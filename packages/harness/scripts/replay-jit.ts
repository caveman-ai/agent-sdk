/**
 * Offline replay of policy.travel_jit over recorded TB4 trials (read-only: it
 * opens files under the runs dir and never writes there; holdout tasks are
 * skipped before their trial dirs are opened).
 *
 *   node --experimental-strip-types --no-warnings scripts/replay-jit.ts <runs-dir> [--runs <regex>] [--holdout <file>] [--tasks <tb4 tasks dir>] [--out <md>] [--list]
 *
 * It walks each exec-family transcript up to its first final and runs the
 * lever's own rules (src/travel-jit.ts installsIn, installedPackages,
 * shellWrites; src/travel.ts scratchFindings, fileCandidates, isCode) on the
 * nested calls of each cell, read from the cell's JavaScript (exec_command
 * `cmd`/`workdir` and apply_patch string literals, or a variable assigned
 * one). What a transcript cannot say is approximated:
 * - a command's output and exit: the exec_command records the cell printed
 *   (`output`, `exit_code`); a cell with a non-zero exit_code or a tool error
 *   counts as failed for its commands, so an install there needs its output's
 *   summary; an install that yielded is judged in its own cell (early);
 * - the start snapshot (packages): unknown, so a quiet install of a package
 *   the image already had still fires (an upper bound);
 * - present at the start (scratch) and pre-existing (data): the TB4 task's
 *   environment/ files (by path suffix), or a path (or a name in a printed
 *   directory) that a tool result printed before the write, and not written
 *   by the run earlier; existence is assumed unless the same cell removes it;
 * - data reads Update File bodies as their added lines only.
 * max_per_kind 1: the first fire per kind counts; later triggers are counted
 * as suppressed.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { gradedCode, installedPackages, installsIn, modulesOf, shellWrites } from "../src/travel-jit.ts";
import { codeExtension, fileCandidates, inSystemTree, isCode, mentioned, normalizeDist, pythonImports, scratchFindings, scratchKind, testLayout } from "../src/travel.ts";

const args = process.argv.slice(2);
const runsDir = args[0];
if (runsDir === undefined) throw new Error("usage: replay-jit.ts <runs-dir> [--runs <regex>] [--holdout <file>] [--tasks <dir>] [--out <md>] [--list]");
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const runPattern = new RegExp(flag("--runs") ?? "^r[3-6][a-z]*-tb4$", "u");
const holdoutPath = flag("--holdout");
const tasksDir = flag("--tasks") ?? process.env.HARNESS_TB4_TASKS ?? "";
const outPath = flag("--out");
const listAll = args.includes("--list");
const holdout = new Set(holdoutPath === undefined ? [] : readFileSync(holdoutPath, "utf8").split("\n").map((line) => line.trim()).filter((line) => line !== ""));

type Row = { type: string; text?: string; tools?: { name: string }[]; tool_calls?: { id: string; name: string; input: unknown }[]; is_error?: boolean; content?: unknown };
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : "")).join("\n") : "";

// ---------- the cell's JavaScript ----------

/** The JS string literal at `at` (", ' or `), unescaped, and where it ends; `${...}` in a template is kept as written. */
function literalAt(code: string, at: number): { value: string; end: number } | undefined {
  const quote = code[at];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return undefined;
  let value = "";
  let i = at + 1;
  for (; i < code.length; i++) {
    const c = code[i]!;
    if (c === quote) return { value, end: i + 1 };
    if (c !== "\\") {
      value += c;
      continue;
    }
    const n = code[++i];
    if (n === "n") value += "\n";
    else if (n === "t") value += "\t";
    else if (n === "r") value += "\r";
    else if (n === "0") value += "\0";
    else if (n === "u") {
      const braced = /^\{([0-9a-fA-F]+)\}/u.exec(code.slice(i + 1));
      const hex = braced?.[1] ?? code.slice(i + 1, i + 5);
      value += String.fromCodePoint(Number.parseInt(hex, 16) || 0x3f);
      i += braced === null ? 4 : braced[0].length;
    } else if (n === "x") {
      value += String.fromCharCode(Number.parseInt(code.slice(i + 1, i + 3), 16) || 0x3f);
      i += 2;
    } else if (n === "\n") {
      // a line continuation
    } else if (n !== undefined) value += n;
  }
  return undefined;
}

/** The literal an argument expression names: a literal, `String.raw` template, or an identifier assigned one earlier in the cell. */
function resolveArg(code: string, at: number): string | undefined {
  while (/\s/u.test(code[at] ?? "")) at++;
  if (code.startsWith("String.raw", at)) at += "String.raw".length;
  const literal = literalAt(code, at);
  if (literal !== undefined) return literal.value;
  const name = /^[A-Za-z_$][\w$]*/u.exec(code.slice(at))?.[0];
  if (name === undefined) return undefined;
  let found: string | undefined;
  for (const match of code.slice(0, at).matchAll(new RegExp(`(?:\\b|^)${name.replace(/\$/gu, "\\$")}\\s*=\\s*(?=["'\`]|String\\.raw)`, "gu"))) {
    const value = resolveArg(code, match.index + match[0].length);
    if (value !== undefined) found = value;
  }
  return found;
}

type Nested = { tool: "exec_command"; cmd: string; workdir?: string } | { tool: "apply_patch"; patch: string };

/** The cell's exec_command and apply_patch calls in source order (a loop's body counts once). */
function nestedCalls(code: string): Nested[] {
  const calls: Nested[] = [];
  for (const match of code.matchAll(/tools\s*\.\s*(exec_command|apply_patch)\s*\(\s*/gu)) {
    const at = match.index + match[0].length;
    if (match[1] === "apply_patch") {
      const patch = resolveArg(code, at);
      if (patch !== undefined) calls.push({ tool: "apply_patch", patch });
      continue;
    }
    if (code[at] !== "{") {
      const cmd = resolveArg(code, at);
      if (cmd !== undefined) calls.push({ tool: "exec_command", cmd });
      continue;
    }
    const next = code.indexOf("tools.", at);
    const body = code.slice(at, next === -1 ? code.length : next);
    const field = (key: string) => {
      const found = new RegExp(`["']?${key}["']?\\s*:\\s*`, "u").exec(body);
      if (found !== null) return resolveArg(code, at + found.index + found[0].length);
      // `{ cmd }` shorthand: the variable assigned earlier
      return new RegExp(`[{,]\\s*${key}\\s*[,}]`, "u").test(body) ? resolveArg(code.slice(0, at) + key, at) : undefined;
    };
    const cmd = field("cmd");
    if (cmd === undefined) continue;
    const workdir = field("workdir");
    calls.push({ tool: "exec_command", cmd, ...(workdir === undefined ? {} : { workdir }) });
  }
  return calls;
}

/** A patch's hunks: path, verb, and the lines it adds (Add: the body; Update: `+` lines that are not also `-` lines, the ledger's added lines as near as a patch shows them). */
function patchHunks(patch: string): { path: string; verb: "Add" | "Update" | "Delete"; text: string }[] {
  const out: { path: string; verb: "Add" | "Update" | "Delete"; text: string }[] = [];
  for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File:\s*(.+?)\s*\n([\s\S]*?)(?=^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch|$(?![\s\S]))/gmu)) {
    const move = /^\*\*\* Move to:\s*(.+?)\s*$/mu.exec(match[3]!);
    const lines = match[3]!.split("\n");
    const removed = new Set(lines.filter((line) => line.startsWith("-")).map((line) => line.slice(1)));
    const text = lines.filter((line) => line.startsWith("+") && !removed.has(line.slice(1))).map((line) => line.slice(1)).join("\n");
    out.push({ path: move?.[1] ?? match[2]!, verb: match[1] as "Add" | "Update" | "Delete", text });
  }
  return out;
}

/** The exec_command records a cell's result printed: outputs (unescaped) and exit codes. */
function records(text: string): { outputs: string; exits: number[] } {
  const outputs: string[] = [];
  for (const [, body] of text.matchAll(/"output":"((?:[^"\\]|\\.)*)"/gu)) {
    try {
      outputs.push(JSON.parse(`"${body}"`) as string);
    } catch {
      // a record cut by the cell's own truncation
    }
  }
  const exits = [...text.matchAll(/"exit_code":(-?\d+)/gu)].map((match) => Number(match[1]));
  return { outputs: `${outputs.join("\n")}\n${crude(text)}`, exits };
}

// ---------- one trial ----------

/**
 * The shipped kinds, and shadows for comparison: the first packages rule (a note at the install), packages and data on any
 * code of the run's (not only code the grader runs), and scratch before narrowing (logs, backups, test layouts).
 */
type Kind = "packages" | "scratch" | "data" | "packages_at_install" | "packages_any" | "data_any" | "scratch_wide";
const KINDS: readonly Kind[] = ["packages", "scratch", "data", "packages_at_install", "packages_any", "data_any", "scratch_wide"];
interface Fire { kind: Kind; request: number; items: string[]; extra?: string }
interface Trial {
  run: string; arm: string; task: string; trial: number; pass: boolean;
  requests: number; fires: Fire[]; suppressed: Record<Kind, number>; installsSeen: string[]; dropped: number; casadiImported: boolean;
}

function trialDirOf(job: string): string | undefined {
  if (!existsSync(job)) return undefined;
  const sub = readdirSync(job).find((name) => name.includes("__") && statSync(join(job, name)).isDirectory());
  return sub === undefined ? undefined : join(job, sub);
}

function walk(dir: string, prefix: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, `${prefix}${name}/`, visit);
    else visit(`${prefix}${name}`);
  }
}

const TOKEN = /[\w@+./-]*[\w@+-]\.[A-Za-z0-9]{1,8}\b|[\w@+.-]+(?:\/[\w@+.-]+)+\/?/gu;
const crude = (text: string) => text.replace(/\\n/gu, "\n").replace(/\\t/gu, "\t").replace(/\\"/gu, "\"").replace(/\\\\/gu, "\\");

function replayTrial(trialDir: string, meta: { run: string; arm: string; task: string; trial: number; pass: boolean }): Trial | undefined {
  const transcriptPath = join(trialDir, "agent", "transcript.jsonl");
  if (!existsSync(transcriptPath)) return undefined;
  const rows = readFileSync(transcriptPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Row);
  if (!(rows.find((row) => row.type === "system")?.tools ?? []).some((tool) => tool.name === "exec")) return undefined;
  const argv = JSON.parse(readFileSync(join(trialDir, "agent", "argv.json"), "utf8")) as { cwd?: string };
  const cwd = argv.cwd ?? "/app";
  const instructionPath = join(trialDir, "agent", "instruction.txt");
  const task = existsSync(instructionPath) ? readFileSync(instructionPath, "utf8") : textOf(rows.find((row) => row.type === "user")?.content);
  const taskWords = new Set(task.toLowerCase().split(/[^a-z0-9_.-]+/u).map((word) => word.replace(/^[._-]+|[._-]+$/gu, "")).flatMap((word) => [word, normalizeDist(word)]));
  const envFiles: string[] = [];
  walk(join(tasksDir, meta.task, "environment"), "", (path) => envFiles.push(path));
  const rel = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
  const inEnv = (path: string) => path.startsWith(`${cwd}/`) && envFiles.some((file) => file === rel(path) || file.endsWith(`/${rel(path)}`));
  const abs = (path: string, base = cwd) => posix.normalize(path.startsWith("/") ? path : posix.join(base, path));

  const out: Trial = {
    ...meta, requests: 0, fires: [], suppressed: { packages: 0, scratch: 0, data: 0, packages_at_install: 0, packages_any: 0, data_any: 0, scratch_wide: 0 },
    installsSeen: [], dropped: 0, casadiImported: false,
  };
  const session = new Map<string, { name: string; modules: Set<string> }>(); // packages installed during the run
  const imports = new Map<string, Set<string>>(); // deliverable .py files -> modules the run's lines import
  const fired = new Set<Kind>();
  const seen = new Set<string>(); // printed paths and names so far
  const printedDirs = new Set<string>();
  const written = new Set<string>(); // abs paths the run wrote so far
  const named = new Set<string>();
  let pendingData: Fire | undefined;
  let pendingAny: Fire | undefined;
  const graded = gradedCode(task, cwd);
  const fire = (kind: Kind, request: number, items: string[], extra?: string) => {
    if (fired.has(kind)) {
      out.suppressed[kind]++;
      return;
    }
    fired.add(kind);
    out.fires.push({ kind, request, items, ...(extra === undefined ? {} : { extra }) });
  };
  const results = new Map<string, Row>();
  for (const row of rows) if (row.type === "tool_result" && typeof (row as { id?: string }).id === "string") results.set((row as { id: string }).id, row);

  let request = 0;
  for (const row of rows) {
    if (row.type === "tool_result") {
      const text = crude(textOf(row.content));
      for (const [token] of text.matchAll(TOKEN)) {
        const clean = token.replace(/^\.\//u, "").replace(/\/$/u, "");
        seen.add(clean);
        seen.add(posix.basename(clean));
        if (clean.includes("/")) {
          printedDirs.add(abs(posix.dirname(clean)));
          if (token.endsWith("/")) printedDirs.add(abs(clean));
        }
      }
      continue;
    }
    if (row.type !== "assistant") continue;
    request++;
    const calls = row.tool_calls ?? [];
    if (calls.length === 0 && (row.text ?? "") !== "") break; // the first final
    // A data note found after the previous cell rides on this request's first tool result.
    if (pendingData !== undefined && calls.length > 0) {
      fire("data", request, pendingData.items, pendingData.extra);
      pendingData = undefined;
    }
    if (pendingAny !== undefined && calls.length > 0) {
      fire("data_any", request, pendingAny.items, pendingAny.extra);
      pendingAny = undefined;
    }
    const startSeen = new Set(seen);
    const startDirs = new Set(printedDirs);
    const present = (path: string) => inEnv(path) || startSeen.has(rel(path)) || startSeen.has(path) ||
      (startSeen.has(posix.basename(path)) && /\.[A-Za-z0-9]{1,8}$/u.test(path) && startDirs.has(posix.dirname(path)) && posix.dirname(path) !== cwd);
    for (const call of calls) {
      if (call.name !== "exec") continue;
      const code = typeof (call.input as { input?: unknown })?.input === "string" ? (call.input as { input: string }).input : "";
      const result = results.get(call.id);
      const { outputs, exits } = records(textOf(result?.content));
      const failed = result?.is_error === true || exits.some((code) => code !== 0);
      const cellWrites: { path: string; text?: string }[] = [];
      const removed = new Set<string>();
      const fresh: string[] = [];
      for (const nested of nestedCalls(code)) {
        if (nested.tool === "apply_patch") {
          for (const hunk of patchHunks(nested.patch)) {
            const path = abs(hunk.path);
            if (hunk.verb === "Delete") {
              removed.add(path);
            } else {
              removed.delete(path); // Delete File then Add File of one path: rewritten
              cellWrites.push({ path, text: hunk.text });
            }
          }
          continue;
        }
        const base = nested.workdir === undefined ? cwd : abs(nested.workdir);
        cellWrites.push(...shellWrites(nested.cmd, base));
        for (const [, list] of nested.cmd.matchAll(/(?:^|[;&|]\s*)rm\s+(?:-\S+\s+)*([^;&|\n]+)/gmu)) for (const path of list!.trim().split(/\s+/u)) removed.add(abs(path, base));
        for (const install of installsIn(nested.cmd)) {
          out.installsSeen.push(...install.packages);
          const names = installedPackages(install, outputs, failed ? 1 : 0);
          if (names.length === 0) continue;
          if (install.packages.some((name) => taskWords.has(normalizeDist(name)) || taskWords.has(name.toLowerCase()))) continue;
          const kept = names.filter((name) => !["pip", "setuptools", "wheel", "uv", "pipx", "virtualenv"].includes(normalizeDist(name)) && !named.has(`p:${normalizeDist(name)}`));
          for (const name of kept) named.add(`p:${normalizeDist(name)}`);
          if (kept.length > 0) fire("packages_at_install", request, kept);
          const python = install.manager === "pip" || install.manager === "conda" ? kept
            : install.manager === "apt" ? kept.filter((name) => name.startsWith("python3-")).map((name) => name.slice("python3-".length)) : [];
          for (const name of python) {
            if (session.has(normalizeDist(name))) continue;
            session.set(normalizeDist(name), { name, modules: new Set(modulesOf(name)) });
            fresh.push(name);
          }
        }
      }
      const startPaths = new Set([...envFiles, ...envFiles.map((file) => file.replace(/^[^/]+\//u, "")), ...[...startSeen].filter((token) => token.includes("/")).map((token) => rel(abs(token)))]);
      const layout = testLayout(startPaths);
      const deliverable = (path: string) => !inSystemTree(path) && isCode(rel(path)) && !layout(rel(path));
      // packages: imports the run's lines add to deliverable Python files; a session package one of them imports (this cell's files first).
      for (const write of cellWrites) {
        if (write.text === undefined || removed.has(write.path) || !/\.pyw?$/iu.test(write.path) || !deliverable(write.path)) continue;
        const modules = pythonImports(write.text);
        if (modules.has("casadi")) out.casadiImported = true;
        if (modules.size > 0) imports.set(write.path, new Set([...(imports.get(write.path) ?? []), ...modules]));
      }
      const order = [...new Set([...cellWrites.map((write) => write.path).filter((path) => imports.has(path)), ...imports.keys()])];
      for (const [kind, scope] of [["packages", graded], ["packages_any", () => true]] as const) {
        for (const file of order.filter(scope)) {
          const modules = imports.get(file)!;
          const hits = [...session].filter(([key, dist]) => !named.has(`${kind}:${key}`) && [...dist.modules].some((module) => modules.has(module)));
          if (hits.length === 0) continue;
          for (const [key] of hits) named.add(`${kind}:${key}`);
          fire(kind, request, hits.map(([, dist]) => dist.name), `${rel(file)} via ${cellWrites.some((write) => write.path === file) ? "write" : "install"}`);
          break;
        }
      }
      // scratch: this cell's writes in the tree, not present before, kept by the lever's own rule (shipped: no logs or backups, never in a test layout).
      const inTree = cellWrites.map((write) => write.path).filter((path) => path.startsWith(`${cwd}/`) && !removed.has(path) && !written.has(path) && !present(path)).map(rel);
      const wide = scratchFindings([...new Set(inTree)], startPaths, task).filter((path) => !named.has(`sw:${path}`));
      for (const path of wide) named.add(`sw:${path}`);
      if (wide.length > 0) fire("scratch_wide", request, wide, wide.map((path) => scratchKind(path) === "test" ? "test" : /\.log$/iu.test(path) ? "log" : "other").join(","));
      const scratch = wide.filter((path) => codeExtension(path) && !layout(path)).filter((path) => !named.has(`s:${path}`));
      for (const path of scratch) named.add(`s:${path}`);
      if (scratch.length > 0) fire("scratch", request, scratch, scratch.map((path) => scratchKind(path) === "test" ? "test" : "other").join(","));
      // data: the lines this cell added to deliverable code files name a file that was there before and not written by the run.
      for (const write of cellWrites) {
        if (write.text === undefined || removed.has(write.path) || !deliverable(write.path)) continue;
        const reads = fileCandidates(write.text, write.path, cwd)
          .filter((path) => path !== write.path && !path.startsWith("/opt/") && !mentioned(task, path, cwd) && !written.has(path) && !cellWrites.some((other) => other.path === path) && present(path))
          .filter((path) => !named.has(`d:${write.path}\0${path}`));
        const kept = reads.filter((path) => posix.dirname(path) !== cwd || !reads.some((other) => other !== path && posix.basename(other) === posix.basename(path)));
        for (const path of kept) named.add(`d:${write.path}\0${path}`);
        if (kept.length > 0 && pendingAny === undefined) pendingAny = { kind: "data_any", request: 0, items: kept.sort(), extra: rel(write.path) };
        if (kept.length > 0 && pendingData === undefined && graded(write.path)) pendingData = { kind: "data", request: 0, items: kept.sort(), extra: rel(write.path) };
      }
      for (const write of cellWrites) if (!removed.has(write.path)) written.add(write.path);
    }
  }
  if (pendingData !== undefined) out.dropped++;
  out.requests = request;
  return out;
}

// ---------- the runs ----------

const trials: Trial[] = [];
for (const run of readdirSync(runsDir).sort()) {
  if (!runPattern.test(run)) continue;
  const trialsPath = join(runsDir, run, "trials.jsonl");
  if (!existsSync(trialsPath)) continue;
  const rows = new Map<string, Record<string, any>>();
  for (const line of readFileSync(trialsPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as Record<string, any>;
    rows.set(`${row.arm}\u0000${row.task}\u0000${row.trial}`, row);
  }
  for (const row of rows.values()) {
    if (holdout.has(row.task)) continue; // never opened
    if (row.outcome !== "solved" && row.outcome !== "failed") continue;
    const trialDir = typeof row.job === "string" ? trialDirOf(row.job) : undefined;
    if (trialDir === undefined) continue;
    const trial = replayTrial(trialDir, { run, arm: row.arm, task: row.task, trial: row.trial, pass: (row.reward ?? 0) >= 1 });
    if (trial !== undefined) trials.push(trial);
  }
}

const lines: string[] = [];
const say = (line = "") => lines.push(line);
const pct = (a: number, b: number) => (b === 0 ? "-" : `${Math.round((100 * a) / b)}%`);
const median = (values: number[]) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const passing = trials.filter((trial) => trial.pass);
const failing = trials.filter((trial) => !trial.pass);
const runs = [...new Set(trials.map((trial) => trial.run))];
say(`# travel_jit offline replay (${new Date().toISOString().slice(0, 10)})`);
say();
say(`Runs ${runs.join(", ")} (exec family, TB4 DEV; ${holdout.size} holdout tasks skipped before their trials were opened): ${trials.length} trials, ` +
  `${passing.length} pass, ${failing.length} fail, ${new Set(trials.map((trial) => trial.task)).size} tasks. Up to each trial's first final; max_per_kind 1.`);
say();
say("Method: the lever's own rules (src/travel-jit.ts, src/travel.ts) on each exec cell's nested exec_command/apply_patch calls. \"request\" is the " +
  "request whose tool result carries the note (the next request reads it); data notes ride on the next cell. Approximations: no package snapshot " +
  "(a quiet install of a package the image had counts as new), the start listing is the task's environment/ files plus paths printed earlier, " +
  "existence is assumed unless the cell removes the file, an Update hunk's added lines are its + lines that are not also - lines. " +
  "Shadows are counted on their own (each with max one per run) to show what each narrowing removed.");
say();
say("| kind | trials fired | pass trials fired | fail trials fired | pass rate fired vs not | suppressed later triggers | median request of the note (of total) | median position |");
say("|---|---|---|---|---|---|---|---|");
const LABEL: Record<Kind, string> = {
  packages: "packages (shipped: graded code imports a session package)", scratch: "scratch (shipped: scripts only, never in a test layout)",
  data: "data (shipped: graded code reads a pre-existing file)", packages_at_install: "(shadow) packages at the install, the first rule",
  packages_any: "(shadow) packages, any code of the run's", data_any: "(shadow) data, any code of the run's", scratch_wide: "(shadow) scratch before narrowing",
};
for (const kind of KINDS) {
  const firedOn = (trial: Trial) => trial.fires.some((fire) => fire.kind === kind);
  const yes = trials.filter(firedOn);
  const no = trials.filter((trial) => !firedOn(trial));
  const at = yes.map((trial) => trial.fires.find((fire) => fire.kind === kind)!.request);
  const totals = yes.map((trial) => trial.requests);
  const positions = yes.map((trial) => trial.fires.find((fire) => fire.kind === kind)!.request / Math.max(1, trial.requests));
  say(`| ${LABEL[kind]} | ${yes.length}/${trials.length} (${pct(yes.length, trials.length)}) | ${passing.filter(firedOn).length}/${passing.length} (${pct(passing.filter(firedOn).length, passing.length)}) | ` +
    `${failing.filter(firedOn).length}/${failing.length} (${pct(failing.filter(firedOn).length, failing.length)}) | ${pct(yes.filter((trial) => trial.pass).length, yes.length)} vs ${pct(no.filter((trial) => trial.pass).length, no.length)} | ` +
    `${trials.reduce((sum, trial) => sum + trial.suppressed[kind], 0)} | ${median(at)} of ${median(totals)} | ${Number.isNaN(median(positions)) ? "-" : `${Math.round(100 * median(positions))}%`} |`);
}
say();
const dropped = trials.reduce((sum, trial) => sum + trial.dropped, 0);
say(`data notes dropped because the first final came before another tool call: ${dropped}.`);
say();
for (const kind of ["scratch_wide", "scratch"] as const) {
  const counts = new Map<string, number>();
  for (const trial of trials) for (const fire of trial.fires.filter((fire) => fire.kind === kind)) for (const name of (fire.extra ?? "").split(",")) counts.set(name, (counts.get(name) ?? 0) + 1);
  say(`${kind} fires by the first fire's files: ${[...counts].map(([name, count]) => `${name} ${count}`).join(", ")}.`);
}
say();
say("## biped-contact-dynamics (casadi)");
say();
say("| trial | pass | requests | casadi installed by a command | casadi imported by a deliverable | packages note (request: names, file) |");
say("|---|---|---|---|---|---|");
for (const trial of trials.filter((trial) => trial.task === "biped-contact-dynamics")) {
  const note = trial.fires.find((fire) => fire.kind === "packages");
  say(`| ${trial.run}/${trial.arm}/${trial.trial} | ${trial.pass ? "yes" : "no"} | ${trial.requests} | ${trial.installsSeen.some((name) => normalizeDist(name) === "casadi") ? "yes" : "no"} | ` +
    `${trial.casadiImported ? "yes" : "no"} | ${note === undefined ? "-" : `${note.request}: ${note.items.slice(0, 6).join(", ")} (${note.extra})`} |`);
}
say();
say("## By task (trials fired / trials; pass rate fired vs not)");
say();
say("| task | trials | packages | scratch | data |");
say("|---|---|---|---|---|");
for (const task of [...new Set(trials.map((trial) => trial.task))].sort()) {
  const pool = trials.filter((trial) => trial.task === task);
  const cellFor = (kind: Kind) => {
    const yes = pool.filter((trial) => trial.fires.some((fire) => fire.kind === kind));
    if (yes.length === 0) return "0";
    const no = pool.filter((trial) => !yes.includes(trial));
    return `${yes.length} (${pct(yes.filter((trial) => trial.pass).length, yes.length)} vs ${pct(no.filter((trial) => trial.pass).length, no.length)})`;
  };
  say(`| ${task} | ${pool.length} (${pct(pool.filter((trial) => trial.pass).length, pool.length)} pass) | ${cellFor("packages")} | ${cellFor("scratch")} | ${cellFor("data")} |`);
}
if (listAll) {
  say();
  say("## Every fire");
  say();
  for (const trial of trials) {
    for (const fire of trial.fires) {
      say(`- ${trial.run}/${trial.arm}/${trial.task}/${trial.trial} ${trial.pass ? "PASS" : "fail"} ${fire.kind} @${fire.request}/${trial.requests}: ${fire.items.slice(0, 6).join(", ")}${fire.extra === undefined ? "" : ` [${fire.extra}]`}`);
    }
  }
}
const markdown = `${lines.join("\n")}\n`;
if (outPath !== undefined) writeFileSync(outPath, markdown);
process.stdout.write(markdown);
