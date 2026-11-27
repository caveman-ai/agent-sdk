/**
 * The exec surface on LocalEnv: Codex's pragma and result framing, cell yields
 * and wait, nested exec_command/write_stdin/apply_patch/view_image, the
 * exec_command record's key order, edit tracking through nested apply_patch,
 * and one end-to-end run through the one-file bundle (embedded QuickJS, the
 * bundle as its own worker).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalEnv } from "../src/env/local.ts";
import { loadLoadout } from "../src/loadout.ts";
import { fauxStep } from "../src/models.ts";
import { runHarness } from "../src/run.ts";
import { cellResultText, parseExecSource } from "../src/tools/exec/format.ts";
import { unifiedRecord, type NestedShared } from "../src/tools/exec/nested.ts";
import { execSurface } from "../src/tools/exec/surface.ts";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "harness.mjs");

function setup(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-exec-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const env = new LocalEnv({ cwd: root });
  const surface = execSurface({ env, loadout: loadLoadout("exec-v0"), images: true });
  const tools = Object.fromEntries(surface.tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, args: unknown) => {
    const result = await tools[name]!.execute("call", tools[name]!.prepareArguments?.(args) ?? args);
    return { text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(""), details: result.details as Record<string, any>, content: result.content };
  };
  return { root, env, surface, tools, call, async close() { await surface.dispose(); await env.close(); } };
}

describe("exec surface", { concurrency: 4 }, () => {
test("pragma parsing and result framing follow Codex", () => {
  assert.deepEqual(parseExecSource('// @exec: {"yield_time_ms": 500, "max_output_tokens": 20}\ntext(1)'), { code: "text(1)", yieldTimeMs: 500, maxOutputTokens: 20 });
  assert.deepEqual(parseExecSource("text(1)"), { code: "text(1)" });
  assert.throws(() => parseExecSource("   "), /raw JavaScript source text/u);
  assert.throws(() => parseExecSource('// @exec: {"timeout": 1}\ntext(1)'), /only supports `yield_time_ms` and `max_output_tokens`; got `timeout`/u);
  assert.throws(() => parseExecSource("// @exec: {\"yield_time_ms\": 1}"), /must be followed by JavaScript source/u);
  assert.equal(cellResultText("completed", 1.26, ["a", "b"], 100).text, "Script completed\nWall time 1.3 seconds\nOutput:\nab");
  assert.equal(cellResultText({ running: 3 }, 0, [], 100).text, "Script running with cell ID 3\nWall time 0.0 seconds\nOutput:\n");
  const cut = cellResultText("failed", 0, ["x".repeat(100), "Script error:\nboom"], 10);
  assert.ok(cut.truncated);
  assert.match(cut.text, /^Script failed\nWall time 0\.0 seconds\nOutput:\nWarning: truncated output \(original token count: 30\)\nTotal output lines: 3\n\nx{20}…20 tokens truncated…/u);
});

test("exec_command's record keeps Codex's key order", () => {
  const shared: NestedShared = { env: undefined as never, sessions: new Map(), nextSession: 1000, chunks: 0, inflight: new Map() };
  const done = unifiedRecord(shared, { exitCode: 0, output: "hi\n", truncated: false, durationMs: 5, totalBytes: 3, running: false }, performance.now(), undefined, undefined);
  assert.deepEqual(Object.keys(done), ["chunk_id", "wall_time_seconds", "exit_code", "original_token_count", "output"]);
  const running = unifiedRecord(shared, { exitCode: null, output: "", truncated: false, durationMs: 5, totalBytes: 0, running: true, handle: "p1" }, performance.now(), 1000, 10);
  assert.deepEqual(Object.keys(running), ["chunk_id", "wall_time_seconds", "original_token_count", "output", "session_id"]);
  assert.match(String(done.chunk_id), /^[0-9a-f]{6}$/u);
  assert.notEqual(done.chunk_id, running.chunk_id);
});

test("the exec description declares each nested tool; wait is Codex's", () => {
  const { tools, close } = setup();
  try {
    const description = tools.exec!.description;
    assert.match(description, /^Run JavaScript code to orchestrate\/compose tool calls/u);
    for (const name of ["apply_patch", "exec_command", "view_image", "write_stdin"]) assert.match(description, new RegExp(`### \`${name}\``, "u"));
    assert.match(description, /declare const tools: \{ apply_patch\(input: string\): Promise<unknown>; \};/u);
    assert.match(description, /exec_command\(args: \{\n {2}\/\/ Shell command to execute\.\n {2}cmd: string;/u);
    assert.match(description, /Shared MCP Types:/u);
    assert.deepEqual(tools.exec!.constrainedSampling, { type: "grammar", variants: { openai_lark: tools.exec!.constrainedSampling && (tools.exec!.constrainedSampling as any).variants.openai_lark } });
    assert.match((tools.exec!.constrainedSampling as any).variants.openai_lark, /PRAGMA_LINE: \/\[ \\t\]\*\\\/\\\/ @exec:/u);
    assert.match(tools.wait!.description, /^Waits on a yielded `exec` cell/u);
  } finally {
    void close();
  }
});

test("a cell runs commands, edits through nested apply_patch, and reports mutation and nested calls", async () => {
  const ctx = setup({ "a.txt": "one\ntwo\n" });
  try {
    const patch = "*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n*** End Patch\n";
    const out = await ctx.call("exec", {
      input: `const r = await tools.exec_command({ cmd: "echo hi && exit 3" });\ntext(JSON.stringify(r));\ntext(await tools.apply_patch(${JSON.stringify(patch)}));`,
    });
    assert.match(out.text, /^Script completed\nWall time \d+\.\d seconds\nOutput:\n/u);
    const record = JSON.parse(out.text.split("Output:\n")[1]!.split("Success.")[0]!);
    assert.deepEqual(Object.keys(record), ["chunk_id", "wall_time_seconds", "exit_code", "original_token_count", "output"]);
    assert.equal(record.exit_code, 3);
    assert.equal(record.output, "hi\n");
    assert.match(out.text, /Success\. Updated the following files:\nM a\.txt/u);
    assert.equal(readFileSync(join(ctx.root, "a.txt"), "utf8"), "one\nTWO\n");
    assert.equal(out.details.mutated, true, "nested apply_patch counts as an edit for the policy");
    assert.deepEqual(out.details.nested, { exec_command: 1, apply_patch: 1 });
    const readOnly = await ctx.call("exec", { input: "text((await tools.exec_command({ cmd: 'cat a.txt' })).output)" });
    assert.equal(readOnly.details.mutated, undefined);
    const bad = await ctx.call("exec", { input: `await tools.apply_patch("*** Begin Patch\\n*** Update File: a.txt\\n@@\\n-nope\\n*** End Patch\\n")` });
    assert.match(bad.text, /^Script failed\n[\s\S]*Script error:\n[\s\S]*apply_patch verification failed/u);
    assert.equal(bad.details.mutated, undefined);
  } finally {
    await ctx.close();
  }
});

test("a cell yields at yield_time_ms with its output so far; wait returns only the new output and the completion", async () => {
  const ctx = setup();
  try {
    const first = await ctx.call("exec", { input: '// @exec: {"yield_time_ms": 500}\ntext("start ");\nconst r = await tools.exec_command({ cmd: "sleep 1; echo late", yield_time_ms: 5000 });\ntext(r.output);' });
    assert.match(first.text, /^Script running with cell ID 1\nWall time 0\.\d seconds\nOutput:\nstart $/u);
    assert.equal(first.details.cell_id, 1);
    const second = await ctx.call("wait", { cell_id: "1", yield_time_ms: 10_000 });
    assert.match(second.text, /^Script completed\nWall time \d\.\d seconds\nOutput:\nlate\n$/u);
    assert.equal(second.details.loopExempt, undefined);
    await assert.rejects(ctx.call("wait", { cell_id: "1" }), /exec cell 1 not found/u);
  } finally {
    await ctx.close();
  }
});

test("yield_control returns at once; terminate stops the cell; a wait on a running cell is loop-exempt", async () => {
  const ctx = setup();
  try {
    const started = performance.now();
    const first = await ctx.call("exec", { input: 'text("a"); yield_control(); await new Promise((done) => setTimeout(done, 5000)); text("b");' });
    assert.ok(performance.now() - started < 3000, "yield_control did not wait for the default 30 s yield");
    assert.match(first.text, /^Script running with cell ID 1\n[\s\S]*Output:\na$/u);
    const polled = await ctx.call("wait", { cell_id: 1, yield_time_ms: 50 });
    assert.match(polled.text, /^Script running with cell ID 1\n[\s\S]*Output:\n$/u);
    assert.equal(polled.details.loopExempt, true);
    const stopped = await ctx.call("wait", { cell_id: "1", terminate: true });
    assert.match(stopped.text, /^Script terminated\n/u);
  } finally {
    await ctx.close();
  }
});

test("exec_command yields a session_id; write_stdin polls it to the end and refuses stdin it cannot deliver", async () => {
  const ctx = setup();
  try {
    const out = await ctx.call("exec", {
      input: [
        'const r = await tools.exec_command({ cmd: "echo begin; sleep 0.5; echo end", yield_time_ms: 250 });',
        "text(Object.keys(r).join(',') + '\\n');",
        "let refused = '';",
        "try { await tools.write_stdin({ session_id: r.session_id, chars: 'y\\n' }); } catch (error) { refused = error.message; }",
        "text(refused.includes('no PTY or stdin') ? 'refused\\n' : 'accepted\\n');",
        "const s = await tools.write_stdin({ session_id: r.session_id, yield_time_ms: 5000 });",
        "text(r.output + s.output + Object.keys(s).join(',') + ' ' + s.exit_code);",
      ].join("\n"),
    });
    assert.match(out.text, /Output:\nchunk_id,wall_time_seconds,original_token_count,output,session_id\nrefused\nbegin\nend\nchunk_id,wall_time_seconds,exit_code,original_token_count,output 0$/u);
    assert.deepEqual(out.details.nested, { exec_command: 1, write_stdin: 2 });
  } finally {
    await ctx.close();
  }
});

test("store/load persist across cells, setTimeout works, errors name the script line, output over budget is cut and spilled", async () => {
  const ctx = setup();
  try {
    await ctx.call("exec", { input: 'store("n", 41);' });
    const loaded = await ctx.call("exec", { input: 'await new Promise((done) => setTimeout(done, 20)); text(load("n") + 1);' });
    assert.match(loaded.text, /Output:\n42$/u);
    const failed = await ctx.call("exec", { input: "const a = 1;\nnull.boom;" });
    assert.match(failed.text, /^Script failed\n[\s\S]*Script error:\nTypeError: [\s\S]*:2:/u);
    const big = await ctx.call("exec", { input: '// @exec: {"max_output_tokens": 50}\nfor (let i = 0; i < 400; i++) text(`line ${i}\\n`);' });
    assert.match(big.text, /Output:\nWarning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\nFull output: .*exec-\d+-1\.log\n\nline 0\n/u);
    assert.equal(big.details.truncated, true);
    assert.match(readFileSync(big.details.spill, "utf8"), /line 399/u);
  } finally {
    await ctx.close();
  }
});

test("view_image returns a data URL the cell can attach with image()", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const ctx = setup();
  writeFileSync(join(ctx.root, "dot.png"), png);
  try {
    const out = await ctx.call("exec", { input: 'const v = await tools.view_image({ path: "dot.png" }); text(v.detail); image(v);' });
    assert.match(out.text, /Output:\nhigh\[image\]$/u);
    assert.equal(out.content[1]!.type, "image");
  } finally {
    await ctx.close();
  }
});

test("a run on exec-v0 with a scripted model edits through exec and records nested calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-exec-run-"));
  writeFileSync(join(root, "greeting.txt"), "hello world\n");
  const env = new LocalEnv({ cwd: root });
  const patch = "*** Begin Patch\n*** Update File: greeting.txt\n@@\n-hello world\n+hello there\n*** End Patch\n";
  const script = `text(await tools.apply_patch(${JSON.stringify(patch)}));\ntext((await tools.exec_command({ cmd: "cat greeting.txt" })).output);`;
  const trace = join(root, "trace.jsonl");
  try {
    const result = await runHarness({
      prompt: "Change the greeting.", model: "faux/scripted", effort: "high", loadout: loadLoadout("exec-v0"), env, tracePath: trace,
      fauxSteps: [fauxStep({ toolCalls: [{ name: "exec", arguments: { input: script } }] }), fauxStep({ text: "Done." })],
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.equal(readFileSync(join(root, "greeting.txt"), "utf8"), "hello there\n");
    assert.deepEqual(result.tools.by_name, { exec: 1 });
    assert.deepEqual(result.tools.nested_by_name, { apply_patch: 1, exec_command: 1 });
    const end = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "tool_end");
    assert.equal(end.cell_id, 1);
    assert.equal(end.mutated, true);
  } finally {
    await env.close();
  }
});

test("the one-file bundle runs exec cells (embedded QuickJS, the bundle as its own worker)", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-exec-bundle-"));
  const ws = join(root, "ws");
  mkdirSync(ws);
  const prompt = join(root, "prompt.md");
  writeFileSync(prompt, "Say hi.");
  const faux = join(root, "faux.json");
  writeFileSync(faux, JSON.stringify({ steps: [
    { toolCalls: [{ name: "exec", arguments: { input: 'const r = await tools.exec_command({ cmd: "echo from-bundle > out.txt && cat out.txt" }); text(r.output);' } }] },
    { text: "Done." },
  ] }));
  const args = ["run", "--prompt-file", prompt, "--model", "faux/scripted", "--effort", "high", "--loadout", "exec-v0", "--env", `local:${ws}`,
    "--trace", join(root, "trace.jsonl"), "--result", join(root, "result.json"), "--faux-script", faux];
  const out = await new Promise<{ code: number | null; stderr: string }>((done) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stderr }));
  });
  assert.equal(out.code, 0, out.stderr);
  const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  assert.equal(result.status, "finished", JSON.stringify(result));
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "from-bundle\n");
  const end = readFileSync(join(root, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((event) => event.type === "tool_end");
  assert.equal(end.is_error, false);
  assert.match(result.version.bundle_sha256, /^[0-9a-f]{64}$/u);
});

test("exec-v0 plus Codex's extra wire knobs against pi-ai's Responses provider: a grammar tool and a custom tool call round trip", async () => {
  const { createServer } = await import("node:http");
  const bodies: Record<string, any>[] = [];
  const script = 'const r = await tools.exec_command({ cmd: "echo via-wire" }); text(r.output);';
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const n = bodies.length;
      const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      send("response.created", { response: { id: `resp_${n}`, status: "in_progress" } });
      if (n === 1) {
        const item = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "" };
        send("response.output_item.added", { output_index: 0, item });
        send("response.custom_tool_call_input.delta", { output_index: 0, item_id: "ctc_1", delta: script });
        send("response.custom_tool_call_input.done", { output_index: 0, item_id: "ctc_1", input: script });
        send("response.output_item.done", { output_index: 0, item: { ...item, input: script, status: "completed" } });
      } else {
        const item = { type: "message", id: "msg_2", role: "assistant", status: "in_progress", content: [] };
        send("response.output_item.added", { output_index: 0, item });
        send("response.output_text.delta", { output_index: 0, item_id: "msg_2", content_index: 0, delta: "Done." });
        send("response.output_item.done", { output_index: 0, item: { ...item, status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] } });
      }
      send("response.completed", { response: { id: `resp_${n}`, status: "completed", usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const root = mkdtempSync(join(tmpdir(), "harness-exec-wire-"));
  const env = new LocalEnv({ cwd: root });
  process.env.EXEC_WIRE_KEY = "sk-test";
  // exec-v0 carries the plain wire (tests/loadouts-wire.test.ts); Codex 0.166 also sends low verbosity, no parallel calls and deterministic prefix ids.
  const arm = join(root, "exec-codex-wire.json");
  writeFileSync(arm, JSON.stringify({
    extends: "exec-v0", name: "exec-v0-codex-wire",
    wire: { cache_retention: "short", max_retries: 3, mid_convo_effort: false, reasoning_context: "all_turns", reasoning_summary: "none", verbosity: "low", parallel_tool_calls: false, responses_lite_ids: true },
  }));
  try {
    const result = await runHarness({
      prompt: "Echo.", model: "openai/gpt-6.1-sol", effort: "high", loadout: loadLoadout(arm), env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "EXEC_WIRE_KEY" },
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      assert.equal(body.tools, undefined);
      assert.equal(body.input[0].type, "additional_tools");
      assert.match(body.input[0].id, /^at_/u);
      assert.match(body.input[1].id, /^msg_/u);
      const exec = body.input[0].tools.find((tool: { name: string }) => tool.name === "exec");
      assert.equal(exec.type, "custom");
      assert.equal(exec.format.type, "grammar");
      assert.equal(exec.format.syntax, "lark");
      assert.deepEqual(body.input[0].tools.map((tool: { name: string }) => tool.name), ["exec", "wait"]);
      assert.equal(body.parallel_tool_calls, false);
      assert.deepEqual(body.reasoning, { effort: "high", context: "all_turns" });
      assert.deepEqual(body.text, { verbosity: "low" });
      assert.equal(body.input.filter((item: { type?: string }) => item.type === "configuration_update").length, 0);
    }
    const output = bodies[1]!.input.find((item: { type?: string }) => item.type === "custom_tool_call_output");
    assert.equal(output.call_id, "call_1");
    assert.match(JSON.stringify(output.output), /Script completed\\nWall time \d+\.\d seconds\\nOutput:\\nvia-wire\\n/u);
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
});
});
