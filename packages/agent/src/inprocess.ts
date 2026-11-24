// Direct in-process Harness v4 runner: runs @caveman-ai/harness HarnessSession
// directly in-process with zero external binary or daemon.
import {
  appLoadoutFor,
  appLoadouts,
  HarnessSession,
  LocalEnv,
  resolveHarnessModel,
  type GateConfig,
  type GateProvider,
  type GateRule,
  type HarnessModel,
  type HarnessStreamFn,
  type SessionEvent as HarnessSessionEvent,
} from "@caveman-ai/harness";
import type { AgentDefinition } from "./agent.ts";
import { CavemanError, ZERO_USAGE, type SessionEvent, type StopReason, type Usage } from "./types.ts";

export interface InProcessRunOptions {
  readonly agent: AgentDefinition;
  readonly task: string;
  readonly cwd?: string;
  /** Either a `"provider/model"` spec (e.g. `"anthropic/claude-sonnet-4-6"`) or a custom `HarnessModel`. */
  readonly model: string | HarnessModel;
  /** Required when passing a custom `HarnessModel`; resolved automatically for `"provider/model"` strings. */
  readonly stream?: HarnessStreamFn;
  /** Explicit API key override when `model` is a `"provider/model"` string. */
  readonly apiKey?: string;
  /** Optional provider base URL override when `model` is a `"provider/model"` string. */
  readonly baseUrl?: string;
  readonly loadout?: "general" | "code" | "claude" | "gpt";
  /** Caveman Gate configuration or provider overriding `agent.gate`. */
  readonly gate?: GateConfig;
  /** Shorthand to supply a GateProvider for gated tools declared on `agent`. */
  readonly gateProvider?: GateProvider;
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
  let model: HarnessModel;
  let stream: HarnessStreamFn;
  if (typeof options.model === "string") {
    const resolved = resolveHarnessModel(options.model, {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    });
    model = resolved.model;
    stream = options.stream ?? resolved.stream;
  } else {
    if (options.stream === undefined) {
      throw new CavemanError(
        "stream_required",
        "runInProcess requires `stream` when `model` is an object; pass a \"provider/model\" string to resolve one automatically.",
      );
    }
    model = options.model;
    stream = options.stream;
  }

  const presets = appLoadouts();
  const loadout =
    options.loadout === "claude"
      ? presets.claude
      : options.loadout === "gpt"
        ? presets.gpt
        : options.loadout === "code"
          ? presets.code
          : options.agent.computer && options.agent.computer !== "none"
            ? appLoadoutFor(model)
            : presets.general;

  const env = new LocalEnv({ cwd });
  const events: Array<SessionEvent> = [];
  let seq = 0;
  const emit = (type: SessionEvent["type"], data: any) => {
    const ev = { seq: ++seq, type, created_at: new Date().toISOString(), data } as SessionEvent;
    events.push(ev);
    options.onEvent?.(ev);
  };

  const customTools = (options.agent.tools ?? [])
    .filter((t): t is Exclude<typeof t, string> => typeof t !== "string");

  const tools = customTools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.inputSchema as any,
    execute: async (_id: string, params: any) => {
      const res = await t.call(params);
      return { content: [{ type: "text" as const, text: res.content }], details: { isError: res.isError } };
    },
  }));

  const toolGateRules: GateRule[] = customTools
    .filter((t) => t.gate !== undefined)
    .map((t) => ({
      tool: t.name,
      ...(t.gate!.action === undefined ? {} : { action: t.gate!.action }),
      ...(t.gate!.risk === undefined ? {} : { risk: t.gate!.risk }),
      ...(t.gate!.summary === undefined
        ? {}
        : {
            summary: typeof t.gate!.summary === "function"
              ? (call) => (t.gate!.summary as (input: unknown) => string)(call.args)
              : t.gate!.summary,
          }),
      ...(t.gate!.when === undefined
        ? {}
        : { when: (call) => t.gate!.when!(call.args) }),
    }));

  const baseGate = options.agent.gate;
  const overrideGate = options.gate;
  // Per-run gate rules take precedence over per-tool and agent-level rules (first match wins).
  const mergedRules: GateRule[] = [
    ...(overrideGate?.rules ?? []),
    ...toolGateRules,
    ...(baseGate?.rules ?? []),
  ];
  const mergedProvider = options.gateProvider ?? overrideGate?.provider ?? baseGate?.provider;
  const requireAll = overrideGate?.requireAll ?? baseGate?.requireAll ?? false;
  const gate: GateConfig | undefined =
    mergedRules.length > 0 || requireAll || mergedProvider !== undefined
      ? {
          ...(baseGate ?? {}),
          ...(overrideGate ?? {}),
          ...(mergedProvider === undefined ? {} : { provider: mergedProvider }),
          rules: mergedRules,
          requireAll,
        }
      : undefined;

  const session = new HarnessSession({
    env,
    loadout,
    model,
    stream,
    instructions: options.agent.instructions,
    tools,
    ...(gate === undefined ? {} : { gate }),
  });

  emit("session.status", { status: "running", stop_reason: null, model: model.id });
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
        } else if (ev.type === "gate_requested") {
          emit("gate.requested", {
            gate_id: ev.request.gateId,
            tool: ev.request.tool,
            action: ev.request.action,
            risk: ev.request.risk,
            summary: ev.request.summary,
            input: ev.request.input,
          });
        } else if (ev.type === "gate_decided") {
          emit("gate.decided", {
            gate_id: ev.request.gateId,
            ...(ev.decision.providerGateId === undefined ? {} : { provider_gate_id: ev.decision.providerGateId }),
            tool: ev.request.tool,
            status: ev.decision.status,
            ...(ev.decision.reason === undefined ? {} : { reason: ev.decision.reason }),
            ...(ev.decision.decidedBy === undefined ? {} : { decided_by: ev.decision.decidedBy }),
          });
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
    emit("session.status", { status: "terminated", stop_reason: stopReason, model: model.id });
    return { text: finalText, stop_reason: stopReason, usage, events, loadout: loadout.name };
  } finally {
    await session.close();
    await env.close();
  }
}
