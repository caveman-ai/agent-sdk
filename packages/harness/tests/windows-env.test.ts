/**
 * LocalEnv on Windows (src/env/windows.ts, src/env/local.ts), on whatever host runs the tests: the bash lookup (the
 * host's, Git for Windows' by its git.exe on PATH, Program Files, a bash.exe on PATH, never WSL's), the variables
 * commands get (case-insensitive there), the taskkill argv and its fallback, the env block's shell line, and a LocalEnv
 * told it is on win32: with no bash every command exits 127 saying how to get one; with a bash, no process groups and
 * no reaper, commands killed through the tree kill (whose fallback is all a POSIX host can run), no self-kill guard, and
 * PATH joined with ";". Real Windows is not exercised here.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isBash, hygieneFlags } from "../src/env/hygiene.ts";
import { allowlistedEnv, ENV_DEFAULTS, killTree, LocalEnv } from "../src/env/local.ts";
import type { ExecEnv } from "../src/env/types.ts";
import { findWindowsBash, isWslBash, taskkillCommand, windowsShellNote, type WindowsBash } from "../src/env/windows.ts";
import { envBlock } from "../src/run.ts";

const files = (...paths: string[]) => {
  const set = new Set(paths.map((path) => path.toLowerCase()));
  return (file: string) => set.has(file.toLowerCase());
};
const SYSTEM = { SystemRoot: "C:\\Windows" };
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

test("Windows bash: Git for Windows' by the git.exe on PATH, first", () => {
  // <root>\cmd on PATH (the installer's default), any case of PATH.
  assert.deepEqual(findWindowsBash({
    env: { ...SYSTEM, Path: "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd" },
    isFile: files("C:\\Program Files\\Git\\cmd\\git.exe", GIT_BASH, "C:\\Windows\\System32\\bash.exe"),
  }), { path: GIT_BASH, gitBash: true });
  // <root>\mingw64\bin on PATH, quoted; it wins over Program Files.
  assert.deepEqual(findWindowsBash({
    env: { ...SYSTEM, PATH: '"D:\\Tools\\Git\\mingw64\\bin";C:\\bin', ProgramFiles: "C:\\Program Files" },
    isFile: files("D:\\Tools\\Git\\mingw64\\bin\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe", GIT_BASH),
  }), { path: "D:\\Tools\\Git\\bin\\bash.exe", gitBash: true });
});

test("Windows bash: Program Files, then (x86), then a bash.exe on PATH that is not WSL's", () => {
  assert.deepEqual(findWindowsBash({ env: { ...SYSTEM, PATH: "C:\\bin", PROGRAMFILES: "C:\\Program Files" }, isFile: files(GIT_BASH) }), { path: GIT_BASH, gitBash: true });
  assert.deepEqual(findWindowsBash({
    env: { ...SYSTEM, PATH: "C:\\bin", ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" },
    isFile: files("C:\\Program Files (x86)\\Git\\bin\\bash.exe"),
  }), { path: "C:\\Program Files (x86)\\Git\\bin\\bash.exe", gitBash: true });
  assert.deepEqual(findWindowsBash({
    env: { ...SYSTEM, PATH: "C:\\Windows\\System32;C:\\msys64\\usr\\bin" },
    isFile: files("C:\\Windows\\System32\\bash.exe", "C:\\msys64\\usr\\bin\\bash.exe"),
  }), { path: "C:\\msys64\\usr\\bin\\bash.exe", gitBash: false });
});

test("Windows bash: WSL's launchers never count, and none found says how to install Git for Windows", () => {
  const env = { SystemRoot: "D:\\Win", PATH: "D:\\Win\\System32;C:\\Windows\\Sysnative;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;relative\\bin" };
  assert.equal(isWslBash("D:\\Win\\System32\\bash.exe", env), true);
  assert.equal(isWslBash("C:\\Windows\\Sysnative\\bash.exe", {}), true);
  assert.equal(isWslBash("C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe", env), true);
  assert.equal(isWslBash(GIT_BASH, env), false);
  const found = findWindowsBash({
    env, isFile: files("D:\\Win\\System32\\bash.exe", "C:\\Windows\\Sysnative\\bash.exe", "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe"),
  });
  assert.ok(found.path === undefined);
  assert.match(found.error, /no bash was found .*WSL's does not count.*https:\/\/git-scm\.com\/download\/win/u);
  assert.match(windowsShellNote(found), /^none: no bash was found .*every command fails \(exit 127\) until Git for Windows \(https:\/\/git-scm\.com\/download\/win\) is installed/u);
  // Nothing on PATH or in Program Files at all (a POSIX host's variables).
  const bare = findWindowsBash({ env: { PATH: "/usr/bin:/bin" }, isFile: () => false });
  assert.ok(bare.path === undefined && /bash\.exe on PATH/u.test(bare.error));
});

test("Windows bash: the host's path is used as given, or refused (relative, WSL's, missing), never replaced", () => {
  const env = { ...SYSTEM, PATH: "C:\\Program Files\\Git\\cmd" };
  const withGit = files("C:\\Program Files\\Git\\cmd\\git.exe", GIT_BASH, "E:\\msys\\bash.exe", "C:\\Windows\\System32\\bash.exe");
  assert.deepEqual(findWindowsBash({ env, isFile: withGit, bashPath: "E:\\msys\\bash.exe" }), { path: "E:\\msys\\bash.exe", gitBash: false });
  assert.deepEqual(findWindowsBash({ env, isFile: withGit, bashPath: "//server/share/bash.exe" }).path, undefined, "missing");
  const cases: [string, RegExp][] = [
    ["bash.exe", /is not an absolute path/u],
    ["C:\\Windows\\System32\\bash.exe", /is WSL's launcher/u],
    ["F:\\nowhere\\bash.exe", /is not a file/u],
  ];
  for (const [bashPath, why] of cases) {
    const found = findWindowsBash({ env, isFile: withGit, bashPath });
    assert.ok(found.path === undefined, bashPath);
    assert.match(found.error, why);
    assert.match(found.error, /Nothing was run/u);
    assert.match(windowsShellNote(found), why);
  }
});

test("the shell note: Git Bash with forward slashes, another bash by name", () => {
  assert.equal(windowsShellNote({ path: GIT_BASH, gitBash: true }),
    "Git Bash (C:/Program Files/Git/bin/bash.exe), not cmd.exe or PowerShell: use POSIX shell syntax and forward slashes in paths (C:/repo/file)");
  assert.match(windowsShellNote({ path: "C:\\msys64\\usr\\bin\\bash.exe", gitBash: false }), /^bash \(C:\/msys64\/usr\/bin\/bash\.exe\), not cmd\.exe/u);
  assert.equal(isBash(GIT_BASH), true);
  assert.equal(isBash("/bin/bash"), true);
  assert.equal(isBash("/bin/sh"), false);
  assert.deepEqual(hygieneFlags(GIT_BASH), ["--noprofile", "--norc"]);
});

test("env allowlist: on Windows the Windows variables too, found in any case, under the allowlist's names; never a secret", () => {
  const host = {
    Path: "C:\\bin", SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", TEMP: "C:\\t", TMP: "C:\\t",
    USERPROFILE: "C:\\Users\\me", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\me", APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData", USERNAME: "me", USERDOMAIN: "BOX",
    NUMBER_OF_PROCESSORS: "8", PROCESSOR_ARCHITECTURE: "AMD64", OS: "Windows_NT", HOME: "C:\\Users\\me", LANG: "en_US.UTF-8", TZ: "UTC",
    OPENAI_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "sk-ant", GITHUB_TOKEN: "ghp", EXTERNAL_API_KEY: "ext", Secret_Thing: "x",
  };
  assert.deepEqual(allowlistedEnv("win32", host), {
    ...ENV_DEFAULTS,
    PATH: "C:\\bin", HOME: "C:\\Users\\me", LANG: "en_US.UTF-8", TZ: "UTC",
    SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE", TEMP: "C:\\t", TMP: "C:\\t",
    USERPROFILE: "C:\\Users\\me", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\me", APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
    ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramData: "C:\\ProgramData", USERNAME: "me", USERDOMAIN: "BOX",
    NUMBER_OF_PROCESSORS: "8", PROCESSOR_ARCHITECTURE: "AMD64", OS: "Windows_NT",
  });
  // POSIX: exact names only, as before (Path is not PATH), and none of the Windows ones.
  assert.deepEqual(allowlistedEnv("linux", host), { ...ENV_DEFAULTS, HOME: "C:\\Users\\me", LANG: "en_US.UTF-8", TZ: "UTC" });
  // This host's commands get what the inline allowlist always gave them.
  const before: Record<string, string> = { ...ENV_DEFAULTS };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key] !== undefined) before[key] = process.env[key]!;
  }
  if (process.platform !== "win32") assert.deepEqual(allowlistedEnv(process.platform, process.env), before);
});

test("taskkill: /pid <pid> /T /F by its full path under SystemRoot; its failure falls back to the child's own kill", async () => {
  assert.deepEqual(taskkillCommand(4242, { SYSTEMROOT: "D:\\Win" }), { file: "D:\\Win\\System32\\taskkill.exe", args: ["/pid", "4242", "/T", "/F"] });
  assert.equal(taskkillCommand(7, { windir: "E:\\W" }).file, "E:\\W\\System32\\taskkill.exe");
  assert.equal(taskkillCommand(7, {}).file, "C:\\Windows\\System32\\taskkill.exe");
  const run = (outcome: { code?: number; error?: boolean; throws?: boolean }) => {
    const calls: { file: string; args: string[]; options: unknown }[] = [];
    const kills: unknown[] = [];
    const child = { pid: 99, kill: (signal?: unknown) => (kills.push(signal), true) };
    killTree(child as never, { SystemRoot: "C:\\Windows" }, (file, args, options) => {
      calls.push({ file, args, options });
      if (outcome.throws === true) throw new Error("spawn EPERM");
      const killer = new EventEmitter();
      setImmediate(() => (outcome.error === true ? killer.emit("error", new Error("spawn ENOENT")) : killer.emit("exit", outcome.code ?? 0)));
      return killer as never;
    });
    return { calls, kills };
  };
  const ok = run({ code: 0 });
  const failed = run({ code: 128 });
  const missing = run({ error: true });
  const thrown = run({ throws: true });
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(ok.calls, [{ file: "C:\\Windows\\System32\\taskkill.exe", args: ["/pid", "99", "/T", "/F"], options: { stdio: "ignore", windowsHide: true } }]);
  assert.deepEqual(ok.kills, [], "taskkill did it");
  assert.deepEqual(failed.kills, ["SIGKILL"]);
  assert.deepEqual(missing.kills, ["SIGKILL"]);
  assert.deepEqual(thrown.kills, ["SIGKILL"]);
});

test("the env block: a shell line only where the env has a note", () => {
  const env = (shellNote?: string) => ({ cwd: "/w", os: "linux", ...(shellNote === undefined ? {} : { shellNote }) }) as unknown as ExecEnv;
  assert.equal(envBlock(env()), "<env>\ncwd: /w\nos: linux\n</env>");
  assert.equal(envBlock(env("Git Bash (C:/x/bash.exe), not cmd.exe or PowerShell: use POSIX")),
    "<env>\ncwd: /w\nos: linux\nshell: Git Bash (C:/x/bash.exe), not cmd.exe or PowerShell: use POSIX\n</env>");
});

const cwd = () => realpathSync(mkdtempSync(join(tmpdir(), "harness-win-")));

test("LocalEnv off Windows: no shell note, the env block as before", async () => {
  if (process.platform === "win32") return;
  const env = new LocalEnv({ cwd: cwd() });
  try {
    assert.equal(env.shellNote, undefined);
    assert.equal(env.os, process.platform);
    assert.equal(envBlock(env), `<env>\ncwd: ${env.cwd}\nos: ${process.platform}\n</env>`);
  } finally {
    await env.close();
  }
});

test("LocalEnv on win32 with no bash: every command exits 127 with how to install Git for Windows, nothing throws", async () => {
  if (process.platform === "win32") return;
  const env = new LocalEnv({ cwd: cwd(), platform: "win32" });
  try {
    assert.equal(env.os, "win32");
    assert.match(env.shellNote ?? "", /^none: no bash was found/u);
    assert.match(envBlock(env), /\nos: win32\nshell: none: no bash was found .*git-scm\.com\/download\/win.*\n<\/env>$/u);
    for (const options of [{}, { background: true }, { yieldMs: 10 }]) {
      const result = await env.exec("echo hi", options);
      assert.equal(result.exitCode, 127);
      assert.equal(result.running, false);
      assert.equal(result.handle, undefined);
      assert.match(result.output, /no bash was found.*Install Git for Windows \(https:\/\/git-scm\.com\/download\/win\)/u);
    }
    const refused = new LocalEnv({ cwd: cwd(), platform: "win32", shell: "bash.exe" });
    assert.match(refused.shellNote ?? "", /configured bash \(bash\.exe\) is not an absolute path/u);
    assert.match((await refused.exec("true")).output, /bash\.exe is not an absolute path\. Nothing was run\./u);
    await refused.close();
  } finally {
    await env.close();
  }
});

test("LocalEnv on win32 with a bash: no groups or reaper; timeout, kill, abort and close end commands; no self-kill guard; ';' on PATH", async () => {
  if (process.platform === "win32") return;
  const bash: WindowsBash = { path: "/bin/bash", gitBash: true };
  const env = new LocalEnv({ cwd: cwd(), platform: "win32" }, { windowsBash: bash });
  try {
    assert.equal(env.shellNote, "Git Bash (/bin/bash), not cmd.exe or PowerShell: use POSIX shell syntax and forward slashes in paths (C:/repo/file)");
    const echo = await env.exec("echo hi");
    assert.equal(echo.output, "hi\n");
    assert.equal(echo.exitCode, 0);
    // Timeout: taskkill is not on this host, so its fallback (the child's own kill) is what ends the command.
    const started = performance.now();
    const timed = await env.exec("sleep 30", { timeoutMs: 300 });
    assert.equal(timed.timedOut, true);
    assert.equal(timed.exitCode, null);
    assert.ok(performance.now() - started < 10_000);
    const background = await env.exec("echo $$; exec sleep 30", { yieldMs: 300 });
    assert.equal(background.running, true);
    assert.deepEqual(env.trackedGroups(), [], "no process groups on Windows");
    assert.equal(env.reaperPid(), undefined, "no reaper on Windows");
    const killed = await env.kill(background.handle!);
    assert.equal(killed.killed, true);
    assert.equal(killed.running, false);
    const abort = new AbortController();
    const pending = env.exec("sleep 30", { signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    assert.equal((await pending).killed, true);
    // The guard would refuse this (kill $PPID is the harness); on Windows it is off and `kill` here is a function.
    const posix = new LocalEnv({ cwd: env.cwd });
    posix.configureShell({ selfKillGuard: true });
    const guarded = "kill() { echo fake; }; kill $PPID";
    assert.equal((await posix.exec(guarded)).refused, true);
    await posix.close();
    env.configureShell({ selfKillGuard: true, toolboxPath: env.cwd });
    const unguarded = await env.exec(guarded);
    assert.equal(unguarded.refused, undefined);
    assert.equal(unguarded.output, "fake\n");
    assert.ok((await env.exec('printf %s "$PATH"')).output.endsWith(`;${env.cwd}`), "PATH joins with ';' on Windows");
    // close() ends what still runs.
    const live = await env.exec("echo $$; exec sleep 30", { yieldMs: 300 });
    const pid = Number(live.output.trim());
    assert.ok(pid > 0);
    await env.close();
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  } finally {
    await env.close();
  }
});
