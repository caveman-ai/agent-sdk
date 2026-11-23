/**
 * R1 result shaping (loadout `results.shaping`, off by default). A finished
 * command whose output is over `min_bytes` and reads as a test run, a build or
 * (mode `all`) a search comes back as what the model acts on: counts, the
 * first failures with their trace heads and every assertion message in them,
 * the tail, and the path of the full log in the env. Anything it does not
 * recognize, or would not shrink by a third, is left to the normal cap.
 *
 * Never hides a failure it found: every failure block keeps its header and
 * its message lines (past `max_failures` as one line each), a shown block
 * also its last lines (the raising frame and its message), and every summary
 * line that reports a failure stays; a run that failed but shows no failure
 * the shaper can name is not shaped at all, nor is a go package that failed
 * to build without its build errors in the output. A go package that failed
 * with no failure header keeps the lines it printed before its verdict.
 *
 * Linear time: one pass over the lines; each line is matched on at most its
 * first 512 characters, by patterns anchored at the line start with no nested
 * quantifiers, or by literal scans, so no output can make it backtrack.
 */

export interface ShapeConfig {
  shaping: "tests" | "all";
  min_bytes: number;
  max_failures: number;
  tail_lines: number;
}

export type ShapeKind = "test" | "build" | "search";

export interface ShapePlan {
  kind: ShapeKind;
  /** The runner, compiler or search tool the command names (`pytest`, `go`, `rg`), else `output`. */
  tool: string;
  /** The text the model sees, naming `logPath` as the full log. */
  render(logPath: string): string;
}

const PROBE = 512;
const SHOWN_LINE = 400;
const MAX_ONE_LINERS = 50;
const probe = (line: string) => (line.length > PROBE ? line.slice(0, PROBE) : line);
const clip = (line: string, max = SHOWN_LINE) => (line.length > max ? `${line.slice(0, max)} [... ${line.length - max} chars]` : line);
const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

// ---------------------------------------------------------------- commands

const TEST_TOOLS = new Set(["pytest", "py.test", "jest", "vitest", "mocha", "rspec", "phpunit", "ctest", "tox", "nox", "nosetests", "ava", "karma", "jasmine", "pest", "prove", "bats", "nextest"]);
const TEST_SUBCOMMAND_TOOLS = new Set(["go", "cargo", "dotnet", "mix", "swift", "zig", "deno", "bun", "dart", "flutter", "stack", "cabal", "lein", "sbt", "mvn", "mvnw", "gradle", "gradlew", "bazel", "bazelisk", "npm", "pnpm", "yarn", "rake", "make", "gmake"]);
const TEST_SUBCOMMANDS = new Set(["test", "tests", "t", "check", "verify", "nextest", "test-unit", "unittest"]);
const BUILD_TOOLS = new Set(["tsc", "vue-tsc", "gcc", "g++", "clang", "clang++", "cc", "c++", "javac", "rustc", "make", "gmake", "cmake", "ninja", "mvn", "mvnw", "gradle", "gradlew", "msbuild", "swiftc", "kotlinc", "scalac", "ghc", "nvcc", "meson"]);
const BUILD_SUBCOMMANDS = new Set(["build", "check", "clippy", "vet", "compile", "install", "package", "assemble", "typecheck", "tsc", "lint"]);
const SEARCH_TOOLS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack", "fd", "fdfind", "find"]);
const WRAPPERS = new Set(["env", "sudo", "time", "timeout", "nice", "nohup", "stdbuf", "unbuffer", "command", "exec", "xvfb-run", "npx", "pnpx", "bunx", "uvx",
  "do", "then", "else", "elif", "if", "while", "until", "!"]);
/** `<runner> run|exec|dlx <command>`: the command is what runs (`uv run pytest`, `bundle exec rspec`); `npm run <script>` is classified as is. */
const RUNNER_PREFIX: ReadonlyMap<string, readonly string[]> = new Map([
  ["uv", ["run"]], ["poetry", ["run"]], ["pipenv", ["run"]], ["hatch", ["run"]], ["pdm", ["run"]], ["rye", ["run"]], ["bundle", ["exec"]], ["npm", ["exec"]], ["pnpm", ["exec", "dlx"]], ["yarn", ["dlx"]],
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Commands that show a file or a diff: their text is the model's to read, never shaped by content alone. */
const VIEWERS = new Set(["cat", "head", "tail", "sed", "awk", "less", "more", "nl", "git", "diff", "jq", "xxd", "od", "strings", "bat"]);
const SCRIPT_NAMED_TEST = /^(run[_-]?)?tests?([_-]\w+)?(\.sh|\.py)?$|^runtests?(\.\w+)?$/u;

/**
 * Commands that run around a runner without adding output worth its own view (`cd /app && pytest`): a sequence of
 * these and one runner is still the runner's output. Anything else in sequence (`ls; rg ...`, `git status; pytest`)
 * mixes outputs, so the whole is not shaped (the replay audit's losses were all such mixes).
 */
const QUIET = new Set([
  "cd", "pushd", "popd", "export", "set", "unset", "source", ".", "true", ":", "sleep", "echo", "printf", "ulimit", "umask", "mkdir", "touch", "rm", "cp", "mv",
  "ln", "chmod", "clear", "wait", "trap", "shopt", "for", "do", "done", "while", "until", "if", "then", "else", "elif", "fi", "case", "esac", "exit", "return", "local", "[", "[[",
]);

interface Segment {
  /** The command's name, then up to 7 of its words. */
  words: string[];
  /** Fed by a pipe: a filter of the stream before it (`| tail -50`), not an output of its own. */
  piped: boolean;
}

/** Each simple command in `command`, wrappers and assignments dropped (`timeout 600 uv run pytest -x` is `pytest -x`). */
function commandWords(command: string): string[][] {
  return segmentsOf(command).map((segment) => segment.words);
}

function segmentsOf(command: string): Segment[] {
  const out: Segment[] = [];
  // Redirections that carry `&` (2>&1, &>, >&2) are not separators.
  const parts = command.slice(0, 8000).replace(/\d*[<>]&\d*-?|&>>?/gu, " ").split(/(&&|\|\||[;&|\n(){}`])/u);
  for (let part = 0; part < parts.length; part += 2) {
    const piped = parts[part - 1] === "|";
    const words = parts[part]!.trim().split(/\s+/u).filter((word) => word !== "");
    let index = 0;
    for (;;) {
      const word = words[index];
      if (word === undefined) break;
      const name = baseName(word);
      if (ASSIGNMENT.test(word)) index++;
      else if (WRAPPERS.has(name)) {
        index++;
        while (index < words.length && /^(-\S*|\d+(\.\d+)?[smhd]?)$/u.test(words[index]!)) index++;
      } else if (RUNNER_PREFIX.get(name)?.includes(words[index + 1] ?? "") === true) {
        index += 2;
      } else if (/^python[\d.]*$/u.test(name) && words[index + 1] === "-m") index += 2;
      else break;
    }
    if (index < words.length) out.push({ words: [baseName(words[index]!), ...words.slice(index + 1, index + 8)], piped });
  }
  return out;
}

/**
 * What a command's output is: a test run beats a build beats a search (`go build && go test` is a test run).
 * `mixed`: another command in sequence prints output of its own, so the output is not one runner's.
 */
export function classifyCommand(command: string): { kind: ShapeKind; tool: string; mixed: boolean } | undefined {
  let best: { kind: ShapeKind; tool: string } | undefined;
  let mixed = false;
  const rank = { test: 3, build: 2, search: 1 } as const;
  const offer = (kind: ShapeKind, tool: string) => {
    if (best === undefined || rank[kind] > rank[best.kind]) best = { kind, tool };
  };
  for (const { words: [tool, ...rest], piped } of segmentsOf(command)) {
    if (tool === undefined || piped) continue;
    const kind = classifySegment(tool, rest);
    if (kind !== undefined) offer(kind.kind, kind.tool);
    else if (!QUIET.has(tool)) mixed = true;
  }
  return best === undefined ? undefined : { ...(best as { kind: ShapeKind; tool: string }), mixed };
}

/** One simple command's kind, by its name and first words. */
function classifySegment(tool: string, rest: string[]): { kind: ShapeKind; tool: string } | undefined {
  const offer = (kind: ShapeKind, name: string) => ({ kind, tool: name });
  const args = rest.filter((word) => !word.startsWith("-"));
  const sub = args[0] ?? "";
  if (TEST_TOOLS.has(tool) || tool === "unittest" || SCRIPT_NAMED_TEST.test(tool)) return offer("test", tool);
  if (TEST_SUBCOMMAND_TOOLS.has(tool) && (TEST_SUBCOMMANDS.has(sub) || /^test[:_-]/u.test(sub) || (sub === "run" && /^test/u.test(args[1] ?? "")) ||
    ((tool === "make" || tool === "gmake") && args.some((word) => word === "test" || word === "check" || word === "tests")))) {
    return offer(sub === "check" && (tool === "cargo" || tool === "go") ? "build" : "test", tool);
  }
  if ((tool === "bash" || tool === "sh") && SCRIPT_NAMED_TEST.test(baseName(sub))) return offer("test", baseName(sub));
  if (BUILD_TOOLS.has(tool)) return offer("build", tool);
  if (TEST_SUBCOMMAND_TOOLS.has(tool) && (BUILD_SUBCOMMANDS.has(sub) || (sub === "run" && /^(build|compile|typecheck|tsc|lint)/u.test(args[1] ?? "")))) return offer("build", tool);
  if (SEARCH_TOOLS.has(tool) || (tool === "git" && (sub === "grep" || sub === "ls-files"))) return offer("search", tool === "git" ? `git ${sub}` : tool);
  return undefined;
}

// ---------------------------------------------------------------- shared rendering

/** Kept line indices rendered in order, each gap as one `[... N lines ...]` marker. */
function renderKept(lines: readonly string[], keep: Uint8Array): string[] {
  const out: string[] = [];
  let gap = 0;
  for (let index = 0; index < lines.length; index++) {
    if (keep[index] === 0) {
      gap++;
      continue;
    }
    if (gap > 0) out.push(`[... ${gap} line${gap === 1 ? "" : "s"} ...]`);
    gap = 0;
    out.push(clip(lines[index]!));
  }
  if (gap > 0) out.push(`[... ${gap} line${gap === 1 ? "" : "s"} ...]`);
  return out;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : /(ch|sh|s|x)$/u.test(word) ? "es" : "s"}`;
const sizeOf = (lines: number, bytes: number) => `${plural(lines, "line")}, ${bytes >= 10_240 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`}`;

// ---------------------------------------------------------------- tests

const SUMMARY_PATTERNS: readonly RegExp[] = [
  /^=+ .*\d+ (passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)\b/u, // pytest
  /^\d+ (passed|failed|errors?|skipped)\b.* in [\d.]+s/u, // pytest -q
  /^(ok|FAIL)\s+\S+\s+(\(cached\)|[\d.]+s|\[)/u, // go package line
  /^FAIL$/u, /^PASS$/u, // go
  /^test result: (ok|FAILED)\. /u, // cargo
  /^Tests:\s+\d/u, /^Test Suites:\s+\d/u, // jest
  /^\s*Tests\s+\d+ (passed|failed)/u, /^\s*Test Files\s+\d/u, // vitest
  /^\s*\d+ (passing|failing|pending)\b/u, // mocha
  /^\d+ examples?, \d+ failures?/u, // rspec
  /^(OK \(\d+ tests?|Tests: \d+, Assertions: \d+|FAILURES!$|ERRORS!$)/u, // phpunit
  /^\s*(Passed|Failed)!\s+-\s+Failed:/u, /^\s*Total tests: \d/u, // dotnet
  /^\d+% tests passed, \d+ tests? failed out of \d+/u, // ctest
  /^Ran \d+ tests? in /u, /^(OK|FAILED)( \(.*\))?$/u, // unittest
  /^# (pass|fail|tests)\s+\d+/u, // TAP
];

/** Output that is a test run whatever the command (a script that runs pytest): one of these lines. */
const STRONG_TEST_SIGNATURES: readonly RegExp[] = [
  /^=+ test session starts =+/u, /^=+ .*\d+ (passed|failed)\b.* in [\d.]+s/u, /^(ok|FAIL)\s+\S+\s+(\(cached\)|[\d.]+s)/u, /^--- FAIL: /u,
  /^test result: (ok|FAILED)\. \d+ passed/u, /^Tests:\s+\d+ (failed|passed)/u, /^\s*Tests\s+\d+ (passed|failed)/u, /^\s*\d+ passing \(/u,
  /^\d+ examples?, \d+ failures?/u, /^Ran \d+ tests? in [\d.]+s/u, /^\d+% tests passed, \d+ tests? failed out of/u,
];

/** Lines that open one failure's block. Group 1 names it, when the line does. */
const FAILURE_HEADERS: readonly RegExp[] = [
  /^\s*--- FAIL: (\S+)/u, // go (subtests indented)
  /^---- (\S+) stdout ----/u, // cargo
  /^\s*● (\S.*)$/u, // jest
  /^\s*(?:FAIL|×|✗|✕) (\S.*)$/u, // vitest, jest file lines
  /^\s*\d+\) (\S.*)$/u, // mocha, rspec, phpunit
  /^\s*Failed (\S+) \[/u, // dotnet
  /^\s*\d+\/\d+ Test\s+#\d+: (\S+) \.+\*{3}Failed/u, // ctest
  /^(?:FAIL|ERROR): (\S+)/u, // unittest
  /^not ok \d+ (.*)$/u, // TAP
];

/** A crash: its own failure outside any test, part of the open failure inside one (unittest's traceback, go's panic). */
const CRASH_HEADERS: readonly RegExp[] = [/^Traceback \(most recent call last\):/u, /^panic: /u];

/** One-line failure records (pytest's short summary, cargo's list, ctest's list): kept, up to 50. */
const FAILURE_ONE_LINERS: readonly RegExp[] = [
  /^(?:FAILED|ERROR) \S/u, /^test \S+ \.\.\. FAILED$/u, /^\s+\d+ - \S+ \((Failed|Timeout|SEGFAULT|Exception)/u,
];

/** What a failure's message looks like inside its block: kept wherever it sits in the block. */
const MESSAGE = /^\s*E\s|^\s*>\s|Error|Exception|assert|Assert|expected|Expected|[Rr]eceived|panic|mismatch|not equal|[Ff]ailure|FAIL|Traceback|\.(py|go|rs|js|ts|jsx|tsx|java|rb|php|cs|c|cc|cpp|h|kt|swift|ex|exs):\d+/u;

/** A failure's own message line: pytest's `E   ...` (an assertion's diff can run long, so these get their own budget). */
const E_LINE = /^\s*E\s/u;

/**
 * Where, not what: a traceback frame (pytest's `>` source line and `path:N: in fn`, Python's `File "...", line N`,
 * JS's `at ...`, go's goroutine frames). A deep traceback has one per frame, so frames never spend the message budget;
 * the block's head and tail keep the test's own frame and the raising one.
 */
const FRAME = /^>\s|^\S+:\d+: in \S|^\s*File "[^"]*", line \d+|^\s+at \S|^\s+\S+\.go:\d+ \+0x/u;

/** The last lines of a shown block: where pytest, unittest and go print the raising frame, its message and location. */
const BLOCK_TAIL = 10;
/** A shown block's frames: the first ones (the test's own calls) and the ones nearest the raise; the middle goes. */
const FRAMES_HEAD = 4;
const FRAMES_TAIL = 8;

/** A summary line that reports a failure (a FAIL package line, a FAILED verdict, a nonzero failure count): kept wherever it sits. */
const FAILING_SUMMARY = /^(FAIL\b|FAILED\b|FAILURES!|ERRORS!|\s*Failed!)|test result: FAILED|\b[1-9]\d* (failed|failing|failures?|errors?)\b|\b(Failed|Failures|Errors|failures|errors)[:=]\s*[1-9]/u;

/** go's `# pkg` (or `# pkg [pkg.test]`, `# [pkg]`) before a package's compile, vet or setup errors. Group 1: the package. */
const GO_BUILD_HEADER = /^# \[?([^\s\[\]]+)\]?(?: \[[^\s\]]+\])?$/u;
/** The first line under a go build header that makes it one: a diagnostic. */
const GO_BUILD_DIAGNOSTIC = /^\S+\.go:\d+(:\d+)?: |^(go: |package \S+ is not in |no required module provides |missing go\.sum entry)/u;
/** go's verdict on a package whose tests never ran. Group 1: the package. */
const GO_UNBUILT = /^FAIL\s+(\S+)\s+\[(build|setup) failed\]/u;
/** A go package's verdict line. */
const GO_PACKAGE = /^(ok|FAIL)\s+\S/u;
/** A failed go package whose section printed no failure the shaper can name keeps this many lines before its verdict. */
const GO_SECTION_TAIL = 10;

/** A line that ends the block before it (a pytest section, a go package line or the next test's start). */
const BLOCK_END = /^(={3,}|ok\s|FAIL\s|PASS$|FAIL$|=== RUN|--- PASS|--- SKIP|failures:$|Test Suites:|Tests:)/u;

const COUNT_WORDS: Record<string, "passed" | "failed" | "skipped" | "errors"> = {
  passed: "passed", passing: "passed", ok: "passed", pass: "passed",
  failed: "failed", failing: "failed", failure: "failed", failures: "failed", fail: "failed",
  skipped: "skipped", pending: "skipped", ignored: "skipped", todo: "skipped", xfailed: "skipped", deselected: "skipped", incomplete: "skipped",
  error: "errors", errors: "errors",
};

type Counts = Record<"passed" | "failed" | "skipped" | "errors", number>;

/** Counts on one summary line; a line that totals suites or files (jest, vitest) is not counted. */
function countLine(line: string, counts: Counts): boolean {
  if (/^(Test Suites:|\s*Test Files\s)/u.test(line)) return false;
  let found = false;
  for (const match of line.matchAll(/(\d+) (passed|passing|failed|failing|failures?|skipped|pending|ignored|todo|xfailed|deselected|errors?)\b/gu)) {
    counts[COUNT_WORDS[match[2]!]!] += Number(match[1]);
    found = true;
  }
  for (const match of line.matchAll(/\b(Passed|Failed|Skipped|Failures|Errors|Incomplete|failures|errors|skipped)[:=]\s*(\d+)/gu)) {
    counts[COUNT_WORDS[match[1]!.toLowerCase()]!] += Number(match[2]);
    found = true;
  }
  const ctest = /^\d+% tests passed, (\d+) tests? failed out of (\d+)/u.exec(line);
  if (ctest !== null) {
    counts.failed += Number(ctest[1]);
    counts.passed += Number(ctest[2]) - Number(ctest[1]);
    found = true;
  }
  return found;
}

function shapeTests(lines: string[], exitCode: number | null, config: ShapeConfig): { body: string[]; counts: string } | undefined {
  const keep = new Uint8Array(lines.length);
  const counts: Counts = { failed: 0, errors: 0, passed: 0, skipped: 0 };
  let counted = false;
  const go = { pass: 0, fail: 0, skip: 0, okPackages: 0, failPackages: 0 };
  const runs = new Map<string, number>();
  const summaries: number[] = [];
  const failingSummaries: number[] = [];
  const blocks: { start: number; end: number; pre: number }[] = [];
  let oneLiners = 0;
  let open: { start: number; pre: number } | undefined;
  const close = (end: number) => {
    if (open !== undefined) blocks.push({ ...open, end });
    open = undefined;
  };
  /** go: packages with a `# pkg` build failure block, packages reported `[build failed]`, and the current package's section. */
  const built = new Set<string>();
  const unbuilt: string[] = [];
  let section = { start: 0, blocks: 0, oneLiners: 0 };
  for (let index = 0; index < lines.length; index++) {
    const line = probe(lines[index]!);
    if (line.startsWith("=== RUN")) runs.set(line.slice(7).trim(), index);
    else if (/^\s*--- PASS: /u.test(line)) go.pass++;
    else if (/^\s*--- SKIP: /u.test(line)) go.skip++;
    if (/^ok\s+\S/u.test(line)) go.okPackages++;
    else if (/^FAIL\s+\S/u.test(line)) go.failPackages++;
    if (SUMMARY_PATTERNS.some((pattern) => pattern.test(line))) {
      close(index);
      summaries.push(index);
      if (FAILING_SUMMARY.test(line)) failingSummaries.push(index);
      if (countLine(line, counts)) counted = true;
      if (GO_PACKAGE.test(line)) {
        const unbuiltPackage = GO_UNBUILT.exec(line);
        if (unbuiltPackage !== null) unbuilt.push(unbuiltPackage[1]!);
        else if (line.startsWith("FAIL") && blocks.length === section.blocks && oneLiners === section.oneLiners) {
          // go prints each package's test output just before its verdict: a failure with no header (os.Exit, a
          // TestMain error) is in the last lines of that section, so they stay.
          for (let kept = Math.max(section.start, index - GO_SECTION_TAIL); kept < index; kept++) keep[kept] = 1;
        }
        section = { start: index + 1, blocks: blocks.length, oneLiners };
      }
      continue;
    }
    if (FAILURE_ONE_LINERS.some((pattern) => pattern.test(line))) {
      close(index);
      if (oneLiners++ < MAX_ONE_LINERS) keep[index] = 1;
      continue;
    }
    // A pytest failure section header: `____ test_name ____`.
    const pytestHeader = line.startsWith("___") && line.endsWith("___") && line.replaceAll("_", "").trim() !== "";
    // A go package that failed to build: its `# pkg` line, when a diagnostic follows.
    const goBuild = line.startsWith("# ") ? GO_BUILD_HEADER.exec(line) : null;
    const goBuildHeader = goBuild !== null && GO_BUILD_DIAGNOSTIC.test(probe(lines[index + 1] ?? ""));
    if (goBuildHeader) built.add(goBuild[1]!);
    const header = pytestHeader || goBuildHeader || (line.startsWith("  ● Console") ? false : FAILURE_HEADERS.some((pattern) => pattern.test(line))) ||
      (open === undefined && CRASH_HEADERS.some((pattern) => pattern.test(line)));
    if (header) {
      close(index);
      let pre = index;
      const fail = /^\s*--- FAIL: (\S+)/u.exec(line);
      if (fail !== null) {
        go.fail++;
        const run = runs.get(fail[1]!);
        if (run !== undefined && index - run <= 400) pre = run;
      }
      open = { start: index, pre };
      continue;
    }
    if (open !== undefined && BLOCK_END.test(line)) close(index);
  }
  close(lines.length);
  if (go.pass + go.fail + go.skip > 0 && !counted) {
    counts.passed = go.pass;
    counts.failed = go.fail;
    counts.skipped = go.skip;
    counted = true;
  }
  const failedRun = (exitCode !== null && exitCode !== 0) || counts.failed + counts.errors > 0 || go.failPackages > 0;
  if (summaries.length === 0 && blocks.length === 0) return undefined;
  // A failed run whose failures the shaper cannot name stays raw: never hide an assertion.
  if (failedRun && blocks.length === 0 && oneLiners === 0) return undefined;
  // So does a go package that failed to build with no build errors to show for it.
  if (unbuilt.some((name) => !built.has(name))) return undefined;
  // The last summaries, and every one that reports a failure (a package that failed to build is one line among hundreds).
  for (const index of summaries.slice(-8)) keep[index] = 1;
  for (const index of failingSummaries.slice(0, MAX_ONE_LINERS)) keep[index] = 1;
  let shownBlocks = 0;
  for (const block of blocks) {
    const full = shownBlocks < config.max_failures;
    shownBlocks++;
    keep[block.start] = 1;
    let messages = 0;
    // go -v prints a test's log before its `--- FAIL` line: that log's message lines belong to the failure.
    for (let index = block.pre + 1; index < block.start; index++) {
      if (messages < 6 && MESSAGE.test(probe(lines[index]!))) {
        keep[index] = 1;
        messages++;
      }
    }
    const scanEnd = Math.min(block.end, block.start + 400);
    if (!full) {
      // Past max_failures: the name and one message, an `E` line when there is one, else the first that is not a frame.
      if (messages > 0) continue;
      let best: number | undefined;
      let rank = 0;
      for (let index = block.start + 1; index < scanEnd && rank < 3; index++) {
        const line = probe(lines[index]!);
        const lineRank = E_LINE.test(line) ? 3 : !MESSAGE.test(line) ? 0 : FRAME.test(line) ? 1 : 2;
        if (lineRank > rank) [best, rank] = [index, lineRank];
      }
      if (best !== undefined) keep[best] = 1;
      continue;
    }
    // A shown failure: its head, every `E` line, its other message lines on their own budget, its first frames and the
    // ones nearest the raise (a deep traceback loses its middle), and its tail.
    let eLines = 0;
    const frames: number[] = [];
    for (let index = block.start + 1; index < scanEnd; index++) {
      const line = probe(lines[index]!);
      if (index < block.start + 8) keep[index] = 1;
      if (E_LINE.test(line)) {
        if (eLines++ < 40) keep[index] = 1;
      } else if (FRAME.test(line)) {
        frames.push(index);
      } else if (MESSAGE.test(line) && messages < 16) {
        keep[index] = 1;
        messages++;
      }
    }
    for (const index of frames.length <= FRAMES_HEAD + FRAMES_TAIL ? frames : [...frames.slice(0, FRAMES_HEAD), ...frames.slice(-FRAMES_TAIL)]) keep[index] = 1;
    let last = block.end - 1;
    while (last > block.start && lines[last]!.trim() === "") last--;
    for (let index = Math.max(block.start + 1, last - BLOCK_TAIL + 1); index <= last; index++) keep[index] = 1;
  }
  for (let index = Math.max(0, lines.length - config.tail_lines); index < lines.length; index++) keep[index] = 1;
  const parts = (Object.keys(counts) as (keyof Counts)[]).filter((key) => counts[key] > 0).map((key) => `${counts[key]} ${key}`);
  const packages = go.okPackages + go.failPackages > 0 ? `; go packages: ${go.okPackages} ok, ${go.failPackages} FAIL` : "";
  const countText = `${counted && parts.length > 0 ? parts.join(", ") : "counts not reported"}${packages}`;
  const failuresText = blocks.length === 0 ? "" : `; ${plural(blocks.length, "failure")}${blocks.length > config.max_failures ? `, the first ${config.max_failures} with their trace heads, the rest by name and first message` : " with trace heads"}`;
  return { body: renderKept(lines, keep), counts: `${countText}${failuresText}` };
}

// ---------------------------------------------------------------- builds

/** A compiler or build tool diagnostic line. */
const DIAGNOSTICS: readonly RegExp[] = [
  /^\S+?:\d+:(\d+:)? ?(fatal error|error|warning)\b/u, // gcc, clang, javac
  /^\S+\.go:\d+(:\d+)?: /u, // go build, go vet
  /^\S+\(\d+,\d+\): (error|warning) TS\d+/u, /^\S+:\d+:\d+ - (error|warning) TS\d+/u, // tsc
  /^(error|warning)(\[E\d+\])?: /u, // rustc, cargo
  /^\[(ERROR|WARNING)\] \S/u, // maven
  /^[ew]: \S/u, // kotlin, gradle
  /^CMake (Error|Warning)/u,
  /^\S*ld(\.\S+)?: /u, /: undefined reference to /u,
];
const BUILD_SUMMARY = /^(BUILD (FAILED|SUCCESSFUL)|FAILURE: |\[INFO\] BUILD |\[ERROR\] BUILD|error: could not compile|Found \d+ errors?|\d+ errors? generated|\d+ warnings? generated|make(\[\d+\])?: \*{3}|ninja: build stopped|> Task \S+ FAILED|FAILED: )/u;
const NOT_A_DIAGNOSTIC = /^\[(ERROR|WARNING)\] (-+$|\s*$|Failed to execute goal|To see the full stack|Re-run Maven|For more information|Help 1|BUILD|$)/u;

function shapeBuild(lines: string[], exitCode: number | null, config: ShapeConfig): { body: string[]; counts: string } | undefined {
  const keep = new Uint8Array(lines.length);
  const blocks: { start: number; end: number; error: boolean }[] = [];
  let errors = 0;
  let warnings = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = probe(lines[index]!);
    if (BUILD_SUMMARY.test(line)) {
      keep[index] = 1;
      if (blocks.length > 0 && blocks.at(-1)!.end === lines.length) blocks.at(-1)!.end = index;
      continue;
    }
    if (DIAGNOSTICS.some((pattern) => pattern.test(line)) && !NOT_A_DIAGNOSTIC.test(line)) {
      if (blocks.length > 0 && blocks.at(-1)!.end === lines.length) blocks.at(-1)!.end = index;
      const lower = line.slice(0, 160).toLowerCase();
      const error = !(lower.includes("warning") || line.startsWith("w: ")) || lower.includes("error");
      if (error) errors++;
      else warnings++;
      blocks.push({ start: index, end: lines.length, error });
      continue;
    }
  }
  const failed = exitCode !== null && exitCode !== 0;
  if (blocks.length === 0 || (failed && errors === 0 && warnings === 0)) return undefined;
  // Errors first; warnings only show when there is no error to show.
  const shown = errors > 0 ? blocks.filter((block) => block.error) : blocks;
  let oneLine = 0;
  shown.forEach((block, rank) => {
    if (rank < config.max_failures) {
      for (let index = block.start; index < block.end && index < block.start + 12; index++) keep[index] = 1;
    } else if (oneLine++ < MAX_ONE_LINERS) keep[block.start] = 1;
  });
  for (let index = Math.max(0, lines.length - config.tail_lines); index < lines.length; index++) keep[index] = 1;
  const counts = `${plural(errors, "error")}, ${plural(warnings, "warning")}${shown.length > config.max_failures ? `; the first ${config.max_failures} with context, the rest one line each` : ""}${errors > 0 && warnings > 0 ? "; warnings not shown" : ""}`;
  return { body: renderKept(lines, keep), counts };
}

// ---------------------------------------------------------------- searches

const HIT = /^([^:]{1,400}):(\d+):(.*)$/u;
const FILE_HIT = /^([^:\s][^:]{0,399}):(.*)$/u;
const CONTEXT = /^([^:]{1,400})-(\d+)-/u;

function shapeSearch(lines: string[]): { body: string[]; counts: string } | undefined {
  const files = new Map<string, { hits: number; shown: string[] }>();
  const paths: string[] = [];
  let parsed = 0;
  let hits = 0;
  let nonEmpty = 0;
  let context = 0;
  for (const raw of lines) {
    if (raw === "") continue;
    nonEmpty++;
    const line = probe(raw);
    if (line === "--") {
      parsed++;
      continue;
    }
    const colon = line.indexOf(":");
    const hit = HIT.exec(line) ?? (colon > 0 && /[./]/u.test(line.slice(0, colon)) ? FILE_HIT.exec(line) : null);
    if (hit !== null) {
      const entry = files.get(hit[1]!) ?? { hits: 0, shown: [] };
      files.set(hit[1]!, entry);
      entry.hits++;
      hits++;
      parsed++;
      if (entry.shown.length < 3) entry.shown.push(`  ${hit.length === 4 ? `${hit[2]}: ${clip(hit[3]!.trim(), 160)}` : clip(hit[2]!.trim(), 160)}`);
      continue;
    }
    if (CONTEXT.test(line)) {
      context++;
      parsed++;
      continue;
    }
    if (!/\s/u.test(line)) {
      paths.push(raw);
      parsed++;
    }
  }
  // Hits and bare paths together are two commands' outputs (`find ...; rg ...`): the paths view would drop one.
  if (nonEmpty === 0 || parsed < nonEmpty * 0.9 || (files.size > 0 && paths.length > 0)) return undefined;
  const body: string[] = [];
  if (files.size > 0 && files.size >= paths.length) {
    let shownLines = 0;
    let listed = 0;
    const rest: string[] = [];
    for (const [path, entry] of files) {
      if (listed < 25 && shownLines < 60) {
        body.push(`${path} (${plural(entry.hits, "match")})`, ...entry.shown);
        shownLines += entry.shown.length;
        listed++;
      } else rest.push(`${path} (${entry.hits})`);
    }
    if (rest.length > 0) body.push(`other files: ${rest.slice(0, 60).join(", ")}${rest.length > 60 ? `, and ${rest.length - 60} more` : ""}`);
    return { body, counts: `${plural(hits, "match")} in ${plural(files.size, "file")}${context > 0 ? ` (+${context} context lines)` : ""}; the first 3 per file` };
  }
  const dirs = new Map<string, number>();
  for (const path of paths) {
    const parts = path.replace(/^\.\//u, "").split("/");
    const dir = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length === 2 ? `${parts[0]}/` : "./";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  body.push(...paths.slice(0, 40).map((path) => clip(path, 200)));
  if (paths.length > 40) {
    const top = [...dirs].sort((left, right) => right[1] - left[1]).slice(0, 15).map(([dir, count]) => `${dir} (${count})`);
    body.push(`[... ${paths.length - 40} more paths ...]`, `by directory: ${top.join(", ")}${dirs.size > 15 ? `, and ${dirs.size - 15} more directories` : ""}`);
  }
  return { body, counts: `${plural(paths.length, "path")}${paths.length > 40 ? "; the first 40" : ""}` };
}

// ---------------------------------------------------------------- entry

/**
 * The shaped view of a finished command's output, or undefined when it should
 * reach the model as is: shaping off for its kind, output under `min_bytes`,
 * not recognized, or not at least a third smaller once shaped.
 */
export function shapeOutput(command: string, output: string, exitCode: number | null, config: ShapeConfig): ShapePlan | undefined {
  const size = Buffer.byteLength(output, "utf8");
  if (size <= config.min_bytes) return undefined;
  const lines = output.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const classified = classifyCommand(command);
  if (classified?.mixed === true) return undefined;
  let kind: { kind: ShapeKind; tool: string } | undefined = classified;
  // Known by its output alone (a script that runs pytest): only when one command makes the output and it does not show a file.
  const sources = segmentsOf(command).filter((segment) => !segment.piped && !QUIET.has(segment.words[0]!));
  const viewer = kind === undefined && (sources.length > 1 || sources.some((segment) => VIEWERS.has(segment.words[0]!)));
  if (kind?.kind !== "test" && !viewer && lines.some((line) => STRONG_TEST_SIGNATURES.some((pattern) => pattern.test(probe(line))))) {
    kind = { kind: "test", tool: kind?.kind === "build" ? kind.tool : "output" };
  }
  if (kind === undefined || (kind.kind === "search" && config.shaping !== "all")) return undefined;
  const shaped = kind.kind === "test" ? shapeTests(lines, exitCode, config) : kind.kind === "build" ? shapeBuild(lines, exitCode, config) : shapeSearch(lines);
  if (shaped === undefined) return undefined;
  const label = kind.kind === "search" ? "search output" : `${kind.kind} output`;
  const head = (logPath: string) => `[harness: ${label} shaped (${kind.tool}): ${shaped.counts}. Raw: ${sizeOf(lines.length, size)}; full log: ${logPath}]`;
  const bodyBytes = shaped.body.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0) + 200;
  if (bodyBytes > size * (2 / 3)) return undefined;
  return { kind: kind.kind, tool: kind.tool, render: (logPath) => [head(logPath), ...shaped.body].join("\n") };
}
