/**
 * Token estimates for output budgets (`limits.token_estimate`).
 *
 * - `bytes4` (the default, Codex's): UTF-8 bytes over 4. Right for English
 *   prose; numbers, symbols, ids and sequences run 1.6-2.5 characters per
 *   token, so a "10k" budget ships up to 25k real tokens of them.
 * - `dense`: a linear scan over character-class runs, each with a fixed cost,
 *   fit to o200k_base counts of 5,000 recorded tool results (r1/r1b/r2 exec
 *   cells and exec_command outputs): median error 5% (bytes4: 20%), p90 13%
 *   (45%), aggregate +3% (-20%); on results under 2.5 characters per token,
 *   median 6% and aggregate +1% (bytes4: 46% and -49%). It errs high, so a
 *   budget ships at most about what it says.
 *   Costs: a word (letters; a camelCase hump starts a new one) 0.83 plus 0.58
 *   per letter past 12; an all-caps run of 4+ (ids, sequences) 0.5 a letter; a
 *   digit run 1.3 per group of 3 (o200k splits digits in threes); a space/tab
 *   run 0.5; a newline 0.73; a punctuation run 0.25 plus 0.38 a character for
 *   its first 8; any other character 0.62 per UTF-16 unit. Blank and
 *   punctuation runs past 8 characters add a token per 16 more, so a long
 *   repeat cannot slip past a budget.
 *
 * Costs add over runs, so a budget can cut text at the longest prefix or
 * suffix that fits (`cutStart`, `cutEnd`): linear time, no tokenizer.
 */
export type TokenEstimate = "bytes4" | "dense";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

const LETTER = 1, DIGIT = 2, BLANK = 3, NEWLINE = 4, PUNCT = 5, OTHER = 6;

function classOf(code: number): number {
  if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90)) return LETTER;
  if (code >= 48 && code <= 57) return DIGIT;
  if (code === 32 || code === 9) return BLANK;
  if (code === 10 || code === 13) return NEWLINE;
  return code < 128 ? PUNCT : OTHER;
}

const isUpper = (code: number) => code >= 65 && code <= 90;

/** The cost of a run of `n` characters of one class (`caps`: an all-caps letter run). */
function runCost(kind: number, n: number, caps: boolean): number {
  switch (kind) {
    case LETTER: return caps && n >= 4 ? 0.5 * n : 0.83 + 0.58 * Math.max(0, n - 12);
    case DIGIT: return 1.3 * Math.ceil(n / 3);
    case BLANK: return 0.5 + Math.max(0, n - 8) / 16;
    case NEWLINE: return 0.73 * n;
    case PUNCT: return 0.25 + 0.38 * Math.min(n, 8) + Math.max(0, n - 8) / 16;
    default: return 0.62 * n;
  }
}

/**
 * Each run of `text[from, to)` in order: start, end, class and whether it is
 * all caps. Letters split where a lowercase letter meets an uppercase one
 * (camelCase humps); newlines are one run each.
 */
function forEachRun(text: string, visit: (start: number, end: number, kind: number, caps: boolean) => boolean | void): void {
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    const kind = classOf(code);
    let j = i + 1;
    let caps = kind === LETTER && isUpper(code);
    if (kind === LETTER) {
      while (j < text.length) {
        const next = text.charCodeAt(j);
        if (classOf(next) !== LETTER) break;
        const up = isUpper(next);
        if (up && !isUpper(text.charCodeAt(j - 1))) break; // a new hump
        if (!up) caps = false;
        j++;
      }
    } else if (kind !== NEWLINE) {
      while (j < text.length && classOf(text.charCodeAt(j)) === kind) j++;
    }
    if (visit(i, j, kind, caps) === false) return;
    i = j;
  }
}

/** The estimated token count of `text`. */
export function estimateTokens(text: string, mode: TokenEstimate = "bytes4"): number {
  if (mode === "bytes4") return Math.ceil(bytes(text) / 4);
  let total = 0;
  forEachRun(text, (start, end, kind, caps) => {
    total += runCost(kind, end - start, caps);
  });
  return Math.ceil(total);
}

/** The most characters of a run whose partial cost fits `room` (cost grows with length). */
function fit(kind: number, caps: boolean, length: number, room: number): number {
  let low = 0, high = length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (runCost(kind, mid, caps) <= room) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Never split a surrogate pair. */
const safeEnd = (text: string, index: number) => (index > 0 && index < text.length && (text.charCodeAt(index) & 0xfc00) === 0xdc00 ? index - 1 : index);
const safeStart = (text: string, index: number) => (index > 0 && index < text.length && (text.charCodeAt(index) & 0xfc00) === 0xdc00 ? index + 1 : index);

/** The longest prefix of `text` whose dense estimate is at most `budget` tokens. */
export function cutStart(text: string, budget: number): string {
  let used = 0;
  let end = 0;
  forEachRun(text, (start, stop, kind, caps) => {
    const cost = runCost(kind, stop - start, caps);
    if (used + cost <= budget) {
      used += cost;
      end = stop;
      return true;
    }
    end = start + fit(kind, caps, stop - start, budget - used);
    return false;
  });
  return text.slice(0, safeEnd(text, end));
}

/** The longest suffix of `text` whose dense estimate is at most `budget` tokens. */
export function cutEnd(text: string, budget: number): string {
  const starts: number[] = [];
  const costs: number[] = [];
  const kinds: number[] = [];
  const capsOf: boolean[] = [];
  forEachRun(text, (start, stop, kind, caps) => {
    starts.push(start);
    costs.push(runCost(kind, stop - start, caps));
    kinds.push(kind);
    capsOf.push(caps);
  });
  let used = 0;
  let begin = text.length;
  for (let index = starts.length - 1; index >= 0; index--) {
    const stop = index + 1 < starts.length ? starts[index + 1]! : text.length;
    if (used + costs[index]! <= budget) {
      used += costs[index]!;
      begin = starts[index]!;
      continue;
    }
    begin = stop - fit(kinds[index]!, capsOf[index]!, stop - starts[index]!, budget - used);
    break;
  }
  return text.slice(safeStart(text, begin));
}
