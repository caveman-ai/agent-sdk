/**
 * `@caveman-ai/agent/code` — the Caveman coding agent.
 *
 * A coding agent whose tools run on the real host (`sandbox: "host"`) and whose
 * live-zone context is compressed reversibly by default. Optimized mode is the
 * default: the session starts the local Cave runtime when it can and runs with a
 * recoverable-only efficiency plan over history and tool results. Observe-only is
 * the loud fallback, announced with a banner and shown in the session status for
 * every turn after it.
 *
 * Public accounting is deliberately simple: context reductions are local token
 * estimates, spend is a public-catalog price estimate, and local execution makes
 * no provider savings claim.
 * - Live coding sessions are never lock-eligible; `compile` refuses host mode
 *   so nothing a session does can become a Cave Build.
 */
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { TurnEvent } from "@pebble-agent/protocol";
import type { Api, CacheRetention, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { CavePlan } from "./build.js";
import type { RunBudget, RunReceipt } from "./budget.js";
import type { RunBreakers } from "./breakers.js";
import {
  CODING_CACHE_INPUT_TOKEN_HIT_TARGET,
  analyzeProviderCachePerformance,
} from "./cache-planner/performance.js";
import {
  agent,
  applyAgentDefinitionTransforms,
  type AgentDefinition,
  type AgentDefinitionTransform,
} from "./definition.js";
import {
  memory as defineMemory,
  memoryTTLMilliseconds,
  output,
  type MemoryDefinition,
} from "./primitives.js";
import {
  createMemoryEngine,
  type MemoryRuntimeConfig,
} from "./memory.js";
import { createFileMemoryAdapter } from "./memory-store.js";
import {
  createProgrammaticToolRuntime,
  type ProgrammaticToolRuntime,
} from "./programmatic-tools.js";
import {
  createCommandSessionRuntime,
  type CommandSessionSpillOptions,
} from "./command-session.js";
import {
  localExecutionBackend,
  type ExecutionBackend,
} from "./execution-backend.js";
import { localBackendInternals } from "./coding-backend.js";
import {
  BASH_SESSION_MAX_INPUT_BYTES,
  BASH_SESSION_MAX_SESSIONS,
  BASH_SESSION_MAX_WAIT_MS,
  BASH_SESSION_READ_CHUNK_BYTES,
  BASH_TIMEOUT_MS,
  CODING_TOOL_OUTPUT_CAPS,
  PROCESS_CAPTURE_MAX_BYTES,
  shellTools,
} from "./shell-tools.js";
import {
  createConversation,
  AgentRunController,
  proveSegmentRecovery,
  rejectInternalRunOptions,
  resolveCaveRoute,
  resolveGatewayURL,
  runAgentInternal,
  streamAgentInternalOptions,
  type AgentRunQueueState,
  type CavemanRunEvent,
  type ConversationState,
  type ModelCallRouter,
  type ResolvedCaveRoute,
  type RunOptions,
  type RunResult,
  type SegmentRecoveryProof,
  type TransformTrace,
} from "./runtime.js";
import { encodeRunEvent, PebbleEventEncoder } from "./pebble-stream.js";

export { AgentRunController };
// The tools themselves live in `./shell-tools.js`, composable by any agent;
// these two stay published here because the coding surface documented them.
export { CODING_TOOL_OUTPUT_CAPS };
export { capOutput } from "./shell-tools.js";
export {
  createCommandSessionRuntime,
  type CommandSessionReadOptions,
  type CommandSessionReadResult,
  type CommandSessionRuntime,
  type CommandSessionRuntimeOptions,
  type CommandSessionSpillOptions,
  type CommandSessionStartOptions,
  type CommandSessionStartResult,
  type CommandSessionState,
  type CommandSessionSummary,
  type CommandSessionWriteOptions,
  type CommandSessionWriteResult,
} from "./command-session.js";
export {
  PROGRAMMATIC_TOOL_NAME,
  createProgrammaticToolRuntime,
  programmaticToolInstructions,
  type ProgrammaticToolRuntime,
  type ProgrammaticToolStats,
} from "./programmatic-tools.js";

/**
 * The only transforms a default coding plan may route. Every one of them is
 * CCR-recoverable (`recovery: exact_ccr`) and the runtime proves the round trip
 * byte-for-byte before a compressed body is allowed near the provider. `toon` is
 * excluded on purpose: it is forced-only structured re-encoding, never a default.
 */
export const RECOVERABLE_CODING_TRANSFORMS: readonly string[] = Object.freeze([
  "caveman.engine.code.v1",
  "caveman.engine.diff.v1",
  "caveman.engine.json.v1",
  "caveman.engine.log.v1",
  "caveman.engine.search-result.v1",
  "caveman.engine.terminal.v1",
  "caveman.engine.text.v1",
]);

/** Tool results in a coding session are command, file, and search output. */
const TOOL_RESULT_TRANSFORM = "caveman.engine.terminal.v1";
/** Conversation history is prose plus quoted snippets. */
const HISTORY_TRANSFORM = "caveman.engine.text.v1";

/** Cost-control defaults for coding runs. No retry policy: retries require a declared budget. */
export const CODING_RUN_BREAKERS: RunBreakers = Object.freeze({
  repeatedToolCalls: 3,
  repeatedToolCallWindowTurns: 8,
  noProgressTurns: 3,
  maxToolCallsPerTurn: 8,
});

/** Model calls per turn = 1 + ceil(retry_cascade_reserve / 256) = 64. */
const RETRY_CASCADE_RESERVE = 16_128;
const OUTPUT_MAX_TOKENS = 8_000;

export const OBSERVE_ONLY_BANNER = [
  "cave: OBSERVE-ONLY — the Caveman engine/gateway is not available here.",
  "  Context transforms and gateway telemetry are OFF. Provider usage and local context estimates remain available.",
  "  Turn optimized mode on: npm i -g @caveman-ai/cli && caveman start",
].join("\n");

const FULL_TOOL_INSTRUCTIONS = [
  "- read_file prefixes each line with its number and tab. Strip prefixes before copying; preserve newlines.",
  "- grep searches the workspace with ripgrep, falling back to grep.",
  "- bash runs one shell command in the workspace and returns its combined output.",
  "- write_file creates a file, or overwrites one only when overwrite is true.",
  "- edit_file replaces an exact string in a file. Match enough surrounding text",
  "  to make the target unique, or pass replace_all.",
  "- read_tool_output pages or literal-searches captured output by opaque handle.",
].join("\n");

const PEBBLE_V1_TOOL_INSTRUCTIONS = [
  "- read_file prefixes each line with its number and tab. Strip prefixes before copying; preserve newlines.",
  "- bash runs one shell command in the workspace and returns its combined output.",
  "- write_file creates a file, or overwrites one only when overwrite is true.",
  "- edit_file replaces an exact string in a file. Match enough surrounding text",
  "  to make the target unique, or pass replace_all.",
].join("\n");

function codingInstructions(toolSet: CodingToolSet): string {
  const toolInstructions = toolSet === "pebble-v1"
    ? PEBBLE_V1_TOOL_INSTRUCTIONS
    : FULL_TOOL_INSTRUCTIONS;
  const cappedOutputInstructions = toolSet === "pebble-v1"
    ? "Tool output is capped before it reaches you. Narrow the request or command when output is truncated."
    : [
        "Tool output is capped before it reaches you. Shell output keeps its tail so test",
        "failures survive truncation. When a result gives a handle, page or search that",
        "captured output instead of repeating the command. Otherwise narrow the request.",
      ].join("\n");
  return [
    "You are a coding agent working inside one workspace directory.",
    "",
    "Work like an engineer: read before you edit, prefer the smallest change that",
    "solves the task, and verify with a command when a command can verify it.",
    "",
    "Tools:",
    toolInstructions,
    "",
    cappedOutputInstructions,
    "",
    "Older turns and older tool results may arrive wrapped in <cave-compressed>",
    "markers. Those are reversible: call cave_retrieve with the recovery_handle in",
    "the marker to get the exact original bytes back. Retrieve before guessing.",
    "",
    "Say what you changed and why. Do not claim a command passed unless you ran it.",
  ].join("\n");
}

export type CodingToolSet = "full" | "pebble-v1";
export type CodingToolMode = "direct" | "programmatic";

export interface CodingAgentOptions {
  /** Workspace root. Tools refuse to read or write outside it. */
  workspace?: string;
  /** `provider/model`. Defaults to `CAVE_MODEL`, else the one configured provider. */
  model?: string;
  /** Agent id; also the recovery namespace and default workflow name. */
  id?: string;
  /** Extra instruction text appended to the built-in coding instructions. */
  instructions?: string;
  /** Per-tool raw output caps in bytes, before any transform. */
  outputCaps?: Partial<typeof CODING_TOOL_OUTPUT_CAPS>;
  /** Provider-visible coding tools. Generic SDK default remains the full six-tool surface. */
  toolSet?: CodingToolSet;
  /** `programmatic` collapses ordinary tools into one bounded code-cell tool. */
  toolMode?: CodingToolMode;
  /** Safe read speculation in programmatic mode. Defaults on; ignored by direct mode. */
  speculativeToolCalls?: boolean;
  /** Optional bounded disk retention for command output evicted from memory. */
  commandSessionSpill?: CommandSessionSpillOptions;
  /** Interactive bash sessions. Defaults on locally and off for non-local backends. */
  commandSessions?: boolean;
  /** Workspace and process execution. Defaults to the local host backend. */
  executionBackend?: ExecutionBackend;
  /** Trusted product adapters applied before direct/programmatic tool finalization. */
  definitionTransforms?: readonly AgentDefinitionTransform[];
  /** Provider-visible composite tool name. Product wrappers may brand it; default `caveman_code`. */
  programmaticToolName?: string;
  /** `true` enables durable ambient memory with safe local defaults. */
  memory?: boolean | MemoryDefinition;
}

export interface CodingAgent {
  readonly definition: AgentDefinition;
  /** The default efficiency plan: recoverable routes over the live zone. */
  readonly plan: CavePlan;
  readonly workspace: string;
  readonly modelID: string;
  readonly toolMode: CodingToolMode;
  /** Present only in programmatic mode. Session APIs wire its transport automatically. */
  readonly programmaticTools?: ProgrammaticToolRuntime;
  /** Largest raw tool outputs seen this process, kept for the recovery proof. */
  readonly samples: ToolOutputSample[];
  /** Kill live command sessions owned by this agent. Idempotent. */
  close(): Promise<void>;
}

export interface ToolOutputSample {
  readonly label: string;
  readonly text: string;
}

const MAX_SAMPLES = 4;

/**
 * The default efficiency plan for an interactive coding session.
 *
 * One route per dynamic segment kind, because the runtime refuses an ambiguous
 * dynamic route (two routes matching one runtime segment collapse to
 * `dynamic_route_ambiguous` and the segment passes through untouched). Budgets
 * are sized for a long interactive session rather than a fixture run; they are
 * ceilings that fail the turn honestly rather than silently truncating context.
 */
export function defaultCodingPlan(modelID: string, namespace: string): CavePlan {
  return {
    schema_version: 1,
    plan_id: "caveman-code.default.recoverable-live-zone",
    model: modelID,
    reasoning: "none",
    segment_routes: [
      { segment_kind: "tool_result", transform_id: TOOL_RESULT_TRANSFORM, fallback: "original" },
      { segment_kind: "history", transform_id: HISTORY_TRANSFORM, fallback: "original" },
    ],
    budgets: {
      instructions: 64_000,
      tools: 32_000,
      memory: 8_000,
      history: 4_000_000,
      results_artifacts: 4_000_000,
      reasoning: 64_000,
      output: 512_000,
      retry_cascade_reserve: RETRY_CASCADE_RESERVE,
    },
    recovery: { namespace, tools: ["cave_retrieve"] },
    fallbacks: { unknown: "original", transform_error: "original", not_smaller: "original" },
  };
}

export function createCodingAgent(options: CodingAgentOptions = {}): CodingAgent {
  const workspace = resolve(options.workspace ?? process.cwd());
  const executionBackend = options.executionBackend ?? localExecutionBackend();
  const id = options.id ?? "caveman-code";
  const modelID = resolveCodingModelID(options.model);
  const toolSet = options.toolSet ?? "full";
  if (toolSet !== "full" && toolSet !== "pebble-v1") throw new Error(`coding_tool_set_invalid:${toolSet}`);
  const toolMode = options.toolMode ?? "direct";
  if (toolMode !== "direct" && toolMode !== "programmatic") {
    throw new Error(`coding_tool_mode_invalid:${toolMode}`);
  }
  const caps = { ...CODING_TOOL_OUTPUT_CAPS, ...options.outputCaps };
  const samples: ToolOutputSample[] = [];
  const record = (label: string, text: string) => {
    samples.push({ label, text });
    samples.sort((left, right) => right.text.length - left.text.length);
    samples.length = Math.min(samples.length, MAX_SAMPLES);
  };
  const localBackend = localBackendInternals(executionBackend) !== undefined;
  const commandSessionsEnabled = options.commandSessions ?? localBackend;
  if (!localBackend &&
      (commandSessionsEnabled || options.commandSessionSpill !== undefined)) {
    throw new Error("cave_execution_backend_command_sessions_local_only");
  }
  if (!commandSessionsEnabled && options.commandSessionSpill !== undefined)
    throw new Error("cave_execution_backend_command_sessions_disabled");
  const commandSessions = commandSessionsEnabled
    ? createCommandSessionRuntime({
      maxSessions: BASH_SESSION_MAX_SESSIONS,
      maxOutputBytes: PROCESS_CAPTURE_MAX_BYTES,
      maxReadBytes: BASH_SESSION_READ_CHUNK_BYTES,
      maxInputBytes: BASH_SESSION_MAX_INPUT_BYTES,
      maxTimeoutMs: BASH_TIMEOUT_MS,
      maxWaitMs: BASH_SESSION_MAX_WAIT_MS,
      ...(options.commandSessionSpill === undefined
        ? {}
        : { spill: options.commandSessionSpill }),
    })
    : undefined;
  const baseDefinition = agent({
    id,
    instructions: options.instructions === undefined
      ? codingInstructions(toolSet)
      : `${codingInstructions(toolSet)}\n\n${options.instructions}`,
    model: modelID,
    reasoning: "off",
    sandbox: "host",
    output: output({ maxTokens: OUTPUT_MAX_TOKENS }),
    ...(options.memory === undefined || options.memory === false
      ? {}
      : {
          memory: options.memory === true
            ? defineMemory({ namespace: id })
            : options.memory,
        }),
    tools: shellTools({
      workspace,
      executionBackend,
      tools: toolSet === "pebble-v1"
        ? ["read_file", "bash", "write_file", "edit_file"]
        : ["read_file", "grep", "bash", "write_file", "edit_file", "read_tool_output"],
      outputCaps: caps,
      ...(commandSessions === undefined ? {} : { commandSessions }),
      onOutput: record,
    }),
  });
  const directDefinition = applyAgentDefinitionTransforms(
    baseDefinition,
    options.definitionTransforms ?? [],
  );
  const programmaticTools = toolMode === "programmatic"
    ? createProgrammaticToolRuntime(directDefinition, {
      speculate: options.speculativeToolCalls ?? true,
      ...(options.programmaticToolName === undefined
        ? {}
        : { toolName: options.programmaticToolName }),
    })
    : undefined;
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= (async () => {
    try {
      await programmaticTools?.close();
    } finally {
      await commandSessions?.close();
    }
  })());
  return Object.freeze({
    definition: programmaticTools?.definition ?? directDefinition,
    plan: defaultCodingPlan(modelID, id),
    workspace,
    modelID,
    toolMode,
    ...(programmaticTools === undefined ? {} : { programmaticTools }),
    samples,
    close,
  });
}

function resolveCodingModelID(explicit: string | undefined): string {
  const requested = explicit ?? process.env.CAVE_MODEL;
  if (requested !== undefined && requested !== "") {
    const slash = requested.indexOf("/");
    if (slash <= 0 || slash === requested.length - 1) {
      throw new Error("caveman-code: model must use provider/model format");
    }
    return requested;
  }
  const configured: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) configured.push("anthropic/claude-sonnet-4-6");
  if (process.env.OPENAI_API_KEY) configured.push("openai/gpt-5.5");
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    configured.push("google/gemini-2.5-pro");
  }
  if (configured.length !== 1) {
    throw new Error(
      configured.length === 0
        ? "caveman-code: no supported provider credential found; set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY"
        : "caveman-code: multiple provider credentials found; set CAVE_MODEL to pick one",
    );
  }
  return configured[0]!;
}

/**
 * Clone model records for one provider onto an explicit API base URL while
 * retaining Pi's provider-owned auth and wire implementation. This is an
 * endpoint override, not gateway routing: callers remain in direct-provider
 * mode and every same-provider model selected later receives the same base.
 */
export function codingModelsAtProviderBaseURL(
  modelID: string,
  rawBaseURL: string,
  source: Models = builtinModels(),
): Models {
  const slash = modelID.indexOf("/");
  if (slash < 1 || slash === modelID.length - 1) {
    throw new Error("coding_provider_base_url_model_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBaseURL);
  } catch {
    throw new Error("coding_provider_base_url_invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" || parsed.password !== "") {
    throw new Error("coding_provider_base_url_invalid");
  }
  const provider = modelID.slice(0, slash);
  const baseURL = parsed.toString().replace(/\/$/u, "");
  const rewrite = (model: Model<Api> | undefined): Model<Api> | undefined =>
    model?.provider === provider ? { ...model, baseUrl: baseURL } : model;
  return new Proxy(source, {
    get(target, property) {
      if (property === "getModel") {
        return (selectedProvider: string, id: string) =>
          rewrite(target.getModel(selectedProvider, id));
      }
      if (property === "getModels") {
        return (selectedProvider?: string) =>
          target.getModels(selectedProvider).map((model) => rewrite(model)!);
      }
      if (property === "getAvailable") {
        return async (selectedProvider?: string) =>
          (await target.getAvailable(selectedProvider)).map((model) => rewrite(model)!);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export type CodingTaskPriceBasis = "provider_invoice" | "public_catalog" | "unpriced";

/** One paid attempt in a matched coding-harness evaluation. */
export interface CodingTaskAttemptEvidence {
  taskId: string;
  attemptId: string;
  provider: string;
  model: string;
  /** Completion must come from the task's external verifier, never agent self-report. */
  completed: boolean;
  completionBasis: "external_verifier" | "missing";
  /** Spend for this attempt. Failed attempts remain in the numerator. */
  costUsd: number | null;
  priceBasis: CodingTaskPriceBasis;
  /** Provider-counted total tokens for this attempt. */
  tokens: number | null;
  usageBasis: "provider_reported" | "unavailable";
}

export interface CodingTaskEconomics {
  status: "complete" | "incomplete_evidence" | "no_completed_tasks";
  attempted: number;
  completed: number;
  completionRate: number | null;
  totalCostUsd: number | null;
  costPerCompletedTaskUsd: number | null;
  priceBasis: Exclude<CodingTaskPriceBasis, "unpriced"> | null;
  totalTokens: number | null;
  tokensPerCompletedTask: number | null;
  usageBasis: "provider_reported" | null;
  provider: string | null;
  model: string | null;
  issues: readonly string[];
}

export interface CodingTaskEconomicsOptions {
  /** Planned attempts for this arm. Missing or extra attempts fail metrics closed. */
  expectedAttempts?: number;
}

/**
 * Honest harness metric: all attempt spend divided by externally verified
 * completions. Unknown or mixed evidence produces null, never a favorable zero.
 */
export function summarizeCodingTaskAttempts(
  attempts: readonly CodingTaskAttemptEvidence[],
  options: CodingTaskEconomicsOptions = {},
): CodingTaskEconomics {
  if (options.expectedAttempts !== undefined &&
      (!Number.isSafeInteger(options.expectedAttempts) || options.expectedAttempts < 1)) {
    throw new Error("coding_task_expected_attempts_invalid");
  }
  const issues = new Set<string>();
  if (attempts.length === 0) issues.add("no_attempts");
  if (options.expectedAttempts !== undefined && attempts.length !== options.expectedAttempts) {
    issues.add("attempt_cardinality_mismatch");
  }
  const identities = new Set<string>();
  const attemptIDs = new Set<string>();
  const pricedBases = new Set<Exclude<CodingTaskPriceBasis, "unpriced">>();
  let completionEvidenceComplete = true;
  let costEvidenceComplete = true;
  let usageEvidenceComplete = true;
  let completed = 0;
  let totalCostUsd = 0;
  let totalTokens = 0;

  if (attempts.length === 0) {
    completionEvidenceComplete = false;
    costEvidenceComplete = false;
    usageEvidenceComplete = false;
  }

  for (const attempt of attempts) {
    if (attempt.taskId.trim() === "" || attempt.attemptId.trim() === "") {
      issues.add("attempt_identity_missing");
    }
    const attemptKey = `${attempt.taskId}\0${attempt.attemptId}`;
    if (attemptIDs.has(attemptKey)) issues.add("attempt_identity_duplicate");
    attemptIDs.add(attemptKey);
    if (attempt.provider.trim() === "" || attempt.model.trim() === "") {
      issues.add("runtime_identity_missing");
    } else {
      identities.add(`${attempt.provider}\0${attempt.model}`);
    }
    if (attempt.completionBasis !== "external_verifier") {
      completionEvidenceComplete = false;
      issues.add("completion_evidence_missing");
    } else if (attempt.completed) {
      completed += 1;
    }
    if (attempt.costUsd === null || !Number.isFinite(attempt.costUsd) || attempt.costUsd < 0 ||
        attempt.priceBasis === "unpriced") {
      costEvidenceComplete = false;
      issues.add("cost_evidence_missing");
    } else {
      totalCostUsd += attempt.costUsd;
      pricedBases.add(attempt.priceBasis);
    }
    if (attempt.tokens === null || !Number.isSafeInteger(attempt.tokens) || attempt.tokens < 0 ||
        attempt.usageBasis !== "provider_reported") {
      usageEvidenceComplete = false;
      issues.add("usage_evidence_missing");
    } else {
      totalTokens += attempt.tokens;
    }
  }
  if (identities.size > 1) issues.add("runtime_identity_drift");
  if (!Number.isFinite(totalCostUsd)) {
    costEvidenceComplete = false;
    issues.add("cost_evidence_missing");
  }
  if (!Number.isSafeInteger(totalTokens)) {
    usageEvidenceComplete = false;
    issues.add("usage_evidence_missing");
  }
  if (pricedBases.size > 1) {
    costEvidenceComplete = false;
    issues.add("price_basis_mixed");
  }
  const denominatorKnown = completionEvidenceComplete && identities.size === 1 && attempts.length > 0 &&
    !issues.has("attempt_cardinality_mismatch") &&
    !issues.has("attempt_identity_missing") && !issues.has("attempt_identity_duplicate") &&
    !issues.has("runtime_identity_missing") && !issues.has("runtime_identity_drift");
  const metricAvailable = denominatorKnown && completed > 0;
  const roundedCost = costEvidenceComplete ? roundTaskMetric(totalCostUsd) : null;
  const roundedTokens = usageEvidenceComplete ? totalTokens : null;
  const status = issues.size > 0
    ? "incomplete_evidence"
    : completed === 0 ? "no_completed_tasks" : "complete";
  const identity = identities.size === 1 ? [...identities][0]!.split("\0") : [];
  return Object.freeze({
    status,
    attempted: attempts.length,
    completed,
    completionRate: denominatorKnown ? completed / attempts.length : null,
    totalCostUsd: roundedCost,
    costPerCompletedTaskUsd: metricAvailable && roundedCost !== null
      ? roundTaskMetric(totalCostUsd / completed)
      : null,
    priceBasis: costEvidenceComplete && pricedBases.size === 1 ? [...pricedBases][0]! : null,
    totalTokens: roundedTokens,
    tokensPerCompletedTask: metricAvailable && roundedTokens !== null
      ? roundTaskMetric(totalTokens / completed)
      : null,
    usageBasis: usageEvidenceComplete ? "provider_reported" : null,
    provider: identity[0] ?? null,
    model: identity[1] ?? null,
    issues: Object.freeze([...issues].sort()),
  });
}

function roundTaskMetric(value: number): number {
  return Number(value.toFixed(12));
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionMode = "optimized" | "observe-only";

export interface CodingSessionOptions {
  conversation?: ConversationState;
  cave?: "auto" | "off";
  gatewayURL?: string;
  engineBin?: string;
  workflow?: string;
  /** Defaults to long: coding sessions commonly outlive providers' short cache TTL. */
  cacheRetention?: CacheRetention;
  /** Best-effort local spend cap in USD at public catalog list prices. */
  maxCostUsd?: number;
  /** Hard per-turn task budget. Mutually exclusive with maxCostUsd. */
  budget?: RunBudget;
  /** Same-provider selector invoked at every root working model-call boundary. */
  modelRouter?: ModelCallRouter;
  /** Per-turn loop/no-progress/fan-out policy. Defaults to CODING_RUN_BREAKERS. */
  breakers?: RunBreakers;
  /** Receives every notice, including the observe-only banner. */
  onNotice?: (line: string) => void;
  /** Test seam: passed through to the gateway readiness probe. */
  fetch?: typeof globalThis.fetch;
  ensureRuntime?: boolean;
  /** Runtime memory adapters. Session creates/reuses local engine when omitted. */
  memory?: MemoryRuntimeConfig;
}

export interface TurnBill {
  turn: number;
  mode: SessionMode;
  provider: string;
  model: string;
  /** Per-kind context tokens for this run, from `RunResult.contextBill`. */
  contextBill: Record<string, number>;
  /** Sum of `transformTrace[].beforeTokens` over applied transforms. */
  transformedTokensBefore: number;
  /** Sum of `transformTrace[].afterTokens` over applied transforms. */
  transformedTokensAfter: number;
  /** before − after. A local token estimate, never a dollar figure. */
  tokensSavedInferred: number;
  /** The basis of before/after/saved. Never blended across bases. */
  tokensBasis: TransformTrace["tokensBasis"];
  transformIDs: string[];
  transformFailures: string[];
  recoveryResolved: boolean;
  usageBasis: RunResult["usageBasis"];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported cached share of all input tokens; null without complete usage. */
  cacheInputTokenHitRatio: number | null;
  cacheHitTarget: number;
  cacheHitTargetMet: boolean | null;
  costUsd: number;
  priceBasis: RunResult["priceBasis"];
  latencyMs: number;
}

export interface TurnRecord {
  input: string;
  text: string;
  toolCalls: string[];
  bill: TurnBill;
  /** True when this turn is the one that took the session to observe-only. */
  degraded: boolean;
  /** Canonical economic receipt returned by the same runtime result. */
  receipt: RunReceipt;
}

export interface FailedStreamingTurn {
  readonly failed: true;
  readonly receipt: RunReceipt;
}

export type StreamingCodingTurnResult = TurnRecord | FailedStreamingTurn;

export interface CodingSession {
  readonly agent: CodingAgent;
  readonly conversation: ConversationState;
  readonly options: CodingSessionOptions;
  readonly gatewayURL: string;
  /**
   * The route resolved once, at session start. Every turn is handed this
   * instead of re-probing, so a session makes exactly one runtime-ensure
   * attempt however many turns it runs.
   */
  readonly route: ResolvedCaveRoute;
  mode: SessionMode;
  /** Every notice emitted, banner included. The loud fallback leaves a record. */
  readonly notices: string[];
  readonly turns: TurnRecord[];
  proofShown: boolean;
}

function codingMemoryRuntime(
  codingAgent: CodingAgent,
  config: MemoryRuntimeConfig | undefined,
): MemoryRuntimeConfig | undefined {
  const definition = codingAgent.definition.memory;
  if (definition === undefined) {
    if (config !== undefined) throw new Error("cave_memory_definition_required");
    return undefined;
  }
  if (config?.engine !== undefined) return config;
  const tenant = config?.tenant ?? "_";
  const engine = createMemoryEngine({
    scope: {
      tenant,
      agentId: codingAgent.definition.id,
      namespace: definition.namespace,
    },
    storage: config?.storage ?? createFileMemoryAdapter(
      config?.root === undefined ? {} : { root: config.root },
    ),
    ttlMs: memoryTTLMilliseconds(definition.ttl),
    recallTokens: definition.recallBudget,
    ambient: definition.ambient,
    ...(config?.embedding === undefined ? {} : { embedding: config.embedding }),
    ...(config?.sidecar === undefined ? {} : { sidecar: config.sidecar }),
    ...(config?.onError === undefined ? {} : { onError: config.onError }),
    ...(config?.allowStore === undefined ? {} : { allowStore: config.allowStore }),
  });
  return Object.freeze({
    ...(config ?? {}),
    tenant,
    engine,
  });
}

/**
 * Start a session in the best mode this machine can actually deliver.
 *
 * With `cave: "auto"` this probes the local Cave runtime and starts it when it
 * is installed but not running, so a machine with the engine present is
 * optimized from the first turn. When the probe fails, the session degrades to
 * observe-only **loudly**: the banner is emitted through `onNotice` and recorded
 * on the session, and every turn afterwards reports `observe-only`.
 *
 * The probe happens **once**. Its answer is kept on the session and handed to
 * every turn, so a machine with no runtime pays one failed start attempt for the
 * whole session rather than one per turn.
 */
export async function startCodingSession(
  codingAgent: CodingAgent,
  options: CodingSessionOptions = {},
): Promise<CodingSession> {
  const gatewayURL = resolveGatewayURL(options.gatewayURL);
  const route = await resolveCaveRoute(gatewayURL, {
    ...(options.cave === undefined ? {} : { cave: options.cave }),
    ...(options.ensureRuntime === undefined ? {} : { ensureRuntime: options.ensureRuntime }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    billingProofRequired: options.maxCostUsd !== undefined || options.budget?.maxUsd !== undefined,
  }, false);
  const memory = codingMemoryRuntime(codingAgent, options.memory);
  const normalizedOptions: CodingSessionOptions = memory === undefined
    ? options
    : { ...options, memory };
  const session: CodingSession = {
    agent: codingAgent,
    conversation: normalizedOptions.conversation ?? createConversation(),
    options: normalizedOptions,
    gatewayURL,
    route,
    mode: "optimized",
    notices: [],
    turns: [],
    proofShown: false,
  };
  if (!route.useGateway) degrade(session);
  return session;
}

/**
 * The route a turn actually runs on. Session mode governs: once a session has
 * degraded, degradation is sticky, so a stored route that still says "gateway"
 * never resurrects an observe-only session.
 */
function turnRoute(session: CodingSession): ResolvedCaveRoute {
  return session.mode === "optimized" ? session.route : { useGateway: false };
}

function degrade(session: CodingSession): void {
  if (session.mode === "observe-only") return;
  session.mode = "observe-only";
  session.notices.push(OBSERVE_ONLY_BANNER);
  session.options.onNotice?.(OBSERVE_ONLY_BANNER);
}

/**
 * A run that carries a plan refuses to degrade silently — it throws
 * `cave_gateway_required_for_locked_plan` instead. That specific failure, and
 * only that failure, earns one retry without the plan.
 *
 * A session answers the routing question once and pins it, so a turn is never
 * the thing that discovers an absent gateway; this classification is what turns
 * that refusal into a sticky session degradation wherever it still comes from.
 */
export function classifyTurnFailure(error: unknown): "degrade_to_observe_only" | "fatal" {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("cave_gateway_required_for_locked_plan")
    ? "degrade_to_observe_only"
    : "fatal";
}

function withProgrammaticTransport(
  codingAgent: CodingAgent,
  options: RunOptions,
): RunOptions {
  const runtime = codingAgent.programmaticTools;
  if (runtime === undefined) return options;
  if (options.streamFn !== undefined) {
    return { ...options, streamFn: runtime.wrapStreamFn(options.streamFn) };
  }
  return {
    ...options,
    models: runtime.wrapModels(options.models ?? builtinModels()),
  };
}

export async function runCodingTurn(
  session: CodingSession,
  input: string,
  overrides: RunOptions = {},
): Promise<TurnRecord> {
  // `overrides` is caller input reaching an internal run path, so it faces the
  // same guard the public entry points apply — before the session's own plan and
  // route are merged in, which are the very fields the guard forbids a caller
  // from forging.
  rejectInternalRunOptions(overrides);
  const runtimeOwnedRoute = overrides.streamFn === undefined;
  const base: RunOptions & { caveRoute: ResolvedCaveRoute } = {
    rootDir: session.agent.workspace,
    conversation: session.conversation,
    workflow: session.options.workflow ?? session.agent.definition.id,
    gatewayURL: session.gatewayURL,
    ...(session.options.cave === undefined ? {} : { cave: session.options.cave }),
    ...(session.options.engineBin === undefined ? {} : { engineBin: session.options.engineBin }),
    cacheRetention: session.options.cacheRetention ?? "long",
    ...(session.options.maxCostUsd === undefined ? {} : { maxCostUsd: session.options.maxCostUsd }),
    ...(session.options.budget === undefined ? {} : { budget: session.options.budget }),
    ...(session.options.modelRouter === undefined ? {} : { modelRouter: session.options.modelRouter }),
    breakers: session.options.breakers ?? CODING_RUN_BREAKERS,
    ...(session.options.fetch === undefined ? {} : { fetch: session.options.fetch }),
    ...(session.options.ensureRuntime === undefined
      ? {}
      : { ensureRuntime: session.options.ensureRuntime }),
    ...(session.options.memory === undefined ? {} : { memory: session.options.memory }),
    ...overrides,
    // Last, so the session's route wins over anything an override says about
    // routing: the session probed once and its mode governs from then on.
    caveRoute: turnRoute(session),
  };
  const prepared = withProgrammaticTransport(session.agent, base);
  const startedOptimized = session.mode === "optimized";
  let result: RunResult;
  if (startedOptimized && runtimeOwnedRoute) {
    try {
      result = await runAgentInternal(session.agent.definition, input, {
        ...prepared,
        candidatePlan: session.agent.plan,
      });
    } catch (error) {
      if (classifyTurnFailure(error) === "fatal") throw error;
      degrade(session);
      result = await runAgentInternal(session.agent.definition, input, {
        ...prepared,
        caveRoute: turnRoute(session),
      });
    }
  } else {
    result = await runAgentInternal(session.agent.definition, input, prepared);
  }
  // Runtime-owned routing is authoritative for session health. A caller stream
  // override is honestly observe-only for that bill, but says nothing about the
  // pinned gateway route used by later turns.
  if (runtimeOwnedRoute && result.mode === "observe-only") degrade(session);
  return recordCodingTurn(session, input, result, startedOptimized);
}

function recordCodingTurn(
  session: CodingSession,
  input: string,
  result: RunResult,
  startedOptimized: boolean,
): TurnRecord {
  const record: TurnRecord = {
    input,
    text: result.text,
    toolCalls: result.toolCalls,
    bill: turnBill(session.turns.length + 1, result),
    degraded: startedOptimized && session.mode === "observe-only",
    receipt: result.receipt,
  };
  session.turns.push(record);
  return record;
}

type CodingStreamSignal =
  | { type: "runtime"; attempt: number; event: CavemanRunEvent }
  | { type: "runtime.done"; attempt: number }
  | { type: "runtime.error"; attempt: number; error: unknown }
  | { type: "queue"; state: AgentRunQueueState };

/** One sequence owner per session, retained without changing public session shape. */
const pebbleEncoders = new WeakMap<CodingSession, PebbleEventEncoder>();

function pebbleEncoder(session: CodingSession): PebbleEventEncoder {
  const existing = pebbleEncoders.get(session);
  if (existing !== undefined) return existing;
  const created = new PebbleEventEncoder(session.conversation.sessionId);
  pebbleEncoders.set(session, created);
  return created;
}

export interface StreamingCodingTurnOptions {
  /** Caller overrides face the same internal-option rejection as runCodingTurn. */
  overrides?: RunOptions;
  /** Shared kernel queue/control handle. A fresh handle is created when omitted. */
  controller?: AgentRunController;
}

/**
 * Stream one coding turn as frozen Pebble v1 events.
 *
 * Pi deltas and tool rows pass through live. Provider usage is emitted once per
 * assistant message. A gateway-plan refusal is retried observe-only without
 * painting a transient error; terminal errors appear exactly once after retry.
 */
export async function* streamCodingTurn(
  session: CodingSession,
  input: string,
  options: StreamingCodingTurnOptions = {},
): AsyncGenerator<TurnEvent, StreamingCodingTurnResult | undefined> {
  const overrides = options.overrides ?? {};
  rejectInternalRunOptions(overrides);
  const runtimeOwnedRoute = overrides.streamFn === undefined;
  const controller = options.controller ?? new AgentRunController();
  const encoder = pebbleEncoder(session);
  const signals: CodingStreamSignal[] = [];
  let wake: (() => void) | undefined;
  let activeIterator: AsyncIterator<CavemanRunEvent> | undefined;
  const push = (signal: CodingStreamSignal): void => {
    signals.push(signal);
    wake?.();
    wake = undefined;
  };
  const unsubscribe = controller.subscribe((state) => push({ type: "queue", state }));
  let lastQueue = "";
  const startedOptimized = session.mode === "optimized";
  let attempt = 0;
  const durable = overrides.durable !== undefined;

  yield encoder.event({ kind: "turn.start" });

  try {
    for (;;) {
      const base: RunOptions & { caveRoute: ResolvedCaveRoute } = {
        rootDir: session.agent.workspace,
        // Durable execution owns and restores its own conversation journal.
        // Attaching the live session conversation would make crash resume
        // ambiguous, so one task uses exactly one state owner.
        ...(durable ? {} : { conversation: session.conversation }),
        workflow: session.options.workflow ?? session.agent.definition.id,
        gatewayURL: session.gatewayURL,
        ...(session.options.cave === undefined ? {} : { cave: session.options.cave }),
        ...(session.options.engineBin === undefined ? {} : { engineBin: session.options.engineBin }),
        cacheRetention: session.options.cacheRetention ?? "long",
        ...(session.options.maxCostUsd === undefined ? {} : { maxCostUsd: session.options.maxCostUsd }),
        ...(session.options.budget === undefined ? {} : { budget: session.options.budget }),
        ...(session.options.modelRouter === undefined ? {} : { modelRouter: session.options.modelRouter }),
        breakers: session.options.breakers ?? CODING_RUN_BREAKERS,
        ...(session.options.fetch === undefined ? {} : { fetch: session.options.fetch }),
        ...(session.options.ensureRuntime === undefined
          ? {}
          : { ensureRuntime: session.options.ensureRuntime }),
        ...(session.options.memory === undefined ? {} : { memory: session.options.memory }),
        ...overrides,
        caveRoute: turnRoute(session),
        controller,
      };
      const prepared = withProgrammaticTransport(session.agent, base);
      const runtime = streamAgentInternalOptions(session.agent.definition, input, {
        ...prepared,
        ...(session.mode === "optimized" && attempt === 0 && !durable && runtimeOwnedRoute
          ? { candidatePlan: session.agent.plan }
          : {}),
      });
      const iterator = runtime[Symbol.asyncIterator]();
      activeIterator = iterator;
      const currentAttempt = attempt;
      void (async () => {
        try {
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            push({ type: "runtime", attempt: currentAttempt, event: next.value });
          }
          push({ type: "runtime.done", attempt: currentAttempt });
        } catch (error) {
          push({ type: "runtime.error", attempt: currentAttempt, error });
        }
      })();

      let retry = false;
      for (;;) {
        if (signals.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
        const signal = signals.shift()!;
        if (signal.type === "queue") {
          const key = `${signal.state.queued}:${signal.state.heldAfterInterrupt}`;
          if (key !== lastQueue) {
            lastQueue = key;
            yield encoder.event({
              kind: "queue.changed",
              queued: signal.state.queued,
              heldAfterInterrupt: signal.state.heldAfterInterrupt,
            });
          }
          continue;
        }
        if (signal.attempt !== currentAttempt) continue;
        if (signal.type === "runtime.error") {
          const message = signal.error instanceof Error
            ? signal.error.message
            : String(signal.error);
          yield encoder.event({ kind: "error", message, retryable: false });
          yield encoder.event({ kind: "turn.end", stopReason: "error" });
          return undefined;
        }
        if (signal.type === "runtime.done") {
          // A well-formed runtime always yields run_end or run_error first.
          yield encoder.event({
            kind: "error",
            message: "cave_pebble_runtime_ended_without_terminal_event",
            retryable: false,
          });
          yield encoder.event({ kind: "turn.end", stopReason: "error" });
          return undefined;
        }
        const event = signal.event;
        if (event.type === "run_error") {
          if (attempt === 0 && startedOptimized && runtimeOwnedRoute &&
              classifyTurnFailure(event.message) === "degrade_to_observe_only") {
            degrade(session);
            retry = true;
            attempt++;
            break;
          }
          for (const translated of encodeRunEvent(encoder, event)) yield translated;
          return { failed: true, receipt: event.receipt };
        }
        if (event.type === "run_end") {
          if (runtimeOwnedRoute && event.result.mode === "observe-only") degrade(session);
          for (const translated of encodeRunEvent(encoder, event)) yield translated;
          return recordCodingTurn(session, input, event.result, startedOptimized);
        }
        for (const translated of encodeRunEvent(encoder, event)) yield translated;
      }
      if (!retry) return undefined;
    }
  } finally {
    unsubscribe();
    await activeIterator?.return?.();
  }
}

function turnBill(turn: number, result: RunResult): TurnBill {
  const applied = result.transformTrace.filter((item) => item.outcome === "applied");
  // A token delta is only meaningful within one basis; refuse to blend
  // byte-derived and engine-counted figures into a single reduction.
  const bases = new Set(applied.map((item) => item.tokensBasis));
  if (bases.size > 1) throw new Error("cave_transform_trace_basis_mixed");
  const tokensBasis: TransformTrace["tokensBasis"] = applied[0]?.tokensBasis ?? "byte_derived";
  const before = applied.reduce((sum, item) => sum + item.beforeTokens, 0);
  const after = applied.reduce((sum, item) => sum + item.afterTokens, 0);
  const cache = analyzeProviderCachePerformance([{
    usageBasis: result.usageBasis,
    inputTokens: result.inputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
  }]);
  return {
    turn,
    mode: result.mode,
    provider: result.provider,
    model: result.model,
    contextBill: result.contextBill,
    transformedTokensBefore: before,
    transformedTokensAfter: after,
    // The reduction is the delta of what was ACTUALLY SENT, so a barely-
    // compressible turn whose wrapper cost more than it saved reports zero
    // rather than a phantom positive; the raw before/after stay exposed.
    tokensSavedInferred: Math.max(0, before - after),
    tokensBasis,
    transformIDs: result.transformIDs,
    transformFailures: result.transformFailures,
    recoveryResolved: result.recoveryResolved,
    usageBasis: result.usageBasis,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
    cacheInputTokenHitRatio: cache.cacheInputTokenHitRatio,
    cacheHitTarget: cache.target,
    cacheHitTargetMet: cache.targetMet,
    costUsd: result.costUsd,
    priceBasis: result.priceBasis,
    latencyMs: result.latencyMs,
  };
}

export interface SessionBill {
  turns: number;
  mode: SessionMode;
  transformedTokensBefore: number;
  transformedTokensAfter: number;
  tokensSavedInferred: number;
  /** The basis of the summed reduction. Never blended across bases. */
  tokensBasis: TransformTrace["tokensBasis"];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-reported cached share across all session input, including cold seeds. */
  cacheInputTokenHitRatio: number | null;
  cacheHitTarget: number;
  cacheHitTargetMet: boolean | null;
  costUsd: number;
  priceBasis: RunResult["priceBasis"];
  usageBasis: RunResult["usageBasis"];
  transformIDs: string[];
  transformFailures: string[];
}

export function sessionBill(session: CodingSession): SessionBill {
  const bills = session.turns.map((item) => item.bill);
  const sum = (pick: (bill: TurnBill) => number) =>
    bills.reduce((total, bill) => total + pick(bill), 0);
  const transformIDs = [...new Set(bills.flatMap((bill) => bill.transformIDs))].sort();
  const failures = [...new Set(bills.flatMap((bill) => bill.transformFailures))].sort();
  // Refuse to sum a reduction across mixed token bases.
  const bases = new Set(bills.map((bill) => bill.tokensBasis));
  if (bases.size > 1) throw new Error("cave_transform_trace_basis_mixed");
  const tokensBasis: TransformTrace["tokensBasis"] = bills[0]?.tokensBasis ?? "byte_derived";
  const cache = analyzeProviderCachePerformance(bills.map((bill) => ({
    usageBasis: bill.usageBasis,
    inputTokens: bill.inputTokens,
    cacheReadTokens: bill.cacheReadTokens,
    cacheWriteTokens: bill.cacheWriteTokens,
  })), CODING_CACHE_INPUT_TOKEN_HIT_TARGET);
  return {
    turns: bills.length,
    mode: session.mode,
    transformedTokensBefore: sum((bill) => bill.transformedTokensBefore),
    transformedTokensAfter: sum((bill) => bill.transformedTokensAfter),
    tokensSavedInferred: sum((bill) => bill.tokensSavedInferred),
    tokensBasis,
    inputTokens: sum((bill) => bill.inputTokens),
    outputTokens: sum((bill) => bill.outputTokens),
    cacheReadTokens: sum((bill) => bill.cacheReadTokens),
    cacheWriteTokens: sum((bill) => bill.cacheWriteTokens),
    cacheInputTokenHitRatio: cache.cacheInputTokenHitRatio,
    cacheHitTarget: cache.target,
    cacheHitTargetMet: cache.targetMet,
    costUsd: sum((bill) => bill.costUsd),
    // A session with no turns has no basis to report. `every` on an empty list
    // is true, which would have labelled a zero nobody measured as a catalog
    // price from provider-reported usage; the honest zero says the basis is
    // absent instead.
    priceBasis: bills.length > 0 && bills.every((bill) => bill.priceBasis === "public_catalog")
      ? "public_catalog"
      : "unpriced",
    usageBasis: bills.length > 0 && bills.every((bill) => bill.usageBasis === "provider_reported")
      ? "provider_reported"
      : "unavailable",
    transformIDs,
    transformFailures: failures,
  };
}

// ---------------------------------------------------------------------------
// Printing. Context reductions are local token estimates; spend is shown
// separately at public catalog prices.
// ---------------------------------------------------------------------------

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function cacheHitLine(
  ratio: number | null,
  target: number,
  targetMet: boolean | null,
): string {
  if (ratio === null || targetMet === null) {
    return "  cache input-token hit ratio: unavailable — complete provider usage required";
  }
  return `  cache input-token hit ratio: ${(ratio * 100).toFixed(2)}% ·` +
    ` target ${(target * 100).toFixed(2)}% ${targetMet ? "met" : "missed"}` +
    " — provider-reported; cold seeds included";
}

export function formatTurnBill(bill: TurnBill, sessionSaved: number): string[] {
  const lines = [
    `turn ${bill.turn} · ${bill.mode} · ${bill.provider}/${bill.model} · ${count(bill.latencyMs)} ms`,
  ];
  if (bill.mode === "observe-only") {
    lines.push("  context transforms: off (observe-only) — provider usage and local context estimates remain available");
  } else if (bill.transformIDs.length === 0) {
    lines.push("  context transforms: none applied this turn (nothing was smaller compressed)");
  } else {
    lines.push(`  context transforms: ${bill.transformIDs.join(", ")}`);
    lines.push(
      `  transformed context: ${count(bill.transformedTokensBefore)} tokens before` +
      ` → ${count(bill.transformedTokensAfter)} after`,
    );
  }
  lines.push(
    `  tokens saved: ${count(bill.tokensSavedInferred)} this turn ·` +
    ` ${count(sessionSaved)} this session — local estimate, token counts only`,
  );
  lines.push(
    `  provider usage (${bill.usageBasis}): in ${count(bill.inputTokens)} ·` +
    ` out ${count(bill.outputTokens)} · cache read ${count(bill.cacheReadTokens)} ·` +
    ` cache write ${count(bill.cacheWriteTokens)}`,
  );
  lines.push(cacheHitLine(
    bill.cacheInputTokenHitRatio,
    bill.cacheHitTarget,
    bill.cacheHitTargetMet,
  ));
  lines.push(
    `  spend: ${bill.costUsd.toFixed(6)} USD measured at public catalog list prices` +
    ` (${bill.priceBasis})`,
  );
  if (bill.transformFailures.length > 0) {
    lines.push(`  transform fell back to original: ${bill.transformFailures.join(", ")}`);
  }
  return lines;
}

export function formatSessionBill(bill: SessionBill): string[] {
  // Nothing ran, so nothing is reported: printing basis-labelled zeros would
  // claim a measurement — a catalog price, provider-reported usage — for calls
  // that never happened.
  if (bill.turns === 0) {
    return [
      `session · 0 turns · ${bill.mode}`,
      "  no provider calls this session — nothing measured, nothing claimed",
    ];
  }
  return [
    `session · ${bill.turns} turn${bill.turns === 1 ? "" : "s"} · ${bill.mode}`,
    bill.transformIDs.length === 0
      ? "  context transforms: none applied"
      : `  context transforms: ${bill.transformIDs.join(", ")}`,
    `  transformed context: ${count(bill.transformedTokensBefore)} tokens before` +
    ` → ${count(bill.transformedTokensAfter)} after`,
    `  tokens saved: ${count(bill.tokensSavedInferred)} — local estimate,` +
    " token counts only; no provider savings claim",
    `  provider usage (${bill.usageBasis}): in ${count(bill.inputTokens)} ·` +
    ` out ${count(bill.outputTokens)} · cache read ${count(bill.cacheReadTokens)} ·` +
    ` cache write ${count(bill.cacheWriteTokens)}`,
    cacheHitLine(
      bill.cacheInputTokenHitRatio,
      bill.cacheHitTarget,
      bill.cacheHitTargetMet,
    ),
    `  spend: ${bill.costUsd.toFixed(6)} USD measured at public catalog list prices` +
    ` (${bill.priceBasis})`,
  ];
}

// ---------------------------------------------------------------------------
// Recovery proof
// ---------------------------------------------------------------------------

export interface CodingRecoveryProof extends SegmentRecoveryProof {
  segment: string;
}

/**
 * Take the largest raw tool output this session produced, push it through the
 * same engine compress/retrieve pair the plan and `cave_retrieve` use, and
 * compare bytes. This is the reversibility proof, not a savings claim.
 */
export async function proveRecovery(session: CodingSession): Promise<CodingRecoveryProof> {
  const sample = session.agent.samples[0];
  if (!sample) throw new Error("caveman-code: no tool output recorded yet to prove recovery on");
  const proof = await proveSegmentRecovery({
    body: new TextEncoder().encode(sample.text),
    transformID: TOOL_RESULT_TRANSFORM,
    ...(session.options.engineBin === undefined ? {} : { engineBin: session.options.engineBin }),
  });
  return { ...proof, segment: sample.label };
}

export function formatRecoveryProof(proof: CodingRecoveryProof): string {
  if (proof.outcome === "recovered") {
    return `recovery proof: ${proof.segment} round-trip OK (sha256 match ${proof.originalSHA256.slice(0, 12)})`;
  }
  if (proof.outcome === "not_smaller") {
    return `recovery proof: ${proof.segment} not compressed — the engine kept the original bytes, nothing to recover`;
  }
  return `recovery proof: ${proof.segment} FAILED (sha256 mismatch) — the plan falls back to the original body`;
}

// ---------------------------------------------------------------------------
// Interactive loop
// ---------------------------------------------------------------------------

const HELP = [
  "/tokens          session token bill so far",
  "/prove-recovery  compress one recorded tool output and recover it byte-exactly",
  "/mode            show whether this session is optimized or observe-only",
  "/help            this list",
  "/exit            end the session and print the final bill",
].join("\n");

export interface CodingSessionRunOptions extends CodingSessionOptions {
  agent?: CodingAgent;
  agentOptions?: CodingAgentOptions;
  input?: Readable;
  output?: Writable;
  notice?: Writable;
  /** Test and demo seam: per-turn run option overrides, e.g. a faux model. */
  runOverrides?: RunOptions;
}

/** Interactive coding session over stdin/stdout. Returns the final bill. */
export async function runCodingSession(
  options: CodingSessionRunOptions = {},
): Promise<SessionBill> {
  // Fail before a session (and its runtime probe) is started rather than on the
  // first turn: forged build identity, plan, or routing is never a live option.
  if (options.runOverrides !== undefined) rejectInternalRunOptions(options.runOverrides);
  const out = options.output ?? process.stdout;
  const notice = options.notice ?? process.stderr;
  const write = (value: string) => out.write(`${value}\n`);
  const ownsCodingAgent = options.agent === undefined;
  const codingAgent = options.agent ?? createCodingAgent(options.agentOptions ?? {});
  const sessionOptions: CodingSessionOptions = {
    ...(options.conversation === undefined ? {} : { conversation: options.conversation }),
    ...(options.cave === undefined ? {} : { cave: options.cave }),
    ...(options.gatewayURL === undefined ? {} : { gatewayURL: options.gatewayURL }),
    ...(options.engineBin === undefined ? {} : { engineBin: options.engineBin }),
    ...(options.cacheRetention === undefined ? {} : { cacheRetention: options.cacheRetention }),
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
    ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.modelRouter === undefined ? {} : { modelRouter: options.modelRouter }),
    ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.ensureRuntime === undefined ? {} : { ensureRuntime: options.ensureRuntime }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    onNotice: (line) => {
      notice.write(`${line}\n`);
      options.onNotice?.(line);
    },
  };
  const session = await startCodingSession(codingAgent, sessionOptions);
  write(`caveman-code · ${codingAgent.modelID} · workspace ${codingAgent.workspace}`);
  write(`mode: ${session.mode}${session.mode === "optimized"
    ? " — reversible context transforms on (history + tool results)"
    : ""}`);
  write(HELP);
  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: out,
  });
  // The async iterator applies backpressure per line, so a piped script and an
  // interactive terminal behave the same and end-of-input ends the session.
  const prompt = () => out.write(`\nagent [${session.mode}] > `);
  try {
    prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === "/exit" || line === "/quit") break;
      if (line === "") {
        prompt();
        continue;
      }
      if (line === "/help") {
        write(HELP);
      } else if (line === "/mode") {
        write(`mode: ${session.mode}`);
      } else if (line === "/tokens") {
        for (const value of formatSessionBill(sessionBill(session))) write(value);
      } else if (line === "/prove-recovery") {
        await showProof(session, write);
      } else {
        try {
          const turn = await runCodingTurn(session, line, options.runOverrides ?? {});
          write("");
          write(turn.text);
          write("");
          const saved = sessionBill(session).tokensSavedInferred;
          for (const value of formatTurnBill(turn.bill, saved)) write(value);
          if (!session.proofShown && turn.bill.transformIDs.length > 0) {
            await showProof(session, write);
          }
        } catch (error) {
          write(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      prompt();
    }
  } finally {
    rl.close();
    try {
      await session.options.memory?.engine?.endSession(session.conversation.sessionId);
    } finally {
      if (ownsCodingAgent) await codingAgent.close();
    }
  }
  const final = sessionBill(session);
  write("");
  for (const value of formatSessionBill(final)) write(value);
  return final;
}

async function showProof(
  session: CodingSession,
  write: (value: string) => void,
): Promise<void> {
  try {
    write(formatRecoveryProof(await proveRecovery(session)));
    session.proofShown = true;
  } catch (error) {
    write(`recovery proof unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
