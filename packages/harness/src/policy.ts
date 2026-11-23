/**
 * Bounded autonomy, enforced through Pi's loop hooks (pi-agent-core 1.4):
 * - beforeToolCall: once a stop is decided, the rest of the batch is blocked.
 * - afterToolCall: repeat detection since the last progress. A call is keyed
 *   by its name, arguments AND result, so a repeat that returns something new
 *   (a test after a fix, a poll with new output) is not a repeat. Progress
 *   resets every count: an edit or write, or a successful call (no tool error,
 *   exit code 0 or still running, not `details.failed`) whose name and
 *   arguments are new in this run, e.g. a bash heredoc, `sed -i` or script that writes a new file. So checks
 *   interleaved with real work never add up, while a cycle of the same calls
 *   (A, A, A or A, B, A, B) does. The same call with the same result `nudge_at`
 *   times gets a nudge appended to its result (append-only: the cache prefix is
 *   untouched); `stop_at` times stops the run. A wait on a live process never
 *   counts.
 * - finishTurn: budgets (USD, tokens, wall, requests), empty-turn and
 *   output-cap accounting; `{action: "end"}` stops the run.
 * - getFollowUpMessages: a response cut at max output tokens, or an empty
 *   turn, gets one "continue" message so the loop goes on.
 * Wall time is also a hard deadline: the run's AbortController fires.
 */
import type {
  AfterToolCallContext, AfterToolCallResult, AgentMessage, AgentTurnContext, AgentTurnDecision, BeforeToolCallContext, BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type { LeverState } from "./levers.ts";
import { canonicalJson, sha256, type Loadout } from "./loadout.ts";
import type { FinishSnapshot } from "./snapshot.ts";
import type { Recorder } from "./trace.ts";
import type { ToolDetails } from "./tools/compact.ts";

export interface Budgets {
  usd?: number;
  tokens?: number;
  wall_s?: number;
  requests?: number;
}

/** The tighter of two budgets per dimension. */
export function mergeBudgets(left: Budgets, right: Budgets): Budgets {
  const merged: Budgets = {};
  for (const key of ["usd", "tokens", "wall_s", "requests"] as const) {
    const values = [left[key], right[key]].filter((value): value is number => value !== undefined);
    if (values.length > 0) merged[key] = Math.min(...values);
  }
  return merged;
}

const EMPTY_TURN_MESSAGE = "Continue working on the task. If it is complete, reply with a brief summary.";

export class Policy {
  stopReason: string | undefined;
  /** Count per (name, args, result) since the last progress. */
  private readonly repeats = new Map<string, number>();
  /** Every (name, args) this run has made: a new one that succeeds is progress. */
  private readonly seenCalls = new Set<string>();
  private emptyTurns = 0;
  private lengthContinuations = 0;
  private followUps: AgentMessage[] = [];
  private wallTimer: NodeJS.Timeout | undefined;

  private readonly loadout: Loadout;
  private readonly budgets: Budgets;
  private readonly recorder: Recorder;
  private readonly abort: AbortController;
  /** The policy levers (levers.ts), when the loadout turns any on. */
  private readonly levers: LeverState | undefined;
  /** trace.finish_snapshot (snapshot.ts): the workspace at the first finish attempt, taken before any continuation is sent. */
  private readonly snapshot: FinishSnapshot | undefined;

  constructor(loadout: Loadout, budgets: Budgets, recorder: Recorder, abort: AbortController, levers?: LeverState, snapshot?: FinishSnapshot) {
    this.loadout = loadout;
    this.budgets = budgets;
    this.recorder = recorder;
    this.abort = abort;
    this.levers = levers;
    this.snapshot = snapshot;
    if (budgets.wall_s !== undefined) {
      this.wallTimer = setTimeout(() => this.stop("budget_wall", { wall_s: budgets.wall_s }, true), budgets.wall_s * 1000);
      this.wallTimer.unref();
    }
  }

  dispose(): void {
    if (this.wallTimer !== undefined) clearTimeout(this.wallTimer);
  }

  stop(reason: string, fields: Record<string, unknown> = {}, hard = false): void {
    if (this.stopReason !== undefined) return;
    this.stopReason = reason;
    this.recorder.policy("stop", reason, fields);
    if (hard) this.abort.abort(new Error(reason));
  }

  beforeToolCall = async (_context: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    if (this.stopReason === undefined) return undefined;
    return { block: true, reason: `Run stopped (${this.stopReason}); this call was not executed.`, terminate: true };
  };

  afterToolCall = async (context: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    const result = this.loopCheck(context);
    return this.levers === undefined ? result : this.levers.afterToolCall(context, result);
  };

  private loopCheck(context: AfterToolCallContext): AfterToolCallResult | undefined {
    const details = context.result.details as ToolDetails | undefined;
    if (details?.mutated === true && !context.isError) {
      this.repeats.clear();
      return undefined;
    }
    if (details?.loopExempt === true) return undefined;
    const call = sha256(canonicalJson({ name: context.toolCall.name, args: context.args ?? null }));
    const novel = !this.seenCalls.has(call);
    if (novel) this.seenCalls.add(call);
    const succeeded = !context.isError && details?.failed !== true &&
      (details?.exitCode === undefined || details.exitCode === 0 || details.handle !== undefined);
    if (novel && succeeded) this.repeats.clear();
    // A tool whose text carries run-to-run noise (exec's wall times and chunk ids) supplies a key without it.
    const outcome = details?.repeatKey ?? context.result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
    const key = sha256(`${call}\u0000${context.isError}\u0000${outcome}`);
    const count = (this.repeats.get(key) ?? 0) + 1;
    this.repeats.set(key, count);
    const { nudge_at, stop_at } = this.loadout.policy.loop;
    if (count >= stop_at) {
      this.stop("loop_repeat", { tool: context.toolCall.name, count });
      return { terminate: true };
    }
    if (count >= nudge_at) {
      this.recorder.policy("nudge", "loop_repeat", { tool: context.toolCall.name, count });
      const nudge: TextContent = { type: "text", text: `\n[harness] ${this.loadout.policy.nudges.loop.replaceAll("{count}", String(count))}` };
      return { content: [...context.result.content, nudge] };
    }
    return undefined;
  }

  finishTurn = async (turn: AgentTurnContext): Promise<AgentTurnDecision | undefined> => {
    const message = turn.message;
    if (message.stopReason === "error" || message.stopReason === "aborted") return undefined; // Pi exits on these itself
    this.checkBudgets();
    if (this.stopReason !== undefined) return { action: "end" };
    this.levers?.onTurnEnd(turn);
    const toolCalls = message.content.filter((part) => part.type === "toolCall").length;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
    if (message.stopReason === "length") {
      this.emptyTurns = 0;
      if (this.lengthContinuations >= this.loadout.policy.length_continuations) {
        this.stop("output_cap", { continuations: this.lengthContinuations });
        return { action: "end" };
      }
      this.lengthContinuations++;
      this.recorder.policy("continue", "output_cap", { n: this.lengthContinuations, tool_calls: toolCalls });
      // Truncated tool calls already came back as errors from Pi; a cut text answer needs a nudge to go on.
      if (toolCalls === 0) this.followUps.push(this.userMessage(this.loadout.policy.nudges.length));
      return undefined;
    }
    if (toolCalls === 0 && text === "") {
      this.emptyTurns++;
      if (this.emptyTurns >= this.loadout.policy.empty_turns_stop) {
        this.stop("empty_turns", { count: this.emptyTurns });
        return { action: "end" };
      }
      this.recorder.policy("continue", "empty_turn", { count: this.emptyTurns });
      this.followUps.push(this.userMessage(EMPTY_TURN_MESSAGE));
      return undefined;
    }
    this.emptyTurns = 0;
    if (toolCalls === 0 && message.stopReason === "stop" && (this.levers !== undefined || this.snapshot !== undefined)) {
      const follow = this.levers === undefined ? undefined : await this.levers.onFinishAttempt(text);
      const continues = follow !== undefined && this.stopReason === undefined;
      // The snapshot goes first: the continuation is only queued after it, so the workspace is the one the model tried to finish with.
      if (this.snapshot !== undefined && !this.snapshot.attempted && this.stopReason === undefined) {
        await this.snapshot.atFinishAttempt(this.recorder.usage.requests, continues ? [this.levers?.lastContinuation ?? "unknown"] : []);
      }
      if (continues && follow !== undefined) this.followUps.push(this.userMessage(follow));
    }
    return undefined;
  };

  getFollowUpMessages = async (): Promise<AgentMessage[]> => {
    if (this.stopReason !== undefined) return [];
    const messages = this.followUps;
    this.followUps = [];
    if (messages.length > 0) this.levers?.onContinuation();
    return messages;
  };

  /** Checks the budgets now (between retries, outside a turn); true once the run is stopped. */
  budgetExceeded(): boolean {
    this.checkBudgets();
    return this.stopReason !== undefined;
  }

  private checkBudgets(): void {
    const { usage } = this.recorder;
    const budgets = this.budgets;
    if (budgets.requests !== undefined && usage.requests >= budgets.requests) {
      this.stop("budget_requests", { requests: usage.requests, max: budgets.requests });
      return;
    }
    const tokens = usage.input_tokens + usage.cached_input_tokens + usage.cache_write_tokens + usage.output_tokens;
    if (budgets.tokens !== undefined && tokens >= budgets.tokens) {
      this.stop("budget_tokens", { tokens, max: budgets.tokens });
      return;
    }
    const cost = this.recorder.costUsd;
    if (budgets.usd !== undefined && cost !== null && cost >= budgets.usd) {
      this.stop("budget_usd", { usd: Math.round(cost * 1e6) / 1e6, max: budgets.usd });
      return;
    }
    if (budgets.wall_s !== undefined && this.recorder.now() / 1000 >= budgets.wall_s) {
      this.stop("budget_wall", { wall_s: budgets.wall_s });
    }
  }

  private userMessage(text: string): AgentMessage {
    return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  }
}
