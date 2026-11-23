/**
 * policy.thin_margin (src/thin-margin.ts, src/levers.ts): off by default and
 * hashed as before, fail-closed settings; the task's thresholds (bounds,
 * units, speedup and aggregate targets, subjects, what is not one); the
 * output lines (records decoded, harness lines dropped); the pass rule
 * (comparison, threshold that follows, pass marker with the label's subject)
 * and what never fires (other side, wide margin, fail marker, code, ids,
 * counts, percentile labels, an ambiguous or foreign label); the speedup rule
 * (aggregate lines, factor); max and the trace; and in a faux run on the exec
 * surface (LocalEnv): the note on the cell result, read from the printed text
 * or the ledger, once; the placebo. Offline; no model calls.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import { estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness } from "../src/run.ts";
import { outputLines, quantities, taskThresholds, thinHit, ThinMargin, type MarginOptions } from "../src/thin-margin.ts";

const base = (name = "exec-v0") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  raw.policy ??= {};
  patch(raw);
  return normalizeLoadout(raw);
};

// ---------- loadout ----------

test("thin_margin is off by default: absent or false hashes like the built-in; true is max 1, margin 10%, speedup factor 2, the default text", () => {
  for (const name of ["exec-v0", "compact-v0-plain"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(loadoutHash(withLevers((raw) => (raw.policy.thin_margin = false), name)), loadoutHash(plain), name);
    assert.equal(plain.policy.thin_margin, undefined);
  }
  const on = withLevers((raw) => (raw.policy.thin_margin = true));
  assert.deepEqual(on.policy.thin_margin, { max: 1, margin_pct: 10, speedup_factor: 2, text: LEVER_TEXTS.thin_margin });
  const some = withLevers((raw) => (raw.policy.thin_margin = { max: 2, margin_pct: 7.5, speedup_factor: 3 }));
  assert.deepEqual([some.policy.thin_margin?.max, some.policy.thin_margin?.margin_pct, some.policy.thin_margin?.speedup_factor], [2, 7.5, 3]);
  assert.notEqual(loadoutHash(withLevers((raw) => (raw.policy.thin_margin = { text: "Thin: {measured} / {threshold}." }))), loadoutHash(on));
  assert.equal(withLevers((raw) => {
    raw.policy.thin_margin = true;
    raw.policy.thin_margin_placebo = true;
  }).policy.thin_margin_placebo, true);
});

test("thin_margin settings fail closed: unknown keys, max 0, margin 0 or over 100, a speedup factor of 1, a missing placeholder, a placebo with nothing to replace", () => {
  const bad: [(raw: Record<string, any>) => void, RegExp][] = [
    [(raw) => (raw.policy.thin_margin = { kinds: ["x"] }), /invalid/u],
    [(raw) => (raw.policy.thin_margin = { max: 0 }), /invalid/u],
    [(raw) => (raw.policy.thin_margin = { margin_pct: 0 }), /invalid/u],
    [(raw) => (raw.policy.thin_margin = { margin_pct: 101 }), /invalid/u],
    [(raw) => (raw.policy.thin_margin = { speedup_factor: 1 }), /invalid/u],
    [(raw) => (raw.policy.thin_margin = { text: "Thin: {measured}." }), /needs a \{threshold\}/u],
    [(raw) => (raw.policy.thin_margin = { text: "Thin against {threshold}." }), /needs a \{measured\}/u],
    [(raw) => (raw.policy.thin_margin_placebo = true), /thin_margin_placebo needs/u],
  ];
  for (const [patch, message] of bad) assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message));
});

// ---------- the task's thresholds ----------

/** biped-contact-dynamics' requirement sentences, abridged. */
const BIPED = [
  "Each invocation of your submitted generator must complete within 1200 seconds.",
  "`u` has shape `(K, 4)` and all entries must stay within ±500.",
  "The verifier excludes the first and last 3 samples and a margin of 5 samples on each side of contact-mode transitions, then applies 95th-percentile checks.",
  "Velocities must integrate to positions with a trapezoidal residual below `0.005`; the center-of-mass force-balance residual must remain below `100 N`; " +
    "the contact-force rate must remain below `8000 N/s`; and the actuator-torque rate must remain below `3500 N·m/s`.",
  "Stance feet must stay on the ground, swing feet must reach more than `0.12 m` of clearance during the corresponding single-support phases.",
  "In the interior of the flight phase, both feet should have a visible airborne clearance of 6 cm or more, not merely zero contact force.",
  "The trajectory must contain at least one contiguous `FLIGHT` (mode `3`) block of 25 or more samples.",
  "You have 28800 seconds to complete this task.",
].join("\n");
const VF2 = "The speed gate times `vf2pp_is_isomorphic` on hidden fixed-seed random 5-regular graph pairs with 300 nodes, against NetworkX 3.4.2. " +
  "The geometric mean of the per-case speedup ratios must be at least 5000x faster than NetworkX.";

test("task thresholds: each bound with its unit and passing side; the budget sentence, counts, compounds, versions and examples after an arrow are none", () => {
  const found = taskThresholds(BIPED).map((t) => [t.raw, t.bound, t.unit ?? null, t.base ?? null]);
  assert.deepEqual(found, [
    ["1200 seconds", "max", "s", 1200], ["500", "max", null, null], ["0.005", "max", null, null], ["100 N", "max", "N", null], ["8000 N/s", "max", "N/s", null],
    ["3500 N·m/s", "max", "N·m/s", null], ["0.12 m", "min", "m", 0.12], ["6 cm", "min", "cm", 0.06], ["25", "min", null, null],
  ]);
  const [speed, ...rest] = taskThresholds(VF2);
  assert.deepEqual(rest, []);
  assert.deepEqual([speed!.raw, speed!.bound, speed!.speedup, speed!.aggregate], ["5000x", "min", true, true]);
  assert.deepEqual(taskThresholds("Output a `<20-nt ACGT string>` and the 3-nt PAM. Example: `a[99 : 101 : 2]` -> `(a[99:101:2])`."), []);
  const accuracy = taskThresholds("Reach an accuracy of 0.95 on the held-out set. The model must be at least 3 times faster than the baseline.");
  assert.deepEqual(accuracy.map((t) => [t.raw, t.bound, t.speedup, t.aggregate]), [["0.95", "any", false, false], ["3 times", "min", true, false]]);
  const clearance = taskThresholds(BIPED).find((t) => t.raw === "6 cm")!;
  assert.ok(clearance.subject.includes("clear") && clearance.subject.includes("fligh"), clearance.subject.join(","));
});

test("quantities: units, ids and compounds as written", () => {
  const shown = (text: string) => quantities(text).map((q) => [q.raw, q.unit ?? null, q.compound]);
  assert.deepEqual(shown("12,588x in 3.2s for 6 cm, 95%, 1.5e-4 and 238.53us"), [
    ["12,588x", "x", false], ["3.2s", "s", false], ["6 cm", "cm", false], ["95%", "%", false], ["1.5e-4", null, false], ["238.53us", "us", false],
  ]);
  assert.deepEqual(shown("LOT-00023 v2 python3 3.4.2 5-regular"), [["5", null, true]]);
});

// ---------- the output ----------

test("output lines: exec_command records a cell printed are decoded, harness lines dropped, each line once", () => {
  const cell = "Script completed\nWall time 0.7 seconds\nOutput:\n" +
    `${JSON.stringify({ chunk_id: "66981e", wall_time_seconds: 0.6, exit_code: 0, output: "clearance 0.0628 OK\nsecond line\n" })}{"chunk_id":"a","output":"clearance 0.0628 OK\\n"}`;
  assert.deepEqual(outputLines([cell, "[harness] Note: something 0.0601", "second line"]), ["clearance 0.0628 OK", "second line"]);
});

// ---------- the pass rule ----------

const DEFAULTS: MarginOptions = { marginPct: 10, speedupFactor: 2 };
const hit = (lines: string[], task = BIPED, options: Partial<MarginOptions> = {}) => {
  const found = thinHit(lines, taskThresholds(task), { ...DEFAULTS, ...options });
  return found === undefined ? undefined : `${found.rule} ${found.measured} vs ${found.threshold}`;
};

test("pass rule fires: a comparison with the task's number, the number following the measurement, a pass marker with the label's subject", () => {
  assert.equal(hit(["flight interior clearance min 0.0628 >= 0.06"]), "pass 0.0628 vs 6 cm");
  assert.equal(hit(["check: 0.0628 (>= 0.06)"]), "pass 0.0628 vs 6 cm");
  assert.equal(hit(["torque rate 3181.635732 limit 3500"]), "pass 3182 vs 3500 N·m/s");
  assert.equal(hit(["OK swing clearance min 0.1205"]), "pass 0.1205 vs 0.12 m");
  // The label names the flight clearance best (interior, flight, clearance): 0.1205 is far from its 6 cm.
  assert.equal(hit(["OK flight interior clearance min 0.1205"]), undefined);
  assert.equal(hit(["jump PASS {'integration': 0.000268, 'com_balance': 16.6, 'force_rate': 7884.04, 'torque_rate': 2807.17}"]), "pass 7884.04 vs 8000 N/s");
  assert.equal(hit(["run: PASS K=171, dx=1.208, integration95=0.004585, ID95=1.985"]), "pass 0.004585 vs 0.005");
  assert.equal(hit(["generator finished in 1150.2 s, within limit: True"]), "pass 1150.2 s vs 1200 seconds");
  // The thinnest of several.
  assert.equal(hit(["force rate 7334.2 limit 8000", "torque rate 3495.04 / 3500 PASS"]), "pass 3495.04 vs 3500 N·m/s");
});

test("pass rule never: the other side, a wide margin, a fail marker, code, an unlabeled or foreign or ambiguous label, ids, counts, percentile labels, dates", () => {
  const silent = [
    "flight interior clearance min 0.0596 >= 0.06",
    "flight clearance min 0.0596 OK",
    "flight clearance min 0.0750 OK",
    "flight clearance min 0.0628 FAIL",
    "flight clearance 0.0628: False",
    "    if clearance >= 0.06: print('flight clearance', 0.0628)",
    "# clearance must be >= 0.06; we keep 0.0628",
    "assert min_clear >= 0.0628",
    "print(f'clearance {c:.4f}', flush=True)",
    "flight 0.0628 OK",
    "PASS {'base_dynamics': 0.0628, 'stance': 0.0012}",
    "jump PASS {'frate': 3343.3394, 'urate': 864.7}",
    "PASS rates=3155.2/6110.1",
    "{'lot_id': 'LOT-00023', 'iqc_status': 'PASS'}",
    "flight 27 52 count 25 clearance interior min 0.0994",
    "COM force residual 95      0.00059231 (limit 100)",
    "2026-11-01 11:58:00 force rate OK",
    "========================= 9 passed in 1150.31s =========================",
    "0 1.2397909e-02 2.76e-04 6.24e-03 -7.8 4.10e+01 - 4.41e-02 1.41e-01h 1",
    "PART-0030,PRESS-SW-30,Pressure switch 30,28.95,TRUE,TRUE",
  ];
  for (const line of silent) assert.equal(hit([line]), undefined, line);
  // "0 failed" is no failure.
  assert.equal(hit(["walk: 12 passed, 0 failed; flight clearance min 0.0628 OK"]), "pass 0.0628 vs 6 cm");
  // No thresholds in the task: never.
  assert.equal(hit(["flight clearance min 0.0628 OK"], "Fix the parser."), undefined);
});

test("margin_pct widens the window; an `any` threshold passes on either side", () => {
  assert.equal(hit(["flight clearance min 0.0700 OK"]), undefined);
  assert.equal(hit(["flight clearance min 0.0700 OK"], BIPED, { marginPct: 20 }), "pass 0.0700 vs 6 cm");
  const task = "Reach an accuracy of 0.95 on the held-out set.";
  assert.equal(hit(["held-out accuracy 0.957 PASS"], task), "pass 0.957 vs 0.95");
  assert.equal(hit(["held-out accuracy 95.7% PASS"], task), "pass 95.7% vs 0.95");
});

// ---------- the speedup rule ----------

test("speedup rule: an aggregate target fires on an aggregate line under factor x target; per-case lines only in the shadow; FAIL never", () => {
  assert.equal(hit(["Geometric mean speedup: 7,282x"], VF2), "speedup 7,282x vs 5000x");
  assert.equal(hit(["geomean 9864.2"], VF2), "speedup 9864.2 vs 5000x");
  assert.equal(hit(["Geometric mean speedup: 12,588x"], VF2), undefined);
  assert.equal(hit(["Geometric mean speedup: 12,588x"], VF2, { speedupFactor: 3 }), "speedup 12,588x vs 5000x");
  assert.equal(hit(["Geometric mean speedup: 4,993x"], VF2), undefined);
  assert.equal(hit(["Geometric mean speedup: 7,282x FAIL"], VF2), undefined);
  const perCase = "seed=2 isomorphic NX= 1.157s fast(cold)= 229.03us cold speedup=5,053x";
  assert.equal(hit([perCase], VF2), undefined);
  assert.equal(hit([perCase], VF2, { perCase: true }), "speedup 5,053x vs 5000x");
  // A target without an aggregate: any speedup line.
  assert.equal(hit(["speedup 3.4x"], "The new build must be at least 3 times faster than the baseline."), "speedup 3.4x vs 3 times");
});

// ---------- the lever ----------

function lever(options: { task?: string; max?: number; placebo?: boolean } = {}) {
  const events: [string, string, Record<string, unknown>][] = [];
  const recorder = { usage: { requests: 4 } as never, policy: (action: string, reason: string, fields: Record<string, unknown> = {}) => void events.push([action, reason, fields]) };
  const margin = new ThinMargin({
    lever: { max: options.max ?? 1, margin_pct: 10, speedup_factor: 2, text: LEVER_TEXTS.thin_margin }, placebo: options.placebo ?? false, recorder, task: options.task ?? BIPED,
  });
  return { margin, events };
}
const NOTE = LEVER_TEXTS.thin_margin.replace("{measured}", "0.0628").replace("{threshold}", "6 cm");

test("the lever: one note per run (max), the rest recorded as skipped; output tools only, ledger outputs read; no thresholds, nothing", () => {
  const { margin, events } = lever();
  assert.deepEqual(margin.afterTool("read", undefined, "flight clearance min 0.0628 OK"), []);
  assert.deepEqual(margin.afterTool("exec", { log: [{ kind: "command", cmd: "python check.py", exitCode: 0, output: "flight clearance min 0.0628 OK\n" }] }, "Script completed\nOutput:\n0"), [NOTE]);
  assert.deepEqual(margin.afterTool("exec", undefined, "force rate 7334.2 limit 8000"), []);
  assert.deepEqual(margin.afterTool("exec", undefined, "force rate 7334.2 limit 8000"), []);
  assert.deepEqual(events.map(([action, reason, fields]) => [action, reason, fields.rule, fields.measured, fields.threshold, fields.margin_pct, fields.tool, fields.request, fields.cause]), [
    ["remind", "thin_margin", "pass", "0.0628", "6 cm", 4.7, "exec", 4, undefined],
    ["skip", "thin_margin", "pass", "7334.2", "8000 N/s", 8.3, "exec", 4, "max"],
  ]);
  const none = lever({ task: "Fix the parser." });
  assert.deepEqual(none.margin.thresholds, []);
  assert.deepEqual(none.margin.afterTool("exec", undefined, "flight clearance min 0.0628 OK"), []);
  assert.deepEqual(none.events, []);
});

// ---------- in a run ----------

async function fauxRun(loadout: Loadout, steps: FauxStep[], prompt = BIPED) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-margin-")));
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(step);
  });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-margin-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({ prompt, model: "faux/margin", effort: "high", loadout, env, tracePath, fauxSteps: scripted });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts };
  } finally {
    await env.close();
  }
}

const cell = (script: string): FauxStep => ({ toolCalls: [{ name: "exec", arguments: { input: script } }] });
const echo = (line: string, print = true) => cell(`const r = await tools.exec_command({ cmd: ${JSON.stringify(`echo '${line}'`)} }); text(${print ? "r" : "String(r.exit_code)"});`);
const textOf = (message: { content: unknown }) => typeof message.content === "string" ? message.content
  : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastResult = (context: TranscriptContext) => textOf([...context.messages].reverse().find((message) => message.role === "toolResult")!);
const marginEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy" && event.reason === "thin_margin");

test("in a run: the note rides on the cell result that printed the thin pass, once; a later one is skipped; off, nothing changes", async () => {
  const loadout = withLevers((raw) => (raw.policy.thin_margin = true));
  const run = await fauxRun(loadout, [echo("all good: torque max 401.2"), echo("flight clearance min 0.0628 OK"), echo("force rate 7334.2 limit 8000"), { text: "Done." }]);
  assert.ok(!lastResult(run.contexts[1]!).includes("[harness]"));
  assert.ok(lastResult(run.contexts[2]!).endsWith(`\n[harness] ${NOTE}`), lastResult(run.contexts[2]!));
  assert.ok(!lastResult(run.contexts[3]!).includes("[harness]"));
  assert.deepEqual(marginEvents(run.events).map((event) => [event.action, event.measured, event.threshold, event.tool, event.request, event.cause]), [
    ["remind", "0.0628", "6 cm", "exec", 2, undefined],
    ["skip", "7334.2", "8000 N/s", "exec", 3, "max"],
  ]);
  const off = await fauxRun(normalizeLoadout(base()), [echo("flight clearance min 0.0628 OK"), { text: "Done." }]);
  assert.ok(!lastResult(off.contexts[1]!).includes("[harness]"));
  assert.deepEqual(marginEvents(off.events), []);
});

test("in a run: a measurement the cell ran but did not print is read from the ledger", async () => {
  const loadout = withLevers((raw) => (raw.policy.thin_margin = true));
  const run = await fauxRun(loadout, [echo("flight clearance min 0.0628 OK", false), { text: "Done." }]);
  assert.ok(!lastResult(run.contexts[1]!).includes("0.0628 OK"));
  assert.ok(lastResult(run.contexts[1]!).endsWith(`\n[harness] ${NOTE}`), lastResult(run.contexts[1]!));
});

test("thin_margin placebo: the same trigger appends neutral text of the note's estimated token count", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.thin_margin = true;
    raw.policy.thin_margin_placebo = true;
  });
  const run = await fauxRun(loadout, [echo("flight clearance min 0.0628 OK"), { text: "Done." }]);
  const sent = lastResult(run.contexts[1]!).split("\n[harness] ")[1]!;
  assert.equal(sent, placeboFor("thin_margin", NOTE));
  assert.equal(estimateTokens(sent), estimateTokens(NOTE));
  assert.doesNotMatch(sent, /\b(?:margin|grader|measure|threshold|check)\w*/iu);
  assert.equal(marginEvents(run.events)[0]?.placebo, true);
});
