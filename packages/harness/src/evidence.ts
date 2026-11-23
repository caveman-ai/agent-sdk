/**
 * What a shell command did, for the policy levers (evidence gate, first-green
 * reminder, effort escalation): a static, linear-time read of the command
 * text, no execution. A command is split into segments at unquoted `;`, `&&`,
 * `||`, `|`, `&`, newlines and parentheses (here-doc bodies belong to their
 * segment), and each segment is one of:
 * - check: a test runner, build or compiler, type checker or linter, a run of
 *   a program or script (`python x.py`, `./a.out`, `node -e ...`, `bash
 *   run.sh`), a diff of outputs, a request to a local server. Running the
 *   result counts as evidence (gold/reason-trajectories H1).
 * - mutate: a file write: `sed -i`, `tee`, `mv`/`cp`/`rm`/`mkdir`/`touch`,
 *   `patch`/`git apply`/`git checkout`, a formatter that rewrites, a redirect
 *   (`>`, `>>`) to a file from a segment that is not a check, inline
 *   interpreter code that opens a file for writing.
 * - inspect: everything else (cat, ls, grep, git diff, installs, cd, ...).
 * It is a heuristic by design; the evidence gate's mtime probe catches writes
 * it cannot see (a script that rewrites files). `readOnlyCommand` (D4) is a
 * separate, stricter test: an allowlist of programs that only read, so an
 * "inspect" segment such as an install is not read-only.
 */

export type SegmentKind = "check" | "mutate" | "inspect";

export interface CommandFacts {
  /** Segment kinds in order. */
  kinds: SegmentKind[];
  check: boolean;
  mutate: boolean;
  /** A write after the last check segment (`pytest; sed -i ...`): the check does not cover it. */
  mutatesAfterCheck: boolean;
}

interface Segment {
  text: string;
  heredoc: string;
}

/** Splits a command into segments at unquoted control operators; here-doc bodies attach to the segment that opened them. */
export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let current: Segment = { text: "", heredoc: "" };
  const pending: { delimiter: string; strip: boolean; segment: Segment }[] = [];
  let quote: "'" | '"' | undefined;
  let substitution = 0;
  const flush = () => {
    if (current.text.trim() !== "" || current.heredoc !== "") segments.push(current);
    current = { text: "", heredoc: "" };
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (quote !== undefined) {
      if (c === "\\" && quote === '"') {
        current.text += command.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) quote = undefined;
      current.text += c;
      i++;
      continue;
    }
    if (c === "\\") {
      current.text += command.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current.text += c;
      i++;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/u.test(command[i - 1]!))) {
      const end = command.indexOf("\n", i);
      i = end === -1 ? command.length : end;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      substitution++;
      current.text += "$(";
      i += 2;
      continue;
    }
    if (substitution > 0) {
      if (c === ")") substitution--;
      current.text += c;
      i++;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const match = /^<<(-?)[ \t]*(['"]?)([A-Za-z0-9_.-]+)\2/u.exec(command.slice(i));
      if (match !== null) {
        pending.push({ delimiter: match[3]!, strip: match[1] === "-", segment: current });
        current.text += match[0];
        i += match[0].length;
        continue;
      }
    }
    if (c === "&" && (command[i + 1] === ">" || /[<>]$/u.test(current.text))) {
      current.text += c; // `&>file`, `2>&1`: a redirect, not a separator
      i++;
      continue;
    }
    if (c === "\n" && pending.length > 0) {
      flush();
      let at = i + 1;
      for (const doc of pending) {
        const lines: string[] = [];
        while (at < command.length) {
          const end = command.indexOf("\n", at);
          const line = command.slice(at, end === -1 ? command.length : end);
          at = end === -1 ? command.length : end + 1;
          if ((doc.strip ? line.replace(/^\t+/u, "") : line) === doc.delimiter) break;
          lines.push(line);
        }
        doc.segment.heredoc += `${lines.join("\n")}\n`;
        if (!segments.includes(doc.segment)) segments.push(doc.segment);
      }
      pending.length = 0;
      i = at;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "(" || c === ")" || c === "{" && /^\s*$/u.test(current.text) || c === "}" && /\s$|^$/u.test(current.text)) {
      flush();
      i++;
      continue;
    }
    current.text += c;
    i++;
  }
  flush();
  return segments;
}

/** Shell words of a segment: quotes removed, `$(...)` kept whole. */
export function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      word += text[++i];
      started = true;
      continue;
    }
    if (/\s/u.test(c)) {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    word += c;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

const WRAPPERS = new Set(["sudo", "time", "nohup", "exec", "command", "builtin", "stdbuf", "nice", "ionice", "xvfb-run", "unbuffer", "caffeinate", "chronic"]);
const NEUTRAL = new Set(["cd", "pushd", "popd", "export", "source", ".", "set", "unset", "ulimit", "alias", "true", "false", ":", "exit", "return", "wait", "sleep", "trap", "shopt", "umask", "kill", "pkill", "echo", "printf", "read", "local", "declare", "eval", "done", "fi", "for", "case", "esac", "[", "[[", "test"]);
/** Shell keywords that precede a command in the same segment (`if pytest; then make; fi`). */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!"]);
/** xargs options that take a value. */
const XARGS_VALUE = new Set(["-n", "-I", "-P", "-L", "-d", "-s", "-E", "-a"]);
const INTERPRETERS = /^(?:python(?:\d+(?:\.\d+)?)?|pypy\d*|node|nodejs|ts-node|tsx|ruby|php|Rscript|R|julia|lua(?:jit)?|octave|elixir|escript|groovy|kotlin|scala|perl|bun|deno|java|bash|sh|zsh|dash|ksh)$/u;
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const RUNNERS = new Set([
  "pytest", "py.test", "tox", "nox", "nose2", "jest", "vitest", "mocha", "ava", "tap", "karma", "playwright", "cypress", "rspec", "phpunit",
  "pest", "ctest", "cmake", "ninja", "meson", "bazel", "bazelisk", "buck2", "gradle", "gradlew", "mvn", "mvnw", "ant", "sbt", "mill", "lein",
  "tsc", "gcc", "g++", "cc", "c++", "clang", "clang++", "rustc", "javac", "kotlinc", "scalac", "ghc", "swiftc", "coqc", "coqchk", "lean",
  "lake", "agda", "idris2", "dune", "ocamlfind", "ocamlopt", "ocamlc", "verilator", "iverilog", "vvp", "ghdl", "yosys", "mypy", "pyright",
  "flake8", "pylint", "eslint", "shellcheck", "diff", "cmp", "valgrind", "hyperfine", "rake", "behave", "robot", "hspec", "busted", "prove",
  "make", "gmake", "just", "ab", "k6", "wrk", "sqlite3", "psql", "grpcurl",
]);
const SUBCOMMAND_CHECKS: Record<string, Set<string>> = {
  go: new Set(["test", "build", "run", "vet"]),
  cargo: new Set(["test", "build", "check", "run", "nextest", "clippy", "bench", "miri"]),
  dotnet: new Set(["test", "build", "run"]),
  swift: new Set(["test", "build", "run"]),
  mix: new Set(["test", "compile", "run"]),
  stack: new Set(["test", "build", "run", "exec", "runghc"]),
  cabal: new Set(["test", "build", "run", "exec"]),
  zig: new Set(["test", "build", "run"]),
  poetry: new Set(["build"]),
  uv: new Set(["build"]),
};
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PM_OTHER = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "init", "config", "info", "view", "list", "ls", "why", "outdated", "audit", "version", "pack", "publish", "link", "unlink", "cache", "set", "upgrade", "up", "update", "global", "dlx", "create", "help", "login", "whoami", "prune", "dedupe", "fund", "doctor", "root", "bin", "prefix", "search", "store", "env", "import", "patch", "pm"]);
const PM_FORMATTERS = /(?:^|:)(?:fmt|format|prettier|lint:fix|fix)$/u;
const PYTHON_OTHER_MODULES = new Set(["pip", "venv", "ensurepip", "http.server", "site", "pydoc", "json.tool", "pip_audit", "virtualenv", "uv", "black", "isort", "autopep8"]);
/** Programs that change file contents. rm, mkdir, touch and chmod are left out: after a check they are cleanup or setup, not a change the check missed. */
const MUTATORS = new Set(["tee", "mv", "cp", "ln", "install", "patch", "truncate", "rsync", "unzip", "gunzip", "bunzip2", "unxz", "dd", "ed", "ex", "sponge", "apply_patch", "applypatch", "gofmt", "rustfmt", "black", "isort", "autopep8", "prettier", "clang-format", "shfmt", "dos2unix", "unix2dos", "wget", "curl", "tar", "7z", "split", "csplit", "rename"]);
const GIT_MUTATORS = new Set(["apply", "am", "checkout", "restore", "reset", "stash", "merge", "rebase", "cherry-pick", "revert", "mv", "rm", "switch", "pull", "clean", "clone", "init"]);
const INFO_FLAGS = new Set(["--version", "-V", "-v", "--help", "-h", "version", "help"]);
/** Inline code that writes files: Python, Node, Ruby, Perl idioms. */
const CODE_WRITES = /\bopen\([^)]*,\s*(?:mode\s*=\s*)?['"][^'"]*[wax+]|\.write_(?:text|bytes)\(|\bwriteFile(?:Sync)?\(|\bappendFile(?:Sync)?\(|\bshutil\.(?:copy|move|rmtree)|\bos\.(?:remove|rename|replace|unlink|makedirs|mkdir)\(|\.unlink\(|\bFile\.(?:write|open\([^)]*['"][wa])|\bfs\.(?:rm|rename|copyFile|mkdir)/u;
const LOCAL_URL = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?/u;

/** Words after env assignments, wrappers and runner prefixes (`uv run`, `npx`, `bundle exec`, `timeout 60`). */
export function programWords(words: string[]): string[] {
  let rest = words;
  for (let guard = 0; guard < 12 && rest.length > 0; guard++) {
    const first = rest[0]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(first) || KEYWORDS.has(first)) {
      rest = rest.slice(1);
    } else if (first === "xargs") {
      rest = rest.slice(1);
      while (rest.length > 0 && rest[0]!.startsWith("-")) rest = rest.slice(XARGS_VALUE.has(rest[0]!) ? 2 : 1);
      if (rest.length > 0) rest = [...rest, "<stdin args>"]; // xargs supplies arguments: `xargs python` runs files
    } else if (WRAPPERS.has(first)) {
      rest = rest.slice(1);
      while (rest.length > 0 && rest[0]!.startsWith("-")) rest = rest.slice(rest[0] === "-u" || rest[0] === "-n" || rest[0] === "-c" ? 2 : 1);
    } else if (first === "timeout" || first === "gtimeout") {
      rest = rest.slice(1);
      while (rest.length > 0 && rest[0]!.startsWith("-")) rest = rest.slice(rest[0] === "-s" || rest[0] === "-k" ? 2 : 1);
      rest = rest.slice(1); // the duration
    } else if (first === "env") {
      rest = rest.slice(1);
      while (rest.length > 0 && (rest[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rest[0]!))) rest = rest.slice(1);
    } else if (["uv", "poetry", "pipenv", "pdm", "hatch", "rye"].includes(first) && rest[1] === "run") {
      rest = rest.slice(2);
      while (rest.length > 0 && rest[0]!.startsWith("-")) rest = rest.slice(1);
    } else if (first === "conda" && rest[1] === "run") {
      rest = rest.slice(2);
      while (rest.length > 0 && rest[0]!.startsWith("-")) rest = rest.slice(rest[0] === "-n" || rest[0] === "-p" ? 2 : 1);
    } else if (["npx", "pnpx", "bunx"].includes(first) || (["pnpm", "yarn"].includes(first) && (rest[1] === "exec" || rest[1] === "dlx"))) {
      rest = rest.slice(first.endsWith("x") ? 1 : 2);
      while (rest.length > 0 && rest[0]!.startsWith("-")) rest = rest.slice(1);
    } else if (first === "bundle" && rest[1] === "exec") {
      rest = rest.slice(2);
    } else {
      break;
    }
  }
  return rest;
}

const REDIRECT = /^\d*(?:>>?|&>>?|>\||<<-?|<<<|<>|<)/u;

/** Words without redirections: `2>&1`, `>out`, `> out`, `<<EOF`, `< in`. */
export function stripRedirects(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const match = REDIRECT.exec(words[i]!);
    if (match === null) out.push(words[i]!);
    else if (match[0].length === words[i]!.length) i++; // the target is the next word
  }
  return out;
}

/** Redirect targets that write a file (`> f`, `>> f`, `2> f`, `&> f`), skipping `/dev/*` and fd duplications. */
function redirectsToFile(text: string): boolean {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c !== ">") continue;
    if (text[i - 1] === "<" || text[i + 1] === "(") continue; // `<>` or a process substitution
    let j = i + 1;
    if (text[j] === ">" || text[j] === "|") j++;
    if (text[j] === "&") continue; // `>&2`
    while (text[j] === " " || text[j] === "\t") j++;
    const target = /^[^\s;&|<>()]+/u.exec(text.slice(j))?.[0] ?? "";
    if (target !== "" && !target.startsWith("/dev/")) return true;
  }
  return false;
}

function interpreterKind(program: string, args: string[], heredoc: string): SegmentKind {
  if (args.length === 1 && INFO_FLAGS.has(args[0]!)) return "inspect";
  if (SHELLS.has(program)) {
    const c = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/u.test(arg));
    if (c >= 0) return args[c + 1] === undefined ? "inspect" : kindOf(classifyCommand(args[c + 1]!));
    const script = args.find((arg) => !arg.startsWith("-"));
    if (script !== undefined) return "check";
    return heredoc.trim() === "" ? "inspect" : kindOf(classifyCommand(heredoc));
  }
  if (program === "perl") {
    if (args.some((arg) => /^-[a-zA-Z]*i/u.test(arg))) return "mutate";
    if (args.some((arg) => /^-[a-zA-Z]*[eEnp]/u.test(arg))) return "inspect";
    return args.length === 0 && heredoc === "" ? "inspect" : "check";
  }
  if (program === "java") return args.length === 0 ? "inspect" : "check";
  if (program === "bun" || program === "deno") {
    const sub = args[0];
    if (sub === undefined) return "inspect";
    if (program === "deno" && !["test", "run", "check", "bench", "task", "eval"].includes(sub)) return sub.includes(".") ? "check" : "inspect";
    if (program === "bun" && PM_OTHER.has(sub)) return "inspect";
  }
  const m = args.indexOf("-m");
  if (m >= 0) {
    const module = args[m + 1] ?? "";
    return PYTHON_OTHER_MODULES.has(module) ? (module === "black" || module === "isort" || module === "autopep8" ? "mutate" : "inspect") : "check";
  }
  const inline = args.findIndex((arg) => arg === "-c" || arg === "-e" || arg === "--eval" || arg === "-p" || arg === "--print");
  const code = inline >= 0 ? (args[inline + 1] ?? "") : args.length === 0 || args[0] === "-" ? heredoc : undefined;
  if (code !== undefined) {
    if (code.trim() === "") return "inspect";
    return CODE_WRITES.test(code) ? "mutate" : "check";
  }
  return "check";
}

function segmentKind(segment: Segment): SegmentKind {
  const words = programWords(stripRedirects(shellWords(segment.text)));
  if (words.length === 0) return redirectsToFile(segment.text) ? "mutate" : "inspect";
  const path = words[0]!;
  const program = path.split("/").pop() ?? path;
  const args = words.slice(1);
  let kind: SegmentKind = "inspect";
  if (NEUTRAL.has(program)) kind = "inspect";
  else if (program === "sed") kind = args.some((arg) => /^-[a-zA-Z]*i|^--in-place/u.test(arg)) ? "mutate" : "inspect";
  else if (program === "awk" || program === "gawk") kind = args.includes("inplace") ? "mutate" : "inspect";
  else if (program === "find") kind = args.some((arg) => arg === "-delete" || arg === "-exec" && /^(?:rm|mv|sed|perl)$/u.test(args[args.indexOf(arg) + 1] ?? "")) ? "mutate" : "inspect";
  else if (program === "git") kind = GIT_MUTATORS.has(args.find((arg) => !arg.startsWith("-")) ?? "") ? "mutate" : "inspect";
  else if (program === "curl" || program === "wget" || program === "http" || program === "https") kind = args.some((arg) => LOCAL_URL.test(arg)) ? "check" : MUTATORS.has(program) && args.some((arg) => arg === "-o" || arg === "-O" || arg.startsWith("--output")) ? "mutate" : "inspect";
  else if (program === "tar") kind = args.some((arg) => /^-?[a-zA-Z]*x/u.test(arg)) ? "mutate" : "inspect";
  else if (MUTATORS.has(program)) kind = program === "tee" && args.every((arg) => arg.startsWith("-") || arg.startsWith("/dev/")) ? "inspect" : "mutate";
  else if (program === "ruff") kind = args.includes("format") || args.includes("--fix") ? "mutate" : "check";
  else if (program === "eslint" || program === "clang-tidy") kind = args.includes("--fix") ? "mutate" : "check";
  else if (program === "make" || program === "gmake") kind = args.some((arg) => arg === "-n" || arg === "--dry-run" || arg === "-p") ? "inspect" : args.includes("clean") ? "mutate" : "check";
  else if (RUNNERS.has(program)) kind = args.length === 1 && INFO_FLAGS.has(args[0]!) || args.includes("--collect-only") || args.includes("--co") ? "inspect" : "check";
  else if (SUBCOMMAND_CHECKS[program] !== undefined) kind = SUBCOMMAND_CHECKS[program]!.has(args[0] ?? "") ? "check" : program === "cargo" && args[0] === "fmt" || program === "go" && args[0] === "fmt" ? "mutate" : "inspect";
  else if (PACKAGE_MANAGERS.has(program) && program !== "bun") {
    const sub = args.find((arg) => !arg.startsWith("-"));
    const script = sub === "run" || sub === "run-script" ? args[args.indexOf(sub) + 1] ?? "" : sub ?? "";
    kind = sub === undefined || PM_OTHER.has(sub) ? "inspect" : PM_FORMATTERS.test(script) ? "mutate" : "check";
  } else if (INTERPRETERS.test(program)) kind = interpreterKind(program, args, segment.heredoc);
  else if (path.includes("/")) kind = "check"; // ./a.out, ./run_tests.sh, /app/bin/tool: running the artifact
  if (kind !== "check" && kind !== "mutate" && redirectsToFile(segment.text)) return "mutate";
  return kind;
}

function kindOf(facts: CommandFacts): SegmentKind {
  return facts.mutatesAfterCheck || (facts.mutate && !facts.check) ? "mutate" : facts.check ? "check" : "inspect";
}

/** The kinds of a command's segments, in order, and what they add up to. */
export function classifyCommand(command: string): CommandFacts {
  const kinds = splitSegments(command).map(segmentKind);
  const lastCheck = kinds.lastIndexOf("check");
  const lastMutate = kinds.lastIndexOf("mutate");
  return { kinds, check: lastCheck >= 0, mutate: lastMutate >= 0, mutatesAfterCheck: lastMutate > lastCheck };
}

/**
 * Programs that only read files or report state: no writes, no process
 * control, no network, no code execution. D4's read-only test; an allowlist,
 * so an unknown program is never read-only. Conditional ones (sed, awk, find,
 * git, sort, ...) are decided in `readOnlyWords`.
 */
const READ_ONLY = new Set([
  "ls", "tree", "pwd", "cat", "tac", "head", "tail", "wc", "nl", "grep", "egrep", "fgrep", "rg", "ag", "ack", "fd", "fdfind",
  "file", "stat", "du", "df", "readlink", "realpath", "basename", "dirname", "md5sum", "sha1sum", "sha256sum", "sha512sum", "shasum", "cksum",
  "od", "hexdump", "strings", "cut", "tr", "column", "fold", "rev", "paste", "comm", "expand", "jq", "which", "whereis", "type",
  "echo", "printf", "true", "false", ":", "cd", "pushd", "popd", "export", "set", "unset", "test", "[", "[[", "local", "declare", "read",
  "shopt", "ulimit", "umask", "alias", "trap", "exit", "return", "wait", "sleep", "uname", "id", "whoami", "printenv", "ps", "pgrep",
  "nproc", "free", "uptime", "lscpu", "for", "done", "fi", "esac",
]);
/** git subcommands that read the repository (with their write forms refused in `gitReadOnly`). */
const GIT_READ = new Set([
  "status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "cat-file", "describe", "shortlog",
  "show-ref", "merge-base", "name-rev", "for-each-ref", "count-objects", "whatchanged", "branch", "tag", "remote", "stash", "config", "reflog",
]);
const PM_READ: Record<string, Set<string>> = {
  npm: new Set(["ls", "list", "view", "info", "why", "outdated", "root", "prefix", "bin"]),
  pnpm: new Set(["ls", "list", "why", "outdated", "root", "bin"]),
  yarn: new Set(["list", "info", "why", "outdated"]),
  pip: new Set(["list", "show", "freeze", "check"]),
  pip3: new Set(["list", "show", "freeze", "check"]),
};

/** `git [-C dir] [-c k=v] [--no-pager] <sub> args`: a read of the repository, not a write (branch/tag/remote/config/stash/reflog list forms only). */
function gitReadOnly(args: string[]): boolean {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === undefined) return false;
  if (!GIT_READ.has(sub) || rest.some((arg) => arg.startsWith("--output"))) return false;
  const flagsOnly = (allowed: RegExp) => rest.every((arg) => arg.startsWith("-") && allowed.test(arg));
  switch (sub) {
    case "branch": return flagsOnly(/^(?:-[arvl]+|-vv|--(?:list|all|remotes|verbose|show-current|no-color|color(?:=.*)?|contains|merged|no-merged))$/u);
    case "tag": return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list";
    case "remote": return flagsOnly(/^(?:-v|--verbose)$/u);
    case "config": return rest.some((arg) => /^(?:--get(?:-all|-regexp)?|-l|--list)$/u.test(arg));
    case "stash": return rest[0] === "list" || rest[0] === "show";
    case "reflog": return rest.length === 0 || rest[0] === "show" || rest[0]!.startsWith("-");
    default: return true;
  }
}

/** One segment's program words (after env assignments and wrappers): a read-only program used in a read-only way. */
function readOnlyWords(words: string[]): boolean {
  if (words.length === 0) return true; // assignments only
  const program = words[0]!;
  if (program.includes("/")) return false; // ./ls, /app/bin/cat: a file in the workspace, not the system program
  const args = words.slice(1);
  const positional = args.filter((arg) => !arg.startsWith("-"));
  if (args.length === 1 && INFO_FLAGS.has(args[0]!)) return true; // `python --version`, `go version`
  switch (program) {
    case "sed": return !args.some((arg) => /^-[a-zA-Z]*i|^--in-place/u.test(arg) || /(?:^|[^A-Za-z])[wWe]\s+\S/u.test(arg));
    case "awk": case "gawk": return !args.some((arg) => arg === "inplace" || /[>|]|\bsystem\b|\bgetline\b/u.test(arg));
    case "find": {
      if (args.some((arg) => /^-(?:delete|fprint0?|fprintf|fls)$/u.test(arg))) return false;
      for (let i = 0; i < args.length; i++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/u.test(args[i]!)) continue;
        const end = args.findIndex((arg, at) => at > i && (arg === ";" || arg === "+"));
        if (!readOnlyWords(programWords(args.slice(i + 1, end === -1 ? undefined : end)))) return false;
      }
      return true;
    }
    case "git": return gitReadOnly(args);
    case "sort": return !args.some((arg) => arg === "-o" || arg.startsWith("--output") || /^-[a-zA-Z]*o/u.test(arg));
    case "uniq": return positional.length <= 1;
    case "xxd": return !args.some((arg) => /^-r|^-revert/u.test(arg)) && positional.length <= 1;
    case "date": return !args.some((arg) => /^-[a-zA-Z]*s|^--set/u.test(arg));
    case "yq": return !args.some((arg) => /^-[a-zA-Z]*i|^--inplace/u.test(arg));
    default: break;
  }
  if (PM_READ[program] !== undefined) return PM_READ[program]!.has(args.find((arg) => !arg.startsWith("-")) ?? "");
  return READ_ONLY.has(program);
}

/** The bodies of `$(...)` and backtick substitutions in a command (outermost first). */
function substitutions(command: string): string[] {
  const bodies: string[] = [];
  for (let i = command.indexOf("$("); i !== -1; i = command.indexOf("$(", i + 2)) {
    let depth = 0;
    for (let j = i + 1; j < command.length; j++) {
      if (command[j] === "(") depth++;
      else if (command[j] === ")" && --depth === 0) {
        bodies.push(command.slice(i + 2, j));
        break;
      }
    }
  }
  for (const match of command.matchAll(/`([^`]*)`/gu)) bodies.push(match[1]!);
  return bodies;
}

/**
 * D4: whether a shell command only reads (ls, rg, cat, git status/diff/log,
 * sed -n, find without -delete, ...): every segment, every substitution, an
 * allowlisted program used in a read-only way, and no redirect to a file. A
 * heuristic that errs toward "no": a command it cannot place keeps the run's
 * own effort.
 */
export function readOnlyCommand(command: string): boolean {
  if (command.trim() === "") return false;
  for (const segment of splitSegments(command)) {
    if (redirectsToFile(segment.text)) return false;
    if (!readOnlyWords(programWords(stripRedirects(shellWords(segment.text))))) return false;
  }
  return substitutions(command).every((body) => body.trim() !== "" && readOnlyCommand(body));
}

/**
 * Summary lines that mean a check failed even when the command exited 0
 * (`pytest | tail` exits with tail's status): runner summaries, tracebacks,
 * compiler and build errors.
 */
const FAILURE_MARKERS: readonly RegExp[] = [
  /\b[1-9]\d* (?:failed|failing|failures?)\b/u,
  /^FAILED\b/mu,
  /^FAIL\b/mu,
  /^--- FAIL:/mu,
  /test result: FAILED/u,
  /Traceback \(most recent call last\)/u,
  /^\S+:\d+(?::\d+)?: (?:fatal )?error:/mu,
  /^error(?:\[E\d+\])?:/mu,
  /\berror TS\d+:/u,
  /\*\*\* \[[^\]]*\] Error \d+/u,
  /npm ERR!/u,
  /\bBUILD FAIL(?:ED|URE)\b/u,
  /\bpanicked at\b/u,
  /Segmentation fault|core dumped/u,
];

/** A finished check's outcome: red on a non-zero exit or a failure summary in its output, else green. */
export function checkOutcome(exitCode: number | null | undefined, output: string): "red" | "green" | undefined {
  if (exitCode === undefined || exitCode === null) return undefined;
  if (exitCode !== 0) return "red";
  return FAILURE_MARKERS.some((marker) => marker.test(output)) ? "red" : "green";
}

/** The sentences or lines of a final message that match any hedge pattern, trimmed, at most `max`. */
export function hedgedItems(text: string, patterns: readonly RegExp[], max = 6): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    for (const sentence of line.split(/(?<=[.!?])\s+/u)) {
      const item = sentence.replace(/^[\s>*#-]*(?:\d+[.)]\s*)?/u, "").trim();
      if (item === "" || !patterns.some((pattern) => pattern.test(item))) continue;
      items.push(item.length > 240 ? `${item.slice(0, 237)}...` : item);
      if (items.length >= max) return items;
    }
  }
  return items;
}
