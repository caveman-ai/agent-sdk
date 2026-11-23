import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { parseEnvSpec } from "../src/env/types.ts";
import { createEnv } from "../src/env/index.ts";
import { BUILTIN_LOADOUTS, normalizeLoadout } from "../src/loadout.ts";
import { applyEdits } from "../src/tools/edit-apply.ts";
import { capHeadTail } from "../src/tools/cap.ts";
import { compactTools } from "../src/tools/compact.ts";

function setup(patch: (loadout: Record<string, any>) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-tools-"));
  const env = new LocalEnv({ cwd: dir });
  const raw = structuredClone(BUILTIN_LOADOUTS["compact-v0"]) as Record<string, any>;
  patch(raw);
  const tools = Object.fromEntries(compactTools({ env, loadout: normalizeLoadout(raw), images: true }).map((tool) => [tool.name, tool]));
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = tools[name]!;
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    const result = await tool.execute("t", prepared as never);
    return { text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(""), details: result.details, result };
  };
  return { dir, env, call };
}

test("env specs parse: local and docker only (Caveman runs agents in its own sandboxes, no third party's)", async () => {
  assert.deepEqual(parseEnvSpec("local:/tmp/x"), { kind: "local", cwd: "/tmp/x" });
  assert.deepEqual(parseEnvSpec("docker:box:/app"), { kind: "docker", container: "box", cwd: "/app" });
  assert.throws(() => parseEnvSpec("docker:x"), /docker:<container>:<absolute cwd>/u);
  assert.throws(() => parseEnvSpec("podman:x:/app"), /unknown spec/u);
  assert.throws(() => parseEnvSpec("customenv:sbx123:/app"), /unknown spec .*want local:<cwd> or docker:<container>:<cwd>/u);
  await assert.rejects(createEnv("customenv:sbx123:/app"), /unknown spec/u);
});

test("read pages a long file, caps lines, numbers lines when the loadout asks", async () => {
  const { dir, env, call } = setup();
  try {
    writeFileSync(join(dir, "long.txt"), Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n"));
    const first = await call("read", { path: "long.txt" });
    assert.match(first.text, /^line 1\n/u);
    assert.match(first.text, /\[Showing lines 1-2000 of 3000\. Use offset=2001 to continue\.\]$/u);
    assert.equal(first.details.truncated, true);
    const window = await call("read", { path: "long.txt", offset: 10, limit: 2 });
    assert.equal(window.text, "line 10\nline 11\n\n[2989 more lines in file. Use offset=12 to continue.]");
    await assert.rejects(call("read", { path: "missing.txt" }), /File not found: missing.txt/u);
    await assert.rejects(call("read", { path: "long.txt", offset: 5000 }), /beyond end of file/u);
    writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    assert.match((await call("read", { path: "blob.bin" })).text, /binary file \(4 bytes\)/u);
    writeFileSync(join(dir, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const image = await call("read", { path: "pixel.png" });
    assert.equal(image.result.content[1]?.type, "image");
  } finally {
    await env.close();
  }
  const numbered = setup((loadout) => { loadout.tools.read.limits.line_numbers = true; });
  try {
    writeFileSync(join(numbered.dir, "f.txt"), "a\nb\nc");
    assert.equal((await numbered.call("read", { path: "f.txt", offset: 2 })).text, "2\tb\n3\tc");
  } finally {
    await numbered.env.close();
  }
});

test("bash caps head and tail and spills the full output to a file", async () => {
  const { env, call } = setup();
  try {
    const out = await call("bash", { command: "for i in $(seq 1 5000); do echo row-$i; done" });
    assert.match(out.text, /^row-1\n/u);
    assert.match(out.text, /row-5000$/u);
    assert.match(out.text, /lines, \d+ bytes omitted; full output: \S+\.log/u);
    assert.ok(out.text.split("\n").length <= 2000);
    assert.equal(out.details.truncated, true);
    const spilled = readFileSync(out.details.spill!, "utf8");
    assert.equal(spilled.trim().split("\n").length, 5000);
    const failed = await call("bash", { command: "echo oops >&2; exit 3" });
    assert.equal(failed.text, "oops\n\nCommand exited with code 3");
    assert.equal(failed.details.exitCode, 3);
    assert.equal((await call("bash", { command: "true" })).text, "(no output)");
  } finally {
    await env.close();
  }
});

test("bash yields on timeout: the command keeps running and wait resumes it", async () => {
  const { env, call } = setup();
  try {
    const started = Date.now();
    const first = await call("bash", { command: "echo begin; sleep 1; echo end", timeout: 0.3 });
    assert.ok(Date.now() - started < 900, "returned at the yield, not at exit");
    assert.match(first.text, /^begin\n\n\[Still running after 0s as process (p\d+)\./u);
    const handle = first.details.handle!;
    assert.deepEqual(env.liveHandles(), [handle]);
    const second = await call("wait", { handle, timeout: 5 });
    assert.equal(second.text, "end");
    assert.equal(second.details.exitCode, 0);
    assert.equal(second.details.loopExempt, undefined);
    assert.deepEqual(env.liveHandles(), []);
    await assert.rejects(call("wait", { handle }), /no background process/u);
    const slow = await call("bash", { command: "sleep 30", timeout: 0.1 });
    const polled = await call("wait", { handle: slow.details.handle!, timeout: 0.1 });
    assert.equal(polled.details.loopExempt, true, "a wait on a live process is never a loop");
    const killed = await call("wait", { handle: slow.details.handle!, kill: true });
    assert.match(killed.text, /Command killed\./u);
  } finally {
    await env.close();
  }
});

test("bash hard timeout kills the process group; close kills background work", async () => {
  const { env, call } = setup((loadout) => { loadout.tools.bash.limits.hard_timeout_s = 0.3; });
  try {
    const out = await call("bash", { command: "sleep 5 & sleep 5; echo never" });
    assert.match(out.text, /hard timeout/u);
    const bg = await env.exec("sleep 30", { background: true });
    assert.equal(bg.running, true);
    const pidFile = join(env.cwd, "pid");
    await env.exec(`(sleep 30 & echo $! > ${pidFile}) && echo started`);
    const orphan = Number(readFileSync(pidFile, "utf8"));
    await env.close();
    assert.deepEqual(env.liveHandles(), []);
    assert.throws(() => process.kill(orphan, 0), /ESRCH/u, "a server a command backgrounded dies with the env");
  } finally {
    await env.close();
  }
});

test("commands get an allowlisted environment, never the harness's secrets", async () => {
  process.env.OPENAI_API_KEY = "sk-secret-test";
  const { env, call } = setup();
  try {
    const out = await call("bash", { command: "echo key=${OPENAI_API_KEY:-none} pager=$PAGER; test -n \"$PATH\" && echo path-ok" });
    assert.equal(out.text, "key=none pager=cat\npath-ok");
  } finally {
    delete process.env.OPENAI_API_KEY;
    await env.close();
  }
});

test("edit applies several edits against the original, preserves CRLF and BOM, and names failures", async () => {
  assert.equal(applyEdits("a b c a2", [{ oldText: "b", newText: "B" }, { oldText: "c", newText: "$&C" }], "f").text, "a B $&C a2");
  assert.throws(() => applyEdits("x x", [{ oldText: "x", newText: "y" }], "f"), /Found 2 occurrences of the text in f/u);
  assert.throws(() => applyEdits("abc", [{ oldText: "zz", newText: "y" }], "f"), /Could not find the exact text in f/u);
  assert.throws(() => applyEdits("abcdef", [{ oldText: "abc", newText: "1" }, { oldText: "cde", newText: "2" }], "f"), /edits\[0\] and edits\[1\] overlap/u);
  assert.throws(() => applyEdits("abc", [{ oldText: "a", newText: "a" }], "f"), /No changes made to f/u);
  assert.throws(() => applyEdits("abc", [{ oldText: "", newText: "a" }], "f"), /oldText must not be empty/u);
  assert.equal(applyEdits("﻿one\r\ntwo\r\n", [{ oldText: "one\ntwo", newText: "1\n2" }], "f").text, "﻿1\r\n2\r\n");
  const fuzzy = applyEdits("  if (x) {   \n    say(“hi”);\n  }\n", [{ oldText: "  if (x) {\n    say(\"hi\");\n", newText: "  if (y) {\n    say(\"yo\");\n" }], "f", { fuzzy: true });
  assert.equal(fuzzy.text, "  if (y) {\n    say(\"yo\");\n  }\n");
  assert.equal(fuzzy.fuzzy, 1);
  assert.throws(() => applyEdits("a \nb\na\t\nb\n", [{ oldText: "a\nb\n", newText: "c\n" }], "f", { fuzzy: true }), /Found 2 occurrences/u);

  const { dir, env, call } = setup();
  try {
    writeFileSync(join(dir, "m.py"), "def f():\n    return 1\n\ndef g():\n    return 2\n");
    const out = await call("edit", { path: "m.py", edits: [{ oldText: "return 1", newText: "return 10" }, { oldText: "return 2", newText: "return 20" }] });
    assert.equal(out.text, "Successfully replaced 2 block(s) in m.py.");
    assert.equal(out.details.mutated, true);
    assert.equal(readFileSync(join(dir, "m.py"), "utf8"), "def f():\n    return 10\n\ndef g():\n    return 20\n");
    await call("edit", { path: "m.py", old_string: "return 10", new_string: "return 11" });
    assert.match(readFileSync(join(dir, "m.py"), "utf8"), /return 11/u);
    await assert.rejects(call("edit", { path: "nope.py", edits: [{ oldText: "a", newText: "b" }] }), /File not found: nope.py/u);
    const written = await call("write", { path: "deep/new/file.txt", content: "héllo" });
    assert.equal(written.text, "Successfully wrote 6 bytes to deep/new/file.txt");
    assert.equal(readFileSync(join(dir, "deep/new/file.txt"), "utf8"), "héllo");
  } finally {
    await env.close();
  }
});

test("head+tail cap keeps both ends within byte and line limits, even for one huge line", () => {
  const marker = (lines: number, bytes: number) => `[${lines} lines ${bytes} bytes omitted]`;
  const lines = Array.from({ length: 100 }, (_, index) => `l${index}`).join("\n");
  const capped = capHeadTail(lines, 10, 10_000, marker);
  assert.equal(capped.truncated, true);
  assert.equal(capped.text.split("\n").length, 10);
  assert.match(capped.text, /^l0\n/u);
  assert.match(capped.text, /l99$/u);
  const huge = capHeadTail("x".repeat(100_000), 2000, 1000, marker);
  assert.ok(Buffer.byteLength(huge.text) <= 1000);
  assert.match(huge.text, /\[0 lines \d+ bytes omitted\]/u);
  assert.equal(capHeadTail("short\n", 10, 100, marker).text, "short\n");
});
