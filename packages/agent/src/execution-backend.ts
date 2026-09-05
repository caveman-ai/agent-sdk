/**
 * Execution backend HTTP contract
 *
 * Every request is POST with `Authorization: Bearer <token>` and
 * `Content-Type: application/json`.
 *
 * - `/exec`: request `{ execId, command, args, cwd, env, timeoutMs, maxOutputBytes }`;
 *   response `{ stdout, stderr, code, timedOut, truncated, startFailed? }`.
 * - `/read`: request `{ path, maxBytes? }`; response `{ data }`, where `data`
 *   is base64. A missing path returns HTTP 404.
 * - `/write`: request `{ path, data }`, where `data` is base64; response `{}`.
 * - Optional `/cancel`: request `{ execId }`; response `{}`. Best effort.
 * - Optional `/prepare`: request `{}`; response `{}`.
 * - Optional `/snapshot`: request `{}`; response `{ snapshotId }`.
 * - Optional `/restore`: request `{ snapshotId }`; response `{}`.
 *
 * Non-2xx responses fail closed. `AbortSignal` is transport-local and is not
 * serialized; the HTTP client passes it to fetch for `/exec` cancellation and
 * then posts `/cancel` with the same `execId` so the server can kill the tree.
 * Server enforces its workspace root for paths, including symlink targets.
 */
import { spawn } from "node:child_process";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  killProcessTree,
  LOCAL_BACKEND_INTERNALS,
  portableInvocation,
  type LocalBackendInternals,
} from "./portable-process.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly startFailed?: boolean;
}

export interface ExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface ExecutionBackend {
  readonly id: string;
  exec(request: ExecRequest): Promise<ExecResult>;
  readFile(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  prepare?(): Promise<void>;
  snapshot?(): Promise<string>;
  restore?(snapshotId: string): Promise<void>;
  close?(): Promise<void>;
}

/**
 * How long the run waits after the command itself exits for its pipes to close.
 * `close` normally follows `exit` immediately; the wait only matters when a
 * background descendant still holds the inherited stdout, and it bounds that
 * case instead of hanging on it.
 */
const EXIT_FLUSH_GRACE_MS = 100;

/** Bound on the best-effort /cancel that follows an aborted /exec. */
const CANCEL_TIMEOUT_MS = 5_000;

function randomExecId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function localExecutionBackend(): ExecutionBackend {
  const workspaceRoots = new Map<string, Promise<string>>();
  const internals: LocalBackendInternals = {
    resolvePath(workspace, candidate) {
      let root = workspaceRoots.get(workspace);
      if (root === undefined) {
        root = realpath(workspace);
        workspaceRoots.set(workspace, root);
      }
      return root.then((canonicalWorkspace) => containedPath(canonicalWorkspace, candidate));
    },
    async isFile(path) {
      return (await stat(path)).isFile();
    },
    async writeFile(path, data, exclusive) {
      await writeFile(path, data, { flag: exclusive ? "wx" : "w" });
    },
  };
  return {
    id: "local",
    exec: localExec,
    readFile: (path, opts) => readFile(path).then((data) => boundedBytes(data, opts?.maxBytes)),
    writeFile: (path, data) => writeFile(path, data),
    [LOCAL_BACKEND_INTERNALS]: internals,
  } as ExecutionBackend;
}

export function httpExecutionBackend(opts: {
  url: string;
  token: string;
  fetch?: typeof fetch;
}): ExecutionBackend {
  const url = opts.url.replace(/\/+$/, "");
  if (url === "") throw new Error("cave_execution_backend_http_url_required");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol === "http:" && !isLoopbackHost(parsedUrl.hostname)) {
    throw new Error("cave_execution_backend_http_insecure_url");
  }
  if (opts.token === "") throw new Error("cave_execution_backend_http_token_required");
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const post = async (
    endpoint: string,
    body: unknown,
    signal?: AbortSignal,
    responseCap = 64 * 1024 * 1024,
  ): Promise<unknown> => {
    const response = await fetchImpl(`${url}/${endpoint}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("caveman-code: path escapes the workspace");
      }
      const error = new Error(`cave_execution_backend_http_${endpoint}_failed:${response.status}`) as
        NodeJS.ErrnoException;
      if (endpoint === "read" && response.status === 404) error.code = "ENOENT";
      if (endpoint === "read" && response.status === 422) error.code = "EISDIR";
      throw error;
    }
    const text = await readResponseText(response, responseCap);
    return text === "" ? {} : JSON.parse(text) as unknown;
  };
  return {
    id: "http",
    async exec(request) {
      const execId = randomExecId();
      try {
        const response = await post("exec", {
          execId,
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          env: request.env,
          timeoutMs: request.timeoutMs,
          maxOutputBytes: request.maxOutputBytes,
        }, request.signal, 2 * request.maxOutputBytes + 4_096);
        return validateExecResult(response, request.maxOutputBytes);
      } catch (error) {
        if ((error as Error).name !== "AbortError") throw error;
        // Best effort: the aborted /exec carried execId, so ask the server to kill
        // that process tree. A provider without /cancel answers 404 and the remote
        // process still dies on its own timeoutMs; nothing here can guarantee it.
        await post("cancel", { execId }, AbortSignal.timeout(CANCEL_TIMEOUT_MS), 4_096)
          .catch(() => undefined);
        return {
          stdout: "", stderr: "cave_execution_backend_aborted", code: null,
          timedOut: false, truncated: false,
        };
      }
    },
    async readFile(path, readOpts) {
      const response = objectResponse(await post("read", {
        path,
        ...(readOpts?.maxBytes === undefined ? {} : { maxBytes: readOpts.maxBytes }),
      }, undefined, readOpts?.maxBytes === undefined
        ? 64 * 1024 * 1024
        : Math.ceil(readOpts.maxBytes * 4 / 3) + 4_096), "read");
      if (typeof response.data !== "string") {
        throw new Error("cave_execution_backend_http_read_invalid");
      }
      return boundedBytes(Buffer.from(response.data, "base64"), readOpts?.maxBytes);
    },
    async writeFile(path, data) {
      await post("write", { path, data: Buffer.from(data).toString("base64") });
    },
    async prepare() {
      await post("prepare", {});
    },
    async snapshot() {
      const response = objectResponse(await post("snapshot", {}), "snapshot");
      if (typeof response.snapshotId !== "string" || response.snapshotId === "") {
        throw new Error("cave_execution_backend_http_snapshot_invalid");
      }
      return response.snapshotId;
    },
    async restore(snapshotId) {
      await post("restore", { snapshotId });
    },
  };
}

async function localExec(request: ExecRequest): Promise<ExecResult> {
  let invocation;
  try {
    invocation = portableInvocation(request.command, request.args, { env: request.env });
  } catch (error) {
    return spawnFailure(error);
  }
  return new Promise((accept) => {
    let child;
    try {
      // Its own process group: `cmd &` puts children there too, so the timeout can
      // kill the whole tree rather than just the shell that spawned it.
      child = spawn(invocation.command, [...invocation.args], {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      accept(spawnFailure(error));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      const remaining = request.maxOutputBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.byteLength > remaining) truncated = true;
      const kept = chunk.subarray(0, remaining);
      bytes += kept.byteLength;
      target.push(kept);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    const kill = () => killProcessTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.timeoutMs);
    const abort = () => kill();
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted === true) abort();
    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abort);
      accept(result);
    };
    const finish = () => {
      // Whatever still holds these pipes is not this run's business: reading is
      // over, and a live handle would keep the whole process alive waiting on a
      // background command the user deliberately detached.
      child.stdout.destroy();
      child.stderr.destroy();
      settle({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: exitCode,
        timedOut,
        truncated,
      });
    };
    child.once("error", (error) => settle(spawnFailure(error)));
    child.once("close", (code) => {
      exitCode = code;
      finish();
    });
    // `close` waits for stdio EOF, which a surviving background descendant never
    // gives. `exit` is the command's own answer, so the run settles on it with
    // whatever output arrived rather than waiting on a process it does not own.
    child.once("exit", (code) => {
      exitCode = code;
      setTimeout(finish, EXIT_FLUSH_GRACE_MS).unref();
    });
  });
}

function spawnFailure(error: unknown): ExecResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    stdout: "",
    stderr: message,
    code: 127,
    timedOut: false,
    truncated: false,
    startFailed: true,
  };
}

function validateExecResult(value: unknown, maxOutputBytes: number): ExecResult {
  const result = objectResponse(value, "exec");
  if (typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
      (typeof result.code !== "number" && result.code !== null) ||
      typeof result.timedOut !== "boolean" || typeof result.truncated !== "boolean" ||
      (result.startFailed !== undefined && typeof result.startFailed !== "boolean")) {
    throw new Error("cave_execution_backend_http_exec_invalid");
  }
  const stdout = boundedText(result.stdout, maxOutputBytes);
  const remaining = Math.max(0, maxOutputBytes - Buffer.byteLength(stdout, "utf8"));
  const stderr = boundedText(result.stderr, remaining);
  const truncated = result.truncated || stdout !== result.stdout || stderr !== result.stderr;
  return {
    stdout, stderr, code: result.code, timedOut: result.timedOut, truncated,
    ...(result.startFailed === undefined ? {} : { startFailed: result.startFailed }),
  };
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks, bytes).toString("utf8");
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("cave_execution_backend_http_response_too_large");
    }
    chunks.push(value);
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function objectResponse(value: unknown, endpoint: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`cave_execution_backend_http_${endpoint}_invalid`);
  }
  return value as Record<string, unknown>;
}

function boundedText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.byteLength <= maxBytes ? value : bytes.subarray(0, maxBytes).toString("utf8");
}

function boundedBytes(value: Uint8Array, maxBytes: number | undefined): Uint8Array {
  return maxBytes === undefined || value.byteLength <= maxBytes
    ? value
    : value.subarray(0, maxBytes);
}

/**
 * Resolve a caller path against the canonical workspace and refuse anything
 * that lands outside it.
 *
 * A lexical prefix check is not containment: a symlink inside the workspace
 * pointing anywhere on the filesystem passes it. Both sides are canonicalized
 * first, matching how `stageSandboxSourceGraph` decides the same question.
 */
async function containedPath(canonicalWorkspace: string, candidate: string): Promise<string> {
  const full = await canonicalizePath(resolve(canonicalWorkspace, candidate));
  if (escapesRoot(relative(canonicalWorkspace, full))) {
    throw new Error(`caveman-code: path escapes the workspace: ${candidate}`);
  }
  return full;
}

function escapesRoot(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

/**
 * `realpath` for a path whose leaf may not exist yet (a file `edit_file` is
 * about to create): canonicalize the deepest existing ancestor and re-attach
 * the missing tail, so every symlink on the existing part is still resolved.
 */
async function canonicalizePath(target: string): Promise<string> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const canonical = await realpath(current);
      return missing.length === 0 ? canonical : resolve(canonical, ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}
