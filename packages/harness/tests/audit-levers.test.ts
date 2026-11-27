/**
 * The audit lane's levers, offline (faux model, or the loopback Responses
 * server for what the provider receives):
 * - P4 policy.finish_audit: one evidence-audit continuation at the first
 *   finish attempt the gate and the hedge bounce leave alone; never twice;
 *   never when a hard budget is 90% used.
 * - P6 prompt.time_budget: one line with the wall budget in the first user
 *   message; prompt.time_budget_placebo puts an equal-length neutral line there.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, FauxResponseStep, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import type { ExecEnv } from "../src/env/types.ts";
import { FINISH_AUDIT_BUDGET_PCT, LeverState, timeBudgetLine } from "../src/levers.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness } from "../src/run.ts";
import type { Recorder } from "../src/trace.ts";
import { EXEC_SCENARIO, isPrefix, runScripted, type Body } from "./openai-loopback.ts";

const loadoutDir = join(dirname(fileURLToPath(import.meta.url)), "..", "loadouts");
const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  patch(raw);
  return normalizeLoadout(raw);
};

async function fauxRun(loadout: Loadout, steps: FauxStep[], budgets?: Budgets) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-audit-")));
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(step);
  });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-audit-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({
      prompt: "do the task", model: "faux/audit", effort: "high", loadout, env, tracePath, fauxSteps: scripted, ...(budgets === undefined ? {} : { budgets }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts };
  } finally {
    await env.close();
  }
}

const bash = (command: string): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command } }] });
const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const textOf = (message: { content: unknown } | undefined) =>
  message === undefined ? "" : typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastUser = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "user");
const policyEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`);
const firstUserText = (body: Body) => body.input.find((item: any) => item.role === "user").content[0].text as string;

// ---------- loadout ----------

describe("audit levers", { concurrency: 4 }, () => {
test("P4 and P6 are off by default: absent or false normalizes and hashes like the built-in", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(plain.policy.finish_audit, undefined);
    assert.equal(plain.prompt.time_budget, undefined);
    assert.equal(plain.prompt.time_budget_placebo, undefined);
    const off = withLevers((raw) => {
      raw.policy = { ...raw.policy, finish_audit: false };
      raw.prompt = { ...raw.prompt, time_budget: false, time_budget_placebo: false };
    }, name);
    assert.equal(loadoutHash(off), loadoutHash(plain), `${name}: false is off`);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain));
  }
});

test("true turns them on with the default wording; an object overrides it; the wording enters the behavior hash", () => {
  const on = withLevers((raw) => {
    raw.policy.finish_audit = true;
    raw.prompt.time_budget = true;
  });
  assert.deepEqual(on.policy.finish_audit, { max: 1, text: LEVER_TEXTS.finish_audit });
  assert.deepEqual(on.prompt.time_budget, { text: LEVER_TEXTS.time_budget });
  const worded = withLevers((raw) => {
    raw.policy.finish_audit = { text: "Audit." };
    raw.prompt.time_budget = { text: "About {minutes} min." };
  });
  assert.equal(worded.policy.finish_audit?.text, "Audit.");
  assert.equal(worded.prompt.time_budget?.text, "About {minutes} min.");
  assert.notEqual(loadoutHash(worded), loadoutHash(on));
  const placebo = withLevers((raw) => {
    raw.prompt.time_budget = true;
    raw.prompt.time_budget_placebo = true;
  });
  assert.equal(placebo.prompt.time_budget_placebo, true);
  assert.notEqual(loadoutHash(placebo), loadoutHash(on));
});

test("P4 and P6 settings fail closed: unknown keys, max 0, no {minutes}, a placebo with nothing to replace", () => {
  const bad: [string, (raw: Record<string, any>) => void, RegExp][] = [
    ["unknown key", (raw) => (raw.policy.finish_audit = { maxx: 2 }), /maxx/u],
    ["max 0", (raw) => (raw.policy.finish_audit = { max: 0 }), /finish_audit/u],
    ["empty text", (raw) => (raw.policy.finish_audit = { text: "" }), /finish_audit/u],
    ["unknown time key", (raw) => (raw.prompt.time_budget = { minutes: 5 }), /minutes/u],
    ["no {minutes}", (raw) => (raw.prompt.time_budget = { text: "Take your time." }), /\{minutes\}/u],
    ["placebo alone", (raw) => (raw.prompt.time_budget_placebo = true), /time_budget_placebo needs/u],
  ];
  for (const [label, patch, message] of bad) {
    assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message), label);
  }
});

// ---------- P4 finish audit ----------

test("P4: the first finish attempt gets one audit continuation; the second finish ends the run", async () => {
  const loadout = withLevers((raw) => (raw.policy.finish_audit = true));
  const run = await fauxRun(loadout, [write("a.py", "print(1)\n"), { text: "Done." }, { text: "Done, audited." }, { text: "never sent" }]);
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.usage.requests, 3, "max 1: never fires twice");
  assert.equal(textOf(lastUser(run.contexts[2]!)), LEVER_TEXTS.finish_audit, "the audit is a user message after the final answer");
  assert.deepEqual(policyEvents(run.events), ["continue:finish_audit"]);
  const quiet = await fauxRun(loadout, [{ text: "Nothing to do." }, { text: "Still nothing." }, { text: "never sent" }]);
  assert.equal(quiet.result.usage.requests, 2, "it fires even with no change: the audit is about the requirements, not the edits");
});

test("P4 goes last: the evidence gate and the hedge bounce are spent first, one continuation per finish attempt", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.evidence_gate = { probe: "tools" };
    raw.policy.hedge_continue = true;
    raw.policy.finish_audit = { text: "Audit now." };
  });
  const run = await fauxRun(loadout, [
    write("a.py", "x\n"), { text: "Not verified." }, { text: "Still not verified." }, { text: "Done." }, { text: "Done." }, { text: "never sent" },
  ]);
  assert.deepEqual(policyEvents(run.events), ["continue:evidence_gate", "continue:hedge", "continue:finish_audit"]);
  assert.equal(run.result.usage.requests, 5);
  assert.equal(textOf(lastUser(run.contexts[4]!)), "Audit now.");
});

test("P4: max 2 audits twice, then the run ends", async () => {
  const loadout = withLevers((raw) => (raw.policy.finish_audit = { max: 2 }));
  const run = await fauxRun(loadout, [{ text: "Done." }, { text: "Done." }, { text: "Done." }, { text: "never sent" }]);
  assert.deepEqual(policyEvents(run.events), ["continue:finish_audit", "continue:finish_audit"]);
  assert.equal(run.result.usage.requests, 3);
});

test("P4 stays quiet once a hard budget is 90% used (requests here): the run ends at that finish", async () => {
  const loadout = withLevers((raw) => (raw.policy.finish_audit = true));
  const steps = [...Array.from({ length: 8 }, (_, i) => bash(`echo ${i}`)), { text: "Done." }, { text: "Done." }];
  const near = await fauxRun(loadout, steps, { requests: 10 });
  assert.equal(near.result.status, "finished");
  assert.equal(near.result.usage.requests, 9, "9 of 10 requests used: no audit");
  assert.deepEqual(policyEvents(near.events), ["skip:finish_audit"]);
  const skip = near.events.find((event) => event.reason === "finish_audit");
  assert.deepEqual({ budget: skip?.budget, used_pct: skip?.used_pct }, { budget: "requests", used_pct: 90 });
  const roomy = await fauxRun(loadout, steps, { requests: 11 });
  assert.equal(roomy.result.usage.requests, 10, "9 of 11 is under 90%: the audit fires");
  assert.deepEqual(policyEvents(roomy.events), ["continue:finish_audit"]);
});

/** A LeverState over a recorder whose clock, cost and usage the test sets. */
function auditState(budgets: Budgets, used: { ms?: number; usd?: number | null; tokens?: number; requests?: number }) {
  const events: [string, string, Record<string, unknown>][] = [];
  const recorder = {
    now: () => used.ms ?? 0,
    get costUsd() {
      return used.usd === undefined ? 0 : used.usd;
    },
    usage: { requests: used.requests ?? 0, input_tokens: used.tokens ?? 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
    policy: (action: string, reason: string, fields: Record<string, unknown> = {}) => events.push([action, reason, fields]),
  } as unknown as Recorder;
  const loadout = withLevers((raw) => (raw.policy.finish_audit = true));
  const state = new LeverState({ loadout, budgets, recorder, env: {} as ExecEnv, model: {} as Model<Api>, thinking: "high" as ThinkingLevel });
  return { state, events, used };
}

test("P4's budget guard: wall and USD at 90% skip it (recorded once); just under fires; no budget never skips", async () => {
  assert.equal(FINISH_AUDIT_BUDGET_PCT, 90);
  const wall = auditState({ wall_s: 100 }, { ms: 90_000 });
  assert.equal(await wall.state.onFinishAttempt("Done."), undefined);
  assert.equal(await wall.state.onFinishAttempt("Done."), undefined);
  assert.deepEqual(wall.events, [["skip", "finish_audit", { budget: "wall_s", used_pct: 90 }]], "a skip is recorded once");
  const early = auditState({ wall_s: 100 }, { ms: 89_900 });
  assert.equal(await early.state.onFinishAttempt("Done."), LEVER_TEXTS.finish_audit);
  assert.equal(await early.state.onFinishAttempt("Done."), undefined, "never twice");
  assert.deepEqual(early.events.map(([action, reason]) => `${action}:${reason}`), ["continue:finish_audit"]);
  const usd = auditState({ usd: 2 }, { usd: 1.85 });
  assert.equal(await usd.state.onFinishAttempt("Done."), undefined);
  assert.deepEqual(usd.events, [["skip", "finish_audit", { budget: "usd", used_pct: 93 }]]);
  const cheap = auditState({ usd: 2 }, { usd: 1.79 });
  assert.equal(await cheap.state.onFinishAttempt("Done."), LEVER_TEXTS.finish_audit);
  const tokens = auditState({ tokens: 1000 }, { tokens: 950 });
  assert.equal(await tokens.state.onFinishAttempt("Done."), undefined);
  const unbudgeted = auditState({}, { ms: 10_000_000, usd: 500, tokens: 1e9, requests: 10_000 });
  assert.equal(await unbudgeted.state.onFinishAttempt("Done."), LEVER_TEXTS.finish_audit);
  // A budget that frees up is not possible, but a skip never spends the audit: the guard decides at each attempt.
  const later = auditState({ wall_s: 100 }, { ms: 95_000 });
  assert.equal(await later.state.onFinishAttempt("Done."), undefined);
  later.used.ms = 1_000;
  assert.equal(await later.state.onFinishAttempt("Done."), LEVER_TEXTS.finish_audit);
});

test("P4 on exec-v0 over the wire: the audit is the last input item and every request extends the last", async () => {
  const loadout = withLevers((raw) => (raw.policy.finish_audit = true), "exec-v0");
  const run = await runScripted(loadout, [...EXEC_SCENARIO.slice(0, 4), { text: "Done." }, { text: "Done, audited." }, { text: "never sent" }], {
    setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n"),
  });
  assert.equal(run.result.status, "finished");
  assert.equal(run.bodies.length, 6);
  assert.deepEqual(run.bodies[5]!.input.at(-1), { role: "user", content: [{ type: "input_text", text: LEVER_TEXTS.finish_audit }] });
  for (let i = 1; i < run.bodies.length; i++) assert.ok(isPrefix(run.bodies[i - 1]!, run.bodies[i]!), `request ${i + 1} extends request ${i}`);
  assert.match(readFileSync(run.tracePath, "utf8"), /"action":"continue","reason":"finish_audit","n":1/u);
});

// ---------- P6 time budget ----------

test("P6: the line states the wall budget in whole minutes (at least 1); off or no budget, no line", () => {
  const on = withLevers((raw) => (raw.prompt.time_budget = true), "exec-v0");
  const line = (wall?: number) => timeBudgetLine(on, wall)?.text;
  assert.equal(line(3000), LEVER_TEXTS.time_budget.replace("{minutes}", "50"));
  assert.match(line(3000)!, /^You have about 50 minutes of wall time for this task\. /u);
  assert.equal(timeBudgetLine(on, 90)?.minutes, 2);
  assert.equal(timeBudgetLine(on, 20)?.minutes, 1);
  assert.equal(line(undefined), undefined);
  assert.equal(timeBudgetLine(normalizeLoadout(base("exec-v0")), 3000), undefined);
});

const timed = (placebo: boolean) => withLevers((raw) => {
  raw.prompt.time_budget = true;
  if (placebo) raw.prompt.time_budget_placebo = true;
}, "exec-v0");

test("P6 over the wire: one line after the task in the first message only, byte-identical across trials; later requests extend it", async () => {
  const run = await runScripted(timed(false), [{ exec: 'text("hi");' }, { text: "Done." }], { budgets: { wall_s: 3000 } });
  const expected = LEVER_TEXTS.time_budget.replace("{minutes}", "50");
  const first = firstUserText(run.bodies[0]!);
  assert.ok(first.endsWith(`Make check.sh pass.\n\n${expected}`), first);
  assert.ok(isPrefix(run.bodies[0]!, run.bodies[1]!));
  assert.equal(JSON.stringify(run.bodies[1]).split("of wall time for this task").length - 1, 1, "stated once");
  assert.match(readFileSync(run.tracePath, "utf8"), /"action":"orient","reason":"time_budget","minutes":50,"placebo":false/u);
  const again = await runScripted(timed(false), [{ text: "Done." }], { budgets: { wall_s: 3000 } });
  const strip = (text: string) => text.slice(text.indexOf("</env>"));
  assert.equal(strip(firstUserText(again.bodies[0]!)), strip(first), "the same on every trial with the same budget");
});

test("P6 placebo: the same place gets neutral text of the line's estimated token count, deterministic, asking for nothing", async () => {
  const real = timeBudgetLine(timed(false), 3000)!.text;
  const neutral = timeBudgetLine(timed(true), 3000)!.text;
  assert.equal(neutral, placeboFor("time_budget", real));
  assert.equal(estimateTokens(neutral), estimateTokens(real));
  assert.doesNotMatch(neutral, /\b(?:minutes?|wall|time|budget|stop|verif\w*|requirement|tests?|builds?)\b/iu);
  assert.doesNotMatch(neutral, /\n/u, "one line");
  const run = await runScripted(timed(true), [{ text: "Done." }], { budgets: { wall_s: 3000 } });
  const first = firstUserText(run.bodies[0]!);
  assert.ok(first.endsWith(`Make check.sh pass.\n\n${neutral}`), first);
  assert.ok(!JSON.stringify(run.bodies[0]).includes("of wall time for this task"));
  assert.match(readFileSync(run.tracePath, "utf8"), /"action":"orient","reason":"time_budget","minutes":50,"placebo":true/u);
});

test("P6 refuses to run without a wall budget: the arm would run as its control", async () => {
  const env = new LocalEnv({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "harness-audit-"))) });
  try {
    await assert.rejects(
      runHarness({ prompt: "x", model: "faux/audit", effort: "high", loadout: timed(false), env, fauxSteps: [fauxStep({ text: "Done." })] }),
      /prompt\.time_budget: there is no wall budget/u,
    );
    const run = await fauxRun(timed(false), [{ text: "Done." }], { wall_s: 600 });
    assert.equal(run.result.status, "finished");
    assert.ok(textOf(run.contexts[0]!.messages.find((message) => message.role === "user")).endsWith("about 10 minutes of wall time for this task. " +
      "Long builds, test suites and training runs are fine; do not stop before every requirement is verified."));
  } finally {
    await env.close();
  }
});

test("exec-v0-p46: the time line opens the run and the audit closes it, append-only", async () => {
  const loadout = readLoadout(join(loadoutDir, "exec-v0-p46.json")).loadout;
  const run = await runScripted(loadout, [{ text: "Done." }, { text: "Done, audited." }, { text: "never sent" }], { budgets: { wall_s: 600 } });
  assert.equal(run.bodies.length, 2);
  assert.ok(firstUserText(run.bodies[0]!).endsWith(LEVER_TEXTS.time_budget.replace("{minutes}", "10")));
  assert.deepEqual(run.bodies[1]!.input.at(-1), { role: "user", content: [{ type: "input_text", text: LEVER_TEXTS.finish_audit }] });
  assert.ok(isPrefix(run.bodies[0]!, run.bodies[1]!));
});
});
