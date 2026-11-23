// This machine: one `caveman-runtime agent exec` per session, the way Claude's SDK drives the `claude` binary. The
// runtime is the closed harness; this file only starts it and carries the session's events over stdin and stdout
// (docs/, "Local host"). No daemon, no port, no token file.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

import type { Transport } from "./session.ts";
import { CavemanError, type SessionEvent, type UserEvent } from "./types.ts";

/** The model endpoint a local session pays: a provider, the Caveman gateway, or any compatible endpoint. */
export interface ModelEndpoint {
  /** An Anthropic Messages or OpenAI-compatible base URL. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** The family, when the base URL doesn't say (a proxy). Classes (`fast`, `base`, `frontier`) resolve within it. */
  readonly provider?: "anthropic" | "openai" | "openrouter";
}

export interface LocalStart {
  readonly cwd: string;
  /** A name under `<cwd>/.caveman/agents`, or an agent file's text. */
  readonly agent: { readonly name: string } | { readonly file: string };
  readonly task: string;
  readonly model?: string;
  readonly maxCostUsd?: number;
  readonly maxSeconds?: number;
  readonly access?: "full" | "auto" | "ask";
}

export interface LocalOptions {
  /** The `caveman-runtime` to run: a binary, or a .js/.ts entry run with this Node. Else CAVEMAN_RUNTIME, else PATH. */
  readonly runtime?: string;
  readonly model?: ModelEndpoint;
  readonly env?: NodeJS.ProcessEnv;
}

/** Where a provider's own key is read from when no endpoint is given, in order. */
const PROVIDER_KEYS = [
  { variable: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com", provider: "anthropic" },
  { variable: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", provider: "openai" },
  { variable: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", provider: "openrouter" },
] as const;

/**
 * The endpoint a session pays, and the variable it came from: the one given, else CAVEMAN_MODEL_BASE_URL and
 * CAVEMAN_MODEL_API_KEY, else the first provider key set in the environment.
 */
export function resolveModel(given: ModelEndpoint | undefined, env: NodeJS.ProcessEnv): { readonly endpoint: ModelEndpoint; readonly from?: string } {
  if (given !== undefined) return { endpoint: given };
  const baseUrl = env.CAVEMAN_MODEL_BASE_URL?.trim();
  const apiKey = env.CAVEMAN_MODEL_API_KEY?.trim();
  if (baseUrl && apiKey) {
    const provider = env.CAVEMAN_MODEL_PROVIDER?.trim();
    return { endpoint: { baseUrl, apiKey, ...(provider === "anthropic" || provider === "openai" || provider === "openrouter" ? { provider } : {}) }, from: "CAVEMAN_MODEL_API_KEY" };
  }
  for (const { variable, baseUrl: url, provider } of PROVIDER_KEYS) {
    const key = env[variable]?.trim();
    if (key) return { endpoint: { baseUrl: url, apiKey: key, provider }, from: variable };
  }
  throw new CavemanError(
    "model_missing",
    "No model to run on: pass new Caveman({ model: { baseUrl, apiKey } }), set CAVEMAN_MODEL_BASE_URL and CAVEMAN_MODEL_API_KEY, or set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY.",
  );
}

/** How to start the runtime: a binary as is, a script with this Node. */
export function runtimeCommand(runtime: string | undefined, env: NodeJS.ProcessEnv): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const target = runtime ?? (env.CAVEMAN_RUNTIME?.trim() || "caveman-runtime");
  return /\.(c|m)?(j|t)s$/.test(target) ? { command: process.execPath, args: [target] } : { command: target, args: [] };
}

/** The exit codes of `agent exec` (C5): what each one means as a stop reason. */
const EXIT_STOP: Readonly<Record<number, { readonly stop: "end_turn" | "error" | "budget_reached"; readonly code?: string }>> = {
  0: { stop: "end_turn" },
  1: { stop: "error", code: "agent_failed" },
  2: { stop: "error", code: "usage" },
  3: { stop: "budget_reached", code: "budget_reached" },
  4: { stop: "error", code: "out_of_time" },
};

export function startLocal(start: LocalStart, options: LocalOptions): Transport {
  const env = options.env ?? process.env;
  const { endpoint, from } = resolveModel(options.model, env);
  const { command, args: lead } = runtimeCommand(options.runtime, env);
  const cannotStart = (error: Error) => `Could not start ${command}: ${error.message}. Install the Caveman runtime or pass new Caveman({ runtime }).`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-session-"));
  let child: ChildProcessWithoutNullStreams;
  try {
    const taskFile = path.join(scratch, "task.md");
    fs.writeFileSync(taskFile, start.task, { mode: 0o600 });
    let agentArgs: Array<string>;
    if ("file" in start.agent) {
      const agentFile = path.join(scratch, "agent.md");
      fs.writeFileSync(agentFile, start.agent.file, { mode: 0o600 });
      agentArgs = ["--agent-file", agentFile];
    } else {
      agentArgs = ["--agent", start.agent.name];
    }
    const args = [
      ...lead,
      "agent", "exec",
      "--cwd", start.cwd,
      ...agentArgs,
      "--task-file", taskFile,
      "--events", "-",
      "--input", "-",
      ...(start.model === undefined ? [] : ["--model", start.model]),
      ...(start.maxCostUsd === undefined ? [] : ["--max-cost-usd", String(start.maxCostUsd)]),
      ...(start.maxSeconds === undefined ? [] : ["--max-seconds", String(Math.ceil(start.maxSeconds))]),
      ...(start.access === undefined ? [] : ["--access", start.access]),
    ];
    // The key never sits in an environment, where any process of the same user could read it back (`ps eww`,
    // /proc/<pid>/environ): it goes in an owner-only file the runtime reads once and deletes. Neither it nor the
    // variable the SDK read it from is passed on, so the agent's own commands can't find it.
    const keyFile = path.join(scratch, "model-key");
    fs.writeFileSync(keyFile, endpoint.apiKey, { mode: 0o600 });
    const childEnv: NodeJS.ProcessEnv = { ...env };
    if (from !== undefined) delete childEnv[from];
    delete childEnv.CAVEMAN_MODEL_API_KEY;
    childEnv.CAVEMAN_MODEL_API_KEY_FILE = keyFile;
    childEnv.CAVEMAN_MODEL_BASE_URL = endpoint.baseUrl;
    if (endpoint.provider !== undefined) childEnv.CAVEMAN_MODEL_PROVIDER = endpoint.provider;
    else delete childEnv.CAVEMAN_MODEL_PROVIDER;

    try {
      child = spawn(command, args, { cwd: start.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      throw new CavemanError("runtime_unavailable", cannotStart(error as Error));
    }
  } catch (error) {
    // No runtime will read and delete the key file, and no events() will clean up after it: the files go now. A
    // removal that fails too must not hide why the start failed.
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
    throw error;
  }
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    child.once("error", (error) => resolve({ code: null, error }));
    child.once("close", (code) => resolve({ code }));
  });
  child.stdin.on("error", () => undefined); // a runtime that already ended; its exit says why

  async function* events(): AsyncGenerator<SessionEvent> {
    let seq = 0;
    let terminated = false;
    const synthetic = (type: string, data: Record<string, unknown>): SessionEvent =>
      ({ seq: ++seq, type, created_at: new Date().toISOString(), data }) as SessionEvent;
    try {
      for await (const text of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (text.trim() === "") continue;
        let event: SessionEvent;
        try {
          event = JSON.parse(text) as SessionEvent;
        } catch {
          continue; // stdout carries only events; anything else is not ours to read
        }
        seq = Math.max(seq, event.seq);
        if (event.type === "session.status" && event.data.status === "terminated") terminated = true;
        yield event;
      }
      const { code, error } = await exited;
      if (!terminated) {
        // The runtime ended without saying so: say it, with what it printed.
        const meaning = code === null ? undefined : EXIT_STOP[code];
        if (error !== undefined || meaning?.code !== undefined || meaning === undefined) {
          const message = error !== undefined ? cannotStart(error) : stderr.trim() || `caveman-runtime agent exec exited with ${code}.`;
          yield synthetic("session.error", { code: error !== undefined ? "runtime_unavailable" : meaning?.code ?? "runtime_failed", message });
        }
        yield synthetic("session.status", { status: "terminated", stop_reason: meaning?.stop ?? "error" });
      }
    } finally {
      // Session stops reading on the terminal event, before the child necessarily exits.
      // Do not resolve its result or remove files until that runtime releases its handles.
      if (terminated) await exited;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  const send = async (event: UserEvent & { readonly input_id?: string }) => {
    if (child.stdin.writableEnded || child.exitCode !== null) throw new CavemanError("session_ended", "The session has ended.");
    // A write fails only when the runtime has gone, and its input with it.
    await new Promise<void>((resolve, reject) => child.stdin.write(`${JSON.stringify(event)}\n`, (error) => (error ? reject(new CavemanError("session_ended", "The session has ended.")) : resolve())));
  };

  return {
    id: `local_${randomUUID()}`,
    events: events(),
    message: async (text) => {
      const input = randomUUID();
      await send({ type: "user.message", text, input_id: input });
      return input;
    },
    send,
    close: async () => {
      if (!child.stdin.writableEnded) child.stdin.end();
    },
    kill: () => {
      if (child.exitCode === null) child.kill("SIGTERM");
    },
  };
}
