// Direct in-process Harness v4 runner: runs @caveman-ai/harness HarnessSession
// directly in-process with zero external binary or daemon.
import {
  appLoadouts,
  HarnessSession,
  LocalEnv,
  type HarnessModel,
  type HarnessStreamFn,
  type SessionEvent as HarnessSessionEvent,
} from "@caveman-ai/harness";
import type { AgentDefinition } from "./agent.ts";
import { ZERO_USAGE, type SessionEvent, type StopReason, type Usage } from "./types.ts";

export interface InProcessRunOptions {
  readonly agent: AgentDefinition;
  readonly task: string;
  readonly cwd?: string;
  readonly model: HarnessModel;
  readonly stream: HarnessStreamFn;
  readonly loadout?: "general" | "code" | "claude" | "gpt";
  readonly onEvent?: (event: SessionEvent) => void;
}

export interface InProcessRunResult {
  readonly text: string;
  readonly stop_reason: StopReason;
  readonly usage: Usage;
  readonly events: ReadonlyArray<SessionEvent>;
  readonly loadout: string;
}

/** Runs an AgentDefinition directly in-process on Harness v4 (zero external binary). */
export async function runInProcess(options: InProcessRunOptions): Promise<InProcessRunResult> {
  const cwd = options.cwd ?? process.cwd();
  const presets = appLoadouts();
  const loadout =
    options.loadout === "claude"
      ? presets.claude
      : options.loadout === "gpt"
        ? presets.gpt
        : options.loadout === "code"
          ? presets.code
          : options.agent.computer && options.agent.computer !== "none"
            ? presets.claude
            : presets.general;

  const env = new LocalEnv({ cwd });
  const events: Array<SessionEvent> = [];
  let seq = 0;
  const emit = (type: SessionEvent["type"], data: any) => {
    const ev = { seq: ++seq, type, created_at: new Date().toISOString(), data } as SessionEvent;
    events.push(ev);
    options.onEvent?.(ev);
  };

  const tools = (options.agent.tools ?? [])
    .filter((t): t is Exclude<typeof t, string> => typeof t !== "string")
    .map((t) => ({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.inputSchema as any,
      execute: async (_id: string, params: any) => {
        const res = await t.call(params);
        return { content: [{ type: "text" as const, text: res.content }], details: { isError: res.isError } };
      },
    }));

  const session = new HarnessSession({
    env,
    loadout,
    model: options.model,
    stream: options.stream,
    instructions: options.agent.instructions,
    tools,
  });

  emit("session.status", { status: "running", stop_reason: null, model: options.model.id });
  emit("user.message", { text: options.task, origin: "sdk" });

  try {
    const outcome = await session.runTurn(options.task, {
      onEvent: (ev: HarnessSessionEvent) => {
        if (ev.type === "pi") {
          const pe = ev.event;
          if (pe.type === "tool_execution_start") {
            emit("agent.tool_use", { id: String(pe.toolCallId ?? ""), name: String(pe.toolName ?? ""), input: pe.args ?? {} });
          } else if (pe.type === "tool_execution_end") {
            emit("agent.tool_result", { tool_use_id: String(pe.toolCallId ?? ""), is_error: Boolean(pe.isError), output: pe.result ?? "" });
          }
        }
      },
    });
    const finalText = outcome.finalText ?? "";
    if (finalText) emit("agent.message", { text: finalText });
    const usage: Usage = {
      input_tokens: outcome.usage?.input ?? ZERO_USAGE.input_tokens,
      output_tokens: outcome.usage?.output ?? ZERO_USAGE.output_tokens,
      cache_read_tokens: outcome.usage?.cacheRead ?? ZERO_USAGE.cache_read_tokens,
      cost_usd: outcome.usage?.costUsd ?? ZERO_USAGE.cost_usd,
    };
    emit("session.usage", usage);
    const stopReason: StopReason = outcome.status === "error" ? "error" : outcome.status === "stopped" ? "interrupted" : "end_turn";
    emit("session.status", { status: "terminated", stop_reason: stopReason, model: options.model.id });
    return { text: finalText, stop_reason: stopReason, usage, events, loadout: loadout.name };
  } finally {
    await session.close();
    await env.close();
  }
}
