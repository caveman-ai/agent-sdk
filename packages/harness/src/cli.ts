/**
 * `harness run …` per the harness/rig contract; `harness loadout <spec>` prints
 * the name and hash `run` will report (version.loadout_name / loadout_hash:
 * the loadout as given), the behavior_hash and the normalized loadout
 * (`canonical`); `harness --version`.
 * Exit 0 whenever the agent ran (finished, stopped or a provider error);
 * 1 on a harness crash; 2 on a bad invocation (bad args, loadout, model, env).
 */
import { readMcpConfig, type McpServerConfig } from "./mcp.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { commandUser, createEnv, loadEnvVars } from "./env/index.ts";
import type { ExecEnv } from "./env/types.ts";
import { canonicalJson, readLoadout, type LoadedLoadout } from "./loadout.ts";
import { EFFORTS, type Effort } from "./models.ts";
import { runHarness } from "./run.ts";
import { SNAPSHOT_MODES, type SnapshotMode } from "./snapshot.ts";

declare const HARNESS_VERSION: string | undefined;
const VERSION = typeof HARNESS_VERSION === "string" ? HARNESS_VERSION : "0.1.0-source";

const USAGE = `usage: harness run --prompt-file <path> --model <provider/id> --effort <${EFFORTS.join("|")}>
         --loadout <name|file.json> --env <local:<cwd>|docker:<container>:<cwd>> --trace <out.jsonl> --result <out.json>
         [--transcript <out.jsonl>] (every model-visible message, for trace mining; never changes the run)
         [--openai-base-url URL] [--anthropic-base-url URL] [--api-key-env VAR]
         [--env-file <json|KEY=VALUE file>] [--env-json '{"K":"V"}'] (variables for every command: the image's ENV)
         [--user NAME] (docker: the user commands run as; default $HARNESS_DOCKER_USER, else the container's user;
                        fails if not honoured)
         [--max-usd N] [--max-wall-s N] [--max-requests N] [--max-tokens N] [--faux-script file.json]
         [--finish-snapshot fired|always] [--snapshot-dir DIR] [--snapshot-max-mb N] (the workspace at the first finish
                        attempt as DIR/first-finish.tgz, default DIR = result.json's; never changes a request)
         [--mcp-config <file>] (Claude Code's {"mcpServers": {...}} format; stdio servers, connected on the host)
         [--scripts-dir <dir>] (saved scripts for a program tool with limits.scripts; kept on the host)
         [--followups <file.json>] ({"messages": [...]}: a session; each is sent after the previous turn's final answer)
         [--on-turn-end <cmd>] (after each turn, on the host: sh -c <cmd>, HARNESS_TURN=<n>, the turn's final text on stdin)
       harness loadout <name|file.json>
       harness --version`;

/** sha256 of the running bundle; "source" when run from TypeScript sources. */
function bundleSha256(): string {
  const self = fileURLToPath(import.meta.url);
  if (!self.endsWith(".mjs")) return "source";
  return createHash("sha256").update(readFileSync(self)).digest("hex");
}

function failInvocation(message: string, resultPath: string | undefined, fields: Record<string, unknown> = {}): never {
  process.stderr.write(`harness: ${message}\n`);
  if (resultPath !== undefined) {
    writeFileSync(resultPath, `${JSON.stringify({
      schema: 1, status: "error", stop_reason: "invalid_invocation", error: message,
      version: { bundle_sha256: bundleSha256(), loadout_hash: "", loadout_name: "", behavior_hash: "" }, ...fields,
    }, null, 2)}\n`);
  }
  process.exit(2);
}

const number = (value: string | undefined, flag: string, resultPath?: string): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) failInvocation(`${flag} wants a positive number, got ${JSON.stringify(value)}`, resultPath);
  return parsed;
};

async function run(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      options: {
        "prompt-file": { type: "string" }, model: { type: "string" }, effort: { type: "string" }, loadout: { type: "string" },
        env: { type: "string" }, trace: { type: "string" }, result: { type: "string" }, transcript: { type: "string" },
        "env-file": { type: "string" }, "env-json": { type: "string" }, user: { type: "string" },
        "openai-base-url": { type: "string" }, "anthropic-base-url": { type: "string" }, "api-key-env": { type: "string" },
        "max-usd": { type: "string" }, "max-wall-s": { type: "string" }, "max-requests": { type: "string" }, "max-tokens": { type: "string" },
        "faux-script": { type: "string" },
        "finish-snapshot": { type: "string" }, "snapshot-dir": { type: "string" }, "snapshot-max-mb": { type: "string" },
        "mcp-config": { type: "string" }, "scripts-dir": { type: "string" }, followups: { type: "string" }, "on-turn-end": { type: "string" },
      },
    });
  } catch (error) {
    failInvocation(`${(error as Error).message}\n${USAGE}`, undefined);
  }
  const values = parsed.values;
  const resultPath = values.result;
  for (const flag of ["prompt-file", "model", "effort", "loadout", "env"] as const) {
    if (values[flag] === undefined) failInvocation(`missing --${flag}\n${USAGE}`, resultPath);
  }
  const effort = values.effort as Effort;
  if (!EFFORTS.includes(effort)) failInvocation(`--effort wants one of ${EFFORTS.join(", ")}`, resultPath);
  let prompt: string;
  try {
    prompt = readFileSync(values["prompt-file"]!, "utf8");
  } catch (error) {
    failInvocation(`cannot read --prompt-file: ${(error as Error).message}`, resultPath);
  }
  let loaded: LoadedLoadout;
  try {
    loaded = readLoadout(values.loadout!);
  } catch (error) {
    failInvocation((error as Error).message, resultPath);
  }
  const budgets = {
    ...(values["max-usd"] === undefined ? {} : { usd: number(values["max-usd"], "--max-usd", resultPath)! }),
    ...(values["max-wall-s"] === undefined ? {} : { wall_s: number(values["max-wall-s"], "--max-wall-s", resultPath)! }),
    ...(values["max-requests"] === undefined ? {} : { requests: Math.floor(number(values["max-requests"], "--max-requests", resultPath)!) }),
    ...(values["max-tokens"] === undefined ? {} : { tokens: Math.floor(number(values["max-tokens"], "--max-tokens", resultPath)!) }),
  };
  const snapshotMode = values["finish-snapshot"] as SnapshotMode | undefined;
  if (snapshotMode !== undefined && !SNAPSHOT_MODES.includes(snapshotMode)) failInvocation(`--finish-snapshot wants one of ${SNAPSHOT_MODES.join(", ")}`, resultPath);
  const snapshotMaxMb = number(values["snapshot-max-mb"], "--snapshot-max-mb", resultPath);
  const finishSnapshot = {
    ...(snapshotMode === undefined ? {} : { mode: snapshotMode }),
    ...(values["snapshot-dir"] === undefined ? {} : { dir: values["snapshot-dir"] }),
    ...(snapshotMaxMb === undefined ? {} : { maxMb: snapshotMaxMb }),
  };
  let mcpServers: Record<string, McpServerConfig> | undefined;
  if (values["mcp-config"] !== undefined) {
    try {
      mcpServers = readMcpConfig(values["mcp-config"]);
    } catch (error) {
      failInvocation(`--mcp-config: ${(error as Error).message}`, resultPath);
    }
  }
  let followups: string[] | undefined;
  if (values.followups !== undefined) {
    try {
      const raw: unknown = JSON.parse(readFileSync(values.followups, "utf8"));
      const messages = typeof raw === "object" && raw !== null ? (raw as { messages?: unknown }).messages : undefined;
      if (!Array.isArray(messages) || !messages.every((item) => typeof item === "string" && item.trim() !== "")) throw new Error('want {"messages": ["...", ...]}');
      followups = messages as string[];
    } catch (error) {
      failInvocation(`--followups: ${(error as Error).message}`, resultPath);
    }
  }
  const turnHook = values["on-turn-end"];
  const onTurnEnd = turnHook === undefined ? undefined : (turn: number, finalText: string) => new Promise<void>((resolve) => {
    const child = spawn("sh", ["-c", turnHook], { env: { ...process.env, HARNESS_TURN: String(turn) }, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", (error) => { process.stderr.write(`--on-turn-end: ${error.message}\n`); resolve(); });
    child.on("close", (code) => { if (code !== 0) process.stderr.write(`--on-turn-end exited ${code} after turn ${turn}\n`); resolve(); });
    child.stdin.end(finalText);
  });
  const user = commandUser(values.env!, values.user);
  let env: ExecEnv;
  try {
    env = await createEnv(values.env!, { vars: loadEnvVars(values["env-file"], values["env-json"]), ...(user === undefined ? {} : { user }) });
  } catch (error) {
    failInvocation((error as Error).message, resultPath, { model: values.model, effort });
  }
  const abort = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => abort.abort(new Error(signal));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let exitCode: number;
  try {
    const result = await runHarness({
      prompt, model: values.model!, effort, loadout: loaded.loadout, loadoutHash: loaded.loadoutHash, env, budgets, bundleSha256: bundleSha256(), signal: abort.signal,
      ...(values.trace === undefined ? {} : { tracePath: values.trace }),
      ...(values.transcript === undefined ? {} : { transcriptPath: values.transcript }),
      ...(resultPath === undefined ? {} : { resultPath }),
      ...(Object.keys(finishSnapshot).length === 0 ? {} : { finishSnapshot }),
      ...(mcpServers === undefined ? {} : { mcpServers }),
      ...(values["scripts-dir"] === undefined ? {} : { scriptsDir: values["scripts-dir"] }),
      ...(followups === undefined ? {} : { followups }), ...(onTurnEnd === undefined ? {} : { onTurnEnd }),
      modelOptions: {
        ...(values["openai-base-url"] === undefined ? {} : { openaiBaseUrl: values["openai-base-url"] }),
        ...(values["anthropic-base-url"] === undefined ? {} : { anthropicBaseUrl: values["anthropic-base-url"] }),
        ...(values["api-key-env"] === undefined ? {} : { apiKeyEnv: values["api-key-env"] }),
        ...(values["faux-script"] === undefined ? {} : { fauxScript: values["faux-script"] }),
      },
    });
    process.stderr.write(`harness: ${result.status} (${result.stop_reason}) requests=${result.usage.requests} tools=${result.tools.calls} wall=${result.timing.wall_s}s${result.error === undefined ? "" : ` error=${result.error}`}\n`);
    exitCode = result.stop_reason === "harness_error" ? 1 : 0;
  } catch (error) {
    await env.close();
    failInvocation((error as Error).message, resultPath, { model: values.model, effort });
  }
  await env.close();
  return exitCode;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (command === "run") return await run(rest);
  if (command === "loadout" && rest[0] !== undefined) {
    const loaded = readLoadout(rest[0]);
    // `hash` and `name` are exactly what `run` reports as version.loadout_hash and version.loadout_name (the rig pins them).
    process.stdout.write(`${JSON.stringify({
      name: loaded.name, hash: loaded.loadoutHash, loadout_hash: loaded.loadoutHash, behavior_hash: loaded.behaviorHash,
      canonical: JSON.parse(canonicalJson(loaded.loadout)),
    }, null, 2)}\n`);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
  process.stderr.write(`harness: crash: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
