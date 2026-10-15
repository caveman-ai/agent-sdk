import type { Agent, AgentContext, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
  isContextOverflow,
  isRetryableAssistantError,
  retryDelayMs,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { setTimeout as sleep } from "node:timers/promises";
import type { BudgetMeter, BudgetReservation } from "./budget.js";
import { failFastPreStream, serverRetryDelayMs, type BreakerState } from "./breakers.js";

/**
 * Pi's turn retry (`retry` in pi-coding-agent's settings defaults): a
 * transient provider error turn, mid-stream or before it, is dropped from the
 * context and the loop continues after an exponential backoff.
 */
export interface TurnRetryOptions {
  /** Consecutive retries before the error turn ends the run. Defaults to 3. */
  readonly maxRetries?: number;
  /** First backoff, doubled per attempt. Defaults to 2,000 ms. */
  readonly baseDelayMs?: number;
  /** Cap on one backoff. Defaults to pi-ai's 60,000 ms. */
  readonly maxAgentDelayMs?: number;
}

/**
 * One run's turn retries. The failed attempt stays in the receipt as the call
 * it was and leaves only Pi's state, so the retry is a new call accounted once
 * and nothing is charged twice. A compaction lives in the loop's context, not
 * in Pi's state, so a restarted loop gets the compacted window back and resends
 * the failed request's exact prefix.
 */
export class TurnRetry {
  private readonly maxRetries: number;
  private readonly policy: { readonly baseDelayMs: number; readonly maxAgentDelayMs: number };
  private attempt = 0;
  private since = 0;
  private restarted = false;
  private window: { readonly messages: readonly AgentMessage[]; readonly stateLength: number } | undefined;

  constructor(private readonly agent: Agent, options: TurnRetryOptions) {
    this.maxRetries = options.maxRetries ?? 3;
    this.policy = {
      baseDelayMs: options.baseDelayMs ?? 2_000,
      maxAgentDelayMs: options.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
    };
    if (![this.maxRetries, this.policy.baseDelayMs, this.policy.maxAgentDelayMs]
      .every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("cave_turn_retry_invalid");
    }
  }

  /** Pi's classifier; a context overflow fails the same way every time. */
  retryable(message: AssistantMessage): boolean {
    return isRetryableAssistantError(message) &&
      !isContextOverflow(message, this.agent.state.model.contextWindow);
  }

  /** The loop's context became `messages`; copied, since the loop appends to its own array. */
  compacted(messages: readonly AgentMessage[]): void {
    this.window = { messages: [...messages], stateLength: this.agent.state.messages.length };
  }

  /** Pi's `prepareRequest`: the first request after a restart gets the window back. */
  request(context: AgentContext): { context: AgentContext } | undefined {
    if (!this.restarted) return undefined;
    this.restarted = false;
    if (this.window === undefined) return undefined;
    return { context: { ...context, messages: [
      ...this.window.messages,
      ...this.agent.state.messages.slice(this.window.stateLength),
    ] } };
  }

  /** After a finished loop: true when the last turn was dropped and `continue()` should run. */
  async retry(signal: AbortSignal | undefined): Promise<boolean> {
    const messages = this.agent.state.messages;
    const failed = messages.at(-1);
    if (failed?.role !== "assistant" || !this.retryable(failed) || signal?.aborted) return false;
    // A good answer since the last restart starts a fresh retry series, as in Pi.
    if (messages.slice(this.since, -1).some((message) =>
      message.role === "assistant" && message.stopReason !== "error")) this.attempt = 0;
    if (++this.attempt > this.maxRetries) return false;
    this.agent.state.messages = messages.slice(0, -1);
    this.since = messages.length - 1;
    try {
      await sleep(retryDelayMs(this.policy, this.attempt), undefined, signal === undefined ? {} : { signal });
    } catch {
      this.agent.state.messages = messages;
      return false;
    }
    this.restarted = true;
    return true;
  }
}

/** One in-flight provider call: its budget hold and the allowance it was given. */
export type PendingCallRecord = {
  readonly model: Model<Api>;
  /** Reasoning level this call actually ran at: the route decision's, else the definition's. */
  readonly reasoning: ModelThinkingLevel;
  reservation: BudgetReservation | undefined;
  reservationMeter: BudgetMeter | undefined;
  retryAttempt: number | undefined;
  readonly clampedOutputTokens: number | undefined;
  accountingAt: Date;
};

/** Pre-stream retry of one call, each attempt held against the run's meter. */
export async function retryModelCall(
  attemptCall: () => ReturnType<StreamFn>,
  breakers: BreakerState,
  pending: PendingCallRecord,
  stopError: () => Error | undefined,
  onMeterReserved: (meter: BudgetMeter) => void | Promise<void>,
  abandon: () => void,
): Promise<Awaited<ReturnType<StreamFn>>> {
  const meter = pending.reservationMeter;
  const initial = pending.reservation;
  if (meter === undefined || initial === undefined) return attemptCall();
  const worstCaseSpend = initial.amount;
  const outputTokenCap = initial.outputTokenCap;
  let attempt = 0;
  // Exhausted or refused retries surface a provider error turn as itself.
  const giveUp = (error: unknown) => {
    const replay = (error as { replay?: AssistantMessageEventStream } | undefined)?.replay;
    if (replay === undefined) throw error;
    return replay;
  };
  for (;;) {
    try {
      return await failFastPreStream(await attemptCall(), pending.model);
    } catch (error) {
      if (pending.reservation !== undefined) {
        pending.reservationMeter?.cancel(pending.reservation);
        if (pending.retryAttempt !== undefined) {
          breakers.settleRetry(pending.retryAttempt, 0, "pre_stream_no_usage");
        }
        pending.reservation = undefined;
        pending.reservationMeter = undefined;
        pending.retryAttempt = undefined;
      }
      const terminal = stopError();
      // A context overflow fails the same way on every attempt: never retried.
      if (terminal !== undefined || terminalRetryError(error) ||
          isContextOverflow({ stopReason: "error", errorMessage: (error as Error)?.message } as AssistantMessage)) {
        abandon();
        if (terminal !== undefined) throw terminal;
        return giveUp(error);
      }
      attempt++;
      const wait = breakers.backoffMs(attempt, serverRetryDelayMs(error));
      if (wait === undefined) breakers.recordRetryExhausted(attempt);
      if (wait === undefined || !breakers.retryExposureAvailable(worstCaseSpend, attempt)) {
        abandon();
        return giveUp(error);
      }
      const reservation = meter.reserve(worstCaseSpend, outputTokenCap);
      if (reservation === undefined) {
        breakers.recordRetryExhausted(attempt);
        abandon();
        return giveUp(error);
      }
      pending.reservation = reservation;
      pending.reservationMeter = meter;
      pending.retryAttempt = attempt;
      breakers.recordRetryAttempt(worstCaseSpend, attempt);
      await onMeterReserved(meter);
      if (wait > 0) await new Promise((settle) => setTimeout(settle, wait));
      const expired = stopError();
      if (expired !== undefined) {
        meter.cancel(reservation);
        breakers.settleRetry(attempt, 0, "pre_stream_no_usage");
        pending.reservation = undefined;
        pending.reservationMeter = undefined;
        pending.retryAttempt = undefined;
        abandon();
        throw expired;
      }
    }
  }
}

function terminalRetryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" ||
    error.message === "cave_run_aborted" ||
    error.message === "cave_stream_cancelled" ||
    error.message === "cave_run_stopped" ||
    error.message === "cave_provider_terminal_aborted";
}

