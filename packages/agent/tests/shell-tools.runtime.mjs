import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { shellTools } from "../dist/shell-tools.js";
import { agent, run, schema, tool } from "../dist/index.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";

async function withWorkspace(body) {
  const workspace = await mkdtemp(resolve(tmpdir(), "caveman-shell-tools-"));
  try {
    await body(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function byName(tools) {
  return Object.fromEntries(tools.map((item) => [item.name, item]));
}

test("the default six tools keep their documented order and effects", () => {
  const tools = shellTools({ workspace: process.cwd() });
  assert.deepEqual(
    tools.map((item) => [item.name, item.effect, item.speculative === true]),
    [
      ["read_file", "read", true],
      ["grep", "read", true],
      ["bash", "external", false],
      ["write_file", "write", false],
      ["edit_file", "write", false],
      // Recovery paging reads this agent's own captured bytes, not the
      // workspace, so it is not offered for streaming speculation.
      ["read_tool_output", "read", false],
    ],
  );
});

test("tools are built in the requested order, and bad selections are refused", () => {
  assert.deepEqual(
    shellTools({ workspace: process.cwd(), tools: ["bash", "read_file"] })
      .map((item) => item.name),
    ["bash", "read_file"],
  );
  assert.throws(
    () => shellTools({ workspace: process.cwd(), tools: ["bash", "ls"] }),
    /cave_shell_tool_unknown:ls/,
  );
  assert.throws(
    () => shellTools({ workspace: process.cwd(), tools: ["bash", "bash"] }),
    /cave_shell_tool_duplicate:bash/,
  );
});

test("command sessions are refused on a non-local backend", () => {
  const remote = {
    exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false }),
    readFile: async () => Buffer.alloc(0),
    writeFile: async () => {},
    stat: async () => undefined,
  };
  assert.throws(
    () => shellTools({
      workspace: process.cwd(),
      executionBackend: remote,
      commandSessions: { list: () => [], read: async () => {}, close: async () => {} },
    }),
    /cave_execution_backend_command_sessions_local_only/,
  );
});

test("file tools read line ranges, refuse clobbering, and replace exactly once", async () => {
  await withWorkspace(async (workspace) => {
    const tools = byName(shellTools({ workspace }));
    await writeFile(resolve(workspace, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");

    const page = await tools.read_file.execute({ path: "notes.txt", offset: 2, limit: 1 });
    assert.equal(page, "2\tbeta");

    await tools.write_file.execute({ path: "made.txt", content: "first\n" });
    await assert.rejects(
      () => tools.write_file.execute({ path: "made.txt", content: "lost\n" }),
      /EEXIST/,
    );
    assert.equal(await readFile(resolve(workspace, "made.txt"), "utf8"), "first\n");

    await tools.edit_file.execute({
      path: "notes.txt",
      old_string: "beta",
      new_string: "delta",
    });
    assert.equal(await readFile(resolve(workspace, "notes.txt"), "utf8"), "alpha\ndelta\ngamma\n");
    await writeFile(resolve(workspace, "twice.txt"), "same\nsame\n", "utf8");
    await assert.rejects(
      () => tools.edit_file.execute({
        path: "twice.txt",
        old_string: "same",
        new_string: "other",
      }),
      /appears 2 times/,
    );
  });
});

test("bash runs one bounded command in the workspace", async () => {
  await withWorkspace(async (workspace) => {
    const tools = byName(shellTools({ workspace, tools: ["bash"] }));
    assert.equal(await tools.bash.execute({ command: "echo hi" }), "exit 0\nhi\n");
  });
});

test("paths outside the workspace are refused, symlinked or not", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(resolve(tmpdir(), "caveman-shell-outside-"));
    try {
      await writeFile(resolve(outside, "secret.txt"), "not yours\n", "utf8");
      await mkdir(resolve(workspace, "nested"), { recursive: true });
      await symlink(outside, resolve(workspace, "nested/escape"), "dir");
      const tools = byName(shellTools({ workspace }));
      await assert.rejects(
        () => tools.read_file.execute({ path: "../secret.txt" }),
        /path escapes the workspace/,
      );
      await assert.rejects(
        () => tools.read_file.execute({ path: "nested/escape/secret.txt" }),
        /path escapes the workspace/,
      );
      await assert.rejects(
        () => tools.write_file.execute({ path: "nested/escape/new.txt", content: "no\n" }),
        /path escapes the workspace/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("a capped result is recoverable only when read_tool_output is selected", async () => {
  await withWorkspace(async (workspace) => {
    const body = `HEAD_SENTINEL\n${"x".repeat(3_000)}\nTAIL_SENTINEL\n`;
    await writeFile(resolve(workspace, "big.txt"), body, "utf8");
    const caps = { read_file: 512, read_tool_output: 1_024 };

    const withRecovery = byName(shellTools({ workspace, outputCaps: caps }));
    const capped = await withRecovery.read_file.execute({ path: "big.txt" });
    assert.doesNotMatch(capped, /TAIL_SENTINEL/);
    const handle = capped.match(/handle (tool_[a-f0-9]+)/)?.[1];
    assert.equal(typeof handle, "string");
    const first = await withRecovery.read_tool_output.execute({ handle, offset: 0, limit: 64 });
    assert.match(first, /HEAD_SENTINEL/);
    const next = Number(first.match(/\[next offset: (\d+)\]/)?.[1]);
    assert.equal(Number.isSafeInteger(next), true);
    const found = await withRecovery.read_tool_output.execute({
      handle,
      offset: next,
      query: "TAIL_SENTINEL",
      limit: 64,
    });
    assert.match(found, /TAIL_SENTINEL/);

    const withoutRecovery = byName(shellTools({
      workspace,
      tools: ["read_file"],
      outputCaps: caps,
    }));
    const bare = await withoutRecovery.read_file.execute({ path: "big.txt" });
    assert.doesNotMatch(bare, /read_tool_output/);
    assert.match(bare, /recovery paging is not exposed/);
  });
});

test("onOutput observes every capped tool output", async () => {
  await withWorkspace(async (workspace) => {
    const seen = [];
    const tools = byName(shellTools({
      workspace,
      tools: ["read_file", "bash"],
      onOutput: (label, text) => seen.push([label, text]),
    }));
    await writeFile(resolve(workspace, "seen.txt"), "one\n", "utf8");
    await tools.read_file.execute({ path: "seen.txt" });
    await tools.bash.execute({ command: "echo hi" });
    assert.deepEqual(seen.map(([label]) => label), ["read_file:seen.txt", "bash:echo hi"]);
    assert.equal(seen[1][1], "exit 0\nhi\n");
  });
});

test("any agent can compose shell tools beside its own domain tools", async () => {
  await withWorkspace(async (workspace) => {
    const looked = [];
    const lookup = tool({
      name: "lookup_ticket",
      description: "Look up one support ticket.",
      input: schema.object({ id: schema.string() }),
      effect: "read",
      execute: (input) => {
        looked.push(input.id);
        return `${input.id}: open`;
      },
    });
    const investigator = agent({
      id: "shell-tools-investigator",
      instructions: "Investigate, then answer.",
      model: "anthropic/claude-haiku-4-5",
      sandbox: "host",
      tools: [...shellTools({ workspace, tools: ["bash", "read_file"] }), lookup],
    });
    assert.deepEqual(
      investigator.tools.map((item) => item.name),
      ["bash", "read_file", "lookup_ticket"],
    );
    const result = await run(investigator, "what is up with T-1?", {
      ensureRuntime: false,
      model: fauxModel(),
      streamFn: scriptedStream([
        { toolCalls: [{ name: "lookup_ticket", args: { id: "T-1" } }] },
        { toolCalls: [{ name: "bash", args: { command: "echo checked" } }] },
        { text: "T-1 is open." },
      ]),
    });
    assert.equal(result.text, "T-1 is open.");
    assert.deepEqual(looked, ["T-1"]);
    assert.deepEqual(
      result.receipt.tools.map((item) => [item.name, item.calls, item.errors]).sort(),
      [["bash", 1, 0], ["lookup_ticket", 1, 0]],
    );
  });
});
