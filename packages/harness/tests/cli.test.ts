/**
 * End to end through the bundle (dist/harness.mjs, built by `npm test`): a
 * scripted faux model, and pi-ai's real OpenAI Responses provider against a
 * loopback mock of the Responses API (no network). Both read a file, edit it,
 * run a command and finish; the trace and result must meet the contract.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "harness.mjs");

function harness(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-"));
  const ws = join(root, "ws");
  writeFileSync(join(root, "prompt.txt"), "Change greeting.txt to say hello there, then show it.");
  return { root, ws, prompt: join(root, "prompt.txt"), trace: join(root, "trace.jsonl"), result: join(root, "result.json") };
}

const READ = { name: "read", arguments: { path: "greeting.txt" } };
const EDIT = { name: "edit", arguments: { path: "greeting.txt", edits: [{ oldText: "world", newText: "there" }] } };
const BASH = { name: "bash", arguments: { command: "cat greeting.txt && echo ok" } };

function assertContract(result: Record<string, any>, events: Record<string, any>[], model: string, loadoutName = "compact-v0") {
  assert.equal(result.schema, 1);
  assert.equal(result.status, "finished");
  assert.equal(result.stop_reason, "done");
  assert.match(result.version.bundle_sha256, /^[0-9a-f]{64}$/u);
  assert.equal(result.version.bundle_sha256, readFileSync(`${BUNDLE}.sha256`, "utf8").split(" ")[0]);
  assert.match(result.version.loadout_hash, /^[0-9a-f]{64}$/u);
  assert.match(result.version.behavior_hash, /^[0-9a-f]{64}$/u);
  assert.equal(result.version.loadout_name, loadoutName);
  assert.equal(result.model, model);
  assert.equal(result.effort, "high");
  for (const key of ["requests", "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"]) {
    assert.equal(typeof result.usage[key], "number", key);
  }
  assert.equal(result.usage.requests, 4);
  for (const key of ["wall_s", "model_s", "tool_s", "harness_s"]) assert.ok(result.timing[key] >= 0, key);
  assert.ok(result.timing.time_to_first_request_ms > 0);
  assert.ok(Math.abs(result.timing.model_s + result.timing.tool_s + result.timing.harness_s - result.timing.wall_s) < 0.01);
  assert.equal(result.tools.calls, 3);
  assert.deepEqual(result.tools.by_name, { read: 1, edit: 1, bash: 1 });
  const types = events.map((event) => event.type);
  assert.equal(types[0], "run_start");
  assert.equal(types.at(-1), "stop");
  assert.equal(types.filter((type) => type === "request_start").length, 4);
  assert.equal(types.filter((type) => type === "request_end").length, 4);
  assert.equal(types.filter((type) => type === "tool_end").length, 3);
  assert.equal(types.filter((type) => type === "turn_end").length, 4);
  const requestEnd = events.find((event) => event.type === "request_end")!;
  for (const key of ["latency_ms", "usage", "cache_read_share", "stop_reason"]) assert.ok(key in requestEnd, key);
  const toolEnd = events.find((event) => event.type === "tool_end" && event.name === "bash")!;
  assert.deepEqual([typeof toolEnd.duration_ms, typeof toolEnd.bytes_out, toolEnd.truncated, toolEnd.exit_code], ["number", "number", false, 0]);
}

test("run with a scripted faux model reads, edits, runs a command and finishes", async () => {
  const dirs = workspace();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirs.ws);
  writeFileSync(join(dirs.ws, "greeting.txt"), "hello world\n");
  const script = join(dirs.root, "faux.json");
  writeFileSync(script, JSON.stringify({ steps: [{ toolCalls: [READ] }, { toolCalls: [EDIT] }, { toolCalls: [BASH] }, { text: "Done: it says hello there." }] }));
  const out = await harness(["run", "--prompt-file", dirs.prompt, "--model", "faux/scripted", "--effort", "high", "--loadout", "compact-v0",
    "--env", `local:${dirs.ws}`, "--trace", dirs.trace, "--result", dirs.result, "--faux-script", script]);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(readFileSync(join(dirs.ws, "greeting.txt"), "utf8"), "hello there\n");
  const result = JSON.parse(readFileSync(dirs.result, "utf8"));
  const events = readFileSync(dirs.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assertContract(result, events, "faux/scripted");
  assert.equal(events[0].user, userInfo().username, "run_start names the user commands ran as");
  assert.ok(result.cost_usd > 0);
  const bash = events.find((event) => event.type === "tool_end" && event.name === "bash");
  assert.equal(bash.bytes_out, "hello there\nok".length);
});

test("--transcript writes every model-visible message as JSONL; the run's trace and result are the same shape without it", async () => {
  const dirs = workspace();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirs.ws);
  writeFileSync(join(dirs.ws, "greeting.txt"), "hello world\n");
  const script = join(dirs.root, "faux.json");
  writeFileSync(script, JSON.stringify({ steps: [{ toolCalls: [READ] }, { toolCalls: [EDIT] }, { toolCalls: [BASH] }, { text: "Done: it says hello there." }] }));
  const transcript = join(dirs.root, "transcript.jsonl");
  const out = await harness(["run", "--prompt-file", dirs.prompt, "--model", "faux/scripted", "--effort", "high", "--loadout", "compact-v0",
    "--env", `local:${dirs.ws}`, "--trace", dirs.trace, "--result", dirs.result, "--faux-script", script, "--transcript", transcript]);
  assert.equal(out.code, 0, out.stderr);
  assertContract(JSON.parse(readFileSync(dirs.result, "utf8")), readFileSync(dirs.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)), "faux/scripted");
  const lines = readFileSync(transcript, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.type), ["system", "user", "assistant", "tool_result", "assistant", "tool_result", "assistant", "tool_result", "assistant"]);
  assert.match(lines[0].text, /\S/u);
  assert.match(lines[1].content[0].text, /Change greeting\.txt/u);
  assert.deepEqual(lines[4].tool_calls.map((call: { name: string; input: unknown }) => [call.name, call.input]), [["edit", EDIT.arguments]]);
  assert.equal(lines[7].content[0].text, "hello there\nok");
  assert.equal(lines.at(-1).text, "Done: it says hello there.");
  assert.equal(typeof lines[2].usage.reasoning, "number");
});

/**
 * A loopback Responses API: one scripted SSE response per request; records bodies and auth.
 * `failFirst` requests get a 503 before any stream; `failStreams` lists the request numbers (1-based,
 * over successful-status requests) whose stream fails mid-way with `response.failed` server_error.
 * A step with `thinkMs` first streams an encrypted reasoning item that stays open that long (no summary,
 * so nothing reaches the client in between, as GPT-6.x headless runs stream).
 */
type MockStep = ({ call: { name: string; arguments: object } } | { text: string }) & { thinkMs?: number };
function mockResponses(steps: MockStep[], failFirst = 0, failStreams: number[] = []) {
  const requests: { auth: string | undefined; body: Record<string, any> }[] = [];
  const failed: { auth: string | undefined; body: Record<string, any> }[] = [];
  const failures = { count: 0 };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      if (failures.count < failFirst) {
        failures.count++;
        res.writeHead(503, { "content-type": "application/json", "retry-after-ms": "10" });
        res.end(JSON.stringify({ error: { message: "overloaded", type: "server_error" } }));
        return;
      }
      const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      if (failStreams.includes(requests.length + failed.length + 1)) {
        failed.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "text/event-stream" });
        send("response.created", { response: { id: "resp_failed", status: "in_progress" } });
        send("response.failed", { response: { id: "resp_failed", status: "failed", error: { code: "server_error", message: "The server had an error while processing your request." } } });
        res.end();
        return;
      }
      requests.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      const n = requests.length;
      const step = steps[n - 1];
      res.writeHead(200, { "content-type": "text/event-stream" });
      send("response.created", { response: { id: `resp_${n}`, status: "in_progress" } });
      let index = 0;
      if (step?.thinkMs !== undefined) {
        const reasoning = { type: "reasoning", id: `rs_${n}`, summary: [] };
        send("response.output_item.added", { output_index: 0, item: reasoning });
        await new Promise((done) => setTimeout(done, step.thinkMs));
        send("response.output_item.done", { output_index: 0, item: { ...reasoning, encrypted_content: `enc_${n}` } });
        index = 1;
      }
      if (step === undefined) {
        send("response.failed", { response: { id: `resp_${n}`, status: "failed", error: { code: "server_error", message: "script exhausted" } } });
      } else if ("call" in step) {
        const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: step.call.name, arguments: "" };
        const args = JSON.stringify(step.call.arguments);
        send("response.output_item.added", { output_index: index, item });
        send("response.function_call_arguments.delta", { output_index: index, item_id: item.id, delta: args });
        send("response.function_call_arguments.done", { output_index: index, item_id: item.id, arguments: args });
        send("response.output_item.done", { output_index: index, item: { ...item, arguments: args, status: "completed" } });
      } else {
        const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "in_progress", content: [] };
        send("response.output_item.added", { output_index: index, item });
        send("response.output_text.delta", { output_index: index, item_id: item.id, content_index: 0, delta: step.text });
        send("response.output_item.done", { output_index: index, item: { ...item, status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] } });
      }
      if (step !== undefined) {
        send("response.completed", { response: { id: `resp_${n}`, status: "completed", usage: {
          input_tokens: 1000 * n, input_tokens_details: { cached_tokens: n > 1 ? 900 * (n - 1) : 0 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 }, total_tokens: 1000 * n + 50,
        } } });
      }
      res.end();
    });
  });
  return { server, requests, failed, failures };
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as { port: number }).port;
}

/** The rig's loadout_hash of a file (v3arm.py: sorted keys, no whitespace, UTF-8). */
function rigLoadoutHash(path: string): string {
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
  return createHash("sha256").update(canonical(JSON.parse(readFileSync(path, "utf8")))).digest("hex");
}

test("run through pi-ai's OpenAI Responses provider honors base URL, key env, effort, retries and wire payload", async () => {
  const dirs = workspace();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirs.ws);
  writeFileSync(join(dirs.ws, "greeting.txt"), "hello world\n");
  const { server, requests, failures } = mockResponses([{ call: READ }, { call: EDIT }, { call: BASH }, { text: "Done." }], 2);
  const port = await listen(server);
  const loadout = join(dirs.root, "arm.json");
  writeFileSync(loadout, JSON.stringify({ extends: "compact-v0", name: "arm-verbosity", wire: { payload: { text: { verbosity: "low" } } } }));
  try {
    const out = await harness(["run", "--prompt-file", dirs.prompt, "--model", "openai/gpt-6.1-sol", "--effort", "high", "--loadout", loadout,
      "--env", `local:${dirs.ws}`, "--trace", dirs.trace, "--result", dirs.result, "--openai-base-url", `http://127.0.0.1:${port}/v1`,
      "--api-key-env", "TRIAL_TOKEN", "--max-usd", "5"], { TRIAL_TOKEN: "trial-token-123", OPENAI_API_KEY: "sk-wrong" });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(readFileSync(join(dirs.ws, "greeting.txt"), "utf8"), "hello there\n");
    const result = JSON.parse(readFileSync(dirs.result, "utf8"));
    const events = readFileSync(dirs.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assertContract(result, events, "openai/gpt-6.1-sol", "arm-verbosity");
    assert.equal(result.version.loadout_hash, rigLoadoutHash(loadout), "the version the rig pinned is the version reported");
    // The rig may also ask the bundle (`harness loadout <file>`): the same name and hash as run reports.
    const asked = await harness(["loadout", loadout]);
    assert.equal(asked.code, 0, asked.stderr);
    const pin = JSON.parse(asked.stdout);
    assert.deepEqual([pin.name, pin.hash, pin.behavior_hash], [result.version.loadout_name, result.version.loadout_hash, result.version.behavior_hash]);
    assert.equal(result.provider_retries, 0);
    assert.equal(result.usage.reasoning_tokens, 80);
    assert.equal(result.usage.cached_input_tokens, 900 + 1800 + 2700);
    assert.ok(result.cost_usd > 0);
    assert.equal(failures.count, 2, "two 503s were retried (wire.max_retries)");
    assert.equal(requests.length, 4);
    for (const request of requests) {
      assert.equal(request.auth, "Bearer trial-token-123");
      assert.equal(request.body.model, "gpt-6.1-sol");
      assert.equal(request.body.store, false);
      // GPT-6.x takes mid-conversation effort: Pi pins reasoning.effort and carries the level in a configuration_update item.
      const update = request.body.input.findLast((item: { type?: string }) => item.type === "configuration_update");
      assert.equal(update?.reasoning?.effort ?? request.body.reasoning.effort, "high");
      assert.deepEqual(request.body.text, { verbosity: "low" });
      assert.equal(typeof request.body.prompt_cache_key, "string");
      // Pi 1.4 declares tools to GPT-6.x in an additional_tools input item (the request prefix stays byte-stable).
      const declared = request.body.tools ?? request.body.input.find((item: { type?: string }) => item.type === "additional_tools")?.tools;
      assert.deepEqual(declared.map((tool: { name: string }) => tool.name), ["bash", "edit", "read", "wait", "write"]);
    }
    assert.equal(new Set(requests.map((request) => request.body.prompt_cache_key)).size, 1, "one cache key per run");
    const outputs = requests[3]!.body.input.filter((item: { type?: string }) => item.type === "function_call_output");
    assert.equal(outputs.length, 3);
    assert.match(JSON.stringify(outputs[2]), /hello there\\nok/u);
    // Append-only: each request's input extends the previous one.
    for (let index = 1; index < requests.length; index++) {
      const previous = JSON.stringify(requests[index - 1]!.body.input.slice(0, -1));
      assert.equal(JSON.stringify(requests[index]!.body.input.slice(0, requests[index - 1]!.body.input.length - 1)), previous);
    }
  } finally {
    server.close();
  }
});

test("a stream that fails mid-way is retried from the same transcript and the run finishes", async () => {
  const dirs = workspace();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirs.ws);
  writeFileSync(join(dirs.ws, "greeting.txt"), "hello world\n");
  // Request 1 fails mid-stream; the retry (request 2) and the rest succeed.
  const { server, requests, failed } = mockResponses([{ call: READ }, { call: EDIT }, { call: BASH }, { text: "Done." }], 0, [1, 3]);
  const port = await listen(server);
  const loadout = join(dirs.root, "fast-retry.json");
  writeFileSync(loadout, JSON.stringify({ extends: "compact-v0", name: "fast-retry", policy: { retry: { base_ms: 10 } } }));
  try {
    const out = await harness(["run", "--prompt-file", dirs.prompt, "--model", "openai/gpt-6.1-sol", "--effort", "high", "--loadout", loadout,
      "--env", `local:${dirs.ws}`, "--trace", dirs.trace, "--result", dirs.result, "--openai-base-url", `http://127.0.0.1:${port}/v1`,
      "--api-key-env", "TRIAL_TOKEN"], { TRIAL_TOKEN: "trial-token-123" });
    assert.equal(out.code, 0, out.stderr);
    const result = JSON.parse(readFileSync(dirs.result, "utf8"));
    assert.equal(result.status, "finished", result.error);
    assert.equal(result.stop_reason, "done");
    assert.equal(result.provider_retries, 2);
    assert.equal(failed.length, 2);
    assert.equal(requests.length, 4);
    assert.equal(readFileSync(join(dirs.ws, "greeting.txt"), "utf8"), "hello there\n");
    // Each retry resends exactly the request that failed (same input, same cache key).
    assert.deepEqual(requests[0]!.body.input, failed[0]!.body.input);
    assert.deepEqual(requests[1]!.body.input, failed[1]!.body.input);
    assert.equal(requests[0]!.body.prompt_cache_key, failed[0]!.body.prompt_cache_key);
    const events = readFileSync(dirs.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const retries = events.filter((event) => event.type === "policy" && event.action === "retry");
    assert.equal(retries.length, 2);
    assert.match(retries[0].error, /server_error/u);
  } finally {
    server.close();
  }
});

test("request_end splits a request's latency: ttft_ms to the stream's first event, output_ms to the first visible output", async () => {
  // Live GPT-6.1 Sol at high (smoke1, 2026-10-31): a 117 s request had ttft_ms 1060, since the reasoning item opens at
  // once and streams nothing until it closes. output_ms is when text or a tool call starts, so the reasoning wait
  // (output_ms - ttft_ms) and the decode (latency_ms - output_ms) are read apart.
  const dirs = workspace();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirs.ws);
  writeFileSync(join(dirs.ws, "greeting.txt"), "hello world\n");
  const { server, requests } = mockResponses([{ call: READ, thinkMs: 400 }, { text: "Done." }]);
  const port = await listen(server);
  try {
    const out = await harness(["run", "--prompt-file", dirs.prompt, "--model", "openai/gpt-6.1-sol", "--effort", "high", "--loadout", "compact-v0-plain",
      "--env", `local:${dirs.ws}`, "--trace", dirs.trace, "--result", dirs.result, "--openai-base-url", `http://127.0.0.1:${port}/v1`,
      "--api-key-env", "TRIAL_TOKEN"], { TRIAL_TOKEN: "trial-token-123" });
    assert.equal(out.code, 0, out.stderr);
    assert.equal(requests.length, 2);
    const ends = readFileSync(dirs.trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "request_end");
    const [thought, plain] = ends;
    assert.ok(thought.output_ms >= 400, `output_ms ${thought.output_ms} waits out the open reasoning item`);
    assert.ok(thought.ttft_ms < thought.output_ms - 300, `ttft_ms ${thought.ttft_ms} is the stream's first event, before the reasoning closes`);
    assert.ok(thought.output_ms <= thought.latency_ms);
    assert.ok(plain.output_ms >= plain.ttft_ms && plain.output_ms <= plain.latency_ms, JSON.stringify(plain));
  } finally {
    server.close();
  }
});

test("an unset or empty --api-key-env is an invocation error; no ambient key ever reaches the base URL", async () => {
  const dirs = workspace();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dirs.ws);
  const { server, requests, failed, failures } = mockResponses([{ text: "Done." }]);
  const port = await listen(server);
  const args = ["run", "--prompt-file", dirs.prompt, "--model", "openai/gpt-6.1-sol", "--effort", "high", "--loadout", "compact-v0",
    "--env", `local:${dirs.ws}`, "--trace", dirs.trace, "--result", dirs.result, "--openai-base-url", `http://127.0.0.1:${port}/v1`];
  try {
    const ambient = { OPENAI_API_KEY: "sk-ambient-secret", ANTHROPIC_API_KEY: "sk-ant-ambient", ANTHROPIC_AUTH_TOKEN: "ambient-token" };
    for (const token of [undefined, "", "  "]) {
      const out = await harness([...args, "--api-key-env", "TB4_TRIAL_TOKEN"], { ...ambient, ...(token === undefined ? {} : { TB4_TRIAL_TOKEN: token }) });
      assert.equal(out.code, 2, out.stderr);
      assert.match(out.stderr, /TB4_TRIAL_TOKEN is unset or empty/u);
      const result = JSON.parse(readFileSync(dirs.result, "utf8"));
      assert.equal(result.status, "error");
      assert.equal(result.stop_reason, "invalid_invocation");
    }
    const anthropic = await harness(["run", "--prompt-file", dirs.prompt, "--model", "anthropic/claude-opus-5-5", "--effort", "high", "--loadout", "compact-v0",
      "--env", `local:${dirs.ws}`, "--trace", dirs.trace, "--result", dirs.result, "--anthropic-base-url", `http://127.0.0.1:${port}`], { ANTHROPIC_AUTH_TOKEN: "ambient-token" });
    assert.equal(anthropic.code, 2, "the provider default (ANTHROPIC_API_KEY) is missing: no fallback to other ambient auth");
    assert.match(anthropic.stderr, /ANTHROPIC_API_KEY is unset or empty/u);
    assert.equal(requests.length + failed.length + failures.count, 0, "nothing was sent");
  } finally {
    server.close();
  }
});

test("bad invocations exit 2 with a clear message and an error result", async () => {
  const dirs = workspace();
  const common = ["--prompt-file", dirs.prompt, "--effort", "high", "--trace", dirs.trace, "--result", dirs.result];
  const unknown = await harness(["run", ...common, "--model", "openai/gpt-6.1-sol", "--loadout", "compact-v0", "--env", "customenv:sbx_1:/workspace"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown spec/u);
  const result = JSON.parse(readFileSync(dirs.result, "utf8"));
  assert.equal(result.status, "error");
  assert.equal(result.stop_reason, "invalid_invocation");
  const vars = await harness(["run", ...common, "--model", "openai/gpt-6.1-sol", "--loadout", "compact-v0", "--env", `local:${dirs.root}`, "--env-json", "PATH=/x"]);
  assert.equal(vars.code, 2);
  assert.match(vars.stderr, /--env-json: want a JSON object/u);
  const user = await harness(["run", ...common, "--model", "openai/gpt-6.1-sol", "--loadout", "compact-v0", "--env", `local:${dirs.root}`, "--user", "not-this-host-user"]);
  assert.equal(user.code, 2, "a user the env cannot run as fails the run, not silently ignored");
  assert.match(user.stderr, /user "not-this-host-user" needs a docker env/u);

  const badLoadout = join(dirs.root, "bad.json");
  writeFileSync(badLoadout, JSON.stringify({ extends: "compact-v0", name: "bad", surprise: 1 }));
  const loadout = await harness(["run", ...common, "--model", "openai/gpt-6.1-sol", "--loadout", badLoadout, "--env", `local:${dirs.root}`]);
  assert.equal(loadout.code, 2);
  assert.match(loadout.stderr, /additional properties/u);

  const model = await harness(["run", ...common, "--model", "openai/gpt-0-nope", "--loadout", "compact-v0", "--env", `local:${dirs.root}`]);
  assert.equal(model.code, 2);
  assert.match(model.stderr, /not in the pi-ai catalog/u);

  const effort = await harness(["run", ...common, "--model", "openai/gpt-6.1-sol", "--effort", "ultra", "--loadout", "compact-v0", "--env", `local:${dirs.root}`]);
  assert.equal(effort.code, 2);

  const version = await harness(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+/u);
  assert.ok(existsSync(`${BUNDLE}.sha256`));
});
