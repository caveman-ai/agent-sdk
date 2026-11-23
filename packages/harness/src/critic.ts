/**
 * policy.critic: a fresh-context reviewer AGENT at the implementer's first
 * finish attempt (arXiv 2610.34577: +5.9 to +9.5 pp on Terminal-Bench at
 * 1.13-1.25x cost; same-context reminders help little, and a verifier from
 * another provider adds nothing, so the run's own model reviews). Where
 * policy.validator is one blind call that writes a check program from the task
 * alone, the critic is a Pi agent loop with tools that inspects the actual
 * workspace and runs things.
 *
 * - Start state (LeverState.start, one internal command): a marker in the
 *   critic's scratch dir, the git commit when the cwd is a repo, and the file
 *   list (VCS, vendored, virtualenv and cache trees pruned), kept in the env.
 * - Review, at a finish attempt after every other finish lever (the validator
 *   included: at the first attempt none of them claims), at most max_rounds
 *   times, under the finish levers' 90% budget guard, with a wall cap of
 *   wall_s clamped to half the wall left (under a minute, or under wall_s
 *   when that is shorter: skipped, so the fix keeps as much time as the review):
 *   1. The change summary (one internal command): files created, modified
 *      (ctime newer than the start marker) and deleted since the start, with
 *      sizes, and in a git repo the diff of the modified and deleted files
 *      against the starting commit (cut at diff_bytes).
 *   2. The guard's backup (one internal command): over guard_max_mb the review
 *      is skipped (never run unguarded); else a tar of the cwd and a manifest
 *      (every dir, symlink, executable bit, and cksum + size of every file)
 *      into the critic's scratch dir, then a marker.
 *   3. The review loop: runAgentLoop on the run's provider, model, base URL
 *      and key (models.ts resolveSideModel; a faux model gets its own script),
 *      at the lever's effort, own session id, HTTP, the loadout's wire knobs.
 *      FRESH context: system = the critic prompt; one user message = the task,
 *      the env (cwd, os, the critic's scratch dir), the change summary and the
 *      implementer's final message. Nothing else of the implementer's
 *      transcript. Tools: the run's surface without its file-editing tools
 *      (exec: exec + wait, nested exec_command, write_stdin, view_image, no
 *      apply_patch; compact: read, bash, wait, no edit or write), on an env
 *      view whose commands are internal (the implementer's handles never
 *      shift), whose TMPDIR is the critic's scratch, PYTHONDONTWRITEBYTECODE=1,
 *      and whose harness-side writes into the project are refused. At most
 *      max_turns requests (the one before the last gets a "verdict now"
 *      message); a USD or token budget reached ends it; the wall cap or the
 *      run's abort aborts it. Every response is a side request: its tokens and
 *      USD join usage and cost_usd (the budgets see them) and
 *      side_requests.critic; usage.requests stays the agent loop's.
 *   4. The guard's restore and check (one internal command, always, also
 *      after a timeout or an error): the manifest again plus the files whose
 *      ctime passed the marker; paths the review created are removed, paths
 *      it modified or deleted are taken back out of the tar; the manifest a
 *      third time must equal the first (`residual` 0, `workspace_unchanged`).
 *      The critic's scratch (backup, work and temp dirs) is removed.
 *   5. The verdict: the last `VERDICT: PASS|FAIL` line of the final message,
 *      a FAIL's findings ("Requirement / Fails / Evidence", at most
 *      max_findings). A FAIL with findings continues the run once with
 *      `text` ({findings}); PASS, no verdict, max_turns, a timeout, an error
 *      or a budget reached let the run end.
 * - critic_placebo: the same review (cost, timing, trigger) and
 *   placeboFor("critic", text) in place of the findings.
 *
 * Why the guard is a backup + verify + restore and not a copy: the critic must
 * exercise the deliverable where the grader will, at the paths the task names
 * (often absolute, /app/...), and programs write where they write; a copy of
 * the tree protects only against relative paths, while a restore verified
 * against a content manifest holds whatever the commands did inside the cwd.
 * Not covered: files outside the cwd, installed packages, processes and
 * services (the prompt forbids touching them).
 *
 * Snapshot (src/snapshot.ts): a bounce sets lastContinuation "critic", so
 * trace.finish_snapshot "fired" archives the first-finish workspace; that
 * archive is taken after the review, on the restored tree.
 */
import { randomBytes, randomUUID } from "node:crypto";
import {
  runAgentLoop, runAgentLoopContinue, type AgentEvent, type AgentLoopConfig, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, createInitialSystemMessage, isRetryableAssistantError, toToolDeclaration, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExecEnv } from "./env/types.ts";
import type { Levers, Loadout, ToolConfig } from "./loadout.ts";
import { costOf, type ResolvedModel } from "./models.ts";
import { insideOf } from "./snapshot.ts";
import { compactTools } from "./tools/compact.ts";
import { execSurface } from "./tools/exec/surface.ts";
import type { Recorder } from "./trace.ts";
import { wireSetup } from "./wire.ts";

export type CriticLever = NonNullable<Levers["critic"]>;

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`);

/** Trees the change summary never lists: VCS, vendored packages, virtualenvs, caches. */
const SUMMARY_PRUNE = [".git", "node_modules", ".venv", "venv", "site-packages", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".cache"];
/** The review's file-editing tools, by surface: off in its tool set. */
const MUTATING: Record<Loadout["surface"], readonly string[]> = { exec: ["apply_patch"], compact: ["edit", "write"] };
/** Lines of each change kind the summary lists. */
const SUMMARY_LINES = 200;
/** The implementer's final message as the critic sees it, at most. */
const FINAL_MAX_CHARS = 6000;
/** A review gets at least this much wall time (or its whole wall_s, when shorter), or it is skipped. */
const MIN_WALL_MS = 60_000;
/** Transient provider errors re-run per review (the loop's own retries come first). */
const RETRIES = 2;
const LIST_MARK = "@@critic-list@@";
const DIFF_MARK = "@@critic-diff@@";

const LAST_TURN = "[harness] This is your last request: reply now with no tool call, ending with your VERDICT in the stated form.";

// ---------- shell: the start state and the change summary ----------

/** `find` prune expression: the summary's pruned names, and `exclude` (a ./relative path inside the cwd: the scratch dir) when set. */
function pruneOf(names: readonly string[], exclude?: string): string {
  const parts = [...names.map((name) => `-name ${shellQuote(name)}`), ...(exclude === undefined ? [] : [`-path ${shellQuote(exclude)}`])];
  return parts.length === 0 ? "" : `\\( ${parts.join(" -o ")} \\) -prune -o `;
}

/**
 * Files and symlinks under the cwd (after `prune`) whose inode changed after `marker` (ctime: a write, chmod, rename or
 * backdated mtime all count, and no command can fake it); where find has no -cnewer (busybox), those whose mtime did.
 */
function changedSince(prune: string, marker: string): string {
  const test = (flag: string) => `find . ${prune}\\( -type f -o -type l \\) ${flag} ${marker} -print 2>/dev/null`;
  return `{ ${test("-cnewer")} || ${test("-newer")}; }`;
}

/** Run start (cwd = the env's): the marker, the git commit (`critic_git=`), the sorted file list (`critic_files=` its length). */
export function startScript(dir: string, exclude?: string): string {
  const d = shellQuote(dir);
  return [
    `mkdir -p ${d} && touch ${d}/start || exit 3`,
    'if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then b=$(git rev-parse -q --verify HEAD || git hash-object -t tree /dev/null); echo "critic_git=$b"; fi',
    `find . ${pruneOf(SUMMARY_PRUNE, exclude)}\\( -type f -o -type l \\) -print 2>/dev/null | LC_ALL=C sort > ${d}/start.p`,
    `echo "critic_files=$(wc -l < ${d}/start.p | tr -d ' ')"`,
    "exit 0",
  ].join("\n");
}

/**
 * At a review: files created, modified (ctime newer than the start marker) and deleted since the start, `critic_n_<kind>=` counts,
 * then LIST_MARK and `<kind> <bytes> <path>` lines (at most `lines` per kind), then, with a git base, DIFF_MARK and the git diff of
 * the modified and deleted files against it (at most `diffBytes` + 1 bytes, so a cut shows).
 */
export function summaryScript(dir: string, options: { base?: string; diffBytes: number; lines?: number; exclude?: string }): string {
  const d = shellQuote(dir);
  const lines = options.lines ?? SUMMARY_LINES;
  const prune = pruneOf(SUMMARY_PRUNE, options.exclude);
  const sized = (kind: string) =>
    `head -n ${lines} ${d}/${kind}.p | while IFS= read -r p; do s=$(wc -c < "$p" 2>/dev/null | tr -d ' '); printf '%s %s %s\\n' ${kind} "\${s:-?}" "$p"; done`;
  return [
    `[ -f ${d}/start ] && [ -f ${d}/start.p ] || { echo critic_error=no_start; exit 0; }`,
    `${changedSince(prune, `${d}/start`)} | LC_ALL=C sort -u > ${d}/changed.p`,
    `find . ${prune}\\( -type f -o -type l \\) -print 2>/dev/null | LC_ALL=C sort > ${d}/now.p`,
    `LC_ALL=C comm -13 ${d}/start.p ${d}/now.p > ${d}/created.p`,
    `LC_ALL=C comm -23 ${d}/start.p ${d}/now.p > ${d}/deleted.p`,
    `LC_ALL=C comm -23 ${d}/changed.p ${d}/created.p > ${d}/modified.p`,
    `for k in created modified deleted; do echo "critic_n_$k=$(wc -l < ${d}/$k.p | tr -d ' ')"; done`,
    `echo '${LIST_MARK}'`,
    sized("created"),
    sized("modified"),
    `head -n ${lines} ${d}/deleted.p | while IFS= read -r p; do printf 'deleted - %s\\n' "$p"; done`,
    ...(options.base === undefined || options.diffBytes <= 0 ? [] : [
      `echo '${DIFF_MARK}'`,
      `if [ -s ${d}/modified.p ] || [ -s ${d}/deleted.p ]; then cat ${d}/modified.p ${d}/deleted.p | tr '\\n' '\\0' | ` +
        `xargs -0 git -c core.quotepath=off diff --no-color --no-ext-diff --relative ${shellQuote(options.base)} -- 2>/dev/null | head -c ${options.diffBytes + 1}; fi`,
    ]),
    "exit 0",
  ].join("\n");
}

/** `<prefix><key>=<value>` lines of a script's output. */
export function factsOf(output: string, prefix: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const line of output.split("\n")) {
    if (!line.startsWith(prefix)) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    facts[line.slice(prefix.length, at)] = line.slice(at + 1).trimEnd();
  }
  return facts;
}

export interface ChangeEntry {
  kind: "created" | "modified" | "deleted";
  /** Bytes, or undefined for a deleted file (or one wc could not read). */
  bytes?: number;
  path: string;
}

export interface ChangeSummary {
  entries: ChangeEntry[];
  counts: { created: number; modified: number; deleted: number };
  /** The git diff (git repos only), cut at diffBytes. */
  diff?: string;
  diffCut?: boolean;
}

/** summaryScript's output as entries, counts and the diff; undefined when the start state was missing. */
export function parseSummary(output: string, diffBytes: number): ChangeSummary | undefined {
  const listAt = output.indexOf(LIST_MARK);
  if (listAt === -1) return undefined;
  const head = factsOf(output.slice(0, listAt), "critic_");
  if (head.error !== undefined) return undefined;
  const diffAt = output.indexOf(DIFF_MARK, listAt);
  const list = output.slice(listAt + LIST_MARK.length, diffAt === -1 ? undefined : diffAt);
  const entries: ChangeEntry[] = [];
  for (const line of list.split("\n")) {
    const match = /^(created|modified|deleted) (\S+) (.+)$/u.exec(line);
    if (match === null) continue;
    const bytes = Number(match[2]);
    entries.push({ kind: match[1] as ChangeEntry["kind"], ...(Number.isFinite(bytes) && match[2] !== "-" && match[2] !== "?" ? { bytes } : {}), path: match[3]!.replace(/^\.\//u, "") });
  }
  const count = (kind: string) => Number(head[`n_${kind}`] ?? 0) || 0;
  const summary: ChangeSummary = { entries, counts: { created: count("created"), modified: count("modified"), deleted: count("deleted") } };
  if (diffAt !== -1) {
    const raw = output.slice(diffAt + DIFF_MARK.length).replace(/^\n/u, "");
    const cut = Buffer.byteLength(raw, "utf8") > diffBytes;
    summary.diff = cut ? Buffer.from(raw, "utf8").subarray(0, diffBytes).toString("utf8").replace(/\uFFFD$/u, "") : raw;
    summary.diffCut = cut;
  }
  return summary;
}

const PRUNED_NOTE = ".git, node_modules, virtualenvs and caches not listed";

/** The <changes> block: what changed since the start, as a table, then the git diff when there is one. */
export function renderChanges(summary: ChangeSummary | undefined, cwd: string, diffBytes: number): string {
  if (summary === undefined) return `The harness could not record the starting state of ${cwd}; inspect the workspace yourself.`;
  const { counts } = summary;
  if (counts.created + counts.modified + counts.deleted === 0) return `No file under ${cwd} was created, modified or deleted since the start (${PRUNED_NOTE}).`;
  const width = Math.max(1, ...summary.entries.map((entry) => String(entry.bytes ?? "-").length));
  const lines = [`Files created, modified or deleted under ${cwd} since the start (sizes in bytes; ${PRUNED_NOTE}):`];
  for (const entry of summary.entries) lines.push(`${entry.kind.padEnd(8)} ${String(entry.bytes ?? "-").padStart(width)}  ${entry.path}`);
  for (const kind of ["created", "modified", "deleted"] as const) {
    const listed = summary.entries.filter((entry) => entry.kind === kind).length;
    if (counts[kind] > listed) lines.push(`[${counts[kind] - listed} more ${kind} files not listed]`);
  }
  if (summary.diff !== undefined) {
    lines.push("", "git diff of the modified and deleted files against the starting commit:");
    lines.push(summary.diff.trim() === "" ? "(no tracked file changed)" : summary.diff.trimEnd());
    if (summary.diffCut === true) lines.push(`[diff cut at ${diffBytes} bytes]`);
  }
  return lines.join("\n");
}

/** The critic's first (and only) user message: the task first, then the env, what changed, and the implementer's final message. */
export function criticRequest(task: string, facts: { cwd: string; os?: string; scratch: string; changes: string; final: string }): string {
  const final = facts.final.trim() === "" ? "(empty)" : clip(facts.final.trim(), FINAL_MAX_CHARS);
  return [
    `<task>\n${task.trim()}\n</task>`,
    `<env>\ncwd: ${facts.cwd}\n${facts.os === undefined ? "" : `os: ${facts.os}\n`}your scratch directory (outside the project): ${facts.scratch}\n</env>`,
    `<changes>\n${facts.changes}\n</changes>`,
    `<engineer_final_message>\n${final}\n</engineer_final_message>`,
    "Review the work against the task now.",
  ].join("\n\n");
}

// ---------- shell: the guard ----------

/**
 * Every dir, symlink (with its target's cksum), executable bit and file (cksum and size) under the cwd, one sorted line each:
 * `d ./path`, `l <crc>-<len> ./path`, `x ./path`, `f <crc> <size> ./path` (nothing before the path holds a dot).
 */
function manifest(exclude?: string): string {
  const ex = exclude === undefined ? "" : `-path ${shellQuote(exclude)} -prune -o `;
  const links = "for p; do printf 'l %s %s\\n' \"$(readlink \"$p\" | cksum | tr ' ' -)\" \"$p\"; done";
  return `{ find . ${ex}-type d -print | sed 's/^/d /'; find . ${ex}-type l -exec sh -c ${shellQuote(links)} sh {} +; ` +
    `find . ${ex}-type f -perm -100 -print | sed 's/^/x /'; find . ${ex}-type f -exec cksum {} + | sed 's/^/f /'; } 2>/dev/null | LC_ALL=C sort`;
}

/**
 * Before a review (cwd = the env's): the cwd's size (`cg_kb=`; over `maxKb`: `cg_skip=too_large` and nothing else), then a tar of the
 * cwd (`cg_tar_exit=`), the manifest (`cg_entries=`), the critic's work and temp dirs, and the marker, all under `dir`.
 */
export function guardBeforeScript(dir: string, maxKb: number, exclude?: string): string {
  const d = shellQuote(dir);
  return [
    'kb=$(du -sk . 2>/dev/null | cut -f1); echo "cg_kb=$kb"',
    `if [ -n "$kb" ] && [ "$kb" -gt ${Math.floor(maxKb)} ] 2>/dev/null; then echo cg_skip=too_large; exit 0; fi`,
    `rm -rf ${d} && mkdir -p ${d}/work ${d}/tmp || { echo cg_error=mkdir; exit 0; }`,
    `tar -cf ${d}/backup.tar ${exclude === undefined ? "" : `--exclude=${shellQuote(exclude)} `}. 2>${d}/tar.err; echo "cg_tar_exit=$?"`,
    `echo "cg_tar_err=$(tail -c 300 ${d}/tar.err 2>/dev/null | tr '\\n' ' ')"`,
    `${manifest(exclude)} > ${d}/before.m`,
    `echo "cg_entries=$(wc -l < ${d}/before.m | tr -d ' ')"`,
    `touch ${d}/marker`,
    "exit 0",
  ].join("\n");
}

/**
 * After a review: what it changed under the cwd (manifest lines that differ, and files and symlinks whose ctime passed the marker),
 * `cg_created=` / `cg_restore=` counts and the first `listMax` paths (`+ ` created, `~ ` modified or deleted) between
 * cg_paths_begin/end; created paths removed, the others removed and extracted from the tar (`cg_extract_exit=`), then the manifest
 * compared with the first (`cg_residual=`: differing lines left). The guard dir is removed in every case.
 */
export function guardAfterScript(dir: string, exclude?: string, listMax = 20): string {
  const d = shellQuote(dir);
  const ex = exclude === undefined ? "" : `-path ${shellQuote(exclude)} -prune -o `;
  return [
    `if [ ! -f ${d}/before.m ] || [ ! -f ${d}/backup.tar ] || [ ! -f ${d}/marker ]; then echo cg_error=no_backup; rm -rf -- ${d}; exit 0; fi`,
    // A manifest line's path: everything from its "./" (the type, cksum and size before it hold no dot).
    "paths() { sed 's/^[^.]* \\././' | LC_ALL=C sort -u; }",
    `${manifest(exclude)} > ${d}/after.m`,
    `{ LC_ALL=C comm -23 ${d}/before.m ${d}/after.m; LC_ALL=C comm -13 ${d}/before.m ${d}/after.m; ` +
      `${changedSince(ex, `${d}/marker`)} | sed 's/^/c /'; } | paths > ${d}/touched.p`,
    `paths < ${d}/before.m > ${d}/before.p`,
    `paths < ${d}/after.m > ${d}/after.p`,
    `LC_ALL=C comm -13 ${d}/before.p ${d}/after.p > ${d}/created.p`,
    `LC_ALL=C comm -12 ${d}/touched.p ${d}/before.p > ${d}/restore.p`,
    `echo "cg_created=$(wc -l < ${d}/created.p | tr -d ' ')"`,
    `echo "cg_restore=$(wc -l < ${d}/restore.p | tr -d ' ')"`,
    `echo cg_paths_begin; { sed 's/^/+ /' ${d}/created.p; sed 's/^/~ /' ${d}/restore.p; } | head -n ${listMax}; echo cg_paths_end`,
    `if [ -s ${d}/created.p ] || [ -s ${d}/restore.p ]; then`,
    `  while IFS= read -r p; do rm -rf -- "$p"; done < ${d}/created.p`,
    `  while IFS= read -r p; do if [ -d "$p" ] && [ ! -L "$p" ] && grep -qxF -- "d $p" ${d}/before.m; then continue; fi; rm -rf -- "$p"; done < ${d}/restore.p`,
    // Only the topmost paths are extracted: a deleted directory brings its whole subtree back.
    `  awk '{ n = split($0, p, "/"); a = p[1]; c = 0; for (i = 2; i < n; i++) { a = a "/" p[i]; if (a in k) { c = 1; break } } if (!c) { k[$0] = 1; print } }' ` +
      `${d}/restore.p > ${d}/extract.p`,
    `  if [ -s ${d}/extract.p ]; then tar -xpf ${d}/backup.tar -T ${d}/extract.p 2>${d}/x.err; echo "cg_extract_exit=$?"; ` +
      `echo "cg_extract_err=$(tail -c 300 ${d}/x.err 2>/dev/null | tr '\\n' ' ')"; fi`,
    `  ${manifest(exclude)} > ${d}/final.m`,
    `  echo "cg_residual=$( { LC_ALL=C comm -23 ${d}/before.m ${d}/final.m; LC_ALL=C comm -13 ${d}/before.m ${d}/final.m; } | wc -l | tr -d ' ')"`,
    "else",
    "  echo cg_residual=0",
    "fi",
    `rm -rf -- ${d}`,
    "exit 0",
  ].join("\n");
}

export interface GuardAfter {
  created: number;
  restored: number;
  residual: number;
  paths: string[];
  extractExit?: number;
  extractErr?: string;
  error?: string;
}

/** guardAfterScript's output. */
export function parseGuardAfter(output: string): GuardAfter {
  const facts = factsOf(output, "cg_");
  const begin = output.indexOf("cg_paths_begin\n");
  const end = output.indexOf("cg_paths_end", begin);
  const paths = begin === -1 || end === -1 ? [] : output.slice(begin + "cg_paths_begin\n".length, end).split("\n").filter((line) => line !== "");
  const num = (key: string) => (facts[key] === undefined || facts[key] === "" ? NaN : Number(facts[key]));
  const extract = num("extract_exit");
  const after: GuardAfter = { created: num("created") || 0, restored: num("restore") || 0, residual: num("residual"), paths };
  if (Number.isFinite(extract)) after.extractExit = extract;
  if ((facts.extract_err ?? "").trim() !== "") after.extractErr = facts.extract_err!.trim();
  if (facts.error !== undefined) after.error = facts.error;
  else if (!Number.isFinite(after.residual)) after.error = `no result (${output.slice(-200)})`;
  return after;
}

// ---------- the verdict ----------

export interface Finding {
  requirement?: string;
  fails?: string;
  evidence?: string;
  /** The finding as written (a FAIL whose findings follow no known form is one raw finding). */
  raw: string;
}

const VERDICT_LINE = /^[ \t>*_#`-]*VERDICT[*_`]*[ \t]*[:=-][ \t]*[*_`]*[ \t]*(PASS|FAIL)\b/gimu;
/** A line that starts a finding: optional bullet, number, heading or "Finding N:", then "Requirement...:". */
const FINDING_START = /^[ \t]*(?:[-*\u2022][ \t]*|\d+[.)][ \t]*|#{1,4}[ \t]*)?[*_]*(?:finding[ \t]*\d*[ \t]*[:.)-]?[ \t]*)?[*_]*requirement\b[^:\n]{0,40}:/gimu;
const FIELD_LINE = /^[ \t]*(?:[-*\u2022][ \t]*|\d+[.)][ \t]*)?[*_]*(requirement|fails|what fails|failure|problem|issue|evidence)\b[^:\n]{0,40}:[*_]*[ \t]*(.*)$/iu;
const unbold = (text: string) => text.replaceAll("**", "").replace(/^[*_]+|[*_]+$/gu, "").trim();

/** The last VERDICT line of the critic's final message and, for a FAIL, its findings. */
export function parseVerdict(text: string): { verdict?: "PASS" | "FAIL"; findings: Finding[] } {
  let last: RegExpMatchArray | undefined;
  for (const match of text.matchAll(VERDICT_LINE)) last = match;
  if (last === undefined) return { findings: [] };
  const verdict = last[1]!.toUpperCase() as "PASS" | "FAIL";
  if (verdict === "PASS") return { verdict, findings: [] };
  const body = text.slice(last.index! + last[0].length);
  const starts = [...body.matchAll(FINDING_START)].map((match) => match.index!);
  const findings: Finding[] = [];
  for (const [i, start] of starts.entries()) {
    const segment = body.slice(start, starts[i + 1] ?? body.length).trim();
    const fields: Record<string, string[]> = {};
    let current: string | undefined;
    for (const line of segment.split("\n")) {
      const field = FIELD_LINE.exec(line);
      if (field !== null) {
        const label = field[1]!.toLowerCase();
        current = label === "requirement" ? "requirement" : label === "evidence" ? "evidence" : "fails";
        (fields[current] ??= []).push(field[2]!);
      } else if (current !== undefined) {
        fields[current]!.push(line.trim());
      }
    }
    const joined = (key: string, max: number) => {
      const value = unbold((fields[key] ?? []).join("\n").trim());
      return value === "" ? undefined : clip(value, max);
    };
    const requirement = joined("requirement", 500);
    const fails = joined("fails", 800);
    const evidence = joined("evidence", 1500);
    if (requirement === undefined || (fails === undefined && evidence === undefined)) continue;
    findings.push({ requirement, ...(fails === undefined ? {} : { fails }), ...(evidence === undefined ? {} : { evidence }), raw: clip(segment, 2500) });
  }
  if (findings.length === 0 && body.trim() !== "") findings.push({ raw: clip(body.trim(), 2000) });
  return { verdict, findings };
}

const indent = (text: string) => text.split("\n").join("\n   ");

/** The findings as the implementer sees them: numbered, Requirement / Fails / Evidence, at most `max`, then a count of the rest. */
export function formatFindings(findings: readonly Finding[], max: number): string {
  const lines = findings.slice(0, max).map((finding, index) => {
    if (finding.requirement === undefined) return `${index + 1}. ${indent(finding.raw)}`;
    return [
      `${index + 1}. Requirement: ${indent(finding.requirement)}`,
      ...(finding.fails === undefined ? [] : [`   Fails: ${indent(finding.fails)}`]),
      ...(finding.evidence === undefined ? [] : [`   Evidence: ${indent(finding.evidence)}`]),
    ].join("\n");
  });
  if (findings.length > max) lines.push(`(${findings.length - max} more findings not listed)`);
  return lines.join("\n");
}

// ---------- the review's tools ----------

/** The run's loadout with the surface's file-editing tools off: the review's tool set. */
export function criticLoadout(loadout: Loadout): Loadout {
  const tools: Record<string, ToolConfig> = {};
  for (const [name, config] of Object.entries(loadout.tools)) tools[name] = MUTATING[loadout.surface].includes(name) ? { ...config, exposure: "off" } : config;
  return { ...loadout, tools };
}

/**
 * The env as the review's tools see it: every command internal (handles h<n>: the implementer's p<n> never shift) with `vars`
 * (TMPDIR, PYTHONDONTWRITEBYTECODE) under the command's own, `scratch` as its scratch dir, a harness-side write into the
 * project refused, and close() a no-op (the run's env outlives the review).
 */
export function reviewEnv(env: ExecEnv, options: { scratch: string; vars: Record<string, string> }): ExecEnv {
  const refuse = (path: string) => {
    const full = env.resolvePath(path);
    if (full === env.cwd || insideOf(env.cwd, full) !== undefined) throw new Error(`read-only review: no writes in the project (${path})`);
  };
  return {
    id: env.id, cwd: env.cwd, user: env.user, os: env.os,
    exec: (command, opts = {}) => env.exec(command, { ...opts, internal: true, env: { ...options.vars, ...(opts.env ?? {}) } }),
    poll: (handle) => env.poll(handle),
    wait: (handle, ms, signal) => env.wait(handle, ms, signal),
    kill: (handle) => env.kill(handle),
    readFile: (path, range) => env.readFile(path, range),
    writeFile: async (path, data) => {
      refuse(path);
      return env.writeFile(path, data);
    },
    stat: (path) => env.stat(path),
    listDir: (path) => env.listDir(path),
    scratchDir: async () => options.scratch,
    resolvePath: (path) => env.resolvePath(path),
    close: async () => {},
    ...(env.readFiles === undefined ? {} : { readFiles: (paths: string[]) => env.readFiles!(paths) }),
    ...(env.writeFiles === undefined ? {} : {
      writeFiles: async (files: { path: string; data: Uint8Array | string }[]) => {
        for (const file of files) refuse(file.path);
        return env.writeFiles!(files);
      },
    }),
  };
}

// ---------- the critic ----------

export type CriticStop = "verdict" | "no_verdict" | "max_turns" | "timeout" | "budget" | "aborted" | "error";

interface CriticStart {
  base?: string;
  files: number;
}

interface LoopStats {
  turns: number;
  toolCalls: number;
  calls: string[];
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  cost: number | null;
}

export interface CriticOutcome {
  /** The continuation (the lever's text with the findings). */
  text: string;
  /** Trace fields of the bounce. */
  fields: Record<string, unknown>;
}

export class Critic {
  private readonly lever: CriticLever;
  private readonly loadout: Loadout;
  private readonly env: ExecEnv;
  private readonly recorder: Recorder;
  private readonly task: string;
  private readonly side: ResolvedModel;
  private readonly images: boolean;
  private readonly signal: AbortSignal | undefined;
  private readonly reasoning: ThinkingLevel;
  private readonly sessionId = randomUUID();
  private dir: Promise<string> | undefined;
  private start: Promise<CriticStart | null> | undefined;
  private running: AbortController | undefined;
  private rounds = 0;
  /** A review that cannot be guarded (too large, no backup) or run (no wall time): the critic never runs (again). */
  private retired = false;
  private closed = false;

  constructor(options: { lever: CriticLever; loadout: Loadout; env: ExecEnv; recorder: Recorder; task: string; side: ResolvedModel; images?: boolean; signal?: AbortSignal }) {
    this.lever = options.lever;
    this.loadout = options.loadout;
    this.env = options.env;
    this.recorder = options.recorder;
    this.task = options.task;
    this.side = options.side;
    this.images = options.images ?? false;
    this.signal = options.signal;
    this.reasoning = options.side.model.reasoning ? (clampThinkingLevel(options.side.model, options.lever.effort) as ThinkingLevel) : "off";
  }

  /** The critic's directory in the env's scratch dir (once per run). */
  private scratch(): Promise<string> {
    return this.dir ??= this.env.scratchDir().then((scratch) => `${scratch.replace(/\/+$/u, "")}/.critic-${randomBytes(6).toString("hex")}`);
  }

  /** The env's scratch dir as a ./path inside the cwd, when it is inside it (the guard and the summary leave it out). */
  private async exclude(): Promise<string | undefined> {
    return insideOf(this.env.cwd, await this.env.scratchDir());
  }

  /** Run start: the marker, the git commit and the file list (one internal command; idempotent). Never throws. */
  begin(): Promise<CriticStart | null> {
    return this.start ??= (async () => {
      try {
        const dir = await this.scratch();
        const run = await this.env.exec(startScript(dir, await this.exclude()), { timeoutMs: 60_000, internal: true });
        if (run.exitCode !== 0) throw new Error(`start command exit ${run.exitCode ?? "killed"}: ${run.output.slice(-200)}`);
        const facts = factsOf(run.output, "critic_");
        return { ...(facts.git === undefined || facts.git === "" ? {} : { base: facts.git }), files: Number(facts.files ?? 0) || 0 };
      } catch (error) {
        this.recorder.policy("check", "critic_failed", { stage: "start", error: message(error).slice(0, 300) });
        return null;
      }
    })();
  }

  /** Whether a review may still run: a round left and nothing retired it. */
  get pending(): boolean {
    return !this.closed && !this.retired && this.rounds < this.lever.max_rounds;
  }

  /**
   * A review at a finish attempt: the continuation (or undefined to let the run end). `final` is the implementer's final message,
   * `wallLeftMs` the run's wall left (undefined: no wall budget), `overBudget` whether a hard budget is reached. Never throws.
   */
  async review(final: string, options: { wallLeftMs?: number; overBudget: () => boolean }): Promise<CriticOutcome | undefined> {
    if (!this.pending) return undefined;
    try {
      return await this.round(final, options);
    } catch (error) {
      // Only an env that fails outright gets here (the loop and the guard catch their own errors): the critic retires.
      this.retired = true;
      this.recorder.policy("check", "critic_failed", { stage: "review", round: this.rounds, error: message(error).slice(0, 300) });
      return undefined;
    }
  }

  private async round(final: string, options: { wallLeftMs?: number; overBudget: () => boolean }): Promise<CriticOutcome | undefined> {
    const wallMs = Math.min(this.lever.wall_s * 1000, options.wallLeftMs === undefined ? Infinity : Math.floor(options.wallLeftMs / 2));
    if (wallMs < Math.min(MIN_WALL_MS, this.lever.wall_s * 1000)) {
      this.retired = true;
      this.recorder.policy("skip", "critic", { cause: "wall_left", wall_left_ms: Math.round(options.wallLeftMs ?? 0) });
      return undefined;
    }
    if (this.env.cwd === "/" || this.env.cwd === "") {
      this.retired = true;
      this.recorder.policy("skip", "critic", { cause: "cwd_root" });
      return undefined;
    }
    this.rounds++;
    const round = this.rounds;
    const started = performance.now();
    const dir = await this.scratch();
    const exclude = await this.exclude();
    const start = await this.begin();
    // 1. What changed since the start.
    const summaryStarted = performance.now();
    let summary: ChangeSummary | undefined;
    if (start !== null) {
      try {
        const run = await this.env.exec(summaryScript(dir, { ...(start.base === undefined ? {} : { base: start.base }), diffBytes: this.lever.diff_bytes, ...(exclude === undefined ? {} : { exclude }) }), {
          timeoutMs: 60_000, internal: true,
        });
        summary = parseSummary(run.output, this.lever.diff_bytes);
      } catch (error) {
        this.recorder.policy("check", "critic_failed", { stage: "summary", round, error: message(error).slice(0, 300) });
      }
    }
    const summaryMs = Math.round(performance.now() - summaryStarted);
    // 2. The guard's backup: no backup, no review.
    const guardDir = `${dir}/round-${round}`;
    const guardStarted = performance.now();
    let before: Record<string, string>;
    try {
      const run = await this.env.exec(guardBeforeScript(guardDir, this.lever.guard_max_mb * 1024, exclude), { timeoutMs: 300_000, internal: true });
      before = factsOf(run.output, "cg_");
      if (before.skip === undefined && before.error === undefined && before.tar_exit === undefined) {
        before.error = `backup command exit ${run.exitCode ?? "killed"}${run.timedOut === true ? " (timed out)" : ""}`;
      }
    } catch (error) {
      before = { error: message(error).slice(0, 300) };
    }
    const tarExit = Number(before.tar_exit);
    if (before.skip !== undefined || before.error !== undefined || !(tarExit === 0 || tarExit === 1)) {
      this.retired = true;
      const cause = before.skip ?? "guard_failed";
      this.recorder.policy("skip", "critic", {
        cause, round, cwd_kb: before.kb === undefined || before.kb === "" ? null : Number(before.kb), max_kb: this.lever.guard_max_mb * 1024,
        ...(cause === "guard_failed" ? { error: before.error ?? `tar exit ${before.tar_exit}: ${before.tar_err ?? ""}`.trim() } : {}),
      });
      if (cause === "guard_failed") await this.env.exec(`rm -rf -- ${shellQuote(guardDir)}`, { timeoutMs: 30_000, internal: true }).catch(() => undefined);
      return undefined;
    }
    const backupMs = Math.round(performance.now() - guardStarted);
    // 3. The review, fresh context.
    const request = criticRequest(this.task, {
      cwd: this.env.cwd, ...(this.env.os === undefined ? {} : { os: this.env.os }), scratch: `${guardDir}/work`, changes: renderChanges(summary, this.env.cwd, this.lever.diff_bytes), final,
    });
    const loopStarted = performance.now();
    const loop = await this.loop(request, guardDir, wallMs, options.overBudget);
    const loopMs = Math.round(performance.now() - loopStarted);
    // 4. The guard's restore and check, whatever happened.
    const restoreStarted = performance.now();
    let after: GuardAfter;
    try {
      const run = await this.env.exec(guardAfterScript(guardDir, exclude), { timeoutMs: 300_000, internal: true });
      after = parseGuardAfter(run.output);
    } catch (error) {
      after = { created: 0, restored: 0, residual: NaN, paths: [], error: message(error).slice(0, 300) };
    }
    const restoreMs = Math.round(performance.now() - restoreStarted);
    // 5. The verdict.
    const parsed = loop.stop === "verdict" || loop.stop === "no_verdict" ? parseVerdict(loop.final) : { findings: [] as Finding[] };
    const stop: CriticStop = loop.stop === "verdict" && parsed.verdict === undefined ? "no_verdict" : loop.stop;
    const findings = parsed.verdict === "FAIL" ? parsed.findings : [];
    const unchanged = after.error === undefined && after.residual === 0;
    const runAborted = this.signal?.aborted === true;
    const budget = !runAborted && findings.length > 0 && options.overBudget();
    const bounced = stop === "verdict" && parsed.verdict === "FAIL" && findings.length > 0 && !runAborted && !budget;
    const stats = loop.stats;
    const fields = {
      round, stop, verdict: parsed.verdict ?? null, n_findings: findings.length, bounced, ...(budget ? { cause: "budget" } : {}),
      turns: stats.turns, tool_calls: stats.toolCalls, input_tokens: stats.input, cached_input_tokens: stats.cacheRead, cache_write_tokens: stats.cacheWrite,
      output_tokens: stats.output, reasoning_tokens: stats.reasoning, cost_usd: stats.cost === null ? null : Math.round(stats.cost * 1e6) / 1e6,
      ms: Math.round(performance.now() - started), wall_ms: loopMs, wall_cap_ms: wallMs, summary_ms: summaryMs, backup_ms: backupMs, restore_ms: restoreMs,
      workspace_unchanged: unchanged,
      guard: {
        cwd_kb: Number(before.kb) || 0, entries: Number(before.entries) || 0, ...(tarExit === 1 ? { tar_warning: (before.tar_err ?? "").trim() || "tar exit 1" } : {}),
        created: after.created, restored: after.restored, residual: Number.isFinite(after.residual) ? after.residual : null,
        ...(after.paths.length === 0 ? {} : { paths: after.paths }), ...(after.extractExit === undefined || after.extractExit === 0 ? {} : { extract_exit: after.extractExit }),
        ...(after.extractErr === undefined ? {} : { extract_err: after.extractErr }), ...(after.error === undefined ? {} : { error: after.error }),
      },
      changes: summary === undefined ? null : { ...summary.counts, diff_bytes: summary.diff === undefined ? null : Buffer.byteLength(summary.diff, "utf8") },
      request_bytes: Buffer.byteLength(request, "utf8"),
      ...(loop.error === undefined ? {} : { error: loop.error }),
      calls: stats.calls, final: clip(loop.final, 4000),
    };
    this.recorder.policy("check", "critic", fields);
    if (!bounced) return undefined;
    const items = formatFindings(findings, this.lever.max_findings);
    return {
      text: this.lever.text.replaceAll("{findings}", items),
      fields: { round, n_findings: findings.length, findings: items.slice(0, 4000), workspace_unchanged: unchanged, turns: stats.turns, cost_usd: fields.cost_usd },
    };
  }

  /** The review loop: fresh context, read-only tools, the turn cap, the wall cap. Never throws. */
  private async loop(request: string, guardDir: string, wallMs: number, overBudget: () => boolean): Promise<{ stop: CriticStop; final: string; stats: LoopStats; error?: string }> {
    const stats: LoopStats = { turns: 0, toolCalls: 0, calls: [], input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 };
    const controller = new AbortController();
    this.running = controller;
    const onRunAbort = () => controller.abort(this.signal?.reason);
    if (this.signal?.aborted === true) onRunAbort();
    else this.signal?.addEventListener("abort", onRunAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("critic_timeout"));
    }, wallMs);
    let ended: CriticStop | undefined;
    let steer = false;
    let built: { tools: AgentTool<any>[]; dispose(): Promise<void> } | undefined;
    const history: AgentMessage[] = [];
    try {
      const env = reviewEnv(this.env, { scratch: `${guardDir}/work`, vars: { TMPDIR: `${guardDir}/tmp`, PYTHONDONTWRITEBYTECODE: "1" } });
      const loadout = criticLoadout(this.loadout);
      built = loadout.surface === "compact" ? { tools: compactTools({ env, loadout, images: this.images }), dispose: async () => {} } : execSurface({ env, loadout, images: this.images });
      const tools = built.tools;
      const system = this.lever.prompt.replaceAll("{max_turns}", String(this.lever.max_turns)).replaceAll("{max_findings}", String(this.lever.max_findings));
      const wire = wireSetup(this.loadout.wire, this.side.model, this.sessionId, this.lever.effort);
      let sentAt = performance.now();
      const config: AgentLoopConfig = {
        model: wire.model,
        ...(this.reasoning === "off" ? {} : { reasoning: this.reasoning }),
        sessionId: this.sessionId,
        cacheRetention: this.loadout.wire.cache_retention,
        maxRetries: this.loadout.wire.max_retries,
        ...(this.loadout.wire.max_output_tokens === undefined ? {} : { maxTokens: this.loadout.wire.max_output_tokens }),
        ...(this.loadout.wire.transport === undefined || this.loadout.wire.transport === "ws" ? {} : { transport: this.loadout.wire.transport }),
        ...(wire.onPayload === undefined ? {} : { onPayload: wire.onPayload }),
        toolExecution: this.loadout.policy.tool_execution,
        convertToLlm: (messages) => messages.filter((item) => item.role === "system" || item.role === "user" || item.role === "assistant" || item.role === "toolResult"),
        getApiKey: () => this.side.apiKey(),
        prepareRequest: () => {
          sentAt = performance.now();
          return undefined;
        },
        finishTurn: async (turn) => {
          const reply = turn.message;
          if (reply.stopReason === "error" || reply.stopReason === "aborted") return undefined;
          stats.turns++;
          if (!reply.content.some((part) => part.type === "toolCall")) return undefined;
          if (overBudget()) {
            ended = "budget";
            return { action: "end" };
          }
          if (stats.turns >= this.lever.max_turns) {
            ended = "max_turns";
            return { action: "end" };
          }
          if (stats.turns === this.lever.max_turns - 1) steer = true;
          return undefined;
        },
        getSteeringMessages: async () => {
          if (!steer) return [];
          steer = false;
          return [{ role: "user", content: [{ type: "text", text: LAST_TURN }], timestamp: Date.now() }];
        },
      };
      const streamFn: StreamFn = (requestModel, context, streamOptions) => this.side.models.streamSimple(requestModel, context, { ...streamOptions, ...wire.streamOptions });
      const emit = (event: AgentEvent) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          const reply = event.message as AssistantMessage;
          this.recorder.sideRequest("critic", reply, performance.now() - sentAt);
          stats.input += reply.usage.input;
          stats.cacheRead += reply.usage.cacheRead;
          stats.cacheWrite += reply.usage.cacheWrite;
          stats.output += reply.usage.output;
          stats.reasoning += reply.usage.reasoning ?? 0;
          const cost = costOf(this.side.model, reply.usage, this.loadout.prices);
          stats.cost = cost === undefined || stats.cost === null ? null : stats.cost + cost;
        } else if (event.type === "tool_execution_start") {
          if (stats.calls.length < 20) {
            const args = event.args as Record<string, unknown> | undefined;
            const shown = typeof args?.input === "string" ? args.input : typeof args?.command === "string" ? args.command : JSON.stringify(args ?? null);
            stats.calls.push(clip(`${event.toolName}: ${shown}`, 300));
          }
        } else if (event.type === "tool_execution_end") {
          stats.toolCalls++;
        }
      };
      const first = createInitialSystemMessage(system, tools.map(toToolDeclaration));
      if (first !== undefined) history.push(first);
      const prompt: AgentMessage = { role: "user", content: [{ type: "text", text: request }], timestamp: Date.now() };
      history.push(...await runAgentLoop([prompt], { messages: [...history], tools }, config, emit, controller.signal, streamFn));
      for (let retry = 1; retry <= RETRIES; retry++) {
        const failed = history.at(-1);
        if (failed?.role !== "assistant" || failed.stopReason !== "error" || !isRetryableAssistantError(failed) || controller.signal.aborted || ended !== undefined) break;
        this.recorder.policy("retry", "critic_transient", { attempt: retry, of: RETRIES, error: failed.errorMessage });
        await new Promise((resolve) => setTimeout(resolve, 2_000 * retry));
        if (controller.signal.aborted) break;
        history.pop();
        history.push(...await runAgentLoopContinue({ messages: [...history], tools }, config, emit, controller.signal, streamFn));
      }
    } catch (error) {
      return { stop: timedOut ? "timeout" : this.signal?.aborted === true ? "aborted" : "error", final: "", stats, error: message(error).slice(0, 300) };
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener("abort", onRunAbort);
      this.running = undefined;
      // The review's cells and sessions stop before the guard looks at the workspace.
      await built?.dispose().catch(() => undefined);
    }
    const last = [...history].reverse().find((item): item is AssistantMessage => item.role === "assistant");
    const final = (last?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("").trim();
    if (timedOut) return { stop: "timeout", final, stats };
    if (this.signal?.aborted === true) return { stop: "aborted", final, stats };
    if (ended !== undefined) return { stop: ended, final, stats };
    if (last === undefined) return { stop: "error", final, stats, error: "no response" };
    if (last.stopReason === "error" || last.stopReason === "aborted") return { stop: "error", final, stats, error: (last.errorMessage ?? last.stopReason).slice(0, 300) };
    if (last.content.some((part) => part.type === "toolCall")) return { stop: "error", final, stats, error: "ended on a tool call" };
    return { stop: "verdict", final, stats };
  }

  /** The run is over: a review still running is aborted (its guard still restores). */
  close(): void {
    this.closed = true;
    this.running?.abort(new Error("run_ended"));
  }
}
