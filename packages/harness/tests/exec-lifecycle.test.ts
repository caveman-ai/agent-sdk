/**
 * The exec surface's process lifetimes and its loop detection, on LocalEnv:
 * - a nested exec_command still inside its yield window is killed when its
 *   cell is terminated, times out, ends without awaiting it, or the surface is
 *   disposed (no session id was ever handed out, so nothing else could stop it);
 * - terminate also stops the sessions the cell started and names them;
 * - a completed cell's sessions keep running for write_stdin;
 * - repeat detection ignores wall times, chunk ids and session ids, so the
 *   same failing command rerun through exec is nudged and stopped as on compact;
 * - a nested apply_patch that changes nothing does not reset the repeat counts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, loadLoadout, normalizeLoadout, type Loadout } from "../src/loadout.ts";
import { fauxStep } from "../src/models.ts";
import { runHarness } from "../src/run.ts";
import { execRepeatKey } from "../src/tools/exec/format.ts";
import { execSurface } from "../src/tools/exec/surface.ts";
import { execSurfaceSuite } from "./exec-suite.ts";

execSurfaceSuite("LocalEnv", async () => new LocalEnv({ cwd: mkdtempSync(join(tmpdir(), "harness-exec-suite-")) }));

function setup(loadout: Loadout = loadLoadout("exec-v0"), files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "harness-exec-life-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  const env = new LocalEnv({ cwd: root });
  const surface = execSurface({ env, loadout, images: true });
  const tools = Object.fromEntries(surface.tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, args: unknown) => {
    const result = await tools[name]!.execute("call", tools[name]!.prepareArguments?.(args) ?? args);
    return { text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(""), details: result.details as Record<string, any> };
  };
  return { root, env, surface, call, async close() { await surface.dispose(); await env.close(); } };
}

/** A unique sleep per test, so `ps` finds only this test's processes. */
const marker = () => `sleep ${37 + Math.floor(Math.random() * 1000)}.${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;

const alive = (needle: string) => execFileSync("ps", ["-ax", "-o", "command"], { encoding: "utf8" }).split("\n").some((line) => line.includes(needle));

async function eventually(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return check();
}

test("terminate kills a nested exec_command still inside its yield window", async () => {
  const ctx = setup();
  const sleep = marker();
  try {
    const first = await ctx.call("exec", { input: `// @exec: {"yield_time_ms": 500}\nawait tools.exec_command({ cmd: "${sleep}; echo done", yield_time_ms: 20000 });` });
    assert.match(first.text, /^Script running with cell ID 1\n/u);
    assert.ok(alive(sleep), "the command runs while the cell does");
    const stopped = await ctx.call("wait", { cell_id: "1", terminate: true });
    assert.match(stopped.text, /^Script terminated\n/u);
    assert.equal(alive(sleep), false, "terminate left the command running with no session id");
  } finally {
    await ctx.close();
  }
});

test("terminate stops the sessions the cell started and names them; a completed cell's session keeps running", async () => {
  const ctx = setup();
  const kept = marker();
  const stoppedCmd = marker();
  try {
    const done = await ctx.call("exec", { input: `const r = await tools.exec_command({ cmd: "${kept}", yield_time_ms: 250 }); text(r.session_id);` });
    assert.match(done.text, /^Script completed\n[\s\S]*Output:\n1000$/u);
    const started = await ctx.call("exec", {
      input: `// @exec: {"yield_time_ms": 1500}\nconst r = await tools.exec_command({ cmd: "${stoppedCmd}", yield_time_ms: 250 });\ntext("started");\nawait new Promise((wake) => setTimeout(wake, 20000));`,
    });
    assert.match(started.text, /^Script running with cell ID 2\n[\s\S]*Output:\nstarted$/u);
    const stopped = await ctx.call("wait", { cell_id: "2", terminate: true });
    assert.equal(stopped.text.split("Output:\n")[1], `Stopped exec_command session this cell started: 1001 (\`${stoppedCmd}\`)\n`);
    assert.equal(alive(stoppedCmd), false);
    assert.ok(alive(kept), "a session from a cell that completed outlives it");
    const polled = await ctx.call("exec", { input: 'const s = await tools.write_stdin({ session_id: 1000, chars: "\\u0003" }); text(s.exit_code);' });
    assert.match(polled.text, /Output:\n137$/u);
    assert.equal(await eventually(() => !alive(kept)), true);
  } finally {
    await ctx.close();
  }
});

test("a cell that times out or ends without awaiting its exec_command kills it", async () => {
  const raw = structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as Record<string, any>;
  raw.tools.exec.limits.cell_timeout_s = 1;
  const ctx = setup(normalizeLoadout(raw));
  const timedOut = marker();
  const unawaited = marker();
  try {
    const out = await ctx.call("exec", { input: `await tools.exec_command({ cmd: "${timedOut}", yield_time_ms: 20000 });` });
    assert.match(out.text, /^Script failed\n/u);
    assert.equal(await eventually(() => !alive(timedOut)), true, "the cell timed out; its command did not");
    const ended = await ctx.call("exec", { input: `tools.exec_command({ cmd: "${unawaited}", yield_time_ms: 20000 }).catch(() => {});\ntext("bye");` });
    assert.match(ended.text, /^Script completed\n[\s\S]*Output:\nbye$/u);
    assert.equal(await eventually(() => !alive(unawaited)), true, "the script ended; its unawaited command did not");
  } finally {
    await ctx.close();
  }
});

test("dispose kills commands still inside their yield window, before the env closes", async () => {
  const ctx = setup();
  const sleep = marker();
  try {
    const first = await ctx.call("exec", { input: `// @exec: {"yield_time_ms": 300}\nawait tools.exec_command({ cmd: "${sleep}", yield_time_ms: 20000 });` });
    assert.match(first.text, /^Script running/u);
    assert.ok(alive(sleep));
    await ctx.surface.dispose();
    assert.equal(alive(sleep), false, "dispose left an in-flight command running");
  } finally {
    await ctx.env.close();
  }
});

test("the repeat key drops wall times, cell, chunk and session ids, and spill paths; not the outcome", () => {
  const one = 'Script completed\nWall time 1.1 seconds\nOutput:\n{"chunk_id":"66981e","wall_time_seconds":1.043,"exit_code":1,"original_token_count":2,"output":"fail\\n"}';
  const two = 'Script completed\nWall time 1.2 seconds\nOutput:\n{"chunk_id":"0a0cf5","wall_time_seconds":1.187,"exit_code":1,"original_token_count":2,"output":"fail\\n"}';
  assert.equal(execRepeatKey(one), execRepeatKey(two));
  assert.notEqual(execRepeatKey(one), execRepeatKey(two.replace('"exit_code":1', '"exit_code":0')));
  const pretty = (chunk: string, wall: number, session: number) => `Script running with cell ID ${session - 990}\nWall time 0.3 seconds\nOutput:\n` +
    JSON.stringify({ chunk_id: chunk, wall_time_seconds: wall, original_token_count: 0, output: "", session_id: session }, null, 2);
  assert.equal(execRepeatKey(pretty("aaaaaa", 0.25, 1000)), execRepeatKey(pretty("bbbbbb", 0.311, 1001)));
  const spilled = (cell: number) => `Script completed\nWall time 0.1 seconds\nOutput:\nWarning: truncated output (original token count: 99)\nTotal output lines: 9\nFull output: /tmp/s/exec-${cell}-${cell}.log\n\nx`;
  assert.equal(execRepeatKey(spilled(1)), execRepeatKey(spilled(2)));
  assert.notEqual(execRepeatKey("Output:\nx", 1), execRepeatKey("Output:\nx"));
});

test("the same failing command rerun through exec is nudged and stopped like on compact", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-exec-loop-"));
  const env = new LocalEnv({ cwd: root });
  const loadout = loadLoadout("exec-v0");
  const { nudge_at, stop_at } = loadout.policy.loop;
  const script = 'const r = await tools.exec_command({ cmd: "sleep 0.6; echo fail; exit 1" }); text(JSON.stringify(r));';
  const trace = join(root, "trace.jsonl");
  const seen: string[] = [];
  try {
    const result = await runHarness({
      prompt: "Fix the test.", model: "faux/scripted", effort: "high", loadout, env, tracePath: trace,
      fauxSteps: Array.from({ length: stop_at + 2 }, () => (context: TranscriptContext) => {
        const last = [...context.messages].reverse().find((message) => message.role === "toolResult");
        if (last !== undefined) seen.push(last.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
        return fauxStep({ toolCalls: [{ name: "exec", arguments: { input: script } }] });
      }),
    });
    assert.equal(result.status, "stopped", JSON.stringify(result));
    assert.equal(result.stop_reason, "loop_repeat");
    assert.equal(result.tools.calls, stop_at);
    const policy = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "policy");
    const expected = [...Array.from({ length: stop_at - nudge_at }, (_, index) => `nudge:${nudge_at + index}`), `stop:${stop_at}`];
    assert.deepEqual(policy.map((event) => `${event.action}:${event.count}`), expected);
    assert.notEqual(seen[0], seen[1], "the raw results differ run to run (chunk_id at least), which is what the key removes");
  } finally {
    await env.close();
  }
});

test("a new exec cell whose command fails is not progress; a new one that succeeds is", async () => {
  const loadout = loadLoadout("exec-v0");
  const { nudge_at, stop_at } = loadout.policy.loop;
  const same = 'const r = await tools.exec_command({ cmd: "echo fail; exit 1" }); text(r.output);';
  const run = async (otherExit: number) => {
    const root = mkdtempSync(join(tmpdir(), "harness-exec-progress-"));
    const env = new LocalEnv({ cwd: root });
    const trace = join(root, "trace.jsonl");
    let n = 0;
    try {
      // A, B1, A, B2, A, ...: the same failing cell, alternating with a new cell each time.
      const result = await runHarness({
        prompt: "Fix the test.", model: "faux/scripted", effort: "high", loadout, env, tracePath: trace,
        fauxSteps: Array.from({ length: 2 * stop_at + 2 }, () => () => {
          const other = `// try ${++n}\nconst r = await tools.exec_command({ cmd: "echo other; exit ${otherExit}" }); text(r.output);`;
          return fauxStep({ toolCalls: [{ name: "exec", arguments: { input: n % 2 === 1 ? same : other } }] });
        }),
      });
      const policy = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "policy");
      return { result, policy: policy.map((event) => `${event.action}:${event.count}`) };
    } finally {
      await env.close();
    }
  };
  const failing = await run(1);
  assert.equal(failing.result.stop_reason, "loop_repeat", JSON.stringify(failing.result));
  assert.deepEqual(failing.policy, [...Array.from({ length: stop_at - nudge_at }, (_, index) => `nudge:${nudge_at + index}`), `stop:${stop_at}`]);
  assert.equal(failing.result.tools.calls, 2 * stop_at - 1);
  const passing = await run(0);
  assert.deepEqual(passing.policy, [], "a new cell that succeeds resets the counts");
});

test("a nested apply_patch that changes nothing is not an edit", async () => {
  const ctx = setup(loadLoadout("exec-v0"), { "a.txt": "same\n" });
  try {
    const noop = "*** Begin Patch\n*** Add File: a.txt\n+same\n*** End Patch\n";
    const out = await ctx.call("exec", { input: `text(await tools.apply_patch(${JSON.stringify(noop)}));` });
    assert.match(out.text, /Success\. Updated the following files:\nA a\.txt/u);
    assert.equal(out.details.mutated, undefined, "an identical Add File reset the loop counts");
    const real = "*** Begin Patch\n*** Update File: a.txt\n@@\n-same\n+changed\n*** End Patch\n";
    const edited = await ctx.call("exec", { input: `text(await tools.apply_patch(${JSON.stringify(real)}));` });
    assert.equal(edited.details.mutated, true);
    assert.equal(readFileSync(join(ctx.root, "a.txt"), "utf8"), "changed\n");
  } finally {
    await ctx.close();
  }
});
