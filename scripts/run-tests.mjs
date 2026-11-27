#!/usr/bin/env node
/**
 * Runs all workspace test suites in parallel and reports each suite's timing.
 * Keeps output readable by printing buffered output per suite and exiting
 * non-zero if any suite fails.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function newestMtime(target) {
  let latest = 0;
  const info = statSync(target);
  if (!info.isDirectory()) return info.mtimeMs;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const mtime = newestMtime(join(target, entry.name));
    if (mtime > latest) latest = mtime;
  }
  return latest;
}

function evalsDistIsFresh() {
  const pkg = join(ROOT, "packages", "evals");
  const outputs = [join(pkg, "dist", "index.js"), join(pkg, "dist", "sdk.js")];
  if (!outputs.every((file) => existsSync(file))) return false;
  const testsDir = join(pkg, "tests");
  if (readdirSync(testsDir).some((name) => name.endsWith(".ts"))) return false;
  const oldestOut = Math.min(...outputs.map((file) => statSync(file).mtimeMs));
  const newestIn = Math.max(
    newestMtime(join(pkg, "src")),
    newestMtime(join(pkg, "tsconfig.json")),
    newestMtime(join(pkg, "tsconfig.test.json")),
  );
  return oldestOut >= newestIn;
}

const SUITES = [
  { name: "@caveman-ai/protocol", cmd: pnpm, args: ["--filter", "@caveman-ai/protocol", "test"] },
  { name: "@caveman-ai/harness", cmd: pnpm, args: ["--filter", "@caveman-ai/harness", "test"] },
  { name: "@caveman-ai/agent", cmd: pnpm, args: ["--filter", "@caveman-ai/agent", "test"] },
  { name: "@caveman-ai/evals", cmd: pnpm, args: ["--filter", "@caveman-ai/evals", evalsDistIsFresh() ? "test:runtime" : "test"] },
  { name: "@caveman-ai/react", cmd: pnpm, args: ["--filter", "@caveman-ai/react", "test"] },
  { name: "examples:basics", cmd: process.execPath, args: ["--experimental-strip-types", "--no-warnings", "--test", "examples/basics/tests/*.test.ts"] },
];

function runSuite(suite) {
  const started = performance.now();
  return new Promise((done) => {
    const child = spawn(suite.cmd, suite.args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code, signal) => {
      const ms = Math.round(performance.now() - started);
      done({ ...suite, code: code ?? (signal ? 1 : 0), signal, ms, stdout, stderr });
    });
  });
}

const started = performance.now();
const results = await Promise.all(SUITES.map(runSuite));
const failed = results.filter((r) => r.code !== 0);

for (const r of results) {
  const status = r.code === 0 ? "PASS" : `FAIL (exit=${r.code}${r.signal ? `, signal=${r.signal}` : ""})`;
  process.stdout.write(`[${status}] ${r.name} (${(r.ms / 1000).toFixed(2)}s)\n`);
  if (r.code !== 0) {
    if (r.stdout.trim()) process.stdout.write(`${r.stdout.trimEnd()}\n`);
    if (r.stderr.trim()) process.stderr.write(`${r.stderr.trimEnd()}\n`);
  }
}

const totalS = ((performance.now() - started) / 1000).toFixed(2);
process.stdout.write(`All ${results.length} suites finished in ${totalS}s (${results.length - failed.length} passed, ${failed.length} failed).\n`);
if (failed.length > 0) process.exit(1);
