/**
 * Offline replay of policy.thin_margin over recorded trials (read-only: it
 * opens files under the runs dir and never writes there; holdout tasks are
 * skipped before their trial dirs are opened).
 *
 *   node --experimental-strip-types --no-warnings scripts/replay-margin.ts <runs-dir> [--runs <regex>] [--holdout <file>]...
 *     [--out <md>] [--list]
 *
 * It walks each transcript in order and feeds every tool result's text to the
 * lever's own class (src/thin-margin.ts ThinMargin.observe on outputLines), one
 * result per call, as the live lever sees one tool result, with the task text
 * from the trial's instruction.txt. A live run also reads the output tails of
 * the cell's nested commands (the ledger), which a transcript does not keep:
 * output a cell ran but did not print is not seen here, so the replay fires
 * at most as often as live. Each fire is placed against the trial's first
 * final (the first assistant turn with text and no tool calls).
 *
 * Variants, each its own ThinMargin on the same results: shipped (the
 * defaults: margin 10%, speedup factor 2), pass_only and speedup_only (one
 * rule each), m20 (margin 20%), f3 and f5 (speedup factor 3 and 5),
 * per_case (a per-case ratio counts for an aggregate speedup target),
 * no_subject (a marked line need not name the threshold's subject).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEVER_TEXTS } from "../src/prompts.ts";
import { outputLines, ThinMargin, type MarginOptions } from "../src/thin-margin.ts";

const args = process.argv.slice(2);
const runsDir = args[0];
if (runsDir === undefined) throw new Error("usage: replay-margin.ts <runs-dir> [--runs <regex>] [--holdout <file>]... [--out <md>] [--list]");
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const runPattern = new RegExp(flag("--runs") ?? "^r(?:[3-9]|1[0-2])[a-z0-9]*-(?:tb4|ds)$", "u");
const outPath = flag("--out");
const listAll = args.includes("--list");
const holdout = new Set<string>();
args.forEach((arg, index) => {
  if (arg !== "--holdout") return;
  for (const line of readFileSync(args[index + 1]!, "utf8").split("\n")) if (line.trim() !== "") holdout.add(line.trim());
});

type Row = { type: string; text?: string; tool_calls?: { id: string; name: string }[]; content?: unknown; id?: string; name?: string };
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : "")).join("\n") : "";

type Variant = "shipped" | "pass_only" | "speedup_only" | "m20" | "f3" | "f5" | "per_case" | "no_subject";
type Settings = { margin: number; factor: number; rules?: MarginOptions["rules"]; perCase?: true; subject?: false; label: string };
const VARIANTS: Record<Variant, Settings> = {
  shipped: { margin: 10, factor: 2, label: "shipped (margin 10%, speedup factor 2)" },
  pass_only: { margin: 10, factor: 2, rules: ["pass"], label: "(shadow) pass rule only" },
  speedup_only: { margin: 10, factor: 2, rules: ["speedup"], label: "(shadow) speedup rule only" },
  m20: { margin: 20, factor: 2, label: "(shadow) margin 20%" },
  f3: { margin: 10, factor: 3, label: "(shadow) speedup factor 3" },
  f5: { margin: 10, factor: 5, label: "(shadow) speedup factor 5" },
  per_case: { margin: 10, factor: 2, perCase: true, label: "(shadow) per-case ratios count for an aggregate target" },
  no_subject: { margin: 10, factor: 2, subject: false, label: "(shadow) marked lines need not name the subject" },
};
const NAMES = Object.keys(VARIANTS) as Variant[];

interface Fire { request: number; rule: string; measured: string; threshold: string; line: string }
interface Trial {
  run: string; arm: string; task: string; trial: number; pass: boolean; dataset: string; requests: number; final: number | undefined;
  thresholds: number; speedup: boolean; results: number; fires: Partial<Record<Variant, Fire>>;
}

function trialDirOf(job: string): string | undefined {
  if (!existsSync(job)) return undefined;
  const sub = readdirSync(job).find((name) => name.includes("__") && statSync(join(job, name)).isDirectory());
  return sub === undefined ? undefined : join(job, sub);
}

/** A ThinMargin with the variant's settings whose recorder keeps the first fire. */
function leverOf(variant: Variant, task: string, out: Trial): { observe(lines: string[], request: number): void; thresholds: number; speedup: boolean } {
  const settings = VARIANTS[variant];
  const recorder = {
    usage: { requests: 0 } as never,
    policy(action: string, _reason: string, fields: Record<string, unknown> = {}) {
      if (action === "remind" && out.fires[variant] === undefined) {
        out.fires[variant] = { request: fields.request as number, rule: fields.rule as string, measured: fields.measured as string, threshold: fields.threshold as string, line: fields.line as string };
      }
    },
  };
  const lever = new ThinMargin({ lever: { max: 1, margin_pct: settings.margin, speedup_factor: settings.factor, text: LEVER_TEXTS.thin_margin }, placebo: false, recorder, task });
  const options = { ...(settings.rules === undefined ? {} : { rules: settings.rules }), ...(settings.perCase ? { perCase: true } : {}), ...(settings.subject === false ? { subject: false } : {}) };
  return {
    observe: (lines, request) => void lever.observe(lines, "exec", request, options),
    thresholds: lever.thresholds.length, speedup: lever.thresholds.some((t) => t.speedup),
  };
}

const OUTPUT_TOOLS = new Set(["exec", "wait", "bash", "exec_command", "write_stdin"]);

function replayTrial(trialDir: string, meta: { run: string; arm: string; task: string; trial: number; pass: boolean; dataset: string }): Trial | undefined {
  const transcriptPath = join(trialDir, "agent", "transcript.jsonl");
  if (!existsSync(transcriptPath)) return undefined;
  const rows = readFileSync(transcriptPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Row);
  const instructionPath = join(trialDir, "agent", "instruction.txt");
  const task = existsSync(instructionPath) ? readFileSync(instructionPath, "utf8") : textOf(rows.find((row) => row.type === "user")?.content);
  const out: Trial = { ...meta, requests: 0, final: undefined, thresholds: 0, speedup: false, results: 0, fires: {} };
  const levers = NAMES.map((variant) => leverOf(variant, task, out));
  out.thresholds = levers[0]!.thresholds;
  out.speedup = levers[0]!.speedup;
  let request = 0;
  for (const row of rows) {
    if (row.type === "assistant") {
      request++;
      if ((row.tool_calls ?? []).length === 0 && (row.text ?? "") !== "" && out.final === undefined) out.final = request;
      continue;
    }
    if (row.type !== "tool_result" || out.thresholds === 0 || !OUTPUT_TOOLS.has(row.name ?? "")) continue;
    out.results++;
    const lines = outputLines([textOf(row.content)]);
    for (const lever of levers) lever.observe(lines, request);
  }
  out.requests = request;
  return out;
}

function replayAll(): Trial[] {
  const trials: Trial[] = [];
  for (const run of readdirSync(runsDir!).sort()) {
    if (!runPattern.test(run)) continue;
    const trialsPath = join(runsDir!, run, "trials.jsonl");
    if (!existsSync(trialsPath)) continue;
    const rows = new Map<string, Record<string, any>>();
    for (const line of readFileSync(trialsPath, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const row = JSON.parse(line) as Record<string, any>;
      rows.set(`${row.arm}\u0000${row.task}\u0000${row.trial}`, row);
    }
    for (const row of rows.values()) {
      if (holdout.has(row.task)) continue; // never opened
      if (row.outcome !== "solved" && row.outcome !== "failed") continue;
      const trialDir = typeof row.job === "string" ? trialDirOf(row.job) : undefined;
      if (trialDir === undefined) continue;
      const dataset = run.endsWith("-ds") ? "ds" : "tb4";
      const trial = replayTrial(trialDir, { run, arm: row.arm, task: row.task, trial: row.trial, pass: (row.reward ?? 0) >= 1, dataset });
      if (trial !== undefined) trials.push(trial);
    }
  }
  return trials;
}

const trials = replayAll();

// ---------- the report ----------

const lines: string[] = [];
const say = (line = "") => lines.push(line);
const pct = (a: number, b: number) => (b === 0 ? "-" : `${Math.round((100 * a) / b)}%`);
const median = (values: number[]) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const before = (trial: Trial, fire: Fire) => trial.final === undefined || fire.request < trial.final;
const id = (trial: Trial) => `${trial.run}/${trial.arm}/${trial.task}/${trial.trial}`;
const firing = (fire: Fire) => `${fire.rule} ${fire.measured} vs ${fire.threshold}`;

say(`# thin_margin offline replay (${new Date().toISOString().slice(0, 10)})`);
say();
for (const dataset of ["tb4", "ds"]) {
  const pool = trials.filter((trial) => trial.dataset === dataset);
  if (pool.length === 0) continue;
  const passing = pool.filter((trial) => trial.pass);
  const failing = pool.filter((trial) => !trial.pass);
  const runs = [...new Set(pool.map((trial) => trial.run))];
  say(`## ${dataset.toUpperCase()} dev: ${pool.length} trials (${passing.length} pass, ${failing.length} fail), ${new Set(pool.map((trial) => trial.task)).size} tasks, runs ${runs.join(", ")}`);
  say();
  say(`Tasks with a stated threshold: ${new Set(pool.filter((trial) => trial.thresholds > 0).map((trial) => trial.task)).size}; with a speedup target: ${new Set(pool.filter((trial) => trial.speedup).map((trial) => trial.task)).size}. ` +
    `Tool results read: ${pool.reduce((sum, trial) => sum + trial.results, 0)}.`);
  say();
  say("| variant | trials fired | pass fired | fail fired | fired before first final (pass / fail) | median request of the note (of first final) |");
  say("|---|---|---|---|---|---|");
  for (const variant of NAMES) {
    const yes = pool.filter((trial) => trial.fires[variant] !== undefined);
    const early = yes.filter((trial) => before(trial, trial.fires[variant]!));
    say(`| ${VARIANTS[variant].label} | ${yes.length}/${pool.length} (${pct(yes.length, pool.length)}) | ${yes.filter((trial) => trial.pass).length}/${passing.length} (${pct(yes.filter((trial) => trial.pass).length, passing.length)}) | ` +
      `${yes.filter((trial) => !trial.pass).length}/${failing.length} (${pct(yes.filter((trial) => !trial.pass).length, failing.length)}) | ` +
      `${early.filter((trial) => trial.pass).length} / ${early.filter((trial) => !trial.pass).length} | ` +
      `${median(yes.map((trial) => trial.fires[variant]!.request))} of ${median(yes.map((trial) => trial.final ?? trial.requests))} |`);
  }
  say();
  say("By task (trials with a fire, pass/fail):");
  say();
  say(`| task | trials (pass/fail) | ${NAMES.join(" | ")} |`);
  say(`|---|---|${NAMES.map(() => "---").join("|")}|`);
  for (const task of [...new Set(pool.map((trial) => trial.task))].sort()) {
    const of = pool.filter((trial) => trial.task === task);
    if (NAMES.every((variant) => of.every((trial) => trial.fires[variant] === undefined))) continue;
    const cell = (variant: Variant) => `${of.filter((trial) => trial.pass && trial.fires[variant] !== undefined).length}/${of.filter((trial) => !trial.pass && trial.fires[variant] !== undefined).length}`;
    say(`| ${task} | ${of.filter((trial) => trial.pass).length}/${of.filter((trial) => !trial.pass).length} | ${NAMES.map(cell).join(" | ")} |`);
  }
  say();
  say(`Tasks with no fire in any variant: ${[...new Set(pool.map((trial) => trial.task))].filter((task) => pool.filter((trial) => trial.task === task).every((trial) => NAMES.every((variant) => trial.fires[variant] === undefined))).length}.`);
  say();
}

for (const task of ["biped-contact-dynamics", "vf2-speedup-networkx"]) {
  const of = trials.filter((trial) => trial.task === task);
  if (of.length === 0) continue;
  const failing = of.filter((trial) => !trial.pass);
  say(`## ${task}`);
  say();
  for (const variant of NAMES) {
    const caught = failing.filter((trial) => trial.fires[variant] !== undefined);
    const early = caught.filter((trial) => before(trial, trial.fires[variant]!));
    say(`- ${variant}: fires on ${caught.length}/${failing.length} failing trials (${early.length} before their first final; note at median request ` +
      `${median(early.map((trial) => trial.fires[variant]!.request))} of first final ${median(early.map((trial) => trial.final ?? trial.requests))}) and ` +
      `${of.filter((trial) => trial.pass && trial.fires[variant] !== undefined).length}/${of.length - failing.length} passing.`);
  }
  say();
  say("| trial | pass | first final / requests | shipped (request: rule measured vs threshold) | m20 | f3 |");
  say("|---|---|---|---|---|---|");
  for (const trial of of) {
    const show = (fire: Fire | undefined) => (fire === undefined ? "-" : `${fire.request}: ${firing(fire)}`);
    say(`| ${trial.run}/${trial.arm}/${trial.trial} | ${trial.pass ? "yes" : "no"} | ${trial.final ?? "-"} / ${trial.requests} | ${show(trial.fires.shipped)} | ${show(trial.fires.m20)} | ${show(trial.fires.f3)} |`);
  }
  say();
}

say("## Shipped fires outside biped and vf2 (false-positive candidates)");
say();
for (const trial of trials.filter((trial) => trial.fires.shipped !== undefined && trial.task !== "biped-contact-dynamics" && trial.task !== "vf2-speedup-networkx")) {
  const fire = trial.fires.shipped!;
  say(`- ${trial.pass ? "PASS" : "fail"} ${id(trial)} @${fire.request}/${trial.final ?? trial.requests}: ${firing(fire)} | \`${fire.line.replaceAll("`", "'")}\``);
}
say();
if (listAll) {
  say("## Every fire");
  say();
  for (const trial of trials) {
    for (const variant of NAMES) {
      const fire = trial.fires[variant];
      if (fire !== undefined) say(`- ${variant} ${trial.pass ? "PASS" : "fail"} ${id(trial)} @${fire.request}/${trial.final ?? trial.requests}: ${firing(fire)} | \`${fire.line.replaceAll("`", "'")}\``);
    }
  }
}
const markdown = `${lines.join("\n")}\n`;
if (outPath !== undefined) writeFileSync(outPath, markdown);
process.stdout.write(markdown);
