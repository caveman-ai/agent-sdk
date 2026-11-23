/**
 * policy.thin_margin: a note on the tool result that prints a check passing a
 * numeric threshold of the task by a thin margin, while the agent is still
 * working. Dev census (research/mine4/findings.md): biped-contact-dynamics
 * failed 34 of 67 trials with the feet too low under the grader's stricter
 * flight window while the agent's own check passed at the margin, and
 * vf2-speedup-networkx failed when the grader measured 1,019-4,993x against a
 * 5,000x gate while the failing agents' own benchmarks claimed 14,509-887,950x.
 * On this model a finish-time nudge does not move the first "done", so the
 * note rides on the result where the thin pass is printed. No model call, no
 * env command.
 *
 * The task's thresholds (`taskThresholds`): each number of the task text with
 * a threshold word close by in its sentence (at least, at most, >=, <=,
 * minimum, maximum, more/less than, above/below, within, tolerance, target,
 * threshold, accuracy, window, margin, speedup, faster, `or more`, `x
 * faster`, a percent), with its unit (time, length, memory, percent, ratio,
 * or any other unit word kept as written) and the side that passes: `min`
 * (the measurement must be at least it), `max` (at most) or `any` (no
 * direction word). Never a count of 10 or less without a unit (mode numbers,
 * sample margins), a zero, a compound (`20-nt`, `5-regular`) or a number in
 * the budget sentence ("You have 28800 seconds"); an arrow (`->`, `=>`, an
 * example's) is no bound word. A ratio unit (`5000x`, `3 times`) or a
 * speedup/faster word makes it a speedup target; `aggregate` when its
 * sentence names one (geometric mean, mean, median, overall). Its `subject`:
 * the word stems of its clause and the clause before it (`clear`, `torqu`,
 * `rate`).
 *
 * The output (`outputLines`): the result text and, on the exec surface, the
 * output tails of the cell's nested commands (the ledger), each JSON record a
 * cell printed decoded to its `output`, without the harness's own lines (the
 * cell header, truncation notices, `[harness]` notes). Lines that are not a
 * measurement report are skipped: source code (statements, comments, print
 * calls, method calls, comparisons, attribute access), over 400 characters,
 * more than 10 numbers (tables, tuple dumps, solver iterations), no word of
 * three letters, and for the pass rule CSV rows. Numbers that are not
 * measurements are masked: dates, clock times, versions, hashes, hex, paths
 * with `:line`, test ids, `x/y` counts, progress percentages, a count before a
 * count noun (`12 passed`, `300 nodes`), a number after an index word
 * (`seed=4`, `line 12`), a test runner's `in 0.31s`; and a measurement is
 * never negative, zero, a small count (an integer of 10 or less without a
 * unit), an id (`00023`, `LOT-23`), a compound, a bare 90/95/99 (a
 * percentile's label), or equal to the threshold (an echo of the task).
 * A line FIRES when:
 * - (pass) it has no fail marker (FAIL, failed, False, not ok, ERROR, NO
 *   PASS; "0 failed" is none) and a measurement within `margin_pct` of a
 *   threshold on its passing side (either side for `any`), in a compatible
 *   unit, where either the line compares the two (`0.0603 >= 0.06`: the
 *   operator's side must pass), or the threshold's own number follows the
 *   measurement (`3182 limit 3500`), or the line carries a pass marker (PASS,
 *   OK, passed, a check mark, meets, True, >=, <=) and the measurement's
 *   label (the text before it back to `,` `;` `{` `}` `|`, or the previous
 *   label) names this threshold's subject more than any other threshold's
 *   (a label naming two equally, `rates=`, pairs with neither). Never an
 *   integer against an integer threshold without an explicit comparison (a
 *   count), never a percentage at 100. A speedup target is the speedup
 *   rule's, except by comparison;
 * - (speedup) the task states a speedup target T and the line prints a ratio
 *   (`123.4x`, or the number after speedup/faster/ratio/geomean), with T <=
 *   ratio < speedup_factor * T and no FAIL; for an aggregate target only on a
 *   line that names an aggregate (a per-case ratio is not the gate).
 * The hit with the thinnest margin is the one named.
 *
 * At most `max` fires per run. Trace: each fire is `policy remind
 * thin_margin` with the rule, the measurement and threshold as written, the
 * margin in percent, the line (cut to 200), the tool and `request` (the
 * request whose tool call the note rides on); a trigger after the run's notes
 * is `policy skip thin_margin` (cause max; the first 10 distinct ones). The
 * placebo keeps the trigger and sends placeboFor("thin_margin", text).
 */
import type { Levers } from "./loadout.ts";
import { placeboFor } from "./prompts.ts";
import type { LedgerEntry } from "./tools/exec/nested.ts";
import type { Recorder } from "./trace.ts";

type Lever = NonNullable<Levers["thin_margin"]>;

export type Dim = "time" | "length" | "memory" | "percent" | "ratio";
export type Bound = "min" | "max" | "any";

/** A number as written, with its unit when one follows it. */
export interface Quantity {
  /** The number and unit as written ("6 cm", "5,053x", "0.0603"). */
  raw: string;
  value: number;
  negative: boolean;
  /** Followed by `-word` (`20-nt`, `5-regular`): part of a compound, not a quantity. */
  compound: boolean;
  /** The unit, normalized ("s", "ms", "cm", "%", "x"), or any other unit token as written ("N/s"). */
  unit?: string;
  dim?: Dim;
  /** The value in the dimension's base unit (s, m, B), for units with a scale. */
  base?: number;
  index: number;
  end: number;
}

/** A threshold the task states (see the header). */
export interface Threshold extends Quantity {
  bound: Bound;
  speedup: boolean;
  /** Its sentence names an aggregate (geometric mean, mean, median, overall): a per-case measurement is not the gate. */
  aggregate: boolean;
  /** Word stems of its clause that a measurement line must share (unless it compares with the threshold's own number). */
  subject: string[];
}

/** A thin pass found in a tool result. */
export interface MarginHit {
  rule: "pass" | "speedup";
  /** The measurement as printed (a long number shortened). */
  measured: string;
  /** The threshold as the task writes it. */
  threshold: string;
  /** How far past the threshold the measurement is, as a fraction of the threshold (0.03 = 3%). */
  margin: number;
  line: string;
}

export interface MarginOptions {
  marginPct: number;
  speedupFactor: number;
  /** Which rules may fire (default both). */
  rules?: readonly ("pass" | "speedup")[];
  /** Ratios on per-case lines count for an aggregate target too (default false; the replay's shadow). */
  perCase?: boolean;
  /** A marked line must name the threshold's subject (default true; false is the replay's shadow). */
  subject?: boolean;
}

// ---------- quantities ----------

const SCALE: Record<string, [Dim, number]> = {
  s: ["time", 1], ms: ["time", 1e-3], us: ["time", 1e-6], ns: ["time", 1e-9], min: ["time", 60], h: ["time", 3600],
  m: ["length", 1], cm: ["length", 1e-2], mm: ["length", 1e-3], km: ["length", 1e3],
  B: ["memory", 1], KB: ["memory", 1024], MB: ["memory", 1024 ** 2], GB: ["memory", 1024 ** 3],
};
const UNIT_ALIASES: [RegExp, string][] = [
  [/^(?:%|percent)$/u, "%"], [/^(?:x|×|times)$/u, "x"],
  [/^(?:s|secs?|seconds?)$/u, "s"], [/^(?:ms|milliseconds?)$/u, "ms"], [/^(?:us|[µμ]s|microseconds?)$/u, "us"], [/^ns$/u, "ns"],
  [/^(?:mins?|minutes?)$/u, "min"], [/^(?:h|hrs?|hours?)$/u, "h"],
  [/^(?:m|meters?|metres?)$/u, "m"], [/^cm$/u, "cm"], [/^mm$/u, "mm"], [/^km$/u, "km"],
  [/^(?:B|bytes?)$/u, "B"], [/^[kK]i?B$/u, "KB"], [/^Mi?B$/u, "MB"], [/^Gi?B$/u, "GB"],
];

/**
 * A number (`1,000`, `0.0603`, `1.5e-4`; never inside an identifier such as `LOT-23` or `v2`, never a version's `3.4` of `3.4.2`),
 * then optionally a unit: `x`/`×` attached, or after at most one space a percent sign, `times`, a time, length or memory unit, or a
 * force unit (N, N/s, N·m/s, kept as written).
 */
const QUANTITY = new RegExp(
  "(?<![\\w.])(?<!\\w-)(-)?(\\d{1,3}(?:,\\d{3})+(?!\\d)|\\d+)(\\.\\d+)?(?:[eE]([-+]?\\d+))?(?!\\.\\d)" +
    "(?:([x×])(?![\\w])|\\s?(%|percent\\b|times\\b|[µμ]s\\b|N(?:·m|\\*m|m)?/s\\b|(?:ms|us|ns|s|secs?|seconds?|milliseconds?|microseconds?|mins?|minutes?|h|hrs?|hours?|cm|mm|km|m|meters?|metres?|bytes?|B|[kKMG]i?B|N)\\b(?!/)))?" +
    "(?![\\w])(-[A-Za-z])?",
  "gu",
);

/** The quantities in a text, in order. */
export function quantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  for (const match of text.matchAll(QUANTITY)) {
    const value = Number(`${match[2]!.replaceAll(",", "")}${match[3] ?? ""}${match[4] === undefined ? "" : `e${match[4]}`}`);
    if (!Number.isFinite(value)) continue;
    const written = match[5] ?? match[6];
    const unit = written === undefined ? undefined : UNIT_ALIASES.find(([pattern]) => pattern.test(written))?.[1] ?? written;
    const scale = unit === undefined ? undefined : SCALE[unit];
    const dim: Dim | undefined = unit === "%" ? "percent" : unit === "x" ? "ratio" : scale?.[0];
    const sign = match[1] === undefined ? 0 : 1;
    const end = match.index + match[0].length - (match[7] === undefined ? 0 : 2);
    out.push({
      raw: text.slice(match.index + sign, end).trim(), value, negative: sign === 1, compound: match[7] !== undefined, index: match.index + sign, end,
      ...(unit === undefined ? {} : { unit }), ...(dim === undefined ? {} : { dim }), ...(scale === undefined ? {} : { base: value * scale[1] }),
    });
  }
  return out;
}

/** Pairs of (measured, threshold) values that compare in one unit; empty when the units differ. */
export function comparable(m: Quantity, t: Quantity): [number, number][] {
  if (m.unit !== undefined && t.unit !== undefined) {
    if (m.dim !== undefined && m.dim === t.dim) return m.base !== undefined && t.base !== undefined ? [[m.base, t.base]] : [[m.value, t.value]];
    return m.unit === t.unit ? [[m.value, t.value]] : [];
  }
  if (t.dim === "percent") return [[m.value, t.value], [m.value, t.value / 100]];
  if (m.dim === "percent") return [[m.value, t.value], [m.value / 100, t.value]];
  if (t.base !== undefined && t.base !== t.value) return [[m.value, t.value], [m.value, t.base]];
  if (m.base !== undefined && m.base !== m.value) return [[m.value, t.value], [m.base, t.value]];
  return [[m.value, t.value]];
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** An integer of 10 or less without a unit: a count, an index or a mode, not a measurement (nor, in a task, a threshold). */
const smallCount = (q: Quantity) => q.unit === undefined && Number.isInteger(q.value) && q.value <= 10;

// ---------- subjects ----------

/** Words that name no quantity: function words, threshold and check vocabulary, generic task words. */
const STOP = new Set((
  "must should shall have with that this from than more less least most each both every also into only stay stays remain remains below above within " +
  "under over during after before their which where when then them they will would your there these those such some other does make made same very " +
  "just like need needs keep being been were what whose while about across along among around between through toward upon without again always " +
  "never still even given using used uses value values number numbers task file files output outputs result results check checks checked test tests " +
  "verifier verified grader graded hidden visible minimum maximum target threshold required requires require requirement requirements tolerance " +
  "greater smaller larger lower higher faster slower times second seconds minutes hours percent margin window exceed exceeds strictly approximately " +
  "roughly including include includes contain contains containing config configured submission submitted solution case cases first last " +
  "note notes sure fewer many much samples sample time"
).split(/\s+/u));

/** The word stems of a text: words of 4+ letters (camelCase and snake_case split), not stop words, cut to 5 letters. */
export function stems(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase().split(/[^a-z]+/u)) {
    if (word.length >= 4 && !STOP.has(word)) out.add(word.slice(0, 5));
  }
  return [...out];
}

/** How many of a subject's stems a label names: a word of it starts or (a compound such as `minclear`) ends with the stem. */
function overlap(label: string, subject: readonly string[]): number {
  const words = label.replace(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase().split(/[^a-z]+/u).filter((word) => word.length >= 3);
  return subject.filter((stem) => words.some((word) => word.startsWith(stem) || (word.length > stem.length && word.endsWith(stem)))).length;
}

/** What a measurement is called: the text before it back to the last `,` `;` `{` `}` `|` (or the line start); an empty one is the previous measurement's. */
function labels(text: string, all: readonly Quantity[]): Map<Quantity, string> {
  const out = new Map<Quantity, string>();
  let previous = "";
  for (const q of all) {
    const before = text.slice(0, q.index);
    const from = Math.max(...[",", ";", "{", "}", "|"].map((mark) => before.lastIndexOf(mark)));
    const label = before.slice(from + 1);
    previous = /[A-Za-z]{2,}/u.test(label) ? label : previous;
    out.set(q, previous);
  }
  return out;
}

// ---------- the task's thresholds ----------

const LOWER_BEFORE = /(?:at least|no less than|not less than|no fewer than|minimum(?: of)?|\bmin(?:imum)?\b|>=|≥|(?<![-=<])>(?![>=])|more than|greater than|\babove\b|exceeds?|exceeding|higher than|faster than|\bover\b|\bbeyond\b)/giu;
const UPPER_BEFORE = /(?:at most|no more than|not more than|maximum(?: of)?|\bmax(?:imum)?\b|<=|≤|<(?![-=<])|less than|fewer than|\bbelow\b|\bunder\b|\bwithin\b|not exceed|up to|lower than|smaller than|tolerance(?: of)?|capped at|limit(?:ed)? to)/giu;
const LOWER_AFTER = /^[\s`'"*)]*(?:or (?:more|greater|higher|above|better|faster|longer)|\+(?!\d)|(?:x|×|times)?\s*(?:faster|speed-?up|quicker))/iu;
const UPPER_AFTER = /^[\s`'"*)]*(?:or (?:less|fewer|lower|below|under|smaller|shorter)|at most)/iu;
const NEUTRAL = /\b(?:target|threshold|accuracy|precision|recall|tolerance|window|margin|speed-?ups?|faster|gate)\b|%/iu;
const SPEEDUP_WORDS = /\bspeed-?ups?\b|\bfaster\b|\bquicker\b/iu;
const AGGREGATE = /\b(?:geo(?:metric)?[- _]?mean|gmean|mean|average|avg|median|overall|aggregate|total)\b/iu;
/** The budget sentence the harness or the rig adds ("You have 28800 seconds to complete this task"): not a requirement. */
const BUDGET_SENTENCE = /\byou have (?:about )?[\d,.]+ (?:seconds|minutes|hours)\b/iu;

/** The task text as sentences (a sentence ends at . ! ? followed by space, at ; or a line break). */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/u).filter((sentence) => sentence.trim() !== "");
}

/** The clause of a sentence around an index (between the commas, semicolons and colons followed by a space), with the clause before it. */
function clauseAt(sentence: string, index: number): string {
  const marks = [", ", "; ", ": "];
  const startOf = (at: number) => Math.max(...marks.map((mark) => sentence.lastIndexOf(mark, at)));
  const start = startOf(index);
  const previous = start <= 0 ? -1 : startOf(start - 1);
  const ends = marks.map((mark) => sentence.indexOf(mark, index)).filter((at) => at >= 0);
  return sentence.slice(start < 0 ? 0 : previous < 0 ? 0 : previous + 2, ends.length === 0 ? sentence.length : Math.min(...ends));
}

/** The numeric thresholds the task states (see the header). */
export function taskThresholds(task: string): Threshold[] {
  const out: Threshold[] = [];
  for (const sentence of sentences(task)) {
    if (BUDGET_SENTENCE.test(sentence)) continue;
    for (const q of quantities(sentence)) {
      if (q.negative || q.value === 0 || q.compound || smallCount(q)) continue;
      const before = sentence.slice(Math.max(0, q.index - 32), q.index);
      const after = sentence.slice(q.end, q.end + 32);
      const lastOf = (pattern: RegExp) => {
        let at = -1;
        for (const match of before.matchAll(pattern)) at = match.index + match[0].length;
        return at;
      };
      const lower = Math.max(lastOf(LOWER_BEFORE), LOWER_AFTER.test(after) ? before.length + 1 : -1);
      const upper = Math.max(lastOf(UPPER_BEFORE), UPPER_AFTER.test(after) ? before.length + 1 : -1);
      const near = sentence.slice(Math.max(0, q.index - 48), q.end + 48);
      let bound: Bound | undefined;
      if (lower >= 0 || upper >= 0) bound = lower > upper ? "min" : "max";
      else if (NEUTRAL.test(near) || q.dim === "percent" || q.dim === "ratio") bound = "any";
      if (bound === undefined) continue;
      const speedup = q.dim === "ratio" || (bound !== "max" && SPEEDUP_WORDS.test(near));
      if (speedup && bound === "any") bound = "min";
      if (out.some((known) => known.raw === q.raw && known.bound === bound)) continue;
      const clause = stems(clauseAt(sentence, q.index));
      out.push({ ...q, bound, speedup, aggregate: speedup && AGGREGATE.test(sentence), subject: clause.length >= 2 ? clause : stems(sentence) });
    }
  }
  return out;
}

// ---------- the output ----------

/** Lines the harness writes into a result: the exec cell header, truncation and cut notices, spill paths, its own notes. */
const HARNESS_LINE = /^(?:Script (?:completed|failed|terminated|running with cell ID \d+)|Wall time \d+(?:\.\d+)? seconds|Output:|Warning: truncated output \(original token count: \d+\)|Total output lines: \d+|Full output: .*|Omitted: output lines.*|\[harness\].*|\.\.\. \d+ bytes omitted \.\.\.|\[\.\.\. \d+ (?:more|lines?).*\])$/u;

/** The `output` strings of exec_command/write_stdin records a cell printed as JSON (`{"chunk_id":...,"output":"..."}`), decoded. */
function recordOutputs(line: string): string[] | undefined {
  if (!line.includes("\"output\":\"")) return undefined;
  const outputs: string[] = [];
  for (const match of line.matchAll(/"output":"((?:[^"\\]|\\.)*)"?/gu)) {
    try {
      outputs.push(JSON.parse(`"${match[1]!}"`) as string);
    } catch {
      outputs.push(match[1]!.replace(/\\n/gu, "\n").replace(/\\t/gu, "\t").replace(/\\"/gu, "\""));
    }
  }
  return outputs;
}

/** The output lines of a result's texts (see the header): records decoded, harness lines dropped, each distinct line once. */
export function outputLines(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (line: string) => {
    const trimmed = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").trim();
    if (trimmed === "" || HARNESS_LINE.test(trimmed) || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const text of texts) {
    for (const line of text.split("\n")) {
      const outputs = recordOutputs(line);
      if (outputs === undefined) add(line);
      else for (const output of outputs) for (const inner of output.split("\n")) add(inner);
    }
  }
  return out;
}

/** A line-number or grep gutter (`12\t`, `12: `, `src/x.py:12:`), stripped before a line is judged. */
const GUTTER = /^(?:[\w./-]+:\d+[:-]|\s*\d+(?:\t|[:|]\s))\s*/u;
/** Source code, not a measurement: a statement or block header, a comment, a print call, an equality test, a compound assignment, attribute or item access. */
const CODE = new RegExp([
  "^(?:def|class)\\s+\\w+", "^(?:return|import|raise|assert|yield|del)\\b", "^from\\s+\\S+\\s+import\\b", "^(?:if|elif|while|for|with|except)\\b.*:\\s*(?:#.*)?$",
  "^(?:else|try|finally):", "^(?:const|let|var|function|export|async\\s+function)\\b", "^(?:#|//|/\\*|\\*\\s|@\\w)", "print\\(|console\\.log\\(|\\bf[\"']",
  "\\w\\s*[=!]==?\\s*[\\w(]", "\\w\\s*(?:\\+|-|\\*|/|\\|\\||&&|\\?\\?)=\\s*\\S", "\\b(?:self|this)\\.\\w", "\\w\\[[\"'][\\w-]+[\"']\\]", "\\)\\s*:\\s*$", "[;{]\\s*$",
  "\\bnp\\.\\w+\\(", "[\\w\"')\\]]\\.\\w+\\([^)]*\\)", "\\b(?:flush|axis|dtype|key|end|sep)=", "\\)\\s*(?:#|//)",
].join("|"), "u");
const WORD = /[A-Za-z]{3,}/u;
const CSV = /(?:,(?=[^\s\d])[^,\n]*){3,}/u;
const PASS = /\bPASS(?:ED|ES)?\b|\b[Pp]ass(?:ed|es)?\b|\bOK\b|✓|✔|✅|\bmeets?\b|\bTrue\b|>=|<=|≥|≤/u;
const FAIL = /\bFAIL(?:ED|S|URE|ING)?\b|\b[Ff]ail(?:ed|s|ures?|ing)?\b|✗|✘|❌|\bFalse\b|\bnot ok\b|\bERROR\b|\bNO PASS\b|\bnot? pass(?:ed|es)?\b|\b(?:does|did)(?: not|n't) (?:meet|pass)\b/u;
/** "0 failed", "failures: 0": no failure. */
const NO_FAILURES = /\b0\s+(?:failed|failures?|errors?)\b|\b(?:failed|failures?|errors?)\s*[:=]\s*0\b/giu;
const SPEEDUP_FAIL = /\bFAIL(?:ED|S|URE)?\b|✗|✘|❌|\bnot ok\b/u;
const RATIO_WORD = /\b(?:speed-?ups?|faster|ratio|geo(?:metric)?[- _]?mean|gmean)\b/giu;
/** numpy scalars as Python prints them in containers: `np.float64(0.061)`. */
const NP_SCALAR = /\bnp\.(?:float|int|uint)\d*\(([^()]*)\)/gu;
const MAX_NUMBERS = 10;
/** A bare 90, 95 or 99: a percentile's label (`COM force 95 0.0337`), not a measurement. */
const PERCENTILE = /^(?:90|95|99)$/u;

/** Masks (spaces) for numbers that are not measurements (see the header). */
const MASKS: RegExp[] = [
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?/gu,
  /\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/gu,
  /\bv?\d+(?:\.\d+){2,}\b/gu,
  /\b0x[0-9a-fA-F]+\b/gu,
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gu,
  /\S+::\S+/gu,
  /(?:^|\s)[~.]{0,2}\/?[\w.@+-]+(?:\/[\w.@+-]+)+\/?(?::\d+)*/gu,
  /\b[\w-]+\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|c|cc|cpp|h|hpp|cs|kt|swift|sh|json|ya?ml|toml|md|txt|csv|log|npz|npy|html|css)(?::\d+)+/gu,
  /(?<![\d.])\d+\s*\/\s*\d+(?![\d.])/gu,
  /\[\s*\d+%\]|\b\d+%\|/gu,
  /#\d+/gu,
  /\b(?:line|lines|pid|port|seeds?|epoch|step|iter(?:ation)?|trial|case|test|id|rank|row|col(?:umn)?|chunk|session|request|attempt|run|batch|round|gen(?:eration)?|n|k|i|j|idx|index|size|shape|dim|version|python|py|ver)\s*[=:#]?\s*\(?\d+(?:,\s?\d+)*\b/giu,
  /\b\d+(?:,\d{3})*\s+(?:passed|failed|errors?|warnings?|skipped|deselected|xfailed|xpassed|tests?|items?|files?|lines?|bytes?|chars?|characters?|rows?|columns?|records?|entries|nodes?|edges?|vertices|iterations?|epochs?|steps?|points?|trials?|cases?|calls?|requests?|tokens?|params?|parameters?|packages?|modules?|functions?|classes?|commits?|chunks?|workers?|threads?|processes?|cores?|seeds?|graphs?|pairs?|variables?|constraints?|elements?|objects?|users?|days?|years?)\b/giu,
];
const RUNNER_TIME = /\bin \d+(?:\.\d+)?\s?s(?:econds)?\b/gu;
const RUNNER_LINE = /\b(?:passed|failed|Ran \d+ tests?|test result:)/u;

function masked(line: string): string {
  let text = line;
  for (const mask of MASKS) text = text.replace(mask, (match) => " ".repeat(match.length));
  if (RUNNER_LINE.test(line)) text = text.replace(RUNNER_TIME, (match) => " ".repeat(match.length));
  return text;
}

/** A measurement as the note names it: as printed, a long number shortened (4 significant digits under 1000, else whole). */
function shown(q: Quantity): string {
  const number = /^[\d,]+(?:\.\d+)?(?:[eE][-+]?\d+)?/u.exec(q.raw)?.[0] ?? q.raw;
  const significant = number.replace(/[eE].*$/u, "").replace(/\D/gu, "").replace(/^0+/u, "").length;
  if (significant <= 6) return q.raw;
  const value = Math.abs(q.value) < 1000 ? String(Number(q.value.toPrecision(4))) : String(Math.round(q.value));
  return `${value}${q.raw.slice(number.length)}`;
}

/** How far `m` is past `t` on the passing side, as a fraction of `t`, or undefined when it is not on that side or not within `max`. */
function passingMargin(m: number, t: number, bound: Bound, max: number): number | undefined {
  if (t <= 0 || m <= 0 || same(m, t)) return undefined;
  const margin = bound === "min" ? (m - t) / t : bound === "max" ? (t - m) / t : Math.abs(m - t) / t;
  return margin > 0 && margin <= max + 1e-12 ? margin : undefined;
}

/** A comparison operator alone between two numbers (brackets, colons and commas around it allowed): `0.0603 >= 0.06`, `(>= 0.06)`. */
function operatorBetween(text: string): ">" | "<" | undefined {
  const op = /^[\s()[\]:,]*(>=|<=|≥|≤|>|<)[\s()[\]:,]*$/u.exec(text)?.[1];
  return op === undefined ? undefined : /[>≥]/u.test(op) ? ">" : "<";
}

/** The thinnest pass in the lines, or undefined (see the header). */
export function thinHit(lines: readonly string[], thresholds: readonly Threshold[], options: MarginOptions): MarginHit | undefined {
  if (thresholds.length === 0) return undefined;
  const rules = new Set(options.rules ?? ["pass", "speedup"]);
  const max = options.marginPct / 100;
  const speedups = thresholds.filter((threshold) => threshold.speedup);
  const isThreshold = (q: Quantity, t: Threshold) => comparable(q, t).some(([a, b]) => same(a, b));
  let best: MarginHit | undefined;
  const offer = (hit: MarginHit) => {
    if (best === undefined || hit.margin < best.margin) best = hit;
  };
  for (const raw of lines) {
    const line = raw.replace(GUTTER, "").replace(NP_SCALAR, "$1");
    if (line.length > 400 || CODE.test(line) || !WORD.test(line.replace(/\b\d[\d.]*[eE][-+]?\d+\b/gu, ""))) continue;
    const text = masked(line);
    const all = quantities(text);
    if (all.length === 0 || all.length > MAX_NUMBERS) continue;
    const measures = all.filter((q) => !q.negative && q.value !== 0 && !q.compound && !smallCount(q) && !/^0\d/u.test(q.raw) && !PERCENTILE.test(q.raw) &&
      !thresholds.some((t) => isThreshold(q, t)));
    if (measures.length === 0) continue;
    const cut = line.length > 200 ? `${line.slice(0, 197)}...` : line;
    if (rules.has("pass") && !CSV.test(line) && !FAIL.test(line.replace(NO_FAILURES, ""))) {
      // `m >= t`, `t <= m` with the threshold's own number: the operator says which side the line's check passes on.
      const compared = new Set<Threshold>();
      for (let i = 0; i + 1 < all.length; i++) {
        const [left, right] = [all[i]!, all[i + 1]!];
        const op = operatorBetween(text.slice(left.end, right.index));
        if (op === undefined) continue;
        for (const t of thresholds) {
          const [m, side]: [Quantity | undefined, Bound] = isThreshold(right, t) && !isThreshold(left, t) ? [left, op === ">" ? "min" : "max"]
            : isThreshold(left, t) && !isThreshold(right, t) ? [right, op === ">" ? "max" : "min"] : [undefined, "any"];
          if (m === undefined || !measures.includes(m) || (t.bound !== "any" && t.bound !== side)) continue;
          compared.add(t);
          for (const [a, b] of comparable(m, t)) {
            const margin = passingMargin(a, b, side, max);
            if (margin !== undefined) offer({ rule: "pass", measured: shown(m), threshold: t.raw, margin, line: cut });
          }
        }
      }
      // Otherwise a measurement goes to the thresholds its label names best (its subject; a speedup target is the speedup rule's), on a
      // line with a pass marker, or to a threshold whose own number follows it on the line (`3182 limit 3500`).
      const marked = PASS.test(line);
      const named = labels(text, all);
      for (const m of measures) {
        const counted = thresholds.map((t) => (compared.has(t) || t.speedup ? 0 : options.subject === false ? 1 : overlap(named.get(m) ?? "", t.subject)));
        const most = Math.max(...counted);
        // A label that names two thresholds equally (`rates=`, `frate`) says nothing about which one it measures.
        const unique = most > 0 && counted.filter((count) => count === most).length === 1;
        const next = all[all.indexOf(m) + 1];
        thresholds.forEach((t, i) => {
          const follows = next !== undefined && isThreshold(next, t) && !compared.has(t) && !t.speedup;
          if (!follows && !(marked && counted[i] === most && (unique || options.subject === false))) return;
          // Integer against an integer threshold: a count or an index, never judged without an explicit comparison.
          if (t.unit === undefined && Number.isInteger(t.value) && Number.isInteger(m.value) && m.unit === undefined) return;
          // A percentage at its ceiling is not a thin pass.
          if (m.dim === "percent" && m.value >= 100 && t.bound !== "max") return;
          for (const [a, b] of comparable(m, t)) {
            const margin = passingMargin(a, b, t.bound, max);
            if (margin !== undefined) offer({ rule: "pass", measured: shown(m), threshold: t.raw, margin, line: cut });
          }
        });
      }
    }
    if (rules.has("speedup") && speedups.length > 0 && !SPEEDUP_FAIL.test(line)) {
      const ratios = measures.filter((q) => q.dim === "ratio");
      for (const word of text.matchAll(RATIO_WORD)) {
        const from = word.index + word[0].length;
        const after = measures.find((q) => q.index >= from && q.index - from <= 30);
        if (after !== undefined && after.unit === undefined && !ratios.includes(after)) ratios.push(after);
      }
      const aggregateLine = AGGREGATE.test(line);
      for (const m of ratios) {
        for (const t of speedups) {
          if (t.aggregate && !aggregateLine && options.perCase !== true) continue;
          if (m.value >= t.value && m.value < t.value * options.speedupFactor && !same(m.value, t.value)) {
            offer({ rule: "speedup", measured: shown(m), threshold: t.raw, margin: (m.value - t.value) / t.value, line: cut });
          }
        }
      }
    }
  }
  return best;
}

// ---------- the lever ----------

type Details = { log?: LedgerEntry[] };

/** Tool results whose text is command output (the exec surface's cells and waits, the compact surface's bash and wait). */
const OUTPUT_TOOLS = new Set(["exec", "wait", "bash", "exec_command", "write_stdin"]);
const SKIP_RECORDS = 10;

export class ThinMargin {
  private readonly lever: Lever;
  private readonly placebo: boolean;
  private readonly recorder: Pick<Recorder, "policy" | "usage">;
  /** The task's thresholds, read once. */
  readonly thresholds: Threshold[];
  private fires = 0;
  private readonly skipped = new Set<string>();

  constructor(options: { lever: Lever; placebo: boolean; recorder: Pick<Recorder, "policy" | "usage">; task: string }) {
    this.lever = options.lever;
    this.placebo = options.placebo;
    this.recorder = options.recorder;
    this.thresholds = taskThresholds(options.task);
  }

  /** The note this tool result carries, if any (at most one). A failure of the lever's own is traced, never the tool call's. */
  afterTool(name: string, details: Details | undefined, text: string): string[] {
    if (this.thresholds.length === 0 || !OUTPUT_TOOLS.has(name)) return [];
    try {
      const texts = [text, ...(details?.log ?? []).flatMap((entry) => (entry.kind === "mutate" ? [] : [entry.output]))];
      const note = this.observe(outputLines(texts), name, this.recorder.usage.requests);
      return note === undefined ? [] : [note];
    } catch (error) {
      this.recorder.policy("check", "thin_margin_failed", { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  /** The lever on one result's output lines (shared with scripts/replay-margin.ts): a fire, a skip once the run had its notes, or nothing. */
  observe(lines: readonly string[], tool: string, request: number, options: Pick<MarginOptions, "rules" | "perCase" | "subject"> = {}): string | undefined {
    const hit = thinHit(lines, this.thresholds, { marginPct: this.lever.margin_pct, speedupFactor: this.lever.speedup_factor, ...options });
    if (hit === undefined) return undefined;
    const fields = { rule: hit.rule, measured: hit.measured, threshold: hit.threshold, margin_pct: Math.round(hit.margin * 1000) / 10, line: hit.line, tool, request };
    if (this.fires >= this.lever.max) {
      const key = `${hit.measured}\0${hit.threshold}`;
      if (!this.skipped.has(key) && this.skipped.size < SKIP_RECORDS) this.recorder.policy("skip", "thin_margin", { ...fields, cause: "max" });
      this.skipped.add(key);
      return undefined;
    }
    this.fires++;
    this.recorder.policy("remind", "thin_margin", { n: this.fires, ...fields, placebo: this.placebo });
    const text = this.lever.text.replaceAll("{measured}", hit.measured).replaceAll("{threshold}", hit.threshold);
    return this.placebo ? placeboFor("thin_margin", text) : text;
  }
}
