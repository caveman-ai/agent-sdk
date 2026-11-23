/**
 * R2 wait(until) (`tools.wait.limits.until`, off by default): a wait that
 * blocks inside the harness until a condition holds, so a server start, a
 * build or a log line costs one tool call instead of one model request per
 * poll. Conditions: `exit` (the target ends), `regex:<pattern>` (a new output
 * line matches), `port:<n>` (something accepts TCP connections on localhost),
 * `file:<path>` (the path exists). At most 300 s; the target ending always
 * returns, whatever the condition.
 *
 * Port and file conditions are checked by one background loop inside the env
 * (one start call on a remote env, its exit streams back), never by a call per check.
 * A regex is tested once per complete line (its first 4096 characters) and on
 * the growing last line, so the scan is linear in the output.
 */
import type { ExecEnv, ExecResult } from "../env/types.ts";

export const UNTIL_MAX_MS = 300_000;

export const UNTIL_DESCRIPTION = 'Block until this holds, at most 300 s: "exit" (the process ends), "regex:<pattern>" (a new output line matches), ' +
  '"port:<n>" (something accepts TCP connections on localhost:<n>), "file:<path>" (the path exists). The process ending always returns.';

export type Until = { kind: "exit" } | { kind: "regex"; re: RegExp } | { kind: "port"; port: number } | { kind: "file"; path: string };

export function parseUntil(spec: string): Until {
  const text = spec.trim();
  if (text === "exit") return { kind: "exit" };
  const colon = text.indexOf(":");
  const kind = colon < 0 ? text : text.slice(0, colon);
  const value = colon < 0 ? "" : text.slice(colon + 1);
  if ((kind === "regex" || kind === "re") && value !== "") {
    try {
      return { kind: "regex", re: new RegExp(value, "u") };
    } catch (error) {
      throw new Error(`until: invalid regex ${JSON.stringify(value)}: ${(error as Error).message}`);
    }
  }
  if (kind === "port" && /^\d{1,5}$/u.test(value.trim()) && Number(value) >= 1 && Number(value) <= 65_535) return { kind: "port", port: Number(value) };
  if (kind === "file" && value.trim() !== "") return { kind: "file", path: value.trim() };
  throw new Error(`until must be "exit", "regex:<pattern>", "port:<1-65535>" or "file:<path>"; got ${JSON.stringify(spec)}`);
}

export function describeUntil(until: Until): string {
  if (until.kind === "regex") return `regex /${until.re.source}/`;
  if (until.kind === "port") return `port ${until.port}`;
  if (until.kind === "file") return `file ${until.path}`;
  return "exit";
}

/** One regex over a stream: each complete line is tested once, the partial last line again as it grows. */
export class LineMatcher {
  private partial = "";
  private readonly re: RegExp;

  constructor(re: RegExp) {
    this.re = re;
  }

  feed(chunk: string): boolean {
    if (chunk === "") return false;
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop()!;
    if (this.partial.length > 4096) this.partial = this.partial.slice(0, 4096);
    for (const line of lines) if (this.re.test(line.length > 4096 ? line.slice(0, 4096) : line)) return true;
    return this.partial !== "" && this.re.test(this.partial);
  }
}

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A loop in the env that exits 0 once the condition holds, checking every 250 ms; works under bash, dash and sh. */
export function probeCommand(until: { kind: "port"; port: number } | { kind: "file"; path: string }): string {
  if (until.kind === "file") return `while [ ! -e ${quote(until.path)} ]; do sleep 0.25; done`;
  const port = until.port;
  return `while :; do (exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && exit 0; (exec 3<>/dev/tcp/localhost/${port}) 2>/dev/null && exit 0; ` +
    `nc -z 127.0.0.1 ${port} >/dev/null 2>&1 && exit 0; sleep 0.25; done`;
}

/** What a wait blocks on: a background process or an exec cell. `step` blocks up to `ms` and returns the new output. */
export interface WaitTarget {
  step(ms: number, signal?: AbortSignal): Promise<{ text: string; ended: boolean }>;
}

export interface UntilOutcome {
  met: boolean;
  /** The target ended while waiting (or had already). */
  ended: boolean;
  elapsedMs: number;
}

/** A background process as a wait target: every new chunk is kept, the last result has the exit state. */
export function processTarget(env: ExecEnv, handle: string): WaitTarget & { output: string; last?: ExecResult | undefined; truncated: boolean } {
  const target = {
    output: "",
    truncated: false,
    last: undefined as ExecResult | undefined,
    async step(ms: number, signal?: AbortSignal) {
      const run = await env.wait(handle, ms, signal);
      target.output += run.output;
      target.truncated ||= run.truncated;
      target.last = run;
      return { text: run.output, ended: !run.running };
    },
  };
  return target;
}

/** Blocks until `until` holds, the target ends, `maxMs` pass or `signal` aborts. No target: port and file only. */
export async function waitUntil(env: ExecEnv, until: Until, maxMs: number, target: WaitTarget | undefined, signal?: AbortSignal): Promise<UntilOutcome> {
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const matcher = until.kind === "regex" ? new LineMatcher(until.re) : undefined;
  const probed = until.kind === "port" || until.kind === "file" ? until : undefined;
  if (target === undefined && probed === undefined) throw new Error("wait: a handle is needed unless until is port:<n> or file:<path>");
  let probe = probed === undefined ? undefined : await env.exec(probeCommand(probed), { background: true, timeoutMs: maxMs + 5_000 });
  const done = (met: boolean, ended: boolean): UntilOutcome => ({ met, ended, elapsedMs: elapsed() });
  try {
    for (;;) {
      const left = maxMs - elapsed();
      if (left <= 0 || signal?.aborted === true) return done(false, false);
      if (probe !== undefined && !probe.running) return done(probe.exitCode === 0, false);
      if (target === undefined) {
        const run = await env.wait(probe!.handle!, left, signal);
        return done(!run.running && run.exitCode === 0, false);
      }
      const step = await target.step(until.kind === "exit" ? left : Math.min(left, 250), signal);
      if (matcher?.feed(step.text) === true) return done(true, step.ended);
      if (probe?.running === true) {
        probe = await env.poll(probe.handle!);
        if (!probe.running) return done(probe.exitCode === 0, step.ended);
      }
      if (step.ended) return done(until.kind === "exit", true);
    }
  } finally {
    if (probe?.running === true && probe.handle !== undefined) await env.kill(probe.handle).catch(() => undefined);
  }
}

/** The line a wait with a condition leads its result with. */
export function untilLine(until: Until, outcome: UntilOutcome): string {
  const seconds = (Math.round(outcome.elapsedMs / 100) / 10).toFixed(1);
  return `[wait until ${describeUntil(until)}: ${outcome.met ? "met" : outcome.ended ? "not met; the process ended" : "not met"} after ${seconds}s]`;
}

/**
 * Text with every until line's elapsed time taken out, for the policy's
 * repeat detection: two identical waits that took 0.3 s and 0.4 s are the
 * same result. Only a whole line of untilLine's shape is touched.
 */
export function withoutUntilTimes(text: string): string {
  return text.replace(/^(\[wait until [^\n]*?) after \d+(?:\.\d+)?s\]$/gmu, "$1]");
}
