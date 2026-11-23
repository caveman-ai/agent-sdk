/**
 * The exec surface's process lifetimes through any ExecEnv, checked only with
 * ExecEnv calls (a pid file and `kill -0` inside the env), so the same suite
 * runs on LocalEnv (tests/exec-lifecycle.test.ts) and DockerEnv
 * (tests/docker.test.ts). A nested exec_command still inside its yield window has
 * no session id, so whatever ends its call must kill it, and it is killed
 * through ExecOptions.signal:
 * - the exec tool call is aborted (the run's signal: a stop, a budget, SIGTERM);
 * - `wait {terminate: true}` on its cell;
 * - the script ends without awaiting it;
 * - the surface is disposed at the end of the run.
 * A command that yielded keeps running as a session after its cell completes,
 * until write_stdin "\u0003" stops it. Also: a nested apply_patch costs one
 * env read and one write per file, no stat.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecEnv } from "../src/env/types.ts";
import { loadLoadout } from "../src/loadout.ts";
import { execSurface } from "../src/tools/exec/surface.ts";
import { countedEnv } from "./tool-suite.ts";

type Call = (name: string, args: unknown, signal?: AbortSignal) => Promise<{ text: string; details: Record<string, any> }>;

function surfaceOn(env: ExecEnv) {
  const surface = execSurface({ env, loadout: loadLoadout("exec-v0"), images: true });
  const tools = Object.fromEntries(surface.tools.map((tool) => [tool.name, tool]));
  const call: Call = async (name, args, signal) => {
    const tool = tools[name]!;
    const result = await tool.execute("call", (tool.prepareArguments?.(args) ?? args) as never, signal);
    return { text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(""), details: result.details as Record<string, any> };
  };
  return { surface, call };
}

/** A long sleep that first writes its own pid (`exec` keeps the pid) to `file`. */
const sleeper = (file: string) => `echo $$ > ${file}; exec sleep ${41 + Math.floor(Math.random() * 100)}`;

async function pidOf(env: ExecEnv, file: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const text = await env.readFile(file).then((data) => Buffer.from(data).toString().trim(), () => "");
    if (/^\d+$/u.test(text)) return text;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`${file}: no pid`);
}

const isAlive = async (env: ExecEnv, pid: string) => (await env.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).output.trim() === "alive";

/** True once `pid` is gone (within `ms`). */
async function goneWithin(env: ExecEnv, pid: string, ms = 5000): Promise<boolean> {
  const end = performance.now() + ms;
  for (;;) {
    if (!(await isAlive(env, pid))) return true;
    if (performance.now() > end) return false;
    await new Promise((done) => setTimeout(done, 100));
  }
}

const execCommand = (cmd: string, yieldMs = 20000) => `await tools.exec_command({ cmd: ${JSON.stringify(cmd)}, yield_time_ms: ${yieldMs} });`;

export function execSurfaceSuite(label: string, makeEnv: () => Promise<ExecEnv>): void {
  const withSurface = (name: string, body: (env: ExecEnv, call: Call, dispose: () => Promise<void>) => Promise<void>) =>
    test(`${label} exec: ${name}`, { timeout: 60_000 }, async () => {
      const env = await makeEnv();
      const { surface, call } = surfaceOn(env);
      try {
        await body(env, call, () => surface.dispose());
      } finally {
        await surface.dispose();
        await env.close();
      }
    });

  withSurface("an aborted exec call kills its nested exec_command (ExecOptions.signal)", async (env, call) => {
    const abort = new AbortController();
    const pending = call("exec", { input: `// @exec: {"yield_time_ms": 20000}\n${execCommand(sleeper("abort.pid"))}` }, abort.signal);
    const pid = await pidOf(env, "abort.pid");
    assert.equal(await isAlive(env, pid), true, "the command runs while the cell does");
    const started = performance.now();
    abort.abort(new Error("run stopped"));
    await pending;
    assert.ok(performance.now() - started < 15_000, "the aborted call returned without waiting out its yield");
    assert.equal(await goneWithin(env, pid), true, "the aborted call left its command running with no session id");
  });

  withSurface("wait terminate kills a nested exec_command still inside its yield window", async (env, call) => {
    const first = await call("exec", { input: `// @exec: {"yield_time_ms": 1500}\n${execCommand(sleeper("term.pid"))}` });
    assert.match(first.text, /^Script running with cell ID 1\n/u);
    const pid = await pidOf(env, "term.pid");
    assert.equal(await isAlive(env, pid), true);
    const stopped = await call("wait", { cell_id: "1", terminate: true });
    assert.match(stopped.text, /^Script terminated\n/u);
    assert.equal(await isAlive(env, pid), false, "terminate returned before the command was killed");
  });

  withSurface("a script that ends without awaiting its exec_command kills it; dispose kills an in-flight one", async (env, call, dispose) => {
    const ended = await call("exec", { input: `tools.exec_command({ cmd: ${JSON.stringify(sleeper("unawaited.pid"))}, yield_time_ms: 20000 }).catch(() => {});\nawait new Promise((wake) => setTimeout(wake, 1500));\ntext("bye");` });
    assert.match(ended.text, /^Script completed\n[\s\S]*Output:\nbye$/u);
    assert.equal(await goneWithin(env, await pidOf(env, "unawaited.pid")), true, "the script ended; its unawaited command did not");
    const running = await call("exec", { input: `// @exec: {"yield_time_ms": 1500}\n${execCommand(sleeper("dispose.pid"))}` });
    assert.match(running.text, /^Script running/u);
    const pid = await pidOf(env, "dispose.pid");
    await dispose();
    assert.equal(await isAlive(env, pid), false, "dispose left an in-flight command running");
  });

  withSurface("a yielded command outlives its cell as a session; write_stdin \\u0003 stops it", async (env, call) => {
    const done = await call("exec", { input: `const r = await tools.exec_command({ cmd: ${JSON.stringify(sleeper("session.pid"))}, yield_time_ms: 500 }); text(r.session_id);` });
    assert.match(done.text, /^Script completed\n[\s\S]*Output:\n1000$/u);
    const pid = await pidOf(env, "session.pid");
    assert.equal(await isAlive(env, pid), true, "a session from a completed cell keeps running");
    const stopped = await call("exec", { input: 'const s = await tools.write_stdin({ session_id: 1000, chars: "\\u0003" }); text(s.exit_code);' });
    assert.match(stopped.text, /Output:\n137$/u);
    assert.equal(await goneWithin(env, pid), true);
  });

  test(`${label} exec: a nested apply_patch reads each file once (no stat) and writes it once`, async () => {
    const inner = await makeEnv();
    const { env, calls } = countedEnv(inner);
    const { surface, call } = surfaceOn(env);
    try {
      await inner.writeFile("p.txt", "one\ntwo\n");
      const patch = "*** Begin Patch\n*** Update File: p.txt\n@@\n-two\n+2\n*** Add File: new.txt\n+fresh\n*** End Patch\n";
      calls.length = 0;
      const out = await call("exec", { input: `text(await tools.apply_patch(${JSON.stringify(patch)}));` });
      assert.match(out.text, /Success\. Updated the following files:/u, out.text);
      assert.equal(Buffer.from(await inner.readFile("p.txt")).toString(), "one\n2\n");
      assert.equal(calls.filter((name) => name === "stat").length, 0, calls.join(","));
      assert.equal(calls.filter((name) => name === "readFile").length, 2, calls.join(","));
      assert.equal(calls.filter((name) => name === "writeFile").length, 2, calls.join(","));
    } finally {
      await surface.dispose();
      await inner.close();
    }
  });
}
