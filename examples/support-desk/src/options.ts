import { join } from "node:path";
import {
  createFileMemoryAdapter,
  createMemoryEngine,
  memoryTTLMilliseconds,
  type MemoryEngine,
  type RunBreakers,
  type RunBudget,
  type RunOptions,
} from "@caveman-ai/agent";
import { rootDir, supportDesk } from "./agent.ts";

/** Hard local cap per ticket at public-catalog list prices; compaction before stop. */
export const budget: RunBudget = { maxUsd: 0.05, onExhausted: "compact" };

/** A support bot re-calling the same lookup twice is already stuck. */
export const breakers: RunBreakers = { repeatedToolCalls: 2 };

export const tenant = process.env.SUPPORT_TENANT ?? "northbeam";

/** One engine per process; the runtime reuses it across turns and sessions. */
export const memoryEngine: MemoryEngine = createMemoryEngine({
  scope: { tenant, agentId: supportDesk.id, namespace: "customers" },
  storage: createFileMemoryAdapter({ root: join(rootDir, ".caveman", "memory") }),
  ttlMs: memoryTTLMilliseconds("30d"),
});

export function runOptions(): RunOptions {
  return {
    rootDir,
    budget,
    breakers,
    deadlineMs: 90_000,
    memory: { tenant, engine: memoryEngine },
  };
}

export const usd = (value: number): string => `$${value.toFixed(4)}`;
export const tok = (value: number): string => value.toLocaleString("en-US");
