/**
 * What a host adds to a coding agent: ordered instruction sections, explicit
 * MCP servers, and the Caveman engine levers. The SDK still never discovers
 * workspace files: a host reads AGENTS.md or CLAUDE.md itself and passes text.
 */
import { McpHost, type McpHostOptions, type McpServerEntry } from "./mcp.js";
import type { ProgrammaticToolRuntime } from "./programmatic-tools.js";

export interface CodingInstructionSection {
  /** One line naming the source, for example `AGENTS.md`, `Project instructions`, `Memory`. */
  readonly title: string;
  readonly text: string;
}

/**
 * Sections render in the host's order after everything the SDK writes, so the
 * SDK part of the prefix never moves. Any change to a section changes the
 * prompt prefix: put the most stable first (repository instructions) and the
 * most volatile last (a memory brief). Empty sections are left out.
 */
export function renderCodingInstructionSections(
  sections: readonly CodingInstructionSection[],
): string | undefined {
  if (!Array.isArray(sections)) throw new Error("coding_instruction_sections_invalid");
  const rendered = sections.flatMap((section: CodingInstructionSection) => {
    if (typeof section?.title !== "string" || typeof section.text !== "string") {
      throw new Error("coding_instruction_section_invalid");
    }
    const title = section.title.trim();
    if (title === "" || /[\r\n]/.test(title)) throw new Error("coding_instruction_section_title_invalid");
    const text = section.text.trim();
    return text === "" ? [] : [`# ${title}\n\n${text}`];
  });
  return rendered.length === 0 ? undefined : rendered.join("\n\n");
}

/**
 * One switchboard for the Caveman engine levers, so a benchmark arm flips
 * fields, not code. Levers act only when the session runs the engine
 * (`cave: "local"` or a gateway); engine off is the session's `cave: "off"`.
 * No lever is on by default unless measured not worse per solved task.
 */
export interface CodingLevers {
  /**
   * `bound` (default): the engine sees only a tool output that overran its
   * cap, and reads all of it instead of a blind cut; everything else reaches
   * the model as it is. `all`: tool results over 8 KiB and history as well.
   * `cave_retrieve` returns the original either way.
   */
  readonly compression?: "bound" | "all";
  /** Keep: compression keeps the lines relevant to the user's ask. Default true. */
  readonly keep?: boolean;
}

export type ResolvedCodingLevers = Readonly<Required<CodingLevers>>;

export function resolveCodingLevers(levers: CodingLevers = {}): ResolvedCodingLevers {
  const compression = levers.compression ?? "bound";
  if (compression !== "bound" && compression !== "all") throw new Error(`coding_levers_compression_invalid:${String(compression)}`);
  const keep = levers.keep ?? true;
  if (typeof keep !== "boolean") throw new Error("coding_levers_keep_invalid");
  return Object.freeze({ compression, keep });
}

/** MCP servers a host launches explicitly; their tools are callable only inside the code tool. */
export interface CodingMcpOptions extends Omit<McpHostOptions, "servers" | "cwd" | "register"> {
  /** Stdio or streamable HTTP entries; HTTP takes `headers` (a bearer token goes in `Authorization`). */
  readonly servers: readonly McpServerEntry[];
}

/** Register server tools into the code tool, gate cells on connecting servers, and start connecting. */
export function attachCodingMcp(
  runtime: ProgrammaticToolRuntime,
  options: CodingMcpOptions,
  workspace: string,
): McpHost {
  const host = new McpHost({
    ...options,
    cwd: workspace,
    register: (tools, namespace) => runtime.registerNestedTools(tools, namespace),
  });
  runtime.setCellGate((code, signal) => host.waitForCell(code, signal));
  host.start();
  return host;
}
