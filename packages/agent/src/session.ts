// A session, the same on both hosts. A host gives it a transport (a child process here, the Agents API on Cloud);
// the session reads every event once, answers the agent's asks with the caller's handlers, and tells callers when
// a turn ends and when the session ends.

import { createGateHook, type GateConfig, type GateProvider, type GateRule } from "@caveman-ai/harness";
import type { Tool } from "./tool.ts";
import {
  CavemanError,
  ZERO_USAGE,
  type ApprovalAsk,
  type Ask,
  type QuestionAsk,
  type SessionEvent,
  type StopReason,
  type Usage,
  type UserEvent,
} from "./types.ts";

/** The caller's answer to one ask. */
type Reply = Extract<UserEvent, { readonly ask_id: string }>;

/** How a host carries one session. */
export interface Transport {
  readonly id: string;
  /** Every public event in order; ends when the session has ended or `close()` was called. */
  readonly events: AsyncIterable<SessionEvent>;
  /**
   * Sends a message; resolves with the id the host took it under. The host says that id on the message's user.message,
   * in the turn the message started or joined, or on the session.error that refused it. Rejects as `send` does.
   */
  message(text: string): Promise<string>;
  /**
   * Rejects with `session_ended` once the host takes no more input, or once the stream stopped before the host said
   * whether it took this: what waited on an answer ended with it.
   */
  send(event: Exclude<UserEvent, { readonly type: "user.message" }>): Promise<void>;
  /**
   * No more input: the session ends after its running turn, refusing the asks still open (here), or the stream
   * stops and the session goes on, its asks still waiting on their answers (Cloud).
   */
  close(): Promise<void>;
  /** Stop now. */
  kill(): void;
}

export type Decision = "allow" | "deny" | { readonly decision: "allow" | "deny"; readonly message?: string };

export interface AskHandlers {
  /** Custom tools' handlers, by name. */
  readonly tools?: ReadonlyArray<Tool<unknown>>;
  /** Per-session Caveman Gate overrides enforced fail-closed before running custom tool handlers (highest rule precedence). */
  readonly gate?: GateConfig;
  /** Agent-level default Caveman Gate policy (evaluated after per-session `gate` overrides and per-tool `gate` policies). */
  readonly agentGate?: GateConfig;
  /** Shorthand to supply a GateProvider for gated custom tools in this session. */
  readonly gateProvider?: GateProvider;
  /** Answers an approval. Without it, or when it throws, the approval is denied, and the agent is told why. */
  readonly canUseTool?: (ask: ApprovalAsk) => Decision | Promise<Decision>;
  /** Answers a question. Without it, or when it throws, the agent is told to decide for itself and say what it assumed. */
  readonly onQuestion?: (ask: QuestionAsk) => string | Promise<string>;
}

export interface TurnResult {
  /** The agent's last message in the turn. */
  readonly text: string;
  readonly stopReason: StopReason | null;
  /** Cumulative for the session at the turn's end. */
  readonly usage: Usage;
}

export interface SessionResult extends TurnResult {
  /** The model the session ran on, when the host said. */
  readonly model?: string;
  /** Why it failed, when it did. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** A host's refusal of one input (a bad line, an answer to an ask that is gone, a message not taken): the session goes on. */
const REFUSALS: ReadonlySet<string> = new Set(["input_invalid", "answer_refused", "message_refused"]);

const DECIDE_YOURSELF = "Decide yourself, go on, and say in your final message what you assumed.";
const NO_ONE_TO_ASK = `No one is available to answer. ${DECIDE_YOURSELF}`;

/** The answer to an ask whose handler threw: the agent reads why and goes on, as it does with a tool's error. */
function failedReply(ask: Ask, why: string): Reply {
  if (ask.kind === "tool") return { type: "user.tool_result", ask_id: ask.ask_id, content: why, is_error: true };
  if (ask.kind === "approval") {
    return { type: "user.approval", ask_id: ask.ask_id, decision: "deny", message: `Not allowed: the program that started this session could not decide (its canUseTool failed: ${why}).` };
  }
  return { type: "user.answer", ask_id: ask.ask_id, text: `The program that started this session could not answer (its onQuestion failed: ${why}). ${DECIDE_YOURSELF}` };
}

const messageOf = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));

export class Session {
  readonly id: string;
  private readonly transport: Transport;
  private readonly handlers: AskHandlers;
  private readonly log: Array<SessionEvent> = [];
  private readonly wakers = new Set<() => void>();
  private readonly turns: Array<TurnResult> = [];
  private turnsTaken = 0;
  /** The turn each of the caller's messages started or joined, by the id the host took it under, until send() reads it. */
  private readonly placed = new Map<string, number>();
  /** The caller's messages the host refused, by the id it took them under: they run in no turn. */
  private readonly refused = new Map<string, { code: string; message: string }>();
  private turnWaiters: Array<() => void> = [];
  private inTurn = false;
  private ended = false;
  /** Asks the agent still waits on: a Stop, the end of their turn and the session's end refuse them. */
  private readonly openAsks = new Set<string>();
  /** Per-ask abort controllers so pending Gate approvals cancel immediately when a turn is interrupted or ended. */
  private readonly askAborts = new Map<string, AbortController>();
  private lastText = "";
  /** The agent's last message in the turn going now: a turn that says nothing has no text, not the last turn's. */
  private turnText = "";
  private usage: Usage = ZERO_USAGE;
  private model: string | undefined;
  /** The host's error since its last stop, which the next stop keeps if that stop is a failure. */
  private failing: { code: string; message: string } | undefined;
  /** Why the turn or session that stopped last failed, by the host's word; a turn after it, or a good stop, clears it. */
  private failure: { code: string; message: string } | undefined;
  /** The session's own failure: its events stopped, or an answer could not reach the host. */
  private error: { code: string; message: string } | undefined;
  private stopReason: StopReason | null = null;
  private final: Promise<SessionResult>;

  constructor(transport: Transport, handlers: AskHandlers, options: { readonly once?: boolean } = {}) {
    this.id = transport.id;
    this.transport = transport;
    this.handlers = handlers;
    this.final = this.pump(options.once === true);
  }

  /** Every event of the session, from its start; each call replays from the beginning, then follows live. */
  async *events(): AsyncGenerator<SessionEvent> {
    let i = 0;
    for (;;) {
      while (i < this.log.length) yield this.log[i++]!;
      if (this.ended) return;
      await new Promise<void>((wake) => this.wakers.add(wake));
    }
  }

  /** Resolves when the next turn the caller hasn't taken yet ends (the first call: the task's turn). */
  async next(): Promise<TurnResult> {
    // A send() still under way has taken no turn: its message may join a turn already running (exec), be refused, or
    // be the one turn left, so passing over its turn could leave next() on one no message will start.
    return this.turnAt(this.turnsTaken++);
  }

  /**
   * Sends a message, and resolves when the turn it starts (or joins, where the host steers it into the running one)
   * ends; rejects when the host refuses it.
   */
  async send(text: string): Promise<TurnResult> {
    if (this.ended) throw new CavemanError("session_ended", "The session has ended.");
    // The host says which turn took the message: other turns (another agent's mail, the runtime's own) may come
    // first, and the turn running when it was sent may end before the host reads it.
    const index = await this.turnOf(await this.transport.message(text));
    try {
      return await this.turnAt(index);
    } finally {
      // Earlier turns the caller never took (it followed them on events()) are passed over.
      if (index !== undefined) this.turnsTaken = Math.max(this.turnsTaken, index + 1);
    }
  }

  private clearOpenAsks(reason = "Session ask cancelled"): void {
    this.openAsks.clear();
    for (const controller of this.askAborts.values()) {
      controller.abort(new Error(reason));
    }
    this.askAborts.clear();
  }

  /** Stops the running turn; the session stays open for the next message. */
  async interrupt(): Promise<void> {
    if (this.ended) return;
    this.clearOpenAsks("Session interrupted");
    await this.transport.send({ type: "user.interrupt" });
  }

  /** Resolves when the session ends. */
  result(): Promise<SessionResult> {
    return this.final;
  }

  /** Ends the session after its running turn and resolves with its result. */
  async close(): Promise<SessionResult> {
    if (!this.ended) await this.transport.close();
    return this.final;
  }

  /** Ends the session now. */
  kill(): void {
    // A Stop (Cloud) or the runtime's end (here) refuses the asks still open.
    this.clearOpenAsks("Session killed");
    this.transport.kill();
  }

  /** The turn `index` when it ends, or how the session ended when it ends first (or `index` is none). */
  private async turnAt(index: number | undefined): Promise<TurnResult> {
    while (index === undefined || this.turns[index] === undefined) {
      if (this.ended) return { text: this.turnText, stopReason: this.stopReason, usage: this.usage };
      await new Promise<void>((wake) => this.turnWaiters.push(wake));
    }
    return this.turns[index]!;
  }

  /** The turn the host put the message `input` in, once it says so; none when the session ends first. */
  private async turnOf(input: string): Promise<number | undefined> {
    for (;;) {
      const index = this.placed.get(input);
      if (index !== undefined) {
        this.placed.delete(input);
        return index;
      }
      const refusal = this.refused.get(input);
      if (refusal !== undefined) {
        this.refused.delete(input);
        throw new CavemanError(refusal.code, refusal.message);
      }
      if (this.ended) return undefined;
      await new Promise<void>((wake) => this.turnWaiters.push(wake));
    }
  }

  private wake(): void {
    for (const wake of this.wakers) wake();
    this.wakers.clear();
  }

  private wakeTurnWaiters(): void {
    const waiters = this.turnWaiters;
    this.turnWaiters = [];
    for (const wake of waiters) wake();
  }

  private endTurn(): void {
    this.turns.push({ text: this.turnText, stopReason: this.stopReason, usage: this.usage });
    this.turnText = "";
    this.clearOpenAsks("Turn ended");
    this.wakeTurnWaiters();
  }

  private async pump(once: boolean): Promise<SessionResult> {
    try {
      for await (const event of this.transport.events) {
        this.log.push(event);
        this.observe(event);
        this.wake();
        if (event.type === "session.status" && event.data.status === "idle" && once) {
          // A one-shot session ends at its first finished turn.
          await this.transport.close();
        }
        if (event.type === "session.status" && event.data.status === "terminated") break;
      }
    } catch (failure) {
      this.error ??= { code: failure instanceof CavemanError ? failure.code : "transport_failed", message: failure instanceof Error ? failure.message : String(failure) };
    } finally {
      // Handlers still at work (a person who has not answered) are not waited for. One that answers later still
      // sends: a Cloud session goes on after its stream stops, and a host whose session ended refuses the answer.
      this.ended = true;
      this.wake();
      this.wakeTurnWaiters();
    }
    const error = this.failure ?? this.error;
    return {
      text: this.lastText,
      stopReason: this.stopReason ?? (error === undefined ? "end_turn" : "error"),
      usage: this.usage,
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(error === undefined ? {} : { error }),
    };
  }

  private openTurn(): void {
    if (this.inTurn) return;
    this.inTurn = true;
    // The session went on past a failed turn: that failure is no longer why it stopped.
    this.failing = undefined;
    this.failure = undefined;
  }

  private observe(event: SessionEvent): void {
    switch (event.type) {
      case "user.message":
        // A turn's input opens it: exec says it before turn.started, and a turn it stopped before it started says only
        // this and idle. One of the caller's messages runs in the turn it opened or came into.
        this.openTurn();
        if (event.data.input_id !== undefined) {
          this.placed.set(event.data.input_id, this.turns.length);
          this.wakeTurnWaiters();
        }
        break;
      case "agent.message":
        this.lastText = event.data.text;
        this.turnText = event.data.text;
        break;
      case "session.usage":
        this.usage = event.data;
        break;
      case "session.error":
        if (event.data.input_id !== undefined) {
          this.refused.set(event.data.input_id, { code: event.data.code, message: event.data.message });
          this.wakeTurnWaiters();
        } else if (!REFUSALS.has(event.data.code)) this.failing = event.data;
        break;
      case "session.status": {
        const { status, stop_reason: stop } = event.data;
        if (event.data.model !== undefined) this.model = event.data.model;
        if (stop !== null) this.stopReason = stop;
        if (status === "running" || status === "requires_action") this.openTurn();
        else if (status === "idle" || status === "terminated") {
          // The error said before a stop is why it stopped, when it failed; a turn or session that ended well has none.
          if (stop === "error" || stop === "budget_reached") this.failure = this.failing ?? this.failure;
          else if (stop !== null) this.failure = undefined;
          this.failing = undefined;
          // An idle with no turn open ends none: Cloud says one when it parks a spent budget with nothing running.
          if (this.inTurn) {
            this.inTurn = false;
            this.endTurn();
          }
        }
        break;
      }
      case "requires_action": {
        this.openAsks.add(event.data.ask_id);
        const controller = new AbortController();
        this.askAborts.set(event.data.ask_id, controller);
        void this.answer(event.data, controller.signal);
        break;
      }
      default:
        break;
    }
  }

  /** Answers an ask whatever its handler does, so the agent never waits on one that will not come. */
  private async answer(ask: Ask, signal: AbortSignal): Promise<void> {
    let reply: Reply;
    try {
      reply = await this.replyTo(ask, signal).catch((failure: unknown) => failedReply(ask, messageOf(failure)));
    } finally {
      this.askAborts.delete(ask.ask_id);
    }
    // Refused while the handler decided: the host would refuse the answer.
    if (signal.aborted || !this.openAsks.delete(ask.ask_id)) return;
    try {
      await this.transport.send(reply);
    } catch (failure) {
      if (failure instanceof CavemanError && failure.code === "session_ended") return;
      // The ask stays open and nothing else will answer it: end the session, saying why, rather than leave it waiting.
      this.error ??= { code: "answer_failed", message: messageOf(failure) };
      this.transport.kill();
    }
  }

  private async replyTo(ask: Ask, signal: AbortSignal): Promise<Reply> {
    if (ask.kind === "tool") {
      const handler = this.handlers.tools?.find((item) => item.name === ask.name);
      if (ask.truncated === true) {
        return {
          type: "user.tool_result",
          ask_id: ask.ask_id,
          content: `${ask.name} did not run: its input was too large to reach the program that started this session, and arrived cut. Send less in one call.`,
          is_error: true,
        };
      }
      if (handler === undefined) {
        return {
          type: "user.tool_result",
          ask_id: ask.ask_id,
          content: `No handler for the tool ${ask.name} in the program that started this session.`,
          is_error: true,
        };
      }
      // Enforce fail-closed Caveman Gate on SDK-executed tool handlers whenever either
      // the tool declares a `gate` policy or session/agent gate rules apply.
      // Precedence matches runInProcess: per-session override -> per-tool -> agent default.
      const override = this.handlers.gate;
      const agentDefault = this.handlers.agentGate;
      if (handler.gate !== undefined || override !== undefined || agentDefault !== undefined) {
        const toolRule: GateRule | undefined = handler.gate === undefined
          ? undefined
          : {
              tool: handler.name,
              ...(handler.gate.action === undefined ? {} : { action: handler.gate.action }),
              ...(handler.gate.risk === undefined ? {} : { risk: handler.gate.risk }),
              ...(handler.gate.summary === undefined
                ? {}
                : {
                    summary: typeof handler.gate.summary === "function"
                      ? (call) => (handler.gate!.summary as (input: unknown) => string)(call.args)
                      : handler.gate.summary,
                  }),
              ...(handler.gate.when === undefined ? {} : { when: (call) => handler.gate!.when!(call.args) }),
            };
        const provider = this.handlers.gateProvider ?? override?.provider ?? agentDefault?.provider;
        const requireAll = override?.requireAll ?? agentDefault?.requireAll ?? false;
        const gateHook = createGateHook({
          ...(agentDefault ?? {}),
          ...(override ?? {}),
          ...(provider === undefined ? {} : { provider }),
          requireAll,
          sessionId: override?.sessionId ?? agentDefault?.sessionId ?? this.id,
          rules: [
            ...(override?.rules ?? []),
            ...(toolRule === undefined ? [] : [toolRule]),
            ...(agentDefault?.rules ?? []),
          ],
        });
        const refused = await gateHook({ id: ask.ask_id, name: ask.name, args: ask.input }, signal);
        if (refused !== undefined) {
          return { type: "user.tool_result", ask_id: ask.ask_id, content: refused, is_error: true };
        }
      }
      // Recheck ask liveness immediately before running side-effecting tool code so a
      // late approval after interrupt()/kill()/turn-end can never execute the tool.
      if (signal.aborted || !this.openAsks.has(ask.ask_id)) {
        return { type: "user.tool_result", ask_id: ask.ask_id, content: "Tool call cancelled before execution.", is_error: true };
      }
      const { content, isError } = await handler.call(ask.input);
      return { type: "user.tool_result", ask_id: ask.ask_id, content, is_error: isError };
    }
    if (ask.kind === "approval") {
      const decided = this.handlers.canUseTool === undefined
        ? { decision: "deny" as const, message: "Not allowed: the program that started this session approves nothing (it passed no canUseTool)." }
        : await this.handlers.canUseTool(ask);
      const { decision, message } = typeof decided === "string" ? { decision: decided, message: undefined } : decided;
      return { type: "user.approval", ask_id: ask.ask_id, decision, ...(message === undefined ? {} : { message }) };
    }
    const text = this.handlers.onQuestion === undefined ? NO_ONE_TO_ASK : await this.handlers.onQuestion(ask);
    return { type: "user.answer", ask_id: ask.ask_id, text };
  }
}
