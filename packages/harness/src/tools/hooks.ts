/**
 * A host's hooks on the calls a program or an exec cell makes (the library session, src/session.ts). The host sees
 * each nested call start and end, so its transcript can show what a program did, and may refuse one before it runs (an
 * approval card, a PreToolUse hook). A refusal throws inside the program with the host's reason, so the model reads
 * why, and the call never runs. Without hooks (the CLI) the tools are returned as they are.
 */
import type { CodemodeTool } from "@earendil-works/pi-codemode";

export interface NestedCall {
  /** Unique within the session: `<parent tool call id>.<n>`. */
  id: string;
  /** The program or exec call that made it. */
  parentId: string;
  /** The name the program called: `bash`, `exec_command`, `apply_patch`, `<server>__<tool>`, `mcp__<server>__<tool>`. */
  name: string;
  args: unknown;
  /** Set for an MCP tool: its server and the server's own tool name. */
  mcp?: { server: string; tool: string };
}

export interface NestedHooks {
  /** A reason refuses the call (it throws in the program with that reason); undefined lets it run. */
  before?(call: NestedCall, signal: AbortSignal): Promise<string | undefined>;
  start?(call: NestedCall): void;
  end?(call: NestedCall, outcome: { result: unknown; isError: boolean }): void;
}

let sequence = 0;

/**
 * `tools` with the hooks around each call. `mcpOf` names a tool's MCP server and tool when it is one. A tool that
 * answered synchronously still answers (now as a promise, which the isolate awaits the same way).
 */
export function hookTools(
  tools: CodemodeTool[], hooks: NestedHooks | undefined, parentId: string, mcpOf: (name: string) => NestedCall["mcp"] = () => undefined,
): CodemodeTool[] {
  if (hooks === undefined) return tools;
  return tools.map((tool) => ({
    ...tool,
    async execute(raw: unknown, context: { signal: AbortSignal }) {
      const mcp = mcpOf(tool.name);
      const call: NestedCall = { id: `${parentId}.${++sequence}`, parentId, name: tool.name, args: raw, ...(mcp === undefined ? {} : { mcp }) };
      const refused = await hooks.before?.(call, context.signal);
      if (refused !== undefined) throw new Error(refused);
      hooks.start?.(call);
      try {
        const result = await tool.execute(raw as never, context as never);
        hooks.end?.(call, { result, isError: false });
        return result;
      } catch (error) {
        hooks.end?.(call, { result: error instanceof Error ? error.message : String(error), isError: true });
        throw error;
      }
    },
  }) as CodemodeTool);
}
