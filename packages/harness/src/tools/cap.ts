/**
 * Output caps. A file read keeps its head (the model pages on with offset); a
 * command keeps its head and its tail: the head holds what the command printed
 * first (the first files of `cat a b c`), the tail holds the result and the
 * failure a test run ends with. Ported from the climb branch's output-cap.ts
 * (P1: 139 of 154 tail-only capped reads were re-read within five calls).
 */

export interface Capped {
  text: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  keptLines: number;
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** `text` cut to a byte budget at a character boundary, from the start or the end. */
function cutBytes(text: string, maxBytes: number, from: "start" | "end"): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  if (from === "start") {
    let end = maxBytes;
    while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
    return encoded.subarray(0, end).toString("utf8");
  }
  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
  return encoded.subarray(start).toString("utf8");
}

/** The first lines of `text` that fit both limits; a first line over the byte limit is cut at a character. */
export function capHead(text: string, maxLines: number, maxBytes: number): Capped & { cutLine: boolean } {
  const lines = text.split("\n");
  const totalBytes = bytes(text);
  let used = 0;
  let kept = 0;
  for (const line of lines.slice(0, maxLines)) {
    const size = bytes(line) + (kept === 0 ? 0 : 1);
    if (used + size > maxBytes) break;
    used += size;
    kept++;
  }
  if (kept === 0 && lines.length > 0 && text !== "") {
    return { text: cutBytes(lines[0]!, maxBytes, "start"), truncated: true, totalLines: lines.length, totalBytes, keptLines: 1, cutLine: true };
  }
  return { text: lines.slice(0, kept).join("\n"), truncated: kept < lines.length, totalLines: lines.length, totalBytes, keptLines: kept, cutLine: false };
}

/**
 * `text` within `maxLines` and `maxBytes`: about a third from the head, the rest
 * from the tail, `marker(omittedLines, omittedBytes)` on its own line between.
 */
export function capHeadTail(text: string, maxLines: number, maxBytes: number, marker: (lines: number, bytes: number) => string): Capped {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const totalBytes = bytes(text);
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { text, truncated: false, totalLines: lines.length, totalBytes, keptLines: lines.length };
  }
  const budget = Math.max(64, maxBytes - bytes(marker(lines.length, totalBytes)) - 2);
  const lineBudget = Math.max(2, maxLines - 1);
  const headBytes = Math.floor(budget / 3);
  const headLines = Math.max(1, Math.floor(lineBudget / 3));
  let head = 0;
  let used = 0;
  while (head < lines.length && head < headLines) {
    const size = bytes(lines[head]!) + 1;
    if (used + size > headBytes) break;
    used += size;
    head++;
  }
  let tail = 0;
  while (tail < lines.length - head && head + tail < lineBudget) {
    const size = bytes(lines[lines.length - 1 - tail]!) + 1;
    if (used + size > budget) break;
    used += size;
    tail++;
  }
  if (head === 0 && tail === 0) {
    // One huge line (minified output, a progress bar): cut by bytes at both ends.
    const front = cutBytes(text, Math.floor(budget / 3), "start");
    const back = cutBytes(text, budget - bytes(front), "end");
    const omitted = totalBytes - bytes(front) - bytes(back);
    return { text: `${front}\n${marker(0, omitted)}\n${back}`, truncated: true, totalLines: lines.length, totalBytes, keptLines: 0 };
  }
  const kept = [...lines.slice(0, head), ...lines.slice(lines.length - tail)];
  const omittedLines = lines.length - head - tail;
  const omittedBytes = totalBytes - kept.reduce((sum, line) => sum + bytes(line) + 1, 0);
  const parts = [...lines.slice(0, head), marker(omittedLines, Math.max(0, omittedBytes)), ...lines.slice(lines.length - tail)];
  return { text: parts.join("\n"), truncated: true, totalLines: lines.length, totalBytes, keptLines: head + tail };
}
