/**
 * `apply_patch`: the Codex CLI patch format that GPT models are trained to
 * emit, implemented from the format (Codex is Apache-2.0; nothing is ported).
 * Benchmark sandboxes put it on PATH so a model working only through bash can
 * edit files the way it learned to, instead of through sed and heredocs.
 *
 *   *** Begin Patch
 *   *** Add File: <path>          every line follows as `+<line>`
 *   *** Delete File: <path>
 *   *** Update File: <path>
 *   *** Move to: <path>           optional, right after Update File
 *   @@ <line to seek to>          optional, one or several
 *    <context>  -<removed>  +<added>
 *   *** End of File               optional: the chunk sits at the end of the file
 *   *** End Patch
 *
 * All-or-nothing: every hunk is applied to in-memory copies of the files
 * before anything is written, so a chunk that does not match leaves the tree
 * as it was and the model resends one corrected patch instead of first
 * working out which half of its edit landed.
 */

export type PatchLineOp = " " | "-" | "+";

export interface PatchChunk {
  /** `@@ <text>` headers, sought in order before the chunk's own lines (a class, then a method). */
  readonly contexts: readonly string[];
  readonly lines: ReadonlyArray<{ readonly op: PatchLineOp; readonly text: string }>;
  /** `*** End of File`: the chunk's old lines are the file's last lines. */
  readonly endOfFile: boolean;
  /** 1-based line of the patch where the chunk starts, for error messages. */
  readonly patchLine: number;
}

export type PatchHunk =
  | { readonly kind: "add"; readonly path: string; readonly contents: string }
  | { readonly kind: "delete"; readonly path: string }
  | { readonly kind: "update"; readonly path: string; readonly moveTo?: string; readonly chunks: readonly PatchChunk[] };

/** File access for {@link applyPatch}; the caller decides what a patch path names. */
export interface PatchIO {
  /** The file's text, or undefined when it does not exist. */
  read(path: string): Promise<string | undefined>;
  /** Writes the file, creating its parent directories. */
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * The key a patch path names (e.g. an absolute path), so `./a.py` and `a.py`
   * in one patch share one in-memory copy. When given, read/write/remove
   * receive the resolved path. Defaults to the path as written.
   */
  resolve?(path: string): string;
}

export interface PatchSummary {
  readonly added: string[];
  readonly modified: string[];
  readonly deleted: string[];
  /** Some file was written or removed; false when every hunk left its file as it was. */
  readonly changed: boolean;
}

/** A patch that cannot apply as written. Thrown before anything is written. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File:";
const DELETE = "*** Delete File:";
const UPDATE = "*** Update File:";
const MOVE = "*** Move to:";
const END_OF_FILE = "*** End of File";
/** `apply_patch <<'EOF'` handed over as one argument with no shell to strip the heredoc. */
const HEREDOC = /^<<-?\s*(['"]?)(\w+)\1$/u;
/** `@@ -12,5 +12,6 @@ def f():` from unified-diff habit: the ranges mean nothing here, the trailing text is the context. */
const UNIFIED_RANGES = /^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@\s*/u;
const HUNK_HEADERS = `"${ADD} <path>", "${DELETE} <path>" or "${UPDATE} <path>"`;

/**
 * Parses a patch into hunks. Lenient where models drift without ambiguity:
 * CRLF patch text, blank lines around the patch and between hunks, a heredoc
 * wrapper, an unprefixed blank line inside Add File, a context line missing
 * its leading space, unified-diff ranges in `@@` headers.
 */
export function parsePatch(text: string): PatchHunk[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const blank = (n: number) => lines[n]!.trim() === "";
  let first = 0;
  let last = lines.length - 1;
  const trimBlank = () => {
    while (first <= last && blank(first)) first++;
    while (last >= first && blank(last)) last--;
  };
  trimBlank();
  const heredoc = first < last ? HEREDOC.exec(lines[first]!.trim()) : null;
  if (heredoc !== null && lines[last]!.trim() === heredoc[2]) {
    first++;
    last--;
    trimBlank();
  }
  if (first > last) throw new PatchError("invalid patch: it is empty; pass it as the first argument or on stdin");
  if (lines[first]!.trim() !== BEGIN) throw new PatchError(`invalid patch: the first line must be "${BEGIN}", got ${quote(lines[first]!)}`);
  if (first === last || lines[last]!.trim() !== END) throw new PatchError(`invalid patch: the last line must be "${END}", got ${quote(lines[last]!)}`);

  const hunks: PatchHunk[] = [];
  let i = first + 1;
  const at = (n: number) => `invalid patch: line ${n + 1}`;
  const pathAfter = (prefix: string, n: number) => {
    const path = lines[n]!.trim().slice(prefix.length).trim();
    if (path === "") throw new PatchError(`${at(n)}: "${prefix}" needs a path`);
    return path;
  };
  while (i < last) {
    const header = lines[i]!.trim();
    if (header === "") {
      i++;
    } else if (header.startsWith(ADD)) {
      const path = pathAfter(ADD, i++);
      const body: string[] = [];
      while (i < last) {
        const line = lines[i]!;
        if (line.startsWith("+")) {
          body.push(line.slice(1));
          i++;
          continue;
        }
        if (line.trim() === "") {
          // A blank line between `+` lines is an empty line whose `+` the model dropped; trailing ones end the file.
          let next = i;
          while (next < last && blank(next)) next++;
          if (next < last && lines[next]!.startsWith("+")) {
            for (; i < next; i++) body.push("");
            continue;
          }
          break;
        }
        if (line.startsWith("***")) break;
        throw new PatchError(`${at(i)}: every line of Add File ${path} must start with "+", got ${quote(line)}`);
      }
      hunks.push({ kind: "add", path, contents: body.map((line) => `${line}\n`).join("") });
    } else if (header.startsWith(DELETE)) {
      hunks.push({ kind: "delete", path: pathAfter(DELETE, i++) });
    } else if (header.startsWith(UPDATE)) {
      const path = pathAfter(UPDATE, i++);
      const moveTo = i < last && lines[i]!.trim().startsWith(MOVE) ? pathAfter(MOVE, i++) : undefined;
      const chunks: PatchChunk[] = [];
      while (i < last && !lines[i]!.startsWith("***")) {
        if (blank(i)) {
          i++;
          continue;
        }
        const start = i;
        const contexts: string[] = [];
        for (; i < last && lines[i]!.startsWith("@@"); i++) {
          const context = lines[i]!.slice(2).replace(/^ /u, "").replace(UNIFIED_RANGES, "").trimEnd();
          if (context !== "") contexts.push(context);
        }
        const body: Array<{ op: PatchLineOp; text: string }> = [];
        let endOfFile = false;
        for (; i < last; i++) {
          const line = lines[i]!;
          if (line.trim() === END_OF_FILE) {
            endOfFile = true;
            i++;
            break;
          }
          if (line.startsWith("@@") || line.startsWith("***")) break;
          const op = line[0];
          // "" is a blank context line; any other unprefixed line is context whose leading space the model dropped.
          body.push(op === " " || op === "+" || op === "-" ? { op, text: line.slice(1) } : { op: " ", text: line });
        }
        if (body.length === 0) throw new PatchError(`${at(start)}: a chunk of Update File ${path} has no lines`);
        chunks.push({ contexts, lines: body, endOfFile, patchLine: start + 1 });
      }
      if (chunks.length === 0) throw new PatchError(`${at(i)}: Update File ${path} has no @@ chunk`);
      hunks.push(moveTo === undefined ? { kind: "update", path, chunks } : { kind: "update", path, moveTo, chunks });
    } else {
      throw new PatchError(`${at(i)}: ${quote(lines[i]!)} is not a hunk header; use ${HUNK_HEADERS}`);
    }
  }
  if (hunks.length === 0) throw new PatchError(`invalid patch: it has no hunks; use ${HUNK_HEADERS}`);
  return hunks;
}

/**
 * Applies a patch through `io`, all or nothing: every hunk is validated
 * against in-memory copies first (later hunks see earlier ones, as when
 * applied one by one), then all writes happen, then all removals, so a
 * failed write never follows a removed move source.
 */
export interface PatchOptions {
  /**
   * apply_patch.nearest: a chunk that does not match names the file's lines nearest to it (numbered, as the file has
   * them now), or where its lines sit when they are above an earlier chunk's match, so the model can fix the patch
   * without first re-reading the file (25 of 42 failed patches in the census were followed by a re-read request).
   */
  nearest?: boolean;
}

export async function applyPatch(text: string, io: PatchIO, options: PatchOptions = {}): Promise<PatchSummary> {
  const hunks = parsePatch(text);
  const resolve = (path: string) => io.resolve?.(path) ?? path;
  const files = new Map<string, { original: string | undefined; current: string | undefined }>();
  const load = async (path: string) => {
    const key = resolve(path);
    let file = files.get(key);
    if (file === undefined) {
      let original: string | undefined;
      try {
        original = await io.read(key);
      } catch (error) {
        throw new PatchError(`${path}: cannot read it (${error instanceof Error ? error.message : String(error)})`);
      }
      file = { original, current: original };
      files.set(key, file);
    }
    return file;
  };
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const hunk of hunks) {
    const file = await load(hunk.path);
    if (hunk.kind === "add") {
      file.current = hunk.contents;
      added.push(hunk.path);
      continue;
    }
    const verb = hunk.kind === "delete" ? "Delete File" : "Update File";
    if (file.current === undefined) throw new PatchError(`${verb} ${hunk.path}: no such file; use "${ADD} ${hunk.path}" to create it`);
    if (hunk.kind === "delete") {
      file.current = undefined;
      deleted.push(hunk.path);
      continue;
    }
    const next = updateText(hunk.path, file.current, hunk.chunks, options.nearest === true);
    if (hunk.moveTo !== undefined && resolve(hunk.moveTo) !== resolve(hunk.path)) {
      (await load(hunk.moveTo)).current = next;
      file.current = undefined;
      modified.push(hunk.moveTo);
    } else {
      file.current = next;
      modified.push(hunk.path);
    }
  }
  let changed = false;
  for (const [key, file] of files) {
    if (file.current !== undefined && file.current !== file.original) {
      await io.write(key, file.current);
      changed = true;
    }
  }
  for (const [key, file] of files) {
    if (file.current === undefined && file.original !== undefined) {
      await io.remove(key);
      changed = true;
    }
  }
  const unique = (paths: string[]) => [...new Set(paths)];
  return { added: unique(added), modified: unique(modified), deleted: unique(deleted), changed };
}

/** Codex's success text, line for line: models trained on Codex read it as "the edit landed". */
export function formatPatchSummary(summary: PatchSummary): string {
  return [
    "Success. Updated the following files:",
    ...summary.added.map((path) => `A ${path}`),
    ...summary.modified.map((path) => `M ${path}`),
    ...summary.deleted.map((path) => `D ${path}`),
  ].join("\n") + "\n";
}

/** Typographic punctuation a model may write for the ASCII in the file (or the reverse). */
const DASHES = /[‐-―−]/gu;
const SINGLE_QUOTES = /[‘-‛]/gu;
const DOUBLE_QUOTES = /[“-‟]/gu;
const SPACES = /[  -   　]/gu;
const normalize = (line: string) =>
  line.trim().replace(DASHES, "-").replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, "\"").replace(SPACES, " ");

/** Strictest first, as Codex matches: an exact match later in the file beats a loose one earlier. */
const MATCHERS: ReadonlyArray<(line: string, wanted: string) => boolean> = [
  (line, wanted) => line === wanted,
  (line, wanted) => line.trimEnd() === wanted.trimEnd(),
  (line, wanted) => line.trim() === wanted.trim(),
  (line, wanted) => normalize(line) === normalize(wanted),
];

/** First index at or after `from` where `pattern` matches, trying each matcher over the whole range before the next. */
function seek(lines: readonly string[], pattern: readonly string[], from: number): number {
  for (const same of MATCHERS) {
    for (let i = from; i + pattern.length <= lines.length; i++) {
      if (pattern.every((wanted, j) => same(lines[i + j]!, wanted))) return i;
    }
  }
  return -1;
}

/**
 * One Update File's chunks over the file's text. Context lines keep the
 * file's own text (a loose match must not rewrite indentation the model got
 * wrong on lines it did not mean to change), each line keeps its own ending
 * (CRLF stays CRLF, mixed files stay mixed), added lines take the file's
 * first ending, and the final newline stays as the original had it.
 */
function updateText(path: string, original: string, chunks: readonly PatchChunk[], nearest = false): string {
  const lines: string[] = [];
  const ends: string[] = [];
  for (const match of original.matchAll(/([^\n]*?)(\r?\n|$)/gu)) {
    if (match[0] === "" && match.index === original.length) break;
    lines.push(match[1]!);
    ends.push(match[2]!);
  }
  const eol = ends.find((end) => end !== "") ?? "\n";
  const finalNewline = original === "" || original.endsWith("\n");
  const edits: Array<{ start: number; remove: number; lines: string[]; ends: string[] }> = [];
  let cursor = 0;
  chunks.forEach((chunk, n) => {
    const where = `${path}: chunk ${n + 1} of ${chunks.length} (patch line ${chunk.patchLine})`;
    const after = (index: number) => (index > 0 ? ` after line ${index}` : "");
    let anchor = -1;
    for (const context of chunk.contexts) {
      const found = seek(lines, [context], cursor);
      if (found < 0) {
        const above = nearest && cursor > 0 ? seek(lines, [context], 0) : -1;
        if (above >= 0) throw new PatchError(`${where}: the @@ line ${quote(context)} is at line ${above + 1}, above where the previous chunk matched (line ${cursor}); ${IN_ORDER}`);
        throw new PatchError(`${where}: cannot find the @@ line ${quote(context)}${after(cursor)}; re-read ${path} and resend the patch`);
      }
      anchor = found;
      cursor = found + 1;
    }
    const added = chunk.lines.filter((line) => line.op === "+");
    if (added.length === chunk.lines.length) {
      // Only added lines: right after the @@ line they name, else at the end of the file.
      const at = chunk.contexts.length > 0 && !chunk.endOfFile ? cursor : lines.length;
      edits.push({ start: at, remove: 0, lines: added.map((line) => line.text), ends: added.map(() => eol) });
      return;
    }
    const find = (ops: PatchChunk["lines"]) => {
      const old = ops.filter((line) => line.op !== "+").map((line) => line.text);
      let found = chunk.endOfFile ? seek(lines, old, Math.max(cursor, lines.length - old.length)) : -1;
      if (found < 0) found = seek(lines, old, cursor);
      // The @@ line repeated as the chunk's first context line.
      if (found < 0 && anchor >= 0) found = seek(lines, old, anchor);
      return found;
    };
    let ops = chunk.lines;
    let start = find(ops);
    // A blank line after the chunk (often just spacing before the next header) parses as context the file may not have.
    while (start < 0 && ops.at(-1)?.op === " " && ops.at(-1)!.text.trim() === "" && ops.slice(0, -1).some((line) => line.op !== "+")) {
      ops = ops.slice(0, -1);
      start = find(ops);
    }
    if (start < 0) {
      const old = chunk.lines.filter((line) => line.op !== "+").map((line) => line.text);
      const missing = old.find((text) => text.trim() !== "" && !lines.some((line) => MATCHERS[3]!(line, text)));
      const shown = old.slice(0, 8).map(quote).join(", ") + (old.length > 8 ? `, ... (${old.length - 8} more)` : "");
      const why = missing === undefined ? "each line exists but not together in this order" : `${quote(missing)} is not in the file`;
      const head = `${where}: cannot find the context and removed lines [${shown}]${after(cursor)} (${why})`;
      if (nearest) {
        const above = cursor > 0 ? seek(lines, old, 0) : -1;
        if (above >= 0) throw new PatchError(`${head}; they are at lines ${above + 1}-${above + old.length}, above where the previous chunk matched (line ${cursor}); ${IN_ORDER}`);
        const window = nearestWindow(lines, old, cursor);
        if (window !== undefined) {
          throw new PatchError(`${head}; the nearest lines in ${path} (${window.start + 1}-${window.end}), as the file has them now:\n${numbered(lines, window)}\n` +
            "Fix the chunk from these lines and resend the patch.");
        }
      }
      throw new PatchError(`${head}; re-read ${path} and resend the patch`);
    }
    const edit = { start, remove: 0, lines: [] as string[], ends: [] as string[] };
    let k = start;
    for (const line of ops) {
      if (line.op === "+") {
        edit.lines.push(line.text);
        edit.ends.push(eol);
        continue;
      }
      if (line.op === " ") {
        edit.lines.push(lines[k]!);
        edit.ends.push(ends[k]!);
      }
      k++;
    }
    edit.remove = k - start;
    edits.push(edit);
    cursor = k;
  });
  // Stable sort, applied back to front: an insertion and a replacement at one index keep chunk order.
  edits.sort((a, b) => a.start - b.start);
  for (const edit of edits.reverse()) {
    lines.splice(edit.start, edit.remove, ...edit.lines);
    ends.splice(edit.start, edit.remove, ...edit.ends);
  }
  const lastLine = lines.length - 1;
  return lines.map((line, i) => line + (i < lastLine || finalNewline ? ends[i] || eol : "")).join("");
}

const IN_ORDER = "put the chunks of one Update File in file order and resend the patch";

/** At most this many file lines in a nearest-lines hint. */
const NEAREST_MAX_LINES = 24;

/**
 * The stretch of the file a chunk most likely meant: every non-blank old line votes for the start its matches in the
 * file imply (by the loosest matcher), weighted by how rare the line is, so `}` or `return` barely count; ties go to
 * the start nearest the cursor. One line of margin on each side covers a line the model added or dropped.
 */
export function nearestWindow(lines: readonly string[], old: readonly string[], cursor: number): { start: number; end: number } | undefined {
  const positions = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const key = normalize(line);
    if (key === "") return;
    const list = positions.get(key);
    if (list === undefined) positions.set(key, [index]);
    else list.push(index);
  });
  const votes = new Map<number, number>();
  old.forEach((text, offset) => {
    const at = positions.get(normalize(text));
    if (at === undefined || normalize(text) === "") return;
    for (const index of at) votes.set(index - offset, (votes.get(index - offset) ?? 0) + 1 / at.length);
  });
  let best: number | undefined;
  for (const [start, score] of votes) {
    const current = best === undefined ? -1 : votes.get(best)!;
    if (score > current + 1e-9 || (Math.abs(score - current) <= 1e-9 && Math.abs(start - cursor) < Math.abs(best! - cursor))) best = start;
  }
  if (best === undefined) return undefined;
  const start = Math.max(0, best - 1);
  const end = Math.min(lines.length, best + old.length + 1, start + NEAREST_MAX_LINES);
  return start < end ? { start, end } : undefined;
}

/** `cat -n` style lines, each cut at 200 characters. */
function numbered(lines: readonly string[], window: { start: number; end: number }): string {
  const out: string[] = [];
  for (let index = window.start; index < window.end; index++) {
    const line = lines[index]!;
    out.push(`${String(index + 1).padStart(6)}\t${line.length > 200 ? `${line.slice(0, 200)}...` : line}`);
  }
  return out.join("\n");
}

function quote(text: string): string {
  return JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}...` : text);
}
