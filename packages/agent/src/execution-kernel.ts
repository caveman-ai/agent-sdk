import { catalogCost } from "./catalog.js";
import {
  parseAnyCaveBuildLock,
  type AnyCaveBuildLock,
  type CavePlan,
} from "./build.js";
import {
  contextIRToWire,
  lowerContext,
  sha256,
  stableStringify,
  type ContextIR,
  type LoweredContext,
  type RuntimeContextSegment,
} from "./context-ir.js";
import type { AgentDefinition } from "./index.js";
import type { ToolDefinition } from "./primitives.js";
import { PI_NATIVE_COMPILER_CONTRACT } from "./runtime-identity.js";

export function lowerAgentContext(
  definition: AgentDefinition,
  options: {
    rootDir?: string;
    runtimeSegments?: readonly RuntimeContextSegment[];
    input?: unknown;
    inputProviderVisibleBytes?: number;
    inputOpaque?: boolean;
  } = {},
): Promise<LoweredContext> {
  return lowerContext({
    ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    instructions: definition.instructions,
    tools: definition.tools,
    contexts: definition.contexts,
    ...(definition.memory === undefined ? {} : { memory: definition.memory }),
    ...(definition.output === undefined ? {} : {
      output: {
        maxTokens: definition.output.maxTokens,
        ...(definition.output.schema === undefined ? {} : { schema: definition.output.schema }),
      },
    }),
    ...(options.runtimeSegments === undefined ? {} : { runtimeSegments: options.runtimeSegments }),
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.inputProviderVisibleBytes === undefined
      ? {}
      : { inputProviderVisibleBytes: options.inputProviderVisibleBytes }),
    ...(options.inputOpaque === undefined ? {} : { inputOpaque: options.inputOpaque }),
  });
}

export interface LockedHarnessPreparation {
  readonly build: AnyCaveBuildLock;
  readonly plan: CavePlan;
  readonly planSHA256: string;
  readonly contextIRSHA256: string;
  readonly provider: string;
  readonly model: string;
}

export function validatePlanSelection(
  plan: CavePlan,
  selected: {
    provider: string;
    model: string;
    reasoning: "off" | "minimal" | "low" | "medium" | "high";
  },
): void {
  const expectedReasoning = plan.reasoning === "none" ? "off" : plan.reasoning;
  if (`${selected.provider}/${selected.model}` !== plan.model ||
      selected.reasoning !== expectedReasoning) {
    throw new Error("cave_execution_plan_selection_mismatch");
  }
}

export function prepareLockedHarnessExecution(input: {
  build: AnyCaveBuildLock;
  harness: string;
  adapterVersion: string;
  upstreamVersion: string;
  agentId?: string;
  contextIR: ContextIR;
  plan: CavePlan;
}): LockedHarnessPreparation {
  const build = parseAnyCaveBuildLock(input.build);
  if (build.harness.id !== input.harness ||
      build.harness.adapter_version !== input.adapterVersion ||
      build.harness.upstream_version !== input.upstreamVersion) {
    throw new Error("cave_harness_build_mismatch");
  }
  if (build.schema_version === 3 && input.harness === "pi" &&
      build.capability_manifest.adapter_contract_sha256 !==
        sha256(stableStringify(PI_NATIVE_COMPILER_CONTRACT))) {
    throw new Error("cave_harness_native_compiler_contract_mismatch");
  }
  if (input.agentId !== undefined && build.agent_id !== input.agentId) {
    throw new Error("cave_harness_agent_mismatch");
  }
  if (stableStringify(input.plan) !== stableStringify(build.selected_plan)) {
    throw new Error("cave_harness_plan_mismatch");
  }
  const planSHA256 = sha256(stableStringify(input.plan));
  if (planSHA256 !== build.plan_sha256) {
    throw new Error("cave_harness_plan_digest_mismatch");
  }
  const contextIRSHA256 = sha256(stableStringify(contextIRToWire(input.contextIR)));
  if (contextIRSHA256 !== build.context_ir_sha256) {
    throw new Error("cave_harness_context_ir_mismatch");
  }
  const [provider, ...modelParts] = input.plan.model.split("/");
  const model = modelParts.join("/");
  if (!provider || !model) throw new Error("cave_harness_model_invalid");
  return Object.freeze({
    build,
    plan: build.selected_plan,
    planSHA256,
    contextIRSHA256,
    provider,
    model,
  });
}

export interface ProviderUsageEvidence {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ValidatedProviderUsage extends ProviderUsageEvidence {
  priced: boolean;
  catalogCostUsd: number;
}

export function validateProviderUsage(
  evidence: ProviderUsageEvidence,
  options: {
    expected?: { provider: string; model: string };
    reportedCostUsd?: number;
    requirePriced?: boolean;
    /** Trusted start time of the provider request whose usage is being priced. */
    accountingAt?: Date;
  } = {},
): ValidatedProviderUsage {
  if (typeof evidence.provider !== "string" || evidence.provider.length === 0 ||
      typeof evidence.model !== "string" || evidence.model.length === 0) {
    throw new Error("cave_provider_identity_missing");
  }
  if (options.expected !== undefined &&
      (evidence.provider !== options.expected.provider || evidence.model !== options.expected.model)) {
    throw new Error("cave_provider_model_identity_mismatch");
  }
  const values = [
    evidence.inputTokens,
    evidence.outputTokens,
    evidence.cacheReadTokens,
    evidence.cacheWriteTokens,
    evidence.reasoningTokens,
    evidence.totalTokens,
  ];
  const disjointTotal = evidence.inputTokens + evidence.outputTokens +
    evidence.cacheReadTokens + evidence.cacheWriteTokens;
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      evidence.totalTokens <= 0 || evidence.totalTokens !== disjointTotal ||
      evidence.reasoningTokens > evidence.outputTokens) {
    throw new Error("cave_provider_usage_incomplete");
  }
  const priced = catalogCost({
    provider: evidence.provider,
    model: evidence.model,
    inputTokens: evidence.inputTokens,
    outputTokens: evidence.outputTokens,
    cacheReadTokens: evidence.cacheReadTokens,
    cacheWriteTokens: evidence.cacheWriteTokens,
    reasoningTokens: evidence.reasoningTokens,
  }, options.accountingAt);
  if (!priced.priced && options.requirePriced === true) {
    throw new Error("cave_provider_usage_unpriced");
  }
  if (options.reportedCostUsd !== undefined &&
      (!priced.priced || !Number.isFinite(options.reportedCostUsd) ||
        options.reportedCostUsd < 0 ||
        Math.abs(options.reportedCostUsd - priced.usd) > 1e-12)) {
    throw new Error("cave_provider_cost_mismatch");
  }
  return Object.freeze({
    ...evidence,
    priced: priced.priced,
    catalogCostUsd: priced.priced ? priced.usd : 0,
  });
}

/** The receipt and journal record of one settled call; unreadable usage is an unpriced zero. */
export function providerCallRecord(
  model: { readonly provider: string; readonly id: string },
  usage: ValidatedProviderUsage | undefined,
) {
  return usage === undefined ? {
    provider: model.provider, model: model.id, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, estimatedUsd: 0, unpriced: true, usageBasis: "unavailable" as const,
  } : {
    provider: usage.provider, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens, cacheWriteTokens: usage.cacheWriteTokens,
    reasoningTokens: usage.reasoningTokens, estimatedUsd: usage.catalogCostUsd, unpriced: !usage.priced,
    usageBasis: "provider_reported" as const,
  };
}

export function enforceSemanticBudgets(
  bill: Readonly<Record<string, number>>,
  outputMaxTokens: number,
  plan: CavePlan,
): void {
  const slots: Array<[keyof CavePlan["budgets"], number]> = [
    ["instructions", bill.instruction ?? 0],
    ["tools", bill.tool_schema ?? 0],
    ["memory", bill.memory ?? 0],
    ["history", bill.history ?? 0],
    ["results_artifacts", (bill.artifact ?? 0) + (bill.skill ?? 0) + (bill.tool_result ?? 0)],
    ["output", outputMaxTokens],
  ];
  for (const [slot, used] of slots) {
    if (used > plan.budgets[slot]) throw new Error(`cave_${slot}_budget_exceeded`);
  }
}

export function volatileStablePrefix(instructions: string, tools: readonly ToolDefinition[]): boolean {
  const value = `${instructions}\n${stableStringify(tools.map((item) => ({
    name: item.name,
    description: item.description,
    input: item.input,
  })))}`;
  return [
    /\b20[0-9]{2}-[01][0-9]-[0-3][0-9][T ][0-2][0-9]:[0-5][0-9]/,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    /["'](?:run|request|build|trace|span)[_-]?id["']\s*:/i,
    /["']nonce["']\s*:/i,
  ].some((pattern) => pattern.test(value));
}
