#!/usr/bin/env node
/**
 * CI test entry point. Splits the root `pnpm test` work into independent
 * pieces so CI can run them as parallel jobs, without dropping anything:
 *
 *   node scripts/ci-test.mjs harness --shard <i>/<n>
 *     Bundles the harness, then runs shard i of n of packages/harness/tests/*.test.ts.
 *     Every call recomputes all n shards from the live file list and fails
 *     unless they are disjoint and their union is exactly that list.
 *
 *   node scripts/ci-test.mjs packages
 *     Runs every other suite the root `test` script runs (all workspace
 *     packages it filters, except the harness, plus the examples).
 *
 *   node scripts/ci-test.mjs verify
 *     Only checks the coverage guards (shards and the suite list).
 *
 * The suite guard reads the root package.json `test` script (and
 * scripts/run-tests.mjs when present) and fails if it names a package this
 * file does not run, so a suite added there cannot silently skip CI.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HARNESS = join(ROOT, "packages/harness");
const HARNESS_PKG = "@caveman-ai/harness";
// Root `test` suites other than the harness, run by the `packages` job.
const PACKAGES = ["@caveman-ai/protocol", "@caveman-ai/agent", "@caveman-ai/evals", "@caveman-ai/react"];

function fail(message) {
  process.stderr.write(`ci-test: ${message}\n`);
  process.exit(1);
}

function run(cmd, args, cwd = ROOT) {
  process.stdout.write(`$ ${cmd} ${args.join(" ")}\n`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.error) fail(String(result.error));
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function harnessFiles() {
  const files = readdirSync(join(HARNESS, "tests"))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => `tests/${name}`);
  if (files.length === 0) fail("no harness test files found");
  return files;
}

// Round-robin over the sorted list: deterministic, and spreads the long
// suites instead of clustering them by name.
function shard(files, index, total) {
  return files.filter((_, i) => i % total === index - 1);
}

function verifyShards(files, total) {
  const seen = new Map();
  for (let i = 1; i <= total; i += 1) {
    for (const file of shard(files, i, total)) {
      if (seen.has(file)) fail(`${file} is in shards ${seen.get(file)} and ${i}`);
      seen.set(file, i);
    }
  }
  const missing = files.filter((file) => !seen.has(file));
  if (missing.length > 0 || seen.size !== files.length) fail(`shards drop ${missing.join(", ") || "files"}`);
}

function verifySuites() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  let source = String(pkg.scripts?.test ?? "");
  const runner = join(ROOT, "scripts/run-tests.mjs");
  if (existsSync(runner)) source += `\n${readFileSync(runner, "utf8")}`;
  const named = new Set(source.match(/@caveman-ai\/[a-z0-9-]+/gu) ?? []);
  if (named.size === 0) fail("the root test script names no packages; update scripts/ci-test.mjs");
  const covered = new Set([HARNESS_PKG, ...PACKAGES]);
  const uncovered = [...named].filter((name) => !covered.has(name));
  if (uncovered.length > 0) fail(`root test runs ${uncovered.join(", ")} but CI does not; add it to PACKAGES`);
  if (!/test:examples|examples\//u.test(source)) fail("root test no longer runs the examples; update scripts/ci-test.mjs");
}

function parseShard(argv) {
  const flag = argv.indexOf("--shard");
  const value = flag === -1 ? undefined : argv[flag + 1];
  const match = /^(\d+)\/(\d+)$/u.exec(value ?? "");
  if (!match) fail("usage: ci-test.mjs harness --shard <i>/<n>");
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total) fail(`bad shard ${value}`);
  return { index, total };
}

const [mode, ...rest] = process.argv.slice(2);
verifySuites();

if (mode === "harness") {
  const { index, total } = parseShard(rest);
  const files = harnessFiles();
  verifyShards(files, total);
  const mine = shard(files, index, total);
  process.stdout.write(`harness shard ${index}/${total}: ${mine.length} of ${files.length} files\n${mine.join("\n")}\n`);
  if (mine.length === 0) process.exit(0);
  run(process.execPath, ["scripts/bundle.mjs"], HARNESS);
  run(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", ...mine], HARNESS);
} else if (mode === "packages") {
  for (const name of PACKAGES) run("pnpm", ["--filter", name, "test"]);
  run("pnpm", ["test:examples"]);
} else if (mode === "verify") {
  const files = harnessFiles();
  for (let total = 1; total <= 8; total += 1) verifyShards(files, total);
  process.stdout.write(`ok: ${files.length} harness files, suites ${[HARNESS_PKG, ...PACKAGES].join(", ")}, examples\n`);
} else {
  fail("usage: ci-test.mjs harness --shard <i>/<n> | packages | verify");
}
