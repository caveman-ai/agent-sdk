/**
 * Offline replay of travel_check and unmet_target over recorded bench trials
 * (read-only: it opens files under the runs dir and never writes there).
 *
 *   node --experimental-strip-types --no-warnings scripts/replay-travel.ts <runs-dir> [--tasks <tb4 tasks dir>] [--json <out>] [--list]
 *
 * unmet_target runs exactly (unmetSentence on each v3 trial's first final and
 * its instruction.txt; wall used = the final's time over --max-wall-s).
 * travel_check runs the same rules (travel.ts) on an approximation of the
 * workspace, because transcripts carry no file system:
 * - written: paths the exec cells write (apply_patch Add/Update/Move, shell
 *   redirections, tee, cp/mv targets, touch, Python open(..., "w")), minus
 *   paths removed later (rm, Delete File, mv away), relative to the cwd;
 * - content: the file as the grader received it (artifacts/ per the
 *   manifest) when it traveled, else the Add File body;
 * - start: a path counts as present at the start when it is in the TB4
 *   task's environment/ dir or a tool result printed it (path or name)
 *   before the run first wrote it; (b) treats a literal as a pre-existing
 *   file when its name was printed by a tool result and the run never wrote it;
 * - (a) packages: names from `pip|uv pip|python -m pip install` and apt
 *   python3-* commands and "Successfully installed" lines, mapped to modules
 *   by a small alias table (no pip state in transcripts: an approximation).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileCandidates, isCode, mentioned, normalizeDist, packageFindings, pathLiterals, scratchFindings, unmetSentence, type Dist } from "../src/travel.ts";

const args = process.argv.slice(2);
const runsDir = args[0];
if (runsDir === undefined) throw new Error("usage: replay-travel.ts <runs-dir> [--tasks <dir>] [--json <out>] [--list]");
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const tasksDir = flag("--tasks") ?? process.env.HARNESS_TB4_TASKS ?? "";
const jsonOut = flag("--json");
const listAll = args.includes("--list");

type Row = { type: string; t?: number; text?: string; tools?: { name: string }[]; tool_calls?: { id: string; name: string; input: unknown }[]; id?: string; content?: unknown };

const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => (part?.type === "text" ? part.text ?? "" : "")).join("\n") : "";

/** JS string escapes in exec cell source, undone enough to read patches and commands. */
const unescape = (code: string) => code.replace(/\\n/gu, "\n").replace(/\\t/gu, "\t").replace(/\\"/gu, "\"").replace(/\\'/gu, "'").replace(/\\`/gu, "`").replace(/\\\\/gu, "\\");

const ALIAS: Record<string, string[]> = {
  "opencv-python": ["cv2"], "opencv-python-headless": ["cv2"], "opencv-contrib-python": ["cv2"], pillow: ["PIL"], "scikit-learn": ["sklearn"], "scikit-image": ["skimage"],
  pyyaml: ["yaml"], beautifulsoup4: ["bs4"], pymupdf: ["fitz"], "python-dateutil": ["dateutil"], pycryptodome: ["Crypto"], pycryptodomex: ["Cryptodome"],
  "protobuf": ["google"], "msgpack-python": ["msgpack"], "python-magic": ["magic"], "pyserial": ["serial"], "attrs": ["attr", "attrs"], "typing-extensions": ["typing_extensions"],
};
const modulesOf = (dist: string) => ALIAS[normalizeDist(dist)] ?? [normalizeDist(dist).replace(/-/gu, "_")];

const SKIP_PATH = /^(?:\/dev\/|\/proc\/|&|\d$)/u;

interface Trial {
  run: string; arm: string; task: string; trial: number; pass: boolean; dataset: string; exec?: true;
  unmet?: { sentence: string; usedPct: number | undefined };
  /** What the phrase rule alone (no number from the task) would quote: replay only. */
  unmetPhraseOnly?: string;
  scratch: string[]; data: { file: string; reads: string[] }[]; packages: { name: string; modules: string[]; files: string[] }[];
  written: number;
}

function trialDirOf(job: string): string | undefined {
  if (!existsSync(job)) return undefined;
  const sub = readdirSync(job).find((name) => name.includes("__") && statSync(join(job, name)).isDirectory());
  return sub === undefined ? undefined : join(job, sub);
}

/** Shell write targets and removals in a command, in order. */
function shellOps(cmd: string): { op: "write" | "remove"; path: string }[] {
  const ops: { at: number; op: "write" | "remove"; path: string }[] = [];
  for (const match of cmd.matchAll(/(?<![<>&\d=-])>>?(?![=&>])\s*(['"]?)([^\s'"<>|;&()]+)\1/gu)) ops.push({ at: match.index, op: "write", path: match[2]! });
  for (const match of cmd.matchAll(/\btee\s+(?:-a\s+)?(['"]?)([^\s'"<>|;&()]+)\1/gu)) ops.push({ at: match.index, op: "write", path: match[2]! });
  for (const match of cmd.matchAll(/\btouch\s+((?:[^\s;&|<>]+\s*)+)/gu)) for (const path of match[1]!.trim().split(/\s+/u)) if (!path.startsWith("-")) ops.push({ at: match.index, op: "write", path });
  for (const match of cmd.matchAll(/\b(cp|mv|install)\s+((?:-\S+\s+)*)(\S+)\s+([^\s;&|<>]+)/gu)) {
    if (match[1] === "mv") ops.push({ at: match.index, op: "remove", path: match[3]! });
    ops.push({ at: match.index + 1, op: "write", path: match[4]! });
  }
  for (const match of cmd.matchAll(/\brm\s+((?:-\S+\s+)*)((?:[^\s;&|<>]+\s*)+)/gu)) for (const path of match[2]!.trim().split(/\s+/u)) ops.push({ at: match.index, op: "remove", path });
  for (const match of cmd.matchAll(/\bopen\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[wax]b?\+?\3/gu)) ops.push({ at: match.index, op: "write", path: match[2]! });
  for (const match of cmd.matchAll(/\b(?:os\.remove|os\.unlink|shutil\.rmtree)\(\s*(['"])([^'"]+)\1/gu)) ops.push({ at: match.index, op: "remove", path: match[2]! });
  return ops.filter((op) => !SKIP_PATH.test(op.path)).sort((a, b) => a.at - b.at).map(({ op, path }) => ({ op, path }));
}

function replayTrial(trialDir: string, meta: { run: string; arm: string; task: string; trial: number; pass: boolean; dataset: string; startedMs: number }): Trial | undefined {
  const transcriptPath = join(trialDir, "agent", "transcript.jsonl");
  if (!existsSync(transcriptPath)) return undefined;
  const rows = readFileSync(transcriptPath, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Row);
  const system = rows.find((row) => row.type === "system");
  const argv = JSON.parse(readFileSync(join(trialDir, "agent", "argv.json"), "utf8")) as { argv: string[]; cwd?: string };
  const cwd = argv.cwd ?? "/app";
  const wallAt = argv.argv.indexOf("--max-wall-s");
  const wall = wallAt === -1 ? undefined : Number(argv.argv[wallAt + 1]);
  const instructionPath = join(trialDir, "agent", "instruction.txt");
  const task = existsSync(instructionPath) ? readFileSync(instructionPath, "utf8") : textOf(rows.find((row) => row.type === "user")?.content);
  const { startedMs, ...fields } = meta;
  void startedMs;
  const out: Trial = { ...fields, scratch: [], data: [], packages: [], written: 0 };
  const final = rows.find((row) => row.type === "assistant" && (row.text ?? "") !== "" && (row.tool_calls ?? []).length === 0);
  if (final !== undefined) {
    const sentence = unmetSentence(final.text!, task);
    if (sentence !== undefined) out.unmet = { sentence, usedPct: wall === undefined ? undefined : Math.round(((final.t ?? 0) / 1000 / wall) * 100) };
    const loose = unmetSentence(final.text!, task, { number: false });
    if (loose !== undefined) out.unmetPhraseOnly = loose;
  }
  // ---- travel (exec family only): the workspace, approximated ----
  if (!(system?.tools ?? []).some((tool) => tool.name === "exec")) return out;
  out.exec = true;
  const abs = (path: string) => posix.normalize(path.startsWith("/") ? path : posix.join(cwd, path));
  const rel = (path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path);
  const inCwd = (path: string) => path.startsWith(`${cwd}/`);
  const shellWritten = new Map<string, string | undefined>(); // abs path -> Add File body (if known), as the transcript leaves it
  const patchOp = new Map<string, "Add" | "Update">();
  const firstWriteAt = new Map<string, number>();
  const seenAt = new Map<string, number>(); // printed token (path or name) -> first tool-result index
  const printedDirs = new Set<string>();
  const installs = new Set<string>();
  rows.forEach((row, index) => {
    if (row.type === "tool_result") {
      const text = textOf(row.content);
      for (const [token] of text.matchAll(/[\w@+./-]*[\w@+-]\.[A-Za-z0-9]{1,8}\b|[\w@+.-]+(?:\/[\w@+.-]+)+\/?/gu)) {
        const clean = token.replace(/^\.\//u, "").replace(/\/$/u, "");
        for (const key of [clean, posix.basename(clean)]) if (!seenAt.has(key)) seenAt.set(key, index);
        if (clean.includes("/")) {
          printedDirs.add(abs(posix.dirname(clean)));
          if (token.endsWith("/")) printedDirs.add(abs(clean));
        }
      }
      for (const [, list] of text.matchAll(/Successfully installed ([^\n\\"]+)/gu)) for (const token of list!.trim().split(/\s+/u)) installs.add(token.replace(/-\d[\w.+!]*$/u, ""));
      return;
    }
    if (row.type !== "assistant") return;
    for (const call of row.tool_calls ?? []) {
      const input = call.input as { input?: string } | undefined;
      const code = unescape(typeof input?.input === "string" ? input.input : JSON.stringify(call.input ?? ""));
      const wrote = (path: string, body: string | undefined) => {
        shellWritten.set(path, body ?? shellWritten.get(path));
        if (!firstWriteAt.has(path)) firstWriteAt.set(path, index);
      };
      for (const match of code.matchAll(/^\*\*\* (Add|Update|Delete) File:\s*(\S+)\n([\s\S]*?)(?=^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch|$(?![\s\S]))/gmu)) {
        const path = abs(match[2]!);
        if (match[1] === "Delete") {
          shellWritten.delete(path);
          continue;
        }
        if (!patchOp.has(path)) patchOp.set(path, match[1] as "Add" | "Update");
        const move = /^\*\*\* Move to:\s*(\S+)/mu.exec(match[3]!);
        const body = match[1] === "Add" ? match[3]!.split("\n").filter((line) => line.startsWith("+")).map((line) => line.slice(1)).join("\n") : undefined;
        if (move !== null) shellWritten.delete(path);
        wrote(move === null ? path : abs(move[1]!), body);
      }
      for (const op of shellOps(code)) {
        const path = abs(op.path);
        if (op.op === "remove") {
          for (const key of [...shellWritten.keys()]) if (key === path || key.startsWith(`${path}/`)) shellWritten.delete(key);
        } else if (!shellWritten.has(path)) {
          wrote(path, undefined);
        }
      }
      for (const [, spec] of code.matchAll(/\b(?:pip3?|python3? -m pip|uv pip)\s+install\s+([^"\n;&|`]+)/gu)) {
        for (const token of spec!.split(/\s+/u)) {
          if (token === "" || token.startsWith("-") || /^[./]|:\/\//u.test(token) || /requirements/u.test(token)) continue;
          installs.add(token.split(/[<>=![~;]/u)[0]!);
        }
      }
      for (const [, spec] of code.matchAll(/\bapt(?:-get)?\s+install\s+([^"\n;&|`]+)/gu)) for (const token of spec!.split(/\s+/u)) if (/^python3-[\w.-]+$/u.test(token)) installs.add(token.slice(8));
    }
  });
  const printedBefore = (path: string) => {
    const first = seenAt.get(rel(path)) ?? seenAt.get(path) ?? seenAt.get(posix.basename(path));
    return first !== undefined && first < (firstWriteAt.get(path) ?? Infinity);
  };
  const envFiles = new Set<string>();
  const envDir = join(tasksDir, meta.task, "environment");
  if (meta.dataset === "tb4" && existsSync(envDir)) walk(envDir, "", (path) => envFiles.add(path));
  const inEnvDir = (path: string) => envFiles.has(rel(path)) || [...envFiles].some((file) => file.endsWith(`/${rel(path)}`));
  // What traveled: TB4 artifact dirs and files (mtimes kept: newer than the trial start = the run wrote it); DeepSWE model.patch.
  const travelled = new Map<string, { written: boolean; full?: string; text?: string; created?: boolean }>();
  const manifestPath = join(trialDir, "artifacts", "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as { source: string; destination: string; type: string; status: string }[] : [];
  const roots: string[] = [];
  for (const entry of manifest) {
    if (entry.status !== "ok" || entry.source.startsWith("/logs/")) continue;
    const source = entry.source.replace(/\/+$/u, "");
    const target = join(trialDir, entry.destination);
    if (entry.type === "directory") {
      roots.push(source);
      walk(target, "", (path, full) => travelled.set(`${source}/${path}`, { written: statSync(full).mtimeMs >= meta.startedMs - 1000, full }));
    } else if (existsSync(target)) {
      roots.push(source);
      travelled.set(source, { written: statSync(target).mtimeMs >= meta.startedMs - 1000, full: target });
    }
  }
  const patchPath = join(trialDir, "artifacts", "logs", "artifacts", "model.patch");
  const startTests = new Set<string>();
  if (meta.dataset === "ds" && existsSync(patchPath)) {
    for (const chunk of readFileSync(patchPath, "utf8").split(/^diff --git /mu).slice(1)) {
      const path = /^a\/(\S+) b\//u.exec(chunk)?.[1];
      if (path === undefined || /^deleted file mode/mu.test(chunk)) continue;
      const created = /^new file mode/mu.test(chunk);
      const added = chunk.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
      travelled.set(abs(path), { written: true, text: added, created });
      if (!created) startTests.add(path); // a file the repo had (a test-named one marks its directory as holding tests)
    }
    roots.push(cwd);
  }
  const underRoot = (path: string) => roots.some((root) => path === root || path.startsWith(`${root}/`));
  // (c) scratch: created by the run, there at the end. Present at the start: older than the trial (artifacts), a repo file the
  // patch modifies, in the task's environment/, or printed before the run first wrote it.
  const startScratch = new Set<string>([...envFiles, ...startTests]);
  for (const [path, file] of travelled) if (!file.written) startScratch.add(rel(path));
  for (const [token, index] of seenAt) {
    if (!token.includes("/")) continue;
    if (index < (firstWriteAt.get(abs(token)) ?? Infinity)) startScratch.add(rel(abs(token)));
  }
  const createdTravelled = [...travelled].filter(([path, file]) => inCwd(path) && file.written && (file.created ?? !(inEnvDir(path) || patchOp.get(path) === "Update" || printedBefore(path)))).map(([path]) => rel(path));
  const createdElsewhere = [...shellWritten.keys()].filter((path) => inCwd(path) && !underRoot(path) && !inEnvDir(path) && !printedBefore(path)).map(rel);
  const notTravelled = new Set(createdElsewhere);
  out.scratch = scratchFindings([...createdTravelled, ...createdElsewhere], startScratch, task).map((path) => `${path}${notTravelled.has(path) ? " (not in artifacts)" : ""}`);
  // Code the run wrote, as it ended.
  const code: { path: string; abs: string; text: string }[] = [];
  for (const [path, file] of travelled) {
    if (!file.written || !isCode(rel(path))) continue;
    const text = file.text ?? (file.full === undefined ? undefined : readFileSync(file.full, "utf8"));
    if (text !== undefined) code.push({ path: rel(path), abs: path, text });
  }
  for (const [path, body] of shellWritten) if (!underRoot(path) && inCwd(path) && isCode(rel(path)) && body !== undefined) code.push({ path: rel(path), abs: path, text: body });
  out.written = code.length;
  // (b) data (TB4: DeepSWE repo files travel with the repo, and the live check skips git-tracked files).
  if (meta.dataset === "tb4") {
    const writtenAbs = new Set([...[...travelled].filter(([, file]) => file.written).map(([path]) => path), ...shellWritten.keys()]);
    for (const file of code) {
      const reads = new Set<string>();
      for (const candidate of fileCandidates(file.text, file.abs, cwd)) {
        if (writtenAbs.has(candidate) || candidate === file.abs || mentioned(task, candidate, cwd)) continue;
        // Exists and is older than the run: exact under an artifact root; elsewhere its name and directory were printed.
        const exists = underRoot(candidate) ? travelled.get(candidate)?.written === false
          : seenAt.has(rel(candidate)) || seenAt.has(candidate) ||
            (seenAt.has(posix.basename(candidate)) && /\.[A-Za-z0-9]{1,8}$/u.test(candidate) && printedDirs.has(posix.dirname(candidate)) && posix.dirname(candidate) !== cwd);
        if (exists) reads.add(candidate);
      }
      // One literal, several guesses: keep a name's guesses outside the cwd's top level when there are any (the env would test each).
      const kept = [...reads].filter((path) => posix.dirname(path) !== cwd || ![...reads].some((other) => other !== path && posix.basename(other) === posix.basename(path)));
      if (kept.length > 0) out.data.push({ file: file.path, reads: kept.sort() });
    }
  }
  // (a) packages, approximated: the start snapshot is everything not installed in the run.
  if (installs.size > 0) {
    const now = new Map<string, Dist>();
    for (const name of installs) now.set(normalizeDist(name), { name, local: false, modules: modulesOf(name) });
    out.packages = packageFindings(new Map([["(start)", { name: "(start)", local: false, modules: [] }]]), now, code, task);
  }
  return out;
}

function walk(dir: string, prefix: string, visit: (path: string, full: string) => void): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (!/^(?:\.git|node_modules|\.venv|venv|site-packages|\.tox|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.cache|target|dist|build)$/u.test(name)) walk(full, `${prefix}${name}/`, visit);
    } else {
      visit(`${prefix}${name}`, full);
    }
  }
}

const trials: Trial[] = [];
for (const run of readdirSync(runsDir).sort()) {
  if (/^(?:rig|smoke|sm2|wsd)/u.test(run)) continue;
  const trialsPath = join(runsDir, run, "trials.jsonl");
  if (!existsSync(trialsPath)) continue;
  const rows = new Map<string, Record<string, any>>();
  for (const line of readFileSync(trialsPath, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as Record<string, any>;
    rows.set(`${row.arm}\u0000${row.task}\u0000${row.trial}`, row);
  }
  for (const row of rows.values()) {
    if (row.outcome !== "solved" && row.outcome !== "failed") continue;
    const trialDir = typeof row.job === "string" ? trialDirOf(row.job) : undefined;
    if (trialDir === undefined) continue;
    const trial = replayTrial(trialDir, {
      run, arm: row.arm, task: row.task, trial: row.trial, pass: (row.reward ?? 0) >= 1, dataset: run.endsWith("-ds") ? "ds" : "tb4",
      // The agent's start: files copied in during environment setup are the start state, not the run's.
      startedMs: Date.parse(row.started) + 1000 * ((row.phase_s?.environment_setup ?? 0) + (row.phase_s?.agent_setup ?? 0)),
    });
    if (trial !== undefined) trials.push(trial);
  }
}

const rate = (list: Trial[]) => `${list.filter((trial) => trial.pass).length}/${list.length}${list.length === 0 ? "" : ` (${Math.round((100 * list.filter((trial) => trial.pass).length) / list.length)}%)`}`;
const split = (name: string, fired: (trial: Trial) => boolean, pool: Trial[]) => {
  const yes = pool.filter(fired);
  console.log(`  ${name}: fires ${yes.length}/${pool.length}; pass fired ${rate(yes)} vs not ${rate(pool.filter((trial) => !fired(trial)))}`);
};
for (const dataset of ["tb4", "ds"]) {
  const all = trials.filter((trial) => trial.dataset === dataset);
  console.log(`${dataset}: ${all.length} v3 trials with a first final, pass ${rate(all)}`);
  split("unmet_target (any wall)", (trial) => trial.unmet !== undefined, all);
  split("unmet_target (<50% wall)", (trial) => trial.unmet !== undefined && (trial.unmet.usedPct ?? 100) < 50, all);
  const pool = all.filter((trial) => trial.exec === true);
  console.log(`  ${pool.length} exec-family trials, pass ${rate(pool)}`);
  split("(a) packages~", (trial) => trial.packages.length > 0, pool);
  split("(b) data", (trial) => trial.data.length > 0, pool);
  split("(c) scratch", (trial) => trial.scratch.length > 0, pool);
  split("(c) scratch that traveled", (trial) => trial.scratch.some((path) => !path.endsWith("(not in artifacts)")), pool);
  split("any of a/b/c", (trial) => trial.packages.length + trial.data.length + trial.scratch.length > 0, pool);
}
const known = (run: string, prefix: string, task: string) => trials.filter((trial) => trial.run === run && trial.arm.startsWith(prefix) && trial.task === task);
console.log("\nknown cases:");
for (const trial of known("anc1-tb4", "e1", "wal-recovery-ordering")) console.log(`  wal-recovery-ordering ${trial.arm}: scratch ${JSON.stringify(trial.scratch)}`);
for (const trial of known("anc1-tb4", "e1", "interleaved-vigenere")) console.log(`  interleaved-vigenere ${trial.arm}: data ${JSON.stringify(trial.data)}`);
const biped = trials.filter((trial) => trial.task === "biped-contact-dynamics");
console.log(`  biped-contact-dynamics: ${biped.length} trials, packages fired on ${biped.filter((trial) => trial.packages.length > 0).length}: ` +
  JSON.stringify(biped.filter((trial) => trial.packages.length > 0).map((trial) => `${trial.run}/${trial.arm}/${trial.trial}${trial.pass ? " PASS" : ""}: ${trial.packages.map((p) => `${p.name}<-${p.files.join("+")}`).join("; ")}`)));
console.log("\nunmet_target fires:");
for (const trial of trials.filter((trial) => trial.unmet !== undefined)) console.log(`  ${trial.run} ${trial.arm} ${trial.task} ${trial.trial} ${trial.pass ? "PASS" : "fail"} used ${trial.unmet!.usedPct}%: ${trial.unmet!.sentence.slice(0, 240)}`);
console.log("\nphrase-only rule (not shipped; no number required):");
for (const trial of trials.filter((trial) => trial.unmetPhraseOnly !== undefined)) console.log(`  ${trial.run} ${trial.arm} ${trial.task} ${trial.trial} ${trial.pass ? "PASS" : "fail"}: ${trial.unmetPhraseOnly!.slice(0, 200)}`);
if (listAll) {
  console.log("\ntravel fires:");
  for (const trial of trials.filter((trial) => trial.packages.length + trial.data.length + trial.scratch.length > 0)) {
    console.log(`  ${trial.run} ${trial.arm} ${trial.task} ${trial.trial} ${trial.pass ? "PASS" : "fail"} a=${JSON.stringify(trial.packages.map((p) => `${p.name}<-${p.files.join("+")}`))} b=${JSON.stringify(trial.data)} c=${JSON.stringify(trial.scratch)}`);
  }
}
if (jsonOut !== undefined) writeFileSync(jsonOut, JSON.stringify(trials, null, 1));
