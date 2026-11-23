/**
 * Wire knobs: each one asserted on the request body pi-ai 1.4 actually sends,
 * captured by a fake `fetch` (OpenAI Responses and Anthropic Messages SSE),
 * plus output-cap continuation through a loopback Responses server.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInitialSystemMessage, type Message } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadLoadout, loadoutHash, normalizeLoadout } from "../src/loadout.ts";
import { resolveModel, type Effort } from "../src/models.ts";
import { runHarness } from "../src/run.ts";
import { normalizeWire, uuidv5, wireSetup, type Wire } from "../src/wire.ts";

const fail = (message: string): never => {
  throw new LoadoutError(message);
};

const sse = (events: [string, object][]) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");

const OPENAI_SSE = sse([
  ["response.created", { response: { id: "resp_1", status: "in_progress" } }],
  ["response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } }],
  ["response.output_text.delta", { output_index: 0, item_id: "msg_1", content_index: 0, delta: "ok" }],
  ["response.output_item.done", { output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } }],
  ["response.completed", { response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11 } } }],
]);

const ANTHROPIC_SSE = sse([
  ["message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }],
  ["content_block_stop", { index: 0 }],
  ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
  ["message_stop", {}],
]);

const TOOL = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } as never;

/** A transcript with a prior turn: reasoning (OpenAI), a tool call and its result, then a new user message. */
function transcript(api: "openai-responses" | "anthropic-messages"): Message[] {
  const system = createInitialSystemMessage("You are a coding agent.", [TOOL])!;
  const provider = api === "openai-responses" ? "openai" : "anthropic";
  const model = api === "openai-responses" ? "gpt-6.1-sol" : "claude-opus-5-5";
  const reasoning = api === "openai-responses"
    ? [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] }) }]
    : [];
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return [
    system,
    { role: "user", content: [{ type: "text", text: "Fix the bug." }], timestamp: 1 },
    { role: "assistant", content: [...reasoning, { type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "a.py" } }], api, provider, model, usage, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call_1|fc_1", toolName: "read", content: [{ type: "text", text: "print(1)" }], isError: false, timestamp: 3 },
    { role: "user", content: [{ type: "text", text: "Go on." }], timestamp: 4 },
  ] as Message[];
}

/** The body pi-ai sends for `spec` with these wire knobs, through a fake fetch. */
async function captured(spec: string, raw: Record<string, unknown>, effort: Effort = "high", sessionId = "session-1", messages?: Message[]): Promise<Record<string, any>> {
  const wire: Wire = normalizeWire(raw as never, fail);
  process.env.WIRE_TEST_KEY = "sk-test"; // resolveModel fails closed on a missing key; the stream below passes its own
  const resolved = resolveModel(spec, { apiKeyEnv: "WIRE_TEST_KEY" });
  const setup = wireSetup(wire, resolved.model, sessionId, effort);
  let body: Record<string, any> | undefined;
  const anthropic = resolved.model.api === "anthropic-messages";
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body));
    return new Response(anthropic ? ANTHROPIC_SSE : OPENAI_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const stream = resolved.models.streamSimple(setup.model, { messages: messages ?? transcript(anthropic ? "anthropic-messages" : "openai-responses") }, {
    apiKey: anthropic ? "sk-ant-test" : "sk-test", reasoning: effort, sessionId, cacheRetention: wire.cache_retention, maxRetries: 0,
    ...(wire.max_output_tokens === undefined ? {} : { maxTokens: wire.max_output_tokens }),
    ...(setup.onPayload === undefined ? {} : { onPayload: setup.onPayload }), ...setup.streamOptions, fetch,
  } as never);
  const message = await stream.result();
  assert.notEqual(message.stopReason, "error", message.errorMessage ?? "provider error");
  assert.ok(body !== undefined, "the fake transport saw a request");
  return body;
}

const SOL = "openai/gpt-6.1-sol";
const OPUS = "anthropic/claude-opus-5-5";
const items = (body: Record<string, any>, type: string) => (body.input as { type?: string }[]).filter((item) => item.type === type);

test("(a) mid_convo_effort: Pi pins medium plus configuration_update items; off sends plain reasoning.effort", async () => {
  const pi = await captured(SOL, {});
  assert.equal(pi.reasoning.effort, "medium");
  const updates = items(pi, "configuration_update").map((item: any) => item.reasoning.effort);
  assert.ok(updates.length >= 1 && updates.every((effort: string) => effort === "high"), JSON.stringify(updates));
  const plain = await captured(SOL, { mid_convo_effort: false });
  assert.equal(plain.reasoning.effort, "high");
  assert.equal(items(plain, "configuration_update").length, 0);

  const opusPi = await captured(OPUS, {}, "low");
  assert.deepEqual(opusPi.output_config, { effort: "high" }, "Pi pins Anthropic effort and carries the level in messages");
  assert.ok(opusPi.thinking.block_binding !== undefined);
  const opusPlain = await captured(OPUS, { mid_convo_effort: false }, "low");
  assert.deepEqual(opusPlain.output_config, { effort: "low" });
  assert.equal(opusPlain.thinking.type, "adaptive");
  assert.equal(opusPlain.thinking.block_binding, undefined);
});

test("(b) reasoning.context and encrypted reasoning carry-over", async () => {
  const pi = await captured(SOL, {});
  assert.equal(pi.store, false);
  assert.deepEqual(pi.include, ["reasoning.encrypted_content"]);
  assert.equal(pi.reasoning.context, undefined);
  assert.deepEqual(items(pi, "reasoning").map((item: any) => item.encrypted_content), ["enc-1"], "Pi replays the prior turn's encrypted reasoning");
  const allTurns = await captured(SOL, { reasoning_context: "all_turns" });
  assert.equal(allTurns.reasoning.context, "all_turns");
  const dropped = await captured(SOL, { reasoning_carry: false });
  assert.equal(items(dropped, "reasoning").length, 0);
  assert.equal(dropped.include, undefined);
  assert.equal(dropped.store, false);
});

test("(c) text.verbosity and (d) reasoning.summary", async () => {
  const pi = await captured(SOL, {});
  assert.equal(pi.text, undefined);
  assert.equal(pi.reasoning.summary, "auto", "Pi's default");
  const low = await captured(SOL, { verbosity: "low", reasoning_summary: "none" });
  assert.deepEqual(low.text, { verbosity: "low" });
  assert.equal("summary" in low.reasoning, false, "none omits the field, as Codex does for GPT-6.x");
  const concise = await captured(SOL, { reasoning_summary: "concise" });
  assert.equal(concise.reasoning.summary, "concise");
});

test("(e) prompt_cache_key is the session id on every request; off omits it", async () => {
  const one = await captured(SOL, {}, "high", "session-A");
  const two = await captured(SOL, {}, "high", "session-A");
  assert.equal(one.prompt_cache_key, "session-A");
  assert.equal(two.prompt_cache_key, one.prompt_cache_key);
  const off = await captured(SOL, { prompt_cache_key: "off" });
  assert.equal(off.prompt_cache_key, undefined);
});

test("(f) responses_lite_ids: tools and instructions lead the input with Codex's deterministic ids", async () => {
  // RFC 4122 test vector (DNS namespace, "python.org").
  assert.equal(uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
  const pi = await captured(SOL, {});
  assert.equal(pi.tools, undefined, "Pi already declares tools in an additional_tools input item");
  assert.equal(pi.input[0].type, "additional_tools");
  assert.equal(pi.input[0].id, undefined);
  assert.equal(pi.input[1].role, "developer");
  const one = await captured(SOL, { responses_lite_ids: true }, "high", "thread-1");
  const again = await captured(SOL, { responses_lite_ids: true }, "high", "thread-1");
  const other = await captured(SOL, { responses_lite_ids: true }, "high", "thread-2");
  assert.match(one.input[0].id, /^at_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.deepEqual(one.input[0].tools, pi.input[0].tools);
  assert.deepEqual(one.input[1], { type: "message", id: one.input[1].id, role: "developer", content: [{ type: "input_text", text: "You are a coding agent." }] });
  assert.match(one.input[1].id, /^msg_[0-9a-f-]{36}$/u);
  assert.equal(one.input[0].id, again.input[0].id);
  assert.equal(one.input[1].id, again.input[1].id);
  assert.notEqual(one.input[0].id, other.input[0].id, "ids are namespaced by the session");
  const namespace = uuidv5("6ba7b812-9dad-11d1-80b4-00c04fd430c8", "thread-1");
  assert.equal(one.input[0].id, `at_${uuidv5(namespace, JSON.stringify(pi.input[0].tools))}`);
  assert.equal(one.input[1].id, `msg_${uuidv5(namespace, "You are a coding agent.")}`);
});

test("(g) parallel_tool_calls on OpenAI and Anthropic", async () => {
  assert.equal((await captured(SOL, {})).parallel_tool_calls, undefined);
  assert.equal((await captured(SOL, { parallel_tool_calls: false })).parallel_tool_calls, false);
  assert.equal((await captured(SOL, { parallel_tool_calls: true })).parallel_tool_calls, true);
  assert.equal((await captured(OPUS, {})).tool_choice, undefined);
  assert.deepEqual((await captured(OPUS, { parallel_tool_calls: false })).tool_choice, { type: "auto", disable_parallel_tool_use: true });
});

test("(h) max_output_tokens reaches both providers", async () => {
  assert.equal((await captured(SOL, { max_output_tokens: 4096 })).max_output_tokens, 4096);
  assert.equal((await captured(OPUS, { max_output_tokens: 4096 })).max_tokens, 4096);
});

test("(h) a response cut at max_output_tokens is continued with the length nudge", async () => {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const n = bodies.length;
      const item = { type: "message", id: `msg_${n}`, role: "assistant", status: "in_progress", content: [] };
      const text = n === 1 ? "The answer is" : " 42.";
      res.write(sse([
        ["response.created", { response: { id: `resp_${n}`, status: "in_progress" } }],
        ["response.output_item.added", { output_index: 0, item }],
        ["response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: text }],
        ["response.output_item.done", { output_index: 0, item: { ...item, status: n === 1 ? "incomplete" : "completed", content: [{ type: "output_text", text, annotations: [] }] } }],
        n === 1
          ? ["response.incomplete", { response: { id: "resp_1", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 64, total_tokens: 74 } } }]
          : ["response.completed", { response: { id: "resp_2", status: "completed", usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } }],
      ]));
      res.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const root = mkdtempSync(join(tmpdir(), "harness-wire-"));
  const env = new LocalEnv({ cwd: root });
  try {
    const loadout = normalizeLoadout({ ...structuredClone(BUILTIN_LOADOUTS["compact-v0"]) as object, wire: { max_output_tokens: 64, mid_convo_effort: false } });
    process.env.WIRE_TEST_KEY = "sk-test";
    const result = await runHarness({
      prompt: "What is the answer?", model: SOL, effort: "high", loadout, env, tracePath: join(root, "trace.jsonl"),
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "WIRE_TEST_KEY" },
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.equal(bodies.length, 2);
    for (const body of bodies) assert.equal(body.max_output_tokens, 64);
    const last = bodies[1]!.input.at(-1);
    assert.equal(last.role, "user");
    assert.match(JSON.stringify(last.content), /cut off at the output token limit/u);
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
});

test("(i) Anthropic cache breakpoints: Pi's placement, prefix/tail TTLs, a second tail breakpoint", async () => {
  const marks = (body: Record<string, any>) => [
    ...body.system.map((block: any) => ["system", block.cache_control]),
    ...body.tools.map((tool: any) => [`tool:${tool.name}`, tool.cache_control]),
    ...body.messages.flatMap((message: any, index: number) => (Array.isArray(message.content) ? message.content : [])
      .map((block: any) => [`m${index}:${block.type}`, block.cache_control])),
  ].filter(([, control]) => control !== undefined);
  const pi = await captured(OPUS, {});
  // Pi ends with a system effort message (mid-convo effort); the tail breakpoint sits on the last user message.
  const lastUser = (body: Record<string, any>) => body.messages.findLastIndex((message: any) => message.role === "user");
  assert.deepEqual(marks(pi), [["system", { type: "ephemeral" }], ["tool:read", { type: "ephemeral" }], [`m${lastUser(pi)}:text`, { type: "ephemeral" }]]);
  const long = await captured(OPUS, { cache_retention: "long" });
  assert.ok(marks(long).every(([, control]) => control.ttl === "1h"));
  const split = await captured(OPUS, { anthropic: { prefix_ttl: "1h", tail_ttl: "5m", tail_breakpoints: 2 } });
  const last = lastUser(split);
  const previousUser = split.messages.findLastIndex((message: any, index: number) => message.role === "user" && index < last);
  const previousBlock = split.messages[previousUser].content.at(-1).type;
  assert.deepEqual(marks(split), [
    ["system", { type: "ephemeral", ttl: "1h" }], ["tool:read", { type: "ephemeral", ttl: "1h" }],
    [`m${previousUser}:${previousBlock}`, { type: "ephemeral" }], [`m${last}:text`, { type: "ephemeral" }],
  ]);
  assert.ok(marks(split).length <= 4);
  assert.throws(() => normalizeWire({ anthropic: { prefix_ttl: "5m", tail_ttl: "1h" } } as never, fail), /1h breakpoints must come first/u);
  assert.throws(() => normalizeWire({ cache_retention: "none", anthropic: { tail_ttl: "5m" } } as never, fail), /need wire.cache_retention/u);
});

/** Two Opus tool turns, each with thinking; the request goes out after the second tool result. */
function opusToolLoop(): Message[] {
  const system = createInitialSystemMessage("You are a coding agent.", [TOOL])!;
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const turn = (n: number, ts: number) => [
    { role: "assistant", content: [{ type: "thinking", thinking: `plan ${n}`, thinkingSignature: `sig-${n}` }, { type: "toolCall", id: `toolu_${n}`, name: "read", arguments: { path: `f${n}.py` } }],
      api: "anthropic-messages", provider: "anthropic", model: "claude-opus-5-5", usage, stopReason: "toolUse", timestamp: ts },
    { role: "toolResult", toolCallId: `toolu_${n}`, toolName: "read", content: [{ type: "text", text: `print(${n})` }], isError: false, timestamp: ts + 1 },
  ];
  return [system, { role: "user", content: [{ type: "text", text: "Fix the bug." }], timestamp: 1 }, ...turn(1, 2), ...turn(2, 4)] as Message[];
}

test("(i2) Anthropic thinking_history latest: only the latest assistant message keeps thinking; its prefix stays cached", async () => {
  const thinking = (body: Record<string, any>) => body.messages.map((message: any, index: number) => [index, message.role,
    (Array.isArray(message.content) ? message.content : []).filter((block: any) => block.type === "thinking").map((block: any) => block.thinking)]);
  const assistants = (body: Record<string, any>) => thinking(body).filter(([, role]: any) => role === "assistant");
  const all = await captured(OPUS, {}, "high", "session-1", opusToolLoop());
  assert.deepEqual(assistants(all).map(([, , t]: any) => t), [["plan 1"], ["plan 2"]], "by default every turn's thinking is sent");
  const latest = await captured(OPUS, { anthropic: { thinking_history: "latest" } }, "high", "session-1", opusToolLoop());
  assert.deepEqual(assistants(latest).map(([, , t]: any) => t), [[], ["plan 2"]], "only the latest assistant message keeps its thinking");
  const first = latest.messages.findIndex((message: any) => message.role === "assistant");
  assert.ok(latest.messages[first].content.some((block: any) => block.type === "tool_use"), "the earlier turn keeps its tool call");
  const lastAssistant = latest.messages.findLastIndex((message: any) => message.role === "assistant");
  const stableUser = latest.messages.slice(0, lastAssistant).findLastIndex((message: any) => message.role === "user");
  assert.deepEqual(latest.messages[stableUser].content.at(-1).cache_control, { type: "ephemeral" }, "the trimmed prefix ends on a breakpoint");
  const marks = [...latest.system, ...latest.tools, ...latest.messages.flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))]
    .filter((block: any) => block.cache_control !== undefined);
  assert.ok(marks.length <= 4, "the API allows four breakpoints");
  const none = await captured(OPUS, { cache_retention: "none", anthropic: { thinking_history: "latest" } }, "high", "session-1", opusToolLoop());
  assert.deepEqual(assistants(none).map(([, , t]: any) => t), [[], ["plan 2"]]);
  assert.equal(none.messages[stableUser].content.at(-1).cache_control, undefined, "no breakpoints when caching is off");
  assert.deepEqual(normalizeWire({ anthropic: { thinking_history: "all" } } as never, fail), normalizeWire({} as never, fail), "all is the default");
});

test("(i) Anthropic thinking: adaptive effort by default, budget mapping, display", async () => {
  const adaptive = await captured(OPUS, { mid_convo_effort: false }, "medium");
  assert.equal(adaptive.thinking.type, "adaptive");
  assert.deepEqual(adaptive.output_config, { effort: "medium" });
  const budget = await captured(OPUS, { mid_convo_effort: false, anthropic: { thinking: "budget" } }, "high");
  assert.deepEqual(budget.thinking, { type: "enabled", budget_tokens: 16384, display: "summarized" });
  assert.equal(budget.output_config, undefined);
  const custom = await captured(OPUS, { mid_convo_effort: false, max_output_tokens: 20_000, anthropic: { thinking: "budget", thinking_budgets: { xhigh: 50_000 }, thinking_display: "omitted" } }, "xhigh");
  assert.deepEqual(custom.thinking, { type: "enabled", budget_tokens: 20_000 - 1024, display: "omitted" }, "the budget leaves 1024 tokens of answer under max_tokens");
  assert.throws(() => normalizeWire({ anthropic: { thinking: "budget" } } as never, fail), /needs wire.mid_convo_effort false/u);
  assert.throws(() => normalizeWire({ anthropic: { thinking_budgets: { low: 2048 } } } as never, fail), /needs thinking "budget"/u);
});

test("wire defaults hash like omitted keys; compact-v0-plain is compact-v0 with the plain wire", () => {
  const base = structuredClone(BUILTIN_LOADOUTS["compact-v0"]) as Record<string, any>;
  const spelled = structuredClone(base);
  spelled.wire = { ...spelled.wire, mid_convo_effort: true, reasoning_carry: true, prompt_cache_key: "session", responses_lite_ids: false, anthropic: { thinking: "adaptive", tail_breakpoints: 1 } };
  assert.equal(loadoutHash(normalizeLoadout(spelled)), loadoutHash(normalizeLoadout(base)));
  const plain = loadLoadout("compact-v0-plain");
  const compact = loadLoadout("compact-v0");
  assert.deepEqual({ ...plain, name: "compact-v0", wire: compact.wire }, compact);
  assert.deepEqual(plain.wire, { cache_retention: "short", max_retries: 3, mid_convo_effort: false, reasoning_context: "all_turns", reasoning_summary: "none" });
  assert.notEqual(loadoutHash(plain), loadoutHash(compact));
  assert.throws(() => normalizeLoadout({ ...base, wire: { verbosity: "loud" } }), /loadout is invalid/u);
  assert.throws(() => normalizeLoadout({ ...base, wire: { anthropic: { cache_ttl: "1h" } } }), /loadout is invalid/u);
});

test("an arm file can set wire knobs over a built-in", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-wire-arm-"));
  const path = join(dir, "arm.json");
  writeFileSync(path, JSON.stringify({ extends: "exec-v0", name: "exec-v0-cfg", wire: { mid_convo_effort: true, cache_retention: "short" } }));
  const arm = loadLoadout(path);
  assert.equal(arm.wire.mid_convo_effort, undefined, "true is the default and is dropped");
  assert.equal(arm.wire.reasoning_context, undefined, "extends replaces top-level keys whole");
});
