/**
 * Shell hardening shared by every ExecEnv (B3), each part behind its own
 * loadout flag and off by default:
 * - hygiene: the command reaches its shell in an unexported variable, never on
 *   the shell's argv (`pkill -f "go test"` cannot match, and kill, the shell
 *   running it: Reason 1.3's one-line worker change), bash starts with
 *   --noprofile --norc, BASH_ENV/ENV are /dev/null, stdin is /dev/null, and
 *   git and pagers never prompt or page.
 * - watch stop: a command whose output ends on a watch-mode banner ("Waiting
 *   for file changes") and stays silent for 10 s is stopped (exit 124) with a
 *   one-line remedy; the matcher is a linear scan, never a regex over output.
 * - self-kill guard (LocalEnv): kill/pkill/killall/xargs-kill lines whose
 *   targets include the harness or one of its ancestors are refused with a
 *   correctable message, before anything runs.
 * - toolbox: a pinned tool directory appended last on PATH when it exists.
 */
import { execFile } from "node:child_process";
import { userInfo } from "node:os";

export interface ShellSettings {
  hygiene?: boolean;
  /** Stop a command silent this long on a watch-mode banner; undefined is off. */
  watchStopMs?: number;
  selfKillGuard?: boolean;
  /** Absolute directory appended last on PATH when it exists in the env. */
  toolboxPath?: string;
}

/** The variable that carries the command to its shell under hygiene. */
export const CMD_VAR = "__harness_cmd";

/**
 * Variables hygiene adds under the image's own (an image that sets BASH_ENV to
 * activate a venv keeps it). Git config rides in GIT_CONFIG_COUNT (command
 * scope) rather than a private GIT_CONFIG_GLOBAL file, so the model's own
 * `git config --global` still lands in ~/.gitconfig where a grader reads it.
 */
export const HYGIENE_ENV: Readonly<Record<string, string>> = Object.freeze({
  BASH_ENV: "/dev/null", ENV: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", PAGER: "cat",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "core.pager", GIT_CONFIG_VALUE_0: "cat",
  GIT_CONFIG_KEY_1: "core.editor", GIT_CONFIG_VALUE_1: "true",
  GIT_CONFIG_KEY_2: "safe.directory", GIT_CONFIG_VALUE_2: "*",
});

/** The fixed `-c` script that runs the command from CMD_VAR; `export -n` keeps it out of the command's children. */
export function offArgvScript(bash: boolean): string {
  return bash ? `export -n ${CMD_VAR}; eval "$${CMD_VAR}"` : `__harness_c=$${CMD_VAR}; unset ${CMD_VAR}; eval "$__harness_c"`;
}

/** Whether a shell path is a bash: `/bin/bash`, or a Windows `...\bash.exe` (LocalEnv on Windows). */
export function isBash(shell: string): boolean {
  return shell.endsWith("bash") || /bash\.exe$/iu.test(shell);
}

/** Shell flags before `-c` under hygiene (dash has no --noprofile). */
export function hygieneFlags(shell: string): string[] {
  return isBash(shell) ? ["--noprofile", "--norc"] : [];
}

/** A shell prefix that appends `dir` to PATH when it exists and is not on PATH yet. */
export function toolboxPrefix(dir: string): string {
  return `if [ -d '${dir}' ]; then case ":$PATH:" in *':${dir}:'*) ;; *) PATH="\${PATH:+$PATH:}${dir}"; export PATH;; esac; fi; `;
}

// ---------------------------------------------------------------- watch stop

export const WATCH_STOP_MS = 10_000;
const TAIL_BYTES = 2048;
const BANNERS = ["waiting for file changes", "waiting for changes", "watching for file changes", "watching for changes", "watch usage: press w to show more"];
const HELP_LINE = "press h to show help";

export const watchStopNote = (seconds: number) =>
  `[harness: stopped after ${seconds} s without output: the command finished its run and was waiting for file changes (watch mode), so it would never exit. ` +
  "Its results are above; exit code 124 is this stop, not the command's own. To run it once: prefix the same command with CI=1, " +
  "or pass --run to vitest (vitest run ...), --watchAll=false to jest, or drop --watch/-w. To keep a watcher running, start it in the background with its output in a file.]";

/**
 * `text` with ANSI escapes (CSI, OSC, two-byte ESC) and control characters
 * other than tab and newline removed, carriage returns as newlines. One pass.
 */
export function plainText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x1b || code === 0x9b) {
      const kind = code === 0x9b ? "[" : text[i + 1];
      if (code === 0x1b) i++;
      if (kind === "[") {
        while (i + 1 < text.length) {
          const c = text.charCodeAt(++i);
          if (c >= 0x40 && c <= 0x7e) break;
        }
      } else if (kind !== undefined && "()*+-./#%".includes(kind)) {
        i++; // charset designation: ESC ( B
      } else if (kind === "]") {
        while (i + 1 < text.length) {
          const c = text.charCodeAt(++i);
          if (c === 0x07) break;
          if (c === 0x1b && text[i + 1] === "\\") {
            i++;
            break;
          }
        }
      }
      continue;
    }
    if (code === 0x0d) out += "\n";
    else if (code >= 0x20 || code === 0x0a || code === 0x09) out += text[i];
  }
  return out;
}

/**
 * Whether output ends on a watch-mode banner: its last non-blank line names the
 * wait ("Waiting for file changes..."), or is vitest's "press h to show help"
 * right after such a line. Reason's rule, as substring checks on the last two
 * lines of the plain tail (linear; no backtracking).
 */
export function endsOnWatchBanner(tail: string): boolean {
  const text = plainText(tail).toLowerCase();
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === " " || text[end - 1] === "\t")) end--;
  const lastStart = text.lastIndexOf("\n", end - 1) + 1;
  const last = text.slice(lastStart, end);
  const names = (line: string) => BANNERS.some((banner) => line.includes(banner));
  if (names(last)) return true;
  if (!last.includes(HELP_LINE) || lastStart === 0) return false;
  return names(text.slice(text.lastIndexOf("\n", lastStart - 2) + 1, lastStart - 1));
}

/** Watches one command's output; calls onStop once if it goes silent for `idleMs` on a watch banner. */
export class WatchStop {
  private tail: Buffer = Buffer.alloc(0);
  private lastAt = performance.now();
  private timer: NodeJS.Timeout | undefined;
  private done = false;
  stopped = false;
  private readonly idleMs: number;
  private readonly onStop: () => void;
  constructor(idleMs: number, onStop: () => void) {
    this.idleMs = idleMs;
    this.onStop = onStop;
  }

  feed(chunk: Buffer): void {
    if (this.done) return;
    this.tail = chunk.length >= TAIL_BYTES ? Buffer.from(chunk.subarray(chunk.length - TAIL_BYTES)) : Buffer.concat([this.tail, chunk]).subarray(-TAIL_BYTES);
    this.lastAt = performance.now();
    this.arm(this.idleMs);
  }

  close(): void {
    this.done = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(ms: number): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => this.check(), ms);
    this.timer.unref();
  }

  private check(): void {
    this.timer = undefined;
    if (this.done) return;
    const idle = performance.now() - this.lastAt;
    if (idle < this.idleMs) return this.arm(this.idleMs - idle);
    if (!endsOnWatchBanner(this.tail.toString("latin1"))) return;
    this.done = true;
    this.stopped = true;
    this.onStop();
  }
}

// ----------------------------------------------------------- self-kill guard

/** A process the model's commands must not signal: the harness and its ancestors. */
export interface GuardedProcess {
  pid: number;
  ppid: number;
  pgid: number;
  /** Executable name (basename), as pkill and killall match it. */
  comm: string;
  /** Full command line, as pkill -f matches it. */
  args: string;
}

interface Simple {
  words: string[];
  /** The command before it in a pipeline (`a | b`: b's pipedFrom is a). */
  pipedFrom?: Simple;
}

/** `\0S<n>\0` in a word: command substitution n of the parse. */
const SUBST = /\0S(\d+)\0/u;

/**
 * Simple commands of a shell line: words with quotes removed, `$VAR` kept
 * literally, each `$(...)` / backticks parsed as its own list and left as a
 * placeholder. Good enough to find kill targets; never used to run anything.
 */
export function parseCommands(text: string): { commands: Simple[]; substitutions: Simple[][] } {
  const substitutions: Simple[][] = [];
  const parse = (src: string): Simple[] => {
    const commands: Simple[] = [];
    let words: string[] = [];
    let word: string | undefined;
    let piped: Simple | undefined;
    const endWord = () => {
      if (word !== undefined) words.push(word);
      word = undefined;
    };
    const endCommand = (pipe: boolean) => {
      endWord();
      let current: Simple | undefined;
      if (words.length > 0) {
        current = { words, ...(piped === undefined ? {} : { pipedFrom: piped }) };
        commands.push(current);
      }
      piped = pipe ? current : undefined;
      words = [];
    };
    /** Index just past the `)` closing a `$(` that opened before `from`. */
    const closeParen = (from: number): number => {
      let depth = 1;
      for (let j = from; j < src.length; j++) {
        const c = src[j];
        if (c === "\\") j++;
        else if (c === "'") j = Math.max(j, src.indexOf("'", j + 1));
        else if (c === "(") depth++;
        else if (c === ")" && --depth === 0) return j + 1;
        if (j < 0) break;
      }
      return src.length;
    };
    const substitute = (inner: string) => {
      substitutions.push(parse(inner));
      word = (word ?? "") + `\0S${substitutions.length - 1}\0`;
    };
    for (let i = 0; i < src.length; i++) {
      const c = src[i]!;
      if (c === "\\") {
        if (src[i + 1] === "\n") i++;
        else if (i + 1 < src.length) word = (word ?? "") + src[++i];
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        word = (word ?? "") + src.slice(i + 1, end === -1 ? src.length : end);
        i = end === -1 ? src.length : end;
      } else if (c === '"') {
        word ??= "";
        for (i++; i < src.length && src[i] !== '"'; i++) {
          if (src[i] === "\\" && i + 1 < src.length && '"\\$`'.includes(src[i + 1]!)) word += src[++i];
          else if (src[i] === "$" && src[i + 1] === "(") {
            const end = closeParen(i + 2);
            substitute(src.slice(i + 2, end - 1));
            i = end - 1;
          } else if (src[i] === "`") {
            const end = src.indexOf("`", i + 1);
            substitute(src.slice(i + 1, end === -1 ? src.length : end));
            i = end === -1 ? src.length : end;
          } else word += src[i];
        }
      } else if (c === "$" && src[i + 1] === "(") {
        const end = closeParen(i + 2);
        substitute(src.slice(i + 2, end - 1));
        i = end - 1;
      } else if (c === "`") {
        const end = src.indexOf("`", i + 1);
        substitute(src.slice(i + 1, end === -1 ? src.length : end));
        i = end === -1 ? src.length : end;
      } else if (c === "#" && word === undefined) {
        const end = src.indexOf("\n", i);
        i = end === -1 ? src.length : end - 1;
      } else if (c === "|") {
        const pipe = src[i + 1] !== "|";
        if (!pipe) i++;
        endCommand(pipe);
      } else if (c === ";" || c === "&" || c === "\n" || c === "(" || c === ")") {
        endCommand(false);
      } else if (c === " " || c === "\t") {
        endWord();
      } else {
        word = (word ?? "") + c;
      }
    }
    endCommand(false);
    return commands;
  };
  return { commands: parse(text), substitutions };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
/** Prefix commands and the options of theirs that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]), exec: new Set(["-a"]), command: new Set(), builtin: new Set(),
  nohup: new Set(), time: new Set(), nice: new Set(["-n"]), env: new Set(["-u", "-C", "-S"]), stdbuf: new Set(["-i", "-o", "-e"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]), xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-i"]),
};
const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);
/** Reserved words that may open a simple command (`while true; do pkill node; done`, `{ kill $PPID; }`). */
const RESERVED = new Set(["{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "fi", "done"]);

/** The command a simple command runs past its prefixes (assignments, sudo, env, timeout, xargs...), and whether xargs feeds it. */
function unwrap(words: string[]): { words: string[]; xargs: boolean } {
  let i = 0;
  let xargs = false;
  while (i < words.length) {
    const word = words[i]!;
    if (ASSIGNMENT.test(word) || RESERVED.has(word)) {
      i++;
      continue;
    }
    const name = basename(word);
    const options = WRAPPERS[name];
    if (options === undefined) break;
    if (name === "xargs") xargs = true;
    i++;
    while (i < words.length && words[i]!.startsWith("-") && words[i] !== "--") i += options.has(words[i]!) ? 2 : 1;
    if (words[i] === "--") i++;
    if (name === "timeout" && i < words.length) i++; // the duration
    while (name === "env" && i < words.length && ASSIGNMENT.test(words[i]!)) i++;
  }
  return { words: words.slice(i), xargs };
}

const SIGNAL_WORD = /^-(\d+|SIG[A-Z0-9+-]+|[A-Z][A-Z0-9+-]+)$/u;
const PGREP_VALUE = new Set(["-u", "-U", "-g", "-G", "-P", "-s", "-t", "-F", "-M", "-N", "-c", "--signal", "--session", "--pidfile", "--parent", "--pgroup", "--euid", "--uid", "--group", "--terminal", "--ns", "--nslist"]);
const KILLALL_VALUE = new Set(["-s", "--signal", "-u", "--user", "-o", "--older-than", "-y", "--younger-than", "-n", "--ns", "-c", "-t"]);

interface Context {
  procs: GuardedProcess[];
  user: string | undefined;
  uid: number | undefined;
  /** BSD pkill/pgrep (macOS) skip their own ancestors unless -a. */
  bsd: boolean;
  /** The guarded pids that are ancestors of the command (default: all of them, the harness's own chain). */
  ancestors: Set<number> | undefined;
}

/** Literal test of a pattern a model gave (ERE as a JS RegExp; a pattern JS cannot compile is matched as text). */
function matcher(pattern: string, flags: { exact: boolean; ignoreCase: boolean }): (text: string) => boolean {
  try {
    const regex = new RegExp(flags.exact ? `^(?:${pattern})$` : pattern, flags.ignoreCase ? "iu" : "u");
    return (text) => regex.test(text);
  } catch {
    const needle = flags.ignoreCase ? pattern.toLowerCase() : pattern;
    return (text) => {
      const hay = flags.ignoreCase ? text.toLowerCase() : text;
      return flags.exact ? hay === needle : hay.includes(needle);
    };
  }
}

const isUser = (value: string, ctx: Context) => value.includes("$") || value.split(",").some((part) => part === ctx.user || part === String(ctx.uid));

/** Guarded processes a pgrep/pkill invocation (its arguments) selects. */
function pgrepHits(args: string[], ctx: Context): { hits: GuardedProcess[]; signal0: boolean } {
  let full = false;
  let exact = false;
  let ignoreCase = false;
  let negate = false;
  let newest = false;
  let signal0 = false;
  let withAncestors = false;
  const patterns: string[] = [];
  const filters: ((proc: GuardedProcess) => boolean)[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      patterns.push(...args.slice(i + 1));
      break;
    }
    if (SIGNAL_WORD.test(arg)) {
      if (arg === "-0") signal0 = true;
      continue;
    }
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (PGREP_VALUE.has(flag)) {
      const value = inline ?? args[++i] ?? "";
      if (flag === "--signal" && value === "0") signal0 = true;
      else if (flag === "-u" || flag === "-U" || flag === "--euid" || flag === "--uid") filters.push(() => isUser(value, ctx));
      else if (flag === "-P" || flag === "--parent") filters.push((proc) => value.split(",").includes(String(proc.ppid)));
      else if (flag === "-g" || flag === "--pgroup") filters.push((proc) => value.split(",").includes(String(proc.pgid)));
      else if (flag !== "-F" && flag !== "--pidfile") filters.push(() => false); // session, tty, group, namespace: not ours to judge
      continue;
    }
    if (arg.startsWith("--")) {
      if (arg === "--full") full = true;
      else if (arg === "--exact") exact = true;
      else if (arg === "--ignore-case") ignoreCase = true;
      else if (arg === "--inverse") negate = true;
      else if (arg === "--newest") newest = true;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      for (const letter of arg.slice(1)) {
        if (letter === "f") full = true;
        else if (letter === "x") exact = true;
        else if (letter === "i") ignoreCase = true;
        else if (letter === "v") negate = true;
        else if (letter === "n") newest = true;
        else if (letter === "a") withAncestors = true;
      }
      continue;
    }
    patterns.push(arg);
  }
  if (newest || (patterns.length === 0 && filters.length === 0)) return { hits: [], signal0 };
  const tests = patterns.map((pattern) => matcher(pattern, { exact, ignoreCase }));
  const hits = ctx.procs.filter((proc) => {
    if (ctx.bsd && !withAncestors && (ctx.ancestors === undefined || ctx.ancestors.has(proc.pid))) return false;
    if (!filters.every((filter) => filter(proc))) return false;
    if (tests.length === 0) return true;
    const matched = tests.some((test) => test(full ? proc.args : proc.comm));
    return matched !== negate;
  });
  return { hits, signal0 };
}

/** Guarded processes a killall or pidof invocation selects by name. */
function nameHits(args: string[], ctx: Context, killall: boolean): { hits: GuardedProcess[]; signal0: boolean } {
  let regex = false;
  let ignoreCase = false;
  let signal0 = false;
  const names: string[] = [];
  const filters: ((proc: GuardedProcess) => boolean)[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      names.push(...args.slice(i + 1));
      break;
    }
    if (killall && SIGNAL_WORD.test(arg)) {
      if (arg === "-0") signal0 = true;
      continue;
    }
    if (killall && KILLALL_VALUE.has(arg)) {
      const value = args[++i] ?? "";
      if ((arg === "-s" || arg === "--signal") && value === "0") signal0 = true;
      if (arg === "-u" || arg === "--user") filters.push(() => isUser(value, ctx));
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (killall && arg === "-l") return { hits: [], signal0: true };
      if (killall && (arg.includes("r") || arg.includes("m"))) regex = true;
      if (killall && arg.includes("I")) ignoreCase = true;
      continue;
    }
    names.push(arg);
  }
  if (names.length === 0 && filters.length === 0) return { hits: [], signal0 };
  const tests = names.map((name) => (regex ? matcher(name, { exact: false, ignoreCase }) : matcher(name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), { exact: true, ignoreCase })));
  const hits = ctx.procs.filter((proc) => filters.every((filter) => filter(proc)) &&
    (tests.length === 0 || tests.some((test) => test(proc.comm) || test(basename(proc.args.split(" ")[0] ?? "")))));
  return { hits, signal0 };
}

/** Guarded processes a source command (pgrep or pidof, maybe piped through head/sort) would print. */
function sourceHits(list: Simple[] | undefined, ctx: Context): GuardedProcess[] {
  const hits: GuardedProcess[] = [];
  for (const simple of list ?? []) {
    const { words } = unwrap(simple.words);
    const name = basename(words[0] ?? "");
    if (name === "pgrep") hits.push(...pgrepHits(words.slice(1), ctx).hits);
    else if (name === "pidof") hits.push(...nameHits(words.slice(1), ctx, false).hits);
  }
  return hits;
}

/** The pipeline feeding a command (its upstream commands, nearest first). */
function upstream(simple: Simple): Simple[] {
  const out: Simple[] = [];
  for (let at = simple.pipedFrom; at !== undefined; at = at.pipedFrom) out.push(at);
  return out;
}

/** What `kill ARGS` would signal among the guarded processes. */
function killHits(args: string[], ctx: Context, substitutions: Simple[][], piped: Simple[] | undefined): { hits: GuardedProcess[]; signal0: boolean; all: boolean } {
  let i = 0;
  let signal0 = false;
  if (args[0] === "-l" || args[0] === "-L") return { hits: [], signal0: true, all: false };
  if (args[0] === "-s" || args[0] === "-n") {
    signal0 = args[1] === "0";
    i = 2;
  } else if (args[0] !== undefined && args[0].startsWith("-") && args[0] !== "--") {
    signal0 = args[0] === "-0" || args[0] === "-SIG0";
    i = 1;
  }
  if (args[i] === "--") i++;
  const hits: GuardedProcess[] = [];
  let all = false;
  for (const arg of args.slice(i)) {
    const subst = SUBST.exec(arg);
    if (subst !== null) hits.push(...sourceHits(substitutions[Number(subst[1])], ctx));
    else if (arg === "-1") all = true;
    else if (/^-\d+$/u.test(arg)) hits.push(...ctx.procs.filter((proc) => proc.pgid === Number(arg.slice(1))));
    else if (/^\d+$/u.test(arg)) hits.push(...ctx.procs.filter((proc) => proc.pid === Number(arg)));
    else if (arg === "$PPID" || arg === "${PPID}") hits.push(...ctx.procs.slice(0, 1));
  }
  if (piped !== undefined) hits.push(...sourceHits(piped, ctx));
  return { hits, signal0, all };
}

export interface GuardContext {
  user?: string | undefined;
  uid?: number | undefined;
  /** pkill semantics to assume (default this host's). */
  platform?: string;
  /** Guarded pids that are ancestors of the command's shell (default: all). */
  ancestors?: Set<number>;
}

const describe = (proc: GuardedProcess) => `pid ${proc.pid} ${(proc.args || proc.comm).slice(0, 80)}`;

/**
 * The refusal for a command line that would signal the harness or one of its
 * ancestors (`procs[0]` is the harness, the parent of every command's shell),
 * or undefined when it would not (or cannot be told from the text).
 */
export function selfKillRefusal(command: string, procs: GuardedProcess[], who: GuardContext = {}): string | undefined {
  if (procs.length === 0 || !/kill|pidof/u.test(command)) return undefined;
  const platform = who.platform ?? process.platform;
  const ctx: Context = { procs, user: who.user, uid: who.uid, bsd: platform === "darwin" || platform.endsWith("bsd"), ancestors: who.ancestors };
  let parsed;
  try {
    parsed = parseCommands(command);
  } catch {
    return undefined;
  }
  for (const list of [parsed.commands, ...parsed.substitutions]) {
    for (const simple of list) {
      const { words, xargs } = unwrap(simple.words);
      const name = basename(words[0] ?? "");
      const args = words.slice(1);
      let found: { hits: GuardedProcess[]; signal0: boolean; all?: boolean } | undefined;
      if (name === "kill") found = killHits(args, ctx, parsed.substitutions, xargs ? upstream(simple) : undefined);
      else if (name === "pkill") found = pgrepHits(args, ctx);
      else if (name === "killall") found = nameHits(args, ctx, true);
      if (found === undefined || found.signal0) continue;
      const segment = simple.words.join(" ").replace(/\0S\d+\0/gu, "$(...)");
      if (found.all === true) {
        return `[harness: refused, nothing was run: \`${segment}\` signals every process you may signal, including the harness running your commands (${describe(procs[0]!)}), which would end this run. Kill your own processes by pid or by a pattern only they match.]`;
      }
      if (found.hits.length > 0) {
        const pids = [...new Set(found.hits.map((proc) => proc.pid))];
        return `[harness: refused, nothing was run: \`${segment}\` would also signal the harness running your commands (${describe(found.hits[0]!)}${found.hits.length > 1 ? ` and ${found.hits.length - 1} more` : ""}), which would end this run. ` +
          `Target only your own processes: use a pattern only they match (the script name or a unique argument), or kill pids from \`pgrep -fl PATTERN\` other than ${pids.join(", ")}.]`;
      }
    }
  }
  return undefined;
}

const run = (file: string, args: string[]) => new Promise<string>((done) =>
  execFile(file, args, { timeout: 5_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => done(error === null ? stdout : "")));

/**
 * `root` (the harness: the parent of every command's shell) and its ancestors,
 * from ps; pid 1 only for root (no one else may signal it). Empty when ps fails.
 */
export async function guardedProcesses(root: number = process.pid): Promise<GuardedProcess[]> {
  const table = new Map<number, { ppid: number; pgid: number }>();
  for (const line of (await run("ps", ["-A", "-o", "pid=,ppid=,pgid="])).split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/u).map(Number);
    if (pid !== undefined && Number.isInteger(pid) && pid > 0) table.set(pid, { ppid: ppid ?? 0, pgid: pgid ?? 0 });
  }
  const chain: number[] = [];
  for (let pid = root; table.has(pid) && !chain.includes(pid) && (pid > 1 || process.getuid?.() === 0); pid = table.get(pid)!.ppid) chain.push(pid);
  if (chain.length === 0) return [];
  const column = async (field: string) => {
    const out = new Map<number, string>();
    for (const line of (await run("ps", ["-o", `pid=,${field}=`, "-p", chain.join(",")])).split("\n")) {
      const match = /^\s*(\d+)\s(.*)$/u.exec(line);
      if (match !== null) out.set(Number(match[1]), match[2]!.trim());
    }
    return out;
  };
  const [comms, argv] = await Promise.all([column("comm"), column("args")]);
  return chain.map((pid) => ({ pid, ppid: table.get(pid)!.ppid, pgid: table.get(pid)!.pgid, comm: basename(comms.get(pid) ?? ""), args: argv.get(pid) ?? "" }));
}

export function currentUid(): number | undefined {
  try {
    return userInfo().uid;
  } catch {
    return undefined;
  }
}
