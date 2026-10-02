import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  PROTOCOL_VERSION,
  type StopReason,
  type TurnEvent,
} from "@pebble-agent/protocol";
import { catalogCost } from "./catalog.js";
import type { CavemanRunEvent, RunResult } from "./runtime.js";

type EventPayload = TurnEvent extends infer Event
  ? Event extends TurnEvent
    ? Omit<Event, "v" | "seq" | "ts" | "sessionId">
    : never
  : never;

function shortJson(value: unknown, max = 240): string {
  let rendered: string;
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = "[unserializable]";
  }
  return rendered.length <= max ? rendered : `${rendered.slice(0, max - 1)}…`;
}

function resultText(result: unknown): string | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
  return parts.length === 0 ? undefined : shortJson(parts.join("\n"));
}

function assistantUsage(message: AssistantMessage): EventPayload | undefined {
  const usage = message.usage;
  if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite]
    .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return undefined;
  }
  const cost = catalogCost({
    provider: message.provider,
    model: message.model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    reasoningTokens: usage.reasoning ?? 0,
  }, new Date(message.timestamp));
  return {
    kind: "usage",
    usage: {
      in: usage.input,
      out: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      costUsd: cost.priced ? cost.usd : null,
      model: message.model,
    },
  };
}

export function protocolStopReason(result: RunResult): StopReason {
  switch (result.stopReason) {
    case "complete":
      return "end_turn";
    case "budget_exhausted":
    case "wallet_revoked":
      return "budget_paused";
    case "deadline":
    case "loop_detected":
    case "no_progress":
    case "call_budget_exhausted":
      return "interrupted";
    default: {
      const unreachable: never = result.stopReason;
      throw new Error(`cave_pebble_stop_reason_unknown:${unreachable}`);
    }
  }
}

/** Sequence-owning adapter from Pi/runtime events to frozen Pebble v1 events. */
export class PebbleEventEncoder {
  private seq = 0;

  constructor(readonly sessionId: string, private readonly now = () => new Date()) {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("cave_pebble_session_id_required");
    }
  }

  event(payload: EventPayload): TurnEvent {
    return {
      v: PROTOCOL_VERSION,
      seq: this.seq++,
      ts: this.now().toISOString(),
      sessionId: this.sessionId,
      ...payload,
    } as TurnEvent;
  }

  nestedToolStart(id: string, name: string, args: unknown): TurnEvent {
    return this.event({
      kind: "tool.start",
      id,
      name,
      argsSummary: shortJson(args),
    });
  }

  nestedToolEnd(id: string, isError: boolean, result: unknown): TurnEvent {
    return this.event({
      kind: "tool.end",
      id,
      status: isError ? "failed" : "completed",
      detail: shortJson(result),
    });
  }

  pi(event: AgentEvent): TurnEvent[] {
    switch (event.type) {
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          return [this.event({ kind: "delta.text", text: update.delta })];
        }
        if (update.type === "thinking_delta") {
          return [this.event({ kind: "delta.thinking", text: update.delta })];
        }
        return [];
      }
      case "message_end": {
        if (event.message.role !== "assistant") return [];
        const usage = assistantUsage(event.message);
        return usage === undefined ? [] : [this.event(usage)];
      }
      case "tool_execution_start":
        return [this.nestedToolStart(event.toolCallId, event.toolName, event.args)];
      case "tool_execution_update":
        return [this.event({
          kind: "tool.update",
          id: event.toolCallId,
          delta: resultText(event.partialResult) ?? shortJson(event.partialResult),
        })];
      case "tool_execution_end": {
        const detail = resultText(event.result);
        return [this.event({
          kind: "tool.end",
          id: event.toolCallId,
          status: event.isError ? "failed" : "completed",
          ...(detail === undefined ? {} : { detail }),
        })];
      }
      default:
        return [];
    }
  }

  terminal(event: Extract<CavemanRunEvent, { type: "run_end" | "run_error" }>): TurnEvent[] {
    if (event.type === "run_error") {
      return [
        this.event({ kind: "error", message: `${event.code}: ${event.message}`, retryable: false }),
        this.event({ kind: "turn.end", stopReason: "error" }),
      ];
    }
    return [this.event({ kind: "turn.end", stopReason: protocolStopReason(event.result) })];
  }
}

/**
 * The mechanical `CavemanRunEvent` → Pebble mapping, with no policy in it.
 *
 * Callers that need policy (retry, degrade, session bookkeeping) inspect the
 * run event themselves and still encode through here, so the wire shape has
 * exactly one definition no matter which surface emits it.
 */
export function encodeRunEvent(
  encoder: PebbleEventEncoder,
  event: CavemanRunEvent,
): TurnEvent[] {
  switch (event.type) {
    case "pi":
      return encoder.pi(event.event);
    case "nested_tool_start":
      return [encoder.nestedToolStart(event.id, event.name, event.args)];
    case "nested_tool_end":
      return [encoder.nestedToolEnd(event.id, event.isError, event.result)];
    case "model_route":
      return [encoder.event({
        kind: "route.decided",
        model: event.decision.model,
        reason: event.decision.reason,
        signals: [...event.decision.signals],
      })];
    case "cache_warm":
      // Spend between turns: a usage frame, so live cost includes it.
      return [encoder.event({
        kind: "usage",
        usage: {
          in: event.call.inputTokens,
          out: event.call.outputTokens,
          cacheRead: event.call.cacheReadTokens,
          cacheWrite: event.call.cacheWriteTokens,
          costUsd: event.call.unpriced ? null : event.call.estimatedUsd,
          model: event.call.model,
        },
      })];
    case "run_end":
    case "run_error":
      return encoder.terminal(event);
    default:
      return [];
  }
}
