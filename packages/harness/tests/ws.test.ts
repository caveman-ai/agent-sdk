/**
 * W1, the Responses WebSocket transport (src/ws.ts, wire.transport "ws"):
 * normalization, the delta rule, and whole runs through runHarness and pi-ai's
 * real Responses provider against a loopback server that speaks HTTP and
 * WebSocket (tests/ws-loopback.ts). Over WS every request must carry the body
 * HTTP carries (rebuilt from the chain), the trace's usage fields must match
 * HTTP's, and every full resend, reconnect and fallback must be named.
 * Offline; no model calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import type { Budgets } from "../src/policy.ts";
import { runHarness } from "../src/run.ts";
import { DEFAULT_WS, normalizeWire } from "../src/wire.ts";
import { continuationOf, handshakeHeaders, OPENAI_BETA_WS, WsTransport, type Continuation } from "../src/ws.ts";
import { COMPACT_SCENARIO, EXEC_SCENARIO, stableBody, type Body, type Step } from "./openai-loopback.ts";
import { startFakeResponses, type Faults, type FakeServer } from "./ws-loopback.ts";

const LOADOUTS = join(import.meta.dirname, "..", "loadouts");
const fail = (message: string): never => {
  throw new LoadoutError(message);
};
const withWire = (base: string, wire: Record<string, unknown>, extra: Record<string, unknown> = {}): Loadout => {
  const raw = structuredClone(BUILTIN_LOADOUTS[base]) as Record<string, any>;
  return normalizeLoadout({ ...raw, name: `${base}-test`, wire: { ...raw.wire, ...wire }, ...extra });
};

interface FakeRun {
  server: FakeServer;
  result: Awaited<ReturnType<typeof runHarness>>;
  trace: Body[];
  cwd: string;
}

async function runFake(loadout: Loadout, steps: Step[], faults: Faults = {}, budgets?: Budgets): Promise<FakeRun> {
  const server = await startFakeResponses(steps, faults);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-ws-")));
  const env = new LocalEnv({ cwd });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-ws-trace-")), "trace.jsonl");
  process.env.LOOPBACK_KEY = "sk-test";
  try {
    const result = await runHarness({
      prompt: "Make check.sh pass.", model: "openai/gpt-6.1-sol", effort: "high", loadout, env, tracePath,
      modelOptions: { openaiBaseUrl: server.url, apiKeyEnv: "LOOPBACK_KEY" }, ...(budgets === undefined ? {} : { budgets }),
    });
    const trace = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Body);
    return { server, result, trace, cwd };
  } finally {
    await server.close();
    await env.close();
  }
}

/** An input item as the model sees it, independent of who rendered it (no status, parsed arguments, message text). */
function seen(item: Body): Body {
  const { status: _status, ...rest } = item;
  if (rest.type === "function_call") rest.arguments = JSON.parse(rest.arguments);
  if (rest.type === "message" && Array.isArray(rest.content)) rest.content = rest.content.map((part: Body) => part.text);
  return JSON.parse(JSON.stringify(rest, Object.keys(rest).sort()));
}
const comparable = (body: Body, cwd: string) => {
  const stable = stableBody(body, cwd);
  return { ...stable, input: (stable.input as Body[]).map(seen) };
};
const kinds = (trace: Body[], type: string, kind?: string) => trace.filter((event) => event.type === type && (kind === undefined || event.kind === kind));
const usageOf = (trace: Body[]) => kinds(trace, "request_end").map((event) => ({ usage: event.usage, cache_read_share: event.cache_read_share, cost_usd: event.cost_usd, stop_reason: event.stop_reason }));

test("wire.transport: http normalizes away, ws gets Codex's defaults, ws settings need ws, a prewarm needs the delta", () => {
  assert.equal(normalizeWire({ transport: "http" }, fail).transport, undefined);
  assert.deepEqual(normalizeWire({ transport: "http" }, fail), normalizeWire(undefined, fail));
  assert.deepEqual(normalizeWire({ transport: "ws" }, fail).ws, DEFAULT_WS);
  assert.deepEqual(DEFAULT_WS, { prewarm: true, incremental: true, max_age_s: 3300, connect_timeout_ms: 10_000, max_failures: 3 });
  assert.equal(normalizeWire({ transport: "ws", ws: { incremental: false } }, fail).ws?.prewarm, false);
  assert.throws(() => normalizeWire({ transport: "ws", ws: { incremental: false, prewarm: true } }, fail), /prewarm needs wire.ws.incremental/u);
  assert.throws(() => normalizeWire({ ws: { prewarm: false } }, fail), /wire.ws needs wire.transport "ws"/u);
  assert.throws(() => normalizeLoadout({ ...(BUILTIN_LOADOUTS["exec-v0"] as object), wire: { transport: "ws", ws: { max_age_s: 7200 } } }), /invalid/u);
  // An arm spelling out the default transport behaves (and hashes) like its base.
  assert.equal(loadoutHash(withWire("exec-v0", { transport: "http" })), loadoutHash(normalizeLoadout({ ...(BUILTIN_LOADOUTS["exec-v0"] as object), name: "exec-v0-test" })));
  const arm = readLoadout(join(LOADOUTS, "exec-v0-ws.json")).loadout;
  assert.equal(arm.wire.transport, "ws");
  assert.deepEqual(arm.wire.ws, DEFAULT_WS);
});

test("continuationOf: the delta past the previous input and output, or Codex's reason for a full resend", () => {
  const props = { model: "gpt-6.1-sol", reasoning: { effort: "high" }, store: false, stream: true };
  const sent = [{ role: "developer", content: "sys" }, { role: "user", content: "task" }];
  const previous: Continuation = {
    props: JSON.stringify({ model: "gpt-6.1-sol", reasoning: { effort: "high" }, store: false }),
    inputKeys: sent.map((item) => JSON.stringify(item)),
    output: [
      { type: "reasoning", id: "rs_1", encrypted_content: "e1", summary: [], status: "completed" },
      { type: "function_call", id: "fc_1", call_id: "c1", name: "bash", arguments: "{\"command\": \"ls\"}", status: "completed" },
    ],
    responseId: "resp_1",
  };
  // pi-ai's rendering of the same output: no status, arguments re-serialized, keys in its own order.
  const rendered = [
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "e1" },
    { type: "function_call", id: "fc_1", call_id: "c1", name: "bash", arguments: "{\"command\":\"ls\"}" },
  ];
  const result = { type: "function_call_output", call_id: "c1", output: "a.txt" };
  const body = { ...props, input: [...sent, ...rendered, result] };
  assert.deepEqual(continuationOf(body, previous), { delta: [result], previousResponseId: "resp_1" });
  assert.deepEqual(continuationOf({ ...props, input: [...sent] }, { ...previous, output: [] }), { delta: [], previousResponseId: "resp_1" });
  assert.deepEqual(continuationOf(body, undefined), { reason: "no_previous_response" });
  assert.deepEqual(continuationOf({ ...body, reasoning: { effort: "xhigh" } }, previous), { reason: "property_changed:reasoning" });
  assert.deepEqual(continuationOf({ ...body, input: sent }, previous), { reason: "input_shortened" });
  assert.deepEqual(continuationOf({ ...body, input: [{ role: "developer", content: "other" }, ...body.input.slice(1)] }, previous), { reason: "input_mismatch" });
  const edited = [rendered[0], { ...rendered[1], arguments: "{\"command\":\"ls -la\"}" }];
  const edit = continuationOf({ ...body, input: [...sent, ...edited, result] }, previous) as { reason: string; detail: { index: number; sent: Record<string, string>; server: Record<string, string> } };
  assert.equal(edit.reason, "output_mismatch");
  assert.equal(edit.detail.index, 1, "the trace names the first differing output item");
  assert.notEqual(edit.detail.sent.arguments, edit.detail.server.arguments, "and which of its fields differ");
  assert.equal(edit.detail.sent.call_id, edit.detail.server.call_id);
  const dropped = [rendered[1], result, result];
  assert.equal((continuationOf({ ...body, input: [...sent, ...dropped] }, previous) as { reason: string }).reason, "output_mismatch", "reasoning_carry false drops the reasoning item: no chain");
});

test("handshakeHeaders: the caller's auth and identity, no body headers, the WebSocket beta once", () => {
  const headers = handshakeHeaders({ authorization: "Bearer k", "content-type": "application/json", "x-stainless-os": "MacOS", accept: "text/event-stream", session_id: "s", "x-client-request-id": "s" });
  assert.deepEqual(headers, { authorization: "Bearer k", session_id: "s", "x-client-request-id": "s", "openai-beta": OPENAI_BETA_WS });
  assert.equal(handshakeHeaders({ "openai-beta": "a=1" })["openai-beta"], `a=1,${OPENAI_BETA_WS}`);
  assert.equal(handshakeHeaders({ "openai-beta": OPENAI_BETA_WS })["openai-beta"], OPENAI_BETA_WS);
});

/** The loopback scenarios with grep's missing-file message silenced: stdout and stderr interleave in no fixed order, and two runs are compared. */
const quiet = (steps: Step[]): Step[] => JSON.parse(JSON.stringify(steps).replaceAll("grep -q ok a.txt", "grep -qs ok a.txt")) as Step[];

for (const [base, steps] of [["exec-v0", quiet(EXEC_SCENARIO)], ["compact-v0-plain", quiet(COMPACT_SCENARIO)]] as const) {
  test(`${base}-ws sends HTTP's bodies over one socket, chained after a generate:false prewarm, and traces HTTP's usage`, async () => {
    const http = await runFake(readLoadout(base).loadout, steps);
    const ws = await runFake(readLoadout(join(LOADOUTS, `${base}-ws.json`)).loadout, steps);
    assert.equal(http.result.status, "finished");
    assert.equal(ws.result.status, "finished");
    assert.deepEqual(ws.server.transports, steps.map(() => "ws"));
    assert.equal(ws.server.connections, 1, "one connection per run");
    const handshake = ws.server.handshakes[0]!;
    assert.equal(handshake.authorization, "Bearer sk-test");
    assert.equal(handshake["openai-beta"], "responses_websockets=2026-02-06");
    assert.equal(handshake["x-client-request-id"], ws.server.bodies[0]!.prompt_cache_key, "the run's session id, as on HTTP");
    assert.equal(ws.server.bodies.length, http.server.bodies.length);
    for (let index = 0; index < http.server.bodies.length; index++) {
      assert.deepEqual(comparable(ws.server.bodies[index]!, ws.cwd), comparable(http.server.bodies[index]!, http.cwd), `request ${index + 1}`);
    }
    assert.deepEqual(usageOf(ws.trace), usageOf(http.trace), "usage, cache share and cost fields are pi-ai's, transport-blind");
    assert.deepEqual(ws.result.usage, http.result.usage);
    assert.equal(ws.result.cost_usd, http.result.cost_usd);
    // The frames: the prewarm carries the whole first body with generate:false; every request after chains with only new items.
    const [prewarm, ...frames] = ws.server.frames;
    assert.equal(prewarm!.generate, false);
    assert.equal(prewarm!.stream, undefined, "transport fields are not sent");
    assert.deepEqual(prewarm!.input, http.server.bodies[0]!.input.map((item: Body) => JSON.parse(JSON.stringify(item).replaceAll(http.cwd, ws.cwd))));
    assert.equal(frames.length, steps.length);
    assert.deepEqual(frames.map((frame) => frame.previous_response_id), ["warm_1", ...steps.slice(1).map((_, index) => `resp_${index + 1}`)]);
    assert.equal(frames[0]!.input.length, 0, "the first request chains from the prewarm with an empty delta");
    for (const frame of frames) {
      assert.equal(frame.store, false, "store:false: the chain lives in the connection's cache");
      assert.equal(frame.stream, undefined);
      assert.equal(frame.generate, undefined);
    }
    for (const frame of frames.slice(1)) assert.deepEqual(frame.input.map((item: Body) => item.type ?? item.role), [base === "exec-v0" ? "custom_tool_call_output" : "function_call_output"]);
    const requests = kinds(ws.trace, "ws", "request");
    assert.deepEqual(requests.map((event) => event.mode), steps.map(() => "incremental"));
    assert.deepEqual(requests.map((event) => event.n), steps.map((_, index) => index + 1));
    assert.ok(requests.every((event) => event.bytes < event.bytes_full));
    assert.equal(kinds(ws.trace, "ws", "connect").length, 1);
    assert.equal(kinds(ws.trace, "ws", "prewarm")[0]!.ok, true);
    assert.equal(kinds(ws.trace, "transport_fallback").length, 0);
    const summary = ws.result.transport!;
    assert.equal(summary.ws_requests, steps.length);
    assert.equal(summary.http_requests, 0);
    assert.equal(summary.incremental, steps.length);
    assert.equal(summary.full, 0);
    assert.ok(summary.bytes_sent * 2 < summary.bytes_full, `${summary.bytes_sent} of ${summary.bytes_full} bytes`);
    assert.equal(http.result.transport, undefined, "HTTP runs report no transport block");
  });
}

test("prewarm off: the first request goes whole (first_request), the rest chain", async () => {
  const run = await runFake(withWire("exec-v0", { transport: "ws", ws: { prewarm: false } }), EXEC_SCENARIO);
  assert.equal(run.result.status, "finished");
  assert.ok(run.server.frames.every((frame) => frame.generate === undefined));
  const requests = kinds(run.trace, "ws", "request");
  assert.deepEqual(requests.map((event) => event.reason ?? event.mode), ["first_request", "incremental", "incremental", "incremental", "incremental"]);
  assert.equal(kinds(run.trace, "ws", "prewarm").length, 0);
});

test("response.completed re-encrypts reasoning: the chain follows the items pi-ai replays (output_item.done), so every request after the first is a delta", async () => {
  const run = await runFake(withWire("exec-v0", { transport: "ws", ws: { prewarm: false } }), EXEC_SCENARIO, { reencrypt_completed: true });
  assert.equal(run.result.status, "finished");
  const requests = kinds(run.trace, "ws", "request");
  assert.deepEqual(requests.map((event) => event.reason ?? event.mode), ["first_request", "incremental", "incremental", "incremental", "incremental"]);
});

// ---------- a prewarm on a socket that takes the frame and goes silent (a stalled upstream or relay) ----------

/** One streaming POST through `transport`, as pi-ai's provider sends it. */
const postVia = (transport: WsTransport, url: string, input: unknown[], signal?: AbortSignal) => transport.fetch(`${url}/responses`, {
  method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" },
  body: JSON.stringify({ model: "gpt-6.1-sol", store: false, stream: true, input }), ...(signal === undefined ? {} : { signal }),
});
const userItem = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });

for (const stall of ["silent", "after_created"] as const) {
  test(`a stalled prewarm (${stall}) ends with its request's abort: the request rejects, the socket closes, the next request goes whole`, { timeout: 15_000 }, async () => {
    const server = await startFakeResponses([{ text: "one" }], { stall_prewarm: stall });
    const events: Body[] = [];
    // The deadline is far away: only the abort can end the prewarm here.
    const transport = new WsTransport({ ...DEFAULT_WS, connect_timeout_ms: 60_000 }, { event: (type, fields) => events.push({ type, ...fields }) });
    try {
      const abort = new AbortController();
      const started = performance.now();
      setTimeout(() => abort.abort(new Error("budget_wall")), 150);
      await assert.rejects(postVia(transport, server.url, [userItem("a")], abort.signal), { name: "AbortError" });
      const ms = performance.now() - started;
      assert.ok(ms < 2_000, `rejected ${Math.round(ms)} ms after the request, 150 ms after the abort`);
      assert.deepEqual(server.frames.map((frame) => frame.generate), [false], "only the prewarm went out");
      const prewarm = kinds(events, "ws", "prewarm");
      assert.deepEqual(prewarm.map((event) => [event.ok, event.error]), [[false, "aborted"]]);
      // The stalled socket is dropped: the next request opens a new one and goes whole, named by the abort.
      const next = await postVia(transport, server.url, [userItem("b")]);
      assert.match(await next.text(), /event: response\.completed/u);
      assert.equal(server.connections, 2);
      assert.deepEqual(kinds(events, "ws", "request").map((event) => event.reason ?? event.mode), ["aborted"]);
      assert.equal(server.frames.at(-1)!.previous_response_id, undefined);
    } finally {
      transport.close();
      await server.close();
    }
  });

  test(`a stalled prewarm (${stall}) is dropped at connect_timeout_ms: the request goes whole on a new socket (prewarm_failed)`, { timeout: 15_000 }, async () => {
    const server = await startFakeResponses([{ text: "one" }], { stall_prewarm: stall });
    const events: Body[] = [];
    const transport = new WsTransport({ ...DEFAULT_WS, connect_timeout_ms: 200 }, { event: (type, fields) => events.push({ type, ...fields }) });
    try {
      const response = await postVia(transport, server.url, [userItem("a")]);
      assert.match(await response.text(), /event: response\.completed/u);
      const prewarm = kinds(events, "ws", "prewarm");
      assert.equal(prewarm.length, 1);
      assert.equal(prewarm[0]!.ok, false);
      assert.equal(prewarm[0]!.error, "prewarm timed out after 200 ms");
      assert.ok((prewarm[0]!.ms as number) >= 190 && (prewarm[0]!.ms as number) < 2_000, `${String(prewarm[0]!.ms)} ms`);
      assert.deepEqual(kinds(events, "ws", "request").map((event) => event.reason ?? event.mode), ["prewarm_failed"]);
      assert.deepEqual(server.frames.map((frame) => [frame.generate ?? null, frame.previous_response_id ?? null]), [[false, null], [null, null]]);
      assert.equal(server.connections, 2, "the silent socket is dropped, never reused");
      assert.deepEqual(server.transports, ["ws"]);
      const summary = transport.summary();
      assert.deepEqual([summary.ws_requests, summary.http_requests, summary.failures, summary.fallback], [1, 0, 0, null]);
      assert.deepEqual(summary.full_reasons, { prewarm_failed: 1 });
    } finally {
      transport.close();
      await server.close();
    }
  });
}

test("a whole exec-v0-ws run on a stalled prewarm: the wall budget's hard stop ends it on time; a short connect_timeout_ms lets it finish", { timeout: 30_000 }, async () => {
  const started = performance.now();
  const stopped = await runFake(readLoadout(join(LOADOUTS, "exec-v0-ws.json")).loadout, EXEC_SCENARIO, { stall_prewarm: "silent" }, { wall_s: 1 });
  const ms = performance.now() - started;
  assert.equal(stopped.result.stop_reason, "budget_wall");
  assert.ok(ms < 5_000, `the run returned ${Math.round(ms)} ms after it started (wall 1 s, prewarm deadline 10 s)`);
  assert.equal(stopped.server.bodies.length, 0, "no model request was answered");
  assert.deepEqual(kinds(stopped.trace, "ws", "prewarm").map((event) => event.error), ["aborted"]);
  const finished = await runFake(withWire("exec-v0", { transport: "ws", ws: { connect_timeout_ms: 300 } }), quiet(EXEC_SCENARIO), { stall_prewarm: "silent" });
  assert.equal(finished.result.status, "finished");
  assert.deepEqual(finished.server.transports, EXEC_SCENARIO.map(() => "ws"));
  const reasons = kinds(finished.trace, "ws", "request").map((event) => event.reason ?? event.mode);
  assert.deepEqual(reasons, ["prewarm_failed", ...EXEC_SCENARIO.slice(1).map(() => "incremental")]);
  assert.equal(finished.result.transport!.failures, 0);
});

test("incremental off: every request is a full resend on the one socket (the ablation)", async () => {
  const run = await runFake(withWire("exec-v0", { transport: "ws", ws: { incremental: false } }), EXEC_SCENARIO);
  assert.equal(run.result.status, "finished");
  assert.equal(run.server.connections, 1);
  assert.ok(run.server.frames.every((frame) => frame.previous_response_id === undefined && frame.generate === undefined));
  assert.deepEqual(run.result.transport!.full_reasons, { incremental_off: 5 });
  const { bytes_sent: sent, bytes_full: full } = run.result.transport!;
  assert.ok(Math.abs(sent - full) <= 5 * 16, `the whole body every time (only \`stream\` out, \`type\` in): ${sent} vs ${full}`);
});

test("D2 escalation changes reasoning.effort: each flip goes whole (property_changed:reasoning), an unchanged effort chains", async () => {
  const run = await runFake(withWire("exec-v0", { transport: "ws" }, { depth: { escalate: { on: ["after_red"] } } }), EXEC_SCENARIO);
  assert.equal(run.result.status, "finished");
  assert.equal(run.server.transports.every((transport) => transport === "ws"), true);
  const efforts = run.server.bodies.map((body) => body.reasoning.effort as string);
  assert.ok(new Set(efforts).size > 1, `the lever flipped the effort: ${efforts.join(",")}`);
  const reasons = kinds(run.trace, "ws", "request").map((event) => event.reason ?? event.mode);
  assert.deepEqual(reasons, efforts.map((effort, index) => (index > 0 && effort !== efforts[index - 1] ? "property_changed:reasoning" : "incremental")));
});

test("previous_response_not_found: one full resend on the same socket, named", async () => {
  const run = await runFake(readLoadout(join(LOADOUTS, "exec-v0-ws.json")).loadout, EXEC_SCENARIO, { forget_once: true });
  assert.equal(run.result.status, "finished");
  assert.equal(run.server.connections, 1);
  assert.equal(run.server.bodies.length, EXEC_SCENARIO.length);
  const reasons = kinds(run.trace, "ws", "request").map((event) => event.reason ?? event.mode);
  assert.deepEqual(reasons, ["incremental", "previous_response_not_found", "incremental", "incremental", "incremental", "incremental"]);
  assert.equal(run.result.provider_retries, 0, "the harness never saw it");
});

test("the 60-minute connection limit: one reconnect and a full resend, no fallback", async () => {
  const run = await runFake(readLoadout(join(LOADOUTS, "exec-v0-ws.json")).loadout, EXEC_SCENARIO, { limit_at: 3 });
  assert.equal(run.result.status, "finished");
  assert.equal(run.server.connections, 2);
  assert.deepEqual(run.server.transports, EXEC_SCENARIO.map(() => "ws"));
  const reasons = kinds(run.trace, "ws", "request").map((event) => event.reason ?? event.mode);
  assert.deepEqual(reasons, ["incremental", "incremental", "incremental", "connection_limit", "incremental", "incremental"]);
  assert.equal(kinds(run.trace, "transport_fallback").length, 0);
  assert.equal(kinds(run.trace, "ws", "connect").filter((event) => event.ok).length, 2);
});

test("a refused upgrade (no WebSocket at the base URL): each request over HTTP, then the run stays on HTTP, all traced", async () => {
  const run = await runFake(readLoadout(join(LOADOUTS, "exec-v0-ws.json")).loadout, EXEC_SCENARIO, { refuse: 404 });
  assert.equal(run.result.status, "finished");
  assert.deepEqual(run.server.transports, EXEC_SCENARIO.map(() => "http"));
  const fallbacks = kinds(run.trace, "transport_fallback");
  assert.deepEqual(fallbacks.map((event) => event.scope), ["request", "request", "run"]);
  assert.ok(fallbacks.every((event) => event.from === "ws" && event.to === "http" && event.phase === "connect"));
  const summary = run.result.transport!;
  assert.equal(summary.http_requests, EXEC_SCENARIO.length);
  assert.equal(summary.ws_requests, 0);
  assert.notEqual(summary.fallback, null);
  assert.equal(run.server.handshakes.length, 3, "the early connect (request 1 waits on it) and two more attempts; none after the run fell back");
});

test("a socket lost before the first event: that request over HTTP, the next on a new socket (reconnect)", async () => {
  const run = await runFake(readLoadout(join(LOADOUTS, "exec-v0-ws.json")).loadout, EXEC_SCENARIO, { drop: { at: 2, when: "before" } });
  assert.equal(run.result.status, "finished");
  assert.deepEqual(run.server.transports, ["ws", "http", "ws", "ws", "ws"]);
  const fallback = kinds(run.trace, "transport_fallback");
  assert.equal(fallback.length, 1);
  assert.deepEqual([fallback[0]!.phase, fallback[0]!.scope, fallback[0]!.n], ["before_events", "request", 2]);
  const reasons = kinds(run.trace, "ws", "request").map((event) => event.reason ?? event.mode);
  assert.deepEqual(reasons, ["incremental", "incremental", "reconnect", "incremental", "incremental"]);
  assert.equal(run.server.connections, 2);
});

test("a socket lost mid-response: a transient error the run's retry re-sends, over a new socket", async () => {
  const loadout = withWire("exec-v0", { transport: "ws" }, { policy: { retry: { base_ms: 1, max_ms: 5 } } });
  const run = await runFake(loadout, EXEC_SCENARIO, { drop: { at: 2, when: "after_created" } });
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.provider_retries, 1);
  const fallback = kinds(run.trace, "transport_fallback");
  assert.deepEqual(fallback.map((event) => [event.phase, event.scope]), [["mid_stream", "request"]]);
  assert.deepEqual(run.server.transports, EXEC_SCENARIO.map(() => "ws"), "request 2 is sent again, over WS");
  assert.equal(run.server.connections, 2);
  assert.match(String(kinds(run.trace, "request_end")[1]!.error), /stream was interrupted/u);
  const reasons = kinds(run.trace, "ws", "request").map((event) => event.reason ?? event.mode);
  assert.deepEqual(reasons, ["incremental", "incremental", "reconnect", "incremental", "incremental", "incremental"]);
});

test("an error event before the response is the HTTP status error pi-ai would see (400: no retry, named)", async () => {
  const run = await runFake(readLoadout(join(LOADOUTS, "exec-v0-ws.json")).loadout, EXEC_SCENARIO, { error_at: { at: 2, status: 400, code: "invalid_prompt" } });
  assert.equal(run.result.status, "error");
  assert.equal(run.result.stop_reason, "provider_error");
  assert.match(String(run.result.error), /400/u);
  assert.match(String(run.result.error), /scripted invalid_prompt/u);
  assert.equal(kinds(run.trace, "transport_fallback").length, 0, "a refusal is not a transport failure");
  assert.equal(run.result.transport!.failures, 0);
});

test("ws on a model that is not OpenAI Responses fails up front", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-ws-")));
  const env = new LocalEnv({ cwd });
  process.env.LOOPBACK_KEY = "sk-test";
  try {
    await assert.rejects(runHarness({
      prompt: "x", model: "anthropic/claude-opus-5-5", effort: "high", loadout: withWire("exec-v0", { transport: "ws" }), env,
      modelOptions: { anthropicBaseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "LOOPBACK_KEY" },
    }), /OpenAI Responses only/u);
  } finally {
    await env.close();
  }
});

test("the transport alone: a socket past max_age_s is replaced before the next request (connection_age); an aborted request never sends; a closed transport is HTTP", async () => {
  const server = await startFakeResponses([{ text: "one" }, { text: "two" }, { text: "three" }]);
  const events: Body[] = [];
  const transport = new WsTransport({ ...DEFAULT_WS, prewarm: false, max_age_s: 60 }, { event: (type, fields) => events.push({ type, ...fields }) });
  const post = (input: unknown[], signal?: AbortSignal) => transport.fetch(`${server.url}/responses`, {
    method: "POST", headers: { authorization: "Bearer k", "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.1-sol", store: false, stream: true, input }), ...(signal === undefined ? {} : { signal }),
  });
  const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
  const realNow = Date.now;
  try {
    const first = await post([user("a")]);
    assert.match(await first.text(), /event: response\.completed/u);
    const reply = (n: number, text: string) => [
      { type: "reasoning", id: `rs_${n}`, summary: [], encrypted_content: `enc-${n}` },
      { type: "message", id: `msg_${n}`, role: "assistant", content: [{ type: "output_text", text, annotations: [] }] },
    ];
    const chained = await post([user("a"), ...reply(1, "one"), user("b")]);
    await chained.text();
    Date.now = () => realNow() + 61_000;
    const aged = await post([user("a"), ...reply(1, "one"), user("b"), ...reply(2, "two"), user("c")]);
    await aged.text();
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(post([user("x")], aborted.signal), { name: "AbortError" });
    Date.now = realNow;
    const requests = events.filter((event) => event.type === "ws" && event.kind === "request").map((event) => event.reason ?? event.mode);
    assert.deepEqual(requests, ["first_request", "incremental", "connection_age"], "the aborted request sent nothing");
    assert.equal(server.connections, 2);
    assert.deepEqual(server.frames.map((frame) => frame.previous_response_id ?? null), [null, "resp_1", null]);
    transport.close();
    const after = await post([user("d")]);
    await after.text();
    assert.deepEqual(server.transports, ["ws", "ws", "ws", "http"]);
    assert.equal(transport.summary().http_requests, 1);
  } finally {
    Date.now = realNow;
    transport.close();
    await server.close();
  }
});
