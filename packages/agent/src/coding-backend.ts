import { isAbsolute, relative, resolve } from "node:path";
import type { ExecResult, ExecutionBackend } from "./execution-backend.js";
import {
  LOCAL_BACKEND_INTERNALS,
  type LocalBackendInternals,
} from "./portable-process.js";

const PROCESS_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;

export type ProcessRun = {
  output: string;
  code: number | null;
  timedOut: boolean;
  spawnFailed: boolean;
  captureComplete: boolean;
};

export function localBackendInternals(
  backend: ExecutionBackend,
): LocalBackendInternals | undefined {
  return (backend as ExecutionBackend & {
    [LOCAL_BACKEND_INTERNALS]?: LocalBackendInternals;
  })[LOCAL_BACKEND_INTERNALS];
}

export function backendWorkspaceRoot(
  backend: ExecutionBackend,
  workspace: string,
): Promise<string> {
  const internals = localBackendInternals(backend);
  return internals === undefined
    ? Promise.resolve(resolve(workspace))
    : internals.resolvePath(workspace, ".");
}

export async function backendContainedPath(
  backend: ExecutionBackend,
  workspace: string,
  candidate: string,
  fileRoot?: string,
): Promise<string> {
  if (fileRoot !== undefined) {
    return backendContainedPath(backend, await backendWorkspaceRoot(backend, fileRoot), resolve(workspace, candidate));
  }
  const internals = localBackendInternals(backend);
  if (internals !== undefined) return internals.resolvePath(workspace, candidate);
  const target = resolve(workspace, candidate);
  const path = relative(workspace, target);
  if (path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path)) {
    throw new Error(`caveman-code: path escapes the workspace: ${candidate}`);
  }
  return target;
}

export async function backendIsFile(
  backend: ExecutionBackend,
  path: string,
): Promise<boolean> {
  return await localBackendInternals(backend)?.isFile(path) ?? true;
}

export async function backendWriteFile(
  backend: ExecutionBackend,
  path: string,
  data: Uint8Array,
  exclusive: boolean,
): Promise<void> {
  const internals = localBackendInternals(backend);
  if (internals !== undefined) return internals.writeFile(path, data, exclusive);
  if (exclusive) {
    try {
      await backend.readFile(path, { maxBytes: 1 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await backend.writeFile(path, data);
        return;
      }
      throw error;
    }
    const error = new Error(`EEXIST: file already exists, open '${path}'`) as
      NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
  await backend.writeFile(path, data);
}

/**
 * Baseline environment for the coding agent's host subprocesses.
 *
 * NOT a spread of `process.env`: a model-driven `bash`/`grep`/`rg` must not
 * inherit the framework's own account and provider credentials
 * (`CAVE_API_KEY`, `ANTHROPIC_API_KEY`, …) and exfiltrate them. Only a fixed
 * shell/locale baseline passes through.
 *
 * This is a credential boundary, NOT a sandbox: `bash` is **uncontained by
 * design** — it runs arbitrary host commands with the user's own privileges.
 * The env allow-list only removes the framework-managed secrets from what those
 * commands can read; it does not, and is not meant to, contain what they do.
 */
export function buildCodingProcessEnv(local: boolean): Record<string, string> {
  const allow = local ? [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
    "TERM", "TMPDIR", "PWD", "ComSpec", "PATHEXT", "SystemRoot", "TEMP", "TMP",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  ] : ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM"];
  const env: Record<string, string> = {};
  for (const key of allow) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export async function runBackendProcess(
  backend: ExecutionBackend,
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessRun> {
  const result: ExecResult = await backend.exec({
    command,
    args,
    cwd,
    env: buildCodingProcessEnv(localBackendInternals(backend) !== undefined),
    timeoutMs,
    maxOutputBytes: PROCESS_CAPTURE_MAX_BYTES,
    ...(signal === undefined ? {} : { signal }),
  });
  return {
    output: combinedProcessOutput(result),
    code: result.code,
    timedOut: result.timedOut,
    spawnFailed: result.code === 127 || result.startFailed === true,
    captureComplete: !result.truncated,
  };
}

export function combinedProcessOutput(result: ExecResult): string {
  const separator = result.stdout !== "" && !result.stdout.endsWith("\n") && result.stderr !== ""
    ? "\n"
    : "";
  return `${result.stdout}${separator}${result.stderr}`;
}
