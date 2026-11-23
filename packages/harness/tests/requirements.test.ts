/**
 * prompt.requirements (P5-lite) and its placebo, offline: the extractor's
 * rules on synthetic task texts, the block it compiles to, where the block
 * lands in the first message (loopback Responses server: what the provider
 * receives), and P4's audit wording while a list is shown.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout } from "../src/loadout.ts";
import { estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { extractRequirements, requirementsBlock, requirementScore, sentencesOf } from "../src/requirements.ts";
import { isPrefix, runScripted, type Body } from "./openai-loopback.ts";

const loadoutDir = join(dirname(fileURLToPath(import.meta.url)), "..", "loadouts");
const arm = (name: string) => readLoadout(join(loadoutDir, `${name}.json`)).loadout;
const base = (name = "exec-v0") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  patch(raw);
  return normalizeLoadout(raw);
};
const firstUserText = (body: Body) => body.input.find((item: any) => item.role === "user").content[0].text as string;

const TASK = [
  "<!-- canary 1234 -->",
  "# Report generator",
  "",
  "The service at `/srv/app` builds daily reports. Some reports do not include a footer today.",
  "",
  "Your tool must run as:",
  "",
  "```bash",
  "python /srv/app/report.py --date YYYY-MM-DD --out OUT_DIR",
  "```",
  "",
  "Write the report to `OUT_DIR/report.csv` with columns in this order: date, region, total. Each total must be rounded to exactly two decimals (e.g. 1.50). " +
    "The input file is saved at `/srv/app/data.json`. The p95 latency must stay below 200 ms; retries are capped at 3 per request; the cache is warmed at start, " +
    "flushed at exit, and rebuilt whenever the configuration file changes on disk, and all logs go to the standard error stream so the operator can review them later.",
  "",
  "The following files are read-only and must not be modified:",
  "- `/srv/app/schema.py`",
  "- `/srv/app/README.md`",
  "",
  "Every report must satisfy:",
  "- Regions appear in the order of the input file, with the region named first in the configuration file always listed before every other region in the output.",
  "- Totals add up to the grand total line at the bottom of the report, which itself carries the label TOTAL in upper case.",
  "",
  "Do not add third-party dependencies. The report should be deterministic.",
  "The report should be deterministic.",
].join("\n");

const EXPECTED = [
  "Your tool must run as: `python /srv/app/report.py --date YYYY-MM-DD --out OUT_DIR`",
  "Write the report to `OUT_DIR/report.csv` with columns in this order: date, region, total.",
  "Each total must be rounded to exactly two decimals (e.g. 1.50).",
  "The p95 latency must stay below 200 ms",
  "The following files are read-only and must not be modified: `/srv/app/schema.py`; `/srv/app/README.md`",
  "Every report must satisfy:",
  "Regions appear in the order of the input file, with the region named first in the configuration file always listed before every other region in the output.",
  "Totals add up to the grand total line at the bottom of the report, which itself carries the label TOTAL in upper case.",
  "Do not add third-party dependencies.",
  "The report should be deterministic.",
];

// ---------- loadout ----------

test("prompt.requirements is off by default: absent or false normalizes and hashes like the built-in", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(plain.prompt.requirements, undefined);
    assert.equal(plain.prompt.requirements_placebo, undefined);
    const off = withLevers((raw) => (raw.prompt = { ...raw.prompt, requirements: false, requirements_placebo: false }), name);
    assert.equal(loadoutHash(off), loadoutHash(plain), `${name}: false is off`);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain));
  }
});

test("true turns it on with rules v1, 25 items and the default wording; an object overrides; the wording enters the behavior hash", () => {
  const on = withLevers((raw) => (raw.prompt.requirements = true));
  assert.deepEqual(on.prompt.requirements, {
    rules: "v1", max_items: 25, text: LEVER_TEXTS.requirements, more: LEVER_TEXTS.requirements_more, audit_text: LEVER_TEXTS.requirements_audit,
  });
  const worded = withLevers((raw) => (raw.prompt.requirements = { max_items: 5, text: "Checklist:\n{list}" }));
  assert.equal(worded.prompt.requirements?.max_items, 5);
  assert.equal(worded.prompt.requirements?.text, "Checklist:\n{list}");
  assert.notEqual(loadoutHash(worded), loadoutHash(on));
  const placebo = withLevers((raw) => {
    raw.prompt.requirements = true;
    raw.prompt.requirements_placebo = true;
  });
  assert.equal(placebo.prompt.requirements_placebo, true);
  assert.notEqual(loadoutHash(placebo), loadoutHash(on));
});

test("prompt.requirements settings fail closed: unknown keys, rules other than v1, max_items 0, no {list}, no {count}, a placebo with nothing to replace", () => {
  const bad: [string, (raw: Record<string, any>) => void, RegExp][] = [
    ["unknown key", (raw) => (raw.prompt.requirements = { items: 5 }), /items/u],
    ["rules v2", (raw) => (raw.prompt.requirements = { rules: "v2" }), /requirements/u],
    ["max_items 0", (raw) => (raw.prompt.requirements = { max_items: 0 }), /requirements/u],
    ["no {list}", (raw) => (raw.prompt.requirements = { text: "Requirements below." }), /\{list\}/u],
    ["no {count}", (raw) => (raw.prompt.requirements = { more: "More exist." }), /\{count\}/u],
    ["placebo alone", (raw) => (raw.prompt.requirements_placebo = true), /requirements_placebo needs/u],
  ];
  for (const [label, patch, message] of bad) {
    assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message), label);
  }
});

// ---------- extractor ----------

test("the extractor keeps the task's requirement sentences in its own words and task order, and nothing descriptive", () => {
  const { items, more } = extractRequirements(TASK, 25);
  assert.deepEqual(items, EXPECTED);
  assert.equal(more, 0);
  const collapsed = TASK.replace(/\s+/gu, " ");
  for (const item of items.filter((item) => !item.includes("; ") && !item.includes("--date"))) assert.ok(collapsed.includes(item), `verbatim: ${item}`);
});

test("the extractor is deterministic: same text, same list; CRLF line ends and HTML comments do not change it", () => {
  assert.deepEqual(extractRequirements(TASK, 25), extractRequirements(TASK, 25));
  assert.deepEqual(extractRequirements(TASK.replaceAll("\n", "\r\n"), 25), extractRequirements(TASK, 25));
  assert.deepEqual(extractRequirements(`<!-- a\nmultiline comment that must be ignored -->\n${TASK}`, 25), extractRequirements(TASK, 25));
});

test("over max_items the strongest units stay, in task order, and the rest are counted", () => {
  const { items, more } = extractRequirements(TASK, 3);
  assert.deepEqual(items, [EXPECTED[0], EXPECTED[2], EXPECTED[3]], "obligation + CLI, obligation + bound, obligation + bound");
  assert.equal(more, EXPECTED.length - 3);
});

test("sentences never split inside a code span or after an abbreviation; long ones split at '; ' and ' -- '", () => {
  assert.deepEqual(sentencesOf("Use `a. B` here. Then stop."), ["Use `a. B` here.", "Then stop."]);
  assert.deepEqual(sentencesOf("Round it (e.g. 1.5) as shown. Done."), ["Round it (e.g. 1.5) as shown.", "Done."]);
  assert.deepEqual(sentencesOf("Short; kept whole."), ["Short; kept whole."]);
  const long = `${"a".repeat(130)} must hold; ${"b".repeat(130)} -- c must hold too.`;
  assert.deepEqual(sentencesOf(long), [`${"a".repeat(130)} must hold`, "b".repeat(130), "c must hold too."]);
});

test("triggers: obligations, imperative 'do not' (not a descriptive one), bounds, asked-for outputs (not passive ones), CLI signatures", () => {
  assert.equal(requirementScore("Events that do not match are dropped."), 0);
  assert.equal(requirementScore("Do not edit the tests."), 3);
  assert.equal(requirementScore("Keep the API; do not rename it."), 3);
  assert.equal(requirementScore("The log is written to `/tmp/x.log`."), 0);
  assert.equal(requirementScore("Write the log to `/tmp/x.log`."), 2);
  assert.equal(requirementScore("Latency stays below 30 ms."), 2);
  assert.equal(requirementScore("Run it as `tool --fast`."), 2);
  assert.equal(requirementScore("The parser is slow."), 0);
  assert.equal(requirementScore("Install the packages from requirements.txt first."), 0, "a file name is not the word");
  assert.equal(requirementScore("It should be fast."), 1);
});

test("a lead-in absorbs a few short flat items, nested items stay under their own lead, bare formula lines are a list", () => {
  const nested = [
    "Behavior:",
    "- Parsing must accept:",
    "  - `a:b`",
    "  - `a:b:c`",
    "- Assignment errors must match exactly:",
    "  - Size mismatch between the target range and the assigned value: `range assignment size mismatch: target=<X> value=<Y>`",
    "  - Wrong value type for a string target: `range assignment expects STRING value, got <TYPE>`",
    "- Unrelated note about the history of the project.",
  ].join("\n");
  assert.deepEqual(extractRequirements(nested, 25).items, [
    "Parsing must accept: `a:b`; `a:b:c`",
    "Assignment errors must match exactly:",
    "Size mismatch between the target range and the assigned value: `range assignment size mismatch: target=<X> value=<Y>`",
    "Wrong value type for a string target: `range assignment expects STRING value, got <TYPE>`",
  ]);
  const formulas = "These must hold:\n\nx = y + z\nw < 2 * x\n";
  assert.deepEqual(extractRequirements(formulas, 25).items, ["These must hold: x = y + z; w < 2 * x"]);
});

test("nothing to list: no block (and none in the placebo arm either)", () => {
  const plain = "Fix the bug in parser.py. The parser crashes on empty input.";
  assert.deepEqual(extractRequirements(plain, 25), { items: [], more: 0 });
  assert.deepEqual(requirementsBlock(arm("exec-v0-req"), plain), { items: 0, more: 0, tokens: 0, placebo: false });
  assert.deepEqual(requirementsBlock(arm("exec-v0-reqplac"), plain), { items: 0, more: 0, tokens: 0, placebo: true });
  assert.equal(requirementsBlock(normalizeLoadout(base()), TASK), undefined, "off: undefined");
});

test("the block: the default header, numbered items, the count line when capped", () => {
  const block = requirementsBlock(arm("exec-v0-req"), TASK)!;
  const list = EXPECTED.map((item, index) => `${index + 1}. ${item}`).join("\n");
  assert.equal(block.text, LEVER_TEXTS.requirements.replace("{list}", list));
  assert.ok(block.text!.startsWith("<requirements>\n") && block.text!.endsWith("\n</requirements>"));
  assert.deepEqual({ items: block.items, more: block.more, placebo: block.placebo }, { items: 10, more: 0, placebo: false });
  assert.equal(block.tokens, estimateTokens(block.text!));
  const capped = requirementsBlock(withLevers((raw) => (raw.prompt.requirements = { max_items: 3 })), TASK)!;
  assert.ok(capped.text!.endsWith(`3. ${EXPECTED[3]}\n[7 more requirement sentences in the task are not listed here]\n</requirements>`), capped.text ?? "");
});

test("the placebo block: neutral text of the block's estimated token count, deterministic, asking for nothing", () => {
  const real = requirementsBlock(arm("exec-v0-req"), TASK)!.text!;
  const neutral = requirementsBlock(arm("exec-v0-reqplac"), TASK)!;
  assert.equal(neutral.text, placeboFor("requirements", real));
  assert.equal(estimateTokens(neutral.text!), estimateTokens(real));
  assert.equal(neutral.placebo, true);
  assert.doesNotMatch(neutral.text!, /\b(?:must|requirements?|exactly|should|report|csv|\d)\b/iu);
});

// ---------- over the wire ----------

test("exec-v0-req over the wire: the block follows the task in the first message, once, the same on every trial; later requests extend it", async () => {
  const block = requirementsBlock(arm("exec-v0-req"), TASK)!.text!;
  const run = await runScripted(arm("exec-v0-req"), [{ exec: 'text("hi");' }, { text: "Done." }], { prompt: TASK });
  assert.equal(run.bodies.length, 2);
  const first = firstUserText(run.bodies[0]!);
  assert.ok(first.endsWith(`${TASK}\n\n${block}`), first);
  assert.ok(isPrefix(run.bodies[0]!, run.bodies[1]!));
  assert.equal(JSON.stringify(run.bodies[1]).split("numbered by the harness").length - 1, 1, "appended once");
  assert.match(readFileSync(run.tracePath, "utf8"), /"action":"orient","reason":"requirements","items":10,"more":0,"tokens":\d+,"placebo":false/u);
  const again = await runScripted(arm("exec-v0-req"), [{ text: "Done." }], { prompt: TASK });
  const strip = (text: string) => text.slice(text.indexOf("</env>"));
  assert.equal(strip(firstUserText(again.bodies[0]!)), strip(first), "byte-identical across trials");
});

test("exec-v0-req with nothing to list sends exactly what exec-v0 sends", async () => {
  const prompt = "Fix the bug in parser.py.";
  const control = await runScripted(normalizeLoadout(base()), [{ text: "Done." }], { prompt });
  const req = await runScripted(arm("exec-v0-req"), [{ text: "Done." }], { prompt });
  const strip = (text: string) => text.slice(text.indexOf("</env>"));
  assert.equal(strip(firstUserText(req.bodies[0]!)), strip(firstUserText(control.bodies[0]!)));
  assert.match(readFileSync(req.tracePath, "utf8"), /"reason":"requirements","items":0/u);
});

test("exec-v0-reqplac over the wire: the same place gets the neutral block", async () => {
  const neutral = requirementsBlock(arm("exec-v0-reqplac"), TASK)!.text!;
  const run = await runScripted(arm("exec-v0-reqplac"), [{ text: "Done." }], { prompt: TASK });
  assert.ok(firstUserText(run.bodies[0]!).endsWith(`${TASK}\n\n${neutral}`));
  assert.ok(!JSON.stringify(run.bodies[0]).includes("numbered by the harness"));
  assert.match(readFileSync(run.tracePath, "utf8"), /"reason":"requirements","items":10,"more":0,"tokens":\d+,"placebo":true/u);
});

test("order in the first message: task, requirement list, P6 time line, P3 orientation", async () => {
  const loadout = withLevers((raw) => {
    raw.prompt.requirements = true;
    raw.prompt.time_budget = true;
    raw.policy.discovery = true;
  });
  const run = await runScripted(loadout, [{ text: "Done." }], {
    prompt: TASK, budgets: { wall_s: 600 },
    setup: (cwd) => {
      mkdirSync(join(cwd, "tests"));
      writeFileSync(join(cwd, "tests", "test_report.py"), "def test_x():\n    pass\n");
    },
  });
  const first = firstUserText(run.bodies[0]!);
  const at = [TASK, "<requirements>", "minutes of wall time", "<orientation>"].map((marker) => first.indexOf(marker));
  assert.ok(at.every((index) => index >= 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, `order: ${JSON.stringify(at)}`);
});

// ---------- P4 with the list ----------

test("exec-v0-req4: the audit asks for each numbered item; trace names the list size", async () => {
  const run = await runScripted(arm("exec-v0-req4"), [{ text: "Done." }, { text: "Done, audited." }, { text: "never sent" }], { prompt: TASK });
  assert.equal(run.bodies.length, 2);
  assert.deepEqual(run.bodies[1]!.input.at(-1), { role: "user", content: [{ type: "input_text", text: LEVER_TEXTS.requirements_audit }] });
  assert.ok(isPrefix(run.bodies[0]!, run.bodies[1]!));
  assert.match(readFileSync(run.tracePath, "utf8"), /"action":"continue","reason":"finish_audit","n":1,"list":10/u);
});

test("P4 keeps its own wording without a shown list: P4 alone, an empty list, or the placebo block", async () => {
  const audit = async (loadout: ReturnType<typeof arm>, prompt: string) => {
    const run = await runScripted(loadout, [{ text: "Done." }, { text: "Done, audited." }], { prompt });
    return (run.bodies[1]!.input.at(-1) as { content: { text: string }[] }).content[0]!.text;
  };
  assert.equal(await audit(arm("exec-v0-p4"), TASK), LEVER_TEXTS.finish_audit);
  assert.equal(await audit(arm("exec-v0-req4"), "Fix the bug in parser.py."), LEVER_TEXTS.finish_audit);
  const placebo4 = withLevers((raw) => {
    raw.prompt.requirements = true;
    raw.prompt.requirements_placebo = true;
    raw.policy.finish_audit = true;
  });
  assert.equal(await audit(placebo4, TASK), LEVER_TEXTS.finish_audit);
});
