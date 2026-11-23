/**
 * LocalEnv process groups: a group is signalled only while it is ours, and a
 * harness that dies without close() still takes its commands with it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalEnv } from "../src/env/local.ts";

const workdir = () => realpathSync(mkdtempSync(join(tmpdir(), "harness-groups-")));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return check();
}

test("a command's group is dropped once it is empty, so close() never signals a stale id", async () => {
  const env = new LocalEnv({ cwd: workdir() });
  const kills: [number, string | number | undefined][] = [];
  const realKill = process.kill;
  try {
    const plain = await env.exec("echo hi");
    assert.equal(plain.output, "hi\n");
    assert.deepEqual(env.trackedGroups(), [], "an exited command with no children leaves no group behind");

    // A backgrounded child keeps the group alive after the command exits: still ours, still tracked.
    const started = await env.exec("sleep 30 >/dev/null 2>&1 & echo $!");
    const sleeper = Number(started.output.trim());
    assert.ok(alive(sleeper));
    assert.equal(env.trackedGroups().length, 1);
    // Once that child dies, the next probe drops the group (its id is free for the OS to reuse).
    process.kill(sleeper, "SIGKILL");
    assert.ok(await until(() => env.trackedGroups().length === 0, 3_000), "the emptied group was pruned");

    process.kill = ((pid: number, signal?: string | number) => {
      kills.push([pid, signal]);
      return realKill.call(process, pid, signal as NodeJS.Signals);
    }) as typeof process.kill;
    await env.close();
    assert.deepEqual(kills.filter(([pid, signal]) => pid < 0 && signal !== 0), [], "close() sent no group kill");
  } finally {
    process.kill = realKill;
    await env.close();
  }
});

test("close() still kills a live server a finished command left behind", async () => {
  const env = new LocalEnv({ cwd: workdir() });
  try {
    const started = await env.exec("sleep 30 >/dev/null 2>&1 & echo $!");
    const sleeper = Number(started.output.trim());
    assert.ok(alive(sleeper));
    await env.close();
    assert.ok(await until(() => !alive(sleeper), 2_000));
  } finally {
    await env.close();
  }
});

test("a harness killed without close() leaves nothing running: the reaper kills its groups", async () => {
  const local = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "env", "local.ts");
  const script = `
    import { LocalEnv } from ${JSON.stringify(local)};
    const env = new LocalEnv({ cwd: ${JSON.stringify(workdir())} });
    const left = await env.exec("sleep 60 >/dev/null 2>&1 & echo $!");
    const running = await env.exec("echo $$; exec sleep 60", { yieldMs: 300 });
    console.log(JSON.stringify({ left: Number(left.output.trim()), running: Number(running.output.trim()), reaper: env.reaperPid() }));
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const pids = await new Promise<{ left: number; running: number; reaper: number }>((done, fail) => {
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) done(JSON.parse(out));
    });
    child.once("exit", (code) => fail(new Error(`child exited ${code} before reporting: ${out}`)));
  });
  try {
    assert.ok(alive(pids.left) && alive(pids.running) && alive(pids.reaper));
    child.kill("SIGKILL");
    assert.ok(await until(() => !alive(pids.left) && !alive(pids.running), 3_000), "both the leftover and the running command died with the harness");
    assert.ok(await until(() => !alive(pids.reaper), 2_000), "the reaper exits after its sweep");
  } finally {
    child.kill("SIGKILL");
    for (const pid of [pids.left, pids.running]) if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

test("a command started with an already-aborted signal is killed at once", async () => {
  const env = new LocalEnv({ cwd: workdir() });
  try {
    const abort = new AbortController();
    abort.abort();
    const started = Date.now();
    const run = await env.exec("sleep 20", { signal: abort.signal });
    assert.ok(Date.now() - started < 3_000);
    assert.equal(run.killed, true);
    assert.equal(run.exitCode, null);
  } finally {
    await env.close();
  }
});
