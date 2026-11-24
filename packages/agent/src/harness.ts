/**
 * Direct Harness v4 entrypoint on `@caveman-ai/agent/harness`.
 *
 * Re-exports the open-source `@caveman-ai/harness` engine (`HarnessSession`,
 * model-native loadouts, `LocalEnv`, `DockerEnv`, `SandboxEnv`, MCP helpers,
 * `resolveHarnessModel`) plus `toHarnessTool()` to drop `@caveman-ai/agent`
 * `tool()` declarations straight into a `HarnessSession`.
 */
export * from "@caveman-ai/harness";
import {
  createGateHook,
  type GateProvider,
  type GateRule,
  type HarnessTool,
} from "@caveman-ai/harness";
import type { Tool } from "./tool.ts";
import { CavemanError } from "./types.ts";

export interface ToHarnessToolOptions {
  /** Human-readable label shown in traces and UIs (defaults to `definition.name`). */
  label?: string;
  /**
   * Required when `definition.gate` is set (unless `sessionGated: true` and the
   * caller passes the matching rules to `HarnessSession({ gate })`).
   */
  gateProvider?: GateProvider;
  /**
   * Set to `true` only when the caller enforces `definition.gate` via
   * `HarnessSession({ gate: { rules: gateRulesForTools(tools), provider } })`.
   */
  sessionGated?: boolean;
}

/** Convert per-tool `gate` policies on `@caveman-ai/agent` tools into `HarnessSession` `GateRule[]`. */
export function gateRulesForTools(tools: ReadonlyArray<Tool<any>>): GateRule[] {
  return tools
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
}

/**
 * Adapt a `@caveman-ai/agent` `tool()` declaration into a `HarnessTool` for `HarnessSession`.
 *
 * - Fails closed if `definition.gate` is declared without `options.gateProvider`
 *   (or `options.sessionGated: true`).
 * - Throws when `definition.call()` returns `isError: true` so Pi marks the
 *   tool result as an error for the model and `afterCall` hooks.
 */
export function toHarnessTool<I>(
  definition: Tool<I>,
  options: ToHarnessToolOptions = {},
): HarnessTool {
  let checkGate: ((call: { id: string; name: string; args: unknown }, signal: AbortSignal | undefined) => Promise<string | undefined>) | undefined;
  if (definition.gate !== undefined && options.sessionGated !== true) {
    if (options.gateProvider === undefined) {
      throw new CavemanError(
        "gate_provider_required",
        `Tool "${definition.name}" declares a Caveman Gate policy. Pass { gateProvider } to toHarnessTool(), or pass { sessionGated: true } with gateRulesForTools() on HarnessSession.`,
      );
    }
    const rules = gateRulesForTools([definition]);
    checkGate = createGateHook({ provider: options.gateProvider, rules });
  }

  return {
    name: definition.name,
    label: options.label ?? definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    execute: async (toolCallId, params, signal) => {
      if (checkGate !== undefined) {
        const refused = await checkGate({ id: toolCallId, name: definition.name, args: params }, signal);
        if (refused !== undefined) throw new Error(refused);
      }
      const res = await definition.call(params);
      if (res.isError) throw new Error(res.content);
      return {
        content: [{ type: "text", text: res.content }],
        details: { isError: false },
      };
    },
  };
}
