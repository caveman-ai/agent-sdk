/**
 * travel_check and unmet_target (finish-time, levers.ts runs them).
 *
 * travel_check: the work may be checked in a fresh copy of the starting
 * environment that receives only the task's deliverables (TB4's
 * environment_mode "separate"). Correct work in the run's own sandbox then
 * fails in three mechanical ways, each found here without a model call:
 * - packages: a Python package installed during the run (a distribution the
 *   start snapshot lacked: pip, uv, or apt's python3-* which install
 *   .dist-info/.egg-info too) that a file the run wrote imports;
 * - data: a file the run wrote names, by a string-literal path, a file that
 *   existed before the run and that the run did not write (outside system
 *   trees, not tracked by git, not named in the task);
 * - scratch: test/scratch-looking files the run created in the working tree
 *   (test_*, *_test.*, check*, debug*, scratch*, *.log, *.bak) that the task
 *   does not name; a test file next to tests that were there at the start is
 *   the project's convention, not scratch. __pycache__ dirs the run created
 *   are listed only when something else fires (alone they are noise).
 * Every env command is `internal` (handles h<n>), so the model's p<n> handles
 * never shift. The start state is a marker file in the scratch dir (files
 * newer than it are the run's), the scratch-looking files and test dirs
 * present, and a package snapshot.
 *
 * unmet_target: a draft final that says a numeric target the task set is
 * not met ("78.09%, below the requested 98%") while most of the wall budget
 * is left. `unmetSentence` is pure; scripts/replay-travel.ts runs it over
 * recorded finals.
 *
 * The pure parts (scratchKind, scratchFindings, pathLiterals, fileCandidates,
 * pythonImports, packageFindings, unmetSentence) are what the offline replay
 * runs.
 */
import { posix } from "node:path";
import type { ExecEnv } from "./env/types.ts";

// ---------- scratch files ----------

/** Directory names whose files are build output, vendored or caches: never scanned. */
const PRUNE = [".git", "node_modules", ".venv", "venv", "site-packages", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".cache", "target", "dist", "build"];
const PRUNE_DIR = new RegExp(`(?:^|/)(?:${PRUNE.map((name) => name.replace(/\./gu, "\\.")).join("|")})/`, "u");

/** Test-named files: a project's own convention where tests already lived at the start. */
const TEST_NAME = /^(?:test_.+|.+_test\.[^./]+|.+\.(?:test|spec)\.[^./]+|tests?\.[^./]+)$/u;
/** Other scratch names: a checker, debug or scratch script, a log, a backup. */
const OTHER_SCRATCH = /^(?:checks?(?:[_.-].*)?|debug(?:[_.-].*)?|scratch.*|.+\.(?:log|bak))$/iu;
const TEST_DIRS = new Set(["test", "tests", "testing", "__tests__", "spec"]);

export type ScratchKind = "test" | "scratch";

/** Whether a workspace-relative path looks like a test or scratch file (vendored, build and cache trees excluded). */
export function scratchKind(path: string): ScratchKind | undefined {
  if (PRUNE_DIR.test(path) || path.includes("__pycache__/")) return undefined;
  const name = posix.basename(path);
  if (TEST_NAME.test(name)) return "test";
  if (OTHER_SCRATCH.test(name)) {
    // A log inside a logs/ directory is what the program was asked to keep.
    if (/\.log$/iu.test(name) && path.split("/").slice(0, -1).some((dir) => /^logs?$/iu.test(dir))) return undefined;
    return "scratch";
  }
  return undefined;
}

/** Whether the task text names a path: whole, relative to the cwd, or by its file name. */
export function mentioned(task: string, path: string, cwd?: string): boolean {
  const name = posix.basename(path);
  if (name !== "" && task.includes(name)) return true;
  if (task.includes(path)) return true;
  if (cwd !== undefined && path.startsWith(`${cwd}/`) && task.includes(path.slice(cwd.length + 1))) return true;
  return false;
}

/**
 * The scratch files the run created: workspace-relative `created` paths that
 * look like tests or scratch, minus those the task names, those present at
 * the start (`start`: the scratch-looking files and test dirs then), and test
 * files that follow a test layout: under a test directory (tests/, test/,
 * __tests__/, ...; a suite, vendored or the project's) or in a directory that
 * held tests at the start. What remains is a test dropped among the
 * deliverables (/app/test_wal.py).
 */
export function scratchFindings(created: readonly string[], start: ReadonlySet<string>, task: string): string[] {
  const conventional = testLayout(start);
  return created.filter((path) => {
    const kind = scratchKind(path);
    if (kind === undefined || start.has(path) || mentioned(task, path)) return false;
    return !(kind === "test" && conventional(path));
  }).sort();
}

/**
 * Whether a workspace-relative path is in the project's test layout: under a
 * test directory (tests/, test/, __tests__/, ...) or under a directory that
 * held tests at the start (`start`: the scratch-looking paths then).
 */
export function testLayout(start: ReadonlySet<string>): (path: string) => boolean {
  const testDirs = new Set<string>();
  for (const path of start) {
    if (TEST_DIRS.has(posix.basename(path))) testDirs.add(path);
    else if (scratchKind(path) === "test") testDirs.add(posix.dirname(path));
  }
  return (path: string) => {
    if (posix.dirname(path).split("/").some((dir) => TEST_DIRS.has(dir))) return true;
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      if (testDirs.has(dir)) return true;
      if (dir === "." || dir === "/" || dir === "") return false;
    }
  };
}

// ---------- data read by path literal ----------

/** Code the scan reads for imports and path literals. */
const CODE_EXT = /\.(?:py|pyw|js|mjs|cjs|ts|mts|cts|jsx|tsx|sh|bash|rb|pl|php|go|rs|c|cc|cpp|cxx|h|hpp|java|kt|scala|r|jl|lua|swift)$/iu;
export const isCode = (path: string) => CODE_EXT.test(path) && scratchKind(path) === undefined && !path.includes("__pycache__/") && !PRUNE_DIR.test(path);
/** Whether a path has a source-code extension (scratch-named or not). */
export const codeExtension = (path: string) => CODE_EXT.test(path);

/** System trees a deliverable may read anywhere: never data the task's files must carry. */
const SYSTEM = /^\/(?:usr|etc|proc|dev|tmp|sys|bin|sbin|lib|lib32|lib64|run|var|boot|nix|snap)(?:\/|$)/u;
export const inSystemTree = (path: string) => SYSTEM.test(path);

/** A literal right after these is a module specifier or an include, not a file the program opens. */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\(|#\s*include|\bmod|\buse|\bsource)\s*$/u;
const MIME = /^(?:application|text|image|audio|video|multipart|font|model|message)\/[\w.+-]+$/u;
const DATA_EXT = /\.(?:txt|csv|json|jsonl|dat|bin|npy|npz|pkl|pickle|pt|pth|tsv|xml|yaml|yml|db|sqlite3?|wav|png|jpe?g|gz|parquet|h5|hdf5|model|vocab|dict)$/iu;

/**
 * String literals of a source file, as the scan reads them: `paths` look like
 * file paths (a slash or a file extension; no whitespace, template, glob,
 * URL, MIME type, module specifier or include), `segments` are bare
 * directory-like names ("data") that a path join may put in front of a name.
 */
export function pathLiterals(text: string): string[] {
  return literalsOf(text).paths;
}

function literalsOf(text: string): { paths: string[]; segments: string[] } {
  const paths = new Set<string>();
  const segments = new Set<string>();
  for (const match of text.matchAll(/(["'`])([^"'`\s\\${}*?<>|]{1,300})\1/gu)) {
    const body = match[2]!;
    if (SPECIFIER.test(text.slice(Math.max(0, match.index - 24), match.index))) continue;
    if (body.includes("://") || body.startsWith("@") || MIME.test(body) || /^[-.]+$/u.test(body) || /^\.[A-Za-z0-9]+$/u.test(body)) continue;
    if (!body.includes("/")) {
      if (/^[A-Za-z_][\w-]{0,40}$/u.test(body)) {
        segments.add(body);
        continue;
      }
      if (!/^[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/u.test(body)) continue;
      // Module-like dotted names ("os.path", "numpy.linalg") are not files unless the extension is a data one.
      if (/^(?:[a-z_][a-z0-9_]*\.)+[a-z_][a-z0-9_]*$/u.test(body) && !DATA_EXT.test(body)) continue;
    }
    paths.add(body);
  }
  return { paths: [...paths], segments: [...segments] };
}

const usable = (path: string, cwd: string) => !SYSTEM.test(path) && path !== cwd && path !== "/";

/** Absolute paths a literal in `file` (absolute) may name: as is, or relative to the cwd and to the file's directory; system trees dropped. */
export function literalCandidates(literal: string, file: string, cwd: string): string[] {
  const paths = literal.startsWith("/") ? [posix.normalize(literal)]
    : [posix.normalize(posix.join(cwd, literal)), posix.normalize(posix.join(posix.dirname(file), literal))];
  return [...new Set(paths)].filter((path) => usable(path, cwd));
}

const MAX_JOINED = 120;

/**
 * Every absolute path a file's literals may name: each path literal as
 * literalCandidates gives it, then the joins a path join of two literals
 * makes (`os.path.join(DATA_DIR, "words.txt")` with DATA_DIR from "data" or
 * "/app/data"): a file-name literal under each directory-like literal, at
 * most MAX_JOINED of them. Existence is the env's to decide.
 */
export function fileCandidates(text: string, file: string, cwd: string): string[] {
  const { paths, segments } = literalsOf(text);
  const out = new Set<string>();
  for (const literal of paths) for (const candidate of literalCandidates(literal, file, cwd)) out.add(candidate);
  const names = paths.filter((literal) => !literal.includes("/"));
  if (names.length === 0) return [...out];
  const dirs = new Set<string>();
  for (const literal of [...paths.filter((path) => path.includes("/") && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/u.test(posix.basename(path))), ...segments]) {
    for (const dir of literalCandidates(literal, file, cwd)) dirs.add(dir);
  }
  let joined = 0;
  for (const dir of dirs) {
    for (const name of names) {
      if (joined >= MAX_JOINED) return [...out];
      const path = posix.join(dir, name);
      if (usable(path, cwd) && !out.has(path)) {
        out.add(path);
        joined++;
      }
    }
  }
  return [...out];
}

// ---------- packages ----------

/** Top-level Python modules a file imports (absolute imports; importlib/__import__ by literal). */
export function pythonImports(text: string): Set<string> {
  const code = text.replace(/#[^\n]*/gu, "");
  const names = new Set<string>();
  for (const [, list] of code.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gmu)) {
    for (const part of list!.split(",")) names.add(part.trim().split(/[.\s]/u)[0]!);
  }
  for (const [, mod] of code.matchAll(/^[ \t]*from[ \t]+([A-Za-z_]\w*)[\w.]*[ \t]+import\b/gmu)) names.add(mod!);
  for (const [, mod] of code.matchAll(/\b(?:importlib\.import_module|__import__)\(\s*["']([A-Za-z_]\w*)/gu)) names.add(mod!);
  names.delete("");
  return names;
}

/** A distribution: normalized name, whether it was installed from a local path (editable or file://), its top-level modules. */
export interface Dist {
  name: string;
  local: boolean;
  modules: string[];
}

export const normalizeDist = (name: string) => name.trim().toLowerCase().replace(/[-_.]+/gu, "-");

/** The snapshot (`name \t local \t mod,mod`) as distributions by normalized name. */
export function parsePackages(text: string): Map<string, Dist> {
  const dists = new Map<string, Dist>();
  for (const line of text.split("\n")) {
    const [name, local, modules] = line.split("\t");
    if (name === undefined || name.trim() === "" || modules === undefined) continue;
    const key = normalizeDist(name);
    dists.set(key, { name: name.trim(), local: local === "1", modules: modules.split(",").map((mod) => mod.trim()).filter((mod) => /^[A-Za-z_]\w*$/u.test(mod)) });
  }
  return dists;
}

export interface PackageFinding {
  /** The distribution installed during the run. */
  name: string;
  /** Its modules the files import. */
  modules: string[];
  /** The run's files that import them. */
  files: string[];
}

/**
 * Distributions present now and not at the start (never one installed from a
 * local path: the project itself, editable), whose modules a code file the
 * run wrote imports; a package the task names (by distribution or module) is
 * one it asked for. An empty start snapshot (no python3 then) finds nothing.
 */
export function packageFindings(start: ReadonlyMap<string, Dist>, now: ReadonlyMap<string, Dist>, files: readonly { path: string; text: string }[], task: string): PackageFinding[] {
  if (start.size === 0) return [];
  const taskWords = new Set(task.toLowerCase().split(/[^a-z0-9_.-]+/u).flatMap((word) => [word, normalizeDist(word)]));
  const imports = files.filter((file) => /\.pyw?$/iu.test(file.path)).map((file) => ({ path: file.path, modules: pythonImports(file.text) }));
  const findings: PackageFinding[] = [];
  for (const [key, dist] of now) {
    if (start.has(key) || dist.local || taskWords.has(key) || dist.modules.some((mod) => taskWords.has(mod.toLowerCase()))) continue;
    const modules = new Set<string>();
    const users: string[] = [];
    for (const file of imports) {
      const used = dist.modules.filter((mod) => file.modules.has(mod));
      if (used.length === 0) continue;
      for (const mod of used) modules.add(mod);
      users.push(file.path);
    }
    if (users.length > 0) findings.push({ name: dist.name, modules: [...modules].sort(), files: users.sort() });
  }
  return findings.sort((a, b) => normalizeDist(a.name).localeCompare(normalizeDist(b.name), "en"));
}

// ---------- the workspace ----------

const SECTION = "\u0001section\u0001";
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const PRUNE_EXPR = `\\( ${PRUNE.map((name) => `-name ${shellQuote(name)}`).join(" -o ")} \\) -prune`;
const nulList = (text: string) => text.split("\0").filter((item) => item !== "").map((item) => item.replace(/^\.\//u, ""));

/**
 * Every installed Python distribution as `name \t local \t modules`: modules
 * from top_level.txt, else the top-level entries of RECORD; local when
 * direct_url.json names a file: URL (an editable or path install). Run from /
 * so the workspace never shadows importlib.
 */
export const PACKAGES_COMMAND = "command -v python3 >/dev/null 2>&1 && (cd / && python3 -c '" + [
  "import importlib.metadata as m",
  "for d in m.distributions():",
  "    try:",
  "        n = (d.metadata[\"Name\"] or \"\").strip()",
  "        t = (d.read_text(\"top_level.txt\") or \"\").split()",
  "        if not t:",
  "            s = set()",
  "            for f in d.files or []:",
  "                p = str(f).split(\"/\")",
  "                h = p[0]",
  "                if h in (\"..\", \"__pycache__\", \"bin\") or h.endswith((\".dist-info\", \".egg-info\", \".data\", \".pth\")): continue",
  "                if len(p) > 1: s.add(h)",
  "                elif h.endswith(\".py\"): s.add(h[:-3])",
  "                elif h.endswith((\".so\", \".pyd\")): s.add(h.split(\".\")[0])",
  "            t = sorted(s)",
  "        u = d.read_text(\"direct_url.json\") or \"\"",
  "        print(n + chr(9) + (\"1\" if \"file:\" in u else \"0\") + chr(9) + \",\".join(t))",
  "    except Exception:",
  "        pass",
].join("\n") + "') 2>/dev/null | head -c 2000000";

/** Scratch-looking files, test dirs and __pycache__ dirs under the cwd (exact rules: scratchKind). */
const SCRATCH_FIND = `find . ${PRUNE_EXPR} -o -type d -name __pycache__ -print0 -prune -o -type d \\( -name test -o -name tests -o -name testing -o -name __tests__ -o -name spec \\) -print0 -o -type f ` +
  "\\( -name 'test_*' -o -name '*_test.*' -o -name '*.test.*' -o -name '*.spec.*' -o -name 'test.*' -o -name 'tests.*' -o -iname 'check*' -o -iname 'debug*' " +
  "-o -iname 'scratch*' -o -iname '*.log' -o -iname '*.bak' \\) -print0 2>/dev/null | head -c 2000000";

/** What travel_check compares against: the marker (files newer are the run's), the scratch-looking paths then, the packages then. */
export interface TravelStart {
  marker: string;
  scratch: Set<string>;
  packages: Map<string, Dist>;
}

/** Touch the marker, list the scratch-looking files and dirs, snapshot the packages: one internal command. Null when the env could not say. */
export async function readTravelStart(env: ExecEnv): Promise<TravelStart | null> {
  try {
    const marker = `${await env.scratchDir()}/.travel-start`;
    const run = await env.exec(`touch ${shellQuote(marker)} || exit 3; ${SCRATCH_FIND}; printf '\\0${SECTION}\\0'; ${PACKAGES_COMMAND}; exit 0`, { timeoutMs: 60_000, internal: true });
    if (run.exitCode !== 0) return null;
    const at = run.output.indexOf(SECTION);
    if (at === -1) return null;
    return { marker, scratch: new Set(nulList(run.output.slice(0, at))), packages: parsePackages(run.output.slice(at + SECTION.length).replace(/^\0/u, "")) };
  } catch {
    return null;
  }
}

export interface TravelFindings {
  packages: PackageFinding[];
  data: { file: string; reads: string[] }[];
  scratch: string[];
  /** __pycache__ dirs the run created: listed only next to another finding. */
  pycache: string[];
  /** Files the run wrote under the cwd, code files read (for the trace). */
  written: number;
  code: number;
}

const MAX_CODE_FILES = 64;
const MAX_CODE_BYTES = 512 * 1024;
const MAX_CANDIDATES = 600;

/**
 * The findings now: the files under the cwd newer than the marker (the run's),
 * the packages now, then the code files' imports and path literals, and for
 * the literals one more command that keeps those naming a regular file older
 * than the marker and not tracked by git.
 */
export async function travelFindings(env: ExecEnv, start: TravelStart, task: string): Promise<TravelFindings> {
  const marker = shellQuote(start.marker);
  // A __pycache__ dir is listed when newer (created or written into) and never entered; every other file when newer.
  const run = await env.exec(`find . ${PRUNE_EXPR} -o -type d -name __pycache__ \\( -newer ${marker} -print0 -o -true \\) -prune -o -type f -newer ${marker} -print0 2>/dev/null | head -c 4000000; ` +
    `printf '\\0${SECTION}\\0'; ${PACKAGES_COMMAND}; exit 0`, { timeoutMs: 60_000, internal: true });
  const at = run.output.indexOf(SECTION);
  const written = nulList(at === -1 ? run.output : run.output.slice(0, at));
  const now = at === -1 ? new Map<string, Dist>() : parsePackages(run.output.slice(at + SECTION.length).replace(/^\0/u, ""));
  const created = written.filter((path) => !start.scratch.has(path));
  const scratch = scratchFindings(created, start.scratch, task);
  const pycache = created.filter((path) => posix.basename(path) === "__pycache__").sort();
  const codePaths = written.filter(isCode).sort().slice(0, MAX_CODE_FILES);
  const decoder = new TextDecoder();
  const absolute = codePaths.map((path) => env.resolvePath(path));
  const contents = env.readFiles !== undefined ? await env.readFiles(absolute)
    : await Promise.all(absolute.map((path) => env.readFile(path).catch((error: Error) => error)));
  const files: { path: string; abs: string; text: string }[] = [];
  contents.forEach((content, index) => {
    if (!(content instanceof Error) && content.byteLength <= MAX_CODE_BYTES) files.push({ path: codePaths[index]!, abs: absolute[index]!, text: decoder.decode(content) });
  });
  const packages = packageFindings(start.packages, now, files, task);
  const writtenAbs = new Set(written.map((path) => env.resolvePath(path)));
  const byCandidate = new Map<string, Set<string>>();
  for (const file of files) {
    for (const candidate of fileCandidates(file.text, file.abs, env.cwd)) {
      if (writtenAbs.has(candidate) || candidate === file.abs || mentioned(task, candidate, env.cwd)) continue;
      if (!byCandidate.has(candidate) && byCandidate.size >= MAX_CANDIDATES) continue;
      (byCandidate.get(candidate) ?? byCandidate.set(candidate, new Set()).get(candidate)!).add(file.path);
    }
  }
  const data: { file: string; reads: string[] }[] = [];
  if (byCandidate.size > 0) {
    const reads = new Map<string, string[]>();
    for (const path of await preexisting(env, start.marker, [...byCandidate.keys()])) {
      for (const file of byCandidate.get(path) ?? []) (reads.get(file) ?? reads.set(file, []).get(file)!).push(path);
    }
    for (const file of [...reads.keys()].sort()) data.push({ file, reads: reads.get(file)!.sort() });
  }
  return { packages, data, scratch, pycache, written: written.length, code: files.length };
}

/**
 * The paths that name a regular file older than the marker (there before the
 * run, not written by it) and not tracked by git: one internal command.
 */
export async function preexisting(env: ExecEnv, marker: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const list = paths.map(shellQuote).join(" ");
  const check = await env.exec(`g=0; git rev-parse --is-inside-work-tree >/dev/null 2>&1 && g=1; for p in ${list}; do ` +
    `[ -f "$p" ] && [ ! "$p" -nt ${shellQuote(marker)} ] || continue; ` +
    `[ "$g" = 1 ] && git ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && continue; printf '%s\\0' "$p"; done; exit 0`, { timeoutMs: 30_000, internal: true });
  return nulList(check.output);
}

export const travelFired = (findings: Pick<TravelFindings, "packages" | "data" | "scratch">) => findings.packages.length + findings.data.length + findings.scratch.length > 0;

const list = (items: readonly string[], max: number) => `${items.slice(0, max).join(", ")}${items.length > max ? `, and ${items.length - max} more` : ""}`;

/** One line per finding, for the reminder's `{items}`. */
export function formatTravel(findings: Pick<TravelFindings, "packages" | "data" | "scratch" | "pycache">): string {
  const lines: string[] = [];
  for (const finding of findings.packages.slice(0, 6)) {
    lines.push(`- ${list(finding.files, 3)} import${finding.files.length === 1 ? "s" : ""} ${finding.modules.join(", ")} (package ${finding.name}, installed during this session)`);
  }
  for (const finding of findings.data.slice(0, 6)) lines.push(`- ${finding.file} reads ${list(finding.reads, 4)}, which you did not write`);
  if (findings.scratch.length > 0) lines.push(`- scratch or test files you created in the project tree: ${list(findings.scratch, 10)}`);
  if (findings.pycache.length > 0) lines.push(`- __pycache__ directories you created: ${list(findings.pycache, 4)}`);
  return lines.join("\n");
}

// ---------- unmet_target ----------

/** Numbers as written ("98%", "0.98", "1,000", "1.5e-4"), each with its percent/fraction twin. */
function numbersIn(text: string): { raw: string; values: number[] }[] {
  const out: { raw: string; values: number[] }[] = [];
  for (const match of text.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:[eE]([-+]?\d+))?(?![\w])(\s*(?:%|percent\b))?/gu)) {
    const value = Number(`${match[1]!.replaceAll(",", "")}${match[2] ?? ""}${match[3] === undefined ? "" : `e${match[3]}`}`);
    if (!Number.isFinite(value)) continue;
    const values = match[4] !== undefined ? [value, value / 100] : value > 0 && value <= 1 ? [value, value * 100] : [value];
    out.push({ raw: match[0].trim(), values });
  }
  return out;
}

const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** A sentence that says a target is not met: these phrases, never after a negation ("no", "none", "never", "without"). */
const UNMET_PHRASE = new RegExp([
  "\\bbelow (?:the |our |its |a )?(?:required|requested|target(?:ed)?|minimum|needed|expected|specified|stated|goal)\\b",
  "\\b(?:short of|falls? short|fell short)\\b",
  "\\b(?:does|did|do|is|was|are|were)(?:n['\u2019]t| not) (?:yet )?(?:meet|reach|achieve|hit|satisfy|attain|met|reached|achieved|satisfied|attained)\\b",
  "\\b(?:not|never) (?:yet )?(?:met|achieved|reached|attained)\\b",
  "\\bunmet\\b",
  "\\bfail(?:s|ed)? to (?:meet|reach|achieve|hit|attain)\\b",
  "\\bmiss(?:es|ed)? (?:the |its |our )?(?:target|threshold|requirement|goal)\\b",
  "\\b(?:less|lower|worse) than (?:the )?(?:required|requested|target|minimum|needed|goal)\\b",
].join("|"), "iu");
const NEGATED = /\b(?:no|none|never|nothing|zero|without|neither|nor)\b[^.;:]{0,40}$/iu;
/** "below the required" of a lower-is-better metric (error, time, memory, size) is the target met. */
const LOWER_BETTER = /\b(?:error|errors|loss|latency|runtime|run time|time|times|seconds?|ms|milliseconds?|memory|ram|size|bytes?|[kmg]i?b|mae|mse|rmse|distance|deviation|diff(?:erence)?|tolerance|budget|limit|cap|max(?:imum)?|overhead|penalty|violations?|failures?)\b/iu;

/**
 * The first sentence of `final` that says a target the task set is unmet,
 * or undefined. Precision first: the sentence must carry an unmet phrase
 * (UNMET_PHRASE, not negated) and a number the task text also has (as
 * written, or its percent/fraction twin); a "below/less than the required"
 * phrase is skipped for lower-is-better metrics. `number: false` drops the
 * number rule (policy.unmet_target.require_number false).
 */
export function unmetSentence(final: string, task: string, options: { number?: boolean } = {}): string | undefined {
  const needNumber = options.number !== false;
  const taskValues = numbersIn(task).flatMap((number) => number.values).filter((value) => value !== 0 && value !== 1);
  if (needNumber && taskValues.length === 0) return undefined;
  const sentences = final.replace(/\*\*|__|`/gu, "").split(/(?<=[.!?])\s+(?=[A-Z(*_-])|\n+/u).map((sentence) => sentence.replace(/^[\s>*+-]+|\s+$/gu, "")).filter((sentence) => sentence !== "");
  for (const sentence of sentences) {
    const phrase = UNMET_PHRASE.exec(sentence);
    if (phrase === null || NEGATED.test(sentence.slice(0, phrase.index))) continue;
    if (/^(?:below|less|lower|worse)\b/iu.test(phrase[0]) && LOWER_BETTER.test(sentence)) continue;
    if (needNumber && !numbersIn(sentence).some((number) => number.values.some((value) => taskValues.some((target) => same(value, target))))) continue;
    return sentence.length > 400 ? `${sentence.slice(0, 397)}...` : sentence;
  }
  return undefined;
}
