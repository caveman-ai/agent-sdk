/**
 * DockerEnv: ExecEnv in a running container on this host, driven by the docker
 * CLI (`--env docker:<container>:<cwd>`). The harness runs outside the
 * container; nothing is installed in it. Every ExecEnv call is one
 * `docker exec` (writeFiles: one per file, concurrently); poll and wait cost
 * none, since a command's output streams back on the `docker exec` that started it.
 *
 * What `docker exec` does, and what this does about it (probed on Docker 29.4
 * under OrbStack, 2026-10-31):
 * - The exec'd process inherits the container's environment (the image's
 *   Config.Env and compose `environment:`), so nothing like --env-file is
 *   needed; variables given here (`env`, per-call env) are added with `-e`.
 * - runc makes every exec'd process a session and group leader (pid = pgid),
 *   so a command already has its own process group. The probe checks that;
 *   when a runtime does not, commands start under `setsid` (which then does not
 *   fork). A kill is `kill -9 -<pgid>` from a second `docker exec` (killing the
 *   docker client leaves the process running). Every command also carries
 *   HARNESS_PROC=<env tag>.<handle>, inherited by its descendants: close()
 *   kills every tagged process, daemons that left the group too.
 * - The daemon holds `docker exec` open while anything holds the command's
 *   pipes (`server &` kept it about 2 s past the command's exit). A wrapper
 *   prints the command's pid on stdout first, folds the command's stderr into
 *   stdout (one stream, so arrival order is kept), then prints an exit mark
 *   with a per-env nonce and exits with the status. The command finishes at the
 *   mark plus the 250 ms pipe grace LocalEnv gives, and the docker client is
 *   then dropped.
 * - Without `-i` the command's stdin is empty (never a hang on a read).
 * - A host-side reaper (one sh, in its own session) runs the tagged kill in the
 *   container if the harness dies without close(), as LocalEnv's reaper does.
 * - File operations are small POSIX sh scripts (cat, tail/head -c, wc, stat,
 *   mkdir) run as the command user, so they see what the agent sees.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { ENV_DEFAULTS, keptPrefix, utf8End } from "./local.ts";
import type { DirEntry, ExecEnv, ExecOptions, ExecResult, FileStat, ReadRange } from "./types.ts";

const CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
const PIPE_GRACE_MS = 250;
/** How long a killed command may take to report its end before it is finished here anyway. */
const KILL_SETTLE_MS = 2_000;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 120_000;
const WRITE_CONCURRENCY = 8;

/**
 * `$0` is the shell, `$1` the command: print this shell's pid (its process group), run the command with stderr on
 * stdout and stdin empty, then print the exit mark on stdout (after all the command's own output) and exit with it.
 */
const wrapperScript = (tag: string) =>
  `printf '\\036harness-pid-${tag}:%d\\n' "$$"; "$0" -c "$1" 2>&1 </dev/null; s=$?; printf '\\036harness-exit-${tag}:%d\\n' "$s"; exit "$s"`;
/** One call at connect: is cwd a directory, who runs commands, which shell and OS, is this a group leader, setsid, a scratch dir. */
const PROBE = `[ -d "$1" ] || { echo nocwd; exit 0; }
u=$(id -u 2>/dev/null) || while read -r k v _; do [ "$k" = Uid: ] && u=$v; done < /proc/self/status
echo "uid=$u"; echo "user=$(id -un 2>/dev/null)"
if [ -x /bin/bash ]; then echo shell=/bin/bash; else echo shell=/bin/sh; fi
echo "os=$(uname -s 2>/dev/null)"
echo "pid=$$"; read -r _ _ _ _ g _ < /proc/$$/stat 2>/dev/null && echo "pgid=$g"
s=$(command -v setsid 2>/dev/null) && echo "setsid=$s"
d=$(mktemp -d /tmp/harness-run-XXXXXX 2>/dev/null) || { d=/tmp/harness-run-$$; mkdir -p "$d"; }
echo "scratch=$d"`;
/** Kill the process groups in "$@" (a command's pid is its pgid). */
const KILL_GROUPS = `for p in "$@"; do kill -9 -"$p" 2>/dev/null; done`;
/** Kill every process whose environment has HARNESS_PROC matching "^$t" (descendants inherit it wherever they regroup). */
const KILL_TAGGED = `for e in /proc/[0-9]*/environ; do p=\${e#/proc/}; p=\${p%/environ}
  [ "$p" = "$$" ] && continue
  tr '\\000' '\\n' < "$e" 2>/dev/null | grep -q "^HARNESS_PROC=$t" && kill -9 "$p" 2>/dev/null
done`;
/** Exit 3 a directory, 4 missing, 5 unreadable; else the bytes: whole, from $2, or $3 of them from $2. */
const READ = `[ -d "$1" ] && exit 3; [ -e "$1" ] || exit 4; [ -r "$1" ] || exit 5
if [ -z "$2" ]; then exec cat "$1"; fi
if [ -z "$3" ]; then exec tail -c +$(($2 + 1)) "$1"; fi
tail -c +$(($2 + 1)) "$1" | head -c "$3"`;
/**
 * Per path a header line `<status> <n>` then, for OK, exactly n bytes (padded or cut if the file changed between the
 * count and the read, so the framing never breaks).
 */
const READ_MANY = `for p; do
  if [ -d "$p" ]; then echo "EISDIR 0"; elif [ ! -e "$p" ]; then echo "ENOENT 0"; elif [ ! -r "$p" ]; then echo "EACCES 0"
  elif n=$(wc -c < "$p" 2>/dev/null); then n=$((n + 0)); echo "OK $n"; { cat "$p" 2>/dev/null; cat /dev/zero; } | head -c "$n"
  else echo "EIO 0"; fi
done`;
const WRITE = `mkdir -p "$(dirname "$1")" && cat > "$1"`;
/** `<kind> <size> <mtime s>` of the path, symlinks followed (a dangling one is a symlink), or `none`. */
const STAT = `if [ -e "$1" ]; then
  if [ -d "$1" ]; then k=directory; elif [ -f "$1" ]; then k=file; else k=other; fi
  o=$(stat -L -c '%s %Y' "$1" 2>/dev/null) || o="$(wc -c < "$1" 2>/dev/null || echo 0) 0"
  echo "$k $o"
elif [ -L "$1" ]; then echo "symlink 0 0"; else echo none; fi`;
/** NUL-separated `<kind>/<name>` entries; exit 4 missing, 6 not a directory, 5 unreadable. */
const LIST = `[ -e "$1" ] || [ -L "$1" ] || exit 4; [ -d "$1" ] || exit 6; cd "$1" 2>/dev/null || exit 5
for f in .* *; do
  case $f in .|..) continue;; esac
  if [ -L "$f" ]; then k=symlink; elif [ -d "$f" ]; then k=directory; elif [ -f "$f" ]; then k=file; elif [ -e "$f" ]; then k=other; else continue; fi
  printf '%s/%s\\000' "$k" "$f"
done`;
/**
 * The host-side reaper: holds a pipe from the harness; at EOF without a `disarm` line (the harness died without
 * close()), kills the env's tagged processes in the container and removes the scratch dir.
 */
const REAPER = `last=; while IFS= read -r line; do last=$line; done
[ "$last" = disarm ] || "$0" exec -u 0 "$1" /bin/sh -c "$2" harness "$3" "$4" >/dev/null 2>&1; exit 0`;
/** The reaper's script in the container: $1 the tag pattern, $2 the scratch dir (empty: keep it). */
const REAP_IN_CONTAINER = `t=$1\n${KILL_TAGGED}\n[ -z "$2" ] || rm -rf -- "$2"\nexit 0`;

export interface DockerEnvOptions {
  /** Container name or id; it must be running. */
  container: string;
  /** Absolute working directory inside the container; must exist. */
  cwd: string;
  /** User commands and file operations run as (`docker exec -u`); default the container's own user. */
  user?: string;
  /** Variables for every command, on top of the container's own environment. */
  env?: Record<string, string>;
  /** The docker CLI (default $HARNESS_DOCKER, else `docker` on PATH). */
  docker?: string;
  keepScratch?: boolean;
  /** Tests: behave as if exec'd processes were not group leaders and there were no setsid (tagged kills only). */
  noGroups?: boolean;
}

interface Proc {
  id: string;
  pid: number;
  client: ChildProcess;
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
  /** stdout bytes not yet passed on: the head before the pid line, or a tail that may start the exit mark. */
  held?: Buffer | undefined;
  /** The command's exit status, from the wrapper's mark. */
  status?: number;
  terminating?: Promise<void>;
  onOutput?: (chunk: string) => void;
  offAbort?: () => void;
  /** Resolves once the pid line arrived (true) or the client ended without one (false). */
  started: Promise<boolean>;
  onStarted: (ok: boolean) => void;
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

/** Where a suffix of `buf` that is a proper prefix of `mark` starts (buf.length if none): those bytes wait for the next chunk. */
function partialAt(buf: Buffer, mark: Buffer): number {
  for (let i = Math.max(0, buf.length - mark.length + 1); i < buf.length; i++) {
    if (buf[i] === mark[0] && mark.subarray(0, buf.length - i).equals(buf.subarray(i))) return i;
  }
  return buf.length;
}

/** A file error as node:fs throws one (`code`, `path`), which the tools read (src/tools/compact.ts): shared with SandboxEnv. */
export function fileError(code: string, syscall: string, path: string, detail?: string): Error {
  const text = code === "ENOENT" ? "no such file or directory" : code === "EISDIR" ? "illegal operation on a directory"
    : code === "ENOTDIR" ? "not a directory" : code === "EACCES" ? "permission denied" : (detail ?? "failed");
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), { code, path });
}

const EXIT_CODES: Record<number, string> = { 3: "EISDIR", 4: "ENOENT", 5: "EACCES", 6: "ENOTDIR" };

export class DockerEnv implements ExecEnv {
  readonly id: string;
  readonly cwd: string;
  readonly container: string;
  /** The user commands and file operations run as (as the probe saw it). */
  user: string | undefined;
  os = "linux";
  private readonly requestedUser: string | undefined;
  private readonly docker: string;
  private readonly baseEnv: Record<string, string>;
  private readonly keepScratch: boolean;
  private readonly procs = new Map<string, Proc>();
  /** Every command's process group: close() kills them all. */
  private readonly groups = new Set<number>();
  private readonly tag = randomUUID().slice(0, 12);
  private readonly pidMark = Buffer.from(`\x1eharness-pid-${this.tag}:`);
  private readonly mark = Buffer.from(`\x1eharness-exit-${this.tag}:`);
  private readonly wrapper = wrapperScript(this.tag);
  private shell = "/bin/sh";
  /** How a command gets its own process group: already a leader, setsid, or none (tagged kills only). */
  private grouping: "leader" | "setsid" | "none" = "none";
  private setsid: string | undefined;
  private scratch = "";
  private nextId = 0;
  private nextInternalId = 0;
  private started = false;
  private reaper: ChildProcess | undefined;

  /** Probe a running container (one `docker exec`) and return an env on it. */
  static async connect(options: DockerEnvOptions): Promise<DockerEnv> {
    const env = new DockerEnv(options);
    await env.probe(options.noGroups === true);
    return env;
  }

  private constructor(options: DockerEnvOptions) {
    if (!options.cwd.startsWith("/")) throw new Error("env: docker cwd must be absolute");
    if (options.container === "" || options.container.startsWith("-")) throw new Error(`env: bad docker container ${JSON.stringify(options.container)}`);
    this.container = options.container;
    this.id = `docker:${options.container}`;
    this.cwd = posix.resolve(options.cwd);
    this.requestedUser = options.user;
    this.user = options.user;
    this.docker = options.docker ?? (process.env.HARNESS_DOCKER || "docker");
    this.baseEnv = { ...ENV_DEFAULTS, ...(options.env ?? {}) };
    this.keepScratch = options.keepScratch === true;
  }

  private async probe(noGroups: boolean): Promise<void> {
    const out = await this.raw(PROBE, [this.cwd], { timeoutMs: START_TIMEOUT_MS });
    const stdout = out.stdout.toString("utf8");
    if (out.code !== 0 && !stdout.includes("scratch=")) {
      const why = out.stderr.toString("utf8").trim() || stdout.trim() || `exit ${out.code}`;
      throw new Error(`env: docker cannot run commands${this.requestedUser === undefined ? "" : ` as user ${JSON.stringify(this.requestedUser)}`} in container ${this.container}: ${why.slice(0, 500)}`);
    }
    if (stdout.startsWith("nocwd")) throw new Error(`env: docker cwd ${this.cwd} is not a directory in container ${this.container}`);
    const facts = Object.fromEntries(stdout.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (facts.scratch === undefined) throw new Error(`env: docker probe of container ${this.container} failed: ${JSON.stringify(stdout.slice(0, 500))}`);
    const want = this.requestedUser;
    if (want !== undefined && facts.user !== want && facts.uid !== want && !(want === "root" && facts.uid === "0") && !want.startsWith(`${facts.uid}:`)) {
      throw new Error(`env: docker commands in container ${this.container} run as ${JSON.stringify(facts.user ?? facts.uid)} (uid ${facts.uid}), not the requested user ${JSON.stringify(want)}`);
    }
    this.user = facts.user !== undefined && facts.user !== "" ? facts.user : facts.uid;
    this.shell = facts.shell ?? "/bin/sh";
    if (facts.os !== undefined && /^[A-Za-z0-9_-]+$/u.test(facts.os)) this.os = facts.os.toLowerCase();
    this.setsid = facts.setsid;
    this.grouping = noGroups ? "none" : facts.pgid !== undefined && facts.pgid === facts.pid ? "leader" : facts.setsid !== undefined ? "setsid" : "none";
    this.scratch = facts.scratch;
  }

  /** How commands get a process group (tests and diagnostics). */
  processGroups(): "leader" | "setsid" | "none" {
    return this.grouping;
  }

  resolvePath(path: string): string {
    return posix.resolve(this.cwd, path);
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const proc = await this.start(command, options);
    if (options.signal?.aborted === true) await this.terminate(proc, "killed");
    const yieldMs = options.background === true ? 0 : options.yieldMs;
    if (yieldMs === 0) return this.snapshot(proc);
    await this.race(proc, yieldMs, options.signal);
    if (options.signal?.aborted === true) await this.terminate(proc, "killed");
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
    await this.terminate(proc, "killed");
    return this.snapshot(proc);
  }

  async readFile(path: string, range?: ReadRange): Promise<Uint8Array> {
    const target = this.resolvePath(path);
    const ranged = range !== undefined && (range.offset !== undefined || range.length !== undefined);
    const offset = Math.max(0, Math.floor(range?.offset ?? 0));
    const args = [target];
    if (ranged) {
      if (range.length !== undefined && range.length <= 0) {
        if ((await this.stat(target)) === undefined) throw fileError("ENOENT", "open", target);
        return new Uint8Array(0);
      }
      args.push(String(offset), range.length === undefined ? "" : String(Math.floor(range.length)));
    }
    const out = await this.raw(READ, args);
    if (out.code === 0) return out.stdout;
    throw this.opError(out, "open", target);
  }

  /** One `docker exec` for all of them, framed per file. */
  async readFiles(paths: string[]): Promise<(Uint8Array | Error)[]> {
    if (paths.length === 0) return [];
    const targets = paths.map((path) => this.resolvePath(path));
    const out = await this.raw(READ_MANY, targets);
    const results: (Uint8Array | Error)[] = [];
    let at = 0;
    for (const target of targets) {
      const nl = out.stdout.indexOf(0x0a, at);
      const header = nl === -1 ? "" : out.stdout.subarray(at, nl).toString("latin1");
      const match = /^([A-Z]+) (\d+)$/u.exec(header);
      if (match === null) {
        const why = out.stderr.toString("utf8").trim() || `exit ${out.code}`;
        results.push(fileError("EIO", "open", target, why));
        at = out.stdout.length;
        continue;
      }
      const n = Number(match[2]);
      at = nl + 1;
      if (match[1] === "OK") {
        results.push(Buffer.from(out.stdout.subarray(at, at + n)));
        at += n;
      } else {
        results.push(fileError(match[1]!, match[1] === "EISDIR" ? "read" : "open", target));
      }
    }
    return results;
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const target = this.resolvePath(path);
    const out = await this.raw(WRITE, [target], { stdin: typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data) });
    if (out.code !== 0) throw this.opError(out, "open", target);
  }

  /** One `docker exec` per file, concurrently (a pipe of several files cannot be split portably in sh). */
  async writeFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++]!;
        await this.writeFile(file.path, file.data);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, files.length) }, worker));
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const target = this.resolvePath(path);
    const out = await this.raw(STAT, [target]);
    const line = out.stdout.toString("utf8").trim();
    const match = /^(file|directory|symlink|other) (\d+) (\d+)$/u.exec(line);
    if (match === null) {
      if (line === "none") return undefined;
      throw this.opError(out, "stat", target);
    }
    return { kind: match[1] as FileStat["kind"], size: Number(match[2]), mtimeMs: Number(match[3]) * 1000 };
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const target = this.resolvePath(path);
    const out = await this.raw(LIST, [target]);
    if (out.code !== 0) throw this.opError(out, "scandir", target);
    return out.stdout.toString("utf8").split("\0").filter((entry) => entry !== "").map((entry) => {
      const slash = entry.indexOf("/");
      return { name: entry.slice(slash + 1), kind: entry.slice(0, slash) as DirEntry["kind"] };
    });
  }

  async scratchDir(): Promise<string> {
    return this.scratch;
  }

  async close(): Promise<void> {
    const live = [...this.procs.values()].filter((proc) => !proc.finished);
    for (const proc of live) proc.killed = true;
    const groups = this.grouping === "none" ? [] : [...this.groups];
    this.groups.clear();
    // One call: every group, every tagged process, then the scratch dir (after the kill, so nothing recreates it).
    const script = [
      groups.length === 0 ? "" : KILL_GROUPS,
      this.started ? KILL_TAGGED : "",
      this.scratch !== "" && !this.keepScratch ? `rm -rf -- '${this.scratch}'` : "",
    ].filter((part) => part !== "");
    if (script.length > 0) await this.raw(`t=$1; shift\n${script.join("\n")}\nexit 0`, [`${this.tag}\\.`, ...groups.map(String)], { root: true, timeoutMs: 30_000 }).catch(() => undefined);
    if (this.reaper !== undefined) {
      this.reaper.stdin?.end("disarm\n");
      this.reaper = undefined;
    }
    await within(Promise.all(live.map((proc) => proc.done)), KILL_SETTLE_MS);
    for (const proc of live) this.finish(proc, null);
    this.procs.clear();
  }

  /** Live processes, for tests and diagnostics. */
  liveHandles(): string[] {
    return [...this.procs.values()].filter((proc) => !proc.finished).map((proc) => proc.id);
  }

  /** The reaper's pid (started with the first command), for tests. */
  reaperPid(): number | undefined {
    return this.reaper?.pid;
  }

  /** `docker exec` argv prefix: the user and the variables every command gets. */
  private execArgs(options: { interactive?: boolean; root?: boolean; cwd?: string; env?: Record<string, string> } = {}): string[] {
    const args = ["exec"];
    if (options.interactive === true) args.push("-i");
    const user = options.root === true ? "0" : this.requestedUser;
    if (user !== undefined) args.push("-u", user);
    if (options.cwd !== undefined) args.push("-w", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
    args.push(this.container);
    return args;
  }

  private startReaper(): void {
    if (this.reaper !== undefined) return;
    const reaper = spawn("/bin/sh", ["-c", REAPER, this.docker, this.container, REAP_IN_CONTAINER, `${this.tag}\\.`, this.keepScratch ? "" : this.scratch],
      { stdio: ["pipe", "ignore", "ignore"], detached: true, env: process.env });
    reaper.on("error", () => undefined);
    reaper.stdin!.on("error", () => undefined);
    reaper.unref();
    (reaper.stdin as unknown as { unref?: () => void }).unref?.();
    this.reaper = reaper;
  }

  private async start(command: string, options: ExecOptions): Promise<Proc> {
    let settle!: () => void;
    let onStarted!: (ok: boolean) => void;
    const id = options.internal === true ? `h${++this.nextInternalId}` : `p${++this.nextId}`;
    const cwd = options.cwd === undefined ? this.cwd : this.resolvePath(options.cwd);
    const prefix = this.grouping === "setsid" && this.setsid !== undefined ? [this.setsid] : [];
    const argv = [
      ...this.execArgs({ cwd, env: { ...this.baseEnv, ...(options.env ?? {}), HARNESS_PROC: `${this.tag}.${id}` } }),
      ...prefix, this.shell, "-c", this.wrapper, this.shell, command,
    ];
    this.startReaper();
    const client = spawn(this.docker, argv, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const proc: Proc = {
      id, pid: 0, client, kept: [], keptBytes: 0, totalBytes: 0, cursor: 0, truncated: false,
      startedAt: performance.now(), exitCode: null, finished: false, done: new Promise<void>((done) => (settle = done)), settle: () => settle(),
      timedOut: false, killed: false, timers: [], started: new Promise<boolean>((done) => (onStarted = done)), onStarted: (ok) => onStarted(ok),
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
    };
    client.stdout!.on("data", (chunk: Buffer) => this.onStdout(proc, chunk));
    // The wrapper's own stderr and the docker client's errors (the command's stderr is on stdout).
    client.stderr!.on("data", (chunk: Buffer) => this.record(proc, chunk));
    client.once("error", (error) => {
      this.record(proc, Buffer.from(`failed to start ${this.docker}: ${error.message}\n`));
      proc.onStarted(false);
      this.finish(proc, 127);
    });
    client.once("close", (code) => {
      proc.onStarted(false);
      if (proc.pid === 0 && !proc.finished) {
        // No pid line: docker never ran the wrapper (no container, a missing cwd, an unknown user).
        if (proc.held !== undefined) this.record(proc, proc.held);
        proc.held = undefined;
        this.note(proc, `failed to start in ${this.id} (docker exit ${code})`);
        return this.finish(proc, 127);
      }
      this.finish(proc, proc.status ?? code);
    });
    const startTimer = setTimeout(() => {
      this.note(proc, `no start in ${START_TIMEOUT_MS} ms`);
      client.kill("SIGKILL");
    }, START_TIMEOUT_MS);
    const ok = await proc.started;
    clearTimeout(startTimer);
    if (!ok && proc.pid === 0) {
      await proc.done;
      return proc;
    }
    this.groups.add(proc.pid);
    this.started = true;
    this.procs.set(proc.id, proc);
    if (options.signal !== undefined) {
      const onAbort = () => void this.terminate(proc, "killed");
      options.signal.addEventListener("abort", onAbort, { once: true });
      proc.offAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timer = setTimeout(() => void this.terminate(proc, "timedOut"), options.timeoutMs);
      timer.unref();
      proc.timers.push(timer);
    }
    return proc;
  }

  /** The wrapper's stdout: the pid line, the command's output, then the exit mark (held back while a chunk ends in a part of it). */
  private onStdout(proc: Proc, bytes: Buffer): void {
    if (proc.finished) return;
    if (proc.status !== undefined) return this.record(proc, bytes);
    let buf = proc.held === undefined ? bytes : Buffer.concat([proc.held, bytes]);
    proc.held = undefined;
    if (proc.pid === 0) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length <= this.pidMark.length + 12) {
          proc.held = Buffer.from(buf);
          return;
        }
      } else if (buf.subarray(0, this.pidMark.length).equals(this.pidMark)) {
        const digits = buf.subarray(this.pidMark.length, nl).toString("latin1");
        if (/^\d{1,10}$/u.test(digits)) {
          proc.pid = Number(digits);
          proc.onStarted(true);
          buf = buf.subarray(nl + 1);
        }
      }
      if (proc.pid === 0) return this.record(proc, buf); // not our wrapper's first line: pass it on as output
    }
    const at = buf.indexOf(this.mark);
    if (at === -1) {
      const keep = partialAt(buf, this.mark);
      if (keep > 0) this.record(proc, buf.subarray(0, keep));
      if (keep < buf.length) proc.held = Buffer.from(buf.subarray(keep));
      return;
    }
    const digitsAt = at + this.mark.length;
    const end = buf.indexOf(0x0a, digitsAt);
    const digits = buf.subarray(digitsAt, end === -1 ? buf.length : end).toString("latin1");
    if (end === -1 && /^\d{0,3}$/u.test(digits)) {
      if (at > 0) this.record(proc, buf.subarray(0, at));
      proc.held = Buffer.from(buf.subarray(at));
      return;
    }
    if (end === -1 || !/^\d{1,3}$/u.test(digits)) return this.record(proc, buf);
    if (at > 0) this.record(proc, buf.subarray(0, at));
    proc.status = Number(digits);
    if (end + 1 < buf.length) this.record(proc, buf.subarray(end + 1));
    // All the command's own output has arrived; a child it backgrounded may still hold stdout (and the daemon the
    // docker client). Let its in-flight output land for the same grace LocalEnv gives, then finish.
    const grace = setTimeout(() => this.finish(proc, proc.status ?? null), PIPE_GRACE_MS);
    grace.unref();
    proc.timers.push(grace);
  }

  /** A harness line in the command's output, on a line of its own. */
  private note(proc: Proc, text: string): void {
    const last = proc.kept.length === 0 ? undefined : proc.kept[proc.kept.length - 1]!.at(-1);
    this.record(proc, Buffer.from(`${last === undefined || last === 0x0a ? "" : "\n"}[harness: ${text}]\n`));
  }

  private record(proc: Proc, chunk: Buffer): void {
    if (chunk.length === 0 || proc.finished) return;
    proc.totalBytes += chunk.length;
    const keep = proc.truncated ? 0 : keptPrefix(chunk, CAPTURE_MAX_BYTES - proc.keptBytes);
    if (keep > 0) {
      proc.kept.push(keep === chunk.length ? chunk : chunk.subarray(0, keep));
      proc.keptBytes += keep;
    }
    if (keep < chunk.length) proc.truncated = true;
    proc.onOutput?.(chunk.toString("utf8"));
  }

  private finish(proc: Proc, code: number | null): void {
    if (proc.finished) return;
    if (proc.held !== undefined && proc.pid !== 0) {
      // A tail that looked like the start of the mark but the command ended without one: it was output.
      const held = proc.held;
      proc.held = undefined;
      this.record(proc, held);
    }
    proc.finished = true;
    proc.exitCode = proc.timedOut || proc.killed ? null : code;
    for (const timer of proc.timers) clearTimeout(timer);
    proc.offAbort?.();
    // The docker client may still be held by a child the command backgrounded: drop it (the child keeps running).
    if (proc.client.exitCode === null && proc.client.signalCode === null) {
      proc.client.stdout?.destroy();
      proc.client.stderr?.destroy();
      proc.client.kill("SIGKILL");
    }
    proc.settle();
  }

  /** Kill a command's group (one `docker exec`), give the client a moment to end, then finish it regardless. */
  private terminate(proc: Proc, how: "killed" | "timedOut"): Promise<void> {
    if (proc.finished) return Promise.resolve();
    proc[how] = true;
    return proc.terminating ??= (async () => {
      const script = this.grouping !== "none" ? KILL_GROUPS : KILL_TAGGED;
      await this.raw(`t=$1; shift\n${script}\nexit 0`, [`${this.tag}\\.${proc.id}$`, String(proc.pid)], { root: true, timeoutMs: 30_000 }).catch(() => undefined);
      await within(proc.done, KILL_SETTLE_MS);
      this.finish(proc, null);
    })();
  }

  /** A harness-internal script under /bin/sh in the container (no wrapper); its exit code, stdout and stderr. */
  private raw(script: string, args: string[], options: { stdin?: Buffer; root?: boolean; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: Buffer; stderr: Buffer }> {
    const argv = [...this.execArgs({ interactive: options.stdin !== undefined, ...(options.root === true ? { root: true } : {}) }), "/bin/sh", "-c", script, "harness", ...args];
    return new Promise((done, fail) => {
      const client = spawn(this.docker, argv, { stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env: process.env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const timer = setTimeout(() => client.kill("SIGKILL"), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
      client.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
      client.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
      client.once("error", (error) => {
        clearTimeout(timer);
        fail(new Error(`docker: cannot run ${this.docker}: ${error.message}`));
      });
      client.once("close", (code) => {
        clearTimeout(timer);
        done({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      if (options.stdin !== undefined) {
        client.stdin!.on("error", () => undefined);
        client.stdin!.end(options.stdin);
      }
    });
  }

  private opError(out: { code: number | null; stderr: Buffer }, syscall: string, target: string): Error {
    const code = out.code === null ? undefined : EXIT_CODES[out.code];
    if (code !== undefined) return fileError(code, code === "EISDIR" ? "read" : syscall, target);
    const why = out.stderr.toString("utf8").trim();
    if (/permission denied/iu.test(why)) return fileError("EACCES", syscall, target);
    if (/not a directory/iu.test(why)) return fileError("ENOTDIR", syscall, target);
    if (/no such file/iu.test(why) && !/container/iu.test(why)) return fileError("ENOENT", syscall, target);
    return fileError("EIO", syscall, target, `docker exec in ${this.container} failed (exit ${out.code}): ${why.slice(0, 300)}`);
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
    };
  }

  private proc(handle: string): Proc {
    const proc = this.procs.get(handle);
    if (proc === undefined) throw new Error(`no background process ${JSON.stringify(handle)} (it finished and its output was returned, or it never existed)`);
    return proc;
  }
}
