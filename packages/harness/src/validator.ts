/**
 * policy.validator: an independent acceptance check behind a wall (Factory's
 * "What it Takes for Coding Agents to Complete Large Software Tasks", M38/H7).
 * Every single-agent campaign there ended because the agent decided it was
 * done, and its own checks inherit its blind spots; a validator that writes
 * the checks from the spec before implementation, which the implementer never
 * sees, and returns only clustered findings, moved the stopping rule to an
 * independent measurer. Here it is one side call and one command per trial:
 *
 * - Generation, at run start, in the background (LeverState.start starts it
 *   and does not await it, so the first request is never delayed): one
 *   internal env command probes the interpreters (python3, bash) and lists the
 *   starting workspace (depth 2, vendored and cache trees pruned, shallow
 *   entries first, capped at listing_bytes with capListing); then ONE model
 *   call on the run's own provider, model, base URL and key (run.ts
 *   `resolveSideModel`: the call is metered where the run is) at the lever's
 *   effort (default medium), with its own small context: the validator prompt,
 *   the task text, the workdir, the interpreters, the time limit and the
 *   listing; never the implementer's transcript or files. The reply's first
 *   fenced python or bash block is the check program, kept in harness memory
 *   only. Its tokens and cost join the run's usage and cost_usd (so the
 *   --max-usd cap sees it) through Recorder.sideRequest; `usage.requests`
 *   stays the agent loop's count, the side call is `side_requests.validator`.
 *   One retry on a transient provider error; the call is aborted at
 *   gen_timeout_s, by the run's abort, or when the run ends first.
 * - Check, at a finish attempt after every other finish lever (levers.ts), at
 *   most max_rounds times, under the finish checks' 90% budget guard: waits
 *   for the generation if it is still running (wait_ms), writes the program to
 *   a random directory in the env's scratch dir (outside the cwd), runs it
 *   there with the cwd as its working directory (internal command: handles
 *   h<n>; TMPDIR inside that directory, PYTHONDONTWRITEBYTECODE=1; timeout
 *   check_timeout_s, clamped to the wall left), then one internal command
 *   lists workspace files the check changed (trace `workspace_changed`) and
 *   removes the directory. The program prints `PASS <id> <requirement>` /
 *   `FAIL <id> <requirement>: <reason>` and a final `END <passed> <failed>`.
 *   Without the END line (a crash, a syntax error, a missing interpreter, a
 *   timeout) the run is recorded and the validator retires: it never bounces
 *   on a program it cannot trust. With FAIL lines, the run continues with one
 *   user message: the failing requirements, deduplicated and clustered by
 *   requirement (reasons joined, at most max_findings clusters), never the
 *   program. A clean result lets the run end.
 * - validator_placebo keeps the generation, the check and the trigger, and
 *   sends placeboFor("validator", text) in place of the findings: the same
 *   timing, cost and trials, without the content.
 * - The program reaches the trace only when the run is over (close():
 *   `validator_program`), so a LocalEnv implementer cannot read it from the
 *   trace file mid-run either.
 *
 * Snapshot (src/snapshot.ts): a bounce sets lastContinuation "validator", so
 * trace.finish_snapshot "fired" archives the first-finish workspace for the
 * rig's ffverify like evidence_bounce and test_isolation. The archive is taken
 * after the check ran (as for every finish check); the check must not change
 * the workspace, and any file it did change is named in the check's trace
 * event (`workspace_changed`).
 */
import { randomBytes } from "node:crypto";
import { clampThinkingLevel, isRetryableAssistantError, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExecEnv } from "./env/types.ts";
import type { Levers } from "./loadout.ts";
import { capListing, probeCommand } from "./levers.ts";
import { insideOf } from "./snapshot.ts";
import type { Recorder } from "./trace.ts";

export type ValidatorLever = NonNullable<Levers["validator"]>;

/** The side call: one completion on the run's model client; never part of the agent loop's transcript. */
export type SideCall = (context: Context, options: { reasoning?: Exclude<ThinkingLevel, "off">; maxTokens: number; signal: AbortSignal }) => Promise<AssistantMessage>;

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const PRUNE = "-name .git -o -name node_modules -o -name .venv -o -name venv -o -name __pycache__ -o -name .tox -o -name .mypy_cache " +
  "-o -name .pytest_cache -o -name site-packages -o -name target -o -name .cache";

/** One internal command: the interpreters (`validator_<name>=` lines), a separator, then the workspace at depth 2, shallow entries first. */
export const SURVEY_COMMAND = [
  "command -v python3 >/dev/null 2>&1 && printf 'validator_python3=%s\\n' \"$(python3 --version 2>&1 | head -n 1)\";",
  "command -v bash >/dev/null 2>&1 && echo validator_bash=1;",
  "echo validator_listing=;",
  `{ find . -mindepth 1 -maxdepth 2 \\( ${PRUNE} \\) -prune -o \\( -type d -exec printf '%s/\\n' {} + \\) -o -print; } 2>/dev/null`,
  "| sed 's|^\\./||' | awk -F/ '{ d = NF; if ($0 ~ /\\/$/) d--; print d \"\\t\" $0 }' | LC_ALL=C sort -t \"$(printf '\\t')\" -k1,1n -k2,2 | cut -f2- | head -n 400",
].join(" ");

export interface Survey {
  python3?: string;
  bash: boolean;
  listing: string;
}

export function parseSurvey(output: string, maxBytes: number): Survey {
  const at = output.indexOf("validator_listing=");
  const head = at === -1 ? output : output.slice(0, at);
  const python3 = /^validator_python3=(.*)$/mu.exec(head)?.[1]?.trim();
  const listing = at === -1 ? "" : output.slice(at + "validator_listing=".length).replace(/^\n/u, "");
  return { ...(python3 === undefined || python3 === "" ? {} : { python3 }), bash: /^validator_bash=1$/mu.test(head), listing: capListing(listing, maxBytes) };
}

/** The validator's request: the task, the environment facts and the starting listing. Nothing of the implementer's. */
export function validatorRequest(task: string, facts: { cwd: string; os?: string; survey: Survey; timeoutS: number }): string {
  const interpreters = [facts.survey.python3 === undefined ? undefined : `python3 (${facts.survey.python3})`, facts.survey.bash ? "bash" : undefined, "sh"]
    .filter((part) => part !== undefined).join(", ");
  return [
    `<task>\n${task.trim()}\n</task>`,
    "<environment>",
    `workdir: ${facts.cwd} (the program runs with this as its current directory)`,
    ...(facts.os === undefined ? [] : [`os: ${facts.os}`]),
    `interpreters: ${interpreters}${facts.survey.python3 === undefined ? " (no python3: write bash)" : ""}`,
    `time limit for the whole program: ${facts.timeoutS} s`,
    "</environment>",
    `<workspace>\nFiles and directories in the workdir at the start, before any work (depth 2, may be cut):\n${facts.survey.listing}\n</workspace>`,
    "Write the acceptance check program now.",
  ].join("\n");
}

export type ProgramLang = "python" | "bash" | "sh";

/** The first fenced python or shell block of a reply (an untagged block by its shebang), or undefined. */
export function parseProgram(text: string): { lang: ProgramLang; code: string } | undefined {
  for (const match of text.matchAll(/```[ \t]*([A-Za-z0-9_+-]*)[^\n]*\n([\s\S]*?)\n[ \t]*```/gu)) {
    const tag = match[1]!.toLowerCase();
    const code = match[2]!;
    if (code.trim() === "") continue;
    if (["python", "python3", "py"].includes(tag)) return { lang: "python", code: `${code}\n` };
    if (["bash", "shell"].includes(tag)) return { lang: "bash", code: `${code}\n` };
    if (tag === "sh") return { lang: "sh", code: `${code}\n` };
    if (tag === "") {
      if (/^#!.*python/u.test(code)) return { lang: "python", code: `${code}\n` };
      if (/^#!.*\b(?:ba)?sh\b/u.test(code)) return { lang: /bash/u.test(code.split("\n", 1)[0]!) ? "bash" : "sh", code: `${code}\n` };
    }
  }
  return undefined;
}

export interface CheckLine {
  id: string;
  requirement: string;
  reason?: string;
}

export interface CheckOutput {
  pass: CheckLine[];
  fail: CheckLine[];
  /** The END line's counts, or undefined when the program never printed it (it crashed, timed out or never ran). */
  end?: { pass: number; fail: number };
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`);

/** The program's PASS/FAIL/END lines (anything else it printed is ignored); a repeated id counts once, a FAIL over a PASS. */
export function parseCheckOutput(output: string): CheckOutput {
  const pass = new Map<string, CheckLine>();
  const fail = new Map<string, CheckLine>();
  let end: CheckOutput["end"];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const done = /^END\s+(\d+)\s+(\d+)$/u.exec(line);
    if (done !== null) {
      end = { pass: Number(done[1]), fail: Number(done[2]) };
      continue;
    }
    const match = /^(PASS|FAIL)\s+(\S+)\s+(.+)$/u.exec(line);
    if (match === null) continue;
    const id = match[2]!;
    if (match[1] === "PASS") {
      if (!fail.has(id)) pass.set(id, { id, requirement: clip(match[3]!.trim(), 160) });
      continue;
    }
    const body = match[3]!;
    const colon = body.indexOf(": ");
    const requirement = clip((colon === -1 ? body : body.slice(0, colon)).trim(), 160);
    const reason = colon === -1 ? undefined : clip(body.slice(colon + 2).trim(), 220);
    pass.delete(id);
    if (!fail.has(id)) fail.set(id, { id, requirement, ...(reason === undefined || reason === "" ? {} : { reason }) });
  }
  return { pass: [...pass.values()], fail: [...fail.values()], ...(end === undefined ? {} : { end }) };
}

/**
 * The failing checks as the implementer sees them: one "- " line per
 * requirement (case and spacing folded), its distinct reasons joined with
 * "; " (at most 3), first-seen order, at most `max` lines plus a count of the rest.
 */
export function clusterFindings(fails: readonly CheckLine[], max: number): { items: string; clusters: number } {
  const clusters = new Map<string, { requirement: string; reasons: string[] }>();
  for (const line of fails) {
    const key = line.requirement.toLowerCase().replace(/\s+/gu, " ").replace(/[.\s]+$/u, "");
    const cluster = clusters.get(key) ?? { requirement: line.requirement.replace(/[.\s]+$/u, ""), reasons: [] };
    clusters.set(key, cluster);
    if (line.reason !== undefined && !cluster.reasons.some((reason) => reason.toLowerCase() === line.reason!.toLowerCase())) cluster.reasons.push(line.reason);
  }
  const all = [...clusters.values()];
  const lines = all.slice(0, max).map(({ requirement, reasons }) => {
    const shown = reasons.slice(0, 3).join("; ");
    const more = reasons.length > 3 ? ` (+${reasons.length - 3} more)` : "";
    return `- ${requirement}${shown === "" ? "" : `: ${shown}`}${more}`;
  });
  if (all.length > max) lines.push(`- (${all.length - max} more failing requirements not listed)`);
  return { items: lines.join("\n"), clusters: all.length };
}

interface Program {
  lang: ProgramLang;
  code: string;
}

/** Usage of a side call as trace fields. */
const usageFields = (reply: AssistantMessage) => ({
  input_tokens: reply.usage.input, cached_input_tokens: reply.usage.cacheRead, cache_write_tokens: reply.usage.cacheWrite,
  output_tokens: reply.usage.output, reasoning_tokens: reply.usage.reasoning ?? 0,
});

const textOf = (reply: AssistantMessage) => reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");

export class Validator {
  private readonly lever: ValidatorLever;
  private readonly env: ExecEnv;
  private readonly recorder: Recorder;
  private readonly task: string;
  private readonly call: SideCall;
  private readonly reasoning: Exclude<ThinkingLevel, "off"> | undefined;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal | undefined;
  private generation: Promise<Program | null> | undefined;
  private deadline: NodeJS.Timeout | undefined;
  private program: Program | null | undefined;
  private rounds = 0;
  /** No program, or one that did not finish: the validator never runs (again). */
  private retired = false;
  private closed = false;

  constructor(options: { lever: ValidatorLever; env: ExecEnv; recorder: Recorder; task: string; call: SideCall; model: Model<Api>; signal?: AbortSignal }) {
    this.lever = options.lever;
    this.env = options.env;
    this.recorder = options.recorder;
    this.task = options.task;
    this.call = options.call;
    const level = options.model.reasoning ? (clampThinkingLevel(options.model, options.lever.effort) as ThinkingLevel) : "off";
    this.reasoning = level === "off" ? undefined : level;
    this.signal = options.signal;
  }

  /** Starts the generation in the background (idempotent); the caller never awaits it. */
  begin(): void {
    if (this.generation !== undefined || this.closed) return;
    const abort = () => this.controller.abort(this.signal?.reason);
    if (this.signal?.aborted === true) abort();
    else this.signal?.addEventListener("abort", abort, { once: true });
    this.deadline = setTimeout(() => this.controller.abort(new Error("gen_timeout")), this.lever.gen_timeout_s * 1000);
    this.deadline.unref();
    this.generation = this.generate().catch((error: unknown) => {
      this.recorder.policy("check", "validator_failed", { stage: "generate", error: message(error).slice(0, 300) });
      return null;
    }).finally(() => {
      clearTimeout(this.deadline);
      this.signal?.removeEventListener("abort", abort);
    });
  }

  /** Whether a check may still run: a round left and nothing retired it. */
  get pending(): boolean {
    return !this.closed && !this.retired && this.rounds < this.lever.max_rounds;
  }

  private async generate(): Promise<Program | null> {
    const started = performance.now();
    const surveyed = await this.env.exec(SURVEY_COMMAND, { timeoutMs: 30_000, internal: true, signal: this.controller.signal });
    const survey = parseSurvey(surveyed.output, this.lever.listing_bytes);
    const request = validatorRequest(this.task, { cwd: this.env.cwd, ...(this.env.os === undefined ? {} : { os: this.env.os }), survey, timeoutS: this.lever.check_timeout_s });
    const context: Context = { systemPrompt: this.lever.prompt, messages: [{ role: "user", content: [{ type: "text", text: request }], timestamp: Date.now() }] };
    let reply: AssistantMessage | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const sent = performance.now();
      reply = await this.call(context, { ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }), maxTokens: this.lever.max_output_tokens, signal: this.controller.signal });
      this.recorder.sideRequest("validator", reply, performance.now() - sent);
      if (reply.stopReason !== "error" || !isRetryableAssistantError(reply) || this.controller.signal.aborted) break;
    }
    const fields = {
      stage: "generate", ms: Math.round(performance.now() - started), stop_reason: reply!.stopReason, ...usageFields(reply!),
      python3: survey.python3 ?? null, listing_lines: survey.listing.split("\n").length, request_bytes: Buffer.byteLength(request, "utf8"),
    };
    if (reply!.stopReason === "error" || reply!.stopReason === "aborted") {
      this.recorder.policy("check", "validator_failed", { ...fields, error: (reply!.errorMessage ?? reply!.stopReason).slice(0, 300) });
      return null;
    }
    const program = parseProgram(textOf(reply!));
    if (program === undefined || (program.lang === "python" && survey.python3 === undefined) || (program.lang === "bash" && !survey.bash)) {
      const why = program === undefined ? "no program" : `${program.lang} is not available`;
      this.recorder.policy("check", "validator_failed", { ...fields, error: why });
      return null;
    }
    this.recorder.policy("check", "validator", { ...fields, lang: program.lang, bytes: Buffer.byteLength(program.code, "utf8") });
    return program;
  }

  /**
   * The check at a finish attempt: the findings message (or undefined to let
   * the run end) and the trace fields of a bounce. `wallLeftMs` clamps the
   * check's timeout (undefined: no wall budget). Never throws.
   */
  async check(wallLeftMs: number | undefined): Promise<{ text: string; fields: Record<string, unknown> } | undefined> {
    if (!this.pending) return undefined;
    const waited = performance.now();
    this.program = await (this.generation ?? Promise.resolve(null));
    const waitMs = Math.round(performance.now() - waited);
    if (this.program === null) {
      this.retired = true;
      this.recorder.policy("skip", "validator", { cause: "no_program", wait_ms: waitMs });
      return undefined;
    }
    const timeoutMs = Math.min(this.lever.check_timeout_s * 1000, wallLeftMs === undefined ? Infinity : wallLeftMs - 30_000);
    if (timeoutMs < 10_000) {
      this.recorder.policy("skip", "validator", { cause: "wall_left", wall_left_ms: Math.round(wallLeftMs ?? 0), wait_ms: waitMs });
      this.retired = true;
      return undefined;
    }
    this.rounds++;
    const round = this.rounds;
    const started = performance.now();
    const ran = await this.runProgram(this.program, timeoutMs);
    const ms = Math.round(performance.now() - started);
    const base = { round, wait_ms: waitMs, ms, ...(ran.changed.length === 0 ? {} : { workspace_changed: ran.changed }) };
    if (ran.error !== undefined) {
      this.retired = true;
      this.recorder.policy("check", "validator_failed", { ...base, stage: "run", error: ran.error, exit_code: ran.exitCode ?? null, tail: ran.output.slice(-400) });
      return undefined;
    }
    const parsed = parseCheckOutput(ran.output);
    if (parsed.end === undefined) {
      this.retired = true;
      this.recorder.policy("check", "validator_failed", {
        ...base, stage: "run", error: `no END line (exit ${ran.exitCode ?? "killed"})`, exit_code: ran.exitCode ?? null, n_pass: parsed.pass.length, n_fail: parsed.fail.length,
        tail: ran.output.slice(-400),
      });
      return undefined;
    }
    const counts = { n_pass: parsed.pass.length, n_fail: parsed.fail.length, exit_code: ran.exitCode ?? null, ...(parsed.end.pass === parsed.pass.length && parsed.end.fail === parsed.fail.length ? {} : { end: parsed.end }) };
    if (parsed.fail.length === 0) {
      this.recorder.policy("check", "validator", { ...base, stage: "run", ...counts, bounced: false });
      return undefined;
    }
    const { items, clusters } = clusterFindings(parsed.fail, this.lever.max_findings);
    const text = this.lever.text.replaceAll("{items}", items);
    this.recorder.policy("check", "validator", { ...base, stage: "run", ...counts, clusters, bounced: true });
    return { text, fields: { ...base, ...counts, clusters, fail_ids: parsed.fail.slice(0, 20).map((line) => line.id), findings: items.slice(0, 2000) } };
  }

  private async runProgram(program: Program, timeoutMs: number): Promise<{ output: string; exitCode?: number | null; error?: string; changed: string[] }> {
    const scratch = (await this.env.scratchDir()).replace(/\/+$/u, "");
    const dir = `${scratch}/.vc-${randomBytes(8).toString("hex")}`;
    const file = `${dir}/${randomBytes(6).toString("hex")}.${program.lang === "python" ? "py" : "sh"}`;
    const interpreter = program.lang === "python" ? "python3" : program.lang;
    const changed: string[] = [];
    try {
      await this.env.writeFile(file, program.code);
      const run = await this.env.exec(`mkdir -p ${shellQuote(`${dir}/tmp`)} && touch ${shellQuote(`${dir}/.start`)} && ${interpreter} ${shellQuote(file)} < /dev/null`, {
        timeoutMs, internal: true, env: { TMPDIR: `${dir}/tmp`, PYTHONDONTWRITEBYTECODE: "1" }, ...(this.signal === undefined ? {} : { signal: this.signal }),
      });
      if (run.timedOut === true) return { output: run.output, exitCode: run.exitCode, error: `timeout after ${Math.round(timeoutMs / 1000)} s`, changed };
      if (run.killed === true) return { output: run.output, exitCode: run.exitCode, error: "killed", changed };
      return { output: run.output, exitCode: run.exitCode, changed };
    } catch (error) {
      return { output: "", error: message(error).slice(0, 300), changed };
    } finally {
      // Files of the workspace the check changed (it must not), then the program and its temp files are gone.
      const own = insideOf(this.env.cwd, dir);
      const after = await this.env.exec(`${probeCommand(`${dir}/.start`)}; rm -rf ${shellQuote(dir)}`, { timeoutMs: 30_000, internal: true }).catch(() => undefined);
      changed.push(...(after?.output ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "" && (own === undefined || !line.startsWith(own))));
    }
  }

  /** The run is over: a generation still running is aborted (its usage so far still counts), and the program goes to the trace. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.generation === undefined) return;
    this.controller.abort(new Error("run_ended"));
    const program = await this.generation;
    if (program !== null) this.recorder.event("validator_program", { lang: program.lang, bytes: Buffer.byteLength(program.code, "utf8"), code: program.code });
  }
}
