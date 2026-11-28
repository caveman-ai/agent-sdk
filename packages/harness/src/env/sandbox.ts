/**
 * SandboxEnv: ExecEnv on a Caveman sandbox, a bare fleet computer the harness drives from outside it through the
 * public sandbox API (`@caveman-ai/sdk/sandboxes`) with the caller's own key: on the harness pool, the session's key,
 * so the computer is made, metered and refused as any API caller's would be. Nothing is installed in the computer and
 * it holds no credential: the key only ever travels as the API's bearer, never in a command's environment.
 *
 * The computer is made on the first call that needs one (exec, a file call, scratchDir), not before: cwd, user and os
 * are fixed facts of the image (/workspace, tools, linux: the guest agent's own, Caveman Cloud Sandboxes
 * guestagent), so the system prompt is written before any computer exists, and an agent that never calls a tool makes
 * none. Given `computerId` (a kept computer, or the session's from an earlier claim), it uses that one instead. The
 * create carries no shape (the API decides a session computer's size, network, lifetime and idle) and the session's
 * Idempotency-Key; a create the API refuses because the session has its computer already
 * (cave_code_session_computer_exists, its details.computer_id) attaches that one. Only a computer this env made gets
 * the host's `files` (a build's own), written into cwd once, as one batch, before the first call runs. What happens to
 * the computer is told through `onEvent` (made, attached, woke, released, lost): the session's `session.sandbox` events.
 *
 * Every ExecEnv call is one stream through the relay (the SDK's exec or files), so it costs one round trip:
 * - exec opens one exec stream. A command past its yield keeps its stream as its handle; poll and wait read what came
 *   on it, and kill sends its process group SIGKILL on it and waits for its end. The guest runs every command in a
 *   process group of its own and kills that group when the stream ends before the command does, so an abort, a
 *   timeout and close() all end everything a command started. A wrapper (as DockerEnv's) folds stderr into stdout
 *   (one stream, arrival order kept), says its pid and the computer's boot id first, and says the exit with a per-env
 *   nonce last: the command finishes at that mark plus the 250 ms pipe grace LocalEnv gives, even while a child it
 *   backgrounded holds its output open. Such a stream stays open (the child keeps running) until the child lets go
 *   or the env closes; while any stream is open the fleet does not pause the computer.
 * - read, write, stat and list are the files verb; readFiles and writeFiles issue theirs concurrently, BATCH at a time.
 *   A write whose folder is not there makes it (mkdir -p) and writes again.
 * - A stream the API refuses before it opens (its rate per caller, the computer's stream count) is opened again after
 *   the wait it asks, up to RATE_WAIT_MS: nothing ran. A computer put to sleep is woken (resume, then wait for it to
 *   run) and the call made again; one that came back without its memory (a new boot id) is said once, in the next
 *   command's output. A computer that is gone is `lost`: every later call fails saying so, and none is made in its
 *   place (one computer per session).
 *
 * Process groups: kills go to the group the guest made for the command; a daemon that left it (setsid) still carries
 * HARNESS_PROC=<env tag>.<handle>, and close() kills every process carrying the tag, then removes the scratch dir, in
 * one more stream.
 */
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import {
  SandboxCommand,
  SandboxError,
  SandboxExecError,
  Sandboxes,
  SandboxStateError,
  type CodeComputer,
  type SandboxFileInfo,
} from "@caveman-ai/sdk/sandboxes";
import { fileError } from "./docker.ts";
import { ENV_DEFAULTS, keptPrefix, utf8End } from "./local.ts";
import type { DirEntry, ExecEnv, ExecOptions, ExecResult, FileStat, ReadRange } from "./types.ts";

const CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const PIPE_GRACE_MS = 250;
/** How long a killed command may take to report its end before it is finished here anyway. */
const KILL_SETTLE_MS = 2_000;
/** How long a command's first line (its pid) may take once its stream is asked for. */
const START_TIMEOUT_MS = 60_000;
/** How long refusals that ask to wait (a rate, a stream count) are waited out before the call fails. */
const RATE_WAIT_MS = 60_000;
/** How many file streams a batch (readFiles, writeFiles) has open at once: the burst a caller's stream rate allows. */
const BATCH = 20;
const READY_TIMEOUT_MS = 120_000;
const BOOT_ID = "/proc/sys/kernel/random/boot_id";
/** A segment of a repository's owner or name, as the lane takes it. */
const GIT_SEGMENT = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/u;
/** A clone's URL: http or https, no credentials in it (the computer holds none), no query or fragment; undefined if not. */
function gitURLOf(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return undefined;
  return url.href;
}
/** A branch git would take, never an option. */
const GIT_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,255}$/u;

/**
 * `$0` the shell, `$1` the command: say this shell's pid (its process group) and the boot id, run the command under
 * bash when the image has it, stderr on stdout and stdin empty, then say the exit mark (after all its own output).
 */
const wrapperScript = (tag: string, bootFile: string) =>
  `{ read -r b <'${bootFile}'; } 2>/dev/null || b=-; printf '\\036harness-pid-${tag}:%d:%s\\n' "$$" "$b"; ` +
  `s=/bin/sh; [ -x /bin/bash ] && s=/bin/bash; "$s" -c "$1" 2>&1 </dev/null; c=$?; printf '\\036harness-exit-${tag}:%d\\n' "$c"; exit "$c"`;
/** At acquire and after a wake: is cwd there, who runs commands, the boot id, the scratch dir ($3: keep this one). */
const PROBE = `[ -d "$1" ] || { echo nocwd; exit 0; }
echo "user=$(id -un 2>/dev/null || id -u)"
{ read -r b <"$2"; } 2>/dev/null || b=-
echo "boot=$b"
if [ -n "$3" ]; then d=$3; mkdir -p "$d" && chmod 700 "$d"; else d=$(mktemp -d /tmp/harness-run-XXXXXX 2>/dev/null) || { d=/tmp/harness-run-$$; mkdir -p "$d"; }; fi
echo "scratch=$d"`;
/**
 * The clone: $1 the folder, $2 the lane's URL, $3 the GitHub URL, $4 the base branch (empty: the default). A folder that
 * has a clone is left alone; else the lane's repository is cloned there, origin set to the GitHub URL, and the clone's
 * own config sends that URL to the lane.
 */
const CLONE = `[ -d "$1/.git" ] && { echo had; exit 0; }
if [ -n "$4" ]; then git clone --quiet --branch "$4" -- "$2" "$1"; else git clone --quiet -- "$2" "$1"; fi || exit $?
cd "$1" && git remote set-url origin "$3" && git config "url.$2.insteadOf" "$3" || exit $?
echo cloned`;
/** Which of the paths on stdin (one a line, relative to $1) are there already. */
const PRESENT = `while IFS= read -r p; do if [ -e "$1/$p" ] || [ -L "$1/$p" ]; then printf '%s\n' "$p"; fi; done; exit 0`;
/** close(): every process whose environment carries HARNESS_PROC matching "^$1" (daemons that left their group), then the scratch dir. */
const SWEEP = `t=$1
for e in /proc/[0-9]*/environ; do p=\${e#/proc/}; p=\${p%/environ}
  [ "$p" = "$$" ] && continue
  tr '\\000' '\\n' < "$e" 2>/dev/null | grep -q "^HARNESS_PROC=$t" && kill -9 "$p" 2>/dev/null
done
[ -z "$2" ] || rm -rf -- "$2"
exit 0`;

/** The create's refusal when the session has its computer already; its details.computer_id is that one. */
const SESSION_COMPUTER_EXISTS = "cave_code_session_computer_exists";

/** What happened to the session's computer: the `data` of a `session.sandbox` event. */
export interface SandboxEvent {
  action: "made" | "attached" | "woke" | "released" | "lost";
  computer_id: string;
  size?: string;
  image?: string;
  network?: string;
  /** keep, as the computer's answer says it. */
  keep?: string;
  /** From the first request to a computer that runs commands (made, attached, woke). */
  ready_ms?: number;
  /** It came back from a sleep that kept its disk alone: the processes it ran are gone. */
  slept_without_memory?: boolean;
  /** Why it is lost. */
  reason?: string;
}

export interface SandboxEnvOptions {
  /** The Caveman Cloud API origin (https://app.caveman.so). */
  controlURL: string;
  /** The origin that serves /relay (the streams); absent, controlURL. */
  relayURL?: string;
  /** The key the computer is made and used with: on the pool, the session's own. It never reaches the computer. */
  apiKey: string;
  /** A computer to use (kept, attached, or the session's from an earlier claim); absent, one is made on the first call. */
  computerId?: string;
  /** The create's Idempotency-Key (`session-<id>` on the pool): a create asked again answers the computer the first made. */
  idempotencyKey?: string;
  /**
   * Files (a build's own; paths relative to cwd) written into a computer this env makes, once, as one batch, before
   * the first call runs; never into one it attaches. Read only when a computer is made.
   */
  files?: () => Promise<{ path: string; data: Uint8Array | string }[]>;
  /**
   * The session's repository, cloned into cwd once the computer runs (made, or attached without the clone; one that
   * has it is left alone) from `gitURL`, where the computer reaches it (on the fleet, its host's git lane,
   * http://172.16.0.1:47483/git/v1/<owner>/<name>.git: git's smart HTTP, no credential in the computer; Cloud says
   * which). Its base branch is checked out, origin is https://github.com/<owner>/<name>.git, and the clone's own config
   * sends that URL to gitURL (`url.<gitURL>.insteadOf`), so fetch and push by it work as on a laptop.
   */
  repository?: { owner: string; name: string; baseBranch?: string; gitURL: string };
  /** The working directory in the computer (default /workspace, the image's). */
  cwd?: string;
  /** The user commands run as, as the image has it (default tools); the probe's answer replaces it once known. */
  user?: string;
  /**
   * Variables for every command, over ENV_DEFAULTS: on the pool, a build's secrets. They travel only in the exec stream
   * that starts each command (its env option), so they live in that command's processes alone: nothing writes them
   * into the computer (no file, no profile, no event), and a command started without them never sees them.
   */
  env?: Record<string, string>;
  /** How long a computer may take to run, made, attached or woken (default 120 000 ms). */
  readyTimeoutMs?: number;
  onEvent?: (event: SandboxEvent) => void;
  /** The SDK's transport (tests); default fetch. */
  fetch?: typeof globalThis.fetch;
  /** The SDK's first wait before a retry (tests: 0). */
  retryDelayMs?: number;
  /** Tests: the file the boot id is read from (default the kernel's). */
  bootIdFile?: string;
}

interface Proc {
  id: string;
  kept: Buffer[];
  keptBytes: number;
  totalBytes: number;
  cursor: number;
  truncated: boolean;
  startedAt: number;
  exitCode: number | null;
  finished: boolean;
  done: Promise<void>;
  settle: () => void;
  timedOut: boolean;
  killed: boolean;
  timers: NodeJS.Timeout[];
  held?: Buffer | undefined;
  pid: number;
  status?: number;
  terminating?: Promise<void>;
  onOutput?: (chunk: string) => void;
  offAbort?: () => void;
  started: Promise<boolean>;
  onStarted: (ok: boolean) => void;
  control: SandboxCommand;
  abort: AbortController;
  /** Settles when the command's stream has ended (its exit, a failure, or an abort). */
  stream: Promise<void>;
  streamEnded: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((done) => {
  const wake = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", wake);
    done();
  };
  const timer = setTimeout(wake, ms);
  signal?.addEventListener("abort", wake, { once: true });
});

async function within(work: Promise<unknown>, ms: number): Promise<void> {
  const stop = new AbortController();
  await Promise.race([work, sleep(ms, stop.signal)]);
  stop.abort();
}

/** Where a suffix of `buf` that is a proper prefix of `mark` starts (buf.length if none). */
function partialAt(buf: Buffer, mark: Buffer): number {
  for (let i = Math.max(0, buf.length - mark.length + 1); i < buf.length; i++) {
    if (buf[i] === mark[0] && mark.subarray(0, buf.length - i).equals(buf.subarray(i))) return i;
  }
  return buf.length;
}

const KINDS: Record<SandboxFileInfo["type"], FileStat["kind"]> = { file: "file", dir: "directory", symlink: "symlink", other: "other" };
const isCode = (error: unknown, ...codes: string[]) => error instanceof SandboxExecError && codes.includes(error.code);
const errorText = (error: unknown) => error instanceof Error ? `${(error as { code?: unknown }).code === undefined ? "" : `${String((error as { code?: unknown }).code)}: `}${error.message}` : String(error);

/** A files-verb refusal as node:fs would throw it, which the tools read (ENOENT, EISDIR, ENOTDIR, EACCES). */
function asFileError(error: unknown, syscall: string, target: string): Error {
  if (!(error instanceof SandboxExecError)) return error instanceof Error ? error : new Error(String(error));
  switch (error.code) {
    case "cave_code_computer_file_not_found": return fileError("ENOENT", syscall, target);
    case "cave_code_computer_file_permission": return fileError("EACCES", syscall, target);
    case "cave_code_computer_file_exists": return fileError("EEXIST", syscall, target, "file already exists");
    case "cave_code_computer_file_too_large": return fileError("ENOSPC", syscall, target, error.message);
    case "cave_code_computer_file_refused":
      if (/is a directory/iu.test(error.message)) return fileError("EISDIR", "read", target);
      if (/not a directory/iu.test(error.message)) return fileError("ENOTDIR", syscall, target);
      return fileError("EIO", syscall, target, error.message);
    default:
      return fileError("EIO", syscall, target, `${error.code}: ${error.message}`);
  }
}

export class SandboxEnv implements ExecEnv {
  readonly cwd: string;
  readonly os = "linux";
  readonly #client: Sandboxes;
  readonly #options: SandboxEnvOptions;
  readonly #baseEnv: Record<string, string>;
  readonly #procs = new Map<string, Proc>();
  /** Commands whose stream is open: running, or finished while a child they backgrounded holds it. */
  readonly #open = new Set<Proc>();
  readonly #tag = randomUUID().slice(0, 12);
  readonly #pidMark = Buffer.from(`\x1eharness-pid-${this.#tag}:`);
  readonly #mark = Buffer.from(`\x1eharness-exit-${this.#tag}:`);
  readonly #wrapper: string;
  #user: string;
  #computerId: string | undefined;
  /** The session's computer, as the create's refusal named it. */
  #existing: string | undefined;
  /** This env made the computer and has not yet written the host's files into it. */
  #seedPending = false;
  #computer: CodeComputer | undefined;
  #acquiring: Promise<string> | undefined;
  #ready = false;
  #waking: Promise<void> | undefined;
  #lost: string | undefined;
  #boot: string | undefined;
  /** The computer came back without its memory: the next command's output says so first. */
  #sleptNote = false;
  #scratch = "";
  #nextId = 0;
  #nextInternalId = 0;
  #closed = false;

  constructor(options: SandboxEnvOptions) {
    this.#options = options;
    this.cwd = posix.resolve(options.cwd ?? "/workspace");
    this.#user = options.user ?? "tools";
    this.#computerId = options.computerId;
    this.#baseEnv = { ...ENV_DEFAULTS, ...(options.env ?? {}) };
    this.#wrapper = wrapperScript(this.#tag, options.bootIdFile ?? BOOT_ID);
    const key = options.idempotencyKey;
    const transport = options.fetch ?? globalThis.fetch;
    const createURL = `${new URL(options.controlURL).origin}/api/v1/code/computers`;
    this.#client = new Sandboxes({
      controlURL: options.controlURL,
      apiKey: options.apiKey,
      ...(options.relayURL === undefined ? {} : { relayURL: options.relayURL }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
      // The create's transport: the SDK sends no Idempotency-Key and keeps no error's details, so the key rides here and
      // a refusal for the session's computer is read here for its details.computer_id.
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (init?.method !== "POST" || url !== createURL) return await transport(input, init);
        const response = await transport(input, key === undefined ? init : { ...init, headers: { ...(init.headers as Record<string, string>), "idempotency-key": key } });
        if (response.status === 409) {
          const body = await response.clone().json().catch(() => undefined) as { error?: { code?: unknown; details?: { computer_id?: unknown } } } | undefined;
          const id = body?.error?.details?.computer_id;
          if (body?.error?.code === SESSION_COMPUTER_EXISTS && typeof id === "string" && id !== "") this.#existing = id;
        }
        return response;
      },
    });
  }

  /** `sandbox:<computer id>` once there is one, `sandbox` before. */
  get id(): string {
    return this.#computerId === undefined ? "sandbox" : `sandbox:${this.#computerId}`;
  }

  /** The user commands run as: the image's, as the probe saw it once there is a computer. */
  get user(): string {
    return this.#user;
  }

  /** The computer's id, once made or named. */
  get computerId(): string | undefined {
    return this.#computerId;
  }

  resolvePath(path: string): string {
    return posix.resolve(this.cwd, path);
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const proc = this.#newProc(options);
    let computer: string;
    try {
      computer = await this.#acquire(options.signal);
    } catch (error) {
      if (options.signal?.aborted === true) {
        proc.killed = true;
        this.#finish(proc, null);
      } else {
        this.#note(proc, `no computer to run this on: ${errorText(error)}`);
        this.#finish(proc, 127);
      }
      return this.#snapshot(proc);
    }
    await this.#start(proc, computer, command, options);
    if (options.signal?.aborted === true) await this.#terminate(proc, "killed");
    const yieldMs = options.background === true ? 0 : options.yieldMs;
    if (yieldMs === 0) return this.#snapshot(proc);
    await this.#race(proc, yieldMs, options.signal);
    if (options.signal?.aborted === true) await this.#terminate(proc, "killed");
    return this.#snapshot(proc);
  }

  async poll(handle: string): Promise<ExecResult> {
    return this.#snapshot(this.#proc(handle));
  }

  async wait(handle: string, ms: number, signal?: AbortSignal): Promise<ExecResult> {
    const proc = this.#proc(handle);
    await this.#race(proc, ms, signal);
    return this.#snapshot(proc);
  }

  async kill(handle: string): Promise<ExecResult> {
    const proc = this.#proc(handle);
    await this.#terminate(proc, "killed");
    return this.#snapshot(proc);
  }

  async readFile(path: string, range?: ReadRange): Promise<Uint8Array> {
    const target = this.resolvePath(path);
    const id = await this.#acquire();
    const ranged = range !== undefined && (range.offset !== undefined || range.length !== undefined);
    if (!ranged) return await this.#retrying(() => this.#client.readFile(id, target)).catch((error: unknown) => { throw asFileError(error, "open", target); });
    const offset = Math.max(0, Math.floor(range.offset ?? 0));
    if (range.length !== undefined && range.length <= 0) {
      if ((await this.stat(target)) === undefined) throw fileError("ENOENT", "open", target);
      return new Uint8Array(0);
    }
    if (range.length === undefined) {
      const all = await this.#retrying(() => this.#client.readFile(id, target)).catch((error: unknown) => { throw asFileError(error, "open", target); });
      return all.subarray(offset);
    }
    // A bounded range: the stream is ended once offset + length bytes came, so a page of a large file reads its head only.
    const want = offset + Math.floor(range.length);
    const parts: Uint8Array[] = [];
    let got = 0;
    const enough = new Error("enough");
    await this.#retrying(() => {
      parts.length = 0;
      got = 0;
      const stop = new AbortController();
      return this.#client.streamFile(id, target, (chunk) => {
        parts.push(chunk);
        got += chunk.length;
        if (got >= want) stop.abort(enough);
      }, { signal: stop.signal }).then(() => undefined, (error: unknown) => {
        if (error !== enough) throw error;
      });
    }).catch((error: unknown) => { throw asFileError(error, "open", target); });
    return Buffer.concat(parts).subarray(offset, want);
  }

  /** Each file on a stream of its own, BATCH at a time, in input order; a file that cannot be read is its Error. */
  async readFiles(paths: string[]): Promise<(Uint8Array | Error)[]> {
    const results: (Uint8Array | Error)[] = new Array(paths.length);
    await this.#batch(paths.length, async (at) => {
      results[at] = await this.readFile(paths[at]!).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    });
    return results;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await this.#write(await this.#acquire(), path, data);
  }

  /** Each file on a stream of its own, BATCH at a time; the first failure is thrown once all have been tried. */
  async writeFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    await this.#writeBatch(await this.#acquire(), files);
  }

  async #writeBatch(id: string, files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    let failure: unknown;
    await this.#batch(files.length, async (at) => {
      await this.#write(id, files[at]!.path, files[at]!.data).catch((error: unknown) => { failure ??= error; });
    });
    if (failure !== undefined) throw failure;
  }

  async #write(id: string, path: string, data: Uint8Array | string): Promise<void> {
    const target = this.resolvePath(path);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    try {
      await this.#retrying(() => this.#client.writeFile(id, target, bytes));
      return;
    } catch (error) {
      if (!isCode(error, "cave_code_computer_file_not_found")) throw asFileError(error, "open", target);
    }
    // Its folder is not there: make it and its parents (one there is no error), then write again.
    const folder = posix.dirname(target);
    await this.#retrying(() => this.#client.makeDir(id, folder, { parents: true })).catch((error: unknown) => { throw asFileError(error, "mkdir", folder); });
    await this.#retrying(() => this.#client.writeFile(id, target, bytes)).catch((error: unknown) => { throw asFileError(error, "open", target); });
  }

  /** Symlinks followed (a dangling one is a symlink); undefined when there is nothing there. */
  async stat(path: string): Promise<FileStat | undefined> {
    const target = this.resolvePath(path);
    const id = await this.#acquire();
    const statOf = (at: string) => this.#retrying(() => this.#client.statFile(id, at));
    let info: SandboxFileInfo;
    try {
      info = await statOf(target);
    } catch (error) {
      if (isCode(error, "cave_code_computer_file_not_found")) return undefined;
      throw asFileError(error, "stat", target);
    }
    let at = target;
    for (let hops = 0; info.type === "symlink" && info.link !== undefined && hops < 8; hops++) {
      at = posix.resolve(posix.dirname(at), info.link);
      const next = await statOf(at).catch(() => undefined);
      if (next === undefined) return { kind: "symlink", size: info.size, mtimeMs: Date.parse(info.mtime) || 0 };
      info = next;
    }
    return { kind: KINDS[info.type] ?? "other", size: info.size, mtimeMs: Date.parse(info.mtime) || 0 };
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const target = this.resolvePath(path);
    const id = await this.#acquire();
    const entries = await this.#retrying(() => this.#client.listFiles(id, target)).catch((error: unknown) => { throw asFileError(error, "scandir", target); });
    return entries.map((entry) => ({ name: entry.name, kind: KINDS[entry.type] ?? "other" }));
  }

  async scratchDir(): Promise<string> {
    await this.#acquire();
    return this.#scratch;
  }

  /** Live handles, for tests and diagnostics. */
  liveHandles(): string[] {
    return [...this.#procs.values()].filter((proc) => !proc.finished).map((proc) => proc.id);
  }

  /**
   * Ends every command this env started (each stream's process group killed, then the stream ended), kills the
   * processes that left their group, removes the scratch dir and says `released`. The computer itself stays: deleting
   * a session's computer is the session's end's (the pool's finish), a kept one is its owner's.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#acquiring?.catch(() => undefined);
    const live = [...this.#open];
    for (const proc of live) {
      if (!proc.finished) proc.killed = true;
      this.#signal(proc);
    }
    await within(Promise.all(live.map((proc) => proc.stream)), KILL_SETTLE_MS);
    for (const proc of live) {
      proc.abort.abort(new Error("closed"));
      this.#finish(proc, null);
    }
    this.#procs.clear();
    this.#open.clear();
    const id = this.#computerId;
    if (id === undefined || !this.#ready || this.#lost !== undefined) return;
    // One stream, never a wake: a computer asleep has no process of ours left.
    await this.#client.run(id, ["/bin/sh", "-c", SWEEP, "harness", `${this.#tag}\\.`, this.#scratch], { cwd: "/", signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    this.#emit({ action: "released" });
  }

  // ── the computer ────────────────────────────────────────────

  /** The computer's id once it runs commands: made (or found) on the first call, shared by every call after. */
  async #acquire(signal?: AbortSignal): Promise<string> {
    if (this.#lost !== undefined) throw new Error(this.#lost);
    if (this.#closed) throw new Error("the sandbox env is closed");
    if (this.#ready) return this.#computerId!;
    const acquiring = this.#acquiring ??= this.#make().then((id) => {
      this.#ready = true;
      return id;
    }, (error: unknown) => {
      this.#acquiring = undefined;
      throw error;
    });
    if (signal === undefined) return await acquiring;
    signal.throwIfAborted();
    let off: (() => void) | undefined;
    try {
      return await Promise.race([acquiring, new Promise<never>((_, fail) => {
        const stop = () => fail(signal.reason);
        signal.addEventListener("abort", stop, { once: true });
        off = () => signal.removeEventListener("abort", stop);
      })]);
    } finally {
      off?.();
    }
  }

  async #make(): Promise<string> {
    const began = performance.now();
    const timeoutMs = this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    let action: "made" | "attached" = "attached";
    let computer: CodeComputer | undefined;
    if (this.#computerId === undefined) {
      computer = await this.#create();
      if (computer !== undefined) {
        action = "made";
        this.#seedPending = this.#options.files !== undefined;
      }
      this.#computerId = computer?.id ?? this.#existing!;
    }
    const id = this.#computerId;
    if (computer === undefined) {
      computer = await this.#client.get(id).catch(async (error: unknown) => { throw await this.#gone(error); });
      if (computer.desired_state !== "running") computer = await this.#client.resume(id).catch(async (error: unknown) => { throw await this.#gone(error); });
    }
    this.#computer = computer;
    if (computer.observed_state !== "running") {
      computer = await this.#client.waitFor(id, "running", { timeoutMs }).catch(async (error: unknown) => { throw await this.#gone(error); });
      this.#computer = computer;
    }
    await this.#probe(id, true);
    if (this.#options.repository !== undefined) await this.#clone(id, this.#options.repository);
    if (this.#seedPending) {
      // The build's own files, before any call runs: once, into the computer made here (a failure is tried again with
      // the next call, never into another).
      await this.#seed(id, await this.#options.files!());
      this.#seedPending = false;
    }
    this.#emit({ action, ready_ms: Math.round(performance.now() - began) });
    return id;
  }

  /** The session's repository into cwd from its git URL (CLONE), unless the computer has the clone already. */
  async #clone(id: string, repository: NonNullable<SandboxEnvOptions["repository"]>): Promise<void> {
    const { owner, name, baseBranch, gitURL } = repository;
    if (!GIT_SEGMENT.test(owner) || !GIT_SEGMENT.test(name)) throw new Error(`the repository ${JSON.stringify(`${owner}/${name}`)} is not an owner and a name git takes`);
    if (baseBranch !== undefined && !GIT_BRANCH.test(baseBranch)) throw new Error(`the base branch ${JSON.stringify(baseBranch)} is not a branch name`);
    const lane = gitURLOf(gitURL);
    if (lane === undefined) throw new Error(`the repository's git URL ${JSON.stringify(gitURL)} is not an http(s) URL without credentials`);
    const out = await this.#retrying(() => this.#client.run(id, ["/bin/sh", "-c", CLONE, "harness", this.cwd, lane, `https://github.com/${owner}/${name}.git`, baseBranch ?? ""],
      { cwd: "/", env: this.#baseEnv }));
    if (out.exitCode !== 0) throw new Error(`the repository ${owner}/${name} could not be cloned from ${lane} (exit ${out.exitCode}): ${(out.stdout + out.stderr).trim().slice(-600)}`);
  }

  /**
   * The host's files into a computer made here. With a repository cloned there, a file never replaces one of the
   * repository's, and each is kept out of git (the clone's .git/info/exclude), so a commit never takes the build's.
   */
  async #seed(id: string, files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    if (this.#options.repository !== undefined && files.length > 0) {
      const listed = files.filter((file) => !file.path.includes("\n"));
      const out = await this.#retrying(() => this.#client.run(id, ["/bin/sh", "-c", PRESENT, "harness", this.cwd], { cwd: "/", stdin: listed.map((file) => `${file.path}\n`).join("") }));
      const present = new Set(out.stdout.split("\n").filter((line) => line !== ""));
      files = files.filter((file) => !present.has(file.path));
      const exclude = this.resolvePath(".git/info/exclude");
      const before = await this.#retrying(() => this.#client.readFile(id, exclude)).then((data) => Buffer.from(data).toString("utf8"), () => "");
      // Each path anchored at the top, git's pattern characters escaped, so it names that one file.
      const lines = files.map((file) => `/${file.path.replace(/[\\*?[\]!# ]/gu, (c) => `\\${c}`)}`);
      if (lines.length > 0) await this.#write(id, exclude, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}# the session's build (Caveman)\n${lines.join("\n")}\n`);
    }
    await this.#writeBatch(id, files);
  }

  /**
   * POST /code/computers with no shape (the API decides a session computer's), asked again only when its answer was
   * lost and an Idempotency-Key makes that safe. Undefined: the session has its computer already (#existing), to attach.
   */
  async #create(): Promise<CodeComputer | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#client.create({});
      } catch (error) {
        if (error instanceof SandboxError && error.code === SESSION_COMPUTER_EXISTS && this.#existing !== undefined) return undefined;
        const lostAnswer = error instanceof SandboxError && (error.status === 0 || [502, 503, 504].includes(error.status)) && error.code !== "cave_code_computer_start_ceiling";
        if (!lostAnswer || this.#options.idempotencyKey === undefined || attempt >= 3) throw error;
        await sleep(500 * 2 ** attempt);
      }
    }
  }

  /**
   * One stream: the cwd is there, who runs commands, the boot id, the scratch dir (made, or made again after a wake).
   * `wake`: a computer found asleep is woken first (never from inside a wake, which is what probes it).
   */
  async #probe(id: string, wake: boolean): Promise<void> {
    const out = await this.#retrying(() => this.#client.run(id, ["/bin/sh", "-c", PROBE, "harness", this.cwd, this.#options.bootIdFile ?? BOOT_ID, this.#scratch], { cwd: "/" }),
      undefined, () => true, wake);
    if (out.stdout.startsWith("nocwd")) throw new Error(`the computer has no folder ${this.cwd}`);
    const facts = Object.fromEntries(out.stdout.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (out.exitCode !== 0 || facts.scratch === undefined || facts.scratch === "") {
      throw new Error(`the computer's first command failed (exit ${out.exitCode}): ${(out.stderr || out.stdout).trim().slice(0, 300)}`);
    }
    if (facts.user !== undefined && facts.user !== "") this.#user = facts.user;
    this.#scratch = facts.scratch;
    this.#observeBoot(facts.boot);
  }

  /** A new boot id: the computer slept without its memory since the last command. True when it changed. */
  #observeBoot(boot: string | undefined): boolean {
    if (boot === undefined || boot === "" || boot === "-") return false;
    const before = this.#boot;
    this.#boot = boot;
    if (before === undefined || before === boot) return false;
    this.#sleptNote = true;
    return true;
  }

  /** A computer put to sleep: woken (resume, then wait for it to run, then probed), once for every call that found it so. */
  #wake(): Promise<void> {
    return this.#waking ??= (async () => {
      const id = this.#computerId!;
      const began = performance.now();
      try {
        await this.#client.resume(id);
        this.#computer = await this.#client.waitFor(id, "running", { timeoutMs: this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS });
      } catch (error) {
        throw await this.#gone(error);
      }
      const before = this.#boot;
      await this.#probe(id, false);
      const slept = before !== undefined && this.#boot !== before;
      if (slept) this.#sleptNote = true;
      this.#emit({ action: "woke", ready_ms: Math.round(performance.now() - began), ...(slept ? { slept_without_memory: true } : {}) });
    })().finally(() => {
      this.#waking = undefined;
    });
  }

  /**
   * An error that says the computer is gone (not found, deleted, failed for good) makes it lost, and is answered as
   * the error to throw. A stream refused as not found is checked with a read first: the relay says not found for a
   * key it does not know too.
   */
  async #gone(error: unknown): Promise<unknown> {
    let notFound = error instanceof SandboxError && error.status === 404;
    if (!notFound && error instanceof SandboxExecError && error.status === 404 && this.#computerId !== undefined) {
      notFound = await this.#client.get(this.#computerId).then((c) => c.desired_state === "deleted", (e: unknown) => e instanceof SandboxError && e.status === 404);
    }
    const ended = error instanceof SandboxStateError && (error.sandbox.desired_state === "deleted" || error.sandbox.observed_state === "failed" || error.sandbox.observed_state === "deleted");
    if (!notFound && !ended) return error;
    if (this.#lost === undefined && this.#computerId !== undefined) {
      const reason = ended ? (error as Error).message : `it is not found (${(error as SandboxError).code})`;
      this.#lost = `the computer ${this.#computerId} is lost: ${reason}; its files and processes are gone, and this session gets no other`;
      this.#emit({ action: "lost", reason });
      for (const proc of this.#open) proc.abort.abort(new Error("lost"));
    }
    return new Error(this.#lost ?? errorText(error));
  }

  /**
   * One stream call, made again while the API refused to open it (nothing ran): after the wait a rate or a stream count
   * asks, or after waking a computer put to sleep (`wake`). `fresh` says whether the call may be made again (exec:
   * nothing of the command came back yet).
   */
  async #retrying<T>(call: () => Promise<T>, signal?: AbortSignal, fresh: () => boolean = () => true, wake = true): Promise<T> {
    const began = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (!(error instanceof SandboxExecError) || signal?.aborted === true || this.#closed || !fresh()) throw error;
        if (error.code === "cave_code_computer_not_running" && wake && attempt < 3) {
          await this.#wake();
          continue;
        }
        if (error.status === 404) throw await this.#gone(error);
        const asked = error.status > 0 && (error.status === 429 || error.status === 503) &&
          ["cave_rate_limit_exceeded", "cave_code_computer_streams_limit", "cave_internal"].includes(error.code);
        const wait = Math.min(10_000, Math.max(250, (error.retryAfter ?? 1) * 1000) * (1 + Math.min(attempt, 8) / 2));
        if (!asked || Date.now() - began + wait > RATE_WAIT_MS) throw error;
        await sleep(wait, signal);
        signal?.throwIfAborted();
      }
    }
  }

  #emit(event: Omit<SandboxEvent, "computer_id">): void {
    const computer = this.#computer;
    const said = (key: string) => {
      const value = (computer as Record<string, unknown> | undefined)?.[key];
      return typeof value === "string" && value !== "" ? { [key]: value } : {};
    };
    const full: SandboxEvent = {
      computer_id: this.#computerId ?? "",
      // What the computer's answer says of itself (the API decides a session computer's shape).
      ...said("size"), ...said("image"), ...said("network"), ...said("keep"),
      ...event,
    };
    try {
      this.#options.onEvent?.(full);
    } catch {
      // A host's listener never breaks a tool call.
    }
  }

  async #batch(count: number, work: (at: number) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < count) await work(next++);
    };
    await Promise.all(Array.from({ length: Math.min(BATCH, count) }, worker));
  }

  // ── commands ────────────────────────────────────────────────

  #newProc(options: ExecOptions): Proc {
    let settle!: () => void;
    let onStarted!: (ok: boolean) => void;
    return {
      id: options.internal === true ? `h${++this.#nextInternalId}` : `p${++this.#nextId}`,
      kept: [], keptBytes: 0, totalBytes: 0, cursor: 0, truncated: false, startedAt: performance.now(), exitCode: null, finished: false,
      done: new Promise<void>((done) => (settle = done)), settle: () => settle(), timedOut: false, killed: false, timers: [], pid: 0,
      started: new Promise<boolean>((done) => (onStarted = done)), onStarted: (ok) => onStarted(ok),
      control: new SandboxCommand(), abort: new AbortController(), stream: Promise.resolve(), streamEnded: true,
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    };
  }

  async #start(proc: Proc, computer: string, command: string, options: ExecOptions): Promise<void> {
    const cwd = options.cwd === undefined ? this.cwd : this.resolvePath(options.cwd);
    const env = { ...this.#baseEnv, ...(options.env ?? {}), HARNESS_PROC: `${this.#tag}.${proc.id}` };
    proc.streamEnded = false;
    this.#open.add(proc);
    proc.stream = this.#retrying(() => this.#client.exec(computer, ["/bin/sh", "-c", this.#wrapper, "sh", command], {
      cwd, env, control: proc.control, signal: proc.abort.signal,
      stdout: (chunk) => this.#onStdout(proc, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
      // The wrapper's own stderr (the command's is on stdout).
      stderr: (chunk) => this.#record(proc, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
      // A signal the computer would not send: end the stream, which kills the group all the same.
      onRefused: (refusal) => { if (refusal.of === "signal") proc.abort.abort(new Error("signal refused")); },
    }), proc.abort.signal, () => proc.pid === 0 && proc.totalBytes === 0).then((code) => {
      this.#streamEnd(proc);
      if (proc.pid === 0 && !proc.killed && !proc.timedOut) this.#note(proc, `failed to start in ${this.id} (exit ${code})`);
      this.#finish(proc, proc.pid === 0 && !proc.killed && !proc.timedOut ? 127 : proc.status ?? code);
    }, (error: unknown) => {
      this.#streamEnd(proc);
      if (!proc.killed && !proc.timedOut && !proc.finished) {
        const failure = this.#lost !== undefined ? this.#lost
          : isCode(error, "cave_code_computer_stopped") ? "the computer was put to sleep or deleted while this ran; its processes were stopped"
            : errorText(error);
        this.#note(proc, proc.pid === 0 ? `failed to start in ${this.id}: ${failure}` : failure);
      }
      this.#finish(proc, proc.pid === 0 && !proc.killed && !proc.timedOut ? 127 : proc.status ?? null);
    });
    // The abort and the hard deadline hold from the call, while the stream opens (a refusal waited out) too.
    if (options.signal !== undefined) {
      const onAbort = () => void this.#terminate(proc, "killed");
      options.signal.addEventListener("abort", onAbort, { once: true });
      proc.offAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timer = setTimeout(() => void this.#terminate(proc, "timedOut"), Math.max(0, options.timeoutMs - (performance.now() - proc.startedAt)));
      timer.unref();
      proc.timers.push(timer);
    }
    const startTimer = setTimeout(() => {
      if (proc.pid !== 0) return;
      this.#note(proc, `no start in ${START_TIMEOUT_MS / 1000} s`);
      proc.abort.abort(new Error("no start"));
    }, START_TIMEOUT_MS + RATE_WAIT_MS);
    const ok = await Promise.race([proc.started, proc.done.then(() => false)]);
    clearTimeout(startTimer);
    if (ok) this.#procs.set(proc.id, proc);
  }

  #streamEnd(proc: Proc): void {
    proc.streamEnded = true;
    this.#open.delete(proc);
  }

  /** The wrapper's stdout: the pid line, the command's output, then the exit mark (held back while a chunk ends in a part of it). */
  #onStdout(proc: Proc, bytes: Buffer): void {
    if (proc.finished) return;
    if (proc.status !== undefined) return this.#record(proc, bytes);
    let buf = proc.held === undefined ? bytes : Buffer.concat([proc.held, bytes]);
    proc.held = undefined;
    if (proc.pid === 0) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length <= this.#pidMark.length + 80) {
          proc.held = Buffer.from(buf);
          return;
        }
      } else if (buf.subarray(0, this.#pidMark.length).equals(this.#pidMark)) {
        const match = /^(\d{1,10}):(.{0,64})$/su.exec(buf.subarray(this.#pidMark.length, nl).toString("latin1"));
        if (match !== null) {
          proc.pid = Number(match[1]);
          // A new boot id here: the computer came back without its memory with no wake of ours (someone else's).
          if (this.#observeBoot(match[2])) this.#emit({ action: "woke", slept_without_memory: true });
          if (this.#sleptNote) {
            this.#sleptNote = false;
            this.#note(proc, "the computer slept without its memory since the last command: the processes it ran were stopped (files are kept)");
          }
          proc.onStarted(true);
          buf = buf.subarray(nl + 1);
        }
      }
      if (proc.pid === 0) return this.#record(proc, buf);
    }
    const at = buf.indexOf(this.#mark);
    if (at === -1) {
      const keep = partialAt(buf, this.#mark);
      if (keep > 0) this.#record(proc, buf.subarray(0, keep));
      if (keep < buf.length) proc.held = Buffer.from(buf.subarray(keep));
      return;
    }
    const digitsAt = at + this.#mark.length;
    const end = buf.indexOf(0x0a, digitsAt);
    const digits = buf.subarray(digitsAt, end === -1 ? buf.length : end).toString("latin1");
    if (end === -1 && /^\d{0,3}$/u.test(digits)) {
      if (at > 0) this.#record(proc, buf.subarray(0, at));
      proc.held = Buffer.from(buf.subarray(at));
      return;
    }
    if (end === -1 || !/^\d{1,3}$/u.test(digits)) return this.#record(proc, buf);
    if (at > 0) this.#record(proc, buf.subarray(0, at));
    proc.status = Number(digits);
    if (end + 1 < buf.length) this.#record(proc, buf.subarray(end + 1));
    // All the command's own output came; a child it backgrounded may still hold the stream: its in-flight output gets
    // the grace LocalEnv gives, then the command is finished and the stream left open for the child.
    const grace = setTimeout(() => this.#finish(proc, proc.status ?? null), PIPE_GRACE_MS);
    grace.unref();
    proc.timers.push(grace);
  }

  /** A harness line in the command's output, on a line of its own. */
  #note(proc: Proc, text: string): void {
    const last = proc.kept.length === 0 ? undefined : proc.kept[proc.kept.length - 1]!.at(-1);
    this.#record(proc, Buffer.from(`${last === undefined || last === 0x0a ? "" : "\n"}[harness: ${text}]\n`));
  }

  #record(proc: Proc, chunk: Buffer): void {
    if (chunk.length === 0 || proc.finished) return;
    proc.totalBytes += chunk.length;
    const keep = proc.truncated ? 0 : keptPrefix(chunk, CAPTURE_MAX_BYTES - proc.keptBytes);
    if (keep > 0) {
      proc.kept.push(Buffer.from(chunk.subarray(0, keep)));
      proc.keptBytes += keep;
    }
    if (keep < chunk.length) proc.truncated = true;
    proc.onOutput?.(chunk.toString("utf8"));
  }

  #finish(proc: Proc, code: number | null): void {
    if (proc.finished) return;
    if (proc.held !== undefined && proc.pid !== 0) {
      // A tail that looked like the start of the mark, but the command ended without one: it was output.
      const held = proc.held;
      proc.held = undefined;
      this.#record(proc, held);
    }
    proc.finished = true;
    proc.exitCode = proc.timedOut || proc.killed ? null : code;
    for (const timer of proc.timers) clearTimeout(timer);
    proc.offAbort?.();
    // A child the command backgrounded may still hold the stream: it stays open (in #open, the child running on) until
    // the child lets go or close() ends it.
    proc.onStarted(false);
    proc.settle();
  }

  /** SIGKILL to the command's process group, on its own stream. */
  #signal(proc: Proc): void {
    try {
      proc.control.sendSignal("KILL");
    } catch {
      proc.abort.abort(new Error("killed"));
    }
  }

  /** Kill a command's group, give its stream a moment to say the end, then end the stream and finish it regardless. */
  #terminate(proc: Proc, how: "killed" | "timedOut"): Promise<void> {
    if (proc.finished) return Promise.resolve();
    proc[how] = true;
    return proc.terminating ??= (async () => {
      // Not started yet (its stream opening, or waiting out a refusal): ending the stream is the whole kill.
      if (proc.pid !== 0) {
        this.#signal(proc);
        await within(proc.stream, KILL_SETTLE_MS);
      }
      proc.abort.abort(new Error(how));
      this.#finish(proc, null);
    })();
  }

  async #race(proc: Proc, ms: number | undefined, signal?: AbortSignal): Promise<void> {
    if (proc.finished) return;
    const waits: Promise<unknown>[] = [proc.done];
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    if (ms !== undefined) waits.push(new Promise((done) => (timer = setTimeout(done, Math.max(0, ms)))));
    if (signal !== undefined) {
      if (signal.aborted) return;
      waits.push(new Promise<void>((done) => signal.addEventListener("abort", onAbort = () => done(), { once: true })));
    }
    try {
      await Promise.race(waits);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  #snapshot(proc: Proc): ExecResult {
    const all = proc.kept.length === 1 ? proc.kept[0]! : Buffer.concat(proc.kept);
    if (proc.kept.length > 1) proc.kept = [all];
    const end = proc.finished ? all.length : utf8End(all);
    const output = all.subarray(proc.cursor, end).toString("utf8");
    proc.cursor = Math.max(proc.cursor, end);
    if (proc.finished) this.#procs.delete(proc.id);
    return {
      exitCode: proc.exitCode,
      output,
      truncated: proc.truncated,
      durationMs: Math.round(performance.now() - proc.startedAt),
      totalBytes: proc.totalBytes,
      running: !proc.finished,
      ...(proc.finished ? {} : { handle: proc.id }),
      ...(proc.timedOut ? { timedOut: true } : {}),
      ...(proc.killed ? { killed: true } : {}),
    };
  }

  #proc(handle: string): Proc {
    const proc = this.#procs.get(handle);
    if (proc === undefined) throw new Error(`no background process ${JSON.stringify(handle)} (it finished and its output was returned, or it never existed)`);
    return proc;
  }
}
