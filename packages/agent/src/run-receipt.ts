import type { BreakerEvent } from "./breakers.js";
import {
  type BudgetDenomination,
  type BudgetTranche,
  type ReceiptCall,
  type ReceiptCompaction,
  type ReceiptResume,
  type ReceiptTool,
  type RunReceipt,
  type RunStopReason,
} from "./budget.js";
import {
  snapshotDataDictionary,
  snapshotDataRecord,
  snapshotDenseArray,
} from "./strict-data.js";

/** Versioned cross-package wire identity for an SDK economic receipt. */
export const AGENT_RUN_RECEIPT_SCHEMA = "caveman.agent.run-receipt.v1" as const;

const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_STRING_BYTES = 1024 * 1024;
const MAX_ARRAY_LENGTH = 65_536;
const MAX_OBJECT_KEYS = 32;
const MAX_SNAPSHOT_DEPTH = 32;
const MAX_SNAPSHOT_NODES = 200_000;
const MAX_SUBAGENT_DEPTH = 8;

const RECEIPT_KEYS = Object.freeze([
  "schema", "runId", "agentId", "basis", "claimBasis", "stopReason",
  "denomination", "max", "released", "spent", "capBreached", "overspent",
  "totalEstimatedUsd", "totalTokens", "unpriced", "calls", "tools",
  "subagents", "tranches", "breakers", "compactions", "resume",
]);
const RECEIPT_REQUIRED_KEYS = Object.freeze([
  "schema", "runId", "agentId", "basis", "claimBasis", "stopReason",
  "denomination", "capBreached", "overspent", "totalEstimatedUsd",
  "totalTokens", "unpriced", "calls", "tools", "subagents", "tranches",
  "breakers", "compactions",
]);
const CALL_KEYS = Object.freeze([
  "provider", "model", "inputTokens", "outputTokens", "cacheReadTokens",
  "cacheWriteTokens", "reasoningTokens", "estimatedUsd", "unpriced",
  "usageBasis", "clampedOutputTokens",
]);
const CALL_REQUIRED_KEYS = Object.freeze(CALL_KEYS.filter(
  (key) => key !== "clampedOutputTokens",
));
const TOOL_KEYS = Object.freeze(["name", "calls", "errors"]);
const TOOL_ALLOWED_KEYS = Object.freeze([...TOOL_KEYS, "denied"]);
const TRANCHE_KEYS = Object.freeze(["amount", "reason", "atCall"]);
const BREAKER_KEYS = Object.freeze([
  "kind", "tool", "count", "signature", "reservedSpend", "measuredSpend",
  "spendBasis",
]);
const COMPACTION_KEYS = Object.freeze([
  "index", "tier", "preTokens", "postTokens", "pinnedSegmentIds",
  "elidedSegmentDigests", "summarySchemaVersion", "cacheState", "meteredCost",
  "meteredBasis", "modeledNetTokens", "modeledBasis", "workingCallsAfter",
]);
const COMPACTION_REQUIRED_KEYS = Object.freeze(COMPACTION_KEYS.filter(
  (key) => key !== "summarySchemaVersion",
));
const RESUME_KEYS = Object.freeze([
  "attempts", "priorCalls", "priorEstimatedUsd", "priorTokens", "priorUnpriced",
  "priorSettled", "possibleDoubleCountCalls", "discardedPartialTurn",
]);
const RESUME_REQUIRED_KEYS = Object.freeze(RESUME_KEYS.filter(
  (key) => key !== "priorSettled",
));

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STOP_REASONS = Object.freeze<RunStopReason[]>([
  "complete", "budget_exhausted", "deadline", "loop_detected", "no_progress",
  "wallet_revoked", "call_budget_exhausted",
]);
const DENOMINATIONS = Object.freeze<Array<BudgetDenomination | "none">>([
  "usd", "tokens", "none",
]);
const USAGE_BASES = Object.freeze<ReceiptCall["usageBasis"][]>([
  "provider_reported", "unavailable",
]);
const BREAKER_KINDS = Object.freeze<BreakerEvent["kind"][]>([
  "loop_detected", "no_progress", "fan_out_blocked", "retry_attempted",
  "retry_exhausted",
]);
const SPEND_BASES = Object.freeze<Array<NonNullable<BreakerEvent["spendBasis"]>>>([
  "pre_stream_no_usage", "provider_reported", "unavailable_worst_case",
]);

interface SnapshotBounds {
  nodes: number;
  stringBytes: number;
  readonly active: WeakSet<object>;
}

interface ReceiptTotals {
  tokens: number;
  estimatedUsd: number;
  unpriced: boolean;
}

/**
 * Validate one complete receipt, detach every nested value, and deeply freeze
 * the result. This is the sole public receipt parser; it accepts both JSON wire
 * objects (optional `undefined` fields absent) and SDK in-memory receipts.
 */
export function defineRunReceipt(value: unknown): RunReceipt {
  const snapshot = snapshotBoundedValue(value, {
    nodes: 0,
    stringBytes: 0,
    active: new WeakSet<object>(),
  }, 0);
  const receipt = normalizeReceipt(snapshot, 0, new Set<string>()).receipt;
  let serialized: string;
  try {
    serialized = JSON.stringify(receipt);
  } catch {
    return fail("bytes");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) fail("bytes");
  return receipt;
}

/** Alias: validation and definition share one strict parser, never two rulesets. */
export const validateRunReceipt: typeof defineRunReceipt = defineRunReceipt;

function normalizeReceipt(value: unknown, depth: number, runIds: Set<string>): {
  receipt: RunReceipt;
  totals: ReceiptTotals;
} {
  if (depth > MAX_SUBAGENT_DEPTH) fail("subagent_depth");
  const source = record(value, RECEIPT_KEYS, RECEIPT_REQUIRED_KEYS, "receipt");
  if (source["schema"] !== AGENT_RUN_RECEIPT_SCHEMA ||
      source["basis"] !== "estimated_list_price_subtotal" ||
      source["claimBasis"] !== "inferred") {
    fail("identity");
  }
  requireText(source["runId"], "run_id", RUN_ID);
  const runId = source["runId"] as string;
  if (runIds.has(runId)) fail("run_id_tree");
  runIds.add(runId);
  requireText(source["agentId"], "agent_id");
  requireOneOf(source["stopReason"], STOP_REASONS, "stop_reason");
  requireOneOf(source["denomination"], DENOMINATIONS, "denomination");
  requireBoolean(source["capBreached"], "cap_breached");
  requireNonNegativeNumber(source["overspent"], "overspent");
  requireNonNegativeNumber(source["totalEstimatedUsd"], "total_estimated_usd");
  requireNonNegativeInteger(source["totalTokens"], "total_tokens");
  requireBoolean(source["unpriced"], "unpriced");

  const denomination = source["denomination"] as BudgetDenomination | "none";
  const max = optionalNonNegativeNumber(source["max"], "max");
  const released = optionalNonNegativeNumber(source["released"], "released");
  const spent = optionalNonNegativeNumber(source["spent"], "spent");
  if (denomination === "none") {
    if (max !== undefined || released !== undefined || spent !== undefined) {
      fail("budget_shape");
    }
  } else {
    if (max === undefined || max <= 0 || released === undefined || spent === undefined ||
        released > max) {
      fail("budget_shape");
    }
    if (denomination === "tokens" &&
        (![max, released, spent].every(Number.isSafeInteger))) {
      fail("budget_shape");
    }
  }

  const calls = normalizeArray(source["calls"], "calls", normalizeCall);
  const tools = normalizeTools(source["tools"]);
  const subagentValues = array(source["subagents"], "subagents");
  const subagentEntries = subagentValues.map((child) =>
    normalizeReceipt(child, depth + 1, runIds));
  const subagents = Object.freeze(subagentEntries.map((entry) => entry.receipt));
  if (subagents.some((child) => child.denomination !== denomination)) {
    fail("subagent_denomination");
  }
  if (denomination !== "none" && subagents.some((child) =>
    child.max === undefined || child.max > released!)) {
    fail("subagent_wallet");
  }
  const tranches = normalizeArray(source["tranches"], "tranches", normalizeTranche);
  if (denomination === "none" && tranches.length !== 0) fail("tranches");
  if (denomination === "tokens" && tranches.some((entry) => !Number.isSafeInteger(entry.amount))) {
    fail("tranches");
  }
  for (let index = 1; index < tranches.length; index++) {
    if (tranches[index]!.atCall < tranches[index - 1]!.atCall) fail("tranches");
  }
  const releasedByTranches = tranches.reduce(
    (sum, tranche) => denomination === "tokens"
      ? checkedIntegerSum(sum, tranche.amount, "tranches")
      : checkedNumberSum(sum, tranche.amount, "tranches"),
    0,
  );
  if (released !== undefined && released <= releasedByTranches) {
    fail("tranches");
  }
  const breakers = normalizeArray(source["breakers"], "breakers", normalizeBreaker);
  const compactions = normalizeCompactions(source["compactions"], calls.length);
  const resume = source["resume"] === undefined
    ? undefined
    : normalizeResume(source["resume"], denomination);
  if (resume?.priorSettled !== undefined && spent !== undefined &&
      resume.priorSettled > spent) {
    fail("resume_prior_settled");
  }
  if (denomination !== "none" && resume !== undefined) {
    const priorTotal = denomination === "tokens"
      ? resume.priorTokens
      : resume.priorEstimatedUsd;
    if (spendLessThan(resume.priorSettled!, priorTotal, denomination) ||
        (!resume.priorUnpriced &&
          !spendEqual(resume.priorSettled!, priorTotal, denomination))) {
      fail("resume_prior_settled");
    }
  }

  const retryEvidence = breakers.filter((event) => event.kind === "retry_attempted");
  const paidCompactions = compactions.filter((event) => event.meteredCost > 0);
  if (denomination === "none" && (retryEvidence.length > 0 || paidCompactions.length > 0)) {
    fail("measured_spend_budget");
  }
  if (denomination === "tokens" &&
      (retryEvidence.some((event) =>
        !Number.isSafeInteger(event.reservedSpend) || !Number.isSafeInteger(event.measuredSpend)) ||
        paidCompactions.some((event) => !Number.isSafeInteger(event.meteredCost)))) {
    fail("measured_spend");
  }
  if (denomination !== "none" && retryEvidence.some((event) =>
    event.reservedSpend === undefined || event.reservedSpend > released!)) {
    fail("measured_spend_budget");
  }
  const callBackedRetries = retryEvidence.filter((event) =>
    event.spendBasis !== "pre_stream_no_usage");
  if (callBackedRetries.length + paidCompactions.length > calls.length) {
    fail("measured_spend_calls");
  }

  if (denomination !== "none") {
    let evidencedSpend = resume?.priorSettled ?? 0;
    for (const call of calls) {
      const amount = denomination === "tokens"
        ? call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheWriteTokens
        : call.estimatedUsd;
      evidencedSpend = denomination === "tokens"
        ? checkedIntegerSum(evidencedSpend, amount, "spent")
        : checkedNumberSum(evidencedSpend, amount, "spent");
    }
    for (const child of subagents) {
      if (child.spent === undefined) fail("subagent_spent");
      evidencedSpend = denomination === "tokens"
        ? checkedIntegerSum(evidencedSpend, child.spent, "spent")
        : checkedNumberSum(evidencedSpend, child.spent, "spent");
    }
    const hasUnavailableOwnUsage = calls.some((call) => call.usageBasis === "unavailable");
    if (spendLessThan(spent!, evidencedSpend, denomination) ||
        (!hasUnavailableOwnUsage && !spendEqual(spent!, evidencedSpend, denomination))) {
      fail("spent");
    }
    const opaqueOwnSpend = Math.max(0, spent! - evidencedSpend);
    if (hasUnavailableOwnUsage &&
        spendLessThan(released!, opaqueOwnSpend, denomination)) {
      fail("spent");
    }
    const nestedSpend = subagents.reduce((sum, child) => denomination === "tokens"
      ? checkedIntegerSum(sum, child.spent!, "measured_spend")
      : checkedNumberSum(sum, child.spent!, "measured_spend"), 0);
    const priorSettled = resume?.priorSettled ?? 0;
    const currentAttemptSpend = spent! - nestedSpend - priorSettled;
    if (currentAttemptSpend < -moneyTolerance(spent!, nestedSpend + priorSettled)) {
      fail("measured_spend");
    }
    const measuredEvidence = [...retryEvidence, ...paidCompactions].reduce(
      (sum, event) => {
        const amount = "kind" in event
          ? event.measuredSpend ?? 0
          : event.meteredCost;
        return denomination === "tokens"
          ? checkedIntegerSum(sum, amount, "measured_spend")
          : checkedNumberSum(sum, amount, "measured_spend");
      },
      0,
    );
    if (spendLessThan(Math.max(0, currentAttemptSpend), measuredEvidence, denomination)) {
      fail("measured_spend");
    }
  }

  const ownTokens = calls.reduce((sum, call) => checkedIntegerSum(sum,
    call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheWriteTokens,
    "total_tokens"), 0);
  const nestedTokens = subagentEntries.reduce(
    (sum, entry) => checkedIntegerSum(sum, entry.totals.tokens, "total_tokens"),
    0,
  );
  const expectedTokens = checkedIntegerSum(
    checkedIntegerSum(ownTokens, nestedTokens, "total_tokens"),
    resume?.priorTokens ?? 0,
    "total_tokens",
  );
  if (source["totalTokens"] !== expectedTokens) fail("total_tokens");

  const ownUsd = calls.reduce((sum, call) => checkedNumberSum(
    sum, call.estimatedUsd, "total_estimated_usd",
  ), 0);
  const nestedUsd = subagentEntries.reduce((sum, entry) => checkedNumberSum(
    sum, entry.totals.estimatedUsd, "total_estimated_usd",
  ), 0);
  const expectedUsd = roundUsd(checkedNumberSum(
    checkedNumberSum(ownUsd, nestedUsd, "total_estimated_usd"),
    resume?.priorEstimatedUsd ?? 0,
    "total_estimated_usd",
  ));
  if (source["totalEstimatedUsd"] !== expectedUsd) fail("total_estimated_usd");

  const expectedUnpriced = calls.some((call) => call.unpriced) ||
    subagentEntries.some((entry) => entry.totals.unpriced) ||
    (resume?.priorUnpriced ?? false);
  if (source["unpriced"] !== expectedUnpriced) fail("unpriced");

  const ownBreached = denomination !== "none" && spent! > max!;
  const expectedBreached = ownBreached || subagents.some((child) => child.capBreached);
  if (source["capBreached"] !== expectedBreached) fail("cap_breached");
  const expectedOverspent = denomination === "none" || !ownBreached
    ? 0
    : denomination === "usd"
      ? roundUsd(spent! - max!)
      : spent! - max!;
  if (source["overspent"] !== expectedOverspent) fail("overspent");

  const receipt = Object.freeze({
    schema: AGENT_RUN_RECEIPT_SCHEMA,
    runId,
    agentId: source["agentId"] as string,
    basis: "estimated_list_price_subtotal" as const,
    claimBasis: "inferred" as const,
    stopReason: source["stopReason"] as RunStopReason,
    denomination,
    ...(max === undefined ? {} : { max, released: released!, spent: spent! }),
    capBreached: source["capBreached"] as boolean,
    overspent: source["overspent"] as number,
    totalEstimatedUsd: source["totalEstimatedUsd"] as number,
    totalTokens: source["totalTokens"] as number,
    unpriced: source["unpriced"] as boolean,
    calls,
    tools,
    subagents,
    tranches,
    breakers,
    compactions,
    ...(resume === undefined ? {} : { resume }),
  }) as RunReceipt;
  return {
    receipt,
    totals: {
      tokens: receipt.totalTokens,
      estimatedUsd: receipt.totalEstimatedUsd,
      unpriced: receipt.unpriced,
    },
  };
}

function normalizeCall(value: unknown): ReceiptCall {
  const source = record(value, CALL_KEYS, CALL_REQUIRED_KEYS, "call");
  requireText(source["provider"], "call_provider");
  requireText(source["model"], "call_model");
  for (const key of [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "reasoningTokens",
  ]) {
    requireNonNegativeInteger(source[key], `call_${key}`);
  }
  requireNonNegativeNumber(source["estimatedUsd"], "call_estimated_usd");
  requireBoolean(source["unpriced"], "call_unpriced");
  requireOneOf(source["usageBasis"], USAGE_BASES, "call_usage_basis");
  const clampedOutputTokens = optionalNonNegativeInteger(
    source["clampedOutputTokens"], "call_clamped_output_tokens",
  );
  if ((source["reasoningTokens"] as number) > (source["outputTokens"] as number)) {
    fail("call_reasoning_tokens");
  }
  if (source["unpriced"] === true && source["estimatedUsd"] !== 0) {
    fail("call_estimated_usd");
  }
  if (source["usageBasis"] === "unavailable" &&
      (source["unpriced"] !== true || source["estimatedUsd"] !== 0 ||
        ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
          "reasoningTokens"].some((key) => source[key] !== 0))) {
    fail("call_usage_basis");
  }
  return Object.freeze({
    provider: source["provider"] as string,
    model: source["model"] as string,
    inputTokens: source["inputTokens"] as number,
    outputTokens: source["outputTokens"] as number,
    cacheReadTokens: source["cacheReadTokens"] as number,
    cacheWriteTokens: source["cacheWriteTokens"] as number,
    reasoningTokens: source["reasoningTokens"] as number,
    estimatedUsd: source["estimatedUsd"] as number,
    unpriced: source["unpriced"] as boolean,
    usageBasis: source["usageBasis"] as ReceiptCall["usageBasis"],
    ...(clampedOutputTokens === undefined ? {} : { clampedOutputTokens }),
  }) as ReceiptCall;
}

function normalizeTools(value: unknown): readonly ReceiptTool[] {
  const seen = new Set<string>();
  return normalizeArray(value, "tools", (entry) => {
    const source = record(entry, TOOL_ALLOWED_KEYS, TOOL_KEYS, "tool");
    requireText(source["name"], "tool_name");
    requireNonNegativeInteger(source["calls"], "tool_calls");
    requireNonNegativeInteger(source["errors"], "tool_errors");
    if (source["denied"] !== undefined) requireNonNegativeInteger(source["denied"], "tool_denied");
    const denied = (source["denied"] as number | undefined) ?? 0;
    if ((source["errors"] as number) > (source["calls"] as number) ||
        denied > (source["errors"] as number) ||
        seen.has(source["name"] as string)) {
      fail("tool_counts");
    }
    seen.add(source["name"] as string);
    return Object.freeze({
      name: source["name"] as string,
      calls: source["calls"] as number,
      errors: source["errors"] as number,
      ...(denied === 0 ? {} : { denied }),
    });
  });
}

function normalizeTranche(value: unknown): BudgetTranche {
  const source = record(value, TRANCHE_KEYS, TRANCHE_KEYS, "tranche");
  requirePositiveNumber(source["amount"], "tranche_amount");
  requireText(source["reason"], "tranche_reason");
  if ((source["reason"] as string).trim() === "") fail("tranche_reason");
  requireNonNegativeInteger(source["atCall"], "tranche_at_call");
  return Object.freeze({
    amount: source["amount"] as number,
    reason: source["reason"] as string,
    atCall: source["atCall"] as number,
  });
}

function normalizeBreaker(value: unknown): BreakerEvent {
  const source = record(value, BREAKER_KEYS, ["kind", "count"], "breaker");
  requireOneOf(source["kind"], BREAKER_KINDS, "breaker_kind");
  requireNonNegativeInteger(source["count"], "breaker_count");
  if (source["tool"] !== undefined) requireText(source["tool"], "breaker_tool");
  if (source["signature"] !== undefined) {
    requireText(source["signature"], "breaker_signature", SHA256);
  }
  const reservedSpend = optionalNonNegativeNumber(source["reservedSpend"], "breaker_reserved_spend");
  const measuredSpend = optionalNonNegativeNumber(source["measuredSpend"], "breaker_measured_spend");
  if (source["spendBasis"] !== undefined) {
    requireOneOf(source["spendBasis"], SPEND_BASES, "breaker_spend_basis");
  }
  if ((source["count"] as number) === 0) fail("breaker_count");
  switch (source["kind"] as BreakerEvent["kind"]) {
    case "loop_detected":
      if (source["tool"] === undefined || source["signature"] === undefined ||
          hasSpendEvidence(reservedSpend, measuredSpend, source["spendBasis"])) {
        fail("breaker_shape");
      }
      break;
    case "no_progress":
      if (source["tool"] !== undefined || source["signature"] === undefined ||
          hasSpendEvidence(reservedSpend, measuredSpend, source["spendBasis"])) {
        fail("breaker_shape");
      }
      break;
    case "fan_out_blocked":
      if (source["tool"] === undefined || source["signature"] !== undefined ||
          hasSpendEvidence(reservedSpend, measuredSpend, source["spendBasis"])) {
        fail("breaker_shape");
      }
      break;
    case "retry_attempted":
      if (source["tool"] !== undefined || source["signature"] !== undefined ||
          reservedSpend === undefined || reservedSpend <= 0 || measuredSpend === undefined ||
          source["spendBasis"] === undefined ||
          (source["spendBasis"] === "pre_stream_no_usage" && measuredSpend !== 0) ||
          (source["spendBasis"] === "unavailable_worst_case" &&
            measuredSpend !== reservedSpend)) {
        fail("breaker_retry_evidence");
      }
      break;
    case "retry_exhausted":
      if (source["tool"] !== undefined || source["signature"] !== undefined ||
          hasSpendEvidence(reservedSpend, measuredSpend, source["spendBasis"])) {
        fail("breaker_shape");
      }
      break;
  }
  return Object.freeze({
    kind: source["kind"] as BreakerEvent["kind"],
    ...(source["tool"] === undefined ? {} : { tool: source["tool"] as string }),
    count: source["count"] as number,
    ...(source["signature"] === undefined
      ? {}
      : { signature: source["signature"] as string }),
    ...(reservedSpend === undefined ? {} : { reservedSpend }),
    ...(measuredSpend === undefined ? {} : { measuredSpend }),
    ...(source["spendBasis"] === undefined
      ? {}
      : { spendBasis: source["spendBasis"] as NonNullable<BreakerEvent["spendBasis"]> }),
  }) as BreakerEvent;
}

function normalizeCompactions(
  value: unknown,
  totalCalls: number,
): readonly ReceiptCompaction[] {
  const values = array(value, "compactions");
  let previousWorkingCalls = totalCalls;
  return Object.freeze(values.map((entry, expectedIndex) => {
    const source = record(
      entry, COMPACTION_KEYS, COMPACTION_REQUIRED_KEYS, "compaction",
    );
    requireNonNegativeInteger(source["index"], "compaction_index");
    if (source["index"] !== expectedIndex) fail("compaction_index");
    requireOneOf(source["tier"], ["evicted", "summarized", "new-context"], "compaction_tier");
    requireNonNegativeInteger(source["preTokens"], "compaction_pre_tokens");
    requireNonNegativeInteger(source["postTokens"], "compaction_post_tokens");
    const pinnedSegmentIds = normalizeStringArray(
      source["pinnedSegmentIds"], "compaction_pinned_segment_ids",
    );
    const elidedSegmentDigests = normalizeStringArray(
      source["elidedSegmentDigests"], "compaction_elided_segment_digests", SHA256,
    );
    const summarySchemaVersion = optionalPositiveInteger(
      source["summarySchemaVersion"], "compaction_summary_schema_version",
    );
    if ((source["postTokens"] as number) >= (source["preTokens"] as number) ||
        ((source["tier"] === "summarized") !== (summarySchemaVersion !== undefined))) {
      fail("compaction_shape");
    }
    requireOneOf(source["cacheState"], ["warm", "cold", "unknown"], "compaction_cache_state");
    requireNonNegativeNumber(source["meteredCost"], "compaction_metered_cost");
    if (source["meteredBasis"] !== "measured") fail("compaction_metered_basis");
    requireFiniteNumber(source["modeledNetTokens"], "compaction_modeled_net_tokens");
    if (source["modeledBasis"] !== "modeled") fail("compaction_modeled_basis");
    requireNonNegativeInteger(source["workingCallsAfter"], "compaction_working_calls_after");
    const workingCallsAfter = source["workingCallsAfter"] as number;
    if (workingCallsAfter > totalCalls || workingCallsAfter > previousWorkingCalls) {
      fail("compaction_working_calls_after");
    }
    previousWorkingCalls = workingCallsAfter;
    const expectedModeledNetTokens =
      ((source["preTokens"] as number) - (source["postTokens"] as number)) * workingCallsAfter -
      (workingCallsAfter > 0 ? source["postTokens"] as number : 0);
    if (!Number.isSafeInteger(expectedModeledNetTokens) ||
        source["modeledNetTokens"] !== expectedModeledNetTokens) {
      fail("compaction_modeled_net_tokens");
    }
    return Object.freeze({
      index: source["index"] as number,
      tier: source["tier"] as ReceiptCompaction["tier"],
      preTokens: source["preTokens"] as number,
      postTokens: source["postTokens"] as number,
      pinnedSegmentIds,
      elidedSegmentDigests,
      ...(summarySchemaVersion === undefined ? {} : { summarySchemaVersion }),
      cacheState: source["cacheState"] as ReceiptCompaction["cacheState"],
      meteredCost: source["meteredCost"] as number,
      meteredBasis: "measured" as const,
      modeledNetTokens: source["modeledNetTokens"] as number,
      modeledBasis: "modeled" as const,
      workingCallsAfter,
    }) as ReceiptCompaction;
  }));
}

function normalizeResume(value: unknown, denomination: BudgetDenomination | "none"): ReceiptResume {
  const source = record(value, RESUME_KEYS, RESUME_REQUIRED_KEYS, "resume");
  requirePositiveInteger(source["attempts"], "resume_attempts");
  if ((source["attempts"] as number) < 2) fail("resume_attempts");
  requireNonNegativeInteger(source["priorCalls"], "resume_prior_calls");
  requireNonNegativeNumber(source["priorEstimatedUsd"], "resume_prior_estimated_usd");
  requireNonNegativeInteger(source["priorTokens"], "resume_prior_tokens");
  requireBoolean(source["priorUnpriced"], "resume_prior_unpriced");
  const priorSettled = optionalNonNegativeNumber(source["priorSettled"], "resume_prior_settled");
  if ((denomination === "none") !== (priorSettled === undefined)) fail("resume_prior_settled");
  if (denomination === "tokens" && priorSettled !== undefined && !Number.isSafeInteger(priorSettled)) {
    fail("resume_prior_settled");
  }
  requireNonNegativeInteger(
    source["possibleDoubleCountCalls"], "resume_possible_double_count_calls",
  );
  requireBoolean(source["discardedPartialTurn"], "resume_discarded_partial_turn");
  if (source["priorCalls"] === 0 &&
      (source["priorEstimatedUsd"] !== 0 || source["priorTokens"] !== 0 ||
        source["priorUnpriced"] !== false || (priorSettled !== undefined && priorSettled !== 0))) {
    fail("resume_zero_calls");
  }
  return Object.freeze({
    attempts: source["attempts"] as number,
    priorCalls: source["priorCalls"] as number,
    priorEstimatedUsd: source["priorEstimatedUsd"] as number,
    priorTokens: source["priorTokens"] as number,
    priorUnpriced: source["priorUnpriced"] as boolean,
    ...(priorSettled === undefined ? {} : { priorSettled }),
    possibleDoubleCountCalls: source["possibleDoubleCountCalls"] as number,
    discardedPartialTurn: source["discardedPartialTurn"] as boolean,
  }) as ReceiptResume;
}

function snapshotBoundedValue(
  value: unknown,
  bounds: SnapshotBounds,
  depth: number,
): unknown {
  if (depth > MAX_SNAPSHOT_DEPTH || ++bounds.nodes > MAX_SNAPSHOT_NODES) {
    fail("bounds");
  }
  if (value === null || typeof value === "boolean" || value === undefined) return value;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    accountStringBytes(bytes, bounds);
    return value;
  }
  if (typeof value === "number") {
    requireFiniteNumber(value, "number");
    return value;
  }
  if (typeof value !== "object") fail("data");
  if (bounds.active.has(value)) fail("cycle");
  bounds.active.add(value);
  try {
    let isArray: boolean;
    try {
      isArray = Array.isArray(value);
    } catch {
      return fail("object");
    }
    if (isArray) {
      const values = snapshotDenseArray(value, MAX_ARRAY_LENGTH, () => fail("array"));
      const output: unknown[] = [];
      for (const item of values) output.push(snapshotBoundedValue(item, bounds, depth + 1));
      return output;
    }
    const source = snapshotDataDictionary(value, MAX_OBJECT_KEYS, () => fail("object"));
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      accountStringBytes(Buffer.byteLength(key, "utf8"), bounds);
      output[key] = snapshotBoundedValue(source[key], bounds, depth + 1);
    }
    return output;
  } finally {
    bounds.active.delete(value);
  }
}

function record(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
): Readonly<Record<string, unknown>> {
  return snapshotDataRecord(value, allowed, required, () => fail(field));
}

function array(value: unknown, field: string): readonly unknown[] {
  return snapshotDenseArray(value, MAX_ARRAY_LENGTH, () => fail(field));
}

function normalizeArray<T>(
  value: unknown,
  field: string,
  normalize: (entry: unknown) => T,
): readonly T[] {
  return Object.freeze(array(value, field).map(normalize));
}

function normalizeStringArray(
  value: unknown,
  field: string,
  pattern?: RegExp,
): readonly string[] {
  return Object.freeze(array(value, field).map((entry) => {
    requireText(entry, field, pattern);
    return entry;
  }));
}

function requireText(
  value: unknown,
  field: string,
  pattern?: RegExp,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0 ||
      (pattern !== undefined && !pattern.test(value))) {
    fail(field);
  }
}

function requireBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") fail(field);
}

function requireOneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  field: string,
): asserts value is T {
  if (typeof value !== "string" || !choices.includes(value as T)) fail(field);
}

function requireFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) fail(field);
}

function requireNonNegativeNumber(value: unknown, field: string): asserts value is number {
  requireFiniteNumber(value, field);
  if (value < 0) fail(field);
}

function requirePositiveNumber(value: unknown, field: string): asserts value is number {
  requireFiniteNumber(value, field);
  if (value <= 0) fail(field);
}

function requireNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0)) fail(field);
}

function requirePositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(field);
}

function optionalNonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  requireNonNegativeNumber(value, field);
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  requireNonNegativeInteger(value, field);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  requirePositiveInteger(value, field);
  return value;
}

function hasSpendEvidence(
  reservedSpend: number | undefined,
  measuredSpend: number | undefined,
  spendBasis: unknown,
): boolean {
  return reservedSpend !== undefined || measuredSpend !== undefined || spendBasis !== undefined;
}

function checkedIntegerSum(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) fail(field);
  return sum;
}

function checkedNumberSum(left: number, right: number, field: string): number {
  const sum = left + right;
  if (!Number.isFinite(sum) || sum < 0) fail(field);
  return sum;
}

function spendLessThan(
  actual: number,
  expectedMinimum: number,
  denomination: BudgetDenomination | "none",
): boolean {
  if (denomination === "tokens") return actual < expectedMinimum;
  return actual + moneyTolerance(actual, expectedMinimum) < expectedMinimum;
}

function spendEqual(
  actual: number,
  expected: number,
  denomination: BudgetDenomination | "none",
): boolean {
  if (denomination === "tokens") return actual === expected;
  return Math.abs(actual - expected) <= moneyTolerance(actual, expected);
}

function moneyTolerance(left: number, right: number): number {
  return Math.max(1e-10, Number.EPSILON * Math.max(Math.abs(left), Math.abs(right)) * 8);
}

function accountStringBytes(bytes: number, bounds: SnapshotBounds): void {
  if (bytes > MAX_STRING_BYTES) fail("string_bytes");
  bounds.stringBytes += bytes;
  if (bounds.stringBytes > MAX_RECEIPT_BYTES) fail("bytes");
}

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e10) / 1e10;
}

function fail(field: string): never {
  throw new Error(`cave_run_receipt_invalid:${field}`);
}
