/**
 * D4 effort de-escalation, offline: the read-only command test, the loadout
 * flag, and which requests run lowered, by a scripted faux model (the trace's
 * per-request effort and reason) and the loopback Responses server (the
 * `reasoning.effort` the provider receives, on compact-v0-plain and exec-v0).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { readOnlyCommand } from "../src/evidence.ts";
import { readsRed } from "../src/levers.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout } from "../src/loadout.ts";
import { fauxStep, type Effort, type FauxStep } from "../src/models.ts";
import { DEFAULT_FINISH_PATTERNS } from "../src/prompts.ts";
import { runHarness } from "../src/run.ts";
import { isPrefix, runScripted, type Body, type Step } from "./openai-loopback.ts";

const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  patch(raw);
  return normalizeLoadout(raw);
};
const d4 = (settings: unknown = true, name?: string) => withLevers((raw) => (raw.depth = { deescalate: settings }), name);

const traceOf = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
const starts = (events: Record<string, any>[]) => events.filter((event) => event.type === "request_start");

async function fauxRun(loadout: ReturnType<typeof normalizeLoadout>, steps: FauxStep[], options: { effort?: Effort; setup?: (cwd: string) => void } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-d4-")));
  options.setup?.(cwd);
  const env = new LocalEnv({ cwd });
  const scripted: FauxResponseStep[] = steps.map((step) => () => fauxStep(step));
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-d4-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({ prompt: "do the task", model: "faux/d4", effort: options.effort ?? "high", loadout, env, tracePath, fauxSteps: scripted });
    const events = traceOf(tracePath);
    return { result, events, efforts: starts(events).map((event) => event.effort), reasons: starts(events).map((event) => event.effort_reason) };
  } finally {
    await env.close();
  }
}

const read = (path = "a.txt"): FauxStep => ({ toolCalls: [{ name: "read", arguments: { path } }] });
const bash = (command: string, timeout?: number): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command, ...(timeout === undefined ? {} : { timeout }) } }] });
const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const files = (cwd: string) => {
  writeFileSync(join(cwd, "a.txt"), "x\n");
  writeFileSync(join(cwd, "check.sh"), "grep -q ok a.txt && echo 'all passed' || { echo '1 failed'; exit 1; }\n");
};

// ---------- the read-only command test ----------

test("readOnlyCommand: reads, listings, searches and git reads are read-only", () => {
  for (const command of [
    "ls -la", "cat a.txt", "rg -n 'def main' src", "grep -rn foo . | head -20", "git status", "git diff HEAD~1 -- src/a.py", "git log --oneline -5",
    "git -C /app --no-pager show HEAD:a.txt", "cd /app && ls && cat README.md", "sed -n '1,40p' a.py", "find . -name '*.py' -not -path './.git/*'",
    "find . -name '*.py' -exec grep -l foo {} +", "wc -l $(git ls-files)", "head -c 200 a.bin | xxd", "tail -n 50 /tmp/log 2>/dev/null",
    "for f in *.py; do wc -l $f; done", "if [ -f x ]; then cat x; fi", "python3 --version", "git ls-files | xargs wc -l", "timeout 10 rg foo",
    "sleep 2; echo done", "ps aux | grep python", "git branch -a", "git stash list", "npm ls --depth 0", "pip list", "jq .name package.json",
    "cat <<'EOF'\nhello\nEOF",
  ]) assert.equal(readOnlyCommand(command), true, command);
});

test("readOnlyCommand: writes, checks, process control, installs, unknown programs and workspace binaries are not", () => {
  for (const command of [
    "", "pytest -q", "sh check.sh", "python3 -c 'print(1)'", "make", "sed -i 's/a/b/' a.py", "echo x > a.txt", "cat a b >> c", "ls | tee out.txt",
    "rm -f a", "touch a", "mkdir -p b", "cp a b", "git checkout a.py", "git stash", "git branch new-branch", "git tag v1", "git config user.name x",
    "pip install foo", "npm install", "curl https://example.com", "kill 123", "pkill -f server", "find . -name '*.pyc' -delete",
    "find . -exec rm {} \\;", "awk '{ print > \"out\" }' a", "sort -o a.txt a.txt", "./ls", "/app/bin/cat a", "cat $(touch x)", "ls `rm -f a`",
    "eval ls", "source env.sh", "xargs rm", "uniq a b", "date -s 2020-01-01", "ls && pytest", "node server.js",
  ]) assert.equal(readOnlyCommand(command), false, command);
});

// ---------- loadout ----------

test("D4 is off by default: absent or false normalizes and hashes like the built-ins", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(plain.depth?.deescalate, undefined);
    assert.equal(loadoutHash(d4(false, name)), loadoutHash(plain), name);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain), name);
  }
});

test("D4 true is to medium on reads and polls with the default finish patterns; settings override; bad settings fail closed", () => {
  assert.deepEqual(d4().depth?.deescalate, { to: "medium", on: ["poll", "read_only"], finish_patterns: [...DEFAULT_FINISH_PATTERNS] });
  assert.deepEqual(d4({ to: "low", on: ["poll"] }).depth?.deescalate?.on, ["poll"]);
  assert.notEqual(loadoutHash(d4({ to: "low" })), loadoutHash(d4()));
  for (const [label, settings, message] of [
    ["to high", { to: "high" }, /depth/u], ["bad trigger", { on: ["writes"] }, /depth/u], ["empty on", { on: [] }, /depth/u],
    ["unknown key", { below: "low" }, /below/u], ["bad regex", { finish_patterns: ["("] }, /finish_patterns/u],
  ] as const) {
    assert.throws(() => d4(settings), (error: Error) => error instanceof LoadoutError && message.test(error.message), label);
  }
});

// ---------- which requests run lowered ----------

test("D4 on the plain wire: requests after reads and read-only commands go at medium; the first, after a write, a red check or a check keep the run's effort", async () => {
  const run = await runScripted(d4(), [
    { tool: "read", args: { path: "a.txt" } },
    { tool: "bash", args: { command: "ls -la && cat a.txt" } },
    { tool: "write", args: { path: "b.txt", content: "y\n" } },
    { tool: "bash", args: { command: "sh check.sh" } },
    { tool: "read", args: { path: "a.txt" } },
    { tool: "write", args: { path: "a.txt", content: "ok\n" } },
    { tool: "bash", args: { command: "sh check.sh" } },
    { tool: "bash", args: { command: "cat a.txt" } },
    { text: "Done." },
  ], { setup: files });
  assert.equal(run.result.status, "finished");
  const efforts = ["high", "medium", "medium", "high", "high", "high", "high", "high", "medium"];
  assert.deepEqual(run.bodies.map((body) => body.reasoning.effort), efforts,
    "first; read; ls+cat; write; red check; read while red; fix; green check; cat");
  for (let i = 1; i < run.bodies.length; i++) assert.ok(isPrefix(run.bodies[i - 1]!, run.bodies[i]!), `request ${i + 1} extends request ${i}`);
  for (const body of run.bodies) assert.equal(body.input.filter((item: any) => item.type === "configuration_update").length, 0, "plain reasoning.effort only");
  const trace = starts(traceOf(run.tracePath));
  assert.deepEqual(trace.map((event) => event.effort), efforts);
  assert.deepEqual(trace.map((event) => event.effort_reason), ["base", "mechanical", "mechanical", "base", "base", "base", "base", "base", "mechanical"]);
  assert.deepEqual(run.result.effort_mix, {
    by_effort: { high: { requests: 6, output_tokens: 60, reasoning_tokens: 0 }, medium: { requests: 3, output_tokens: 30, reasoning_tokens: 0 } },
    by_reason: { base: 6, mechanical: 3 },
  });
});

test("D4 on exec-v0: a read-only cell and a poll of a running cell go lowered; a cell that yielded, a patch and checks do not", async () => {
  const command = (cmd: string): Step => ({ exec: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }); text(JSON.stringify(r));` });
  const run = await runScripted(d4({ to: "low" }, "exec-v0"), [
    command("ls && cat a.txt"),
    { exec: `// @exec: {"yield_time_ms": 200}\nawait tools.exec_command({ cmd: "sleep 1.5; echo slept", yield_time_ms: 20000 });\ntext("slept");` },
    { tool: "wait", args: { cell_id: "2", yield_time_ms: 100 } },
    { tool: "wait", args: { cell_id: "2", yield_time_ms: 10000 } },
    command("sh check.sh"),
    { exec: `text(await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+ok\n*** End Patch\n")}));` },
    command("sh check.sh"),
    command("cat a.txt"),
    { text: "Done." },
  ], { setup: files });
  assert.equal(run.result.status, "finished");
  const outputs = (body: Body): string[] => body.input.filter((item: any) => item.type?.endsWith("call_output")).map((item: any) => item.output as string);
  assert.match(outputs(run.bodies[2]!).at(-1)!, /Script running with cell ID 2/u);
  assert.match(outputs(run.bodies[3]!).at(-1)!, /Script running with cell ID 2/u, "the first wait returns before the cell ends");
  assert.match(outputs(run.bodies[5]!).at(-1)!, /1 failed/u);
  assert.deepEqual(run.bodies.map((body) => body.reasoning.effort), ["high", "low", "high", "low", "low", "high", "high", "high", "low"],
    "first; ls+cat cell; yielded cell; poll of the running cell; its read-only end; red check; patch; green check; cat");
  assert.deepEqual(run.result.effort_mix?.by_reason, { base: 5, mechanical: 4 });
});

test("D4: a turn announcing it is finishing, a loop nudge, a failure or a mixed batch keeps the run's effort", async () => {
  const announced = await fauxRun(d4(), [
    { text: "Reading the input.", toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] },
    { text: "All tests pass. One last look at the file.", toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] },
    { text: "Ok." },
  ], { setup: files });
  assert.deepEqual(announced.efforts, ["high", "medium", "high"]);
  const nudged = await fauxRun(d4(), [read(), read(), read(), { text: "Ok." }], { setup: files });
  assert.deepEqual(nudged.efforts, ["high", "medium", "medium", "high"], "the third identical read carries the loop nudge");
  const failed = await fauxRun(d4(), [bash("cat missing.txt"), read("missing.txt"), bash("ls"), { text: "Ok." }], { setup: files });
  assert.deepEqual(failed.efforts, ["high", "high", "high", "medium"], "a non-zero exit and a tool error are failures");
  const mixed = await fauxRun(d4(), [
    { toolCalls: [{ name: "read", arguments: { path: "a.txt" } }, { name: "write", arguments: { path: "b.txt", content: "y" } }] },
    { toolCalls: [{ name: "read", arguments: { path: "a.txt" } }, { name: "read", arguments: { path: "b.txt" } }] },
    { text: "Ok." },
  ], { setup: files });
  assert.deepEqual(mixed.efforts, ["high", "high", "medium"]);
});

// ---------- a read that prints a failure (the check that wrote it hid its verdict) ----------

test("readsRed: failure summaries in a result's text or an exec ledger's output tails, line-number gutters ignored", () => {
  assert.equal(readsRed("FAILED test_a - 1 failed", undefined), true);
  assert.equal(readsRed("     3\tFAILED test_a", undefined), true, "cat -n");
  assert.equal(readsRed("12\terror: cannot find value", undefined), true, "read's numbered lines");
  assert.equal(readsRed("x\nall passed\n", undefined), false);
  assert.equal(readsRed("read it", { log: [{ kind: "command", cmd: "cat out.log", exitCode: 0, output: "Traceback (most recent call last):\n" }] }), true,
    "a nested command's output the cell did not print");
  assert.equal(readsRed("ok", { log: [{ kind: "mutate" }, { kind: "poll", session: 3, output: "3 passed" }] }), false);
});

test("D4: a check whose verdict was hidden (> log; echo $?) then a read of its log keeps the run's effort until a check comes back green", async () => {
  const masked = "sh check.sh > out.log 2>&1; echo exit=$?";
  const run = await fauxRun(d4(), [
    bash(masked), bash("cat out.log"), read(), write("a.txt", "ok\n"), bash(masked), bash("cat out.log"), read(), { text: "Done." },
  ], { setup: files });
  assert.equal(run.result.status, "finished");
  assert.deepEqual(run.efforts, ["high", "high", "high", "high", "high", "high", "medium", "medium"],
    "first; masked check; its red log (was medium); a read while the log is red (was medium); fix; masked check; its green log; read");
  assert.deepEqual(run.reasons, ["base", "base", "base", "base", "base", "base", "mechanical", "mechanical"]);
  // The other shapes of a hidden verdict and of reading it back; a source file that spells a summary out errs the same way.
  for (const [check, look] of [
    ["sh check.sh > out.log 2>&1 || true", bash("tail -5 out.log")],
    [masked, read("out.log")],
    [masked, bash("cat -n out.log")],
    ["ls", read("check.sh")],
  ] as const) {
    const variant = await fauxRun(d4(), [bash(check), look, read(), { text: "Ok." }], { setup: files });
    assert.deepEqual(variant.efforts, ["high", check === "ls" ? "medium" : "high", "high", "high"], `${check} then ${JSON.stringify(look)}`);
  }
});

test("D4 on exec-v0: a cell reading a red log, printed or not, keeps the run's effort until a green check", async () => {
  const masked = "sh check.sh > out.log 2>&1; echo exit=$?";
  const command = (cmd: string): Step => ({ exec: `const r = await tools.exec_command({ cmd: ${JSON.stringify(cmd)} }); text(JSON.stringify(r));` });
  const run = await runScripted(d4({ to: "low" }, "exec-v0"), [
    command(masked),
    { exec: `await tools.exec_command({ cmd: "cat out.log" });\ntext("read it");` },
    command("cat a.txt"),
    { exec: `text(await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+ok\n*** End Patch\n")}));` },
    command(masked),
    command("cat out.log"),
    { text: "Done." },
  ], { setup: files });
  assert.equal(run.result.status, "finished");
  const outputs = (body: Body): string[] => body.input.filter((item: any) => item.type?.endsWith("call_output")).map((item: any) => item.output as string);
  assert.doesNotMatch(outputs(run.bodies[2]!).at(-1)!, /failed/u, "the cell printed only its own text");
  assert.deepEqual(run.bodies.map((body) => body.reasoning.effort), ["high", "high", "high", "high", "high", "high", "low"],
    "first; masked check; the red log's cell; a read while red; patch; masked check; its green log");
});

test("D4: polls of a still-running bash job go lowered; the yield of a check and its finished wait keep the run's effort; on: [poll] leaves reads alone", async () => {
  const setup = (cwd: string) => {
    files(cwd);
    writeFileSync(join(cwd, "green.sh"), "echo '3 passed'\n");
  };
  const steps = [
    read(),
    bash("sleep 1.5; sh green.sh", 1),
    { toolCalls: [{ name: "wait", arguments: { handle: "p1", timeout: 0.1 } }] },
    { toolCalls: [{ name: "wait", arguments: { handle: "p1" } }] },
    bash("sleep 1; echo ok", 0.2),
    { toolCalls: [{ name: "wait", arguments: { handle: "p2" } }] },
    { text: "Ok." },
  ];
  const run = await fauxRun(d4(), steps, { setup });
  assert.deepEqual(run.efforts, ["high", "medium", "high", "medium", "high", "medium", "medium"],
    "first; read; a yielded check; poll; the check ended; a yielded read-only job; its finished wait");
  const pollsOnly = await fauxRun(d4({ on: ["poll"] }), steps, { setup });
  assert.deepEqual(pollsOnly.efforts, ["high", "high", "high", "medium", "high", "high", "high"]);
});

test("D4 composes with D2: escalation wins, and only requests D2 leaves at the run's effort can go lowered", async () => {
  const loadout = withLevers((raw) => (raw.depth = { escalate: { on: ["first_write", "after_red"] }, deescalate: true }));
  const readStep: Step = { tool: "read", args: { path: "a.txt" } };
  const run = await runScripted(loadout, [
    readStep, readStep, { tool: "write", args: { path: "b.txt", content: "y" } }, readStep, { tool: "bash", args: { command: "sh check.sh" } }, readStep, { text: "Ok." },
  ], { setup: files });
  const efforts = ["xhigh", "xhigh", "xhigh", "high", "medium", "xhigh", "high"];
  assert.deepEqual(run.bodies.map((body) => body.reasoning.effort), efforts, "pre-write x3; after the write; read; after red; read while red");
  const trace = starts(traceOf(run.tracePath));
  assert.deepEqual(trace.map((event) => event.effort), efforts);
  assert.deepEqual(trace.map((event) => event.effort_reason), ["escalated", "escalated", "escalated", "base", "mechanical", "escalated", "base"]);
  assert.deepEqual(run.result.effort_mix?.by_reason, { escalated: 4, base: 2, mechanical: 1 });
  assert.deepEqual(run.result.effort_mix?.by_effort.xhigh?.requests, 4);
});

test("D4 never raises effort, and the evidence gate's continuation keeps the run's effort", async () => {
  const steps = [read(), read(), { text: "Ok." }];
  assert.deepEqual((await fauxRun(d4(), steps, { setup: files, effort: "low" })).efforts, ["low", "low", "low"], "medium is above a low run");
  assert.deepEqual((await fauxRun(d4({ to: "low" }), steps, { setup: files, effort: "medium" })).efforts, ["medium", "low", "low"]);
  const gated = await fauxRun(withLevers((raw) => {
    raw.depth = { deescalate: true };
    raw.policy.evidence_gate = { probe: "tools" };
  }), [write("b.py", "x\n"), { text: "Ok." }, read(), { text: "Ok." }], { setup: files });
  assert.deepEqual(gated.events.filter((event) => event.type === "policy").map((event) => event.reason), ["evidence_gate"]);
  assert.deepEqual(gated.efforts, ["high", "high", "high", "medium"], "the request after the gate's message is base");
  const off = await fauxRun(normalizeLoadout(base()), steps, { setup: files });
  assert.deepEqual(off.efforts, [undefined, undefined, undefined], "without D2/D4 no per-request effort");
  assert.equal(off.result.effort_mix, undefined, "and no effort mix in result.json");
});

// ---------- the wire guard ----------

test("D4 refuses Pi's per-turn effort items (OpenAI on compact-v0) and Anthropic's top-level effort; Anthropic per-message effort runs", async () => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "loopback refuses" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env.D4_GUARD_KEY = "sk-test";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-d4-guard-")));
  const env = new LocalEnv({ cwd });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const modelOptions = { anthropicBaseUrl: url, openaiBaseUrl: `${url}/v1`, apiKeyEnv: "D4_GUARD_KEY" };
  const go = (loadout: ReturnType<typeof normalizeLoadout>, model: string) => runHarness({ prompt: "Say hi.", model, effort: "high", loadout, env, modelOptions });
  try {
    await assert.rejects(go(d4(true, "compact-v0"), "openai/gpt-6.1-sol"), /depth\.deescalate: openai\/gpt-6\.1-sol would get each effort change as an appended configuration_update item/u);
    await assert.rejects(go(d4(), "anthropic/claude-opus-5-5"), /^Error: depth\.deescalate: anthropic\/claude-opus-5-5 would get its effort as a top-level field/u);
    const both = withLevers((raw) => (raw.depth = { escalate: true, deescalate: true }));
    await assert.rejects(go(both, "anthropic/claude-opus-5-5"), /depth\.escalate and depth\.deescalate: .* or turn depth\.escalate and depth\.deescalate off/u);
    assert.equal((await go(d4(true, "compact-v0"), "anthropic/claude-opus-5-5")).stop_reason, "provider_error", "per-message effort passes the guard");
    assert.equal((await go(d4(), "openai/gpt-6.1-sol")).stop_reason, "provider_error", "the plain wire passes the guard");
  } finally {
    server.close();
    await env.close();
  }
});
