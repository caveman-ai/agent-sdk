/**
 * policy.travel_jit (src/travel-jit.ts, src/levers.ts): off by default and
 * hashed as before; the install, shell-write and package-output rules with
 * their negatives (bare npm ci, pip install -e ., a requirements file, a
 * failed install, an already-satisfied one); and each kind in a faux run on a
 * LocalEnv: the note on the result that created the hazard (packages,
 * scratch) or on the next one (data), max_per_kind, the task-named and
 * test-layout exceptions, a data path under /usr, internal handles, the
 * placebo, and travel_check alongside. Offline; no model calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import { estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness } from "../src/run.ts";
import { gradedCode, installedPackages, installsIn, modulesOf, shellWrites as shellWritesOf, type Install } from "../src/travel-jit.ts";

const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  raw.policy ??= {};
  patch(raw);
  return normalizeLoadout(raw);
};

// ---------- loadout ----------

test("travel_jit is off by default: absent or false normalizes and hashes like the built-in; true turns on every kind once each", () => {
  for (const name of ["exec-v0", "compact-v0-plain"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(loadoutHash(withLevers((raw) => (raw.policy.travel_jit = false), name)), loadoutHash(plain), name);
    assert.equal(plain.policy.travel_jit, undefined);
  }
  const on = withLevers((raw) => (raw.policy.travel_jit = true));
  assert.deepEqual(on.policy.travel_jit, {
    kinds: ["data", "packages", "scratch"], max_per_kind: 1,
    text_packages: LEVER_TEXTS.travel_jit_packages, text_scratch: LEVER_TEXTS.travel_jit_scratch, text_data: LEVER_TEXTS.travel_jit_data,
  });
  const some = withLevers((raw) => (raw.policy.travel_jit = { kinds: ["scratch", "packages"], max_per_kind: 2 }));
  assert.deepEqual([some.policy.travel_jit?.kinds, some.policy.travel_jit?.max_per_kind], [["packages", "scratch"], 2]);
  assert.deepEqual(withLevers((raw) => (raw.policy.travel_jit = { kinds: ["packages"] })).policy.travel_jit?.kinds, ["packages"], "packages alone");
  assert.notEqual(loadoutHash(withLevers((raw) => (raw.policy.travel_jit = { text_scratch: "Other {files}." }))), loadoutHash(on));
});

test("travel_jit settings fail closed: unknown keys and kinds, empty kinds, max 0, a missing placeholder, a placebo with nothing to replace", () => {
  const bad: [(raw: Record<string, any>) => void, RegExp][] = [
    [(raw) => (raw.policy.travel_jit = { text: "x" }), /invalid/u],
    [(raw) => (raw.policy.travel_jit = { kinds: [] }), /invalid/u],
    [(raw) => (raw.policy.travel_jit = { kinds: ["logs"] }), /invalid/u],
    [(raw) => (raw.policy.travel_jit = { max_per_kind: 0 }), /invalid/u],
    [(raw) => (raw.policy.travel_jit = { text_packages: "no placeholder" }), /text_packages needs a \{packages\}/u],
    [(raw) => (raw.policy.travel_jit = { text_scratch: "no placeholder" }), /text_scratch needs a \{files\}/u],
    [(raw) => (raw.policy.travel_jit = { text_data: "{file} only" }), /text_data needs a \{reads\}/u],
    [(raw) => (raw.policy.travel_jit_placebo = true), /travel_jit_placebo needs/u],
  ];
  for (const [patch, message] of bad) assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message));
});

// ---------- the rules ----------

const installed = (cmd: string, output = "", exitCode: number | null = 0) => installsIn(cmd).flatMap((install: Install) => installedPackages(install, output, exitCode));

test("installs: the biped case and each manager, names from the output first (requested ones first), else from the arguments", () => {
  assert.deepEqual(installsIn("pip install casadi"), [{ manager: "pip", packages: ["casadi"] }]);
  assert.deepEqual(installed("pip install casadi 2>&1 | tail -2", "Successfully installed casadi-3.6.7 numpy-2.1.0\n"), ["casadi", "numpy"]);
  assert.deepEqual(installed("python3 -m pip install -q 'casadi>=3.7,<3.9'"), ["casadi"], "quiet: the arguments");
  assert.deepEqual(installed("uv pip install --system casadi", " + numpy==2.1.0\n + casadi==3.6.7\n"), ["casadi", "numpy"]);
  assert.deepEqual(installed("poetry add -G dev requests", "  - Installing requests (2.32.3)\n"), ["requests"]);
  assert.deepEqual(installed("sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends coinor-libipopt-dev",
    "Setting up libmumps5:amd64 (5.6) ...\nSetting up coinor-libipopt-dev:amd64 (3.14) ...\n"), ["coinor-libipopt-dev", "libmumps5"]);
  assert.deepEqual(installed("npm install --save-dev lodash@4", "added 1 package in 2s"), ["lodash"]);
  assert.deepEqual(installed("npm i -g @scope/tool@1.2.0"), ["@scope/tool"]);
  assert.deepEqual(installed("yarn add left-pad"), ["left-pad"]);
  assert.deepEqual(installed("conda install -y -c conda-forge casadi=3.6"), ["casadi"]);
  assert.deepEqual(installed("cargo install --locked ripgrep", "  Installed package `ripgrep v14.1.0` (executable `rg`)"), ["ripgrep"]);
  assert.deepEqual(installed("gem install bundler -v 2.4.0", "Successfully installed bundler-2.4.0\n1 gem installed"), ["bundler"]);
  assert.deepEqual(installed("go install golang.org/x/tools/gopls@latest"), ["gopls"]);
  assert.deepEqual(installed("bash -lc 'pip3 install pyyaml'"), ["pyyaml"], "a shell -c is followed");
  assert.deepEqual(installed("pip install numpy && python -c 'import numpy'", "Successfully installed numpy-2.1.0", 1), ["numpy"], "a later segment failed: the summary says it installed");
});

test("installs: never a lockfile restore, a project/editable/requirements/vendoring install, a failed or already-satisfied one, or a non-install subcommand", () => {
  for (const cmd of ["npm install", "npm ci", "yarn", "yarn install", "pnpm install", "pip install -e .", "pip install .", "pip install -r requirements.txt",
    "pip install --requirement=req.txt casadi", "pip install -t vendor casadi", "pip install ./dist/pkg-1.0-py3-none-any.whl", "pip install --editable ./lib",
    "cargo install --path .", "go install ./...", "conda install --file env.txt", "npm install ./local-pkg", "apt-get update", "pip download casadi",
    "pip show casadi", "pip list", "npm run build", "cargo build", "go build ./...", "echo pip install casadi", "cat > s.sh <<'EOF'\npip install casadi\nEOF"]) {
    assert.deepEqual(installsIn(cmd), [], cmd);
  }
  assert.deepEqual(installed("pip install casadii", "ERROR: No matching distribution found for casadii", 1), [], "failed");
  assert.deepEqual(installed("pip install numpy", "Requirement already satisfied: numpy in /usr/lib/python3/dist-packages (1.26.4)\n"), [], "already there");
  assert.deepEqual(installed("apt-get install -y curl", "curl is already the newest version (8.5.0).\n0 upgraded, 0 newly installed, 0 to remove"), []);
  assert.deepEqual(installed("npm install lodash", "up to date, audited 3 packages in 1s"), []);
});

test("shell writes: redirections, tee, touch, cp/mv targets and cd, never a here-doc body, an fd duplication, /dev or an unresolvable path", () => {
  const shellWrites = (command: string, cwd: string) => shellWritesOf(command, cwd).map((write) => write.path);
  assert.deepEqual(shellWritesOf("cat > solve.py <<'EOF'\nimport casadi\nprint(1 > 2)\nx = open('a') >> 3\nEOF\npython solve.py", "/app"),
    [{ path: "/app/solve.py", text: "import casadi\nprint(1 > 2)\nx = open('a') >> 3\n" }], "the here-doc is the file's text, not a command");
  assert.deepEqual(shellWrites("python run.py > out.log 2>&1; echo done >&2; ls 2>/dev/null", "/app"), ["/app/out.log"]);
  assert.deepEqual(shellWrites("cd /tmp/work && cat > test_a.py <<EOF\nx\nEOF", "/app"), ["/tmp/work/test_a.py"]);
  assert.deepEqual(shellWrites("cd sub; touch test_b.py debug.log", "/app"), ["/app/sub/test_b.py", "/app/sub/debug.log"]);
  assert.deepEqual(shellWrites("echo x | tee -a notes.txt /app/b.txt >/dev/null", "/app"), ["/app/notes.txt", "/app/b.txt"]);
  assert.deepEqual(shellWrites("cp /tmp/check.py /app/ && mv a.py b.py && cp x.py y.py tests/", "/app"),
    ["/app/check.py", "/app/b.py", "/app/b.py/a.py", "/app/tests/x.py", "/app/tests/y.py"]);
  assert.deepEqual(shellWrites("echo 'a > b' \"c >> d\"; cd $DIR && touch t.py; cd - ; touch u.py", "/app"), [], "quoted, then no known directory");
  assert.deepEqual(shellWrites("printf x > \"/app/my file.txt\"", "/app"), ["/app/my file.txt"]);
});

test("graded code: a file the task names or one beside a code file it names; not a script that writes the outputs the grader checks", () => {
  const biped = gradedCode("Implement a generator at `/app/submission/solve.py`; it must run as `python /app/submission/solve.py --config C`. Write results/walk.npz.", "/app");
  assert.deepEqual(["/app/submission/solve.py", "/app/submission/cartesian.py", "/app/results/make.py", "/app/explore.py"].map(biped), [true, true, false, false]);
  const hof = gradedCode("Analyze the CIF files in /app/data and write /app/solution/answers.json.", "/app");
  assert.deepEqual(["/app/solution/analyze.py", "/app/analyze.py"].map(hof), [false, false]);
  const vigenere = gradedCode("Build /app/cracker.py so that it decrypts the sample.", "/app");
  assert.deepEqual(["/app/cracker.py", "/app/inspect_part.py"].map(vigenere), [true, false], "the working directory itself is not a deliverable's directory");
});

test("module names: a distribution's top-level modules by name, with the common exceptions", () => {
  assert.deepEqual(["casadi", "scikit-learn", "opencv-python-headless", "PyYAML", "Pillow", "beautifulsoup4", "typing_extensions", "drake"].map(modulesOf),
    [["casadi"], ["sklearn"], ["cv2"], ["yaml"], ["PIL"], ["bs4"], ["typing_extensions"], ["pydrake"]]);
});

// ---------- in a run ----------

const workdir = () => realpathSync(mkdtempSync(join(tmpdir(), "harness-jit-")));
const put = (cwd: string, path: string, text: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};
const age = (cwd: string, paths: string[], secondsAgo: number) => {
  const at = new Date(Date.now() - secondsAgo * 1000);
  for (const path of paths) utimesSync(join(cwd, path), at, at);
};

async function fauxRun(loadout: Loadout, steps: FauxStep[], options: { cwd?: string; prompt?: string } = {}) {
  const cwd = options.cwd ?? workdir();
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(step);
  });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-jit-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({ prompt: options.prompt ?? "do the task", model: "faux/jit", effort: "high", loadout, env, tracePath, fauxSteps: scripted });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts, cwd };
  } finally {
    await env.close();
  }
}

const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const bash = (command: string, timeout?: number): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command, ...(timeout === undefined ? {} : { timeout }) } }] });
const cell = (script: string): FauxStep => ({ toolCalls: [{ name: "exec", arguments: { input: script } }] });
const textOf = (message: { content: unknown }) => typeof message.content === "string" ? message.content
  : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
/** The text of the last tool result a request saw. */
const lastResult = (context: TranscriptContext) => textOf([...context.messages].reverse().find((message) => message.role === "toolResult")!);
const jitEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy" && event.reason === "travel_jit");
const note = (text: string) => `\n[harness] ${text}`;
/** A stand-in pip: prints what pip prints, installs nothing. */
const fakePip = (output: string) => `pip() { printf '%s\\n' ${JSON.stringify(output)}; }; `;

const pkgText = (file: string, packages: string) => LEVER_TEXTS.travel_jit_packages.replace("{file}", file).replace("{packages}", packages);

const BIPED = "Implement a trajectory generator at `/submission/solve.py`; it must run as python submission/solve.py --config C.";

test("packages in a run: an install alone is silent; the note rides on the write that imports it (the biped case), once", async () => {
  const loadout = withLevers((raw) => (raw.policy.travel_jit = true));
  const run = await fauxRun(loadout, [
    bash(`${fakePip("Successfully installed zzjitdep-1.0 zzjitpkg-3.6.7")}pip install zzjitpkg`),
    write("submission/solve.py", "import numpy as np\nimport zzjitpkg as ca\n"),
    bash(`${fakePip("Successfully installed zzjitother-0.1")}pip install zzjitother`),
    write("submission/more.py", "from zzjitother import x\nimport zzjitpkg\n"),
    { text: "Done." },
  ], { prompt: BIPED });
  assert.ok(!lastResult(run.contexts[1]!).includes("[harness]"), "the install itself");
  assert.ok(lastResult(run.contexts[2]!).endsWith(note(pkgText("submission/solve.py", "zzjitpkg"))), lastResult(run.contexts[2]!));
  assert.ok(!lastResult(run.contexts[4]!).includes("[harness]"), "max_per_kind 1");
  assert.deepEqual(jitEvents(run.events).map((event) => [event.action, event.kind, event.packages, event.via, event.tool, event.request, event.cause]), [
    ["check", "install", ["zzjitpkg", "zzjitdep"], undefined, "bash", 1, undefined],
    ["remind", "packages", ["zzjitpkg"], "write", "write", 2, undefined],
    ["check", "install", ["zzjitother"], undefined, "bash", 3, undefined],
    ["skip", "packages", ["zzjitother"], "write", "write", 4, "max"],
  ]);
});

test("packages in a run: an install after the import notes it on the install's result; dependencies named by the output count", async () => {
  const loadout = withLevers((raw) => (raw.policy.travel_jit = { kinds: ["packages"] }), "exec-v0");
  const add = (path: string, body: string) => `*** Begin Patch\n*** Add File: ${path}\n${body.split("\n").map((line) => `+${line}`).join("\n")}\n*** End Patch\n`;
  const run = await fauxRun(loadout, [
    cell(`await tools.apply_patch(${JSON.stringify(add("solve.py", "import yaml\nimport zzjitdep"))}); text("ok");`),
    cell(`await tools.exec_command({ cmd: ${JSON.stringify(`${fakePip("Successfully installed zzjitdep-1.0 zzjitpkg-3.6.7")}pip install zzjitpkg`)} }); text("ok");`),
    { text: "Done." },
  ], { prompt: "Write solve.py; the grader runs it." });
  assert.ok(!lastResult(run.contexts[1]!).includes("[harness]"));
  assert.ok(lastResult(run.contexts[2]!).endsWith(note(pkgText("solve.py", "zzjitdep"))), lastResult(run.contexts[2]!));
  assert.deepEqual(jitEvents(run.events).filter((event) => event.action === "remind").map((event) => [event.file, event.via, event.tool, event.request]), [["solve.py", "install", "exec", 2]]);
});

test("packages in a run: never an import the file already had, one in an output script the grader does not run, /tmp or a test, an already-satisfied, failed or task-named install, or a bare restore", async () => {
  const cwd = workdir();
  put(cwd, "upstream.py", "import zzjitpkg\nx = 1\n");
  const loadout = withLevers((raw) => (raw.policy.travel_jit = { kinds: ["packages"] }), "exec-v0");
  const update = "*** Begin Patch\n*** Update File: upstream.py\n@@\n import zzjitpkg\n-x = 1\n+x = 2\n*** End Patch\n";
  const sh = (cmd: string) => cell(`await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }); text("ok");`);
  const run = await fauxRun(loadout, [
    sh(`${fakePip("Successfully installed zzjitpkg-3.6.7")}pip install zzjitpkg`),
    cell(`await tools.apply_patch(${JSON.stringify(update)}); text("ok");`),
    sh("mkdir -p /tmp/jit-work && cat > /tmp/jit-work/probe.py <<'EOF'\nimport zzjitpkg\nEOF"),
    sh("mkdir -p tests && cat > tests/test_solve.py <<'EOF'\nimport zzjitpkg\nEOF"),
    sh("cat > check_it.py <<'EOF'\nimport zzjitpkg\nEOF"),
    sh(`${fakePip("Requirement already satisfied: zzjitold in /x")}pip install zzjitold`),
    sh(`${fakePip("ERROR: No matching distribution")}pip install zzjitbad; exit 1`),
    sh("npm() { :; }; npm ci && npm install"),
    sh(`${fakePip("Successfully installed zzjitnamed-1.0 zzjitdep2-2.0")}pip install zzjitnamed`),
    sh("cat > main.py <<'EOF'\nimport zzjitold, zzjitbad, zzjitnamed, zzjitdep2\nEOF"),
    sh("mkdir -p solution && cat > solution/analyze.py <<'EOF'\nimport zzjitpkg\nEOF"),
    { text: "Done." },
  ], { cwd, prompt: "Solve it with zzjitnamed in main.py (it imports upstream.py). Write the answers to solution/answers.json." });
  for (const context of run.contexts) assert.ok(!context.messages.some((message) => message.role === "toolResult" && textOf(message).includes("[harness]")));
  assert.deepEqual(jitEvents(run.events).filter((event) => event.action !== "check").map((event) => [event.action, event.cause, event.packages]), [["skip", "task_named", ["zzjitnamed"]]]);
});

const SCRATCH_TEXT = LEVER_TEXTS.travel_jit_scratch.replace("{files}", "test_wal.py");

test("scratch in a run: a test dropped among the deliverables gets the note on that write; a test under tests/, a task-named file, a start file and /tmp do not", async () => {
  const cwd = workdir();
  put(cwd, "check_old.py", "");
  const loadout = withLevers((raw) => (raw.policy.travel_jit = { kinds: ["scratch"] }));
  const run = await fauxRun(loadout, [
    write("wal.py", "x = 1\n"),
    write("tests/test_new.py", "import wal\n"),
    write("check_report.txt", "ok"),
    write("check_old.py", "print(1)"),
    bash("mkdir -p /tmp/jit-work && cat > /tmp/jit-work/test_x.py <<'EOF'\nprint(1)\nEOF"),
    write("test_wal.py", "import wal\n"),
    { text: "Done." },
  ], { cwd, prompt: "Repair wal.py. Write the report to check_report.txt." });
  for (const at of [1, 2, 3, 4, 5]) assert.ok(!lastResult(run.contexts[at]!).includes("[harness]"), `step ${at}`);
  assert.ok(lastResult(run.contexts[6]!).endsWith(note(SCRATCH_TEXT)));
  assert.deepEqual(jitEvents(run.events).map((event) => [event.action, event.kind, event.files, event.tool, event.request]), [["remind", "scratch", ["test_wal.py"], "write", 6]]);
});

test("scratch on the exec surface: an apply_patch Add File and a here-doc in a cell; a file removed in the same cell, a log and a script under tests/ are not named", async () => {
  const loadout = withLevers((raw) => (raw.policy.travel_jit = { kinds: ["scratch"], max_per_kind: 2 }), "exec-v0");
  const add = (path: string) => `*** Begin Patch\n*** Add File: ${path}\n+import wal\n*** End Patch\n`;
  const run = await fauxRun(loadout, [
    cell(`await tools.apply_patch(${JSON.stringify(add("test_wal.py"))}); text("ok");`),
    cell(`await tools.apply_patch(${JSON.stringify(add("debug_gone.py"))}); await tools.exec_command({ cmd: "rm debug_gone.py" }); text("ok");`),
    cell(`await tools.exec_command({ cmd: "python3 -c 'print(1)' > run.log; mkdir -p tests && echo x > tests/check_fixture.py" }); text("ok");`),
    cell(`await tools.exec_command({ cmd: "mkdir -p sub && cd sub && cat > debug_run.py <<'EOF'\\nprint(1)\\nEOF" }); text("ok");`),
    { text: "Done." },
  ]);
  assert.ok(lastResult(run.contexts[1]!).endsWith(note(SCRATCH_TEXT)), lastResult(run.contexts[1]!));
  assert.ok(!lastResult(run.contexts[2]!).includes("[harness]"));
  assert.ok(!lastResult(run.contexts[3]!).includes("[harness]"), "a log, a script under tests/");
  assert.ok(lastResult(run.contexts[4]!).endsWith(note(LEVER_TEXTS.travel_jit_scratch.replace("{files}", "sub/debug_run.py"))));
  assert.deepEqual(jitEvents(run.events).map((event) => [event.kind, event.files, event.tool]), [["scratch", ["test_wal.py"], "exec"], ["scratch", ["sub/debug_run.py"], "exec"]]);
});

test("data in a run: the note rides on the next tool result after the write; /usr, task-named and run-written files and a test's reads are not named; a finish first drops it", async () => {
  const cwd = workdir();
  put(cwd, "data/words.txt", "a\nb\n");
  put(cwd, "data/sample.txt", "x");
  age(cwd, ["data/words.txt", "data/sample.txt"], 120);
  const loadout = withLevers((raw) => (raw.policy.travel_jit = { kinds: ["data"] }));
  const cracker = "import os\nDATA = os.path.join(os.path.dirname(__file__), 'data')\nwords = open(os.path.join(DATA, 'words.txt')).read()\n" +
    "open('data/sample.txt'); open('/usr/share/dict/words'); open('made.json')\n";
  const run = await fauxRun(loadout, [
    bash("sleep 1.1; echo '{}' > made.json"),
    write("tests/conftest.py", "WORDS = open('data/words.txt').read()\n"),
    write("cracker.py", cracker),
    bash("sleep 0.5"),
    { text: "Done." },
  ], { cwd, prompt: "Build cracker.py. A sample is at data/sample.txt." });
  assert.ok(!lastResult(run.contexts[2]!).includes("[harness]"), "a test's reads");
  assert.ok(!lastResult(run.contexts[3]!).includes("[harness]"), "not on the write itself");
  const expected = LEVER_TEXTS.travel_jit_data.replace("{file}", "cracker.py").replace("{reads}", join(cwd, "data/words.txt"));
  assert.ok(lastResult(run.contexts[4]!).endsWith(note(expected)), lastResult(run.contexts[4]!));
  assert.deepEqual(jitEvents(run.events).map((event) => [event.action, event.kind, event.file, event.reads, event.written_tool, event.written_request, event.tool, event.request]),
    [["remind", "data", "cracker.py", [join(cwd, "data/words.txt")], "write", 3, "bash", 4]]);

  const early = await fauxRun(loadout, [write("cracker.py", cracker), bash("sleep 0.5"), { text: "Done." }], { cwd: (() => {
    const dir = workdir();
    put(dir, "data/words.txt", "a");
    age(dir, ["data/words.txt"], 120);
    return dir;
  })(), prompt: "Build cracker.py." });
  assert.equal(jitEvents(early.events).length, 1, "one fire");
  const dropped = await fauxRun(loadout, [write("cracker.py", cracker), { text: "Done." }], { cwd: (() => {
    const dir = workdir();
    put(dir, "data/words.txt", "a");
    age(dir, ["data/words.txt"], 120);
    return dir;
  })(), prompt: "Build cracker.py." });
  assert.deepEqual(jitEvents(dropped.events).map((event) => [event.action, event.cause]), [["skip", "finished_first"]], "the finish came first");
});

test("travel_jit's env commands are internal: the model's background handle is p1 with the lever on, as with it off", async () => {
  for (const on of [false, true]) {
    const loadout = withLevers((raw) => (raw.policy.travel_jit = on));
    const run = await fauxRun(loadout, [write("test_x.py", "x"), bash("sleep 0.6; echo slow", 0.05), { toolCalls: [{ name: "wait", arguments: { handle: "p1" } }] }, { text: "Done." }]);
    assert.match(lastResult(run.contexts[2]!), /\bp1\b/u, `lever ${on ? "on" : "off"}: first handle`);
    assert.match(lastResult(run.contexts[3]!), /slow/u);
  }
});

test("travel_jit placebo: the same trigger appends neutral text of the note's estimated token count", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.travel_jit = true;
    raw.policy.travel_jit_placebo = true;
  });
  const run = await fauxRun(loadout, [write("test_wal.py", "import wal\n"), { text: "Done." }]);
  const sent = lastResult(run.contexts[1]!).split("\n[harness] ")[1]!;
  assert.equal(sent, placeboFor("travel_jit_scratch", SCRATCH_TEXT));
  assert.equal(estimateTokens(sent), estimateTokens(SCRATCH_TEXT));
  assert.doesNotMatch(sent, /\b(?:test|scratch|package|environment|file|tree)\w*/iu);
  assert.equal(jitEvents(run.events)[0]?.placebo, true);
});

test("travel_jit beside travel_check: one shared start, the in-flight note, then the finish check on what is still there", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.travel_jit = true;
    raw.policy.travel_check = true;
  });
  const run = await fauxRun(loadout, [write("test_wal.py", "import wal\n"), { text: "Done." }, { text: "Done." }]);
  assert.ok(lastResult(run.contexts[1]!).endsWith(note(SCRATCH_TEXT)));
  assert.deepEqual(run.events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`), ["remind:travel_jit", "continue:travel_check"]);
});
