import type { RunBreakers, RunBudget, RunOptions } from "@caveman-ai/agent";
import { rootDir } from "./agent.ts";
import { policyFor, type Grant } from "./policy.ts";

/** Hard local cap per investigation at public-catalog list prices; compaction before stop. */
export const budget: RunBudget = { maxUsd: 0.5, onExhausted: "compact" };
/** An investigator re-running the same search is stuck, not thorough. */
export const breakers: RunBreakers = { repeatedToolCalls: 2, noProgressTurns: 4 };

export function runOptions(grant: Grant): RunOptions {
  return {
    rootDir,
    budget,
    breakers,
    deadlineMs: 5 * 60_000,
    maxToolCalls: 24,
    toolPolicy: policyFor(grant),
  };
}
