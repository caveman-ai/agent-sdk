/**
 * exec.batch (tools.exec.limits.batch): the exec description carries Codex 0.163's batching rules and its
 * Promise.allSettled cell; batch_placebo puts equal-length neutral text in the same place. Off, the description is
 * byte-for-byte what it was (the built-in request bodies are pinned in builtin-bodies.test.ts). The example in the
 * description runs as written in a real cell, its nested calls overlap, and a check of a running session rides along
 * with a read in one report. Offline; LocalEnv; no model calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, normalizeLoadout } from "../src/loadout.ts";
import { estimateTokens } from "../src/prompts.ts";
import { BATCH_LINES, BATCH_PLACEBO, EXEC_DESCRIPTION, execToolDescription } from "../src/tools/exec/describe.ts";
import { NESTED_SPECS } from "../src/tools/exec/nested.ts";
import { execSurface } from "../src/tools/exec/surface.ts";

type Raw = Record<string, any>;
const ANCHOR = "unawaited promises are silently discarded.";

function exec(limits: Raw = {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-batch-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const raw = structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as Raw;
  Object.assign(raw.tools.exec.limits, limits);
  const env = new LocalEnv({ cwd: dir });
  const surface = execSurface({ env, loadout: normalizeLoadout(raw), images: false });
  const tools = Object.fromEntries(surface.tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, args: unknown) => {
    const result = await tools[name]!.execute("t", (tools[name]!.prepareArguments?.(args) ?? args) as never);
    return result.content.map((part) => ("text" in part ? part.text : "")).join("");
  };
  return { tools, call, async close() { await surface.dispose(); await env.close(); } };
}

/** The example cell as the batch lines show it, between the backticks after "for example" (the base description has its own). */
const exampleCell = (description: string) => {
  assert.ok(description.includes(BATCH_LINES));
  return /for example `([^`]+)`/u.exec(BATCH_LINES)![1]!;
};

test("exec.batch off: the description is exactly the one before the flag, with and without aliases", async () => {
  const specs = Object.values(NESTED_SPECS);
  assert.equal(execToolDescription(specs, true, false, "off"), execToolDescription(specs, true, false));
  assert.equal(execToolDescription(specs, true, true, "off"), execToolDescription(specs, true, true));
  const off = exec();
  const plain = exec({ batch: false });
  try {
    assert.equal(off.tools.exec!.description, plain.tools.exec!.description);
    assert.ok(off.tools.exec!.description.startsWith(EXEC_DESCRIPTION));
    for (const phrase of ["Promise.allSettled", "Batch independent", "Parallelize"]) assert.ok(!off.tools.exec!.description.includes(phrase), phrase);
  } finally {
    await off.close();
    await plain.close();
  }
});

test("exec.batch on: Codex's batching rules follow the unawaited-promises line; aliases still list after the helpers", async () => {
  const on = exec({ batch: true, aliases: true });
  try {
    const description = on.tools.exec!.description;
    assert.ok(description.includes(`${ANCHOR}\n${BATCH_LINES}\n\n- Global helpers:`), description.slice(0, 2000));
    assert.equal(description.split(BATCH_LINES).length, 2, "once");
    assert.ok(description.indexOf("- `sh(cmd: string") > description.indexOf("- Global helpers:"));
    assert.match(BATCH_LINES, /Keep dependencies, edits, waits, and adaptive follow-ups sequential\./u);
    assert.ok(!on.tools.wait!.description.includes("Promise"), "wait is unchanged");
  } finally {
    await on.close();
  }
});

test("exec.batch placebo: equal-length neutral text in the same place, none of the batching wording; it needs batch", async () => {
  assert.equal(estimateTokens(BATCH_PLACEBO), estimateTokens(BATCH_LINES));
  for (const phrase of ["Promise", "Batch", "batch", "parallel", "Parallel", "independent", "await", "exec"]) assert.ok(!BATCH_PLACEBO.includes(phrase), phrase);
  const plac = exec({ batch: true, batch_placebo: true });
  try {
    assert.ok(plac.tools.exec!.description.includes(`${ANCHOR}\n${BATCH_PLACEBO}\n\n- Global helpers:`));
    assert.ok(!plac.tools.exec!.description.includes("Promise.allSettled"));
  } finally {
    await plac.close();
  }
  const env = new LocalEnv({ cwd: mkdtempSync(join(tmpdir(), "harness-batch-bad-")) });
  try {
    const loadout = (limits: Raw) => {
      const raw = structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as Raw;
      Object.assign(raw.tools.exec.limits, limits);
      return normalizeLoadout(raw);
    };
    assert.throws(() => execSurface({ env, loadout: loadout({ batch_placebo: true }), images: false }), (error: Error) => error instanceof LoadoutError && /batch_placebo needs/u.test(error.message));
    assert.throws(() => execSurface({ env, loadout: loadout({ batch: "yes" }), images: false }), /tools\.exec\.limits\.batch: want boolean/u);
  } finally {
    await env.close();
  }
});

test("exec.batch: the description's example runs as written, both results in one report", async () => {
  const { tools, call, close } = exec({ batch: true }, { "src/m.py": "x = 1\ndef parse(s):\n    return s\n", "setup.py": "from setuptools import setup\nsetup(name='m')\n" });
  try {
    const out = await call("exec", exampleCell(tools.exec!.description));
    assert.match(out, /^Script completed\n/u, out);
    assert.match(out, /\{"i":0,"status":"fulfilled","value":\{[^\n]*"exit_code":0[^\n]*src\/m\.py:2:def parse/u, out);
    assert.match(out, /\{"i":1,"status":"fulfilled","value":\{[^\n]*"exit_code":0[^\n]*setup\(name='m'\)/u, out);
  } finally {
    await close();
  }
});

test("exec.batch: nested calls awaited together overlap, and a session check rides along with a read", async () => {
  const { call, close } = exec({ batch: true }, { "notes.txt": "alpha\n" });
  try {
    const began = performance.now();
    const both = await call("exec", "const r = await Promise.allSettled([tools.exec_command({cmd: \"sleep 1; echo one\"}), tools.exec_command({cmd: \"sleep 1; echo two\"})]); r.forEach((x) => text(x.value.output));");
    const seconds = (performance.now() - began) / 1000;
    assert.match(both, /one\n[\s\S]*two\n/u, both);
    assert.ok(seconds < 1.8, `two 1 s commands took ${seconds.toFixed(2)} s: not concurrent`);
    // A job that yields, then one cell that checks it and reads a file: one report carries both.
    const launched = await call("exec", "text(await tools.exec_command({cmd: \"sleep 1; echo built\", yield_time_ms: 250}));");
    const session = Number(/"session_id":(\d+)/u.exec(launched)![1]);
    const cell = `const r = await Promise.allSettled([tools.write_stdin({session_id: ${session}, chars: "", yield_time_ms: 5000}), tools.exec_command({cmd: "cat notes.txt"})]); r.forEach((x, i) => text({i, ...x}));`;
    const out = await call("exec", cell);
    assert.match(out, /"i":0,"status":"fulfilled","value":\{[^\n]*"exit_code":0[^\n]*built/u, out);
    assert.match(out, /"i":1,"status":"fulfilled","value":\{[^\n]*alpha/u, out);
  } finally {
    await close();
  }
});
