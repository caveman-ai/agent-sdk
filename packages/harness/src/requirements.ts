/**
 * prompt.requirements: the task's requirement sentences, extracted by fixed
 * rules (no model), numbered, and appended once to the first user message
 * after the task. The items are the task's own words (whitespace collapsed,
 * list markers dropped, a short command block quoted inline after the
 * sentence that introduces it); nothing is paraphrased. The same task text
 * always gives the same block, so the first message is one cache prefix
 * across trials.
 *
 * Rules "v1" (the loadout names the rule set, so behavior_hash changes when
 * the rules do):
 * - Units: sentences of prose paragraphs and list items, and table rows.
 *   HTML comments, headings and fenced code are not units; a paragraph of
 *   two or more bare lines with no sentence end (formulas, a list without
 *   markers) is a list. A fence of at most 3 short lines right after a unit
 *   ending in ":" is quoted into it (a CLI signature or a one-line format).
 *   A unit ending in ":" leads the list items right under it (the top-level
 *   items after a paragraph, or the deeper-indented items under an item):
 *   at most 8 short single-sentence items without items of their own are
 *   absorbed ("lead: a; b; c"); otherwise each item is a unit and inherits
 *   the lead's selection (the lead stays a unit of its own). A sentence
 *   longer than CLAUSE_SPLIT_CHARS is split into its "; " and " -- " clauses.
 * - A unit is a requirement when it states an obligation or prohibition
 *   (must, shall, required, exactly, never, may not, "do not" opening a
 *   sentence or clause; weaker: should, ensure, make sure, need to, only,
 *   avoid, exact, strictly, maximize, minimize), a numeric bound (at least,
 *   at most, below, within, no more than, ... near a number; ±, ≤, ≥, <, >
 *   before a number; a percentage), an output (write, save, produce, ...,
 *   not passive, with a path, a file name or a format word) or a CLI
 *   signature (a --flag, "usage:", "run as").
 * - Duplicates (case, whitespace, backticks and end punctuation ignored) and
 *   units contained in an earlier kept unit are dropped. Over `max_items`, the
 *   strongest units are kept (obligation 3, bound / output / CLI 2, weak 1,
 *   summed; ties to the earlier unit), listed in task order, and one line
 *   counts the rest.
 */
import type { Loadout } from "./loadout.ts";
import { estimateTokens, placeboFor } from "./prompts.ts";

/** Sentences longer than this are split into their "; " and " -- " clauses, so a list item is closer to one checkable claim. */
export const CLAUSE_SPLIT_CHARS = 240;
/** List items a lead-in absorbs inline ("lead: a; b"), each at most this long. */
const INLINE_ITEMS = 8;
const INLINE_ITEM_CHARS = 100;
const FENCE_LINES = 3;
const FENCE_LINE_CHARS = 200;

const OBLIGATION = /\b(?:must|mustn['’]t|shall|required|requires?|requirements?(?!\.\w)|exactly|never|may not|not (?:allowed|accepted|acceptable|permitted)|forbidden|prohibited)\b/iu;
/** "do not" as an instruction (opening a sentence or clause, or after "and", "you", ...), not as a description ("events that do not match"). */
const PROHIBITION = /(?:^|[,;:(—–]\s*|\s-\s+|\b(?:and|or|but|you|please|then|so)\s+)[*_]*(?:do not|don['’]t)\b/iu;
const WEAK = /\b(?:should(?:n['’]t)?|ensures?|make sure|needs? to|only|avoid|exact|strictly|maximi[sz]e|minimi[sz]e)\b/iu;
const BOUND = new RegExp(
  "\\b(?:at (?:least|most)|no (?:more|fewer|less|later|earlier) than|(?:less|fewer|more|greater|lower|higher|longer|shorter|earlier|later) than|" +
    "below|above|under|over|within|exceeds?|exceeding|up to|between|minimum|maximum|tolerance|rtol|atol|decimals?|decimal places|" +
    "significant (?:digits|figures))\\b[^.;]{0,48}?\\d|[±≤≥]|[<>]=?\\s*-?\\d|\\d\\s*%",
  "iu",
);
/** An output the task asks for, not one it describes ("the report is saved at ..."): never right after a form of "be". */
const OUTPUT_VERB = /(?<!\b(?:is|are|was|were|be|been|being)\s+)\b(?:write|writes|written|save[sd]?|output(?:s|ted)?|produces?|produced|creates?|generates?|exports?|stores?|emits?|prints?|dumps?|places?|puts?)\b/iu;
const PATH_OR_FILE = /(?:^|[\s`'"(=])(?:~|\.{1,2})?\/[\w.@+-]+|\b[\w-]+\.(?:json|jsonl|csv|tsv|txt|md|npz|npy|pkl|pt|parquet|ya?ml|xml|html?|png|jpe?g|svg|pdf|log|sql|db|sqlite|xlsx|toml|ini|wav|mp[34]|zip|tar|gz|bin|out)\b/iu;
const FORMAT = /\b(?:format(?:ted)?|schema|columns?|headers?|fields?|keys?|json|csv|tsv|yaml|one per line|newline-delimited)\b/iu;
const CLI = /(?:^|[\s`'"(])--[a-z][\w-]*|\busage:|\b(?:run|runs|invoked?|called|executed?) (?:as|with|like)\b/iu;

/** A sentence ends on this line: end punctuation at its end, or before a capital inside it. */
const SENTENCE_END = /[.!?]["'”’)\]]*(?:$|\s+\p{Lu})/u;
const ABBREVIATION =/(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|approx|incl|resp|al|fig|figs|eq|eqs|sec|no|nos|mr|mrs|ms|dr|st|viz)$/iu;
const CODE_SPAN = /`[^`\n]*`/gu;

/** How strongly a unit reads as a requirement; 0 is not one. */
export function requirementScore(unit: string): number {
  let score = 0;
  if (OBLIGATION.test(unit) || PROHIBITION.test(unit)) score += 3;
  else if (WEAK.test(unit)) score += 1;
  if (BOUND.test(unit)) score += 2;
  if (OUTPUT_VERB.test(unit) && (PATH_OR_FILE.test(unit) || FORMAT.test(unit))) score += 2;
  if (CLI.test(unit)) score += 2;
  return score;
}

type Block =
  | { kind: "prose"; lines: string[] }
  | { kind: "item"; indent: number; lines: string[] }
  | { kind: "row"; text: string }
  | { kind: "fence"; lines: string[] }
  | { kind: "heading" };

/** Markdown-ish blocks: paragraphs, list items (with their continuation lines and indent), table rows, fences and headings (HTML comments dropped). */
function blocksOf(text: string): Block[] {
  const lines = text.replace(/\r\n?/gu, "\n").replace(/<!--[\s\S]*?-->/gu, "").split("\n");
  const blocks: Block[] = [];
  let current: { kind: "prose"; lines: string[] } | { kind: "item"; indent: number; lines: string[] } | undefined;
  const flush = () => {
    // Bare lines with no sentence end anywhere (formulas, a list without markers) are list items, not one run-on sentence.
    if (current?.kind === "prose" && current.lines.length >= 2 && current.lines.every((line) => !SENTENCE_END.test(line))) {
      for (const line of current.lines) blocks.push({ kind: "item", indent: 0, lines: [line] });
    } else if (current !== undefined) {
      blocks.push(current);
    }
    current = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replaceAll("\t", "    ");
    const fence = /^\s*(`{3,}|~{3,})/u.exec(line);
    if (fence !== null) {
      flush();
      const close = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(close); i++) body.push(lines[i]!);
      blocks.push({ kind: "fence", lines: body });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^\s{0,3}#{1,6}(?:\s|$)/u.test(line)) {
      flush();
      blocks.push({ kind: "heading" });
      continue;
    }
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      flush();
      if (!/^\s*\|[\s:|-]+\|\s*$/u.test(line)) blocks.push({ kind: "row", text: line.trim() });
      continue;
    }
    const item = /^(\s*)(?:[-*+\u2022]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    if (item !== null) {
      flush();
      current = { kind: "item", indent: item[1]!.length, lines: [item[2]!.trim()] };
      continue;
    }
    if (current === undefined) current = { kind: "prose", lines: [] };
    current.lines.push(line.trim());
  }
  flush();
  return blocks;
}

/** Join a block's lines: a line break is a sentence break after end punctuation or before a capital, else a space. */
function joinLines(lines: string[]): string[] {
  const pieces: string[] = [];
  for (const line of lines) {
    const last = pieces.at(-1);
    if (last !== undefined && !/[.!?:]["'\u201d\u2019)\]]*$/u.test(last) && !/^[\p{Lu}`*]/u.test(line)) pieces[pieces.length - 1] = `${last} ${line}`;
    else pieces.push(line);
  }
  return pieces.map((piece) => piece.replace(/\s+/gu, " ").trim()).filter((piece) => piece !== "");
}

/** Sentences of one line of prose, never split inside an inline code span or after a known abbreviation; long ones split at "; " and " -- ". */
export function sentencesOf(text: string): string[] {
  const spans: string[] = [];
  const masked = text.replace(CODE_SPAN, (span) => `\u0000${spans.push(span) - 1}\u0001`);
  const out: string[] = [];
  let start = 0;
  for (const match of masked.matchAll(/[.!?]["'\u201d\u2019)\]]*\s+(?=[\p{Lu}\p{N}\u0000"'\u201c\u2018(\[*_])/gu)) {
    const end = match.index;
    if (masked[end] === "." && ABBREVIATION.test(masked.slice(start, end))) continue;
    out.push(masked.slice(start, end + match[0].trimEnd().length));
    start = end + match[0].length;
  }
  out.push(masked.slice(start));
  const unmask = (part: string) => part.replace(/\u0000(\d+)\u0001/gu, (_, index: string) => spans[Number(index)]!).trim();
  return out.flatMap((sentence) => {
    const whole = unmask(sentence);
    if (whole.length <= CLAUSE_SPLIT_CHARS) return [whole];
    return sentence.split(/;\s+|\s+--\s+/u).map(unmask);
  }).filter((sentence) => sentence !== "");
}

interface Unit {
  text: string;
  /** The lead-in (a unit ending in ":") this list item sits under. */
  lead?: Unit;
  /** The units of the list items right under this lead-in. */
  children?: Unit[][];
  absorbed?: true;
}

function unitsOf(text: string): Unit[] {
  const units: Unit[] = [];
  /** Open list items by indent; a prose unit ending in ":" leads the top-level items right after it. */
  let open: { indent: number; unit: Unit }[] = [];
  let proseLead: Unit | undefined;
  for (const block of blocksOf(text)) {
    if (block.kind === "item") {
      while (open.length > 0 && open.at(-1)!.indent >= block.indent) open.pop();
      const parent = open.length > 0 ? open.at(-1)!.unit : proseLead;
      const lead = parent?.text.endsWith(":") === true ? parent : undefined;
      const own = joinLines(block.lines).flatMap(sentencesOf).map((sentence): Unit => ({ text: sentence, ...(lead === undefined ? {} : { lead }) }));
      if (own.length === 0) continue;
      units.push(...own);
      if (lead !== undefined) (lead.children ??= []).push(own);
      open.push({ indent: block.indent, unit: own.at(-1)! });
      continue;
    }
    open = [];
    proseLead = undefined;
    if (block.kind === "heading") continue;
    if (block.kind === "row") {
      units.push({ text: block.text.replace(/\s+/gu, " ") });
      continue;
    }
    if (block.kind === "fence") {
      const last = units.at(-1);
      const lines = block.lines.map((line) => line.trim()).filter((line) => line !== "");
      if (last !== undefined && last.text.endsWith(":") && lines.length > 0 && lines.length <= FENCE_LINES && lines.every((line) => line.length <= FENCE_LINE_CHARS)) {
        last.text = `${last.text} ${lines.map((line) => (line.includes("`") ? line : `\`${line}\``)).join(" ")}`;
      }
      continue;
    }
    for (const piece of joinLines(block.lines)) for (const sentence of sentencesOf(piece)) units.push({ text: sentence });
    proseLead = units.at(-1);
  }
  // A lead-in with a few short, flat items reads as one requirement: "lead: a; b; c".
  for (const unit of units) {
    const items = unit.children;
    if (items === undefined || items.length > INLINE_ITEMS) continue;
    if (!items.every((item) => item.length === 1 && item[0]!.children === undefined && item[0]!.text.length <= INLINE_ITEM_CHARS)) continue;
    unit.text = `${unit.text} ${items.map((item) => item[0]!.text.replace(/[.;,]+$/u, "")).join("; ")}`;
    for (const item of items) item[0]!.absorbed = true;
  }
  return units.filter((unit) => unit.absorbed !== true);
}

/** A unit's own score, or its lead-in's when higher (a list under "must hold:" is a list of requirements). */
const scoreOf = (unit: Unit): number => Math.max(requirementScore(unit.text), unit.lead === undefined ? 0 : scoreOf(unit.lead));

const keyOf = (text: string) => text.toLowerCase().replace(/[`*]/gu, "").replace(/\s+/gu, " ").replace(/^[\s.;:,]+|[\s.;:,]+$/gu, "");

/** The task's requirement sentences in task order (at most `maxItems`), and how many more matched. Pure and deterministic. */
export function extractRequirements(task: string, maxItems: number): { items: string[]; more: number } {
  const picked: { text: string; score: number; index: number }[] = [];
  const keys: string[] = [];
  for (const unit of unitsOf(task)) {
    const score = scoreOf(unit);
    if (score === 0) continue;
    const key = keyOf(unit.text);
    if (key === "" || keys.some((seen) => seen.includes(key))) continue;
    keys.push(key);
    picked.push({ text: unit.text, score, index: picked.length });
  }
  const kept = [...picked].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, maxItems).sort((a, b) => a.index - b.index);
  return { items: kept.map((item) => item.text), more: picked.length - kept.length };
}

/** What run.ts appends to the first user message (undefined text: nothing matched, nothing appended). */
export interface RequirementsBlock {
  text?: string;
  items: number;
  more: number;
  tokens: number;
  placebo: boolean;
}

/**
 * The block for this task under the loadout's prompt.requirements, or
 * undefined when the lever is off. The placebo arm gets neutral text of the
 * block's estimated token count in the same place (and nothing when the list
 * is empty, as the real arm).
 */
export function requirementsBlock(loadout: Loadout, task: string): RequirementsBlock | undefined {
  const lever = loadout.prompt.requirements;
  if (lever === undefined) return undefined;
  const placebo = loadout.prompt.requirements_placebo === true;
  const { items, more } = extractRequirements(task, lever.max_items);
  if (items.length === 0) return { items: 0, more: 0, tokens: 0, placebo };
  const numbered = items.map((item, index) => `${index + 1}. ${item}`);
  if (more > 0) numbered.push(lever.more.replaceAll("{count}", String(more)));
  const block = lever.text.replaceAll("{list}", numbered.join("\n"));
  const text = placebo ? placeboFor("requirements", block) : block;
  return { text, items: items.length, more, tokens: estimateTokens(text), placebo };
}
