// The SDK's front door: `new Caveman()` runs agents on this machine, `new Caveman({ apiKey })` on Caveman Cloud,
// with the same calls. `run()` is the efficient path: start on a cheap model, check the work, and move up a model
// only when the check fails (docs/, "Efficiency is the product").

import { spawn } from "node:child_process";

import { Agents } from "@caveman-ai/sdk/agents";

import { agentFileText, handlersOf, type AgentDefinition } from "./agent.ts";
import { runCloudAutomation, runLocalAutomation, type AutomationRunOptions, type AutomationRunResult } from "./automations.ts";
import { startCloud } from "./cloud.ts";
import { startLocal, type ModelEndpoint } from "./local.ts";
import { Session, type AskHandlers, type SessionResult } from "./session.ts";
import type { Tool } from "./tool.ts";
import { CavemanError, ZERO_USAGE, type Usage } from "./types.ts";

export interface CavemanOptions {
  /** A Caveman Cloud `code:run` key: sessions run on Cloud. Without one they run on this machine. */
  readonly apiKey?: string;
  /** The Cloud API origin. Default https://api.caveman.so. */
  readonly cloudUrl?: string;
  /** This machine: the model endpoint sessions pay (else CAVEMAN_MODEL_* or a provider key from the environment). */
  readonly model?: ModelEndpoint;
  /** This machine: the `caveman-runtime` to run (else CAVEMAN_RUNTIME, else the one on PATH). */
  readonly runtime?: string;
  /** Cloud: the fetch to call the API with (a proxy's, a test's). Default the global one. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface SessionOptions extends AskHandlers {
  /** An agent file's name (`.caveman/agents/<name>.md` here; a published agent's name or id on Cloud), or an agent defined in code. */
  readonly agent: string | AgentDefinition;
  /** The first message. */
  readonly task: string;
  /** This machine: the directory it works in. Default the current one. */
  readonly cwd?: string;
  /** Cloud: the repository its computer checks out, `owner/name`. */
  readonly repo?: string;
  readonly baseBranch?: string;
  /** A class (`fast`, `base`, `frontier`, `auto`) or a model id; wins over the agent's. */
  readonly model?: string;
  /** Stops the session when reached. */
  readonly budget?: { readonly usd?: number; readonly seconds?: number };
  /**
   * This machine: which calls stop for `canUseTool` first. `full`: none. `auto`: commands and outside tools. `ask`:
   * file edits too. Default `auto` when `canUseTool` is given, else `full`.
   */
  readonly access?: "full" | "auto" | "ask";
  /** Handlers for custom tools an agent file declares (an agent defined in code carries its own). */
  readonly tools?: ReadonlyArray<Tool<unknown>>;
  /** Cloud: up to 16 keys kept on the session. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** What `run()` checks after each attempt: a shell command (this machine), or a function. */
export type Check = string | ((result: SessionResult) => boolean | string | Promise<boolean | string>);

export interface RunOptions extends SessionOptions {
  /**
   * Passes when the command exits 0, or the function returns true. A function may return text instead: the work
   * failed, and the text says why (the next attempt reads it).
   */
  readonly check?: Check;
  /** Models to move up to, in order, when an attempt fails its check, e.g. `["base", "frontier"]`. */
  readonly escalate?: ReadonlyArray<string>;
}

export interface Attempt {
  readonly model?: string;
  readonly result: SessionResult;
  /** Undefined when there was no check. */
  readonly passed?: boolean;
  /** What the check said when it failed. */
  readonly feedback?: string;
}

export interface RunResult extends SessionResult {
  /** Undefined when there was no check; false when every attempt failed it or the budget ran out first. */
  readonly passed?: boolean;
  readonly attempts: ReadonlyArray<Attempt>;
}

/** Failures another model would not fix: `run()` stops at them instead of escalating. */
const UNFIXABLE = new Set(["runtime_unavailable", "usage", "agent_invalid", "model_missing", "transport_failed"]);

const CHECK_TIMEOUT_MS = 10 * 60_000;
const FEEDBACK_MAX = 4000;

const addUsage = (a: Usage, b: Usage): Usage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
  cost_usd: Math.round((a.cost_usd + b.cost_usd) * 1e6) / 1e6,
});

/** Runs `command` in `cwd`; fails with the end of its output. */
function commandCheck(command: string, cwd: string): Promise<{ passed: boolean; feedback?: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? { file: "cmd.exe", args: ["/d", "/s", "/c", command] } : { file: "/bin/sh", args: ["-c", command] };
    const child = spawn(shell.file, shell.args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: CHECK_TIMEOUT_MS });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-FEEDBACK_MAX);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", (error) => resolve({ passed: false, feedback: `\`${command}\` could not run: ${error.message}` }));
    child.once("close", (code, signal) =>
      resolve(code === 0 ? { passed: true } : { passed: false, feedback: `\`${command}\` ${signal ? `was stopped (${signal})` : `exited with ${code}`}:\n${output.trim()}` }),
    );
  });
}

export class Caveman {
  readonly host: "local" | "cloud";
  readonly sessions: { readonly create: (options: SessionOptions) => Promise<Session> };
  /** Systems of agents: run an automation file to its end. */
  readonly automations: { readonly run: (name: string, options?: AutomationRunOptions) => Promise<AutomationRunResult> };
  private readonly options: CavemanOptions;
  private readonly cloud: Agents | undefined;

  constructor(options: CavemanOptions = {}) {
    this.options = options;
    this.host = options.apiKey === undefined ? "local" : "cloud";
    this.cloud = options.apiKey === undefined
      ? undefined
      : new Agents({ controlURL: options.cloudUrl ?? "https://api.caveman.so", apiKey: options.apiKey, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
    this.sessions = { create: (session) => this.start(session, false) };
    this.automations = {
      run: (name, run = {}) => (this.cloud === undefined ? runLocalAutomation(name, run, this.options.runtime) : runCloudAutomation(this.cloud, name, run)),
    };
  }

  /**
   * Runs an agent on a task to its end. With `check`, the work is checked after each attempt, and a failed attempt
   * is tried again on the next model of `escalate`, told what the check said. The usage is the sum of every attempt.
   */
  async run(options: RunOptions): Promise<RunResult> {
    const cwd = options.cwd ?? process.cwd();
    if (typeof options.check === "string" && this.host === "cloud") {
      throw new CavemanError("check_unsupported", "A command check runs on this machine; on Cloud pass a function, or use an automation's checks.");
    }
    const ladder = [options.model, ...(options.escalate ?? [])];
    const attempts: Array<Attempt> = [];
    let usage = ZERO_USAGE;
    let feedback: string | undefined;
    for (const model of ladder) {
      const left = options.budget?.usd === undefined ? undefined : options.budget.usd - usage.cost_usd;
      if (left !== undefined && left <= 0) break;
      const task = feedback === undefined
        ? options.task
        : `${options.task}\n\nA previous attempt did not pass the check. What the check said:\n\n${feedback}\n\nFix that and finish the task.`;
      const session = await this.start({
        ...options,
        task,
        ...(model === undefined ? {} : { model }),
        ...(options.budget === undefined ? {} : { budget: { ...options.budget, ...(left === undefined ? {} : { usd: left }) } }),
      }, true);
      const result = await session.result();
      usage = addUsage(usage, result.usage);
      if (options.check === undefined) {
        attempts.push({ ...(model === undefined ? {} : { model }), result });
        return { ...result, usage, attempts };
      }
      if ((result.error !== undefined && UNFIXABLE.has(result.error.code)) || result.stopReason === "budget_reached") {
        // Another model would not fix it, or there is no money left for one.
        attempts.push({ ...(model === undefined ? {} : { model }), result, passed: false });
        return { ...result, usage, passed: false, attempts };
      }
      const verdict = result.error !== undefined && result.stopReason !== "end_turn"
        ? { passed: false, feedback: `The attempt failed: ${result.error.message}` }
        : typeof options.check === "string"
          ? await commandCheck(options.check, cwd)
          : await Promise.resolve(options.check(result)).then((said) =>
              said === true ? { passed: true } : { passed: false, feedback: typeof said === "string" && said.trim() !== "" ? said.slice(0, FEEDBACK_MAX) : "The check did not pass." },
            );
      attempts.push({ ...(model === undefined ? {} : { model }), result, passed: verdict.passed, ...(verdict.feedback === undefined ? {} : { feedback: verdict.feedback }) });
      if (verdict.passed) return { ...result, usage, passed: true, attempts };
      feedback = verdict.feedback;
    }
    const last = attempts.at(-1);
    if (last === undefined) throw new CavemanError("budget_reached", "The budget was spent before the first attempt.");
    return { ...last.result, usage, passed: false, attempts };
  }

  private async start(options: SessionOptions, once: boolean): Promise<Session> {
    const inline = typeof options.agent === "string" ? undefined : options.agent;
    const handlers: AskHandlers = {
      tools: [...(inline === undefined ? [] : handlersOf(inline)), ...(options.tools ?? [])],
      ...(options.gate === undefined ? {} : { gate: options.gate }),
      ...(inline?.gate === undefined ? {} : { agentGate: inline.gate }),
      ...(options.gateProvider === undefined ? {} : { gateProvider: options.gateProvider }),
      ...(options.canUseTool === undefined ? {} : { canUseTool: options.canUseTool }),
      ...(options.onQuestion === undefined ? {} : { onQuestion: options.onQuestion }),
    };
    if (this.cloud !== undefined) {
      if (options.repo === undefined) throw new CavemanError("repo_required", "A Cloud session needs repo: \"owner/name\" (its computer checks it out).");
      const transport = await startCloud(this.cloud, {
        agent: inline === undefined ? { ref: options.agent as string } : { name: inline.name ?? "agent", file: agentFileText(inline) },
        repo: options.repo,
        task: options.task,
        ...(options.baseBranch === undefined ? {} : { baseBranch: options.baseBranch }),
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.budget?.usd === undefined ? {} : { budgetUsd: options.budget.usd }),
        ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
      });
      return new Session(transport, handlers, { once });
    }
    const transport = startLocal(
      {
        cwd: options.cwd ?? process.cwd(),
        agent: inline === undefined ? { name: options.agent as string } : { file: agentFileText(inline) },
        task: options.task,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.budget?.usd === undefined ? {} : { maxCostUsd: options.budget.usd }),
        ...(options.budget?.seconds === undefined ? {} : { maxSeconds: options.budget.seconds }),
        access: options.access ?? (options.canUseTool === undefined ? "full" : "auto"),
      },
      {
        ...(this.options.runtime === undefined ? {} : { runtime: this.options.runtime }),
        ...(this.options.model === undefined ? {} : { model: this.options.model }),
      },
    );
    return new Session(transport, handlers, { once });
  }
}
