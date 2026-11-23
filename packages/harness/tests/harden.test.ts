/**
 * The harden lane's levers, each a loadout flag that is off by default:
 * policy.shell_hygiene, policy.watch_stop, policy.self_kill_guard,
 * env.toolbox_path, trace.cache_monitor, wire.prompt_cache_key_mode, and the
 * --transcript output (not a flag: it never changes a request). Offline:
 * LocalEnv on this host and a loopback Responses server; no model calls.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { endsOnWatchBanner, parseCommands, plainText, selfKillRefusal, type GuardedProcess } from "../src/env/hygiene.ts";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, loadoutHash, normalizeLoadout, readLoadout, shellSettingsOf, type Loadout } from "../src/loadout.ts";
import { fauxStep } from "../src/models.ts";
import { runHarness } from "../src/run.ts";
import { compactTools } from "../src/tools/compact.ts";
import { cacheBreak, promptItems } from "../src/trace.ts";
import { taskCacheKey } from "../src/wire.ts";
import { loopbackRun } from "./loopback.ts";

const workdir = () => realpathSync(mkdtempSync(join(tmpdir(), "harness-harden-")));
const builtin = (name: string) => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withFlags = (name: string, patch: (raw: Record<string, any>) => void): Loadout => {
  const raw = builtin(name);
  raw.name = `${name}-arm`;
  patch(raw);
  return normalizeLoadout(raw);
};
const events = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);

// ------------------------------------------------------------------ loadout flags

test("every lever flag is off in the built-ins, and spelling one out as off hashes like omitting it", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const { loadout, behaviorHash } = readLoadout(name);
    assert.deepEqual(shellSettingsOf(loadout), {}, name);
    assert.equal(loadout.env, undefined);
    assert.equal(loadout.trace, undefined);
    assert.equal(loadout.wire.prompt_cache_key_mode, undefined);
    const spelled = builtin(name);
    Object.assign(spelled.policy, { shell_hygiene: false, watch_stop: false, self_kill_guard: false });
    Object.assign(spelled, { env: { toolbox_path: false }, trace: { cache_monitor: false } });
    spelled.wire.prompt_cache_key_mode = "session";
    assert.equal(loadoutHash(normalizeLoadout(spelled)), behaviorHash, `${name}: defaults spelled out`);
  }
});

test("each flag on changes behavior_hash and reaches the env settings; toolbox true is /opt/tb4/bin", () => {
  const base = readLoadout("compact-v0-plain").behaviorHash;
  const on = withFlags("compact-v0-plain", (raw) => {
    Object.assign(raw.policy, { shell_hygiene: true, watch_stop: true, self_kill_guard: true });
    raw.env = { toolbox_path: true };
  });
  assert.deepEqual(shellSettingsOf(on), { hygiene: true, watchStopMs: 10_000, selfKillGuard: true, toolboxPath: "/opt/tb4/bin" });
  const hashes = new Set<string>([base]);
  for (const patch of [
    (raw: Record<string, any>) => (raw.policy.shell_hygiene = true),
    (raw: Record<string, any>) => (raw.policy.watch_stop = true),
    (raw: Record<string, any>) => (raw.policy.self_kill_guard = true),
    (raw: Record<string, any>) => (raw.env = { toolbox_path: true }),
    (raw: Record<string, any>) => (raw.trace = { cache_monitor: true }),
    (raw: Record<string, any>) => (raw.wire.prompt_cache_key_mode = "task"),
  ]) {
    const raw = builtin("compact-v0-plain");
    patch(raw);
    hashes.add(loadoutHash(normalizeLoadout(raw)));
  }
  assert.equal(hashes.size, 7, "six flags, six distinct behaviors");
  const explicit = builtin("compact-v0-plain");
  explicit.env = { toolbox_path: "/opt/tb4/bin/" };
  const implied = builtin("compact-v0-plain");
  implied.env = { toolbox_path: true };
  assert.equal(loadoutHash(normalizeLoadout(explicit)), loadoutHash(normalizeLoadout(implied)), "true names /opt/tb4/bin");
  const relative = builtin("compact-v0-plain");
  relative.env = { toolbox_path: "opt/tb4" };
  assert.throws(() => normalizeLoadout(relative), /toolbox_path/u);
  const conflict = builtin("compact-v0-plain");
  Object.assign(conflict.wire, { prompt_cache_key: "off", prompt_cache_key_mode: "task" });
  assert.throws(() => normalizeLoadout(conflict), /prompt_cache_key_mode "task" needs a prompt_cache_key/u);
});

// ------------------------------------------------------------------ B3 shell hygiene

test("shell_hygiene: pkill -f on the command's own text no longer kills the shell running it (off: it does)", async () => {
  const token = `${31_000 + Math.floor(Math.random() * 999)}.${Math.floor(Math.random() * 9_000) + 1_000}`;
  // BSD pkill skips its own ancestors unless -a; procps pkill (Linux, the bench) does not.
  const command = `sleep ${token} & sleep 0.3; pkill ${process.platform === "linux" ? "" : "-a "}-f "sleep ${token}"; echo survived`;
  const on = new LocalEnv({ cwd: workdir() });
  on.configureShell({ hygiene: true });
  const off = new LocalEnv({ cwd: workdir() });
  try {
    const hardened = await on.exec(command, { timeoutMs: 20_000 });
    assert.equal(hardened.exitCode, 0, hardened.output);
    assert.match(hardened.output, /survived/u);
    const plain = await off.exec(command, { timeoutMs: 20_000 });
    assert.doesNotMatch(plain.output, /survived/u, "without hygiene the shell's argv carries the pattern and pkill kills it");
  } finally {
    await on.close();
    await off.close();
  }
});

test("shell_hygiene: no rc files, BASH_ENV/ENV /dev/null (an image's own BASH_ENV wins), stdin EOF, git never pages or prompts", async () => {
  const cwd = workdir();
  const rc = join(cwd, "rc.sh");
  writeFileSync(rc, "echo RC-SOURCED\n");
  const env = new LocalEnv({ cwd });
  env.configureShell({ hygiene: true });
  const image = new LocalEnv({ cwd, env: { BASH_ENV: rc } });
  image.configureShell({ hygiene: true });
  try {
    const run = await env.exec('echo "[$BASH_ENV][$ENV][$GIT_TERMINAL_PROMPT][$GIT_PAGER][$PAGER]"; read -r line; echo "read=$?"; env | grep -c __harness_cmd; ps -o args= -p $$', { timeoutMs: 10_000 });
    assert.equal(run.exitCode, 0, run.output);
    const lines = run.output.trim().split("\n");
    assert.equal(lines[0], "[/dev/null][/dev/null][0][cat][cat]");
    assert.equal(lines[1], "read=1", "stdin is /dev/null: read hits EOF at once");
    assert.equal(lines[2], "0", "the command variable is not exported to the command's children");
    assert.doesNotMatch(lines[3] ?? "", /read -r line/u, "the shell's argv is the fixed stub, not the command");
    const git = await env.exec("git config --get core.editor; git config --get core.pager; git config --get safe.directory", { timeoutMs: 10_000 });
    if (git.exitCode !== 127) assert.equal(git.output.trim(), "true\ncat\n*");
    const sourced = await image.exec("echo body", { timeoutMs: 10_000 });
    assert.equal(sourced.output, "RC-SOURCED\nbody\n", "the image's BASH_ENV is the image's choice");
  } finally {
    await env.close();
    await image.close();
  }
});

test("shell_hygiene: exit codes, syntax errors, heredocs, multi-line scripts and cwd behave as before", async () => {
  const cwd = workdir();
  mkdirSync(join(cwd, "sub"));
  const on = new LocalEnv({ cwd });
  on.configureShell({ hygiene: true });
  const off = new LocalEnv({ cwd });
  try {
    for (const command of ["exit 7", "if then", "cat <<'EOF'\n$HOME is literal\nEOF", "a=1\nb=2\necho $((a+b)) \"$0\"", "pwd; false || echo or", 'printf "%s\\n" "$@"; echo "args=$#"']) {
      const left = await on.exec(command, { timeoutMs: 10_000, cwd: "sub" });
      const right = await off.exec(command, { timeoutMs: 10_000, cwd: "sub" });
      if (command === "if then") {
        // A syntax error is reported by eval instead of -c, and bash 3.2's eval exits 1 where -c exits 2.
        assert.ok(left.exitCode !== 0 && right.exitCode !== 0, command);
        assert.match(left.output, /syntax error/u);
        continue;
      }
      assert.equal(left.exitCode, right.exitCode, command);
      assert.equal(left.output, right.output, command);
    }
  } finally {
    await on.close();
    await off.close();
  }
});

// ------------------------------------------------------------------ B3 watch stop

test("watch banner matcher: vitest, tsc, nodemon, jest and ANSI-coloured banners match; a banner mid-output or vite's help line do not", () => {
  const yes = [
    " Test Files  3 passed (3)\n      Tests  12 passed (12)\n\n Waiting for file changes...\n       press h to show help, press q to quit\n",
    "\x1b[32m✓\x1b[39m done\n\x1b[2K\r\x1b[1m\x1b[36m Waiting for file changes...\x1b[39m\x1b[22m\n  \x1b[2mpress \x1b[22m\x1b[1mh\x1b[22m\x1b[2m to show help\x1b[22m\n\n",
    "[12:00:00 PM] Found 0 errors. Watching for file changes.\n",
    "[nodemon] app crashed - waiting for file changes before starting...\n",
    "Ran all test suites.\n\nWatch Usage: Press w to show more.",
    "progress 99%\rWAITING FOR CHANGES   \n\n",
  ];
  for (const tail of yes) assert.equal(endsOnWatchBanner(tail), true, JSON.stringify(tail));
  const no = [
    "Waiting for file changes...\nrebuilding\nerror TS2304\n",
    "  VITE v5  ready in 300 ms\n  ➜  Local:   http://localhost:5173/\n  ➜  press h + enter to show help\n",
    "press h to show help\n",
    "all tests passed\n",
    "",
  ];
  for (const tail of no) assert.equal(endsOnWatchBanner(tail), false, JSON.stringify(tail));
  assert.equal(plainText("a\x1b]0;title\x07b\x1b[1;31mc\x1b(Bd\r\n"), "abcd\n\n");
});

test("watch banner matcher is linear: 4 MB of near-miss text is scanned in seconds, not minutes", () => {
  const nasty = `${"waiting for file chang".repeat(100_000)}${"\x1b[".repeat(500_000)}`;
  const started = performance.now();
  for (let i = 0; i < 4; i++) endsOnWatchBanner(nasty);
  // About 0.4 s on an idle host and 2.5 s under a bench's load; a super-linear scan of this input takes minutes.
  assert.ok(performance.now() - started < 10_000, `${performance.now() - started} ms`);
});

test("watch_stop: silent on a watch banner -> stopped, exit 124, a one-line remedy; other silence and the flag off are untouched", async () => {
  const banner = "printf ' Tests  3 passed (3)\\n\\n Waiting for file changes...\\n       press h to show help, press q to quit\\n'";
  const on = new LocalEnv({ cwd: workdir() });
  on.configureShell({ watchStopMs: 300 });
  const off = new LocalEnv({ cwd: workdir() });
  try {
    const started = performance.now();
    const stopped = await on.exec(`${banner}; sleep 30`, { yieldMs: 20_000, timeoutMs: 60_000 });
    assert.ok(performance.now() - started < 5_000, "stopped well before the sleep or the yield");
    assert.equal(stopped.exitCode, 124);
    assert.equal(stopped.watchStopped, true);
    assert.equal(stopped.running, false);
    assert.match(stopped.output, /Tests {2}3 passed/u, "the run's results stay");
    const note = stopped.output.trim().split("\n").at(-1)!;
    assert.match(note, /^\[harness: stopped after 0 s without output: .*CI=1.*--run.*\]$/u);
    const quiet = await on.exec("echo working; sleep 1; echo finished", { yieldMs: 20_000 });
    assert.equal(quiet.exitCode, 0, "silence without a banner is not a watcher");
    assert.equal(quiet.watchStopped, undefined);
    const untouched = await off.exec(`${banner}; sleep 1`, { yieldMs: 20_000 });
    assert.equal(untouched.exitCode, 0, "off: the command runs to its end");
    // A yielded command is still watched while it runs in the background.
    const yielded = await on.exec(`sleep 0.4; ${banner}; sleep 30`, { yieldMs: 100, timeoutMs: 60_000 });
    assert.equal(yielded.running, true);
    const later = await on.wait(yielded.handle!, 10_000);
    assert.equal(later.exitCode, 124);
    assert.match(later.output, /CI=1/u);
  } finally {
    await on.close();
    await off.close();
  }
});

test("watch_stop: the bash tool shows the stop as exit code 124 with the remedy", async () => {
  const env = new LocalEnv({ cwd: workdir() });
  env.configureShell({ watchStopMs: 200 });
  try {
    const bash = compactTools({ env, loadout: readLoadout("compact-v0").loadout, images: false }).find((tool) => tool.name === "bash")!;
    const result = await bash.execute("t", { command: "echo 'Found 0 errors. Watching for file changes.'; sleep 30" } as never);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    assert.match(text, /Watching for file changes\.\n\[harness: stopped after 0 s without output.*\]\n\nCommand exited with code 124$/su);
    assert.equal((result.details as { exitCode: number }).exitCode, 124);
  } finally {
    await env.close();
  }
});

// ------------------------------------------------------------------ B3 self-kill guard

const HARNESS: GuardedProcess = { pid: 4242, ppid: 4000, pgid: 4242, comm: "node", args: "node /opt/harness/dist/harness.mjs run --loadout compact-v0" };
const RIG: GuardedProcess = { pid: 4000, ppid: 1, pgid: 3999, comm: "python3", args: "python3 rig/v3arm.py --arm compact" };
const PROCS = [HARNESS, RIG];
const refuse = (command: string) => selfKillRefusal(command, PROCS, { user: "agent", uid: 1000, platform: "linux" });

test("self-kill guard: kill lines that would hit the harness or its ancestors are refused with a correctable message", () => {
  for (const command of [
    "pkill node", "pkill -9 -f node", "pkill -f harness.mjs", "pkill -f 'python3 rig'", "pkill -KILL -f '.'", "pkill -fi HARNESS",
    "killall node", "killall -9 python3", "kill 4242", "kill -9 4000", "kill -TERM -- -4242", "kill -s KILL -3999", "kill -9 -1",
    "kill $PPID", 'kill -9 "${PPID}"', "kill $(pgrep -f harness)", "kill -9 `pgrep node`", "pgrep -f node | xargs kill -9",
    "pgrep -f node | head -1 | xargs -r kill", "sudo pkill -f node", "cd /tmp && timeout 5 pkill node; echo done", "pkill -u agent",
    "kill $(pidof node)", "env FOO=1 pkill -x node", "pkill -P 4000", "npm test; pkill -f node",
    "while true; do pkill node; done", "if true; then killall node; fi", "{ kill $PPID; }", "pgrep node | xargs -I {} kill {}",
  ]) {
    const refusal = refuse(command);
    assert.ok(refusal !== undefined, `should refuse: ${command}`);
    assert.match(refusal, /^\[harness: refused, nothing was run: `.*`.*(pgrep -fl PATTERN|by pid or by a pattern).*\]$/u, command);
  }
  assert.match(refuse("pkill -f node")!, /pid 4242 node \/opt\/harness/u, "names what it would have hit");
});

test("self-kill guard: kills of the model's own processes, signal 0, other users and look-alike text are allowed", () => {
  for (const command of [
    "pkill -f 'node server.js'", "pkill -f vitest", "pkill -0 -f node", "kill -0 $PPID", "kill -0 4242", "kill 1234", "kill -9 -4321",
    "kill %1", "kill $!", "kill $pid", "kill 0", "killall vite", "pkill -u otheruser node", "pkill -n node", "kill -l",
    "echo 'pkill -f node'", "grep -r pkill .", "# pkill node", "pgrep -f node", "kill $(cat server.pid)", "lsof -ti:3000 | xargs kill",
    "pkill -t pts/3 node", "pkill -g 77 node", "python skill.py", "pkill",
  ]) {
    assert.equal(refuse(command), undefined, `should allow: ${command}`);
  }
  assert.equal(selfKillRefusal("pkill node", []), undefined, "nothing to guard");
  // BSD pkill/pgrep (macOS) skip their own ancestors unless -a: the harness is one, so only -a or killall/kill reach it.
  const bsd = (command: string) => selfKillRefusal(command, PROCS, { user: "agent", uid: 1000, platform: "darwin" });
  assert.equal(bsd("pkill -f node"), undefined);
  assert.equal(bsd("pgrep node | xargs kill"), undefined);
  assert.notEqual(bsd("pkill -a -f node"), undefined);
  assert.notEqual(bsd("killall node"), undefined);
  assert.notEqual(bsd("kill $PPID"), undefined);
  const decoy = { ...HARNESS, pid: 9999, args: "node decoy" };
  assert.notEqual(selfKillRefusal("pkill -f decoy", [decoy, ...PROCS], { platform: "darwin", ancestors: new Set([4242, 4000]) }), undefined, "a guarded process that is not an ancestor is hit");
});

test("self-kill guard: the parser splits pipelines, lists and substitutions, and keeps quoted text as one word", () => {
  const { commands, substitutions } = parseCommands(`a "b c" 'd e' f\\ g | h $(i "j") && k; l & m\nn # o`);
  assert.deepEqual(commands.map((command) => command.words.map((word) => word.replace(/\0S(\d+)\0/gu, "<$1>"))), [["a", "b c", "d e", "f g"], ["h", "<0>"], ["k"], ["l"], ["m"], ["n"]]);
  assert.deepEqual(commands[1]!.pipedFrom?.words, ["a", "b c", "d e", "f g"]);
  assert.deepEqual(substitutions[0]!.map((command) => command.words), [["i", "j"]]);
});

test("self_kill_guard on LocalEnv: pkill -f on the guarded process's argv is refused and it survives; off, it dies", async () => {
  const marker = `decoy-${randomUUID()}`;
  const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore" });
  const alive = () => {
    try {
      process.kill(decoy.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };
  const guarded = new LocalEnv({ cwd: workdir(), guardRoot: decoy.pid! });
  guarded.configureShell({ selfKillGuard: true });
  const open = new LocalEnv({ cwd: workdir(), guardRoot: decoy.pid! });
  open.configureShell({ hygiene: true }); // so the pkill line does not also kill its own shell
  try {
    await new Promise((done) => setTimeout(done, 200));
    const refused = await guarded.exec(`echo before; pkill -f ${marker}; echo after`, { timeoutMs: 10_000 });
    assert.equal(refused.exitCode, 1);
    assert.equal(refused.refused, true);
    assert.doesNotMatch(refused.output, /before|after/u, "nothing of the line ran");
    assert.match(refused.output, new RegExp(`pid ${decoy.pid}`, "u"));
    await new Promise((done) => setTimeout(done, 200));
    assert.equal(alive(), true);
    const fine = await guarded.exec("echo ok; kill -0 $$", { timeoutMs: 10_000 });
    assert.equal(fine.output, "ok\n");
    const killed = await open.exec(`pkill -f ${marker}; echo after`, { timeoutMs: 10_000 });
    assert.match(killed.output, /after/u);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(alive(), false, "with the guard off the same line kills it");
  } finally {
    decoy.kill("SIGKILL");
    await guarded.close();
    await open.close();
  }
});

// ------------------------------------------------------------------ toolbox on PATH

test("env.toolbox_path: an existing toolbox goes last on PATH (the image's tools win); a missing one changes nothing", async () => {
  const cwd = workdir();
  const box = join(cwd, "tb4bin");
  const mine = join(cwd, "mine");
  mkdirSync(box);
  mkdirSync(mine);
  for (const [dir, name, text] of [[box, "tbx-probe", "toolbox"], [box, "shadowed", "toolbox"], [mine, "shadowed", "image"]] as const) {
    writeFileSync(join(dir, name), `#!/bin/sh\necho ${text}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  const imagePath = `${mine}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  const on = new LocalEnv({ cwd, env: { PATH: imagePath } });
  on.configureShell({ toolboxPath: box });
  const missing = new LocalEnv({ cwd, env: { PATH: imagePath } });
  missing.configureShell({ toolboxPath: join(cwd, "nope") });
  try {
    const run = await on.exec('tbx-probe; shadowed; echo "$PATH"', { timeoutMs: 10_000 });
    assert.deepEqual(run.output.trim().split("\n"), ["toolbox", "image", `${imagePath}:${box}`]);
    const none = await missing.exec('echo "$PATH"', { timeoutMs: 10_000 });
    assert.equal(none.output.trim(), imagePath);
  } finally {
    await on.close();
    await missing.close();
  }
});

test("B3 flags on an env that cannot apply them (no configureShell, e.g. DockerEnv) fail the run up front; off, it runs as before", async () => {
  const cwd = workdir();
  const bare = () => {
    const env = new LocalEnv({ cwd });
    Object.defineProperty(env, "configureShell", { value: undefined });
    return env;
  };
  const on = normalizeLoadout({ ...(BUILTIN_LOADOUTS["compact-v0-plain"] as Record<string, unknown>), name: "b3-on", policy: { shell_hygiene: true, watch_stop: true }, env: { toolbox_path: true } });
  const steps = [fauxStep({ text: "Done." })];
  const env = bare();
  try {
    await assert.rejects(runHarness({ prompt: "Say hi.", model: "faux/b3", effort: "high", loadout: on, env, fauxSteps: steps }),
      /does not apply the loadout's shell flags \(hygiene, watchStopMs, toolboxPath\)/u);
    const off = await runHarness({ prompt: "Say hi.", model: "faux/b3", effort: "high", loadout: readLoadout("compact-v0-plain").loadout, env, fauxSteps: [fauxStep({ text: "Done." })] });
    assert.equal(off.status, "finished", JSON.stringify(off));
  } finally {
    await env.close();
  }
});

// ------------------------------------------------------------------ B2 cache-break monitor

test("cache monitor: append-only is none; an edited item, a changed tool set and a shrunk prompt are named at their index", () => {
  const body = (input: unknown[], tools = [{ name: "bash" }]) => ({ instructions: "sys", tools, input });
  const first = promptItems(body([{ role: "user", content: "task" }]));
  assert.deepEqual(first.map((item) => item.kind), ["instructions", "tools", "user"]);
  const appended = promptItems(body([{ role: "user", content: "task" }, { type: "function_call", call_id: "1" }, { type: "function_call_output", call_id: "1", output: "ok" }]));
  assert.deepEqual(cacheBreak(undefined, first), { index: null, kind: null, prevKind: null, reason: "none" });
  assert.deepEqual(cacheBreak(first, appended), { index: null, kind: null, prevKind: null, reason: "none" });
  const edited = promptItems(body([{ role: "user", content: "task" }, { type: "function_call", call_id: "1" }, { type: "function_call_output", call_id: "1", output: "OK (edited)" }]));
  assert.deepEqual(cacheBreak(appended, edited), { index: 4, kind: "function_call_output", prevKind: "function_call_output", reason: "prefix_mutation" });
  const retooled = promptItems(body([{ role: "user", content: "task" }], [{ name: "bash" }, { name: "wait" }]));
  assert.deepEqual(cacheBreak(first, retooled), { index: 1, kind: "tools", prevKind: "tools", reason: "tool_set_change" });
  const compacted = promptItems(body([{ role: "user", content: "summary of the work so far" }]));
  assert.deepEqual(cacheBreak(appended, compacted), { index: 2, kind: "user", prevKind: "user", reason: "compaction" });
  // Anthropic: a breakpoint that moves to the newest message is not a prefix change.
  const messages = (marked: number) => ({
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [0, 1, 2].slice(0, marked + 1).map((index) => ({ role: index % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${index}`, ...(index === marked ? { cache_control: { type: "ephemeral" } } : {}) }] })),
  });
  assert.deepEqual(cacheBreak(promptItems(messages(1)), promptItems(messages(2))).reason, "none");
});

test("trace.cache_monitor: a cache event per request with the break and the cache_read share (both built-in wires are append-only)", async () => {
  for (const [name, expected] of [["compact-v0-plain", { first_diverging_index: null, item_kind: null, reason: "none" }], ["compact-v0", { first_diverging_index: null, prev_kind: null, reason: "none" }]] as const) {
    const trace = join(workdir(), "trace.jsonl");
    const loadout = withFlags(name, (raw) => (raw.trace = { cache_monitor: true }));
    await loopbackRun(loadout, { extra: { tracePath: trace } });
    const cache = events(trace).filter((event) => event.type === "cache");
    assert.equal(cache.length, 2, name);
    assert.deepEqual({ n: cache[0]!.n, reason: cache[0]!.reason, prev_items: cache[0]!.prev_items, share: cache[0]!.cache_read_share }, { n: 1, reason: "none", prev_items: 0, share: 0 });
    assert.equal(cache[1]!.cache_read_share, 0.8, "80 of 100 prompt tokens were cache reads");
    for (const [key, value] of Object.entries(expected)) assert.equal(cache[1]![key], value, `${name} ${key}`);
    assert.ok(cache[1]!.items > cache[1]!.prev_items);
  }
  const plainTrace = join(workdir(), "trace.jsonl");
  await loopbackRun(readLoadout("compact-v0-plain").loadout, { extra: { tracePath: plainTrace } });
  assert.equal(events(plainTrace).filter((event) => event.type === "cache").length, 0, "off: no cache events");
});

// ------------------------------------------------------------------ wire.prompt_cache_key_mode

test("prompt_cache_key_mode task: one key per task prefix, the same on every request and every run of the task; a new task, a new key", async () => {
  const loadout = withFlags("compact-v0-plain", (raw) => (raw.wire.prompt_cache_key_mode = "task"));
  const cwd = workdir();
  const keys = async (prompt: string) => (await loopbackRun(loadout, { prompt, cwd })).bodies.map((raw) => JSON.parse(raw).prompt_cache_key as string);
  const [a1, a2] = await keys("Fix the bug.");
  const [b1, b2] = await keys("Fix the bug.");
  const [c1] = await keys("Write the docs.");
  assert.match(a1!, /^task-[0-9a-f]{40}$/u);
  assert.equal(a1, a2, "stable within a run");
  assert.equal(a1, b1, "shared by every run of the task");
  assert.equal(b1, b2);
  assert.notEqual(a1, c1, "another task, another key");
  const session = (await loopbackRun(readLoadout("compact-v0-plain").loadout, { cwd })).bodies.map((raw) => JSON.parse(raw).prompt_cache_key as string);
  assert.match(session[0]!, /^[0-9a-f-]{36}$/u, "default: the session id");
  assert.equal(taskCacheKey({ model: "m", input: [{ role: "developer", content: "s" }, { role: "user", content: "t" }, { type: "function_call" }] }),
    taskCacheKey({ model: "m", input: [{ role: "developer", content: "s" }, { role: "user", content: "t" }] }), "only the prefix through the first user message counts");
});

// ------------------------------------------------------------------ --transcript

test("transcript: system, task, assistant (tool call input, reasoning tokens) and tool results as the model saw them; requests unchanged", async () => {
  const cwd = workdir();
  const path = join(cwd, "transcript.jsonl");
  const loadout = readLoadout("compact-v0-plain").loadout;
  const withTranscript = await loopbackRun(loadout, { cwd, extra: { transcriptPath: path } });
  const without = await loopbackRun(loadout, { cwd });
  const mask = (raw: string) => JSON.stringify({ ...JSON.parse(raw), prompt_cache_key: "<session>" });
  assert.deepEqual(withTranscript.bodies.map(mask), without.bodies.map(mask), "the transcript never changes a request");
  const lines = events(path);
  assert.deepEqual(lines.map((line) => line.type), ["system", "user", "assistant", "tool_result", "assistant"]);
  assert.deepEqual(lines.map((line) => line.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(lines[0]!.sections, ["core.identity", "compact.tools", "core.verify", "core.finish"]);
  assert.deepEqual(lines[0]!.tools.map((tool: { name: string }) => tool.name).sort(), ["bash", "edit", "read", "wait", "write"]);
  assert.ok(withTranscript.bodies[0]!.includes(JSON.stringify(lines[0]!.text).slice(1, -1)), "the system text is what was sent");
  assert.match(lines[1]!.content[0].text, /<env>\ncwd: .*\n<\/env>\n\nSay hi\.$/su);
  assert.deepEqual(lines[2]!.tool_calls, [{ id: lines[2]!.tool_calls[0].id, name: "bash", input: { command: "echo hi" } }]);
  assert.equal(lines[2]!.usage.reasoning, 7);
  assert.deepEqual({ name: lines[3]!.name, content: lines[3]!.content, is_error: lines[3]!.is_error }, { name: "bash", content: [{ type: "text", text: "hi" }], is_error: false });
  assert.equal(lines[4]!.text, "Done.");
  assert.equal(lines[4]!.stop_reason, "stop");
});
