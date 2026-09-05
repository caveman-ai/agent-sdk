// Runs every ticket in tickets/ through the same agent, then replays one.
//
// What it shows: the static prefix (instructions, skills index, tool schemas)
// is byte-stable across tickets, so after the first ticket writes it into the
// provider cache every later ticket reads it warm, and the receipt says so
// from provider-reported numbers. Then a durable replay returns a journaled
// result without a provider call.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CavemanRunError, run, type ReceiptCall, type RunReceipt } from "@caveman-ai/agent";
import { catalogCacheProfile, catalogCost } from "@caveman-ai/agent/catalog";
import { rootDir, supportDesk } from "./agent.ts";
import { memoryEngine, runOptions, tok, usd } from "./options.ts";

const ticketsDir = join(rootDir, "tickets");
const names = readdirSync(ticketsDir).filter((name) => name.endsWith(".md")).sort();
const batch = Date.now().toString(36);
const runIdFor = (name: string): string => `demo-${batch}-${name.replace(/\.md$/u, "")}`;

interface Row {
  ticket: string;
  calls: number;
  warmRead: number;
  cacheWrite: number;
  cost: number;
  cold: number | undefined;
  tools: string;
}

const allCalls = (receipt: RunReceipt): ReceiptCall[] => [
  ...receipt.calls,
  ...receipt.subagents.flatMap(allCalls),
];

/** Same calls priced with no cache read or write. Inferred, never measured. */
function coldEstimateUsd(receipt: RunReceipt): number | undefined {
  let total = 0;
  for (const call of allCalls(receipt)) {
    const cold = catalogCost({
      provider: call.provider,
      model: call.model,
      inputTokens: call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: call.outputTokens,
      reasoningTokens: call.reasoningTokens,
    });
    if (!cold.priced) return undefined;
    total += cold.usd;
  }
  return total;
}

const rows: Row[] = [];
let provider = "";
let model = "";
for (const name of names) {
  process.stdout.write(`${name.padEnd(22)} `);
  try {
    const result = await run(supportDesk, readFileSync(join(ticketsDir, name), "utf8"), {
      ...runOptions(),
      durable: { runId: runIdFor(name) },
    });
    const calls = allCalls(result.receipt);
    provider = result.provider;
    model = result.model;
    rows.push({
      ticket: name,
      calls: calls.length,
      warmRead: calls.reduce((sum, call) => sum + call.cacheReadTokens, 0),
      cacheWrite: calls.reduce((sum, call) => sum + call.cacheWriteTokens, 0),
      cost: result.receipt.totalEstimatedUsd,
      cold: result.receipt.unpriced ? undefined : coldEstimateUsd(result.receipt),
      tools: [...new Set(result.toolCalls)].join(" "),
    });
    const stopped = result.stopReason === "complete" ? "" : ` (stopped: ${result.stopReason})`;
    console.log(`${usd(result.receipt.totalEstimatedUsd)}${stopped}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const spent = error instanceof CavemanRunError ? ` after ${usd(error.receipt.totalEstimatedUsd)}` : "";
    console.log(`failed${spent}: ${message}`);
  }
}
await memoryEngine.flush();

if (rows.length === 0) process.exit(1);

const header = ["ticket", "calls", "warm read", "cache write", "cost", "cold est.", "tools"];
const widths = [22, 5, 10, 11, 9, 9, 0];
const line = (cells: string[]): string =>
  cells.map((cell, index) => (index < 4 ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!))).join("  ");
const total = rows.reduce(
  (sum, row) => ({
    calls: sum.calls + row.calls,
    warmRead: sum.warmRead + row.warmRead,
    cacheWrite: sum.cacheWrite + row.cacheWrite,
    cost: sum.cost + row.cost,
    cold: sum.cold === undefined || row.cold === undefined ? undefined : sum.cold + row.cold,
  }),
  { calls: 0, warmRead: 0, cacheWrite: 0, cost: 0, cold: 0 as number | undefined },
);
const money = (value: number | undefined): string => (value === undefined ? "unpriced" : usd(value));
console.log(`\n${line(header)}`);
for (const row of rows) {
  console.log(line([
    row.ticket, String(row.calls), tok(row.warmRead), tok(row.cacheWrite),
    money(row.cost), money(row.cold), `  ${row.tools}`,
  ]));
}
console.log(line([
  "total", String(total.calls), tok(total.warmRead), tok(total.cacheWrite),
  money(total.cost), money(total.cold), "",
]));
console.log(`
  ${provider}/${model} · ${rows.length} tickets · one byte-stable prefix
  cost       estimated public-catalog list-price subtotal, not an invoice
  cold est.  inferred — the same calls priced with no cache read or write
  warm read  provider-reported tokens served from the provider's prompt cache`);

if (total.warmRead + total.cacheWrite === 0) {
  const profile = catalogCacheProfile(provider, model);
  console.log(profile === undefined
    ? `\n  no cache activity was reported and the catalog has no cache profile for this model.`
    : `\n  no cache activity was reported. ${model} caches prefixes of ${tok(profile.minPrefixTokens)}+ tokens;` +
      `\n  this agent's prefix may be below that. CAVE_MODEL=anthropic/claude-sonnet-5 caches from 1,024.`);
}

// Durable replay: the same runId returns the journaled outcome. No provider
// call is made, which is why the receipt's calls are the first attempt's.
const first = rows[0]!;
const started = performance.now();
const replay = await run(supportDesk, readFileSync(join(ticketsDir, first.ticket), "utf8"), {
  ...runOptions(),
  durable: { runId: runIdFor(first.ticket) },
});
console.log(`
  replay of ${first.ticket}: journaled result returned in ${Math.round(performance.now() - started)}ms,
  receipt still shows the first attempt's ${allCalls(replay.receipt).length} calls and ${usd(replay.receipt.totalEstimatedUsd)}.
  journals: .caveman/runs/durable/`);
