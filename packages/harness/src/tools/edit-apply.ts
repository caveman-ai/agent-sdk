/**
 * Pi's edit contract (1.3/1.4): one or more exact replacements, each matched
 * against the original file (not incrementally), each unique, none
 * overlapping. Line endings are matched in LF space and restored; a BOM is
 * kept. With `fuzzy`, an oldText that matches nowhere exactly may match one
 * line window after Pi's normalization (NFKC, trailing whitespace, smart
 * quotes, Unicode dashes and spaces); anything ambiguous still fails.
 * Messages follow Pi's wording, which the models were trained on.
 */
export interface TextEdit {
  oldText: string;
  newText: string;
}

export interface AppliedEdits {
  text: string;
  replaced: number;
  fuzzy: number;
}

function normalizeLine(line: string): string {
  return line.normalize("NFKC")
    .trimEnd()
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‐‑‒–—―−]/gu, "-")
    .replace(/[  -   　]/gu, " ");
}

function occurrences(content: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/** One line window of `content` equal to `oldText` after normalization: [start, end) and whether a newline was consumed. */
function fuzzyWindow(content: string, oldText: string): { start: number; end: number; count: number } {
  const wanted = oldText.split("\n");
  if (wanted.length > 1 && wanted.at(-1) === "") wanted.pop();
  const target = wanted.map(normalizeLine);
  const starts = [0];
  for (let at = content.indexOf("\n"); at !== -1; at = content.indexOf("\n", at + 1)) starts.push(at + 1);
  const lines = starts.map((start, index) => content.slice(start, index + 1 < starts.length ? starts[index + 1]! - 1 : content.length));
  const normalized = lines.map(normalizeLine);
  let match = -1;
  let count = 0;
  for (let first = 0; first + target.length <= lines.length; first++) {
    let equal = true;
    for (let offset = 0; offset < target.length && equal; offset++) equal = normalized[first + offset] === target[offset];
    if (equal) {
      count++;
      if (match === -1) match = first;
    }
  }
  if (count !== 1) return { start: -1, end: -1, count };
  const last = match + target.length - 1;
  return { start: starts[match]!, end: starts[last]! + lines[last]!.length, count };
}

const label = (index: number, total: number, single: string) => (total === 1 ? single : `edits[${index}]`);

export function applyEdits(original: string, edits: readonly TextEdit[], path: string, options: { fuzzy?: boolean } = {}): AppliedEdits {
  if (edits.length === 0) throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  const bom = original.startsWith("﻿") ? "﻿" : "";
  const body = original.slice(bom.length);
  const crlf = /\r\n/u.test(body) && body.indexOf("\r\n") <= body.indexOf("\n");
  const content = body.replace(/\r\n/gu, "\n");
  const spans: { start: number; end: number; replacement: string; index: number }[] = [];
  let fuzzy = 0;
  edits.forEach((edit, index) => {
    if (typeof edit?.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error(`${label(index, edits.length, "oldText")} and newText must be strings.`);
    }
    const oldText = edit.oldText.replace(/\r\n/gu, "\n");
    const newText = edit.newText.replace(/\r\n/gu, "\n");
    if (oldText === "") {
      throw new Error(edits.length === 1 ? `oldText must not be empty in ${path}.` : `edits[${index}].oldText must not be empty in ${path}.`);
    }
    const found = occurrences(content, oldText);
    if (found.length > 1) {
      throw new Error(edits.length === 1
        ? `Found ${found.length} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
        : `Found ${found.length} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
    }
    if (found.length === 1) {
      spans.push({ start: found[0]!, end: found[0]! + oldText.length, replacement: newText, index });
      return;
    }
    if (options.fuzzy === true) {
      const window = fuzzyWindow(content, oldText);
      if (window.count === 1) {
        // The window stops before its last line break: drop the one newText carries for it.
        const replacement = oldText.endsWith("\n") && newText.endsWith("\n") ? newText.slice(0, -1) : newText;
        spans.push({ start: window.start, end: window.end, replacement, index });
        fuzzy++;
        return;
      }
      if (window.count > 1) {
        throw new Error(`Found ${window.count} occurrences of ${label(index, edits.length, "the text")} in ${path}. Please provide more context to make it unique.`);
      }
    }
    throw new Error(edits.length === 1
      ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
      : `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
  });
  spans.sort((left, right) => left.start - right.start);
  for (let index = 1; index < spans.length; index++) {
    const previous = spans[index - 1]!;
    const current = spans[index]!;
    if (current.start < previous.end) {
      throw new Error(`edits[${previous.index}] and edits[${current.index}] overlap in ${path}. Merge them into one edit or target disjoint regions.`);
    }
  }
  // Slices, never String.prototype.replace: newText may hold `$&` or `$1`.
  let text = "";
  let cursor = 0;
  for (const span of spans) {
    text += content.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  text += content.slice(cursor);
  if (text === content) {
    throw new Error(edits.length === 1
      ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
      : `No changes made to ${path}. The replacements produced identical content.`);
  }
  return { text: bom + (crlf ? text.replace(/\n/gu, "\r\n") : text), replaced: spans.length, fuzzy };
}
