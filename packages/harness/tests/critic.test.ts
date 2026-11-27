/**
 * policy.critic, offline (pure rules, real shells for the guard and the change summary, the faux model on a LocalEnv for whole
 * runs, and the loopback Responses server for what the provider receives; no network, no real model):
 * - the loadout: off by default (built-ins hash as before), the defaults, fail-closed settings, the arms;
 * - the rules: the verdict and its findings, the findings as sent, the first message, the change summary;
 * - the guard on a real shell: every kind of change a review makes in the cwd is undone and verified, a large cwd is skipped;
 * - in a run: the fresh context (task, changes, final message; nothing else of the implementer's), the read-only tools (no
 *   file-editing tool; whatever its commands change is restored), FAIL -> one continuation with the findings, PASS / no verdict /
 *   provider error / timeout / max_turns -> the run ends, the placebo, cost in the run's totals, the snapshot registration,
 *   max_rounds, the order after the validator, the 90% guard;
 * - over the wire: the review's requests go to the run's base URL at its effort, with its own tools and cache key;
 * - an end-to-end dry run on a tiny fake task (the critic runs the deliverable, finds the bug, the fix ends the run).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { FauxResponseStep, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import {
  criticLoadout, criticRequest, factsOf, formatFindings, guardAfterScript, guardBeforeScript, parseGuardAfter, parseSummary, parseVerdict, renderChanges,
  reviewEnv, startScript, summaryScript,
} from "../src/critic.ts";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { CRITIC_PROMPT, estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness, type RunOptions } from "../src/run.ts";
import { eventsOf, type Body, type Step } from "./openai-loopback.ts";

const loadoutDir = join(import.meta.dirname, "..", "loadouts");
const base = (name = "exec-v0") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  patch(raw);
  return normalizeLoadout(raw);
};
const criticOn = (settings: boolean | Record<string, unknown> = true, placebo = false, name?: string) => withLevers((raw) => {
  raw.policy.critic = settings;
  if (placebo) raw.policy.critic_placebo = true;
}, name);

const sh = (cwd: string, script: string) => execFileSync("/bin/sh", ["-c", script], { cwd, encoding: "utf8" });
const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

// ---------- loadout ----------

describe("critic", { concurrency: 4 }, () => {
test("critic is off by default: absent or false normalizes and hashes like the built-ins", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(plain.policy.critic, undefined);
    assert.equal(plain.policy.critic_placebo, undefined);
    const off = withLevers((raw) => {
      raw.policy = { ...raw.policy, critic: false, critic_placebo: false };
    }, name);
    assert.equal(loadoutHash(off), loadoutHash(plain), `${name}: false is off`);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain));
  }
});

test("true turns it on with the defaults; each setting enters the behavior hash", () => {
  const on = criticOn();
  assert.deepEqual(on.policy.critic, {
    effort: "high", max_rounds: 1, max_turns: 12, wall_s: 300, max_findings: 5, diff_bytes: 16000, guard_max_mb: 1024, prompt: CRITIC_PROMPT, text: LEVER_TEXTS.critic,
  });
  for (const change of [{ effort: "medium" }, { max_rounds: 2 }, { max_turns: 6 }, { wall_s: 120 }, { max_findings: 3 }, { diff_bytes: 0 }, { guard_max_mb: 50 },
    { prompt: "Review." }, { text: "Found:\n{findings}" }]) {
    assert.notEqual(loadoutHash(criticOn(change)), loadoutHash(on), JSON.stringify(change));
  }
  assert.notEqual(loadoutHash(criticOn(true, true)), loadoutHash(on), "the placebo is its own arm");
});

test("the settings fail closed: unknown keys, a text without {findings}, bad numbers, a placebo with nothing to replace", () => {
  assert.throws(() => criticOn({ rounds: 2 }), LoadoutError);
  assert.throws(() => criticOn({ text: "Fix it." }), /\{findings\}/u);
  assert.throws(() => criticOn({ max_rounds: 0 }), LoadoutError);
  assert.throws(() => criticOn({ max_turns: 0 }), LoadoutError);
  assert.throws(() => criticOn({ wall_s: 0 }), LoadoutError);
  assert.throws(() => criticOn({ effort: "off" }), LoadoutError);
  assert.throws(() => withLevers((raw) => (raw.policy.critic_placebo = true)), /critic_placebo needs policy.critic/u);
});

test("the arms: exec-v0-critic turns on exactly the critic; exec-v0-criticplac adds its placebo", () => {
  const critic = readLoadout(join(loadoutDir, "exec-v0-critic.json")).loadout;
  const plac = readLoadout(join(loadoutDir, "exec-v0-criticplac.json")).loadout;
  assert.deepEqual(critic.policy.critic, criticOn().policy.critic);
  assert.equal(critic.policy.critic_placebo, undefined);
  assert.equal(plac.policy.critic_placebo, true);
  const { critic: _critic, ...policy } = critic.policy;
  assert.deepEqual({ ...critic, name: "", policy }, { ...readLoadout("exec-v0").loadout, name: "" });
});

// ---------- rules ----------

test("parseVerdict: the last VERDICT line wins; a FAIL's numbered findings with requirement, fails and evidence; bold and bullets tolerated", () => {
  assert.deepEqual(parseVerdict("Checked everything.\nVERDICT: PASS"), { verdict: "PASS", findings: [] });
  assert.deepEqual(parseVerdict("The format is `VERDICT: FAIL` or PASS.\n\n**VERDICT:** PASS\n"), { verdict: "PASS", findings: [] }, "the last one counts, bold allowed");
  assert.deepEqual(parseVerdict("I think it works."), { findings: [] }, "no verdict line");
  const text = [
    "I ran the checks.", "", "VERDICT: FAIL",
    "1. Requirement: \"add must accept integers given as strings\"",
    "   Fails: add('2', '3') returns '23'.",
    "   Evidence: python3 -c \"import add; print(add.add('2','3'))\" -> 23",
    "2. **Requirement**: \"write the result to /app/out.txt\"",
    "   **Fails**: the file is missing",
    "   **Evidence**: ls /app/out.txt ->",
    "   ls: cannot access '/app/out.txt': No such file or directory",
    "- Requirement: a requirement without any failure or evidence",
  ].join("\n");
  const parsed = parseVerdict(text);
  assert.equal(parsed.verdict, "FAIL");
  assert.deepEqual(parsed.findings.map(({ raw: _raw, ...finding }) => finding), [
    { requirement: "\"add must accept integers given as strings\"", fails: "add('2', '3') returns '23'.", evidence: "python3 -c \"import add; print(add.add('2','3'))\" -> 23" },
    { requirement: "\"write the result to /app/out.txt\"", fails: "the file is missing", evidence: "ls /app/out.txt ->\nls: cannot access '/app/out.txt': No such file or directory" },
  ], "a finding with neither failure nor evidence is dropped");
  const loose = parseVerdict("VERDICT: FAIL\nThe output file is never written; ls shows nothing.");
  assert.deepEqual(loose.findings, [{ raw: "The output file is never written; ls shows nothing." }], "a FAIL in no known form is one raw finding");
  assert.deepEqual(parseVerdict("VERDICT: FAIL\n").findings, [], "a bare FAIL has no findings (no bounce)");
});

test("formatFindings: numbered Requirement / Fails / Evidence, multi-line evidence indented, capped with a count", () => {
  const findings = parseVerdict([
    "VERDICT: FAIL",
    "1. Requirement: \"a\"\n   Fails: x\n   Evidence: cmd ->\n   line1\n   line2",
    "2. Requirement: \"b\"\n   Evidence: cmd2 -> out2",
    "3. Requirement: \"c\"\n   Fails: z",
  ].join("\n")).findings;
  assert.equal(formatFindings(findings, 2), [
    "1. Requirement: \"a\"", "   Fails: x", "   Evidence: cmd ->", "   line1", "   line2",
    "2. Requirement: \"b\"", "   Evidence: cmd2 -> out2",
    "(1 more findings not listed)",
  ].join("\n"));
  assert.equal(formatFindings([{ raw: "free text\nsecond line" }], 5), "1. free text\n   second line");
});

test("the first message: the task first, then the env and the critic's scratch, the changes, the final message (capped)", () => {
  const text = criticRequest("  Make add.py sum two numbers.\n", { cwd: "/app", os: "linux", scratch: "/tmp/s/work", changes: "CHANGES", final: "Done: add.py works." });
  assert.equal(text, [
    "<task>\nMake add.py sum two numbers.\n</task>",
    "<env>\ncwd: /app\nos: linux\nyour scratch directory (outside the project): /tmp/s/work\n</env>",
    "<changes>\nCHANGES\n</changes>",
    "<engineer_final_message>\nDone: add.py works.\n</engineer_final_message>",
    "Review the work against the task now.",
  ].join("\n\n"));
  const long = criticRequest("t", { cwd: "/w", scratch: "/s", changes: "c", final: "x".repeat(10_000) });
  assert.ok(long.length < 7_000 && long.includes("x...\n</engineer_final_message>"), "the final message is cut at 6000 characters");
  assert.match(criticRequest("t", { cwd: "/w", scratch: "/s", changes: "c", final: "  " }), /<engineer_final_message>\n\(empty\)\n/u);
});

test("renderChanges: the table with sizes, counts of what was not listed, the git diff (cut), no change, no start state", () => {
  const summary = parseSummary([
    "critic_n_created=3", "critic_n_modified=1", "critic_n_deleted=1", "@@critic-list@@",
    "created 1234 ./src/new.py", "created 7 ./name with space.txt", "modified 99 ./README.md", "deleted - ./old.txt",
    "@@critic-diff@@", "diff --git a/README.md b/README.md\n-old\n+new\n" + "z".repeat(50),
  ].join("\n"), 50);
  assert.deepEqual(summary?.entries, [
    { kind: "created", bytes: 1234, path: "src/new.py" }, { kind: "created", bytes: 7, path: "name with space.txt" },
    { kind: "modified", bytes: 99, path: "README.md" }, { kind: "deleted", path: "old.txt" },
  ]);
  assert.equal(summary?.diffCut, true);
  assert.equal(renderChanges(summary, "/app", 50), [
    "Files created, modified or deleted under /app since the start (sizes in bytes; .git, node_modules, virtualenvs and caches not listed):",
    "created  1234  src/new.py", "created     7  name with space.txt", "modified   99  README.md", "deleted     -  old.txt",
    "[1 more created files not listed]", "",
    "git diff of the modified and deleted files against the starting commit:", "diff --git a/README.md b/README.md\n-old\n+new\nzzzzz", "[diff cut at 50 bytes]",
  ].join("\n"));
  const none = parseSummary("critic_n_created=0\ncritic_n_modified=0\ncritic_n_deleted=0\n@@critic-list@@\n", 100);
  assert.equal(renderChanges(none, "/app", 100), "No file under /app was created, modified or deleted since the start (.git, node_modules, virtualenvs and caches not listed).");
  assert.equal(parseSummary("critic_error=no_start\n", 100), undefined);
  assert.match(renderChanges(undefined, "/app", 100), /could not record the starting state of \/app/u);
});

// ---------- real shells ----------

/** A small project: nested files, an executable, a symlink, a name with a space, a directory tree. */
function project(cwd: string): void {
  mkdirSync(join(cwd, "src/deep"), { recursive: true });
  mkdirSync(join(cwd, "olddir/sub"), { recursive: true });
  writeFileSync(join(cwd, "src/a.py"), "print(1)\n");
  writeFileSync(join(cwd, "src/deep/b.txt"), "b\n");
  writeFileSync(join(cwd, "run.sh"), "echo hi\n");
  chmodSync(join(cwd, "run.sh"), 0o755);
  writeFileSync(join(cwd, "keep.txt"), "keep\n");
  writeFileSync(join(cwd, "name with space.txt"), "space\n");
  writeFileSync(join(cwd, "olddir/sub/f.txt"), "f\n");
  symlinkSync("src/a.py", join(cwd, "link"));
}

/** Paths, file contents (cksum), executable bits and link targets: what must survive a review unchanged. */
const state = (cwd: string) => sh(cwd, "find . -print | LC_ALL=C sort; find . -type f -exec cksum {} + | LC_ALL=C sort; find . -type f -perm -100 | LC_ALL=C sort; readlink link");

test("the guard on a real shell: whatever a review does in the cwd is undone and verified (residual 0); an unchanged cwd needs nothing", () => {
  const cwd = tmp("harness-critic-guard-");
  const dir = join(tmp("harness-critic-scratch-"), "round-1");
  project(cwd);
  const pristine = state(cwd);
  const before = factsOf(sh(cwd, guardBeforeScript(dir, 1024 * 1024)), "cg_");
  assert.equal(before.tar_exit, "0");
  assert.ok(Number(before.entries) >= 12);
  assert.ok(existsSync(join(dir, "work")) && existsSync(join(dir, "tmp")), "the critic's work and temp dirs");
  sh(cwd, [
    "echo junk > src/a.py", "rm src/deep/b.txt", "echo new > new.txt", "mkdir -p newdir/x && echo y > newdir/x/y", "chmod -x run.sh", "rm -rf olddir",
    "rm link && ln -s keep.txt link", "echo changed > 'name with space.txt'", "mkdir __pycache__ && touch __pycache__/c.pyc", "touch -t 200001010000 keep.txt",
  ].join("; "));
  const after = parseGuardAfter(sh(cwd, guardAfterScript(dir)));
  assert.deepEqual({ created: after.created, residual: after.residual, error: after.error, extract: after.extractExit }, { created: 6, residual: 0, error: undefined, extract: 0 });
  assert.ok(after.restored >= 8, `restored ${after.restored}`);
  assert.ok(after.paths.includes("+ ./new.txt") && after.paths.includes("~ ./src/a.py") && after.paths.includes("~ ./keep.txt"), "a backdated mtime is caught by ctime");
  assert.equal(state(cwd), pristine, "paths, contents, modes and link targets are as before");
  assert.ok(!existsSync(dir), "the guard dir (backup, manifests, work and temp dirs) is removed");
  factsOf(sh(cwd, guardBeforeScript(dir, 1024 * 1024)), "cg_");
  assert.deepEqual(parseGuardAfter(sh(cwd, guardAfterScript(dir))), { created: 0, restored: 0, residual: 0, paths: [] });
  assert.deepEqual(factsOf(sh(cwd, guardBeforeScript(dir, 0)), "cg_").skip, "too_large");
  assert.equal(parseGuardAfter(sh(cwd, guardAfterScript(join(dir, "missing")))).error, "no_backup");
});

test("the guard leaves the env's scratch dir out when it sits inside the cwd", () => {
  const cwd = tmp("harness-critic-inside-");
  writeFileSync(join(cwd, "a.txt"), "a\n");
  const dir = join(cwd, ".scratch", "round-1");
  sh(cwd, guardBeforeScript(dir, 1024 * 1024, "./.scratch"));
  writeFileSync(join(cwd, ".scratch", "spill.log"), "spill\n");
  writeFileSync(join(cwd, "a.txt"), "changed\n");
  const after = parseGuardAfter(sh(cwd, guardAfterScript(dir, "./.scratch")));
  assert.deepEqual({ created: after.created, restored: after.restored, residual: after.residual }, { created: 0, restored: 1, residual: 0 });
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "a\n");
  assert.ok(existsSync(join(cwd, ".scratch", "spill.log")), "the scratch dir is not the project's");
});

test("the change summary on a real shell: created, modified and deleted files with sizes; in a git repo, the diff against the start commit", async () => {
  const cwd = tmp("harness-critic-summary-");
  const dir = join(tmp("harness-critic-scratch-"), "crit");
  writeFileSync(join(cwd, "keep.txt"), "keep\n");
  writeFileSync(join(cwd, "edit.txt"), "one\n");
  writeFileSync(join(cwd, "gone.txt"), "gone\n");
  mkdirSync(join(cwd, "node_modules/pkg"), { recursive: true });
  const start = factsOf(sh(cwd, startScript(dir)), "critic_");
  assert.deepEqual(start, { files: "3" }, "no git, three files (node_modules pruned)");
  await new Promise((done) => setTimeout(done, 1050));
  sh(cwd, "echo two >> edit.txt; rm gone.txt; mkdir -p src && printf 'x = 1\\n' > src/new.py; echo y > node_modules/pkg/i.js");
  const summary = parseSummary(sh(cwd, summaryScript(dir, { diffBytes: 1000 })), 1000);
  assert.deepEqual(summary, {
    entries: [{ kind: "created", bytes: 6, path: "src/new.py" }, { kind: "modified", bytes: 8, path: "edit.txt" }, { kind: "deleted", path: "gone.txt" }],
    counts: { created: 1, modified: 1, deleted: 1 },
  });
  // In a git repo: the diff of the modified and deleted tracked files against the starting commit (a commit by the agent still counts).
  const repo = tmp("harness-critic-git-");
  const git = (args: string) => sh(repo, `git -c user.email=t@t -c user.name=t ${args}`);
  writeFileSync(join(repo, "edit.txt"), "one\n");
  writeFileSync(join(repo, "gone.txt"), "gone\n");
  git("init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm start");
  const repoDir = join(tmp("harness-critic-scratch-"), "crit");
  assert.match(factsOf(sh(repo, startScript(repoDir)), "critic_").git ?? "", /^[0-9a-f]{40}$/u);
  const startCommit = factsOf(sh(repo, startScript(join(repoDir, "..", "other"))), "critic_").git!;
  await new Promise((done) => setTimeout(done, 1050));
  sh(repo, "echo two >> edit.txt; rm gone.txt; echo new > untracked.txt");
  git("commit -qam agent");
  const inRepo = parseSummary(sh(repo, summaryScript(repoDir, { base: startCommit, diffBytes: 4000 })), 4000)!;
  assert.deepEqual(inRepo.counts, { created: 1, modified: 1, deleted: 1 });
  assert.match(inRepo.diff ?? "", /diff --git a\/edit\.txt b\/edit\.txt[\s\S]*\+two/u);
  assert.match(inRepo.diff ?? "", /deleted file mode[\s\S]*-gone/u);
  assert.ok(!(inRepo.diff ?? "").includes("untracked.txt"), "an untracked new file is listed, not diffed");
  assert.match(renderChanges(inRepo, repo, 4000), /created\s+4\s+untracked\.txt/u);
});

test("the review's tools: no file-editing tool on either surface; harness-side writes into the project are refused; commands are internal", async () => {
  const exec = criticLoadout(readLoadout("exec-v0").loadout);
  assert.equal(exec.tools.apply_patch?.exposure, "off");
  assert.deepEqual(Object.entries(exec.tools).filter(([, config]) => config.exposure === "eager").map(([name]) => name).sort(), ["exec", "exec_command", "view_image", "wait", "write_stdin"]);
  const compact = criticLoadout(readLoadout("compact-v0-plain").loadout);
  assert.deepEqual(Object.entries(compact.tools).filter(([, config]) => config.exposure === "eager").map(([name]) => name).sort(), ["bash", "read", "wait"]);
  const cwd = tmp("harness-critic-env-");
  const scratch = tmp("harness-critic-envs-");
  const env = new LocalEnv({ cwd });
  try {
    const view = reviewEnv(env, { scratch, vars: { TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: "1" } });
    await assert.rejects(view.writeFile("x.txt", "x"), /read-only review/u);
    await assert.rejects(view.writeFile(join(cwd, "sub/y.txt"), "y"), /read-only review/u);
    await view.writeFile(join(scratch, "ok.txt"), "ok");
    assert.equal(readFileSync(join(scratch, "ok.txt"), "utf8"), "ok", "the critic's own scratch is writable");
    assert.equal(await view.scratchDir(), scratch);
    const run = await view.exec("echo $TMPDIR $PYTHONDONTWRITEBYTECODE; sleep 5", { yieldMs: 200 });
    assert.match(run.handle ?? "", /^h\d+$/u, "an internal handle: the implementer's p<n> never shift");
    await view.kill(run.handle!);
    assert.equal((await view.exec("echo $TMPDIR")).output.trim(), scratch);
    assert.match((await env.exec("echo hi", { yieldMs: 0, background: true })).handle ?? "", /^p1$/u, "the implementer's first handle is still p1");
  } finally {
    await env.close();
  }
});

// ---------- in a run ----------

/** In the implementer's early turns only: never in what the critic sees. */
const PRIVATE = "IMPLEMENTER-PRIVATE-91c2";
const TASK = "Write result.txt containing ok.";

const cell = (code: string, text?: string): FauxStep => ({ ...(text === undefined ? {} : { text }), toolCalls: [{ name: "exec", arguments: { input: code } }] });
/** An exec cell running one shell command and printing its output. */
const run = (cmd: string, text?: string): FauxStep => cell(`const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }); text(String(r.output ?? ""));`, text);
const textOf = (message: { content: unknown } | undefined) =>
  message === undefined ? "" : typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastUser = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "user");
const policyEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`);
/** The review's trace event (any: each test reads the fields it names). */
const criticCheck = (events: Record<string, any>[]): any => events.find((event) => event.type === "policy" && event.action === "check" && event.reason === "critic");

const FAIL_VERDICT = [
  "I read result.txt.", "", "VERDICT: FAIL",
  "1. Requirement: \"result.txt containing ok\"",
  "   Fails: result.txt says okay, not ok.",
  "   Evidence: cat result.txt -> okay",
].join("\n");
const FINDINGS_ITEMS = "1. Requirement: \"result.txt containing ok\"\n   Fails: result.txt says okay, not ok.\n   Evidence: cat result.txt -> okay";
const FINDINGS = LEVER_TEXTS.critic.replace("{findings}", FINDINGS_ITEMS);
const PASS_VERDICT = "result.txt holds ok.\n\nVERDICT: PASS";

type CriticReply = FauxStep | ((context: TranscriptContext, signal: AbortSignal | undefined) => FauxStep | Promise<FauxStep>);

interface Run {
  result: Awaited<ReturnType<typeof runHarness>>;
  /** Trace events (any: each test reads the fields of the events it names). */
  events: any[];
  /** The implementer's request contexts and the critic's, in order. */
  contexts: TranscriptContext[];
  critic: TranscriptContext[];
  cwd: string;
  transcript: string;
}

async function fauxRun(loadout: Loadout, steps: (FauxStep | ((context: TranscriptContext) => FauxStep | Promise<FauxStep>))[], critic: CriticReply[], options: {
  budgets?: Budgets; prompt?: string; finishSnapshot?: RunOptions["finishSnapshot"]; resultPath?: string; setup?: (cwd: string) => void; validator?: FauxStep[]; cwd?: string;
} = {}): Promise<Run> {
  const cwd = options.cwd ?? tmp("harness-critic-run-");
  options.setup?.(cwd);
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const criticContexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => async (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(typeof step === "function" ? await step(context) : step);
  });
  const reviews: FauxResponseStep[] = critic.map((reply) => async (context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined) => {
    criticContexts.push(structuredClone(context));
    return fauxStep(typeof reply === "function" ? await reply(context, streamOptions?.signal) : reply);
  });
  const dir = mkdtempSync(join(tmpdir(), "harness-critic-trace-"));
  const tracePath = join(dir, "trace.jsonl");
  const transcriptPath = join(dir, "transcript.jsonl");
  try {
    const result = await runHarness({
      prompt: options.prompt ?? TASK, model: "faux/crit", effort: "high", loadout, env, tracePath, transcriptPath, fauxSteps: scripted, criticFauxSteps: reviews,
      ...(options.validator === undefined ? {} : { validatorFauxSteps: options.validator.map(fauxStep) }),
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      ...(options.finishSnapshot === undefined ? {} : { finishSnapshot: options.finishSnapshot }), ...(options.resultPath === undefined ? {} : { resultPath: options.resultPath }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts, critic: criticContexts, cwd, transcript: readFileSync(transcriptPath, "utf8") };
  } finally {
    await env.close();
  }
}

/** Every file under `dir` with its text, sorted. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((entry) => statSync(join(dir, entry)).isFile()).sort()
    .map((entry) => `${entry}: ${readFileSync(join(dir, entry), "utf8")}`);
}

test("a fresh context: the critic sees its prompt, its own tools, and one message (the task first, the changes, the final message), nothing else", async () => {
  const run1 = await fauxRun(criticOn(), [
    { ...run(`printf 'okay\\n' > result.txt # ${PRIVATE}`, `Plan: ${PRIVATE}`) },
    { text: "Done: result.txt says okay." },
    { text: "Fixed." },
    { text: "never sent" },
  ], [
    run("cat result.txt"),
    FAIL_VERDICT,
  ].map((reply) => (typeof reply === "string" ? { text: reply } : reply)));
  assert.equal(run1.result.status, "finished");
  assert.equal(run1.result.usage.requests, 3);
  assert.equal(run1.critic.length, 2);
  const [first, second] = run1.critic;
  const system = first!.messages[0] as { role: string; content: string; toolsAdded?: { name: string; description: string }[] };
  assert.equal(system.role, "system");
  assert.equal(system.content, CRITIC_PROMPT.replace("{max_turns}", "12").replace("{max_findings}", "5"));
  assert.deepEqual(system.toolsAdded?.map((tool) => tool.name), ["exec", "wait"]);
  assert.ok(!system.toolsAdded!.some((tool) => tool.description.includes("apply_patch")), "no file-editing tool is even described");
  assert.deepEqual(first!.messages.map((message) => message.role), ["system", "user"], "one user message: nothing of the implementer's transcript");
  const request = textOf(first!.messages[1]);
  assert.ok(request.startsWith(`<task>\n${TASK}\n</task>\n\n<env>\ncwd: ${run1.cwd}\n`), "the task comes first");
  assert.match(request, /<changes>\nFiles created, modified or deleted under .* since the start[^\n]*\ncreated\s+5\s+result\.txt\n<\/changes>/u);
  assert.match(request, /<engineer_final_message>\nDone: result\.txt says okay\.\n<\/engineer_final_message>/u);
  assert.ok(!JSON.stringify(run1.critic).includes(PRIVATE), "neither the implementer's text nor its commands reach the critic");
  assert.deepEqual(second!.messages.map((message) => message.role), ["system", "user", "assistant", "toolResult"], "its own tool results, nothing more");
  assert.match(textOf(second!.messages[3]), /okay/u, "its command ran in the workspace");
  // The implementer never sees the critic's prompt or its transcript; only the findings message.
  for (const context of run1.contexts) assert.ok(!JSON.stringify(context).includes("You are an independent reviewer"));
  assert.equal(textOf(lastUser(run1.contexts[2]!)), FINDINGS);
  assert.ok(!run1.transcript.includes("You are an independent reviewer") && !run1.transcript.includes("engineer_final_message"), "the implementer's transcript holds nothing of the review's");
  assert.deepEqual(policyEvents(run1.events), ["check:critic", "continue:critic"]);
});

test("read-only: the critic's commands may vandalize the project and apply_patch is gone, yet the workspace after the review is exactly as before", async () => {
  const cwd = tmp("harness-critic-ro-");
  writeFileSync(join(cwd, "data.csv"), "a,b\n1,2\n");
  mkdirSync(join(cwd, "lib"));
  writeFileSync(join(cwd, "lib", "util.py"), "X = 1\n");
  let before: string[] = [];
  const vandal = cell([
    "await tools.exec_command({ cmd: \"echo junk > result.txt; rm data.csv; rm -rf lib; echo new > stray.txt; mkdir -p .pytest_cache && touch .pytest_cache/x\" });",
    "try { await tools.apply_patch(\"*** Begin Patch\\n*** Add File: patched.txt\\n+x\\n*** End Patch\\n\"); text('patched'); } catch (error) { text('apply_patch: ' + error.message); }",
    "const r = await tools.exec_command({ cmd: \"ls; echo TMPDIR=$TMPDIR\" }); text(String(r.output));",
  ].join("\n"));
  const run1 = await fauxRun(criticOn(), [
    run("printf 'okay\\n' > result.txt"),
    () => {
      before = filesUnder(cwd);
      return { text: "Done." };
    },
    () => {
      assert.deepEqual(filesUnder(cwd), before, "the implementer's next request finds the workspace it left");
      return { text: "Fixed." };
    },
    { text: "never sent" },
  ], [vandal, (context) => {
    const out = textOf(context.messages.at(-1));
    assert.match(out, /apply_patch: tools\.apply_patch does not exist\. Available: exec_command, view_image, write_stdin\./u, "no apply_patch on the critic's tools");
    assert.match(out, /stray\.txt/u, "the vandalism happened");
    assert.match(out, /TMPDIR=\S+\/round-1\/tmp/u, "temp files go to the critic's scratch");
    return { text: FAIL_VERDICT };
  }], { cwd });
  assert.equal(run1.result.status, "finished");
  const check = criticCheck(run1.events);
  assert.equal(run1.result.usage.requests, 3);
  assert.equal(check.workspace_unchanged, true);
  assert.ok(check.guard.created >= 3 && check.guard.restored >= 3, JSON.stringify(check.guard));
  assert.equal(check.guard.residual, 0);
  assert.ok(check.guard.paths.includes("+ ./stray.txt") && check.guard.paths.includes("~ ./data.csv"));
  assert.deepEqual(filesUnder(cwd), ["data.csv: a,b\n1,2\n", "lib/util.py: X = 1\n", "result.txt: okay\n"]);
});

const okayThenDone = (...after: FauxStep[]) => [run("printf 'okay\\n' > result.txt"), { text: "Done." }, ...after, { text: "never sent" }];

test("FAIL with findings continues the run once with the findings; the next finish ends the run (max_rounds 1)", async () => {
  const run1 = await fauxRun(criticOn(), okayThenDone({ text: "Fixed." }), [{ text: FAIL_VERDICT }, { text: FAIL_VERDICT }]);
  assert.equal(run1.result.status, "finished");
  assert.equal(run1.result.usage.requests, 3);
  assert.equal(run1.critic.length, 1, "one review");
  assert.equal(textOf(lastUser(run1.contexts[2]!)), FINDINGS);
  const check = criticCheck(run1.events);
  assert.deepEqual({ stop: check.stop, verdict: check.verdict, n_findings: check.n_findings, bounced: check.bounced, turns: check.turns, tool_calls: check.tool_calls },
    { stop: "verdict", verdict: "FAIL", n_findings: 1, bounced: true, turns: 1, tool_calls: 0 });
  assert.ok(check.ms >= check.wall_ms && check.wall_cap_ms === 300_000 && check.final.endsWith("Evidence: cat result.txt -> okay"));
  const fired = run1.events.find((event) => event.action === "continue" && event.reason === "critic");
  assert.deepEqual({ round: fired.round, n_findings: fired.n_findings, findings: fired.findings, placebo: fired.placebo, unchanged: fired.workspace_unchanged },
    { round: 1, n_findings: 1, findings: FINDINGS_ITEMS, placebo: false, unchanged: true });
});

test("PASS, no verdict, a bare FAIL, a provider error, max_turns and a timeout all let the run end (recorded, never a bounce)", async () => {
  const cases: [string, Loadout, CriticReply[], string, Record<string, unknown>][] = [
    ["pass", criticOn(), [{ text: PASS_VERDICT }], "verdict", { verdict: "PASS", n_findings: 0 }],
    ["no verdict", criticOn(), [{ text: "It looks right to me." }], "no_verdict", { verdict: null }],
    ["bare FAIL", criticOn(), [{ text: "VERDICT: FAIL" }], "verdict", { verdict: "FAIL", n_findings: 0 }],
    ["provider error", criticOn(), [{ stopReason: "error", errorMessage: "400 bad request" }], "error", { error: "400 bad request" }],
    ["unscripted", criticOn(), [], "error", {}],
    ["max_turns", criticOn({ max_turns: 2 }), [run("true"), run("true"), { text: FAIL_VERDICT }], "max_turns", { turns: 2, tool_calls: 2 }],
    ["timeout", criticOn({ wall_s: 1 }), [run("true"), (_context, signal) => new Promise<FauxStep>((resolve) => {
      if (signal?.aborted === true) resolve({ text: FAIL_VERDICT });
      signal?.addEventListener("abort", () => resolve({ text: FAIL_VERDICT }), { once: true });
    })], "timeout", { wall_cap_ms: 1000 }],
  ];
  await Promise.all(cases.map(async ([label, loadout, replies, stop, fields]) => {
    const run1 = await fauxRun(loadout, okayThenDone(), replies);
    assert.equal(run1.result.status, "finished", label);
    assert.equal(run1.result.usage.requests, 2, `${label}: the run ended at the first finish`);
    const check = criticCheck(run1.events);
    assert.equal(check?.stop, stop, label);
    assert.equal(check.bounced, false, label);
    assert.equal(check.workspace_unchanged, true, label);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(check[key], value, `${label}: ${key}`);
    assert.ok(!policyEvents(run1.events).includes("continue:critic"), label);
    if (label === "max_turns") {
      assert.equal(run1.critic.length, 2, "never a third request");
      assert.equal(textOf(lastUser(run1.critic[1]!)), "[harness] This is your last request: reply now with no tool call, ending with your VERDICT in the stated form.");
    }
    if (label === "timeout") assert.ok(check.wall_ms < 15_000, `cut at the cap (${check.wall_ms} ms)`);
  }));
});

test("the placebo runs the same review and sends neutral text of the findings' estimated token count", async () => {
  const run1 = await fauxRun(criticOn(true, true), okayThenDone({ text: "Done." }), [run("cat result.txt"), { text: FAIL_VERDICT }]);
  assert.equal(run1.result.usage.requests, 3);
  assert.equal(run1.critic.length, 2, "the same review");
  const sent = textOf(lastUser(run1.contexts[2]!));
  assert.equal(sent, placeboFor("critic", FINDINGS));
  assert.equal(estimateTokens(sent), estimateTokens(FINDINGS));
  assert.doesNotMatch(sent, /\b(?:review|requirement|result|fix|finish|task|fail)\w*/iu);
  const fired = run1.events.find((event) => event.action === "continue" && event.reason === "critic");
  assert.equal(fired.placebo, true);
  assert.equal(fired.findings, FINDINGS_ITEMS, "the trace keeps what the real arm would have sent");
  const pass = await fauxRun(criticOn(true, true), okayThenDone(), [{ text: PASS_VERDICT }]);
  assert.equal(pass.result.usage.requests, 2, "a PASS: no placebo either");
});

test("cost: the review's tokens and USD are in usage and cost_usd and in side_requests.critic; requests stay the agent loop's", async () => {
  const run1 = await fauxRun(criticOn(), okayThenDone({ text: "Fixed." }), [run("cat result.txt"), { text: FAIL_VERDICT }]);
  const loop = run1.events.filter((event) => event.type === "request_end");
  const side = run1.events.filter((event) => event.type === "side_request");
  assert.deepEqual(side.map((event) => event.kind), ["critic", "critic"]);
  const sum = (key: string, events: Record<string, any>[]) => events.reduce((total, event) => total + event.usage[key], 0);
  assert.equal(run1.result.usage.requests, loop.length);
  assert.equal(run1.result.usage.output_tokens, sum("output", loop) + sum("output", side));
  assert.equal(run1.result.usage.input_tokens, sum("input", loop) + sum("input", side));
  const loopCost = loop.reduce((total, event) => total + event.cost_usd, 0);
  const sideCost = side.reduce((total, event) => total + event.cost_usd, 0);
  assert.ok(sideCost > 0);
  assert.ok(Math.abs(run1.result.cost_usd! - (loopCost + sideCost)) < 1e-6);
  const critic = run1.result.side_requests?.critic;
  assert.deepEqual(critic && { requests: critic.requests, output: critic.output_tokens }, { requests: 2, output: sum("output", side) });
  const check = criticCheck(run1.events);
  assert.equal(check.output_tokens, sum("output", side));
  assert.ok(Math.abs(check.cost_usd - sideCost) < 1e-5);
});

test("a USD budget reached during the review ends it without a bounce", async () => {
  const run1 = await fauxRun(criticOn(), okayThenDone(), [run("true", "x".repeat(40_000)), { text: FAIL_VERDICT }], { budgets: { usd: 0.02 } });
  const check = criticCheck(run1.events);
  assert.deepEqual({ stop: check.stop, bounced: check.bounced, turns: check.turns }, { stop: "budget", bounced: false, turns: 1 });
  assert.equal(run1.critic.length, 1);
  assert.ok((run1.result.cost_usd ?? 0) >= 0.02);
});

test("snapshot: a critic bounce is a finish lever that fires; the archive is the implementer's first-finish workspace, not the review's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-critic-snap-"));
  const vandal = run("echo junk > result.txt; echo stray > stray.txt");
  const run1 = await fauxRun(criticOn(), [run("printf 'okay\\n' > result.txt"), { text: "Done." }, run("printf 'ok\\n' > result.txt"), { text: "Fixed." }, { text: "never sent" }],
    [vandal, { text: FAIL_VERDICT }], { finishSnapshot: { mode: "fired" }, resultPath: join(dir, "result.json") });
  const ff = run1.result.first_finish!;
  assert.deepEqual({ levers: ff.levers_pending, request: ff.request_index, skipped: ff.skipped }, { levers: ["critic"], request: 2, skipped: undefined });
  assert.ok(ff.path !== undefined && existsSync(ff.path));
  const listing = execFileSync("tar", ["-tzf", ff.path!]).toString().split("\n").filter((line) => line !== "" && line !== "./").sort();
  assert.deepEqual(listing, ["./result.txt"], "nothing the review created");
  assert.equal(execFileSync("tar", ["-xzOf", ff.path!, "./result.txt"]).toString(), "okay\n", "the implementer's content, not the review's");
  assert.deepEqual(filesUnder(run1.cwd), ["result.txt: ok\n"]);
  const dir2 = mkdtempSync(join(tmpdir(), "harness-critic-snap-"));
  const clean = await fauxRun(criticOn(), okayThenDone(), [{ text: PASS_VERDICT }], { finishSnapshot: { mode: "fired" }, resultPath: join(dir2, "result.json") });
  assert.equal(clean.result.first_finish?.skipped, "not_fired");
});

test("max_rounds 2 reviews again at the next finish (fresh context each time); the default reviews once", async () => {
  const twice = await fauxRun(criticOn({ max_rounds: 2 }), okayThenDone({ text: "Done again." }, { text: "Done, third." }), [{ text: FAIL_VERDICT }, { text: FAIL_VERDICT }]);
  assert.equal(twice.result.usage.requests, 4);
  assert.deepEqual(twice.events.filter((event) => event.action === "continue").map((event) => event.round), [1, 2]);
  assert.deepEqual(twice.critic.map((context) => context.messages.map((message) => message.role)), [["system", "user"], ["system", "user"]], "round 2 starts fresh");
  assert.match(textOf(twice.critic[1]!.messages[1]), /<engineer_final_message>\nDone again\.\n/u);
});

test("order and guards: the critic goes after the validator; the 90% budget guard, too little wall left and a cwd over guard_max_mb skip it", async () => {
  const both = withLevers((raw) => {
    raw.policy.validator = true;
    raw.policy.critic = true;
  });
  const failing = "```python\nprint('FAIL R1 result says ok: got okay')\nprint('END 0 1')\n```";
  const ordered = await fauxRun(both, okayThenDone({ text: "Done." }, { text: "Done." }), [{ text: FAIL_VERDICT }], { validator: [{ text: failing }] });
  assert.deepEqual(ordered.events.filter((event) => event.action === "continue").map((event) => event.reason), ["validator", "critic"]);
  assert.equal(ordered.result.usage.requests, 4);
  const steps = [...Array.from({ length: 9 }, (_, i) => run(`echo x > f${i}.txt`)), { text: "Done." }, { text: "never sent" }];
  const near = await fauxRun(criticOn(), steps, [{ text: FAIL_VERDICT }], { budgets: { requests: 11 } });
  assert.equal(near.result.usage.requests, 10);
  assert.deepEqual(near.events.filter((event) => event.action === "skip").map((event) => [event.reason, event.budget]), [["critic", "requests"]]);
  assert.equal(near.critic.length, 0);
  const short = await fauxRun(criticOn(), okayThenDone(), [{ text: FAIL_VERDICT }], { budgets: { wall_s: 100 } });
  assert.equal(short.events.find((event) => event.action === "skip")?.cause, "wall_left", "half of ~100 s left is under a minute");
  assert.equal(short.critic.length, 0);
  const big = await fauxRun(criticOn({ guard_max_mb: 1 }), okayThenDone(), [{ text: FAIL_VERDICT }], { setup: (cwd) => writeFileSync(join(cwd, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7)) });
  const skipped = big.events.find((event) => event.action === "skip");
  assert.deepEqual({ cause: skipped?.cause, max_kb: skipped?.max_kb }, { cause: "too_large", max_kb: 1024 });
  assert.ok(skipped.cwd_kb >= 3072);
  assert.equal(big.critic.length, 0, "never an unguarded review");
  assert.equal(big.result.usage.requests, 2);
});

// ---------- over the wire ----------

test("over the wire (exec-v0-critic): the review goes to the run's own base URL at high effort with its own tools, cache key and fresh input", async () => {
  const bodies: Body[] = [];
  const criticBodies: Body[] = [];
  const steps: Step[] = [
    { exec: 'await tools.apply_patch("*** Begin Patch\\n*** Add File: result.txt\\n+okay\\n*** End Patch\\n"); text("written");' },
    { text: "Done." }, { text: "Fixed." },
  ];
  const criticSteps: Step[] = [{ exec: 'const r = await tools.exec_command({ cmd: "cat result.txt" }); text(String(r.output));' }, { text: FAIL_VERDICT }];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Body;
      const critic = JSON.stringify(body).includes("You are an independent reviewer");
      (critic ? criticBodies : bodies).push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const step: Step = critic ? criticSteps[criticBodies.length - 1] ?? { text: PASS_VERDICT } : steps[bodies.length - 1] ?? { text: "Done." };
      res.end(eventsOf(step, critic ? 900 + criticBodies.length : bodies.length).map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const cwd = tmp("harness-critic-wire-");
  const env = new LocalEnv({ cwd });
  process.env.LOOPBACK_KEY = "sk-test";
  try {
    const loadout = readLoadout(join(loadoutDir, "exec-v0-critic.json")).loadout;
    const result = await runHarness({
      prompt: TASK, model: "openai/gpt-6.1-sol", effort: "medium", loadout, env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LOOPBACK_KEY" },
    });
    assert.equal(result.status, "finished");
    assert.equal(bodies.length, 3);
    assert.equal(criticBodies.length, 2, "two review requests, to the run's own base URL");
    const [first, second] = criticBodies as [Body, Body];
    assert.equal(first.model, "gpt-6.1-sol");
    assert.equal(first.reasoning?.effort, "high", "the lever's effort, not the run's");
    assert.equal(bodies[0]!.reasoning?.effort, "medium");
    // The tool set rides in an additional_tools input item (Pi's Responses wire).
    const toolsOf = (body: Body) => (body.input as Body[]).filter((item) => item.type === "additional_tools").flatMap((item) => item.tools as { name: string }[]);
    assert.deepEqual(toolsOf(first).map((tool) => tool.name).sort(), ["exec", "wait"]);
    assert.ok(!JSON.stringify(toolsOf(first)).includes("apply_patch"), "no file-editing tool described");
    assert.ok(JSON.stringify(toolsOf(bodies[0]!)).includes("apply_patch"), "the implementer keeps its own");
    assert.notEqual(first.prompt_cache_key, bodies[0]!.prompt_cache_key, "its own cache key");
    assert.equal(second.prompt_cache_key, first.prompt_cache_key, "one key across the review");
    const userTexts = (body: Body) => (body.input as Body[]).filter((item) => item.role === "user").map((item) => JSON.stringify(item.content));
    assert.equal(userTexts(first).length, 1, "one user message");
    assert.match(userTexts(first)[0]!, /<task>\\nWrite result\.txt containing ok\.\\n<\/task>/u);
    assert.ok(!JSON.stringify(first.input).includes("written"), "nothing of the implementer's turns");
    assert.ok(JSON.stringify(second.input).includes("okay"), "its own command's output comes back to it");
    assert.deepEqual(bodies[2]!.input.at(-1), { role: "user", content: [{ type: "input_text", text: FINDINGS }] });
    assert.equal(result.side_requests?.critic?.requests, 2);
    assert.equal(result.usage.requests, 3);
    assert.equal(result.usage.input_tokens, 500, "3 agent requests and 2 review requests at 100 input tokens each");
    assert.deepEqual(filesUnder(cwd), ["result.txt: okay\n"]);
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
});

// ---------- end to end ----------

test("dry run on a tiny fake task: the critic runs the deliverable, its verdict quotes what it saw, the fix ends the run", async () => {
  const task = "Create add.py with a function add(a, b) that returns the sum of two integers. It must also accept integers given as strings, so add('2', '3') == 5.";
  const probe = "python3 -c \"import add; print(repr(add.add(2, 3))); print(repr(add.add('2', '3')))\"";
  const run1 = await fauxRun(criticOn(), [
    run("printf 'def add(a, b):\\n    return a + b\\n' > add.py"),
    { text: "add.py is done: add(2, 3) returns 5." },
    run("printf 'def add(a, b):\\n    return int(a) + int(b)\\n' > add.py"),
    { text: "add.py now converts both arguments with int()." },
    { text: "never sent" },
  ], [
    run(probe),
    (context) => {
      // The critic's own command ran on the implementer's file; its verdict quotes what came back.
      const seen = textOf(context.messages.at(-1));
      const lines = seen.split("\n").filter((line) => /^'?\d/u.test(line));
      return {
        text: [
          "add(2, 3) works; add('2', '3') does not.", "", "VERDICT: FAIL",
          "1. Requirement: \"It must also accept integers given as strings, so add('2', '3') == 5.\"",
          `   Fails: add('2', '3') returns ${lines[1]} instead of 5.`,
          `   Evidence: ${probe} -> ${lines.join(" ")}`,
        ].join("\n"),
      };
    },
  ], { prompt: task });
  assert.equal(run1.result.status, "finished");
  assert.equal(run1.result.usage.requests, 4);
  const findings = textOf(lastUser(run1.contexts[2]!));
  assert.equal(findings, LEVER_TEXTS.critic.replace("{findings}", [
    "1. Requirement: \"It must also accept integers given as strings, so add('2', '3') == 5.\"",
    "   Fails: add('2', '3') returns '23' instead of 5.",
    `   Evidence: ${probe} -> 5 '23'`,
  ].join("\n")));
  assert.match(textOf(run1.critic[0]!.messages[1]), /created\s+\d+\s+add\.py/u, "the change summary names the deliverable");
  assert.deepEqual(filesUnder(run1.cwd), ["add.py: def add(a, b):\n    return int(a) + int(b)\n"], "the fix, and no __pycache__ from the review's import");
  const flow = run1.events.filter((event) => ["request_start", "side_request", "policy", "stop"].includes(event.type))
    .map((event) => (event.type === "policy" ? `${event.action}:${event.reason}` : event.type === "side_request" ? `side:${event.kind}` : event.type));
  assert.deepEqual(flow, ["request_start", "request_start", "side:critic", "side:critic", "check:critic", "continue:critic", "request_start", "request_start", "stop"]);
  const check = criticCheck(run1.events);
  assert.deepEqual({ turns: check.turns, tool_calls: check.tool_calls, n_findings: check.n_findings, unchanged: check.workspace_unchanged, created: check.guard.created },
    { turns: 2, tool_calls: 1, n_findings: 1, unchanged: true, created: 0 });
});
});
