/**
 * B5's loop guard on results whose text names a per-call file or time: the R1
 * shaped view (its `full log: <path>` is a new spill file per call), a capped
 * result's spill path, and R2's until line (its elapsed time). The same call
 * with the same raw result must still count as a repeat: nudged at 3, stopped
 * at 6, on both surfaces, as with shaping off. Faux model, LocalEnv, offline.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import { runHarness } from "../src/run.ts";
import { execRepeatKey } from "../src/tools/exec/format.ts";
import { withoutUntilTimes } from "../src/tools/wait-until.ts";

const LOADOUTS = join(import.meta.dirname, "..", "loadouts");
const arm = (name: string) => readLoadout(join(LOADOUTS, `${name}.json`)).loadout;

/** The same pytest-looking failure every run: 120 passing lines, one failure, the summary (over min_bytes, so R1 shapes it). */
const CI = "for i in $(seq 1 120); do echo \"tests/test_m$i.py ........................................ [ $i%]\"; done\n" +
  "echo '=== FAILURES ==='; echo '___ test_add ___'; echo '>       assert add(1, 2) == 4'; echo 'E       assert 3 == 4'\n" +
  "echo 'tests/test_calc.py:12: AssertionError'; echo 'FAILED tests/test_calc.py::test_add - assert 3 == 4'; echo '=== 1 failed, 120 passed in 0.50s ==='; exit 1\n";

async function loop(loadout: Loadout, step: FauxStep, setup: (cwd: string) => void = () => {}, wrap: (env: LocalEnv) => void = () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), "harness-loop-shaped-"));
  writeFileSync(join(cwd, "ci.sh"), CI);
  setup(cwd);
  const env = new LocalEnv({ cwd });
  wrap(env);
  const tracePath = join(cwd, "trace.jsonl");
  const steps = [...Array.from({ length: 8 }, () => fauxStep(step)), fauxStep({ text: "done" })];
  try {
    const result = await runHarness({ prompt: "fix the test", model: "faux/loop", effort: "high", loadout, env, tracePath, fauxSteps: steps });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    const policy = events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}:${event.count}`);
    const shaped = events.filter((event) => event.type === "tool_end").map((event) => event.shaped ?? "raw");
    return { result, policy, shaped };
  } finally {
    await env.close();
  }
}

const STOPPED = ["nudge:loop_repeat:3", "nudge:loop_repeat:4", "nudge:loop_repeat:5", "stop:loop_repeat:6"];
const BASH = { toolCalls: [{ name: "bash", arguments: { command: "sh ci.sh" } }] };
const EXEC = { toolCalls: [{ name: "exec", arguments: { input: 'const r = await tools.exec_command({ cmd: "sh ci.sh" }); text(r.output);' } }] };

describe("loop-shaped", { concurrency: true }, () => {
for (const [name, step] of [["compact-v0-plain-r1", BASH], ["exec-v0-r1", EXEC]] as const) {
  test(`B5 with R1 on (${name}): the same failing test run x8, each shaped and spilled to a new file, is nudged at 3 and stopped at 6`, async () => {
    const run = await loop(arm(name), step);
    assert.equal(run.result.stop_reason, "loop_repeat", JSON.stringify(run.policy));
    assert.deepEqual(run.policy, STOPPED);
    assert.equal(run.result.tools.calls, 6);
    assert.ok(run.shaped.every((label) => label.startsWith("test:")), `every result is shaped: ${run.shaped.join(" ")}`);
  });
}

test("B5 on the built-ins: a capped result spilled to a new file per call is still a repeat (compact; exec already strips its spill path)", async () => {
  // 3000 identical lines: over compact's 2000-line cap, so each call spills to its own out-N.log named in the cap marker.
  const big = (cwd: string) => writeFileSync(join(cwd, "big.sh"), "for i in $(seq 1 3000); do echo \"line $i\"; done; exit 1\n");
  for (const name of ["compact-v0-plain", "compact-v0"]) {
    const run = await loop(normalizeLoadout(structuredClone(BUILTIN_LOADOUTS[name]) as never), { toolCalls: [{ name: "bash", arguments: { command: "sh big.sh" } }] }, big);
    assert.deepEqual(run.policy, STOPPED, name);
  }
  const exec = await loop(normalizeLoadout(structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as never),
    { toolCalls: [{ name: "exec", arguments: { input: 'const r = await tools.exec_command({ cmd: "sh big.sh", max_output_tokens: 100 }); text(r.output);' } }] }, big);
  assert.deepEqual(exec.policy, STOPPED, "exec-v0");
});

test("B5 with R2 on: the same wait until on a port that never opens, each with its own elapsed time, is nudged at 3 and stopped at 6", async () => {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  // Each wait's probe takes 120 ms longer than the last, so every result says a different "after N.Ns".
  let waits = 0;
  const slower = (env: LocalEnv) => {
    const wait = env.wait.bind(env);
    env.wait = async (handle, ms, signal) => {
      const run = await wait(handle, ms, signal);
      const delay = 120 * waits++;
      if (delay > 0) await new Promise((done) => setTimeout(done, delay));
      return run;
    };
  };
  const run = await loop(arm("compact-v0-plain-r23"), { toolCalls: [{ name: "wait", arguments: { until: `port:${port}`, timeout: 0.05 } }] }, () => {}, slower);
  assert.deepEqual(run.policy, STOPPED);
  assert.ok(waits >= 6);
});

test("repeat keys: R1 full-log paths and R2 until times are taken out; everything else in the text still counts", () => {
  const shaped = (log: string, s: string) => `Script completed\nWall time ${s} seconds\nOutput:\n[wait until exit: met after ${s}s]\n` +
    `[harness: test output shaped (pytest): 1 failed; 1 failure with trace heads. Raw: 9 lines, 3 KB; full log: ${log}]\nE  assert 3 == 4`;
  assert.equal(execRepeatKey(shaped("/tmp/harness-run-a/cmd-1.log", "0.4")), execRepeatKey(shaped("/tmp/harness-run-a/cmd-7.log", "12.0")));
  const json = (log: string) => `Script completed\nWall time 1.0 seconds\nOutput:\n${JSON.stringify({ output: `[harness: ... full log: ${log}]\nE x` })}`;
  assert.equal(execRepeatKey(json("/s/cmd-1.log")), execRepeatKey(json("/s/cmd-2.log")), "inside a JSON-printed record too");
  assert.notEqual(execRepeatKey(shaped("/s/cmd-1.log", "1.0")), execRepeatKey(shaped("/s/cmd-1.log", "1.0").replace("3 == 4", "3 == 5")), "a different failure is not a repeat");
  assert.equal(withoutUntilTimes("[wait until regex /after 3s/: not met after 300.0s]"), "[wait until regex /after 3s/: not met]");
  assert.equal(withoutUntilTimes("echo [wait until exit: met after 1.0s] later"), "echo [wait until exit: met after 1.0s] later", "only a whole until line");
});
});
