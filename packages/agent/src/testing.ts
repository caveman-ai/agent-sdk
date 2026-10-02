/**
 * The two-piece test kit every test in this repo was hand-rolling: a model
 * that costs nothing to call, and a stream that answers from a script.
 *
 * Neither talks to a provider, and neither is wired into the runtime — they
 * are values you pass to `run()`/`stream()` as `model` and `streamFn`:
 *
 * ```ts
 * import { fauxModel, scriptedStream } from "@caveman-ai/agent/testing";
 *
 * const result = await run(myAgent, "go", {
 *   model: fauxModel(),
 *   streamFn: scriptedStream([
 *     { toolCalls: [{ name: "poll", args: {} }] },
 *     { text: "done", usage: { input: 120, output: 8 } },
 *   ]),
 * });
 * ```
 *
 * A run driven by a `streamFn` is always billed `observe-only`: this process
 * produced the turn, so nothing about it can be claimed as optimized.
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type JsonObject,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** A cataloged, priced id, so a USD budget has something honest to meter. */
const PRICED_MODEL_ID = "claude-haiku-4-5";

export interface FauxModelOptions {
  readonly provider?: string;
  readonly id?: string;
  /**
   * Use a model id that exists in the public pricing catalog. Off by default,
   * because an uncataloged model is what proves a USD budget fails closed.
   */
  readonly priced?: boolean;
}

/** A model handle that never reaches a provider. */
export function fauxModel(options: FauxModelOptions = {}): Model<Api> {
  const handle = fauxProvider({ provider: options.provider ?? "anthropic" });
  const id = options.id ?? (options.priced === true ? PRICED_MODEL_ID : undefined);
  return {
    ...handle.getModel(),
    ...(id === undefined ? {} : { id }),
    contextWindow: 200_000,
    maxTokens: 4_000,
  };
}

export interface ScriptedTurn {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<{ readonly name: string; readonly args: unknown }>;
  readonly usage?: Partial<Usage>;
}

function scriptedUsage(partial: Partial<Usage> | undefined): Usage {
  const input = partial?.input ?? 100;
  const output = partial?.output ?? 10;
  const cacheRead = partial?.cacheRead ?? 0;
  const cacheWrite = partial?.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: partial?.reasoning ?? 0,
    totalTokens: partial?.totalTokens ?? input + output + cacheRead + cacheWrite,
    cost: partial?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * A {@link StreamFn} that answers each provider call with the next scripted
 * turn. A turn with tool calls stops with `toolUse`, so the agent loop runs
 * the tools and comes back for the next one.
 *
 * The script running out is an error, not an empty answer: a test that made
 * one more call than it scripted has found something, and silently inventing
 * a turn would hide it.
 */
export function scriptedStream(
  turns: ReadonlyArray<ScriptedTurn>,
  /** Clock for message timestamps; fix it when a test asserts exact bytes. */
  options: { readonly now?: () => number } = {},
): StreamFn {
  const now = options.now ?? Date.now;
  let call = 0;
  return (selected) => {
    const turn = turns[call];
    call += 1;
    if (turn === undefined) {
      throw new Error(
        `cave_testing_script_exhausted: scripted stream has ${turns.length} turn(s); call ${call} asked for another`,
      );
    }
    const content = [
      ...(turn.text === undefined ? [] : [{ type: "text" as const, text: turn.text }]),
      ...(turn.toolCalls ?? []).map((toolCall, index) => ({
        type: "toolCall" as const,
        id: `scripted-${call}-${index}`,
        name: toolCall.name,
        arguments: (toolCall.args ?? {}) as JsonObject,
      })),
    ];
    const stopReason = (turn.toolCalls ?? []).length > 0 ? "toolUse" as const : "stop" as const;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content,
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      usage: scriptedUsage(turn.usage),
      stopReason,
      timestamp: now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
      stream.push({ type: "done", reason: stopReason, message });
      stream.end(message);
    });
    return stream;
  };
}
