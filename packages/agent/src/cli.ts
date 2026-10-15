#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { constants, readFileSync, watch } from "node:fs";
import { glob, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { commandHasHelp, parseServeOptions, printHelp } from "./cli-options.js";
import { catalogSearchCeiling, CATALOG_SHA256 } from "./catalog.js";
import { ConnectRuntime } from "./connect.js";
import {
  agentDefinitionSHA256,
  buildPolicySHA256,
  checkLock,
  compileAndWrite,
  contextIRSHA256,
  generateCandidatePlans,
  parseAnyCaveBuildLock,
  type AnyCaveBuildLock,
  type BuildConfig,
  type CaveBuildLockV3,
  type CavePlan,
  type CompileResult,
  type TransformCapability,
} from "./build.js";
import {
  assertProfiledBuildTarget,
  compileProfiledNativePi,
  nativePiCompilerTarget,
  planNativePiCandidates,
  type CompileProfiledResult,
} from "./compiler.js";
import {
  contextIRIsContentBlind,
  loadEvalSandboxProfile,
  runNativePiFixture,
} from "./compile-runner.js";
import {
  contextBill,
  lowerContext,
  sha256,
  stableStringify,
  type ContextIR,
} from "./context-ir.js";
import {
  createCompilerWorkloadProfile,
  parseWorkloadProfile,
  type WorkloadProfile,
} from "./profile.js";
import {
  agentFileSourcePaths,
  loadDevModule,
  type LoadedDevModule,
} from "./dev-loader.js";
import {
  agentDirContextOrigins,
  agentDirRunDefaults,
  conventionEntryPath,
  generateAgentDirEntry,
  hasAgentDirConvention,
  loadAgentDir,
} from "./dir-loader.js";
import {
  findVolatileFrozenSegment,
  frozenPrefixTokens,
  providerPrefixMinimum,
  renderBelowMinimumAdvisory,
  renderStaticPlanFailure,
  withPerturbedClock,
  type StaticPlanFailure,
} from "./cache-planner/static-checks.js";
import { writeRunReceipt } from "./receipt-print.js";
import { createAgentServer } from "./serve.js";
import { HttpDurableStore, type DurableStore } from "./durable.js";
import { lowerAgentContext } from "./execution-kernel.js";
import { createConversation, type AgentDefinition } from "./index.js";
import {
  caveGatewayReady,
  buildEngineEnv,
  buildRuntimeControlEnv,
  resolveGatewayURL,
  runAgentInternal,
  verifySandboxConformance,
  type ConversationState,
} from "./runtime.js";
import type { ContextKind, EvalDefinition } from "./primitives.js";
import { optionalPeerCheck } from "./optional-peers.js";
import { normalizeTrajectory, type NormalizedTrajectory } from "./trajectory-ir.js";
import { projectSourceFiles, sourceGraphSHA256 } from "./source-graph.js";
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_VERSION,
  FRAMEWORK_VERSION,
  PI_ADAPTER_VERSION,
  PI_UPSTREAM_VERSION,
} from "./runtime-identity.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${FRAMEWORK_VERSION}\n`);
    return;
  }
  const optionArgs = args.slice(0, args.indexOf("--") < 0 ? undefined : args.indexOf("--"));
  if (commandHasHelp(command) && optionArgs.some((arg) => arg === "--help" || arg === "-h")) {
    printHelp(command);
    return;
  }
  if (command === "dev") {
    await dev(args);
    return;
  }
  if (command === "build") {
    await build(args);
    return;
  }
  if (command === "check") {
    await check(args);
    return;
  }
  if (command === "doctor") {
    await doctor(args);
    return;
  }
  if (command === "register") {
    await register(args);
    return;
  }
  if (command === "serve") {
    await serve(args);
    return;
  }
  if (command === "connect") {
    process.exitCode = await new ConnectRuntime().delegate(args);
    return;
  }
  throw new Error(`unknown command ${JSON.stringify(command)}; run caveman-agent --help`);
}

type DoctorStatus = "pass" | "warn" | "fail";

type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
};

type DoctorReport = {
  schema_version: 1;
  framework_version: string;
  ready: boolean;
  /** What a run on this machine would do today, with nothing else installed. */
  execution_mode: "optimized" | "observe-only";
  checks: DoctorCheck[];
  /** Present only when the cwd looks like a vercel/eve agent directory (F7). */
  eve_migration?: EveLayout;
  harnesses: Array<{
    id: "pi" | "claude" | "vercel-ai-sdk" | "eve" | "mastra";
    locked_execution: boolean;
    detail: string;
  }>;
  next_action: string;
};

type EveLayout = {
  /** Project-relative agent directory: "agent" (eve's nested default) or "." (flat). */
  agent_dir: string;
  /** Eve-only convention directories found (no v1 equivalent here). */
  eve_only: string[];
  /** Files/directories that map 1:1 onto the Caveman agent-directory convention. */
  maps: string[];
};

// Eve's documented layout (vercel/eve README + docs/reference/project-layout.md,
// verified 2026-08-15): an `agent/` directory — or the project root in the flat
// layout — holding required instructions.md, optional agent.ts, tools/, skills/,
// subagents/, sandbox/, plus the eve-only channels/, schedules/, connections/,
// hooks/. Detection is deliberately conservative: the nested `agent/` shape is
// an eve marker by itself (this convention keeps instructions.md at the root);
// a flat directory is only called eve when an eve-only directory is present,
// because a flat eve agent without one already IS this convention's shape —
// the overlap is the migration.
const EVE_ONLY_DIRS = ["channels", "schedules", "connections", "hooks"] as const;
const EVE_SHARED_ENTRIES = [
  "instructions.md",
  "agent.ts",
  "tools",
  "skills",
  "subagents",
  "sandbox",
] as const;

async function detectEveLayout(root: string): Promise<EveLayout | undefined> {
  const isDir = async (path: string) => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  };
  const isFile = async (path: string) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  };
  // A directory that already carries caveman.config.ts is a Caveman project
  // (native or already migrated) whatever else it contains — never flag it.
  if (await isFile(resolve(root, "caveman.config.ts"))) return undefined;
  for (const agentDir of ["agent", "."]) {
    const base = resolve(root, agentDir);
    if (!await isFile(resolve(base, "instructions.md"))) continue;
    const eveOnly: string[] = [];
    for (const name of EVE_ONLY_DIRS) {
      if (await isDir(resolve(base, name))) eveOnly.push(`${name}/`);
    }
    if (agentDir === "." && eveOnly.length === 0) return undefined;
    const maps: string[] = [];
    for (const name of EVE_SHARED_ENTRIES) {
      const path = resolve(base, name);
      if (name.endsWith(".md") || name.endsWith(".ts")
        ? await isFile(path)
        : await isDir(path)) {
        maps.push(name.includes(".") ? name : `${name}/`);
      }
    }
    return { agent_dir: agentDir, eve_only: eveOnly, maps };
  }
  return undefined;
}

/**
 * F7: doctor recognizes an eve directory and says what maps — nothing is
 * rewritten and there is no import command; the convention overlap does the
 * work, and one docs page walks the move. The mapping never overstates:
 * agent.ts exists on both sides but the shapes differ, and eve-only
 * directories are named as having no v1 equivalent rather than skipped.
 */
function renderEveMigration(eve: EveLayout): string {
  const from = eve.agent_dir === "." ? "this directory" : `${eve.agent_dir}/`;
  return [
    "",
    `vercel/eve agent directory detected (${[
      ...(eve.agent_dir === "." ? [] : ["agent/ layout"]),
      ...eve.eve_only,
    ].join(", ")})`,
    "",
    `  moves as-is     ${["instructions.md", "subagents/"]
      .filter((name) => eve.maps.includes(name))
      .join(" · ") || "none found yet"} — same names, same meaning, into the project root`,
    ...(() => {
      const rewrites = [
        ...(eve.maps.includes("agent.ts")
          ? ["agent.ts (exports AgentDirConfig here: model, budget, breakers)"]
          : []),
        ...(eve.maps.includes("tools/")
          ? ["tools/*.ts (each file must default-export this package's tool())"]
          : []),
        ...(eve.maps.includes("skills/")
          ? ["skills/*.md → .agents/skills/<name>/SKILL.md (Agent Skills layout)"]
          : []),
      ];
      return rewrites.length > 0
        ? [`  rewrite         ${rewrites.join(" · ")}`]
        : [];
    })(),
    ...(eve.eve_only.length > 0
      ? [`  no equivalent   ${eve.eve_only.join(" · ")} — channels, schedules, connections, and hooks are v2 scope here; Vercel Connect credentials are not supported`]
      : []),
    `  then            add caveman.config.ts + package.json, run caveman-agent doctor, then caveman-agent dev (from ${from} moved to a project root)`,
    "  walk            docs/eve-migration.md in the @caveman-ai/agent package — about 10 minutes to a first receipt",
    "",
  ].join("\n");
}

async function doctor(args: string[]): Promise<void> {
  if (args.some((value) => value !== "--json")) {
    throw new Error("usage: caveman-agent doctor [--json]");
  }
  const json = args.includes("--json");
  const root = process.cwd();
  const checks: DoctorCheck[] = [];
  const node = process.versions.node;
  checks.push(compareNodeVersion(node, "22.19.0") >= 0
    ? { id: "node", status: "pass", detail: `Node ${node}` }
    : {
      id: "node",
      status: "fail",
      detail: `Node ${node}; framework requires >=22.19.0`,
      fix: "install Node 22.19 or newer",
    });

  checks.push(await optionalPeerCheck());

  try {
    if (!await verifySandboxConformance()) throw new Error("probe returned false");
    checks.push({ id: "sandbox", status: "pass", detail: "tool sandbox containment probe passed" });
  } catch (error) {
    checks.push({
      id: "sandbox",
      status: "fail",
      detail: `tool sandbox containment unavailable: ${safeDiagnostic(error)}`,
      fix: "use supported Node runtime and OS; do not run production tools with sandbox fixture",
    });
  }

  // Missing engine and missing runtime are WARN, not FAIL: without them runs
  // still reach a real model response in observe-only mode (no transform or
  // gateway telemetry; provider usage and local context estimates remain). Only conditions that make even an
  // observe-only run untrustworthy fail this command.
  try {
    const registry = await loadTransformRegistry();
    checks.push({
      id: "engine",
      status: "pass",
      detail: `transform registry ${registry.sha256.slice(0, 12)} (${registry.capabilities.length} capabilities)`,
    });
  } catch (error) {
    checks.push({
      id: "engine",
      status: "warn",
      detail: `Caveman engine not found — transforms disabled (observe-only): ${safeDiagnostic(error)}`,
      fix: "npm i -g @caveman-ai/cli && caveman start",
    });
  }

  try {
    const command = process.env.CAVEMAN_CLI_BIN ?? "caveman";
    // Public Caveman porcelain exposes `version` as a command, not a GNU-style
    // flag. Keep doctor aligned with public CLI contract.
    const { stdout } = await execFileAsync(command, ["version"], {
      encoding: "utf8",
      env: buildRuntimeControlEnv(),
      maxBuffer: 64 << 10,
      timeout: 10_000,
    });
    const version = runtimeVersionDiagnostic(stdout);
    checks.push({ id: "runtime_cli", status: "pass", detail: version });
  } catch (error) {
    checks.push({
      id: "runtime_cli",
      status: "warn",
      detail: `Caveman runtime CLI unavailable — runs stay observe-only: ${safeDiagnostic(error)}`,
      fix: "npm i -g @caveman-ai/cli && caveman start",
    });
  }

  const gatewayURL = resolveGatewayURL(undefined);
  checks.push(await caveGatewayReady(gatewayURL)
    ? { id: "gateway", status: "pass", detail: `Caveman gateway ready at ${gatewayURL}` }
    : {
      id: "gateway",
      status: "warn",
      detail: `gateway not reachable at ${gatewayURL} — telemetry off, runs are observe-only`,
      fix: "npm i -g @caveman-ai/cli && caveman start",
    });

  const configPath = resolve(root, "caveman.config.ts");
  let currentLock: AnyCaveBuildLock | undefined;
  try {
    await readFile(configPath);
    const loaded = await loadBuildInputs(root, "caveman.config.ts");
    await lowerBuildContext(root, loaded.agent);
    checks.push({
      id: "project",
      status: "pass",
      detail: `${loaded.agent.id}: config, entry, eval graph, and static Context IR load`,
    });
    try {
      await readFile(resolve(root, ".caveman/agent.lock.json"));
      const lock = await validLockIdentity(root, loaded.config.entry, loaded.agent);
      if (!lock) throw new Error("lock disappeared during validation");
      currentLock = lock;
      checks.push({
        id: "lock",
        status: "pass",
        detail: `${lock.harness.id} build ${lock.build_sha256.slice(0, 12)} is current`,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        checks.push({
          id: "lock",
          status: "warn",
          detail: "no Cave Build lock; dev runs unlocked",
          fix: "add eval fixtures, then run caveman-agent build",
        });
      } else {
        checks.push({
          id: "lock",
          status: "fail",
          detail: safeDiagnostic(error),
          fix: "fix drift, then rebuild; do not deploy stale lock",
        });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      checks.push({
        id: "project",
        status: "warn",
        detail: "no caveman.config.ts in current directory",
        fix: "run command from generated agent project",
      });
    } else {
      checks.push({
        id: "project",
        status: "fail",
        detail: safeDiagnostic(error),
        fix: "fix config, entry, eval, or context source error",
      });
    }
  }

  try {
    const credentialModels = [
      process.env.ANTHROPIC_API_KEY && "anthropic/claude-haiku-4-5",
      process.env.OPENAI_API_KEY && "openai/gpt-5.4-mini",
      (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) && "google/gemini-2.5-flash",
    ].filter((value): value is string => typeof value === "string");
    const selectedModel = process.env.CAVE_MODEL ?? localProviderModel(root) ??
      (credentialModels.length === 1 ? credentialModels[0] : undefined);
    if (selectedModel === undefined) {
      checks.push({
        id: "provider",
        status: "warn",
        detail: credentialModels.length > 1
          ? "multiple provider credentials found but no model selected"
          : "no provider model selected",
        fix: credentialModels.length > 1
          ? "set CAVE_MODEL or configure .caveman/provider.json"
          : "set one supported provider credential or configure .caveman/provider.json",
      });
    } else {
      const credential = credentialForModel(selectedModel);
      checks.push(credential.available
        ? {
          id: "provider",
          status: "pass",
          detail: `${selectedModel} selected; ${credential.name} available`,
        }
        : {
          id: "provider",
          status: "warn",
          detail: `${selectedModel} selected; ${credential.name} missing`,
          fix: `set ${credential.name} in current shell`,
        });
    }
  } catch (error) {
    checks.push({
      id: "provider",
      status: "fail",
      detail: safeDiagnostic(error),
      fix: "fix .caveman/provider.json or CAVE_MODEL",
    });
  }

  // F7: recognize a vercel/eve agent directory and say what maps. Detection
  // only — no files are read beyond existence checks, nothing is rewritten.
  const eveLayout = await detectEveLayout(root);
  if (eveLayout !== undefined) {
    checks.push({
      id: "eve_migration",
      status: "warn",
      detail: `vercel/eve agent directory detected (${[
        ...(eveLayout.agent_dir === "." ? [] : ["agent/ layout"]),
        ...eveLayout.eve_only,
      ].join(", ")}) — ${
        eveLayout.maps.length > 0
          ? `found ${eveLayout.maps.join(", ")}: tools need this package's exports; skills move to canonical .agents/skills/<name>/SKILL.md layout`
          : "no mappable files found yet"
      }; ${
        eveLayout.eve_only.length > 0
          ? `${eveLayout.eve_only.join(", ")} have no v1 equivalent`
          : "no eve-only directories found"
      }`,
      fix: "read docs/eve-migration.md in the @caveman-ai/agent package, move the mapped files, then run caveman-agent dev",
    });
  }

  let globalClaudeVersion = "global Claude Code not found (not required)";
  try {
    const { stdout } = await execFileAsync(process.env.CLAUDE_BIN ?? "claude", ["--version"], {
      encoding: "utf8",
      env: buildRuntimeControlEnv(),
      maxBuffer: 64 << 10,
      timeout: 10_000,
    });
    globalClaudeVersion = stdout.trim() || "global Claude Code returned empty version";
  } catch {
    // Claude is optional. Harness matrix below reports exact availability.
  }

  const ready = checks.every((check) => check.status !== "fail");
  const firstFailure = checks.find((check) => check.status === "fail");
  const firstWarning = checks.find((check) => check.status === "warn");
  // A machine without the engine or the runtime CLI can still run observe-only,
  // but it cannot execute a Cave Build: locked execution needs the transforms
  // and the local runtime, so it is reported separately from the exit code.
  const optimized = ["engine", "runtime_cli"].every((id) =>
    checks.find((check) => check.id === id)?.status === "pass");
  const lockedRequirements = ["project", "lock", "provider", "engine", "runtime_cli"];
  const lockedMissing = lockedRequirements.find((id) => checks.find((check) => check.id === id)?.status !== "pass");
  const lockedReady = ready && optimized && lockedMissing === undefined && currentLock?.harness.id === "pi";
  const notLockedDetail = !ready
    ? "foundation check failed"
    : lockedMissing !== undefined
      ? `locked execution unavailable: ${lockedMissing} check is not ready`
      : "locked execution unavailable";
  const report: DoctorReport = {
    schema_version: 1,
    framework_version: FRAMEWORK_VERSION,
    ready,
    execution_mode: optimized ? "optimized" : "observe-only",
    checks,
    ...(eveLayout === undefined ? {} : { eve_migration: eveLayout }),
    harnesses: [
      {
        id: "pi",
        locked_execution: lockedReady,
        detail: lockedReady
          ? `adapter ${PI_ADAPTER_VERSION}; upstream ${PI_UPSTREAM_VERSION}`
          : notLockedDetail,
      },
      {
        id: "claude",
        locked_execution: false,
        detail: `Agent SDK ${CLAUDE_AGENT_SDK_VERSION} / bundled Claude Code ${CLAUDE_CODE_VERSION}; ${globalClaudeVersion}; public lane exists, but locked execution stays fail-closed pending source/runtime provenance, per-turn budgets, CCR proof, cached-substitution evidence, and executable Pi/Claude replay`,
      },
      {
        id: "vercel-ai-sdk",
        locked_execution: false,
        detail: "native adapter package targets ai 7.0.84; CLI behavioral execution bridge is not shipped",
      },
      {
        id: "eve",
        locked_execution: false,
        detail: "adapter 0.29.2 registration/evidence envelope exists; CLI behavioral execution bridge is not shipped",
      },
      {
        id: "mastra",
        locked_execution: false,
        detail: "native adapter package targets @mastra/core 1.63.2; CLI behavioral execution bridge is not shipped",
      },
    ],
    next_action: firstFailure?.fix ?? firstWarning?.fix ?? "run caveman-agent dev",
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Caveman Agent ${FRAMEWORK_VERSION} doctor`,
      "",
      ...checks.map((check) => {
        const mark = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
        return `${mark.padEnd(4)} ${check.id.padEnd(12)} ${check.detail}`;
      }),
      "",
      ...(eveLayout === undefined ? [] : [renderEveMigration(eveLayout)]),
      `run mode: ${report.execution_mode}${report.execution_mode === "observe-only" ? " (no transforms or gateway telemetry)" : ""}`,
      `locked harnesses: ${report.harnesses.filter((item) => item.locked_execution).map((item) => item.id).join(", ") || "none"}`,
      `next: ${report.next_action}`,
      "provider calls: 0",
      "provider savings: not claimed",
      "",
    ].join("\n"));
  }
  if (!ready) process.exitCode = 1;
}

function compareNodeVersion(current: string, minimum: string): number {
  const parse = (value: string) => value.split(".").slice(0, 3).map((part) => Number(part));
  const left = parse(current);
  const right = parse(minimum);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function safeDiagnostic(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/[\r\n]+/g, " ").slice(0, 512);
}

function runtimeVersionDiagnostic(stdout: string): string {
  const value = stdout.trim();
  if (value === "") throw new Error("empty version output");
  try {
    const parsed = JSON.parse(value) as { version?: unknown; binary_release?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim() !== "") {
      const release = typeof parsed.binary_release === "string" && parsed.binary_release.trim() !== ""
        ? ` (${parsed.binary_release.trim()})`
        : "";
      return `caveman ${parsed.version.trim()}${release}`;
    }
  } catch {
    // Older CLIs may return one plain version line.
  }
  return value.replace(/[\r\n]+/g, " ").slice(0, 256);
}

function credentialForModel(model: string): { name: string; available: boolean } {
  const provider = model.split("/", 1)[0];
  if (provider === "anthropic") {
    return { name: "ANTHROPIC_API_KEY", available: Boolean(process.env.ANTHROPIC_API_KEY) };
  }
  if (provider === "openai") {
    return { name: "OPENAI_API_KEY", available: Boolean(process.env.OPENAI_API_KEY) };
  }
  if (provider === "google" || provider === "gemini") {
    return {
      name: "GEMINI_API_KEY or GOOGLE_API_KEY",
      available: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    };
  }
  return { name: `credential for ${provider || "unknown provider"}`, available: false };
}

async function register(_args: string[]): Promise<void> {
  const root = process.cwd();
  const controlURL = process.env.CAVE_CONTROL_URL?.replace(/\/+$/, "");
  const token = process.env.CAVE_TOKEN ?? process.env.CAVE_API_TOKEN;
  const projectID = process.env.CAVE_PROJECT_ID;
  if (!controlURL || !token || !projectID) {
    throw new Error("register requires CAVE_CONTROL_URL, CAVE_TOKEN, and CAVE_PROJECT_ID");
  }
  const lock = await readLock(root);
  const loaded = await loadBuildInputs(root, "caveman.config.ts");
  const checked = await validLockIdentity(root, loaded.config.entry);
  if (!checked || checked.build_sha256 !== lock.build_sha256) {
    throw new Error("cave_stale_lock:registration");
  }
  const response = await fetch(`${controlURL}/api/v1/projects/${encodeURIComponent(projectID)}/agent-builds`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      agent_slug: lock.agent_id,
      build_sha256: lock.build_sha256,
      plan_sha256: lock.plan_sha256,
      source_sha256: lock.source_sha256,
      eval_suite_sha256: lock.eval_suite_sha256,
      catalog_sha256: lock.catalog_sha256,
      transform_registry_sha256: lock.runtime.transform_registry_sha256,
      harness: lock.harness.id,
      adapter_version: lock.harness.adapter_version,
      upstream_version: lock.harness.upstream_version,
      runtime_version: lock.runtime.caveman_version,
      evidence_status: lock.evidence.status,
      evidence_basis: lock.evidence.basis,
      lock,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`registration failed: HTTP ${response.status}`);
  }
  const registered = await response.json() as { id?: unknown; build_sha256?: unknown };
  process.stdout.write([
    `registered build: ${String(registered.build_sha256 ?? lock.build_sha256)}`,
    `registration id: ${String(registered.id ?? "unavailable")}`,
    "registration does not activate plan or create a savings claim",
    "provider savings: not claimed",
    "",
  ].join("\n"));
}

/**
 * The deployable target. Serves one agent over HTTP with every run journaled,
 * resuming whatever the previous instance left unfinished before it reports
 * ready. Configuration is environment-only, because that is what every
 * container platform supplies:
 *
 *   CAVE_SERVE_TOKEN    required bearer token for /runs
 *   CAVE_JOURNAL_URL    optional HTTP journal (default: local disk)
 *   CAVE_JOURNAL_TOKEN  bearer token for that journal
 *   PORT / HOST         defaults 8080 / 0.0.0.0
 */
async function serve(args: string[]): Promise<void> {
  const { directory, port, host, locked } = parseServeOptions(args, process.env);
  const token = process.env.CAVE_SERVE_TOKEN;
  if (token === undefined || token === "") {
    throw new Error(
      "caveman-agent serve: set CAVE_SERVE_TOKEN; an unauthenticated agent endpoint spends money for anyone who finds it",
    );
  }
  const root = resolve(process.cwd(), directory);
  const definition = await hasAgentDirConvention(root)
    ? await loadAgentDir(root)
    : await loadAgent(resolve(root, "src/agent.ts"));

  const journalUrl = process.env.CAVE_JOURNAL_URL;
  let store: DurableStore | undefined;
  if (journalUrl !== undefined && journalUrl !== "") {
    const journalToken = process.env.CAVE_JOURNAL_TOKEN;
    if (journalToken === undefined || journalToken === "") {
      throw new Error("caveman-agent serve: CAVE_JOURNAL_URL needs CAVE_JOURNAL_TOKEN");
    }
    store = new HttpDurableStore({ url: journalUrl, token: journalToken });
  }

  const server = createAgentServer({
    definition,
    token,
    rootDir: root,
    ...(store === undefined ? {} : { store }),
    ...(locked ? { build: await readLock(root) } : {}),
  });
  const bound = await server.listen(port, host);
  process.stdout.write(
    `caveman-agent serve: listening on ${host}:${String(bound)}${
      journalUrl === undefined ? " (journal: local disk)" : " (journal: http)"
    }\n`,
  );
  // A platform stops an instance with SIGTERM. Draining is best effort:
  // anything unfinished is journaled and resumed by the next instance.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void server.close().then(() => process.exit(0));
    });
  }
}

async function dev(args: string[]): Promise<void> {
  const root = process.cwd();
  // Bare `caveman-agent dev` prefers the agent-directory convention when the
  // project root carries instructions.md; otherwise the classic src/agent.ts
  // default is unchanged. An explicit entry may also name a convention
  // directory, which maps to its generated module entry.
  const requested = args[0] ??
    (await hasAgentDirConvention(root) ? "." : "src/agent.ts");
  const requestedAbsolute = resolve(root, requested);
  const entryAbsolute = await conventionEntryPath(requestedAbsolute);
  const dirRoot = entryAbsolute === requestedAbsolute ? undefined : requestedAbsolute;
  // Regenerate the directory convention's module entry before every staging
  // pass so a tool added or removed mid-session lands in the staged graph.
  // Pure directory scan — no live import of user modules on the watch path;
  // the loader's imports happen inside the staged snapshot.
  const refreshDirEntry = async (): Promise<void> => {
    if (dirRoot !== undefined) await generateAgentDirEntry(dirRoot);
  };
  const entry = relative(root, entryAbsolute);
  const prompt = args.slice(1).join(" ") || "Reply with one short greeting.";
  const conversation = createConversation();
  const sessionId = conversation.sessionId;
  const interactive = args.length <= 1 && process.stdin.isTTY && process.stdout.isTTY;
  if (!interactive) {
    await refreshDirEntry();
    const snapshot = await prepareDevSnapshot(root, entry);
    try {
      await runDevTurn(snapshot, prompt, sessionId, conversation, root);
    } finally {
      await snapshot.loaded.dispose();
    }
    return;
  }

  let revision = 0;
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    const path = filename?.toString().replaceAll("\\", "/") ?? "";
    // .caveman/runs is the receipt trail every dev turn writes; watching it
    // would mark the snapshot dirty after each turn's own receipt.
    if (path !== "" &&
        /(?:^|\/)(?:node_modules|\.git|dist|coverage|\.turbo|\.caveman\/runs)(?:\/|$)/.test(path)) {
      return;
    }
    revision += 1;
  });
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let snapshot: PreparedDevSnapshot | undefined;
  let snapshotRevision = -1;
  try {
    const initialRevision = revision;
    await refreshDirEntry();
    snapshot = await prepareDevSnapshot(root, entry);
    snapshotRevision = initialRevision;
    await runDevTurn(snapshot, prompt, sessionId, conversation, root);
    while (true) {
      const promptDirty = revision !== snapshotRevision;
      const next = await readline.question(
        promptDirty ? "caveman-agent (reloaded)> " : "caveman-agent> ",
      );
      if (next.trim() === "") continue;
      try {
        const dirty = revision !== snapshotRevision;
        if (dirty) {
          const replacementRevision = revision;
          await refreshDirEntry();
          const replacement = await prepareDevSnapshot(root, entry);
          const previous = snapshot;
          snapshot = replacement;
          snapshotRevision = replacementRevision;
          await previous.loaded.dispose();
        }
        await runDevTurn(snapshot, next, sessionId, conversation, root);
      } catch (error) {
        process.stderr.write(`${firstUsefulError(error)}\n`);
      }
    }
  } finally {
    await snapshot?.loaded.dispose();
    watcher.close();
    readline.close();
  }
}

type PreparedDevSnapshot = {
  loaded: LoadedDevModule;
  definition: AgentDefinition;
  identity?: AnyCaveBuildLock;
};

async function prepareDevSnapshot(
  root: string,
  entry: string,
): Promise<PreparedDevSnapshot> {
  const loaded = await loadDevModule(root, resolve(root, entry));
  try {
    const definition = agentFromImported(loaded.imported);
    await loaded.includeAgentFiles(definition);
    const hasLockSnapshot = await stageDevLockInputs(root, loaded);
    const identity = hasLockSnapshot
      ? await validLockIdentity(
        loaded.rootDir,
        loaded.entryPath,
        definition,
        async ({ evals }) => {
          await loaded.includeFiles(evals.flatMap((fixture) =>
            fixture.tools.sandbox === undefined ? [] : [fixture.tools.sandbox]
          ));
        },
        // The staged snapshot already carries the generated convention entry;
        // regenerating here would pin the staging directory's basename as id.
        false,
      )
      : undefined;
    return { loaded, definition, ...(identity === undefined ? {} : { identity }) };
  } catch (error) {
    await loaded.dispose();
    throw loaded.remapError(error);
  }
}

async function runDevTurn(
  snapshot: PreparedDevSnapshot,
  prompt: string,
  sessionId: string,
  conversation: ConversationState,
  projectRoot: string,
): Promise<void> {
  const { loaded, definition, identity } = snapshot;
  try {
    const runtimeDefinition = identity === undefined
      ? definition
      : {
        ...definition,
        model: identity.selected_plan.model,
        reasoning: runtimeReasoning(identity.selected_plan.reasoning),
      };
    // A directory-loaded agent carries run defaults from its agent.ts
    // (budget, breakers); dev turns honor them like run() does.
    const defaults = agentDirRunDefaults(definition);
    const result = await runAgentInternal(runtimeDefinition as AgentDefinition, prompt, {
      rootDir: loaded.rootDir,
      entryPath: loaded.entryPath,
      sessionId,
      conversation,
      ...(defaults?.budget === undefined ? {} : { budget: defaults.budget }),
      ...(defaults?.breakers === undefined ? {} : { breakers: defaults.breakers }),
      ...(identity === undefined ? {} : {
        lockedBuild: identity,
      }),
    });
    process.stdout.write(`\nagent response\n${result.text}\n\n`);
    // F1/F5: every dev turn ends with the receipt print — one cost block,
    // rendered by the same renderer the goldens pin. The receipt JSON lands
    // under the real project root, not the staged snapshot.
    try {
      const { rendered } = await writeRunReceipt(projectRoot, result.receipt, {
        mode: result.mode,
        durationMs: result.latencyMs,
      });
      process.stdout.write(rendered);
    } catch (error) {
      process.stderr.write(`caveman-agent: receipt write failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`);
    }
    process.stdout.write([
      "",
      `context bill: ${formatBill(result.contextBill)}`,
      `active safe transforms: ${result.transformIDs.length > 0 ? result.transformIDs.join(",") : "pass-through"} + stable-prefix guard`,
      `next action: ${identity ? "run caveman-agent check before deployment" : "review eval fixtures, then npm run build"}`,
      "local evidence: estimate only",
      "provider savings: not claimed",
      "",
    ].join("\n"));
  } catch (error) {
    throw loaded.remapError(error);
  }
}

async function stageDevLockInputs(
  root: string,
  loaded: Awaited<ReturnType<typeof loadDevModule>>,
): Promise<boolean> {
  const lockPath = ".caveman/agent.lock.json";
  let lockBytes: string;
  try {
    lockBytes = await readFile(resolve(root, lockPath), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const configPath = "caveman.config.ts";
  const lockValue = JSON.parse(lockBytes) as { schema_version?: unknown };
  await loaded.includeFiles(lockValue.schema_version === 3
    ? [lockPath, ".caveman/workload-profile.json"]
    : [lockPath]);
  await loaded.includeSourceGraph([configPath]);
  const imported = await importFresh(resolve(loaded.rootDir, configPath)) as {
    default?: BuildConfig;
    config?: BuildConfig;
  };
  const config = imported.default ?? imported.config;
  if (!config || typeof config.evals !== "string") {
    throw new Error("caveman build: config must export defineBuild()");
  }
  const evalFiles: string[] = [];
  for await (const path of glob(config.evals, { cwd: root })) {
    evalFiles.push(resolve(root, path));
  }
  await loaded.includeSourceGraph(evalFiles);
  await loaded.includeFiles(await projectSourceFiles(root));
  await loaded.includeOptionalFiles(PACKAGE_STATE_FILES);
  return true;
}

function firstUsefulError(error: unknown): string {
  const stack = error instanceof Error ? error.stack ?? error.message : String(error);
  return stack.split("\n").slice(0, 4).join("\n");
}

async function build(args: string[]): Promise<void> {
  const root = process.cwd();
  const verbose = args.includes("--verbose");
  const acceptPrefixShrink = args.includes("--accept-prefix-shrink");
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const configPath = positional[0] ?? "caveman.config.ts";
  const loaded = await loadBuildInputs(root, configPath);
  const lowered = await lowerBuildContext(root, loaded.agent);
  // Static plan checks run BEFORE the eval gate (goldens/README.md ordering
  // contract): they are free and deterministic, so a build without evals
  // still fails fast on a static violation instead of printing
  // needs_eval. Wire codes are demoted to --verbose.
  const checks = await runStaticPlanChecks(root, loaded, lowered.ir, { acceptPrefixShrink });
  for (const advisory of checks.advisories) process.stdout.write(advisory);
  if (checks.failure !== undefined) {
    process.stdout.write(renderStaticPlanFailure(checks.failure, { verbose }));
    process.exitCode = 1;
    return;
  }
  const evals = loaded.evals;
  if (evals.length === 0) {
    printBuildResult({
      status: "needs_eval",
      estimated_ceiling_usd: 0,
      planned_runs: 0,
      completed_runs: 0,
      static_rejections: 0,
      actual_cost_usd: null,
      reason: "no eval fixture",
    });
    return;
  }

  // Explicit split metadata opts into profile-guided v3. Compiler never
  // guesses which examples are holdout evidence.
  if (evals.some((fixture) => fixture.split !== undefined)) {
    await buildProfiled(root, loaded, evals);
    await recordFrozenPrefix(root, lowered.ir);
    return;
  }

  const buildContexts = await Promise.all(evals.map((fixture) =>
    lowerBuildContext(root, loaded.agent, fixtureInput(fixture.input))));
  const baseline = baselinePlan(loaded.agent, root, buildContexts.map((item) => item.ir));
  const transformRegistry = await loadTransformRegistry();
  const preferredTransforms = await profilePreferredTransforms(lowered);
  // The catalog pricing + model/safety-class policy filter now live in
  // generateCandidatePlans so the public compile() enforces the same thing
  // — the CLI passes its policy and no longer post-filters.
  const candidates = generateCandidatePlans(
    loaded.agent,
    lowered.ir,
    baseline,
    loaded.config.allowedModels ?? configuredModelCandidates(baseline.model),
    true,
    preferredTransforms,
    transformRegistry.capabilities,
    evalDynamicKinds(evals),
    {
      ...(loaded.config.allowedModels === undefined ? {} : { allowedModels: loaded.config.allowedModels }),
      ...(loaded.config.deniedModels === undefined ? {} : { deniedModels: loaded.config.deniedModels }),
      ...(loaded.config.forbiddenSafetyClasses === undefined
        ? {}
        : { forbiddenSafetyClasses: loaded.config.forbiddenSafetyClasses }),
    },
  );
  const plannedRuns = candidates.filter((candidate) => !candidate.static_rejection).length * evals.length * 5;
  const estimatedCeiling = candidates
    .filter((candidate) => !candidate.static_rejection)
    .reduce((sum, candidate) => sum + candidate.estimated_cost_usd_per_run * evals.length * 5, 0);
  process.stdout.write(`static reservation ceiling: $${estimatedCeiling.toFixed(4)} public-catalog estimate · ${plannedRuns} runs · provider overage remains possible\n`);
  const sandboxConformance = await verifySandboxConformance();
  if (!sandboxConformance) throw new Error("cave_sandbox_conformance_failed");
  const privacyConformance = contextIRIsContentBlind(lowered.ir);
  if (!privacyConformance) throw new Error("cave_privacy_conformance_failed");
  const conversations = new Map<string, ConversationState>();
  const result = await compileAndWrite({
    agent: loaded.agent,
    contextIR: lowered.ir,
    evals: loaded.evals,
    candidates,
    baselinePlan: baseline,
    seeds: [1, 2, 3, 4, 5],
    config: loaded.config,
    sourceSha256: loaded.sourceSha256,
    catalogSha256: CATALOG_SHA256,
    transformRegistrySha256: transformRegistry.sha256,
    runtimeVersion: FRAMEWORK_VERSION,
    adapterVersion: PI_ADAPTER_VERSION,
    upstreamVersion: PI_UPSTREAM_VERSION,
    runner: async ({ plan, eval: fixture, seed, maxCostUsd, signal }) => runNativePiFixture({
      rootDir: root,
      entryPath: loaded.entryPath,
      definition: loaded.agent,
      plan,
      fixture,
      seed,
      sandboxConformance,
      privacyConformance,
      conversations,
      maxCostUsd,
      signal,
    }),
  });
  printBuildResult(result);
  await recordFrozenPrefix(root, lowered.ir);
}

/**
 * Static plan checks (phase 2): volatile frozen prefix (#224 first half),
 * prefix-shrink regression against the locked plan, and frozen prefix below
 * the provider's minimum cacheable length. Deterministic, provider-free, and
 * ahead of the eval gate. Each check fires only on facts it actually has —
 * an old lock without a frozen-prefix record, or a model without a catalog
 * cache profile, honestly skips rather than guessing.
 */
async function runStaticPlanChecks(
  root: string,
  loaded: LoadedBuildInputs,
  ir: ContextIR,
  options: { acceptPrefixShrink?: boolean } = {},
): Promise<{ failure: StaticPlanFailure | undefined; advisories: string[] }> {
  const advisories: string[] = [];
  // A second, independent composition pass must lower to a byte-identical
  // frozen prefix; a run-varying context value declared build-stable differs.
  // The second pass runs under a +26h clock so day-stable values
  // (`toDateString()`) are caught, not just per-call ones. Note: composition
  // side effects (module imports, context fns) run twice per build.
  const requestedEntry = resolve(root, loaded.config.entry);
  const secondAgent = await withPerturbedClock(() =>
    loaded.entryPath !== requestedEntry
      ? loadAgentDir(requestedEntry)
      : loadAgent(loaded.entryPath));
  const second = await lowerBuildContext(root, secondAgent);
  const volatile = findVolatileFrozenSegment(ir, second.ir);
  if (volatile !== undefined) {
    const origin = agentDirContextOrigins(secondAgent)?.get(volatile.id);
    return {
      advisories,
      failure: {
        code: "cave_frozen_prefix_volatile_segment",
        location: origin?.file ?? loaded.config.entry,
        segmentId: volatile.id,
        stability: volatile.stability,
        ...(origin?.source === undefined ? {} : { sourcePreview: origin.source }),
        fixToolPath: `tools/get_${volatile.id.replaceAll(/[^A-Za-z0-9_-]+/g, "_")}.ts`,
      },
    };
  }

  const currentTokens = frozenPrefixTokens(ir);
  let lock: AnyCaveBuildLock | undefined;
  try {
    lock = await readLock(root);
  } catch {
    lock = undefined;
  }
  if (options.acceptPrefixShrink === true) {
    // The shrink is declared intentional: reset the baseline. The build's
    // end-of-lock record rewrite establishes the new one.
    await rm(resolve(root, FROZEN_PREFIX_RECORD_PATH), { force: true });
  } else if (lock !== undefined) {
    const record = await readFrozenPrefixRecord(root);
    if (record !== undefined && record.context_ir_sha256 === lock.context_ir_sha256 &&
        currentTokens < record.frozen_prefix_tokens) {
      return {
        advisories,
        failure: {
          code: "cave_prefix_shrink_regression",
          lockedTokens: record.frozen_prefix_tokens,
          currentTokens,
        },
      };
    }
  }

  const model = lock?.selected_plan.model ??
    (typeof loaded.agent.model === "string" ? loaded.agent.model : undefined);
  if (model !== undefined) {
    const minimum = providerPrefixMinimum(model);
    if (minimum !== undefined && currentTokens < minimum.minimumTokens) {
      // Severity is mode-scoped (goldens/README.md): only an explicit-cache
      // model fails — its lock would promise breakpoints over a cache that
      // cannot exist. Affinity/implicit models still run below the minimum;
      // they just read cold, and the advisory says so loudly.
      if (minimum.mode === "explicit") {
        return {
          advisories,
          failure: {
            code: "cave_frozen_prefix_below_provider_minimum",
            prefixTokens: currentTokens,
            minimumTokens: minimum.minimumTokens,
            model: minimum.model,
          },
        };
      }
      advisories.push(renderBelowMinimumAdvisory({
        prefixTokens: currentTokens,
        minimumTokens: minimum.minimumTokens,
        model: minimum.model,
      }));
    }
  }
  return { failure: undefined, advisories };
}

const FROZEN_PREFIX_RECORD_PATH = ".caveman/frozen-prefix.json";
/** The IR's token estimate basis (context-ir.ts estimateTokens: bytes / 4). */
const FROZEN_PREFIX_TOKEN_BASIS = "local_estimate_bytes_over_4";

interface FrozenPrefixRecord {
  context_ir_sha256: string;
  frozen_prefix_tokens: number;
  basis: typeof FROZEN_PREFIX_TOKEN_BASIS;
}

async function readFrozenPrefixRecord(root: string): Promise<FrozenPrefixRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(resolve(root, FROZEN_PREFIX_RECORD_PATH), "utf8"),
    );
    if (isPlainRecord(parsed) &&
        typeof parsed.context_ir_sha256 === "string" &&
        /^[0-9a-f]{64}$/.test(parsed.context_ir_sha256) &&
        Number.isSafeInteger(parsed.frozen_prefix_tokens) &&
        Number(parsed.frozen_prefix_tokens) >= 0 &&
        // A record on a different estimate basis must not be compared against
        // this build's figures; the shrink check honestly skips it.
        parsed.basis === FROZEN_PREFIX_TOKEN_BASIS) {
      return parsed as unknown as FrozenPrefixRecord;
    }
  } catch {
    // Missing or unreadable record: the shrink check honestly skips.
  }
  return undefined;
}

/**
 * Records the frozen-prefix token count beside a lock this build just wrote
 * (workload-profile.json pattern), binding it to the lock's context IR digest
 * so the next build's shrink check compares like against like.
 */
async function recordFrozenPrefix(root: string, ir: ContextIR): Promise<void> {
  let lock: AnyCaveBuildLock;
  try {
    lock = await readLock(root);
  } catch {
    return;
  }
  const digest = contextIRSHA256(ir);
  if (lock.context_ir_sha256 !== digest) return;
  const record: FrozenPrefixRecord = {
    context_ir_sha256: digest,
    frozen_prefix_tokens: frozenPrefixTokens(ir),
    basis: FROZEN_PREFIX_TOKEN_BASIS,
  };
  const path = resolve(root, FROZEN_PREFIX_RECORD_PATH);
  await mkdir(resolve(root, ".caveman"), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
}

export type ProfiledEvalSplits = {
  profile: EvalDefinition[];
  development: EvalDefinition[];
  holdout: EvalDefinition[];
};

export type ProfiledPlanningState = {
  planningEvals: readonly EvalDefinition[];
  contextByEvalID: ReadonlyMap<string, ContextIR>;
  lowered: Awaited<ReturnType<typeof lowerContext>>;
  baseline: CavePlan;
  observedDynamicKinds: ReadonlySet<ContextKind>;
};

type ProfileSource = "imported_traces" | "profile_evals";

const PROFILE_CALL_RESERVE = 8;
const MAX_TRACE_FILES = 128;
const MAX_TRACE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TRACE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_TRACE_ROWS = 50_000;

async function buildProfiled(
  root: string,
  loaded: LoadedBuildInputs,
  evals: EvalDefinition[],
): Promise<void> {
  const splits = splitProfiledEvals(evals);
  const imported = await importProfileTrajectories(root, loaded.agent);
  const profileSource: ProfileSource = imported.length > 0 ? "imported_traces" : "profile_evals";
  if (imported.length === 0 && splits.profile.length === 0) {
    throw new Error(
      "cave_compiler_profile_evidence_missing: add split \"profile\" evals or .caveman/traces/*.jsonl",
    );
  }
  if (loaded.agent.tools.length > 0) {
    printProfiledBuildResult({
      status: "capability_refused",
      estimated_ceiling_usd: 0,
      actual_cost_usd: 0,
      reason: "cave_compiler_tool_effect_coverage_unavailable",
    }, profileSource, imported.length, 0);
    return;
  }
  const planning = await prepareProfiledPlanningState(root, loaded.agent, splits);
  const { contextByEvalID, lowered, baseline } = planning;
  const observedDynamicKinds = new Set([
    ...planning.observedDynamicKinds,
    ...observedDynamicKindsFromTrajectories(imported),
  ]);
  const transformRegistry = await loadTransformRegistry();
  const preferredTransforms = await profilePreferredTransforms(lowered);
  const modelCandidates = loaded.config.allowedModels ?? configuredModelCandidates(baseline.model);
  const planningAccountingAt = new Date();
  const candidates = planNativePiCandidates({
    agent: loaded.agent,
    contextIR: lowered.ir,
    baselinePlan: baseline,
    modelCandidates,
    config: loaded.config,
    observedDynamicKinds,
    preferredTransforms,
    transformCapabilities: transformRegistry.capabilities,
    accountingAt: planningAccountingAt,
  });
  const runnable = candidates.filter((candidate) => candidate.static_rejection === undefined);
  const baselineCandidate = runnable.find((candidate) => candidate.plan.plan_id === baseline.plan_id);
  if (baselineCandidate === undefined) {
    throw new Error("cave_compiler_baseline_not_runnable: check model catalog and build policy");
  }
  const developmentSeeds = [1, 2, 3, 4, 5];
  const holdoutSeeds = [1, 2, 3, 4, 5];
  const developmentCeiling = runnable.reduce((sum, candidate) =>
    sum + candidate.estimated_cost_usd_per_run * splits.development.length * developmentSeeds.length, 0);
  const hasBehavioralCandidate = runnable.some((candidate) =>
    candidate.plan.plan_id !== baseline.plan_id);
  const maxSelectedEstimate = Math.max(0, ...runnable.map((candidate) =>
    candidate.estimated_cost_usd_per_run));
  const holdoutCandidateCeiling = hasBehavioralCandidate
    ? baselineCandidate.estimated_cost_usd_per_run + maxSelectedEstimate
    : baselineCandidate.estimated_cost_usd_per_run;
  const holdoutCeiling = holdoutCandidateCeiling * splits.holdout.length * holdoutSeeds.length;
  const profileFixtureCeilings = imported.length > 0
    ? []
    : splits.profile.map((fixture) => profileFixtureCeiling(
      baseline.model,
      contextByEvalID.get(fixture.id)!,
      loaded.agent.output?.maxTokens ?? 2_000,
      planningAccountingAt,
    ));
  const profileCeiling = profileFixtureCeilings.reduce((sum, value) => sum + value, 0);
  const estimatedCeiling = roundCompilerUsd(profileCeiling + developmentCeiling + holdoutCeiling);
  const plannedRuns = (imported.length > 0 ? 0 : splits.profile.length) +
    runnable.length * splits.development.length * developmentSeeds.length +
    (hasBehavioralCandidate ? 2 : 1) * splits.holdout.length * holdoutSeeds.length;
  process.stdout.write([
    "profile-guided build v3",
    `target: pi ${PI_ADAPTER_VERSION} / upstream ${PI_UPSTREAM_VERSION}`,
    `profile source: ${profileSource === "imported_traces"
      ? `${imported.length} content-blind trace rows`
      : `${splits.profile.length} profile evals`}`,
    `validation: ${splits.development.length} development / ${splits.holdout.length} untouched holdout evals`,
    `static reservation ceiling: $${estimatedCeiling.toFixed(4)} public-catalog estimate · ${plannedRuns} runs`,
    `configured search budget: $${loaded.config.maxSearchCostUsd.toFixed(4)} · terminal provider overage remains possible`,
    "result basis: local inferred evidence; provider savings not claimed",
    "",
  ].join("\n"));
  if (estimatedCeiling > loaded.config.maxSearchCostUsd) {
    printProfiledBuildResult({
      status: "search_budget_exceeded",
      estimated_ceiling_usd: estimatedCeiling,
      actual_cost_usd: 0,
      reason: "profile + development + untouched-holdout ceiling exceeds configured cap",
    }, profileSource, imported.length, 0);
    return;
  }

  const sandboxConformance = await verifySandboxConformance();
  if (!sandboxConformance) throw new Error("cave_sandbox_conformance_failed");
  const privacyConformance = contextIRIsContentBlind(lowered.ir);
  if (!privacyConformance) throw new Error("cave_privacy_conformance_failed");

  const profileRows = [...imported];
  // Imported history is evidence, not spend caused by this compilation.
  let profileActualCostUsd: number | null = 0;
  if (profileRows.length === 0) {
    for (const [index, fixture] of splits.profile.entries()) {
      const remaining = roundCompilerUsd(
        loaded.config.maxSearchCostUsd - (profileActualCostUsd ?? 0),
      );
      if (!(remaining > 0)) break;
      const profiled = await runProfileFixture(
        root,
        loaded.entryPath,
        loaded.agent,
        baseline,
        fixture,
        Math.min(profileFixtureCeilings[index]!, remaining),
      );
      profileRows.push(profiled.trajectory);
      profileActualCostUsd = roundCompilerUsd((profileActualCostUsd ?? 0) + profiled.catalogCostUsd);
      if (profileActualCostUsd >= loaded.config.maxSearchCostUsd) break;
    }
  }
  if (profileRows.length < (imported.length > 0 ? imported.length : splits.profile.length)) {
    printProfiledBuildResult({
      status: "search_budget_exceeded",
      estimated_ceiling_usd: estimatedCeiling,
      actual_cost_usd: profileActualCostUsd,
      reason: "profile execution consumed configured search cap before all fixtures",
    }, profileSource, profileRows.length, profileActualCostUsd);
    return;
  }
  const profile = createCompilerWorkloadProfile(profileRows);
  const remainingSearchBudget = roundCompilerUsd(
    loaded.config.maxSearchCostUsd - (profileActualCostUsd ?? 0),
  );
  if (!(remainingSearchBudget > 0)) {
    printProfiledBuildResult({
      status: "search_budget_exceeded",
      estimated_ceiling_usd: estimatedCeiling,
      actual_cost_usd: profileActualCostUsd,
      reason: "profile execution consumed configured search cap",
    }, profileSource, profileRows.length, profileActualCostUsd);
    return;
  }

  const target = nativePiCompilerTarget();
  const result = await compileProfiledNativePi({
    rootDir: root,
    entryPath: loaded.entryPath,
    agent: loaded.agent,
    contextIR: lowered.ir,
    profile,
    developmentEvals: splits.development,
    holdoutEvals: splits.holdout,
    developmentSeeds,
    holdoutSeeds,
    modelCandidates,
    transformCapabilities: transformRegistry.capabilities,
    preferredTransforms,
    baselinePlan: baseline,
    config: { ...loaded.config, maxSearchCostUsd: remainingSearchBudget },
    sourceSha256: loaded.sourceSha256,
    catalogSha256: CATALOG_SHA256,
    transformRegistrySha256: transformRegistry.sha256,
    runtimeVersion: FRAMEWORK_VERSION,
  });
  if (result.lock !== undefined) {
    assertProfiledBuildTarget(result.lock, target);
    await writeProfiledArtifacts(
      root,
      profile,
      { ...result, lock: result.lock },
      profileSource,
      profileActualCostUsd,
      estimatedCeiling,
    );
  }
  printProfiledBuildResult(result, profileSource, profileRows.length, profileActualCostUsd);
}

/**
 * Lowers only evidence available before development selection. Holdout inputs
 * never enter planning ContextIR, baseline budgets, or dynamic candidate hints;
 * compileProfiled receives them unchanged for its later holdout runner.
 */
export async function prepareProfiledPlanningState(
  root: string,
  definition: AgentDefinition,
  splits: ProfiledEvalSplits,
): Promise<ProfiledPlanningState> {
  const planningEvals = Object.freeze([...splits.profile, ...splits.development]);
  const buildContexts = await Promise.all(planningEvals.map((fixture) =>
    lowerBuildContext(root, definition, fixtureInput(fixture.input))));
  const contextByEvalID = new Map(planningEvals.map((fixture, index) => [
    fixture.id,
    buildContexts[index]!.ir,
  ]));
  const lowered = await lowerBuildContext(root, definition);
  const baseline = baselinePlan(definition, root, buildContexts.map((item) => item.ir));
  return {
    planningEvals,
    contextByEvalID,
    lowered,
    baseline,
    observedDynamicKinds: evalDynamicKinds(planningEvals),
  };
}

function splitProfiledEvals(evals: readonly EvalDefinition[]): ProfiledEvalSplits {
  const missing = evals.find((fixture) => fixture.split === undefined);
  if (missing !== undefined) {
    throw new Error(`cave_compiler_eval_split_required:${missing.id}`);
  }
  const missingLineage = evals.find((fixture) =>
    typeof fixture.lineageId !== "string" || fixture.lineageId.trim() === "");
  if (missingLineage !== undefined) {
    throw new Error(`cave_compiler_eval_lineage_required:${missingLineage.id}`);
  }
  if (new Set(evals.map((fixture) => fixture.id)).size !== evals.length) {
    throw new Error("cave_compiler_duplicate_eval_id");
  }
  const profile = evals.filter((fixture) => fixture.split === "profile");
  const development = evals.filter((fixture) => fixture.split === "development");
  const holdout = evals.filter((fixture) => fixture.split === "holdout");
  if (development.length === 0 || holdout.length === 0) {
    throw new Error("cave_compiler_eval_split_empty: development and holdout are required");
  }
  const lineageOwner = new Map<string, EvalDefinition["split"]>();
  for (const fixture of evals) {
    const existing = lineageOwner.get(fixture.lineageId!);
    if (existing !== undefined && existing !== fixture.split) {
      throw new Error("cave_compiler_eval_lineage_overlap");
    }
    lineageOwner.set(fixture.lineageId!, fixture.split);
  }
  return { profile, development, holdout };
}

function profileFixtureCeiling(
  model: string,
  contextIR: ContextIR,
  maxOutputTokens: number,
  accountingAt: Date,
): number {
  const inputTokens = Object.values(contextBill(contextIR)).reduce((sum, value) => sum + value, 0);
  const callCeiling = catalogSearchCeiling(model, inputTokens, maxOutputTokens, accountingAt);
  if (callCeiling === undefined) {
    throw new Error(`cave_compiler_profile_model_unpriced:${model}`);
  }
  // Runtime receives this exact USD cap. Reserve several turns for tool loops;
  // provider settlement can still report an overage, which remains visible.
  return roundCompilerUsd(Math.max(0.000001, callCeiling * PROFILE_CALL_RESERVE));
}

async function runProfileFixture(
  root: string,
  entry: string,
  definition: AgentDefinition,
  baseline: CavePlan,
  fixture: EvalDefinition,
  maxCostUsd: number,
): Promise<{ trajectory: NormalizedTrajectory; catalogCostUsd: number }> {
  const selected = {
    ...definition,
    model: baseline.model,
    reasoning: runtimeReasoning(baseline.reasoning),
    // Profiling is paid compiler execution too. Always isolate authored tool
    // closures; fixture mode receives default network/child/credential denial.
    sandbox: "required",
  } as AgentDefinition;
  const accountingStartedAt = new Date();
  const result = await runAgentInternal(selected, fixtureInput(fixture.input), {
    rootDir: root,
    entryPath: entry,
    candidatePlan: baseline,
    sessionId: `profile:${sha256(fixture.id).slice(0, 24)}`,
    conversation: createConversation(),
    maxCostUsd,
    ...(fixture.tools.mode === "live" ? {
      sandboxProfile: await loadEvalSandboxProfile(root, fixture),
    } : {}),
  });
  const accountingFinishedAt = new Date();
  const priced = result.usageBasis === "provider_reported" && result.priceBasis === "public_catalog"
    ? { priced: true, usd: result.costUsd }
    : { priced: false, usd: 0 };
  if (result.usageBasis !== "provider_reported" || result.priceBasis !== "public_catalog" ||
      !priced.priced) {
    throw new Error("cave_compiler_profile_cost_incomplete_after_run");
  }
  const trajectory = normalizeTrajectory(result, {
      split: "profile",
      caseId: fixture.id,
      lineageId: fixture.lineageId!,
      inputSha256: sha256(stableStringify(fixture.input)),
      agentSha256: sha256(definition.id),
      toolEffects: Object.fromEntries(definition.tools.map((tool) => [tool.name, tool.effect])),
    accountingStartedAt,
    accountingFinishedAt,
  });
  if (trajectory.price_basis !== "public_catalog") {
    throw new Error("cave_compiler_profile_price_window_changed");
  }
  return {
    trajectory,
    catalogCostUsd: trajectory.cost_usd,
  };
}

export async function importProfileTrajectories(
  root: string,
  definition: AgentDefinition,
): Promise<NormalizedTrajectory[]> {
  const files: string[] = [];
  for (const pattern of [".caveman/traces/**/*.json", ".caveman/traces/**/*.jsonl"]) {
    for await (const path of glob(pattern, { cwd: root })) files.push(path);
  }
  files.sort();
  if (files.length > MAX_TRACE_FILES) throw new Error("cave_compiler_trace_file_limit");
  if (files.length === 0) return [];
  const traceRoot = await realpath(resolve(root, ".caveman/traces"));
  let totalBytes = 0;
  const rows: NormalizedTrajectory[] = [];
  const toolEffects = Object.fromEntries(definition.tools.map((tool) => [tool.name, tool.effect]));
  for (const relativePath of files) {
    const fullPath = resolve(root, relativePath);
    const relativePathCheck = relative(root, fullPath);
    if (relativePathCheck === ".." || relativePathCheck.startsWith("../") ||
        relativePathCheck.startsWith("..\\") || isAbsolute(relativePathCheck)) {
      throw new Error("cave_compiler_trace_path_escape");
    }
    const canonicalPath = await realpath(fullPath);
    const canonicalRelative = relative(traceRoot, canonicalPath);
    if (canonicalRelative === ".." || canonicalRelative.startsWith("../") ||
        canonicalRelative.startsWith("..\\") || isAbsolute(canonicalRelative)) {
      throw new Error("cave_compiler_trace_path_escape");
    }
    const loaded = await readBoundedTraceFile(canonicalPath, MAX_TRACE_TOTAL_BYTES - totalBytes);
    totalBytes += loaded.bytes;
    const contents = loaded.contents;
    const remainingRows = MAX_TRACE_ROWS - rows.length;
    const values = relativePath.endsWith(".jsonl")
      ? traceJSONLRows(contents, relativePath, remainingRows)
      : traceJSONRows(contents, relativePath);
    if (values.length > remainingRows) throw new Error("cave_compiler_trace_row_limit");
    for (const value of values) {
      const envelope = parseTraceEnvelope(value, relativePath);
      if (envelope.agent_sha256 !== sha256(definition.id)) {
        throw new Error(`cave_compiler_trace_agent_mismatch:${relativePath}`);
      }
      rows.push(normalizeTrajectory(envelope.trace, {
        split: "profile",
        caseId: envelope.case_id,
        lineageId: envelope.lineage_id,
        inputSha256: envelope.input_sha256,
        agentSha256: envelope.agent_sha256,
        toolEffects,
      }));
    }
  }
  return rows;
}

async function readBoundedTraceFile(
  path: string,
  remainingTotalBytes: number,
): Promise<{ contents: string; bytes: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`cave_compiler_trace_not_regular_file:${path}`);
    const allowed = Math.min(MAX_TRACE_FILE_BYTES, remainingTotalBytes);
    if (metadata.size > MAX_TRACE_FILE_BYTES) throw new Error("cave_compiler_trace_file_too_large");
    if (metadata.size > remainingTotalBytes) throw new Error("cave_compiler_trace_total_too_large");
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, allowed + 1 - bytes));
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      if (bytes > MAX_TRACE_FILE_BYTES) throw new Error("cave_compiler_trace_file_too_large");
      if (bytes > remainingTotalBytes) throw new Error("cave_compiler_trace_total_too_large");
      chunks.push(buffer.subarray(0, read.bytesRead));
    }
    try {
      return {
        contents: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)),
        bytes,
      };
    } catch (error) {
      throw new Error(`cave_compiler_trace_utf8_invalid:${path}`, { cause: error });
    }
  } finally {
    await handle.close();
  }
}

/** Profile-only runtime evidence can unlock dynamic history/tool-result candidates. */
export function observedDynamicKindsFromTrajectories(
  trajectories: readonly NormalizedTrajectory[],
): ReadonlySet<ContextKind> {
  const observed = new Set<ContextKind>();
  for (const trajectory of trajectories) {
    if ((trajectory.context_bill.history ?? 0) > 0) observed.add("history");
    if ((trajectory.context_bill.tool_result ?? 0) > 0 || trajectory.tools.length > 0) {
      observed.add("tool_result");
    }
  }
  return observed;
}

function traceJSONRows(contents: string, path: string): unknown[] {
  try {
    const value = JSON.parse(contents) as unknown;
    return Array.isArray(value) ? value : [value];
  } catch (error) {
    throw new Error(`cave_compiler_trace_json_invalid:${path}`, { cause: error });
  }
}

function traceJSONLRows(contents: string, path: string, limit: number): unknown[] {
  const rows: unknown[] = [];
  let lineStart = 0;
  let lineNumber = 0;
  for (let index = 0; index <= contents.length; index++) {
    if (index !== contents.length && contents.charCodeAt(index) !== 10) continue;
    lineNumber++;
    const line = contents.slice(lineStart, index).replace(/\r$/u, "");
    lineStart = index + 1;
    if (line.trim() === "") continue;
    if (rows.length >= limit) throw new Error("cave_compiler_trace_row_limit");
    try {
      rows.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`cave_compiler_trace_json_invalid:${path}:${lineNumber}`, { cause: error });
    }
  }
  return rows;
}

function parseTraceEnvelope(value: unknown, path: string): {
  schema_version: 1;
  case_id: string;
  lineage_id: string;
  input_sha256: string;
  agent_sha256: string;
  trace: unknown;
} {
  if (!isPlainRecord(value) ||
      stableStringify(Object.keys(value).sort()) !==
        stableStringify(["agent_sha256", "case_id", "input_sha256", "lineage_id", "schema_version", "trace"]) ||
      value.schema_version !== 1 || typeof value.case_id !== "string" || value.case_id.trim() === "" ||
      value.case_id.length > 512 ||
      typeof value.lineage_id !== "string" || value.lineage_id.trim() === "" ||
      value.lineage_id.length > 512 ||
      typeof value.input_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.input_sha256) ||
      typeof value.agent_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.agent_sha256) ||
      !("trace" in value)) {
    throw new Error(`cave_compiler_trace_envelope_invalid:${path}`);
  }
  return value as {
    schema_version: 1;
    case_id: string;
    lineage_id: string;
    input_sha256: string;
    agent_sha256: string;
    trace: unknown;
  };
}

async function writeProfiledArtifacts(
  root: string,
  profile: WorkloadProfile,
  result: CompileProfiledResult & { lock: CaveBuildLockV3 },
  profileSource: ProfileSource,
  profileActualCostUsd: number | null,
  estimatedTotalCeilingUsd: number,
): Promise<void> {
  const directory = resolve(root, ".caveman");
  await mkdir(directory, { recursive: true });
  const totalActualCostUsd = result.actual_cost_usd === null || profileActualCostUsd === null
    ? null
    : roundCompilerUsd(profileActualCostUsd + result.actual_cost_usd);
  const holdoutBaselineCostUsd =
    result.lock.validation.holdout.baseline_catalog_cost_usd_per_task;
  const holdoutSelectedCostUsd =
    result.lock.validation.holdout.selected_catalog_cost_usd_per_task;
  const holdoutDeltaUsd = roundCompilerUsd(holdoutBaselineCostUsd - holdoutSelectedCostUsd);
  const breakEvenTasks = totalActualCostUsd !== null && holdoutDeltaUsd > 0
    ? Math.ceil(totalActualCostUsd / holdoutDeltaUsd)
    : null;
  const report = {
    schema_version: 1,
    status: result.status,
    basis: "inferred",
    publishable: false,
    target: "pi",
    build_sha256: result.lock.build_sha256,
    plan_sha256: result.lock.plan_sha256,
    profile: {
      source: profileSource,
      profile_sha256: profile.profile_sha256,
      trajectory_count: profile.partitions.profile.trajectory_count,
      provider_reported_count: profile.partitions.profile.provider_reported_count,
      usage_incomplete_count: profile.partitions.profile.usage_incomplete_count,
    },
    validation: result.lock.validation,
    compiler_passes: result.lock.passes,
    cost: {
      total_estimated_ceiling_usd: estimatedTotalCeilingUsd,
      validation_estimated_ceiling_usd: result.estimated_ceiling_usd,
      profile_actual_catalog_usd: profileActualCostUsd,
      validation_actual_catalog_usd: result.actual_cost_usd,
      total_actual_catalog_usd: totalActualCostUsd,
    },
    economics: {
      basis: "inferred",
      holdout_baseline_catalog_usd_per_task: holdoutBaselineCostUsd,
      holdout_selected_catalog_usd_per_task: holdoutSelectedCostUsd,
      holdout_catalog_delta_usd_per_task: holdoutDeltaUsd,
      break_even_tasks: breakEvenTasks,
    },
    claims: {
      provider_savings_claimed: false,
      verified_savings_usd: 0,
    },
  } as const;
  await atomicWriteJSON(resolve(directory, "workload-profile.json"), profile);
  await atomicWriteJSON(resolve(directory, "build-report.json"), report);
  // Lock is commit marker. Readers never observe a new lock before its bound
  // profile and human-readable report exist.
  await atomicWriteJSON(resolve(directory, "agent.lock.json"), result.lock);
}

async function atomicWriteJSON(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function printProfiledBuildResult(
  result: CompileProfiledResult,
  profileSource: ProfileSource,
  profileRows: number,
  profileActualCostUsd: number | null,
): void {
  const completedRuns = (result.development?.completed_runs ?? 0) +
    (result.holdout?.completed_runs ?? 0);
  const totalActual = result.actual_cost_usd === null || profileActualCostUsd === null
    ? null
    : roundCompilerUsd(profileActualCostUsd + result.actual_cost_usd);
  process.stdout.write([
    `build status: ${result.status}`,
    `profile: ${profileRows} rows from ${profileSource}`,
    `validation runs: ${completedRuns}`,
    totalActual === null
      ? "actual public-catalog cost: unknown (terminal usage evidence incomplete)"
      : `actual public-catalog cost: $${totalActual.toFixed(6)}`,
    ...(result.reason === undefined ? [] : [`reason: ${result.reason}`]),
    ...(result.lock === undefined ? [
      "lock: not written",
      "local evidence: incomplete",
    ] : [
      "lock: .caveman/agent.lock.json",
      "report: .caveman/build-report.json",
      `build: ${result.lock.build_sha256}`,
      `plan: ${result.lock.selected_plan_id}`,
      `passes: ${result.lock.passes.map((pass) => pass.pass_id).join(", ")}`,
      `holdout: ${result.lock.validation.holdout.completed_runs} passed runs`,
      "local evidence: development-selected, untouched-holdout passed (inferred)",
    ]),
    "provider savings: not claimed",
    `next action: ${profiledBuildNextAction(result.status)}`,
    "",
  ].join("\n"));
  if (result.lock === undefined) process.exitCode = 1;
}

function profiledBuildNextAction(status: CompileProfiledResult["status"]): string {
  if (status === "locked") return "run npm run check before deployment";
  if (status === "holdout_failed") return "keep baseline; inspect holdout failures";
  if (status === "capability_refused") return "inspect target identity, sandbox, privacy, and tool-effect conformance";
  if (status === "search_budget_exceeded") return "raise maxSearchCostUsd or narrow candidate models";
  if (status === "needs_eval") return "add independent development and holdout evals";
  if (status === "no_passing_build") return "keep baseline and inspect development evidence";
  if (status === "incomplete_evidence") return "fix missing usage, grader, privacy, or sandbox evidence";
  return "run caveman-agent doctor, then rebuild";
}

function roundCompilerUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e10) / 1e10;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function printBuildResult(result: CompileResult): void {
  process.stdout.write([
    `build status: ${result.status}`,
    `completed: ${result.completed_runs}/${result.planned_runs} runs`,
    result.actual_cost_usd === null
      ? "actual public-catalog cost: unknown (no terminal usage evidence)"
      : `actual public-catalog cost: $${result.actual_cost_usd.toFixed(6)}`,
    ...(result.reason ? [`reason: ${result.reason}`] : []),
    ...(result.lock ? [
      `lock: .caveman/agent.lock.json`,
      `build: ${result.lock.build_sha256}`,
      `plan: ${result.lock.selected_plan_id}`,
      `model: ${result.lock.selected_plan.model} · reasoning ${result.lock.selected_plan.reasoning}`,
      `routes: ${result.lock.selected_plan.segment_routes.length === 0
        ? "pass-through"
        : result.lock.selected_plan.segment_routes.map((route) => route.transform_id).join(" → ")}`,
      `baseline cost/task: ${formatCatalogCost(result.baseline_catalog_cost_usd_per_task)}`,
      `selected cost/task: ${formatCatalogCost(result.selected_catalog_cost_usd_per_task)}`,
      `change: ${formatCatalogChange(
        result.baseline_catalog_cost_usd_per_task,
        result.selected_catalog_cost_usd_per_task,
      )}`,
      `eval runs: ${result.lock.evidence.completed_runs} passed build evidence`,
      "local evidence: passed (estimate only)",
      "provider savings: not claimed",
    ] : [
      "lock: not written",
      "local evidence: incomplete",
      "provider savings: not claimed",
    ]),
    `next action: ${buildNextAction(result.status)}`,
    "",
  ].join("\n"));
  if (!result.lock) process.exitCode = 1;
}

function formatCatalogCost(value: number | undefined): string {
  return value === undefined ? "unavailable" : `$${value.toFixed(6)} public catalog`;
}

function formatCatalogChange(baseline: number | undefined, selected: number | undefined): string {
  if (baseline === undefined || selected === undefined || baseline <= 0) return "unavailable";
  const percentage = ((selected / baseline) - 1) * 100;
  return `${percentage >= 0 ? "+" : ""}${percentage.toFixed(1)}% local estimate`;
}

function buildNextAction(status: CompileResult["status"]): string {
  switch (status) {
    case "locked":
      return "run npm run check before deployment";
    case "needs_eval":
      return "add eval fixtures, then run npm run build";
    case "search_budget_exceeded":
      return "raise maxSearchCostUsd or narrow allowed models, then run npm run build";
    case "no_passing_build":
      return "keep baseline and inspect failing eval evidence";
    case "incomplete_evidence":
      return "fix missing terminal usage or grader evidence, then run npm run build";
  }
}

async function profilePreferredTransforms(
  lowered: Awaited<ReturnType<typeof lowerContext>>,
): Promise<ReadonlyMap<string, string>> {
  const preferred = new Map<string, string>();
  for (const segment of lowered.ir.segments) {
    if (segment.safety !== "S4" ||
        /(?:opaque|signed|signature|jwt|token|cipher|encrypted)/i.test(segment.id)) continue;
    const body = lowered.bodies.get(segment.bodyHandle);
    if (!body) throw new Error(`cave_context_body_missing:${segment.id}`);
    const type = await detectEngineType(body);
    if (/^[a-z0-9-]+$/.test(type) && type !== "unknown") {
      preferred.set(segment.id, `caveman.engine.${type}.v1`);
    }
  }
  return preferred;
}

async function detectEngineType(input: Uint8Array): Promise<string> {
  const command = process.env.CAVEMAN_ENGINE_BIN ?? "caveman-engine";
  return new Promise((accept, reject) => {
    const child = spawn(command, ["detect"], {
      env: buildEngineEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(value ?? "");
    };
    const terminate = (error: Error): void => {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      finish(error);
    };
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > 64 * 1024) {
        terminate(new Error("engine_detect_output_limit"));
        return;
      }
      target.push(chunk);
    };
    const timeoutMS = engineDetectTimeoutMS();
    const timer = setTimeout(() => terminate(new Error("engine_detect_timeout")), timeoutMS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`engine_detect_exit_${code}:${Buffer.concat(stderr).toString("utf8").slice(0, 256)}`));
        return;
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8").trim());
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

function engineDetectTimeoutMS(): number {
  const value = Number(process.env.CAVE_AGENT_ENGINE_DETECT_TIMEOUT_MS ?? 10_000);
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000 ? value : 10_000;
}

function configuredModelCandidates(baseline: string): string[] {
  const models = new Set<string>([baseline]);
  if (process.env.ANTHROPIC_API_KEY) models.add("anthropic/claude-haiku-4-5");
  if (process.env.OPENAI_API_KEY) models.add("openai/gpt-5.4-mini");
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) models.add("google/gemini-2.5-flash");
  return [...models].sort();
}

async function check(args: string[]): Promise<void> {
  const root = process.cwd();
  const configPath = args[0] ?? "caveman.config.ts";
  const loaded = await loadBuildInputs(root, configPath);
  let lock: AnyCaveBuildLock;
  try {
    lock = await readLock(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("cave_build_lock_missing: add eval fixtures, then run npm run build");
    }
    throw error;
  }
  const checked = await checkCurrentLock(root, lock, loaded);
  if (!checked.valid) {
    throw new Error(`cave_stale_lock:${checked.stale.join(",")}: run npm run build to relock`);
  }
  process.stdout.write([
    `lock valid: ${lock.build_sha256}`,
    `plan: ${lock.selected_plan_id}`,
    `catalog cost/task: $${lock.evidence.catalog_cost_usd_per_task.toFixed(6)}`,
    ...(lock.schema_version === 3 ? [
      `profile: ${lock.compiler.profile_sha256}`,
      `holdout: ${lock.validation.holdout.completed_runs} passed runs`,
      `target: ${lock.capability_manifest.target}`,
    ] : []),
    "local evidence: passed (estimate only)",
    "provider savings: not claimed",
    "",
  ].join("\n"));
}

type LoadedBuildInputs = {
  config: BuildConfig;
  agent: AgentDefinition;
  evals: EvalDefinition[];
  sourceSha256: string;
  /** Absolute effective entry: the configured file, or a convention directory's generated entry. */
  entryPath: string;
};

const PACKAGE_STATE_FILES = [
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

async function loadBuildInputs(
  root: string,
  configPath: string,
  beforeSourceHash?: (
    inputs: Omit<LoadedBuildInputs, "sourceSha256">,
  ) => Promise<void>,
  // Regenerating the convention's module entry is correct against the real
  // project root but wrong inside a dev-staged snapshot (its temp basename
  // would pin the wrong id) — the staged copy already carries the generated
  // entry, so the dev path passes false and just imports it.
  regenerateDirEntry = true,
): Promise<LoadedBuildInputs> {
  const configAbsolute = resolve(root, configPath);
  const imported = await importFresh(configAbsolute) as { default?: BuildConfig; config?: BuildConfig };
  const config = imported.default ?? imported.config;
  if (!config || config.lock !== "strict" || config.sandbox !== "required") {
    throw new Error("caveman build: config must use strict lock and required sandbox");
  }
  const requestedEntry = resolve(root, config.entry);
  const entryAbsolute = await conventionEntryPath(requestedEntry);
  const agent = entryAbsolute !== requestedEntry && regenerateDirEntry
    ? await loadAgentDir(requestedEntry)
    : await loadAgent(entryAbsolute);
  const evalFiles: string[] = [];
  for await (const path of glob(config.evals, { cwd: root })) evalFiles.push(resolve(root, path));
  evalFiles.sort();
  const evals: EvalDefinition[] = [];
  for (const path of evalFiles) {
    const module = await importFresh(path) as Record<string, unknown>;
    for (const value of Object.values(module)) {
      if (isEval(value)) evals.push(value);
    }
  }
  await beforeSourceHash?.({ config, agent, evals, entryPath: entryAbsolute });
  const sourceFiles = new Set<string>([configAbsolute, entryAbsolute, ...evalFiles]);
  for (const path of await projectSourceFiles(root)) sourceFiles.add(path);
  for (const source of agentFileSourcePaths(agent)) {
    sourceFiles.add(resolve(root, source));
  }
  for (const fixture of evals) {
    if (fixture.tools.sandbox) sourceFiles.add(resolve(root, fixture.tools.sandbox));
  }
  for (const name of PACKAGE_STATE_FILES) {
    const path = resolve(root, name);
    try {
      await readFile(path);
      sourceFiles.add(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const sourceSha256 = await sourceGraphSHA256(root, sourceFiles);
  return { config, agent, evals, sourceSha256, entryPath: entryAbsolute };
}

async function validLockIdentity(
  root: string,
  entry: string,
  expectedAgent?: AgentDefinition,
  beforeSourceHash?: Parameters<typeof loadBuildInputs>[2],
  regenerateDirEntry = true,
): Promise<AnyCaveBuildLock | undefined> {
  try {
    const lock = await readLock(root);
    const loaded = await loadBuildInputs(
      root,
      "caveman.config.ts",
      beforeSourceHash,
      regenerateDirEntry,
    );
    if (loaded.entryPath !== await conventionEntryPath(resolve(root, entry))) {
      throw new Error("cave_stale_lock:entry");
    }
    if (expectedAgent !== undefined &&
        agentDefinitionSHA256(loaded.agent) !== agentDefinitionSHA256(expectedAgent)) {
      throw new Error("cave_stale_lock:dev_snapshot");
    }
    const checked = await checkCurrentLock(root, lock, loaded);
    if (!checked.valid) throw new Error(`cave_stale_lock:${checked.stale.join(",")}: run npm run build to relock`);
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function checkCurrentLock(
  root: string,
  lock: AnyCaveBuildLock,
  loaded: LoadedBuildInputs,
): Promise<{ valid: boolean; stale: string[] }> {
  const transformRegistrySha256 = await transformRegistrySHA256();
  const contextIRSha256 = contextIRSHA256(await lowerBuildContext(
    root,
    loaded.agent,
  ).then((value) => value.ir));
  if (lock.schema_version === 2) {
    return checkLock(lock, {
      sourceSha256: loaded.sourceSha256,
      agentDefinitionSha256: agentDefinitionSHA256(loaded.agent),
      contextIRSha256,
      evalSuiteSha256: sha256(stableStringify(loaded.evals)),
      runtimeVersion: FRAMEWORK_VERSION,
      adapterVersion: PI_ADAPTER_VERSION,
      upstreamVersion: PI_UPSTREAM_VERSION,
      transformRegistrySha256,
      catalogSha256: CATALOG_SHA256,
    });
  }

  const stale: string[] = [];
  const target = nativePiCompilerTarget();
  try {
    assertProfiledBuildTarget(lock, target);
  } catch {
    stale.push("target");
  }
  if (lock.source_sha256 !== loaded.sourceSha256) stale.push("source");
  if (lock.agent_definition_sha256 !== agentDefinitionSHA256(loaded.agent)) {
    stale.push("agent_definition");
  }
  if (lock.context_ir_sha256 !== contextIRSha256) stale.push("context_ir");
  if (lock.eval_suite_sha256 !== profiledEvalSuiteSHA256(loaded.evals)) stale.push("eval_suite");
  if (lock.runtime.caveman_version !== FRAMEWORK_VERSION) stale.push("runtime");
  if (lock.runtime.transform_registry_sha256 !== transformRegistrySha256) {
    stale.push("transform_registry");
  }
  if (lock.runtime.external_provenance_sha256 !== "") stale.push("external_provenance");
  if (lock.catalog_sha256 !== CATALOG_SHA256) stale.push("catalog");
  if (lock.compiler.policy_sha256 !== buildPolicySHA256(loaded.config)) {
    stale.push("policy");
  }
  try {
    const profile = parseWorkloadProfile(JSON.parse(await readFile(
      resolve(root, ".caveman/workload-profile.json"),
      "utf8",
    )));
    if (lock.compiler.profile_sha256 !== profile.profile_sha256) stale.push("profile");
    if (lock.compiler.profile_partition_sha256 !== profile.partitions.profile.split_sha256) {
      stale.push("profile_partition");
    }
  } catch {
    stale.push("profile");
  }
  return { valid: stale.length === 0, stale: [...new Set(stale)] };
}

function profiledEvalSuiteSHA256(evals: readonly EvalDefinition[]): string {
  const development = evals.filter((fixture) => fixture.split === "development");
  const holdout = evals.filter((fixture) => fixture.split === "holdout");
  return sha256(stableStringify({
    development: sha256(stableStringify(development)),
    holdout: sha256(stableStringify(holdout)),
  }));
}

function lowerBuildContext(root: string, definition: AgentDefinition, input?: string) {
  return lowerAgentContext(definition, {
    rootDir: root,
    ...(input === undefined ? {} : { input }),
  });
}

async function transformRegistrySHA256(): Promise<string> {
  return (await loadTransformRegistry()).sha256;
}

async function loadTransformRegistry(): Promise<{
  sha256: string;
  capabilities: TransformCapability[];
}> {
  const command = process.env.CAVEMAN_ENGINE_BIN ?? "caveman-engine";
  try {
    const { stdout } = await execFileAsync(command, ["registry"], {
      encoding: "utf8",
      env: buildEngineEnv(),
      maxBuffer: 2 << 20,
      timeout: 10_000,
    });
    const parsed = JSON.parse(stdout) as {
      registry_sha256?: unknown;
      capabilities?: Array<{
        transform_id?: unknown;
        eligible_segment_kinds?: unknown;
      }>;
    };
    if (typeof parsed.registry_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.registry_sha256)) {
      throw new Error("registry output has no valid registry_sha256");
    }
    if (!Array.isArray(parsed.capabilities) || parsed.capabilities.length === 0) {
      throw new Error("registry output has no capabilities");
    }
    const capabilities = parsed.capabilities.map((capability): TransformCapability => {
      if (typeof capability.transform_id !== "string" ||
          !Array.isArray(capability.eligible_segment_kinds) ||
          capability.eligible_segment_kinds.some((kind) => typeof kind !== "string")) {
        throw new Error("registry output has invalid capability");
      }
      return {
        transformID: capability.transform_id,
        segmentKinds: capability.eligible_segment_kinds as TransformCapability["segmentKinds"],
      };
    });
    return { sha256: parsed.registry_sha256, capabilities };
  } catch (error) {
    throw new Error(
      `cave_transform_registry_unavailable: run caveman setup or set CAVEMAN_ENGINE_BIN (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function runtimeReasoning(value: CavePlan["reasoning"]): AgentDefinition["reasoning"] {
  return value === "none" ? "off" : value;
}

function baselinePlan(definition: AgentDefinition, root: string, contexts: readonly ContextIR[]): CavePlan {
  const model = typeof definition.model === "string"
    ? definition.model
    : process.env.CAVE_MODEL ?? localProviderModel(root) ?? detectedModel();
  const bills = contexts.map(contextBill);
  const max = (kinds: readonly string[]) => Math.max(0, ...bills.map((bill) =>
    kinds.reduce((sum, kind) => sum + (bill[kind] ?? 0), 0)));
  return {
    schema_version: 1,
    plan_id: "baseline.pass-through",
    model,
    reasoning: definition.reasoning === "off" ? "none" : definition.reasoning,
    segment_routes: [],
    budgets: {
      instructions: max(["instruction"]),
      tools: max(["tool_schema"]),
      memory: max(["memory"]),
      history: Math.max(max(["history"]), (definition.output?.maxTokens ?? 2_000) * 2),
      results_artifacts: Math.max(
        max(["artifact", "skill", "tool_result"]),
        definition.tools.length * (definition.output?.maxTokens ?? 2_000) * 2,
      ),
      reasoning: definition.reasoning === "off" ? 0 : definition.output?.maxTokens ?? 2_000,
      output: definition.output?.maxTokens ?? 2_000,
      retry_cascade_reserve: Math.max(256, Math.ceil(max(["history", "tool_result"]) * 0.1)),
    },
    recovery: { namespace: definition.id, tools: [] },
    fallbacks: { unknown: "original", transform_error: "original", not_smaller: "original" },
  };
}

function evalDynamicKinds(evals: readonly EvalDefinition[]): ReadonlySet<ContextKind> {
  const kinds = new Set<ContextKind>();
  if (evals.some((fixture) => fixture.quality.some((grader) => grader.type === "tool_called"))) {
    kinds.add("history");
    kinds.add("tool_result");
  }
  return kinds;
}

function localProviderModel(root: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, ".caveman/provider.json"), "utf8")) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("caveman build: invalid .caveman/provider.json");
  }
}

function detectedModel(): string {
  const configured = [
    process.env.ANTHROPIC_API_KEY && "anthropic/claude-haiku-4-5",
    process.env.OPENAI_API_KEY && "openai/gpt-5.4-mini",
    (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) && "google/gemini-2.5-flash",
  ].filter((value): value is string => typeof value === "string");
  if (configured.length !== 1) {
    throw new Error("caveman build: set CAVE_MODEL when zero or multiple provider credentials exist");
  }
  return configured[0]!;
}

async function loadAgent(path: string): Promise<AgentDefinition> {
  return agentFromImported(await importFresh(path));
}

function agentFromImported(imported: unknown): AgentDefinition {
  const exported = imported as { default?: AgentDefinition; agent?: AgentDefinition };
  const definition = exported.default ?? exported.agent;
  if (!definition || definition.kind !== "agent") throw new Error("caveman agent: entry must export default agent()");
  return definition;
}

async function readLock(root: string): Promise<AnyCaveBuildLock> {
  return parseAnyCaveBuildLock(JSON.parse(
    await readFile(resolve(root, ".caveman/agent.lock.json"), "utf8"),
  ));
}

const retainedImports: LoadedDevModule[] = [];

async function importFresh(path: string): Promise<unknown> {
  const extension = extname(path);
  const projectRelative = relative(process.cwd(), path);
  if ([".ts", ".mts", ".cts"].includes(extension) &&
      projectRelative !== ".." && !projectRelative.startsWith("../") &&
      !projectRelative.startsWith("..\\") && !isAbsolute(projectRelative)) {
    const loaded = await loadDevModule(process.cwd(), path);
    retainedImports.push(loaded);
    return loaded.imported;
  }
  return import(`${pathToFileURL(path).href}?cave=${Date.now()}-${crypto.randomUUID()}`);
}

function isEval(value: unknown): value is EvalDefinition {
  return value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === "eval";
}

function fixtureInput(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatBill(bill: Record<string, number>): string {
  return Object.entries(bill).sort(([a], [b]) => a.localeCompare(b)).map(([kind, tokens]) => `${kind}=${tokens}`).join(" ");
}

main().finally(async () => {
  await Promise.all(retainedImports.splice(0).map((loaded) => loaded.dispose()));
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`caveman-agent: ${message}\n`);
  process.exitCode = 1;
});
