// An agent defined in code is written as an agent file, the one canonical form the runtime's agent loader reads
// (`.caveman/agents/<name>.md`: frontmatter, then instructions). So there is one validator, and an inline agent can
// be saved to a repository or published to Cloud unchanged.

import type { Tool } from "./tool.ts";
import { CavemanError } from "./types.ts";

export type Computer = "none" | "readonly" | "full";

export interface AgentDefinition {
  /** Its name in the file; also its name when published to Cloud. Default "agent". */
  readonly name?: string;
  readonly description?: string;
  /** The agent's instructions: its system prompt when it runs with no workspace. */
  readonly instructions: string;
  /** A class (`fast`, `base`, `frontier`, `auto`) or a model id. A session's `model` wins. */
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh";
  /**
   * What it may touch. `none` (the default for an agent defined in code): only the tools you give it, the lean
   * shape, with no coding prompt and no shell or file tools. `readonly` or `full`: the coding engine on the
   * session's directory, every coding lever on.
   */
  readonly computer?: Computer;
  /** Tools it may call: tools made with `tool()` run in this process; names allow built-in tools. */
  readonly tools?: ReadonlyArray<Tool<never> | Tool<unknown> | string>;
  readonly disallowedTools?: ReadonlyArray<string>;
}

const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** JSON is YAML: every value is written as JSON, so nothing in it can break the frontmatter. */
const line = (key: string, value: unknown): string => `${key}: ${JSON.stringify(value)}`;

/** The agent file text for `definition`: the same bytes for the same definition, so its cache prefix holds. */
export function agentFileText(definition: AgentDefinition): string {
  const name = definition.name ?? "agent";
  if (!AGENT_NAME.test(name)) {
    throw new CavemanError("agent_name_invalid", `Agent name "${name}" must be lowercase letters, digits and -, start with a letter, at most 40.`);
  }
  if (definition.instructions.trim() === "") throw new CavemanError("agent_instructions_missing", `Agent "${name}" needs instructions.`);
  const tools = (definition.tools ?? []).map((entry) =>
    typeof entry === "string" ? entry : { type: "custom", name: entry.name, description: entry.description, input_schema: entry.inputSchema },
  );
  const names = tools.map((entry) => (typeof entry === "string" ? entry : entry.name));
  const twice = names.find((item, i) => names.indexOf(item) !== i);
  if (twice !== undefined) throw new CavemanError("tool_declared_twice", `Agent "${name}" declares the tool "${twice}" twice.`);
  const front = [
    line("name", name),
    line("description", definition.description ?? name),
    line("engine", "caveman"),
    ...(definition.model === undefined ? [] : [line("model", definition.model)]),
    ...(definition.effort === undefined ? [] : [line("effort", definition.effort)]),
    line("computer", definition.computer ?? "none"),
    ...(tools.length === 0 ? [] : [line("tools", tools)]),
    ...(definition.disallowedTools === undefined ? [] : [line("disallowedTools", definition.disallowedTools)]),
  ];
  return `---\n${front.join("\n")}\n---\n\n${definition.instructions.trim()}\n`;
}

/** The handlers an agent definition carries, by tool name. */
export const handlersOf = (definition: AgentDefinition): ReadonlyArray<Tool<unknown>> =>
  (definition.tools ?? []).filter((entry): entry is Tool<unknown> => typeof entry !== "string");
