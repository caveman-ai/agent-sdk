/**
 * Honest harness economics for matched coding evaluations: all attempt spend
 * over externally verified completions, failing closed on missing evidence.
 */
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
