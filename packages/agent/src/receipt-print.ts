import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { catalogCost } from "./catalog.js";
import type { RunReceipt } from "./budget.js";

/**
 * The end-of-run receipt print (golden artifact F1).
 *
 * `renderReceipt` is a pure function — receipt-shaped JSON in, text out — and
 * its output is snapshot-tested byte-for-byte against `goldens/receipt-*.txt`.
 * Editing a golden is a product decision, not a test fix; if this renderer
 * disagrees with a golden, this renderer is wrong.
 *
 * Honesty rules the goldens encode, restated where the code enforces them:
 * - every cost is a public-catalog list-price subtotal, never an invoice,
 *   and the line says so;
 * - the cold estimate is a counterfactual labelled `inferred`, never
 *   subtracted into any other figure, and computed over the SAME scope as
 *   the cost line (root and subagent calls together) so a subagent's spend
 *   can never masquerade as a cache-write premium — on a RESUMED run the
 *   cost line also covers prior attempts this attempt's calls cannot
 *   reprice, so the cold-estimate line is dropped rather than compared
 *   across scopes;
 * - an unpriced model prints its honest flag instead of $0;
 * - a run with no model calls anywhere prints an honest absence;
 * - a stopped run says it stopped, and a breached cap prints the overage
 *   explicitly — never a negative percent;
 * - every mode is named, and observe-only names its upgrade (F8).
 */

/** One model call, as the print needs it. Structurally satisfied by ReceiptCall. */
export interface ReceiptPrintCall {
  readonly provider: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly unpriced: boolean;
  /** A cache warm is spend, not a turn. */
  readonly purpose?: "cache_warm" | undefined;
}

/** The call tree the print aggregates over. Structurally satisfied by RunReceipt. */
export interface ReceiptCallTree {
  readonly calls: readonly ReceiptPrintCall[];
  readonly subagents?: readonly ReceiptCallTree[] | undefined;
}

/**
 * What the renderer consumes: the run's own `RunReceipt` fields it reads,
 * plus the print-only facts the receipt does not carry (mode, duration, and
 * the path the receipt JSON was written to). Built by spreading a `RunReceipt`
 * and adding the three extras, so the receipt file itself stays exactly the
 * `caveman.agent.run-receipt.v1` contract.
 */
export interface ReceiptLike extends ReceiptCallTree {
  /** Estimated list-price subtotal of the run and everything under it. */
  readonly totalEstimatedUsd: number;
  /** True when any call in the run (or a subagent's) went unpriced. */
  readonly unpriced: boolean;
  readonly stopReason: string;
  readonly denomination: "usd" | "tokens" | "none";
  readonly max?: number | undefined;
  readonly spent?: number | undefined;
  readonly capBreached?: boolean | undefined;
  readonly mode: "optimized" | "observe-only";
  readonly durationMs: number;
  /** Where the full receipt JSON was written, as printed. */
  readonly receiptPath: string;
  /** Present only on resumed durable runs. Structurally satisfied by ReceiptResume. */
  readonly resume?: {
    readonly attempts: number;
    readonly priorCalls: number;
    readonly priorEstimatedUsd: number;
    readonly priorUnpriced: boolean;
    readonly possibleDoubleCountCalls: number;
  } | undefined;
}

const INDENT = "  ";
const LABEL_WIDTH = 15;
const CONTINUATION = INDENT + " ".repeat(LABEL_WIDTH);
const OBSERVE_ONLY_LINE = "observe-only — engine adds compression + recovery";

function row(label: string, value: string): string {
  return `${INDENT}${label.padEnd(LABEL_WIDTH)}${value}`;
}

function integer(value: number): string {
  return value.toLocaleString("en-US");
}

/** "$0.05" for 0.05 — a fixed-notation cap figure with trailing zeros trimmed. */
function usdCap(value: number): string {
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** Root and subagent calls flattened: one scope for every aggregate row. */
function allCalls(
  tree: ReceiptCallTree,
  into: Array<{ call: ReceiptPrintCall; fromSubagent: boolean }> = [],
  fromSubagent = false,
): Array<{ call: ReceiptPrintCall; fromSubagent: boolean }> {
  for (const call of tree.calls) into.push({ call, fromSubagent });
  for (const child of tree.subagents ?? []) allCalls(child, into, true);
  return into;
}

/**
 * The same run repriced as if every input token had been sent fresh at the
 * cold input list price — no cache read, no cache write — over the SAME call
 * scope the cost line covers. A counterfactual, labelled `inferred` on the
 * print. A root call the catalog cannot reprice at a single list rate (a
 * recurring-priced model) reports which model; a subagent call that cannot
 * be repriced drops the line entirely rather than print a cross-scope
 * comparison.
 */
function coldEstimate(
  calls: readonly { call: ReceiptPrintCall; fromSubagent: boolean }[],
):
  | { kind: "usd"; usd: number }
  | { kind: "recurring"; model: string }
  | { kind: "drop" } {
  let total = 0;
  for (const { call, fromSubagent } of calls) {
    // Without a cache there is nothing to keep warm: the counterfactual omits it.
    if (call.purpose === "cache_warm") continue;
    const cost = catalogCost({
      provider: call.provider,
      model: call.model,
      inputTokens: call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: call.reasoningTokens,
    });
    if (!cost.priced) {
      // The run's own calls WERE priced (the unpriced branch renders
      // otherwise), so a repricing failure here means the model has no
      // single time-independent list rate — recurring UTC pricing.
      return fromSubagent
        ? { kind: "drop" }
        : { kind: "recurring", model: call.model };
    }
    total += cost.usd;
  }
  return { kind: "usd", usd: total };
}

export function renderReceipt(receipt: ReceiptLike): string {
  const calls = allCalls(receipt);
  const turns = calls.filter(({ call }) => call.purpose === undefined).length;
  const seconds = (receipt.durationMs / 1000).toFixed(1);
  // A stopped run never claims completion. Fail closed on the wording: any
  // reason other than the natural end renders as a stop, named in plain words.
  const header = receipt.stopReason === "complete"
    ? "run complete"
    : `run stopped — ${receipt.stopReason.replaceAll("_", " ")}`;
  const lines: string[] = [
    `${header} · ${turns} turn${turns === 1 ? "" : "s"} · ${seconds}s`,
    "",
  ];
  const modeLine = receipt.mode === "observe-only" ? OBSERVE_ONLY_LINE : receipt.mode;

  if (turns === 0) {
    // Honest absence: nothing ran anywhere in the tree, so nothing is priced
    // and nothing is estimated — never a row of fabricated zeros.
    lines.push(row("mode", modeLine));
    lines.push(`${INDENT}no model calls were made — nothing to price, nothing to estimate.`);
  } else {
    const byModel = new Map<string, { model: string; calls: number }>();
    for (const { call } of calls) {
      const key = `${call.provider}/${call.model}`;
      const entry = byModel.get(key) ?? { model: call.model, calls: 0 };
      entry.calls += 1;
      byModel.set(key, entry);
    }
    lines.push(row("model", [...byModel.values()]
      .map((entry) => `${entry.model} (${entry.calls} call${entry.calls === 1 ? "" : "s"})`)
      .join(" · ")));
    lines.push(row("mode", modeLine));

    const inputTotal = calls.reduce(
      (total, { call }) => total + call.inputTokens + call.cacheReadTokens + call.cacheWriteTokens,
      0,
    );
    const outputTotal = calls.reduce((total, { call }) => total + call.outputTokens, 0);
    const cacheRead = calls.reduce((total, { call }) => total + call.cacheReadTokens, 0);
    const cacheWrite = calls.reduce((total, { call }) => total + call.cacheWriteTokens, 0);
    // Both figures are the provider's own aggregate, and the line says so.
    // A run that both read and wrote cache shows both — neither hides.
    const cacheFacts = cacheRead > 0 && cacheWrite > 0
      ? `${integer(cacheRead)} read warm · ${integer(cacheWrite)} written to cache`
      : cacheWrite > 0
        ? `${integer(cacheWrite)} written to cache`
        : `${integer(cacheRead)} read warm`;
    lines.push(row("input", `${integer(inputTotal)} tok · ${cacheFacts} (provider-reported)`));
    lines.push(row("output", `${integer(outputTotal)} tok`));

    const unpricedCall = calls.find(({ call }) => call.unpriced);
    if (unpricedCall !== undefined || receipt.unpriced) {
      // The honest flag, never $0: an unknown price is not a zero price.
      const name = unpricedCall?.call.model ?? "a model in this run";
      lines.push(row("cost", `unpriced — ${name} is not in the public catalog,`));
      lines.push(`${CONTINUATION}so no dollar figure is shown rather than a guessed one`);
    } else {
      // A resumed run's cost line covers the whole logical run (prior
      // attempts folded in), but this attempt's calls are the only ones the
      // renderer can reprice — a cold estimate over them would compare
      // mismatched scopes, so the line is dropped (same refusal as an
      // unrepriceable subagent call).
      const cold = receipt.resume !== undefined
        ? { kind: "drop" as const }
        : coldEstimate(calls);
      lines.push(row("cost", `$${receipt.totalEstimatedUsd.toFixed(4)}   list-price subtotal, not an invoice`));
      if (cold.kind === "usd" && cacheWrite > 0 && receipt.totalEstimatedUsd > cold.usd) {
        // The first-run shape: cost above the cold estimate is the cache-write
        // premium, explained in place so the receipt never reads backwards.
        // Printed only when the provider actually reported cache writes.
        lines.push(`${CONTINUATION}above the cold estimate: this run paid the up-front`);
        lines.push(`${CONTINUATION}premium to write your prefix into the provider cache`);
      }
      if (cold.kind === "usd") {
        lines.push(row(
          "cold estimate",
          `$${cold.usd.toFixed(4)}   inferred — same run with no ${
            cacheWrite > 0 && cacheRead > 0
              ? "provider cache"
              : cacheWrite > 0
                ? "cache write"
                : "warm prefix"
          }`,
        ));
      } else if (cold.kind === "recurring") {
        lines.push(row(
          "cold estimate",
          `unavailable — ${cold.model} uses recurring pricing`,
        ));
      }
      // kind "drop": a subagent call could not be repriced — no line at all
      // rather than a comparison over mismatched scopes.
    }

    if (receipt.denomination !== "none" && receipt.max !== undefined &&
        receipt.spent !== undefined) {
      const usd = receipt.denomination === "usd";
      const spentDisplayed = usd ? Number(receipt.spent.toFixed(4)) : receipt.spent;
      const breached = receipt.capBreached === true || spentDisplayed > receipt.max;
      const spentText = usd ? `$${spentDisplayed.toFixed(4)}` : integer(spentDisplayed);
      const maxText = usd ? usdCap(receipt.max) : integer(receipt.max);
      const prefix = usd ? "" : "token cap: ";
      if (breached) {
        // The ledger records the real amount; the print names the overage.
        // A negative "remains" percent would be the flattering disguise.
        const over = usd
          ? `$${(spentDisplayed - receipt.max).toFixed(4)}`
          : integer(spentDisplayed - receipt.max);
        lines.push(row(
          "budget",
          `${prefix}${spentText} spent of ${maxText} cap · over by ${over} (provider-reported after reservation)`,
        ));
      } else {
        const percent = Math.floor(((receipt.max - spentDisplayed) / receipt.max) * 100);
        lines.push(row(
          "budget",
          `${prefix}${spentText} spent of ${maxText} · ${percent}% remains`,
        ));
      }
    }
  }

  if (receipt.resume !== undefined) {
    // A resumed run says so, and says what the crash made unknowable. Prior
    // spend is already inside the totals above — this line attributes it,
    // never adds it again. An unpriced prior attempt prints no dollar figure.
    const prior = receipt.resume.priorUnpriced
      ? `${integer(receipt.resume.priorCalls)} call${receipt.resume.priorCalls === 1 ? "" : "s"} (unpriced)`
      : `${integer(receipt.resume.priorCalls)} call${receipt.resume.priorCalls === 1 ? "" : "s"}, $${receipt.resume.priorEstimatedUsd.toFixed(4)}`;
    lines.push(row(
      "resumed",
      `attempt ${receipt.resume.attempts} · prior attempts: ${prior} — included in the totals above`,
    ));
    if (receipt.resume.possibleDoubleCountCalls > 0) {
      const n = receipt.resume.possibleDoubleCountCalls;
      lines.push(`${CONTINUATION}${n} call${n === 1 ? " was" : "s were"} in flight at a crash — the provider`);
      lines.push(`${CONTINUATION}may have billed ${n === 1 ? "it" : "them"}; that usage is unknown and counted nowhere`);
    }
  }

  lines.push("");
  lines.push(row("full receipt", receipt.receiptPath));
  return `${lines.join("\n")}\n`;
}

/**
 * Write the run's receipt JSON under `rootDir` and render its print.
 *
 * The file at `.caveman/runs/<stamp>/receipt.json` is the unmodified
 * `RunReceipt` — it stays valid against the shared
 * `agent-run-receipt.schema.json` contract. The print-only extras (mode,
 * duration, path) exist only in the rendered text. Two runs landing in the
 * same second get distinct `-2`, `-3`, … directories instead of overwriting.
 */
export async function writeRunReceipt(
  rootDir: string,
  receipt: RunReceipt,
  extras: { mode: "optimized" | "observe-only"; durationMs: number },
): Promise<{ rendered: string; receiptPath: string }> {
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  let receiptPath = `.caveman/runs/${stamp}/receipt.json`;
  for (let attempt = 2; ; attempt++) {
    const directory = dirname(resolve(rootDir, receiptPath));
    try {
      await mkdir(directory, { recursive: false });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Parent .caveman/runs does not exist yet — create the chain once.
        await mkdir(directory, { recursive: true });
        break;
      }
      if (code !== "EEXIST") throw error;
      if (attempt > 99) throw error;
      receiptPath = `.caveman/runs/${stamp}-${attempt}/receipt.json`;
    }
  }
  await writeFile(resolve(rootDir, receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
  const rendered = renderReceipt({
    ...receipt,
    mode: extras.mode,
    durationMs: extras.durationMs,
    receiptPath,
  });
  return { rendered, receiptPath };
}
