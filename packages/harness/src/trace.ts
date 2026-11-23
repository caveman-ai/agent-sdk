/**
 * Trace recorder: one JSON event per line (request_start/end, tool_start/end,
 * turn_end, policy, stop), written synchronously so a crash keeps everything
 * before it, and the run's result.json with the latency decomposition:
 * model_s from request timings, tool_s from the union of tool intervals
 * (parallel tools overlap), harness_s the rest of wall.
 */
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import type { AgentEvent, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { costOf, type Prices } from "./models.ts";
import type { FirstFinish } from "./snapshot.ts";
import type { WsSummary } from "./ws.ts";

export type RunStatus = "finished" | "stopped" | "error";

export interface UsageTotals {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

export interface SessionTurn {
  n: number;
  requests: number;
  cost_usd: number | null;
  wall_s: number;
}

export interface RunResult {
  schema: 1;
  status: RunStatus;
  stop_reason: string;
  /** loadout_hash: the loadout as given (the rig's pin); behavior_hash (additive): the normalized loadout. */
  version: { bundle_sha256: string; loadout_hash: string; loadout_name: string; behavior_hash: string };
  model: string;
  effort: string;
  /** Additive: the thinking level the model actually ran at after Pi's clamp. */
  thinking_level: string;
  usage: UsageTotals;
  /** Additive: USD at catalog or loadout prices; null when the model has no known price. */
  cost_usd: number | null;
  timing: { wall_s: number; model_s: number; tool_s: number; harness_s: number; time_to_first_request_ms: number | null };
  /** `nested_by_name` (additive): calls the exec surface's scripts made to nested tools. */
  tools: { calls: number; errors: number; by_name: Record<string, number>; nested_by_name?: Record<string, number> };
  /** Additive: turns re-run after a transient provider error. */
  provider_retries: number;
  /** Additive, only for a session (--followups): each user turn's requests, USD and wall time, in order. */
  turns?: SessionTurn[];
  /**
   * Additive, only when depth.escalate or depth.deescalate sets the effort per
   * request: requests and output tokens by the effort each request was sent
   * at, and requests by why (base, escalated by D2, mechanical for D4).
   */
  effort_mix?: EffortMix;
  /** Additive, only with wire.transport "ws": requests per transport, delta vs full sends (with reasons), bytes, fallback. */
  transport?: WsSummary;
  /** Additive, only with trace.finish_snapshot (or --finish-snapshot): the workspace snapshot at the first finish attempt. */
  first_finish?: FirstFinish;
  /**
   * Additive, only when the harness made a side call on the run's model (policy.validator's generation, policy.critic's review requests), by kind: its requests,
   * tokens and USD. These tokens and USD are already in `usage` and `cost_usd` (budgets included); `usage.requests` is the agent loop's.
   */
  side_requests?: Record<string, SideUsage>;
  error?: string;
}

export interface SideUsage {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  latency_ms: number;
}

export interface EffortMix {
  by_effort: Record<string, { requests: number; output_tokens: number; reasoning_tokens: number }>;
  by_reason: Record<string, number>;
}

/** Stream events that start visible output (text or a tool call), as opposed to the stream opening or reasoning. */
const OUTPUT_STARTS: ReadonlySet<string> = new Set(["text_start", "text_delta", "toolcall_start", "toolcall_delta"]);

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

/** One item of a request's prompt as the cache sees it: its kind and its bytes (cache_control markers excluded: they move, the content does not). */
export interface PromptItem {
  kind: string;
  key: string;
}

export type CacheBreak = "prefix_mutation" | "tool_set_change" | "compaction" | "params_change" | "none";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const withoutCacheControl = (key: string, value: unknown) => (key === "cache_control" ? undefined : value);

/**
 * A provider request body as an ordered item list: instructions or system,
 * the tool set (one item: Responses `additional_tools` or a `tools` array),
 * then each input item or message.
 */
export function promptItems(body: unknown): PromptItem[] {
  if (!isObject(body)) return [];
  const items: PromptItem[] = [];
  const add = (kind: string, value: unknown) => items.push({ kind, key: JSON.stringify(value, withoutCacheControl) ?? "" });
  if (body.instructions !== undefined) add("instructions", body.instructions);
  if (body.system !== undefined) add("system", body.system);
  if (Array.isArray(body.tools) && body.tools.length > 0) add("tools", body.tools);
  const list = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  for (const item of list) {
    const kind = !isObject(item) ? "item" : item.type === "additional_tools" ? "tools"
      : typeof item.role === "string" ? (item.type === undefined || item.type === "message" ? item.role : `${String(item.type)}:${item.role}`)
      : String(item.type ?? "item");
    add(kind, item);
  }
  return items;
}

/**
 * The request fields that set reasoning depth (Responses `reasoning`, Messages
 * `thinking` and `output_config`), as one key. They are not prompt items, but
 * providers render them ahead of the messages: Anthropic documents that a
 * thinking or effort change invalidates the messages cache, and OpenAI may
 * render effort into the prompt header. D2 changes them per request on the
 * plain wire, so the monitor compares them too.
 */
export function promptParams(body: unknown): string {
  if (!isObject(body)) return "";
  const picked: Record<string, unknown> = {};
  for (const key of ["reasoning", "thinking", "output_config"]) if (body[key] !== undefined) picked[key] = body[key];
  return JSON.stringify(picked, withoutCacheControl);
}

/** Where `next` stops extending `previous`, and the likely cause. */
export function cacheBreak(previous: PromptItem[] | undefined, next: PromptItem[]): { index: number | null; kind: string | null; prevKind: string | null; reason: CacheBreak } {
  if (previous === undefined) return { index: null, kind: null, prevKind: null, reason: "none" };
  const shared = Math.min(previous.length, next.length);
  let index = 0;
  while (index < shared && previous[index]!.key === next[index]!.key) index++;
  if (index === previous.length) return { index: null, kind: null, prevKind: null, reason: "none" };
  const kind = next[index]?.kind ?? null;
  const prevKind = previous[index]!.kind;
  if (prevKind === "tools" || kind === "tools") return { index, kind, prevKind, reason: "tool_set_change" };
  return { index, kind, prevKind, reason: next.length < previous.length ? "compaction" : "prefix_mutation" };
}

function textBytes(result: AgentToolResult<unknown> | undefined): number {
  let total = 0;
  for (const part of result?.content ?? []) total += part.type === "text" ? Buffer.byteLength(part.text, "utf8") : part.data.length;
  return total;
}

export class Recorder {
  readonly startedAt = performance.now();
  /** A session's user turns (--followups), recorded as each ends. */
  sessionTurns: SessionTurn[] | undefined;
  readonly usage: UsageTotals = { requests: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  costUsd: number | null = 0;
  private fd: number | undefined;
  private requestStartedAt: number | undefined;
  private firstTokenAt: number | undefined;
  /** When the response's first text or tool call began: after the model's reasoning, which streams nothing headless. */
  private firstOutputAt: number | undefined;
  private firstRequestMs: number | null = null;
  private modelMs = 0;
  private readonly toolSpans: [number, number][] = [];
  private readonly toolStarts = new Map<string, number>();
  private readonly byName: Record<string, number> = {};
  private readonly nestedByName: Record<string, number> = {};
  private toolCalls = 0;
  private toolErrors = 0;
  private turns = 0;
  /** The effort the request in flight was sent at (D2/D4 only), and the run's mix. */
  private requestEffort: string | undefined;
  private readonly effortMix: EffortMix = { by_effort: {}, by_reason: {} };
  private readonly side: Record<string, SideUsage> = {};

  private readonly model: Model<Api>;
  private readonly prices: Prices;
  /** trace.cache_monitor: the previous request's items, and this request's break, emitted with its usage. */
  private readonly cacheMonitor: boolean;
  private lastItems: PromptItem[] | undefined;
  private lastParams: string | undefined;
  private pendingBreak: (ReturnType<typeof cacheBreak> & { items: number; prev_items: number; params?: { from: unknown; to: unknown }; items_reason?: CacheBreak }) | undefined;

  constructor(path: string | undefined, model: Model<Api>, prices: Prices, options: { cacheMonitor?: boolean } = {}) {
    this.model = model;
    this.prices = prices;
    this.cacheMonitor = options.cacheMonitor === true;
    if (path !== undefined) this.fd = openSync(path, "w");
  }

  /** The final provider body of the request in flight (after every wire rewrite); compared with the previous one when the cache monitor is on. */
  observeRequest(body: unknown): void {
    if (!this.cacheMonitor) return;
    const items = promptItems(body);
    const params = promptParams(body);
    const found = cacheBreak(this.lastItems, items);
    this.pendingBreak = { ...found, items: items.length, prev_items: this.lastItems?.length ?? 0 };
    // A changed effort or thinking setting sits ahead of every item, so it is the break; an item-level one is kept beside it.
    if (this.lastParams !== undefined && params !== this.lastParams) {
      this.pendingBreak = {
        ...this.pendingBreak, reason: "params_change", params: { from: JSON.parse(this.lastParams), to: JSON.parse(params) },
        ...(found.reason === "none" ? {} : { items_reason: found.reason }),
      };
    }
    this.lastItems = items;
    this.lastParams = params;
  }

  /** Milliseconds since this run started. */
  now(): number {
    return performance.now() - this.startedAt;
  }

  event(type: string, fields: Record<string, unknown> = {}): void {
    if (this.fd === undefined) return;
    writeSync(this.fd, `${JSON.stringify({ t: round(this.now(), 1), type, ...fields })}\n`);
  }

  /** Called from Pi's prepareRequest hook, immediately before each provider request; `effort` and its `reason` when depth.escalate or depth.deescalate sets it per request. */
  requestStart(messages: number, effort?: string, reason?: string): void {
    this.requestStartedAt = performance.now();
    this.firstTokenAt = undefined;
    this.firstOutputAt = undefined;
    this.firstRequestMs ??= Math.round(performance.now());
    this.requestEffort = effort;
    if (effort !== undefined) {
      const mix = (this.effortMix.by_effort[effort] ??= { requests: 0, output_tokens: 0, reasoning_tokens: 0 });
      mix.requests++;
      if (reason !== undefined) this.effortMix.by_reason[reason] = (this.effortMix.by_reason[reason] ?? 0) + 1;
    }
    this.event("request_start", {
      n: this.usage.requests + 1, messages, ...(effort === undefined ? {} : { effort }), ...(reason === undefined ? {} : { effort_reason: reason }),
    });
  }

  /** Pi's agent events: assistant message ends are request ends; tool executions are tool spans. */
  onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "message_update":
        if (event.message.role !== "assistant") return;
        this.firstTokenAt ??= performance.now();
        if (this.firstOutputAt === undefined && OUTPUT_STARTS.has(event.assistantMessageEvent.type)) this.firstOutputAt = performance.now();
        return;
      case "message_end":
        if (event.message.role === "assistant") this.requestEnd(event.message as AssistantMessage);
        return;
      case "tool_execution_start":
        this.toolStarts.set(event.toolCallId, performance.now());
        this.event("tool_start", { id: event.toolCallId, name: event.toolName });
        return;
      case "tool_execution_end": {
        const started = this.toolStarts.get(event.toolCallId);
        this.toolStarts.delete(event.toolCallId);
        const ended = performance.now();
        const durationMs = event.durationMs ?? (started === undefined ? 0 : ended - started);
        this.toolSpans.push([ended - durationMs, ended]);
        this.toolCalls++;
        if (event.isError) this.toolErrors++;
        this.byName[event.toolName] = (this.byName[event.toolName] ?? 0) + 1;
        const result = event.result as AgentToolResult<{
          truncated?: boolean; spill?: string; exitCode?: number | null; handle?: string; cell_id?: number; nested?: Record<string, number>; mutated?: boolean;
          shaped?: string;
        }> | undefined;
        const nested = result?.details?.nested;
        for (const [name, count] of Object.entries(nested ?? {})) this.nestedByName[name] = (this.nestedByName[name] ?? 0) + count;
        this.event("tool_end", {
          id: event.toolCallId, name: event.toolName, duration_ms: Math.round(durationMs), bytes_out: textBytes(result),
          truncated: result?.details?.truncated === true, is_error: event.isError,
          ...(result?.details?.spill === undefined ? {} : { spill: result.details.spill }),
          ...(result?.details?.exitCode === undefined ? {} : { exit_code: result.details.exitCode }),
          ...(result?.details?.handle === undefined ? {} : { handle: result.details.handle }),
          ...(result?.details?.cell_id === undefined ? {} : { cell_id: result.details.cell_id }),
          ...(nested === undefined ? {} : { nested }),
          ...(result?.details?.mutated === true ? { mutated: true } : {}),
          ...(result?.details?.shaped === undefined ? {} : { shaped: result.details.shaped }),
        });
        return;
      }
      case "turn_end":
        this.turns++;
        this.event("turn_end", { n: this.turns, tool_results: event.toolResults.length });
        return;
      default:
        return;
    }
  }

  private requestEnd(message: AssistantMessage): void {
    const ended = performance.now();
    const started = this.requestStartedAt ?? ended;
    this.requestStartedAt = undefined;
    const latency = ended - started;
    this.modelMs += latency;
    const usage = message.usage;
    this.usage.requests++;
    this.usage.input_tokens += usage.input;
    this.usage.cached_input_tokens += usage.cacheRead;
    this.usage.cache_write_tokens += usage.cacheWrite;
    this.usage.output_tokens += usage.output;
    this.usage.reasoning_tokens += usage.reasoning ?? 0;
    if (this.requestEffort !== undefined) {
      const mix = this.effortMix.by_effort[this.requestEffort]!;
      mix.output_tokens += usage.output;
      mix.reasoning_tokens += usage.reasoning ?? 0;
      this.requestEffort = undefined;
    }
    const cost = costOf(this.model, usage, this.prices);
    this.costUsd = cost === undefined || this.costUsd === null ? null : this.costUsd + cost;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
    this.event("request_end", {
      n: this.usage.requests, latency_ms: Math.round(latency),
      ttft_ms: this.firstTokenAt === undefined ? null : Math.round(this.firstTokenAt - started),
      output_ms: this.firstOutputAt === undefined ? null : Math.round(this.firstOutputAt - started),
      stop_reason: message.stopReason,
      usage: { input: usage.input, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, output: usage.output, reasoning: usage.reasoning ?? 0 },
      cache_read_share: prompt === 0 ? 0 : round(usage.cacheRead / prompt),
      cost_usd: cost === undefined ? null : round(cost, 6),
      tool_calls: message.content.filter((part) => part.type === "toolCall").length,
      ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
    });
    if (this.pendingBreak !== undefined) {
      const found = this.pendingBreak;
      this.pendingBreak = undefined;
      this.event("cache", {
        n: this.usage.requests, first_diverging_index: found.index, item_kind: found.kind, prev_kind: found.prevKind, reason: found.reason,
        ...(found.params === undefined ? {} : { params: found.params }), ...(found.items_reason === undefined ? {} : { items_reason: found.items_reason }),
        items: found.items, prev_items: found.prev_items, cache_read_share: prompt === 0 ? 0 : round(usage.cacheRead / prompt),
      });
    }
  }

  /**
   * A harness side call on the run's model (policy.validator's generation, each of policy.critic's review requests), outside the agent loop: its tokens and USD join the
   * run's usage and cost_usd (so the USD and token budgets see it) and `side_requests[kind]`; `usage.requests`, the request
   * timings and the cache monitor stay the agent loop's. Emits a `side_request` event.
   */
  sideRequest(kind: string, message: AssistantMessage, latencyMs: number): void {
    const usage = message.usage;
    this.usage.input_tokens += usage.input;
    this.usage.cached_input_tokens += usage.cacheRead;
    this.usage.cache_write_tokens += usage.cacheWrite;
    this.usage.output_tokens += usage.output;
    this.usage.reasoning_tokens += usage.reasoning ?? 0;
    const cost = costOf(this.model, usage, this.prices);
    this.costUsd = cost === undefined || this.costUsd === null ? null : this.costUsd + cost;
    const side = (this.side[kind] ??= {
      requests: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cost_usd: 0, latency_ms: 0,
    });
    side.requests++;
    side.input_tokens += usage.input;
    side.cached_input_tokens += usage.cacheRead;
    side.cache_write_tokens += usage.cacheWrite;
    side.output_tokens += usage.output;
    side.reasoning_tokens += usage.reasoning ?? 0;
    side.cost_usd = cost === undefined || side.cost_usd === null ? null : round(side.cost_usd + cost, 6);
    side.latency_ms += Math.round(latencyMs);
    this.event("side_request", {
      kind, n: side.requests, latency_ms: Math.round(latencyMs), stop_reason: message.stopReason,
      usage: { input: usage.input, cache_read: usage.cacheRead, cache_write: usage.cacheWrite, output: usage.output, reasoning: usage.reasoning ?? 0 },
      cost_usd: cost === undefined ? null : round(cost, 6), ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
    });
  }

  policy(action: "nudge" | "stop" | "continue" | "retry" | "remind" | "orient" | "skip" | "check", reason: string, fields: Record<string, unknown> = {}): void {
    this.event("policy", { action, reason, ...fields });
  }

  /** Total tool time: the union of tool intervals, so parallel tools are not double counted. */
  private toolMs(): number {
    const spans = [...this.toolSpans].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let end = -Infinity;
    for (const [start, stop] of spans) {
      if (stop <= end) continue;
      total += stop - Math.max(start, end);
      end = stop;
    }
    return total;
  }

  result(fields: Pick<RunResult, "status" | "stop_reason" | "version" | "model" | "effort" | "thinking_level" | "provider_retries"> & { error?: string }): RunResult {
    const wall = this.now();
    const tool = this.toolMs();
    const harness = Math.max(0, wall - this.modelMs - tool);
    return {
      schema: 1,
      status: fields.status,
      stop_reason: fields.stop_reason,
      version: fields.version,
      model: fields.model,
      effort: fields.effort,
      thinking_level: fields.thinking_level,
      usage: { ...this.usage },
      cost_usd: this.costUsd === null ? null : round(this.costUsd, 6),
      timing: {
        wall_s: round(wall / 1000), model_s: round(this.modelMs / 1000), tool_s: round(tool / 1000), harness_s: round(harness / 1000),
        time_to_first_request_ms: this.firstRequestMs,
      },
      tools: {
        calls: this.toolCalls, errors: this.toolErrors, by_name: { ...this.byName },
        ...(Object.keys(this.nestedByName).length === 0 ? {} : { nested_by_name: { ...this.nestedByName } }),
      },
      provider_retries: fields.provider_retries,
      ...(Object.keys(this.effortMix.by_effort).length === 0 ? {} : { effort_mix: structuredClone(this.effortMix) }),
      ...(Object.keys(this.side).length === 0 ? {} : { side_requests: structuredClone(this.side) }),
      ...(this.sessionTurns === undefined ? {} : { turns: structuredClone(this.sessionTurns) }),
      ...(fields.error === undefined ? {} : { error: fields.error }),
    };
  }

  finish(result: RunResult, resultPath: string | undefined): void {
    this.event("stop", { status: result.status, stop_reason: result.stop_reason, ...(result.error === undefined ? {} : { error: result.error }) });
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    if (resultPath !== undefined) writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  }
}
