import type { ToolDefinition } from "./primitives.js";
import { schema, tool } from "./primitives.js";
import type { AgentDefinition } from "./definition.js";
import {
  runAgent,
  runLockedAgent,
  streamAgent,
  type RunOptions,
  type RunResult,
} from "./runtime.js";
import type { Static, TSchema } from "@earendil-works/pi-ai";

/** The parsed `RunResult.output` type for a definition whose `output()` declares a schema. */
export type AgentOutput<D> = D extends AgentDefinition<infer S>
  ? S extends TSchema ? Static<S> : never
  : never;
import { agentDirRunDefaults } from "./dir-loader.js";
import { writeRunReceipt } from "./receipt-print.js";
import type { AgentInput } from "./input.js";

export * from "./context-ir.js";
export * from "./trajectory-ir.js";
export * from "./profile.js";
export * from "./compiler.js";
export * from "./primitives.js";
export * from "./programmatic-tools.js";
export * from "./connect.js";
export * from "./model-boundary.js";
export * from "./model-usage.js";
export * from "./input.js";
export * from "./run-receipt.js";
export * from "./execution-backend.js";
export * from "./memory.js";
export * from "./memory-adapters.js";
export {
  agent,
  applyAgentDefinitionTransforms,
  type AgentDefinition,
  type AgentDefinitionTransform,
} from "./definition.js";
export {
  AGENT_RUN_RECEIPT_SCHEMA,
  OUTPUT_CLAMP_FLOOR_TOKENS,
  createBudgetController,
} from "./budget.js";
export type { BreakerEvent, RunBreakers } from "./breakers.js";
export {
  SUMMARY_SCHEMA_VERSION,
  contextSummarySources,
  latestContextSummary,
  normalizeCompaction,
  parseContextSummary,
  renderSummary,
  summarizationInstruction,
  validateContextSummaryTransition,
} from "./compaction.js";
export type {
  CompactionOptions,
  ContextAnchor,
  ContextAnchorKind,
  ContextSummary,
  ContextSummarySource,
  ContextSummaryValidation,
  NormalizedCompaction,
} from "./compaction.js";
export * from "./compaction-eval.js";
export * from "./compaction-harness.js";
export type {
  BudgetController,
  BudgetDenomination,
  BudgetExhaustionContext,
  BudgetExhaustionHandler,
  BudgetTranche,
  ReceiptCall,
  ReceiptCompaction,
  ReceiptResume,
  ReceiptTool,
  RunBudget,
  RunReceipt,
  RunStopReason,
} from "./budget.js";
export {
  DiskDurableStore,
  durableInputIsReplayable,
  durableRunSummary,
  HttpDurableStore,
} from "./durable.js";
export type {
  DurableRunOptions,
  DurableRunSummary,
  DurableStore,
  HttpDurableStoreOptions,
} from "./durable.js";
export type {
  CavemanRunEvent,
  ConversationState,
  ModelCallRouteDecision,
  ModelCallRouteInput,
  ModelCallRouter,
  RunOptions,
  RunResult,
} from "./runtime.js";
export {
  AgentRunController,
  CavemanRunError,
  agentStaticContextDiagnostics,
  createConversation,
  verifySandboxConformance,
} from "./runtime.js";
export type { AgentStaticContextDiagnostics } from "./runtime.js";
export { shellTools } from "./shell-tools.js";
export type { ShellToolName, ShellToolsOptions } from "./shell-tools.js";
export { decideToolCall, TOOL_POLICY_TIMEOUT_MS } from "./tool-policy.js";
export type {
  ToolCallDecision,
  ToolCallDenial,
  ToolCallPolicy,
  ToolCallPolicyInput,
} from "./tool-policy.js";
// The scoped-egress contract is public because it is what a caller writes in
// `RunOptions.sandboxProfile.network`. `egressAllowed` is exported alongside it
// so the exact rule a deployment will be held to can be asserted in that
// deployment's own tests, rather than inferred from documentation.
export {
  egressAllowed,
  resolveEgressPolicy,
  type ResolvedEgressPolicy,
  type SandboxEgress,
  type SandboxEgressPolicy,
} from "./sandbox/policy.js";
export {
  createFileMemoryAdapter,
  type MemoryStoreConfig,
} from "./memory-store.js";
export {
  AGENT_DIR_ENTRY,
  composeAgentDir,
  loadAgentDir,
} from "./dir-loader.js";
// The cache planner (src/cache-planner/) is deliberately NOT re-exported:
// internal imports only until the package's public planner surface is decided
// (tests reach it via dist/cache-planner/index.js directly).
export type {
  AgentDirConfig,
  AgentDirContextValue,
  AgentDirModules,
  AgentDirRunDefaults,
} from "./dir-loader.js";
export { routine, routineOutcomes } from "./routine.js";
export type { RoutineOutcome, RoutineOutcomeCount } from "./routine.js";
export { renderReceipt } from "./receipt-print.js";
export type { ReceiptLike, ReceiptPrintCall } from "./receipt-print.js";

/**
 * A directory-loaded definition carries run defaults (its config's budget and
 * breakers, the generated sandbox entry, and receipt printing) — explicit
 * RunOptions override them, and a caller-supplied `maxCostUsd` keeps the
 * default budget out because the two contracts are mutually exclusive.
 * Defaults are assigned imperatively so a caller's explicit `undefined`
 * cannot clobber one through spread ordering.
 */
function withAgentDirDefaults(
  definition: AgentDefinition,
  options: RunOptions | undefined,
  defaultPrint = true,
): RunOptions | undefined {
  const defaults = agentDirRunDefaults(definition);
  if (defaults === undefined) return options;
  const merged: RunOptions = { ...options };
  if (merged.budget === undefined && merged.maxCostUsd === undefined &&
      defaults.budget !== undefined) {
    merged.budget = defaults.budget;
  }
  if (merged.breakers === undefined && defaults.breakers !== undefined) {
    merged.breakers = defaults.breakers;
  }
  if (merged.rootDir === undefined && defaults.rootDir !== undefined) {
    merged.rootDir = defaults.rootDir;
  }
  if (merged.entryPath === undefined && defaults.entryPath !== undefined) {
    merged.entryPath = defaults.entryPath;
  }
  if (defaultPrint && merged.printReceipt === undefined) {
    merged.printReceipt = true;
  }
  return merged;
}

export async function run<D extends AgentDefinition>(
  definition: D,
  input: AgentInput,
  options?: RunOptions,
): Promise<RunResult<AgentOutput<D>>> {
  const merged = withAgentDirDefaults(definition, options);
  const result = await runAgent(definition, input, merged) as RunResult<AgentOutput<D>>;
  // F1: the receipt print is the default end of a scaffolded (directory-
  // loaded) run — `printReceipt` defaults ON there and OFF everywhere else,
  // because stdout may be a protocol channel a receipt would corrupt.
  if (merged?.printReceipt === true) {
    try {
      const { rendered } = await writeRunReceipt(
        merged.rootDir ?? process.cwd(),
        result.receipt,
        { mode: result.mode, durationMs: result.latencyMs },
      );
      process.stdout.write(rendered);
    } catch (error) {
      process.stderr.write(`caveman agent: receipt write failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`);
    }
  }
  return result;
}

/** Execute a validated Pi Cave Build from an embedded application. */
export async function runLocked<D extends AgentDefinition>(
  definition: D,
  input: AgentInput,
  build: import("./build.js").AnyCaveBuildLock,
  options?: RunOptions,
): Promise<RunResult<AgentOutput<D>>> {
  return await runLockedAgent(definition, input, build, withAgentDirDefaults(definition, options)) as
    RunResult<AgentOutput<D>>;
}

export function stream(
  definition: AgentDefinition,
  input: AgentInput,
  options?: RunOptions,
) {
  // Streaming has no receipt print site yet, so the flag stays unset here
  // rather than riding along inert.
  return streamAgent(definition, input, withAgentDirDefaults(definition, options, false));
}

export function subagent(options: {
  name: string;
  description: string;
  agent: AgentDefinition;
  timeoutMs?: number;
  maxInputChars?: number;
  maxCalls?: number;
  /**
   * This child's wallet in USD. Under a USD-metered run the wallet is carved
   * out of the parent's **remaining** budget when the child is spawned, and its
   * unspent remainder returns to the parent when the child finishes.
   */
  maxCostUsd?: number;
  /**
   * This child's wallet in tokens — the denomination sibling of `maxCostUsd`,
   * used by a token-metered run. A token-metered run cannot fund a subagent
   * that declares no token wallet.
   */
  maxTokens?: number;
  maxContextTokens?: number;
}): ToolDefinition {
  const maxInputChars = options.maxInputChars ?? 32_768;
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars <= 0) {
    throw new Error("caveman agent: subagent maxInputChars must be a positive integer");
  }
  const maxCalls = options.maxCalls ?? 1;
  const maxCostUsd = options.maxCostUsd ?? 1;
  const maxContextTokens = options.maxContextTokens ?? 128_000;
  if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0) {
    throw new Error("caveman agent: subagent maxCalls must be a positive integer");
  }
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error("caveman agent: subagent maxCostUsd must be positive");
  }
  if (options.maxTokens !== undefined &&
      (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0)) {
    throw new Error("caveman agent: subagent maxTokens must be a positive integer");
  }
  if (!Number.isSafeInteger(maxContextTokens) || maxContextTokens <= 0) {
    throw new Error("caveman agent: subagent maxContextTokens must be a positive integer");
  }
  return tool({
    name: options.name,
    description: options.description,
    input: schema.object({ task: schema.string() }),
    effect: "read",
    result: "auto",
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    runtime: {
      kind: "subagent",
      definition: options.agent,
      maxInputChars,
      maxCalls,
      maxCostUsd,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      maxContextTokens,
    },
    async execute() {
      throw new Error("cave_subagent_framework_runner_required");
    },
  });
}
