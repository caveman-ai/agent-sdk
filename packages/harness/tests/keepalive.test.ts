/**
 * wire.anthropic.keepalive_s (src/keepalive.ts): the last streamed Messages request is re-sent with max_tokens 0
 * and stream false when no request starts within the interval, with the same URL, headers and prompt; real requests
 * reset the gap; pings stop at keepalive_max and on close. Plus the knob's normalization.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheKeepAlive, type KeepAliveUsage } from "../src/keepalive.ts";
import { LoadoutError } from "../src/loadout.ts";
import { normalizeWire } from "../src/wire.ts";

const fail = (message: string): never => {
  throw new LoadoutError(message);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Sent { url: string; headers: Headers; body: Record<string, unknown> }

function harness(options: { intervalMs?: number; maxPerGap?: number; status?: number } = {}) {
  const sent: Sent[] = [];
  const pings: { usage: KeepAliveUsage | undefined; error?: string }[] = [];
  const base: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    const status = options.status ?? 200;
    const payload = status === 200
      ? { id: "msg_ka", type: "message", content: [], stop_reason: "max_tokens", usage: { input_tokens: 3, cache_read_input_tokens: 41_000, cache_creation_input_tokens: 0, output_tokens: 0 } }
      : { type: "error", error: { type: "invalid_request_error", message: "nope" } };
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  const keepalive = new CacheKeepAlive({
    intervalMs: options.intervalMs ?? 40, maxPerGap: options.maxPerGap ?? 12, base,
    onPing: (usage, _latency, error) => pings.push({ usage, ...(error === undefined ? {} : { error }) }),
  });
  return { keepalive, sent, pings };
}

const REQUEST = {
  model: "claude-opus-5-5", max_tokens: 32_000, stream: true, thinking: { type: "adaptive" }, output_config: { effort: "high" },
  system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] }],
};

const post = (keepalive: CacheKeepAlive, body: object = REQUEST, url = "https://proxy.test/anthropic/v1/messages?beta=true") =>
  keepalive.fetch(url, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-api-key": "k", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "content-length": "999" },
  });

test("a streamed Messages request is re-sent with max_tokens 0 and stream false after the interval, same URL, headers and prompt", async () => {
  const { keepalive, sent, pings } = harness();
  await post(keepalive);
  assert.equal(sent.length, 1);
  // Wait for the first ping rather than a fixed time: under a loaded test run a 40 ms timer can fire late.
  for (const started = Date.now(); (sent.length < 2 || pings.length < 1) && Date.now() - started < 3000;) await sleep(5);
  keepalive.close();
  assert.ok(sent.length >= 2, `pings sent: ${sent.length - 1}`);
  const ping = sent[1]!;
  assert.equal(ping.url, sent[0]!.url);
  assert.equal(ping.headers.get("x-api-key"), "k");
  assert.equal(ping.headers.get("anthropic-beta"), "fine-grained-tool-streaming-2025-05-14");
  assert.equal(ping.headers.get("content-length"), null, "the original content-length would not fit the new body");
  assert.deepEqual(ping.body, { ...REQUEST, max_tokens: 0, stream: false });
  assert.deepEqual(pings[0], { usage: { input: 3, cacheRead: 41_000, cacheWrite: 0, output: 0 } });
});

test("a real request inside the interval resets the gap; pings repeat every interval up to maxPerGap", async () => {
  const { keepalive, sent } = harness({ intervalMs: 40, maxPerGap: 2 });
  await post(keepalive);
  await sleep(25);
  await post(keepalive, { ...REQUEST, messages: [...REQUEST.messages, { role: "assistant", content: [{ type: "text", text: "a" }] }] });
  await sleep(25);
  assert.equal(sent.length, 2, "no ping while requests keep coming");
  await sleep(150);
  keepalive.close();
  const pings = sent.slice(2);
  assert.equal(pings.length, 2, "maxPerGap bounds the pings after one real request");
  for (const ping of pings) assert.equal((ping.body.messages as unknown[]).length, 2, "the ping repeats the latest request");
});

test("non-streamed requests, other endpoints and non-POSTs never arm a ping; close stops a pending one", async () => {
  const { keepalive, sent } = harness({ intervalMs: 30 });
  await post(keepalive, { ...REQUEST, stream: false });
  await post(keepalive, REQUEST, "https://proxy.test/anthropic/v1/messages/count_tokens");
  await keepalive.fetch("https://proxy.test/anthropic/v1/messages", { method: "GET" });
  await sleep(60);
  assert.equal(sent.length, 3, "nothing but the three requests themselves");
  await post(keepalive);
  keepalive.close();
  await sleep(60);
  assert.equal(sent.length, 4, "a closed keep-alive sends nothing");
});

test("a refused ping is reported as an error and changes nothing else", async () => {
  const { keepalive, sent, pings } = harness({ intervalMs: 30, maxPerGap: 1, status: 400 });
  await post(keepalive);
  await sleep(60);
  keepalive.close();
  assert.equal(sent.length, 2);
  assert.equal(pings.length, 1);
  assert.equal(pings[0]!.usage, undefined);
  assert.match(pings[0]!.error ?? "", /HTTP 400: nope/u);
});

test("keepalive_s needs cache_retention short; keepalive_max needs keepalive_s; the default max normalizes away", () => {
  assert.deepEqual(normalizeWire({ anthropic: { keepalive_s: 270 } } as never, fail).anthropic, { keepalive_s: 270 });
  assert.deepEqual(normalizeWire({ anthropic: { keepalive_s: 270, keepalive_max: 12 } } as never, fail).anthropic, { keepalive_s: 270 });
  assert.deepEqual(normalizeWire({ anthropic: { keepalive_s: 270, keepalive_max: 4 } } as never, fail).anthropic, { keepalive_s: 270, keepalive_max: 4 });
  assert.throws(() => normalizeWire({ cache_retention: "long", anthropic: { keepalive_s: 270 } } as never, fail), /needs wire.cache_retention short/u);
  assert.throws(() => normalizeWire({ anthropic: { keepalive_max: 4 } } as never, fail), /keepalive_max needs keepalive_s/u);
});

test("through pi-ai's Anthropic client: the ping replays the exact body pi-ai sent, with max_tokens 0 and stream false", async () => {
  const { createInitialSystemMessage } = await import("@earendil-works/pi-ai");
  const { resolveModel } = await import("../src/models.ts");
  const sseOf = (events: [string, object][]) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");
  const SSE = sseOf([
    ["message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
    ["message_stop", {}],
  ]);
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const base: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body));
    seen.push({ url, body, headers: new Headers(init?.headers) });
    return body.stream === true
      ? new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } })
      : new Response(JSON.stringify({ content: [], stop_reason: "max_tokens", usage: { input_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 0 } }), { status: 200 });
  };
  const pings: (KeepAliveUsage | undefined)[] = [];
  const keepalive = new CacheKeepAlive({ intervalMs: 40, maxPerGap: 1, base, onPing: (usage) => pings.push(usage) });
  process.env.KEEPALIVE_TEST_KEY = "sk-ant-test";
  const resolved = resolveModel("anthropic/claude-opus-5-5", { apiKeyEnv: "KEEPALIVE_TEST_KEY" });
  const system = createInitialSystemMessage("You are a coding agent.", [])!;
  const stream = resolved.models.streamSimple(resolved.model, { messages: [system, { role: "user", content: [{ type: "text", text: "Fix the bug." }], timestamp: 1 }] as never }, {
    apiKey: "sk-ant-test", reasoning: "high", sessionId: "s-1", cacheRetention: "short", maxRetries: 0, fetch: keepalive.fetch,
  } as never);
  const message = await stream.result();
  assert.notEqual(message.stopReason, "error", message.errorMessage ?? "provider error");
  await sleep(80);
  keepalive.close();
  assert.equal(seen.length, 2, "one real request, one ping");
  const [real, ping] = seen as [typeof seen[0], typeof seen[0]];
  assert.match(real.url, /\/v1\/messages/u);
  assert.equal(ping.url, real.url);
  assert.equal(real.body.stream, true);
  assert.deepEqual(ping.body, { ...real.body, max_tokens: 0, stream: false });
  assert.equal(ping.headers.get("x-api-key") ?? ping.headers.get("authorization"), real.headers.get("x-api-key") ?? real.headers.get("authorization"));
  assert.equal(ping.headers.get("anthropic-beta"), real.headers.get("anthropic-beta"));
  assert.deepEqual(pings, [{ input: 2, cacheRead: 900, cacheWrite: 0, output: 0 }]);
});
