/**
 * LocalEnv: ExecEnv on this host. Uncontained host execution, not isolation:
 * commands run as this user with an allowlisted environment (no ambient
 * secrets: provider keys never reach a command).
 *
 * Every command runs in its own process group so a timeout, abort or kill
 * takes its children too. A command that outlives its yield keeps running and
 * is reachable by handle until it exits or the env closes.
 *
 * Process groups are signalled only while they are known to be ours. A group
 * is ours while its leader (our child, reaped by us) lives; after the leader
 * exits, a group that still has members (a server the command backgrounded)
 * is re-probed every PRUNE_MS and dropped the moment it is empty, so a stale
 * id that the OS hands to someone else's group after a PID wrap is never
 * signalled (that would need 99,999 PIDs inside one probe interval).
 *
 * A reaper (one tiny sh per env, in its own session) holds the list of live
 * groups on a pipe from this process. If the harness dies without close()
 * (SIGKILL, OOM), the pipe closes and the reaper kills those groups, so no
 * command or server outlives its run.
 *
 * Windows (win32, or LocalEnvOptions.platform) has no process groups and none
 * of the above: commands run in a real bash (src/env/windows.ts: the host's,
 * else Git for Windows'), started without a console window, and a timeout,
 * abort, kill() or close() ends the command's process tree with
 * `taskkill /pid <pid> /T /F`. There is no reaper there: a harness killed
 * outright (not closed) leaves its commands running, and a process a finished
 * command left in the background (a server) has no live ancestor in the tree,
 * so close() does not reach it either (the Caveman engine SDK's limits too).
 * Commands get the POSIX allowlist plus WINDOWS_ENV_ALLOWLIST, read
 * case-insensitively; the self-kill guard (it reads ps) is off; with no usable
 * bash every command finishes with exit 127 and how to get one, and
 * `shellNote` tells the model which shell it writes for.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import {
  CMD_VAR, currentUid, guardedProcesses, HYGIENE_ENV, hygieneFlags, isBash, offArgvScript, selfKillRefusal, WatchStop, watchStopNote,
  type GuardedProcess, type ShellSettings,
} from "./hygiene.ts";
import type { DirEntry, ExecEnv, ExecOptions, ExecResult, FileStat, ReadRange } from "./types.ts";
import { envValue, findWindowsBash, taskkillCommand, WINDOWS_ENV_ALLOWLIST, windowsShellNote, type HostEnv, type WindowsBash } from "./windows.ts";

/** Output a command may hold in memory; beyond it bytes are counted, not kept. */
const CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
/** After a command exits, how long its pipes may stay open (a backgrounded child holding them). */
const PIPE_GRACE_MS = 250;
/** How often a group whose leader exited is probed for remaining members. */
const PRUNE_MS = 1_000;
/** Keeps the last line it read (the live group ids); at EOF kills those groups. `kill -9 "-$g"` works in bash, sh and dash. */
const REAPER = 'groups=; while IFS= read -r line; do groups=$line; done; for g in $groups; do kill -9 "-$g" 2>/dev/null; done; exit 0';
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"];
/** Variables every backend sets for commands (a pager would hang a headless run). */
export const ENV_DEFAULTS: Readonly<Record<string, string>> = { PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };

interface Proc {
  id: string;
  child: ChildProcess;
  kept: Buffer[];
  keptBytes: number;
  totalBytes: number;
  /** Bytes of `kept` already returned to a caller. */
  cursor: number;
  truncated: boolean;
  startedAt: number;
  exitCode: number | null;
  finished: boolean;
  done: Promise<void>;
  timedOut: boolean;
  killed: boolean;
  timer?: NodeJS.Timeout;
  watch?: WatchStop;
  watchStopped: boolean;
}

export interface LocalEnvOptions {
  cwd: string;
  /** Extra variables for every command (win over the allowlisted ones). */
  env?: Record<string, string>;
  /** Keep the scratch directory on close (debugging). */
  keepScratch?: boolean;
  /** The process the self-kill guard protects with its ancestors (default this one: the parent of every command's shell). */
  guardRoot?: number;
  /**
   * Windows only: the bash commands run in, an absolute path to a bash.exe (Git for Windows', MSYS2's, Cygwin's), used
   * as given. A relative path, WSL's launcher or a missing file is refused: every command then fails saying why. Default:
   * the bash of the Git install whose git.exe is on PATH, then Program Files' Git, then a bash.exe on PATH that is not WSL's.
   */
  shell?: string;
  /** The platform to behave as (default this one's): tests run the Windows branches on any host. */
  platform?: string;
}

/** Test seams, not part of the library's API. */
export interface LocalEnvInternals {
  /** The Windows bash as found, in place of a lookup on this host (the Windows branches on a POSIX host). */
  windowsBash?: WindowsBash;
}

/**
 * The host variables every command gets, over ENV_DEFAULTS: the POSIX allowlist, and on Windows also
 * WINDOWS_ENV_ALLOWLIST, read case-insensitively there (`Path` is PATH) and passed under the allowlist's names.
 */
export function allowlistedEnv(platform: string, source: HostEnv): Record<string, string> {
  const base: Record<string, string> = { ...ENV_DEFAULTS };
  if (platform !== "win32") {
    for (const key of ENV_ALLOWLIST) {
      const value = source[key];
      if (value !== undefined) base[key] = value;
    }
    return base;
  }
  for (const key of [...ENV_ALLOWLIST, ...WINDOWS_ENV_ALLOWLIST]) {
    const value = envValue(source, key);
    if (value !== undefined) base[key] = value;
  }
  return base;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

type Spawner = (file: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "once">;

/**
 * Windows: ends a command's process tree with taskkill /T /F (Git's bash launcher, the bash it started, and what that
 * started while still in the tree); if taskkill cannot start or fails, kills the child itself.
 */
export function killTree(child: Pick<ChildProcess, "pid" | "kill">, env: HostEnv = process.env, run: Spawner = spawn): void {
  if (child.pid === undefined) return;
  const fallback = () => {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  };
  const { file, args } = taskkillCommand(child.pid, env);
  try {
    const killer = run(file, args, { stdio: "ignore", windowsHide: true });
    killer.once("error", fallback);
    killer.once("exit", (code: number | null) => {
      if (code !== 0) fallback();
    });
  } catch {
    fallback();
  }
}

/** The end of `buffer` that ends on a UTF-8 character boundary. */
export function utf8End(buffer: Buffer): number {
  let end = buffer.length;
  let back = 0;
  while (back < 4 && end - back - 1 >= 0 && (buffer[end - back - 1]! & 0xc0) === 0x80) back++;
  const lead = end - back - 1;
  if (lead < 0) return end;
  const byte = buffer[lead]!;
  const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return back + 1 < need ? lead : end;
}

/**
 * How many leading bytes of `chunk` fit in `room` bytes of capture. A chunk that
 * crosses the ceiling keeps its head (pipe chunk sizes vary by host, so dropping
 * it whole made the kept size depend on the machine), cut back to a whole UTF-8
 * character.
 */
export function keptPrefix(chunk: Buffer, room: number): number {
  if (chunk.length <= room) return chunk.length;
  if (room <= 0) return 0;
  return utf8End(chunk.subarray(0, room));
}

export function currentUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

export class LocalEnv implements ExecEnv {
  readonly id = "local";
  readonly cwd: string;
  /** This host's user (commands run as it); undefined when the OS cannot name it. */
  readonly user = currentUser();
  readonly os: string;
  /** Windows: the bash commands run in and how to write for it (or that there is none), for the model's env block. */
  readonly shellNote: string | undefined;
  private readonly windows: boolean;
  /** Windows with no usable bash: why, as every command's output (exit 127). */
  private readonly noShell: string | undefined;
  private readonly procs = new Map<string, Proc>();
  /**
   * Process groups that are ours: leader alive (false) or leader exited but
   * members left at the last probe (true). close() kills them all, so a server
   * a command backgrounded dies with the run.
   */
  private readonly groups = new Map<number, boolean>();
  private pruneTimer: NodeJS.Timeout | undefined;
  private reaper: ChildProcess | undefined;
  private baseEnv: Record<string, string>;
  /** The allowlisted host variables and ENV_DEFAULTS, then the image's (options.env): hygiene slots in between. */
  private readonly hostEnv: Record<string, string>;
  private readonly imageEnv: Record<string, string>;
  private settings: ShellSettings = {};
  private readonly guardRoot: number;
  private guarded: Promise<{ procs: GuardedProcess[]; ancestors: Set<number> }> | undefined;
  private readonly shell: string;
  private readonly keepScratch: boolean;
  private scratch?: Promise<string>;
  private nextId = 0;
  private nextInternalId = 0;

  constructor(options: LocalEnvOptions, internals: LocalEnvInternals = {}) {
    this.cwd = resolve(options.cwd);
    const platform = options.platform ?? process.platform;
    this.os = platform;
    this.windows = platform === "win32";
    const base = allowlistedEnv(platform, process.env);
    this.hostEnv = base;
    this.imageEnv = { ...(options.env ?? {}) };
    this.baseEnv = { ...base, ...this.imageEnv };
    if (this.windows) {
      const found = internals.windowsBash ?? findWindowsBash({ env: process.env, isFile, bashPath: options.shell });
      this.shell = found.path ?? "bash.exe";
      this.noShell = found.path === undefined ? found.error : undefined;
      this.shellNote = windowsShellNote(found);
    } else {
      this.shell = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
      this.noShell = undefined;
      this.shellNote = undefined;
    }
    this.keepScratch = options.keepScratch === true;
    this.guardRoot = options.guardRoot ?? process.pid;
  }

  /** The loadout's shell flags (all off: commands run exactly as before). */
  configureShell(settings: ShellSettings): void {
    this.settings = { ...settings };
    const env = { ...this.hostEnv, ...(settings.hygiene === true ? HYGIENE_ENV : {}), ...this.imageEnv };
    const toolbox = settings.toolboxPath;
    const delimiter = this.windows ? win32.delimiter : posix.delimiter;
    if (toolbox !== undefined && existsSync(toolbox) && !(env.PATH ?? "").split(delimiter).includes(toolbox)) {
      env.PATH = env.PATH === undefined || env.PATH === "" ? toolbox : `${env.PATH}${delimiter}${toolbox}`;
    }
    this.baseEnv = env;
  }

  resolvePath(path: string): string {
    return resolve(this.cwd, path);
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (this.noShell !== undefined) {
      const output = `${this.noShell}\n`;
      return { exitCode: 127, output, truncated: false, durationMs: 0, totalBytes: Buffer.byteLength(output), running: false };
    }
    // The guard reads the process table with ps, which Windows does not have.
    if (this.settings.selfKillGuard === true && !this.windows && /kill|pidof/u.test(command)) {
      // Guarded: the root (this harness) and its ancestors; the ones that are this process's own ancestors matter to BSD pkill.
      this.guarded ??= Promise.all([guardedProcesses(this.guardRoot), this.guardRoot === process.pid ? undefined : guardedProcesses(process.pid)])
        .then(([procs, own]) => ({ procs, ancestors: new Set((own ?? procs).map((proc) => proc.pid)) }));
      const { procs, ancestors } = await this.guarded;
      const refusal = selfKillRefusal(command, procs, { user: this.user, uid: currentUid(), ancestors });
      if (refusal !== undefined) {
        return { exitCode: 1, output: `${refusal}\n`, truncated: false, durationMs: 0, totalBytes: Buffer.byteLength(refusal) + 1, running: false, refused: true };
      }
    }
    const proc = this.start(command, options);
    const yieldMs = options.background === true ? 0 : options.yieldMs;
    if (yieldMs === 0) return this.snapshot(proc);
    await this.race(proc, yieldMs, options.signal);
    return this.snapshot(proc);
  }

  async poll(handle: string): Promise<ExecResult> {
    return this.snapshot(this.proc(handle));
  }

  async wait(handle: string, ms: number, signal?: AbortSignal): Promise<ExecResult> {
    const proc = this.proc(handle);
    await this.race(proc, ms, signal);
    return this.snapshot(proc);
  }

  async kill(handle: string): Promise<ExecResult> {
    const proc = this.proc(handle);
    if (!proc.finished) {
      proc.killed = true;
      this.killGroup(proc);
      await Promise.race([proc.done, new Promise((done) => setTimeout(done, 2_000))]);
    }
    return this.snapshot(proc);
  }

  async readFile(path: string, range?: ReadRange): Promise<Uint8Array> {
    const target = this.resolvePath(path);
    if (range === undefined || (range.offset === undefined && range.length === undefined)) return await readFile(target);
    const file = await open(target, "r");
    try {
      const offset = range.offset ?? 0;
      const length = range.length ?? Math.max(0, (await file.stat()).size - offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await file.close();
    }
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const target = this.resolvePath(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async readFiles(paths: string[]): Promise<(Uint8Array | Error)[]> {
    return await Promise.all(paths.map((path) => this.readFile(path).catch((error: Error) => error)));
  }

  async writeFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    await Promise.all(files.map((file) => this.writeFile(file.path, file.data)));
  }

  async stat(path: string): Promise<FileStat | undefined> {
    try {
      const info = await lstat(this.resolvePath(path));
      const kind = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
      if (kind === "symlink") {
        const followed = await stat(this.resolvePath(path)).catch(() => undefined);
        if (followed !== undefined) return { kind: followed.isDirectory() ? "directory" : followed.isFile() ? "file" : "other", size: followed.size, mtimeMs: followed.mtimeMs };
      }
      return { kind, size: info.size, mtimeMs: info.mtimeMs };
    } catch {
      return undefined;
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const entries = await readdir(this.resolvePath(path), { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      kind: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    }));
  }

  scratchDir(): Promise<string> {
    return this.scratch ??= mkdtemp(join(tmpdir(), "harness-run-"));
  }

  async close(): Promise<void> {
    const live = [...this.procs.values()].filter((proc) => !proc.finished);
    for (const proc of live) {
      proc.killed = true;
      this.killGroup(proc);
    }
    for (const [group, orphaned] of this.groups) { // none on Windows
      if (orphaned && !groupAlive(group)) continue; // emptied since the last probe: the id may not be ours any more
      try {
        process.kill(-group, "SIGKILL");
      } catch {
        // already gone
      }
    }
    this.groups.clear();
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    if (this.reaper !== undefined) {
      this.reaper.stdin?.end("\n"); // an empty list: the reaper exits without killing anything
      this.reaper = undefined;
    }
    await Promise.race([Promise.all(live.map((proc) => proc.done)), new Promise((done) => setTimeout(done, 2_000))]);
    this.procs.clear();
    if (this.scratch !== undefined && !this.keepScratch) {
      const path = await this.scratch.catch(() => undefined);
      if (path !== undefined) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Live processes, for tests and diagnostics. */
  liveHandles(): string[] {
    return [...this.procs.values()].filter((proc) => !proc.finished).map((proc) => proc.id);
  }

  /** Process groups this env would signal at close, for tests and diagnostics. */
  trackedGroups(): number[] {
    return [...this.groups.keys()];
  }

  /** The reaper's pid (started with the first command), for tests. */
  reaperPid(): number | undefined {
    return this.reaper?.pid;
  }

  /** Tell the reaper the current groups (one line, last line wins). */
  private syncReaper(): void {
    if (this.reaper === undefined) {
      if (this.groups.size === 0) return;
      const reaper = spawn("/bin/sh", ["-c", REAPER], { stdio: ["pipe", "ignore", "ignore"], detached: true, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } });
      reaper.on("error", () => undefined);
      reaper.stdin!.on("error", () => undefined); // the reaper died: nothing left to tell it
      reaper.unref();
      (reaper.stdin as unknown as { unref?: () => void }).unref?.();
      this.reaper = reaper;
    }
    this.reaper.stdin!.write(`${[...this.groups.keys()].join(" ")}\n`);
  }

  /** The leader of `group` exited: keep the group only while it has members, re-probing until it is empty. */
  private leaderExited(group: number): void {
    if (!this.groups.has(group)) return;
    if (groupAlive(group)) {
      this.groups.set(group, true);
      this.pruneTimer ??= setInterval(() => this.prune(), PRUNE_MS).unref();
      return;
    }
    this.groups.delete(group);
    this.syncReaper();
  }

  private prune(): void {
    let changed = false;
    for (const [group, orphaned] of this.groups) {
      if (orphaned && !groupAlive(group)) {
        this.groups.delete(group);
        changed = true;
      }
    }
    if (![...this.groups.values()].some(Boolean)) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    if (changed) this.syncReaper();
  }

  private start(command: string, options: ExecOptions): Proc {
    // Hygiene: the shell's argv is a fixed stub and the command rides in an unexported variable (pkill -f cannot match it).
    const hygiene = this.settings.hygiene === true;
    const child = spawn(this.shell, hygiene ? [...hygieneFlags(this.shell), "-c", offArgvScript(isBash(this.shell))] : ["-c", command], {
      cwd: options.cwd === undefined ? this.cwd : this.resolvePath(options.cwd),
      env: { ...this.baseEnv, ...(options.env ?? {}), ...(hygiene ? { [CMD_VAR]: command } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: a process group of its own, signalled as one. Windows: no groups (taskkill ends the tree), no console window.
      ...(this.windows ? { windowsHide: true } : { detached: true }),
    });
    if (child.pid !== undefined && !this.windows) {
      this.groups.set(child.pid, false); // before any kill path below can need it
      this.syncReaper();
    }
    const proc: Proc = {
      id: options.internal === true ? `h${++this.nextInternalId}` : `p${++this.nextId}`, child, kept: [], keptBytes: 0, totalBytes: 0, cursor: 0, truncated: false,
      startedAt: performance.now(), exitCode: null, finished: false, done: Promise.resolve(), timedOut: false, killed: false, watchStopped: false,
    };
    if (this.settings.watchStopMs !== undefined) {
      proc.watch = new WatchStop(this.settings.watchStopMs, () => {
        proc.watchStopped = true;
        this.killGroup(proc);
      });
    }
    const onData = (chunk: Buffer) => {
      proc.watch?.feed(chunk);
      proc.totalBytes += chunk.length;
      const keep = proc.truncated ? 0 : keptPrefix(chunk, CAPTURE_MAX_BYTES - proc.keptBytes);
      if (keep > 0) {
        proc.kept.push(keep === chunk.length ? chunk : chunk.subarray(0, keep));
        proc.keptBytes += keep;
      }
      if (keep < chunk.length) proc.truncated = true;
      options.onOutput?.(chunk.toString("utf8"));
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", onData);
    proc.done = new Promise<void>((done) => {
      let exited = false;
      const finish = (code: number | null) => {
        if (proc.finished) return;
        proc.finished = true;
        proc.watch?.close();
        if (proc.watchStopped && !proc.timedOut && !proc.killed) {
          const last = proc.kept.at(-1);
          const note = `${last === undefined || last[last.length - 1] === 0x0a ? "" : "\n"}${watchStopNote(Math.round(this.settings.watchStopMs! / 1000))}\n`;
          proc.kept.push(Buffer.from(note));
          proc.keptBytes += note.length;
          proc.totalBytes += note.length;
          proc.exitCode = 124;
        } else {
          proc.exitCode = proc.timedOut || proc.killed ? null : code;
        }
        if (proc.timer !== undefined) clearTimeout(proc.timer);
        options.signal?.removeEventListener("abort", onAbort);
        done();
      };
      child.once("error", () => {
        proc.kept.push(Buffer.from(`failed to start ${this.shell}\n`));
        finish(127);
      });
      child.once("exit", (code) => {
        exited = true;
        if (child.pid !== undefined) this.leaderExited(child.pid);
        // A backgrounded grandchild may hold the pipes open: do not wait for it forever.
        const grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(code);
        }, PIPE_GRACE_MS);
        child.once("close", () => {
          clearTimeout(grace);
          finish(code);
        });
      });
      child.once("close", (code) => {
        if (!exited) finish(code);
      });
    });
    const onAbort = () => {
      proc.killed = true;
      this.killGroup(proc);
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      proc.timer = setTimeout(() => {
        proc.timedOut = true;
        this.killGroup(proc);
      }, options.timeoutMs);
      proc.timer.unref();
    }
    this.procs.set(proc.id, proc);
    return proc;
  }

  private async race(proc: Proc, ms: number | undefined, signal?: AbortSignal): Promise<void> {
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

  private snapshot(proc: Proc): ExecResult {
    const all = proc.kept.length === 1 ? proc.kept[0]! : Buffer.concat(proc.kept);
    if (proc.kept.length > 1) proc.kept = [all];
    const end = proc.finished ? all.length : utf8End(all);
    const output = all.subarray(proc.cursor, end).toString("utf8");
    proc.cursor = Math.max(proc.cursor, end);
    if (proc.finished) this.procs.delete(proc.id);
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
      ...(proc.finished && proc.exitCode === 124 && proc.watchStopped ? { watchStopped: true } : {}),
    };
  }

  private proc(handle: string): Proc {
    const proc = this.procs.get(handle);
    if (proc === undefined) throw new Error(`no background process ${JSON.stringify(handle)} (it finished and its output was returned, or it never existed)`);
    return proc;
  }

  private killGroup(proc: Proc): void {
    const group = proc.child.pid;
    if (proc.finished || group === undefined) return;
    if (this.windows) return killTree(proc.child);
    // Leader alive: the id is ours. Leader gone: only a group probed alive within PRUNE_MS, checked again now.
    if (this.groups.get(group) === true && !groupAlive(group)) return;
    if (!this.groups.has(group)) return;
    try {
      process.kill(-group, "SIGKILL");
    } catch {
      proc.child.kill("SIGKILL");
    }
  }
}

/** A process group with at least one member we may signal (EPERM: someone else's, so not ours). */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
}
