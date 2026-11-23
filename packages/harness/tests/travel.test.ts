/**
 * prompt.clean_env, policy.travel_check and policy.unmet_target (src/travel.ts,
 * src/levers.ts): off by default and hashed as before, the pure rules on the
 * known cases (wal-recovery's test file, interleaved-vigenere's words.txt,
 * biped's casadi, layout-config's "78.09%, below the requested 98%"), the
 * workspace reads on a LocalEnv, and each lever in a faux run. Offline; no
 * model calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import type { ExecEnv } from "../src/env/types.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness, systemPromptOf } from "../src/run.ts";
import {
  fileCandidates, formatTravel, packageFindings, parsePackages, pathLiterals, pythonImports, readTravelStart, scratchFindings, scratchKind, travelFindings, unmetSentence,
  type Dist,
} from "../src/travel.ts";

const loadoutDir = join(dirname(fileURLToPath(import.meta.url)), "..", "loadouts");
const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  raw.policy ??= {};
  patch(raw);
  return normalizeLoadout(raw);
};
const workdir = () => realpathSync(mkdtempSync(join(tmpdir(), "harness-travel-")));
const put = (cwd: string, path: string, text: string) => {
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  writeFileSync(join(cwd, path), text);
};
/** Backdate files (seconds ago), so the start marker is newer than the start state and older than the run's writes. */
const age = (cwd: string, paths: string[], secondsAgo: number) => {
  const at = new Date(Date.now() - secondsAgo * 1000);
  for (const path of paths) utimesSync(join(cwd, path), at, at);
};

// ---------- loadout ----------

test("clean_env, travel_check and unmet_target are off by default: absent or false normalizes and hashes like the built-in", () => {
  for (const name of ["exec-v0", "compact-v0-plain"]) {
    const plain = normalizeLoadout(base(name));
    const off = withLevers((raw) => {
      raw.prompt.clean_env = false;
      raw.policy.travel_check = false;
      raw.policy.unmet_target = false;
    }, name);
    assert.equal(loadoutHash(off), loadoutHash(plain), name);
    assert.equal(plain.prompt.clean_env, undefined);
    assert.equal(plain.policy.travel_check, undefined);
    assert.equal(plain.policy.unmet_target, undefined);
  }
});

test("true turns each on with its default wording (unmet: under 50% of the wall, a number required); wording enters the behavior hash", () => {
  const on = withLevers((raw) => {
    raw.prompt.clean_env = true;
    raw.policy.travel_check = true;
    raw.policy.unmet_target = true;
  });
  assert.deepEqual(on.prompt.clean_env, { text: LEVER_TEXTS.clean_env });
  assert.deepEqual(on.policy.travel_check, { text: LEVER_TEXTS.travel_check, kinds: ["data", "packages", "scratch_other", "scratch_tests"] });
  assert.deepEqual(on.policy.unmet_target, { max_used_pct: 50, require_number: true, text: LEVER_TEXTS.unmet_target });
  const reworded = withLevers((raw) => {
    raw.prompt.clean_env = { text: "Other words." };
    raw.policy.travel_check = true;
    raw.policy.unmet_target = true;
  });
  assert.notEqual(loadoutHash(reworded), loadoutHash(on));
});

test("the settings fail closed: unknown keys, empty text, a missing placeholder, a placebo with nothing to replace", () => {
  const bad: [(raw: Record<string, any>) => void, RegExp][] = [
    [(raw) => (raw.policy.travel_check = { max: 2 }), /invalid/u],
    [(raw) => (raw.policy.travel_check = { kinds: [] }), /invalid/u],
    [(raw) => (raw.policy.travel_check = { kinds: ["logs"] }), /invalid/u],
    [(raw) => (raw.policy.travel_check = { text: "" }), /invalid/u],
    [(raw) => (raw.policy.travel_check = { text: "no placeholder" }), /\{items\}/u],
    [(raw) => (raw.policy.unmet_target = { text: "no placeholder" }), /\{sentence\}/u],
    [(raw) => (raw.policy.unmet_target = { max_used_pct: 100 }), /invalid/u],
    [(raw) => (raw.prompt.clean_env = { text: "x", extra: 1 }), /invalid/u],
    [(raw) => (raw.policy.travel_check_placebo = true), /travel_check_placebo needs/u],
    [(raw) => (raw.policy.unmet_target_placebo = true), /unmet_target_placebo needs/u],
    [(raw) => (raw.prompt.clean_env_placebo = true), /clean_env_placebo needs/u],
  ];
  for (const [patch, message] of bad) assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message));
});

test("clean_env: one system prompt section after the sections and addenda, before a system env block; the placebo is neutral text of its estimated length", () => {
  const env = { cwd: "/w", os: "linux" } as ExecEnv;
  const plain = systemPromptOf(normalizeLoadout(base("exec-v0")), env);
  const on = withLevers((raw) => (raw.prompt.clean_env = true), "exec-v0");
  assert.equal(systemPromptOf(on, env), `${plain}\n\n${LEVER_TEXTS.clean_env}`);
  assert.equal(systemPromptOf(on, { cwd: "/other", os: "darwin" } as ExecEnv), systemPromptOf(on, env), "byte-stable: no env facts in it");
  const withEnv = withLevers((raw) => {
    raw.prompt.clean_env = true;
    raw.context = { env: "system" };
  }, "exec-v0");
  assert.ok(systemPromptOf(withEnv, env).endsWith(`${LEVER_TEXTS.clean_env}\n\n<env>\ncwd: /w\nos: linux\n</env>`));
  const placebo = withLevers((raw) => {
    raw.prompt.clean_env = true;
    raw.prompt.clean_env_placebo = true;
  }, "exec-v0");
  const added = systemPromptOf(placebo, env).slice(plain.length + 2);
  assert.equal(added, placeboFor("clean_env", LEVER_TEXTS.clean_env));
  assert.equal(estimateTokens(added), estimateTokens(LEVER_TEXTS.clean_env));
  for (const word of ["environment", "package", "files", "deliverable", "tmp"]) assert.ok(!added.includes(word), `placebo says "${word}"`);
});

test("the travel arms: exec-v0-clean/-cleanplac/-travel/-travelplac/-unmet/-ctu/-ctuplac turn on exactly their levers", () => {
  const load = (suffix: string) => readLoadout(join(loadoutDir, `exec-v0-${suffix}.json`)).loadout;
  assert.deepEqual(load("clean").prompt.clean_env, { text: LEVER_TEXTS.clean_env });
  assert.equal(load("cleanplac").prompt.clean_env_placebo, true);
  assert.deepEqual(load("travel").policy.travel_check, { text: LEVER_TEXTS.travel_check, kinds: ["data", "packages", "scratch_other", "scratch_tests"] });
  assert.equal(load("travelplac").policy.travel_check_placebo, true);
  assert.equal(load("unmet").policy.unmet_target?.max_used_pct, 50);
  const ctu = load("ctu");
  assert.ok(ctu.prompt.clean_env !== undefined && ctu.policy.travel_check !== undefined && ctu.policy.unmet_target !== undefined);
  assert.ok(ctu.prompt.clean_env_placebo === undefined && ctu.policy.travel_check_placebo === undefined && ctu.policy.unmet_target_placebo === undefined);
  const plac = load("ctuplac");
  assert.ok(plac.prompt.clean_env_placebo === true && plac.policy.travel_check_placebo === true && plac.policy.unmet_target_placebo === true);
});

// ---------- the rules ----------

test("scratch names: test_*, *_test.*, *.test.*, check*, debug*, scratch*, *.log, *.bak; not a checkpoint, a log under logs/, or vendored trees", () => {
  for (const path of ["test_wal.py", "a/b_test.go", "x.test.ts", "check.py", "check_output.sh", "debug_run.py", "scratch.py", "run.log", "data.bak", "test.py"]) {
    assert.ok(scratchKind(path) !== undefined, path);
  }
  for (const path of ["checkpoint.pt", "checker_lib.py", "logs/server.log", "node_modules/x/test_a.py", ".venv/lib/test_b.py", "build/out.log", "wal.py", "contest.py"]) {
    assert.equal(scratchKind(path), undefined, path);
  }
});

test("scratch findings: the wal case (a test dropped among the deliverables) is one; a test layout, a test dir with tests at the start, a named file and a start file are not", () => {
  const task = "Repair the WAL-backed storage under /app/. The verifier imports make_engine from /app/app.py. Write the report to check_report.txt.";
  assert.deepEqual(scratchFindings(["test_wal.py", "wal.py"], new Set(), task), ["test_wal.py"]);
  assert.deepEqual(scratchFindings(["tests/test_new.py", "pkg/tests/unit/test_x.py", "check_report.txt"], new Set(), task), [], "test suites and task-named files");
  assert.deepEqual(scratchFindings(["svc/new_test.go", "lib/new_test.go"], new Set(["svc/old_test.go"]), task), ["lib/new_test.go"], "Go: tests next to tests that were there");
  assert.deepEqual(scratchFindings(["run.log", "debug.py"], new Set(["run.log"]), task), ["debug.py"], "present at the start");
});

test("path literals: files and dirs by literal, never module specifiers, includes, MIME types, URLs or globs", () => {
  const js = "import x from './errors';\nconst y = require('../lib/helpers');\nfetch('https://a.b/c.json');\nconst t = 'application/json';\nconst f = fs.readFileSync('data/input.csv');\nglob('*.txt');";
  assert.deepEqual(pathLiterals(js), ["data/input.csv"]);
  assert.deepEqual(pathLiterals("#include \"mvcc_lsm/types.h\"\nFILE *f = fopen(\"/app/table.bin\", \"rb\");"), ["/app/table.bin"]);
  assert.deepEqual(pathLiterals("import os.path\nopen('os.path')\nopen('weights.npz')"), ["weights.npz"]);
});

test("the vigenere case: os.path.join(DATA_DIR, 'words.txt') with DATA_DIR from 'data' names /app/data/words.txt; system trees are dropped", () => {
  const cracker = "DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')\nwith open(os.path.join(DATA_DIR, 'words.txt'), encoding='utf-8') as f:\n    pass\n" +
    "open('/usr/share/dict/words')\nopen('/tmp/x.txt')\nopen('/app/data/sample_ciphertext.txt')";
  const candidates = fileCandidates(cracker, "/app/cracker.py", "/app");
  assert.ok(candidates.includes("/app/data/words.txt"), JSON.stringify(candidates));
  assert.ok(candidates.includes("/app/data/sample_ciphertext.txt"));
  assert.ok(!candidates.some((path) => path.startsWith("/usr/") || path.startsWith("/tmp/")));
});

test("python imports: top-level modules of import, from-import and importlib by literal; relative imports are not packages", () => {
  const text = "import numpy as np, os.path\nfrom casadi import MX\nfrom . import local\nfrom .x import y\n# import commented\nm = importlib.import_module('yaml')\n";
  assert.deepEqual([...pythonImports(text)].sort(), ["casadi", "numpy", "os", "yaml"]);
});

test("package findings: the biped case (casadi installed during the run, imported by the submission) is one; a local or task-named package, an unused one or no start snapshot is not", () => {
  const dist = (name: string, modules: string[], local = false): [string, Dist] => [name.toLowerCase(), { name, local, modules }];
  const start = new Map([dist("numpy", ["numpy"])]);
  const now = new Map([dist("numpy", ["numpy"]), dist("casadi", ["casadi"]), dist("myproj", ["myproj"], true), dist("PyYAML", ["yaml"]), dist("requests", ["requests"])]);
  const files = [
    { path: "submission/solve.py", text: "import numpy\nimport casadi as ca\nimport myproj\n" },
    { path: "submission/io.py", text: "import yaml\n" },
  ];
  assert.deepEqual(packageFindings(start, now, files, "Write submission/solve.py."), [
    { name: "casadi", modules: ["casadi"], files: ["submission/solve.py"] },
    { name: "PyYAML", modules: ["yaml"], files: ["submission/io.py"] },
  ]);
  assert.deepEqual(packageFindings(start, now, files, "Use casadi and PyYAML for this."), [], "the task asked for them");
  assert.deepEqual(packageFindings(new Map(), now, files, ""), [], "no start snapshot: nothing is known to be new");
  assert.deepEqual([...parsePackages("casadi\t0\tcasadi\nmyproj\t1\tmyproj\nPyYAML\t0\t_yaml,yaml\n\n").values()], [
    { name: "casadi", local: false, modules: ["casadi"] }, { name: "myproj", local: true, modules: ["myproj"] }, { name: "PyYAML", local: false, modules: ["_yaml", "yaml"] },
  ]);
});

test("the reminder names each finding kind on its own line", () => {
  const text = formatTravel({
    packages: [{ name: "casadi", modules: ["casadi"], files: ["submission/solve.py"] }], data: [{ file: "cracker.py", reads: ["/app/data/words.txt"] }],
    scratch: ["test_wal.py"], pycache: ["__pycache__"],
  });
  assert.equal(text, "- submission/solve.py imports casadi (package casadi, installed during this session)\n- cracker.py reads /app/data/words.txt, which you did not write\n" +
    "- scratch or test files you created in the project tree: test_wal.py\n- __pycache__ directories you created: __pycache__");
});

test("unmet sentences: a number the task set next to an unmet phrase; not a met limit, a negation, a pre-existing failure or a number the task lacks", () => {
  const layout = "Recreate the layout. Strict pixel equality must be at least 98% of pixels.";
  const final = "Created `/app/output/config.json` with editable text and 21 SVG assets.\n\nVisual similarity is 99.62% SSIM, but strict pixel equality is 78.09%, below the requested 98%.";
  assert.equal(unmetSentence(final, layout), "Visual similarity is 99.62% SSIM, but strict pixel equality is 78.09%, below the requested 98%.");
  assert.equal(unmetSentence("Accuracy reached 0.91, short of the 0.95 target.", "Reach an accuracy of at least 0.95."), "Accuracy reached 0.91, short of the 0.95 target.");
  assert.equal(unmetSentence("Peak memory: approximately **45 MB**, below the 64 MB limit.", "Peak memory must stay under 64 MB."), undefined, "a met limit");
  assert.equal(unmetSentence("Latency is 40 ms, below the required 50 ms.", "Keep latency under 50 ms."), undefined, "lower is better");
  assert.equal(unmetSentence("No window falls short of the 98% target.", "Hit 98% on every window."), undefined, "negated");
  assert.equal(unmetSentence("Some pre-existing tests still fail.", "Fix the 3 failing parser tests."), undefined, "not an unmet phrase");
  assert.equal(unmetSentence("Coverage is 70%, below the requested 80%.", "Write good tests."), undefined, "the task set no such number");
  const bitwise = "Logits match within tolerance. **Bitwise identity was not achieved on this CPU backend.**";
  assert.equal(unmetSentence(bitwise, "Logits must be bitwise identical to the 4-shard original."), undefined, "no number: off by default");
  assert.equal(unmetSentence(bitwise, "Logits must be bitwise identical.", { number: false }), "Bitwise identity was not achieved on this CPU backend.");
});

// ---------- the workspace ----------

test("a LocalEnv workspace: scratch the run created, a pre-existing data file a deliverable reads, and nothing for start files, tmp files or files it wrote", async () => {
  const cwd = workdir();
  put(cwd, "data/words.txt", "a\nb\n");
  put(cwd, "data/sample.txt", "x");
  put(cwd, "tests/test_old.py", "");
  put(cwd, "old.log", "");
  age(cwd, ["data/words.txt", "data/sample.txt", "tests/test_old.py", "old.log"], 120);
  const env = new LocalEnv({ cwd });
  try {
    const start = await readTravelStart(env);
    assert.ok(start !== null);
    assert.ok(start.scratch.has("tests") && start.scratch.has("tests/test_old.py") && start.scratch.has("old.log"), JSON.stringify([...start.scratch]));
    utimesSync(start.marker, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    put(cwd, "cracker.py", "import os\nDATA = os.path.join(os.path.dirname(__file__), 'data')\nopen(os.path.join(DATA, 'words.txt'))\nopen('data/sample.txt')\nopen('out.json', 'w')\n");
    put(cwd, "out.json", "{}");
    put(cwd, "test_cracker.py", "import cracker\n");
    put(cwd, "tests/test_new.py", "");
    put(cwd, "run.log", "");
    put(cwd, "__pycache__/cracker.cpython-313.pyc", "");
    const findings = await travelFindings(env, start, "Build /app/cracker.py. A sample is at data/sample.txt.");
    assert.deepEqual(findings.scratch, ["run.log", "test_cracker.py"]);
    assert.deepEqual(findings.data, [{ file: "cracker.py", reads: [join(cwd, "data/words.txt")] }]);
    assert.deepEqual(findings.pycache, ["__pycache__"]);
    assert.deepEqual(findings.packages, []);
  } finally {
    await env.close();
  }
});

test("a LocalEnv workspace: a package the start snapshot lacked, imported by a file the run wrote, is a finding (start snapshot edited to lack it)", async (t) => {
  const cwd = workdir();
  const env = new LocalEnv({ cwd });
  try {
    const start = await readTravelStart(env);
    assert.ok(start !== null);
    const pip = start.packages.get("pip");
    if (pip === undefined || !pip.modules.includes("pip")) {
      t.skip("no python3 with pip here");
      return;
    }
    start.packages.delete("pip");
    utimesSync(start.marker, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    put(cwd, "solve.py", "import pip\n");
    const findings = await travelFindings(env, start, "Write solve.py.");
    assert.deepEqual(findings.packages, [{ name: pip.name, modules: ["pip"], files: ["solve.py"] }]);
  } finally {
    await env.close();
  }
});

// ---------- in a run ----------

async function fauxRun(loadout: Loadout, steps: FauxStep[], options: { budgets?: Budgets; cwd?: string; prompt?: string } = {}) {
  const cwd = options.cwd ?? workdir();
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(step);
  });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-travel-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({
      prompt: options.prompt ?? "do the task", model: "faux/travel", effort: "high", loadout, env, tracePath, fauxSteps: scripted,
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts, cwd };
  } finally {
    await env.close();
  }
}

const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const bash = (command: string, timeout?: number): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command, ...(timeout === undefined ? {} : { timeout }) } }] });
const textOf = (message: { content: unknown } | undefined) =>
  message === undefined ? "" : typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastUser = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "user");
const policyEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`);
const toolText = (context: TranscriptContext) => context.messages.filter((message) => message.role === "toolResult").map(textOf).join("\n");

const TRAVEL_TEXT = LEVER_TEXTS.travel_check.replace("{items}", "- scratch or test files you created in the project tree: test_wal.py");

test("travel_check in a run: one reminder at the finish attempt naming the files; the second finish ends the run; a clean workspace gets none", async () => {
  const loadout = withLevers((raw) => (raw.policy.travel_check = true));
  const run = await fauxRun(loadout, [write("wal.py", "x = 1\n"), write("test_wal.py", "import wal\n"), { text: "Done." }, { text: "Removed it." }, { text: "never sent" }]);
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.usage.requests, 4);
  assert.equal(textOf(lastUser(run.contexts[3]!)), TRAVEL_TEXT);
  assert.deepEqual(policyEvents(run.events), ["continue:travel_check"]);
  const fired = run.events.find((event) => event.action === "continue");
  assert.deepEqual({ scratch: fired?.scratch, placebo: fired?.placebo, findings: fired?.findings }, { scratch: ["test_wal.py"], placebo: false, findings: 1 });
  const clean = await fauxRun(loadout, [write("wal.py", "x = 1\n"), { text: "Done." }, { text: "never sent" }]);
  assert.equal(clean.result.usage.requests, 2);
  assert.deepEqual(policyEvents(clean.events), ["check:travel_check"]);
  const testsOnly = withLevers((raw) => (raw.policy.travel_check = { kinds: ["packages", "data", "scratch_tests"] }));
  const logOnly = await fauxRun(testsOnly, [write("run.log", "x"), { text: "Done." }, { text: "never sent" }]);
  assert.equal(logOnly.result.usage.requests, 2, "a log does not trigger when scratch_other is not a kind");
  assert.deepEqual(policyEvents(logOnly.events), ["check:travel_check"]);
  const both = await fauxRun(testsOnly, [write("run.log", "x"), write("test_wal.py", "import wal\n"), { text: "Done." }, { text: "Done." }]);
  assert.equal(textOf(lastUser(both.contexts[3]!)), TRAVEL_TEXT, "and is not named next to a test file that does");
});

test("travel_check's env commands are internal: the model's background handle is p1 with the lever on, as with it off", async () => {
  for (const on of [false, true]) {
    const loadout = withLevers((raw) => (raw.policy.travel_check = on));
    const run = await fauxRun(loadout, [bash("sleep 0.6; echo slow", 0.05), { toolCalls: [{ name: "wait", arguments: { handle: "p1" } }] }, { text: "Done." }, { text: "never sent" }]);
    assert.match(toolText(run.contexts[1]!), /\bp1\b/u, `lever ${on ? "on" : "off"}: first handle`);
    assert.match(toolText(run.contexts[2]!), /slow/u);
  }
});

test("travel_check placebo: the same trigger sends neutral text of the reminder's estimated token count", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.travel_check = true;
    raw.policy.travel_check_placebo = true;
  });
  const run = await fauxRun(loadout, [write("test_wal.py", "import wal\n"), { text: "Done." }, { text: "Done." }]);
  const sent = textOf(lastUser(run.contexts[2]!));
  assert.equal(sent, placeboFor("travel_check", TRAVEL_TEXT));
  assert.equal(estimateTokens(sent), estimateTokens(TRAVEL_TEXT));
  assert.doesNotMatch(sent, /\b(?:test|scratch|package|environment|file)\w*/iu);
  assert.equal(run.events.find((event) => event.action === "continue")?.placebo, true);
});

const LAYOUT_TASK = "Recreate the layout as /app/output/config.json. Strict pixel equality must be at least 98%.";
const LAYOUT_FINAL = "Created the config.\n\nStrict pixel equality is 78.09%, below the requested 98%.";

test("unmet_target in a run: the final's own sentence and the time left, once; never without a wall budget", async () => {
  const loadout = withLevers((raw) => (raw.policy.unmet_target = true));
  const run = await fauxRun(loadout, [{ text: LAYOUT_FINAL }, { text: LAYOUT_FINAL }, { text: "never sent" }], { prompt: LAYOUT_TASK, budgets: { wall_s: 3600 } });
  assert.equal(run.result.usage.requests, 2);
  const sent = textOf(lastUser(run.contexts[1]!));
  assert.equal(sent, LEVER_TEXTS.unmet_target.replace("{sentence}", "Strict pixel equality is 78.09%, below the requested 98%.").replace("{remaining}", "60 min"));
  assert.deepEqual(policyEvents(run.events), ["continue:unmet_target"]);
  const noWall = await fauxRun(loadout, [{ text: LAYOUT_FINAL }, { text: "never sent" }], { prompt: LAYOUT_TASK });
  assert.equal(noWall.result.usage.requests, 1);
  const met = await fauxRun(loadout, [{ text: "Strict pixel equality is 99.1%, above the requested 98%." }, { text: "never sent" }], { prompt: LAYOUT_TASK, budgets: { wall_s: 3600 } });
  assert.equal(met.result.usage.requests, 1);
});

test("unmet_target past max_used_pct of the wall: no continuation, the skip recorded once; the placebo keeps the trigger", async () => {
  const late = withLevers((raw) => (raw.policy.unmet_target = { max_used_pct: 1 }));
  const run = await fauxRun(late, [bash("sleep 0.3"), { text: LAYOUT_FINAL }, { text: "never sent" }], { prompt: LAYOUT_TASK, budgets: { wall_s: 10 } });
  assert.equal(run.result.usage.requests, 2);
  assert.deepEqual(policyEvents(run.events), ["skip:unmet_target"]);
  const placebo = withLevers((raw) => {
    raw.policy.unmet_target = true;
    raw.policy.unmet_target_placebo = true;
  });
  const plac = await fauxRun(placebo, [{ text: LAYOUT_FINAL }, { text: "Done." }], { prompt: LAYOUT_TASK, budgets: { wall_s: 3600 } });
  const real = LEVER_TEXTS.unmet_target.replace("{sentence}", "Strict pixel equality is 78.09%, below the requested 98%.").replace("{remaining}", "60 min");
  assert.equal(textOf(lastUser(plac.contexts[1]!)), placeboFor("unmet_target", real));
});

test("order: test_isolation and evidence_bounce, then unmet_target, then travel_check, one continuation per finish attempt; near a hard budget neither new check fires", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.evidence_bounce = true;
    raw.policy.unmet_target = true;
    raw.policy.travel_check = true;
  });
  const run = await fauxRun(loadout, [write("test_wal.py", "import wal\n"), { text: LAYOUT_FINAL }, { text: LAYOUT_FINAL }, { text: "All tests pass." }, { text: "All tests pass." }, { text: "never sent" }],
    { prompt: LAYOUT_TASK, budgets: { wall_s: 3600 } });
  assert.deepEqual(policyEvents(run.events), ["continue:evidence_bounce", "continue:unmet_target", "continue:travel_check"]);
  assert.equal(run.result.usage.requests, 5);
  const near = await fauxRun(withLevers((raw) => {
    raw.policy.unmet_target = true;
    raw.policy.travel_check = true;
  }), [write("test_wal.py", "x"), ...Array.from({ length: 7 }, (_, i) => bash(`echo ${i}`)), { text: LAYOUT_FINAL }, { text: "never sent" }], { prompt: LAYOUT_TASK, budgets: { requests: 10, wall_s: 3600 } });
  assert.equal(near.result.usage.requests, 9, "9 of 10 requests used: no continuation");
  assert.deepEqual(policyEvents(near.events), ["skip:unmet_target", "skip:travel_check"]);
});
