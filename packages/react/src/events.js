/**
 * How a Caveman agent's Pebble v1 event stream becomes render state.
 *
 * Kept free of React so it can be tested without a renderer, and reused by an
 * app driving its own transport. It invents no fields and reports what it does
 * not know as unknown rather than as zero.
 */

/** Nothing has been submitted yet. */
export const INITIAL_STATE = Object.freeze({
  status: "idle",
  text: "",
  thinking: "",
  tools: [],
  usage: null,
  route: null,
  stopReason: null,
  error: null,
  /** Set when the server could not replay a span this client missed. */
  gap: null,
});

/** Raw multi-run session transcript consumed by useSession. */
export const SESSION_INITIAL_STATE = Object.freeze({
  events: [],
  status: "connecting",
  /** True once the server reported history before this point was evicted. */
  gap: false,
  lastGap: null,
});

/** Append one Pebble frame while deriving only transport-level session status. */
export function reduceSessionEvent(state, event) {
  // Not a Pebble frame: the server saying the span this client asked to resume
  // from had already fallen out of its bounded window. It then sends the whole
  // retained window and keeps streaming, so the transcript is complete from
  // here — a marked hole above, not a dead session. Never appended to `events`.
  if (event.error === "cave_serve_events_gap") {
    return {
      ...state,
      gap: true,
      lastGap: { requestedSeq: event.requestedSeq, earliestSeq: event.earliestSeq },
    };
  }
  const events = [...state.events, event];
  if (event.kind === "turn.start") return { ...state, events, status: "streaming" };
  if (event.kind === "turn.end") {
    return { ...state, events, status: event.stopReason === "error" ? "error" : "complete" };
  }
  return { ...state, events };
}

/**
 * Fold one Pebble event into agent state.
 *
 * Pure and exported so the reducer can be tested without a renderer, and so an
 * app driving its own transport can reuse the exact same interpretation.
 */
export function reduceAgentEvent(state, event) {
  switch (event.kind) {
    case "turn.start":
      return { ...INITIAL_STATE, status: "streaming" };
    case "delta.text":
      return { ...state, text: state.text + event.text };
    case "delta.thinking":
      return { ...state, thinking: state.thinking + event.text };
    case "tool.start":
      return {
        ...state,
        tools: [
          ...state.tools,
          { id: event.id, name: event.name, args: event.argsSummary, status: "running", detail: "" },
        ],
      };
    case "tool.update":
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.id === event.id ? { ...tool, detail: tool.detail + event.delta } : tool),
      };
    case "tool.end":
      return {
        ...state,
        tools: state.tools.map((tool) =>
          tool.id === event.id
            ? { ...tool, status: event.status, detail: event.detail ?? tool.detail }
            : tool),
      };
    case "usage":
      return { ...state, usage: addUsage(state.usage, event.usage) };
    case "route.decided":
      return { ...state, route: { model: event.model, reason: event.reason } };
    case "error":
      // Held, not thrown: a turn.end always follows, and it decides the status.
      return { ...state, error: { message: event.message, retryable: event.retryable } };
    case "turn.end":
      return {
        ...state,
        status: event.stopReason === "error" ? "error" : "complete",
        stopReason: event.stopReason,
      };
    default:
      // An event kind this version does not model is ignored, not guessed at.
      return state;
  }
}

/**
 * Running total across a turn's assistant messages.
 *
 * `costUsd` is null the moment any message is unpriced, and stays null. A run
 * that is partly unpriced has an unknown cost, and reporting the priced part as
 * if it were the total would understate real spend.
 */
function addUsage(total, next) {
  const base = total ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  return {
    in: base.in + next.in,
    out: base.out + next.out,
    cacheRead: base.cacheRead + next.cacheRead,
    cacheWrite: base.cacheWrite + next.cacheWrite,
    costUsd: base.costUsd === null || next.costUsd === null
      ? null
      : base.costUsd + next.costUsd,
  };
}
