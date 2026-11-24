// An agent defined in code is written as an agent file, the one canonical form the runtime's agent loader reads
// (`.caveman/agents/<name>.md`: frontmatter, then instructions). So there is one validator, and an inline agent can
// be saved to a repository or published to Cloud unchanged.

import type { GateConfig } from "@caveman-ai/harness";
import type { Tool } from "./tool.ts";
import { CavemanError, type SensorSpec } from "./types.ts";

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
  /** Agent-level Caveman Gate configuration merged with any per-tool `gate` policies. */
  readonly gate?: GateConfig;
  /** Declarative Caveman Sensors that can wake or park this agent at zero compute. */
  readonly sensors?: ReadonlyArray<SensorSpec>;
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
  const tools = (definition.tools ?? []).map((entry) => {
    if (typeof entry === "string") return entry;
    const base: Record<string, unknown> = { type: "custom", name: entry.name, description: entry.description, input_schema: entry.inputSchema };
    if (entry.gate !== undefined) {
      base.gate = {
        ...(entry.gate.action === undefined ? {} : { action: entry.gate.action }),
        ...(entry.gate.risk === undefined ? {} : { risk: entry.gate.risk }),
        ...(typeof entry.gate.summary === "string" ? { summary: entry.gate.summary } : {}),
      };
    }
    return base;
  });
  const names = tools.map((entry) => (typeof entry === "string" ? entry : String(entry.name)));
  const twice = names.find((item, i) => names.indexOf(item) !== i);
  if (twice !== undefined) throw new CavemanError("tool_declared_twice", `Agent "${name}" declares the tool "${twice}" twice.`);
  const sensors = definition.sensors ?? [];
  const sensorTwice = sensors.find((s, i) => sensors.findIndex((other) => other.name === s.name) !== i);
  if (sensorTwice !== undefined) throw new CavemanError("sensor_declared_twice", `Agent "${name}" declares the sensor "${sensorTwice.name}" twice.`);
  const gateSpec = (() => {
    const g = definition.gate;
    if (g === undefined) return undefined;
    const out: Record<string, unknown> = {};
    if (g.requireAll !== undefined) out.requireAll = Boolean(g.requireAll);
    if (g.defaultRisk !== undefined) out.defaultRisk = g.defaultRisk;
    if (g.timeoutMs !== undefined) out.timeoutMs = g.timeoutMs;
    if (g.rules !== undefined && g.rules.length > 0) {
      out.rules = g.rules.map((r) => ({
        tool: typeof r.tool === "string" ? r.tool : { regex: r.tool.source, flags: r.tool.flags },
        ...(r.action === undefined ? {} : { action: r.action }),
        ...(r.risk === undefined ? {} : { risk: r.risk }),
        ...(typeof r.summary === "string" ? { summary: r.summary } : r.summary !== undefined ? { dynamicSummary: true } : {}),
        ...(r.when === undefined ? {} : { hasWhen: true }),
      }));
    }
    return Object.keys(out).length > 0 ? out : undefined;
  })();
  const front = [
    line("name", name),
    line("description", definition.description ?? name),
    line("engine", "caveman"),
    ...(definition.model === undefined ? [] : [line("model", definition.model)]),
    ...(definition.effort === undefined ? [] : [line("effort", definition.effort)]),
    line("computer", definition.computer ?? "none"),
    ...(tools.length === 0 ? [] : [line("tools", tools)]),
    ...(definition.disallowedTools === undefined ? [] : [line("disallowedTools", definition.disallowedTools)]),
    ...(gateSpec === undefined ? [] : [line("gate", gateSpec)]),
    ...(sensors.length === 0 ? [] : [line("sensors", sensors)]),
  ];
  return `---\n${front.join("\n")}\n---\n\n${definition.instructions.trim()}\n`;
}

/** The handlers an agent definition carries, by tool name. */
export const handlersOf = (definition: AgentDefinition): ReadonlyArray<Tool<unknown>> =>
  (definition.tools ?? []).filter((entry): entry is Tool<unknown> => typeof entry !== "string");
