#!/usr/bin/env node
/**
 * Runs all workspace test suites in parallel and reports each suite's timing.
 * Keeps output readable by printing buffered output per suite and exiting
 * non-zero if any suite fails.
 */
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pnpmInvocation(args) {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/iu.test(basename(execPath)) && /\.(?:[cm]?js)$/iu.test(execPath)) {
    return { cmd: process.execPath, args: [execPath, ...args], shell: false };
  }
  return { cmd: "pnpm", args, shell: process.platform === "win32" };
}

const HARNESS_BUNDLE = {
  name: "@caveman-ai/harness (bundle)",
  cmd: process.execPath,
  args: ["packages/harness/scripts/bundle.mjs", "--if-stale"],
  shell: false,
};

const SUITES = [
  { name: "@caveman-ai/protocol", ...pnpmInvocation(["--filter", "@caveman-ai/protocol", "test"]) },
  { name: "@caveman-ai/harness", ...pnpmInvocation(["--filter", "@caveman-ai/harness", "test"]) },
  { name: "@caveman-ai/agent", ...pnpmInvocation(["--filter", "@caveman-ai/agent", "test"]) },
  { name: "@caveman-ai/evals", ...pnpmInvocation(["--filter", "@caveman-ai/evals", "test"]) },
  { name: "@caveman-ai/react", ...pnpmInvocation(["--filter", "@caveman-ai/react", "test"]) },
  {
    name: "examples:basics",
    cmd: process.execPath,
    args: ["--experimental-strip-types", "--no-warnings", "--test", "examples/basics/tests/*.test.ts"],
    shell: false,
  },
];

function runStep(step) {
  const started = performance.now();
  return new Promise((done) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      const ms = Math.round(performance.now() - started);
      done({ ...step, code, signal, ms, stdout, stderr });
    };
    let child;
    try {
      child = spawn(step.cmd, step.args, {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        shell: step.shell,
      });
    } catch (err) {
      stderr = err instanceof Error ? (err.stack ?? err.message) : String(err);
      finish(1, null);
      return;
    }
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}${err instanceof Error ? (err.stack ?? err.message) : String(err)}`;
      finish(1, null);
    });
    child.on("close", (code, signal) => {
      finish(code ?? (signal ? 1 : 0), signal);
    });
  });
}

function printResult(r) {
  const status = r.code === 0 ? "PASS" : `FAIL (exit=${r.code}${r.signal ? `, signal=${r.signal}` : ""})`;
  process.stdout.write(`[${status}] ${r.name} (${(r.ms / 1000).toFixed(2)}s)\n`);
  if (r.code !== 0) {
    if (r.stdout.trim()) process.stdout.write(`${r.stdout.trimEnd()}\n`);
    if (r.stderr.trim()) process.stderr.write(`${r.stderr.trimEnd()}\n`);
  }
}

const started = performance.now();
// Ensure the harness bundle is up to date before parallel suites import it.
const bundle = await runStep(HARNESS_BUNDLE);
if (bundle.code !== 0) {
  printResult(bundle);
  process.exitCode = 1;
} else {
  const results = await Promise.all(SUITES.map(runStep));
  const failed = results.filter((r) => r.code !== 0);

  for (const r of results) printResult(r);

  const totalS = ((performance.now() - started) / 1000).toFixed(2);
  process.stdout.write(`All ${results.length} suites finished in ${totalS}s (${results.length - failed.length} passed, ${failed.length} failed).\n`);
  if (failed.length > 0) process.exitCode = 1;
}
