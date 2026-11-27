/**
 * The compact tools (read, bash, wait, edit, write) through any ExecEnv, using
 * only ExecEnv calls for setup and checks, so the same suite runs against
 * LocalEnv (tests/env.test.ts) and DockerEnv (tests/docker.test.ts).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecEnv } from "../src/env/types.ts";
import { BUILTIN_LOADOUTS, normalizeLoadout } from "../src/loadout.ts";
import { compactTools } from "../src/tools/compact.ts";

type Patch = (loadout: Record<string, any>) => void;
type Call = (name: string, args: Record<string, unknown>) => Promise<{ text: string; details: Record<string, any>; result: { content: { type: string }[] } }>;

function caller(env: ExecEnv, patch: Patch): Call {
  const raw = structuredClone(BUILTIN_LOADOUTS["compact-v0"]) as Record<string, any>;
  patch(raw);
  const tools = Object.fromEntries(compactTools({ env, loadout: normalizeLoadout(raw), images: true }).map((tool) => [tool.name, tool]));
  return async (name, args) => {
    const tool = tools[name]!;
    const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
    const result = await tool.execute("t", prepared as never);
    return { text: result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join(""), details: result.details as Record<string, any>, result };
  };
}

/** An env whose method calls (from the tools, not the env's own internals) are recorded by name. */
export function countedEnv(env: ExecEnv): { env: ExecEnv; calls: string[] } {
  const calls: string[] = [];
  const proxy = new Proxy(env, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(key));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { env: proxy, calls };
}

const text = async (env: ExecEnv, path: string) => Buffer.from(await env.readFile(path)).toString("utf8");

export function toolSuite(label: string, makeEnv: () => Promise<ExecEnv>): void {
  describe(`${label} tools`, { concurrency: true }, () => {
  const withTools = (name: string, body: (env: ExecEnv, call: Call) => Promise<void>, patch: Patch = () => {}) =>
    test(`${label} tools: ${name}`, async () => {
      const env = await makeEnv();
      try {
        await body(env, caller(env, patch));
      } finally {
        await env.close();
      }
    });

  withTools("read pages a long file, refuses a missing file and an offset past the end, spots binaries and images", async (env, call) => {
    await env.writeFiles!([
      { path: "long.txt", data: Array.from({ length: 3000 }, (_, index) => `line ${index + 1}`).join("\n") },
      { path: "blob.bin", data: new Uint8Array([1, 2, 0, 3]) },
      { path: "pixel.png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ]);
    const first = await call("read", { path: "long.txt" });
    assert.match(first.text, /^line 1\n/u);
    assert.match(first.text, /\[Showing lines 1-2000 of 3000\. Use offset=2001 to continue\.\]$/u);
    const window = await call("read", { path: "long.txt", offset: 10, limit: 2 });
    assert.equal(window.text, "line 10\nline 11\n\n[2989 more lines in file. Use offset=12 to continue.]");
    await assert.rejects(call("read", { path: "missing.txt" }), /File not found: missing.txt/u);
    await assert.rejects(call("read", { path: "long.txt", offset: 5000 }), /beyond end of file/u);
    await assert.rejects(call("read", { path: "." }), /is a directory/u);
    assert.match((await call("read", { path: "blob.bin" })).text, /binary file \(4 bytes\)/u);
    assert.equal((await call("read", { path: "pixel.png" })).result.content[1]?.type, "image");
  });

  withTools("bash keeps head and tail, spills the full output, reports exit codes", async (env, call) => {
    const out = await call("bash", { command: "for i in $(seq 1 5000); do echo row-$i; done" });
    assert.match(out.text, /^row-1\n/u);
    assert.match(out.text, /row-5000$/u);
    assert.match(out.text, /lines, \d+ bytes omitted; full output: \S+\.log/u);
    assert.ok(out.text.split("\n").length <= 2000);
    assert.equal((await text(env, out.details.spill)).trim().split("\n").length, 5000);
    const failed = await call("bash", { command: "echo oops >&2; exit 3" });
    assert.equal(failed.text, "oops\n\nCommand exited with code 3");
    assert.equal(failed.details.exitCode, 3);
    assert.equal((await call("bash", { command: "true" })).text, "(no output)");
  });

  withTools("bash yields; wait resumes the command; wait kill stops one", async (env, call) => {
    const started = Date.now();
    const first = await call("bash", { command: "echo begin; sleep 1.0; echo end", timeout: 0.2 });
    assert.ok(Date.now() - started < 900, "returned at the yield, not at exit");
    assert.match(first.text, /^begin\n\n\[Still running after 0s as process (p\d+)\./u);
    const handle = first.details.handle as string;
    const second = await call("wait", { handle, timeout: 10 });
    assert.equal(second.text, "end");
    assert.equal(second.details.exitCode, 0);
    await assert.rejects(call("wait", { handle }), /no background process/u);
    const slow = await call("bash", { command: "sleep 30", timeout: 0.1 });
    const polled = await call("wait", { handle: slow.details.handle, timeout: 0.1 });
    assert.equal(polled.details.loopExempt, true, "a wait on a live process is never a loop");
    assert.match((await call("wait", { handle: slow.details.handle, kill: true })).text, /Command killed\./u);
  });

  withTools("bash hard timeout kills the whole process group", async (env, call) => {
    const out = await call("bash", { command: "sleep 30 & echo $! > child.pid; sleep 30; echo never" });
    assert.match(out.text, /hard timeout/u);
    const pid = (await text(env, "child.pid")).trim();
    assert.equal((await env.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).output, "gone\n");
  }, (loadout) => { loadout.tools.bash.limits.hard_timeout_s = 0.4; });

  withTools("commands never see the harness's secrets", async (_env, call) => {
    process.env.OPENAI_API_KEY = "sk-secret-test";
    try {
      const out = await call("bash", { command: "echo key=${OPENAI_API_KEY:-none} pager=$PAGER; test -n \"$PATH\" && echo path-ok" });
      assert.equal(out.text, "key=none pager=cat\npath-ok");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  withTools("edit replaces several blocks against the original; write creates parents", async (env, call) => {
    await env.writeFile("m.py", "def f():\n    return 1\n\ndef g():\n    return 2\n");
    const out = await call("edit", { path: "m.py", edits: [{ oldText: "return 1", newText: "return 10" }, { oldText: "return 2", newText: "return 20" }] });
    assert.equal(out.text, "Successfully replaced 2 block(s) in m.py.");
    assert.equal(await text(env, "m.py"), "def f():\n    return 10\n\ndef g():\n    return 20\n");
    await env.writeFile("crlf.txt", "﻿one\r\ntwo\r\n");
    await call("edit", { path: "crlf.txt", old_string: "one\ntwo", new_string: "1\n2" });
    assert.equal(await text(env, "crlf.txt"), "﻿1\r\n2\r\n");
    await assert.rejects(call("edit", { path: "nope.py", edits: [{ oldText: "a", newText: "b" }] }), /File not found: nope.py/u);
    const written = await call("write", { path: "deep/new/file.txt", content: "héllo" });
    assert.equal(written.text, "Successfully wrote 6 bytes to deep/new/file.txt");
    assert.equal(await text(env, "deep/new/file.txt"), "héllo");
  });

  test(`${label} tools: read costs one env call and edit two (read, write); no separate stat`, async (t) => {
    const inner = await makeEnv();
    const { env, calls } = countedEnv(inner);
    try {
      await inner.writeFiles!([{ path: "c.txt", data: "alpha\nbeta\n" }, { path: "d/x.txt", data: "x" }]);
      const call = caller(env, () => {});
      const count = async (name: string, args: Record<string, unknown>) => {
        calls.length = 0;
        const out = await call(name, args).then((result) => result.text, (error: Error) => error.message);
        return { out, calls: [...calls] };
      };
      assert.deepEqual(await count("read", { path: "c.txt" }), { out: "alpha\nbeta\n", calls: ["readFile"] });
      assert.deepEqual(await count("edit", { path: "c.txt", edits: [{ oldText: "beta", newText: "gamma" }] }),
        { out: "Successfully replaced 1 block(s) in c.txt.", calls: ["readFile", "writeFile"] });
      assert.equal(await text(inner, "c.txt"), "alpha\ngamma\n");
      const missing = await count("read", { path: "nope.txt" });
      assert.equal(missing.out, "File not found: nope.txt");
      assert.deepEqual(missing.calls, ["readFile"], "a missing file is known from the read alone");
      const dir = await count("read", { path: "d" });
      assert.equal(dir.out, "d is a directory. Use bash (ls) to list it.");
      assert.ok(dir.calls.length <= 2 && dir.calls[0] === "readFile", dir.calls.join(","));
      t.diagnostic(`${label}: reading a directory took ${dir.calls.join(", ")}`);
      assert.equal((await count("edit", { path: "d", edits: [{ oldText: "a", newText: "b" }] })).out, "File not found: d");
    } finally {
      await inner.close();
    }
  });
  });
}
