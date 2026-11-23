export type AgentStatus = "idle" | "streaming" | "complete" | "error" | "detached";

export interface AgentToolCall {
  readonly id: string;
  readonly name: string;
  /** Truncated argument summary as sent on the wire, not the full arguments. */
  readonly args: string;
  readonly status: "running" | "completed" | "failed";
  readonly detail: string;
}

export interface AgentUsage {
  readonly in: number;
  readonly out: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** Null when any message in the turn was unpriced: the total is unknown, not zero. */
  readonly costUsd: number | null;
}

export interface AgentError {
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentGap {
  readonly error: "cave_serve_events_gap";
  /** The sequence this client asked to resume from. */
  readonly requestedSeq: number;
  /** The oldest sequence the server still held. Everything between is lost. */
  readonly earliestSeq: number;
}

export interface AgentState {
  readonly status: AgentStatus;
  readonly text: string;
  readonly thinking: string;
  readonly tools: readonly AgentToolCall[];
  readonly usage: AgentUsage | null;
  readonly route: { readonly model: string; readonly reason: string } | null;
  readonly stopReason: string | null;
  readonly error: AgentError | null;
  /** Set when the server could not replay a span this client missed. */
  readonly gap: AgentGap | null;
}

export declare const INITIAL_STATE: AgentState;

export interface SessionGap {
  /** The sequence this client asked to resume from. */
  readonly requestedSeq: number;
  /** The oldest sequence the server still held. Everything between is lost. */
  readonly earliestSeq: number;
}

export interface SessionState {
  readonly events: readonly ({ kind: string } & Record<string, any>)[];
  readonly status: SessionStatus;
  /**
   * History before this point was evicted from the server's bounded window.
   * The transcript is complete from here: the server sends the whole retained
   * window after the gap and keeps streaming. Not an error.
   */
  readonly gap: boolean;
  readonly lastGap: SessionGap | null;
}

export type SessionStatus = "connecting" | "streaming" | "complete" | "error" | "cancelled";

export declare const SESSION_INITIAL_STATE: SessionState;

/**
 * Append one Pebble frame and derive multi-run session status. Pure.
 *
 * A server gap notice (`{ error: "cave_serve_events_gap", … }`) is recorded on
 * `gap`/`lastGap` and never appended to `events`.
 */
export declare function reduceSessionEvent(
  state: SessionState,
  event: ({ kind: string } | { error: "cave_serve_events_gap" }) & Record<string, any>,
): SessionState;

/** Fold one Pebble v1 `TurnEvent` into agent state. Pure. */
export declare function reduceAgentEvent(state: AgentState, event: { kind: string } & Record<string, any>): AgentState;

export interface UseAgentOptions {
  /**
   * Same-origin base path your app serves, e.g. `/api/agent`. It must proxy
   * `POST /runs` and `GET /runs/:id/events` to the agent server with the bearer
   * token attached. There is deliberately no token option: that credential
   * spends money and must not reach the browser.
   */
  readonly api: string;
}

export interface UseAgentResult extends AgentState {
  readonly runId: string | null;
  /** Submit one run. Resolves with its id as soon as the server accepts it. */
  submit(input: string): Promise<string>;
  /**
   * Attach to a run this hook did not submit — after a reload, or from another
   * tab. The server replays the run's events from the beginning, so this
   * rebuilds the same state an uninterrupted stream would have produced.
   *
   * The server's event window is bounded and in-memory. A run that settled long
   * ago, or one whose events an instance restart discarded, has no stream left
   * to attach to and surfaces as a closed stream; `GET /runs/:id` is the record.
   */
  watch(runId: string): void;
  /**
   * Stop watching without cancelling. `DELETE /runs/:id` exists; this method
   * deliberately does not call it. Reattach with `watch`.
   */
  stopWatching(): void;
}

export declare function useAgent(options: UseAgentOptions): UseAgentResult;

export interface UseSessionOptions {
  /**
   * Same-origin base path your app serves, e.g. `/api/agent`. It must proxy
   * `GET /sessions/:id/events` (or the `/ws` upgrade), `POST
   * /sessions/:id/messages`, and `DELETE /sessions/:id` to the agent server
   * with the bearer token attached. There is deliberately no token option: that
   * credential spends money and must not reach the browser.
   */
  readonly api: string;
  readonly sessionId: string;
  readonly transport?: "sse" | "ws";
}

export interface SessionSendOptions {
  readonly author?: string;
  readonly mode?: "followUp" | "steer";
}

export interface UseSessionResult {
  readonly events: SessionState["events"];
  send(
    text: string,
    options?: SessionSendOptions,
  ): Promise<{ readonly runId: string; readonly queued: boolean } | undefined>;
  /** Cancel the active run, drop the queue, and stop reconnecting. */
  cancel(): Promise<void>;
  readonly status: SessionStatus;
  readonly gap: SessionState["gap"];
  readonly lastGap: SessionState["lastGap"];
}

export declare function useSession(options: UseSessionOptions): UseSessionResult;
