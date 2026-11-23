/**
 * LocalEnv on Windows (src/env/local.ts): the bash commands run in, the variables they get, how a command's process
 * tree is killed, and what the model is told. All pure (the host's variables and the file test are parameters), so the
 * Windows branches are tested on any host.
 *
 * The shell is a real bash, Git for Windows' first: never cmd.exe or PowerShell (the model writes POSIX shell), and
 * never WSL's launcher (it runs the command in another filesystem). Ported from the Caveman engine SDK's
 * windows-shell.ts (@caveman-ai/agent), which read the two references on 2026-10-25:
 * - OpenCode (packages/core/src/shell.ts `gitbash()`): `<git.exe on PATH>\..\..\bin\bash.exe`; it never searches PATH
 *   for bash.exe, which keeps WSL out.
 * - Pi (packages/coding-agent/src/utils/shell.ts `getShellConfig()`): the configured shell, else
 *   %ProgramFiles%\Git\bin\bash.exe and %ProgramFiles(x86)%\Git\bin\bash.exe, else bash.exe on PATH; no bash is an
 *   error that says to install Git for Windows. Both run `bash -c <command>`.
 * Here: the host's bash (LocalEnvOptions.shell), then the bash of the Git install whose git.exe is on PATH, then
 * Program Files, then a bash.exe on PATH that is not WSL's. No environment variable picks the shell.
 *
 * Git's `bin\bash.exe` is a launcher that starts `usr\bin\bash.exe` with Git's PATH and MSYSTEM set, so a command's
 * tree is at least two processes deep: it is killed with `taskkill /T /F`, never by the launcher's pid alone.
 */
import { win32 } from "node:path";

export const GIT_FOR_WINDOWS = "https://git-scm.com/download/win";

export type HostEnv = Readonly<Record<string, string | undefined>>;

/** The bash a Windows host runs commands in, or why there is none. */
export type WindowsBash =
  | { readonly path: string; readonly gitBash: boolean }
  | { readonly path?: undefined; readonly error: string; readonly note: string };

/** A variable by name, as Windows reads it: case-insensitively (`process.env.Path`). */
export function envValue(env: HostEnv, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : env[key];
}

/** A drive or UNC path. A relative one would resolve against where a command starts: a project's folder. */
const absolute = (file: string): boolean => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u.test(file);

/** PATH's absolute entries, in order. */
function pathDirectories(env: HostEnv): string[] {
  return (envValue(env, "PATH") ?? "").split(";")
    .map((entry) => entry.trim().replace(/^"(.*)"$/u, "$1"))
    .filter(absolute);
}

/** WSL's launchers: %SystemRoot%\System32 (Sysnative from a 32-bit process) and the Store's alias. */
export function isWslBash(file: string, env: HostEnv): boolean {
  const directory = win32.dirname(win32.normalize(file)).toLowerCase();
  const root = envValue(env, "SystemRoot") ?? envValue(env, "windir");
  const system = root === undefined || !absolute(root) ? [] : ["System32", "Sysnative"].map((name) => win32.join(root, name).toLowerCase());
  return system.includes(directory) || /^[a-z]:\\windows\\(?:system32|sysnative)$/u.test(directory) || /\\microsoft\\windowsapps$/u.test(directory);
}

export interface FindWindowsBashOptions {
  /** The host's variables (PATH, ProgramFiles, SystemRoot), any case. */
  env: HostEnv;
  /** Whether a file exists and is a regular file. */
  isFile: (file: string) => boolean;
  /** The host's bash: used as given, or refused (relative, WSL's, missing), never replaced by another one. */
  bashPath?: string | undefined;
}

/** The bash commands run in on Windows: the host's, else Git for Windows', else a non-WSL bash.exe on PATH. */
export function findWindowsBash(options: FindWindowsBashOptions): WindowsBash {
  const { env, isFile } = options;
  const chosen = options.bashPath;
  if (chosen !== undefined) {
    const problem = !absolute(chosen) ? "is not an absolute path"
      : isWslBash(chosen, env) ? "is WSL's launcher, which runs commands in another filesystem"
      : !isFile(chosen) ? "is not a file"
      : undefined;
    if (problem === undefined) return { path: chosen, gitBash: false };
    return {
      error: `harness: commands run in the bash the host configured, and ${chosen} ${problem}. Nothing was run. ` +
        `The bash must be an absolute path to a bash.exe that exists (Git for Windows' is C:/Program Files/Git/bin/bash.exe; ${GIT_FOR_WINDOWS}).`,
      note: `none: the configured bash (${slashes(chosen)}) ${problem}, so every command fails (exit 127) until it is fixed; tell the user`,
    };
  }
  const searched: string[] = [];
  const found = (bash: string) => {
    searched.push(bash);
    return !isWslBash(bash, env) && isFile(bash);
  };
  // OpenCode: the install whose git.exe is on PATH, from <root>\cmd, <root>\bin or <root>\mingw64\bin.
  for (const directory of pathDirectories(env)) {
    if (!isFile(win32.join(directory, "git.exe"))) continue;
    const parent = win32.dirname(directory);
    const root = /^(?:mingw|clang|ucrt)/iu.test(win32.basename(parent)) ? win32.dirname(parent) : parent;
    const bash = win32.join(root, "bin", "bash.exe");
    if (found(bash)) return { path: bash, gitBash: true };
  }
  // Pi: Git for Windows' default install folders.
  for (const base of [envValue(env, "ProgramFiles"), envValue(env, "ProgramFiles(x86)")]) {
    if (base === undefined || !absolute(base)) continue;
    const bash = win32.join(base, "Git", "bin", "bash.exe");
    if (found(bash)) return { path: bash, gitBash: true };
  }
  // Pi: another bash on PATH (MSYS2, Cygwin), never WSL's.
  for (const directory of pathDirectories(env)) {
    const bash = win32.join(directory, "bash.exe");
    if (!isWslBash(bash, env) && isFile(bash)) return { path: bash, gitBash: false };
  }
  const where = [...new Set(searched)].join(", ");
  return {
    error: "harness: commands on Windows run in Git for Windows' bash, and no bash was found " +
      `(looked at ${where === "" ? "" : `${where} and `}bash.exe on PATH; WSL's does not count). Nothing was run. ` +
      `Install Git for Windows (${GIT_FOR_WINDOWS}) or put an MSYS2 or Cygwin bash.exe on PATH, then start a new session.`,
    note: `none: no bash was found on this Windows host, so every command fails (exit 127) until Git for Windows (${GIT_FOR_WINDOWS}) is installed; tell the user`,
  };
}

const slashes = (path: string) => path.replaceAll("\\", "/");

/** The env block's `shell:` line on Windows (src/run.ts envBlock): which bash, and how to write commands for it. */
export function windowsShellNote(found: WindowsBash): string {
  if (found.path === undefined) return found.note;
  return `${found.gitBash ? "Git Bash" : "bash"} (${slashes(found.path)}), not cmd.exe or PowerShell: ` +
    "use POSIX shell syntax and forward slashes in paths (C:/repo/file)";
}

/**
 * Host variables commands get on Windows, on top of the POSIX allowlist (src/env/local.ts): what Windows programs need
 * to start (SystemRoot, ComSpec, PATHEXT), find the user's folders (USERPROFILE, APPDATA) and temp (TEMP, TMP), and
 * what Git Bash reads to set HOME. Never a secret.
 */
export const WINDOWS_ENV_ALLOWLIST: readonly string[] = [
  "SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramData", "USERNAME", "USERDOMAIN", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
];

/**
 * `taskkill /pid <pid> /T /F`: the process and every process it started that is still in its tree, forcibly. By its
 * full path, as Pi does: a bare name is looked up in the current folder first.
 */
export function taskkillCommand(pid: number, env: HostEnv): { file: string; args: string[] } {
  const root = envValue(env, "SystemRoot") ?? envValue(env, "windir");
  return { file: win32.join(root !== undefined && absolute(root) ? root : "C:\\Windows", "System32", "taskkill.exe"), args: ["/pid", String(pid), "/T", "/F"] };
}
