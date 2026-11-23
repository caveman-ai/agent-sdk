/**
 * policy.travel_jit: travel_check's three hazards named at the decision point,
 * on the tool result where the run creates them (levers.ts wires it). The
 * finish-time travel_check fired in 2 of 64 trials and moved nothing, and on
 * this model the first "done" is final (R4), so the note rides on the result
 * of the call that made the deliverable depend on something that will not be
 * in the grader's fresh copy of the start. No model call; every env command is
 * `internal` (handles h<n>), so the model's p<n> never shift.
 *
 * - packages: installs are recorded silently (an install note alone would hit
 *   107 of 446 passing dev trials). A command that installs named packages and
 *   succeeded (exit 0, or an install summary in its output): pip/pip3/python
 *   -m pip, uv pip install, uv add, uv tool install, poetry add, pipx install,
 *   conda/mamba/micromamba install, apt/apt-get install, npm/pnpm/yarn add or
 *   install with a package argument, cargo, gem and go install. Never a
 *   segment that installs from a path, a requirements or environment file, an
 *   editable, or into a chosen directory (-t, --prefix, --root: vendoring),
 *   never a bare lockfile restore. Its packages are the ones the output says
 *   it installed (pip/gem "Successfully installed", uv "+ x==", poetry "-
 *   Installing", apt "Setting up", cargo "Installed package"), none when it
 *   says they were already there, else the command's arguments; minus
 *   packaging tools, distributions the start snapshot had, and the whole
 *   install when the task names a requested package. After a Python install
 *   (pip family, conda, apt python3-*) one internal command re-reads the
 *   distributions (travel.ts PACKAGES_COMMAND): every non-local one the start
 *   lacked joins the session's packages with its real top-level modules
 *   (dependencies too); without a start snapshot a name table stands in
 *   (modulesOf). The note FIRES when a Python file the grader runs ADDS an
 *   import of a module of a session package (only the lines the write added:
 *   an upstream file that already imported it is not the run's doing), on
 *   that write's result; or when the install comes after such an import, on
 *   the install's result. "The grader runs" (gradedCode): the task names the
 *   file, or names a code file in its directory (a helper module of the
 *   deliverable), and it is not in a system tree, a test layout or under a
 *   scratch name. A script the run wrote to produce output files is not run
 *   by the grader (replay: hof-topology's solution/analyze.py imports gemmi,
 *   installed in the session, and passes 22 of 22).
 * - scratch: a test- or scratch-looking script (travel.ts scratchKind, with a
 *   source-code extension: logs, backups and result files introduce no code
 *   for a structural check to trip on) written under the cwd by
 *   apply_patch, write/edit or a shell command (redirection, tee, touch, cp/mv
 *   target; a `cd` earlier in the same command is followed) that
 *   scratchFindings keeps (not there at the start, not named by the task), not
 *   in the project's test layout, confirmed to exist with one internal `[ -f ]`.
 * - data: the lines a write added to a code file the grader runs (as above)
 *   name, by literal, a regular file older than the start marker, not tracked
 *   by git, not under /opt (installed software) and not named by the task
 *   (travel.ts fileCandidates, preexisting). The env check runs after the call returns, so the note waits
 *   for the next tool result (no latency); a finish attempt first drops it.
 *
 * Each kind fires at most max_per_kind times per run. Trace: every fire is
 * `policy remind travel_jit`, every suppressed trigger `policy skip
 * travel_jit` with its `cause` (max, task_named, finished_first), each with
 * the kind, what it names, the tool and `request` (the request whose tool
 * call the note rides on; the next request reads it); a recorded install is
 * `policy check travel_jit {kind: "install", packages}`.
 */
import { posix } from "node:path";
import type { ExecEnv } from "./env/types.ts";
import { programWords, shellWords, splitSegments, stripRedirects } from "./evidence.ts";
import type { JitKind, Levers } from "./loadout.ts";
import { placeboFor } from "./prompts.ts";
import type { LedgerEntry } from "./tools/exec/nested.ts";
import type { Recorder } from "./trace.ts";
import {
  codeExtension, fileCandidates, inSystemTree, isCode, mentioned, normalizeDist, PACKAGES_COMMAND, parsePackages, preexisting, pythonImports, scratchFindings, scratchKind, testLayout,
  type TravelStart,
} from "./travel.ts";

// ---------- packages ----------

export type Manager = "pip" | "conda" | "apt" | "npm" | "cargo" | "gem" | "go";

/** One install segment of a command: its manager and the packages its arguments name. */
export interface Install {
  manager: Manager;
  packages: string[];
}

/** Options whose value is the next word (never a package), per manager. */
const VALUE_FLAGS: Record<Manager, Set<string>> = {
  pip: new Set(["-c", "--constraint", "-i", "--index-url", "--extra-index-url", "--index", "--default-index", "-f", "--find-links", "--python-version",
    "--platform", "--implementation", "--abi", "--only-binary", "--no-binary", "--progress-bar", "--cache-dir", "--src", "--upgrade-strategy", "--log",
    "--proxy", "--retries", "--timeout", "--trusted-host", "--cert", "--client-cert", "--exists-action", "--global-option", "--config-settings", "-C",
    "--python", "-p", "--group", "-G", "--optional", "--extra", "--source", "--resolution", "--prerelease", "--index-strategy", "--keyring-provider", "--link-mode"]),
  conda: new Set(["-c", "--channel", "-n", "--name", "-p", "--prefix", "--solver"]),
  apt: new Set(["-o", "--option", "-t", "--target-release", "-c", "--config-file"]),
  npm: new Set(["--prefix", "--registry", "-w", "--workspace", "--tag", "--cache", "--userconfig"]),
  cargo: new Set(["--version", "--vers", "--git", "--branch", "--tag", "--rev", "--registry", "--index", "--features", "-F", "--target", "--target-dir",
    "--profile", "--bin", "--example", "-j", "--jobs", "--root", "--config", "-Z"]),
  gem: new Set(["-v", "--version", "-i", "--install-dir", "-n", "--bindir", "-s", "--source", "-P", "--trust-policy", "--platform"]),
  go: new Set(["-ldflags", "-gcflags", "-asmflags", "-tags", "-mod", "-modfile", "-o", "-p"]),
};

/** Options that make the segment a project, file or vendoring install (an editable, a requirements file, a target directory): never a trigger. */
const PROJECT_FLAGS: Record<Manager, Set<string>> = {
  pip: new Set(["-e", "--editable", "-r", "--requirement", "-t", "--target", "--prefix", "--root"]),
  conda: new Set(["--file"]), apt: new Set(), npm: new Set(), cargo: new Set(["--path"]), gem: new Set(), go: new Set(),
};

const LOCAL_FILE = /\.(?:whl|tar\.gz|tgz|tar\.bz2|zip|deb|gem|conda)$/iu;

/** The package a word names: its name, `null` for a local path or file (the segment is a project install), undefined for no package. */
function packageName(manager: Manager, word: string): string | null | undefined {
  if (word === "" || word === "@" || /[*$`]/u.test(word)) return undefined;
  if (/^(?:\.{1,2}(?:\/|$)|\/|~|file:)/u.test(word) || LOCAL_FILE.test(word)) return null;
  if (word.includes("://") || word.startsWith("git+")) {
    const egg = /#egg=([A-Za-z0-9][\w.-]*)/u.exec(word)?.[1];
    return egg ?? posix.basename(word.replace(/[#?@].*$/u, "").replace(/\/+$/u, "")).replace(/\.git$/u, "");
  }
  switch (manager) {
    case "npm":
      // @scope/name@1.2, name@1.2, user/repo (GitHub shorthand)
      if (word.startsWith("@")) return /^@[^/@\s]+\/[^@\s]+/u.exec(word)?.[0];
      return (word.includes("/") ? word.split("/").pop()!.replace(/#.*$/u, "") : word.replace(/@.*$/u, "")) || undefined;
    case "go": {
      const parts = word.replace(/@.*$/u, "").split("/").filter((part) => part !== "" && part !== "...");
      const last = parts.at(-1);
      return last !== undefined && /^v\d+$/u.test(last) ? parts.at(-2) : last;
    }
    case "conda":
      return /^([A-Za-z0-9][\w.-]*)/u.exec(word.replace(/^.*::/u, ""))?.[1];
    case "apt":
      return /^([a-z0-9][a-z0-9+.-]*)/u.exec(word)?.[1];
    default:
      if (manager === "pip" && word.includes("/")) return null; // dist/x, a local directory
      return /^([A-Za-z0-9][\w.-]*?)(?:[[<>=!~;@ ,]|$)/u.exec(word)?.[1];
  }
}

/** The index of the first positional word (a subcommand), skipping options and their values. */
function positional(args: readonly string[], values: ReadonlySet<string>, from = 0): number {
  for (let i = from; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) return i;
    if (values.has(arg)) i++;
  }
  return -1;
}

/** The manager and argument words of an install segment, or undefined. */
function installArgs(words: readonly string[]): { manager: Manager; args: string[] } | undefined {
  const program = posix.basename(words[0] ?? "");
  const args = words.slice(1);
  const sub = (manager: Manager, names: readonly string[], from = 0) => {
    const at = positional(args, VALUE_FLAGS[manager], from);
    return at >= 0 && names.includes(args[at]!) ? { manager, args: args.slice(at + 1) } : undefined;
  };
  if (/^pip(?:\d+(?:\.\d+)?)?$/u.test(program)) return sub("pip", ["install"]);
  if (/^python(?:\d+(?:\.\d+)?)?$/u.test(program)) {
    const m = args.indexOf("-m");
    return m >= 0 && args[m + 1] === "pip" ? sub("pip", ["install"], m + 2) : undefined;
  }
  if (program === "uv") {
    const at = positional(args, VALUE_FLAGS.pip);
    if (args[at] === "add") return { manager: "pip", args: args.slice(at + 1) };
    if (args[at] === "pip" || args[at] === "tool") return sub("pip", ["install"], at + 1);
    return undefined;
  }
  if (program === "poetry") return sub("pip", ["add"]);
  if (program === "pipx") return sub("pip", ["install"]);
  if (program === "conda" || program === "mamba" || program === "micromamba") return sub("conda", ["install"]);
  if (program === "apt" || program === "apt-get") return sub("apt", ["install"]);
  if (program === "npm") return sub("npm", ["install", "i", "add", "isntall", "in"]);
  if (program === "pnpm") return sub("npm", ["add", "install", "i"]);
  if (program === "yarn") {
    const at = positional(args, VALUE_FLAGS.npm);
    return args[at] === "add" ? { manager: "npm", args: args.slice(at + 1) } : args[at] === "global" ? sub("npm", ["add"], at + 1) : undefined;
  }
  if (program === "cargo") return sub("cargo", ["install"]);
  if (program === "gem") return sub("gem", ["install"]);
  if (program === "go") return sub("go", ["install"]);
  return undefined;
}

/**
 * The install segments of a command (`bash -c`/`sh -c` followed), each with
 * the packages its arguments name. A segment with a local path, a
 * requirements file, an editable or a target directory is a project install
 * and left out; so is one that names no package (`npm install`, `npm ci`).
 */
export function installsIn(command: string, depth = 0): Install[] {
  const out: Install[] = [];
  for (const segment of splitSegments(command)) {
    const words = programWords(stripRedirects(shellWords(segment.text)));
    const program = posix.basename(words[0] ?? "");
    if (/^(?:ba|z|da|k)?sh$/u.test(program) && depth < 2) {
      const c = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/u.test(word));
      if (c > 0 && words[c + 1] !== undefined) out.push(...installsIn(words[c + 1]!, depth + 1));
      continue;
    }
    const install = installArgs(words);
    if (install === undefined) continue;
    const packages: string[] = [];
    let project = false;
    for (let i = 0; i < install.args.length && !project; i++) {
      const arg = install.args[i]!;
      if (arg.startsWith("-")) {
        const flag = arg.replace(/=.*$/u, "");
        if (PROJECT_FLAGS[install.manager].has(flag)) project = true;
        else if (VALUE_FLAGS[install.manager].has(arg)) i++;
        continue;
      }
      const name = packageName(install.manager, arg);
      if (name === null) project = true;
      else if (name !== undefined && name !== "" && !packages.includes(name)) packages.push(name);
    }
    if (!project && packages.length > 0) out.push({ manager: install.manager, packages });
  }
  return out;
}

/** What an install's output says it installed, by manager (versions dropped). */
function summaryNames(manager: Manager, output: string): string[] {
  const names: string[] = [];
  const add = (name: string | undefined) => {
    if (name !== undefined && name !== "" && !names.includes(name)) names.push(name);
  };
  const versioned = (list: string) => list.trim().split(/\s+/u).forEach((token) => add(/^(.+?)-\d[\w.+!]*$/u.exec(token)?.[1] ?? token));
  if (manager === "pip" || manager === "gem") {
    for (const [, list] of output.matchAll(/Successfully installed ([^\n]+)/gu)) versioned(list!);
  }
  if (manager === "pip") {
    for (const [, name] of output.matchAll(/^\s*\+ ([A-Za-z0-9][\w.-]*)==/gmu)) add(name);
    for (const [, name] of output.matchAll(/^\s*- Installing ([A-Za-z0-9][\w.-]*) \(/gmu)) add(name);
  }
  if (manager === "apt") for (const [, name] of output.matchAll(/^Setting up ([a-z0-9][a-z0-9+.-]*)(?::[a-z0-9]+)? \(/gmu)) add(name);
  if (manager === "cargo") for (const [, name] of output.matchAll(/Installed package `([\w-]+) v/gu)) add(name);
  return names;
}

/** Output that says nothing new was installed (only consulted when no summary names a package). */
const NOTHING_NEW: Partial<Record<Manager, RegExp>> = {
  pip: /Requirement already satisfied|\bAudited \d+ packages?|\bChecked \d+ packages?|is already installed/u,
  apt: /is already the newest version|\b0 newly installed\b/u,
  npm: /\bup to date\b/u,
  cargo: /already installed|binary `[^`]+` already exists/u,
  conda: /All requested packages already installed/u,
};

/**
 * The packages an install put in place: what its output says it installed
 * (the requested ones first), none when the output says they were already
 * there or the command failed without a summary, else the requested ones
 * (quiet installs, npm's "added N packages", go install).
 */
export function installedPackages(install: Install, output: string, exitCode: number | null | undefined): string[] {
  const named = summaryNames(install.manager, output);
  if (named.length > 0) {
    const requested = new Set(install.packages.map(normalizeDist));
    return [...named.filter((name) => requested.has(normalizeDist(name))), ...named.filter((name) => !requested.has(normalizeDist(name)))];
  }
  if (exitCode !== 0) return [];
  if (NOTHING_NEW[install.manager]?.test(output) === true) return [];
  return [...install.packages];
}

/** Distributions whose top-level module is not their name (the fallback when the env cannot list modules). */
const MODULE_NAMES: Record<string, string[]> = {
  "opencv-python": ["cv2"], "opencv-python-headless": ["cv2"], "opencv-contrib-python": ["cv2"], "opencv-contrib-python-headless": ["cv2"], pillow: ["PIL"],
  "scikit-learn": ["sklearn"], "scikit-image": ["skimage"], pyyaml: ["yaml"], beautifulsoup4: ["bs4"], pymupdf: ["fitz"], "python-dateutil": ["dateutil"],
  pycryptodome: ["Crypto"], pycryptodomex: ["Cryptodome"], protobuf: ["google"], "msgpack-python": ["msgpack"], "python-magic": ["magic"], pyserial: ["serial"],
  attrs: ["attr", "attrs"], "typing-extensions": ["typing_extensions"], drake: ["pydrake"], "faiss-cpu": ["faiss"], "faiss-gpu": ["faiss"],
  "python-docx": ["docx"], "python-pptx": ["pptx"], pyjwt: ["jwt"], pyzmq: ["zmq"], "psycopg2-binary": ["psycopg2"], "tensorflow-cpu": ["tensorflow"],
};

/**
 * Whether the grader runs a code file (absolute): the task names it (path or
 * file name), or names a code file in the same directory other than the
 * working directory itself (where runs leave their inspection scripts), so it
 * is the deliverable or a module beside it. A script the run wrote to produce
 * the output files the grader checks is not.
 */
export function gradedCode(task: string, cwd: string): (path: string) => boolean {
  const dirs = new Set<string>();
  for (const [token] of task.matchAll(/[\w./-]*[\w-]\.[A-Za-z0-9]{1,8}\b/gu)) {
    if (isCode(token)) dirs.add(posix.dirname(token.startsWith("/") ? posix.normalize(token) : posix.join(cwd, token)));
  }
  dirs.delete(cwd);
  return (path: string) => mentioned(task, path, cwd) || dirs.has(posix.dirname(path));
}

/** The top-level modules a Python distribution provides, by name (MODULE_NAMES, else the name with dashes as underscores). */
export function modulesOf(dist: string): string[] {
  const key = normalizeDist(dist);
  return MODULE_NAMES[key] ?? [key.replace(/-/gu, "_")];
}

// ---------- files a command writes ----------

/** Redirect targets in a segment's text (`> f`, `>> f`, `2> f`, `&> f`, `>| f`), quotes removed; fd duplications skipped. */
function redirectTargets(text: string): string[] {
  const targets: string[] = [];
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
    if (c !== ">" || text[i - 1] === "<" || text[i + 1] === "(") continue;
    let j = i + 1;
    if (text[j] === ">" || text[j] === "|") j++;
    if (text[j] === "&") continue;
    while (text[j] === " " || text[j] === "\t") j++;
    const open = text[j];
    const target = open === "'" || open === '"' ? text.slice(j + 1, text.indexOf(open, j + 1) === -1 ? text.length : text.indexOf(open, j + 1))
      : /^[^\s;&|<>()]+/u.exec(text.slice(j))?.[0] ?? "";
    if (target !== "") targets.push(target);
    i = j;
  }
  return targets;
}

/**
 * Absolute paths a shell command writes, in order: redirect targets, tee and
 * touch arguments, cp/mv destinations (a destination directory gets the
 * source's name; a single-source destination is listed both ways, the env's
 * `[ -f ]` decides). Relative paths resolve against `cwd`, then against each
 * `cd`/`pushd` the command runs first; after a `cd` the text cannot resolve
 * (`cd`, `cd -`, `cd $X`), relative paths are dropped. Paths with expansions
 * and /dev/* are dropped. Here-doc bodies are not commands; a redirect or tee
 * fed by one (`cat > f.py <<EOF`) carries it as the file's `text`.
 */
export function shellWrites(command: string, cwd: string): { path: string; text?: string }[] {
  const out: { path: string; text?: string }[] = [];
  let base: string | undefined = cwd;
  const resolve = (path: string) => (path.startsWith("/") ? posix.normalize(path) : base === undefined ? undefined : posix.join(base, path));
  const add = (path: string, text?: string) => {
    if (path === "" || path === "-" || /[$`*?{}~]/u.test(path) || path.startsWith("/dev/")) return;
    const resolved = resolve(path);
    if (resolved === undefined) return;
    const known = out.find((write) => write.path === resolved);
    if (known === undefined) out.push({ path: resolved, ...(text === undefined ? {} : { text }) });
    else if (text !== undefined) known.text = text;
  };
  for (const segment of splitSegments(command)) {
    const words = programWords(stripRedirects(shellWords(segment.text)));
    const program = posix.basename(words[0] ?? "");
    const args = words.slice(1);
    const plain = args.filter((arg) => !arg.startsWith("-"));
    if (program === "cd" || program === "pushd") {
      const dir = plain[0];
      base = dir === undefined || /[$`~*]/u.test(dir) ? undefined : resolve(dir);
      continue;
    }
    const body = segment.heredoc === "" ? undefined : segment.heredoc;
    for (const target of redirectTargets(segment.text)) add(target, body);
    if (program === "tee") for (const path of plain) add(path, body);
    if (program === "touch") for (const path of plain) add(path);
    if (program === "cp" || program === "mv") {
      const t = args.findIndex((arg) => arg === "-t" || arg === "--target-directory");
      const into = t >= 0 ? args[t + 1] : args.find((arg) => arg.startsWith("--target-directory="))?.slice("--target-directory=".length);
      const files = plain.filter((arg) => arg !== into);
      if (into !== undefined) {
        for (const source of files) add(posix.join(into, posix.basename(source)));
      } else if (files.length >= 2) {
        const dest = files.at(-1)!;
        const sources = files.slice(0, -1);
        if (sources.length === 1 && !dest.endsWith("/") && dest !== "." && dest !== "..") add(dest);
        for (const source of sources) add(posix.join(dest, posix.basename(source)));
      }
    }
  }
  return out;
}

// ---------- the lever ----------

type Lever = NonNullable<Levers["travel_jit"]>;
type Details = { log?: LedgerEntry[]; exitCode?: number | null; handle?: string; mutated?: boolean };
type Finished = { cmd: string; exitCode: number | null | undefined; output: string };
type Write = { path: string; text?: string };

const MAX_CANDIDATES = 600;
/** Packaging tools: upgrading them is housekeeping, not a dependency. */
const PACKAGING = new Set(["pip", "setuptools", "wheel", "uv", "pipx", "virtualenv"]);
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const listOf = (items: readonly string[], max: number) => `${items.slice(0, max).join(", ")}${items.length > max ? `, and ${items.length - max} more` : ""}`;

export class TravelJit {
  private readonly lever: Lever;
  private readonly kinds: ReadonlySet<JitKind>;
  private readonly placebo: boolean;
  private readonly env: ExecEnv;
  private readonly recorder: Recorder;
  private readonly task: string;
  private readonly taskWords: Set<string>;
  private start: Promise<TravelStart | null> = Promise.resolve(null);
  private startFailed = false;
  /** The project's test layout (tests/, test/, ... and, once the start state is in, the directories that held tests then). */
  private inTestLayout: (path: string) => boolean = testLayout(new Set());
  private readonly graded: (path: string) => boolean;
  private readonly fires = new Map<JitKind, number>();
  /** Commands still running, by exec_command session or bash handle: their install is judged at their exit. */
  private readonly sessions = new Map<number, string>();
  private readonly handles = new Map<string, string>();
  /** packages: Python distributions installed during the run (normalized name -> name and top-level modules). */
  private readonly installed = new Map<string, { name: string; modules: Set<string> }>();
  /** packages: the modules each Python file of the run's (absolute path) gained an import of, in the lines the run added. */
  private readonly imports = new Map<string, Set<string>>();
  /** Packages, scratch files and data reads already noted or suppressed (`kind:key`). */
  private readonly named = new Set<string>();
  /** data notes found after their call returned, for the next tool result. */
  private pending: { text: string; fields: Record<string, unknown> }[] = [];
  /** data checks still running. */
  private readonly inflight = new Set<Promise<void>>();

  constructor(options: { lever: Lever; placebo: boolean; env: ExecEnv; recorder: Recorder; task: string }) {
    this.lever = options.lever;
    this.kinds = new Set(options.lever.kinds);
    this.placebo = options.placebo;
    this.env = options.env;
    this.recorder = options.recorder;
    this.task = options.task;
    this.graded = gradedCode(options.task, options.env.cwd);
    this.taskWords = new Set(options.task.toLowerCase().split(/[^a-z0-9_.-]+/u).map((word) => word.replace(/^[._-]+|[._-]+$/gu, "")).flatMap((word) => [word, normalizeDist(word)]));
  }

  /** The start state (travel.ts readTravelStart, shared with travel_check): marker, scratch-looking paths, package snapshot. */
  begin(start: Promise<TravelStart | null>): void {
    this.start = start;
    void start.then((state) => {
      if (state !== null) this.inTestLayout = testLayout(state.scratch);
    });
  }

  /** A finish attempt: data checks still running are let finish (the trace says what they found), then every waiting note is dropped. */
  async onFinishAttempt(): Promise<void> {
    if (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    for (const note of this.pending) this.recorder.policy("skip", "travel_jit", { ...note.fields, cause: "finished_first" });
    this.pending = [];
  }

  /** The notes this tool result carries: data notes found since the last result, then this result's packages and scratch notes. */
  async afterTool(name: string, args: Record<string, unknown> | undefined, details: Details | undefined, text: string): Promise<string[]> {
    const request = this.recorder.usage.requests;
    const notes: string[] = [];
    const push = (note: string | undefined) => {
      if (note !== undefined) notes.push(note);
    };
    for (const note of this.pending.splice(0)) push(this.deliver("data", note.text, { ...note.fields, tool: name, request }));
    const { finished, written } = this.read(name, args, details, text);
    if (finished.length === 0 && written.length === 0) return notes;
    const start = await this.start;
    if (start === null && !this.startFailed) {
      this.startFailed = true;
      this.recorder.policy("check", "travel_jit_failed", { error: "no start state" });
    }
    // Code of the run's that the grader runs: named by the task or beside a code file it names; not in a system tree, a test layout or under a scratch name.
    const code = written.filter((write) => !inSystemTree(write.path) && isCode(this.shown(write.path)) && !this.inTestLayout(this.shown(write.path)) && this.graded(write.path));
    if (this.kinds.has("packages")) push(await this.packages(finished, code, start, name, request));
    if (start === null) return notes;
    if (this.kinds.has("scratch")) push(await this.scratch(written.map((write) => write.path), start, name, request));
    if (this.kinds.has("data")) {
      for (const write of code) {
        if (write.text === undefined || write.text === "") continue;
        const check = this.data(write.path, write.text, start, name, request);
        this.inflight.add(check);
        void check.finally(() => this.inflight.delete(check));
      }
    }
    return notes;
  }

  /** The commands this result finished and the files it wrote (absolute), with the text each write added when known. */
  private read(name: string, args: Record<string, unknown> | undefined, details: Details | undefined, text: string): { finished: Finished[]; written: Write[] } {
    const finished: Finished[] = [];
    const written: Write[] = [];
    const cwd = this.env.cwd;
    if (details?.log !== undefined) {
      for (const entry of details.log) {
        if (entry.kind === "mutate") {
          for (const file of entry.files ?? []) written.push({ path: file.path, text: file.added });
        } else if (entry.kind === "command") {
          written.push(...shellWrites(entry.cmd, entry.workdir === undefined ? cwd : posix.resolve(cwd, entry.workdir)));
          if (entry.session !== undefined) this.sessions.set(entry.session, entry.cmd);
          else finished.push({ cmd: entry.cmd, exitCode: entry.exitCode, output: entry.output });
        } else if (entry.exitCode !== undefined) {
          const cmd = this.sessions.get(entry.session);
          this.sessions.delete(entry.session);
          if (cmd !== undefined) finished.push({ cmd, exitCode: entry.exitCode, output: entry.output });
        }
      }
    } else if (name === "bash" && typeof args?.command === "string") {
      written.push(...shellWrites(args.command, cwd));
      if (details?.handle !== undefined) this.handles.set(details.handle, args.command);
      else finished.push({ cmd: args.command, exitCode: details?.exitCode, output: text });
    } else if (name === "wait" && typeof args?.handle === "string" && details?.handle === undefined) {
      const cmd = this.handles.get(args.handle);
      this.handles.delete(args.handle);
      if (cmd !== undefined && args.kill !== true) finished.push({ cmd, exitCode: details?.exitCode, output: text });
    } else if (name === "write" && details?.mutated === true && typeof args?.path === "string") {
      written.push({ path: this.env.resolvePath(args.path), ...(typeof args.content === "string" ? { text: args.content } : {}) });
    } else if (name === "edit" && details?.mutated === true && typeof args?.path === "string") {
      const edits = Array.isArray(args.edits) ? args.edits as { oldText?: unknown; newText?: unknown }[] : [];
      const added = edits.map((edit) => addedText(typeof edit.oldText === "string" ? edit.oldText : "", typeof edit.newText === "string" ? edit.newText : "")).join("\n");
      written.push({ path: this.env.resolvePath(args.path), text: added });
    }
    const byPath = new Map<string, Write>();
    for (const write of written) {
      const known = byPath.get(write.path);
      byPath.set(write.path, known === undefined ? write : { path: write.path, ...(known.text === undefined && write.text === undefined ? {} : { text: [known.text, write.text].filter((part) => part !== undefined).join("\n") }) });
    }
    return { finished, written: [...byPath.values()] };
  }

  /**
   * packages: record this result's installs (silently), then note a session package that a Python file of the
   * run's gained an import of: in this result's writes, or (an install after the import) in any earlier one.
   */
  private async packages(finished: Finished[], code: Write[], start: TravelStart | null, tool: string, request: number): Promise<string | undefined> {
    const fresh: string[] = [];
    for (const run of finished) {
      for (const install of installsIn(run.cmd)) {
        const names = installedPackages(install, run.output, run.exitCode);
        if (names.length === 0) continue;
        const asked = install.packages.filter((name) => this.taskWords.has(normalizeDist(name)) || this.taskWords.has(name.toLowerCase()));
        if (asked.length > 0) {
          if (!this.named.has(`task:${asked.join(",")}`)) this.recorder.policy("skip", "travel_jit", { kind: "packages", cause: "task_named", packages: asked, tool, request });
          this.named.add(`task:${asked.join(",")}`);
          continue;
        }
        const pythonNames = install.manager === "pip" || install.manager === "conda" ? names
          : install.manager === "apt" ? names.filter((name) => name.startsWith("python3-")).map((name) => name.slice("python3-".length)) : [];
        for (const name of pythonNames) {
          const key = normalizeDist(name);
          if (PACKAGING.has(key) || start?.packages.has(key) === true || this.installed.has(key)) continue;
          this.installed.set(key, { name, modules: new Set(modulesOf(name)) });
          fresh.push(name);
        }
      }
    }
    if (fresh.length > 0 && start !== null && start.packages.size > 0) await this.rereadPackages(start, fresh);
    if (fresh.length > 0) this.recorder.policy("check", "travel_jit", { kind: "install", packages: fresh.slice(0, 12), tool, request });
    for (const write of code) {
      if (!/\.pyw?$/iu.test(write.path) || write.text === undefined) continue;
      const modules = pythonImports(write.text);
      if (modules.size === 0) continue;
      const known = this.imports.get(write.path) ?? new Set<string>();
      for (const module of modules) known.add(module);
      this.imports.set(write.path, known);
    }
    // A session package a file of the run's imports, not yet noted: files this result wrote first.
    const order = [...code.map((write) => write.path).filter((path) => this.imports.has(path)), ...[...this.imports.keys()].filter((path) => !code.some((write) => write.path === path))];
    for (const file of order) {
      const modules = this.imports.get(file)!;
      const hits = [...this.installed].filter(([key, dist]) => !this.named.has(`packages:${key}`) && [...dist.modules].some((module) => modules.has(module)));
      if (hits.length === 0) continue;
      for (const [key] of hits) this.named.add(`packages:${key}`);
      const shown = hits.map(([key, dist]) => {
        const used = [...dist.modules].filter((module) => modules.has(module));
        return used.length === 1 && normalizeDist(used[0]!) === key ? dist.name : `${used.join(", ")} (package ${dist.name})`;
      });
      const via = code.some((write) => write.path === file) ? "write" : "install";
      return this.deliver("packages", this.lever.text_packages.replaceAll("{file}", this.shown(file)).replaceAll("{packages}", listOf(shown, 4)), {
        file: this.shown(file), packages: hits.map(([, dist]) => dist.name), via, tool, request,
      });
    }
    return undefined;
  }

  /** The distributions now: every non-local one the start lacked joins the session's packages with its top-level modules. */
  private async rereadPackages(start: TravelStart, fresh: string[]): Promise<void> {
    try {
      const run = await this.env.exec(`${PACKAGES_COMMAND}; exit 0`, { timeoutMs: 60_000, internal: true });
      for (const [key, dist] of parsePackages(run.output)) {
        if (start.packages.has(key) || dist.local || PACKAGING.has(key) || this.taskWords.has(key) || dist.modules.some((module) => this.taskWords.has(module.toLowerCase()))) continue;
        const known = this.installed.get(key);
        if (known === undefined) {
          this.installed.set(key, { name: dist.name, modules: new Set(dist.modules.length > 0 ? dist.modules : modulesOf(dist.name)) });
          fresh.push(dist.name);
        } else {
          for (const module of dist.modules) known.modules.add(module);
        }
      }
    } catch {
      // the name table stands in
    }
  }

  /** scratch: test or scratch scripts this result wrote in the project tree, outside its test layout, confirmed to exist, one note. */
  private async scratch(written: string[], start: TravelStart, tool: string, request: number): Promise<string | undefined> {
    const cwd = this.env.cwd;
    const inTree = written.filter((path) => path.startsWith(`${cwd}/`)).map((path) => path.slice(cwd.length + 1))
      .filter((path) => codeExtension(path) && !this.inTestLayout(path));
    const found = scratchFindings(inTree, start.scratch, this.task).filter((path) => !this.named.has(`scratch:${path}`));
    if (found.length === 0) return undefined;
    if ((this.fires.get("scratch") ?? 0) >= this.lever.max_per_kind) {
      for (const path of found) this.named.add(`scratch:${path}`);
      this.recorder.policy("skip", "travel_jit", { kind: "scratch", cause: "max", files: found.slice(0, 10), tool, request });
      return undefined;
    }
    let files: string[] = [];
    try {
      const run = await this.env.exec(`for p in ${found.map((path) => shellQuote(`${cwd}/${path}`)).join(" ")}; do [ -f "$p" ] && printf '%s\\0' "$p"; done; exit 0`,
        { timeoutMs: 15_000, internal: true });
      files = run.output.split("\0").filter((path) => path.startsWith(`${cwd}/`)).map((path) => path.slice(cwd.length + 1));
    } catch {
      return undefined;
    }
    if (files.length === 0) return undefined;
    for (const path of files) this.named.add(`scratch:${path}`);
    return this.deliver("scratch", this.lever.text_scratch.replaceAll("{files}", listOf(files, 5)), { files: files.slice(0, 10), kinds: [...new Set(files.map(scratchKind))], tool, request });
  }

  /** data: the lines a write added to a code file name pre-existing files; the note waits for the next tool result. */
  private async data(file: string, added: string, start: TravelStart, tool: string, request: number): Promise<void> {
    if ((this.fires.get("data") ?? 0) >= this.lever.max_per_kind) return;
    try {
      const cwd = this.env.cwd;
      // /opt holds installed software (conda, toolboxes): part of the image, not data.
      const candidates = fileCandidates(added, file, cwd).filter((path) => path !== file && !path.startsWith("/opt/") && !mentioned(this.task, path, cwd) && !this.named.has(`data:${file}\0${path}`))
        .sort().slice(0, MAX_CANDIDATES);
      if (candidates.length === 0) return;
      const reads = await preexisting(this.env, start.marker, candidates);
      if (reads.length === 0) return;
      for (const path of reads) this.named.add(`data:${file}\0${path}`);
      const fields = { kind: "data", file: this.shown(file), reads: reads.slice(0, 5), written_tool: tool, written_request: request };
      this.pending.push({ text: this.lever.text_data.replaceAll("{file}", this.shown(file)).replaceAll("{reads}", listOf(reads, 3)), fields });
    } catch {
      // An env that could not say: nothing to note.
    }
  }

  /** A fire, or a skip once the kind has fired max_per_kind times; the placebo keeps the trigger and sends neutral text. */
  private deliver(kind: JitKind, text: string, fields: Record<string, unknown>): string | undefined {
    const n = this.fires.get(kind) ?? 0;
    if (n >= this.lever.max_per_kind) {
      this.recorder.policy("skip", "travel_jit", { kind, cause: "max", ...fields });
      return undefined;
    }
    this.fires.set(kind, n + 1);
    this.recorder.policy("remind", "travel_jit", { kind, n: n + 1, ...fields, placebo: this.placebo });
    return this.placebo ? placeboFor(`travel_jit_${kind}`, text) : text;
  }

  /** A path as the note names it: relative under the cwd, else absolute. */
  private shown(path: string): string {
    return path.startsWith(`${this.env.cwd}/`) ? path.slice(this.env.cwd.length + 1) : path;
  }
}

/** The lines of an edit's new text that its old text did not have. */
function addedText(oldText: string, newText: string): string {
  const old = new Set(oldText.split("\n"));
  return newText.split("\n").filter((line) => !old.has(line)).join("\n");
}
