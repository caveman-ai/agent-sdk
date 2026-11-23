#!/usr/bin/env node
/**
 * caveman-eval — local-first & CI runner for *.eval.{ts,mts,mjs,js} files.
 *
 * Usage:
 *   npx caveman-eval ./evals/support.eval.ts
 *   npx caveman-eval ./evals/support.eval.mjs --fail-under 0.85
 */
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const files = [];
let failUnder;
let noColor = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--fail-under") {
    failUnder = Number(args[++i]);
  } else if (a === "--no-color") {
    noColor = true;
  } else if (!a.startsWith("--")) {
    files.push(a);
  }
}

if (files.length === 0) {
  console.error("Usage: caveman-eval <file.eval.{ts,mjs,js}...> [--fail-under 0.85]");
  process.exit(2);
}

const c = {
  reset: noColor ? "" : "\x1b[0m",
  bold: noColor ? "" : "\x1b[1m",
  dim: noColor ? "" : "\x1b[2m",
  green: noColor ? "" : "\x1b[32m",
  red: noColor ? "" : "\x1b[31m",
  cyan: noColor ? "" : "\x1b[36m",
};

function readLastRunCache(cachePath = ".caveman/last-run.json") {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function formatDelta(cur, prev) {
  if (prev === undefined || prev === null) return `${c.dim}   —   ${c.reset}`;
  const diff = (cur - prev) * 100;
  if (Math.abs(diff) < 0.05) return `${c.dim}  0.0% ${c.reset}`;
  const sign = diff > 0 ? "+" : "";
  const color = diff > 0 ? c.green : c.red;
  return `${color}${(sign + diff.toFixed(1) + "%").padStart(7)}${c.reset}`;
}

async function loadEvalModule(file) {
  const abs = resolve(file);
  try {
    return await import(pathToFileURL(abs).href);
  } catch (err) {
    const ext = extname(abs);
    if ((ext === ".ts" || ext === ".mts") && err && err.code === "ERR_UNKNOWN_FILE_EXTENSION") {
      throw new Error(
        `Cannot import TypeScript file ${file} directly on Node ${process.versions.node}. Upgrade to Node 22.6+ or run via: npx tsx node_modules/.bin/caveman-eval ${file}`,
      );
    }
    throw err;
  }
}

let allPassed = true;
for (const file of files) {
  const prevCache = readLastRunCache();
  const mod = await loadEvalModule(file);
  const res = typeof mod.default === "function" ? await mod.default() : await mod.default;
  if (res && res.summary && res.summary.scores) {
    const prevScores = prevCache && prevCache.name === res.experimentName ? prevCache.summary?.scores ?? {} : {};
    console.log(`\n${c.bold}${res.experimentName}${c.reset} ${c.dim}(${res.summary.total_trials} trials)${c.reset}`);
    console.log(`${c.dim}${"Scorer".padEnd(24)} ${"Mean".padStart(7)} ${"Delta".padStart(7)} ${"pass@k".padStart(8)} ${"pass^k".padStart(8)}${c.reset}`);
    console.log(`${c.dim}${"─".repeat(58)}${c.reset}`);
    for (const [name, s] of Object.entries(res.summary.scores)) {
      const meanStr = `${(s.mean * 100).toFixed(1)}%`.padStart(7);
      const deltaStr = formatDelta(s.mean, prevScores[name]?.mean);
      const passAtK = `${(s.pass_at_k * 100).toFixed(1)}%`.padStart(8);
      const passPowK = `${(s.pass_pow_k * 100).toFixed(1)}%`.padStart(8);
      console.log(`${name.padEnd(24)} ${c.bold}${meanStr}${c.reset} ${deltaStr} ${passAtK} ${passPowK}`);
      if (Number.isFinite(failUnder) && s.mean < failUnder) allPassed = false;
    }
    if (res.consoleUrl) console.log(`\n  ${c.cyan}Diff -> ${res.consoleUrl}${c.reset}`);
    if (res.passedCI === false) allPassed = false;
  }
}

process.exit(allPassed ? 0 : 1);
