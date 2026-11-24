// The session schema both hosts share: what goes in (the `user.*` events) and what comes out (the public events),
// as the Agents API fixes them (docs/ §3.3-§3.5) and the runtime's one mapper
// emits them (packages/runtime/src/cloudLink/publicEvents.ts). Wire objects keep their wire names.

export type SessionStatus = "starting" | "running" | "requires_action" | "idle" | "terminated";
export type StopReason = "end_turn" | "requires_action" | "budget_reached" | "error" | "interrupted";

/** Cumulative for a session. `cost_usd` is measured from the provider's own usage at list prices. */
export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cost_usd: number;
}

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 };

/** The agent called a tool the caller declared; the caller's handler answers it. */
export interface ToolAsk {
  readonly ask_id: string;
  readonly kind: "tool";
  readonly name: string;
  readonly input: unknown;
  /** The input was too large for the host to carry whole and arrived cut, or without it: its handler does not run. */
  readonly truncated?: boolean;
}

/** The agent wants to do something its access asks about first. */
export interface ApprovalAsk {
  readonly ask_id: string;
  readonly kind: "approval";
  readonly question?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly options?: ReadonlyArray<string>;
}

/** The agent asked a question. */
export interface QuestionAsk {
  readonly ask_id: string;
  readonly kind: "question";
  readonly question: string;
  readonly options?: ReadonlyArray<string>;
}

export type Ask = ToolAsk | ApprovalAsk | QuestionAsk;

interface Event<T extends string, D> {
  readonly seq: number;
  readonly type: T;
  readonly created_at: string;
  readonly data: D;
}

export type GateRisk = "low" | "medium" | "high" | "critical";
export type GateStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export type SensorSourceKind =
  | "http_poll"
  | "webhook"
  | "rss"
  | "github"
  | "slack"
  | "linear"
  | "gmail"
  | "drive"
  | "room";

/** Declarative Caveman Sensor specification attached to an agent or durable park. */
export interface SensorSpec {
  readonly id?: string;
  readonly name: string;
  readonly kind: SensorSourceKind;
  readonly url?: string;
  readonly interval?: string;
  readonly filter?: string;
  readonly match?: Readonly<Record<string, unknown>>;
}

/** A public session event. New types may appear; code that switches on `type` should ignore ones it doesn't know. */
export type SessionEvent =
  | Event<"session.status", { readonly status: SessionStatus; readonly stop_reason: StopReason | null; readonly model?: string }>
  /** `input_id`: one of the caller's own messages, by the id its host took it under. */
  | Event<"user.message", { readonly text: string; readonly origin: string; readonly input_id?: string }>
  | Event<"agent.message", { readonly text: string }>
  | Event<"agent.thinking", { readonly text: string }>
  | Event<"agent.tool_use", { readonly id: string; readonly name: string; readonly input: unknown; readonly truncated?: boolean }>
  | Event<"agent.tool_result", { readonly tool_use_id: string; readonly is_error: boolean; readonly output: unknown; readonly truncated?: boolean }>
  | Event<"requires_action", Ask>
  | Event<"gate.requested", { readonly gate_id: string; readonly tool: string; readonly action: string; readonly risk?: GateRisk; readonly summary?: string; readonly input?: unknown }>
  | Event<"gate.decided", { readonly gate_id: string; readonly tool: string; readonly status: Exclude<GateStatus, "pending">; readonly reason?: string; readonly decided_by?: string }>
  | Event<"sensor.parked", { readonly sensor_ids: ReadonlyArray<string>; readonly reason?: string; readonly exit_code: 5 }>
  | Event<"sensor.triggered", { readonly sensor_id: string; readonly event_id?: string; readonly payload?: unknown }>
  | Event<"agent.subagent", { readonly workspace_id: string | null; readonly title: string; readonly status: string }>
  | Event<"session.usage", Usage>
  | Event<"session.output", { readonly file_id: string; readonly path: string; readonly bytes: number }>
  /** `input_id`: the host refused that one message of the caller's, which runs in no turn. */
  | Event<"session.error", { readonly code: string; readonly message: string; readonly input_id?: string }>
  | Event<"pull_request", { readonly url: string; readonly state: string }>
  | Event<"automation.step", Readonly<Record<string, unknown>>>;

/** What a caller sends into a running session (CONTRACT §3.3, less the HTTP-only `request_id`). */
export type UserEvent =
  | { readonly type: "user.message"; readonly text: string }
  | { readonly type: "user.interrupt" }
  | { readonly type: "user.approval"; readonly ask_id: string; readonly decision: "allow" | "deny"; readonly message?: string }
  | { readonly type: "user.answer"; readonly ask_id: string; readonly text: string }
  | { readonly type: "user.tool_result"; readonly ask_id: string; readonly content: string; readonly is_error: boolean };

/** A failure the SDK reports, with a stable code. */
export class CavemanError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CavemanError";
    this.code = code;
  }
}
