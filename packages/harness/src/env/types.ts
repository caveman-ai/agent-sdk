/**
 * ExecEnv: where tools run. Every method is one request/response, so a remote
 * backend (docker) implements each with one round trip. Output of a command is
 * combined stdout+stderr in arrival order, the stream a terminal shows.
 *
 * pi-durable 1.4's `ExecutionEnv` was checked and not adopted: it is a
 * 25-method FileSystem + Shell keyed on chord `Context` and `Result` values,
 * with streaming readers and watchers that are not one round trip each, and it
 * has no background process handles (no yield, poll, wait or kill).
 */
import type { ShellSettings } from "./hygiene.ts";

export interface ExecOptions {
  /** Working directory; relative paths resolve against the env's cwd. */
  cwd?: string;
  /** Hard deadline: the process group is killed at this point, even in the background. */
  timeoutMs?: number;
  /**
   * Return after this long with the output so far, leaving the command running
   * as a background process (`handle`). Undefined waits until exit or timeout.
   */
  yieldMs?: number;
  /** Start and return a handle at once (yieldMs 0). */
  background?: boolean;
  /** Live output chunks, for tracing or streaming UIs. */
  onOutput?: (chunk: string) => void;
  /** Abort kills the process group. */
  signal?: AbortSignal;
  /** Extra environment variables for this command; these win over the env's own. */
  env?: Record<string, string>;
  /**
   * A harness-internal command the model never sees (trace.finish_snapshot): its
   * handle comes from a sequence of its own (`h<n>`), so the handles the model is
   * shown (`p<n>`) number the same with or without it.
   */
  internal?: boolean;
}

export interface ExecResult {
  /** Null while running, or when killed by a signal or the timeout. */
  exitCode: number | null;
  /** Combined output: everything for a finished command, or the new output since the last view of a handle. */
  output: string;
  /** Captured output hit the env's capture ceiling; later bytes were counted, not kept. */
  truncated: boolean;
  durationMs: number;
  /** Total bytes the command has written so far. */
  totalBytes: number;
  /** Still running in the background: poll, wait or kill it by `handle`. */
  running: boolean;
  handle?: string;
  timedOut?: boolean;
  /** Killed by an abort or kill(). */
  killed?: boolean;
  /** Stopped by policy.watch_stop: silent on a watch-mode banner (exitCode 124, a remedy line appended). */
  watchStopped?: boolean;
  /** Not run: policy.self_kill_guard refused it (the output says why and how to fix it). */
  refused?: boolean;
}

export interface FileStat {
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

export interface DirEntry {
  name: string;
  kind: FileStat["kind"];
}

export interface ReadRange {
  offset?: number;
  length?: number;
}

export interface ExecEnv {
  /** `local` or `docker:<container>`. */
  readonly id: string;
  /** Absolute working directory inside the env. */
  readonly cwd: string;
  /** The user commands run as, when the env knows it (recorded in run_start). */
  readonly user?: string | undefined;
  /**
   * The OS commands run on (`linux`, `darwin`), as the model's env block names
   * it. A stable fact of the image, never a per-trial one (unlike `id`).
   */
  readonly os?: string | undefined;
  /**
   * What the model must know about the shell its commands run in, when it is not the POSIX shell it would assume: the
   * env block's `shell:` line. LocalEnv on Windows only (Git Bash: POSIX syntax, forward slashes; or no bash at all).
   */
  readonly shellNote?: string | undefined;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  /** New output of a background command since its last view; never blocks. */
  poll(handle: string): Promise<ExecResult>;
  /** Block up to `ms` for a background command to exit, then return like poll. */
  wait(handle: string, ms: number, signal?: AbortSignal): Promise<ExecResult>;
  kill(handle: string): Promise<ExecResult>;
  /** Whole file, or a byte range of it. Throws ENOENT-style errors with `code`. */
  readFile(path: string, range?: ReadRange): Promise<Uint8Array>;
  /** Creates parent directories. */
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  /**
   * Several whole files at once, in input order; a file that cannot be read is
   * its Error. Optional: a remote backend issues them concurrently, so N reads
   * cost about one round trip instead of N.
   */
  readFiles?(paths: string[]): Promise<(Uint8Array | Error)[]>;
  /** Several files in one request (parents created). Optional, like readFiles. */
  writeFiles?(files: { path: string; data: Uint8Array | string }[]): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  /** A per-run scratch directory inside the env, outside the workspace (spill files go here). */
  scratchDir(): Promise<string>;
  /** Absolute path inside the env. */
  resolvePath(path: string): string;
  /** Kill every background process and remove the scratch directory. */
  close(): Promise<void>;
  /** The loadout's shell flags (B3); an env without it runs commands as it always did, and a run whose loadout turns any of them on fails at start. */
  configureShell?(settings: ShellSettings): void;
}

/** `local:<cwd>` or `docker:<container>:<cwd>`. */
export type EnvSpec =
  | { kind: "local"; cwd: string }
  | { kind: "docker"; container: string; cwd: string };

export function parseEnvSpec(spec: string): EnvSpec {
  if (spec.startsWith("local:")) {
    const cwd = spec.slice("local:".length);
    if (cwd === "") throw new Error("env: local:<cwd> needs a directory");
    return { kind: "local", cwd };
  }
  if (spec.startsWith("docker:")) {
    // Container names and ids never hold a colon ([a-zA-Z0-9][a-zA-Z0-9_.-]*), so the first one ends it.
    const rest = spec.slice("docker:".length);
    const colon = rest.indexOf(":");
    const container = colon === -1 ? rest : rest.slice(0, colon);
    const cwd = colon === -1 ? "" : rest.slice(colon + 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(container) || cwd === "" || !cwd.startsWith("/")) {
      throw new Error("env: docker spec is docker:<container>:<absolute cwd>");
    }
    return { kind: "docker", container, cwd };
  }
  throw new Error(`env: unknown spec ${JSON.stringify(spec)} (want local:<cwd> or docker:<container>:<cwd>)`);
}
