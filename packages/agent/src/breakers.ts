import {
  DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  retryDelayMs,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { sha256, stableStringify } from "./context-ir.js";

/**
 * Deterministic circuit breakers.
 *
 * Every decision in this file is a hash comparison or an integer count. No
 * model runs anywhere in the breaker path: a model judge cannot participate in
 * stopping or accounting, so all breaker decisions stay deterministic.
 *
 * Local enforcement shares the worker detector's H6 repeat edge: same tool +
 * normalized arguments, excluding a repeat whose immediately-preceding
 * attempt failed. Exact repeats expire after a bounded turn window, so old
 * successful work cannot poison the rest of a long run. Worker-side finding
 * arithmetic is intentionally broader: session graph SCCs plus a population
 * Isolation-Forest confirmation. Local runtime has neither full-session
 * population nor authority to mint findings.
 */
export interface RunBreakers {
  /**
   * How many identical tool calls — same tool, same normalized arguments — end
   * the run. Counted per hash, reset by an intervening failure. Defaults to 3.
   */
  readonly repeatedToolCalls?: number;
  /**
   * Assistant-turn window in which identical calls count toward
   * `repeatedToolCalls`. Older calls decay out. Defaults to 8.
   */
  readonly repeatedToolCallWindowTurns?: number;
  /**
   * How many consecutive read-only turns with an identical outcome signature
   * (same model conclusion and tool identities/results) end the run. Successful
   * declared writes reset the window because equal display text is not proof
   * that host state stayed equal. Defaults to 3.
   */
  readonly noProgressTurns?: number;
  /** Most tool calls one assistant turn may fan out to. Extras are blocked. Defaults to 8. */
  readonly maxToolCallsPerTurn?: number;
  /**
   * Cost-aware retry for model calls that fail before producing any usage.
   * Every retry takes a real hold from the run's BudgetMeter. A pre-stream
   * failure cancels that hold and records measured zero; a successful retry
   * settles provider usage. Worst-case reserved exposure is still capped, so a
   * zero-spend error storm cannot retry forever. A retry policy requires a
   * budget: there is no denomination to reserve without one.
   */
  readonly retry?: {
    /** Worst-case spend the run will expose to retries, in the budget's denomination. */
    readonly maxSpend: number;
    /** First backoff, doubled each attempt. Deterministic — no jitter. Defaults to 250ms. */
    readonly backoffMs?: number;
    /** Retries per model call. Unbounded by count when omitted; `maxSpend` still binds. */
    readonly maxRetries?: number;
    /**
     * Cap on any one wait, Pi's `retry.maxAgentDelayMs`. A thrown provider
     * error's Retry-After above it fails the call instead of sleeping.
     * Defaults to 60s.
     */
    readonly maxAgentDelayMs?: number;
  };
}

export interface NormalizedBreakers {
  readonly repeatedToolCalls: number;
  readonly repeatedToolCallWindowTurns: number;
  readonly noProgressTurns: number;
  readonly maxToolCallsPerTurn: number;
  readonly retryMaxSpend: number | undefined;
  readonly retryBackoffMs: number;
  readonly retryMaxRetries: number;
  readonly retryMaxAgentDelayMs: number;
}

const DEFAULT_REPEATED_TOOL_CALLS = 3;
const DEFAULT_REPEATED_TOOL_CALL_WINDOW_TURNS = 8;
const DEFAULT_NO_PROGRESS_TURNS = 3;
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 8;
const DEFAULT_RETRY_BACKOFF_MS = 250;

export function normalizeRunBreakers(
  breakers: RunBreakers,
  hasBudget: boolean,
): NormalizedBreakers {
  const repeatedToolCalls = breakers.repeatedToolCalls ?? DEFAULT_REPEATED_TOOL_CALLS;
  const repeatedToolCallWindowTurns = breakers.repeatedToolCallWindowTurns ??
    DEFAULT_REPEATED_TOOL_CALL_WINDOW_TURNS;
  const noProgressTurns = breakers.noProgressTurns ?? DEFAULT_NO_PROGRESS_TURNS;
  const maxToolCallsPerTurn = breakers.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  for (const value of [
    repeatedToolCalls,
    repeatedToolCallWindowTurns,
    noProgressTurns,
    maxToolCallsPerTurn,
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("cave_breaker_threshold_invalid");
    }
  }
  if (breakers.retry !== undefined && !hasBudget) {
    throw new Error("cave_breaker_retry_requires_budget");
  }
  if (breakers.retry !== undefined &&
      (!Number.isFinite(breakers.retry.maxSpend) || breakers.retry.maxSpend <= 0)) {
    throw new Error("cave_breaker_retry_spend_invalid");
  }
  const retryBackoffMs = breakers.retry?.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  const retryMaxRetries = breakers.retry?.maxRetries ?? Number.MAX_SAFE_INTEGER;
  const retryMaxAgentDelayMs = breakers.retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS;
  if ([retryBackoffMs, retryMaxRetries, retryMaxAgentDelayMs]
    .some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("cave_breaker_retry_backoff_invalid");
  }
  return Object.freeze({
    repeatedToolCalls,
    repeatedToolCallWindowTurns,
    noProgressTurns,
    maxToolCallsPerTurn,
    retryMaxSpend: breakers.retry?.maxSpend,
    retryBackoffMs,
    retryMaxRetries,
    retryMaxAgentDelayMs,
  });
}

/** One breaker decision, recorded on the receipt so a break is never silent. */
export interface BreakerEvent {
  readonly kind: "loop_detected" | "no_progress" | "fan_out_blocked" | "retry_attempted" | "retry_exhausted";
  readonly tool: string | undefined;
  /** Repeats for a loop, identical turns for no-progress, blocked calls for fan-out, attempt number for a retry. */
  readonly count: number;
  /** The call hash for a loop break, so the offending window is identifiable. */
  readonly signature: string | undefined;
  /** Worst-case hold taken for this retry, in the run budget's denomination. */
  readonly reservedSpend?: number;
  /** Provider-measured spend, zero for the only retryable pre-stream failure. */
  readonly measuredSpend?: number;
  /** Why measuredSpend is trustworthy, or why worst-case settlement was used. */
  readonly spendBasis?: "pre_stream_no_usage" | "provider_reported" | "unavailable_worst_case";
}

type ToolRepeat = { turns: number[]; previousFailed: boolean; lastResult?: string };

/**
 * The breaker bookkeeping for one run. Every method is pure counting over
 * hashes the runtime already has in hand.
 */
export class BreakerState {
  readonly config: NormalizedBreakers;
  private readonly repeats = new Map<string, ToolRepeat>();
  private readonly hashByToolCallId = new Map<string, string>();
  private readonly events: BreakerEvent[] = [];
  private lastTurnSignature: string | undefined;
  private repeatedTurns = 0;
  private currentTurnKey: unknown;
  private completedTurns = 0;
  private currentTurnFanOut = 0;
  private trip: "loop_detected" | "no_progress" | undefined;

  constructor(config: NormalizedBreakers) {
    this.config = config;
  }

  /** The break this run has already decided on, if any. */
  get tripped(): "loop_detected" | "no_progress" | undefined {
    return this.trip;
  }

  get recorded(): readonly BreakerEvent[] {
    return Object.freeze(this.events.map((event) => Object.freeze({ ...event })));
  }

  /**
   * Count one tool call. Returns true when it must be blocked — because it is
   * the repeat that trips the loop breaker, or because its turn has already
   * fanned out as far as it may.
   */
  observeToolCall(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
    allowRepeat: boolean;
    turnKey: unknown;
  }): { block: boolean; reason: string | undefined } {
    if (input.turnKey !== this.currentTurnKey) {
      this.currentTurnKey = input.turnKey;
      this.currentTurnFanOut = 0;
    }
    this.currentTurnFanOut++;
    if (this.currentTurnFanOut > this.config.maxToolCallsPerTurn) {
      this.events.push(Object.freeze({
        kind: "fan_out_blocked",
        tool: input.toolName,
        count: this.currentTurnFanOut,
        signature: undefined,
      }));
      return { block: true, reason: "cave_fan_out_cap_exceeded" };
    }
    // A tool whose whole job is to be called again — polling a queue, waiting
    // on a build — is legitimately repetitive and opts out of the loop count.
    if (input.allowRepeat) return { block: false, reason: undefined };
    const signature = callSignature(input.toolName, input.args);
    this.hashByToolCallId.set(input.toolCallId, signature);
    const entry = this.repeats.get(signature) ?? { turns: [], previousFailed: false };
    if (entry.previousFailed) {
      // The previous identical attempt failed, so this one is a necessary
      // retry, not a re-traversal. Start the window again rather than counting
      // work the run had to pay for anyway.
      entry.turns = [];
      entry.previousFailed = false;
    }
    // Calls execute before the assistant turn completes. Tool-free turns still
    // advance completedTurns in observeTurn, so every real assistant turn ages
    // this window rather than only turns that happen to call a tool.
    const callTurn = this.completedTurns + 1;
    const oldestIncludedTurn = callTurn - this.config.repeatedToolCallWindowTurns + 1;
    entry.turns = entry.turns.filter((turn) => turn >= oldestIncludedTurn);
    entry.turns.push(callTurn);
    this.repeats.set(signature, entry);
    if (entry.turns.length >= this.config.repeatedToolCalls) {
      this.trip ??= "loop_detected";
      this.events.push(Object.freeze({
        kind: "loop_detected",
        tool: input.toolName,
        count: entry.turns.length,
        signature,
      }));
      return { block: true, reason: "cave_tool_call_loop_detected" };
    }
    return { block: false, reason: undefined };
  }

  observeToolResult(toolCallId: string, isError: boolean, changedState = false, result?: unknown): void {
    const signature = this.hashByToolCallId.get(toolCallId);
    // Work landed since the other calls: re-running a test after an edit is progress, not a loop.
    if (changedState && !isError) {
      for (const [key, entry] of this.repeats) if (key !== signature) entry.turns = [];
    }
    if (signature === undefined) return;
    this.hashByToolCallId.delete(toolCallId);
    const entry = this.repeats.get(signature);
    if (entry === undefined) return;
    entry.previousFailed = isError;
    if (result === undefined) return;
    // Same call, new answer is polling that progresses (a build, a process's RSS), not a loop.
    const digest = sha256(stableStringify(result));
    if (entry.lastResult !== undefined && entry.lastResult !== digest) entry.turns = entry.turns.slice(-1);
    entry.lastResult = digest;
  }

  /**
   * Fold one completed turn into the no-progress window. Tool identity is part
   * of the signature; equal output from different operations is not equality.
   * A successful declared write resets the window. Generic runtime cannot
   * inspect arbitrary host state, so treating write text as proof of no change
   * would be an unsafe false stop.
   */
  observeTurn(
    conclusion: string,
    toolResults: readonly unknown[],
    stateChanged = false,
  ): void {
    this.completedTurns++;
    if (stateChanged) {
      this.lastTurnSignature = undefined;
      this.repeatedTurns = 0;
      return;
    }
    const signature = sha256(stableStringify({ conclusion, toolResults }));
    if (signature === this.lastTurnSignature) this.repeatedTurns++;
    else this.repeatedTurns = 1;
    this.lastTurnSignature = signature;
    if (this.repeatedTurns >= this.config.noProgressTurns) {
      this.trip ??= "no_progress";
      this.events.push(Object.freeze({
        kind: "no_progress",
        tool: undefined,
        count: this.repeatedTurns,
        signature,
      }));
    }
  }

  /**
   * Check cumulative worst-case exposure recorded on receipt events. False
   * means allowance cannot cover another attempt; actual BudgetMeter hold is
   * taken separately before recordRetryAttempt makes the attempt auditable.
   */
  retryExposureAvailable(amount: number, attempt: number): boolean {
    const allowance = this.config.retryMaxSpend;
    if (allowance === undefined) return false;
    if (!Number.isFinite(amount) || amount <= 0) return false;
    const exposed = this.events.reduce((total, event) =>
      event.kind === "retry_attempted" ? total + (event.reservedSpend ?? 0) : total, 0);
    if (exposed + amount > allowance || attempt > this.config.retryMaxRetries) {
      this.events.push(Object.freeze({
        kind: "retry_exhausted",
        tool: undefined,
        count: attempt,
        signature: undefined,
      }));
      return false;
    }
    return true;
  }

  /** Record one retry only after its real BudgetMeter hold succeeds. */
  recordRetryAttempt(amount: number, attempt: number): void {
    this.events.push({
      kind: "retry_attempted",
      tool: undefined,
      count: attempt,
      signature: undefined,
      reservedSpend: amount,
    });
  }

  /** Mark a retry reservation refused by the run's live meter. */
  recordRetryExhausted(attempt: number): void {
    this.events.push(Object.freeze({
      kind: "retry_exhausted",
      tool: undefined,
      count: attempt,
      signature: undefined,
    }));
  }

  /** Settle receipt evidence for one already-recorded retry attempt. */
  settleRetry(
    attempt: number,
    measuredSpend: number,
    spendBasis: NonNullable<BreakerEvent["spendBasis"]>,
  ): void {
    // Attempt numbers restart for each model call. Settle the newest matching
    // event that has not already been settled, never an earlier call's retry.
    let event: BreakerEvent | undefined;
    for (let index = this.events.length - 1; index >= 0; index--) {
      const candidate = this.events[index]!;
      if (candidate.kind === "retry_attempted" && candidate.count === attempt &&
          candidate.measuredSpend === undefined) {
        event = candidate;
        break;
      }
    }
    if (event === undefined || !Number.isFinite(measuredSpend) || measuredSpend < 0) {
      throw new Error("cave_retry_accounting_invalid");
    }
    (event as { measuredSpend?: number; spendBasis?: BreakerEvent["spendBasis"] }).measuredSpend = measuredSpend;
    (event as { measuredSpend?: number; spendBasis?: BreakerEvent["spendBasis"] }).spendBasis = spendBasis;
  }

  /**
   * Deterministic exponential backoff capped at `maxAgentDelayMs`, raised to a
   * server Retry-After when one is known. Undefined when the server asks for
   * longer than the cap: the call fails rather than sleeping past it.
   */
  backoffMs(attempt: number, serverDelayMs?: number): number | undefined {
    const cap = this.config.retryMaxAgentDelayMs;
    if (serverDelayMs !== undefined && serverDelayMs > cap) return undefined;
    const own = retryDelayMs({ baseDelayMs: this.config.retryBackoffMs, maxAgentDelayMs: cap }, attempt);
    return Math.max(own, serverDelayMs ?? 0);
  }
}

/** Server-requested wait on a thrown provider error (`retry-after-ms`, then `retry-after`), as pi-ai reads it. */
export function serverRetryDelayMs(error: unknown): number | undefined {
  const headers = (error as { headers?: unknown } | null | undefined)?.headers;
  const header = (name: string): string | undefined => {
    const value = headers instanceof Headers ? headers.get(name)
      : typeof headers === "object" && headers !== null ? (headers as Record<string, unknown>)[name] : undefined;
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  };
  const millis = Number.parseFloat(header("retry-after-ms") ?? "");
  if (Number.isFinite(millis)) return Math.max(0, millis);
  const after = header("retry-after");
  if (after === undefined) return undefined;
  const seconds = Number.parseFloat(after);
  const delay = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function callSignature(toolName: string, args: unknown): string {
  return sha256(stableStringify({ tool: toolName, args: args ?? null }));
}

/** An empty, zero-usage assistant turn: a refused call's `stop`, or a broken stream's `error`. */
function emptyTurn(model: Model<Api>, stopReason: "stop" | "error", errorMessage?: string): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, ...(errorMessage === undefined ? {} : { errorMessage }), timestamp: Date.now(),
  };
}

/**
 * Pi delivers provider failures as an `error` event, not a throw. One that
 * arrives first, before any output or usage, is the same unbilled pre-stream
 * failure as a throw, so a transient one (pi-ai's classifier) is thrown for
 * the retry loop. Everything else streams on unchanged; a source that breaks
 * mid-stream ends as an error turn, never retried.
 */
export async function failFastPreStream(
  source: AssistantMessageEventStream,
  model: Model<Api>,
): Promise<AssistantMessageEventStream> {
  const iterator = source[Symbol.asyncIterator]();
  const replay = createAssistantMessageEventStream();
  const broken = (error: unknown) => replay.push({ type: "error", reason: "error",
    error: emptyTurn(model, "error", error instanceof Error ? error.message : String(error)) });
  let first: IteratorResult<AssistantMessageEvent>;
  try {
    first = await iterator.next();
  } catch (error) {
    broken(error);
    replay.end();
    return replay;
  }
  if (!first.done) replay.push(first.value);
  void (async () => {
    try {
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) replay.push(next.value);
    } catch (error) {
      broken(error);
    }
    // A no-op after a terminal event; without one, result() would never settle.
    broken(new Error("cave_stream_ended_without_terminal"));
    replay.end();
  })();
  const failed = !first.done && first.value.type === "error" ? first.value.error : undefined;
  if (failed !== undefined && !(failed.usage.input || failed.usage.output || failed.usage.cacheRead ||
      failed.usage.cacheWrite) && isRetryableAssistantError(failed) && !isContextOverflow(failed)) {
    throw Object.assign(new Error(failed.errorMessage ?? "cave_provider_error"), { replay });
  }
  return replay;
}

/** The refused call's turn: empty, zero usage, `stop`. finishTurn ends the run on it. */
export function stoppedTurnStream(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message = emptyTurn(model, "stop");
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  return stream;
}
