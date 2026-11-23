// Systems of agents: run an automation file (`.caveman/automations/<name>.yaml`) to its end. On this machine the
// running Caveman Code runs it, from the files as they are (`caveman-runtime automation run --wait --json`); on
// Cloud, the revision Cloud took for that repository (`caveman-runtime apply` sends it).

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { Agents, CodeAutomationRun } from "@caveman-ai/sdk/agents";

import { runtimeCommand } from "./local.ts";
import { CavemanError } from "./types.ts";

export interface AutomationRunOptions {
  /** Values for the automation's inputs. */
  readonly inputs?: Readonly<Record<string, string>>;
  /** This machine: the repository it runs in. Default the current directory. */
  readonly cwd?: string;
  /** This machine: what the run is about, `github:<owner>/<repo>#<number>`. */
  readonly subject?: string;
  /** This machine: write its outputs (a comment, a pull request) when it ends; else they wait to be applied. */
  readonly apply?: boolean;
  /** Cloud: the repository the automation belongs to, `owner/name`. */
  readonly repo?: string;
  /** Cloud: how often to look at the run while it goes. Default 3 s. */
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

export type AutomationStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "skipped";

export interface AutomationRunResult {
  readonly id: string;
  readonly status: AutomationStatus;
  readonly passed: boolean;
  readonly cost_usd: number;
  /** Each step's outcome (this machine; Cloud's run record lists the run's session instead). */
  readonly steps: ReadonlyArray<{ readonly name: string; readonly status: string; readonly decision?: string; readonly summary?: string }>;
  readonly pull_requests: ReadonlyArray<{ readonly url: string; readonly state?: string }>;
  /** The host's own run record, whole. */
  readonly record: unknown;
}

const ENDED = new Set<string>(["succeeded", "failed", "cancelled", "skipped"]);

interface LocalRecord {
  readonly run: string;
  readonly status: AutomationStatus;
  readonly budget: { readonly spent_usd: number };
  readonly steps: ReadonlyArray<{ readonly name: string; readonly status: string; readonly decision?: string; readonly summary?: string }>;
  readonly outputs: ReadonlyArray<{ readonly kind?: string; readonly url?: string }>;
}

export function runLocalAutomation(name: string, options: AutomationRunOptions, runtime: string | undefined): Promise<AutomationRunResult> {
  const { command, args: lead } = runtimeCommand(runtime, process.env);
  const args = [
    ...lead,
    "automation", "run", name, "--wait", "--json",
    ...Object.entries(options.inputs ?? {}).flatMap(([key, value]) => ["--input", `${key}=${value}`]),
    ...(options.subject === undefined ? [] : ["--subject", options.subject]),
    ...(options.apply === true ? ["--apply"] : []),
  ];
  const { signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new CavemanError("aborted", "Stopped before the run started."));
      return;
    }
    const cannotStart = (error: Error) => new CavemanError("runtime_unavailable", `Could not start ${command}: ${error.message}.`);
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, args, { cwd: options.cwd ?? process.cwd(), stdio: ["ignore", "pipe", "pipe"], ...(signal === undefined ? {} : { signal }) });
    } catch (error) {
      reject(cannotStart(error as Error));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-8192)));
    // An abort stops the command, which is only the waiting: the run it asked the running Caveman Code for goes on.
    child.once("error", (error) => reject(signal?.aborted === true ? new CavemanError("aborted", "Stopped waiting; the run may have started, and goes on in Caveman Code if it did.") : cannotStart(error)));
    child.once("close", (code) => {
      let record: LocalRecord;
      try {
        record = JSON.parse(stdout) as LocalRecord;
      } catch {
        // No record: the run never started (no such automation, no running Caveman Code, files with errors).
        reject(new CavemanError(code === 2 ? "automation_not_found" : "automation_refused", stderr.trim() || `caveman-runtime automation run exited with ${code}.`));
        return;
      }
      resolve({
        id: record.run,
        status: record.status,
        passed: record.status === "succeeded",
        cost_usd: record.budget.spent_usd,
        steps: record.steps.map(({ name: step, status, decision, summary }) => ({ name: step, status, ...(decision === undefined ? {} : { decision }), ...(summary === undefined ? {} : { summary }) })),
        pull_requests: record.outputs.filter((output) => output.url !== undefined && output.kind?.includes("pull_request")).map((output) => ({ url: output.url! })),
        record,
      });
    });
  });
}

export async function runCloudAutomation(client: Agents, name: string, options: AutomationRunOptions): Promise<AutomationRunResult> {
  if (options.repo === undefined) throw new CavemanError("repo_required", "A Cloud automation run needs repo: \"owner/name\".");
  const { signal } = options;
  // The caller's signal stops every request and every pause between polls, so an abort ends the wait wherever it lands.
  const call = signal === undefined ? {} : { signal };
  let run: CodeAutomationRun | undefined;
  let asked = false;
  try {
    signal?.throwIfAborted();
    const { automations } = await client.listAutomations({ repo: options.repo }, call);
    const automation = automations.find((item) => item.name === name && item.removed_at == null);
    if (automation === undefined) {
      throw new CavemanError("automation_not_found", `No Cloud automation "${name}" for ${options.repo}; send it with caveman-runtime apply (host: cloud).`);
    }
    asked = true;
    run = await client.runAutomation(automation.id, { request_id: randomUUID(), ...(options.inputs === undefined ? {} : { inputs: { ...options.inputs } }) }, call);
    while (!ENDED.has(run.status)) {
      await delay(options.pollMs ?? 3000, undefined, call);
      run = await client.getAutomationRun(automation.id, run.id, call);
    }
  } catch (failure) {
    if (signal?.aborted === true) {
      // Cloud may have taken a run request the abort cut off before it answered.
      const where = run !== undefined
        ? `Stopped waiting; the run ${run.id} goes on in Cloud.`
        : asked ? "Stopped while Cloud was asked to run it; the run may have started there." : "Stopped before the run started.";
      throw new CavemanError("aborted", where);
    }
    throw failure;
  }
  return {
    id: run.id,
    status: run.status,
    passed: run.status === "succeeded",
    cost_usd: run.cost_usd,
    steps: [],
    pull_requests: (run.pull_requests ?? []).filter((pr) => pr.url !== undefined).map((pr) => ({ url: pr.url!, ...(pr.state === undefined ? {} : { state: pr.state }) })),
    record: run,
  };
}
