/**
 * The `exec` cell's input and result as Codex CLI frames them (rust-v0.166,
 * Apache-2.0; ported from the climb branch's exec-tools.ts): the optional
 * `// @exec: {...}` pragma, the bytes/4 token estimate, head-and-tail token
 * truncation under `Warning: truncated output`, and the
 * `Script completed|failed|terminated|running with cell ID N / Wall time / Output:`
 * header. GPT-6.x is post-trained on these exact strings.
 */
import { cutEnd, cutStart, estimateTokens, type TokenEstimate } from "../tokens.ts";
import { withoutUntilTimes } from "../wait-until.ts";

/** Codex's grammar for the `exec` input: an optional pragma line, then JavaScript source. */
export const EXEC_LARK_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export interface ParsedExecSource {
  code: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

const PRAGMA_PREFIX = "// @exec:";
const PRAGMA_FIELDS = "`yield_time_ms` and `max_output_tokens`";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Codex's `parse_exec_source`: the source and the first-line pragma's fields. Throws Codex's messages. */
export function parseExecSource(input: string): ParsedExecSource {
  if (input.trim() === "") {
    throw new Error("exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line " +
      "`// @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}`.");
  }
  const newline = input.indexOf("\n");
  const first = newline < 0 ? input : input.slice(0, newline);
  const rest = newline < 0 ? "" : input.slice(newline + 1);
  const trimmed = first.trimStart();
  if (!trimmed.startsWith(PRAGMA_PREFIX)) return { code: input };
  if (rest.trim() === "") throw new Error("exec pragma must be followed by JavaScript source on subsequent lines");
  const directive = trimmed.slice(PRAGMA_PREFIX.length).trim();
  const notObject = `exec pragma must be a JSON object with supported fields ${PRAGMA_FIELDS}`;
  if (directive === "") throw new Error(notObject);
  let value: unknown;
  try {
    value = JSON.parse(directive);
  } catch (error) {
    throw new Error(`exec pragma must be valid JSON with supported fields ${PRAGMA_FIELDS}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(notObject);
  for (const key of Object.keys(value)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") throw new Error(`exec pragma only supports ${PRAGMA_FIELDS}; got \`${key}\``);
  }
  const field = (name: "yield_time_ms" | "max_output_tokens"): number | undefined => {
    const item = value[name];
    if (item === undefined || item === null) return undefined;
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) {
      throw new Error(`exec pragma fields ${PRAGMA_FIELDS} must be non-negative safe integers: invalid value for \`${name}\``);
    }
    return item;
  };
  const yieldTimeMs = field("yield_time_ms");
  const maxOutputTokens = field("max_output_tokens");
  return { code: rest, ...(yieldTimeMs === undefined ? {} : { yieldTimeMs }), ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) };
}

/** Codex's approximate token count: UTF-8 bytes over 4, rounded up (`dense`: the run-class estimate, tokens.ts). */
export function approxTokenCount(text: string, mode: TokenEstimate = "bytes4"): number {
  return mode === "bytes4" ? Math.ceil(Buffer.byteLength(text, "utf8") / 4) : estimateTokens(text, mode);
}

function floorBoundary(bytes: Buffer, index: number): number {
  let position = Math.min(index, bytes.byteLength);
  while (position > 0 && position < bytes.byteLength && (bytes[position]! & 0xc0) === 0x80) position--;
  return position;
}

function ceilBoundary(bytes: Buffer, index: number): number {
  let position = Math.max(0, index);
  while (position < bytes.byteLength && (bytes[position]! & 0xc0) === 0x80) position++;
  return position;
}

/**
 * Codex's `truncate_middle_with_token_budget`: head and tail halves of `maxTokens * 4` bytes around a token marker.
 * `dense`: the longest head and tail of half the budget each by the dense estimate, the marker counting the cut part.
 */
export function truncateMiddleTokens(text: string, maxTokens: number, mode: TokenEstimate = "bytes4"): string {
  if (text === "") return "";
  if (mode !== "bytes4") {
    if (maxTokens > 0 && estimateTokens(text, mode) <= maxTokens) return text;
    if (maxTokens <= 0) return `…${estimateTokens(text, mode)} tokens truncated…`;
    const half = Math.floor(maxTokens / 2);
    const head = cutStart(text, half);
    const tail = cutEnd(text.slice(head.length), maxTokens - half);
    return `${head}…${estimateTokens(text.slice(head.length, text.length - tail.length), mode)} tokens truncated…${tail}`;
  }
  const bytes = Buffer.from(text, "utf8");
  const budget = maxTokens * 4;
  if (bytes.byteLength <= budget && maxTokens > 0) return text;
  if (budget === 0) return `…${Math.ceil(bytes.byteLength / 4)} tokens truncated…`;
  const left = Math.floor(budget / 2);
  const head = bytes.subarray(0, floorBoundary(bytes, left)).toString("utf8");
  const tail = bytes.subarray(ceilBoundary(bytes, bytes.byteLength - (budget - left))).toString("utf8");
  return `${head}…${Math.ceil((bytes.byteLength - budget) / 4)} tokens truncated…${tail}`;
}

/**
 * exec.cut_notice: where Codex's middle cut falls, as the 1-based output lines it removed (the lines at either edge may
 * be partly shown). `undefined` when nothing is cut. Same cut as truncateMiddleTokens.
 */
export function omittedLines(text: string, maxTokens: number, mode: TokenEstimate = "bytes4"): { first: number; last: number } | undefined {
  if (!overBudget(text, maxTokens, mode) || text === "") return undefined;
  let headChars: number;
  let tailChars: number;
  if (mode !== "bytes4") {
    if (maxTokens <= 0) return { first: 1, last: Math.max(1, lineCount(text)) };
    const half = Math.floor(maxTokens / 2);
    const head = cutStart(text, half);
    headChars = head.length;
    tailChars = cutEnd(text.slice(head.length), maxTokens - half).length;
  } else {
    const bytes = Buffer.from(text, "utf8");
    const budget = maxTokens * 4;
    if (budget === 0) return { first: 1, last: Math.max(1, lineCount(text)) };
    const left = Math.floor(budget / 2);
    headChars = bytes.subarray(0, floorBoundary(bytes, left)).toString("utf8").length;
    tailChars = bytes.subarray(ceilBoundary(bytes, bytes.byteLength - (budget - left))).toString("utf8").length;
  }
  const newlines = (part: string) => part.split("\n").length - 1;
  const first = newlines(text.slice(0, headChars)) + 1;
  const lastIndex = Math.max(headChars, text.length - tailChars - 1);
  return { first, last: Math.max(first, newlines(text.slice(0, lastIndex)) + 1) };
}

/**
 * exec.cut_notice: Codex's truncation warning plus how to get the rest: the full output's file (when it was saved)
 * and the output lines the cut removed, as a ready `sed -n` range on that file. Within budget: the text as is.
 */
export function cutNoticeText(text: string, maxTokens: number, spill: string | undefined, mode: TokenEstimate = "bytes4"): string {
  if (!overBudget(text, maxTokens, mode)) return text;
  const cut = omittedLines(text, maxTokens, mode);
  const rest = cut === undefined ? "" : spill === undefined
    ? `Omitted: output lines ${cut.first}-${cut.last}\n`
    : `Omitted: output lines ${cut.first}-${cut.last} (sed -n '${cut.first},${cut.last}p' ${spill})\n`;
  return `Warning: truncated output (original token count: ${approxTokenCount(text, mode)})\nTotal output lines: ${lineCount(text)}\n` +
    `${spill === undefined ? "" : `Full output: ${spill}\n`}${rest}\n${truncateMiddleTokens(text, maxTokens, mode)}`;
}

/** Rust's `str::lines().count()`: a final newline ends the last line rather than starting another. */
function lineCount(text: string): number {
  if (text === "") return 0;
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

/** Codex's `formatted_truncate_text`: over budget, a warning with the original size, then the middle-cut text. */
export function formattedTruncateText(text: string, maxTokens: number, spill?: string, mode: TokenEstimate = "bytes4"): string {
  if (!overBudget(text, maxTokens, mode)) return text;
  return `Warning: truncated output (original token count: ${approxTokenCount(text, mode)})\nTotal output lines: ${lineCount(text)}\n` +
    `${spill === undefined ? "" : `Full output: ${spill}\n`}\n${truncateMiddleTokens(text, maxTokens, mode)}`;
}

export function overBudget(text: string, maxTokens: number, mode: TokenEstimate = "bytes4"): boolean {
  return mode === "bytes4" ? Buffer.byteLength(text, "utf8") > maxTokens * 4 : estimateTokens(text, mode) > maxTokens;
}

export type CellStatus = "completed" | "failed" | "terminated" | { running: number };

/** The header line Codex puts before a cell's output. */
export function cellStatusLine(status: CellStatus): string {
  if (typeof status === "object") return `Script running with cell ID ${status.running}`;
  return status === "completed" ? "Script completed" : status === "failed" ? "Script failed" : "Script terminated";
}

/**
 * Codex's cell result text: status, wall time to a tenth of a second,
 * `Output:`, then the text items. Within budget the items are concatenated as
 * written; over it they are joined by newlines and middle-cut under the
 * truncation warning. A failure's `Script error:` item comes last.
 */
export function cellResultText(status: CellStatus, wallSeconds: number, items: readonly string[], maxTokens: number, spill?: string, mode: TokenEstimate = "bytes4", cutNotice = false): { text: string; truncated: boolean } {
  const combined = items.join("\n");
  const truncated = overBudget(combined, maxTokens, mode);
  const body = truncated ? (cutNotice ? cutNoticeText(combined, maxTokens, spill, mode) : formattedTruncateText(combined, maxTokens, spill, mode)) : items.join("");
  const wall = (Math.round(wallSeconds * 10) / 10).toFixed(1);
  return { text: `${cellStatusLine(status)}\nWall time ${wall} seconds\nOutput:\n${body}`, truncated };
}

/**
 * A cell result without its run-to-run noise, for the policy's repeat
 * detection: the wall time line, the cell ID, the spill path, the full-log
 * path an R1-shaped output names (one file per call), an R2 until line's
 * elapsed time, and the per-call `chunk_id`, `wall_time_seconds` and
 * `session_id` of any exec_command record the script printed as JSON. Two
 * runs of the same failing command then compare equal, as they do on the
 * compact surface.
 */
export function execRepeatKey(text: string, images = 0): string {
  return withoutUntilTimes(text)
    .replace(/^Wall time \d+(?:\.\d+)? seconds$/mu, "Wall time")
    .replace(/^(Script running with cell ID )\d+$/mu, "$1#")
    .replace(/^Full output: .*$/mu, "Full output: #")
    .replace(/full log: [^\s\]"\\]+/gu, "full log: #")
    .replace(/(\\*"chunk_id\\*":\s*)\\*"[0-9a-f]*\\*"/gu, "$1#")
    .replace(/(\\*"(?:wall_time_seconds|session_id)\\*":\s*)-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu, "$1#") +
    (images > 0 ? `\n[${images} image${images === 1 ? "" : "s"}]` : "");
}

/** exec.cut_notice's repeat key: also without the per-call spill paths its notices name (inside records too). */
export function cutNoticeRepeatKey(key: string): string {
  if (!key.includes("Omitted: output lines")) return key;
  return key.replace(/Full output: [^\s"\\]+/gu, "Full output: #").replace(/(sed -n '\d+,\d+p' )[^\s)"\\]+/gu, "$1#");
}
