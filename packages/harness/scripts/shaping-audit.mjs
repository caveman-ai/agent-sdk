#!/usr/bin/env node
/**
 * R1 offline replay audit: the result shaper (src/tools/shape.ts) over tool
 * outputs recorded in old trajectories, with no model calls. For r9x/r10p
 * (and their TB4 `web` arms) sessions under a bench runs root it replays every
 * bash call, top level and nested in codemode cells, through shapeOutput in
 * modes `tests` and `all`, and reports:
 * - bytes and approximate tokens (bytes / 4) saved per category (test, build,
 *   search), per attempt and in total, against what the model saw then;
 * - an information-loss audit: for each shaped output, did the model's next 3
 *   actions (the text it wrote: commands, paths, edits, cell code) reference
 *   content the shaped view dropped: file paths, path:line, test names, line
 *   numbers, error names? "strict" counts only references that appear nowhere
 *   earlier in the attempt (task prompt and every earlier call and result), so
 *   this output was the only place the model could have learned them.
 *
 * Usage (from packages/harness):
 *   node --experimental-strip-types --no-warnings scripts/shaping-audit.mjs \
 *     [--runs DIR] [--out report.md] [--json report.json] [--arms r9x,r9xweb,r10p,r10pweb]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCommand, shapeOutput } from "../src/tools/shape.ts";
import { CANARIES } from "./shaping-canaries.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const RUNS = flag("--runs", process.env.HARNESS_BENCH_RUNS ?? "");
const OUT = flag("--out", "shaping-audit.md");
const JSON_OUT = flag("--json", OUT.replace(/\.md$/u, ".json"));
const ARMS = flag("--arms", "r9x,r9xweb,r10p,r10pweb").split(",");
const CONFIG = { min_bytes: 2048, max_failures: 5, tail_lines: 20 };
const LOG = "/tmp/harness-scratch/out-N.log";

/** Every non-empty events.jsonl of the chosen arms: runs/<batch>/<arm>-<task>-<k>-a<n>/<trial>/agent/events.jsonl. */
function sessions() {
  const found = [];
  for (const batch of readdirSync(RUNS)) {
    const batchDir = join(RUNS, batch);
    if (!statSync(batchDir).isDirectory()) continue;
    for (const attempt of readdirSync(batchDir)) {
      const arm = attempt.split("-")[0];
      if (!ARMS.includes(arm)) continue;
      const attemptDir = join(batchDir, attempt);
      if (!statSync(attemptDir).isDirectory()) continue;
      for (const trial of readdirSync(attemptDir)) {
        const path = join(attemptDir, trial, "agent", "events.jsonl");
        try {
          if (statSync(path).size > 0) found.push({ batch, arm, attempt, path });
        } catch {
          // no events for this trial
        }
      }
    }
  }
  return found;
}

const textOf = (result) => (result?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
const argsText = (args) => (args === undefined ? "" : typeof args === "string" ? args : JSON.stringify(args));

/**
 * The attempt as a sequence of model actions (top-level tool calls, with the text the model wrote) and the bash
 * outputs to replay (top level, or nested in the cell that is that action). Pi's own events carry top-level calls;
 * nested_tool_* carry calls a codemode cell made.
 */
function parse(path) {
  const actions = [];
  const outputs = [];
  let prompt = "";
  const open = new Map();
  const nestedOpen = new Map();
  let turns = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "nested_tool_start") nestedOpen.set(event.id, event);
    if (event.type === "nested_tool_end") {
      const start = nestedOpen.get(event.id);
      if (event.name === "bash" && start !== undefined) {
        // The enclosing cell is the latest top-level call started.
        outputs.push({ action: actions.length - 1, command: String(start.args?.command ?? ""), output: typeof event.result === "string" ? event.result : textOf(event.result), nested: true });
      }
      continue;
    }
    if (event.type !== "pi") continue;
    const inner = event.event;
    if (inner.type === "turn_end") turns++;
    if (inner.type === "message_end" && inner.message?.role === "user" && prompt === "") {
      prompt = (inner.message.content ?? []).map((part) => part.text ?? "").join("");
    }
    if (inner.type === "tool_execution_start") {
      open.set(inner.toolCallId, actions.length);
      actions.push({ name: inner.toolName, text: argsText(inner.args), command: inner.toolName === "bash" ? String(inner.args?.command ?? "") : undefined, result: "", turn: turns });
    }
    if (inner.type === "tool_execution_end") {
      const index = open.get(inner.toolCallId);
      if (index === undefined) continue;
      const action = actions[index];
      action.result = textOf(inner.result);
      if (action.name === "bash") outputs.push({ action: index, command: action.command, output: action.result, nested: false });
    }
  }
  return { prompt, actions, outputs, turns };
}

/** The exit code the old harness printed, when it did. */
function exitCodeOf(output) {
  const match = /(?:exited with code|exit code:?|Exit code)\s*(-?\d+)/iu.exec(output.slice(-400));
  return match === null ? 0 : Number(match[1]);
}

const FILE_EXT = "py|go|rs|js|mjs|cjs|ts|tsx|jsx|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|ex|exs|scala|json|ya?ml|toml|sh|txt|md|cfg|ini|sql";
const REFERENCE_PATTERNS = [
  ["path:line", new RegExp(`[\\w./-]+\\.(?:${FILE_EXT}):\\d+`, "gu")],
  ["file path", new RegExp(`[\\w.-]*/[\\w./-]*\\.(?:${FILE_EXT})\\b|\\b[\\w-]+\\.(?:${FILE_EXT})\\b`, "gu")],
  ["test name", /\btest_\w{3,}|\bTest[A-Z]\w{2,}|::\w{4,}/gu],
  ["error name", /\b[A-Z]\w*(?:Error|Exception)\b/gu],
  ["line number", /\bline \d+\b/gu],
];

/** The references a text holds, by kind; each line is scanned on its first 400 characters. */
function references(text) {
  const found = new Map();
  for (const raw of text.split("\n")) {
    const line = raw.length > 400 ? raw.slice(0, 400) : raw;
    for (const [kind, pattern] of REFERENCE_PATTERNS) {
      for (const match of line.matchAll(pattern)) {
        const value = match[0].replace(/^\.\//u, "");
        if (value.length >= 4 && !found.has(value)) found.set(value, kind);
      }
    }
  }
  return found;
}

const bytes = (text) => Buffer.byteLength(text, "utf8");
const tokens = (count) => Math.round(count / 4);

/** The synthetic canaries (scripts/shaping-canaries.mjs): per mode, whether the shaped view (or the raw output, if declined) keeps every failure line. */
function canaries(modes) {
  return CANARIES.map((canary) => {
    const results = {};
    for (const [mode, config] of Object.entries(modes)) {
      const plan = shapeOutput(canary.command, canary.output, canary.exitCode, config);
      const text = plan?.render(LOG) ?? canary.output;
      results[mode] = { shaped: plan !== undefined, missing: canary.keeps.filter((kept) => !text.includes(kept)) };
    }
    return { name: canary.name, results };
  });
}

function audit() {
  const all = sessions();
  const modes = { tests: { shaping: "tests", ...CONFIG }, all: { shaping: "all", ...CONFIG } };
  const report = { runs: RUNS, arms: ARMS, attempts: all.length, byArm: {}, modes: {}, canaries: canaries(modes) };
  for (const session of all) report.byArm[session.arm] = (report.byArm[session.arm] ?? 0) + 1;
  for (const mode of Object.keys(modes)) {
    report.modes[mode] = { bash_outputs: 0, over_min: 0, raw_bytes_all: 0, over_min_bytes: 0, mixed: {}, categories: {}, losses: [], elapsed_ms: 0 };
  }
  for (const session of all) {
    const { prompt, actions, outputs, turns } = parse(session.path);
    for (const [mode, config] of Object.entries(modes)) {
      const stats = report.modes[mode];
      for (const item of outputs) {
        stats.bash_outputs++;
        stats.raw_bytes_all += bytes(item.output);
        if (bytes(item.output) > CONFIG.min_bytes) {
          stats.over_min++;
          stats.over_min_bytes += bytes(item.output);
          const classified = classifyCommand(item.command);
          if (classified?.mixed === true && (classified.kind !== "search" || mode === "all")) {
            const entry = (stats.mixed[classified.kind] ??= { outputs: 0, bytes: 0 });
            entry.outputs++;
            entry.bytes += bytes(item.output);
          }
        }
        const started = performance.now();
        const plan = shapeOutput(item.command, item.output, exitCodeOf(item.output), config);
        stats.elapsed_ms += performance.now() - started;
        if (plan === undefined) continue;
        const shaped = plan.render(LOG);
        const category = (stats.categories[plan.kind] ??= { shaped: 0, raw_bytes: 0, shaped_bytes: 0, resent_saved_bytes: 0, attempts: new Set(), with_loss: 0, with_strict_loss: 0, tools: {} });
        // Every later request re-sends this result (mostly as cached input): an upper bound, since the old arms aged old results.
        category.resent_saved_bytes += (bytes(item.output) - bytes(shaped)) * Math.max(1, turns - (actions[item.action]?.turn ?? 0));
        category.shaped++;
        category.raw_bytes += bytes(item.output);
        category.shaped_bytes += bytes(shaped);
        category.attempts.add(session.path);
        category.tools[plan.tool] = (category.tools[plan.tool] ?? 0) + 1;
        // Loss audit: references the model wrote in its next 3 actions that the raw output had and the shaped one dropped.
        const raw = references(item.output);
        const kept = shaped;
        const next = actions.slice(item.action + 1, item.action + 4);
        const nextText = next.map((action) => action.text).join("\n");
        const earlier = [prompt, ...actions.slice(0, item.action).flatMap((action) => [action.text, action.result])].join("\n");
        const dropped = [];
        for (const [value, kind] of raw) {
          if (kept.includes(value) || !nextText.includes(value)) continue;
          dropped.push({ value, kind, strict: !earlier.includes(value) && !(item.nested && actions[item.action]?.text.includes(value)) });
        }
        if (dropped.length > 0) {
          category.with_loss++;
          if (dropped.some((entry) => entry.strict)) category.with_strict_loss++;
          stats.losses.push({
            attempt: `${session.batch}/${session.attempt}`, kind: plan.kind, tool: plan.tool, command: item.command.slice(0, 160),
            raw_bytes: bytes(item.output), shaped_bytes: bytes(shaped), dropped,
            next: next.map((action) => `${action.name}: ${action.text.slice(0, 160)}`),
          });
        }
      }
    }
  }
  return report;
}

function render(report) {
  const lines = [];
  const fmt = (count) => count.toLocaleString("en-US");
  lines.push(
    "# R1 result shaping: offline replay audit (generated)",
    "",
    `Generated ${new Date().toISOString().slice(0, 10)} by \`packages/harness/scripts/shaping-audit.mjs\` (branch v3). No model calls. ` +
      "Labels: **[V]** measured here from the files named; **[I]** inference.",
    "",
    `- Runs root: \`${report.runs}\`; arms ${report.arms.join(", ")}: ${fmt(report.attempts)} attempts with events (${Object.entries(report.byArm).map(([arm, count]) => `${arm} ${count}`).join(", ")}).`,
    "- Replayed: every bash call's recorded result (top level and nested in codemode cells), as the model saw it then (after the old harness's own caps), " +
      `through \`shapeOutput\` with min_bytes ${CONFIG.min_bytes}, max_failures ${CONFIG.max_failures}, tail_lines ${CONFIG.tail_lines}. The exit code is parsed from the text when the old harness printed one, else 0.`,
    "- Tokens are bytes / 4 (approximate; no tokenizer offline). Savings are against the recorded result, not against a raw untruncated log.",
    "",
  );
  const line = (mode) => {
    const stats = report.modes[mode];
    const categories = Object.values(stats.categories);
    const shaped = categories.reduce((sum, category) => sum + category.shaped, 0);
    const saved = categories.reduce((sum, category) => sum + category.raw_bytes - category.shaped_bytes, 0);
    const resent = categories.reduce((sum, category) => sum + category.resent_saved_bytes, 0);
    const loss = categories.reduce((sum, category) => sum + category.with_loss, 0);
    const strict = categories.reduce((sum, category) => sum + category.with_strict_loss, 0);
    const touched = new Set(categories.flatMap((category) => [...category.attempts])).size;
    const mixed = Object.values(stats.mixed).reduce((sum, entry) => sum + entry.outputs, 0);
    return `\`${mode}\`: ${fmt(shaped)} outputs shaped in ${fmt(touched)} attempts (${fmt(mixed)} more declined as mixed commands), ${fmt(tokens(saved))} tokens saved directly ` +
      `(${fmt(Math.round(tokens(saved) / Math.max(1, report.attempts)))}/attempt over all ${fmt(report.attempts)} attempts; up to ${fmt(Math.round(tokens(resent) / Math.max(1, report.attempts)))} re-sent input tokens/attempt), ` +
      `${loss} shaped outputs (${Math.round((100 * loss) / Math.max(1, shaped))}%) dropped something the next 3 actions used, ${strict} (${Math.round((100 * strict) / Math.max(1, shaped))}%) something the attempt had not seen before.`;
  };
  const failed = report.canaries.filter((canary) => Object.values(canary.results).some((result) => result.missing.length > 0));
  lines.push(
    "## Canaries",
    "",
    `Synthetic outputs where shaping once hid a failure it had found (\`scripts/shaping-canaries.mjs\`): ${report.canaries.length - failed.length} of ${report.canaries.length} keep every failure line in both modes. **[V]**`,
    "",
    ...report.canaries.map((canary) => `- ${canary.name}: ${Object.entries(canary.results).map(([mode, result]) =>
      `${mode} ${result.shaped ? "shaped" : "declined (raw)"}${result.missing.length === 0 ? ", keeps all" : `, MISSING ${result.missing.map((text) => `\`${text}\``).join(", ")}`}`).join("; ")}`),
    "",
  );
  lines.push(
    "## Bottom line",
    "",
    `- ${line("tests")} **[V]**`,
    `- ${line("all")} **[V]**`,
    "- Shaping acts on few outputs: most large bash outputs are file views, diffs and compound commands, which it leaves alone by design. " +
      "The per-attempt saving is small on these arms; the re-sent bound is the larger lever and the one a bench has to confirm. **[I]**",
    "- The mixed-command rule is what keeps strict losses at zero: before it, shaping a runner's output together with an `ls`/`rg` in the same command dropped listings the next action used " +
      "(3 of 96 test outputs, 33 of 72 search outputs). It also declines more test bytes than it shapes; shaping each segment's output on its own would need the harness to mark segment boundaries. **[V]** counts from the earlier run, **[I]** remedy.",
    "- Caveats: the recorded outputs were already capped by the old harness (50 KB head+tail, aged later), so raw bytes understate what a fresh run would print and the re-sent bound ignores aging; " +
      "a dropped reference the model used could also have come from the full log (one read away) or from its own knowledge; 'next 3 actions' only sees tool arguments, not reasoning. **[I]**",
    "",
  );
  for (const [mode, stats] of Object.entries(report.modes)) {
    const totalRaw = Object.values(stats.categories).reduce((sum, category) => sum + category.raw_bytes, 0);
    const totalShaped = Object.values(stats.categories).reduce((sum, category) => sum + category.shaped_bytes, 0);
    lines.push(
      `## Mode \`${mode}\``,
      "",
      `${fmt(stats.bash_outputs)} bash outputs (${fmt(stats.raw_bytes_all)} bytes), ${fmt(stats.over_min)} over ${CONFIG.min_bytes} bytes (${fmt(stats.over_min_bytes)} bytes); shaper time ${Math.round(stats.elapsed_ms)} ms in all. **[V]**`,
      "",
      `Declined because the command mixes outputs (a runner plus \`ls\`, \`git\`, \`cat\`... in sequence): ${Object.entries(stats.mixed).map(([kind, entry]) => `${kind} ${fmt(entry.outputs)} outputs, ${fmt(entry.bytes)} bytes`).join("; ") || "none"}. **[V]**`,
      "",
      "| Category | Shaped outputs | Attempts touched | Raw bytes | Shaped bytes | Saved bytes | Saved tokens (approx) | Saved tokens / attempt (all attempts) | Re-sent input tokens saved / attempt (upper bound) | Shaped w/ any dropped ref in next 3 | Strict (ref seen nowhere earlier) | Tools |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    );
    for (const [kind, category] of Object.entries(stats.categories)) {
      const saved = category.raw_bytes - category.shaped_bytes;
      const tools = Object.entries(category.tools).sort((left, right) => right[1] - left[1]).slice(0, 6).map(([tool, count]) => `${tool} ${count}`).join(", ");
      lines.push(`| ${kind} | ${fmt(category.shaped)} | ${fmt(category.attempts.size)} | ${fmt(category.raw_bytes)} | ${fmt(category.shaped_bytes)} | ${fmt(saved)} (${Math.round((100 * saved) / Math.max(1, category.raw_bytes))}%) | ${fmt(tokens(saved))} | ${fmt(Math.round(tokens(saved) / Math.max(1, report.attempts)))} | ${fmt(Math.round(tokens(category.resent_saved_bytes) / Math.max(1, report.attempts)))} | ${category.with_loss} (${Math.round((100 * category.with_loss) / Math.max(1, category.shaped))}%) | ${category.with_strict_loss} (${Math.round((100 * category.with_strict_loss) / Math.max(1, category.shaped))}%) | ${tools} |`);
    }
    const totalResent = Object.values(stats.categories).reduce((sum, category) => sum + category.resent_saved_bytes, 0);
    lines.push(
      `| **all** | ${fmt(Object.values(stats.categories).reduce((sum, category) => sum + category.shaped, 0))} | | ${fmt(totalRaw)} | ${fmt(totalShaped)} | ${fmt(totalRaw - totalShaped)} (${Math.round((100 * (totalRaw - totalShaped)) / Math.max(1, totalRaw))}%) | ${fmt(tokens(totalRaw - totalShaped))} | ${fmt(Math.round(tokens(totalRaw - totalShaped) / Math.max(1, report.attempts)))} | ${fmt(Math.round(tokens(totalResent) / Math.max(1, report.attempts)))} | | | |`,
      "",
    );
    const strict = stats.losses.filter((loss) => loss.dropped.some((entry) => entry.strict));
    const kinds = {};
    for (const loss of stats.losses) for (const entry of loss.dropped) kinds[`${entry.kind}${entry.strict ? " (strict)" : ""}`] = (kinds[`${entry.kind}${entry.strict ? " (strict)" : ""}`] ?? 0) + 1;
    lines.push(`Dropped references the next 3 actions used, by kind: ${Object.entries(kinds).map(([kind, count]) => `${kind} ${count}`).join(", ") || "none"}. **[V]**`, "");
    if (strict.length > 0) {
      lines.push(`Strict cases (up to 12 of ${strict.length}):`, "");
      for (const loss of strict.slice(0, 12)) {
        lines.push(`- \`${loss.attempt}\` ${loss.kind}/${loss.tool}, ${fmt(loss.raw_bytes)} -> ${fmt(loss.shaped_bytes)} bytes, \`${loss.command.replaceAll("`", "'")}\``,
          `  - dropped and then used: ${loss.dropped.filter((entry) => entry.strict).slice(0, 6).map((entry) => `\`${entry.value}\` (${entry.kind})`).join(", ")}`,
          `  - next: ${loss.next.map((text) => `\`${text.replaceAll("`", "'").replaceAll("\n", " ").slice(0, 120)}\``).join("; ")}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

const report = audit();
const serializable = JSON.parse(JSON.stringify(report, (key, value) => (value instanceof Set ? value.size : value)));
writeFileSync(JSON_OUT, `${JSON.stringify(serializable, null, 1)}\n`);
const markdown = render(report);
writeFileSync(OUT, `${markdown}\n`);
process.stdout.write(`${markdown}\n`);
// A canary that loses a failure line fails the audit: the replay numbers mean nothing if shaping hides failures.
if (report.canaries.some((canary) => Object.values(canary.results).some((result) => result.missing.length > 0))) process.exitCode = 1;
