import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { autoCredentialModel, hostByDefault } from "./defaults.js";
import {
  Type,
  type Api,
  type AssistantMessage,
  type CacheRetention,
  type Context,
  type ImageContent,
  type Model,
  type Models,
  type ProviderHeaders,
  type TextContent,
  type TSchema,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { Value } from "typebox/value";
import {
  agentDefinitionSHA256,
  parseAnyCaveBuildLock,
  toolDefinitionSHA256,
  type AnyCaveBuildLock,
  type CavePlan,
} from "./build.js";
import { CachePlanEngine, optimizeNativeRequest } from "./cache-planner/index.js";
import {
  BudgetMeter,
  ReceiptRecorder,
  bindBudgetController,
  budgetExhaustionContext,
  callCeilingCost,
  callFitsBudget,
  inputTokenCeiling,
  modelIsPriced,
  normalizeRunBudget,
  planCall,
  serializedContextBytes,
  unbindBudgetController,
  type BudgetController,
  type BudgetExhaustionHandler,
  type BudgetReservation,
  type CallCeiling,
  type ReceiptCompaction,
  type ReceiptResume,
  type RunBudget,
  type RunReceipt,
  type RunStopReason,
} from "./budget.js";
import {
  DURABLE_JOURNAL_VERSION,
  DiskDurableStore,
  DurableJournal,
  DurableToolCoordinator,
  analyzeJournal,
  durableConversationCheckpoint,
  MULTIMODAL_DURABLE_INPUT_PREFIX,
  durableConversationMessagesSHA256,
  validateDurableRunId,
  type DurableConversationCheckpoint,
  type DurableJournalState,
  type DurableResumeState,
  type DurableRunOptions,
  type DurableStore,
  type DurableToolInvocation,
} from "./durable.js";
import {
  BreakerState,
  normalizeRunBreakers,
  type RunBreakers,
} from "./breakers.js";
import { CATALOG_SHA256, catalogSearchCeiling } from "./catalog.js";
import { executeConnectTool } from "./connect.js";
import { findPackageJSONCompat } from "./node-compat.js";
import {
  SUMMARY_SCHEMA_VERSION,
  contextSummarySources,
  elidedDigest,
  evictMessage,
  latestContextSummary,
  messagesTokens,
  newContextMessages,
  parseContextSummary,
  planCompaction,
  renderSummary,
  summarizationInstruction,
  validateContextSummaryTransition,
  type ContextSummary,
} from "./compaction.js";
import {
  graphHasUnverifiedToolSchemaSemantics,
  validateAgentGraph,
} from "./definition-graph.js";
import {
  lowerAgentContext,
  prepareLockedHarnessExecution,
  validatePlanSelection,
  validateProviderUsage,
  type ValidatedProviderUsage,
} from "./execution-kernel.js";
import {
  FRAMEWORK_VERSION,
  PI_ADAPTER_VERSION,
  PI_UPSTREAM_VERSION,
} from "./runtime-identity.js";
import type { AgentDefinition } from "./index.js";
import {
  appendRuntimeContextSegment,
  contextBill,
  sha256,
  stableStringify,
  type ContextIR,
  type LoweredContext,
} from "./context-ir.js";
import {
  memoryTTLMilliseconds,
  type NestedToolDispatchOptions,
  type SubagentRuntimeDefinition,
  type ToolDefinition,
  type ToolExecutionContext,
} from "./primitives.js";
import {
  executeRawTool,
  settleToolOutput,
  settledToolOutputFromTransport,
  type SettledToolOutput,
} from "./tool-internal.js";
import {
  ProgrammaticSpeculationScope,
  programmaticToolMetadata,
} from "./programmatic-tools.js";
import {
  createFileMemoryAdapter,
} from "./memory-store.js";
import {
  createMemoryEngine,
  type MemoryEngine,
  type MemoryRuntimeConfig,
} from "./memory.js";
import { selectSandboxBackend } from "./sandbox/backend.js";
import {
  decodeResultFrame,
  installSandboxReaping,
  killSandboxProcess,
  liveSandboxChildren,
  redactSandboxError,
  sandboxSourceReadFlags,
  type SandboxResultFrame,
} from "./sandbox/worker-transport.js";
import { startEgressProxy, type EgressProxy } from "./sandbox/egress-proxy.js";
import { sandboxEgressEnv } from "./sandbox/egress-client.js";
import { resolveEgressPolicy, type SandboxEgressPolicy } from "./sandbox/policy.js";
import { killProcessTree, portableInvocation } from "./portable-process.js";
import { expandSourceGraph } from "./source-graph.js";
import {
  normalizeAgentInput,
  type AgentInput,
} from "./input.js";
import {
  SANDBOX_CREDENTIAL_ENV_BY_CAPABILITY,
  buildSandboxToolEnv,
  mergeSandboxToolEnv,
  type SandboxCredentialCapability,
} from "./sandbox-credentials.js";
import {
  resolveCaveRoute,
  resolveGatewayURL,
  type ResolvedCaveRoute,
} from "./gateway.js";

// Compaction needs room for its own same-model call plus useful work after the
// rewrite. Waiting until the next call no longer fits makes that inequality
// impossible, so default-on compaction starts while four cold next-call
// ceilings remain. Every call still reserves and settles against the hard cap.
const COMPACTION_TRIGGER_MULTIPLIER = 4;

export type CavemanRunEvent =
  | { type: "run_start"; runId: string; agentId: string }
  | { type: "context_ready"; runId: string; contextIR: ContextIR; bill: Record<string, number> }
  | { type: "model_route"; runId: string; decision: ModelCallRouteDecision }
  | { type: "pi"; runId: string; event: AgentEvent }
  | { type: "nested_tool_start"; runId: string; id: string; name: string; args: unknown }
  | { type: "nested_tool_end"; runId: string; id: string; name: string; isError: boolean; result: unknown }
  | { type: "run_end"; runId: string; result: RunResult }
  // A run that fails still carries its ledger: `receipt` is the
  // partial receipt built from the same ReceiptRecorder the run_end path uses,
  // so the calls, tools, and metered spend that DID happen before the failure
  // are never lost. It is always present.
  | { type: "run_error"; runId: string; code: string; message: string; receipt: RunReceipt };

export { AgentRunController } from "./run-controller.js";
export type { AgentRunQueueState } from "./run-controller.js";
import { AgentRunController } from "./run-controller.js";
import { decideToolCall, type ToolCallPolicy } from "./tool-policy.js";

/**
 * The error thrown by the promise-returning run entry points (`runAgent`,
 * `runAgentInternal`) when a run fails. Unlike a bare `Error`, it carries the
 * failing run's partial `receipt` so a caller that only awaits the promise —
 * never consuming the event stream — can still read the ledger of what was
 * spent before the failure. The `cave_*` code is on `code`.
 */
export class CavemanRunError extends Error {
  readonly code: string;
  readonly receipt: RunReceipt;
  constructor(code: string, message: string, receipt: RunReceipt) {
    super(`${code}: ${message}`);
    this.name = "CavemanRunError";
    this.code = code;
    this.receipt = receipt;
    this.cause = receipt;
  }
}

export interface RunResult<TOutput = unknown> {
  runId: string;
  agentId: string;
  text: string;
  /**
   * The final message parsed against `definition.output.schema`. Present only
   * when a schema is declared and the text validated against it; absent when
   * the run stopped before a final message.
   */
  output?: TOutput;
  contextIR: ContextIR;
  contextBill: Record<string, number>;
  cachePrefixSHA256: string;
  cacheBoundaryKnown: boolean;
  cacheBust: boolean;
  usageBasis: "provider_reported" | "unavailable";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Only interpret reasoningTokens when this basis is provider_reported. */
  reasoningUsageBasis: "provider_reported" | "unavailable";
  reasoningTokens: number;
  costUsd: number;
  /**
   * How costUsd was arrived at. `unpriced` means at least one accumulated model
   * call had no public-catalog price, so costUsd is an honest zero-contribution
   * for that call rather than a measured amount — never read it as "$0 spent".
   */
  priceBasis: "public_catalog" | "unpriced";
  /**
   * `optimized` means every model call this run made — its own and every
   * subagent's — actually went through the Caveman gateway, so transforms and
   * gateway telemetry were available to all of it. `observe-only` means at least
   * one call went straight to the provider: either the gateway was unreachable
   * or `cave: "off"`, or the model's provider is not one the gateway proxies
   * (only anthropic, openai, and google are). A mixed graph reports
   * `observe-only`; the label under-claims rather than averaging, because the
   * gateway measured nothing about the calls that bypassed it. Local results are
   * estimates in both modes; no provider savings claim is made.
   */
  mode: "optimized" | "observe-only";
  provider: string;
  model: string;
  latencyMs: number;
  toolCalls: string[];
  evaluatedTransformIDs: string[];
  transformIDs: string[];
  transformFailures: string[];
  transformTrace: TransformTrace[];
  recoveryResolved: boolean;
  /**
   * Why the run stopped issuing calls. `complete` is the ordinary end of the
   * agent loop. Every other value means the runtime stopped between calls with
   * partial work in hand: the text, usage, and cost above cover exactly the
   * calls that did happen, and no call was interrupted mid-flight.
   */
  stopReason: RunStopReason;
  /**
   * True when measured spend crossed the budget's `max`, here or in any
   * subagent wallet beneath this run.
   *
   * It sits beside `stopReason` because the two answer different questions: a
   * run can stop cleanly at its cap, or stop having already gone past it, and
   * a caller switching on `stopReason` alone cannot tell those apart. The
   * runtime never chooses to spend past max — this means a provider reported
   * more than the hold could bound.
   */
  capBreached: boolean;
  /**
   * Signed amount **this run's own meter** went past its `max`, zero when its
   * own cap held. `capBreached` rolls up from subagents; this figure does not,
   * because settling a carve books the child's real spend here too and adding
   * both would count the same money twice. Each subagent's own amount is on
   * its receipt under `receipt.subagents`.
   */
  overspent: number;
  /**
   * This run's economic receipt: every provider call, every tool, every
   * subagent's own receipt, and the budget's tranche history. Its money figures
   * are estimated public-catalog list-price subtotals, never invoices.
   */
  receipt: RunReceipt;
  claimBasis: "inferred";
  unlocked: boolean;
  /**
   * True when this durable run resumed from a prior attempt's journal. Its
   * usage and cost totals cover the whole logical run — prior attempts
   * included — and `receipt.resume` summarizes what happened before this
   * process, including any in-flight call the crash made unaccountable.
   */
  resumed?: boolean;
}

export interface TransformTrace {
  segmentKind: string;
  transformID: string;
  safetyClass: string;
  /**
   * Tokens before and after this transform. `afterTokens` for an applied
   * transform is measured from the BYTES ACTUALLY SENT — the full provider body
   * including the framework's own `<cave-compressed …>` wrapper and instruction
   * line — never the engine's count of the compressed payload alone.
   * Both figures share `tokensBasis`; a delta is only meaningful within one
   * basis, so consumers must not sum across bases.
   */
  beforeTokens: number;
  afterTokens: number;
  /**
   * How `beforeTokens`/`afterTokens` were counted. `byte_derived` is bytes/4 of
   * the real payloads; `engine_counted` is the engine's own tokenizer. A
   * reduction summed across mixed bases is invalid — callers refuse to blend them.
   */
  tokensBasis: "byte_derived" | "engine_counted";
  recoveryKind: string;
  recoveryUsed: boolean;
  latencyMs: number;
  outcome: "applied" | "not_smaller" | "failed_open";
}

type MutableTransformTrace = TransformTrace & { recoveryHandle?: string };
type ProviderFrozenView = {
  api: string;
  bytes: Uint8Array;
  fields: Record<string, unknown>;
  messageField?: "messages" | "input" | "contents" | "context.messages";
  messagePrefix?: unknown[];
};

interface InternalConversationState {
  messages: AgentMessage[];
  sessionId: string;
  busy: boolean;
  fingerprint?: string;
  cachePrefixDigest?: string;
  providerFrozen?: ProviderFrozenView;
  originalFrozen?: ProviderFrozenView;
}

const conversationStates = new WeakMap<Conversation, InternalConversationState>();

export class Conversation {
  readonly sessionId: string;

  constructor() {
    this.sessionId = `conversation-${crypto.randomUUID()}`;
    conversationStates.set(this, {
      messages: [],
      sessionId: this.sessionId,
      busy: false,
    });
  }

  snapshot(): { readonly messages: readonly unknown[] } {
    const state = conversationStates.get(this);
    if (!state) throw new Error("cave_conversation_invalid");
    return Object.freeze({ messages: structuredClone(state.messages) });
  }
}

export type ConversationState = Conversation;

export function createConversation(): Conversation {
  return new Conversation();
}

/**
 * Rebuild a conversation from a journaled checkpoint. The digest is
 * recomputed and must match: a checkpoint that cannot be reproduced byte for
 * byte is not a conversation this runtime will continue.
 */
export function restoreConversation(checkpoint: DurableConversationCheckpoint): Conversation {
  const restored = createConversation();
  const state = conversationStates.get(restored);
  const canonical = durableConversationCheckpoint(checkpoint.sessionId, checkpoint.messages);
  if (state === undefined || canonical.messagesSha256 !== checkpoint.messagesSha256) {
    throw new Error("cave_session_conversation_unrecoverable");
  }
  Object.defineProperty(restored, "sessionId", { value: canonical.sessionId });
  state.sessionId = canonical.sessionId;
  state.messages = structuredClone(canonical.messages) as typeof state.messages;
  return restored;
}

export interface ModelCallRouteInput {
  /** Zero-based root provider-call index, including paid compactions. */
  readonly callIndex: number;
  readonly role: "working" | "compaction";
  readonly provider: string;
  readonly currentModel: string;
  /** Conservative serialized-context ceiling used by wallet admission. */
  readonly ctxTokens: number;
  readonly hasImages: boolean;
  readonly toolErrorStreak: number;
  readonly previousUsage?: {
    readonly model: string;
    /** Uncached provider input. Optional for compatibility with older routers. */
    readonly inputTokens?: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  };
}

export interface ModelCallRouteDecision {
  /** Full `provider/model` identity. V1 routing cannot cross providers. */
  readonly model: string;
  readonly reason: string;
  readonly signals: readonly string[];
}

export type ModelCallRouter = (
  input: ModelCallRouteInput,
) => ModelCallRouteDecision | Promise<ModelCallRouteDecision>;

type ConversationTransaction = {
  readonly owner: Conversation;
  readonly sessionId: string;
  messages: AgentMessage[];
  fingerprint: string | undefined;
  cachePrefixDigest: string | undefined;
  providerFrozen: ProviderFrozenView | undefined;
  originalFrozen: ProviderFrozenView | undefined;
};

function beginConversation(owner: Conversation): ConversationTransaction {
  const state = conversationStates.get(owner);
  if (!state) throw new Error("cave_conversation_invalid");
  if (state.busy) throw new Error("cave_conversation_in_use");
  const transaction: ConversationTransaction = {
    owner,
    sessionId: state.sessionId,
    messages: structuredClone(state.messages),
    fingerprint: state.fingerprint,
    cachePrefixDigest: state.cachePrefixDigest,
    providerFrozen: state.providerFrozen === undefined
      ? undefined
      : structuredClone(state.providerFrozen),
    originalFrozen: state.originalFrozen === undefined
      ? undefined
      : structuredClone(state.originalFrozen),
  };
  state.busy = true;
  return transaction;
}

function commitConversation(
  transaction: ConversationTransaction,
  next: {
    messages: AgentMessage[];
    fingerprint: string | undefined;
    cachePrefixDigest: string | undefined;
    providerFrozen: ProviderFrozenView | undefined;
    originalFrozen: ProviderFrozenView | undefined;
  },
): void {
  const state = conversationStates.get(transaction.owner);
  if (!state || !state.busy) throw new Error("cave_conversation_invalid");
  const prepared = {
    messages: structuredClone(next.messages),
    providerFrozen: next.providerFrozen === undefined
      ? undefined
      : structuredClone(next.providerFrozen),
    originalFrozen: next.originalFrozen === undefined
      ? undefined
      : structuredClone(next.originalFrozen),
  };
  state.messages = prepared.messages;
  setOptional(state, "fingerprint", next.fingerprint);
  setOptional(state, "cachePrefixDigest", next.cachePrefixDigest);
  setOptional(state, "providerFrozen", prepared.providerFrozen);
  setOptional(state, "originalFrozen", prepared.originalFrozen);
}

function endConversation(transaction: ConversationTransaction): void {
  const state = conversationStates.get(transaction.owner);
  if (state) state.busy = false;
}

function setOptional<
  T extends object,
  K extends keyof T,
>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function validateModelRouteDecision(decision: ModelCallRouteDecision): void {
  if (decision === null || typeof decision !== "object" ||
      typeof decision.model !== "string" || decision.model.trim() === "" ||
      typeof decision.reason !== "string" || decision.reason.trim() === "" ||
      !Array.isArray(decision.signals) ||
      decision.signals.some((signal) => typeof signal !== "string" || signal.trim() === "")) {
    throw new Error("cave_model_route_decision_invalid");
  }
}

function messageHasImage(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.content)) return false;
  return value.content.some((block) =>
    isRecord(block) && block.type === "image" &&
    typeof block.data === "string" && typeof block.mimeType === "string"
  );
}

// Durable turn checkpoints admit 8 MiB of canonical message data. Keep 1 MiB
// for assistant/tool output so oversized inline media refuses before traffic.
const DURABLE_MULTIMODAL_PROMPT_MAX_BYTES = 7 * 1024 * 1024;

interface PreparedRuntimeInput {
  readonly contextInput: unknown;
  readonly durableInput: string;
  readonly memoryText: string;
  readonly promptContent?: readonly (TextContent | ImageContent)[];
  readonly inputProviderVisibleBytes?: number;
  readonly inputOpaque?: boolean;
}

/**
 * Pi accepts ordered text plus inline base64 images. Every other normalized
 * part fails before run state, budget reservation, journal writes, or provider
 * traffic. URL retrieval stays provider/host-owned and is never smuggled into
 * this adapter.
 */
function prepareRuntimeInput(input: AgentInput, durable: boolean): PreparedRuntimeInput {
  const normalized = normalizeAgentInput(input);
  if (typeof input === "string") {
    if (durable && input.startsWith(MULTIMODAL_DURABLE_INPUT_PREFIX)) {
      throw new Error("cave_durable_input_reserved_prefix");
    }
    if (durable) assertDurableProspectiveConversation([], input, undefined);
    return Object.freeze({
      contextInput: input,
      durableInput: input,
      memoryText: input,
    });
  }

  const unsupported: number[] = [];
  const promptContent: (TextContent | ImageContent)[] = [];
  const contextParts: unknown[] = [];
  const memoryText: string[] = [];
  let providerVisibleBytes = 64;
  let hasImages = false;
  for (let index = 0; index < normalized.parts.length; index++) {
    const part = normalized.parts[index]!;
    if (part.type === "text") {
      promptContent.push(Object.freeze({ type: "text", text: part.text }));
      contextParts.push(Object.freeze({ type: "text", text: part.text }));
      memoryText.push(part.text);
      providerVisibleBytes += Buffer.byteLength(part.text, "utf8") + 32;
      continue;
    }
    if (part.type === "image" && part.source.type === "base64") {
      hasImages = true;
      const contentSHA256 = sha256(part.source.data);
      promptContent.push(Object.freeze({
        type: "image",
        data: part.source.data,
        mimeType: part.mimeType,
      }));
      contextParts.push(Object.freeze({
        type: "image",
        mimeType: part.mimeType,
        source: Object.freeze({
          type: "base64-sha256",
          bytes: Buffer.byteLength(part.source.data, "base64"),
          sha256: contentSHA256,
        }),
      }));
      memoryText.push(`[image:${part.mimeType}:sha256:${contentSHA256}]`);
      providerVisibleBytes += Buffer.byteLength(part.source.data, "utf8") +
        Buffer.byteLength(part.mimeType, "utf8") + 64;
      continue;
    }
    unsupported.push(index);
  }
  if (unsupported.length > 0) {
    throw new Error(`cave_input_unsupported:pi:${unsupported.join(",")}`);
  }
  const contextInput = Object.freeze({
    schemaVersion: 1,
    parts: Object.freeze(contextParts),
  });
  const canonicalContextInput = stableStringify(contextInput);
  const prepared = Object.freeze({
    contextInput,
    durableInput: `${MULTIMODAL_DURABLE_INPUT_PREFIX}${sha256(canonicalContextInput)}`,
    memoryText: memoryText.join("\n").slice(0, 1_000_000),
    promptContent: Object.freeze(promptContent),
    ...(hasImages ? {
      inputProviderVisibleBytes: Math.max(
        providerVisibleBytes,
        Buffer.byteLength(canonicalContextInput, "utf8"),
      ),
      inputOpaque: true,
    } : {}),
  });
  if (durable) assertDurableProspectiveConversation([], input, prepared);
  return prepared;
}

function assertDurableProspectiveConversation(
  previous: readonly unknown[],
  input: AgentInput,
  prepared: PreparedRuntimeInput | undefined,
): void {
  const userMessage = prepared?.promptContent === undefined
    ? { role: "user", content: input as string, timestamp: Number.MAX_SAFE_INTEGER }
    : {
      role: "user",
      content: [...prepared.promptContent],
      timestamp: Number.MAX_SAFE_INTEGER,
    };
  let serialized: string;
  try {
    serialized = JSON.stringify([...previous, userMessage]);
  } catch {
    throw new Error("cave_durable_input_bytes_limit");
  }
  if (Buffer.byteLength(serialized, "utf8") > DURABLE_MULTIMODAL_PROMPT_MAX_BYTES) {
    throw new Error("cave_durable_input_bytes_limit");
  }
}

export interface RunOptions {
  rootDir?: string;
  workflow?: string;
  sessionId?: string;
  /** Provider-native prompt-cache retention. Generic runs inherit Pi's short default. */
  cacheRetention?: CacheRetention;
  gatewayURL?: string;
  ensureRuntime?: boolean;
  /**
   * How this run treats the Caveman gateway. `auto` (default) routes through it
   * and, when the local gateway cannot be reached, degrades to observe-only:
   * the provider's own base URL, no transforms, no gateway telemetry, and
   * `RunResult.mode: "observe-only"`. `off` never contacts or starts the
   * gateway. A run carrying a Cave Build lock or candidate plan never degrades
   * silently — it fails with `cave_gateway_required_for_locked_plan` instead.
   */
  cave?: "auto" | "off";
  /**
   * Best-effort local spend cap for this run, in USD at public catalog list
   * prices. It is not financial enforcement: no provider invoice, no
   * platform quota, and no reservation outside this process is involved. Unset
   * leaves the run bounded only by its model/tool call ceilings.
   * When set, every root and descendant model call reserves the catalog
   * worst-case price of the call against the cap before the provider request
   * and settles measured catalog cost after it. Exhaustion terminates the run
   * with `cave_run_cost_budget_exceeded` before the next model call; partial
   * records stay in the emitted events and no `run_end` result is produced.
   * A model the public catalog cannot price cannot be capped: with the cap set,
   * such a call fails closed with `cave_subagent_unpriced_budget` rather than
   * consuming $0 of budget. Runs on unpriced models must stay uncapped and rely
   * on call ceilings instead.
   */
  maxCostUsd?: number;
  /**
   * The run's budget contract. Declares exactly one denomination:
   * `maxUsd` at public catalog list prices, or `maxTokens` in provider-counted
   * tokens. A denomination this runtime cannot honestly meter fails closed
   * before the first provider call — `maxUsd` needs a catalog-priced model,
   * because a cap that cannot be measured is not a cap.
   *
   * Enforcement is reserve-and-clamp with one mode and no soft option. Before
   * every provider call the runtime holds that call's worst-case price against
   * the budget; when the remainder cannot cover the configured output
   * allowance it clamps the call's output down to what the remainder affords,
   * and below the output floor it stops. Stopping is a normal result carrying
   * `stopReason`, never a throw: an in-flight call always finishes and is
   * counted, and the runtime never stops mid-tool.
   *
   * The guarantee, exactly: **the runtime never CHOOSES to spend past `max`.**
   * Every call is held at its worst case first, and that hold bounds the
   * payload that actually leaves. When a provider nonetheless reports more
   * than could be bounded, the run settles at the TRUE amount — a ledger that
   * clamps what a call cost is a fake ledger — sets `capBreached` with a
   * signed `overspent` on the result and its receipt, and stops. A breach is
   * loud and terminal; `spent > max` never appears without that flag, and the
   * flag rolls up from any subagent wallet that breached beneath the run.
   *
   * Unlike `maxCostUsd`, which terminates the run with an error, a budget is a
   * planned end state. The two are mutually exclusive.
   */
  budget?: RunBudget;
  /**
   * Optional pre-call model selector. It runs before every root working model
   * request, before budget reservation and before provider I/O. Returned models
   * must exist in the configured Pi catalog and stay within the initial
   * provider; unknown or cross-provider decisions fail closed.
   */
  modelRouter?: ModelCallRouter;
  /**
   * Escape hatch for the credential-regime gate. A USD budget on
   * Pi's own transport, off the gateway, is refused when the local credential
   * store cannot prove the credential is a metered API key — an unprovable
   * regime fails closed rather than booking fictional dollars against what may
   * be a subscription. Set this to `true` to assert, on your own authority,
   * that the credential IS metered per token, so a dollar budget is honest.
   * Ignored for a caller-supplied `streamFn` and for an actually routed gateway
   * whose identified readiness response proves `billing: "managed"`. BYOK or
   * unknown gateway billing still uses this local credential assertion.
   */
  assumeMeteredCredential?: boolean;
  /**
   * Where durable agent memory lives, and for whom. `memory()`
   * entries persist to a per-namespace file scoped by (tenant, agentId,
   * namespace), so a `ttl: "30d"` is a real 30-day promise across process
   * restarts. Set `root` to point an embedding server at its own location, and
   * `tenant` to isolate one tenant's memories from another's even when they
   * share an agent id and namespace. Defaults: `CAVE_AGENT_MEMORY_ROOT` or
   * `~/.caveman/agent-memory`, single-tenant.
   */
  memory?: MemoryRuntimeConfig;
  /**
   * Handle for releasing staged budget during this run. Pair it
   * with `budget.initialUsd` / `budget.initialTokens`: the run starts metered
   * against the initial tranche, and the developer's own checkpoint logic calls
   * `releaseBudget(amount, reason)` to hand it more, up to `max`. Nothing the
   * model produces can reach it.
   */
  budgetController?: BudgetController;
  /**
   * What happens when the budget binds. `"stop"` is the default:
   * stop between calls, return partial work plus the receipt. A handler may
   * release one numeric tranche through the budget controller or stop. It sees
   * only meter figures, runs between calls with nothing in flight, and never
   * receives prompt, output, tool, or model content.
   *
   * Continuation never crosses `max`: a handler that asks for more than the
   * contract allows throws at the release, exactly as a checkpoint would.
   */
  onBudgetExhausted?: "stop" | BudgetExhaustionHandler;
  /**
   * Wall-clock allowance for this run in milliseconds, enforced at the same
   * between-calls points as the budget: the runtime finishes what is in flight,
   * declines to start another call, and returns `stopReason: "deadline"`.
   */
  deadlineMs?: number;
  /**
   * How deep a subagent graph this run may spawn, counted from the root. The
   * default is deliberately small: delegation multiplies spend, so a graph that
   * wants to go deeper says so. Capped at {@link ABSOLUTE_SUBAGENT_DEPTH_LIMIT}.
   */
  maxSubagentDepth?: number;
  /**
   * Opt-in root-tree ceiling on admitted subagent invocations. One shared
   * monotonic counter covers every subagent tool and every descendant depth;
   * failures and aborts still consume an admission once the child starts.
   * Unset preserves per-tool `maxCalls` behavior with no tree-wide total.
   */
  maxSubagentInvocations?: number;
  /**
   * Opt-in root-tree ceiling on simultaneously active descendants. Reservation
   * is synchronous and released on success, failure, or abort. Unset preserves
   * existing behavior with no tree-wide concurrency ceiling.
   */
  maxConcurrentSubagents?: number;
  /**
   * Hard ceiling on the number of provider model calls this run may issue
   * Defaults to 64. When the run reaches it, the runtime stops
   * gracefully between calls with `stopReason: "call_budget_exhausted"` — the
   * partial text, usage, and receipt are returned, never a throw that would
   * destroy the ledger of what was already spent. An efficiency-plan run
   * derives a tighter default from its retry-cascade reserve; a caller value
   * here always overrides. Must be a positive integer.
   */
  maxModelCalls?: number;
  /**
   * Hard ceiling on the number of tool calls this run may issue.
   * Defaults to 64. A tool call beyond it is blocked (the model sees a blocked
   * result and the run continues), never a throw. An efficiency-plan run
   * derives its default from the model-call ceiling and tool count; a caller
   * value here always overrides. Must be a positive integer.
   */
  maxToolCalls?: number;
  /**
   * Deterministic circuit breakers: repeated-tool-call loop
   * detection, a no-progress window, a per-turn fan-out cap, and cost-aware
   * retry. Opt-in — a run that declares none behaves exactly as before, because
   * a false loop break is worse than the loop it thought it saw. Breaking is a
   * between-calls stop like any other, with `stopReason: "loop_detected"` or
   * `"no_progress"` and the offending window on the receipt.
   */
  breakers?: RunBreakers;
  /**
   * Print the end-of-run receipt to stdout and write its JSON under
   * `rootDir/.caveman/runs/`. Off by default: stdout may be a protocol
   * channel (an MCP server, a pipe) that receipt text would corrupt.
   * Directory-loaded agents (`loadAgentDir`) default it ON so the scaffold
   * keeps the receipt with zero config; an explicit value always wins.
   */
  printReceipt?: boolean;
  /**
   * Opt-in durable execution. The run journals its ledger and turn state as
   * it goes (append-only JSONL, disk by default under
   * `rootDir/.caveman/runs/durable/<runId>/`); a crashed or cancelled run
   * called again with the same `runId` RESUMES from the last completed turn
   * instead of starting over — settled spend is never re-reserved and never
   * lost, and a completed run returns its journaled result without spending
   * again. Honest ceiling (at-least-once): a crash mid-provider-call can
   * leave one in-flight call the provider may have billed but whose usage
   * this ledger never saw; resume surfaces it as
   * `receipt.resume.possibleDoubleCountCalls` rather than guessing. That
   * figure counts RESERVED provider calls, not HTTP attempts — a breaker
   * retry cascade inside one reserved call is one intent. A replayed
   * terminal outcome yields only `run_start` then `run_end`/`run_error`
   * (no `context_ready`).
   * The journal contains message content (a resume needs the conversation),
   * unlike the content-blind receipt — the disk store writes 0o700/0o600.
   * A supplied `conversation` is bound by exact session and base-message
   * digest. Completed replay synchronizes it without appending input twice;
   * concurrent reuse fails before journal mutation. Tool intents fsync before
   * I/O. Read tools may redrive, idempotent tools receive a stable key, and an
   * unmatched write/external intent fails closed. Still not combinable with
   * `maxCostUsd` (use `budget`); durability is a root-run contract and child
   * evidence shares its journal. Breaker windows restart on resume.
   */
  durable?: DurableRunOptions;
  /**
   * Host-owned authorization for every declared tool call, decided outside
   * model output (the Claude Agent SDK `canUseTool` shape). Runs after the
   * kernel's own admission (deadline, budget, caps, breakers, sandbox posture,
   * argument shape) for root, subagent, and nested composite calls alike;
   * framework `cave_*` tools are not gated. `{ deny: code }` blocks the call:
   * the model reads `cave_tool_denied:<code>` as the tool result, the receipt
   * counts it under `denied`, and the run continues. A policy that throws,
   * hangs past 10s, or returns a malformed decision ends the run with
   * `cave_tool_policy_failed`: unknown authorization state never executes a
   * tool. Evaluated again on durable resume, before replay: denying a call the
   * crashed attempt already settled ends the resume fail-closed
   * (`cave_durable_tool_replay_incomplete`), never as a quiet skip. A policy
   * cannot rewrite arguments.
   */
  toolPolicy?: ToolCallPolicy;
  model?: Model<Api>;
  models?: Models;
  streamFn?: StreamFn;
  providerPayloadContract?: "pi-on-payload-v1";
  conversation?: Conversation;
  fetch?: typeof globalThis.fetch;
  entryPath?: string;
  engineBin?: string;
  signal?: AbortSignal;
  /** Optional queue/steering/interrupt handle for an active Pi run. */
  controller?: AgentRunController;
  sandboxProfile?: {
    /**
     * Egress for contained tools, in three values:
     *
     * - `false` — no network at all. The kernel removes every route out.
     * - a {@link SandboxEgressPolicy} — scoped egress. The child still has no
     *   network stack; its only peer is a parent-owned proxy that dials the
     *   allowlisted hosts and refuses everything else. Requires a backend that
     *   can provide a reachable proxy path, else
     *   `cave_sandbox_scoped_egress_unavailable`.
     * - `true` — unbounded egress. Still FAILS CLOSED with
     *   `cave_sandbox_network_egress_unbounded`: tool code holding a provider
     *   credential does not get an unfiltered socket. Name the hosts instead.
     *
     * The proxy does not terminate TLS, so it constrains the destination the
     * client names, never the bytes inside the tunnel.
     */
    network: boolean | SandboxEgressPolicy;
    childProcess: boolean;
    credentialEnv: readonly string[];
  };
}

// Re-exported so `@caveman-ai/agent/dist/runtime.js` stays the single import
// site these have always had; the definitions live in the split modules.
export {
  SANDBOX_CREDENTIAL_ENV_BY_CAPABILITY,
  buildSandboxToolEnv,
  validateSandboxCredentialEnv,
} from "./sandbox-credentials.js";
export { sandboxSourceReadFlags } from "./sandbox/worker-transport.js";
export {
  buildRuntimeControlEnv,
  caveGatewayReady,
  ensureCaveRuntime,
  proxyBinaryCandidates,
  resolveCaveRoute,
  resolveGatewayURL,
  type ResolvedCaveRoute,
} from "./gateway.js";

interface InternalRunOptions extends RunOptions {
  lockedBuild?: AnyCaveBuildLock;
  candidatePlan?: CavePlan;
  /**
   * Resolved once per root run and handed to descendants so a nested agent
   * neither re-probes the gateway nor disagrees with its parent about whether
   * this run is optimized or observe-only.
   */
  caveRoute?: ResolvedCaveRoute;
  /** Framework-owned invocation identity. Public callers may not inject it. */
  invocationTrace?: InvocationTrace;
}

type InvocationTrace = {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly startTimeUnixNano: string;
  readonly batch: InvocationSpanBatch;
  /** Present only on child invocations; advisory state declared by this runtime. */
  readonly guardManifest?: InvocationGuardManifest;
};

type InvocationGuardDimension = "active" | "absent" | "unknown";
type InvocationChildSpendGuard = "usd_pre_call" | "tokens_pre_call" | "unknown";
type InvocationRootBudgetGuard = "usd" | "tokens" | "legacy_usd" | "absent" | "unknown";
type InvocationTreeGuard = "active" | "absent";

/** Bounded categorical controls declared by this client runtime at admission. */
type InvocationGuardManifest = {
  readonly schemaVersion: "2";
  readonly basis: "client_runtime_declared";
  readonly framework: "caveman_agent";
  readonly childCalls: InvocationGuardDimension;
  readonly childSpend: InvocationChildSpendGuard;
  readonly childContext: InvocationGuardDimension;
  readonly depth: InvocationGuardDimension;
  readonly rootBudget: InvocationRootBudgetGuard;
  readonly turnFanout: InvocationGuardDimension;
  readonly modelCalls: InvocationGuardDimension;
  readonly toolCalls: InvocationGuardDimension;
  readonly treeInvocations: InvocationTreeGuard;
  readonly treeConcurrency: InvocationTreeGuard;
};

type InvocationOTLPSpan = {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  events: never[];
  status: { code: 0 | 1 | 2 };
};

type InvocationSpanBatch = {
  readonly rootAgentId: string;
  readonly rootWorkflow: string;
  readonly rootSessionId: string;
  readonly apiKey?: string;
  readonly gatewayURL: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly rootBudgetGuard: InvocationRootBudgetGuard;
  readonly treeInvocationsGuard: InvocationTreeGuard;
  readonly treeConcurrencyGuard: InvocationTreeGuard;
  readonly subagentAdmissions: SubagentAdmissionLedger;
  readonly spans: InvocationOTLPSpan[];
  droppedSpans: number;
  flushScheduled: boolean;
};

type InvocationSpanRecord = {
  readonly trace: InvocationTrace;
  readonly agentId: string;
  readonly depth: number;
};

const INVOCATION_EXPORT_TIMEOUT_MS = 250;
const INVOCATION_BATCH_MAX_SPANS = 1_024;

/** Nothing in this framework nests deeper than this, whatever a caller asks for. */
export const ABSOLUTE_SUBAGENT_DEPTH_LIMIT = 8;

/** A root tree cannot opt into an admission counter larger than this. */
export const ABSOLUTE_SUBAGENT_INVOCATION_LIMIT = 65_536;

/** A root tree cannot opt into more simultaneously active descendants than this. */
export const ABSOLUTE_CONCURRENT_SUBAGENT_LIMIT = 1_024;

/** Default recursion depth for subagent graphs: root spawns child spawns grandchild. */
const DEFAULT_SUBAGENT_DEPTH_LIMIT = 2;

/** Root-owned mutable admission state shared across every descendant depth. */
class SubagentAdmissionLedger {
  readonly maxInvocations: number | undefined;
  readonly maxConcurrent: number | undefined;
  private total = 0;
  private active = 0;
  private peakActive = 0;
  private invocationLimitRejections = 0;
  private concurrencyLimitRejections = 0;

  constructor(maxInvocations?: number, maxConcurrent?: number) {
    validateSubagentTreeLimit(
      maxInvocations,
      ABSOLUTE_SUBAGENT_INVOCATION_LIMIT,
      "cave_subagent_invocation_limit_invalid",
    );
    validateSubagentTreeLimit(
      maxConcurrent,
      ABSOLUTE_CONCURRENT_SUBAGENT_LIMIT,
      "cave_subagent_concurrency_limit_invalid",
    );
    this.maxInvocations = maxInvocations;
    this.maxConcurrent = maxConcurrent;
  }

  admit(): () => void {
    if (this.maxInvocations !== undefined && this.total >= this.maxInvocations) {
      this.invocationLimitRejections += 1;
      throw new Error("cave_subagent_invocation_limit");
    }
    if (this.maxConcurrent !== undefined && this.active >= this.maxConcurrent) {
      this.concurrencyLimitRejections += 1;
      throw new Error("cave_subagent_concurrency_limit");
    }
    this.total += 1;
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  outcomes(): {
    readonly admittedDescendants: number;
    readonly peakActiveDescendants: number;
    readonly invocationLimitRejections: number;
    readonly concurrencyLimitRejections: number;
  } {
    return {
      admittedDescendants: this.total,
      peakActiveDescendants: this.peakActive,
      invocationLimitRejections: this.invocationLimitRejections,
      concurrencyLimitRejections: this.concurrencyLimitRejections,
    };
  }
}

function validateSubagentTreeLimit(
  value: number | undefined,
  absoluteLimit: number,
  code: string,
): void {
  if (value !== undefined &&
      (!Number.isSafeInteger(value) || value <= 0 || value > absoluteLimit)) {
    throw new Error(code);
  }
}

type SpendLedger = {
  readonly limitUsd: number;
  readonly maxContextTokens: number;
  readonly exceededCode: string;
  actualUsd: number;
  reservedUsd: number;
  incomplete: boolean;
};

type SpendReservation = {
  readonly ledger: SpendLedger;
  readonly ceilingUsd: number;
  readonly provider: string;
  readonly model: string;
};

type InternalExecutionContext = {
  readonly rootDefinitionSha256: string;
  readonly agentPath: readonly string[];
  readonly spendLedgers: readonly SpendLedger[];
  readonly sandboxRequired: boolean;
  readonly depth: number;
  /** One shared mutable root ledger for optional caps and root-only outcomes. */
  readonly subagentAdmissions: SubagentAdmissionLedger;
  /**
   * A subagent's carved wallet. Present only on descendants: a child never
   * builds its own meter from the parent's `budget` option, it is handed the
   * wallet the parent already reserved for it.
   */
  readonly budgetMeter?: BudgetMeter;
  /**
   * The root run's absolute deadline. Descendants inherit the instant, not the
   * duration, so a deep graph cannot keep resetting the clock.
   */
  readonly deadlineAt?: number;
  /**
   * The ROOT durable journal, inherited by descendants so every provider
   * call in the tree settles into one ledger. Children emit money events
   * tagged with their agent path; only the root journals turn state.
   */
  readonly journal?: DurableJournal;
  /** Collision-resistant logical invocation path used only by durable tools. */
  readonly durablePath?: readonly string[];
  /** One root-owned coordinator shared by direct, nested, child, and sandbox paths. */
  readonly durableTools?: DurableToolCoordinator;
};

type AppliedPlan = {
  bodies: Map<string, Uint8Array>;
  evaluatedTransformIDs: string[];
  appliedTransformIDs: string[];
  failures: string[];
  trace: MutableTransformTrace[];
  recoveryResolved: boolean;
  recoveryHandles: Set<string>;
};

type SandboxSourceSnapshot = {
  readonly stagingRoot: string;
  readonly entryPath: string;
  readonly sourceFiles: readonly string[];
  dispose(): Promise<void>;
};

type NestedUsage = {
  calls: Map<string, number>;
  budgets: Map<string, SpendLedger>;
  /** Each completed subagent run's own receipt, in spawn-completion order. */
  receipts: RunReceipt[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  unpriced: boolean;
  incomplete: boolean;
  /**
   * True once any descendant run reported `observe-only`. A graph whose traffic
   * partly bypassed the gateway cannot be labelled plainly optimized, so the
   * root under-claims instead of averaging.
   */
  observeOnly: boolean;
};

function rootExecutionContext(
  definition: AgentDefinition,
  maxCostUsd?: number,
  maxSubagentInvocations?: number,
  maxConcurrentSubagents?: number,
  efficiencyPlan?: CavePlan,
): InternalExecutionContext {
  validateAgentGraph(definition);
  if (maxCostUsd !== undefined && (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0)) {
    throw new Error("caveman agent: run maxCostUsd must be positive");
  }
  const subagentAdmissions = new SubagentAdmissionLedger(
    maxSubagentInvocations,
    maxConcurrentSubagents,
  );
  return Object.freeze({
    rootDefinitionSha256: agentDefinitionSHA256(definition),
    agentPath: Object.freeze([]),
    // Root cap is one more ancestor ledger: root turns reserve against it, and
    // every descendant stacks its own ledger on top of it.
    spendLedgers: Object.freeze(maxCostUsd === undefined ? [] : [{
      limitUsd: maxCostUsd,
      maxContextTokens: efficiencyPlan === undefined
        ? Number.MAX_SAFE_INTEGER
        : planContextTokenCeiling(efficiencyPlan),
      exceededCode: "cave_run_cost_budget_exceeded",
      actualUsd: 0,
      reservedUsd: 0,
      incomplete: false,
    }]),
    sandboxRequired: definition.sandbox === "required",
    depth: 0,
    subagentAdmissions,
  });
}

export async function verifySandboxConformance(): Promise<boolean> {
  const worker = fileURLToPath(new URL("./sandbox-probe-worker.js", import.meta.url));
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const deniedRoot = await mkdtemp(`${tmpdir()}/caveman-agent-probe-`);
  const deniedFile = resolve(deniedRoot, "known-secret");
  await writeFile(deniedFile, "must-not-read");
  const nodeArgs = [
      "--permission",
      `--allow-fs-read=${packageRoot}`,
      worker,
  ];
  const isolated = selectSandboxBackend({ scopedEgress: false })
    .plan({ nodeArgs, workspace: deniedRoot });
  try {
    const result = await new Promise<Record<string, unknown>>((accept, reject) => {
      const child = spawn(isolated.command, [...isolated.args], {
      cwd: tmpdir(),
      env: {
        PATH: process.env.PATH ?? "",
        TZ: "UTC",
        CAVE_SANDBOX_HOME_PROBE: deniedFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`cave_sandbox_probe_failed:${redactSandboxError(Buffer.concat(stderr).toString("utf8"))}`));
        return;
      }
      try {
        accept(JSON.parse(Buffer.concat(stdout).toString("utf8")) as Record<string, unknown>);
      } catch {
        reject(new Error("cave_sandbox_probe_invalid_output"));
      }
    });
    });
    // Two honest ways for the read to be denied, depending on the backend:
    // the Node permission model refuses it (`ERR_ACCESS_DENIED`), or a mount
    // namespace never showed the file to the child at all (`ENOENT`). The
    // parent created the file immediately above, so `ENOENT` here can only
    // mean the namespace hid it.
    return result.home_read_denied === true &&
      (result.home_read_code === "ERR_ACCESS_DENIED" ||
        result.home_read_code === "ENOENT") &&
      result.child_process_denied === true &&
      result.network_denied === true &&
      result.dns_denied === true &&
      result.udp_denied === true;
  } finally {
    await rm(deniedRoot, { recursive: true, force: true });
  }
}

/** Package-internal harness bridge. Not exported from package entry point. */
export interface HarnessToolSandbox {
  readonly stagingRoot?: string;
  readonly entryPath?: string;
  readonly sourceFiles: readonly string[];
  readonly executionContext: InternalExecutionContext;
  dispose(): Promise<void>;
}

/** Package-internal harness bridge. Stages one immutable source graph. */
export async function prepareHarnessToolSandbox(
  definition: AgentDefinition,
  options: Pick<RunOptions, "rootDir" | "entryPath">,
): Promise<HarnessToolSandbox> {
  const executionContext = rootExecutionContext(definition);
  if (options.entryPath === undefined &&
      requiresSandboxEntry(definition, executionContext.sandboxRequired)) {
    throw new Error(
      "cave_tool_sandbox_entry_required: sandboxed tools need entryPath",
    );
  }
  if (options.entryPath === undefined) {
    return {
      sourceFiles: Object.freeze([]),
      executionContext,
      async dispose() {},
    };
  }
  const rootDir = options.rootDir ?? process.cwd();
  const requested = resolve(rootDir, options.entryPath);
  const snapshot = await stageSandboxSourceGraph(
    rootDir,
    requested,
    dirname(fileURLToPath(import.meta.url)),
  );
  return {
    stagingRoot: snapshot.stagingRoot,
    entryPath: snapshot.entryPath,
    sourceFiles: snapshot.sourceFiles,
    executionContext,
    dispose: snapshot.dispose,
  };
}

/** Package-internal harness bridge. Reuses Pi's exact tool/result policy. */
export function createHarnessToolExecutor(input: {
  definition: AgentDefinition;
  tool: ToolDefinition;
  sandbox: HarnessToolSandbox;
  sandboxProfile?: RunOptions["sandboxProfile"];
  engineBin?: string;
  providerDefinition?: { description: string; input: TSchema };
  deferLockedToolResult?: boolean;
}): (params: unknown, signal?: AbortSignal) => Promise<unknown> {
  if (input.tool.runtime?.kind === "subagent") {
    throw new Error("cave_claude_subagent_bridge_unavailable");
  }
  const sandboxExecute = input.definition.sandbox === "required"
    ? (params: unknown, signal?: AbortSignal, context?: ToolExecutionContext) => executeSandboxedTool(
      input.sandbox.entryPath!,
      input.sandbox.sourceFiles,
      input.sandbox.stagingRoot!,
      input.tool.name,
      params,
      input.tool.timeoutMs,
      true,
      input.sandboxProfile,
      input.sandbox.executionContext,
      toolDefinitionSHA256(input.tool),
      input.tool.output !== undefined,
      signal,
      context,
    )
    : undefined;
  const executor = toPiTool(
    input.tool,
    sandboxExecute,
    sandboxExecute === undefined ? undefined : "sandbox",
    new Set<string>(),
    input.engineBin,
    input.providerDefinition,
    input.deferLockedToolResult,
  );
  return (params, signal) => executor.execute("cave_harness_tool", params, signal);
}

export async function runAgent(
  definition: AgentDefinition,
  input: AgentInput,
  options: RunOptions = {},
): Promise<RunResult> {
  rejectInternalRunOptions(options);
  definition = hostByDefault(definition, options.entryPath);
  return runAgentWithOptions(
    definition,
    input,
    options,
    rootExecutionContext(
      definition,
      options.maxCostUsd,
      options.maxSubagentInvocations,
      options.maxConcurrentSubagents,
    ),
  );
}

/**
 * Execute one already-compiled Pi Cave Build from an embedded application.
 *
 * This is deliberately narrower than the package-internal runner: callers may
 * provide an immutable lock, never a candidate plan or route decision. Runtime
 * validates lock bytes, agent definition, exact runtime/adapter/upstream,
 * catalog, Context IR, selected plan, and (when transforms exist) live Engine
 * registry before provider traffic. Source/eval freshness remains the build
 * command's deployment gate; runtime behavior is rebound independently here.
 */
/**
 * Every precondition a frozen build imposes, checked once.
 *
 * Both locked entry points route through here, so a lock can never be enforced
 * on the awaited path and skipped on the streaming one.
 */
async function prepareLockedRun(
  definition: AgentDefinition,
  buildValue: AnyCaveBuildLock,
  options: RunOptions,
): Promise<{ definition: AgentDefinition; build: AnyCaveBuildLock }> {
  if (graphHasUnverifiedToolSchemaSemantics(definition)) {
    throw new Error("cave_tool_schema_semantics_unverified");
  }
  const build = parseAnyCaveBuildLock(buildValue);
  if (build.harness.id !== "pi") throw new Error("cave_locked_run_harness_unsupported");
  if (build.runtime.caveman_version !== FRAMEWORK_VERSION) {
    throw new Error("cave_locked_run_runtime_mismatch");
  }
  if (build.catalog_sha256 !== CATALOG_SHA256) {
    throw new Error("cave_locked_run_catalog_mismatch");
  }
  if (build.runtime.external_provenance_sha256 !== "") {
    throw new Error("cave_locked_run_external_provenance_unsupported");
  }
  if (build.agent_definition_sha256 !== agentDefinitionSHA256(definition)) {
    throw new Error("cave_locked_run_agent_definition_mismatch");
  }
  if (build.selected_plan.segment_routes.length > 0) {
    const registrySHA256 = await engineRegistrySHA256(options.engineBin, options.signal);
    if (registrySHA256 !== build.runtime.transform_registry_sha256) {
      throw new Error("cave_locked_run_transform_registry_mismatch");
    }
  }
  const selected = build.selected_plan;
  const lockedDefinition: AgentDefinition = Object.freeze({
    ...definition,
    model: selected.model,
    reasoning: selected.reasoning === "none" ? "off" : selected.reasoning,
  });
  return { definition: lockedDefinition, build };
}

export async function runLockedAgent(
  definition: AgentDefinition,
  input: AgentInput,
  buildValue: AnyCaveBuildLock,
  options: RunOptions = {},
): Promise<RunResult> {
  rejectInternalRunOptions(options);
  const locked = await prepareLockedRun(definition, buildValue, options);
  return runAgentInternal(locked.definition, input, {
    ...options,
    lockedBuild: locked.build,
  });
}

/**
 * Streaming counterpart to {@link runLockedAgent}. Package-internal: the lock
 * preflight is async, so unlike `streamAgent` this cannot snapshot its input at
 * call time, and callers must own the input they pass. Not exported from the
 * package entry point.
 */
export async function* streamLockedAgent(
  definition: AgentDefinition,
  input: AgentInput,
  buildValue: AnyCaveBuildLock,
  options: RunOptions = {},
): AsyncGenerator<CavemanRunEvent> {
  rejectInternalRunOptions(options);
  const locked = await prepareLockedRun(definition, buildValue, options);
  yield* streamAgentInternalOptions(locked.definition, input, {
    ...options,
    lockedBuild: locked.build,
  });
}

/** Package-internal compiler/CLI path. Not exported from package entry point. */
export async function runAgentInternal(
  definition: AgentDefinition,
  input: AgentInput,
  options: InternalRunOptions,
): Promise<RunResult> {
  return runAgentWithOptions(
    definition,
    input,
    options,
    rootExecutionContext(
      definition,
      options.maxCostUsd,
      options.maxSubagentInvocations,
      options.maxConcurrentSubagents,
      options.lockedBuild?.selected_plan ?? options.candidatePlan,
    ),
  );
}

/** Package-internal streaming compiler/CLI path. Not exported from package entry point. */
export function streamAgentInternalOptions(
  definition: AgentDefinition,
  input: AgentInput,
  options: InternalRunOptions,
): AsyncGenerator<CavemanRunEvent> {
  return streamAgentWithOptions(
    definition,
    input,
    options,
    rootExecutionContext(
      definition,
      options.maxCostUsd,
      options.maxSubagentInvocations,
      options.maxConcurrentSubagents,
      options.lockedBuild?.selected_plan ?? options.candidatePlan,
    ),
  );
}

async function runAgentWithOptions(
  definition: AgentDefinition,
  input: AgentInput,
  options: InternalRunOptions,
  executionContext: InternalExecutionContext,
): Promise<RunResult> {
  let final: RunResult | undefined;
  for await (const event of streamAgentWithOptions(
    definition,
    input,
    options,
    executionContext,
  )) {
    if (event.type === "run_end") final = event.result;
    if (event.type === "run_error") {
      // The ledger is not lost on the throwing path either: the partial receipt
      // rides on a typed `cause` so a caller that only awaits the promise can
      // still read what was spent before the failure.
      throw new CavemanRunError(event.code, event.message, event.receipt);
    }
  }
  if (!final) throw new Error("caveman agent: run ended without terminal evidence");
  return final;
}

export function streamAgent(
  definition: AgentDefinition,
  input: AgentInput,
  options: RunOptions = {},
): AsyncGenerator<CavemanRunEvent> {
  rejectInternalRunOptions(options);
  definition = hostByDefault(definition, options.entryPath);
  return streamAgentWithOptions(
    definition,
    input,
    options,
    rootExecutionContext(
      definition,
      options.maxCostUsd,
      options.maxSubagentInvocations,
      options.maxConcurrentSubagents,
    ),
  );
}

function streamAgentWithOptions(
  definition: AgentDefinition,
  input: AgentInput,
  options: InternalRunOptions,
  executionContext: InternalExecutionContext,
): AsyncGenerator<CavemanRunEvent> {
  // Snapshot caller input at stream() invocation, before consumer-controlled
  // delay to first next(). This closes stream-specific mutation/TOCTOU.
  const preparedInput = prepareRuntimeInput(input, options.durable !== undefined);
  const controller = new AbortController();
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([options.signal, controller.signal]);
  const inner = streamAgentInternal(
    definition,
    input,
    preparedInput,
    { ...options, signal },
    executionContext,
  );
  return {
    next(value?: unknown) {
      return inner.next(value);
    },
    return(value?: void) {
      controller.abort(new Error("cave_stream_cancelled"));
      return inner.return(value);
    },
    throw(error?: unknown) {
      controller.abort(error);
      return inner.throw(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<CavemanRunEvent>;
}

async function* streamAgentInternal(
  definition: AgentDefinition,
  input: AgentInput,
  preparedInput: PreparedRuntimeInput,
  options: InternalRunOptions,
  executionContext: InternalExecutionContext,
): AsyncGenerator<CavemanRunEvent> {
  if (options.cacheRetention !== undefined &&
      options.cacheRetention !== "none" &&
      options.cacheRetention !== "short" &&
      options.cacheRetention !== "long") {
    throw new Error("cave_cache_retention_invalid");
  }
  if (options.lockedBuild !== undefined && options.candidatePlan !== undefined) {
    throw new Error("cave_execution_mode_ambiguous");
  }
  if ((options.lockedBuild !== undefined || options.durable !== undefined) &&
      graphHasUnverifiedToolSchemaSemantics(definition)) {
    throw new Error("cave_tool_schema_semantics_unverified");
  }
  // Budget shape is settled before anything else happens: an ambiguous or
  // unbounded budget must fail at run() start, not after the first dollar.
  // maxCostUsd and budget are two different contracts for the same money —
  // one terminates with an error, the other returns a planned partial result —
  // so carrying both would leave the run's own stop semantics undecided.
  if (options.budget !== undefined && options.maxCostUsd !== undefined) {
    throw new Error("cave_budget_conflicting_cap");
  }
  const normalizedRunBudget = executionContext.budgetMeter !== undefined ||
      options.budget === undefined
    ? undefined
    : normalizeRunBudget(options.budget);
  const budgetMeter = executionContext.budgetMeter ?? (normalizedRunBudget === undefined
    ? undefined
    : new BudgetMeter(normalizedRunBudget));
  if (options.deadlineMs !== undefined &&
      (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= 0)) {
    throw new Error("cave_run_deadline_invalid");
  }
  if (options.maxSubagentDepth !== undefined &&
      (!Number.isSafeInteger(options.maxSubagentDepth) || options.maxSubagentDepth <= 0 ||
        options.maxSubagentDepth > ABSOLUTE_SUBAGENT_DEPTH_LIMIT)) {
    throw new Error("cave_subagent_depth_limit_invalid");
  }
  const deadlineAt = executionContext.deadlineAt ?? (options.deadlineMs === undefined
    ? undefined
    : performance.now() + options.deadlineMs);
  // A controller with nothing to release would be a silent no-op at the
  // checkpoint that expected it to matter.
  if (options.budgetController !== undefined && budgetMeter === undefined) {
    throw new Error("cave_budget_controller_without_budget");
  }
  const breakers = options.breakers === undefined
    ? undefined
    : new BreakerState(normalizeRunBreakers(options.breakers, budgetMeter !== undefined));
  const efficiencyPlan = options.lockedBuild?.selected_plan ?? options.candidatePlan;
  const buildIdentity = options.lockedBuild === undefined
    ? undefined
    : {
      buildSha256: options.lockedBuild.build_sha256,
      planSha256: options.lockedBuild.plan_sha256,
    };
  let preparedLockedContext: LoweredContext | undefined;
  if (options.lockedBuild !== undefined) {
    preparedLockedContext = await lowerAgentContext(definition, {
      ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    });
    prepareLockedHarnessExecution({
      build: options.lockedBuild,
      harness: "pi",
      adapterVersion: PI_ADAPTER_VERSION,
      upstreamVersion: PI_UPSTREAM_VERSION,
      agentId: definition.id,
      contextIR: preparedLockedContext.ir,
      plan: options.lockedBuild.selected_plan,
    });
  }
  // --- Durable execution pre-work (own substrate; issue #218) -------------
  if (options.durable !== undefined) {
    validateDurableRunId(options.durable.runId);
    if (executionContext.depth > 0 || executionContext.journal !== undefined) {
      throw new Error("cave_durable_subagent_unsupported: durability is a root-run contract; subagents journal through the root");
    }
    if (options.maxCostUsd !== undefined) {
      throw new Error("cave_durable_max_cost_usd_unsupported: use RunOptions.budget with durable runs");
    }
    if (options.candidatePlan !== undefined) {
      throw new Error("cave_durable_candidate_plan_unsupported");
    }
    if (options.conversation !== undefined && options.sessionId !== undefined &&
        options.sessionId !== options.conversation.sessionId) {
      throw new Error("cave_durable_session_mismatch");
    }
  }
  let conversation: ConversationTransaction | undefined;
  let journal: DurableJournal | undefined;
  let durableTools: DurableToolCoordinator | undefined;
  let durableStore: DurableStore | undefined;
  let durableRelease: (() => Promise<void>) | undefined;
  let durableResume: DurableResumeState | undefined;
  let durableReplay: DurableJournalState | undefined;
  let durableSessionId: string | undefined;
  let durableTerminalPersisted = false;
  const runId = options.durable?.runId ?? crypto.randomUUID();
  if (options.durable !== undefined) {
    if (options.conversation !== undefined) {
      // Lock public conversation before journal identity is minted. A losing
      // concurrent run leaves neither intent nor terminal error behind.
      conversation = beginConversation(options.conversation);
    }
    durableStore = options.durable.store ?? new DiskDurableStore(
      resolve(options.rootDir ?? process.cwd(), ".caveman", "runs", "durable"),
    );
    // Everything between taking the lock and entering the main try must
    // release on failure, or the runId stays locked against this process's
    // own live pid for its lifetime.
    try {
      durableRelease = await durableStore.acquire(runId);
      // The identity digest covers the FULL normalized budget contract —
      // staged initial, exhaustion mode, output floor, compaction config —
      // not just denomination and max.
      // JSON round-trip first: the normalized budget carries optional
      // undefined-valued fields stableStringify refuses; dropping them is
      // exactly the canonical form the digest should cover.
      const budgetSha256 = normalizedRunBudget === undefined
        ? "none"
        : sha256(stableStringify(JSON.parse(JSON.stringify(normalizedRunBudget))));
      const durableDefinitionSHA256 = options.lockedBuild === undefined
        ? executionContext.rootDefinitionSha256
        : sha256(stableStringify({
          definition_sha256: executionContext.rootDefinitionSha256,
          build_sha256: options.lockedBuild.build_sha256,
          plan_sha256: options.lockedBuild.plan_sha256,
        }));
      const durableLines = await durableStore.load(runId);
      const analyzed = analyzeJournal(durableLines, {
        runId,
        agentId: definition.id,
        definitionSha256: durableDefinitionSHA256,
        input: preparedInput.durableInput,
        denomination: budgetMeter?.denomination ?? "none",
        budgetMax: budgetMeter?.max,
        budgetInitial: budgetMeter?.released,
        budgetSha256,
        ...(options.sessionId === undefined && conversation === undefined
          ? {}
          : { sessionId: conversation?.sessionId ?? options.sessionId }),
        ...(conversation === undefined
          ? {}
          : { conversationSessionId: conversation.sessionId }),
      });
      if (analyzed.status === "completed" || analyzed.status === "failed") {
        // A terminal journal replays without spending: the runId is an
        // idempotency key (DBOS semantics), so the same call returns the same
        // outcome. Nothing further will be written — release immediately.
        await durableRelease().catch(() => undefined);
        await durableStore.close(runId).catch(() => undefined);
        durableRelease = undefined;
        durableReplay = analyzed;
      } else {
        journal = new DurableJournal(durableStore, runId, durableLines);
        if (analyzed.status === "pending") {
          durableResume = analyzed.resume;
          if (conversation !== undefined) {
            const checkpoint = durableResume.conversation;
            if (checkpoint === undefined || checkpoint.sessionId !== conversation.sessionId ||
                durableConversationMessagesSHA256(conversation.messages) !==
                  checkpoint.messagesSha256) {
              throw new Error("cave_durable_conversation_mismatch");
            }
            conversation.messages = structuredClone(durableResume.messages) as AgentMessage[];
            conversation.fingerprint = undefined;
            conversation.cachePrefixDigest = undefined;
            conversation.providerFrozen = undefined;
            conversation.originalFrozen = undefined;
          }
          // Prior attempts' settled money is spent money: preload it before
          // anything can reserve, so a resume can never re-spend what the
          // journal already accounts for.
          budgetMeter?.restorePrior({
            settled: durableResume.priorSettled,
            calls: durableResume.priorRootMeterCalls,
            tranches: durableResume.priorTranches,
          });
        }
        durableSessionId = durableResume?.sessionId ??
          conversation?.sessionId ?? options.sessionId ?? `${definition.id}-${runId}`;
        if (durableResume === undefined) {
          if (conversation !== undefined) {
            assertDurableProspectiveConversation(
              conversation.messages,
              input,
              preparedInput,
            );
          }
          const conversationCheckpoint = conversation === undefined
            ? undefined
            : durableConversationCheckpoint(conversation.sessionId, conversation.messages);
          journal.emit({
            v: DURABLE_JOURNAL_VERSION,
            at: journal.now(),
            type: "run_started",
            runId,
            agentId: definition.id,
            definitionSha256: durableDefinitionSHA256,
            input: preparedInput.durableInput,
            sessionId: durableSessionId,
            denomination: budgetMeter?.denomination ?? "none",
            budgetMax: budgetMeter?.max,
            budgetSha256,
            ...(conversationCheckpoint === undefined
              ? {}
              : { conversation: conversationCheckpoint }),
            pid: process.pid,
          });
        } else {
          journal.emit({
            v: DURABLE_JOURNAL_VERSION,
            at: journal.now(),
            type: "resumed",
            attempt: durableResume.attempts + 1,
            unmatchedIntents: durableResume.possibleDoubleCountCalls,
            pid: process.pid,
          });
        }
        await journal.flush();
        durableTools = new DurableToolCoordinator(journal, durableResume?.replayTools);
      }
    } catch (error) {
      await durableRelease?.().catch(() => undefined);
      await durableStore.close(runId).catch(() => undefined);
      if (conversation !== undefined) {
        endConversation(conversation);
        conversation = undefined;
      }
      throw error;
    }
  }
  // This run's handle into the (possibly inherited) durable journal. The
  // root owns turn state and tranches; every depth emits its own money
  // events tagged with its path so each real provider call settles exactly
  // once in exactly one journal event.
  const activeJournal = journal ?? executionContext.journal;
  const activeDurableTools = durableTools ?? executionContext.durableTools;
  const journalPath = (executionContext.durablePath ?? executionContext.agentPath).join("/");
  let journaledTranches = durableResume?.priorTranches.length ?? 0;
  const journalNewTranches = (): void => {
    if (journal === undefined || budgetMeter === undefined) return;
    const tranches = budgetMeter.tranches;
    for (; journaledTranches < tranches.length; journaledTranches++) {
      const tranche = tranches[journaledTranches]!;
      journal.emit({
        v: DURABLE_JOURNAL_VERSION,
        at: journal.now(),
        type: "tranche",
        amount: tranche.amount,
        reason: tranche.reason,
        atCall: tranche.atCall,
      });
    }
  };
  const journalMeterCall = (meter: BudgetMeter): void => {
    if (activeJournal === undefined) return;
    activeJournal.emit({
      v: DURABLE_JOURNAL_VERSION,
      at: activeJournal.now(),
      type: "meter_call",
      path: journalPath,
      atCall: meter.calls,
    });
  };
  let activeAbort: (() => void) | undefined;
  let activeExecution: Promise<void> | undefined;
  let sandboxSourceSnapshot: SandboxSourceSnapshot | undefined;
  const pendingSpendReservations: SpendReservation[][] = [];
  const pendingCallRecords: PendingCallRecord[] = [];
  let spendFailure: Error | undefined;
  // Set when the ladder declines to start another call. Pi answers the refusal
  // with one synthesized zero-usage error turn; that turn is our own stop, not
  // provider evidence, so it is skipped by the usage accounting below and
  // dropped from the committed conversation.
  let stopReason: RunStopReason | undefined;
  let ladderFailure: Error | undefined;
  let policyFailure: Error | undefined;
  const failPolicy = (error: unknown): Error => {
    policyFailure ??= error instanceof Error ? error : new Error(String(error));
    controlledAgent?.abort();
    return policyFailure;
  };
  let refusalPending = false;
  let refusalMessage: AssistantMessage | undefined;
  const receipt = new ReceiptRecorder();
  // Declared outside the main try so failed descendants can still be attached
  // to this run's terminal receipt in the catch path.
  const nestedReceipts: RunReceipt[] = [];
  const programmaticScopesByToolName = new Map<string, ProgrammaticSpeculationScope>();
  const closeProgrammaticSpeculation = async (): Promise<void> => {
    await Promise.all(
      [...programmaticScopesByToolName.values()].map((scope) => scope.close()),
    );
  };
  let boundController: BudgetController | undefined;
  let controlledAgent: Agent | undefined;
  let invocationSpanRecord: InvocationSpanRecord | undefined;
  let invocationSpanFinished = false;
  const finishInvocationSpan = (statusCode: 0 | 1 | 2): void => {
    if (invocationSpanFinished || invocationSpanRecord === undefined) return;
    invocationSpanFinished = true;
    recordInvocationSpan(invocationSpanRecord, statusCode);
    if (invocationSpanRecord.trace.parentSpanId === "") {
      scheduleInvocationSpanBatch(invocationSpanRecord.trace.batch);
    }
  };
  const releaseConversation = () => {
    if (!conversation) return;
    endConversation(conversation);
    conversation = undefined;
  };
  // Owned resources released BEFORE the terminal event is yielded, so a manual
  // `.next()` consumer that stops the moment it receives run_end/run_error does
  // not strand the staged source-graph tempdir or leave the budget controller
  // bound to a meter nothing reads any more.
  // Idempotent — the finally calls it again for the abort/throw paths.
  let runResourcesReleased = false;
  const releaseRunResources = async (): Promise<void> => {
    if (runResourcesReleased) return;
    runResourcesReleased = true;
    if (boundController !== undefined) unbindBudgetController(boundController);
    await sandboxSourceSnapshot?.dispose();
  };

  try {
    // The terminal yields live INSIDE the try so a consumer that `.return()`s
    // at run_start still runs the finally — the durable lock, store handle,
    // and staged resources must never outlive an abandoned generator.
    yield { type: "run_start", runId, agentId: definition.id };
    if (durableReplay !== undefined) {
      if (durableReplay.status === "completed") {
        if (conversation !== undefined) {
          const checkpoint = durableReplay.conversation;
          const base = durableReplay.baseConversation;
          if (checkpoint === undefined || base === undefined ||
              checkpoint.sessionId !== conversation.sessionId) {
            throw new Error("cave_durable_conversation_mismatch");
          }
          const current = durableConversationMessagesSHA256(conversation.messages);
          if (current === base.messagesSha256) {
            commitConversation(conversation, {
              messages: structuredClone(checkpoint.messages) as AgentMessage[],
              fingerprint: undefined,
              cachePrefixDigest: undefined,
              providerFrozen: undefined,
              originalFrozen: undefined,
            });
          } else if (current !== checkpoint.messagesSha256) {
            throw new Error("cave_durable_conversation_mismatch");
          }
        }
        releaseConversation();
        yield { type: "run_end", runId, result: durableReplay.result as RunResult };
      } else if (durableReplay.status === "failed") {
        if (conversation !== undefined) {
          const base = durableReplay.baseConversation;
          if (base === undefined || base.sessionId !== conversation.sessionId ||
              durableConversationMessagesSHA256(conversation.messages) !== base.messagesSha256) {
            throw new Error("cave_durable_conversation_mismatch");
          }
        }
        releaseConversation();
        yield {
          type: "run_error",
          runId,
          code: durableReplay.code,
          message: durableReplay.message,
          receipt: durableReplay.receipt as RunReceipt,
        };
      }
      return;
    }
    activeDurableTools?.assertResumeSafe();
    if (options.budgetController !== undefined && budgetMeter !== undefined) {
      bindBudgetController(options.budgetController, budgetMeter);
      boundController = options.budgetController;
    }
    if (durableResume !== undefined && conversation === undefined &&
        durableResume.messages.length > 0) {
      // Rebuild the crashed run's conversation to its last completed turn.
      // This is the ordinary multi-turn shape — a committed conversation
      // re-entering a run — with the journal standing in for the process
      // that died. The partial turn past the boundary was discarded; its
      // journaled spend was preloaded above.
      const restored = createConversation();
      const restoredState = conversationStates.get(restored);
      if (restoredState === undefined) throw new Error("cave_conversation_invalid");
      restoredState.messages = structuredClone(durableResume.messages) as AgentMessage[];
      conversation = beginConversation(restored);
    } else if (conversation === undefined) {
      conversation = options.conversation === undefined
        ? undefined
        : beginConversation(options.conversation);
    }
    if (options.entryPath === undefined &&
        requiresSandboxEntry(definition, executionContext.sandboxRequired)) {
      throw new Error(
        "cave_tool_sandbox_entry_required: sandboxed tools need RunOptions.entryPath; use sandbox fixture only for trusted tests",
      );
    }
    const originalConversationMessages = conversation?.messages.slice() ?? [];
    const initialConversationSegments = conversationTextSegments(originalConversationMessages);
    const initialConversationMedia = conversationMediaSegments(originalConversationMessages);
    const lowered = await lowerAgentContext(definition, {
      ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
      runtimeSegments: [
        ...initialConversationSegments.map((segment) => ({
          id: segment.id,
          kind: segment.kind,
          body: new TextEncoder().encode(segment.text),
        })),
        ...initialConversationMedia,
      ],
      input: preparedInput.contextInput,
      ...(preparedInput.inputProviderVisibleBytes === undefined
        ? {}
        : { inputProviderVisibleBytes: preparedInput.inputProviderVisibleBytes }),
      ...(preparedInput.inputOpaque === undefined
        ? {}
        : { inputOpaque: preparedInput.inputOpaque }),
    });
    const bill = contextBill(lowered.ir);
    if (efficiencyPlan) enforceSemanticBudgets(
      bill,
      definition.output?.maxTokens ?? 0,
      efficiencyPlan,
    );
    yield { type: "context_ready", runId, contextIR: lowered.ir, bill };
    const appliedPlan = await applyEfficiencyPlan(lowered, efficiencyPlan, options.engineBin, options.signal);
    const frameworkDistRoot = dirname(fileURLToPath(import.meta.url));
    const requestedSandboxEntry = options.entryPath === undefined
      ? undefined
      : resolve(options.rootDir ?? process.cwd(), options.entryPath);
    sandboxSourceSnapshot = requestedSandboxEntry === undefined
      ? undefined
      : await stageSandboxSourceGraph(
        options.rootDir ?? process.cwd(),
        requestedSandboxEntry,
        frameworkDistRoot,
      );
    const sandboxEntry = sandboxSourceSnapshot?.entryPath;
    const sandboxSourceFiles = sandboxSourceSnapshot?.sourceFiles ?? [];
    const sandboxStagingRoot = sandboxSourceSnapshot?.stagingRoot;
    const conversationOriginals = new Map<string, string>();
    const initialProviderMessages = replaceConversationSegments(
      originalConversationMessages,
      initialConversationSegments,
      lowered,
      appliedPlan,
      conversationOriginals,
    );

    const gatewayURL = resolveGatewayURL(options.gatewayURL);
    const caveRoute = await resolveCaveRoute(gatewayURL, {
      ...options,
      billingProofRequired: budgetMeter?.denomination === "usd" && options.streamFn === undefined,
    }, efficiencyPlan !== undefined);

    const models = options.models ?? builtinModels();
    const model = options.model ?? resolveModel(definition, models, options.rootDir ?? process.cwd());
    const pricingAdmissionAt = new Date();
    // Runtime-gated denomination, first ground: the catalog must
    // price the model, or a USD cap meters an honest zero and never binds. The
    // second ground — the credential regime — is checked after routing below,
    // because which credential pays depends on where the request goes.
    if (budgetMeter?.denomination === "usd" &&
        !modelIsPriced(model.provider, model.id, pricingAdmissionAt)) {
      // F8: the degrade names its next step — which model is unpriced and
      // what to do about it, not just the wire code.
      throw new Error(
        `cave_budget_denomination_unavailable: ${model.provider}/${model.id} is not in the public catalog, so a USD budget cannot meter it — use budget.maxTokens, or pick a cataloged model`,
      );
    }
    // Actual routing is the source of truth, not the route decision: the
    // gateway only speaks the three provider dialects it proxies, so a model
    // outside them keeps its own base URL even on a reachable gateway. Every
    // downstream honesty question — which headers may be sent, what mode this
    // run may claim — reads gatewayActive, never caveRoute.useGateway alone.
    const routing = caveRoute.useGateway
      ? routeModelThroughCave(model, gatewayURL)
      : { model, routed: false };
    const routedModel = routing.model;
    const gatewayActive = routing.routed;
    const sessionId = durableSessionId ?? options.sessionId ?? conversation?.sessionId ?? `${definition.id}-${runId}`;
    const workflow = options.workflow ?? definition.id;
    const memoryEngine = definition.memory === undefined
      ? undefined
      : resolveMemoryEngine(definition.memory, definition.id, options.memory);
    // Ambient work needs one engine owned across turns. A one-shot implicit
    // engine still serves explicit tools, but is never left writing after run.
    const ambientMemoryActive = definition.memory?.ambient !== false &&
      options.memory?.engine === memoryEngine;
    const passiveRecall = !ambientMemoryActive
      ? undefined
      : memoryEngine?.beginTurn({ sessionId, text: preparedInput.memoryText });
    const invocationTrace = gatewayActive
      ? options.invocationTrace ?? rootInvocationTrace(
        definition.id,
        workflow,
        sessionId,
        gatewayURL,
        options.fetch ?? globalThis.fetch,
        process.env.CAVE_API_KEY || undefined,
        rootBudgetGuardState(options, budgetMeter),
        options.maxSubagentInvocations === undefined ? "absent" : "active",
        options.maxConcurrentSubagents === undefined ? "absent" : "active",
        executionContext.subagentAdmissions,
      )
      : undefined;
    const {
      invocationTrace: _inheritedInvocationTrace,
      modelRouter: _rootModelRouter,
      ...optionsWithoutInvocationTrace
    } = options;
    const nestedOptions: InternalRunOptions = {
      ...optionsWithoutInvocationTrace,
      caveRoute,
      ...(invocationTrace === undefined ? {} : { invocationTrace }),
    };
    if (invocationTrace !== undefined) {
      invocationSpanRecord = {
        trace: invocationTrace,
        agentId: definition.id,
        depth: executionContext.depth,
      };
    }
    // Runtime-gated denomination, second ground: the run must actually be
    // BILLED in dollars. A Claude Pro/Max subscription reached through Pi's
    // credential store is not billed per token, so every dollar this ledger
    // reported for it would be fiction.
    //
    // Which credential pays is what decides this. A caller-supplied streamFn
    // owns its transport, so local login says nothing about billing. A routed
    // gateway skips the local credential gate ONLY when its identified
    // readiness response says it supplies a managed provider credential.
    // Standalone BYOK and unknown/legacy gateways fall through to Pi's actual
    // credential regime; ambient account-key presence proves no payer.
    if (budgetMeter?.denomination === "usd" &&
        options.streamFn === undefined &&
        (!gatewayActive || caveRoute.providerBilling !== "managed")) {
      const regime = await credentialRegime(models, model.provider);
      // A subscription is fiction in dollars; an unprovable regime fails closed
      // rather than fail-open into fictional dollars. The escape
      // hatch is the caller asserting, on its own authority, that this
      // credential is a metered API key.
      if (regime === "subscription" ||
          (regime === "unknown" && options.assumeMeteredCredential !== true)) {
        // F8: same refusal, but the message names the one-line fix for the
        // state the machine is actually in instead of only the wire code.
        throw new Error(
          `cave_budget_denomination_unavailable: ${credentialRegimeFix(regime, model.provider)}`,
        );
      }
    }
    if (efficiencyPlan !== undefined) {
      validatePlanSelection(efficiencyPlan, {
        provider: model.provider,
        model: model.id,
        reasoning: definition.reasoning,
      });
    }
    const recoveryHandles = appliedPlan.recoveryHandles;
    const nestedUsage: NestedUsage = {
      calls: new Map(),
      budgets: new Map(),
      receipts: nestedReceipts,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      unpriced: false,
      incomplete: false,
      observeOnly: false,
    };
    let dispatchNestedTool: ((input: {
      parent: ToolDefinition;
      parentToolCallId: string;
      name: string;
      args: unknown;
      options: NestedToolDispatchOptions | undefined;
      parentSignal: AbortSignal;
      turnKey?: object;
    }) => Promise<unknown>) | undefined;
    const hasDynamicRecoveryRoute = efficiencyPlan?.segment_routes.some((route) =>
      route.segment_kind === "history" || route.segment_kind === "tool_result") ?? false;
    const hasToolResultRoute = efficiencyPlan?.segment_routes.some((route) =>
      route.segment_kind === "tool_result") ?? false;
    const needsRecoveryTool = recoveryHandles.size > 0 || hasDynamicRecoveryRoute ||
      definition.tools.some((item) => item.result !== "inline");
    const needsToolSearch = appliedPlan.appliedTransformIDs.includes("caveman.engine.toolschema.v1");
    const memoryTools = definition.memory === undefined
      ? []
      : localMemoryTools(definition.memory, memoryEngine!);
    // Descendants inherit the durable journal through the execution context:
    // the root's own frozen context predates the journal, so subagents get
    // this extended view — same object otherwise, so nothing else changes.
    const executionContextForDescendants: InternalExecutionContext = journal === undefined
      ? executionContext
      : Object.freeze({
        ...executionContext,
        journal,
        ...(durableTools === undefined ? {} : { durableTools }),
        durablePath: executionContext.durablePath ?? Object.freeze([]),
      });
    const piTools: AgentTool<TSchema>[] = [
      ...definition.tools.map((item) => {
        const providerTool = providerToolDefinition(item, lowered, appliedPlan);
        const programmaticMetadata = programmaticToolMetadata(item);
        const connectRuntime = item.runtime?.kind === "caveman-connect"
          ? item.runtime
          : undefined;
        const delegatedExecutionKind = item.runtime?.kind === "subagent"
          ? "subagent" as const
          : connectRuntime !== undefined
          ? "connect" as const
          : options.entryPath === undefined || definition.sandbox === "host"
          ? undefined
          : "sandbox" as const;
        return toPiTool(
          item,
          item.runtime?.kind === "subagent"
          ? (params, signal, context) => executeSubagent(
            item,
            params,
            signal,
            { ...nestedOptions, model },
            nestedUsage,
            executionContextForDescendants,
            budgetMeter,
            deadlineAt,
            context?.toolCallId,
          )
          : connectRuntime !== undefined
          ? (params, signal) => executeConnectTool(connectRuntime, params, signal)
          // Host mode runs closures in this process by explicit opt-in, so a
          // staged entry path never promotes them into a tool worker.
          : options.entryPath === undefined || definition.sandbox === "host"
          ? undefined
          : (params, signal, context) => executeSandboxedTool(
            sandboxEntry!,
            sandboxSourceFiles,
            sandboxStagingRoot!,
            item.name,
            params,
            item.timeoutMs,
            definition.sandbox === "required",
            options.sandboxProfile,
            executionContext,
            toolDefinitionSHA256(item),
            item.output !== undefined,
            signal,
            context,
          ),
          delegatedExecutionKind,
          recoveryHandles,
          options.engineBin,
          providerTool,
          hasToolResultRoute,
          item.nestedTools === undefined
            ? undefined
            : (request) => {
              if (dispatchNestedTool === undefined) {
                throw new Error("cave_nested_tool_dispatch_unavailable");
              }
              return dispatchNestedTool({ parent: item, ...request });
            },
          item.nestedTools === undefined && programmaticMetadata === undefined
            ? undefined
            : (toolCallId) => {
              const pending: Promise<unknown>[] = [];
              const programmatic = programmaticScopesByToolName.get(item.name)?.finish(toolCallId);
              if (programmatic !== undefined) pending.push(programmatic);
              const raw = nestedRawSettlementsByParent.get(toolCallId);
              if (raw !== undefined) pending.push(...raw);
              return pending.length === 0
                ? undefined
                : Promise.allSettled(pending).then(() => undefined);
            },
          activeDurableTools,
          journalPath,
        );
      }),
      ...(needsRecoveryTool ? [durablePiTool(
        recoveryTool(recoveryHandles, options.engineBin, appliedPlan.trace),
        "read", activeDurableTools, journalPath,
      )] : []),
      ...(needsToolSearch ? [durablePiTool(
        toolSchemaSearchTool(recoveryHandles, options.engineBin, appliedPlan.trace),
        "read", activeDurableTools, journalPath,
      )] : []),
      ...memoryTools.map((tool) => durablePiTool(
        tool,
        tool.name === "cave_memory_remember" ? "write" : "read",
        activeDurableTools,
        journalPath,
      )),
    ];
    const originalInstructions = assembleSystemPrompt(definition, lowered);
    const ambiguousCustomAdapter = options.streamFn !== undefined &&
      options.providerPayloadContract !== "pi-on-payload-v1" &&
      appliedPlan.appliedTransformIDs.length > 0;
    if (ambiguousCustomAdapter) {
      markAppliedPlanFailedOpen(appliedPlan, "cache_adapter_ambiguous");
    }
    const instructions = ambiguousCustomAdapter
      ? originalInstructions
      : assembleSystemPrompt(definition, lowered, appliedPlan.bodies);
    const prefixDigest = sha256(stableStringify({
      instructions,
      tools: piTools.map((item) => ({
        name: item.name,
        description: item.description,
        parameters: item.parameters,
      })),
    }));
    const conversationFingerprint = sha256(stableStringify({
      agentId: definition.id,
      provider: routedModel.provider,
      model: routedModel.id,
      api: routedModel.api,
      prefixDigest,
      buildIdentity: buildIdentity ?? null,
      lockedPlanSHA256: buildIdentity?.planSha256 ?? null,
      executionPlanSHA256: efficiencyPlan === undefined
        ? null
        : sha256(stableStringify(efficiencyPlan)),
    }));
    if (conversation?.fingerprint !== undefined &&
        conversation.fingerprint !== conversationFingerprint) {
      conversation.cachePrefixDigest = undefined;
      conversation.providerFrozen = undefined;
      conversation.originalFrozen = undefined;
    }
    if (conversation) conversation.fingerprint = conversationFingerprint;
    if (efficiencyPlan?.segment_routes.length && volatileStablePrefix(instructions, definition.tools)) {
      throw new Error("cave_cache_volatile_stable_slot");
    }
    // Every x-cave-* header exists for the Caveman gateway: x-cave-api-key is
    // an account credential, and agent/workflow/session/cache-epoch/prefix
    // digest/context bill/build+plan digests are account-linked identifiers and
    // internal telemetry. A request that does not go through the gateway goes to
    // a third party, so it carries none of them.
    const headers = gatewayActive
      ? runtimeHeaders(
        definition.id,
        workflow,
        sessionId,
        buildIdentity,
        bill,
        appliedPlan.appliedTransformIDs,
        prefixDigest,
        conversationFingerprint,
        invocationTrace,
      )
      : undefined;
    const baseStream = options.streamFn ?? models.streamSimple.bind(models);
    // Native cache hints (phase 2, decision 3's "self-sufficient"): off the
    // gateway, the in-SDK cache planner adds provider-native cache markers to
    // the outgoing upstream request only. When the loopback gateway is routed
    // it keeps precedence — the engine is not constructed at all — and
    // `cave: "off"` or an ambiguous custom adapter also disables it. Requests
    // already carrying caller cache markers (Pi's own cacheRetention markers
    // included) pass through as caller-managed inside the planner. Nothing
    // here is recorded or counted as savings anywhere.
    const nativeCacheEngine =
      !gatewayActive && options.cave !== "off" && !ambiguousCustomAdapter
        ? new CachePlanEngine()
        : undefined;
    const applyNativeCacheHints = (
      payload: unknown,
      providerModel: { api: string; provider: string; id: string },
    ): unknown => {
      if (nativeCacheEngine === undefined) return payload;
      const wire = NATIVE_CACHE_WIRES[providerModel.api];
      if (wire === undefined || providerModel.provider !== wire.provider) return payload;
      try {
        const body = JSON.stringify(payload);
        const result = optimizeNativeRequest(nativeCacheEngine, {
          scope: `${definition.id}/${options.workflow ?? definition.id}`,
          epoch: `${sessionId}:${prefixDigest.slice(0, 16)}`,
          partitionKey: sessionId,
          provider: wire.provider,
          model: providerModel.id,
          endpoint: wire.endpoint,
          body,
          runtimeMode: "optimize",
          prefixTokens: 0,
        });
        if (!result.applied) return payload;
        // Live-path gate (#225): only cache grammars proven against a live
        // provider may leave the SDK. Today that is exactly the openai
        // affinity routing key; explicit-cache grammars
        // (prompt_cache_options/prompt_cache_breakpoint) stay
        // fixture-parity-only until their live smoke passes.
        if (result.plan.mode !== "affinity" || result.optimizerIds.length !== 1 ||
            result.optimizerIds[0] !== "openai-prompt-cache-key") {
          return payload;
        }
        return JSON.parse(result.body);
      } catch {
        // Any parse or planning uncertainty: the original payload leaves
        // unchanged. Never a partial edit, never an error surfaced as spend.
        return payload;
      }
    };
    let providerPrefixDigest = conversation?.cachePrefixDigest;
    let providerFrozen = conversation?.providerFrozen;
    let originalFrozen = conversation?.originalFrozen;
    let cacheBoundaryKnown = false;
    let cacheBust = false;
    let finalMessage: AssistantMessage | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let reasoningUsageUnavailable = false;
    let costUsd = 0;
    let unpricedCall = false;
    let usageFailure: Error | undefined;
    // Durable counters restore from the journal so the ceilings govern the
    // LOGICAL run, not each process: a crash loop cannot buy itself a fresh
    // call budget every restart. Compaction counters deliberately do NOT
    // restore: a resume rebuilds the uncompacted transcript (see the
    // prepareNextTurnWithContext note), so it must be allowed to compact it
    // again — every attempt is metered against the restored budget, which is
    // the real bound.
    let modelCalls = durableResume?.priorRootModelCalls ?? 0;
    let routedCalls = modelCalls;
    let compactionsUsed = 0;
    // Incremented the moment a compaction takes a reservation, so a paid
    // attempt counts even when its summary is later discarded.
    let compactionsSpent = 0;
    let previousSummary: ContextSummary | undefined;
    // Provider-reported, never assumed: the last call either read a cached
    // prefix or it did not. Before the first call there is nothing to report.
    let lastCallCacheState: "warm" | "cold" | "unknown" = "unknown";
    let activeWorkingModel = routedModel;
    let toolErrorStreak = 0;
    let previousRouteUsage: ModelCallRouteInput["previousUsage"];
    const queued: CavemanRunEvent[] = [];
    let wake: (() => void) | undefined;
    const wakeQueuedConsumer = (): void => {
      const pending = wake;
      wake = undefined;
      pending?.();
    };
    const toolCalls: string[] = durableResume === undefined
      ? []
      : durableResume.priorToolEvents.map((entry) => entry.name);
    const configuredToolsByName = new Map(definition.tools.map((item) => [item.name, item]));
    // Composite containers remain visible in results/receipts but do not buy
    // extra hidden calls. Direct and nested calls share this one run-local cap.
    let toolBudgetCallCount = durableResume === undefined
      ? 0
      : durableResume.priorToolEvents.reduce((count, entry) =>
        configuredToolsByName.get(entry.name)?.nestedTools === undefined ? count + 1 : count, 0);
    let compositeEnvelopeCallCount = durableResume === undefined
      ? 0
      : durableResume.priorToolEvents.reduce((count, entry) =>
        configuredToolsByName.get(entry.name)?.nestedTools === undefined ? count : count + 1, 0);
    let compositeEnvelopeTurnKey: AssistantMessage | undefined;
    let compositeEnvelopeTurnCount = 0;
    const compositeTurnKeys = new Map<string, object>();
    const nestedOutcomesByParent = new Map<string, Array<{ sequence: number; isError: boolean }>>();
    type NestedScheduler = {
      readonly activeReads: Set<Promise<unknown>>;
      effectTail: Promise<void>;
    };
    const nestedSchedulersByParent = new Map<string, NestedScheduler>();
    // Timed dispatch promises may reject before non-cooperative raw execution
    // or async output validation settles. Keep those raw settlements separate
    // so composite finalization can prove quiescence instead of mistaking a
    // deadline rejection for stopped work.
    const nestedRawSettlementsByParent = new Map<string, Set<Promise<unknown>>>();
    const scheduleNested = (
      parentToolCallId: string,
      effect: ToolDefinition["effect"],
      execute: () => Promise<unknown>,
    ): Promise<unknown> => {
      let scheduler = nestedSchedulersByParent.get(parentToolCallId);
      if (scheduler === undefined) {
        scheduler = { activeReads: new Set(), effectTail: Promise.resolve() };
        nestedSchedulersByParent.set(parentToolCallId, scheduler);
      }
      if (effect === "read") {
        const work = scheduler.effectTail.then(execute);
        scheduler.activeReads.add(work);
        void work.finally(() => scheduler!.activeReads.delete(work)).catch(() => undefined);
        return work;
      }
      const barriers = [scheduler.effectTail, ...scheduler.activeReads];
      const work = Promise.allSettled(barriers).then(execute);
      scheduler.effectTail = work.then(() => undefined, () => undefined);
      return work;
    };
    let nestedToolSequence = 0;
    // Turn-state watermark: how much of pi's message array the journal has.
    // Tail identity detects a wholesale rewrite (compaction journals its own
    // snapshot; this is the fail-safe for any other rewrite). The seed itself
    // is never re-journaled: a resume rebuilds it from run_started + prior
    // turn events, exactly like a committed conversation re-entering a run.
    let journaledMessagesLen = initialProviderMessages.length;
    let journaledMessagesTail: AgentMessage | undefined = initialProviderMessages.at(-1);
    let turnStateChanged = false;
    const startedAt = performance.now();
    // Caller-supplied ceilings override the derived defaults. They
    // fail closed: a non-positive or non-integer value is a malformed cap, not
    // "no cap", so it is rejected before the first provider call.
    const callCeilingOverride = (value: number | undefined, field: string): number | undefined => {
      if (value === undefined) return undefined;
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`cave_${field}_invalid`);
      }
      return value;
    };
    const maxModelCalls = callCeilingOverride(options.maxModelCalls, "max_model_calls") ??
      (efficiencyPlan === undefined
        ? 64
        : 1 + Math.max(1, Math.ceil(efficiencyPlan.budgets.retry_cascade_reserve / 256)));
    const maxToolCalls = callCeilingOverride(options.maxToolCalls, "max_tool_calls") ??
      (efficiencyPlan === undefined
        ? 64
        : Math.max(1, definition.tools.length) * Math.max(1, maxModelCalls - 1));
    dispatchNestedTool = async ({
      parent,
      parentToolCallId,
      name,
      args,
      options: dispatchOptions,
      parentSignal,
      turnKey: suppliedTurnKey,
    }): Promise<unknown> => {
      const nested = parent.nestedTools?.find((item) => item.name === name);
      if (nested === undefined) throw new Error(`cave_nested_tool_not_allowed:${name}`);
      if (dispatchOptions?.claimSpeculation === true) {
        if (nested.effect !== "read" || nested.speculative !== true ||
            parent.speculativeTools?.includes(nested.name) !== true) {
          throw new Error(`cave_nested_tool_speculation_not_allowed:${nested.name}`);
        }
        if (args === null || typeof args !== "object" || Array.isArray(args) ||
            !Value.Check(nested.input, args)) {
          throw new Error(`cave_tool_input_schema_mismatch:${nested.name}`);
        }
        const claimed = programmaticScopesByToolName.get(parent.name)?.claim(
          parentToolCallId,
          nested.name,
          args as Record<string, unknown>,
          dispatchOptions.signal,
        );
        if (claimed !== undefined) return claimed;
      }
      const turnKey = suppliedTurnKey ?? compositeTurnKeys.get(parentToolCallId);
      if (turnKey === undefined) throw new Error("cave_nested_tool_parent_inactive");

      const nestedToolCallId = `${parentToolCallId}:nested:${++nestedToolSequence}`;
      const outcome = { sequence: nestedToolSequence, isError: true };
      const parentOutcomes = nestedOutcomesByParent.get(parentToolCallId) ?? [];
      parentOutcomes.push(outcome);
      nestedOutcomesByParent.set(parentToolCallId, parentOutcomes);
      queued.push({
        type: "nested_tool_start",
        runId,
        id: nestedToolCallId,
        name: nested.name,
        args,
      });
      wakeQueuedConsumer();
      toolCalls.push(nested.name);
      toolBudgetCallCount++;
      receipt.recordToolCall(nested.name);
      let isError = true;
      let eventResult: unknown;
      try {
        if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
          stopReason = "deadline";
          throw new Error("cave_run_deadline_exceeded");
        }
        if (budgetMeter?.revoked) {
          stopReason = "wallet_revoked";
          throw new Error("cave_budget_revoked");
        }
        if (budgetMeter !== undefined &&
            (budgetMeter.capBreached || budgetMeter.remaining() <= 0)) {
          stopReason = "budget_exhausted";
          throw new Error("cave_budget_exhausted");
        }
        if (toolBudgetCallCount > maxToolCalls) {
          throw new Error("cave_tool_call_budget_exceeded");
        }
        if (breakers !== undefined) {
          const decision = breakers.observeToolCall({
            toolCallId: nestedToolCallId,
            toolName: nested.name,
            args,
            allowRepeat: nested.allowRepeat === true,
            turnKey,
          });
          if (decision.block) throw new Error(decision.reason!);
        }
        if (nested.effect === "write" && definition.sandbox === "fixture") {
          throw new Error("cave_side_effect_blocked");
        }
        if (definition.sandbox === "required") {
          throw new Error("cave_nested_tool_sandbox_unsupported");
        }
        if (args === null || typeof args !== "object" || Array.isArray(args) ||
            !Value.Check(nested.input, args)) {
          throw new Error(`cave_tool_input_schema_mismatch:${nested.name}`);
        }
        if (options.toolPolicy !== undefined) {
          const denial = await decideToolCall(options.toolPolicy, {
            runId,
            agentId: definition.id,
            agentPath: executionContext.agentPath,
            toolCallId: nestedToolCallId,
            parentToolCallId,
            name: nested.name,
            effect: nested.effect,
            args,
          }).catch((error: unknown) => { throw failPolicy(error); });
          if (denial !== undefined) {
            receipt.recordToolDenial(nested.name);
            throw new Error(denial.reason);
          }
        }
        const timeout = AbortSignal.timeout(nested.timeoutMs);
        const signals = [parentSignal, timeout];
        if (dispatchOptions?.signal !== undefined) signals.push(dispatchOptions.signal);
        const combined = AbortSignal.any(signals);
        if (combined.aborted) throw abortSignalError(combined, "cave_nested_tool_aborted");
        const executeNested = (durable?: DurableToolInvocation) => {
          const rawSettlement = scheduleNested(
            parentToolCallId,
            nested.effect,
            async () => {
              if (combined.aborted) {
                throw abortSignalError(combined, "cave_nested_tool_aborted");
              }
              if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
                stopReason = "deadline";
                throw new Error("cave_run_deadline_exceeded");
              }
              if (budgetMeter?.revoked) throw new Error("cave_budget_revoked");
              const nestedContext: ToolExecutionContext = Object.freeze({
                toolCallId: nestedToolCallId,
                parentToolCallId,
                ...(durable === undefined ? {} : { durable }),
                dispatch() {
                  return Promise.reject(new Error("cave_nested_tool_dispatch_unavailable"));
                },
              });
              const rawValue = nested.runtime?.kind === "subagent"
                ? executeSubagent(
                    nested,
                    args,
                    combined,
                    { ...nestedOptions, model },
                    nestedUsage,
                    executionContextForDescendants,
                    budgetMeter,
                    deadlineAt,
                    nestedToolCallId,
                  )
                : executeRawTool(nested, args, combined, nestedContext);
              return (await settleToolOutput(nested, await rawValue)).value;
            },
          );
          let rawSettlements = nestedRawSettlementsByParent.get(parentToolCallId);
          if (rawSettlements === undefined) {
            rawSettlements = new Set<Promise<unknown>>();
            nestedRawSettlementsByParent.set(parentToolCallId, rawSettlements);
          }
          rawSettlements.add(rawSettlement);
          void rawSettlement.finally(() => {
            rawSettlements!.delete(rawSettlement);
            if (rawSettlements!.size === 0) {
              nestedRawSettlementsByParent.delete(parentToolCallId);
            }
          }).catch(() => undefined);
          return runWithToolDeadline(() => rawSettlement, nested.timeoutMs);
        };
        const value = activeDurableTools === undefined
          ? await executeNested()
          : await activeDurableTools.execute({
            path: journalPath,
            toolCallId: nestedToolCallId,
            name: nested.name,
            effect: nested.effect,
            args,
          }, executeNested);
        isError = false;
        eventResult = value;
        if (nested.effect === "write") turnStateChanged = true;
        if (nested.runtime?.kind === "subagent") turnStateChanged = true;
        return value;
      } catch (error) {
        eventResult = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        outcome.isError = isError;
        receipt.recordToolOutcome(nested.name, isError);
        breakers?.observeToolResult(nestedToolCallId, isError);
        queued.push({
          type: "nested_tool_end",
          runId,
          id: nestedToolCallId,
          name: nested.name,
          isError,
          result: eventResult,
        });
        wakeQueuedConsumer();
      }
    };
    const foldNestedOutcomes = (parentToolCallId: string): void => {
      for (const outcome of (nestedOutcomesByParent.get(parentToolCallId) ?? [])
        .sort((left, right) => left.sequence - right.sequence)) {
        toolErrorStreak = outcome.isError ? toolErrorStreak + 1 : 0;
      }
      nestedOutcomesByParent.delete(parentToolCallId);
      nestedSchedulersByParent.delete(parentToolCallId);
      nestedRawSettlementsByParent.delete(parentToolCallId);
    };
    for (const parent of definition.tools) {
      // Streaming speculation can execute a nested read before Pi exposes the
      // parent tool call to its canonical executor. Durable mode keeps one
      // deterministic parent-intent -> nested-intent order, so those reads
      // launch through normal dispatch once the parent is active.
      if (activeDurableTools !== undefined) continue;
      const metadata = programmaticToolMetadata(parent);
      if (metadata?.enabled !== true) continue;
      programmaticScopesByToolName.set(parent.name, new ProgrammaticSpeculationScope(
        runId,
        parent,
        (launch) => dispatchNestedTool!({
          parent,
          parentToolCallId: launch.parentToolCallId,
          name: launch.name,
          args: launch.args,
          options: { signal: launch.signal },
          parentSignal: launch.signal,
          turnKey: launch.turnKey,
        }),
        foldNestedOutcomes,
      ));
    }
    const accountedAssistantMessages = new WeakSet<object>();
    const accountProviderMessage = (message: AssistantMessage): void => {
      // beforeToolCall runs after the provider message but before its tools.
      // Account there so a call that consumed the deadline or wallet cannot
      // launch fresh side effects. turn_end calls this too for tool-free turns;
      // object identity makes the operation exactly once on either path.
      if (accountedAssistantMessages.has(message)) {
        finalMessage = message;
        return;
      }
      accountedAssistantMessages.add(message);
      const reservation = pendingSpendReservations.shift();
      const pendingCall = pendingCallRecords.shift();
      const budgetReservation = pendingCall?.reservation;
      const reservationMeter = pendingCall?.reservationMeter;
      const callModel = pendingCall?.model ?? activeWorkingModel;
      // An error/aborted terminal turn that carried NO provider usage and
      // holds no live reservation is the crash reporting itself: journaling
      // a zero settle for it would match the in-flight call's intent and
      // silently hide the possible-double-count the resume must surface.
      // But real money always journals — a live reservation settles held
      // money at worst case, and an aborted stream that still reported
      // usage is measured spend, not an unknown.
      const carriedUsage = message.usage !== undefined && (
        message.usage.input > 0 || message.usage.output > 0 ||
        (message.usage.cacheRead ?? 0) > 0 || (message.usage.cacheWrite ?? 0) > 0
      );
      // Pi synthesizes a zero-usage error turn when a pre-admission hook
      // rejects before streamFn/provider I/O. With no pending call there is
      // nothing to account; recording it would invent an unavailable call.
      if (pendingCall === undefined && !carriedUsage &&
          (message.stopReason === "error" || message.stopReason === "aborted")) {
        finalMessage = message;
        return;
      }
      const journalThisSettle = activeJournal !== undefined &&
        !((message.stopReason === "error" || message.stopReason === "aborted") &&
          budgetReservation === undefined && !carriedUsage);
      try {
        if (definition.reasoning !== "off" && callModel.reasoning === true &&
            message.usage.reasoning === undefined) {
          reasoningUsageUnavailable = true;
        }
        const usage = validateProviderUsage({
          provider: message.provider,
          model: message.model,
          inputTokens: message.usage.input,
          outputTokens: message.usage.output,
          cacheReadTokens: message.usage.cacheRead,
          cacheWriteTokens: message.usage.cacheWrite,
          reasoningTokens: message.usage.reasoning ?? 0,
          totalTokens: message.usage.totalTokens,
        }, {
          expected: { provider: callModel.provider, model: callModel.id },
          requirePriced: reservation !== undefined && reservation.length > 0,
          ...(pendingCall === undefined ? {} : { accountingAt: pendingCall.accountingAt }),
        });
        if (reservation !== undefined) {
          spendFailure ??= settleProviderSpend(reservation, usage);
        }
        if (budgetReservation !== undefined) {
          const measuredSpend = reservationMeter?.denomination === "usd"
            ? usage.catalogCostUsd
            : usage.totalTokens;
          reservationMeter?.settle(
            budgetReservation,
            measuredSpend,
          );
          if (pendingCall?.retryAttempt !== undefined) {
            breakers?.settleRetry(pendingCall.retryAttempt, measuredSpend, "provider_reported");
          }
        }
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        cacheReadTokens += usage.cacheReadTokens;
        cacheWriteTokens += usage.cacheWriteTokens;
        reasoningTokens += usage.reasoningTokens;
        costUsd += usage.catalogCostUsd;
        if (!usage.priced) unpricedCall = true;
        lastCallCacheState = usage.cacheReadTokens > 0 ? "warm" : "cold";
        previousRouteUsage = {
          model: `${usage.provider}/${usage.model}`,
          inputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        };
        receipt.recordCall({
          provider: usage.provider,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,
          estimatedUsd: usage.catalogCostUsd,
          unpriced: !usage.priced,
          usageBasis: "provider_reported",
          clampedOutputTokens: pendingCall?.clampedOutputTokens,
        });
        if (journalThisSettle && activeJournal !== undefined) {
          activeJournal.emit({
            v: DURABLE_JOURNAL_VERSION,
            at: activeJournal.now(),
            type: "call_settled",
            path: journalPath,
            kind: "model",
            call: {
              provider: usage.provider,
              model: usage.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              reasoningTokens: usage.reasoningTokens,
              estimatedUsd: usage.catalogCostUsd,
              unpriced: !usage.priced,
              usageBasis: "provider_reported",
            },
            ...(budgetReservation !== undefined && reservationMeter !== undefined
              ? {
                settledAmount: reservationMeter.denomination === "usd"
                  ? usage.catalogCostUsd
                  : usage.totalTokens,
              }
              : {}),
          });
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        usageFailure ??= failure;
        unpricedCall = true;
        receipt.recordCall({
          provider: callModel.provider,
          model: callModel.id,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          estimatedUsd: 0,
          unpriced: true,
          usageBasis: "unavailable",
          clampedOutputTokens: pendingCall?.clampedOutputTokens,
        });
        // Worst-case settlement keeps unreadable provider usage from looking
        // free. A later tool must see the resulting dead wallet.
        if (budgetReservation !== undefined) {
          reservationMeter?.settle(budgetReservation, budgetReservation.amount);
          if (pendingCall?.retryAttempt !== undefined) {
            breakers?.settleRetry(
              pendingCall.retryAttempt,
              budgetReservation.amount,
              "unavailable_worst_case",
            );
          }
        }
        if (reservation !== undefined && reservation.length > 0) {
          markSpendIncomplete(reservation.map((item) => item.ledger));
          spendFailure ??= failure;
        }
        if (journalThisSettle && activeJournal !== undefined) {
          // Unreadable usage settles at worst case in the meter; the journal
          // records the same honesty — an unavailable-usage call, settled at
          // the reservation amount, never a free call.
          activeJournal.emit({
            v: DURABLE_JOURNAL_VERSION,
            at: activeJournal.now(),
            type: "call_settled",
            path: journalPath,
            kind: "model",
            call: {
              provider: callModel.provider,
              model: callModel.id,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              estimatedUsd: 0,
              unpriced: true,
              usageBasis: "unavailable",
            },
            ...(budgetReservation === undefined ? {} : { settledAmount: budgetReservation.amount }),
          });
        }
      }
      finalMessage = message;
    };
    const resolveModelRoute = async (
      current: Model<Api>,
      role: ModelCallRouteInput["role"],
      context: Parameters<StreamFn>[1],
      streamOptions: Parameters<StreamFn>[2],
    ): Promise<{ selected: Model<Api>; decision?: ModelCallRouteDecision }> => {
      const hasImages = context.messages.some((message) => messageHasImage(message));
      if (options.modelRouter === undefined) {
        if (hasImages && !current.input.includes("image")) {
          throw new Error(`cave_model_input_unsupported:${current.provider}/${current.id}:images`);
        }
        return { selected: current };
      }
      const outputTokenCap = Math.min(
        streamOptions?.maxTokens ?? definition.output?.maxTokens ?? Number.MAX_SAFE_INTEGER,
        current.maxTokens,
      );
      const ctxTokens = callCeilingFor(
        current,
        context.systemPrompt ?? "",
        context.messages as unknown as readonly AgentMessage[],
        context.tools,
        outputTokenCap,
        restorableRequestBytes(conversationOriginals, instructions, originalInstructions),
      ).inputTokenCeiling;
      const decision = await options.modelRouter({
        callIndex: routedCalls,
        role,
        provider: model.provider,
        currentModel: `${current.provider}/${current.id}`,
        ctxTokens,
        hasImages,
        toolErrorStreak,
        ...(previousRouteUsage === undefined ? {} : { previousUsage: previousRouteUsage }),
      });
      validateModelRouteDecision(decision);
      const slash = decision.model.indexOf("/");
      const provider = slash < 1 ? "" : decision.model.slice(0, slash);
      const id = slash < 1 ? "" : decision.model.slice(slash + 1);
      if (provider !== model.provider) throw new Error("cave_model_route_cross_provider");
      const currentID = `${current.provider}/${current.id}`;
      const raw = decision.model === currentID
        ? current
        : models.getModel(provider, id);
      if (raw === undefined) throw new Error(`cave_model_route_unknown:${decision.model}`);
      if (hasImages && !raw.input.includes("image")) {
        throw new Error(`cave_model_route_incompatible:${decision.model}:images`);
      }
      if (ctxTokens > raw.contextWindow) {
        throw new Error(`cave_model_route_incompatible:${decision.model}:context`);
      }
      const selected = gatewayActive && decision.model !== currentID
        ? routeModelThroughCave(raw, gatewayURL).model
        : raw;
      return { selected, decision };
    };
    const emitModelRoute = (decision: ModelCallRouteDecision | undefined): void => {
      if (decision === undefined) return;
      routedCalls++;
      queued.push({ type: "model_route", runId, decision });
      wake?.();
      wake = undefined;
    };
    const streamFn: StreamFn = async (_selected, context, streamOptions) => {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("cave_run_aborted");
      }
      // A replay identity mismatch is first observable when the model emits
      // the tool call. Refuse the next provider call immediately instead of
      // letting Pi treat that mismatch as an ordinary recoverable tool error.
      activeDurableTools?.assertResumeSafe();
      if (spendFailure) throw spendFailure;
      if (usageFailure) throw usageFailure;
      if (nestedUsage.incomplete) throw new Error("cave_nested_usage_incomplete");
      if (efficiencyPlan && reasoningUsageUnavailable) {
        throw new Error("cave_reasoning_usage_unavailable");
      }
      if (efficiencyPlan) {
        enforceSemanticBudgets(contextBill(lowered.ir), outputTokens, efficiencyPlan);
        if (reasoningTokens > efficiencyPlan.budgets.reasoning) {
          throw new Error("cave_reasoning_budget_exceeded");
        }
      }
      // Any provider-stream bet that the just-finished turn did not claim is
      // cancelled and durably settled before routing or admitting another
      // paid call. This keeps breaker and receipt state causally ordered.
      await Promise.all(
        [...programmaticScopesByToolName.values()].map((scope) => scope.settleBeforeNextStream()),
      );
      // The hard model-call ceiling is a stop condition, not a failure: ending
      // the run through the same graceful path as every other stop keeps the
      // partial work and the receipt intact. Checked before the
      // increment so exactly `maxModelCalls` calls are allowed.
      if (modelCalls >= maxModelCalls) {
        stopReason = "call_budget_exhausted";
        refusalPending = true;
        throw new Error("cave_run_stopped");
      }
      let routed: Awaited<ReturnType<typeof resolveModelRoute>>;
      try {
        routed = await resolveModelRoute(activeWorkingModel, "working", context, streamOptions);
      } catch (error) {
        ladderFailure ??= error instanceof Error ? error : new Error(String(error));
        throw ladderFailure;
      }
      const selected = routed.selected;
      activeWorkingModel = selected;
      emitModelRoute(routed.decision);
      modelCalls++;
      // Trusted provider-request admission time. Reservation and settlement
      // retain this exact instant; no later wall clock can move the price tier.
      const accountingAt = new Date();
      // Between-calls stop point. Nothing is in flight here: the previous turn
      // and its tools have finished and settled, and this call has not started.
      const plan = () => decideNextCall({
        meter: budgetMeter,
        breakers,
        deadlineAt,
        selected,
        context,
        requestedOutputTokens: streamOptions?.maxTokens,
        outputMaxTokens: definition.output?.maxTokens,
        planOutputTokens: efficiencyPlan?.budgets.output,
        restorableBytes: restorableRequestBytes(
          conversationOriginals,
          instructions,
          originalInstructions,
        ),
        accountingAt,
      });
      let decided: NextCallDecision;
      try {
        decided = plan();
        // Escalation gets exactly one attempt per exhaustion: the handler either
        // funds the next call or it does not, and a handler that keeps releasing
        // slivers must not turn one stop into an unbounded loop.
        if (decided.action === "stop" && decided.reason === "budget_exhausted" &&
            budgetMeter !== undefined && typeof options.onBudgetExhausted === "function") {
          const outcome = await options.onBudgetExhausted(budgetExhaustionContext(budgetMeter));
          if (outcome !== "stop") {
            if (!isRecord(outcome) || typeof outcome.release !== "number" ||
                typeof outcome.reason !== "string") {
              throw new Error("cave_budget_exhaustion_result_invalid");
            }
            budgetMeter.release(outcome.release, outcome.reason);
            decided = plan();
          }
        }
      } catch (error) {
        // Pi answers a thrown streamFn with a synthesized terminal error turn,
        // which would otherwise replace this cause with a generic provider
        // failure. Record it first so the run reports what actually went wrong.
        ladderFailure ??= error instanceof Error ? error : new Error(String(error));
        throw ladderFailure;
      }
      if (decided.action === "stop") {
        // Pi answers a thrown streamFn with a synthesized zero-usage error turn,
        // so record the refusal before throwing or the stop becomes the usage
        // failure that turn produces.
        stopReason = decided.reason;
        refusalPending = true;
        throw new Error("cave_run_stopped");
      }
      if (decided.action === "compact") {
        // Compaction happens between turns, where a rewritten context can
        // persist. By the time a call is being made the ladder has only the
        // clamp and stop rungs left, so this branch is unreachable and fails
        // closed rather than silently proceeding at an unreserved cost.
        stopReason = "budget_exhausted";
        refusalPending = true;
        throw new Error("cave_run_stopped");
      }
      const pendingCall: PendingCallRecord = {
        model: selected,
        reservation: decided.reservation,
        reservationMeter: budgetMeter,
        retryAttempt: undefined,
        clampedOutputTokens: decided.clampedOutputTokens,
        accountingAt,
      };
      pendingCallRecords.push(pendingCall);
      // Pi answers a thrown streamFn with a synthesized zero-usage error turn,
      // so record the refusal before throwing or the terminal error becomes the
      // usage failure that turn produces.
      let spendReservations: SpendReservation[];
      try {
        spendReservations = reserveProviderSpend(
          executionContext.spendLedgers,
          selected,
          definition.output?.maxTokens ?? efficiencyPlan?.budgets.output,
          accountingAt,
        );
      } catch (error) {
        spendFailure ??= error instanceof Error ? error : new Error(String(error));
        const orphaned = pendingCallRecords.pop();
        if (orphaned?.reservation !== undefined) {
          orphaned.reservationMeter?.cancel(orphaned.reservation);
        }
        throw spendFailure;
      }
      pendingSpendReservations.push(spendReservations);
      const transformTrace = serializeTransformTrace(appliedPlan.trace);
      const requestHeaders = mergeHeaders(
        streamOptions?.headers,
        headers === undefined ? {} : {
          ...headers,
          "x-cave-context-bill": serializeContextBill(contextBill(lowered.ir)),
          "x-cave-transforms": appliedPlan.appliedTransformIDs.length > 0
            ? appliedPlan.appliedTransformIDs.join(",")
            : "caveman.pass-through.v1",
          ...(transformTrace === "" ? {} : { "x-cave-transform-trace": transformTrace }),
        },
      );
      // Cache-boundary bookkeeping writes gateway headers as it goes. Off the
      // gateway there is nothing to write them to, so the same code path leaks
      // nothing to the provider.
      const caveHeaders = headers === undefined ? undefined : requestHeaders;
      const setCaveHeader = (name: string, value: string): void => {
        if (caveHeaders !== undefined) caveHeaders[name] = value;
      };
      const upstreamOnPayload = streamOptions?.onPayload;
      const callSignal = options.signal === undefined
        ? streamOptions?.signal
        : streamOptions?.signal === undefined
          ? options.signal
          : AbortSignal.any([streamOptions.signal, options.signal]);
      const streamOnce = async () => {
        let source = await baseStream(selected, context, {
        ...streamOptions,
        ...(options.cacheRetention === undefined
          ? {}
          : { cacheRetention: options.cacheRetention }),
        // Pi resolves GEMINI_API_KEY only. SDK advertises GOOGLE_API_KEY too,
        // so expose alias under Pi's expected env name. Env overlay preserves
        // Pi's stored-credential precedence; explicit apiKey still wins.
        ...(selected.provider === "google" && streamOptions?.apiKey === undefined &&
            !streamOptions?.env?.GEMINI_API_KEY && !process.env.GEMINI_API_KEY &&
            process.env.GOOGLE_API_KEY
          ? { env: { ...(streamOptions?.env ?? {}), GEMINI_API_KEY: process.env.GOOGLE_API_KEY } }
          : {}),
        ...(callSignal === undefined ? {} : { signal: callSignal }),
        // The budget clamp is one more ceiling on the same allowance: it only
        // ever lowers what the call may ask for, never raises it.
        ...((definition.output === undefined && efficiencyPlan === undefined &&
            decided.clampedOutputTokens === undefined) ? {} : {
          maxTokens: Math.min(
            streamOptions?.maxTokens ?? definition.output?.maxTokens ??
              efficiencyPlan?.budgets.output ?? Number.MAX_SAFE_INTEGER,
            definition.output?.maxTokens ?? Number.MAX_SAFE_INTEGER,
            efficiencyPlan?.budgets.output ?? Number.MAX_SAFE_INTEGER,
            decided.clampedOutputTokens ?? Number.MAX_SAFE_INTEGER,
          ),
        }),
        sessionId,
        headers: requestHeaders,
        onPayload(payload, providerModel) {
          const inspect = (candidate: unknown): unknown => {
            let outgoing = candidate;
            let frozen = providerFrozenView(outgoing, providerModel.api);
            if (!frozen) {
              if (appliedPlan.appliedTransformIDs.length > 0) {
                cacheBust = true;
                outgoing = replaceExactStrings(outgoing, instructions, originalInstructions);
                markRequestPassThrough(caveHeaders, appliedPlan, "cache_boundary_unknown");
              }
              return outgoing;
            }
            cacheBoundaryKnown = true;
            const nextDigest = sha256(frozen.bytes);
            if (providerPrefixDigest === undefined) {
              providerPrefixDigest = nextDigest;
              providerFrozen = frozen;
              originalFrozen = providerFrozenView(
                restoreOriginalPayload(
                  replaceExactStrings(outgoing, instructions, originalInstructions),
                  conversationOriginals,
                ),
                providerModel.api,
              );
              setCaveHeader("x-cave-cache-prefix-sha256", nextDigest);
              return outgoing;
            }
            if (providerFrozen === undefined || !providerFrozenExtends(frozen, providerFrozen)) {
              cacheBust = true;
              outgoing = originalFrozen === undefined
                ? restoreOriginalPayload(
                  replaceExactStrings(outgoing, instructions, originalInstructions),
                  conversationOriginals,
                )
                : restoreProviderFrozen(outgoing, originalFrozen, frozen);
              frozen = providerFrozenView(outgoing, providerModel.api);
              const fallbackDigest = frozen === undefined ? prefixDigest : sha256(frozen.bytes);
              setCaveHeader(
                "x-cave-cache-epoch",
                `${definition.id}:${options.workflow ?? definition.id}:${sessionId}:fallback:${fallbackDigest.slice(0, 16)}`,
              );
              setCaveHeader("x-cave-cache-prefix-sha256", fallbackDigest);
              markRequestPassThrough(caveHeaders, appliedPlan, "cache_prefix_drift");
            } else {
              providerFrozen = frozen;
              originalFrozen = providerFrozenView(
                restoreOriginalPayload(
                  replaceExactStrings(outgoing, instructions, originalInstructions),
                  conversationOriginals,
                ),
                providerModel.api,
              );
              setCaveHeader("x-cave-cache-prefix-sha256", providerPrefixDigest);
            }
            return outgoing;
          };
          // Hints apply AFTER the frozen-view bookkeeping above, which
          // deliberately tracks the un-hinted payload: the digest stays
          // stable across calls whatever the planner decides per call.
          const replaced = upstreamOnPayload?.(payload, providerModel);
          if (replaced instanceof Promise) {
            return replaced.then((value) =>
              applyNativeCacheHints(
                inspect(value === undefined ? payload : value),
                providerModel,
              ));
          }
          return applyNativeCacheHints(
            inspect(replaced === undefined ? payload : replaced),
            providerModel,
          );
        },
        });
        for (const scope of programmaticScopesByToolName.values()) {
          source = scope.wrapStream(source);
        }
        return source;
      };
      if (activeJournal !== undefined) {
        // The intent is durable BEFORE the provider can be reached: a crash
        // from here until the settle lands is exactly the at-least-once
        // window, and the unmatched intent is what makes resume surface it
        // as a possible double-count instead of forgetting it.
        journalNewTranches();
        if (decided.reservation !== undefined && budgetMeter !== undefined) {
          journalMeterCall(budgetMeter);
        }
        activeJournal.emit({
          v: DURABLE_JOURNAL_VERSION,
          at: activeJournal.now(),
          type: "call_started",
          path: journalPath,
          kind: "model",
          provider: selected.provider,
          model: selected.id,
        });
        await activeJournal.flush();
      }
      // Cost-aware retry. Only a call that fails before producing any stream at
      // all is retried, because that is the one shape where nothing was spent
      // and nothing was consumed. Each retry takes a real hold from the run's
      // meter, then cancels it at measured zero if the pre-stream failure
      // repeats. Receipt events also sum worst-case reserved exposure, so a
      // zero-spend error storm still exhausts its declared allowance. Backoff
      // stays deterministic — a breaker has to be reproducible.
      const abandonPendingCall = (): void => {
        const index = pendingCallRecords.indexOf(pendingCall);
        if (index < 0) return;
        pendingCallRecords.splice(index, 1);
        const [legacyReservations] = pendingSpendReservations.splice(index, 1);
        if (legacyReservations !== undefined) releaseLedgerHolds(legacyReservations);
        if (activeJournal !== undefined) {
          // The reservation was cancelled before the provider was reached, so
          // the journaled intent is closed as unbilled rather than left to
          // read as a possible double-count on resume.
          activeJournal.emit({
            v: DURABLE_JOURNAL_VERSION,
            at: activeJournal.now(),
            type: "call_abandoned",
            path: journalPath,
          });
        }
      };
      if (breakers?.config.retryMaxSpend === undefined || decided.reservation === undefined) {
        try {
          return await streamOnce();
        } catch (error) {
          // Rejection before a stream exists is the same proven-unbilled
          // boundary as an exhausted retry: cancel the hold and close the
          // durable intent before the terminal failure is recorded.
          if (pendingCall.reservation !== undefined) {
            pendingCall.reservationMeter?.cancel(pendingCall.reservation);
            pendingCall.reservation = undefined;
            pendingCall.reservationMeter = undefined;
          }
          abandonPendingCall();
          throw error;
        }
      }
      const retryStopError = (): Error | undefined => {
        if (callSignal?.aborted) {
          return callSignal.reason instanceof Error
            ? callSignal.reason
            : new Error("cave_run_aborted");
        }
        if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
          stopReason = "deadline";
          refusalPending = true;
          return new Error("cave_run_stopped");
        }
        if (budgetMeter?.revoked) {
          stopReason = "wallet_revoked";
          refusalPending = true;
          return new Error("cave_run_stopped");
        }
        if (budgetMeter?.capBreached) {
          stopReason = "budget_exhausted";
          refusalPending = true;
          return new Error("cave_run_stopped");
        }
        return undefined;
      };
      return retryModelCall(
        streamOnce,
        breakers,
        pendingCall,
        retryStopError,
        (meter) => {
          journalMeterCall(meter);
          return activeJournal?.flush();
        },
        abandonPendingCall,
      );
    };

    const pi = new Agent({
      initialState: {
        systemPrompt: instructions,
        model: routedModel,
        thinkingLevel: definition.reasoning,
        tools: piTools,
        ...(conversation === undefined ? {} : {
          messages: initialProviderMessages,
        }),
      },
      sessionId,
      streamFn,
      transformContext: async (messages) => injectMemoryPrompt(
        await transformConversationContext(
          messages,
          originalConversationMessages.length,
          lowered,
          efficiencyPlan,
          options.engineBin,
          appliedPlan,
          conversationOriginals,
          options.signal,
        ),
        originalConversationMessages.length,
        passiveRecall?.prompt,
      ),
      // The between-calls point where a compaction can persist: the turn has
      // settled, no tool is in flight, and the replacement context this returns
      // is what the next call is built from.
      prepareNextTurnWithContext: async (turn) => {
        if (budgetMeter === undefined || budgetMeter.onExhausted !== "compact") return undefined;
        if (compactionsUsed >= budgetMeter.compaction.maxCompactions) return undefined;
        // Pi runs this hook after EVERY turn, including the last one. A turn
        // that asked for no tools is the end of the loop: no working call
        // follows it, so a rewrite here would buy a context nothing reads.
        const requestedTools = turn.message.role === "assistant" &&
          turn.message.content.some((part) => part.type === "toolCall");
        if (!requestedTools) return undefined;
        // The run has already decided to stop; paying a summarizer now buys
        // nothing. The ladder's other stop conditions bind here exactly as they
        // bind at the call boundary.
        if (breakers?.tripped !== undefined) return undefined;
        if (deadlineAt !== undefined && performance.now() >= deadlineAt) return undefined;
        const outputTokenCap = Math.min(
          definition.output?.maxTokens ?? Number.MAX_SAFE_INTEGER,
          efficiencyPlan?.budgets.output ?? Number.MAX_SAFE_INTEGER,
          activeWorkingModel.maxTokens,
        );
        const nextCall = callCeilingFor(
          activeWorkingModel,
          instructions,
          turn.context.messages,
          turn.context.tools,
          outputTokenCap,
        );
        const compactionDecisionAt = new Date();
        const nextCallCost = callCeilingCost(
          budgetMeter.denomination,
          nextCall,
          nextCall.outputTokenCap,
          compactionDecisionAt,
        );
        // Trigger before exhaustion. At-max same-model compaction is
        // mathematically unreachable: once one working call no longer fits,
        // that same-sized summarizer plus post-rewrite headroom cannot fit
        // either. Four call ceilings preserves default-on compact-and-continue
        // while every actual provider call remains hard-reserved.
        if (nextCallCost === undefined ||
            budgetMeter.remaining() >= COMPACTION_TRIGGER_MULTIPLIER * nextCallCost) {
          return undefined;
        }
        const compacted = await compactContext({
          generation: compactionsUsed + 1,
          messages: turn.context.messages,
          systemPrompt: instructions,
          tools: turn.context.tools,
          meter: budgetMeter,
          selected: activeWorkingModel,
          outputTokenCap,
          baseStream,
          sessionId,
          signal: options.signal,
          previousSummary,
          receipt,
          headers,
          spendLedgers: executionContext.spendLedgers,
          routeModel: (selected, context, streamOptions) =>
            resolveModelRoute(selected, "compaction", context, streamOptions),
          onReserved: (compactionModel, decision) => {
            emitModelRoute(decision);
            compactionsSpent++;
            if (activeJournal === undefined) return;
            journalMeterCall(budgetMeter);
            activeJournal.emit({
              v: DURABLE_JOURNAL_VERSION,
              at: activeJournal.now(),
              type: "call_started",
              path: journalPath,
              kind: "compaction",
              provider: compactionModel.provider,
              model: compactionModel.id,
            });
            // Returned so compactContext awaits it before the summarizer
            // call leaves — the intent is durable first, exactly like a
            // working call's.
            return activeJournal.flush();
          },
          onAbandoned: () => {
            if (activeJournal === undefined) return;
            activeJournal.emit({
              v: DURABLE_JOURNAL_VERSION,
              at: activeJournal.now(),
              type: "call_abandoned",
              path: journalPath,
            });
            // Close the already-flushed intent before the fallback lets the
            // run continue and possibly complete.
            return activeJournal.flush();
          },
          // A compaction is a provider call this run made. Its usage joins the
          // run's own totals so RunResult and the receipt cannot disagree, and
          // so a parent aggregating this child sees the whole cost.
          accrue: (usage, compactionModel, settledAmount) => {
            if (usage === undefined) {
              usageFailure ??= new Error("cave_provider_usage_incomplete");
              unpricedCall = true;
              if (activeJournal !== undefined) {
                activeJournal.emit({
                  v: DURABLE_JOURNAL_VERSION,
                  at: activeJournal.now(),
                  type: "call_settled",
                  path: journalPath,
                  kind: "compaction",
                  call: {
                    provider: compactionModel.provider,
                    model: compactionModel.id,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    reasoningTokens: 0,
                    estimatedUsd: 0,
                    unpriced: true,
                    usageBasis: "unavailable",
                  },
                  ...(budgetMeter === undefined ? {} : { settledAmount }),
                });
              }
              return;
            }
            inputTokens += usage.inputTokens;
            outputTokens += usage.outputTokens;
            cacheReadTokens += usage.cacheReadTokens;
            cacheWriteTokens += usage.cacheWriteTokens;
            reasoningTokens += usage.reasoningTokens;
            costUsd += usage.catalogCostUsd;
            if (!usage.priced) unpricedCall = true;
            previousRouteUsage = {
              model: `${usage.provider}/${usage.model}`,
              inputTokens: usage.inputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
            };
            lastCallCacheState = usage.cacheReadTokens > 0 ? "warm" : "cold";
            if (activeJournal !== undefined) {
              activeJournal.emit({
                v: DURABLE_JOURNAL_VERSION,
                at: activeJournal.now(),
                type: "call_settled",
                path: journalPath,
                kind: "compaction",
                call: {
                  provider: usage.provider,
                  model: usage.model,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  cacheReadTokens: usage.cacheReadTokens,
                  cacheWriteTokens: usage.cacheWriteTokens,
                  reasoningTokens: usage.reasoningTokens,
                  estimatedUsd: usage.catalogCostUsd,
                  unpriced: !usage.priced,
                  usageBasis: "provider_reported",
                },
                ...(budgetMeter === undefined ? {} : { settledAmount }),
              });
            }
          },
          cacheState: lastCallCacheState,
        });
        // Only an attempt that actually reserved counts against the cap. A
        // precondition decline costs nothing, so burning the budget on one
        // would close the rung for a later turn that could have afforded it —
        // while a summarizer producing unusable output must still be stopped
        // from being retried every turn at a paid call each time.
        if (compactionsSpent > compactionsUsed) compactionsUsed = compactionsSpent;
        if (compacted === undefined) return undefined;
        // A rollover makes no provider call, so it takes no reservation and
        // `compactionsSpent` never sees it. Counting it here is what keeps
        // `maxCompactions` binding on the free rung too.
        if (compacted.tier === "new-context") compactionsUsed++;
        previousSummary = compacted.summary;
        // Deliberately NOT journaled as a snapshot: pi's state.messages is
        // append-only — the replacement context below lives only in the
        // loop's local view, so the journal keeps following pi.state (the
        // same transcript commitConversation would persist). A resume
        // therefore rebuilds the full pre-compaction history and, because
        // compaction counters are not restored, may pay to compact it again
        // — metered, journaled, budget-bounded. Journaling compacted.messages
        // here instead would be overwritten by the next turn's state delta.
        if (journal !== undefined) {
          journalNewTranches();
          await journal.flush();
        }
        return { context: { ...turn.context, messages: compacted.messages } };
      },
      beforeToolCall: async ({ toolCall, args, assistantMessage }) => {
        accountProviderMessage(assistantMessage);
        const configured = configuredToolsByName.get(toolCall.name);
        if (deadlineAt !== undefined && performance.now() >= deadlineAt) {
          stopReason = "deadline";
          return { block: true, reason: "cave_run_deadline_exceeded" };
        }
        if (budgetMeter?.revoked) {
          stopReason = "wallet_revoked";
          return { block: true, reason: "cave_budget_revoked" };
        }
        if (budgetMeter !== undefined &&
            (budgetMeter.capBreached || budgetMeter.remaining() <= 0)) {
          stopReason = "budget_exhausted";
          return { block: true, reason: "cave_budget_exhausted" };
        }
        // Pi emits tool_execution_start before this hook, so direct calls are
        // already admitted. Composite containers do not consume this cap;
        // their kernel-dispatched nested calls do.
        if (toolBudgetCallCount > maxToolCalls) {
          return { block: true, reason: "cave_tool_call_budget_exceeded" };
        }
        if (configured?.nestedTools !== undefined) {
          if (compositeEnvelopeCallCount > maxToolCalls) {
            return { block: true, reason: "cave_tool_call_budget_exceeded" };
          }
          if (compositeEnvelopeTurnKey !== assistantMessage) {
            compositeEnvelopeTurnKey = assistantMessage;
            compositeEnvelopeTurnCount = 0;
          }
          compositeEnvelopeTurnCount++;
          if (breakers !== undefined &&
              compositeEnvelopeTurnCount > breakers.config.maxToolCallsPerTurn) {
            return { block: true, reason: "cave_fan_out_cap_exceeded" };
          }
        }
        if (breakers !== undefined && configured?.nestedTools === undefined) {
          const decision = breakers.observeToolCall({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args,
            allowRepeat: configured?.allowRepeat === true,
            turnKey: assistantMessage,
          });
          if (decision.block) return { block: true, reason: decision.reason! };
        }
        if ((toolCall.name === "cave_retrieve" && needsRecoveryTool) ||
            (toolCall.name.startsWith("cave_memory_") && definition.memory !== undefined)) {
          if (args === null || typeof args !== "object" || Array.isArray(args)) {
            return { block: true, reason: "cave_tool_arguments_invalid" };
          }
          return undefined;
        }
        if (!configured) return { block: true, reason: "cave_unknown_tool" };
        if (configured.effect === "write" && definition.sandbox === "fixture") {
          return { block: true, reason: "cave_side_effect_blocked" };
        }
        if (configured.nestedTools !== undefined && definition.sandbox === "required") {
          return { block: true, reason: "cave_nested_tool_sandbox_unsupported" };
        }
        if (definition.sandbox === "required" &&
            configured.runtime?.kind !== "subagent" &&
            configured.runtime?.kind !== "caveman-connect" &&
            options.entryPath === undefined) {
          return { block: true, reason: "cave_sandbox_entry_required" };
        }
        if (args === null || typeof args !== "object" || Array.isArray(args)) {
          return { block: true, reason: "cave_tool_arguments_invalid" };
        }
        if (configured.nestedTools !== undefined) {
          const activation = programmaticScopesByToolName.get(configured.name)?.activate(
            toolCall.id,
            assistantMessage,
            isRecord(args) ? args.code : undefined,
          );
          if (activation === undefined) {
            compositeTurnKeys.set(toolCall.id, assistantMessage);
          } else {
            compositeTurnKeys.set(toolCall.id, activation.turnKey);
            const speculativeOutcomes = nestedOutcomesByParent.get(
              activation.provisionalParentToolCallId,
            );
            if (speculativeOutcomes !== undefined) {
              nestedOutcomesByParent.delete(activation.provisionalParentToolCallId);
              nestedOutcomesByParent.set(toolCall.id, speculativeOutcomes);
            }
            const speculativeScheduler = nestedSchedulersByParent.get(
              activation.provisionalParentToolCallId,
            );
            if (speculativeScheduler !== undefined) {
              nestedSchedulersByParent.delete(activation.provisionalParentToolCallId);
              nestedSchedulersByParent.set(toolCall.id, speculativeScheduler);
            }
            const speculativeRawSettlements = nestedRawSettlementsByParent.get(
              activation.provisionalParentToolCallId,
            );
            if (speculativeRawSettlements !== undefined) {
              nestedRawSettlementsByParent.delete(activation.provisionalParentToolCallId);
              nestedRawSettlementsByParent.set(toolCall.id, speculativeRawSettlements);
            }
          }
        }
        // After composite activation on purpose: a denied composite then owns its
        // speculative nested state under its own id, so tool_execution_end folds
        // it instead of stranding it under the provisional key.
        if (options.toolPolicy !== undefined) {
          let denial;
          try {
            denial = await decideToolCall(options.toolPolicy, {
              runId,
              agentId: definition.id,
              agentPath: executionContext.agentPath,
              toolCallId: toolCall.id,
              name: configured.name,
              effect: configured.effect,
              args,
            });
          } catch (error) {
            failPolicy(error);
            return { block: true, reason: "cave_tool_policy_failed" };
          }
          if (denial !== undefined) {
            receipt.recordToolDenial(configured.name);
            return denial;
          }
        }
        return undefined;
      },
    });

    options.controller?._attach(pi);
    controlledAgent = pi;

    let terminal = false;
    pi.subscribe((event) => {
      options.controller?._observe(event);
      // The one turn Pi synthesizes for a refused call carries no provider
      // evidence. It is recorded as the run's own stop, never accounted.
      let synthesizedRefusal = false;
      if (event.type === "turn_end" && event.message.role === "assistant" && refusalPending) {
        synthesizedRefusal = true;
        refusalPending = false;
        refusalMessage = event.message;
      }
      if (event.type === "turn_end" && event.message.role === "assistant" &&
          !synthesizedRefusal) {
        accountProviderMessage(event.message);
        breakers?.observeTurn(
          assistantText(event.message),
          event.toolResults.map((item) => ({
            toolName: item.toolName,
            isError: item.isError,
            content: item.content,
          })),
          turnStateChanged,
        );
        turnStateChanged = false;
      }
      if (event.type === "tool_execution_start") {
        toolCalls.push(event.toolName);
        receipt.recordToolCall(event.toolName);
        if (configuredToolsByName.get(event.toolName)?.nestedTools === undefined) {
          toolBudgetCallCount++;
        } else {
          compositeEnvelopeCallCount++;
        }
      }
      if (event.type === "tool_execution_end") {
        receipt.recordToolOutcome(event.toolName, event.isError);
        const configured = configuredToolsByName.get(event.toolName);
        if (configured?.nestedTools === undefined) {
          breakers?.observeToolResult(event.toolCallId, event.isError);
        } else {
          foldNestedOutcomes(event.toolCallId);
          compositeTurnKeys.delete(event.toolCallId);
        }
        if (configured?.nestedTools === undefined) {
          toolErrorStreak = event.isError ? toolErrorStreak + 1 : 0;
        }
        // Progress follows state, not display text. Declared writes are the
        // obvious case; framework-owned memory tools and successful subagents
        // can also mutate durable or opaque child state while returning the
        // same short result each turn.
        if (!event.isError && ((configured?.nestedTools === undefined && configured?.effect === "write") ||
            configured?.runtime?.kind === "subagent" ||
            event.toolName.startsWith("cave_memory_"))) {
          turnStateChanged = true;
        }
      }
      queued.push({ type: "pi", runId, event });
      if (event.type === "agent_end") terminal = true;
      wake?.();
      wake = undefined;
    });
    if (journal !== undefined) {
      const ownJournal = journal;
      // Second, ASYNC subscriber: pi awaits listener promises in order, so a
      // turn is durable before the loop can start the next call — the same
      // barrier DBOS gets from its per-step checkpoint write. Registered
      // after the accounting subscriber so refusalMessage is already set
      // when a synthesized refusal turn arrives here.
      pi.subscribe(async (event) => {
        if (event.type !== "turn_end") return;
        // The synthesized refusal turn is the runtime declining to spend, not
        // conversation state; committed conversations drop it and so does the
        // journal.
        if (event.message === refusalMessage) return;
        // An error/aborted terminal turn is the crash itself, not state to
        // resume FROM: journaling it would make the resumed transcript end in
        // the failure it is recovering from.
        if (event.message.role === "assistant" &&
            (event.message.stopReason === "error" || event.message.stopReason === "aborted")) {
          return;
        }
        const messages = pi.state.messages;
        if (journaledMessagesLen > 0 &&
            messages[journaledMessagesLen - 1] !== journaledMessagesTail) {
          ownJournal.emit({
            v: DURABLE_JOURNAL_VERSION,
            at: ownJournal.now(),
            type: "snapshot",
            messages: structuredClone(messages) as unknown[],
          });
        } else if (messages.length > journaledMessagesLen) {
          ownJournal.emit({
            v: DURABLE_JOURNAL_VERSION,
            at: ownJournal.now(),
            type: "turn",
            messages: structuredClone(messages.slice(journaledMessagesLen)) as unknown[],
          });
        }
        journaledMessagesLen = messages.length;
        journaledMessagesTail = messages.at(-1);
        journalNewTranches();
        await ownJournal.flush();
      });
    }

    const abort = () => pi.abort();
    activeAbort = abort;
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) pi.abort();
    // A resumed run re-enters the loop mid-transcript: the seed ends at a
    // turn boundary (user or tool-result message — analyzeJournal trimmed to
    // one), so `continue()` picks up where the crashed process stopped
    // instead of `prompt()` appending the original input a second time.
    const resumeContinue = durableResume?.hasCompletedTurn === true;
    const execution = (resumeContinue
      ? pi.continue()
      : preparedInput.promptContent === undefined
        ? pi.prompt(input as string)
        : pi.prompt({
          role: "user" as const,
          content: [...preparedInput.promptContent],
          timestamp: Date.now(),
        })).catch((error: unknown) => {
      terminal = true;
      wake?.();
      wake = undefined;
      throw error;
    });
    activeExecution = execution;

    while (!terminal || queued.length > 0) {
      if (queued.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      while (queued.length > 0) {
        yield queued.shift()!;
      }
    }
    await execution;
    await closeProgrammaticSpeculation();
    activeDurableTools?.assertReconciled();
    if (efficiencyPlan && reasoningUsageUnavailable) {
      throw new Error("cave_reasoning_usage_unavailable");
    }
    if (ladderFailure) throw ladderFailure;
    if (policyFailure) throw policyFailure;
    if (spendFailure) throw spendFailure;
    if (usageFailure !== undefined &&
        (efficiencyPlan !== undefined ||
          executionContext.spendLedgers.length > 0 ||
          usageFailure.message === "cave_provider_model_identity_mismatch" ||
          usageFailure.message === "cave_provider_identity_missing")) {
      throw usageFailure;
    }
    if (pendingSpendReservations.length > 0) {
      markSpendIncomplete(executionContext.spendLedgers);
      throw new Error("cave_subagent_spend_evidence_incomplete");
    }
    // A run stopped before its first call has no assistant message, and that is
    // the honest outcome rather than missing evidence: the caller gets an empty
    // answer, zero usage, and the reason the runtime declined to spend.
    if (!finalMessage && stopReason === undefined) {
      throw new Error("cave_incomplete_evidence: Pi emitted no final assistant message");
    }
    if (finalMessage &&
        (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted")) {
      throw new Error(`cave_provider_terminal_${finalMessage.stopReason}`);
    }
    const text = finalMessage === undefined ? "" : assistantText(finalMessage);
    if (ambientMemoryActive && text !== "") {
      memoryEngine?.endTurn({ sessionId, text });
    }
    let output: { readonly value: unknown } | undefined;
    if (definition.output?.schema && finalMessage !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("cave_output_schema_invalid_json");
      }
      if (!Value.Check(definition.output.schema, parsed)) {
        throw new Error("cave_output_schema_mismatch");
      }
      output = { value: parsed };
    }
    if (appliedPlan.appliedTransformIDs.length > 0 && !cacheBoundaryKnown) {
      cacheBust = true;
      markRequestPassThrough(headers, appliedPlan, "cache_boundary_unobserved");
    }
    for (const child of nestedReceipts) receipt.recordSubagent(child);
    // A resumed run's totals cover the LOGICAL run: prior attempts' settled
    // calls are folded in from the journal. Their per-call detail stays in
    // the journal; the receipt summarizes them under `resume`.
    const priorTotals = durableResume?.priorTotals;
    const receiptResume: ReceiptResume | undefined = durableResume === undefined
      ? undefined
      : {
        attempts: durableResume.attempts + 1,
        priorCalls: durableResume.priorCalls,
        priorEstimatedUsd: durableResume.priorTotals.estimatedUsd,
        priorTokens: durableResume.priorTotals.totalTokens,
        priorUnpriced: durableResume.priorTotals.unpriced ||
          durableResume.priorTotals.anyUsageUnavailable,
        priorSettled: budgetMeter === undefined ? undefined : durableResume.priorSettled,
        possibleDoubleCountCalls: durableResume.possibleDoubleCountCalls,
        discardedPartialTurn: durableResume.discardedPartialTurn,
      };
    // Built once so the result and its receipt cannot disagree about a breach.
    const runReceipt = receipt.build({
      runId,
      agentId: definition.id,
      stopReason: stopReason ?? "complete",
      meter: budgetMeter,
      ...(breakers === undefined ? {} : { breakers: breakers.recorded }),
      ...(receiptResume === undefined ? {} : { resume: receiptResume }),
    });
    const result: RunResult = {
      runId,
      agentId: definition.id,
      text,
      ...(output === undefined ? {} : { output: output.value }),
      contextIR: lowered.ir,
      contextBill: contextBill(lowered.ir),
      cachePrefixSHA256: providerPrefixDigest ?? prefixDigest,
      cacheBoundaryKnown,
      cacheBust,
      usageBasis: usageFailure === undefined ? "provider_reported" : "unavailable",
      inputTokens: usageFailure === undefined
        ? inputTokens + nestedUsage.inputTokens + (priorTotals?.inputTokens ?? 0)
        : 0,
      outputTokens: usageFailure === undefined
        ? outputTokens + nestedUsage.outputTokens + (priorTotals?.outputTokens ?? 0)
        : 0,
      cacheReadTokens: usageFailure === undefined
        ? cacheReadTokens + nestedUsage.cacheReadTokens + (priorTotals?.cacheReadTokens ?? 0)
        : 0,
      cacheWriteTokens: usageFailure === undefined
        ? cacheWriteTokens + nestedUsage.cacheWriteTokens + (priorTotals?.cacheWriteTokens ?? 0)
        : 0,
      reasoningUsageBasis: usageFailure === undefined && !reasoningUsageUnavailable
        ? "provider_reported"
        : "unavailable",
      reasoningTokens: usageFailure === undefined
        ? reasoningTokens + nestedUsage.reasoningTokens + (priorTotals?.reasoningTokens ?? 0)
        : 0,
      costUsd: usageFailure === undefined
        ? costUsd + nestedUsage.costUsd + (priorTotals?.estimatedUsd ?? 0)
        : 0,
      priceBasis: usageFailure === undefined && !unpricedCall && !nestedUsage.unpriced &&
          !(receiptResume?.priorUnpriced ?? false)
        ? "public_catalog"
        : "unpriced",
      // A caller-supplied streamFn produced this turn in-process: whatever the
      // gateway is doing, it did not optimize a request it never saw.
      mode: gatewayActive && options.streamFn === undefined && !nestedUsage.observeOnly
        ? "optimized"
        : "observe-only",
      provider: finalMessage?.provider ?? routedModel.provider,
      model: finalMessage?.model ?? routedModel.id,
      latencyMs: Math.round(performance.now() - startedAt),
      toolCalls,
      evaluatedTransformIDs: appliedPlan.evaluatedTransformIDs,
      transformIDs: appliedPlan.appliedTransformIDs,
      transformFailures: appliedPlan.failures,
      transformTrace: appliedPlan.trace.map(({ recoveryHandle: _handle, ...item }) => item),
      recoveryResolved: appliedPlan.recoveryResolved,
      stopReason: stopReason ?? "complete",
      capBreached: runReceipt.capBreached,
      overspent: runReceipt.overspent,
      receipt: runReceipt,
      claimBasis: "inferred",
      unlocked: buildIdentity === undefined,
      ...(durableResume === undefined ? {} : { resumed: true }),
    };
    if (efficiencyPlan) {
      if (result.reasoningUsageBasis !== "provider_reported") {
        throw new Error("cave_reasoning_usage_unavailable");
      }
      if (result.reasoningTokens > efficiencyPlan.budgets.reasoning) {
        throw new Error("cave_reasoning_budget_exceeded");
      }
    }
    if (efficiencyPlan) {
      enforceSemanticBudgets(result.contextBill, result.outputTokens, efficiencyPlan);
    }
    let conversationCommit: Parameters<typeof commitConversation>[1] | undefined;
    let completedConversation: DurableConversationCheckpoint | undefined;
    if (conversation) {
      const produced = pi.state.messages.slice(initialProviderMessages.length);
      // The refusal turn is the runtime declining to spend, not something the
      // model said. Resuming this conversation must not replay it.
      if (refusalMessage !== undefined && produced.at(-1) === refusalMessage) produced.pop();
      conversationCommit = {
        messages: [
          ...originalConversationMessages,
          ...produced,
        ],
        cachePrefixDigest: providerPrefixDigest,
        providerFrozen,
        originalFrozen,
        fingerprint: conversationFingerprint,
      };
      const durableConversationSession = options.conversation?.sessionId ??
        durableResume?.conversation?.sessionId;
      if (durableConversationSession !== undefined) {
        completedConversation = durableConversationCheckpoint(
          durableConversationSession,
          conversationCommit.messages,
        );
      }
    } else if (durableResume?.conversation !== undefined) {
      // A real process restart may resume a run without reconstructing the
      // caller's ephemeral Conversation object. The journal still owns the
      // exact logical session and must carry its final transcript so a later
      // attached Conversation can synchronize from base to terminal state.
      // Same rule as the branch above: the synthesized refusal turn is the
      // runtime declining to spend, so it must not enter the checkpoint a
      // later attached Conversation synchronizes from.
      const produced = [...pi.state.messages];
      if (refusalMessage !== undefined && produced.at(-1) === refusalMessage) produced.pop();
      completedConversation = durableConversationCheckpoint(
        durableResume.conversation.sessionId,
        produced,
      );
    }
    if (journal !== undefined) {
      // The outcome is durable BEFORE the caller sees it (DBOS ordering):
      // once run_end is yielded, re-invoking this runId must replay this
      // exact result instead of spending again. If the outcome CANNOT be
      // journaled (serialization, disk), the logical run stays pending and
      // this attempt fails;
      // exposing success before durable truth would permit duplicate effects.
      journalNewTranches();
      journal.emit({
        v: DURABLE_JOURNAL_VERSION,
        at: journal.now(),
        type: "run_completed",
        result,
        ...(completedConversation === undefined
          ? {}
          : { conversation: completedConversation }),
      });
      await journal.flush();
      durableTerminalPersisted = true;
    }
    if (conversation !== undefined && conversationCommit !== undefined) {
      // External state moves only after terminal fsync. Crash between these
      // operations is repaired by terminal replay's checkpoint sync.
      commitConversation(conversation, conversationCommit);
    }
    releaseConversation();
    await releaseRunResources();
    finishInvocationSpan(1);
    yield { type: "run_end", runId, result };
  } catch (caughtError) {
    let error: unknown = caughtError;
    if (pendingSpendReservations.length > 0) {
      markSpendIncomplete(executionContext.spendLedgers);
    }
    // The run is over; nothing carved from its budget may keep spending. Any
    // subagent still in flight stops between its own calls.
    budgetMeter?.revoke();
    activeAbort?.();
    if (activeExecution) await activeExecution.catch(() => undefined);
    try {
      await closeProgrammaticSpeculation();
    } catch (settlementError) {
      error = settlementError;
    }
    releaseConversation();
    // Every run — budgeted or not, succeeded or failed — returns its ledger.
    // Built from the same ReceiptRecorder the success path uses, so the calls,
    // tools, and metered spend that happened before the failure survive it
    for (const child of nestedReceipts) receipt.recordSubagent(child);
    // Built defensively: a receipt-build failure must never mask
    // the original error.
    const failureResume: ReceiptResume | undefined = durableResume === undefined
      ? undefined
      : {
        attempts: durableResume.attempts + 1,
        priorCalls: durableResume.priorCalls,
        priorEstimatedUsd: durableResume.priorTotals.estimatedUsd,
        priorTokens: durableResume.priorTotals.totalTokens,
        priorUnpriced: durableResume.priorTotals.unpriced ||
          durableResume.priorTotals.anyUsageUnavailable,
        priorSettled: budgetMeter === undefined ? undefined : durableResume.priorSettled,
        possibleDoubleCountCalls: durableResume.possibleDoubleCountCalls,
        discardedPartialTurn: durableResume.discardedPartialTurn,
      };
    let partialReceipt: RunReceipt;
    try {
      partialReceipt = receipt.build({
        runId,
        agentId: definition.id,
        stopReason: stopReason ?? "complete",
        meter: budgetMeter,
        ...(breakers === undefined ? {} : { breakers: breakers.recorded }),
        ...(failureResume === undefined ? {} : { resume: failureResume }),
      });
    } catch {
      // Dropping the meter makes this receipt denomination-less, so every
      // money-bearing companion the validator ties to a denomination has to go
      // with it: a journaled `priorSettled`, and any subagent/compaction the
      // recorder still holds. Otherwise this "defensive" rebuild throws for
      // exactly the runs it exists to protect and masks the real error.
      const denominationless = failureResume === undefined
        ? undefined
        : { ...failureResume, priorSettled: undefined };
      try {
        partialReceipt = receipt.build({
          runId,
          agentId: definition.id,
          stopReason: stopReason ?? "complete",
          meter: undefined,
          ...(denominationless === undefined ? {} : { resume: denominationless }),
        });
      } catch {
        partialReceipt = new ReceiptRecorder().build({
          runId,
          agentId: definition.id,
          stopReason: stopReason ?? "complete",
          meter: undefined,
        });
      }
    }
    if (journal !== undefined && !durableTerminalPersisted && options.signal?.aborted !== true) {
      // A thrown run is TERMINAL for its runId (DBOS: an errored workflow is
      // not silently re-run) — re-invoking replays this same error. The one
      // exception is an abort: a caller cancelling a run is the deliberate
      // twin of a crash, so the journal stays pending and the run resumable.
      try {
        journalNewTranches();
        journal.emit({
          v: DURABLE_JOURNAL_VERSION,
          at: journal.now(),
          type: "run_failed",
          code: errorCode(error),
          message: boundedDurableMessage(error),
          receipt: partialReceipt,
        });
        await journal.flush();
      } catch {
        // Journaling the failure must never mask the failure itself; an
        // unwritten terminal event leaves the run pending, which resume
        // handles honestly.
      }
    }
    await releaseRunResources();
    finishInvocationSpan(2);
    yield {
      type: "run_error",
      runId,
      code: errorCode(error),
      message: error instanceof Error ? error.message : String(error),
      receipt: partialReceipt,
    };
  } finally {
    activeAbort?.();
    if (activeExecution) await activeExecution.catch(() => undefined);
    await closeProgrammaticSpeculation().catch(() => undefined);
    if (controlledAgent !== undefined) options.controller?._detach(controlledAgent);
    if (activeAbort) options.signal?.removeEventListener("abort", activeAbort);
    releaseConversation();
    // Idempotent backstop for the abort/return() paths that never reached a
    // terminal yield; the success and error paths already released above.
    await releaseRunResources();
    if (journal !== undefined) {
      // Whatever was queued (a cancelled run's last settles) still lands; a
      // failed flush leaves the journal short, which resume reads as the
      // documented in-flight uncertainty rather than as corruption.
      await journal.flush().catch(() => undefined);
    }
    if (durableRelease !== undefined) await durableRelease().catch(() => undefined);
    if (durableStore !== undefined) await durableStore.close(runId).catch(() => undefined);
    finishInvocationSpan(0);
  }
}

async function stageSandboxSourceGraph(
  root: string,
  entryPath: string,
  frameworkDistRoot: string,
): Promise<SandboxSourceSnapshot> {
  const canonicalRoot = await realpath(root);
  const canonicalEntry = await realpath(entryPath);
  const entryName = relative(canonicalRoot, canonicalEntry);
  if (escapesRoot(entryName)) {
    throw new Error("cave_tool_sandbox_entry_escapes_root");
  }
  const canonicalFrameworkDist = await realpath(frameworkDistRoot);
  const graph = [...await expandSourceGraph(
    canonicalRoot,
    [canonicalEntry],
    false,
    [canonicalFrameworkDist],
  )].sort();
  const staging = await realpath(await mkdtemp(resolve(tmpdir(), "caveman-agent-source-")));
  try {
    const stagedFiles: string[] = [];
    await copyOptionalSandboxFile(
      resolve(canonicalRoot, "package.json"),
      resolve(staging, "package.json"),
      stagedFiles,
    );
    for (const source of graph) {
      if (!escapesRoot(relative(canonicalFrameworkDist, source))) {
        continue;
      }
      const name = relative(canonicalRoot, source);
      if (escapesRoot(name)) throw new Error("cave_tool_sandbox_source_escapes_root");
      const destination = resolve(staging, name);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      stagedFiles.push(destination);
    }
    const frameworkName = relative(canonicalRoot, canonicalFrameworkDist);
    if (!escapesRoot(frameworkName)) {
      const frameworkDestination = resolve(staging, frameworkName);
      await mkdir(dirname(frameworkDestination), { recursive: true });
      await symlink(
        canonicalFrameworkDist,
        frameworkDestination,
        process.platform === "win32" ? "junction" : "dir",
      );
      stagedFiles.push(frameworkDestination);
    }
    const nodeModules = await realpath(resolve(canonicalRoot, "node_modules"));
    await symlink(
      nodeModules,
      resolve(staging, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    stagedFiles.push(resolve(staging, "node_modules"));
    let disposed = false;
    return {
      stagingRoot: staging,
      entryPath: resolve(staging, entryName),
      sourceFiles: Object.freeze(stagedFiles),
      async dispose() {
        if (disposed) return;
        disposed = true;
        await rm(staging, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function copyOptionalSandboxFile(
  source: string,
  destination: string,
  stagedFiles: string[],
): Promise<void> {
  try {
    await readFile(source);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    stagedFiles.push(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function escapesRoot(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

type ConversationTextSegment = {
  id: string;
  kind: "history" | "tool_result";
  messageIndex: number;
  contentIndex?: number;
  text: string;
};

/**
 * Content-derived runtime segment id. Naming a live-zone segment
 * by a digest of its text — not its position — means the same message always
 * gets the same id and, crucially, a different message never inherits another
 * message's id after compaction shifts the indices. The 16-hex prefix is ample
 * for per-run uniqueness; `appendRuntimeContextSegment` still fails closed on a
 * same-id/different-bytes collision.
 */
function runtimeSegmentId(kind: "history" | "tool_result", text: string): string {
  return `runtime.${kind}.${sha256(text).slice(0, 16)}`;
}

function conversationTextSegments(
  messages: readonly AgentMessage[],
  currentPromptIndex = -1,
): ConversationTextSegment[] {
  const segments: ConversationTextSegment[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    if (messageIndex === currentPromptIndex) continue;
    const message = messages[messageIndex];
    if (!isRecord(message) ||
        !["user", "assistant", "toolResult"].includes(String(message.role))) {
      continue;
    }
    const kind = message.role === "toolResult" ? "tool_result" : "history";
    if (typeof message.content === "string") {
      segments.push({
        // Content-derived identity: a segment is named by the
        // bytes it carries, never by its position. Compaction rewrites the
        // message list and shifts every index, so a positional id would let a
        // NEW message inherit a PRIOR turn's message's compressed body. The
        // messageIndex/contentIndex below still locate the message to
        // substitute; they no longer decide identity.
        id: runtimeSegmentId(kind, message.content),
        kind,
        messageIndex,
        text: message.content,
      });
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (let contentIndex = 0; contentIndex < message.content.length; contentIndex++) {
      const content = message.content[contentIndex];
      if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") continue;
      segments.push({
        id: runtimeSegmentId(kind, content.text),
        kind,
        messageIndex,
        contentIndex,
        text: content.text,
      });
    }
  }
  return segments;
}

/** Content-blind accounting projection for prior provider-visible images. */
function conversationMediaSegments(
  messages: readonly AgentMessage[],
  currentPromptIndex = -1,
) {
  const segments: Array<{
    id: string;
    kind: "history" | "tool_result";
    body: Uint8Array;
    providerVisibleBytes: number;
    opaque: true;
  }> = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    if (messageIndex === currentPromptIndex) continue;
    const message = messages[messageIndex];
    if (!isRecord(message) ||
        !["user", "assistant", "toolResult"].includes(String(message.role)) ||
        !Array.isArray(message.content)) {
      continue;
    }
    const kind = message.role === "toolResult" ? "tool_result" : "history";
    for (const content of message.content) {
      if (!isRecord(content) || content.type !== "image" ||
          typeof content.data !== "string" || typeof content.mimeType !== "string") {
        continue;
      }
      const metadata = stableStringify({
        type: "image",
        mimeType: content.mimeType,
        bytes: Buffer.byteLength(content.data, "base64"),
        sha256: sha256(content.data),
      });
      const body = new TextEncoder().encode(metadata);
      segments.push({
        id: runtimeSegmentId(kind, metadata),
        kind,
        body,
        providerVisibleBytes: Math.max(
          body.byteLength,
          Buffer.byteLength(content.data, "utf8") +
            Buffer.byteLength(content.mimeType, "utf8") + 64,
        ),
        opaque: true,
      });
    }
  }
  return segments;
}

function replaceConversationSegments(
  messages: readonly AgentMessage[],
  segments: readonly ConversationTextSegment[],
  lowered: LoweredContext,
  applied: AppliedPlan,
  originals: Map<string, string>,
): AgentMessage[] {
  const output = structuredClone(messages) as AgentMessage[];
  for (const descriptor of segments) {
    const segment = lowered.ir.segments.find((item) => item.id === descriptor.id);
    if (!segment) continue;
    const providerBody = applied.bodies.get(segment.bodyHandle);
    if (!providerBody) continue;
    const replacement = new TextDecoder().decode(providerBody);
    if (replacement === descriptor.text) continue;
    setConversationText(output, descriptor, replacement);
    originals.set(replacement, descriptor.text);
  }
  return output;
}

function setConversationText(
  messages: AgentMessage[],
  descriptor: ConversationTextSegment,
  replacement: string,
): void {
  const message = messages[descriptor.messageIndex] as unknown as {
    content: string | Array<Record<string, unknown>>;
  } | undefined;
  if (!message) return;
  if (descriptor.contentIndex === undefined) {
    message.content = replacement;
    return;
  }
  if (!Array.isArray(message.content)) return;
  const content = message.content[descriptor.contentIndex];
  if (content?.type === "text") content.text = replacement;
}

async function transformConversationContext(
  messages: AgentMessage[],
  currentPromptIndex: number,
  lowered: LoweredContext,
  plan: CavePlan | undefined,
  engineBin: string | undefined,
  applied: AppliedPlan,
  originals: Map<string, string>,
  signal?: AbortSignal,
): Promise<AgentMessage[]> {
  if (!plan) return messages;
  const descriptors = conversationTextSegments(messages, currentPromptIndex);
  const output = structuredClone(messages) as AgentMessage[];
  for (const descriptor of descriptors) {
    if (descriptor.text.startsWith("<cave-compressed ")) continue;
    const routes = plan.segment_routes.filter((route) =>
      route.segment_kind === descriptor.kind &&
      (route.segment_id === undefined || route.segment_id === descriptor.id));
    if (routes.length === 0) continue;
    if (routes.length > 1) {
      const failure = `dynamic_route_ambiguous:${descriptor.id}`;
      if (!applied.failures.includes(failure)) applied.failures.push(failure);
      continue;
    }
    const body = new TextEncoder().encode(descriptor.text);
    const segment = appendRuntimeContextSegment(lowered, {
      id: descriptor.id,
      kind: descriptor.kind,
      body,
    });
    const existing = applied.bodies.get(segment.bodyHandle);
    if (existing && !bytesEqual(existing, body)) {
      const replacement = new TextDecoder().decode(existing);
      setConversationText(output, descriptor, replacement);
      originals.set(replacement, descriptor.text);
      continue;
    }
    const dynamic = await applyEfficiencyPlan({
      ir: { schemaVersion: 1, segments: [segment] },
      bodies: new Map([[segment.bodyHandle, body]]),
    }, {
      ...plan,
      segment_routes: [routes[0]!],
    }, engineBin, signal);
    mergeAppliedPlan(applied, dynamic, plan);
    const replacementBody = dynamic.bodies.get(segment.bodyHandle);
    if (!replacementBody || bytesEqual(replacementBody, body)) continue;
    const replacement = new TextDecoder().decode(replacementBody);
    applied.bodies.set(segment.bodyHandle, replacementBody);
    setConversationText(output, descriptor, replacement);
    originals.set(replacement, descriptor.text);
  }
  return output;
}

/** Runtime-only live-zone injection. Never enters append-only conversation state. */
function injectMemoryPrompt(
  messages: AgentMessage[],
  currentPromptIndex: number,
  prompt: string | undefined,
): AgentMessage[] {
  if (prompt === undefined || prompt === "") return messages;
  const output = [...messages];
  output.splice(Math.max(0, Math.min(currentPromptIndex, output.length)), 0, {
    role: "user",
    content: prompt,
    timestamp: Date.now(),
  } as AgentMessage);
  return output;
}

function mergeAppliedPlan(target: AppliedPlan, source: AppliedPlan, plan: CavePlan): void {
  for (const [handle, body] of source.bodies) target.bodies.set(handle, body);
  for (const id of source.evaluatedTransformIDs) {
    if (!target.evaluatedTransformIDs.includes(id)) target.evaluatedTransformIDs.push(id);
  }
  for (const id of source.appliedTransformIDs) {
    if (!target.appliedTransformIDs.includes(id)) target.appliedTransformIDs.push(id);
  }
  for (const failure of source.failures) {
    if (!target.failures.includes(failure)) target.failures.push(failure);
  }
  target.trace.push(...source.trace);
  target.evaluatedTransformIDs = orderedTransformIDs(plan, target.evaluatedTransformIDs);
  target.appliedTransformIDs = orderedTransformIDs(plan, target.appliedTransformIDs);
  const routeOrder = new Map(plan.segment_routes.map((route, index) => [
    `${route.segment_kind}\u0000${route.transform_id}`,
    index,
  ]));
  target.trace.sort((left, right) =>
    (routeOrder.get(`${left.segmentKind}\u0000${left.transformID}`) ?? Number.MAX_SAFE_INTEGER) -
    (routeOrder.get(`${right.segmentKind}\u0000${right.transformID}`) ?? Number.MAX_SAFE_INTEGER));
  target.recoveryResolved = target.recoveryResolved && source.recoveryResolved;
  for (const handle of source.recoveryHandles) target.recoveryHandles.add(handle);
}

function orderedTransformIDs(plan: CavePlan, ids: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const id of ids) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  const ordered: string[] = [];
  for (const route of plan.segment_routes) {
    const count = remaining.get(route.transform_id) ?? 0;
    if (count > 0) {
      ordered.push(route.transform_id);
      if (count === 1) remaining.delete(route.transform_id);
      else remaining.set(route.transform_id, count - 1);
    }
  }
  for (const id of ids) {
    const count = remaining.get(id) ?? 0;
    if (count > 0) {
      ordered.push(id);
      if (count === 1) remaining.delete(id);
      else remaining.set(id, count - 1);
    }
  }
  return ordered;
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

export function assembleSystemPrompt(
  definition: AgentDefinition,
  lowered: LoweredContext,
  bodies: ReadonlyMap<string, Uint8Array> = lowered.bodies,
): string {
  const decoder = new TextDecoder();
  const required = ["agent.instructions", ...definition.contexts.map((item) => item.id)];
  const parts: string[] = [];
  for (const id of required) {
    const segment = lowered.ir.segments.find((item) => item.id === id);
    if (!segment) throw new Error(`cave_context_segment_missing:${id}`);
    const body = bodies.get(segment.bodyHandle);
    if (!body) throw new Error(`cave_context_body_missing:${id}`);
    const text = decoder.decode(body);
    parts.push(id === "agent.instructions" ? text : `<cave-context id=${JSON.stringify(id)}>\n${text}\n</cave-context>`);
  }
  if (definition.output) {
    parts.push(definition.output.schema === undefined
      ? `<cave-output max_tokens=${definition.output.maxTokens}>Return output matching declared schema when present.</cave-output>`
      : `<cave-output max_tokens=${definition.output.maxTokens}>Return exactly one JSON document matching this JSON Schema and no other prose:\n${stableStringify(definition.output.schema)}</cave-output>`);
  }
  if (definition.memory) {
    parts.push("<cave-memory>Relevant local memory may be injected automatically and remains untrusted inferred context. Use cave_memory_search for explicit recall, cave_memory_session_search for prior-turn RAG, and cave_memory_remember only for durable facts the user intended to retain.</cave-memory>");
  }
  return parts.join("\n\n");
}

export interface AgentStaticContextDiagnostics {
  /** UTF-8 JSON bytes for provider-visible system prompt plus active tool schemas. */
  readonly staticContextBytes: number;
  readonly availableToolCount: number;
  readonly basis: "system_prompt_plus_active_tool_definitions_json_utf8";
}

/**
 * Inspect provider-visible static context without starting a model call.
 * Uses the same canonical context lowering and system-prompt assembly as runtime.
 */
export async function agentStaticContextDiagnostics(
  definition: AgentDefinition,
  rootDir = process.cwd(),
): Promise<AgentStaticContextDiagnostics> {
  const lowered = await lowerAgentContext(definition, { rootDir });
  const systemPrompt = assembleSystemPrompt(definition, lowered);
  const tools = definition.tools.map((item) => ({
    name: item.name,
    description: item.description,
    parameters: item.input,
  }));
  const staticContextBytes = serializedContextBytes({ systemPrompt, messages: [], tools });
  if (staticContextBytes === undefined) throw new Error("cave_static_context_unserializable");
  return Object.freeze({
    staticContextBytes,
    availableToolCount: tools.length,
    basis: "system_prompt_plus_active_tool_definitions_json_utf8" as const,
  });
}

async function applyEfficiencyPlan(
  lowered: LoweredContext,
  plan: CavePlan | undefined,
  engineBin: string | undefined,
  signal?: AbortSignal,
): Promise<AppliedPlan> {
  const bodies = new Map(lowered.bodies);
  if (!plan || plan.segment_routes.length === 0) {
    return {
      bodies,
      evaluatedTransformIDs: [],
      appliedTransformIDs: [],
      failures: [],
      recoveryResolved: true,
      recoveryHandles: new Set(),
      trace: [],
    };
  }
  const known = new Set([
    "a11y", "code", "config", "diff", "html", "json", "log", "repetition",
    "search-result", "tabular", "terminal", "text", "toolschema", "toon",
  ].map((name) => `caveman.engine.${name}.v1`));
  const evaluated: string[] = [];
  const applied: string[] = [];
  const failures: string[] = [];
  const handles = new Set<string>();
  const trace: MutableTransformTrace[] = [];
  let recoveryResolved = true;
  for (const route of plan.segment_routes) {
    if (!known.has(route.transform_id)) {
      throw new Error(`cave_unknown_transform:${route.transform_id}`);
    }
    const targets = lowered.ir.segments.filter((segment) =>
      segment.kind === route.segment_kind &&
      (route.segment_id === undefined || segment.id === route.segment_id));
    if (targets.length === 0) {
      if (route.segment_kind === "history" || route.segment_kind === "tool_result") {
        continue;
      }
      throw new Error(`cave_plan_route_unmatched:${route.segment_id ?? route.segment_kind}`);
    }
    evaluated.push(route.transform_id);
    let routeApplied = false;
    for (const segment of targets) {
      const original = lowered.bodies.get(segment.bodyHandle);
      if (!original) throw new Error(`cave_context_body_missing:${segment.id}`);
      if (segment.safety !== "S4") throw new Error(`cave_transform_safety_mismatch:${segment.id}`);
      const startedAt = performance.now();
      // beforeTokens/afterTokens are byte-derived (bytes/4) throughout so a
      // delta is always within one basis. beforeTokens counts the ORIGINAL
      // bytes; afterTokens, for an applied transform, counts the FULL provider
      // body actually sent — wrapper included. segment.tokenCount
      // is already estimateTokens(original) = bytes/4.
      const beforeTokens = segment.tokenCount;
      if (segment.opaque) {
        trace.push({
          segmentKind: segment.kind,
          transformID: route.transform_id,
          safetyClass: segment.safety,
          beforeTokens,
          afterTokens: beforeTokens,
          tokensBasis: "byte_derived",
          recoveryKind: segment.recovery,
          recoveryUsed: false,
          latencyMs: Math.round(performance.now() - startedAt),
          outcome: "not_smaller",
        });
        continue;
      }
      try {
        const transformed = await engineCompress(original, engineBin, engineContentType(route.transform_id), signal);
        if (!transformed.handle) {
          trace.push({
            segmentKind: segment.kind,
            transformID: route.transform_id,
            safetyClass: segment.safety,
            beforeTokens,
            afterTokens: beforeTokens,
            tokensBasis: "byte_derived",
            recoveryKind: segment.recovery,
            recoveryUsed: false,
            latencyMs: Math.round(performance.now()-startedAt),
            outcome: "not_smaller",
          });
          continue;
        }
        const recovered = await engineRetrieve(transformed.handle, undefined, engineBin, signal);
        if (!bytesEqual(recovered, original)) {
          recoveryResolved = false;
          failures.push(`${route.transform_id}:recovery_mismatch:${segment.id}`);
          trace.push({
            segmentKind: segment.kind,
            transformID: route.transform_id,
            safetyClass: segment.safety,
            beforeTokens,
            afterTokens: beforeTokens,
            tokensBasis: "byte_derived",
            recoveryKind: segment.recovery,
            recoveryUsed: false,
            latencyMs: Math.round(performance.now()-startedAt),
            outcome: "failed_open",
          });
          continue;
        }
        const providerBody = segment.kind === "tool_schema"
          ? validatedToolSchemaBytes(transformed.output, segment.id)
          : new TextEncoder().encode([
            `<cave-compressed transform=${JSON.stringify(route.transform_id)} recovery_handle=${JSON.stringify(transformed.handle)}>`,
            new TextDecoder().decode(transformed.output),
            "Use cave_retrieve for omitted detail.",
            "</cave-compressed>",
          ].join("\n"));
        bodies.set(segment.bodyHandle, providerBody);
        handles.add(transformed.handle);
        routeApplied = true;
        trace.push({
          segmentKind: segment.kind,
          transformID: route.transform_id,
          safetyClass: segment.safety,
          beforeTokens,
          // The bytes that actually go on the wire, wrapper and instruction line
          // included — never the engine's compressed-payload-only count.
          afterTokens: Math.ceil(providerBody.byteLength / 4),
          tokensBasis: "byte_derived",
          recoveryKind: segment.recovery,
          recoveryUsed: false,
          latencyMs: Math.round(performance.now()-startedAt),
          outcome: "applied",
          recoveryHandle: transformed.handle,
        });
      } catch (error) {
        failures.push(`${route.transform_id}:transform_error:${segment.id}:${safeEngineError(error)}`);
        trace.push({
          segmentKind: segment.kind,
          transformID: route.transform_id,
          safetyClass: segment.safety,
          beforeTokens,
          afterTokens: beforeTokens,
          tokensBasis: "byte_derived",
          recoveryKind: segment.recovery,
          recoveryUsed: false,
          latencyMs: Math.round(performance.now()-startedAt),
          outcome: "failed_open",
        });
      }
    }
    if (routeApplied) applied.push(route.transform_id);
  }
  return {
    bodies,
    evaluatedTransformIDs: orderedTransformIDs(plan, evaluated),
    appliedTransformIDs: orderedTransformIDs(plan, applied),
    failures,
    recoveryResolved,
    recoveryHandles: handles,
    trace,
  };
}

async function engineCompress(
  input: Uint8Array,
  engineBin: string | undefined,
  contentType = "text",
  signal?: AbortSignal,
): Promise<{ output: Uint8Array; handle?: string; tokensBefore?: number; tokensAfter?: number }> {
  const result = await runEngine(engineBin, ["compress", "--type", contentType], input, signal);
  const lastLine = result.stderr.trim().split("\n").pop() ?? "{}";
  const report = JSON.parse(lastLine) as {
    recovery_handle?: unknown;
    tokens_before?: unknown;
    tokens_after?: unknown;
  };
  const handle = typeof report.recovery_handle === "string" && report.recovery_handle.length > 0
    ? report.recovery_handle
    : undefined;
  if (!handle && !bytesEqual(result.stdout, input)) {
    throw new Error("engine_changed_bytes_without_recovery");
  }
  const tokensBefore = validEngineTokenCount(report.tokens_before);
  const tokensAfter = validEngineTokenCount(report.tokens_after);
  return {
    output: result.stdout,
    ...(handle === undefined ? {} : { handle }),
    ...(tokensBefore === undefined ? {} : { tokensBefore }),
    ...(tokensAfter === undefined ? {} : { tokensAfter }),
  };
}

async function engineRegistrySHA256(
  engineBin: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  let parsed: unknown;
  try {
    const result = await runEngine(engineBin, ["registry"], undefined, signal);
    parsed = JSON.parse(new TextDecoder().decode(result.stdout));
  } catch (error) {
    throw new Error("cave_locked_run_transform_registry_unavailable", { cause: error });
  }
  const digest = isRecord(parsed) ? parsed.registry_sha256 : undefined;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error("cave_locked_run_transform_registry_invalid");
  }
  return digest;
}

function engineContentType(transformID: string): string {
  const match = /^caveman\.engine\.([a-z0-9-]+)\.v1$/.exec(transformID);
  if (!match) throw new Error(`cave_unknown_transform:${transformID}`);
  return match[1]!;
}


export interface SegmentRecoveryProof {
  transformID: string;
  /**
   * `recovered` = the engine returned bytes identical to the original.
   * `not_smaller` = the engine declined to compress, so there is nothing to
   * recover and the original bytes are what the model sees.
   * `mismatch` = recovery did not reproduce the original; the plan fails open
   * to the original body and nothing may be claimed for this segment.
   */
  outcome: "recovered" | "not_smaller" | "mismatch";
  handle?: string;
  originalSHA256: string;
  recoveredSHA256?: string;
  originalBytes: number;
  compressedBytes?: number;
  tokensBefore?: number;
  tokensAfter?: number;
}

/**
 * Compress one segment body and recover it through exactly the engine pair that
 * plan application and the `cave_retrieve` tool use, then compare bytes. This
 * checks reversibility and nothing else: it measures no spend and makes no
 * savings claim. Token counts it reports are local engine estimates.
 */
export async function proveSegmentRecovery(input: {
  body: Uint8Array;
  transformID: string;
  engineBin?: string;
}): Promise<SegmentRecoveryProof> {
  const originalSHA256 = sha256(input.body);
  const transformed = await engineCompress(
    input.body,
    input.engineBin,
    engineContentType(input.transformID),
  );
  const tokens = {
    ...(transformed.tokensBefore === undefined ? {} : { tokensBefore: transformed.tokensBefore }),
    ...(transformed.tokensAfter === undefined ? {} : { tokensAfter: transformed.tokensAfter }),
  };
  if (!transformed.handle) {
    return {
      transformID: input.transformID,
      outcome: "not_smaller",
      originalSHA256,
      originalBytes: input.body.byteLength,
      ...tokens,
    };
  }
  const recovered = await engineRetrieve(transformed.handle, undefined, input.engineBin);
  return {
    transformID: input.transformID,
    outcome: bytesEqual(recovered, input.body) ? "recovered" : "mismatch",
    handle: transformed.handle,
    originalSHA256,
    recoveredSHA256: sha256(recovered),
    originalBytes: input.body.byteLength,
    compressedBytes: transformed.output.byteLength,
    ...tokens,
  };
}

async function engineRetrieve(
  handle: string,
  query: string | undefined,
  engineBin: string | undefined,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const result = await runEngine(engineBin, [
    "retrieve",
    handle,
    ...(query === undefined || query === "" ? [] : [query]),
  ], undefined, signal);
  return result.stdout;
}

/** Default wall-clock ceiling for one engine subprocess. */
const ENGINE_TIMEOUT_MS = 30_000;

/**
 * The allow-listed environment the engine subprocess starts from.
 *
 * A compression engine never needs provider or account credentials, so the
 * parent's full environment — ANTHROPIC_API_KEY, CAVE_API_KEY, AWS_*, … — is
 * withheld. Namespace prefixes are not safe allowlists: Caveman also uses
 * `CAVEMAN_API_KEY`, `CAVEMAN_MCP_TOKEN`, and session-key variables. Pass only
 * exact configuration names read by Engine (plus test fixture store var).
 */
export function buildEngineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TZ: process.env.TZ ?? "UTC",
  };
  for (const key of [
    // Portable process-launch baseline; none carries account/provider secrets.
    "ComSpec", "PATHEXT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE",
    "CAVEMAN_CCR_DB",
    "CAVEMAN_HOME",
    "CAVE_ENGINE_TOON",
    "CAVE_PIXEL_DENSITY",
    "CAVE_PIXEL_GPT_PROFILES",
    "CAVE_PIXEL_MODELS",
    "CAVE_FAKE_ENGINE_STORE",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function runEngine(
  engineBin: string | undefined,
  args: string[],
  input?: Uint8Array,
  signal?: AbortSignal,
): Promise<{ stdout: Uint8Array; stderr: string }> {
  const command = engineBin ?? process.env.CAVEMAN_ENGINE_BIN ?? "caveman-engine";
  // A hung engine must not run forever: a default timeout plus the caller's own
  // run/tool signal both terminate it, and the child is spawned detached so the
  // whole process group is killed, not just the direct child.
  const timeout = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  return new Promise((accept, reject) => {
    const env = buildEngineEnv();
    const invocation = portableInvocation(command, args, { env });
    const child = spawn(invocation.command, [...invocation.args], {
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let terminalError: Error | undefined;
    const cleanup = (): void => {
      combined.removeEventListener("abort", onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };
    const terminate = (error: Error, immediate = false): void => {
      terminalError ??= error;
      killSandboxProcess(child, immediate ? "SIGKILL" : "SIGTERM");
      if (!immediate && killTimer === undefined) {
        killTimer = setTimeout(() => killSandboxProcess(child, "SIGKILL"), 250);
        killTimer.unref();
      }
    };
    function onAbort(): void {
      const reason = combined.reason;
      const isTimeout = reason instanceof DOMException && reason.name === "TimeoutError";
      terminate(isTimeout
        ? new Error("cave_engine_timeout")
        : (reason instanceof Error ? reason : new Error("cave_engine_aborted")));
    }
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 16 * 1024 * 1024) {
        terminate(new Error("engine_output_limit"), true);
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError !== undefined) {
        reject(terminalError);
        return;
      }
      if (code !== 0) {
        reject(new Error(`engine_exit_${code}:${Buffer.concat(stderr).toString("utf8").slice(0, 256)}`));
        return;
      }
      accept({
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
    // A child that died before draining stdin makes end() emit EPIPE; swallow it
    // so the real terminal error (timeout/exit) is what surfaces.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function recoveryTool(
  handles: ReadonlySet<string>,
  engineBin: string | undefined,
  trace?: MutableTransformTrace[],
): AgentTool<TSchema> {
  return {
    name: "cave_retrieve",
    label: "cave_retrieve",
    description: "Recover exact content omitted by an active Caveman transform. Handles are scoped to this run.",
    parameters: Type.Object({
      recovery_handle: Type.String(),
      query: Type.Optional(Type.String()),
    }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const input = params as { recovery_handle: string; query?: string };
      if (!handles.has(input.recovery_handle)) throw new Error("cave_recovery_handle_out_of_scope");
      const value = await engineRetrieve(input.recovery_handle, input.query, engineBin);
      for (const item of trace ?? []) {
        if (item.recoveryHandle === input.recovery_handle) item.recoveryUsed = true;
      }
      return {
        content: [{ type: "text", text: new TextDecoder().decode(value) }],
        details: { recovery: input.query ? "query" : "exact" },
      };
    },
  };
}

function toolSchemaSearchTool(
  handles: ReadonlySet<string>,
  engineBin: string | undefined,
  trace?: MutableTransformTrace[],
): AgentTool<TSchema> {
  return {
    name: "cave_search_tools",
    label: "cave_search_tools",
    description: "Search exact original tool definitions when compacted annotations are insufficient.",
    parameters: Type.Object({ query: Type.String() }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const query = (params as { query: string }).query.trim().toLowerCase();
      if (query === "") throw new Error("cave_tool_search_query_required");
      const terms = tokenize(query);
      const hits: Array<{ score: number; value: Record<string, unknown>; handle: string }> = [];
      for (const handle of handles) {
        const original = await engineRetrieve(handle, undefined, engineBin);
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(original));
        } catch {
          continue;
        }
        if (!isRecord(parsed) || typeof parsed.name !== "string" ||
            typeof parsed.description !== "string" || !isRecord(parsed.input)) continue;
        const haystack = `${parsed.name} ${parsed.description} ${JSON.stringify(parsed.input)}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
        if (score > 0) hits.push({ score, value: parsed, handle });
      }
      hits.sort((first, second) => second.score - first.score ||
        String(first.value.name).localeCompare(String(second.value.name)));
      const selected = hits.slice(0, 4);
      for (const hit of selected) {
        for (const item of trace ?? []) {
          if (item.recoveryHandle === hit.handle) item.recoveryUsed = true;
        }
      }
      const text = JSON.stringify(selected.map((hit) => hit.value));
      if (text.length > 8_192) throw new Error("cave_tool_search_result_limit");
      return {
        content: [{ type: "text", text }],
        details: { recovery: "tool_schema_search", hits: selected.length },
      };
    },
  };
}

function validEngineTokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
}

function resolveMemoryEngine(
  definition: NonNullable<AgentDefinition["memory"]>,
  agentId: string,
  config: MemoryRuntimeConfig | undefined,
): MemoryEngine {
  const scope = {
    tenant: config?.tenant ?? "_",
    agentId,
    namespace: definition.namespace,
  };
  if (config?.engine !== undefined) {
    const actual = config.engine.scope;
    if (actual.tenant !== scope.tenant || actual.agentId !== scope.agentId ||
        actual.namespace !== scope.namespace) {
      throw new Error("cave_memory_engine_scope_mismatch");
    }
    return config.engine;
  }
  return createMemoryEngine({
    scope,
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
}

function localMemoryTools(
  definition: NonNullable<AgentDefinition["memory"]>,
  engine: MemoryEngine,
): AgentTool<TSchema>[] {
  // Defense in depth: memory() already rejects a non-local provenance/consent at
  // construction, but a hand-built MemoryDefinition must still fail
  // BEFORE the run spends — not inside a tool call — so this throws at tool
  // setup, never at execute time.
  if (definition.provenance !== "local" || definition.consent !== "local_only") {
    throw new Error("cave_memory_shared_backend_unavailable");
  }
  const recall: AgentTool<TSchema> = {
    name: "cave_memory_search",
    label: "cave_memory_search",
    description: "Recall relevant local memory from declared namespace. Returns bounded local evidence only.",
    parameters: Type.Object({ query: Type.String() }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const query = (params as { query: string }).query;
      const hits = await engine.search(query);
      const used = hits.reduce((sum, hit) => sum + hit.text.length, 0);
      return {
        content: [{ type: "text", text: JSON.stringify({ hits, basis: "inferred", namespace: definition.namespace }) }],
        details: { namespace: definition.namespace, recallTokensEstimated: Math.ceil(used / 4) },
      };
    },
  };
  const remember: AgentTool<TSchema> = {
    name: "cave_memory_remember",
    label: "cave_memory_remember",
    description: "Remember one explicit fact in declared local namespace.",
    parameters: Type.Object({ text: Type.String() }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const remembered = await engine.remember({ text: (params as { text: string }).text });
      return {
        content: [{ type: "text", text: JSON.stringify({
          remembered: true,
          id: remembered.id,
          basis: "inferred",
        }) }],
        details: { namespace: definition.namespace },
      };
    },
  };
  const sessionSearch: AgentTool<TSchema> = {
    name: "cave_memory_session_search",
    label: "cave_memory_session_search",
    description: "Search bounded prior local session turns in declared namespace.",
    parameters: Type.Object({ query: Type.String() }),
    executionMode: "parallel",
    async execute(_toolCallId, params) {
      const hits = await engine.searchSessions((params as { query: string }).query);
      return {
        content: [{ type: "text", text: JSON.stringify({
          hits,
          basis: "inferred",
          namespace: definition.namespace,
        }) }],
        details: { namespace: definition.namespace, hits: hits.length },
      };
    },
  };
  return [recall, remember, sessionSearch];
}

function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
  return first.byteLength === second.byteLength && first.every((value, index) => value === second[index]);
}

function safeEngineError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[A-Za-z0-9_=-]{24,}/g, "<redacted>")
    .slice(0, 160);
}

/**
 * Which billing regime pays for this provider's configured credential, as a
 * tri-state:
 *
 * - `"subscription"` — Pi positively identified an unbilled OAuth session
 *   (e.g. Claude Pro/Max). Dollars are fiction here.
 * - `"metered"` — Pi positively identified a per-token API key.
 * - `"unknown"` — Pi has no `checkAuth`, or it threw. The regime cannot be
 *   proven, so it is NOT silently treated as metered: a caller that meant to
 *   meter dollars against an API key must say so with
 *   `RunOptions.assumeMeteredCredential`. Guessing "metered" is exactly the
 *   fail-open that would book fictional dollars against a subscription.
 *
 * Pi reports the credential type without refreshing an OAuth token, so this
 * costs nothing and touches no network. Callers decide whether Pi's credential
 * store is even the right authority for the run in hand — it is not, for a
 * caller-supplied transport or a gateway-routed request.
 */
async function credentialRegime(
  models: Models,
  provider: string,
): Promise<"subscription" | "metered" | "unknown"> {
  if (typeof models.checkAuth === "function") {
    try {
      const check = await models.checkAuth(provider);
      if (check?.type === "oauth") return "subscription";
      if (check?.type === "api_key") return "metered";
    } catch {
      // Alias fallback below still proves local Google API-key billing.
    }
  }
  // Runtime accepts GOOGLE_API_KEY as alias for Pi's GEMINI_API_KEY-only
  // Google provider. Use only after Pi failed to prove a stronger regime, so a
  // future OAuth-capable Google provider cannot be relabeled as metered.
  if (provider === "google" && process.env.GOOGLE_API_KEY) return "metered";
  return "unknown";
}

/**
 * F8 message shaping only: the refusal above is unchanged, this names the
 * one-line fix for the state the machine is actually in. Three states:
 * subscription login (dollars are fiction, ADR 0023), no credential at all
 * (name the exact env var for this provider), or a credential Pi cannot
 * classify (name the explicit caller assertion).
 */
function credentialRegimeFix(
  regime: "subscription" | "unknown",
  provider: string,
): string {
  if (regime === "subscription") {
    return `the ${provider} login in this shell is a subscription, which is not billed per token, so a USD budget would meter fiction — use budget.maxTokens, or switch to a metered API key`;
  }
  const names = SANDBOX_CREDENTIAL_ENV_BY_CAPABILITY[
    provider as SandboxCredentialCapability
  ] as readonly string[] | undefined;
  if (names !== undefined && !names.some((name) => process.env[name])) {
    return `no ${names.join(" or ")} in this shell — set it, then re-run (run caveman-agent doctor for the full readiness picture)`;
  }
  return `the ${provider} credential cannot be proven to be a metered API key — set assumeMeteredCredential: true only if you know it is, or use budget.maxTokens`;
}

function resolveModel(definition: AgentDefinition, models: Models, rootDir: string): Model<Api> {
  if (typeof definition.model === "object" && "provider" in definition.model) {
    return definition.model;
  }
  const requested = typeof definition.model === "string"
    ? definition.model
    : process.env.CAVE_MODEL ?? localProviderModel(rootDir);
  if (requested) {
    const slash = requested.indexOf("/");
    if (slash <= 0 || slash === requested.length - 1) {
      throw new Error("caveman agent: pinned model must use provider/model format");
    }
    const model = models.getModel(requested.slice(0, slash), requested.slice(slash + 1));
    if (!model) throw new Error(`caveman agent: unknown model ${JSON.stringify(requested)}`);
    return model;
  }

  const [provider, id] = autoCredentialModel();
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`caveman agent: baseline model unavailable: ${provider}/${id}`);
  return model;
}

function localProviderModel(rootDir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(rootDir, ".caveman/provider.json"), "utf8")) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("caveman agent: invalid .caveman/provider.json");
  }
}

/**
 * Point a model at the gateway when the gateway speaks its dialect.
 *
 * The three routes below are the only ones the Caveman gateway proxies. Every
 * other provider Pi can reach (xai, groq, bedrock, openrouter, …) keeps its own
 * base URL, and `routed: false` is what tells the caller this request is
 * third-party traffic: no account key, no telemetry headers, no `optimized`.
 */
function routeModelThroughCave(
  model: Model<Api>,
  gatewayURL: string,
): { model: Model<Api>; routed: boolean } {
  const prefix: Record<string, string> = {
    anthropic: "anthropic",
    // Pi provider clients append endpoint paths relative to these versioned
    // API roots. Dropping the version yields routes the gateway does not serve.
    openai: "openai/v1",
    google: "gemini/v1beta",
  };
  const route = prefix[model.provider];
  if (!route) return { model, routed: false };
  return { model: { ...model, baseUrl: `${gatewayURL}/${route}` }, routed: true };
}

function runtimeHeaders(
  agentId: string,
  workflow: string,
  sessionId: string,
  buildIdentity: { buildSha256: string; planSha256: string } | undefined,
  bill: Record<string, number>,
  transforms: string[],
  prefixDigest: string,
  conversationFingerprint: string,
  invocationTrace: InvocationTrace | undefined,
): ProviderHeaders {
  const headers: ProviderHeaders = {
    "x-cave-agent": agentId,
    "x-cave-workflow": workflow,
    "x-cave-session": sessionId,
    "x-cave-context-bill": serializeContextBill(bill),
    "x-cave-transforms": transforms.length > 0 ? transforms.join(",") : "caveman.pass-through.v1",
    "x-cave-cache-epoch": `${agentId}:${workflow}:${sessionId}:${conversationFingerprint.slice(0, 16)}`,
    "x-cave-cache-prefix-sha256": prefixDigest,
    // Pi already applied locked transforms locally. Gateway remains metering
    // transport only; generic entitlement compression would corrupt compiler
    // baseline and double-transform selected candidates.
    "x-cave-transform-location": "local",
  };
  if (invocationTrace !== undefined) {
    headers["x-cave-trace-id"] = invocationTrace.traceId;
    // Provider request is child of currently executing agent invocation.
    headers["x-cave-parent-span-id"] = invocationTrace.spanId;
  }
  if (invocationTrace?.batch.apiKey) headers["x-cave-api-key"] = invocationTrace.batch.apiKey;
  if (buildIdentity) {
    headers["x-cave-agent-build"] = buildIdentity.buildSha256;
    headers["x-cave-efficiency-plan"] = buildIdentity.planSha256;
  }
  return headers;
}

function rootInvocationTrace(
  rootAgentId: string,
  rootWorkflow: string,
  rootSessionId: string,
  gatewayURL: string,
  fetchImpl: typeof globalThis.fetch,
  apiKey: string | undefined,
  rootBudgetGuard: InvocationRootBudgetGuard,
  treeInvocationsGuard: InvocationTreeGuard,
  treeConcurrencyGuard: InvocationTreeGuard,
  subagentAdmissions: SubagentAdmissionLedger,
): InvocationTrace {
  return {
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    parentSpanId: "",
    startTimeUnixNano: unixTimeNano(),
    batch: {
      rootAgentId,
      rootWorkflow,
      rootSessionId,
      gatewayURL,
      fetchImpl,
      rootBudgetGuard,
      treeInvocationsGuard,
      treeConcurrencyGuard,
      subagentAdmissions,
      spans: [],
      droppedSpans: 0,
      flushScheduled: false,
      ...(apiKey === undefined ? {} : { apiKey }),
    },
  };
}

function rootBudgetGuardState(
  options: InternalRunOptions,
  meter: BudgetMeter | undefined,
): InvocationRootBudgetGuard {
  if (meter !== undefined) {
    if (options.budget === undefined) return "unknown";
    if (meter.denomination === "usd") return "usd";
    if (meter.denomination === "tokens") return "tokens";
    return "unknown";
  }
  if (options.budget !== undefined) return "unknown";
  if (options.maxCostUsd !== undefined) return "legacy_usd";
  return "absent";
}

function childInvocationGuardManifest(input: {
  runtime: SubagentRuntimeDefinition;
  parentMeter: BudgetMeter | undefined;
  rootBudget: InvocationRootBudgetGuard;
  treeInvocations: InvocationTreeGuard;
  treeConcurrency: InvocationTreeGuard;
  breakers: RunBreakers | undefined;
}): InvocationGuardManifest {
  const childSpend: InvocationChildSpendGuard = input.parentMeter?.denomination === "tokens"
    ? input.runtime.maxTokens === undefined ? "unknown" : "tokens_pre_call"
    : Number.isFinite(input.runtime.maxCostUsd) && input.runtime.maxCostUsd > 0
      ? "usd_pre_call"
      : "unknown";
  return Object.freeze({
    schemaVersion: "2",
    basis: "client_runtime_declared",
    framework: "caveman_agent",
    childCalls: Number.isSafeInteger(input.runtime.maxCalls) && input.runtime.maxCalls > 0
      ? "active"
      : "unknown",
    childSpend,
    childContext: Number.isSafeInteger(input.runtime.maxContextTokens) && input.runtime.maxContextTokens > 0
      ? "active"
      : "unknown",
    depth: "active",
    rootBudget: input.rootBudget,
    turnFanout: input.breakers === undefined ? "absent" : "active",
    modelCalls: "active",
    toolCalls: "active",
    treeInvocations: input.treeInvocations,
    treeConcurrency: input.treeConcurrency,
  });
}

function childInvocationTrace(
  parent: InvocationTrace,
  guardManifest: InvocationGuardManifest,
): InvocationTrace {
  return {
    traceId: parent.traceId,
    spanId: randomBytes(8).toString("hex"),
    parentSpanId: parent.spanId,
    startTimeUnixNano: unixTimeNano(),
    batch: parent.batch,
    guardManifest,
  };
}

function unixTimeNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

/** Record bounded identity/control metadata only; never content or errors. */
function recordInvocationSpan(input: InvocationSpanRecord, statusCode: 0 | 1 | 2): void {
  const batch = input.trace.batch;
  const root = input.trace.parentSpanId === "";
  // Reserve final slot for root, which completes after all descendants.
  if (!root && batch.spans.length >= INVOCATION_BATCH_MAX_SPANS - 1) {
    batch.droppedSpans++;
    return;
  }
  batch.spans.push({
    traceId: input.trace.traceId,
    spanId: input.trace.spanId,
    parentSpanId: input.trace.parentSpanId,
    name: "invoke_agent",
    kind: 1,
    startTimeUnixNano: input.trace.startTimeUnixNano,
    endTimeUnixNano: unixTimeNano(),
    attributes: [
      { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
      { key: "cave.agent.id", value: { stringValue: input.agentId } },
      { key: "cave.agent.depth", value: { intValue: String(input.depth) } },
      ...invocationGuardAttributes(input.trace.guardManifest),
      ...(root ? invocationTreeOutcomeAttributes(batch.subagentAdmissions) : []),
    ],
    events: [],
    status: { code: statusCode },
  });
}

function invocationTreeOutcomeAttributes(
  ledger: SubagentAdmissionLedger,
): InvocationOTLPSpan["attributes"] {
  const outcomes = ledger.outcomes();
  return [
    {
      key: "cave.agent.tree.admitted_descendants",
      value: { intValue: String(outcomes.admittedDescendants) },
    },
    {
      key: "cave.agent.tree.peak_active_descendants",
      value: { intValue: String(outcomes.peakActiveDescendants) },
    },
    {
      key: "cave.agent.tree.invocation_limit_rejections",
      value: { intValue: String(outcomes.invocationLimitRejections) },
    },
    {
      key: "cave.agent.tree.concurrency_limit_rejections",
      value: { intValue: String(outcomes.concurrencyLimitRejections) },
    },
  ];
}

function invocationGuardAttributes(
  manifest: InvocationGuardManifest | undefined,
): InvocationOTLPSpan["attributes"] {
  if (manifest === undefined) return [];
  return [
    { key: "cave.guard.schema_version", value: { stringValue: manifest.schemaVersion } },
    { key: "cave.guard.basis", value: { stringValue: manifest.basis } },
    { key: "cave.guard.framework", value: { stringValue: manifest.framework } },
    { key: "cave.guard.child_calls", value: { stringValue: manifest.childCalls } },
    { key: "cave.guard.child_spend", value: { stringValue: manifest.childSpend } },
    { key: "cave.guard.child_context", value: { stringValue: manifest.childContext } },
    { key: "cave.guard.depth", value: { stringValue: manifest.depth } },
    { key: "cave.guard.root_budget", value: { stringValue: manifest.rootBudget } },
    { key: "cave.guard.turn_fanout", value: { stringValue: manifest.turnFanout } },
    { key: "cave.guard.model_calls", value: { stringValue: manifest.modelCalls } },
    { key: "cave.guard.tool_calls", value: { stringValue: manifest.toolCalls } },
    { key: "cave.guard.tree_invocations", value: { stringValue: manifest.treeInvocations } },
    { key: "cave.guard.tree_concurrency", value: { stringValue: manifest.treeConcurrency } },
  ];
}

/** Defer one best-effort authenticated export; never alter paid run outcome. */
function scheduleInvocationSpanBatch(batch: InvocationSpanBatch): void {
  if (batch.flushScheduled) return;
  batch.flushScheduled = true;
  if (batch.apiKey === undefined) return;
  const signal = AbortSignal.timeout(INVOCATION_EXPORT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-cave-agent": batch.rootAgentId,
    "x-cave-workflow": batch.rootWorkflow,
    "x-cave-session": batch.rootSessionId,
    "x-cave-api-key": batch.apiKey,
  };
  setImmediate(() => {
    try {
      const payload = {
        resourceSpans: [{
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "@caveman-ai/agent" } },
              { key: "cave.telemetry.delivery_basis", value: { stringValue: "attempted_unconfirmed" } },
              { key: "cave.invocation.batch.span_count", value: { intValue: String(batch.spans.length) } },
              { key: "cave.invocation.batch.dropped_spans", value: { intValue: String(batch.droppedSpans) } },
            ],
          },
          scopeSpans: [{ spans: batch.spans }],
        }],
      };
      void batch.fetchImpl(`${batch.gatewayURL}/otlp/v1/traces`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      }).catch(() => undefined);
    } catch {
      // Caller fetch may throw synchronously; telemetry remains advisory.
    }
  });
}

function serializeContextBill(bill: Record<string, number>): string {
  return Object.entries(bill)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, tokens]) => `${kind}=${tokens}`)
    .join(",");
}

/**
 * Pi APIs where the in-SDK cache planner may add hints on the LIVE path.
 * Anthropic caching is provider-native via Pi's own markers; the SDK planner
 * adds openai affinity routing keys and takes over other wires only when
 * proven live (#225). So anthropic-messages is deliberately absent (Pi's
 * `cache_control` markers ARE the provider-native cache path there — the
 * planner would read them as caller-managed anyway), and Bedrock's onPayload
 * object is a Smithy command input, not the raw invoke/converse JSON body.
 * Those wires exist fixture-parity-only until #225's live smoke passes.
 */
const NATIVE_CACHE_WIRES: Readonly<Record<string, { provider: string; endpoint: string }>> = {
  "openai-completions": { provider: "openai", endpoint: "/v1/chat/completions" },
  "openai-responses": { provider: "openai", endpoint: "/v1/responses" },
};

function providerFrozenView(payload: unknown, api: string): ProviderFrozenView | undefined {
  if (!isRecord(payload)) return undefined;
  const fields: Record<string, unknown> = {};
  let messageField: ProviderFrozenView["messageField"];
  let messagePrefix: unknown[] | undefined;
  if (api === "pi-messages") {
    // Pi Messages sends one nested Context object, not Anthropic-shaped root
    // fields. Track provider-visible JSON fields at their real paths.
    const context = isRecord(payload.context) ? payload.context : undefined;
    if (context && "systemPrompt" in context) fields["context.systemPrompt"] = context.systemPrompt;
    if (context && "tools" in context) fields["context.tools"] = context.tools;
    messageField = "context.messages";
    messagePrefix = frozenConversationPrefix(context?.messages);
  } else if (api === "anthropic-messages" || api === "bedrock-converse-stream") {
    if ("system" in payload) fields.system = payload.system;
    if ("tools" in payload) fields.tools = payload.tools;
    // AWS Converse nests tool definitions and choice under toolConfig.
    if (api === "bedrock-converse-stream" && "toolConfig" in payload) fields.toolConfig = payload.toolConfig;
    messageField = "messages";
    messagePrefix = frozenConversationPrefix(payload.messages);
  } else if (api === "openai-completions" || api === "mistral-conversations") {
    // Pi's Mistral Conversations payload is OpenAI-chat-shaped: system prompt
    // is first message, tool definitions stay at root, and remaining history
    // follows in `messages`. Mistral also enables prefix reuse via x-affinity
    // plus promptCacheKey, so its frozen bytes need same drift guard.
    if ("tools" in payload) fields.tools = payload.tools;
    messageField = "messages";
    messagePrefix = frozenConversationPrefix(payload.messages);
  } else if (api === "openai-responses" || api === "openai-codex-responses" ||
      api === "azure-openai-responses") {
    if ("instructions" in payload) fields.instructions = payload.instructions;
    if ("tools" in payload) fields.tools = payload.tools;
    messageField = "input";
    messagePrefix = frozenConversationPrefix(payload.input);
  } else if (api === "google-generative-ai" || api === "google-vertex") {
    // Pi's Google adapters expose @google/genai GenerateContentParameters to
    // onPayload: provider-visible system/tool fields live under `config`, not
    // at the REST wire names on the root object.
    const config = isRecord(payload.config) ? payload.config : undefined;
    if (config && "systemInstruction" in config) fields["config.systemInstruction"] = config.systemInstruction;
    if (config && "tools" in config) fields["config.tools"] = config.tools;
    // Keep root aliases for caller-supplied adapters using raw REST payloads.
    if ("systemInstruction" in payload) fields.systemInstruction = payload.systemInstruction;
    if ("system_instruction" in payload) fields.system_instruction = payload.system_instruction;
    if ("tools" in payload) fields.tools = payload.tools;
    messageField = "contents";
    messagePrefix = frozenConversationPrefix(payload.contents);
  } else {
    return undefined;
  }
  if (messagePrefix?.length) fields[`${messageField}_prefix`] = messagePrefix;
  if (Object.keys(fields).length === 0 && messageField === undefined) return undefined;
  return {
    api,
    bytes: semanticFrozenBytes(fields, messageField, messagePrefix),
    fields,
    ...(messageField === undefined ? {} : { messageField }),
    ...(messagePrefix === undefined ? {} : { messagePrefix }),
  };
}

function frozenConversationPrefix(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  // Latest turn stays live. Everything before it is provider-visible history
  // whose exact serialization must remain frozen inside this cache epoch.
  return value.slice(0, Math.max(0, value.length - 1));
}

function semanticFrozenBytes(
  fields: Record<string, unknown>,
  messageField: ProviderFrozenView["messageField"],
  messagePrefix: unknown[] | undefined,
): Uint8Array {
  const ordered: Array<[string, unknown]> = [];
  // Provider cache hierarchy is explicit, not JavaScript object-key order.
  for (const key of [
    "tools",
    "toolConfig",
    "system",
    "systemInstruction",
    "system_instruction",
    "instructions",
    "config.tools",
    "config.systemInstruction",
    "context.systemPrompt",
    "context.tools",
  ]) {
    if (key in fields) ordered.push([key, fields[key]]);
  }
  if (messageField) ordered.push([messageField, messagePrefix ?? []]);
  return new TextEncoder().encode(ordered
    .map(([name, value]) => `${name}\u0000${JSON.stringify(value)}`)
    .join("\u0001"));
}

function providerFrozenExtends(current: ProviderFrozenView, prior: ProviderFrozenView): boolean {
  if (current.api !== prior.api || current.messageField !== prior.messageField) return false;
  const stableKeys = new Set([
    ...Object.keys(current.fields).filter((key) => !key.endsWith("_prefix")),
    ...Object.keys(prior.fields).filter((key) => !key.endsWith("_prefix")),
  ]);
  for (const key of stableKeys) {
    if (JSON.stringify(current.fields[key]) !== JSON.stringify(prior.fields[key])) return false;
  }
  const currentMessages = current.messagePrefix ?? [];
  const priorMessages = prior.messagePrefix ?? [];
  if (currentMessages.length < priorMessages.length) return false;
  return priorMessages.every((message, index) =>
    JSON.stringify(currentMessages[index]) === JSON.stringify(message));
}

function restoreProviderFrozen(
  payload: unknown,
  frozen: ProviderFrozenView,
  currentFrozen: ProviderFrozenView,
): unknown {
  if (!isRecord(payload)) return payload;
  const restored = structuredClone(payload);
  const priorKeys = new Set(Object.keys(frozen.fields));
  for (const key of Object.keys(currentFrozen.fields)) {
    if (!key.endsWith("_prefix") && !priorKeys.has(key)) {
      deleteNestedRecordValue(restored, key);
    }
  }
  for (const [key, value] of Object.entries(frozen.fields)) {
    if (key.endsWith("_prefix")) continue;
    setNestedRecordValue(restored, key, structuredClone(value));
  }
  if (frozen.messageField && frozen.messagePrefix) {
    const currentValue = nestedRecordValue(restored, frozen.messageField);
    const current = Array.isArray(currentValue) ? currentValue : [];
    const dynamicStart = Math.min(
      frozen.messagePrefix.length,
      frozenConversationPrefix(current).length,
    );
    const dynamic = current.slice(dynamicStart);
    setNestedRecordValue(restored, frozen.messageField, [...structuredClone(frozen.messagePrefix), ...dynamic]);
  }
  return restored;
}

function nestedRecordValue(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setNestedRecordValue(value: Record<string, unknown>, path: string, next: unknown): void {
  const keys = path.split(".");
  let current = value;
  for (const key of keys.slice(0, -1)) {
    const child = isRecord(current[key]) ? current[key] : {};
    current[key] = child;
    current = child;
  }
  current[keys.at(-1)!] = next;
}

function deleteNestedRecordValue(value: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(current[key])) return;
    current = current[key];
  }
  delete current[keys.at(-1)!];
}

function replaceExactStrings(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) return value.map((item) => replaceExactStrings(item, from, to));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    replaceExactStrings(item, from, to),
  ]));
}

function restoreOriginalPayload(value: unknown, originals: ReadonlyMap<string, string>): unknown {
  let restored = value;
  for (const [transformed, original] of originals) {
    restored = replaceExactStrings(restored, transformed, original);
  }
  return restored;
}

// `headers` is undefined when this request does not go through the gateway:
// the plan still fails open, but no x-cave-* header is written for a third
// party to receive.
function markRequestPassThrough(
  headers: ProviderHeaders | undefined,
  plan: AppliedPlan,
  reason: string,
): void {
  markAppliedPlanFailedOpen(plan, reason);
  if (headers === undefined) return;
  headers["x-cave-transforms"] = "caveman.pass-through.v1";
  const trace = serializeTransformTrace(plan.trace);
  if (trace === "") delete headers["x-cave-transform-trace"];
  else headers["x-cave-transform-trace"] = trace;
}

function markAppliedPlanFailedOpen(plan: AppliedPlan, reason: string): void {
  if (!plan.failures.includes(reason)) plan.failures.push(reason);
  plan.appliedTransformIDs.splice(0);
  for (const item of plan.trace) {
    if (item.outcome === "applied") item.outcome = "failed_open";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function volatileStablePrefix(instructions: string, tools: readonly ToolDefinition[]): boolean {
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

function serializeTransformTrace(trace: readonly TransformTrace[]): string {
  if (trace.length > 64) throw new Error("cave_transform_trace_limit");
  const value = trace.map((item) => [
    item.transformID,
    item.segmentKind,
    item.safetyClass,
    item.outcome,
    item.beforeTokens,
    item.afterTokens,
    item.recoveryKind,
    item.recoveryUsed ? 1 : 0,
    item.latencyMs,
  ].join("|")).join(",");
  if (value.length > 8_192) throw new Error("cave_transform_trace_limit");
  return value;
}

function mergeHeaders(first: ProviderHeaders | undefined, second: ProviderHeaders): ProviderHeaders {
  return { ...(first ?? {}), ...second };
}

/**
 * Bound one complete raw+validation operation to one monotonic deadline.
 * Work begins in a microtask after timer installation, so synchronous execute
 * or validator work is inside the measured interval. Event-loop blocking can
 * delay timer delivery; elapsed-time post-check prevents that block from being
 * accepted as a successful in-budget result.
 *
 * JavaScript cannot preempt a closure that ignores its signal. This bounds
 * caller wait; composite/subagent paths separately track raw settlement.
 */
function runWithToolDeadline<T>(
  start: () => T | Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const deadlineAt = performance.now() + timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    // NOT unref'd: this timer must keep the loop alive to fire, otherwise a
    // hung closure would leave the run's promise pending forever.
    timer = setTimeout(() => reject(new Error("cave_tool_timeout")), timeoutMs);
  });
  const work = Promise.resolve().then(start).then((value) => {
    if (performance.now() >= deadlineAt) throw new Error("cave_tool_timeout");
    return value;
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function isSettledToolOutput(value: unknown): value is SettledToolOutput {
  if (!isRecord(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const text = descriptors.text;
  const bytes = descriptors.bytes;
  const output = descriptors.value;
  return text !== undefined && "value" in text && typeof text.value === "string" &&
    bytes !== undefined && "value" in bytes && bytes.value instanceof Uint8Array &&
    output !== undefined && "value" in output;
}

async function boundedSettlement(
  work: readonly Promise<unknown>[],
  graceMs: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  });
  try {
    return await Promise.race([
      Promise.allSettled(work).then(() => true as const),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function abortSignalError(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function durablePiTool(
  source: AgentTool<TSchema>,
  effect: ToolDefinition["effect"],
  durableTools: DurableToolCoordinator | undefined,
  path: string,
): AgentTool<TSchema> {
  if (durableTools === undefined) return source;
  return {
    ...source,
    async execute(toolCallId, params, signal) {
      return durableTools.execute({
        path,
        toolCallId,
        name: source.name,
        effect,
        args: params,
      }, () => Promise.resolve(source.execute(toolCallId, params, signal)));
    },
  };
}

function toPiTool(
  definition: ToolDefinition,
  delegatedExecute?: (
    params: unknown,
    signal?: AbortSignal,
    context?: ToolExecutionContext,
  ) => Promise<unknown>,
  delegatedExecutionKind?: "sandbox" | "connect" | "subagent",
  recoveryHandles?: Set<string>,
  engineBin?: string,
  providerDefinition?: { description: string; input: TSchema },
  deferLockedToolResult = false,
  nestedDispatch?: (input: {
    parentToolCallId: string;
    name: string;
    args: unknown;
    options: NestedToolDispatchOptions | undefined;
    parentSignal: AbortSignal;
  }) => Promise<unknown>,
  nestedFinalize?: (parentToolCallId: string) => Promise<void> | undefined,
  durableTools?: DurableToolCoordinator,
  durablePath = "",
): AgentTool<TSchema> {
  return {
    name: definition.name,
    label: definition.name,
    description: providerDefinition?.description ?? definition.description,
    parameters: providerDefinition?.input ?? definition.input,
    executionMode: definition.effect === "read" ? "parallel" : "sequential",
    async execute(toolCallId, params, signal) {
      const executeOne = async (
        durable?: DurableToolInvocation,
      ): Promise<Awaited<ReturnType<AgentTool<TSchema>["execute"]>>> => {
      const timeout = AbortSignal.timeout(definition.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      // Direct in-process closures are bounded by the outer race. Composite
      // tools additionally drain admitted nested work below: finite writes
      // cannot mutate after settlement, while a non-cooperative nested closure
      // honestly remains unquiesced instead of reporting false completion.
      const nestedInvocations: Promise<unknown>[] = [];
      let directEffectSettlement: Promise<unknown> | undefined;
      let acceptingNestedCalls = true;
      const context: ToolExecutionContext = Object.freeze({
          toolCallId,
          ...(durable === undefined ? {} : { durable }),
          parentToolCallId: toolCallId,
          dispatch(name: string, args: unknown, options?: NestedToolDispatchOptions) {
            let pending: Promise<unknown>;
            try {
              if (definition.nestedTools === undefined) {
                throw new Error("cave_nested_tool_dispatch_unavailable");
              }
              if (!acceptingNestedCalls) {
                throw new Error("cave_nested_tool_parent_inactive");
              }
              if (nestedDispatch === undefined) {
                throw new Error("cave_nested_tool_dispatch_unavailable");
              }
              pending = nestedDispatch({
                parentToolCallId: toolCallId,
                name,
                args,
                options,
                parentSignal: combined,
              });
            } catch (error) {
              pending = Promise.reject(error);
            }
            nestedInvocations.push(pending);
            void pending.catch(() => undefined);
            return pending;
          },
        });
      let settledOutput: Awaited<ReturnType<typeof settleToolOutput>> | undefined;
      let executionError: unknown;
      let executionFailed = false;
      try {
        if (delegatedExecute === undefined) {
          const rawExecution = Promise.resolve().then(
            () => executeRawTool(definition, params, combined, context),
          );
          if (definition.effect !== "read") directEffectSettlement = rawExecution;
          settledOutput = await runWithToolDeadline(async () => {
            const rawValue = await rawExecution;
            return settleToolOutput(definition, rawValue);
          }, definition.timeoutMs);
        } else if (delegatedExecutionKind === "sandbox") {
          // Worker settles Standard Schema against raw runtime values before
          // JSON transport and owns process-tree timeout/close. Parent receives
          // a validated immutable settlement, never invokes schema twice.
          const startedAt = performance.now();
          const delegated = await delegatedExecute(params, combined, context);
          if (performance.now() - startedAt >= definition.timeoutMs) {
            throw new Error("cave_tool_timeout");
          }
          if (!isSettledToolOutput(delegated)) {
            throw new Error("cave_sandbox_invalid_output");
          }
          settledOutput = delegated;
        } else if (delegatedExecutionKind === "subagent") {
          // Child run may ignore abort. Dispatch still observes its deadline;
          // raw child settlement remains tracked below so parent cannot report
          // clean completion while child accounting/effects remain live.
          const childSettlement = Promise.resolve().then(async () => {
            const rawValue = await delegatedExecute(params, combined, context);
            return settleToolOutput(definition, rawValue);
          });
          nestedInvocations.push(childSettlement);
          void childSettlement.catch(() => undefined);
          settledOutput = await runWithToolDeadline(
            () => childSettlement,
            definition.timeoutMs,
          );
        } else {
          // Connect owns subprocess termination; deadline still spans both its
          // execution and potentially async Standard output settlement.
          settledOutput = await runWithToolDeadline(async () => {
            const rawValue = await delegatedExecute(params, combined, context);
            return settleToolOutput(definition, rawValue);
          }, definition.timeoutMs);
        }
      } catch (error) {
        executionFailed = true;
        executionError = error;
      }
      acceptingNestedCalls = false;
      // Host closures cannot be preempted. Never terminally settle an admitted
      // effect while its raw execute body can still mutate external state.
      if (directEffectSettlement !== undefined) {
        const quiesced = await boundedSettlement([directEffectSettlement], 1_000);
        if (!quiesced) throw new Error("cave_tool_effect_unquiesced");
      }
      // A composite cannot settle while nested mutations remain in flight.
      // Program-owned error handling decides whether a nested rejection is
      // recovered; kernel still waits for every admitted call to quiesce.
      const finalize = nestedFinalize?.(toolCallId);
      if (finalize !== undefined) {
        nestedInvocations.push(finalize);
        void finalize.catch(() => undefined);
      }
      if (nestedInvocations.length > 0) {
        const quiesced = await boundedSettlement(nestedInvocations, 1_000);
        if (!quiesced) throw new Error("cave_program_nested_calls_unquiesced");
      }
      if (executionFailed) throw executionError;
      if (settledOutput === undefined) throw new Error("cave_tool_result_missing");
      const text = settledOutput.text;
      const raw = settledOutput.bytes;
      const maxInlineBytes = definition.artifact === undefined
        ? 32_768
        : definition.artifact.maxInlineTokens * 4;
      if (deferLockedToolResult) {
        if (raw.byteLength > 16 * 1024 * 1024) throw new Error("cave_tool_result_limit");
        return {
          content: [{ type: "text", text: text ?? "null" }],
          details: { effect: definition.effect, resultPolicy: definition.result, lockedRoutePending: true },
        };
      }
      if (definition.result === "inline") {
        if (raw.byteLength > maxInlineBytes) throw new Error("cave_tool_result_inline_limit");
        return {
          content: [{ type: "text", text: text ?? "null" }],
          details: { effect: definition.effect, resultPolicy: definition.result },
        };
      }
      const mustOffload = definition.result === "page" ||
        definition.result === "compress" ||
        definition.result === "exact_ccr" ||
        raw.byteLength > maxInlineBytes;
      if (!mustOffload) {
        return {
          content: [{ type: "text", text: text ?? "null" }],
          details: { effect: definition.effect, resultPolicy: definition.result },
        };
      }
      const transformed = await engineCompress(raw, engineBin);
      if (!transformed.handle || !recoveryHandles) {
        throw new Error("cave_tool_result_requires_recovery");
      }
      const recovered = await engineRetrieve(transformed.handle, undefined, engineBin);
      if (!bytesEqual(recovered, raw)) throw new Error("cave_tool_result_recovery_mismatch");
      recoveryHandles.add(transformed.handle);
      const compressed = new TextDecoder().decode(transformed.output);
      return {
        content: [{
          type: "text",
          text: [
            compressed,
            `<<cave_retrieve:${transformed.handle}>>`,
            definition.result === "page"
              ? "Use cave_retrieve with a narrow query to page relevant detail."
              : "Use cave_retrieve for omitted detail.",
          ].join("\n"),
        }],
        details: {
          effect: definition.effect,
          resultPolicy: definition.result,
          recoveryHandle: transformed.handle,
          recoveryVerified: true,
        },
      };
      };
      const result = durableTools === undefined
        ? executeOne()
        : durableTools.execute({
          path: durablePath,
          toolCallId,
          name: definition.name,
          effect: definition.effect,
          args: params,
        }, executeOne);
      const settled = await result;
      if (isRecord(settled) && isRecord(settled.details) &&
          typeof settled.details.recoveryHandle === "string") {
        recoveryHandles?.add(settled.details.recoveryHandle);
      }
      return settled;
    },
  };
}

function validatedToolSchemaBytes(output: Uint8Array, segmentID: string): Uint8Array {
  const parsed = JSON.parse(new TextDecoder().decode(output)) as unknown;
  if (!isRecord(parsed) || typeof parsed.name !== "string" ||
      typeof parsed.description !== "string" || !isRecord(parsed.input)) {
    throw new Error(`tool_schema_transform_invalid:${segmentID}`);
  }
  return output;
}

function providerToolDefinition(
  definition: ToolDefinition,
  lowered: LoweredContext,
  appliedPlan: AppliedPlan,
): { description: string; input: TSchema } {
  const segment = lowered.ir.segments.find((item) => item.id === `tool.${definition.name}`);
  if (!segment) throw new Error(`cave_context_segment_missing:tool.${definition.name}`);
  const body = appliedPlan.bodies.get(segment.bodyHandle);
  if (!body) throw new Error(`cave_context_body_missing:tool.${definition.name}`);
  const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  if (!isRecord(parsed) || parsed.name !== definition.name ||
      typeof parsed.description !== "string" || !isRecord(parsed.input)) {
    throw new Error(`cave_tool_schema_invalid:${definition.name}`);
  }
  return { description: parsed.description, input: parsed.input as TSchema };
}

async function executeSubagent(
  toolDefinition: ToolDefinition,
  params: unknown,
  signal: AbortSignal | undefined,
  parentOptions: InternalRunOptions,
  usage: NestedUsage,
  executionContext: InternalExecutionContext,
  parentMeter: BudgetMeter | undefined,
  parentDeadlineAt: number | undefined,
  parentToolCallId?: string,
): Promise<unknown> {
  const runtime = toolDefinition.runtime;
  if (runtime?.kind !== "subagent") throw new Error("cave_subagent_runtime_missing");
  if (params === null || typeof params !== "object" || Array.isArray(params) ||
      typeof (params as { task?: unknown }).task !== "string") {
    throw new Error("cave_subagent_arguments_invalid");
  }
  const task = (params as { task: string }).task;
  if (task.length > runtime.maxInputChars) throw new Error("cave_subagent_input_limit");
  const calls = usage.calls.get(toolDefinition.name) ?? 0;
  if (calls >= runtime.maxCalls) throw new Error("cave_subagent_call_budget");
  // Reserve synchronously before any await so parallel Pi tool dispatch cannot
  // pass the same maxCalls check twice.
  usage.calls.set(toolDefinition.name, calls + 1);
  const depth = executionContext.depth;
  const depthLimit = Math.min(
    parentOptions.maxSubagentDepth ?? DEFAULT_SUBAGENT_DEPTH_LIMIT,
    ABSOLUTE_SUBAGENT_DEPTH_LIMIT,
  );
  if (depth + 1 > depthLimit) throw new Error("cave_subagent_depth_limit");
  // The wallet is carved here, still synchronously, for the same reason: two
  // subagents dispatched in one turn must not both be funded out of the same
  // remaining budget.
  const walletAmount = parentMeter === undefined
    ? undefined
    : parentMeter.denomination === "usd" ? runtime.maxCostUsd : runtime.maxTokens;
  if (parentMeter !== undefined && walletAmount === undefined) {
    throw new Error("cave_subagent_wallet_denomination_unavailable");
  }
  const carve = parentMeter === undefined || walletAmount === undefined
    ? undefined
    : parentMeter.carve(walletAmount);
  if (parentMeter !== undefined && carve === undefined) {
    throw new Error("cave_subagent_wallet_unavailable");
  }
  // Depth and wallet rejection happen before root-tree admission. Admission is
  // synchronous, so parallel tools cannot both observe stale capacity.
  let releaseAdmission: (() => void) | undefined;
  try {
    releaseAdmission = executionContext.subagentAdmissions.admit();
  } catch (error) {
    if (parentMeter !== undefined && carve !== undefined) parentMeter.settleCarve(carve);
    throw error;
  }
  try {
    const invocationTrace = parentOptions.invocationTrace === undefined
      ? undefined
      : childInvocationTrace(
        parentOptions.invocationTrace,
        childInvocationGuardManifest({
          runtime,
          parentMeter,
          rootBudget: parentOptions.invocationTrace.batch.rootBudgetGuard,
          treeInvocations: parentOptions.invocationTrace.batch.treeInvocationsGuard,
          treeConcurrency: parentOptions.invocationTrace.batch.treeConcurrencyGuard,
          breakers: parentOptions.breakers,
        }),
      );
    return await runSubagent({
      toolDefinition,
      runtime,
      task,
      signal,
      parentOptions,
      usage,
      executionContext,
      depth,
      childMeter: carve?.child,
      parentDeadlineAt,
      invocationTrace,
      parentToolCallId,
    });
  } finally {
    releaseAdmission?.();
    // Whatever the child did not spend goes back to the parent, on every path.
    if (parentMeter !== undefined && carve !== undefined) parentMeter.settleCarve(carve);
  }
}

async function runSubagent(input: {
  toolDefinition: ToolDefinition;
  runtime: SubagentRuntimeDefinition;
  task: string;
  signal: AbortSignal | undefined;
  parentOptions: InternalRunOptions;
  usage: NestedUsage;
  executionContext: InternalExecutionContext;
  depth: number;
  childMeter: BudgetMeter | undefined;
  parentDeadlineAt: number | undefined;
  invocationTrace: InvocationTrace | undefined;
  parentToolCallId: string | undefined;
}): Promise<unknown> {
  const {
    toolDefinition,
    runtime,
    task,
    signal,
    parentOptions,
    usage,
    executionContext,
    depth,
  } = input;
  if (signal?.aborted) throw signal.reason;
  const childDefinition = runtime.definition as AgentDefinition;
  const childContext = await lowerAgentContext(childDefinition, {
    ...(parentOptions.rootDir === undefined ? {} : { rootDir: parentOptions.rootDir }),
    input: task,
  });
  const childContextTokens = childContext.ir.segments
    .reduce((total, segment) => total + segment.tokenCount, 0);
  if (childContextTokens > runtime.maxContextTokens) {
    throw new Error("cave_subagent_context_budget");
  }
  const childUsesAuto = childDefinition.model !== null &&
    typeof childDefinition.model === "object" &&
    "kind" in childDefinition.model &&
    childDefinition.model.kind === "auto";
  const childModel = childUsesAuto && parentOptions.model !== undefined
    ? parentOptions.model
    : resolveModel(
      childDefinition,
      parentOptions.models ?? builtinModels(),
      parentOptions.rootDir ?? process.cwd(),
    );
  // A carved wallet is already the child's hard economic boundary in the
  // parent's denomination. Stacking the legacy USD-only ledger on a token
  // wallet would require catalog pricing and reject otherwise valid raw-token
  // runs (including subscription/unpriced transports). Keep that ledger only
  // for standalone legacy subagents that have no carved BudgetMeter.
  let spendLedger: SpendLedger | undefined;
  if (input.childMeter === undefined) {
    spendLedger = usage.budgets.get(toolDefinition.name);
    if (spendLedger === undefined) {
      spendLedger = {
        limitUsd: runtime.maxCostUsd,
        maxContextTokens: runtime.maxContextTokens,
        exceededCode: "cave_subagent_cost_budget",
        actualUsd: 0,
        reservedUsd: 0,
        incomplete: false,
      };
      usage.budgets.set(toolDefinition.name, spendLedger);
    }
    if (spendLedger.incomplete) throw new Error("cave_subagent_spend_evidence_incomplete");
  }
  // budget and deadlineMs never travel down as options: the child is handed
  // the wallet its parent already carved and the parent's absolute deadline,
  // so it can neither mint itself a second budget nor restart the clock.
  const {
    lockedBuild: _lockedBuild,
    candidatePlan: _candidatePlan,
    conversation: _conversation,
    model: _parentModel,
    signal: _parentSignal,
    budget: _parentBudget,
    budgetController: _parentBudgetController,
    onBudgetExhausted: _parentOnBudgetExhausted,
    deadlineMs: _parentDeadlineMs,
    invocationTrace: _parentInvocationTrace,
    // Durability is a root contract. The child inherits the ROOT journal via
    // executionContext (money events, path-tagged), never its own copy of the
    // durable option — a child opening the same journal would fight the
    // root's lock and double-drive the run.
    durable: _parentDurable,
    ...inherited
  } = parentOptions;
  const subagentPath = Object.freeze([
    ...executionContext.agentPath,
    toolDefinition.name,
  ]);
  if (executionContext.durableTools !== undefined && input.parentToolCallId === undefined) {
    throw new Error("cave_durable_tool_call_id_missing");
  }
  const durablePath = Object.freeze([
    ...(executionContext.durablePath ?? []),
    `${toolDefinition.name}:${input.parentToolCallId === undefined
      ? "volatile"
      : sha256(input.parentToolCallId)}`,
  ]);
  const childExecutionContext: InternalExecutionContext = Object.freeze({
    rootDefinitionSha256: executionContext.rootDefinitionSha256,
    agentPath: subagentPath,
    spendLedgers: spendLedger === undefined
      ? executionContext.spendLedgers
      : Object.freeze([...executionContext.spendLedgers, spendLedger]),
    sandboxRequired: executionContext.sandboxRequired ||
      childDefinition.sandbox === "required",
    depth: depth + 1,
    subagentAdmissions: executionContext.subagentAdmissions,
    ...(input.childMeter === undefined ? {} : { budgetMeter: input.childMeter }),
    ...(input.parentDeadlineAt === undefined ? {} : { deadlineAt: input.parentDeadlineAt }),
    ...(executionContext.journal === undefined ? {} : { journal: executionContext.journal }),
    ...(executionContext.durableTools === undefined
      ? {}
      : { durableTools: executionContext.durableTools, durablePath }),
  });
  const childSignal = signal === undefined
    ? _parentSignal
    : _parentSignal === undefined
      ? signal
      : AbortSignal.any([signal, _parentSignal]);
  let child: RunResult;
  try {
    child = await runAgentWithOptions(
      childDefinition,
      task,
      {
        ...inherited,
        ensureRuntime: false,
        model: childModel,
        ...(input.invocationTrace === undefined ? {} : { invocationTrace: input.invocationTrace }),
        ...(childSignal === undefined ? {} : { signal: childSignal }),
      },
      childExecutionContext,
    );
  } catch (error) {
    if (error instanceof CavemanRunError) usage.receipts.push(error.receipt);
    usage.incomplete = true;
    throw error;
  }
  // A completed child is paid evidence even when its terminal usage is
  // unavailable. Retain its receipt before rejecting incomplete propagation;
  // otherwise the parent settles the carve but loses the child subtree.
  usage.receipts.push(child.receipt);
  if (child.usageBasis !== "provider_reported" || !completeUsage(child)) {
    usage.incomplete = true;
    throw new Error("cave_nested_usage_incomplete");
  }
  usage.inputTokens += child.inputTokens;
  usage.outputTokens += child.outputTokens;
  usage.cacheReadTokens += child.cacheReadTokens;
  usage.cacheWriteTokens += child.cacheWriteTokens;
  usage.reasoningTokens += child.reasoningTokens;
  usage.costUsd += child.costUsd;
  if (child.mode === "observe-only") usage.observeOnly = true;
  if (child.priceBasis !== "public_catalog") usage.unpriced = true;
  if (child.inputTokens > runtime.maxContextTokens) {
    usage.incomplete = true;
    throw new Error("cave_subagent_context_budget");
  }
  if (spendLedger !== undefined &&
      (spendLedger.incomplete || spendLedger.actualUsd > runtime.maxCostUsd)) {
    usage.incomplete = true;
    throw new Error("cave_subagent_cost_budget");
  }
  return {
    text: child.text,
    agent_id: child.agentId,
    usage_basis: child.usageBasis,
    input_tokens: child.inputTokens,
    output_tokens: child.outputTokens,
    cost_usd: child.costUsd,
    // A child that ran out of wallet returns partial work; the caller sees why
    // rather than reading a truncated answer as a complete one.
    stop_reason: child.stopReason,
    claim_basis: "inferred",
  };
}

function completeUsage(result: RunResult): boolean {
  if (result.reasoningUsageBasis !== "provider_reported") return false;
  return [
    result.inputTokens,
    result.outputTokens,
    result.cacheReadTokens,
    result.cacheWriteTokens,
    result.reasoningTokens,
    result.costUsd,
  ].every((value) => Number.isFinite(value) && value >= 0);
}

/**
 * Ceiling on one prospective call over `messages`, on the same byte-derived
 * basis the meter reserves against.
 */
export function callCeilingFor(
  selected: Model<Api>,
  systemPrompt: string,
  messages: readonly AgentMessage[],
  tools: unknown,
  outputTokenCap: number,
  restorableBytes = 0,
): CallCeiling {
  const bytes = serializedContextBytes({ systemPrompt, messages, tools });
  return {
    provider: selected.provider,
    model: selected.id,
    inputTokenCeiling: bytes === undefined
      ? selected.contextWindow
      : inputTokenCeiling(
        bytes + Math.max(0, restorableBytes),
        messages.length,
        selected.contextWindow,
      ),
    outputTokenCap,
  };
}

/**
 * One compaction attempt: **evict, then summarize**, both inside the same
 * budget the run is defending.
 *
 * Eviction avoids a summarizer call — stale tool output becomes a citation
 * pointer — and is applied whenever it shrinks anything.
 * Summarization is only reached when eviction alone did not buy the next call,
 * and only when its own preconditions hold: affordable at the cold cache rate,
 * yielding more than the floor, and leaving room for several working calls
 * rather than exactly one.
 *
 * Every rejection path returns the best context it has and lets the caller fall
 * through to the clamp rung. A compaction that cannot be checked is never
 * accepted.
 */
async function compactContext(input: {
  messages: readonly AgentMessage[];
  systemPrompt: string;
  tools: unknown;
  meter: BudgetMeter;
  selected: Model<Api>;
  outputTokenCap: number;
  baseStream: StreamFn;
  sessionId: string;
  signal: AbortSignal | undefined;
  /** 1-based number of this compaction within the run, for the rollover sink. */
  generation: number;
  previousSummary: ContextSummary | undefined;
  receipt: ReceiptRecorder;
  /**
   * The run's gateway header set, or undefined when this run is not routed
   * through the gateway. A summarization on an optimized run must carry the
   * same account credential and identifiers as a working call — without them
   * the gateway rejects it and the rung dies silently on exactly the path it
   * was built for.
   */
  headers: ProviderHeaders | undefined;
  /**
   * Legacy outer spend ledgers this run reserves against, when present. A
   * carved child's own hard boundary is its BudgetMeter; this separate list
   * preserves older root/ancestor maxCostUsd limits without stacking another
   * USD ledger on that child meter.
   */
  spendLedgers: readonly SpendLedger[];
  /** Resolves a same-provider model immediately before a paid summary call. */
  routeModel: (
    selected: Model<Api>,
    context: Parameters<StreamFn>[1],
    streamOptions: Parameters<StreamFn>[2],
  ) => Promise<{ selected: Model<Api>; decision?: ModelCallRouteDecision }>;
  /** Called once a compaction has taken a reservation, so a paid attempt counts. */
  onReserved: (
    selected: Model<Api>,
    decision: ModelCallRouteDecision | undefined,
  ) => void | Promise<void>;
  /** Closes a durable intent when stream acquisition proves no call began. */
  onAbandoned: () => void | Promise<void>;
  /**
   * Accrues the summarizer's provider usage into the run's own totals. A
   * compaction is a provider call the run made; it belongs in `RunResult`'s
   * usage and cost exactly like a working call, or the run under-reports
   * itself and every parent aggregating it inherits the gap.
   */
  accrue: (
    usage: ValidatedProviderUsage | undefined,
    selected: Model<Api>,
    settledAmount: number,
  ) => void;
  /**
   * Whether the provider's own usage reported a warm prefix on the last call.
   * `unknown` models cold — under-claim, never blend.
   */
  cacheState: "warm" | "cold" | "unknown";
}): Promise<{
  messages: AgentMessage[];
  summary: ContextSummary | undefined;
  tier: ReceiptCompaction["tier"];
} | undefined> {
  const config = input.meter.compaction;
  const accountingAt = new Date();
  const plan = planCompaction(input.messages, config);
  const summarySources = contextSummarySources(input.messages, plan.summarizable);
  const previousSummary = input.previousSummary ?? latestContextSummary(input.messages);
  const preTokens = messagesTokens(input.messages);
  const elidedDigests: string[] = [];
  const evictable = new Set(plan.evictable);
  const evicted = input.messages.map((message, index) => {
    if (!evictable.has(index)) return message;
    const citation = evictMessage(message, index);
    // A citation longer than what it replaces is not a compaction.
    if (messagesTokens([citation]) >= messagesTokens([message])) return message;
    elidedDigests.push(elidedDigest(message));
    return citation;
  });
  const evictedTokens = messagesTokens(evicted);
  const pinnedIds = plan.pinned.map((index) => `runtime.user_intent.${index}`);
  const evictionHelped = evictedTokens < preTokens;

  const fitsAfterEviction = callFitsBudget(
    input.meter,
    callCeilingFor(
      input.selected,
      input.systemPrompt,
      evicted,
      input.tools,
      input.outputTokenCap,
    ),
    accountingAt,
  );
  if (fitsAfterEviction && evictionHelped) {
    input.receipt.recordCompaction({
      tier: "evicted",
      preTokens,
      postTokens: evictedTokens,
      pinnedSegmentIds: pinnedIds,
      elidedSegmentDigests: elidedDigests,
      summarySchemaVersion: undefined,
      cacheState: input.cacheState,
      meteredCost: 0,
      });
    return { messages: evicted, summary: previousSummary, tier: "evicted" };
  }

  // The rollover rung sits exactly where summarization would: free eviction has
  // already been tried and was not enough. Unlike summarization it makes no
  // provider call, so there is no reservation, no usage to accrue, and nothing
  // to settle — the only cost it can impose is the cold prefix the rewrite
  // forces, which `minYieldTokens` is already the guard for.
  if (config.mode === "new-context") {
    let seed: string;
    try {
      seed = await config.newContext!({
        messages: input.messages,
        generation: input.generation,
      });
    } catch {
      // The window could not be persisted. Dropping it anyway would destroy
      // context nothing can recover, so the rung declines.
      return evictionHelped ? finishEviction() : undefined;
    }
    const fresh = newContextMessages(input.messages, plan, seed);
    const freshTokens = messagesTokens(fresh);
    if (preTokens - freshTokens < config.minYieldTokens) {
      return evictionHelped ? finishEviction() : undefined;
    }
    input.receipt.recordCompaction({
      tier: "new-context",
      preTokens,
      postTokens: freshTokens,
      pinnedSegmentIds: pinnedIds,
      // A rollover elides nothing to a citation: it drops the window whole and
      // the sink owns what happens to it.
      elidedSegmentDigests: [],
      summarySchemaVersion: undefined,
      cacheState: input.cacheState,
      meteredCost: 0,
    });
    // No summary lineage crosses a rollover: the next window starts with no
    // prior capsule to validate a transition against.
    return { messages: fresh, summary: undefined, tier: "new-context" };
  }

  const recentSet = new Set(plan.recent);
  const head = plan.pinned
    .filter((index) => !recentSet.has(index))
    .map((index) => input.messages[index]!);
  const tail = plan.recent.map((index) => evicted[index]!);
  const requestedSummarizer = chooseSummarizer(config.summarizerModel, input.selected, preTokens);
  // The summarization request is built by the same shape as a working call —
  // same system prompt, same tools, same history — so it extends the cached
  // prefix instead of starting a second one.
  const summarizerMessages: AgentMessage[] = [
    ...evicted,
    {
      role: "user",
      content: summarizationInstruction(previousSummary, summarySources),
      timestamp: Date.now(),
    } as AgentMessage,
  ];
  const routedSummarizer = await input.routeModel(
    requestedSummarizer,
    {
      systemPrompt: input.systemPrompt,
      messages: summarizerMessages as never,
      tools: input.tools as never,
    },
    { maxTokens: config.summaryMaxTokens, sessionId: input.sessionId },
  );
  const summarizerModel = routedSummarizer.selected;
  const summarizerCall = callCeilingFor(
    summarizerModel,
    input.systemPrompt,
    summarizerMessages,
    input.tools,
    config.summaryMaxTokens,
  );
  // Always reserved COLD, whatever the last working call's cache evidence said.
  //
  // The summarizer is a different request from the call that read that warm
  // prefix: the middle has been rewritten by eviction, an instruction is
  // appended, and the working call's context transform did not run. A prefix
  // that diverges at the first rewritten message is a cold read, so pricing it
  // as a cache read books roughly a tenth of what arrives.
  //
  // The same-model summarizer is intentionally reachable because the caller
  // triggers while four cold working-call ceilings remain. This reserve still
  // prices the summarizer cold; reachability comes from earlier timing, never
  // an unevidenced cache discount.
  const summarizerCost = callCeilingCost(
    input.meter.denomination,
    summarizerCall,
    config.summaryMaxTokens,
    accountingAt,
  );
  if (summarizerCost === undefined) return evictionHelped ? finishEviction() : undefined;
  // Model the post-compaction working call before paying for one: the summary
  // replaces the middle, so the projected context is head + summary + tail.
  const projected = [...head, summaryMessage(placeholderSummary(config.summaryMaxTokens)), ...tail];
  const projectedTokens = messagesTokens(projected);
  if (preTokens - projectedTokens < config.minYieldTokens) {
    return evictionHelped ? finishEviction() : undefined;
  }
  const projectedCall = callCeilingFor(
    input.selected,
    input.systemPrompt,
    projected,
    input.tools,
    input.outputTokenCap,
  );
  const projectedCost = callCeilingCost(
    input.meter.denomination,
    projectedCall,
    input.outputTokenCap,
    accountingAt,
  );
  if (projectedCost === undefined) return evictionHelped ? finishEviction() : undefined;
  // Budget floor: reserve enough for compaction and projected working calls;
  // otherwise eviction is the only safe fallback.
  if (input.meter.remaining() < summarizerCost + config.headroomCalls * projectedCost) {
    return evictionHelped ? finishEviction() : undefined;
  }

  const reservation = input.meter.reserve(summarizerCost, config.summaryMaxTokens);
  if (reservation === undefined) return evictionHelped ? finishEviction() : undefined;
  // Preserve any legacy outer maxCostUsd holds too. A ledger that cannot cover
  // this call declines compaction rather than throwing; carved child-wallet
  // enforcement is already the BudgetMeter reservation above.
  let ledgerReservations: SpendReservation[];
  try {
    ledgerReservations = reserveProviderSpend(
      input.spendLedgers,
      summarizerModel,
      config.summaryMaxTokens,
      accountingAt,
    );
  } catch {
    input.meter.cancel(reservation);
    return evictionHelped ? finishEviction() : undefined;
  }
  // Past this point the attempt is paid for whatever happens to its output.
  // Awaited: a durable run fsyncs the summarizer's intent here, giving the
  // compaction call the same crash-window barrier as a working call.
  await input.onReserved(summarizerModel, routedSummarizer.decision);
  let stream: Awaited<ReturnType<StreamFn>>;
  try {
    stream = await input.baseStream(
      summarizerModel,
      {
        systemPrompt: input.systemPrompt,
        messages: summarizerMessages as never,
        // Same tool definitions as a working call. Dropping them is what makes
        // a compaction request diverge from the cached prefix and re-send the
        // whole history as fresh input.
        tools: input.tools as never,
      },
      {
        maxTokens: config.summaryMaxTokens,
        sessionId: input.sessionId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        // Same account credential and identifiers as a working call. The
        // context bill and transform markers describe THIS request: a
        // compaction is a framework-local rewrite, not a gateway transform.
        ...(input.headers === undefined ? {} : {
          headers: {
            ...input.headers,
            "x-cave-transforms": "caveman.pass-through.v1",
            "x-cave-transform-location": "local",
          },
        }),
      },
    );
  } catch {
    // The provider never returned a stream, so this attempt is proven
    // unbilled. Cancel both holds and close the durable intent as abandoned.
    input.meter.cancel(reservation);
    releaseLedgerHolds(ledgerReservations);
    await input.onAbandoned();
    return evictionHelped ? finishEviction() : undefined;
  }
  let assistant: AssistantMessage;
  try {
    for await (const _event of stream) { /* drain to terminal */ }
    assistant = await stream.result();
  } catch {
    // A returned stream is provider-visible. If it then fails, billing is
    // uncertain: settle the full reservation, retain an unavailable call in
    // the receipt/journal, and make the run stop on incomplete usage evidence.
    const metered = reservation.amount;
    markSpendIncomplete(ledgerReservations.map((item) => item.ledger));
    input.accrue(undefined, summarizerModel, metered);
    input.receipt.recordCompactionCall({
      provider: summarizerModel.provider,
      model: summarizerModel.id,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedUsd: 0,
      unpriced: true,
      usageBasis: "unavailable",
      clampedOutputTokens: undefined,
    });
    input.meter.settle(reservation, metered);
    return evictionHelped ? finishEviction(metered) : undefined;
  }
  let metered = reservation.amount;
  let unpriced = true;
  let ledgerFailure: Error | undefined;
  try {
    const usage = validateProviderUsage({
      provider: assistant.provider,
      model: assistant.model,
      inputTokens: assistant.usage.input,
      outputTokens: assistant.usage.output,
      cacheReadTokens: assistant.usage.cacheRead,
      cacheWriteTokens: assistant.usage.cacheWrite,
      reasoningTokens: assistant.usage.reasoning ?? 0,
      totalTokens: assistant.usage.totalTokens,
    }, { accountingAt });
    metered = input.meter.denomination === "usd" ? usage.catalogCostUsd : usage.totalTokens;
    unpriced = !usage.priced;
    // Settle any legacy outer maxCostUsd ledgers. A carved child's own
    // compaction is settled by its BudgetMeter reservation above.
    ledgerFailure = settleProviderSpend(ledgerReservations, usage);
    input.accrue(usage, summarizerModel, metered);
    input.receipt.recordCompactionCall({
      provider: usage.provider,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      estimatedUsd: usage.catalogCostUsd,
      unpriced: !usage.priced,
      usageBasis: "provider_reported",
      clampedOutputTokens: undefined,
    });
  } catch {
    // The summarizer ran and cost something we cannot read. Settle at the
    // worst case rather than letting an unmeasurable call read as free, and
    // tell the run and any legacy outer ledgers the evidence is incomplete.
    markSpendIncomplete(ledgerReservations.map((item) => item.ledger));
    input.accrue(undefined, summarizerModel, metered);
    input.receipt.recordCompactionCall({
      provider: summarizerModel.provider,
      model: summarizerModel.id,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedUsd: 0,
      unpriced: true,
      usageBasis: "unavailable",
      clampedOutputTokens: undefined,
    });
  }
  input.meter.settle(reservation, metered);
  // A compaction that pushed a legacy outer ledger past its cap is that
  // ledger's failure to raise, exactly as a working call would be.
  if (ledgerFailure !== undefined) throw ledgerFailure;
  if (unpriced && input.meter.denomination === "usd") {
    return evictionHelped ? finishEviction(metered) : undefined;
  }

  const summary = parseContextSummary(assistantText(assistant));
  // A summary that does not validate is discarded, never shipped.
  if (summary === undefined) return evictionHelped ? finishEviction(metered) : undefined;
  const transition = validateContextSummaryTransition(
    summary, previousSummary, summarySources,
  );
  if (!transition.ok) return evictionHelped ? finishEviction(metered) : undefined;
  const compacted = [...head, summaryMessage(renderSummary(summary)), ...tail];
  const postTokens = messagesTokens(compacted);
  // Pinned survival is STRUCTURAL here, not something to re-assert: `head` and
  // `tail` are verbatim slices of the original messages and the summary is
  // inserted strictly between them, so every pinned index is carried through
  // unchanged by construction. A `pinnedContentSurvives` call at
  // this site can only ever succeed, so it is retired rather than kept as a
  // check that cannot fail. Inflation is the real guard that remains: a rewrite
  // that bought nothing is discarded.
  if (postTokens >= preTokens) {
    return evictionHelped ? finishEviction(metered) : undefined;
  }
  input.receipt.recordCompaction({
    tier: "summarized",
    preTokens,
    postTokens,
    pinnedSegmentIds: pinnedIds,
    elidedSegmentDigests: elidedDigests,
    summarySchemaVersion: SUMMARY_SCHEMA_VERSION,
    cacheState: input.cacheState,
    meteredCost: metered,
  });
  return { messages: compacted, summary, tier: "summarized" };

  function finishEviction(meteredCost = 0) {
    input.receipt.recordCompaction({
      tier: "evicted",
      preTokens,
      postTokens: evictedTokens,
      pinnedSegmentIds: pinnedIds,
      elidedSegmentDigests: elidedDigests,
      summarySchemaVersion: undefined,
      cacheState: input.cacheState,
      meteredCost,
      });
    return { messages: evicted, summary: previousSummary, tier: "evicted" as const };
  }
}

/**
 * A cheaper summarizer is opt-in and gated: below a context window that covers
 * the history it must read, it would fail at exactly the moment it is needed,
 * so the run falls back to its own working model.
 */
function chooseSummarizer(
  requested: Model<Api> | undefined,
  working: Model<Api>,
  historyTokens: number,
): Model<Api> {
  if (requested === undefined) return working;
  return requested.contextWindow >= historyTokens ? requested : working;
}

function summaryMessage(body: Record<string, unknown>): AgentMessage {
  return {
    role: "user",
    content: `<cave-context-summary>\n${JSON.stringify(body)}\n</cave-context-summary>`,
    caveContextSummary: true,
    timestamp: Date.now(),
  } as AgentMessage;
}

/** Worst-case summary body used to model the post-compaction context before paying for one. */
function placeholderSummary(summaryMaxTokens: number): Record<string, unknown> {
  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    generation: 1,
    anchors: [],
    objective: "x".repeat(summaryMaxTokens * 4),
  };
}

async function retryModelCall(
  attemptCall: () => ReturnType<StreamFn>,
  breakers: BreakerState,
  pending: PendingCallRecord,
  stopError: () => Error | undefined,
  onMeterReserved: (meter: BudgetMeter) => void | Promise<void>,
  abandon: () => void,
): Promise<Awaited<ReturnType<StreamFn>>> {
  const meter = pending.reservationMeter;
  const initial = pending.reservation;
  if (meter === undefined || initial === undefined) return attemptCall();
  const worstCaseSpend = initial.amount;
  const outputTokenCap = initial.outputTokenCap;
  let attempt = 0;
  for (;;) {
    try {
      return await attemptCall();
    } catch (error) {
      if (pending.reservation !== undefined) {
        pending.reservationMeter?.cancel(pending.reservation);
        if (pending.retryAttempt !== undefined) {
          breakers.settleRetry(pending.retryAttempt, 0, "pre_stream_no_usage");
        }
        pending.reservation = undefined;
        pending.reservationMeter = undefined;
        pending.retryAttempt = undefined;
      }
      const terminal = stopError();
      if (terminal !== undefined || terminalRetryError(error)) {
        abandon();
        throw terminal ?? error;
      }
      attempt++;
      if (!breakers.retryExposureAvailable(worstCaseSpend, attempt)) {
        abandon();
        throw error;
      }
      const reservation = meter.reserve(worstCaseSpend, outputTokenCap);
      if (reservation === undefined) {
        breakers.recordRetryExhausted(attempt);
        abandon();
        throw error;
      }
      pending.reservation = reservation;
      pending.reservationMeter = meter;
      pending.retryAttempt = attempt;
      breakers.recordRetryAttempt(worstCaseSpend, attempt);
      await onMeterReserved(meter);
      const wait = breakers.backoffMs(attempt);
      if (wait > 0) await new Promise((settle) => setTimeout(settle, wait));
      const expired = stopError();
      if (expired !== undefined) {
        meter.cancel(reservation);
        breakers.settleRetry(attempt, 0, "pre_stream_no_usage");
        pending.reservation = undefined;
        pending.reservationMeter = undefined;
        pending.retryAttempt = undefined;
        abandon();
        throw expired;
      }
    }
  }
}

function terminalRetryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" ||
    error.message === "cave_run_aborted" ||
    error.message === "cave_stream_cancelled" ||
    error.message === "cave_run_stopped" ||
    error.message === "cave_provider_terminal_aborted";
}

/**
 * How many bytes an outgoing payload could still grow by if `onPayload`
 * restores originals.
 *
 * A transformed request carries compressed text; on cache-prefix drift the
 * runtime puts the uncompressed original back before the request leaves. The
 * reserve is taken before that happens, so it adds the full delta of every
 * substitution the run could reverse — an over-estimate by construction, which
 * is the only safe direction for a ceiling.
 */
export function restorableRequestBytes(
  originals: ReadonlyMap<string, string>,
  instructions: string,
  originalInstructions: string,
): number {
  let growth = Math.max(0, originalInstructions.length - instructions.length);
  for (const [replacement, original] of originals) {
    growth += Math.max(0, original.length - replacement.length);
  }
  return growth;
}

/** One in-flight provider call: its budget hold and the allowance it was given. */
type PendingCallRecord = {
  readonly model: Model<Api>;
  reservation: BudgetReservation | undefined;
  reservationMeter: BudgetMeter | undefined;
  retryAttempt: number | undefined;
  readonly clampedOutputTokens: number | undefined;
  accountingAt: Date;
};

type NextCallDecision =
  | {
    readonly action: "proceed";
    readonly reservation: BudgetReservation | undefined;
    /** Set only when the budget lowered this call's output allowance. */
    readonly clampedOutputTokens: number | undefined;
  }
  | { readonly action: "compact"; readonly call: CallCeiling }
  | { readonly action: "stop"; readonly reason: RunStopReason };

/**
 * The exhaustion ladder at one call boundary: deadline, then full allowance,
 * then a clamped allowance down to the floor, then stop.
 *
 * The input side of the reserve is a ceiling, not an estimate. Every catalog
 * tokenizer is byte-level BPE, so the serialized request's byte count bounds
 * its token count from above, and the model's context window bounds that in
 * turn. Reserving high stops a run at most one call early; reserving low would
 * let it spend past a cap it promised to hold.
 */
function decideNextCall(input: {
  meter: BudgetMeter | undefined;
  breakers: BreakerState | undefined;
  deadlineAt: number | undefined;
  selected: Model<Api>;
  context: Context;
  requestedOutputTokens: number | undefined;
  outputMaxTokens: number | undefined;
  planOutputTokens: number | undefined;
  /**
   * Bytes the outgoing payload can still GROW by after this reserve is taken.
   *
   * The reserve is computed on the context as it stands, but `onPayload` runs
   * afterwards and can restore uncompressed originals when the cache prefix
   * drifts — a request larger than the one that was priced. Adding the full
   * restorable delta keeps the reserve above the payload that actually leaves,
   * whichever branch onPayload takes.
   */
  restorableBytes?: number;
  /** Trusted admission time for the provider request being reserved. */
  accountingAt: Date;
}): NextCallDecision {
  const tripped = input.breakers?.tripped;
  if (tripped !== undefined) return { action: "stop", reason: tripped };
  if (input.deadlineAt !== undefined && performance.now() >= input.deadlineAt) {
    return { action: "stop", reason: "deadline" };
  }
  if (input.meter === undefined) {
    return { action: "proceed", reservation: undefined, clampedOutputTokens: undefined };
  }
  if (input.meter.denomination === "usd" &&
      !modelIsPriced(input.selected.provider, input.selected.id, input.accountingAt)) {
    throw new Error(
      "cave_budget_denomination_unavailable: " +
        `${input.selected.provider}/${input.selected.id} is not in the public ` +
        "price catalog, so a dollar budget cannot meter this call — use " +
        "budget.maxTokens or a cataloged model",
    );
  }
  const outputTokenCap = Math.min(
    input.requestedOutputTokens ?? Number.MAX_SAFE_INTEGER,
    input.outputMaxTokens ?? Number.MAX_SAFE_INTEGER,
    input.planOutputTokens ?? Number.MAX_SAFE_INTEGER,
    input.selected.maxTokens,
  );
  // One construction for every reserve in the runtime, so the restorable term
  // cannot be present in one place and missing in another.
  const call = callCeilingFor(
    input.selected,
    input.context.systemPrompt ?? "",
    input.context.messages as unknown as readonly AgentMessage[],
    input.context.tools,
    outputTokenCap,
    input.restorableBytes ?? 0,
  );
  // Compaction is never available at the CALL boundary: it is a between-turns
  // rewrite decided by prepareNextTurnWithContext, so by the time a call is being
  // planned the ladder has only clamp and stop left — the always-
  // false compactionAvailable param was dead and is removed).
  const plan = planCall(input.meter, call, false, input.accountingAt);
  if (plan.action === "stop") return { action: "stop", reason: plan.reason };
  if (plan.action === "compact") return { action: "compact", call };
  return {
    action: "proceed",
    reservation: plan.reservation,
    clampedOutputTokens: plan.outputTokenCap < outputTokenCap ? plan.outputTokenCap : undefined,
  };
}

function reserveProviderSpend(
  ledgers: readonly SpendLedger[],
  model: Model<Api>,
  requestedOutputTokens: number | undefined,
  accountingAt: Date,
): SpendReservation[] {
  if (ledgers.length === 0) return [];
  const outputTokens = Math.min(
    model.maxTokens,
    requestedOutputTokens ?? model.maxTokens,
  );
  const reservations = ledgers.map((ledger) => ({
    ledger,
    ceilingUsd: catalogSearchCeiling(
      `${model.provider}/${model.id}`,
      Math.min(model.contextWindow, ledger.maxContextTokens),
      outputTokens,
      accountingAt,
    ),
  }));
  if (reservations.some((item) => item.ceilingUsd === undefined)) {
    markSpendIncomplete(ledgers);
    throw new Error("cave_subagent_unpriced_budget");
  }
  for (const { ledger, ceilingUsd } of reservations) {
    if (ledger.incomplete) throw new Error("cave_subagent_spend_evidence_incomplete");
    if (ledger.actualUsd + ledger.reservedUsd + ceilingUsd! > ledger.limitUsd) {
      throw new Error(ledger.exceededCode);
    }
  }
  const complete = reservations.map(({ ledger, ceilingUsd }) => ({
    ledger,
    ceilingUsd: ceilingUsd!,
    provider: model.provider,
    model: model.id,
  }));
  for (const { ledger, ceilingUsd } of complete) ledger.reservedUsd += ceilingUsd;
  return complete;
}

function planContextTokenCeiling(plan: CavePlan): number {
  const ceiling = plan.budgets.instructions + plan.budgets.tools + plan.budgets.memory +
    plan.budgets.history + plan.budgets.results_artifacts;
  if (!Number.isSafeInteger(ceiling) || ceiling <= 0) {
    throw new Error("cave_plan_context_budget_invalid");
  }
  return ceiling;
}

function settleProviderSpend(
  reservations: readonly SpendReservation[],
  usage: ValidatedProviderUsage,
): Error | undefined {
  if (reservations.length === 0) return undefined;
  const requested = reservations[0]!;
  if (usage.provider !== requested.provider || usage.model !== requested.model) {
    markSpendIncomplete(reservations.map((item) => item.ledger));
    return new Error("cave_subagent_model_identity_mismatch");
  }
  if (!usage.priced) {
    markSpendIncomplete(reservations.map((item) => item.ledger));
    return new Error("cave_subagent_spend_evidence_incomplete");
  }
  let failure: Error | undefined;
  for (const reservation of reservations) {
    const { ledger, ceilingUsd } = reservation;
    ledger.reservedUsd = Math.max(0, ledger.reservedUsd - ceilingUsd);
    ledger.actualUsd += usage.catalogCostUsd;
    if (usage.catalogCostUsd > ceilingUsd || ledger.actualUsd > ledger.limitUsd) {
      ledger.incomplete = true;
      failure ??= new Error(ledger.exceededCode);
    }
  }
  return failure;
}

function markSpendIncomplete(ledgers: readonly SpendLedger[]): void {
  for (const ledger of ledgers) ledger.incomplete = true;
}

/** Give back holds for a call that never reached the provider. */
function releaseLedgerHolds(reservations: readonly SpendReservation[]): void {
  for (const { ledger, ceilingUsd } of reservations) {
    ledger.reservedUsd = Math.max(0, ledger.reservedUsd - ceilingUsd);
  }
}

async function executeSandboxedTool(
  entryPath: string,
  sourceFiles: readonly string[],
  stagingRoot: string,
  toolName: string,
  params: unknown,
  timeoutMs: number,
  allowSideEffects: boolean,
  profile: RunOptions["sandboxProfile"],
  executionContext: InternalExecutionContext,
  toolDefinitionSha256: string,
  declaredOutput: boolean,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<SettledToolOutput> {
  if (profile?.childProcess === true) {
    throw new Error("cave_sandbox_child_process_containment_unavailable");
  }
  // `network: true` still means UNRESTRICTED egress from code that holds a
  // provider credential, which is an exfiltration hole rather than a feature.
  // It stays refused. The supported alternative is naming the hosts: a policy
  // object routes the tool through the parent-owned proxy below, where the
  // allowlist is enforced somewhere the tool cannot reach.
  if (profile?.network === true) {
    throw new Error("cave_sandbox_network_egress_unbounded");
  }
  const egressPolicy = profile?.network === undefined || profile.network === false
    ? undefined
    : resolveEgressPolicy(profile.network);
  const requestedCredentialEnv = profile?.credentialEnv ?? [];
  // Validate every grant — credentials, egress policy, collapsed read roots,
  // and the availability of a backend strong enough for what was asked — before
  // allocating per-call state. Refused input must fail without leaving a
  // caveman-agent-tool-* workspace or a listening proxy behind.
  const baseEnv = buildSandboxToolEnv(requestedCredentialEnv);
  const backend = selectSandboxBackend({ scopedEgress: egressPolicy !== undefined });
  const sourceReadFlags = sandboxSourceReadFlags(sourceFiles, stagingRoot);
  const workspace = await realpath(await mkdtemp(`${tmpdir()}/caveman-agent-tool-`));
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const worker = fileURLToPath(new URL("./tool-worker.js", import.meta.url));
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const args = [
    "--permission",
    // One declared source file, framework runtime, dependencies, and ephemeral
    // workspace only. Never grant tool code a project-root read capability:
    // repositories commonly contain .env files, credentials, and local traces.
    ...sourceReadFlags,
    `--allow-fs-read=${packageRoot}`,
    ...sandboxDependencyReadRoots().map((path) => `--allow-fs-read=${path}`),
    `--allow-fs-read=${workspace}`,
    `--allow-fs-write=${workspace}`,
    worker,
  ];
  // Always under the OS boundary: `network: true` was refused above, so there is
  // no un-isolated spawn path left. The proxy is the parent's, lives outside
  // the child's namespace, and is the only thing that ever dials outward.
  const proxy: EgressProxy | undefined = egressPolicy === undefined
    ? undefined
    : await startEgressProxy(egressPolicy, resolve(workspace, "egress.sock"));
  const isolated = backend.plan({
    nodeArgs: args,
    workspace,
    ...(proxy === undefined ? {} : { egressSocketPath: proxy.socketPath }),
  });
  const childEnv = proxy === undefined || isolated.egress === "none"
    ? baseEnv
    : mergeSandboxToolEnv(baseEnv, sandboxEgressEnv(isolated.egress, proxy.url));
  // Tool code inherits fd 3 and can write arbitrary bytes to it. Authenticate
  // worker frames with a per-call secret that never enters tool context, argv,
  // or environment so forged early frames can only cause a closed failure.
  const resultAuthenticationKey = randomBytes(32).toString("hex");
  installSandboxReaping();
  try {
    const result = await new Promise<SandboxResultFrame>((accept, reject) => {
      // fd 3 carries the length-prefixed result; the tool's own stdout/stderr
      // are separate channels with their own byte budgets so a chatty dep can
      // neither corrupt the result nor SIGKILL a successful tool.
      const child = spawn(isolated.command, [...isolated.args], {
        cwd: workspace,
        detached: process.platform !== "win32",
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      liveSandboxChildren.add(child);
      const resultChunks: Buffer[] = [];
      const stderr: Buffer[] = [];
      let resultBytes = 0;
      let stderrBytes = 0;
      let terminalError: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const terminate = (error: Error, immediate = false) => {
        terminalError ??= error;
        killSandboxProcess(child, immediate ? "SIGKILL" : "SIGTERM");
        if (!immediate && killTimer === undefined) {
          killTimer = setTimeout(() => {
            killSandboxProcess(child, "SIGKILL");
          }, 250);
          killTimer.unref();
        }
      };
      const onAbort = () => {
        const signaledReason = signal?.aborted ? signal.reason : undefined;
        const reason = signaledReason instanceof DOMException &&
            signaledReason.name === "TimeoutError"
          ? new Error("cave_sandbox_timeout")
          : signaledReason ?? new Error("cave_sandbox_timeout");
        terminate(
          reason instanceof Error ? reason : new Error(String(reason)),
        );
      };
      // The tool's own stdout (console.log in its import graph) is not the
      // result and never fails the tool; drained and dropped.
      child.stdout.on("data", () => undefined);
      // stderr keeps its OWN budget: a runaway log caps its buffer but does not
      // terminate a tool that otherwise succeeded on fd 3.
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= 1_048_576) stderr.push(chunk);
      });
      const resultStream = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
      resultStream?.on("data", (chunk: Buffer) => {
        resultBytes += chunk.byteLength;
        if (resultBytes > 1_048_576) {
          terminate(new Error("cave_sandbox_output_limit"), true);
          return;
        }
        resultChunks.push(chunk);
      });
      child.stdin.on("error", () => undefined);
      child.once("error", (error) => {
        terminalError ??= error;
      });
      child.once("close", (code) => {
        liveSandboxChildren.delete(child);
        combined.removeEventListener("abort", onAbort);
        if (killTimer !== undefined) clearTimeout(killTimer);
        if (terminalError) {
          reject(terminalError);
          return;
        }
        const parsed = decodeResultFrame(
          Buffer.concat(resultChunks),
          resultAuthenticationKey,
        );
        if (parsed !== undefined) {
          accept(parsed);
          return;
        }
        // No valid result frame: fall back to the exit code and redacted stderr.
        if (code !== 0) {
          reject(new Error(`cave_sandbox_failed:${redactSandboxError(Buffer.concat(stderr).toString("utf8"))}`));
          return;
        }
        reject(new Error("cave_sandbox_invalid_output"));
      });
      combined.addEventListener("abort", onAbort, { once: true });
      if (combined.aborted) onAbort();
      child.stdin.end(JSON.stringify({
        entry: pathToFileURL(entryPath).href,
        agentPath: executionContext.agentPath,
        rootDefinitionSha256: executionContext.rootDefinitionSha256,
        toolDefinitionSha256,
        tool: toolName,
        params,
        invocation: context === undefined
          ? undefined
          : {
            toolCallId: context.toolCallId,
            ...(context.durable === undefined ? {} : { durable: context.durable }),
          },
        allowSideEffects,
        allowNetwork: egressPolicy !== undefined,
        resultAuthenticationKey,
      }));
    });
    if (!result.ok) {
      // A tool that failed after the allowlist refused a destination almost
      // always failed *because* of it. Carry the count — never the hostnames,
      // which are tool-controlled input — so the failure is diagnosable.
      const denied = proxy?.attempts().filter((attempt) => !attempt.allowed).length ?? 0;
      throw new Error(
        denied === 0
          ? result.code ?? "cave_sandbox_tool_failed"
          : `${result.code ?? "cave_sandbox_tool_failed"}:egress_denied=${denied}`,
      );
    }
    if (result.settled !== true) throw new Error("cave_sandbox_invalid_output");
    return settledToolOutputFromTransport(
      result.value,
      result.text,
      toolName,
      declaredOutput,
    );
  } finally {
    await proxy?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

function requiresSandboxEntry(
  definition: AgentDefinition,
  inheritedRequired: boolean,
): boolean {
  const sandboxRequired = inheritedRequired || definition.sandbox === "required";
  for (const declared of definition.tools) {
    const candidates = [declared, ...(declared.nestedTools ?? [])];
    for (const candidate of candidates) {
      if (candidate.runtime?.kind === "caveman-connect") continue;
      if (candidate.runtime?.kind !== "subagent") {
        if (candidate === declared && sandboxRequired) return true;
        continue;
      }
      const child = candidate.runtime.definition;
      if (child !== null && typeof child === "object" &&
          (child as { kind?: unknown }).kind === "agent" &&
          requiresSandboxEntry(child as AgentDefinition, sandboxRequired)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Refuse caller-supplied build identity, plan, or routing.
 *
 * Exported for the other public entry points that forward caller options into
 * `runAgentInternal` (`./code`): the guard belongs to whoever accepts the
 * untrusted object, and it must run BEFORE any session-internal field is merged
 * in, or the session's own plan and route would trip it.
 */
export function rejectInternalRunOptions(options: RunOptions): void {
  const value = options as Record<string, unknown>;
  if ("buildIdentity" in value || "efficiencyPlan" in value ||
      "lockedBuild" in value || "candidatePlan" in value || "caveRoute" in value ||
      "invocationTrace" in value) {
    throw new Error(
      "cave_internal_run_option: Cave Build execution is available through caveman-agent dev/build after lock validation",
    );
  }
}

let sandboxDependencyRoots: readonly string[] | undefined;

export function sandboxDependencyReadRoots(): readonly string[] {
  if (sandboxDependencyRoots !== undefined) return sandboxDependencyRoots;
  const frameworkRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const queue: string[] = [resolve(frameworkRoot, "package.json")];
  const visited = new Set<string>();
  const roots = new Set<string>();
  while (queue.length > 0) {
    const manifestPath = queue.shift()!;
    if (visited.has(manifestPath)) continue;
    visited.add(manifestPath);
    let manifest: {
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      throw new Error("cave_sandbox_dependency_manifest_invalid");
    }
    const required = new Set(Object.keys(manifest.dependencies ?? {}));
    const optional = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const dependency of [...new Set([...required, ...optional])].sort()) {
      let childManifest: string | undefined;
      try {
        childManifest = findPackageJSONCompat(dependency, pathToFileURL(manifestPath));
      } catch {
        childManifest = undefined;
      }
      if (childManifest === undefined) {
        if (required.has(dependency)) {
          throw new Error(`cave_sandbox_dependency_unresolvable:${dependency}`);
        }
        continue;
      }
      // Node's resolver reads the lexical package.json and then loads through
      // the resolved target. Workspace links therefore need both narrow roots;
      // granting either side alone fails under Node's permission model.
      const lexicalPackageRoot = dirname(childManifest);
      const resolvedPackageRoot = realpathSync(lexicalPackageRoot);
      for (const packageRoot of new Set([lexicalPackageRoot, resolvedPackageRoot])) {
        const pnpm = packageRoot.indexOf("/node_modules/.pnpm/");
        roots.add(pnpm >= 0
          ? packageRoot.slice(0, pnpm + "/node_modules/.pnpm".length)
          : packageRoot);
      }
      queue.push(childManifest);
    }
  }
  sandboxDependencyRoots = Object.freeze([...roots].sort());
  return sandboxDependencyRoots;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("cave_cache_prefix_drift")) return "cave_cache_prefix_drift";
  for (const code of ["cave_tool_policy_failed", "cave_tool_policy_decision_invalid", "cave_tool_policy_reason_invalid"]) {
    if (message.startsWith(code)) return code;
  }
  if (message.includes("credential")) return "cave_provider_credentials";
  return "cave_agent_run_failed";
}

function boundedDurableMessage(error: unknown): string {
  const firstLine = (error instanceof Error ? error.message : String(error)).split("\n", 1)[0] ?? "";
  const encoder = new TextEncoder();
  if (encoder.encode(firstLine).byteLength <= 4_096) return firstLine;
  let output = "";
  for (const point of firstLine) {
    if (encoder.encode(output + point).byteLength > 4_096) break;
    output += point;
  }
  return output;
}
