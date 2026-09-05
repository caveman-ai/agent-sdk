import type { Api, Model, TSchema } from "@earendil-works/pi-ai";
import type {
  Auto,
  ContextDefinition,
  FileSource,
  MemoryDefinition,
  OutputDefinition,
  ToolDefinition,
} from "./primitives.js";

export interface AgentDefinition<TOutput extends TSchema | undefined = TSchema | undefined> {
  readonly kind: "agent";
  readonly id: string;
  readonly instructions: string | FileSource;
  readonly model: Auto | string | Model<Api>;
  readonly reasoning: "off" | "minimal" | "low" | "medium" | "high";
  readonly tools: readonly ToolDefinition[];
  readonly contexts: readonly ContextDefinition[];
  readonly memory?: MemoryDefinition;
  /** Declared output contract; its schema types `RunResult.output`. */
  readonly output?: OutputDefinition<TOutput>;
  /**
   * Tool containment posture.
   *
   * - `"required"` (default): tool closures run in network-denied isolated
   *   Node workers imported from an immutable staged source graph, so
   *   `RunOptions.entryPath` is mandatory.
   * - `"fixture"`: trusted tests only — closures run in the host process and
   *   `effect: "write"` tools are blocked before they execute.
   * - `"host"`: explicit opt-in for interactive and coding agents whose tools
   *   need real host access. Closures run in the host process with no worker
   *   spawn and no `entryPath` requirement, and `effect: "write"` tools do
   *   execute. Effect declarations stay mandatory — host mode changes
   *   enforcement, not declaration. A host-mode agent is never lock-eligible:
   *   `compile` refuses it with `cave_host_sandbox_lock_ineligible`, and locked
   *   builds for coding agents compile against fixture corpora instead. Host
   *   mode is refused under a sandbox-required ancestor so a subagent cannot
   *   escape its root's containment. Host execution is never isolation.
   */
  readonly sandbox: "required" | "fixture" | "host";
  /**
   * Whether the author named a sandbox posture. `false` means the `"required"`
   * above is the type-level default rather than a stated intent, which is what
   * lets `run()`/`stream()` execute on the host (loudly) when no `entryPath` is
   * supplied. An explicit posture — including an explicit `"required"` — is
   * never reinterpreted.
   */
  readonly sandboxDeclared: boolean;
}

/** Trusted, explicit definition transform applied by an embedding product. */
export interface AgentDefinitionTransform {
  readonly id: string;
  readonly apply: (definition: AgentDefinition) => AgentDefinition;
}

const SANDBOX_MODES: readonly AgentDefinition["sandbox"][] = [
  "required",
  "fixture",
  "host",
];

export function agent<TOutput extends TSchema | undefined = undefined>(options: {
  id: string;
  instructions: string | FileSource;
  model: Auto | string | Model<Api>;
  reasoning?: AgentDefinition["reasoning"];
  tools?: ToolDefinition[];
  contexts?: ContextDefinition[];
  memory?: MemoryDefinition;
  output?: OutputDefinition<TOutput>;
  sandbox?: AgentDefinition["sandbox"];
}): AgentDefinition<TOutput> {
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(options.id)) {
    throw new Error(`caveman agent: invalid agent id ${JSON.stringify(options.id)}`);
  }
  const tools = Object.freeze([...(options.tools ?? [])]);
  if (new Set(tools.map((item) => item.name)).size !== tools.length) {
    throw new Error("caveman agent: duplicate tool name");
  }
  const sandbox = options.sandbox ?? "required";
  if (!SANDBOX_MODES.includes(sandbox)) {
    throw new Error(`caveman agent: unknown sandbox mode ${JSON.stringify(sandbox)}`);
  }
  const reserved = tools.find((item) => item.name.startsWith("cave_"));
  if (reserved) {
    throw new Error(
      `caveman agent: tool prefix cave_ is reserved by framework (${reserved.name})`,
    );
  }
  return Object.freeze({
    kind: "agent",
    id: options.id,
    instructions: options.instructions,
    model: options.model,
    reasoning: options.reasoning ?? "low",
    tools,
    contexts: Object.freeze([...(options.contexts ?? [])]),
    sandbox,
    sandboxDeclared: options.sandbox !== undefined,
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.output === undefined ? {} : { output: options.output }),
  });
}

export function applyAgentDefinitionTransforms(
  definition: AgentDefinition,
  transforms: readonly AgentDefinitionTransform[],
): AgentDefinition {
  const ids = new Set<string>();
  let current = definition;
  for (const transform of transforms) {
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/.test(transform.id)) {
      throw new Error(`caveman agent: invalid definition transform id ${JSON.stringify(transform.id)}`);
    }
    if (ids.has(transform.id)) {
      throw new Error(`caveman agent: duplicate definition transform ${JSON.stringify(transform.id)}`);
    }
    ids.add(transform.id);
    const next = transform.apply(current);
    if (next === null || typeof next !== "object" || next.kind !== "agent") {
      throw new Error(`caveman agent: definition transform ${JSON.stringify(transform.id)} returned invalid definition`);
    }
    current = next;
  }
  return current;
}
