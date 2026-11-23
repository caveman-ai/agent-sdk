/**
 * Finish-time checks (levers.ts runs them at a finish attempt):
 *
 * - test_isolation: a test file the run CREATED that uses helpers defined only
 *   in another test file the run created or modified. Graders often replace
 *   or add their own copies of test files, and then the new file stops
 *   compiling (DeepSWE: 15 of 15 runs with this pattern failed, 0 of 200
 *   passing runs had it). Static and cheap: the workspace's own git (or, with
 *   no git, a test-file listing taken at the start) names the files; regexes
 *   read Go, Python and JS/TS. No language server.
 * - evidence_bounce: what a draft final message claims as evidence, by
 *   loadout-defined patterns: a requirement-level check, only proxies (format,
 *   syntax, compile, lint) or nothing. Ported from mine2/finalclass.py.
 *
 * `isolationFindings` and `evidenceClass` are pure, so an offline replay over
 * recorded transcripts runs the same rules (scripts/replay-finishcheck.ts).
 */
import { posix } from "node:path";
import type { ExecEnv } from "./env/types.ts";

// ---------- evidence_bounce ----------

export type EvidenceClass = "requirement" | "proxy_only" | "none";

/** finalclass.py: a requirement-level claim wins; else any proxy claim; else none. */
export function evidenceClass(text: string, patterns: { requirement: readonly RegExp[]; proxy: readonly RegExp[] }): EvidenceClass {
  if (text.trim() === "") return "none";
  if (patterns.requirement.some((pattern) => pattern.test(text))) return "requirement";
  return patterns.proxy.some((pattern) => pattern.test(text)) ? "proxy_only" : "none";
}

// ---------- test_isolation: the rules ----------

export type TestLanguage = "go" | "python" | "js";

/** A test file the run wrote: created (`text` is the whole file) or modified (`text` is only the lines the run added). */
export interface AgentTestFile {
  path: string;
  created: boolean;
  text: string;
  /**
   * Modified files: the file at the start (live: the start commit's copy;
   * replay: the lines the run's edits removed). What it already declares is
   * not the run's, even on a line the run changed (a new signature, a flag's
   * help text, a gofmt realignment): a grader's copy keeps those names.
   */
  base?: string;
}

export interface IsolationFinding {
  lang: TestLanguage;
  /** The created test file that depends on another. */
  file: string;
  /** The test file that defines what it uses. */
  from: string;
  /** The helpers (Go), imported names or the module (Python, JS). */
  names: string[];
}

/** Build output, vendored and environment trees: test files there are not the run's own sources. */
const SKIP_DIR = /(?:^|\/)(?:\.git|node_modules|vendor|third_party|site-packages|\.venv|venv|__pycache__|dist|build|out|coverage|target)\//u;

/** Which test-file kind a path is: Go `_test.go`; Python test modules (`test_*.py`, `*_test.py`; never conftest.py); JS/TS `*.test.*`, `*.spec.*`. */
export function testLanguage(path: string): TestLanguage | undefined {
  if (SKIP_DIR.test(path)) return undefined;
  if (/_test\.go$/u.test(path)) return "go";
  if (/(?:^|\/)(?:test_[^/]*|[^/]+_test)\.py$/u.test(path)) return "python";
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path)) return "js";
  return undefined;
}

/** Comments and string literals blanked (line breaks kept), so names inside them are not uses. */
function stripGo(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|`[^`]*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu, (match) => match.replace(/[^\n]/gu, " "));
}

const GO_TEST_FUNC = /^(?:Test|Benchmark|Example|Fuzz)(?![a-z])/u;

/** Go keywords and predeclared identifiers: never a helper a test file defines. */
const GO_RESERVED = new Set((
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var " +
  "any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr " +
  "true false iota nil append cap clear close complex copy delete imag len make max min new panic print println real recover"
).split(" "));

/**
 * The names grouped `var (` / `const (` / `type (` blocks declare: the leading
 * identifiers of the group's own entries, i.e. lines at the group's bracket
 * depth and at its first entry's indentation. Lines inside a func literal, a
 * struct type or composite literal (deeper brackets) or a wrapped expression
 * (deeper indentation) are not entries.
 */
function goGroupNames(stripped: string, names: Set<string>): void {
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^(?:type|var|const)[ \t]*\(/u.exec(lines[i]!);
    if (head === null) continue;
    let depth = 0;
    let indent: string | undefined;
    let j = i;
    for (; j < lines.length; j++) {
      const line = j === i ? lines[i]!.slice(head[0].length - 1) : lines[j]!;
      if (j > i && depth === 1) {
        const entry = /^([ \t]+)([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*)/u.exec(line);
        if (entry !== null && (indent ??= entry[1]!) === entry[1]) for (const name of entry[2]!.split(/\s*,\s*/u)) names.add(name);
      }
      for (const char of line) {
        if (char === "(" || char === "[" || char === "{") depth++;
        else if ((char === ")" || char === "]" || char === "}") && --depth === 0) break;
      }
      if (depth <= 0) break;
    }
    i = j;
  }
}

/** Top-level declarations a Go file (or the lines a run added to it) makes: funcs (not tests or methods), types, vars, consts, grouped ones too. */
function goDefs(stripped: string): Set<string> {
  const names = new Set<string>();
  for (const [, name] of stripped.matchAll(/^func\s+([A-Za-z_]\w*)\s*[([]/gmu)) if (!GO_TEST_FUNC.test(name!) && name !== "init") names.add(name!);
  for (const [, name] of stripped.matchAll(/^(?:type|var|const)\s+([A-Za-z_]\w*)/gmu)) names.add(name!);
  goGroupNames(stripped, names);
  names.delete("_");
  for (const name of names) if (GO_RESERVED.has(name)) names.delete(name);
  return names;
}

/** `now` minus what `base` (a modified file's start version) already declares. */
function newSince(now: Set<string>, base: string | undefined, defs: (text: string) => Set<string>): Set<string> {
  if (base === undefined) return now;
  const before = defs(base);
  return new Set([...now].filter((name) => !before.has(name)));
}

const goPackage = (stripped: string) => /^package\s+(\w+)/mu.exec(stripped)?.[1];
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Names of `defs` the stripped Go file uses: not a selector (`x.name`), a declaration, a struct key, or a name it declares locally. */
function goUses(stripped: string, defs: Set<string>): string[] {
  const used: string[] = [];
  for (const name of defs) {
    const n = escape(name);
    if (new RegExp(`(?<![\\w.])${n}(?:\\s*,\\s*\\w+)*\\s*:=|\\b(?:var|const|type|func)\\s+${n}\\b`, "u").test(stripped)) continue;
    if (new RegExp(`(?<![\\w.])${n}\\b(?!\\s*:[^=])`, "u").test(stripped)) used.push(name);
  }
  return used.sort();
}

/** Top-level `def`, `class` and assignments of a Python file (or its added lines). */
function pyDefs(text: string): Set<string> {
  const names = new Set<string>();
  for (const [, def, cls, assign] of text.matchAll(/^(?:(?:async\s+)?def\s+(\w+)|class\s+(\w+)|(\w+)\s*(?::[^=\n]*)?=(?!=))/gmu)) names.add((def ?? cls ?? assign)!);
  return names;
}

interface PyImport {
  /** Candidate module paths (no `.py`), relative to the workspace when `relative`, else a path suffix. */
  modules: string[];
  relative: boolean;
  /** Imported names; undefined for `import m` (then the attributes used through `alias`). */
  names?: string[];
  alias?: string;
}

function pyImports(file: string, text: string): PyImport[] {
  const code = text.replace(/#[^\n]*/gu, "");
  const out: PyImport[] = [];
  const dir = posix.dirname(file);
  for (const [, mod, list] of code.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]+)/gmu)) {
    const names = list!.replace(/[()\\]/gu, " ").split(",").map((part) => part.trim().split(/\s+as\s+/u)[0]!.trim()).filter((name) => name !== "");
    const dots = /^\.*/u.exec(mod!)![0].length;
    const rest = mod!.slice(dots).split(".").filter((part) => part !== "").join("/");
    if (dots > 0) {
      let base = dir;
      for (let i = 1; i < dots; i++) base = posix.dirname(base);
      const at = (path: string) => posix.normalize(posix.join(base, path));
      // `from . import test_x` names a module; `from .test_x import y` names a module's members.
      out.push({ modules: rest === "" ? [] : [at(rest)], relative: true, names });
      out.push(...names.map((name) => ({ modules: [at(rest === "" ? name : `${rest}/${name}`)], relative: true, alias: name })));
    } else {
      out.push({ modules: [rest], relative: false, names });
      out.push(...names.map((name) => ({ modules: [`${rest}/${name}`], relative: false, alias: name })));
    }
  }
  for (const [, list] of code.matchAll(/^[ \t]*import[ \t]+([^\n]+)/gmu)) {
    for (const part of list!.split(",")) {
      const [mod, alias] = part.trim().split(/\s+as\s+/u);
      if (mod === undefined || !/^[\w.]+$/u.test(mod)) continue;
      out.push({ modules: [mod.split(".").join("/")], relative: false, alias: alias?.trim() ?? mod });
    }
  }
  return out;
}

/** JS/TS: relative specifiers with the names imported from each (undefined: default, namespace, side effect or require). */
function jsImports(text: string): { spec: string; names?: string[] }[] {
  const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
  const out: { spec: string; names?: string[] }[] = [];
  for (const [, clause, , spec] of code.matchAll(/\bimport\s+(?:type\s+)?([^'";]*?)\s*from\s*(['"])(\.{1,2}\/[^'"]+)\2/gu)) {
    const braces = /^\{([^}]*)\}$/u.exec(clause!.trim());
    const names = braces?.[1]!.split(",").map((part) => part.trim().replace(/^type\s+/u, "").split(/\s+as\s+/u)[0]!.trim()).filter((name) => name !== "");
    out.push(names === undefined ? { spec: spec! } : { spec: spec!, names });
  }
  for (const [, , spec] of code.matchAll(/(?:\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"]+)\1/gmu)) out.push({ spec: spec! });
  return out;
}

function jsExports(text: string): Set<string> {
  const names = new Set<string>();
  for (const [, name] of text.matchAll(/\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([\w$]+)/gu)) names.add(name!);
  for (const [, list] of text.matchAll(/\bexport\s*\{([^}]*)\}/gu)) for (const part of list!.split(",")) names.add(part.trim().split(/\s+as\s+/u).at(-1)!.trim());
  for (const [, name] of text.matchAll(/\b(?:module\.)?exports\.([\w$]+)\s*=/gu)) names.add(name!);
  names.delete("");
  return names;
}

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

function jsCandidates(file: string, spec: string): string[] {
  const path = posix.normalize(posix.join(posix.dirname(file), spec));
  const out = [path, ...JS_EXT.map((ext) => path + ext), ...JS_EXT.map((ext) => `${path}/index${ext}`)];
  // ESM TypeScript imports name the emitted file: `./a.test.js` is `./a.test.ts`.
  const emitted = /\.([cm]?)js(x?)$/u.exec(path);
  if (emitted !== null) out.push(`${path.slice(0, -emitted[0].length)}.${emitted[1]}ts${emitted[2]}`, `${path.slice(0, -emitted[0].length)}.tsx`);
  return out;
}

/**
 * Each created test file that uses something defined only in another test
 * file of this run: Go (same directory and package; helpers the other file
 * declares, or for a modified file declares in its added lines), Python (a
 * test module importing a test module in its own directory; conftest.py is
 * never one) and
 * JS/TS (a test file importing a sibling `*.test.*` / `*.spec.*`). A modified
 * target counts only through what its added lines define and its start
 * version (`base`) did not.
 */
export function isolationFindings(files: readonly AgentTestFile[]): IsolationFinding[] {
  const findings: IsolationFinding[] = [];
  const typed = files.map((file) => ({ ...file, lang: testLanguage(file.path) })).filter((file) => file.lang !== undefined);
  for (const file of typed) {
    if (!file.created) continue;
    const others = typed.filter((other) => other.lang === file.lang && other.path !== file.path);
    if (file.lang === "go") {
      const stripped = stripGo(file.text);
      const own = goDefs(stripped);
      const pkg = goPackage(stripped);
      for (const other of others) {
        if (posix.dirname(other.path) !== posix.dirname(file.path)) continue;
        const theirs = stripGo(other.text);
        const before = other.created || other.base === undefined ? undefined : stripGo(other.base);
        const otherPkg = goPackage(theirs) ?? (before === undefined ? undefined : goPackage(before));
        if (pkg !== undefined && otherPkg !== undefined && pkg !== otherPkg) continue;
        const defs = new Set([...newSince(goDefs(theirs), before, goDefs)].filter((name) => !own.has(name)));
        const names = goUses(stripped, defs);
        if (names.length > 0) findings.push({ lang: "go", file: file.path, from: other.path, names });
      }
    } else if (file.lang === "python") {
      for (const imp of pyImports(file.path, file.text)) {
        // A sibling: a test module in the importer's own directory (a package module named *_test.py elsewhere is a library).
        const target = others.find((other) => posix.dirname(other.path) === posix.dirname(file.path) && imp.modules.some((mod) => {
          const path = `${mod}.py`;
          return imp.relative ? other.path === path : other.path === path || other.path.endsWith(`/${path}`);
        }));
        if (target === undefined || findings.some((finding) => finding.file === file.path && finding.from === target.path)) continue;
        const used = imp.names ?? [...file.text.matchAll(new RegExp(`(?<![\\w.])${escape(imp.alias ?? "")}\\.(\\w+)`, "gu"))].map((match) => match[1]!);
        const defs = target.created ? undefined : newSince(pyDefs(target.text), target.base, pyDefs);
        const names = defs === undefined ? (used.length > 0 ? [...new Set(used)] : [posix.basename(target.path, ".py")]) : used.filter((name) => name === "*" ? defs.size > 0 : defs.has(name));
        if (names.length > 0) findings.push({ lang: "python", file: file.path, from: target.path, names: [...new Set(names)].sort() });
      }
    } else {
      for (const imp of jsImports(file.text)) {
        const candidates = jsCandidates(file.path, imp.spec);
        const target = others.find((other) => candidates.includes(other.path));
        if (target === undefined || findings.some((finding) => finding.file === file.path && finding.from === target.path)) continue;
        const exports = target.created ? undefined : newSince(jsExports(target.text), target.base, jsExports);
        const names = exports === undefined ? imp.names ?? [imp.spec] : imp.names === undefined ? (exports.size > 0 ? [imp.spec] : []) : imp.names.filter((name) => exports.has(name));
        if (names.length > 0) findings.push({ lang: "js", file: file.path, from: target.path, names: [...new Set(names)].sort() });
      }
    }
  }
  return findings;
}

// ---------- test_isolation: the workspace ----------

/** Git pathspecs for the test-file kinds (`*` crosses `/` in a plain pathspec); testLanguage filters exactly. */
const PATHSPECS = "'*_test.go' '*test_*.py' '*_test.py' '*.test.*' '*.spec.*'";
const FIND_TESTS = "find . \\( -name .git -o -name node_modules -o -name vendor -o -name .venv -o -name venv -o -name __pycache__ -o -name site-packages " +
  "-o -name dist -o -name build -o -name target -o -name .cache \\) -prune -o -type f \\( -name '*_test.go' -o -name 'test_*.py' -o -name '*_test.py' " +
  "-o -name '*.test.*' -o -name '*.spec.*' \\) -print0 2>/dev/null | head -c 1000000";
const SECTION = "\u0001section\u0001";

/** What the workspace was at the run's start: the git commit and the paths already dirty, or (no git) the test files present. */
export type Baseline = { git: true; base: string; dirty: Set<string> } | { git: false; files: Set<string> };

const GIT_STATUS = (base: string) =>
  `git ls-files -z --others --exclude-standard -- ${PATHSPECS}; printf '\\0${SECTION}\\0'; ` +
  `git -c core.quotepath=off diff -z --name-status --no-renames --relative ${base} -- ${PATHSPECS} 2>/dev/null`;

export const BASELINE_COMMAND =
  "if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then " +
  `b=$(git rev-parse -q --verify HEAD || git hash-object -t tree /dev/null); printf 'git %s\\0' "$b"; ${GIT_STATUS('"$b"')}; ` +
  `else printf 'find\\0'; ${FIND_TESTS}; fi`;

const nulList = (text: string) => text.split("\0").filter((item) => item !== "").map((item) => item.replace(/^\.\//u, ""));

/** `git ls-files --others` then `git diff --name-status` (NUL-separated), as [untracked, status-by-path]. */
function parseGitStatus(text: string): [string[], Map<string, string>] {
  const at = text.indexOf(SECTION);
  const untracked = nulList(at === -1 ? text : text.slice(0, at));
  const parts = at === -1 ? [] : nulList(text.slice(at + SECTION.length));
  const status = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) status.set(parts[i + 1]!, parts[i]!);
  return [untracked, status];
}

/** The start state (null when the env could not say: the check then compares against HEAD with nothing dirty). */
export async function readBaseline(env: ExecEnv): Promise<Baseline | null> {
  try {
    const run = await env.exec(BASELINE_COMMAND, { timeoutMs: 30_000 });
    const [head, ...rest] = run.output.split("\0");
    const body = rest.join("\0");
    if (head?.startsWith("git ") === true) {
      const [untracked, status] = parseGitStatus(body);
      return { git: true, base: head.slice(4).trim(), dirty: new Set([...untracked, ...status.keys()]) };
    }
    if (head === "find") return { git: false, files: new Set(nulList(body)) };
    return null;
  } catch {
    return null;
  }
}

const MAX_FILES = 64;
const MAX_BYTES = 512 * 1024;
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const BASE_MARK = "\u0001base\u0001";

/**
 * The run's own test files now: created ones whole, modified ones as their
 * added lines (git diff against the start commit, so a commit by the agent
 * still counts) with their start version (`git show <base>:./<path>`, in the
 * same env call). With no git, only files created since the start listing.
 */
export async function agentTestFiles(env: ExecEnv, baseline: Baseline | null): Promise<AgentTestFile[]> {
  const created: string[] = [];
  const modified: string[] = [];
  const git = baseline === null || baseline.git;
  const base = baseline?.git === true ? baseline.base : "HEAD";
  if (git) {
    const run = await env.exec(`git rev-parse --is-inside-work-tree >/dev/null 2>&1 && { ${GIT_STATUS(shellQuote(base))}; }`, { timeoutMs: 30_000 });
    if (run.exitCode !== 0 && run.output === "") return [];
    const [untracked, status] = parseGitStatus(run.output);
    const dirty = baseline?.git === true ? baseline.dirty : new Set<string>();
    for (const path of untracked) if (!dirty.has(path)) created.push(path);
    for (const [path, code] of status) {
      if (dirty.has(path)) continue;
      if (code.startsWith("A")) created.push(path);
      else if (code.startsWith("M")) modified.push(path);
    }
  } else {
    const run = await env.exec(FIND_TESTS, { timeoutMs: 30_000 });
    for (const path of nulList(run.output)) if (!baseline.files.has(path)) created.push(path);
  }
  const keep = (paths: string[]) => paths.filter((path) => testLanguage(path) !== undefined).sort().slice(0, MAX_FILES);
  const [news, changed] = [keep(created), keep(modified)];
  if (news.length === 0) return [];
  const decoder = new TextDecoder();
  const read = env.readFiles !== undefined
    ? env.readFiles(news.map((path) => env.resolvePath(path)))
    : Promise.all(news.map((path) => env.readFile(env.resolvePath(path)).catch((error: Error) => error)));
  // Each start version follows its marker and index; `./` makes the path relative to the env's directory, like --relative.
  const starts = changed.map((path, index) => `printf '${BASE_MARK}%s\\n' ${index}; git show ${shellQuote(`${base}:./${path}`)} 2>/dev/null | head -c ${MAX_BYTES}`).join("; ");
  const diff = changed.length === 0 ? undefined
    : env.exec(`git -c core.quotepath=off diff -U0 --no-color --no-ext-diff --no-renames --relative ${shellQuote(base)} -- ${changed.map(shellQuote).join(" ")} | head -c 4000000; ` +
      `{ ${starts}; } | head -c 16000000`, { timeoutMs: 30_000 });
  const [contents, diffRun] = await Promise.all([read, diff]);
  const files: AgentTestFile[] = [];
  contents.forEach((content, index) => {
    if (!(content instanceof Error) && content.byteLength <= MAX_BYTES) files.push({ path: news[index]!, created: true, text: decoder.decode(content) });
  });
  if (diffRun !== undefined) {
    const [diffText = "", ...startChunks] = diffRun.output.split(BASE_MARK);
    const startOf = new Map<string, string>();
    for (const chunk of startChunks) {
      const newline = chunk.indexOf("\n");
      const path = changed[Number(chunk.slice(0, newline))];
      if (newline > 0 && path !== undefined) startOf.set(path, chunk.slice(newline + 1));
    }
    const added = new Map<string, string[]>();
    let current: string[] | undefined;
    for (const line of diffText.split("\n")) {
      if (line.startsWith("+++ ")) {
        const path = line.slice(4).replace(/\t$/u, "");
        current = path.startsWith("b/") ? (added.get(path.slice(2)) ?? added.set(path.slice(2), []).get(path.slice(2))) : undefined;
      } else if (line.startsWith("+") && current !== undefined) {
        current.push(line.slice(1));
      }
    }
    for (const [path, lines] of added) {
      const start = startOf.get(path);
      files.push({ path, created: false, text: lines.join("\n"), ...(start === undefined ? {} : { base: start }) });
    }
  }
  return files;
}

/** One line per finding, for the reminder's `{items}`. */
export function formatFindings(findings: readonly IsolationFinding[]): string {
  return findings.slice(0, 8).map((finding) => `- ${finding.file} uses ${finding.names.slice(0, 6).join(", ")}${finding.names.length > 6 ? ", ..." : ""} from ${finding.from}`).join("\n");
}
