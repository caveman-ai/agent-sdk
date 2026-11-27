/**
 * ExecEnv conformance: what every backend (LocalEnv, DockerEnv) must do, as one
 * function a backend's test calls with a factory.
 * The factory gets a fresh, empty, writable directory path to use as cwd
 * (for a remote backend: a path inside the sandbox).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecEnv } from "../src/env/types.ts";

export function execEnvConformance(label: string, makeEnv: () => Promise<ExecEnv>): void {
  describe(`${label} conformance`, { concurrency: true }, () => {
  const withEnv = (name: string, body: (env: ExecEnv) => Promise<void>) =>
    test(`${label}: ${name}`, async () => {
      const env = await makeEnv();
      try {
        await body(env);
      } finally {
        await env.close();
      }
    });

  withEnv("exec returns combined output, exit code and duration", async (env) => {
    const run = await env.exec("echo out; echo err >&2; exit 4");
    assert.equal(run.running, false);
    assert.equal(run.exitCode, 4);
    assert.equal(run.output, "out\nerr\n");
    assert.equal(run.totalBytes, 8);
    assert.equal(run.truncated, false);
    assert.ok(run.durationMs >= 0);
    assert.equal(run.handle, undefined);
  });

  withEnv("exec runs in the env cwd by default and in options.cwd when given", async (env) => {
    await env.writeFile("sub/marker.txt", "x");
    assert.equal((await env.exec("pwd")).output.trim(), env.cwd);
    assert.equal((await env.exec("ls", { cwd: "sub" })).output.trim(), "marker.txt");
  });

  withEnv("a yield leaves the command running; poll and wait return only new output", async (env) => {
    const first = await env.exec("echo a; sleep 0.6; echo b", { yieldMs: 200 });
    assert.equal(first.running, true);
    assert.equal(first.exitCode, null);
    assert.equal(first.output, "a\n");
    const handle = first.handle!;
    const polled = await env.poll(handle);
    assert.equal(polled.running, true);
    assert.equal(polled.output, "");
    const done = await env.wait(handle, 5000);
    assert.equal(done.running, false);
    assert.equal(done.exitCode, 0);
    assert.equal(done.output, "b\n");
    await assert.rejects(env.poll(handle), /no background process/u);
  });

  withEnv("background starts at once; kill stops it; the hard timeout kills too", async (env) => {
    const bg = await env.exec("sleep 30", { background: true });
    assert.equal(bg.running, true);
    const killed = await env.kill(bg.handle!);
    assert.equal(killed.running, false);
    assert.equal(killed.killed, true);
    assert.equal(killed.exitCode, null);
    const started = Date.now();
    const timed = await env.exec("sleep 30", { timeoutMs: 200 });
    assert.ok(Date.now() - started < 5000);
    assert.equal(timed.timedOut, true);
    assert.equal(timed.exitCode, null);
  });

  withEnv("an abort signal kills the command", async (env) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const run = await env.exec("sleep 30", { signal: controller.signal });
    assert.equal(run.killed, true);
  });

  withEnv("files: write creates parents, read whole or a range, stat and listDir", async (env) => {
    await env.writeFile("a/b/c.txt", "0123456789");
    assert.equal(Buffer.from(await env.readFile("a/b/c.txt")).toString(), "0123456789");
    assert.equal(Buffer.from(await env.readFile("a/b/c.txt", { offset: 2, length: 3 })).toString(), "234");
    assert.equal(Buffer.from(await env.readFile(`${env.cwd}/a/b/c.txt`, { offset: 8 })).toString(), "89");
    assert.deepEqual(await env.stat("a/b/c.txt").then((info) => [info?.kind, info?.size]), ["file", 10]);
    assert.equal((await env.stat("a"))?.kind, "directory");
    assert.equal(await env.stat("missing"), undefined);
    assert.deepEqual(await env.listDir("a/b"), [{ name: "c.txt", kind: "file" }]);
    await assert.rejects(env.readFile("missing.txt"));
    assert.equal(env.resolvePath("x/y"), `${env.cwd}/x/y`);
  });

  withEnv("the scratch dir is outside the workspace and writable", async (env) => {
    const scratch = await env.scratchDir();
    assert.ok(!scratch.startsWith(`${env.cwd}/`));
    await env.writeFile(`${scratch}/spill.log`, "full");
    assert.equal(Buffer.from(await env.readFile(`${scratch}/spill.log`)).toString(), "full");
    assert.equal(await env.scratchDir(), scratch, "one scratch dir per env");
  });

  withEnv("multi-byte output is never split mid-character across polls", async (env) => {
    const first = await env.exec("printf '\\xc3'; sleep 0.4; printf '\\xa9\\n'", { yieldMs: 150 });
    const rest = await env.wait(first.handle!, 5000);
    assert.equal(first.output + rest.output, "é\n");
  });

  withEnv("a child the command backgrounded does not hold it open; close kills it", async (env) => {
    const started = Date.now();
    const run = await env.exec("sleep 30 & echo $! > bg.pid; echo hi");
    assert.equal(run.running, false);
    assert.equal(run.exitCode, 0);
    assert.equal(run.output, "hi\n");
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    const pid = Buffer.from(await env.readFile("bg.pid")).toString().trim();
    assert.equal((await env.exec(`kill -0 ${pid} && echo alive`)).output, "alive\n");
    await env.close();
    const checker = await makeEnv();
    try {
      assert.equal((await checker.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).output, "gone\n");
    } finally {
      await checker.close();
    }
  });

  withEnv("per-call variables win over the env's; a pager never blocks", async (env) => {
    const run = await env.exec("echo $HARNESS_T $PAGER", { env: { HARNESS_T: "x" } });
    assert.equal(run.output, "x cat\n");
  });

  withEnv("batched reads and writes keep order and report each failure", async (env) => {
    if (env.readFiles === undefined || env.writeFiles === undefined) return;
    await env.writeFiles([{ path: "m/a.txt", data: "A" }, { path: "m/n/b.bin", data: new Uint8Array([0, 255, 1]) }]);
    const [a, missing, b] = await env.readFiles(["m/a.txt", "m/none.txt", `${env.cwd}/m/n/b.bin`]);
    assert.equal(Buffer.from(a as Uint8Array).toString(), "A");
    assert.ok(missing instanceof Error);
    assert.deepEqual([...(b as Uint8Array)], [0, 255, 1]);
  });

  withEnv("a batch of twenty files, binary ones byte for byte, round-trips in order", async (env) => {
    if (env.readFiles === undefined || env.writeFiles === undefined) return;
    const every = new Uint8Array(256).map((_, index) => index);
    const files = Array.from({ length: 20 }, (_, index) => ({ path: `batch/${index % 3}/f${index}.bin`, data: index % 2 === 0 ? every.subarray(index) : `text ${index}\n` }));
    await env.writeFiles(files);
    const read = await env.readFiles([...files.map((file) => file.path), "batch/none.bin"]);
    for (const [index, file] of files.entries()) {
      assert.ok(Buffer.from(read[index] as Uint8Array).equals(Buffer.from(file.data)), `file ${index}`);
    }
    assert.ok(read[20] instanceof Error && (read[20] as { code?: string }).code === "ENOENT");
    assert.deepEqual([...(await env.readFile("batch/0/f0.bin", { offset: 250, length: 10 }))], [250, 251, 252, 253, 254, 255]);
  });

  withEnv("output past the 32 MiB capture ceiling is counted, not kept", async (env) => {
    const ceiling = 32 * 1024 * 1024;
    const run = await env.exec(`yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c ${ceiling + 1000}`, { timeoutMs: 60_000 });
    assert.equal(run.exitCode, 0);
    assert.equal(run.truncated, true);
    assert.equal(run.totalBytes, ceiling + 1000);
    assert.equal(run.output.length, ceiling);
  });
  });
}
