/**
 * policy.clause_check (src/clause-check.ts, src/levers.ts), offline (pure rules, the faux model on a LocalEnv, and the
 * loopback Responses server for what the provider receives; no network, no real model):
 * - the loadout: off by default (built-ins hash as before), the defaults, fail-closed settings, the arms;
 * - the rules: the answer's clauses / NONE / unparsed, verbatim quotes, the note's list, the changes' cap, the request;
 * - in a run: the trigger (the first green after a red, with or without first_green; never a green without a red; never
 *   without a change, which does not use up `max`; `max`), no delay to the tool result or the next request, the note on
 *   the NEXT tool result and never on the triggering one, NONE gives no note, a finish attempt or the run's end drops it,
 *   the placebo, the cost in the run's totals, the side call at the run's effort with no tools, and the changes it reads
 *   (git diff in a repo, the run's added lines without one, created files, the diff_bytes cap);
 * - over the wire (exec-v0-clause): the side call goes to the run's own base URL at the run's effort, with no tools, and
 *   its note rides on the next exec result.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FauxResponseStep, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import {
  CHECK_TAIL_CHARS, changeParts, checkTail, ClauseCheck, clauseRequest, fitParts, formatClauses, MAX_CLAUSES, parseClauses, verbatimCount,
} from "../src/clause-check.ts";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type Effort, type FauxStep } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { CLAUSE_PROMPT, estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness } from "../src/run.ts";
import { eventsOf, type Body, type Step } from "./openai-loopback.ts";

const loadoutDir = join(import.meta.dirname, "..", "loadouts");
const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  raw.policy ??= {};
  patch(raw);
  return normalizeLoadout(raw);
};
const clauseOn = (settings: boolean | Record<string, unknown> = true, options: { placebo?: boolean; extra?: (raw: Record<string, any>) => void } = {}) => withLevers((raw) => {
  raw.policy.clause_check = settings;
  if (options.placebo === true) raw.policy.clause_check_placebo = true;
  options.extra?.(raw);
});

// ---------- loadout ----------

test("clause_check is off by default: absent or false normalizes and hashes like the built-ins", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(plain.policy.clause_check, undefined);
    assert.equal(plain.policy.clause_check_placebo, undefined);
    const off = withLevers((raw) => {
      raw.policy = { ...raw.policy, clause_check: false, clause_check_placebo: false };
    }, name);
    assert.equal(loadoutHash(off), loadoutHash(plain), `${name}: false is off`);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain));
  }
});

test("true turns it on with the defaults; each setting enters the behavior hash; the placebo is its own arm", () => {
  const on = clauseOn();
  assert.deepEqual(on.policy.clause_check, { max: 1, diff_bytes: 12000, max_output_tokens: 4000, prompt: CLAUSE_PROMPT, text: LEVER_TEXTS.clause_check });
  for (const change of [{ max: 2 }, { diff_bytes: 4000 }, { max_output_tokens: 2000 }, { prompt: "List clauses." }, { text: "Clauses:\n{clauses}" }]) {
    assert.notEqual(loadoutHash(clauseOn(change)), loadoutHash(on), JSON.stringify(change));
  }
  assert.notEqual(loadoutHash(clauseOn(true, { placebo: true })), loadoutHash(on));
  assert.ok(LEVER_TEXTS.clause_check.startsWith("Note: an independent reading of the task found clauses your change and checks may not cover yet:\n{clauses}\n"));
  assert.ok(LEVER_TEXTS.clause_check.endsWith("Check each against the task text; fix what is real before you finish."));
});

test("the settings fail closed: unknown keys, a text without {clauses}, bad numbers, an effort setting, a placebo with nothing to replace", () => {
  assert.throws(() => clauseOn({ rounds: 2 }), LoadoutError);
  assert.throws(() => clauseOn({ effort: "medium" }), LoadoutError, "the effort is always the run's");
  assert.throws(() => clauseOn({ text: "Check the task." }), /\{clauses\}/u);
  assert.throws(() => clauseOn({ max: 0 }), LoadoutError);
  assert.throws(() => clauseOn({ diff_bytes: 10 }), LoadoutError);
  assert.throws(() => clauseOn({ max_output_tokens: 10 }), LoadoutError);
  assert.throws(() => withLevers((raw) => (raw.policy.clause_check_placebo = true)), /clause_check_placebo needs policy.clause_check/u);
});

test("the arms: exec-v0-clause turns on exactly clause_check; exec-v0-clauseplac adds its placebo", () => {
  const clause = readLoadout(join(loadoutDir, "exec-v0-clause.json")).loadout;
  const plac = readLoadout(join(loadoutDir, "exec-v0-clauseplac.json")).loadout;
  assert.equal(clause.name, "exec-v0-clause");
  assert.equal(clause.policy.clause_check?.text, LEVER_TEXTS.clause_check);
  assert.equal(clause.policy.clause_check_placebo, undefined);
  assert.equal(plac.policy.clause_check_placebo, true);
  const { clause_check: _clause, ...policy } = clause.policy;
  assert.deepEqual({ ...clause, name: "", policy }, { ...readLoadout("exec-v0").loadout, name: "" });
});

// ---------- rules ----------

test("parseClauses: bullet and numbered lines are the clauses; otherwise NONE; otherwise unparsed", () => {
  assert.deepEqual(parseClauses("- \"an empty name must return 'Hello, world!'\"\n* it must strip whitespace\n2) a third one"), {
    result: "clauses", clauses: ["\"an empty name must return 'Hello, world!'\"", "it must strip whitespace", "a third one"], total: 3,
  });
  for (const none of ["NONE", "NONE.", "**NONE**", "  none  ", "- NONE", "Every clause is handled.\nNONE"]) assert.deepEqual(parseClauses(none), { result: "none" }, none);
  assert.deepEqual(parseClauses("- a\n- NONE\n- a"), { result: "clauses", clauses: ["a"], total: 1 }, "a bare none and repeats dropped");
  assert.deepEqual(parseClauses("All clauses are handled by the diff."), { result: "unparsed" });
  assert.deepEqual(parseClauses(""), { result: "unparsed" });
  const many = parseClauses(Array.from({ length: 14 }, (_, i) => `- clause ${i}`).join("\n"));
  assert.ok(many.result === "clauses" && many.clauses.length === MAX_CLAUSES && many.total === 14);
  const long = parseClauses(`- ${"x".repeat(1000)}`);
  assert.ok(long.result === "clauses" && long.clauses[0]!.length === 400 && long.clauses[0]!.endsWith("..."));
});

test("verbatimCount: quotes found in the task (quotes, case, spacing and ellipses folded); paraphrases are not", () => {
  const task = "Create app.py. It must also strip  surrounding whitespace from name, and an empty name must return 'Hello, world!'.";
  assert.equal(verbatimCount(["“an empty name must return 'Hello, world!'”", "It must also strip surrounding whitespace from name"], task), 2);
  assert.equal(verbatimCount(["\"It must also strip ... from name\""], task), 1);
  assert.equal(verbatimCount(["names should be trimmed", "it must also strip ... from the input"], task), 0);
});

test("formatClauses: one line per clause, then the count of the rest; the note fills {clauses}", () => {
  assert.equal(formatClauses(["a", "b"]), "- a\n- b");
  assert.equal(formatClauses(["a"], 3), "- a\n- (2 more not listed)");
  assert.equal(LEVER_TEXTS.clause_check.replace("{clauses}", formatClauses(["a"])),
    "Note: an independent reading of the task found clauses your change and checks may not cover yet:\n- a\nCheck each against the task text; fix what is real before you finish.");
});

test("fitParts: everything when it fits; else small parts stay whole and the big ones share the rest, cut at a line", () => {
  const small = { head: "+++ b/small.py (new file)", body: "+x = 1" };
  const big = { head: "+++ b/big.py (new file)", body: Array.from({ length: 400 }, (_, i) => `+line ${i}`).join("\n") };
  const big2 = { head: "git diff:", body: Array.from({ length: 400 }, (_, i) => `-old ${i}`).join("\n") };
  assert.deepEqual(fitParts([small], 1000), { text: "+++ b/small.py (new file)\n+x = 1", cut: false });
  const fit = fitParts([big2, small, big], 2000);
  assert.equal(fit.cut, true);
  assert.ok(Buffer.byteLength(fit.text) <= 2000, `${Buffer.byteLength(fit.text)} bytes`);
  assert.ok(fit.text.includes("+++ b/small.py (new file)\n+x = 1\n"), "the small part is whole");
  assert.ok(fit.text.indexOf("git diff:") < fit.text.indexOf("small.py") && fit.text.indexOf("small.py") < fit.text.indexOf("big.py"), "order kept");
  assert.equal(fit.text.split("[... cut]").length - 1, 2, "both big parts cut");
  assert.match(fit.text, /\+line \d+\n\[\.\.\. cut\]$/u, "cut at a line boundary");
  const parts = changeParts({ diff: "diff --git a/x b/x\n", created: [{ path: "n.py", text: "a\nb\n", cut: true }], added: [{ path: "m.py", text: "c" }] });
  assert.deepEqual(parts.map((part) => part.head), [
    "git diff of the modified and deleted files against the starting commit:", "--- /dev/null\n+++ b/n.py (new file)",
    "+++ b/m.py (lines your edits added; no starting copy to diff against)",
  ]);
  assert.deepEqual(parts.slice(1).map((part) => part.body), ["+a\n+b\n[... file continues]", "+c"]);
});

test("the request: the task, the changes, the passing check's command and output tail, then the question", () => {
  const text = clauseRequest("  Make add.py.\n", "created add.py", { cmd: "pytest -q", output: "3 passed\n" });
  assert.equal(text, [
    "<task>\nMake add.py.\n</task>", "<changes>\ncreated add.py\n</changes>", "<passing_check>\n$ pytest -q\n3 passed\n</passing_check>",
    "List the task's clauses that these changes and this check do not show as handled, or answer NONE.",
  ].join("\n\n"));
  const long = checkTail(`${"a".repeat(5000)}\nTAIL`);
  assert.ok(long.startsWith("[... earlier output cut]\n") && long.endsWith("TAIL") && long.length === CHECK_TAIL_CHARS + "[... earlier output cut]\n".length);
  assert.equal(checkTail("  \n"), "(no output)");
});

// ---------- in a run ----------

const TASK = "Create app.py with a function greet(name) that returns 'Hello, <name>!'. It must also strip surrounding whitespace from name, " +
  "and an empty name must return 'Hello, world!'.";
const CLAUSES = "- \"an empty name must return 'Hello, world!'\"";
const NOTE = LEVER_TEXTS.clause_check.replace("{clauses}", CLAUSES);
const APP = "def greet(name):\n    return f'Hello, {name.strip()}!'\n";

const scripts = (cwd: string) => {
  writeFileSync(join(cwd, "fail.sh"), "echo '1 failed'; exit 1\n");
  writeFileSync(join(cwd, "green.sh"), "echo '3 passed'\n");
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const bash = (command: string): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command } }] });
const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const edit = (path: string, oldText: string, newText: string): FauxStep => ({ toolCalls: [{ name: "edit", arguments: { path, edits: [{ oldText, newText }] } }] });
const textOf = (message: { content: unknown } | undefined) =>
  message === undefined ? "" : typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastTool = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "toolResult");
const policyEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`);
const clauseEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy" && String(event.reason).startsWith("clause_check"))
  .map((event) => `${event.action}:${event.stage ?? event.cause ?? ""}`);
const reminder = (text: string) => `\n[harness] ${text}`;

/** Whether the trace gets an event matching `match` within `ms`. */
async function traceHas(tracePath: string, match: (event: Record<string, any>) => boolean, ms = 10_000): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(20)) {
    if (!existsSync(tracePath)) continue;
    const lines = readFileSync(tracePath, "utf8").split("\n").filter((line) => line.trim() !== "");
    if (lines.some((line) => {
      try {
        return match(JSON.parse(line) as Record<string, any>);
      } catch {
        return false;
      }
    })) return true;
  }
  return false;
}
const isCall = (event: Record<string, any>) => event.type === "policy" && event.reason === "clause_check" && event.stage === "call";

type AgentStep = FauxStep | ((context: TranscriptContext, tracePath: string) => Promise<FauxStep>);
type SideStep = FauxStep | ((context: TranscriptContext, options: SimpleStreamOptions | undefined, tracePath: string) => Promise<FauxStep>);

interface Run {
  result: Awaited<ReturnType<typeof runHarness>>;
  events: Record<string, any>[];
  contexts: TranscriptContext[];
  /** Each side call as the provider got it: its context and the options it was sent with. */
  side: { context: TranscriptContext; reasoning: unknown; maxTokens: unknown }[];
  cwd: string;
  ms: number;
}

async function fauxRun(loadout: Loadout, steps: AgentStep[], side: SideStep[], options: {
  setup?: (cwd: string) => void; prompt?: string; effort?: Effort; budgets?: Budgets;
} = {}): Promise<Run> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-clause-")));
  options.setup?.(cwd);
  const env = new LocalEnv({ cwd });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-clause-trace-")), "trace.jsonl");
  const contexts: TranscriptContext[] = [];
  const seen: Run["side"] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => async (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(typeof step === "function" ? await step(context, tracePath) : step);
  });
  const sideScripted: FauxResponseStep[] = side.map((step) => async (context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined) => {
    seen.push({ context: structuredClone(context), reasoning: streamOptions?.reasoning, maxTokens: streamOptions?.maxTokens });
    return fauxStep(typeof step === "function" ? await step(context, streamOptions, tracePath) : step);
  });
  const started = performance.now();
  try {
    const result = await runHarness({
      prompt: options.prompt ?? TASK, model: "faux/clause", effort: options.effort ?? "high", loadout, env, tracePath, fauxSteps: scripted, clauseFauxSteps: sideScripted,
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts, side: seen, cwd, ms: performance.now() - started };
  } finally {
    await env.close();
  }
}

/** The core scenario: a change, a red check, a green one (the trigger), then the step after it, then whatever follows. */
const core = (after: AgentStep[]): AgentStep[] => [write("app.py", APP), bash("sh fail.sh"), bash("sh green.sh"), ...after];
/** The step after the trigger: waits until the side call's answer is in (so the note is ready), then runs `then`. */
const afterCall = (then: FauxStep): AgentStep => async (_context, tracePath) => {
  await traceHas(tracePath, isCall);
  return then;
};

test("the trigger: the side call starts at the first green after a red, never delays the tool result or the next request, and its note rides on the NEXT result", async () => {
  let nextSent!: () => void;
  const next = new Promise<void>((done) => (nextSent = done));
  let sawNext = false;
  const run = await fauxRun(clauseOn(), core([
    async (_context, tracePath) => {
      nextSent();
      await traceHas(tracePath, isCall);
      return bash("echo next");
    },
    { text: "Done." }, { text: "never sent" },
  ]), [async () => {
    // The side call answers only once the request after the green is out: a trigger that held the green's result would deadlock here.
    sawNext = await Promise.race([next.then(() => true), sleep(5_000).then(() => false)]);
    return { text: CLAUSES };
  }], { setup: scripts });
  assert.equal(sawNext, true, "the request after the green went out while the side call was open");
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.usage.requests, 5);
  assert.doesNotMatch(textOf(lastTool(run.contexts[2]!)), /\[harness\]/u, "the red carries nothing");
  assert.equal(textOf(lastTool(run.contexts[3]!)), "3 passed", "never on the result that triggered it");
  assert.equal(textOf(lastTool(run.contexts[4]!)), `next${reminder(NOTE)}`, "the next tool result carries the note");
  assert.deepEqual(clauseEvents(run.events), ["check:trigger", "check:call", "remind:"]);
  const trigger = run.events.find((event) => event.reason === "clause_check" && event.stage === "trigger")!;
  assert.deepEqual({ tool: trigger.tool, request: trigger.request, check: trigger.check }, { tool: "bash", request: 3, check: "sh green.sh" });
  const call = run.events.find(isCall)!;
  assert.deepEqual({ n: call.n, result: call.result, n_clauses: call.n_clauses, verbatim: call.verbatim, trigger_request: call.trigger_request, by: call.by, git: call.git, changes: call.changes },
    { n: 1, result: "clauses", n_clauses: 1, verbatim: 1, trigger_request: 3, by: "workspace", git: false, changes: { created: 1, modified: 0, deleted: 0 } });
  assert.ok(call.call_ms >= 0 && call.ms >= call.call_ms && call.output_tokens > 0 && call.cost_usd > 0);
  const delivered = run.events.find((event) => event.reason === "clause_check" && event.action === "remind")!;
  assert.deepEqual({ request: delivered.request, requests_later: delivered.requests_later, placebo: delivered.placebo, tool: delivered.tool, n_clauses: delivered.n_clauses },
    { request: 4, requests_later: 1, placebo: false, tool: "bash", n_clauses: 1 });
  // The side call: its own small context, the run's effort, no tools.
  assert.equal(run.side.length, 1);
  const side = run.side[0]!;
  const [system, ...rest] = side.context.messages;
  assert.equal(system?.role, "system");
  assert.equal(textOf(system), CLAUSE_PROMPT);
  assert.equal((system as { toolsAdded?: unknown[] }).toolsAdded?.length ?? 0, 0, "no tools");
  assert.deepEqual(rest.map((message) => message.role), ["user"], "one user message, nothing of the agent's transcript");
  const request = textOf(rest[0]);
  assert.ok(request.startsWith(`<task>\n${TASK}\n</task>`), request);
  assert.ok(request.includes("created  ") && request.includes("app.py"), "the change list");
  assert.ok(request.includes("+++ b/app.py (new file)\n+def greet(name):\n+    return f'Hello, {name.strip()}!'"), request);
  assert.ok(request.includes("<passing_check>\n$ sh green.sh\n3 passed\n</passing_check>"), request);
  assert.ok(!request.includes("fail.sh") || !request.includes("1 failed"), "not the red check's output");
  assert.equal(side.reasoning, "high", "the run's effort");
  assert.equal(side.maxTokens, 4000);
});

test("the side call runs at the run's own effort (its clamped thinking level), whatever it is", async () => {
  for (const [effort, level] of [["low", "low"], ["medium", "medium"], ["xhigh", "high"]] as const) {
    const run = await fauxRun(clauseOn(), core([afterCall(bash("echo next")), { text: "Done." }]), [{ text: "NONE" }], { setup: scripts, effort });
    assert.equal(run.side.length, 1, effort);
    assert.equal(run.result.thinking_level, level, `${effort}: the faux model clamps to ${level}`);
    assert.equal(run.side[0]!.reasoning, run.result.thinking_level, effort);
  }
});

test("trigger rules: a green with no red before it, or a red-to-green with nothing changed, makes no call; no_change does not use up max", async () => {
  const plain = await fauxRun(clauseOn(), [write("app.py", APP), bash("sh green.sh"), bash("echo next"), { text: "Done." }], [{ text: CLAUSES }], { setup: scripts });
  assert.deepEqual(clauseEvents(plain.events), []);
  assert.equal(plain.side.length, 0);
  assert.equal(plain.result.side_requests, undefined);
  const unchanged = await fauxRun(clauseOn(), [
    bash("sh fail.sh"), bash("sh green.sh"),
    async (_context, tracePath) => {
      await traceHas(tracePath, (event) => event.cause === "no_change");
      return bash("echo idle");
    },
    ...core([afterCall(bash("echo next")), { text: "Done." }]),
  ], [{ text: CLAUSES }], { setup: scripts });
  assert.deepEqual(clauseEvents(unchanged.events), ["check:trigger", "skip:no_change", "check:trigger", "check:call", "remind:"]);
  assert.deepEqual(unchanged.events.find((event) => event.cause === "no_change")?.changes, { created: 0, modified: 0, deleted: 0 });
  assert.equal(unchanged.side.length, 1);
  assert.equal(textOf(lastTool(unchanged.contexts[3]!)), "idle", "nothing rides on the result after a no_change trigger");
  assert.equal(textOf(lastTool(unchanged.contexts[7]!)), `next${reminder(NOTE)}`);
});

test("max: one call per run by default; max 2 audits the next red-to-green too", async () => {
  const steps = () => core([
    afterCall(bash("echo next")), edit("app.py", "name.strip()", "name.strip() or 'world'"), bash("sh fail.sh"), bash("sh green.sh"),
    async (_context: TranscriptContext, tracePath: string) => {
      await traceHas(tracePath, (event) => isCall(event) && event.n === 2, 1_500);
      return bash("echo last");
    },
    { text: "Done." },
  ]);
  const once = await fauxRun(clauseOn(), steps(), [{ text: CLAUSES }, { text: CLAUSES }], { setup: scripts });
  assert.equal(once.side.length, 1);
  assert.deepEqual(clauseEvents(once.events), ["check:trigger", "check:call", "remind:"]);
  assert.doesNotMatch(textOf(lastTool(once.contexts[8]!)), /\[harness\]/u);
  const twice = await fauxRun(clauseOn({ max: 2 }), steps(), [{ text: CLAUSES }, { text: "- \"returns 'Hello, <name>!'\"" }], { setup: scripts });
  assert.equal(twice.side.length, 2);
  assert.deepEqual(clauseEvents(twice.events), ["check:trigger", "check:call", "remind:", "check:trigger", "check:call", "remind:"]);
  assert.equal(textOf(lastTool(twice.contexts[8]!)), `last${reminder(LEVER_TEXTS.clause_check.replace("{clauses}", "- \"returns 'Hello, <name>!'\""))}`);
  assert.deepEqual(twice.events.filter(isCall).map((event) => [event.n, event.changes]), [[1, { created: 1, modified: 0, deleted: 0 }], [2, { created: 1, modified: 0, deleted: 0 }]]);
});

test("one audit at a time: a trigger while one runs waits for it, then runs (max 2); a finish attempt in between drops it", async () => {
  const second = (then: AgentStep[]) => core([
    edit("app.py", "name.strip()", "name.strip() or 'world'"), bash("sh fail.sh"), bash("sh green.sh"), ...then,
  ]);
  // The first call answers only once the second trigger is queued behind it.
  const firstWaits: SideStep = async (_context, _options, tracePath) => {
    await traceHas(tracePath, (event) => event.stage === "trigger" && event.queued === true);
    return { text: CLAUSES };
  };
  const run = await fauxRun(clauseOn({ max: 2 }), second([
    async (_context, tracePath) => {
      await traceHas(tracePath, (event) => isCall(event) && event.n === 2);
      return bash("echo next");
    },
    bash("echo more"), { text: "Done." },
  ]), [firstWaits, { text: "NONE" }], { setup: scripts });
  assert.equal(run.side.length, 2);
  assert.deepEqual(clauseEvents(run.events), ["check:trigger", "check:trigger", "check:call", "check:call", "remind:"]);
  const [first, queued] = run.events.filter((event) => event.stage === "trigger");
  assert.deepEqual([first!.request, queued!.request, queued!.queued], [3, 6, true]);
  assert.deepEqual(run.events.filter(isCall).map((event) => [event.n, event.trigger_request, event.result]), [[1, 3, "clauses"], [2, 6, "none"]]);
  assert.doesNotMatch(textOf(lastTool(run.contexts[6]!)), /\[harness\]/u, "not on the green that queued the second trigger");
  assert.equal(textOf(lastTool(run.contexts[7]!)), `next${reminder(NOTE)}`, "the first call's note rides on the next result after it returned");
  // A finish attempt while the trigger waits: dropped, never run.
  const dropped = await fauxRun(clauseOn({ max: 2 }, { extra: (raw) => (raw.policy.finish_audit = true) }), second([
    { text: "Done." },
    async (_context, tracePath) => {
      await traceHas(tracePath, (event) => event.stage === "queued");
      return { text: "Done again." };
    },
  ]), [async (_context, _options, tracePath) => {
    await traceHas(tracePath, (event) => event.action === "continue" && event.reason === "finish_audit");
    return { text: CLAUSES };
  }, { text: "NONE" }], { setup: scripts });
  assert.equal(dropped.side.length, 1);
  assert.deepEqual(clauseEvents(dropped.events), ["check:trigger", "check:trigger", "check:call", "skip:finished_first", "skip:queued"]);
  assert.deepEqual([dropped.events.find((event) => event.stage === "queued")?.trigger_request, dropped.events.find((event) => event.stage === "queued")?.cause], [6, "finished_first"]);
});

test("the queue, step by step (a stub env whose change summary the test releases): a trigger behind a no_change audit runs; one behind a call that used up max is dropped", async () => {
  const summary = (created: number) => `critic_n_created=${created}\ncritic_n_modified=0\ncritic_n_deleted=0\n@@critic-list@@\n${created > 0 ? "created 6 ./a.py\n" : ""}`;
  const harness = (max: number) => {
    const gates: ((output: string) => void)[] = [];
    const events: string[] = [];
    let calls = 0;
    const env = {
      id: "stub", cwd: "/w", scratchDir: async () => "/s", resolvePath: (path: string) => (path.startsWith("/") ? path : `/w/${path}`),
      readFile: async () => new TextEncoder().encode("x = 1\n"),
      exec: (command: string) => command.includes("critic_files=")
        ? Promise.resolve({ exitCode: 0, output: "critic_files=0\n", truncated: false, durationMs: 1, totalBytes: 1, running: false })
        : new Promise((resolve) => gates.push((output) => resolve({ exitCode: 0, output, truncated: false, durationMs: 1, totalBytes: 1, running: false }))),
    };
    const recorder = {
      usage: { requests: 3 }, sideRequest: () => {},
      policy: (action: string, reason: string, fields: Record<string, unknown> = {}) => events.push(`${action}:${reason}:${String(fields.stage ?? fields.cause ?? "")}${fields.cause !== undefined && fields.stage !== undefined ? `:${String(fields.cause)}` : ""}`),
    };
    const clause = new ClauseCheck({
      lever: { ...clauseOn({ max }).policy.clause_check! }, placebo: false, env: env as never, recorder: recorder as never, task: TASK,
      call: async () => {
        calls++;
        return fauxStep({ text: CLAUSES });
      },
      reasoning: "high", cost: () => 0,
    });
    const check = (cmd: string) => ({ tool: "bash", cmd, output: "3 passed", changedByTools: true });
    return { clause, gates, events, calls: () => calls, check };
  };
  const settle = () => sleep(30);
  // Behind a no_change audit: the queued trigger runs when it ends.
  const a = harness(1);
  await a.clause.begin();
  a.clause.trigger(a.check("sh one.sh"));
  a.clause.trigger(a.check("sh two.sh"));
  await settle();
  a.gates.shift()!(summary(0));
  await settle();
  assert.equal(a.gates.length, 1, "the queued audit reads the changes");
  a.gates.shift()!(summary(1));
  await settle();
  assert.equal(a.calls(), 1);
  assert.deepEqual(a.events, ["check:clause_check:trigger", "check:clause_check:trigger", "skip:clause_check:no_change", "check:clause_check:call"]);
  assert.equal(a.clause.take("bash"), NOTE);
  // Behind a call that used up max 1: dropped (cause max), never a second call.
  const b = harness(1);
  await b.clause.begin();
  b.clause.trigger(b.check("sh one.sh"));
  b.clause.trigger(b.check("sh two.sh"));
  await settle();
  b.gates.shift()!(summary(1));
  await settle();
  assert.equal(b.calls(), 1);
  assert.equal(b.gates.length, 0);
  assert.deepEqual(b.events, ["check:clause_check:trigger", "check:clause_check:trigger", "check:clause_check:call", "skip:clause_check:queued:max"]);
  // After max is used up a trigger records nothing; close drops a waiting note.
  b.clause.trigger(b.check("sh three.sh"));
  await b.clause.close();
  assert.deepEqual(b.events.slice(4), ["skip:clause_check:run_ended"]);
});

test("with first_green on: the reminder rides on the green result, the clause note on the next one; first_green alone makes no side call", async () => {
  const both = await fauxRun(clauseOn(true, { extra: (raw) => (raw.policy.first_green = true) }), core([afterCall(bash("echo next")), { text: "Done." }]), [{ text: CLAUSES }], { setup: scripts });
  assert.equal(textOf(lastTool(both.contexts[3]!)), `3 passed${reminder(LEVER_TEXTS.first_green)}`);
  assert.equal(textOf(lastTool(both.contexts[4]!)), `next${reminder(NOTE)}`);
  assert.deepEqual(policyEvents(both.events).filter((event) => event !== "check:clause_check"), ["remind:first_green", "remind:clause_check"]);
  const green = await fauxRun(withLevers((raw) => (raw.policy.first_green = true)), core([bash("echo next"), { text: "Done." }]), [{ text: CLAUSES }], { setup: scripts });
  assert.equal(green.side.length, 0);
  assert.deepEqual(policyEvents(green.events), ["remind:first_green"]);
});

test("NONE (or an answer that is not a list, or one the output cap cut before any) gives no note", async () => {
  const answers: [FauxStep, string][] = [
    [{ text: "NONE" }, "none"], [{ text: "Everything the task states is handled." }, "unparsed"], [{ thinking: "long reasoning", stopReason: "length" }, "cut"],
  ];
  for (const [answer, result] of answers) {
    const run = await fauxRun(clauseOn(), core([afterCall(bash("echo next")), bash("echo more"), { text: "Done." }]), [answer], { setup: scripts });
    assert.equal(run.result.usage.requests, 6, result);
    assert.equal(run.events.find(isCall)?.result, result);
    assert.deepEqual(clauseEvents(run.events), ["check:trigger", "check:call"], result);
    for (const context of run.contexts) assert.ok(!JSON.stringify(context).includes("independent reading"), result);
  }
});

test("dropped: a note ready at a finish attempt, an answer that comes back after one, and a call still running when the run ends", async () => {
  // Ready, then the agent finishes instead of calling a tool: the note never reaches it.
  const ready = await fauxRun(clauseOn(), core([afterCall({ text: "Done." }), { text: "never sent" }]), [{ text: CLAUSES }], { setup: scripts });
  assert.equal(ready.result.usage.requests, 4);
  assert.deepEqual(clauseEvents(ready.events), ["check:trigger", "check:call", "skip:finished_first"]);
  assert.equal(ready.events.find((event) => event.cause === "finished_first")?.n_clauses, 1);
  // The answer comes back after a finish attempt that another lever continued: dropped, never on a later result.
  const audited = await fauxRun(clauseOn(true, { extra: (raw) => (raw.policy.finish_audit = true) }), core([
    { text: "Done." },
    async (_context, tracePath) => {
      await traceHas(tracePath, (event) => event.cause === "finished_first");
      return bash("echo after");
    },
    { text: "Done again." },
  ]), [async (_context, _options, tracePath) => {
    await traceHas(tracePath, (event) => event.action === "continue" && event.reason === "finish_audit");
    return { text: CLAUSES };
  }], { setup: scripts });
  assert.equal(audited.result.usage.requests, 6);
  assert.deepEqual(clauseEvents(audited.events), ["check:trigger", "check:call", "skip:finished_first"]);
  assert.equal(textOf(lastTool(audited.contexts[5]!)), "after");
  // Still running when the run ends: aborted, counted, no note, and the run did not wait for it.
  let sideStarted!: () => void;
  const started = new Promise<void>((done) => (sideStarted = done));
  const running = await fauxRun(clauseOn(), core([async () => {
    await Promise.race([started, sleep(5_000)]);
    return { text: "Done." };
  }, { text: "never sent" }]), [async (_context, options) => {
    sideStarted();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted === true) resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return { text: CLAUSES };
  }], { setup: scripts });
  assert.equal(running.result.status, "finished");
  assert.equal(running.result.usage.requests, 4);
  assert.ok(running.ms < 20_000);
  assert.equal(running.result.side_requests?.clause_check?.requests, 1);
  const call = running.events.find(isCall)!;
  assert.ok(["aborted", "error"].includes(call.result), call.result);
  assert.ok(!running.events.some((event) => event.reason === "clause_check" && event.action === "remind"));
});

test("the placebo: the same trigger, call and timing, and neutral text of the note's estimated token count", async () => {
  const run = await fauxRun(clauseOn(true, { placebo: true }), core([afterCall(bash("echo next")), { text: "Done." }]), [{ text: CLAUSES }], { setup: scripts });
  const sent = textOf(lastTool(run.contexts[4]!));
  assert.ok(sent.startsWith("next\n[harness] "));
  const note = sent.slice("next\n[harness] ".length);
  assert.equal(note, placeboFor("clause_check", NOTE));
  assert.equal(estimateTokens(note), estimateTokens(NOTE));
  assert.doesNotMatch(note, /\b(?:clause|task|check|fix|finish|empty|Hello)\w*/iu);
  assert.equal(run.side.length, 1, "the same side call");
  assert.deepEqual(clauseEvents(run.events), ["check:trigger", "check:call", "remind:"]);
  assert.equal(run.events.find((event) => event.action === "remind")?.placebo, true);
  const none = await fauxRun(clauseOn(true, { placebo: true }), core([afterCall(bash("echo next")), { text: "Done." }]), [{ text: "NONE" }], { setup: scripts });
  assert.equal(textOf(lastTool(none.contexts[4]!)), "next", "NONE: no placebo note either");
});

test("cost: the side call's tokens and USD are in usage and cost_usd and in side_requests.clause_check; requests stay the agent loop's", async () => {
  const run = await fauxRun(clauseOn(), core([afterCall(bash("echo next")), { text: "Done." }]), [{ text: CLAUSES }], { setup: scripts });
  const loop = run.events.filter((event) => event.type === "request_end");
  const side = run.events.filter((event) => event.type === "side_request");
  assert.equal(side.length, 1);
  assert.equal(side[0]!.kind, "clause_check");
  const sum = (key: string, events: Record<string, any>[]) => events.reduce((total, event) => total + event.usage[key], 0);
  assert.equal(run.result.usage.requests, loop.length);
  assert.equal(run.result.usage.output_tokens, sum("output", loop) + sum("output", side));
  assert.equal(run.result.usage.input_tokens, sum("input", loop) + sum("input", side));
  const loopCost = loop.reduce((total, event) => total + event.cost_usd, 0);
  assert.ok(side[0]!.cost_usd > 0);
  assert.ok(Math.abs(run.result.cost_usd! - (loopCost + side[0]!.cost_usd)) < 1e-6);
  assert.equal(run.result.side_requests?.clause_check?.requests, 1);
  const call = run.events.find(isCall)!;
  assert.equal(call.output_tokens, side[0]!.usage.output);
  assert.ok(Math.abs(call.cost_usd - side[0]!.cost_usd) < 1e-6);
});

test("the changes: a git repo's diff against the start commit plus the created files; without git the lines the edits added", async () => {
  const lib = "def answer():\n    return 1\n";
  const steps = () => [
    edit("lib.py", "return 1", "return 2"), write("new_test.py", "from lib import answer\nassert answer() == 2\n"), bash("sh fail.sh"), bash("sh green.sh"),
    afterCall(bash("echo next")), { text: "Done." },
  ];
  const repo = await fauxRun(clauseOn(), steps(), [{ text: "NONE" }], {
    setup: (cwd) => {
      scripts(cwd);
      writeFileSync(join(cwd, "lib.py"), lib);
      const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
      git("init", "-q");
      git("add", ".");
      git("commit", "-q", "-m", "start");
    },
  });
  const inRepo = textOf(repo.side[0]!.context.messages.find((message) => message.role === "user"));
  assert.ok(inRepo.includes("git diff of the modified and deleted files against the starting commit:\ndiff --git a/lib.py b/lib.py"), inRepo);
  assert.ok(inRepo.includes("-    return 1\n+    return 2"), inRepo);
  assert.ok(inRepo.includes("+++ b/new_test.py (new file)\n+from lib import answer"), inRepo);
  assert.ok(!inRepo.includes("lines your edits added"), "the diff covers lib.py");
  assert.deepEqual([repo.events.find(isCall)?.git, repo.events.find(isCall)?.changes], [true, { created: 1, modified: 1, deleted: 0 }]);
  const plain = await fauxRun(clauseOn(), steps(), [{ text: "NONE" }], {
    setup: (cwd) => {
      scripts(cwd);
      writeFileSync(join(cwd, "lib.py"), lib);
    },
  });
  const noRepo = textOf(plain.side[0]!.context.messages.find((message) => message.role === "user"));
  // compact `edit`: the lines of its new text that its old text lacked (here a fragment); exec apply_patch records whole lines.
  assert.ok(noRepo.includes("+++ b/lib.py (lines your edits added; no starting copy to diff against)\n+return 2"), noRepo);
  assert.ok(!noRepo.includes("-    return 1") && !noRepo.includes("git diff"), noRepo);
  assert.ok(noRepo.includes("+++ b/new_test.py (new file)"));
  assert.deepEqual([plain.events.find(isCall)?.git, plain.events.find(isCall)?.changes], [false, { created: 1, modified: 1, deleted: 0 }]);
});

test("the changes are capped at diff_bytes; binary files are left out", async () => {
  const big = Array.from({ length: 2000 }, (_, i) => `row_${i} = ${i}`).join("\n");
  const run = await fauxRun(clauseOn({ diff_bytes: 1500 }), [
    write("app.py", APP), write("table.py", big), write("blob.png", "\u0000PNG"), bash("sh fail.sh"), bash("sh green.sh"), afterCall(bash("echo next")), { text: "Done." },
  ], [{ text: "NONE" }], { setup: scripts });
  const request = textOf(run.side[0]!.context.messages.find((message) => message.role === "user"));
  const changes = request.slice(request.indexOf("<changes>"), request.indexOf("</changes>"));
  const body = changes.slice(changes.indexOf("--- /dev/null"));
  assert.ok(Buffer.byteLength(body) <= 1500, `${Buffer.byteLength(body)} bytes`);
  assert.ok(body.includes("+++ b/app.py (new file)\n+def greet(name):\n+    return f'Hello, {name.strip()}!'"), "the small file stays whole");
  assert.ok(body.includes("+++ b/table.py (new file)") && body.includes("[... cut]"));
  assert.ok(changes.includes("blob.png") && !body.includes("blob.png"), "listed, never shown");
  assert.equal(run.events.find(isCall)?.changes_cut, true);
});

// ---------- over the wire ----------

test("over the wire (exec-v0-clause): the side call goes to the run's own base URL at the run's effort with no tools; its note rides on the next exec result", async () => {
  const bodies: Body[] = [];
  const sideBodies: Body[] = [];
  const patch = (path: string, line: string) => `*** Begin Patch\n*** Add File: ${path}\n+${line}\n*** End Patch\n`;
  const steps: Step[] = [
    { exec: `await tools.apply_patch(${JSON.stringify(patch("check.sh", "grep -q ok a.txt && echo 'all passed' || { echo '1 failed'; exit 1; }"))}); text("written");` },
    { exec: 'const r = await tools.exec_command({ cmd: "sh check.sh" }); text(JSON.stringify(r));' },
    { exec: `await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+ok\n*** End Patch\n")}); text("fixed");` },
    { exec: 'const r = await tools.exec_command({ cmd: "sh check.sh" }); text(JSON.stringify(r));' },
    { exec: 'text("next");' },
    { text: "Done." },
  ];
  let sideAnswered!: () => void;
  const answered = new Promise<void>((done) => (sideAnswered = done));
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", async () => {
      const body = JSON.parse(raw) as Body;
      const side = JSON.stringify(body).includes("You compare a software task");
      if (side) sideBodies.push(body);
      else bodies.push(body);
      // The request after the green waits for the side call's answer (and a beat to parse it), so the note is ready for its result.
      if (!side && bodies.length === 5) await Promise.race([answered.then(() => sleep(300)), sleep(10_000)]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const step: Step = side ? { text: "- \"a.txt must contain ok\"" } : steps[bodies.length - 1] ?? { text: "Done." };
      res.end(eventsOf(step, side ? 900 : bodies.length).map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""));
      if (side) sideAnswered();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-clause-wire-")));
  writeFileSync(join(cwd, "a.txt"), "x\n");
  const env = new LocalEnv({ cwd });
  process.env.LOOPBACK_KEY = "sk-test";
  try {
    const loadout = readLoadout(join(loadoutDir, "exec-v0-clause.json")).loadout;
    const task = "Make a.txt contain ok, and a.txt must contain ok.";
    const result = await runHarness({
      prompt: task, model: "openai/gpt-6.1-sol", effort: "high", loadout, env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LOOPBACK_KEY" },
    });
    assert.equal(result.status, "finished");
    assert.equal(bodies.length, 6);
    assert.equal(sideBodies.length, 1, "one side call, to the run's own base URL");
    const side = sideBodies[0]!;
    assert.equal(side.model, "gpt-6.1-sol");
    assert.deepEqual(bodies.map((body) => body.reasoning?.effort), ["high", "high", "high", "high", "high", "high"]);
    assert.equal(side.reasoning?.effort, "high", "the run's effort");
    assert.equal(side.tools, undefined);
    assert.equal(side.max_output_tokens, 4000);
    assert.notEqual(side.prompt_cache_key, bodies[0]!.prompt_cache_key, "its own cache key");
    const sideText = JSON.stringify(side);
    assert.ok(sideText.includes("Make a.txt contain ok") && sideText.includes("all passed") && sideText.includes("+ok"), sideText);
    assert.ok(!sideText.includes("custom_tool_call"), "nothing of the agent's transcript");
    const outputs = (body: Body): string[] => body.input.filter((item: any) => item.type?.endsWith("call_output")).map((item: any) => JSON.stringify(item.output));
    const note = LEVER_TEXTS.clause_check.replace("{clauses}", "- \"a.txt must contain ok\"");
    assert.ok(!outputs(bodies[4]!).at(-1)!.includes("[harness]"), "the green's own result carries nothing");
    const last = outputs(bodies[5]!).at(-1)!;
    assert.ok(last.includes(JSON.stringify(note).slice(1, -1)), last);
    assert.equal(result.side_requests?.clause_check?.requests, 1);
    assert.equal(result.usage.input_tokens, 700, "6 agent requests and the side call at 100 input tokens each");
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
});
