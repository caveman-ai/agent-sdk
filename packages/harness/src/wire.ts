/**
 * Wire knobs: what a loadout changes in the provider request, each through a
 * pi-ai 1.4 option (model compat, stream options) or one `onPayload` rewrite
 * of the request body Pi built. Every knob is off (Pi's request unchanged)
 * unless the loadout sets it; defaults are dropped at normalization so a
 * loadout that spells one out hashes like one that omits it.
 *
 * OpenAI Responses (GPT-6.x):
 * - mid_convo_effort (default true = Pi): false sends the effort as plain
 *   `reasoning.effort` instead of Pi's pinned "medium" plus a per-turn
 *   `configuration_update` item (r10p: plain effort = 2x reasoning, +12-17 pp).
 * - reasoning_context: `reasoning.context` ("all_turns" is Codex's Responses Lite).
 * - reasoning_carry (default true = Pi): Pi replays encrypted reasoning
 *   (store:false, include reasoning.encrypted_content); false drops it.
 * - verbosity: `text.verbosity`. reasoning_summary: "none" omits it (Codex for GPT-6.x).
 * - prompt_cache_key (default "session" = Pi: the run's session id on every request): "off" omits it.
 * - prompt_cache_key_mode "task": the key is `task-` + a hash of the model, instructions, tools and every
 *   input item through the first user message, fixed at the run's first request: every run of one task (and
 *   prefix) shares it, so parallel agents share one warm prefix cache. A factory lever, not for scored A/Bs.
 * - responses_lite_ids: Pi already sends tools as a leading `additional_tools`
 *   item and the instructions as the next developer item, as Codex 0.166
 *   does; this adds Codex's deterministic ids (`at_`/`msg_` + uuidv5 of the
 *   payload under a uuidv5 of the session id), so retries and resumes are
 *   byte-identical. The internal `x-openai-internal-codex-responses-lite`
 *   header is not sent.
 * - parallel_tool_calls: sets the field (Codex sends false for GPT-6.x).
 * - transport "ws" (W1, src/ws.ts): one Responses WebSocket per run, each
 *   request a `response.create` frame carrying the same body, chained by
 *   `previous_response_id` with only the new items; `ws` holds its settings.
 *   "http" (the default) normalizes away.
 * - max_output_tokens (core) is the Responses `max_output_tokens` / Messages
 *   `max_tokens`; a cut response is continued by policy.length_continuations.
 * Anthropic Messages (wire.anthropic):
 * - prefix_ttl / tail_ttl: Pi puts breakpoints on the system prompt, the last
 *   tool and the last message, all at the cache_retention TTL (short 5m, long
 *   1h). These set the prefix (system, tools) and tail (messages) TTLs apart;
 *   1h before 5m is required by the API, so a 5m prefix with a 1h tail fails.
 * - tail_breakpoints 2 adds a breakpoint on the previous user message, so a
 *   turn with more than 20 new blocks still finds the last cached prefix.
 * - thinking "budget" maps effort to `thinking.budget_tokens` (thinking_budgets
 *   over defaults) instead of adaptive thinking with an effort; it needs
 *   mid_convo_effort false. thinking_display "omitted" streams no thinking text.
 * - thinking_history "latest" sends thinking (and redacted_thinking) only in
 *   the latest assistant message, which the API needs during a tool loop;
 *   earlier thinking would be re-read from the cache on every request. A
 *   breakpoint on the last user message before that assistant message keeps
 *   the trimmed prefix cached; a message left with no other content keeps its
 *   thinking. Measured worse on Opus 5.5 high (2026-11-05, 8 tasks x 3, paired):
 *   cache reads -68% but thinking per request doubled, cost +19%, pass -12.5 pp.
 * - parallel_tool_calls false sets `tool_choice.disable_parallel_tool_use`.
 * - keepalive_s (src/keepalive.ts): while no request starts for this long, re-send the last request with
 *   `max_tokens: 0` to refresh the 5-minute cache (at most keepalive_max pings per gap, default 12). Needs
 *   cache_retention short. Expiries cost 6.0% of v3's Opus 5.5 spend (196 trials, median gap 584 s).
 * - thread (src/threads.ts): Anthropic message threads (beta message-threads-2026-08-12): a request that extends the
 *   previous one sends only its new messages. For time to first token; pricing and caching are unchanged. Not with
 *   thinking_history latest (it rewrites earlier messages, so no request would extend the previous one).
 */
import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const strict = { additionalProperties: false } as const;
const Ttl = Type.Union([Type.Literal("5m"), Type.Literal("1h")]);
const Budget = Type.Optional(Type.Integer({ minimum: 1024 }));

export const WireSchema = Type.Object({
  max_output_tokens: Type.Optional(Type.Integer({ minimum: 16 })),
  /** Provider request retries on 408/409/429/5xx before a stream starts (Pi's own default is 0). */
  max_retries: Type.Optional(Type.Integer({ minimum: 0 })),
  cache_retention: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")])),
  /**
 * sse | websocket | auto: pi-ai's own transport option (its compact-backend codex API only). http (the default) | ws:
   * W1, an HTTP request re-uploads and re-parses the whole growing input every turn, while one WebSocket per run sends
   * only the items after `previous_response_id` (Codex's production transport for GPT-6.x, OpenAI Responses only).
   */
  transport: Type.Optional(Type.Union([Type.Literal("sse"), Type.Literal("websocket"), Type.Literal("auto"), Type.Literal("http"), Type.Literal("ws")])),
  /** W1 settings, only with transport "ws"; each default is Codex's behavior. */
  ws: Type.Optional(Type.Object({
    /** Codex sends the first request as `generate:false` and chains the real one from it; off sends it plainly (the ablation). */
    prewarm: Type.Optional(Type.Boolean()),
    /** false: every request is a full resend on the open socket (no previous_response_id): the transport without the delta. */
    incremental: Type.Optional(Type.Boolean()),
    /** The server closes a connection at 60 min (`websocket_connection_limit_reached`); reconnect before a request past this age. */
    max_age_s: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })),
    /** A handshake not answered by then is a failure (that request goes over HTTP), and a prewarm not finished by then is dropped (the request goes whole on a new socket): never a stalled turn. */
    connect_timeout_ms: Type.Optional(Type.Integer({ minimum: 100 })),
    /** Lost connections tolerated (each request then goes over HTTP once) before the rest of the run stays on HTTP. */
    max_failures: Type.Optional(Type.Integer({ minimum: 1 })),
  }, strict)),
  /** Shallow-merged into the provider request body last (e.g. `{"text":{"verbosity":"low"}}`). */
  payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  mid_convo_effort: Type.Optional(Type.Boolean()),
  reasoning_context: Type.Optional(Type.Union([Type.Literal("all_turns"), Type.Literal("current_turn")])),
  reasoning_carry: Type.Optional(Type.Boolean()),
  verbosity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  reasoning_summary: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("auto"), Type.Literal("concise"), Type.Literal("detailed")])),
  prompt_cache_key: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("off")])),
  /** Factory lever, never for scored A/Bs: parallel agents on one repo send the same system+tools+task prefix, so a key from a hash of it (not the session) routes them to one warm cache. */
  prompt_cache_key_mode: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("task")])),
  responses_lite_ids: Type.Optional(Type.Boolean()),
  parallel_tool_calls: Type.Optional(Type.Boolean()),
  anthropic: Type.Optional(Type.Object({
    prefix_ttl: Type.Optional(Ttl),
    tail_ttl: Type.Optional(Ttl),
    tail_breakpoints: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })),
    thinking: Type.Optional(Type.Union([Type.Literal("adaptive"), Type.Literal("budget")])),
    thinking_budgets: Type.Optional(Type.Object({ minimal: Budget, low: Budget, medium: Budget, high: Budget, xhigh: Budget, max: Budget }, strict)),
    thinking_display: Type.Optional(Type.Union([Type.Literal("summarized"), Type.Literal("omitted")])),
    thinking_history: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("latest")])),
    keepalive_s: Type.Optional(Type.Integer({ minimum: 60, maximum: 290 })),
    keepalive_max: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
    thread: Type.Optional(Type.Boolean()),
  }, strict)),
}, strict);

type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicWire {
  prefix_ttl?: "5m" | "1h";
  tail_ttl?: "5m" | "1h";
  tail_breakpoints?: 2;
  thinking?: "budget";
  thinking_budgets?: Partial<Record<Effort, number>>;
  thinking_display?: "summarized" | "omitted";
  thinking_history?: "latest";
  keepalive_s?: number;
  keepalive_max?: number;
  thread?: boolean;
}

/** wire.ws with defaults; present only when transport is "ws". */
export interface WsSettings {
  prewarm: boolean;
  incremental: boolean;
  max_age_s: number;
  connect_timeout_ms: number;
  max_failures: number;
}

export const DEFAULT_WS: Readonly<WsSettings> = Object.freeze({ prewarm: true, incremental: true, max_age_s: 3300, connect_timeout_ms: 10_000, max_failures: 3 });

export interface Wire {
  max_output_tokens?: number;
  max_retries: number;
  cache_retention: "none" | "short" | "long";
  /** Absent = HTTP (`"http"` normalizes away); "ws" = the harness's Responses WebSocket (src/ws.ts); the rest are pi-ai's. */
  transport?: "sse" | "websocket" | "auto" | "ws";
  ws?: WsSettings;
  payload?: Record<string, unknown>;
  mid_convo_effort?: false;
  reasoning_context?: "all_turns" | "current_turn";
  reasoning_carry?: false;
  verbosity?: "low" | "medium" | "high";
  reasoning_summary?: "none" | "auto" | "concise" | "detailed";
  prompt_cache_key?: "off";
  prompt_cache_key_mode?: "task";
  responses_lite_ids?: true;
  parallel_tool_calls?: boolean;
  anthropic?: AnthropicWire;
}

/** Budgets for anthropic.thinking "budget": Pi's defaults for minimal..high, doubled above. */
export const DEFAULT_THINKING_BUDGETS: Readonly<Record<Effort, number>> = Object.freeze({
  minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 65536,
});

type RawWire = Partial<Omit<Wire, "max_retries" | "cache_retention" | "transport" | "ws" | "mid_convo_effort" | "reasoning_carry" | "prompt_cache_key" | "prompt_cache_key_mode" | "responses_lite_ids" | "anthropic">> & {
  max_retries?: number; cache_retention?: Wire["cache_retention"]; transport?: Wire["transport"] | "http"; ws?: Partial<WsSettings>;
  mid_convo_effort?: boolean; reasoning_carry?: boolean;
  prompt_cache_key?: "session" | "off"; prompt_cache_key_mode?: "session" | "task"; responses_lite_ids?: boolean;
  anthropic?: Omit<AnthropicWire, "tail_breakpoints" | "thinking" | "thinking_history"> & { tail_breakpoints?: number; thinking?: "adaptive" | "budget"; thinking_history?: "all" | "latest" };
};

/** Defaults applied, values equal to a default dropped, combinations the API refuses rejected (`fail` throws). */
export function normalizeWire(raw: RawWire | undefined, fail: (message: string) => never): Wire {
  const wire: Wire = { cache_retention: raw?.cache_retention ?? "short", max_retries: raw?.max_retries ?? 3 };
  const copy = <K extends keyof Wire>(key: K, value: Wire[K] | undefined) => {
    if (value !== undefined) wire[key] = value;
  };
  copy("max_output_tokens", raw?.max_output_tokens);
  if (raw?.transport !== undefined && raw.transport !== "http") wire.transport = raw.transport;
  if (raw?.ws !== undefined && wire.transport !== "ws") fail("wire.ws needs wire.transport \"ws\"");
  if (wire.transport === "ws") {
    // The prewarm exists for the real first request to chain from it; with the delta off it would only double that request.
    const ws: WsSettings = { ...DEFAULT_WS, ...(raw?.ws?.incremental === false ? { prewarm: false } : {}), ...raw?.ws };
    if (!ws.incremental && ws.prewarm) fail("wire.ws.prewarm needs wire.ws.incremental (a prewarm only pays when the first request chains from it)");
    wire.ws = ws;
  }
  copy("payload", raw?.payload);
  if (raw?.mid_convo_effort === false) wire.mid_convo_effort = false;
  copy("reasoning_context", raw?.reasoning_context);
  if (raw?.reasoning_carry === false) wire.reasoning_carry = false;
  copy("verbosity", raw?.verbosity);
  copy("reasoning_summary", raw?.reasoning_summary);
  if (raw?.prompt_cache_key === "off") wire.prompt_cache_key = "off";
  if (raw?.prompt_cache_key_mode === "task") {
    if (wire.prompt_cache_key === "off") fail("wire.prompt_cache_key_mode \"task\" needs a prompt_cache_key (not \"off\")");
    wire.prompt_cache_key_mode = "task";
  }
  if (raw?.responses_lite_ids === true) wire.responses_lite_ids = true;
  copy("parallel_tool_calls", raw?.parallel_tool_calls);
  const source = raw?.anthropic;
  if (source !== undefined) {
    const anthropic: AnthropicWire = {};
    if (source.prefix_ttl !== undefined) anthropic.prefix_ttl = source.prefix_ttl;
    if (source.tail_ttl !== undefined) anthropic.tail_ttl = source.tail_ttl;
    if (source.tail_breakpoints === 2) anthropic.tail_breakpoints = 2;
    if (source.thinking === "budget") anthropic.thinking = "budget";
    if (source.thinking_budgets !== undefined) anthropic.thinking_budgets = { ...source.thinking_budgets };
    if (source.thinking_display !== undefined) anthropic.thinking_display = source.thinking_display;
    if (source.thinking_history === "latest") anthropic.thinking_history = "latest";
    if (source.keepalive_s !== undefined) {
      if (wire.cache_retention !== "short") fail("wire.anthropic.keepalive_s refreshes the 5-minute cache: it needs wire.cache_retention short");
      anthropic.keepalive_s = source.keepalive_s;
      if (source.keepalive_max !== undefined && source.keepalive_max !== 12) anthropic.keepalive_max = source.keepalive_max;
    } else if (source.keepalive_max !== undefined) fail("wire.anthropic.keepalive_max needs keepalive_s");
    if (source.thread === true) {
      if (anthropic.thinking_history === "latest") fail("wire.anthropic.thread: thinking_history latest rewrites earlier messages, so no request extends a thread");
      anthropic.thread = true;
    }
    if ((anthropic.prefix_ttl ?? anthropic.tail_ttl) !== undefined && wire.cache_retention === "none") {
      fail("wire.anthropic TTLs need wire.cache_retention short or long (none sends no breakpoints)");
    }
    const ttl = (value: "5m" | "1h" | undefined) => value ?? (wire.cache_retention === "long" ? "1h" : "5m");
    if (ttl(anthropic.prefix_ttl) === "5m" && ttl(anthropic.tail_ttl) === "1h") fail("wire.anthropic: a 1h tail after a 5m prefix is refused by the API (1h breakpoints must come first)");
    if (anthropic.thinking === "budget" && wire.mid_convo_effort !== false) fail("wire.anthropic.thinking \"budget\" needs wire.mid_convo_effort false (effort markers assume adaptive thinking)");
    if (anthropic.thinking_budgets !== undefined && anthropic.thinking !== "budget") fail("wire.anthropic.thinking_budgets needs thinking \"budget\"");
    if (Object.keys(anthropic).length > 0) wire.anthropic = anthropic;
  }
  return wire;
}

/** RFC 4122 version 5 (SHA-1, name-based) UUID, as Rust's `Uuid::new_v5`. */
export function uuidv5(namespace: string, name: string | Uint8Array): string {
  const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(ns).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const UUID_NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

type Body = Record<string, any>;
const isRecord = (value: unknown): value is Body => typeof value === "object" && value !== null && !Array.isArray(value);

/** `task-` + 40 hex of sha256 over the model, instructions, tools and the input through the first user message. */
export function taskCacheKey(body: Body): string {
  const input: unknown[] = Array.isArray(body.input) ? body.input : [];
  const firstUser = input.findIndex((item) => isRecord(item) && item.role === "user");
  const prefix = { model: body.model, instructions: body.instructions, tools: body.tools, input: firstUser === -1 ? input : input.slice(0, firstUser + 1) };
  return `task-${createHash("sha256").update(JSON.stringify(prefix)).digest("hex").slice(0, 40)}`;
}

function rewriteOpenAI(body: Body, wire: Wire, sessionId: string, taskKey: (body: Body) => string): void {
  if (isRecord(body.reasoning)) {
    if (wire.reasoning_context !== undefined) body.reasoning.context = wire.reasoning_context;
    if (wire.reasoning_summary === "none") delete body.reasoning.summary;
    else if (wire.reasoning_summary !== undefined) body.reasoning.summary = wire.reasoning_summary;
  }
  const input: unknown[] = Array.isArray(body.input) ? body.input : [];
  if (wire.reasoning_carry === false) {
    body.input = input.filter((item) => !(isRecord(item) && item.type === "reasoning"));
    if (Array.isArray(body.include)) {
      body.include = body.include.filter((entry: unknown) => entry !== "reasoning.encrypted_content");
      if (body.include.length === 0) delete body.include;
    }
  }
  if (wire.verbosity !== undefined) body.text = { ...(isRecord(body.text) ? body.text : {}), verbosity: wire.verbosity };
  if (wire.prompt_cache_key === "off") delete body.prompt_cache_key;
  else if (wire.prompt_cache_key_mode === "task") body.prompt_cache_key = taskKey(body);
  if (wire.parallel_tool_calls !== undefined) body.parallel_tool_calls = wire.parallel_tool_calls;
  if (wire.responses_lite_ids === true) {
    const namespace = uuidv5(UUID_NAMESPACE_OID, sessionId);
    const items: unknown[] = body.input;
    const tools = items.findIndex((item) => isRecord(item) && item.type === "additional_tools");
    if (tools >= 0) {
      const item = items[tools] as Body;
      items[tools] = { type: item.type, id: `at_${uuidv5(namespace, JSON.stringify(item.tools))}`, ...item };
    }
    const instructions = items.findIndex((item) => isRecord(item) && item.role === "developer" && item.type !== "additional_tools");
    if (instructions >= 0) {
      const item = items[instructions] as Body;
      const text = typeof item.content === "string" ? item.content
        : Array.isArray(item.content) ? item.content.map((part: Body) => (typeof part.text === "string" ? part.text : "")).join("") : "";
      items[instructions] = { type: "message", id: `msg_${uuidv5(namespace, text)}`, role: "developer", content: [{ type: "input_text", text }] };
    }
  }
}

const CACHEABLE = new Set(["text", "image", "tool_result", "document", "tool_addition", "tool_removal"]);

function rewriteAnthropic(body: Body, wire: Wire, effort: Effort | undefined): void {
  const anthropic = wire.anthropic ?? {};
  const control = (ttl: "5m" | "1h") => (ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" });
  const retentionTtl = wire.cache_retention === "long" ? "1h" : "5m";
  const blocks = (list: unknown) => (Array.isArray(list) ? list.filter(isRecord) : []);
  if (anthropic.prefix_ttl !== undefined) {
    for (const block of [...blocks(body.system), ...blocks(body.tools)]) if (block.cache_control !== undefined) block.cache_control = control(anthropic.prefix_ttl);
  }
  const messages = blocks(body.messages);
  const tailTtl = anthropic.tail_ttl ?? retentionTtl;
  if (anthropic.tail_ttl !== undefined) {
    for (const message of messages) for (const block of blocks(message.content)) if (block.cache_control !== undefined) block.cache_control = control(tailTtl);
  }
  if (anthropic.tail_breakpoints === 2 && wire.cache_retention !== "none") {
    const used = [...blocks(body.system), ...blocks(body.tools), ...messages.flatMap((message) => blocks(message.content))]
      .filter((block) => block.cache_control !== undefined).length;
    const users = messages.map((message, index) => (message.role === "user" ? index : -1)).filter((index) => index >= 0);
    const previous = users.length >= 2 ? messages[users[users.length - 2]!] : undefined;
    const last = previous === undefined ? undefined : blocks(previous.content).at(-1);
    if (used < 4 && last !== undefined && CACHEABLE.has(String(last.type)) && last.cache_control === undefined) last.cache_control = control(tailTtl);
  }
  if (anthropic.thinking_history === "latest") {
    const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
    for (const message of messages.slice(0, Math.max(0, lastAssistant))) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const kept = message.content.filter((block: unknown) => !(isRecord(block) && (block.type === "thinking" || block.type === "redacted_thinking")));
      if (kept.length > 0) message.content = kept;
    }
    if (lastAssistant > 0 && wire.cache_retention !== "none") {
      const used = [...blocks(body.system), ...blocks(body.tools), ...messages.flatMap((message) => blocks(message.content))]
        .filter((block) => block.cache_control !== undefined).length;
      const stableUser = messages.slice(0, lastAssistant).findLastIndex((message) => message.role === "user");
      const last = stableUser < 0 ? undefined : blocks(messages[stableUser]!.content).at(-1);
      if (used < 4 && last !== undefined && CACHEABLE.has(String(last.type)) && last.cache_control === undefined) last.cache_control = control(tailTtl);
    }
  }
  if (anthropic.thinking === "budget" && effort !== undefined && isRecord(body.thinking) && body.thinking.type !== "disabled") {
    const budgets = { ...DEFAULT_THINKING_BUDGETS, ...anthropic.thinking_budgets };
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : 32_000;
    body.thinking = { type: "enabled", budget_tokens: Math.max(1024, Math.min(budgets[effort], maxTokens - 1024)), display: body.thinking.display ?? "summarized" };
    delete body.output_config;
  }
  if (anthropic.thinking_display !== undefined && isRecord(body.thinking) && body.thinking.type !== "disabled") body.thinking.display = anthropic.thinking_display;
  if (wire.parallel_tool_calls === false && Array.isArray(body.tools) && body.tools.length > 0) {
    body.tool_choice = { ...(isRecord(body.tool_choice) ? body.tool_choice : { type: "auto" }), disable_parallel_tool_use: true };
  }
}

export interface WireSetup {
  /** The model with compat overrides (mid_convo_effort). */
  model: Model<Api>;
  /** Extra stream options (Pi's thinkingBudgets for budget-thinking models). */
  streamOptions: Record<string, unknown>;
  /** The body rewrite, or undefined when no knob touches the body. */
  onPayload?: (body: unknown, model: Model<Api>) => unknown;
}

/**
 * The pi-ai options a loadout's wire knobs compile to, for one run. `effort`
 * may be a function: the effort of the request being rewritten (depth.escalate
 * changes it per request).
 */
export function wireSetup(wire: Wire, model: Model<Api>, sessionId: string, effort: Effort | undefined | (() => Effort | undefined)): WireSetup {
  const compat = model.compat as Record<string, unknown> | undefined;
  const wired = wire.mid_convo_effort === false && compat?.supportsMidConvoEffort === true
    ? ({ ...model, compat: { ...compat, supportsMidConvoEffort: false } } as Model<Api>)
    : model;
  const streamOptions: Record<string, unknown> = {};
  if (wire.anthropic?.thinking === "budget") streamOptions.thinkingBudgets = { ...DEFAULT_THINKING_BUDGETS, ...wire.anthropic.thinking_budgets };
  const touchesBody = wire.payload !== undefined || wire.reasoning_context !== undefined || wire.reasoning_carry === false || wire.verbosity !== undefined ||
    wire.reasoning_summary !== undefined || wire.prompt_cache_key === "off" || wire.responses_lite_ids === true || wire.parallel_tool_calls !== undefined ||
    wire.anthropic !== undefined || wire.prompt_cache_key_mode === "task";
  if (!touchesBody) return { model: wired, streamOptions };
  let runTaskKey: string | undefined;
  const taskKey = (body: Body) => (runTaskKey ??= taskCacheKey(body));
  const onPayload = (payload: unknown, requestModel: Model<Api>): unknown => {
    if (!isRecord(payload)) return payload;
    const body = structuredClone(payload);
    if (requestModel.api === "openai-responses") rewriteOpenAI(body, wire, sessionId, taskKey);
    else if (requestModel.api === "anthropic-messages") rewriteAnthropic(body, wire, typeof effort === "function" ? effort() : effort);
    return wire.payload === undefined ? body : { ...body, ...wire.payload };
  };
  return { model: wired, streamOptions, onPayload };
}
