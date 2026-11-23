/**
 * trace.finish_snapshot: the workspace at the model's first finish attempt,
 * for a within-trial paired measurement of finish-time levers (P1 evidence
 * gate, P2 hedge continue, P4 audit, test_isolation, evidence_bounce). Those
 * levers act only after the model first tries to finish, so the workspace at
 * that moment IS the control outcome of the trial: graded on its own in a
 * fresh sandbox (the rig's `tb4.py ffverify`), every trial a lever fired on
 * gives a paired (first-finish reward, final reward) at no model cost.
 *
 * - "fired": at the first finish attempt (a turn with text and no tool calls)
 *   that is about to get a harness continuation, before that continuation is
 *   sent. A first attempt that gets none ends the run: its final state is the
 *   first-finish state, and the record says `skipped: "not_fired"`.
 * - "always": at the first finish attempt whatever happens next. In an arm with
 *   no finish levers that is the final state, so a re-grade measures how
 *   faithfully a restore reproduces the trial (restore fidelity).
 *
 * One command in the env (through ExecEnv, `internal`: the handles the model
 * sees are numbered as without it) measures the cwd (`du -sk`), skips it over
 * the size limit, and writes `tar -czf` of the cwd into the env's scratch dir
 * (outside the cwd), with its size and sha256. The copy to the host (chunked
 * ExecEnv.readFile ranges, the sha256 checked) starts at once and overlaps the
 * next request; the run awaits it before result.json, bounded when the run was
 * aborted (the rig's SIGTERM grace is 10 s). Nothing here can fail a run: every
 * failure is a `skipped: "failed"` record with the error.
 *
 * Not captured: processes, services, and files outside the cwd (a database
 * under /var, a global pip install, /tmp). A task whose grader depends on such
 * state restores unfaithfully; "always" arms measure how often.
 *
 * Model-facing requests are byte-identical with this on: the snapshot adds no
 * message, no tool call and no model-visible handle.
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { ExecEnv } from "./env/types.ts";
import type { Recorder } from "./trace.ts";

export type SnapshotMode = "fired" | "always";
export const SNAPSHOT_MODES: readonly SnapshotMode[] = ["fired", "always"];
export const DEFAULT_SNAPSHOT_MAX_MB = 300;
/** The tarball's name in the env's scratch dir and in the host directory. */
export const SNAPSHOT_FILE = "first-finish.tgz";
/** Host copy chunk: one ExecEnv.readFile range per chunk (docker: one exec). */
export const COPY_CHUNK_BYTES = 8 * 1024 * 1024;
const TAR_TIMEOUT_MS = 180_000;
/** How long result.json waits for a copy still under way: normally, and when the run was aborted (signals). */
const SETTLE_MS = 300_000;
const SETTLE_ABORTED_MS = 3_000;

/** The first_finish record in result.json and the trace (`first_finish` event). */
export interface FirstFinish {
  mode: SnapshotMode;
  /** 1-based index of the request whose response was the first finish attempt. */
  request_index?: number;
  /** The finish lever about to continue the run at that attempt (empty: none). */
  levers_pending?: string[];
  /** The env's cwd: what was archived, and where a restore extracts it. */
  cwd: string;
  /** The host copy (or, without a host directory, the tarball in the env). */
  path?: string;
  /** The tarball in the env (removed after a verified copy). */
  env_path?: string;
  bytes?: number;
  /** du -sk of the cwd, in bytes (null when du printed nothing). */
  cwd_bytes?: number | null;
  sha256?: string;
  tar_ms?: number;
  copy_ms?: number;
  /** tar exited 1 (GNU: a file changed while it was read): archived, and said so. */
  tar_warning?: string;
  skipped?: "not_fired" | "no_finish_attempt" | "too_large" | "failed" | "cwd_root";
  error?: string;
}

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * The one env command: cd into the cwd, measure it, skip over `maxKb`, else tar
 * it to `out` (excluding `exclude`, a ./relative path inside the cwd, when the
 * scratch dir sits there) and print the tarball's size and sha256. Every fact is
 * a `ffsnap_<key>=<value>` line; the command itself always exits 0.
 */
export function snapshotScript(cwd: string, out: string, maxKb: number, exclude?: string): string {
  const q = shellQuote(out);
  const err = shellQuote(`${out}.err`);
  return [
    `cd ${shellQuote(cwd)} || { echo ffsnap_error=cd; exit 0; }`,
    "kb=$(du -sk . 2>/dev/null | cut -f1)",
    'echo "ffsnap_cwd_kb=$kb"',
    `if [ -n "$kb" ] && [ "$kb" -gt ${Math.floor(maxKb)} ] 2>/dev/null; then echo ffsnap_skip=too_large; exit 0; fi`,
    `rm -f ${q}`,
    `tar -czf ${q}${exclude === undefined ? "" : ` --exclude=${shellQuote(exclude)}`} . 2>${err}`,
    'echo "ffsnap_tar_exit=$?"',
    `if [ -f ${q} ]; then echo "ffsnap_bytes=$(wc -c < ${q} | tr -d ' ')"; fi`,
    `s=$( (sha256sum ${q} || shasum -a 256 ${q}) 2>/dev/null ); echo "ffsnap_sha256=\${s%% *}"`,
    `echo "ffsnap_err=$(tail -c 300 ${err} 2>/dev/null | tr '\\n' ' ')"`,
    `rm -f ${err}`,
    "exit 0",
  ].join("\n");
}

/** The `ffsnap_<key>=<value>` lines of snapshotScript's output. */
export function parseSnapshotOutput(output: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^ffsnap_([a-z0-9_]+)=(.*)$/u.exec(line.trimEnd());
    if (match !== null) facts[match[1]!] = match[2]!;
  }
  return facts;
}

/** `path` relative to `root` as tar names it (./x), or undefined when it is not inside root. */
export function insideOf(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return `./${rel}`;
}

/** Copies `bytes` bytes of the env file `envPath` to `hostPath` in ranges of `chunk`; returns the copy's sha256. */
export async function copyOut(env: ExecEnv, envPath: string, bytes: number, hostPath: string, chunk = COPY_CHUNK_BYTES): Promise<string> {
  const hash = createHash("sha256");
  const part = `${hostPath}.part`;
  const fd = openSync(part, "w");
  try {
    let offset = 0;
    while (offset < bytes) {
      const data = await env.readFile(envPath, { offset, length: Math.min(chunk, bytes - offset) });
      if (data.length === 0) throw new Error(`short read: ${offset} of ${bytes} bytes`);
      writeSync(fd, data);
      hash.update(data);
      offset += data.length;
    }
    if (offset !== bytes) throw new Error(`read ${offset} bytes, expected ${bytes}`);
  } catch (error) {
    closeSync(fd);
    rmSync(part, { force: true });
    throw error;
  }
  closeSync(fd);
  renameSync(part, hostPath);
  return hash.digest("hex");
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class FinishSnapshot {
  readonly mode: SnapshotMode;
  private readonly env: ExecEnv;
  private readonly recorder: Pick<Recorder, "event">;
  private readonly maxBytes: number;
  private readonly hostDir: string | undefined;
  private readonly chunkBytes: number;
  private record: FirstFinish | undefined;
  private copying: Promise<void> | undefined;

  constructor(options: { env: ExecEnv; recorder: Pick<Recorder, "event">; mode: SnapshotMode; maxMb?: number; hostDir?: string; chunkBytes?: number }) {
    this.env = options.env;
    this.recorder = options.recorder;
    this.mode = options.mode;
    this.maxBytes = Math.max(0, options.maxMb ?? DEFAULT_SNAPSHOT_MAX_MB) * 1024 * 1024;
    this.hostDir = options.hostDir;
    this.chunkBytes = options.chunkBytes ?? COPY_CHUNK_BYTES;
  }

  /** Whether the first finish attempt has been seen (later attempts are ignored). */
  get attempted(): boolean {
    return this.record !== undefined;
  }

  /**
   * The model's first finish attempt; `leversPending` names the continuation
   * about to be sent (empty: none). Takes the snapshot (in "fired" mode only
   * when a continuation follows) before the caller sends anything. Never throws.
   */
  async atFinishAttempt(requestIndex: number, leversPending: string[]): Promise<void> {
    if (this.record !== undefined) return;
    const record: FirstFinish = { mode: this.mode, request_index: requestIndex, levers_pending: [...leversPending], cwd: this.env.cwd };
    this.record = record;
    if (this.mode === "fired" && leversPending.length === 0) {
      record.skipped = "not_fired";
      this.recorder.event("snapshot", { stage: "skip", reason: "not_fired", request_index: requestIndex });
      return;
    }
    if (this.env.cwd === "/" || this.env.cwd === "") {
      record.skipped = "cwd_root";
      this.recorder.event("snapshot", { stage: "skip", reason: "cwd_root", request_index: requestIndex });
      return;
    }
    const started = performance.now();
    try {
      const scratch = await this.env.scratchDir();
      const envPath = `${scratch.replace(/\/+$/u, "")}/${SNAPSHOT_FILE}`;
      record.env_path = envPath;
      const run = await this.env.exec(snapshotScript(this.env.cwd, envPath, this.maxBytes / 1024, insideOf(this.env.cwd, scratch)), {
        timeoutMs: TAR_TIMEOUT_MS, internal: true,
      });
      record.tar_ms = Math.round(performance.now() - started);
      const facts = parseSnapshotOutput(run.output);
      const kb = facts.cwd_kb === undefined || facts.cwd_kb === "" ? null : Number(facts.cwd_kb);
      record.cwd_bytes = kb === null || !Number.isFinite(kb) ? null : kb * 1024;
      if (facts.error !== undefined) throw new Error(`cd ${this.env.cwd} failed`);
      if (facts.skip === "too_large") {
        record.skipped = "too_large";
        this.recorder.event("snapshot", { stage: "skip", reason: "too_large", cwd_bytes: record.cwd_bytes, max_bytes: this.maxBytes, request_index: requestIndex });
        return;
      }
      if (run.exitCode !== 0 || facts.tar_exit === undefined) throw new Error(`snapshot command exit ${run.exitCode ?? "killed"}${run.timedOut === true ? " (timed out)" : ""}: ${run.output.slice(-300)}`);
      const tarExit = Number(facts.tar_exit);
      if (tarExit !== 0 && tarExit !== 1) throw new Error(`tar exit ${facts.tar_exit}: ${facts.err ?? ""}`.trim());
      if (tarExit === 1) record.tar_warning = (facts.err ?? "").trim() || "tar exit 1";
      const bytes = Number(facts.bytes);
      if (facts.bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) throw new Error(`no tarball (${facts.err ?? ""})`.trim());
      record.bytes = bytes;
      const envSha = facts.sha256 ?? "";
      if (/^[0-9a-f]{64}$/u.test(envSha)) record.sha256 = envSha;
      if (bytes > this.maxBytes) {
        // du printed nothing (or undercounted): the archive itself is over the limit.
        record.skipped = "too_large";
        this.recorder.event("snapshot", { stage: "skip", reason: "too_large", bytes, max_bytes: this.maxBytes, request_index: requestIndex });
        void this.env.exec(`rm -f ${shellQuote(envPath)}`, { timeoutMs: 15_000, internal: true }).catch(() => undefined);
        return;
      }
      record.path = envPath;
      this.recorder.event("snapshot", {
        stage: "tar", request_index: requestIndex, levers_pending: record.levers_pending, bytes, cwd_bytes: record.cwd_bytes, ms: record.tar_ms,
        ...(record.sha256 === undefined ? {} : { sha256: record.sha256 }), ...(record.tar_warning === undefined ? {} : { tar_warning: record.tar_warning }),
      });
      if (this.hostDir !== undefined) this.copying = this.copy(record, envPath, bytes, this.hostDir);
    } catch (error) {
      record.skipped = "failed";
      record.error = message(error).slice(0, 500);
      delete record.path;
      this.recorder.event("snapshot", { stage: "failed", request_index: requestIndex, error: record.error });
    }
  }

  private async copy(record: FirstFinish, envPath: string, bytes: number, hostDir: string): Promise<void> {
    const started = performance.now();
    try {
      mkdirSync(hostDir, { recursive: true });
      const hostPath = join(hostDir, SNAPSHOT_FILE);
      const sha = await copyOut(this.env, envPath, bytes, hostPath, this.chunkBytes);
      if (record.sha256 !== undefined && record.sha256 !== sha) {
        rmSync(hostPath, { force: true });
        throw new Error(`copy sha256 ${sha} != env sha256 ${record.sha256}`);
      }
      record.sha256 = sha;
      record.path = hostPath;
      record.copy_ms = Math.round(performance.now() - started);
      await this.env.exec(`rm -f ${shellQuote(envPath)}`, { timeoutMs: 15_000, internal: true }).then(() => {
        delete record.env_path;
      }, () => undefined);
    } catch (error) {
      record.skipped = "failed";
      record.error = `copy: ${message(error)}`.slice(0, 500);
      delete record.path;
    }
  }

  /**
   * The record for result.json, once any copy has finished (or the wait ran
   * out: then `skipped: "failed"`). A run that never reached a finish attempt
   * gets `skipped: "no_finish_attempt"`. Emits the `first_finish` trace event.
   */
  async settle(aborted = false): Promise<FirstFinish> {
    const record = this.record ?? { mode: this.mode, cwd: this.env.cwd, skipped: "no_finish_attempt" as const };
    if (this.copying !== undefined) {
      const limit = aborted ? SETTLE_ABORTED_MS : SETTLE_MS;
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        this.copying.then(() => false),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(true), limit);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut && record.skipped === undefined && record.path === record.env_path) {
        record.skipped = "failed";
        record.error = `copy: still running after ${limit} ms${aborted ? " (run aborted)" : ""}`;
        delete record.path;
      }
    }
    const out = { ...record, ...(record.levers_pending === undefined ? {} : { levers_pending: [...record.levers_pending] }) };
    this.recorder.event("first_finish", { ...out });
    return out;
  }
}
