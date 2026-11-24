/**
 * Direct Harness v4 entrypoint on `@caveman-ai/agent/harness`.
 *
 * Re-exports the open-source `@caveman-ai/harness` engine (`HarnessSession`,
 * model-native loadouts, `LocalEnv`, `DockerEnv`, `SandboxEnv`, MCP helpers,
 * `resolveHarnessModel`) plus `toHarnessTool()` to drop `@caveman-ai/agent`
 * `tool()` declarations straight into a `HarnessSession`.
 */
export * from "@caveman-ai/harness";
import type { HarnessTool } from "@caveman-ai/harness";
import type { Tool } from "./tool.ts";

export interface ToHarnessToolOptions {
  /** Human-readable label shown in traces and UIs (defaults to `definition.name`). */
  label?: string;
}

/** Adapt a `@caveman-ai/agent` `tool()` declaration into a `HarnessTool` for `HarnessSession`. */
export function toHarnessTool<I>(
  definition: Tool<I>,
  options: ToHarnessToolOptions = {},
): HarnessTool {
  return {
    name: definition.name,
    label: options.label ?? definition.name,
    description: definition.description,
    parameters: definition.inputSchema,
    execute: async (_id, params) => {
      const res = await definition.call(params);
      return {
        content: [{ type: "text", text: res.content }],
        details: { isError: res.isError },
      };
    },
  };
}
