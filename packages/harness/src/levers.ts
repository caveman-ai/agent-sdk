/**
 * The policy and depth levers (harness v3 P1-P3, D2, D3), each off unless the
 * loadout turns it on. Nothing here edits a message that was already sent:
 * reminders ride on the tool result being returned (Droid's systemReminder
 * pattern), continuations are new user messages after the final answer, and
 * the orientation is part of the first message. So the input of every request
 * extends the previous one. D2 is the exception to cache stability: on Pi's
 * default wire its effort travels as appended items (append-only), but on the
 * plain wire (mid_convo_effort false) each change rewrites a top-level field
 * (`reasoning.effort`, `thinking.budget_tokens`, `output_config.effort`).
 * Anthropic documents that a thinking or effort change invalidates the
 * messages cache, so a run refuses D2 on that combination (run.ts); whether
 * OpenAI's prefix cache survives a `reasoning.effort` change is not
 * established, and trace.cache_monitor names each change as `params_change`
 * with the next request's cache_read share, so a smoke pair measures it.
 *
 * Evidence tracking (shared by P1, P2, D2 and D4): every tool result is read for
 * file changes and checks, in order. edit, write and a patch that changed
 * files are changes; a bash or exec_command command is classified by
 * `classifyCommand` (check, change or neither, per segment); a command still
 * running when its call returns is resolved when its wait or poll returns its
 * exit. A finished check is red on a non-zero exit or a failure summary in
 * its output, else green.
 *
 * - P1 evidence_gate: at an attempt to finish (a turn with text and no tool
 *   calls), if files changed and no check ran after the last change, one
 *   user message asks for the check that proves the requirement (at most
 *   `max` per run). probe "mtime" also catches changes the classifier cannot
 *   see (a script that rewrites files): the harness touches a marker in its
 *   scratch dir at the start and after each check, and at the finish attempt
 *   looks for workspace files newer than the last marker (one find).
 * - P2 first_green: the first green check after a red one gets a reminder
 *   appended to its result. hedge_continue: a final message with hedged
 *   sentences is answered once with those sentences.
 * - P3 discovery: one pinned read-only listing before the first request,
 *   appended to the first user message.
 * - P4 finish_audit: at the first finish attempt no other continuation
 *   claims (P1 and the hedge bounce go first, so they are spent or did not
 *   apply), one user message asks for each stated requirement with the
 *   command and output that prove it now; at most `max` per run. Skipped
 *   when any hard budget (wall, USD, tokens, requests) is at 90% or more:
 *   an audit the budget cuts short is all cost.
 *   While the first message carries a requirement list (prompt.requirements,
 *   run.ts; not its placebo, not an empty list), the audit is
 *   prompt.requirements.audit_text, which asks for each numbered item.
 * - Finish checks (finishcheck.ts), after P4 in that order, each at most once
 *   per run and under P4's budget guard: test_isolation reads the workspace
 *   (git against the start commit, else a start listing) and, when a test
 *   file the run created uses helpers defined only in another test file the
 *   run wrote, sends one reminder naming them; evidence_bounce classifies the
 *   draft final and, when it names no requirement-level check, bounces once.
 *   Each `_placebo` flag keeps the trigger and sends placeboFor(id, text).
 * - unmet_target and travel_check (travel.ts), after those two in that order,
 *   each at most once per run under the same guard: unmet_target answers a
 *   draft final that says a numeric target the task set is unmet (a number
 *   the task text has, next to an unmet phrase) while less than
 *   max_used_pct (50%) of the wall budget is used, quoting the sentence and
 *   the time left; travel_check (start state taken in start(), all env
 *   commands internal) names packages installed during the run that the
 *   run's files import, pre-existing files they read by literal path, and
 *   scratch/test files the run left in the working tree. unmet_target goes
 *   first: hygiene is judged on the workspace after any more work it buys.
 * - travel_jit (travel-jit.ts): the same three hazards at the decision point,
 *   a note appended to the tool result whose call made a file of the run's
 *   import a package installed during the run (the write, or the install when
 *   it came second) or wrote a scratch script in the tree (packages and
 *   scratch), or to the next tool result after a write whose added lines read
 *   a pre-existing file (data, checked asynchronously; a finish attempt drops
 *   a note still waiting). At most max_per_kind per kind; it shares
 *   travel_check's start state.
 * - interface_gate (interface-gate.ts): a note appended to the tool result
 *   whose edit gave a file that was there at the start new public functions
 *   (scope "untouched": new functions while none of that file's start
 *   functions changed, this edit or earlier), when the task reads as a fix;
 *   at most `max` per run. The exec surface's apply_patch computes what each
 *   write did to the file's functions (nested.ts, only while the lever is
 *   on); no env command.
 * - thin_margin (thin-margin.ts): a note appended to the tool result whose
 *   output (the result text and the cell's nested command outputs) prints a
 *   check passing a numeric threshold the task states within margin_pct of
 *   it, or a speedup under speedup_factor times the task's target; at most
 *   `max` per run. No model call, no env command.
 * - validator (validator.ts), after travel_check, at most max_rounds times
 *   per run under the same 90% guard: a separate model call writes an
 *   acceptance check program from the task text and a starting listing at
 *   run start (started in start(), never awaited before the first request);
 *   at a finish attempt the harness runs it (internal command, in the env's
 *   scratch dir) and continues the run with the failing requirements,
 *   clustered, never the program. A program that does not finish (no END
 *   line) never bounces. The placebo keeps the call, the check and the
 *   trigger and sends placeboFor("validator", text).
 * - critic (critic.ts), after the validator (so at the first finish attempt
 *   no other finish lever claims), at most max_rounds times per run under the
 *   same 90% guard: a separate agent loop on the run's model, with a fresh
 *   context (the task, what changed since the start, the final message) and
 *   read-only tools (every change it makes in the cwd is reverted), reviews
 *   the workspace and ends with VERDICT: PASS/FAIL; a FAIL's findings continue
 *   the run once. The placebo keeps the review and the trigger and sends
 *   placeboFor("critic", text).
 * - clause_check (clause-check.ts): at the first green check after a red one
 *   (P2's moment; first_green on or off), at most `max` times per run and only
 *   when the project tree changed since the start, one side call on the run's
 *   model at the run's effort, in the background (never delaying the result
 *   or the next request), lists the task's clauses that the workspace's
 *   changes and that check's output do not show as handled; the list rides on
 *   the next tool result after the call returns (none for NONE; a finish
 *   attempt or the run's end drops it). The placebo keeps the trigger and the
 *   call and sends placeboFor("clause_check", note).
 * - P6 time_budget (run.ts, via timeBudgetLine): the first user message gets
 *   one line stating the wall budget in minutes, or, under
 *   time_budget_placebo, a neutral line of the same estimated token count.
 * - D2 escalate: the requests before the first change (at most
 *   first_write_max; the request that makes the first change cannot be known
 *   before it is sent) and the request after a red check run at the escalated
 *   effort; every other request at the run's effort.
 * - D3 wall_notice: once elapsed wall passes at_pct of the wall budget, the
 *   next tool result carries the time used and left.
 * - D4 deescalate: a MECHANICAL request runs at `to` (medium or low), every
 *   other request at the run's effort. Mechanical: the last turn's tool
 *   results were all read-only (read; a bash or exec_command command that
 *   `readOnlyCommand` places; an exec cell whose nested calls were all that, or
 *   view_image) or polls (a wait on a job still running), the kinds in `on`,
 *   none failed, printed a failure summary (`readsRed`: a log of a check that
 *   hid its exit, `> out.log; echo $?` or `|| true`, read back) or carried a
 *   harness nudge or reminder; that turn saw no red check, no red check is
 *   outstanding and no red read since the last green check; its text did not announce
 *   finishing (finish_patterns); and no harness message (evidence gate,
 *   hedge, empty-turn or output-cap continuation) followed it. So the first
 *   request, the ones after a red check or a red read (until a green check)
 *   and the one after a finish attempt keep the run's effort. D2 wins: a request D2 escalates is never lowered.
 *   It travels on the same per-request path as D2 (plain wire only: refused
 *   where it would rewrite a cached top-level field or append Pi's per-turn
 *   effort items, run.ts).
 */
import type { AfterToolCallContext, AfterToolCallResult, AgentTurnContext, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Api, type Model, type TextContent } from "@earendil-works/pi-ai";
import type { ExecEnv } from "./env/types.ts";
import { checkOutcome, classifyCommand, hedgedItems, readOnlyCommand, type CommandFacts } from "./evidence.ts";
import { agentTestFiles, evidenceClass, formatFindings, isolationFindings, readBaseline, type Baseline } from "./finishcheck.ts";
import { formatTravel, readTravelStart, scratchKind, travelFindings, travelFired, unmetSentence, type TravelStart } from "./travel.ts";
import { TravelJit } from "./travel-jit.ts";
import { InterfaceGate } from "./interface-gate.ts";
import { ThinMargin } from "./thin-margin.ts";
import { Validator, type SideCall } from "./validator.ts";
import { Critic } from "./critic.ts";
import { ClauseCheck } from "./clause-check.ts";
import type { Loadout } from "./loadout.ts";
import { costOf, type ResolvedModel } from "./models.ts";
import type { Budgets } from "./policy.ts";
import { placeboFor } from "./prompts.ts";
import type { LedgerEntry } from "./tools/exec/nested.ts";
import type { ToolDetails } from "./tools/compact.ts";
import type { Recorder } from "./trace.ts";

/** The finish checks: each at most once per run, under the 90% budget guard, with a `_placebo` flag. */
type FinishCheck = "test_isolation" | "evidence_bounce" | "unmet_target" | "travel_check";

const LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Why a request runs at its effort: the run's own (base), raised by D2 (escalated), lowered by D4 (mechanical). */
export type EffortReason = "base" | "escalated" | "mechanical";

/** A tool result as D4 sees it: file contents or a read-only command, a wait on a job still running, or anything else. */
type Mechanical = "read_only" | "poll" | undefined;

/** Nested exec tools that read: exec_command (its command is judged on its own) and write_stdin polls (a "\u0003" stop logs nothing, so it fails the count). */
const NESTED_READS = new Set(["exec_command", "write_stdin", "view_image"]);

type ResultDetails = ToolDetails & { log?: LedgerEntry[]; nested?: Record<string, number>; running?: true };

/** A finished check: its verdict, its command and its output (on the exec surface the ledger's tail). */
interface CheckRun {
  verdict: "red" | "green";
  cmd: string;
  output: string;
}

/** A command still running when its call returned, by bash handle or exec_command session: its facts and text. */
interface Pending {
  facts: CommandFacts;
  cmd: string;
}

/** Workspace files newer than a marker, pruning VCS, vendored and cache trees; at most 5 paths. */
export function probeCommand(marker: string): string {
  return "find . \\( -name .git -o -name node_modules -o -name __pycache__ -o -name .pytest_cache -o -name .mypy_cache -o -name .ruff_cache " +
    "-o -name .tox -o -name .venv -o -name venv -o -name .cache -o -name target \\) -prune -o -type f " +
    `-newer ${shellQuote(marker)} ! -name '*.pyc' ! -name '*.log' -print 2>/dev/null | head -n 5`;
}

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** Seconds as a short human duration: "45 s", "12 min". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** Cut text to at most `maxBytes` UTF-8 bytes at a line boundary, saying how many lines were left out. */
export function capListing(text: string, maxBytes: number): string {
  const lines = text.split("\n").filter((line) => line !== "");
  const kept: string[] = [];
  let bytes = 0;
  for (const [index, line] of lines.entries()) {
    const more = `[... ${lines.length - index} more]`;
    const size = Buffer.byteLength(line, "utf8") + 1;
    const reserve = index === lines.length - 1 ? 0 : Buffer.byteLength(more, "utf8");
    if (bytes + size + reserve > maxBytes) {
      kept.push(more);
      break;
    }
    kept.push(line);
    bytes += size;
  }
  return kept.length === 0 ? "(none found)" : kept.join("\n");
}

/** P4 stays quiet once any hard budget is this far used: the audit's extra work would be cut off. */
export const FINISH_AUDIT_BUDGET_PCT = 90;

/**
 * P6: the line the first user message gets, or undefined when the lever is off
 * or there is no wall budget (run.ts refuses that combination). Deterministic
 * in the loadout and the budget, so the first message stays one cache prefix
 * across trials. The placebo is neutral text of the line's estimated token count.
 */
export function timeBudgetLine(loadout: Loadout, wallS: number | undefined): { text: string; minutes: number } | undefined {
  const lever = loadout.prompt.time_budget;
  if (lever === undefined || wallS === undefined) return undefined;
  const minutes = Math.max(1, Math.round(wallS / 60));
  const line = lever.text.replaceAll("{minutes}", String(minutes));
  return { text: loadout.prompt.time_budget_placebo === true ? placeboFor("time_budget", line) : line, minutes };
}

interface Marker {
  path: string;
  ready: Promise<boolean>;
}

export class LeverState {
  private readonly loadout: Loadout;
  private readonly budgets: Budgets;
  private readonly recorder: Recorder;
  private readonly env: ExecEnv;
  private readonly base: ThinkingLevel;
  private readonly escalated: ThinkingLevel | undefined;
  /** D4's lowered level (never above the run's own), or undefined when D4 is off. */
  private readonly lowered: ThinkingLevel | undefined;
  private readonly finishPatterns: RegExp[];

  private seq = 0;
  private lastChange: number | undefined;
  private lastCheck: number | undefined;
  /** A check failed and no green one has followed yet (P2). */
  private redOpen = false;
  /** A check in the current turn's tool batch was red (D2 after_red). */
  private redThisTurn = false;
  private redLastTurn = false;
  private completedTurns = 0;
  private gates = 0;
  private greens = 0;
  private hedges = 0;
  private audits = 0;
  private auditSkipped = false;
  /** Finish checks: fired (once per run) and budget-skip recorded, by lever. */
  private readonly checked = new Set<string>();
  private readonly checkSkipped = new Set<string>();
  /** The task text (unmet_target's numbers; what travel_check's findings may not name). */
  private readonly task: string;
  /** travel_check and travel_jit: the start marker, scratch-looking paths and packages. */
  private travelStart: Promise<TravelStart | null> | undefined;
  /** travel_jit's state, when it is on. */
  private readonly jit: TravelJit | undefined;
  /** interface_gate's state, when it is on. */
  private readonly iface: InterfaceGate | undefined;
  /** thin_margin's state, when it is on. */
  private readonly margin: ThinMargin | undefined;
  private travelFailed = false;
  /** test_isolation: the workspace at the start (git commit and dirty paths, or the test files present). */
  private baseline: Promise<Baseline | null> | undefined;
  private readonly evidencePatterns: { requirement: RegExp[]; proxy: RegExp[] } | undefined;
  /** Items of the requirement list the first message showed (prompt.requirements, not its placebo); P4 then asks by number. */
  private requirementItems = 0;
  private noticed = false;
  /** policy.validator's state, when it is on. */
  private readonly validator: Validator | undefined;
  /** policy.critic's state, when it is on. */
  private readonly critic: Critic | undefined;
  /** policy.clause_check's state, when it is on. */
  private readonly clause: ClauseCheck | undefined;
  /** The finish lever whose continuation the last onFinishAttempt returned (trace.finish_snapshot's levers_pending), or undefined. */
  lastContinuation: "evidence_gate" | "hedge" | "finish_audit" | FinishCheck | "validator" | "critic" | undefined;
  private markers = 0;
  private marker: Marker | undefined;
  /** Commands still running, by bash handle or exec_command session: resolved when their exit comes back. */
  private readonly pendingHandles = new Map<string, Pending>();
  private readonly pendingSessions = new Map<number, Pending>();
  /** D4: this turn's tool results as the hooks saw them: how many, and whether every one was mechanical. */
  private turnSeen = 0;
  private turnMechanical = true;
  /** D4: the next request is mechanical unless a red check opens before it is sent. */
  private mechanicalNext = false;
  /** D4: a read or poll printed a failure summary and no check has finished green since (D4's own: P2 and D2 do not see it). */
  private redReadOpen = false;
  /** D4: still-running commands by bash handle or exec_command session, read-only or not: a finished wait on one is judged by its command. */
  private readonly readOnlyHandles = new Map<string, boolean>();
  private readonly readOnlySessions = new Map<number, boolean>();

  constructor(options: {
    loadout: Loadout; budgets: Budgets; recorder: Recorder; env: ExecEnv; model: Model<Api>; thinking: ThinkingLevel; task?: string;
    /** policy.validator's side call on the run's model client (run.ts); required when the lever is on. */
    sideCall?: SideCall;
    /** policy.critic's client: the run's provider, model, base URL and key (run.ts, a faux model its own script); required when the lever is on. */
    criticModel?: ResolvedModel;
    /** policy.clause_check's side call on the run's model client at the run's effort (run.ts clauseCallOf); required when the lever is on. */
    clauseCall?: SideCall;
    /** Whether the model takes images (the critic's view_image). */
    images?: boolean;
    /** The run's abort (wall budget, signals): stops the validator's call and check, and the critic's review. */
    signal?: AbortSignal;
  }) {
    this.loadout = options.loadout;
    this.task = options.task ?? "";
    this.budgets = options.budgets;
    this.recorder = options.recorder;
    this.env = options.env;
    this.base = options.thinking;
    const escalate = options.loadout.depth?.escalate;
    if (escalate !== undefined && options.thinking !== "off") {
      const level = clampThinkingLevel(options.model, escalate.effort) as ThinkingLevel;
      // Escalation never lowers effort below the run's own.
      this.escalated = LEVELS.indexOf(level) > LEVELS.indexOf(options.thinking) ? level : options.thinking;
    }
    const deescalate = options.loadout.depth?.deescalate;
    if (deescalate !== undefined && options.thinking !== "off") {
      const level = clampThinkingLevel(options.model, deescalate.to) as ThinkingLevel;
      // De-escalation never raises effort above the run's own.
      this.lowered = LEVELS.indexOf(level) < LEVELS.indexOf(options.thinking) ? level : options.thinking;
    }
    this.finishPatterns = (deescalate?.finish_patterns ?? []).map((pattern) => new RegExp(pattern, "iu"));
    const jit = options.loadout.policy.travel_jit;
    if (jit !== undefined) {
      this.jit = new TravelJit({ lever: jit, placebo: options.loadout.policy.travel_jit_placebo === true, env: options.env, recorder: options.recorder, task: this.task });
    }
    const iface = options.loadout.policy.interface_gate;
    if (iface !== undefined) {
      this.iface = new InterfaceGate({
        lever: iface, placebo: options.loadout.policy.interface_gate_placebo === true, recorder: options.recorder, task: this.task, cwd: options.env.cwd,
      });
    }
    const margin = options.loadout.policy.thin_margin;
    if (margin !== undefined) {
      this.margin = new ThinMargin({ lever: margin, placebo: options.loadout.policy.thin_margin_placebo === true, recorder: options.recorder, task: this.task });
    }
    const validator = options.loadout.policy.validator;
    if (validator !== undefined) {
      if (options.sideCall === undefined) throw new Error("policy.validator needs a side call on the run's model");
      this.validator = new Validator({
        lever: validator, env: options.env, recorder: options.recorder, task: this.task, call: options.sideCall, model: options.model,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    const critic = options.loadout.policy.critic;
    if (critic !== undefined) {
      if (options.criticModel === undefined) throw new Error("policy.critic needs the run's model client");
      this.critic = new Critic({
        lever: critic, loadout: options.loadout, env: options.env, recorder: options.recorder, task: this.task, side: options.criticModel,
        images: options.images ?? false, ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    const clause = options.loadout.policy.clause_check;
    if (clause !== undefined) {
      if (options.clauseCall === undefined) throw new Error("policy.clause_check needs a side call on the run's model");
      const model = options.model;
      const prices = options.loadout.prices;
      this.clause = new ClauseCheck({
        lever: clause, placebo: options.loadout.policy.clause_check_placebo === true, env: options.env, recorder: options.recorder, task: this.task,
        call: options.clauseCall, reasoning: options.thinking === "off" ? undefined : options.thinking, cost: (usage) => costOf(model, usage, prices),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }
    const bounce = options.loadout.policy.evidence_bounce;
    if (bounce !== undefined) {
      this.evidencePatterns = {
        requirement: bounce.requirement_patterns.map((pattern) => new RegExp(pattern, "iu")), proxy: bounce.proxy_patterns.map((pattern) => new RegExp(pattern, "iu")),
      };
    }
  }

  /** Whether any lever needs the tool-result hooks (none: the run's hooks are exactly as without levers). */
  get active(): boolean {
    const { policy, depth } = this.loadout;
    return policy.evidence_gate !== undefined || policy.first_green !== undefined || policy.hedge_continue !== undefined ||
      policy.finish_audit !== undefined || policy.test_isolation !== undefined || policy.evidence_bounce !== undefined ||
      policy.unmet_target !== undefined || policy.travel_check !== undefined || policy.travel_jit !== undefined || policy.interface_gate !== undefined || policy.thin_margin !== undefined ||
      policy.validator !== undefined ||
      policy.critic !== undefined || policy.clause_check !== undefined || depth?.escalate !== undefined || depth?.deescalate !== undefined || depth?.wall_notice !== undefined;
  }

  /**
   * Before the first request: the start marker for the mtime probe, and the P3 orientation block (undefined when off or empty).
   * The validator's generation starts here and is not awaited; the critic's and clause_check's start states (one internal command each) are.
   */
  async start(): Promise<string | undefined> {
    this.validator?.begin();
    const critic = this.critic?.begin();
    const clause = this.clause?.begin();
    if (this.loadout.policy.evidence_gate?.probe === "mtime") this.touchMarker();
    if (this.loadout.policy.test_isolation !== undefined) this.baseline = readBaseline(this.env);
    if (this.loadout.policy.travel_check !== undefined || this.jit !== undefined) this.travelStart = readTravelStart(this.env);
    if (this.jit !== undefined && this.travelStart !== undefined) this.jit.begin(this.travelStart);
    const [orientation] = await Promise.all([this.discover(), this.marker?.ready, this.baseline, this.travelStart, critic, clause]);
    return orientation;
  }

  private async discover(): Promise<string | undefined> {
    const discovery = this.loadout.policy.discovery;
    if (discovery === undefined) return undefined;
    const started = performance.now();
    try {
      const run = await this.env.exec(discovery.command, { timeoutMs: 30_000 });
      const listing = capListing(run.output, discovery.max_bytes);
      this.recorder.policy("orient", "discovery", { bytes: Buffer.byteLength(listing, "utf8"), lines: listing.split("\n").length, ms: Math.round(performance.now() - started) });
      return discovery.text.replaceAll("{listing}", listing);
    } catch (error) {
      this.recorder.policy("orient", "discovery_failed", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  /**
   * The thinking level of the next request and why (D2, D4), or undefined when
   * neither is on. Pure: a retried request gets the level of the one it repeats.
   */
  requestLevel(): { level: ThinkingLevel; reason: EffortReason } | undefined {
    if (this.escalated === undefined && this.lowered === undefined) return undefined;
    const escalate = this.loadout.depth?.escalate;
    if (escalate !== undefined && this.escalated !== undefined) {
      const preWrite = escalate.on.includes("first_write") && this.lastChange === undefined && this.completedTurns < escalate.first_write_max;
      const afterRed = escalate.on.includes("after_red") && this.redLastTurn;
      // D2 wins: a request it escalates is a decision, so D4 never lowers it.
      if (preWrite || afterRed) return { level: this.escalated, reason: this.escalated === this.base ? "base" : "escalated" };
    }
    if (this.lowered !== undefined && this.lowered !== this.base && this.mechanicalNext && !this.redOpen && !this.redReadOpen) return { level: this.lowered, reason: "mechanical" };
    return { level: this.base, reason: "base" };
  }

  /** A completed (not failed) turn: D2's and D4's per-turn state moves on. */
  onTurnEnd(turn?: Pick<AgentTurnContext, "message" | "toolResults">): void {
    this.completedTurns++;
    if (this.lowered !== undefined) {
      const results = turn?.toolResults ?? [];
      const text = (turn?.message.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
      // Every result was seen by the hook (none was refused before it ran), none failed, no red check, no finish announced.
      this.mechanicalNext = results.length > 0 && this.turnSeen === results.length && this.turnMechanical && results.every((result) => !result.isError) &&
        !this.redThisTurn && !this.finishPatterns.some((pattern) => pattern.test(text));
    }
    this.turnSeen = 0;
    this.turnMechanical = true;
    this.redLastTurn = this.redThisTurn;
    this.redThisTurn = false;
  }

  /** The first message carries a numbered requirement list of `items` items: P4's audit asks for each by number (prompt.requirements.audit_text). */
  listedRequirements(items: number): void {
    this.requirementItems = items;
  }

  /** The harness added a message after the last turn (evidence gate, hedge, empty-turn or output-cap continuation): the next request is not mechanical. */
  onContinuation(): void {
    this.mechanicalNext = false;
  }

  /**
   * Reads a tool result for changes and checks; returns the result with any reminder appended (P2 first green, D3 wall notice,
   * travel_jit, interface_gate and thin_margin notes, a clause_check note that was ready before this result came back).
   */
  async afterToolCall(context: AfterToolCallContext, prior: AfterToolCallResult | undefined): Promise<AfterToolCallResult | undefined> {
    if (prior?.terminate === true) return prior;
    const details = context.result.details as ResultDetails | undefined;
    const isError = prior?.isError ?? context.isError;
    const content = prior?.content ?? context.result.content;
    const args = context.args as Record<string, unknown> | undefined;
    const text = textOf(content);
    // Taken first: a note never rides on the result whose check triggered it, whatever this hook awaits below.
    const clauseNote = this.clause?.take(context.toolCall.name);
    this.clause?.observe(context.toolCall.name, args, details);
    let kind = this.lowered === undefined ? undefined : this.mechanicalKind(context.toolCall.name, args, details, isError);
    // D4 judges what a read printed, not only what ran: a log of a check that hid its verdict (`> out.log; echo $?`, `|| true`) reads red here.
    if (kind !== undefined && readsRed(text, details)) {
      kind = undefined;
      this.redReadOpen = true;
    }
    const outcomes = isError ? [] : this.observe(context.toolCall.name, args, details, text);
    const reminders: string[] = [];
    const green = this.loadout.policy.first_green;
    for (const outcome of outcomes) {
      if (outcome.verdict === "red") {
        this.redOpen = true;
        this.redThisTurn = true;
        continue;
      }
      this.redReadOpen = false;
      if (this.redOpen) {
        this.redOpen = false;
        if (green !== undefined && this.greens < green.max) {
          this.greens++;
          this.recorder.policy("remind", "first_green", { tool: context.toolCall.name, n: this.greens });
          reminders.push(green.text);
        }
        this.clause?.trigger({ tool: context.toolCall.name, cmd: outcome.cmd, output: outcome.output, changedByTools: this.lastChange !== undefined });
      }
    }
    const notice = this.loadout.depth?.wall_notice;
    if (notice !== undefined && !this.noticed && this.budgets.wall_s !== undefined) {
      const elapsed = this.recorder.now() / 1000;
      if (elapsed >= (this.budgets.wall_s * notice.at_pct) / 100) {
        this.noticed = true;
        const left = Math.max(0, this.budgets.wall_s - elapsed);
        this.recorder.policy("remind", "wall_notice", { elapsed_s: Math.round(elapsed), remaining_s: Math.round(left) });
        reminders.push(notice.text.replaceAll("{elapsed}", formatDuration(elapsed)).replaceAll("{remaining}", formatDuration(left))
          .replaceAll("{budget}", formatDuration(this.budgets.wall_s)));
      }
    }
    if (this.jit !== undefined) reminders.push(...await this.jit.afterTool(context.toolCall.name, args, details, text));
    if (this.iface !== undefined) reminders.push(...this.iface.afterTool(context.toolCall.name, args, details));
    // The tool's own result, not a harness nudge an earlier hook appended to it.
    if (this.margin !== undefined) reminders.push(...this.margin.afterTool(context.toolCall.name, details, textOf(context.result.content)));
    if (clauseNote !== undefined) reminders.push(clauseNote);
    const deescalate = this.loadout.depth?.deescalate;
    if (deescalate !== undefined) {
      this.turnSeen++;
      // A result carrying a harness nudge (prior content) or reminder asks for a decision.
      if (kind === undefined || !deescalate.on.includes(kind) || reminders.length > 0 || prior?.content !== undefined) this.turnMechanical = false;
    }
    if (reminders.length === 0) return prior;
    const appended: TextContent[] = reminders.map((text) => ({ type: "text", text: `\n[harness] ${text}` }));
    return { ...(prior ?? {}), content: [...content, ...appended] };
  }

  /**
   * An attempt to finish (a turn with text and no tool calls): the P1 gate,
   * then the hedge bounce, then the P4 audit, then the finish checks
   * (test_isolation, evidence_bounce, unmet_target, travel_check), then the
   * validator, then the critic; at most one of them per attempt.
   * Returns the continuation message, or undefined to let the run end.
   */
  async onFinishAttempt(text: string): Promise<string | undefined> {
    this.lastContinuation = undefined;
    this.clause?.onFinishAttempt();
    await this.jit?.onFinishAttempt();
    const gate = this.loadout.policy.evidence_gate;
    if (gate !== undefined && this.gates < gate.max) {
      const unverified = await this.unverified(gate.probe);
      if (unverified !== undefined) {
        this.gates++;
        this.recorder.policy("continue", "evidence_gate", { n: this.gates, ...unverified });
        this.lastContinuation = "evidence_gate";
        return gate.text;
      }
    }
    const hedge = this.loadout.policy.hedge_continue;
    if (hedge !== undefined && this.hedges < hedge.max) {
      const items = hedgedItems(text, hedge.patterns.map((pattern) => new RegExp(pattern, "u")));
      if (items.length > 0) {
        this.hedges++;
        this.recorder.policy("continue", "hedge", { n: this.hedges, items: items.length });
        this.lastContinuation = "hedge";
        return hedge.text.replaceAll("{items}", items.map((item) => `- ${item}`).join("\n"));
      }
    }
    const audit = this.loadout.policy.finish_audit;
    if (audit !== undefined && this.audits < audit.max) {
      const near = this.budgetNear(FINISH_AUDIT_BUDGET_PCT);
      if (near !== undefined) {
        if (!this.auditSkipped) this.recorder.policy("skip", "finish_audit", near);
        this.auditSkipped = true;
        return undefined;
      }
      this.audits++;
      const listed = this.requirementItems > 0 ? this.loadout.prompt.requirements?.audit_text : undefined;
      this.recorder.policy("continue", "finish_audit", { n: this.audits, ...(listed === undefined ? {} : { list: this.requirementItems }) });
      this.lastContinuation = "finish_audit";
      return listed ?? audit.text;
    }
    return (await this.isolationCheck()) ?? this.evidenceBounce(text) ?? this.unmetTarget(text) ?? (await this.travelCheck()) ?? (await this.validatorCheck()) ??
      (await this.criticCheck(text));
  }

  /**
   * The run is over: the validator's call, if still running, is aborted (its usage so far counts) and its program goes to the
   * trace; the critic takes no new review (one still running is aborted; its guard still restores); clause_check's call, if still
   * running, is aborted and counted, and a note still waiting is dropped. Idempotent.
   */
  async close(): Promise<void> {
    this.critic?.close();
    await Promise.all([this.validator?.close(), this.clause?.close()]);
  }

  /**
   * critic: a review at a finish attempt no earlier lever claimed, at most max_rounds times, under the finish checks' 90% guard
   * (the skip recorded once); its wall cap is clamped to half the wall left, and a USD or token budget reached ends it. A FAIL
   * with findings continues the run; the placebo sends neutral text of the same estimated token count.
   */
  private async criticCheck(text: string): Promise<string | undefined> {
    const critic = this.critic;
    if (critic === undefined || !critic.pending) return undefined;
    const near = this.budgetNear(FINISH_AUDIT_BUDGET_PCT);
    if (near !== undefined) {
      if (!this.checkSkipped.has("critic")) this.recorder.policy("skip", "critic", near);
      this.checkSkipped.add("critic");
      return undefined;
    }
    const wall = this.budgets.wall_s;
    const outcome = await critic.review(text, {
      ...(wall === undefined ? {} : { wallLeftMs: wall * 1000 - this.recorder.now() }), overBudget: () => this.budgetNear(100) !== undefined,
    });
    if (outcome === undefined) return undefined;
    this.lastContinuation = "critic";
    const placebo = this.loadout.policy.critic_placebo === true;
    this.recorder.policy("continue", "critic", { ...outcome.fields, placebo });
    return placebo ? placeboFor("critic", outcome.text) : outcome.text;
  }

  /**
   * validator: the check program run at a finish attempt, at most max_rounds
   * times, under the finish checks' 90% guard (the skip recorded once); its
   * timeout is clamped to the wall left. Failing requirements continue the
   * run; the placebo sends neutral text of the same estimated token count.
   */
  private async validatorCheck(): Promise<string | undefined> {
    const validator = this.validator;
    if (validator === undefined || !validator.pending) return undefined;
    const near = this.budgetNear(FINISH_AUDIT_BUDGET_PCT);
    if (near !== undefined) {
      if (!this.checkSkipped.has("validator")) this.recorder.policy("skip", "validator", near);
      this.checkSkipped.add("validator");
      return undefined;
    }
    const wall = this.budgets.wall_s;
    const outcome = await validator.check(wall === undefined ? undefined : wall * 1000 - this.recorder.now());
    if (outcome === undefined) return undefined;
    this.lastContinuation = "validator";
    const placebo = this.loadout.policy.validator_placebo === true;
    this.recorder.policy("continue", "validator", { ...outcome.fields, placebo });
    return placebo ? placeboFor("validator", outcome.text) : outcome.text;
  }

  /** A finish check may run: on, not yet fired, and no hard budget at 90% (P4's guard; the skip is recorded once). */
  private mayCheck(id: FinishCheck): boolean {
    if (this.loadout.policy[id] === undefined || this.checked.has(id)) return false;
    const near = this.budgetNear(FINISH_AUDIT_BUDGET_PCT);
    if (near === undefined) return true;
    if (!this.checkSkipped.has(id)) this.recorder.policy("skip", id, near);
    this.checkSkipped.add(id);
    return false;
  }

  /** The message a finish check sends: its text, or under its placebo flag neutral text of the same estimated token count. */
  private fire(id: FinishCheck, text: string, fields: Record<string, unknown>): string {
    this.checked.add(id);
    this.lastContinuation = id;
    const placebo = this.loadout.policy[`${id}_placebo`] === true;
    this.recorder.policy("continue", id, { ...fields, placebo });
    return placebo ? placeboFor(id, text) : text;
  }

  private async isolationCheck(): Promise<string | undefined> {
    const lever = this.loadout.policy.test_isolation;
    if (lever === undefined || !this.mayCheck("test_isolation")) return undefined;
    const started = performance.now();
    try {
      const files = await agentTestFiles(this.env, (await this.baseline) ?? null);
      const findings = isolationFindings(files);
      const ms = Math.round(performance.now() - started);
      if (findings.length === 0) {
        this.recorder.policy("check", "test_isolation", { files: files.length, findings: 0, ms });
        return undefined;
      }
      return this.fire("test_isolation", lever.text.replaceAll("{items}", formatFindings(findings)), {
        files: files.length, findings: findings.length, ms, langs: [...new Set(findings.map((finding) => finding.lang))].sort(),
        pairs: findings.slice(0, 5).map((finding) => `${finding.file} <- ${finding.from}`),
      });
    } catch (error) {
      this.recorder.policy("check", "test_isolation_failed", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  private evidenceBounce(text: string): string | undefined {
    const lever = this.loadout.policy.evidence_bounce;
    if (lever === undefined || this.evidencePatterns === undefined || this.checked.has("evidence_bounce")) return undefined;
    const klass = evidenceClass(text, this.evidencePatterns);
    if (klass === "requirement" || !this.mayCheck("evidence_bounce")) return undefined;
    return this.fire("evidence_bounce", lever.text, { class: klass });
  }

  /**
   * unmet_target: the draft final's first sentence saying a numeric target of
   * the task is unmet, answered once with that sentence and the time left,
   * while less than max_used_pct of the wall budget is used (no wall budget:
   * no time to quote, never fires). Over it, the skip is recorded once.
   */
  private unmetTarget(text: string): string | undefined {
    const lever = this.loadout.policy.unmet_target;
    const wall = this.budgets.wall_s;
    if (lever === undefined || wall === undefined || this.checked.has("unmet_target") || this.checkSkipped.has("unmet_target")) return undefined;
    const sentence = unmetSentence(text, this.task, { number: lever.require_number });
    if (sentence === undefined) return undefined;
    const elapsed = this.recorder.now() / 1000;
    const usedPct = wall === 0 ? 100 : Math.round((elapsed / wall) * 100);
    if (elapsed * 100 >= wall * lever.max_used_pct) {
      this.checkSkipped.add("unmet_target");
      this.recorder.policy("skip", "unmet_target", { budget: "wall_s", used_pct: usedPct, max_used_pct: lever.max_used_pct });
      return undefined;
    }
    if (!this.mayCheck("unmet_target")) return undefined;
    const left = formatDuration(Math.max(0, wall - elapsed));
    return this.fire("unmet_target", lever.text.replaceAll("{sentence}", sentence).replaceAll("{remaining}", left), { used_pct: usedPct, sentence: sentence.slice(0, 200) });
  }

  /** travel_check: what would not travel to a fresh copy of the start (travel.ts), named once. */
  private async travelCheck(): Promise<string | undefined> {
    const lever = this.loadout.policy.travel_check;
    if (lever === undefined || this.travelFailed || !this.mayCheck("travel_check")) return undefined;
    const start = await this.travelStart;
    if (start === null || start === undefined) {
      this.travelFailed = true;
      this.recorder.policy("check", "travel_check_failed", { error: "no start state" });
      return undefined;
    }
    const started = performance.now();
    try {
      const all = await travelFindings(this.env, start, this.task);
      const kinds = new Set(lever.kinds);
      // Only the kinds the loadout names trigger (and are named); __pycache__ rides along with any.
      const findings = {
        ...all, packages: kinds.has("packages") ? all.packages : [], data: kinds.has("data") ? all.data : [],
        scratch: all.scratch.filter((path) => kinds.has(scratchKind(path) === "test" ? "scratch_tests" : "scratch_other")),
      };
      const ms = Math.round(performance.now() - started);
      const fields = { written: findings.written, code: findings.code, start_packages: start.packages.size, pycache: findings.pycache.length, ms };
      if (!travelFired(findings)) {
        this.recorder.policy("check", "travel_check", { ...fields, findings: 0 });
        return undefined;
      }
      return this.fire("travel_check", lever.text.replaceAll("{items}", formatTravel(findings)), {
        ...fields, findings: findings.packages.length + findings.data.length + findings.scratch.length,
        packages: findings.packages.map((finding) => finding.name), data: findings.data.slice(0, 5).map((finding) => `${finding.file} <- ${finding.reads.slice(0, 3).join(", ")}`),
        scratch: findings.scratch.slice(0, 10),
      });
    } catch (error) {
      this.recorder.policy("check", "travel_check_failed", { error: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }

  /** The first hard budget used to `pct` percent or more, with how much is used, or undefined. */
  private budgetNear(pct: number): { budget: keyof Budgets; used_pct: number } | undefined {
    const { usage } = this.recorder;
    const used: Record<keyof Budgets, number | null> = {
      wall_s: this.recorder.now() / 1000,
      usd: this.recorder.costUsd,
      tokens: usage.input_tokens + usage.cached_input_tokens + usage.cache_write_tokens + usage.output_tokens,
      requests: usage.requests,
    };
    for (const budget of ["wall_s", "usd", "tokens", "requests"] as const) {
      const max = this.budgets[budget];
      const value = used[budget];
      if (max === undefined || value === null) continue;
      if (value * 100 >= max * pct) return { budget, used_pct: max === 0 ? 100 : Math.round((value / max) * 100) };
    }
    return undefined;
  }

  /** Why the work is unverified (a change after the last check), or undefined. */
  private async unverified(probe: "mtime" | "tools"): Promise<Record<string, unknown> | undefined> {
    if (this.lastChange !== undefined && (this.lastCheck === undefined || this.lastChange > this.lastCheck)) {
      return { by: "tools", checks: this.lastCheck === undefined ? 0 : 1 };
    }
    if (probe !== "mtime" || this.marker === undefined) return undefined;
    const marker = this.marker;
    if (!(await marker.ready)) return undefined;
    try {
      const run = await this.env.exec(probeCommand(marker.path), { timeoutMs: 15_000 });
      const files = run.output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
      return files.length > 0 ? { by: "mtime", files } : undefined;
    } catch {
      return undefined;
    }
  }

  private touchMarker(): void {
    const n = ++this.markers;
    const env = this.env;
    const path = env.scratchDir().then((dir) => `${dir}/.evidence-${n}`);
    const marker: Marker = { path: "", ready: Promise.resolve(false) };
    marker.ready = path.then(async (resolved) => {
      marker.path = resolved;
      const run = await env.exec(`touch ${shellQuote(resolved)}`, { timeoutMs: 15_000 });
      return run.exitCode === 0;
    }).catch(() => false);
    this.marker = marker;
  }

  private change(): void {
    this.lastChange = ++this.seq;
  }

  /** A finished command: its changes and checks in segment order; returns its check outcome, if it was a check. */
  private finished(facts: CommandFacts, exitCode: number | null | undefined, output: string, cmd: string): CheckRun[] {
    for (const kind of facts.kinds) {
      if (kind === "mutate") this.change();
      else if (kind === "check") this.lastCheck = ++this.seq;
    }
    if (!facts.check) return [];
    if (!facts.mutatesAfterCheck && this.loadout.policy.evidence_gate?.probe === "mtime") this.touchMarker();
    const verdict = checkOutcome(exitCode, output);
    return verdict === undefined ? [] : [{ verdict, cmd, output }];
  }

  /** D4: what kind of news a tool result is (see the header); keeps the read-only maps of still-running commands current. */
  private mechanicalKind(name: string, args: Record<string, unknown> | undefined, details: ResultDetails | undefined, isError: boolean): Mechanical {
    if (this.loadout.surface === "exec") return this.execKind(name, args, details, isError);
    if (isError) return undefined;
    if (name === "read") return "read_only";
    if (name === "bash" && typeof args?.command === "string") {
      const readOnly = readOnlyCommand(args.command);
      if (details?.handle !== undefined) {
        this.readOnlyHandles.set(details.handle, readOnly);
        return readOnly ? "read_only" : undefined;
      }
      return readOnly && details?.exitCode === 0 ? "read_only" : undefined;
    }
    if (name === "wait") {
      const handle = typeof args?.handle === "string" ? args.handle : undefined;
      // No handle: a port/file readiness wait, the step before a check. kill: a process stopped.
      if (handle === undefined) return undefined;
      if (args?.kill === true) {
        this.readOnlyHandles.delete(handle);
        return undefined;
      }
      if (details?.handle !== undefined || details?.loopExempt === true) return "poll";
      const readOnly = this.readOnlyHandles.get(handle);
      this.readOnlyHandles.delete(handle);
      return readOnly === true && details?.exitCode === 0 ? "read_only" : undefined;
    }
    return undefined;
  }

  /** D4 on the exec surface: a cell or wait is read-only when every patch, command and poll in its ledger was. */
  private execKind(name: string, args: Record<string, unknown> | undefined, details: ResultDetails | undefined, isError: boolean): Mechanical {
    if (details === undefined) return undefined;
    let readOnly = !isError && details.mutated !== true && details.failed !== true;
    let commands = 0;
    let polls = 0;
    for (const entry of details.log ?? []) {
      if (entry.kind === "mutate") {
        readOnly = false;
      } else if (entry.kind === "command") {
        commands++;
        const command = readOnlyCommand(entry.cmd);
        if (entry.session !== undefined) this.readOnlySessions.set(entry.session, command);
        if (!command || (entry.session === undefined && entry.exitCode !== 0)) readOnly = false;
      } else {
        polls++;
        if (entry.exitCode === undefined) continue; // the session is still running: a poll
        const command = this.readOnlySessions.get(entry.session);
        this.readOnlySessions.delete(entry.session);
        if (command !== true || entry.exitCode !== 0) readOnly = false;
      }
    }
    const calls = details.nested ?? {};
    if (Object.keys(calls).some((tool) => !NESTED_READS.has(tool))) readOnly = false;
    if (!readOnly) return undefined;
    if (name === "wait") {
      if (args?.terminate === true) return undefined;
      return details.running === true || details.loopExempt === true ? "poll" : "read_only";
    }
    if (name !== "exec" || details.running === true) return undefined; // a cell that yielded has work under way: the next request decides about it
    // A call the ledger has no entry for was cut off or was a stop: not a read.
    return (calls.exec_command ?? 0) <= commands && (calls.write_stdin ?? 0) <= polls ? "read_only" : undefined;
  }

  private observe(name: string, args: Record<string, unknown> | undefined, details: ResultDetails | undefined, output: string): CheckRun[] {
    if (details?.log !== undefined) {
      const outcomes: CheckRun[] = [];
      for (const entry of details.log) {
        if (entry.kind === "mutate") {
          this.change();
        } else if (entry.kind === "command") {
          const facts = classifyCommand(entry.cmd);
          if (entry.session !== undefined) {
            if (facts.check || facts.mutate) this.pendingSessions.set(entry.session, { facts, cmd: entry.cmd });
          } else {
            outcomes.push(...this.finished(facts, entry.exitCode, entry.output, entry.cmd));
          }
        } else if (entry.exitCode !== undefined) {
          const pending = this.pendingSessions.get(entry.session);
          this.pendingSessions.delete(entry.session);
          if (pending !== undefined) outcomes.push(...this.finished(pending.facts, entry.exitCode, entry.output, pending.cmd));
        }
      }
      return outcomes;
    }
    if (details?.mutated === true) {
      this.change();
      return [];
    }
    if (name === "bash" && typeof args?.command === "string") {
      const facts = classifyCommand(args.command);
      if (details?.handle !== undefined) {
        if (facts.check || facts.mutate) this.pendingHandles.set(details.handle, { facts, cmd: args.command });
        return [];
      }
      return this.finished(facts, details?.exitCode, output, args.command);
    }
    if (name === "wait" && typeof args?.handle === "string" && details?.handle === undefined) {
      const pending = this.pendingHandles.get(args.handle);
      this.pendingHandles.delete(args.handle);
      // A command the model killed was interrupted, not checked.
      if (pending === undefined || args.kill === true) return [];
      return this.finished(pending.facts, details?.exitCode, output, pending.cmd);
    }
    return [];
  }
}

const textOf = (content: readonly { type: string; text?: string }[]) => content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");

/** Line-number gutters (`read`, `cat -n`, `nl`), stripped so line-anchored failure summaries still match. */
const GUTTER = /^[ \t]*\d+\t/gmu;

/**
 * D4: whether a result the command test calls a read printed a failure
 * summary (checkOutcome's markers): in its text, or in an exec cell's ledger
 * output tails (what its nested commands printed, read or not by the cell).
 * Errs toward "red": a source file that spells a summary out costs one
 * request at the run's effort.
 */
export function readsRed(text: string, details: { log?: LedgerEntry[] } | undefined): boolean {
  const red = (output: string) => checkOutcome(0, output.replace(GUTTER, "")) === "red";
  return red(text) || (details?.log ?? []).some((entry) => entry.kind !== "mutate" && red(entry.output));
}
