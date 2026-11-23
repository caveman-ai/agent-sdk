/**
 * Anthropic message threads (src/threads.ts), against a stub API: the first request creates a thread; one that extends
 * it (previous messages, the previous response, new messages) continues it with only the new messages and no system or
 * tools; a changed history creates a new thread; a lost thread is replayed as a create at once; an API that refuses
 * threads turns them off; keep-alive pings and other calls pass untouched; the beta header rides every thread request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicThreads, type ThreadEvent } from "../src/threads.ts";
import { normalizeWire } from "../src/wire.ts";

const URL_ = "https://proxy.test/v1/messages";
const fail = (message: string): never => { throw new Error(message); };
const sse = (id: string) => [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", content: [] } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");

function stub(errors: Record<number, { status: number; code?: string }> = {}) {
  const sent: { body: Record<string, any>; beta: string | null }[] = [];
  let n = 0;
  const base = (async (_input: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    sent.push({ body, beta: new Headers(init.headers).get("anthropic-beta") });
    const k = ++n;
    const error = errors[k];
    if (error !== undefined) {
      return new Response(JSON.stringify({ type: "error", error: { type: "x", message: "m", ...(error.code === undefined ? {} : { details: { error_code: error.code } }) } }), { status: error.status });
    }
    if (body.stream === false) return new Response(JSON.stringify({ id: `ping${k}`, usage: {} }), { status: 200 });
    return new Response(sse(`msg_${k}`), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { base, sent };
}

const SYSTEM = [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }];
const TOOLS = [{ name: "bash", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }];
const u = (text: string, cache = false) => ({ role: "user", content: [{ type: "text", text, ...(cache ? { cache_control: { type: "ephemeral" } } : {}) }] });
const a = (text: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "text", text }] });
const body = (messages: unknown[]) => ({ model: "claude-opus-5-5", max_tokens: 32000, stream: true, thinking: { type: "adaptive" }, output_config: { effort: "high" }, system: SYSTEM, tools: TOOLS, messages });

async function call(threads: AnthropicThreads, payload: object) {
  const response = await threads.fetch(URL_, { method: "POST", body: JSON.stringify(payload), headers: { "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "content-length": "1" } });
  await response.text(); // read to the end, as pi-ai does
  return response;
}

test("create, then continue with only the new messages; a changed history starts a new thread", async () => {
  const { base, sent } = stub();
  const events: ThreadEvent[] = [];
  const threads = new AnthropicThreads({ base, onEvent: (event) => events.push(event) });
  await call(threads, body([u("task", true)]));
  await call(threads, body([u("task"), a("one"), u("result 1", true)]));
  await call(threads, body([u("task"), a("one"), u("result 1"), a("two"), u("result 2", true)]));
  assert.deepEqual(sent[0]!.body.thread, { type: "create" });
  assert.equal(sent[0]!.beta, "fine-grained-tool-streaming-2025-05-14,message-threads-2026-08-12");
  assert.deepEqual(sent[1]!.body.thread, { type: "continue", previous_message_id: "msg_1" });
  assert.equal(sent[1]!.body.system, undefined);
  assert.equal(sent[1]!.body.tools, undefined);
  assert.deepEqual(sent[1]!.body.messages, [u("result 1", true)], "only the new messages, breakpoint kept");
  assert.deepEqual(sent[1]!.body.output_config, { effort: "high" }, "fixed fields on every request");
  assert.deepEqual(sent[2]!.body.thread, { type: "continue", previous_message_id: "msg_2" });
  assert.deepEqual(events.map((event) => event.mode), ["create", "continue", "continue"]);
  assert.ok(events[2]!.bytes < events[2]!.full_bytes);
  await call(threads, body([u("other task", true)]));
  assert.deepEqual(sent[3]!.body.thread, { type: "create" });
  assert.equal(events[3]!.reason, "no new messages");
});

test("a lost thread is replayed as a create at once; lost again right after a replay, threads go off", async () => {
  const { base, sent } = stub({ 2: { status: 404, code: "thread_not_found" }, 4: { status: 404, code: "thread_not_found" } });
  const events: ThreadEvent[] = [];
  const threads = new AnthropicThreads({ base, onEvent: (event) => events.push(event) });
  await call(threads, body([u("task", true)]));
  const replayed = await call(threads, body([u("task"), a("one"), u("result 1", true)]));
  assert.equal(replayed.status, 200);
  assert.deepEqual(sent[2]!.body.thread, { type: "create" });
  assert.equal(sent[2]!.body.messages.length, 3, "the whole conversation");
  await call(threads, body([u("task"), a("one"), u("result 1"), a("two"), u("result 2", true)]));
  assert.deepEqual(events.map((event) => event.mode), ["create", "replay", "off"]);
  assert.equal(sent[4]!.body.thread, undefined, "off: sent as pi-ai built it");
  assert.equal(sent[4]!.beta, "fine-grained-tool-streaming-2025-05-14");
  await call(threads, body([u("task"), a("one"), u("result 1"), a("two"), u("result 2"), a("three"), u("result 3", true)]));
  assert.equal(sent[5]!.body.thread, undefined);
});

test("an API that refuses threads turns them off; other errors pass through; pings and plain calls are untouched", async () => {
  const refused = stub({ 1: { status: 400, code: "thread_unsupported_request" } });
  const threads = new AnthropicThreads({ base: refused.base });
  const first = await call(threads, body([u("task", true)]));
  assert.equal(first.status, 200);
  assert.equal(refused.sent[1]!.body.thread, undefined, "resent without thread");

  const failing = stub({ 1: { status: 529 } });
  const t2 = new AnthropicThreads({ base: failing.base });
  const overloaded = await t2.fetch(URL_, { method: "POST", body: JSON.stringify(body([u("task", true)])) });
  assert.equal(overloaded.status, 529);
  assert.match(await overloaded.text(), /"type":"error"/u, "pi-ai still reads the error body");

  const plain = stub();
  const t3 = new AnthropicThreads({ base: plain.base });
  await t3.fetch(URL_, { method: "POST", body: JSON.stringify({ ...body([u("task", true)]), max_tokens: 0, stream: false }) });
  assert.equal(plain.sent[0]!.body.thread, undefined, "a keep-alive ping is not threaded");
  assert.equal(plain.sent[0]!.beta, null);
});

test("wire.anthropic.thread normalizes; not with thinking_history latest", () => {
  assert.equal(normalizeWire({ cache_retention: "short", anthropic: { thread: true } } as never, fail).anthropic?.thread, true);
  assert.equal(normalizeWire({ cache_retention: "short", anthropic: { thread: false } } as never, fail).anthropic?.thread, undefined);
  assert.throws(() => normalizeWire({ cache_retention: "short", anthropic: { thread: true, thinking_history: "latest" } } as never, fail), /thinking_history latest/u);
});
