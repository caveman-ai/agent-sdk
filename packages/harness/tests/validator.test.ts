/**
 * policy.validator, offline (pure rules, the faux model on a LocalEnv, and the
 * loopback Responses server for what the provider receives; no network):
 * - the loadout: off by default (built-ins hash as before), the defaults, fail-closed settings, the arms;
 * - the rules: the program block, the PASS/FAIL/END lines, clustering, the survey;
 * - in a run: the generation runs beside the first request and never delays it; the program never reaches a
 *   model-visible message, the workspace or the scratch dir while the implementer works; FAIL lines continue the
 *   run once with clustered findings; PASS-only, a broken program or no program let it end; max_rounds; the
 *   placebo; the snapshot registration; the side call's usage and cost in the run's totals and its USD budget;
 *   a generation still running when the run ends is aborted and still counted;
 * - over the wire: the side call goes to the run's own base URL at the lever's effort, with no tools;
 * - an end-to-end dry run on a tiny fake task (a real check program finds a real bug, the fix passes).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { FauxResponseStep, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { estimateTokens, LEVER_TEXTS, placeboFor, VALIDATOR_PROMPT } from "../src/prompts.ts";
import { runHarness, type RunOptions } from "../src/run.ts";
import { clusterFindings, parseCheckOutput, parseProgram, parseSurvey, SURVEY_COMMAND, validatorRequest } from "../src/validator.ts";
import { eventsOf, type Body, type Step } from "./openai-loopback.ts";

const loadoutDir = join(import.meta.dirname, "..", "loadouts");
const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  patch(raw);
  return normalizeLoadout(raw);
};
const validatorOn = (settings: boolean | Record<string, unknown> = true, placebo = false) => withLevers((raw) => {
  raw.policy.validator = settings;
  if (placebo) raw.policy.validator_placebo = true;
});

// ---------- loadout ----------

describe("validator", { concurrency: 4 }, () => {
test("validator is off by default: absent or false normalizes and hashes like the built-ins", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(plain.policy.validator, undefined);
    assert.equal(plain.policy.validator_placebo, undefined);
    const off = withLevers((raw) => {
      raw.policy = { ...raw.policy, validator: false, validator_placebo: false };
    }, name);
    assert.equal(loadoutHash(off), loadoutHash(plain), `${name}: false is off`);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain));
  }
});

test("true turns it on with the defaults; each setting enters the behavior hash", () => {
  const on = validatorOn();
  assert.deepEqual(on.policy.validator, {
    effort: "medium", max_rounds: 1, check_timeout_s: 300, gen_timeout_s: 600, max_output_tokens: 32000, listing_bytes: 4096, max_findings: 8,
    prompt: VALIDATOR_PROMPT, text: LEVER_TEXTS.validator,
  });
  for (const change of [{ effort: "high" }, { max_rounds: 2 }, { check_timeout_s: 60 }, { prompt: "Write checks." }, { text: "Problems:\n{items}" }]) {
    assert.notEqual(loadoutHash(validatorOn(change)), loadoutHash(on), JSON.stringify(change));
  }
  assert.notEqual(loadoutHash(validatorOn(true, true)), loadoutHash(on), "the placebo is its own arm");
});

test("the settings fail closed: unknown keys, a text without {items}, bad numbers, a placebo with nothing to replace", () => {
  assert.throws(() => validatorOn({ rounds: 2 }), LoadoutError);
  assert.throws(() => validatorOn({ text: "Fix it." }), /\{items\}/u);
  assert.throws(() => validatorOn({ max_rounds: 0 }), LoadoutError);
  assert.throws(() => validatorOn({ check_timeout_s: 1 }), LoadoutError);
  assert.throws(() => validatorOn({ effort: "off" }), LoadoutError);
  assert.throws(() => withLevers((raw) => (raw.policy.validator_placebo = true)), /validator_placebo needs policy.validator/u);
});

test("the arms: exec-v0-val turns on exactly the validator; exec-v0-valplac adds its placebo", () => {
  const val = readLoadout(join(loadoutDir, "exec-v0-val.json")).loadout;
  const plac = readLoadout(join(loadoutDir, "exec-v0-valplac.json")).loadout;
  assert.equal(val.policy.validator?.text, LEVER_TEXTS.validator);
  assert.equal(val.policy.validator_placebo, undefined);
  assert.equal(plac.policy.validator_placebo, true);
  const { validator: _validator, ...policy } = val.policy;
  assert.deepEqual({ ...val, name: "", policy }, { ...readLoadout("exec-v0").loadout, name: "" });
});

// ---------- rules ----------

test("parseProgram: the first python or shell block; an untagged block by its shebang; nothing else", () => {
  assert.deepEqual(parseProgram("Here:\n```python\nprint('PASS R1 x')\n```\n"), { lang: "python", code: "print('PASS R1 x')\n" });
  assert.deepEqual(parseProgram("```py\nx = 1\n```"), { lang: "python", code: "x = 1\n" });
  assert.deepEqual(parseProgram("```bash\necho END 0 0\n```"), { lang: "bash", code: "echo END 0 0\n" });
  assert.deepEqual(parseProgram("```sh\necho hi\n```"), { lang: "sh", code: "echo hi\n" });
  assert.deepEqual(parseProgram("```\n#!/usr/bin/env python3\nprint(1)\n```"), { lang: "python", code: "#!/usr/bin/env python3\nprint(1)\n" });
  assert.deepEqual(parseProgram("```json\n{}\n```\n```python\nprint(2)\n```"), { lang: "python", code: "print(2)\n" }, "a non-program block is skipped");
  assert.equal(parseProgram("no code here"), undefined);
  assert.equal(parseProgram("```\nprint(1)\n```"), undefined, "an untagged block without a shebang is not trusted");
  assert.equal(parseProgram("```python\n   \n```"), undefined);
});

test("parseCheckOutput: PASS/FAIL/END lines among noise; the reason after the first ': '; a repeated id once, FAIL over PASS", () => {
  const out = parseCheckOutput([
    "Traceback noise", "PASS R1 file exists", "FAIL R2 sums two numbers: expected 5, got 23", "FAIL R2 sums two numbers: again", "PASS R3 handles zero",
    "FAIL R3 handles zero: crashed", "FAIL R4 no reason given", "  END 2 3  ",
  ].join("\n"));
  assert.deepEqual(out.pass, [{ id: "R1", requirement: "file exists" }]);
  assert.deepEqual(out.fail, [
    { id: "R2", requirement: "sums two numbers", reason: "expected 5, got 23" },
    { id: "R3", requirement: "handles zero", reason: "crashed" },
    { id: "R4", requirement: "no reason given" },
  ]);
  assert.deepEqual(out.end, { pass: 2, fail: 3 });
  assert.equal(parseCheckOutput("PASS R1 a\nFAIL R2 b: c\n").end, undefined, "no END line: the program did not finish");
});

test("clusterFindings: one line per requirement (case and spacing folded), distinct reasons joined, capped with a count", () => {
  const { items, clusters } = clusterFindings([
    { id: "R1a", requirement: "Handles  pending versions", reason: "1 of 3 kept" },
    { id: "R1b", requirement: "handles pending versions.", reason: "1 of 3 kept" },
    { id: "R1c", requirement: "handles pending versions", reason: "flush dropped v2" },
    { id: "R2", requirement: "blocks encoded XSS", reason: "&lt;script&gt; in srcdoc passed" },
    { id: "R3", requirement: "exit code 0" },
  ], 2);
  assert.equal(clusters, 3);
  assert.equal(items, "- Handles  pending versions: 1 of 3 kept; flush dropped v2\n- blocks encoded XSS: &lt;script&gt; in srcdoc passed\n- (1 more failing requirements not listed)");
  const many = clusterFindings(["a", "b", "c", "d", "e"].map((reason, i) => ({ id: `R${i}`, requirement: "same", reason })), 8);
  assert.equal(many.items, "- same: a; b; c (+2 more)");
});

test("the survey on a real shell: interpreters, then the workspace at depth 2 with directories marked, vendored trees pruned, shallow first", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-val-survey-")));
  for (const path of ["src/deep/x.py", "src/app.py", "README.md", "node_modules/pkg/index.js", ".git/HEAD"]) {
    const full = join(cwd, path);
    await import("node:fs").then((fs) => fs.mkdirSync(join(full, ".."), { recursive: true }));
    writeFileSync(full, "x\n");
  }
  const env = new LocalEnv({ cwd });
  try {
    const run = await env.exec(SURVEY_COMMAND, { timeoutMs: 30_000, internal: true });
    const survey = parseSurvey(run.output, 4096);
    assert.match(survey.python3 ?? "", /^Python 3\./u);
    assert.equal(survey.bash, true);
    assert.deepEqual(survey.listing.split("\n"), ["README.md", "src/", "src/app.py", "src/deep/"]);
    assert.equal(parseSurvey("validator_listing=\n", 4096).listing, "(none found)");
    assert.deepEqual(parseSurvey("validator_bash=1\nvalidator_listing=\na\n", 4096), { bash: true, listing: "a" }, "no python3 line: no python3");
  } finally {
    await env.close();
  }
});

test("the request carries the task, the workdir, the interpreters, the time limit and the listing; no python3 asks for bash", () => {
  const text = validatorRequest("  Make add.py sum two numbers.\n", { cwd: "/app", os: "linux", survey: { python3: "Python 3.12.1", bash: true, listing: "add.py" }, timeoutS: 300 });
  assert.equal(text, [
    "<task>\nMake add.py sum two numbers.\n</task>", "<environment>", "workdir: /app (the program runs with this as its current directory)", "os: linux",
    "interpreters: python3 (Python 3.12.1), bash, sh", "time limit for the whole program: 300 s", "</environment>",
    "<workspace>\nFiles and directories in the workdir at the start, before any work (depth 2, may be cut):\nadd.py\n</workspace>",
    "Write the acceptance check program now.",
  ].join("\n"));
  assert.match(validatorRequest("t", { cwd: "/w", survey: { bash: true, listing: "x" }, timeoutS: 60 }), /interpreters: bash, sh \(no python3: write bash\)/u);
});

// ---------- in a run ----------

const MARKER = "VALIDATOR-SECRET-7f3a";
/** A python check program printing `lines` (and END unless `end` is false); `extra` code runs first. */
const program = (lines: string[], options: { end?: boolean; extra?: string } = {}) => {
  const pass = lines.filter((line) => line.startsWith("PASS")).length;
  const fail = lines.filter((line) => line.startsWith("FAIL")).length;
  const body = [`# ${MARKER}`, options.extra ?? "", ...lines.map((line) => `print(${JSON.stringify(line)})`), options.end === false ? "" : `print("END ${pass} ${fail}")`];
  return `\`\`\`python\n${body.filter((line) => line !== "").join("\n")}\n\`\`\``;
};

const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const textOf = (message: { content: unknown } | undefined) =>
  message === undefined ? "" : typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastUser = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "user");
const policyEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`);

/** Every file under `dir` (recursively), with its text when small. */
function filesUnder(dir: string): { path: string; text: string }[] {
  if (!existsSync(dir)) return [];
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const path = join(dir, entry);
    if (!statSync(path).isFile()) continue;
    out.push({ path: entry, text: statSync(path).size < 1_000_000 ? readFileSync(path, "utf8") : "" });
  }
  return out;
}

interface Run {
  result: Awaited<ReturnType<typeof runHarness>>;
  /** Trace events (any: each test reads the fields of the events it names). */
  events: any[];
  contexts: TranscriptContext[];
  /** At each agent-loop request: files in the cwd and the scratch dir that hold the program's marker or a `.vc-` path. */
  leaks: string[];
  cwd: string;
  scratch: string;
  transcript: string;
  validatorCalls: number;
}

async function fauxRun(loadout: Loadout, steps: (FauxStep | ((context: TranscriptContext) => Promise<FauxStep>))[], validatorReplies: (FauxStep | FauxResponseStep)[], options: {
  budgets?: Budgets; cwd?: string; prompt?: string; finishSnapshot?: RunOptions["finishSnapshot"]; resultPath?: string; tracePath?: string; wrapEnv?: (env: LocalEnv) => void;
} = {}): Promise<Run> {
  const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "harness-val-run-")));
  const env = new LocalEnv({ cwd });
  options.wrapEnv?.(env);
  const scratch = await env.scratchDir();
  const contexts: TranscriptContext[] = [];
  const leaks: string[] = [];
  let validatorCalls = 0;
  const scan = () => {
    for (const [where, dir] of [["cwd", cwd], ["scratch", scratch]] as const) {
      for (const file of filesUnder(dir)) if (file.text.includes(MARKER) || file.path.includes(".vc-")) leaks.push(`${where}:${file.path}`);
    }
  };
  const scripted: FauxResponseStep[] = steps.map((step) => async (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    scan();
    return fauxStep(typeof step === "function" ? await step(context) : step);
  });
  const validator: FauxResponseStep[] = validatorReplies.map((reply) => async (context: TranscriptContext, streamOptions: SimpleStreamOptions | undefined, state, model) => {
    validatorCalls++;
    if (typeof reply === "function") return reply(context, streamOptions, state, model);
    return "role" in reply ? reply : fauxStep(reply);
  });
  const dir = mkdtempSync(join(tmpdir(), "harness-val-trace-"));
  const tracePath = options.tracePath ?? join(dir, "trace.jsonl");
  const transcriptPath = join(dir, "transcript.jsonl");
  try {
    const result = await runHarness({
      prompt: options.prompt ?? "Write result.txt containing ok.", model: "faux/val", effort: "high", loadout, env, tracePath, transcriptPath, fauxSteps: scripted,
      validatorFauxSteps: validator, ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      ...(options.finishSnapshot === undefined ? {} : { finishSnapshot: options.finishSnapshot }), ...(options.resultPath === undefined ? {} : { resultPath: options.resultPath }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    return { result, events, contexts, leaks, cwd, scratch, transcript: readFileSync(transcriptPath, "utf8"), validatorCalls };
  } finally {
    await env.close();
  }
}

const FINDINGS = LEVER_TEXTS.validator.replace("{items}", "- result file says ok: expected 'ok', got 'okay'");
const FAILING = program(["PASS R1 result file exists", "FAIL R2 result file says ok: expected 'ok', got 'okay'", "FAIL R2b result file says ok: expected 'ok', got 'okay'"]);

test("the generation starts beside the first request and never delays it; the program never reaches the implementer", async () => {
  let firstRequest!: () => void;
  const seen = new Promise<void>((done) => (firstRequest = done));
  let sawFirst = false;
  const loadout = validatorOn();
  const run = await fauxRun(loadout, [
    async () => {
      firstRequest();
      return write("result.txt", "okay\n");
    },
    { text: "Done." }, { text: "Fixed it." }, { text: "never sent" },
  ], [async () => {
    // The validator answers only once the agent loop's first request is out: a generation that blocked it would deadlock here.
    sawFirst = await Promise.race([seen.then(() => true), new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), 5_000);
      timer.unref();
    })]);
    return fauxStep({ text: FAILING });
  }]);
  assert.equal(sawFirst, true, "the first request went out while the validator's call was open");
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.usage.requests, 3);
  assert.equal(run.validatorCalls, 1);
  const first = run.events.find((event) => event.type === "request_start");
  const side = run.events.find((event) => event.type === "side_request");
  assert.ok(first.t <= side.t, "the side call ended after the first request started");
  // The wall: never in a model-visible message (every request's context, the transcript), never on disk while the implementer works.
  for (const [index, context] of run.contexts.entries()) assert.ok(!JSON.stringify(context).includes(MARKER), `request ${index + 1} saw the program`);
  assert.ok(!run.transcript.includes(MARKER));
  assert.deepEqual(run.leaks, []);
  assert.deepEqual(filesUnder(run.cwd).map((file) => file.path), ["result.txt"], "the workspace holds only the implementer's file");
  assert.deepEqual(filesUnder(run.scratch).filter((file) => file.path.includes(".vc-") || file.text.includes(MARKER)), [], "the program and its temp dir are removed");
  // The program reaches the trace once, after the agent loop's last request.
  const programAt = run.events.findIndex((event) => event.type === "validator_program");
  assert.ok(programAt > run.events.findLastIndex((event) => event.type === "request_end"));
  assert.ok(run.events[programAt].code.includes(MARKER));
  assert.equal(run.events.filter((event) => JSON.stringify(event).includes(MARKER)).length, 1, "only the validator_program event carries the code");
});

test("FAIL lines continue the run once with the clustered findings, never the program; the second finish ends the run", async () => {
  const run = await fauxRun(validatorOn(), [write("result.txt", "okay\n"), { text: "Done." }, { text: "Fixed." }, { text: "never sent" }], [{ text: FAILING }]);
  assert.equal(run.result.usage.requests, 3);
  assert.equal(textOf(lastUser(run.contexts[2]!)), FINDINGS);
  assert.deepEqual(policyEvents(run.events), ["check:validator", "check:validator", "continue:validator"]);
  const [generated, checked] = run.events.filter((event) => event.type === "policy" && event.action === "check");
  assert.deepEqual({ stage: generated.stage, lang: generated.lang, python3: typeof generated.python3 }, { stage: "generate", lang: "python", python3: "string" });
  assert.ok(generated.output_tokens > 0 && generated.bytes > 0);
  assert.deepEqual({ stage: checked.stage, round: checked.round, n_pass: checked.n_pass, n_fail: checked.n_fail, clusters: checked.clusters, bounced: checked.bounced, exit_code: checked.exit_code },
    { stage: "run", round: 1, n_pass: 1, n_fail: 2, clusters: 1, bounced: true, exit_code: 0 });
  assert.ok(checked.ms >= 0 && checked.wait_ms >= 0);
  const fired = run.events.find((event) => event.action === "continue");
  assert.deepEqual({ placebo: fired.placebo, fail_ids: fired.fail_ids, n_fail: fired.n_fail }, { placebo: false, fail_ids: ["R2", "R2b"], n_fail: 2 });
  assert.ok(!FINDINGS.includes("print(") && !FINDINGS.includes(MARKER));
});

test("PASS-only lets the run end; so do a program without END, a crashing one, a missing block or a failed generation (recorded, never a bounce)", async () => {
  const steps = () => [write("result.txt", "ok\n"), { text: "Done." }, { text: "never sent" }];
  const passing = await fauxRun(validatorOn(), steps(), [{ text: program(["PASS R1 result file says ok"]) }]);
  assert.equal(passing.result.usage.requests, 2);
  const last = passing.events.filter((event) => event.type === "policy").at(-1);
  assert.deepEqual({ reason: last.reason, n_pass: last.n_pass, n_fail: last.n_fail, bounced: last.bounced }, { reason: "validator", n_pass: 1, n_fail: 0, bounced: false });
  const broken: [string, FauxStep | FauxResponseStep, RegExp][] = [
    ["no END", { text: program(["FAIL R1 x: y"], { end: false }) }, /no END line/u],
    ["syntax error", { text: "```python\nprint('FAIL R1 x: y'\nprint('END 0 1')\n```" }, /no END line \(exit 1\)/u],
    ["crash after a FAIL", { text: program(["FAIL R1 x: y"], { extra: "print('FAIL R0 a: b'); raise SystemExit(3)" }) }, /no END line \(exit 3\)/u],
    ["no block", { text: "I cannot write checks for this." }, /no program/u],
    ["provider error", { stopReason: "error", errorMessage: "400 bad request" }, /400 bad request/u],
  ];
  for (const [label, reply, error] of broken) {
    const run = await fauxRun(validatorOn(), steps(), [reply]);
    assert.equal(run.result.usage.requests, 2, label);
    assert.equal(run.result.status, "finished", label);
    const failed = run.events.find((event) => event.reason === "validator_failed");
    assert.match(failed?.error ?? "", error, label);
    assert.ok(!policyEvents(run.events).includes("continue:validator"), label);
  }
  const unscripted = await fauxRun(validatorOn(), steps(), []);
  assert.equal(unscripted.result.usage.requests, 2);
  assert.match(unscripted.events.find((event) => event.reason === "validator_failed")?.error ?? "", /No more faux responses/u);
  assert.equal(unscripted.events.find((event) => event.reason === "validator" && event.action === "skip")?.cause, "no_program");
});

test("a program that times out is recorded and retired; a bash program runs under bash", async () => {
  let seenTimeoutMs: number | undefined;
  const slow = await fauxRun(validatorOn({ check_timeout_s: 10 }), [write("result.txt", "ok\n"), { text: "Done." }, { text: "never sent" }],
    [{ text: "```python\nimport time\nprint('FAIL R1 x: y')\ntime.sleep(60)\nprint('END 0 1')\n```" }], {
      wrapEnv(env) {
        const origExec = env.exec.bind(env);
        env.exec = (command, opts) => {
          if (opts?.timeoutMs === 10_000 && command.includes("python3")) {
            seenTimeoutMs = opts.timeoutMs;
            return origExec(command, { ...opts, timeoutMs: 250 });
          }
          return origExec(command, opts);
        };
      },
    });
  assert.equal(seenTimeoutMs, 10_000);
  assert.equal(slow.result.usage.requests, 2);
  assert.match(slow.events.find((event) => event.reason === "validator_failed")?.error ?? "", /timeout after 10 s/u);
  const bash = await fauxRun(validatorOn(), [write("result.txt", "okay\n"), { text: "Done." }, { text: "ok" }],
    [{ text: "```bash\nif [ \"$(cat result.txt)\" = ok ]; then echo 'PASS R1 says ok'; echo 'END 1 0'; else echo \"FAIL R1 says ok: got $(cat result.txt)\"; echo 'END 0 1'; fi\n```" }]);
  assert.equal(textOf(lastUser(bash.contexts[2]!)), LEVER_TEXTS.validator.replace("{items}", "- says ok: got okay"));
});

test("max_rounds: the default checks once; max_rounds 2 checks again at the next finish and bounces again while it fails", async () => {
  const steps = () => [write("result.txt", "okay\n"), { text: "Done." }, { text: "Done again." }, { text: "Done, third." }, { text: "never sent" }];
  const once = await fauxRun(validatorOn(), steps(), [{ text: FAILING }]);
  assert.equal(once.result.usage.requests, 3);
  const twice = await fauxRun(validatorOn({ max_rounds: 2 }), steps(), [{ text: FAILING }]);
  assert.equal(twice.result.usage.requests, 4);
  assert.equal(twice.validatorCalls, 1, "one generation, two runs of the program");
  assert.deepEqual(twice.events.filter((event) => event.action === "continue").map((event) => event.round), [1, 2]);
  assert.equal(textOf(lastUser(twice.contexts[3]!)), FINDINGS);
  const fixed = await fauxRun(validatorOn({ max_rounds: 2 }), [write("result.txt", "okay\n"), { text: "Done." }, write("result.txt", "ok\n"), { text: "Fixed." }, { text: "never sent" }],
    [{ text: "```python\nt = open('result.txt').read().strip()\nprint('PASS R1 says ok' if t == 'ok' else f'FAIL R1 says ok: got {t}')\nprint('END 1 0' if t == 'ok' else 'END 0 1')\n```" }]);
  assert.equal(fixed.result.usage.requests, 4, "round 2 passes: no second bounce");
  assert.deepEqual(fixed.events.filter((event) => event.reason === "validator" && event.stage === "run").map((event) => event.bounced), [true, false]);
});

test("the placebo keeps the generation, the check and the trigger, and sends neutral text of the findings' estimated token count", async () => {
  const run = await fauxRun(validatorOn(true, true), [write("result.txt", "okay\n"), { text: "Done." }, { text: "Done." }, { text: "never sent" }], [{ text: FAILING }]);
  assert.equal(run.result.usage.requests, 3);
  const sent = textOf(lastUser(run.contexts[2]!));
  assert.equal(sent, placeboFor("validator", FINDINGS));
  assert.equal(estimateTokens(sent), estimateTokens(FINDINGS));
  assert.doesNotMatch(sent, /\b(?:check|requirement|result|fix|finish|problem)\w*/iu);
  const fired = run.events.find((event) => event.action === "continue");
  assert.equal(fired.placebo, true);
  assert.equal(fired.findings, "- result file says ok: expected 'ok', got 'okay'", "the trace keeps what the real arm would have sent");
  const clean = await fauxRun(validatorOn(true, true), [write("result.txt", "ok\n"), { text: "Done." }, { text: "never sent" }], [{ text: program(["PASS R1 ok"]) }]);
  assert.equal(clean.result.usage.requests, 2, "no failing check: no placebo either");
});

test("order and guards: the validator goes after evidence_bounce; under the 90% budget guard it skips once", async () => {
  const both = withLevers((raw) => {
    raw.policy.evidence_bounce = true;
    raw.policy.validator = true;
  });
  const run = await fauxRun(both, [write("result.txt", "okay\n"), { text: "Done." }, { text: "Done." }, { text: "Done." }, { text: "never sent" }], [{ text: FAILING }]);
  assert.deepEqual(run.events.filter((event) => event.action === "continue").map((event) => event.reason), ["evidence_bounce", "validator"]);
  assert.equal(run.result.usage.requests, 4);
  const steps = [...Array.from({ length: 9 }, (_, i) => write(`f${i}.txt`, "x\n")), { text: "Done." }, { text: "never sent" }];
  const near = await fauxRun(validatorOn(), steps, [{ text: FAILING }], { budgets: { requests: 11 } });
  assert.equal(near.result.usage.requests, 10, "10 of 11 requests used at the finish: no check");
  assert.deepEqual(near.events.filter((event) => event.action === "skip").map((event) => [event.reason, event.budget]), [["validator", "requests"]]);
});

test("snapshot: a validator bounce is a finish lever that fires, so --finish-snapshot fired archives the first-finish workspace; a clean check is not_fired", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-val-snap-"));
  const run = await fauxRun(validatorOn(), [write("result.txt", "okay\n"), { text: "Done." }, write("result.txt", "ok\n"), { text: "Fixed." }, { text: "never sent" }], [{ text: FAILING }], {
    finishSnapshot: { mode: "fired" }, resultPath: join(dir, "result.json"),
  });
  const ff = run.result.first_finish!;
  assert.deepEqual({ levers: ff.levers_pending, request: ff.request_index, skipped: ff.skipped }, { levers: ["validator"], request: 2, skipped: undefined });
  assert.ok(ff.path !== undefined && existsSync(ff.path));
  const listing = await import("node:child_process").then(({ execFileSync }) => execFileSync("tar", ["-xzOf", ff.path!, "./result.txt"]).toString());
  assert.equal(listing, "okay\n", "the archive is the workspace the model tried to finish with, before the fix");
  const dir2 = mkdtempSync(join(tmpdir(), "harness-val-snap-"));
  const clean = await fauxRun(validatorOn(), [write("result.txt", "ok\n"), { text: "Done." }], [{ text: program(["PASS R1 ok"]) }], {
    finishSnapshot: { mode: "fired" }, resultPath: join(dir2, "result.json"),
  });
  assert.equal(clean.result.first_finish?.skipped, "not_fired");
});

test("cost: the side call's tokens and USD are in usage and cost_usd and in side_requests.validator; requests stay the agent loop's", async () => {
  const run = await fauxRun(validatorOn(), [write("result.txt", "okay\n"), { text: "Done." }, { text: "Fixed." }], [{ text: FAILING }]);
  const loop = run.events.filter((event) => event.type === "request_end");
  const side = run.events.filter((event) => event.type === "side_request");
  assert.equal(side.length, 1);
  assert.equal(side[0].kind, "validator");
  const sum = (key: string, events: Record<string, any>[]) => events.reduce((total, event) => total + event.usage[key], 0);
  assert.equal(run.result.usage.requests, loop.length);
  assert.equal(run.result.usage.output_tokens, sum("output", loop) + sum("output", side));
  assert.equal(run.result.usage.input_tokens, sum("input", loop) + sum("input", side));
  const loopCost = loop.reduce((total, event) => total + event.cost_usd, 0);
  assert.ok(side[0].cost_usd > 0);
  // Each event rounds cost_usd to 6 decimals (±5e-7), while result.cost_usd rounds the unrounded sum.
  assert.ok(Math.abs(run.result.cost_usd! - (loopCost + side[0].cost_usd)) <= (loop.length + side.length + 1) * 5e-7 + 1e-12);
  assert.deepEqual(run.result.side_requests?.validator && { requests: run.result.side_requests.validator.requests, output: run.result.side_requests.validator.output_tokens },
    { requests: 1, output: side[0].usage.output });
  const generated = run.events.find((event) => event.reason === "validator" && event.stage === "generate");
  assert.equal(generated.output_tokens, side[0].usage.output);
});

test("the USD budget sees the side call: an expensive generation stops the run at the next turn's budget check", async () => {
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-val-usd-")), "trace.jsonl");
  const big = `${program(["PASS R1 ok"]).slice(0, -3)}${"#".repeat(24_000)}\n\`\`\``;
  const run = await fauxRun(validatorOn(), [async () => {
    // The agent loop's first turn ends only after the side call is on the books.
    for (let i = 0; i < 400 && !(existsSync(tracePath) && readFileSync(tracePath, "utf8").includes('"side_request"')); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    return write("result.txt", "ok\n");
  }, { text: "Done." }], [{ text: big }], { budgets: { usd: 0.01 }, tracePath });
  assert.equal(run.result.status, "stopped");
  assert.equal(run.result.stop_reason, "budget_usd");
  assert.equal(run.result.usage.requests, 1);
  assert.ok((run.result.side_requests?.validator?.cost_usd ?? 0) >= 0.01, "the side call alone crossed the cap");
});

test("a generation still running when the run ends is aborted, counted, and never checked", async () => {
  const started = performance.now();
  const run = await fauxRun(validatorOn(), [write("result.txt", "ok\n"), { text: "never sent" }], [async (_context, options) => {
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted === true) resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxStep({ text: FAILING });
  }], { budgets: { requests: 1 } });
  assert.equal(run.result.stop_reason, "budget_requests");
  assert.ok(performance.now() - started < 20_000, "the run did not wait for the generation");
  assert.equal(run.result.side_requests?.validator?.requests, 1);
  assert.ok(!policyEvents(run.events).includes("continue:validator"));
  assert.ok(["aborted", "error"].includes(run.events.find((event) => event.type === "side_request")?.stop_reason), "the call was cut off (faux says error, providers aborted)");
  assert.ok(!run.events.some((event) => event.reason === "validator" && event.stage === "run"), "never checked");
});

test("the finish waits for a generation still running, then checks (wait_ms)", async () => {
  const run = await fauxRun(validatorOn(), [write("result.txt", "okay\n"), { text: "Done." }, { text: "Fixed." }], [async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return fauxStep({ text: FAILING });
  }]);
  const checked = run.events.find((event) => event.reason === "validator" && event.stage === "run");
  assert.ok(checked.wait_ms >= 200, `waited ${checked.wait_ms} ms`);
  assert.equal(run.result.usage.requests, 3);
});

test("a check that writes into the workspace is named in the trace (workspace_changed); PYTHONDONTWRITEBYTECODE keeps imports clean", async () => {
  const run = await fauxRun(validatorOn(), [write("mod.py", "X = 1\n"), { text: "Done." }, { text: "ok" }],
    [{ text: program(["PASS R1 imports"], { extra: "import sys; sys.path.insert(0, '.'); import mod; open('stray.txt', 'w').write('x')" }) }]);
  const checked = run.events.find((event) => event.reason === "validator" && event.stage === "run");
  assert.deepEqual(checked.workspace_changed, ["./stray.txt"]);
  assert.ok(!existsSync(join(run.cwd, "__pycache__")), "no bytecode written by the check's import");
});

// ---------- over the wire ----------

test("over the wire (exec-v0-val): the side call goes to the run's own base URL at medium effort, with no tools, the task and listing only", async () => {
  const bodies: Body[] = [];
  const sideBodies: Body[] = [];
  const steps: Step[] = [
    { exec: 'await tools.apply_patch("*** Begin Patch\\n*** Add File: result.txt\\n+okay\\n*** End Patch\\n"); text("written");' },
    { text: "Done." }, { text: "Fixed." },
  ];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Body;
      const side = JSON.stringify(body).includes("You write acceptance checks");
      if (side) sideBodies.push(body);
      else bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const step: Step = side ? { text: FAILING } : steps[bodies.length - 1] ?? { text: "Done." };
      res.end(eventsOf(step, side ? 900 : bodies.length).map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-val-wire-")));
  writeFileSync(join(cwd, "README.md"), "hello\n");
  const env = new LocalEnv({ cwd });
  process.env.LOOPBACK_KEY = "sk-test";
  try {
    const loadout = readLoadout(join(loadoutDir, "exec-v0-val.json")).loadout;
    const result = await runHarness({
      prompt: "Write result.txt containing ok.", model: "openai/gpt-6.1-sol", effort: "high", loadout, env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LOOPBACK_KEY" },
    });
    assert.equal(result.status, "finished");
    assert.equal(sideBodies.length, 1, "one side call, to the run's own base URL");
    assert.equal(bodies.length, 3);
    const side = sideBodies[0]!;
    assert.equal(side.model, "gpt-6.1-sol");
    assert.equal(side.reasoning?.effort, "medium");
    assert.equal(side.tools, undefined);
    const sideText = JSON.stringify(side);
    assert.ok(sideText.includes("Write result.txt containing ok.") && sideText.includes("README.md"));
    assert.ok(!sideText.includes("apply_patch"), "the validator sees nothing of the implementer's surface");
    assert.notEqual(side.prompt_cache_key, bodies[0]!.prompt_cache_key, "its own cache key");
    for (const body of bodies) assert.ok(!JSON.stringify(body).includes(MARKER), "no agent request carries the program");
    const lastInput = bodies[2]!.input.at(-1);
    assert.deepEqual(lastInput, { role: "user", content: [{ type: "input_text", text: FINDINGS }] });
    assert.equal(result.side_requests?.validator?.requests, 1);
    assert.equal(result.usage.input_tokens, 400, "3 agent requests and the side call at 100 input tokens each");
    assert.ok(result.cost_usd !== null && result.cost_usd > 0);
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
});

// ---------- end to end ----------

test("dry run on a tiny fake task: the validator's own program finds a stated edge case the implementer missed, the fix passes it", async () => {
  const task = "Create add.py with a function add(a, b) that returns the sum of two integers. It must also accept integers given as strings, so add('2', '3') == 5.";
  const checker = [
    "```python",
    "import importlib.util, os, shutil, sys, tempfile",
    "work = tempfile.mkdtemp()",
    "results = []",
    "def check(cid, req, fn):",
    "    try:",
    "        ok, why = fn()",
    "    except Exception as error:",
    "        ok, why = False, f'{type(error).__name__}: {error}'",
    "    print(f'PASS {cid} {req}' if ok else f'FAIL {cid} {req}: {why}')",
    "    results.append(ok)",
    "def load():",
    "    shutil.copy('add.py', os.path.join(work, 'add.py'))",
    "    spec = importlib.util.spec_from_file_location('add_under_test', os.path.join(work, 'add.py'))",
    "    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod",
    "def ints():",
    "    got = load().add(2, 3); return got == 5, f'add(2, 3) expected 5, got {got!r}'",
    "def strings():",
    "    got = load().add('2', '3'); return got == 5, f\"add('2', '3') expected 5, got {got!r}\"",
    "def negative():",
    "    got = load().add('-4', 1); return got == -3, f\"add('-4', 1) expected -3, got {got!r}\"",
    "check('R1', 'add returns the sum of two integers', ints)",
    "check('R2', 'add accepts integers given as strings', strings)",
    "check('R2b', 'add accepts integers given as strings', negative)",
    "print(f'END {sum(results)} {len(results) - sum(results)}')",
    "```",
  ].join("\n");
  const run = await fauxRun(validatorOn(), [
    write("add.py", "def add(a, b):\n    return a + b\n"),
    { text: "add.py is done: add(2, 3) returns 5." },
    write("add.py", "def add(a, b):\n    return int(a) + int(b)\n"),
    { text: "add.py now converts both arguments with int()." },
    { text: "never sent" },
  ], [{ text: checker }], { prompt: task });
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.usage.requests, 4);
  assert.equal(readFileSync(join(run.cwd, "add.py"), "utf8"), "def add(a, b):\n    return int(a) + int(b)\n");
  const findings = textOf(lastUser(run.contexts[2]!));
  assert.equal(findings, LEVER_TEXTS.validator.replace("{items}", "- add accepts integers given as strings: add('2', '3') expected 5, got '23'; TypeError: can only concatenate str (not \"int\") to str"));
  assert.deepEqual(policyEvents(run.events), ["check:validator", "check:validator", "continue:validator"]);
  assert.deepEqual(filesUnder(run.cwd).map((file) => file.path), ["add.py"], "the check worked on a copy");
  assert.deepEqual(run.leaks, []);
  // The flow: the first request goes out, the generation lands beside it, the finish runs the check, the findings go out, the fix, the end.
  const flow = run.events.filter((event) => ["request_start", "side_request", "policy", "validator_program", "stop"].includes(event.type))
    .map((event) => (event.type === "policy" ? `${event.action}:${event.reason}${event.stage === undefined ? "" : `:${event.stage}`}` : event.type));
  assert.equal(flow[0], "request_start");
  assert.deepEqual(flow.filter((item) => item !== "request_start").slice(0, 2), ["side_request", "check:validator:generate"]);
  assert.deepEqual(flow.slice(flow.indexOf("check:validator:run")), [
    "check:validator:run", "continue:validator", "request_start", "request_start", "validator_program", "stop",
  ]);
  const checked = run.events.find((event) => event.reason === "validator" && event.stage === "run");
  assert.deepEqual({ n_pass: checked.n_pass, n_fail: checked.n_fail, clusters: checked.clusters }, { n_pass: 1, n_fail: 2, clusters: 1 });
});
});
