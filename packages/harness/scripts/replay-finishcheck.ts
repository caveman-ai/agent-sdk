/**
 * Offline replay (tier T0, $0) of the finish checks over recorded trials:
 *
 *   node --experimental-strip-types scripts/replay-finishcheck.ts <bench runs dir> <tag>... [--jsonl out.jsonl]
 *
 * Reads each tag's trials.jsonl (last row per trial_key, outcome solved or
 * failed) and the v3 transcript of each trial (read-only), then:
 * - test_isolation: rebuilds the test files the agent wrote from its tool
 *   calls (apply_patch Add/Update/Delete File, `cat > f <<EOF` / `tee`
 *   heredocs, the compact write and edit tools, `rm`) and runs
 *   isolationFindings on them: the same rules as the live check, with the
 *   transcript standing in for the workspace's git. A modified file's start
 *   version is what is known of it: the lines its edits removed (patch `-`
 *   lines, edit oldText) that the run had not added itself.
 * - evidence_bounce: classifies the final message the way mine2/features.py
 *   picks it (the last non-empty assistant text) and the first finish
 *   attempt (the first assistant text with no tool calls) with the default
 *   patterns.
 * Prints fire counts and the pass rate of fired vs not fired trials.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { evidenceClass, isolationFindings, testLanguage, type AgentTestFile, type EvidenceClass } from "../src/finishcheck.ts";
import { DEFAULT_EVIDENCE_PATTERNS } from "../src/prompts.ts";

const PATTERNS = {
  requirement: DEFAULT_EVIDENCE_PATTERNS.requirement.map((source) => new RegExp(source, "iu")),
  proxy: DEFAULT_EVIDENCE_PATTERNS.proxy.map((source) => new RegExp(source, "iu")),
};

/** The JS string literals of an exec cell, cooked (escapes decoded), in order. */
export function jsStrings(code: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "/" && code[i + 1] === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c !== '"' && c !== "'" && c !== "`") continue;
    let text = "";
    let j = i + 1;
    for (; j < code.length && code[j] !== c; j++) {
      if (code[j] === "\\" && j + 1 < code.length) {
        const e = code[++j]!;
        if (e === "u" && /^[0-9a-fA-F]{4}$/u.test(code.slice(j + 1, j + 5))) {
          text += String.fromCharCode(parseInt(code.slice(j + 1, j + 5), 16));
          j += 4;
        } else text += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "\n" ? "" : e;
      } else text += code[j];
      if (c !== "`" && code[j] === "\n") break;
    }
    out.push(text);
    i = j;
  }
  return out;
}

interface Written {
  created: boolean;
  lines: string[];
  /** Modified files: removed lines the run had not added, i.e. lines of the start version. */
  removed: string[];
}

/** The test files a transcript's tool calls wrote: created ones whole (later edits' added lines appended), modified ones as their added lines. */
export function writtenTestFiles(transcript: Record<string, any>[], cwd: string): AgentTestFile[] {
  const files = new Map<string, Written>();
  const norm = (path: string) => {
    let p = path.trim().replace(/^['"]|['"]$/gu, "");
    if (p.startsWith(`${cwd}/`)) p = p.slice(cwd.length + 1);
    return posix.normalize(p).replace(/^\.\//u, "");
  };
  const put = (path: string, lines: string[], whole: boolean, removed: string[] = []) => {
    const key = norm(path);
    if (testLanguage(key) === undefined) return;
    const prior = files.get(key);
    if (whole) files.set(key, { created: true, lines, removed: [] });
    else if (prior === undefined) files.set(key, { created: false, lines, removed });
    else {
      if (!prior.created) prior.removed.push(...removed.filter((line) => !prior.lines.includes(line)));
      prior.lines.push(...lines);
    }
  };
  const scan = (text: string) => {
    for (const [, verb, path, body] of text.matchAll(/^\*\*\* (Add|Update|Delete) File: ([^\n]+)\n([\s\S]*?)(?=^\*\*\* (?:Add File|Update File|Delete File|End Patch)|(?![\s\S]))/gmu)) {
      if (verb === "Delete") {
        files.delete(norm(path!));
        continue;
      }
      const lines = body!.split("\n");
      const marked = (sign: string) => lines.filter((line) => line.startsWith(sign)).map((line) => line.slice(1));
      put(path!, marked("+"), verb === "Add", marked("-"));
    }
    for (const [, append, path, , , body] of text.matchAll(/(?:\bcat|\btee(?:\s+-a)?)\s*(>>?)?\s*([^\s<>;&|]+)\s*<<-?\s*(['"]?)(\w+)\3[^\n]*\n([\s\S]*?)\n\4(?:\n|$)/gu)) {
      put(path!, body!.split("\n"), append !== ">>");
    }
    for (const [, args] of text.matchAll(/\brm\s+((?:-\S+\s+)*[^\n;&|]+)/gu)) {
      for (const arg of args!.split(/\s+/u)) if (!arg.startsWith("-") && arg !== "") files.delete(norm(arg));
    }
  };
  for (const message of transcript) {
    if (message.type !== "assistant") continue;
    for (const call of message.tool_calls ?? []) {
      const input = call.input ?? {};
      if (call.name === "exec" && typeof input.input === "string") {
        for (const literal of jsStrings(input.input)) scan(literal);
      } else if (call.name === "write" && typeof input.path === "string" && typeof input.content === "string") {
        put(input.path, input.content.split("\n"), true);
      } else if (call.name === "edit" && typeof input.path === "string") {
        const edits: { newText?: string; oldText?: string }[] = Array.isArray(input.edits) ? input.edits : [input];
        put(input.path, edits.flatMap((edit) => (edit.newText ?? "").split("\n")), false, edits.flatMap((edit) => (edit.oldText ?? "").split("\n")));
      } else if (call.name === "bash" && typeof input.command === "string") {
        scan(input.command);
      } else if (call.name === "apply_patch" && typeof input.input === "string") {
        scan(input.input);
      }
    }
  }
  return [...files].map(([path, file]) => ({
    path, created: file.created, text: file.lines.join("\n"), ...(file.created || file.removed.length === 0 ? {} : { base: file.removed.join("\n") }),
  }));
}

interface Row {
  run: string;
  ds: string;
  arm: string;
  task: string;
  passed: boolean;
  cost: number;
  iso: string[];
  iso_files: number;
  final_class: EvidenceClass;
  first_class: EvidenceClass;
  any_nonreq: boolean;
  attempts: number;
}

function trialDir(job: string): string | undefined {
  try {
    const sub = readdirSync(job).find((name) => name.includes("__") && statSync(join(job, name)).isDirectory());
    return sub === undefined ? job : join(job, sub);
  } catch {
    return undefined;
  }
}

function replay(runs: string, tags: string[]): Row[] {
  const rows: Row[] = [];
  for (const tag of tags) {
    const latest = new Map<string, Record<string, any>>();
    for (const line of readFileSync(join(runs, tag, "trials.jsonl"), "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line);
        latest.set(row.trial_key, row);
      } catch {
        // a row being written
      }
    }
    for (const row of latest.values()) {
      if (row.outcome !== "solved" && row.outcome !== "failed") continue;
      const dir = row.job === undefined ? undefined : trialDir(row.job);
      if (dir === undefined) continue;
      let transcript: Record<string, any>[];
      try {
        statSync(join(dir, "agent", "trace.jsonl"));
        transcript = readFileSync(join(dir, "agent", "transcript.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
      } catch {
        continue; // Codex or no transcript
      }
      const user = transcript.find((message) => message.type === "user");
      const userText = Array.isArray(user?.content) ? user.content.map((part: { text?: string }) => part.text ?? "").join("\n") : String(user?.content ?? "");
      const cwd = /^cwd: (\S+)$/mu.exec(userText)?.[1] ?? "/app";
      const files = writtenTestFiles(transcript, cwd);
      const findings = isolationFindings(files);
      const assistant = transcript.filter((message) => message.type === "assistant");
      const finalText = [...assistant].reverse().find((message) => message.text)?.text ?? "";
      const finishes = assistant.filter((message) => (message.tool_calls ?? []).length === 0 && (message.text ?? "").trim() !== "").map((message) => message.text as string);
      const classes = finishes.map((text) => evidenceClass(text, PATTERNS));
      rows.push({
        run: tag, ds: row.dataset, arm: row.arm, task: row.task, passed: Number(row.reward ?? 0) >= 1, cost: Number(row.proxy?.cost_usd ?? 0),
        iso: findings.map((finding) => `${finding.file} <- ${finding.from} [${finding.names.slice(0, 4).join(",")}]`), iso_files: files.length,
        final_class: evidenceClass(finalText, PATTERNS), first_class: classes[0] ?? "none", any_nonreq: classes.some((klass) => klass !== "requirement"), attempts: finishes.length,
      });
    }
  }
  return rows;
}

const rate = (rows: Row[]) => (rows.length === 0 ? "  -  " : `${rows.filter((row) => row.passed).length}/${rows.length} (${((100 * rows.filter((row) => row.passed).length) / rows.length).toFixed(1)}%)`);

/** Mantel-Haenszel risk difference, strata = task: pass(not fired) - pass(fired). */
function mhDiff(rows: Row[], fired: (row: Row) => boolean): string {
  const byTask = new Map<string, Row[]>();
  for (const row of rows) byTask.set(`${row.ds}/${row.task}`, [...(byTask.get(`${row.ds}/${row.task}`) ?? []), row]);
  let num = 0;
  let den = 0;
  for (const group of byTask.values()) {
    const yes = group.filter(fired);
    const no = group.filter((row) => !fired(row));
    if (yes.length === 0 || no.length === 0) continue;
    const w = (yes.length * no.length) / group.length;
    const p = (list: Row[]) => list.filter((row) => row.passed).length / list.length;
    num += w * (p(no) - p(yes));
    den += w;
  }
  return den === 0 ? "n/a" : `${(100 * num / den).toFixed(1)} pp (weight ${den.toFixed(1)})`;
}

function report(label: string, rows: Row[], fired: (row: Row) => boolean): void {
  const yes = rows.filter(fired);
  console.log(`${label}: n=${rows.length} fired ${yes.length} (${((100 * yes.length) / Math.max(1, rows.length)).toFixed(1)}%) | pass fired ${rate(yes)} | not fired ${rate(rows.filter((row) => !fired(row)))} | MH within-task ${mhDiff(rows, fired)}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const out = args.indexOf("--jsonl");
  const jsonl = out === -1 ? undefined : args.splice(out, 2)[1];
  const [runs, ...tags] = args;
  if (runs === undefined || tags.length === 0) throw new Error("usage: replay-finishcheck.ts <runs dir> <tag>... [--jsonl out.jsonl]");
  const rows = replay(runs, tags);
  if (jsonl !== undefined) writeFileSync(jsonl, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  console.log("== test_isolation (any created test file using another run test file's helpers)");
  for (const ds of ["deepswe", "tb4"]) {
    const set = rows.filter((row) => row.ds === ds);
    if (set.length > 0) report(`  ${ds}`, set, (row) => row.iso.length > 0);
  }
  for (const row of rows.filter((item) => item.iso.length > 0)) console.log(`    ${row.passed ? "PASS" : "fail"} ${row.run} ${row.arm} ${row.task}: ${row.iso.join("; ")}`);
  console.log("== evidence_bounce (final message names no requirement-level check)");
  const e1 = rows.filter((row) => (row.run.startsWith("r1") && row.arm.startsWith("e1")) || row.run.startsWith("anc1"));
  const capped = e1.filter((row) => row.cost <= 3);
  if (capped.length > 0) {
    report("  finalclass.py set (r1*/e1*, anc1 v3, cost <= 3), final message", capped, (row) => row.final_class !== "requirement");
    for (const klass of ["requirement", "proxy_only", "none"] as const) console.log(`    ${klass.padEnd(12)} ${rate(capped.filter((row) => row.final_class === klass))}`);
  }
  for (const tag of tags) {
    const set = rows.filter((row) => row.run === tag);
    if (set.length === 0) continue;
    report(`  ${tag} final message`, set, (row) => row.final_class !== "requirement");
    report(`  ${tag} first finish attempt`, set, (row) => row.first_class !== "requirement");
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
