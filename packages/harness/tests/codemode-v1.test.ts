/**
 * exec-v1 (research/codemode/findings.md): four flags off by default, each removing a friction source the code-mode
 * census measured, and loadouts/exec-v1.json composing them with exec.batch.
 *
 * - tools.exec.limits.describe "v1": truthful, shorter exec/nested/wait descriptions (yields are caps, a non-zero exit
 *   does not throw, wait is not on `tools`, no stdin, no PTY/deferred tools/MCP/approval arguments), numbers from the
 *   loadout's limits.
 * - tools.exec.limits.error_hints: a script error on its own line, with the fix for tools.wait, a syntax error's line
 *   and a missing image.
 * - tools.exec.limits.cut_notice: a cut result names the output lines it dropped and the file with the whole output;
 *   nested records cut to their own budget are saved too (before: the cut part was gone).
 * - tools.apply_patch.limits.nearest: a chunk that does not match shows the file's nearest lines, numbered.
 *
 * Off, b5 and c9 (the candidate loadouts) and exec-v0/exec-v0-batch hash and render exactly as before (pinned from
 * v3 156559b in fixtures/codemode-pins.json), and results keep Codex's v0 text. Offline; LocalEnv; no
 * model calls.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, LoadoutError, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import { estimateTokens } from "../src/prompts.ts";
import { applyPatch, nearestWindow, type PatchIO } from "../src/tools/exec/apply-patch.ts";
import { BATCH_LINES, BATCH_PLACEBO } from "../src/tools/exec/describe.ts";
import { cutNoticeText, execRepeatKey, cutNoticeRepeatKey, omittedLines } from "../src/tools/exec/format.ts";
import { NESTED_SPECS } from "../src/tools/exec/nested.ts";
import { execSurface } from "../src/tools/exec/surface.ts";

type Raw = Record<string, any>;
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/codemode-pins.json", import.meta.url), "utf8")) as {
  loadouts: Record<string, Raw>;
  pins: Record<string, { loadout_hash: string; behavior_hash: string; exec: string; wait: string }>;
};
const LOADOUTS = new URL("../loadouts/", import.meta.url).pathname;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A loadout file path for a pinned name (b5/c9 written from the fixture, the others from loadouts/ or the built-ins). */
function specOf(name: string): string {
  if (FIXTURE.loadouts[name] === undefined) return Object.hasOwn(BUILTIN_LOADOUTS, name) ? name : join(LOADOUTS, `${name}.json`);
  const dir = mkdtempSync(join(tmpdir(), "harness-pin-r2-"));
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(FIXTURE.loadouts[name], null, 2));
  return path;
}

/** exec-v0 with per-tool limits merged in. */
function loadoutWith(limits: Record<string, Raw> = {}): Loadout {
  const raw = structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as Raw;
  for (const [tool, extra] of Object.entries(limits)) {
    raw.tools[tool] ??= { exposure: "eager" };
    raw.tools[tool].limits = { ...(raw.tools[tool].limits ?? {}), ...extra };
  }
  return normalizeLoadout(raw);
}

function surfaceOf(loadout: Loadout, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-cm1-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const env = new LocalEnv({ cwd: dir });
  const surface = execSurface({ env, loadout, images: false });
  const tools = Object.fromEntries(surface.tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, args: unknown) => {
    const result = await tools[name]!.execute("t", (tools[name]!.prepareArguments?.(args) ?? args) as never);
    return { text: result.content.map((part) => ("text" in part ? part.text : "")).join(""), details: result.details as Raw };
  };
  return { dir, env, tools, call, cell: (code: string) => call("exec", { input: code }), async close() { await surface.dispose(); await env.close(); } };
}

const toolHashes = (loadout: Loadout) => {
  const env = new LocalEnv({ cwd: tmpdir() });
  const surface = execSurface({ env, loadout, images: true });
  const out = Object.fromEntries(surface.tools.map((tool) => [tool.name, sha(`${tool.description}\n${JSON.stringify(tool.parameters)}`)]));
  return { out, async close() { await surface.dispose(); await env.close(); } };
};

test("flags off: b5, c9, exec-v0 and exec-v0-batch hash and render exactly as before exec-v1", async () => {
  for (const [name, pin] of Object.entries(FIXTURE.pins)) {
    const loaded = readLoadout(specOf(name));
    assert.equal(loaded.loadoutHash, pin.loadout_hash, `${name} loadout_hash`);
    assert.equal(loaded.behaviorHash, pin.behavior_hash, `${name} behavior_hash`);
    const { out, close } = toolHashes(loaded.loadout);
    try {
      assert.deepEqual(out, { exec: pin.exec, wait: pin.wait }, `${name}: exec/wait description or parameters moved`);
    } finally {
      await close();
    }
  }
});

test("flags off: results keep Codex's v0 text (glued script error, plain cut, re-read advice, v0 ALL_TOOLS)", async () => {
  const b5 = readLoadout(specOf("b5")).loadout;
  const s = surfaceOf(b5, { "a.py": "def parse(s):\n    return s.strip()\n" });
  try {
    const glued = await s.cell("text(await tools.exec_command({cmd: \"printf abc\"})); await tools.view_image({path: \"nope.png\"});");
    assert.match(glued.text, /"output":"abc"\}Script error:\nError: unable to locate image at `nope\.png`: No such file or directory \(os error 2\)$/u, glued.text);
    const cut = await s.cell("text(await tools.exec_command({cmd: \"seq 1 2000\", max_output_tokens: 100}));");
    assert.match(cut.text, /"output":"Warning: truncated output \(original token count: \d+\)\\nTotal output lines: 2000\\n\\n1\\n2/u);
    assert.ok(!cut.text.includes("Full output") && !cut.text.includes("Omitted:"), cut.text);
    const patch = await s.cell("text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: a.py\\n@@\\n-    return s.strip( )\\n+    return s\\n*** End Patch\"));");
    assert.match(patch.text, /is not in the file\); re-read .*a\.py and resend the patch$/u, patch.text);
    const meta = await s.cell("text(ALL_TOOLS)");
    for (const name of ["apply_patch", "exec_command", "view_image", "write_stdin"] as const) assert.ok(meta.text.includes(JSON.stringify(NESTED_SPECS[name].description)), name);
  } finally {
    await s.close();
  }
});

test("describe v1: true to the implementation, numbers from the loadout, shorter, nothing Codex-only", async () => {
  const v0 = surfaceOf(loadoutWith({ exec: { batch: true } }));
  // As exec-v1.json has it: MCP types off (v1 still renders them when a loadout asks, see the next test).
  const v1 = surfaceOf(loadoutWith({ exec: { batch: true, describe: "v1", mcp_types: false } }));
  try {
    const before = v0.tools.exec!.description;
    const after = v1.tools.exec!.description;
    for (const gone of ["PTY", "deferred", "Shared MCP Types", "justification", "prefix_rule", "sandbox_permissions", "custom_tool_call_output", "V8", "Tool availability can change"]) {
      assert.ok(before.includes(gone), `v0 has ${gone}`);
      assert.ok(!after.includes(gone), `v1 still says ${gone}`);
    }
    for (const said of [
      "is the longest the call waits, not a delay: it returns as soon as the command exits",
      "A non-zero `exit_code` does not throw",
      "`wait` is a separate tool, not on `tools`",
      "There is no stdin",
      "apply_patch(input: string): Promise<string>",
      "(250 ms to 30000 ms)", "(5000 ms to 300000 ms)", "default 10000 ms. It returns as soon as the command exits.",
      BATCH_LINES,
    ]) assert.ok(after.includes(said), said);
    assert.equal(after.split(BATCH_LINES).length, 2, "one batching example");
    assert.ok(estimateTokens(after) < 0.85 * estimateTokens(before), `${estimateTokens(after)} vs ${estimateTokens(before)}`);
    assert.ok(!/Use `wait` only after/u.test(v1.tools.wait!.description));
    assert.match(v1.tools.wait!.description, /`yield_time_ms` is the longest this call waits \(default 10000 ms\); it returns as soon as the cell ends\./u);
    // ALL_TOOLS carries the v1 nested descriptions too.
    const meta = await v1.cell("text(ALL_TOOLS.map((t) => t.name + ': ' + t.description).join('\\n'))");
    assert.match(meta.text, /exec_command: Runs a shell command \(no TTY, no stdin\)/u);
  } finally {
    await v0.close();
    await v1.close();
  }
});

test("describe v1: yield floors, until, aliases, placebo and an mcp_types request all show in the text", async () => {
  const floors = surfaceOf(loadoutWith({ exec: { describe: "v1", aliases: true, batch: true, batch_placebo: true }, exec_command: { min_yield_ms: 10_000 }, write_stdin: { min_poll_ms: 30_000 }, wait: { until: true } }));
  const mcp = surfaceOf(loadoutWith({ exec: { describe: "v1", mcp_types: true } }));
  try {
    const text = floors.tools.exec!.description;
    assert.ok(text.includes("(10000 ms to 30000 ms)") && text.includes("(30000 ms to 300000 ms)") && text.includes("10000 ms to 30000 ms, default 10000 ms"), text);
    assert.ok(text.includes("end the cell and call `wait` with `{session_id, until: \"exit\"}`"));
    assert.ok(text.includes("- `sh(cmd: string") && text.includes("- `read(path: string"));
    assert.ok(text.includes(BATCH_PLACEBO) && !text.includes(BATCH_LINES));
    assert.match(floors.tools.wait!.description, /^Waits on a running `exec` cell, or with `until` on a running `exec_command` session/u);
    assert.ok(floors.tools.wait!.description.includes("`session_id` instead of `cell_id`"));
    assert.ok(mcp.tools.exec!.description.includes("Shared MCP Types"));
    assert.ok(!mcp.tools.exec!.description.includes("with `{session_id, until"), "no until: no session wait advertised");
  } finally {
    await floors.close();
    await mcp.close();
  }
});

test("describe v1: its examples run as written, and calls behave exactly as under v0", async () => {
  // A 1x1 PNG for the image() example.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const v1 = surfaceOf(loadoutWith({ exec: { describe: "v1", batch: true } }), { "src/m.py": "def parse(s):\n    return s\n", "setup.py": "setup()\n" });
  writeFileSync(join(v1.dir, "plot.png"), png);
  const v0 = surfaceOf(loadoutWith({ exec: { batch: true } }), { "src/m.py": "def parse(s):\n    return s\n", "setup.py": "setup()\n" });
  try {
    const example = /for example `(image\([^`]+\))`/u.exec(v1.tools.exec!.description)![1]!;
    const shown = await v1.call("exec", { input: example });
    assert.match(shown.text, /^Script completed\n/u, shown.text);
    const batch = /for example `(const results[^`]+)`/u.exec(v1.tools.exec!.description)![1]!;
    const [a, b] = [await v1.cell(batch), await v0.cell(batch)];
    const strip = (text: string) => execRepeatKey(text);
    assert.equal(strip(a.text), strip(b.text), "same cell, same result under v1 and v0");
    // A long cap returns at the command's exit, as the v1 text says.
    const began = performance.now();
    const quick = await v1.cell("text(await tools.exec_command({cmd: \"echo done\", yield_time_ms: 30000}));");
    assert.ok(performance.now() - began < 5000, "a 30 s cap on a quick command returned at once");
    assert.match(quick.text, /"exit_code":0[^\n]*"output":"done\\n"/u);
  } finally {
    await v1.close();
    await v0.close();
  }
});

test("error_hints: the script error starts its own line, and tools.wait, syntax errors and a missing image say how to fix them", async () => {
  const s = surfaceOf(loadoutWith({ exec: { error_hints: true }, wait: { until: true } }));
  try {
    const wait = await s.cell("text(await tools.exec_command({cmd: \"printf abc\"}));\nawait tools.wait({session_id: 1000});");
    assert.match(wait.text, /"output":"abc"\}\nScript error:\nTypeError: tools\.wait does not exist\./u, wait.text);
    assert.ok(!wait.text.includes("searchTools"), "no searchTools() offered: this surface has none");
    assert.match(wait.text, /`wait` is a separate tool, not on `tools`: end this cell, then call wait with `\{session_id, until: "exit"\}`/u);
    const syntax = await s.cell("const x = 1;\nconst y = ;\ntext(x);");
    assert.match(syntax.text, /Script error:\nSyntaxError:[^\n]*\n\s+at codemode\.js:2:\d+\nCell line 2: const y = ;$/u, syntax.text);
    const pragma = await s.call("exec", { input: "// @exec: {\"yield_time_ms\": 5000}\ntext(1);\nconst = 2;" });
    assert.match(pragma.text, /Cell line 3: const = 2;$/u, pragma.text);
    const image = await s.cell("await tools.view_image({path: \"nope.png\"});");
    assert.match(image.text, /unable to locate image at `nope\.png`: No such file or directory \(os error 2\); if a command in this cell was to write it, check that command's exit_code/u);
    assert.equal(image.details.failed, true);
  } finally {
    await s.close();
  }
});

test("cut_notice: a record cut to its own budget names the omitted lines and saves the whole output, which the sed range reads back", async () => {
  const s = surfaceOf(loadoutWith({ exec: { cut_notice: true } }));
  try {
    const first = await s.cell("const r = await tools.exec_command({cmd: \"seq 1 2000\", max_output_tokens: 100}); text(r.output);");
    const out = first.text;
    const spill = /^Full output: (\S+)$/mu.exec(out)![1]!;
    const range = /^Omitted: output lines (\d+)-(\d+) \(sed -n '(\d+),(\d+)p' (\S+)\)$/mu.exec(out)!;
    assert.ok(range !== null, out);
    assert.equal(range[5], spill);
    assert.equal(readFileSync(spill, "utf8"), Array.from({ length: 2000 }, (_, i) => `${i + 1}\n`).join(""));
    const [lo, hi] = [Number(range[1]), Number(range[2])];
    // The shown head ends inside line `lo` (or just before it) and the tail starts inside line `hi` (or just after it).
    const shown = out.slice(out.indexOf("\n\n") + 2);
    const headLast = shown.split("…")[0]!.split("\n").at(-1)!;
    const tailFirst = shown.split("…").at(-1)!.split("\n")[0]!;
    assert.ok(headLast === "" || String(lo).startsWith(headLast), `head ends with ${JSON.stringify(headLast)}, omitted from ${lo}`);
    assert.ok(tailFirst === "" || String(hi).endsWith(tailFirst) || Number(tailFirst) === hi + 1, `tail starts with ${JSON.stringify(tailFirst)}, omitted to ${hi}`);
    const back = await s.cell(`text((await tools.exec_command({cmd: "sed -n '${lo},${hi}p' ${spill} | head -1; sed -n '${lo},${hi}p' ${spill} | tail -1"})).output);`);
    assert.match(back.text, new RegExp(`Output:\\n${lo}\\n${hi}\\n$`, "u"));
    // Two identical cut runs are a repeat for the loop policy: the per-call spill paths do not count.
    const again = await s.cell("const r = await tools.exec_command({cmd: \"seq 1 2000\", max_output_tokens: 100}); text(r.output);");
    assert.notEqual(first.text, again.text);
    assert.equal(first.details.repeatKey, again.details.repeatKey);
    // The cell-level cut names the same things.
    const cell = await s.call("exec", { input: "// @exec: {\"max_output_tokens\": 50}\ntext((await tools.exec_command({cmd: \"seq 1 500\"})).output);" });
    assert.match(cell.text, /^Output:\nWarning: truncated output \(original token count: \d+\)\nTotal output lines: 500\nFull output: \S+\nOmitted: output lines \d+-\d+ \(sed -n '\d+,\d+p' \S+\)\n\n1\n/mu, cell.text);
  } finally {
    await s.close();
  }
});

test("cut_notice: omitted lines match the cut, within budget nothing changes, and without a file there is no sed hint", () => {
  const text = Array.from({ length: 300 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
  assert.equal(cutNoticeText("short\n", 100, "/x.log"), "short\n");
  for (const mode of ["bytes4", "dense"] as const) {
    const cut = omittedLines(text, 60, mode)!;
    const shown = cutNoticeText(text, 60, undefined, mode);
    assert.match(shown, new RegExp(`^Warning: truncated output \\(original token count: \\d+\\)\\nTotal output lines: 300\\nOmitted: output lines ${cut.first}-${cut.last}\\n\\n`, "u"));
    const body = shown.slice(shown.indexOf("\n\n") + 2);
    const headLast = body.split("…")[0]!.split("\n").at(-1)!;
    assert.ok(`row ${cut.first}`.startsWith(headLast) || headLast === "", `${mode}: head ends inside row ${cut.first}: ${JSON.stringify(headLast)}`);
    const tailFirst = body.split("…").at(-1)!.split("\n")[0]!;
    assert.ok(`row ${cut.last}`.endsWith(tailFirst) || tailFirst === "" || tailFirst === `row ${cut.last + 1}`, `${mode}: tail starts inside row ${cut.last} or at the next: ${JSON.stringify(tailFirst)}`);
  }
  assert.equal(cutNoticeRepeatKey("no notice Full output: /a"), "no notice Full output: /a", "keys without a notice are untouched");
});

test("apply_patch nearest: the error shows the file's nearest lines, numbered; nothing is written; order mistakes are named", async () => {
  const file = ["import os", "", "class Parser:", "    def parse(self, s):", "        s = s.strip()", "        return s", "", "    def close(self):", "        return None", ""].join("\n");
  const files = new Map<string, string>([["p.py", file]]);
  const io: PatchIO = { read: async (path) => files.get(path), write: async (path, text) => void files.set(path, text), remove: async (path) => void files.delete(path) };
  const wrong = "*** Begin Patch\n*** Update File: p.py\n@@\n     def parse(self, s):\n-        s = s.strip( )\n+        s = s.strip().lower()\n         return s\n*** End Patch";
  await assert.rejects(applyPatch(wrong, io), (error: Error) => /re-read p\.py and resend the patch$/u.test(error.message) && !error.message.includes("nearest"));
  await assert.rejects(applyPatch(wrong, io, { nearest: true }), (error: Error) => {
    assert.match(error.message, /\("        s = s\.strip\( \)" is not in the file\); the nearest lines in p\.py \(3-7\), as the file has them now:\n     3\tclass Parser:\n     4\t    def parse\(self, s\):\n     5\t        s = s\.strip\(\)\n     6\t        return s\n     7\t\nFix the chunk from these lines and resend the patch\.$/u);
    return true;
  });
  assert.equal(files.get("p.py"), file, "nothing written");
  const swapped = "*** Begin Patch\n*** Update File: p.py\n@@\n     def close(self):\n-        return None\n+        return 0\n@@\n     def parse(self, s):\n-        s = s.strip()\n+        s = s.lower()\n*** End Patch";
  await assert.rejects(applyPatch(swapped, io, { nearest: true }), /they are at lines 4-5, above where the previous chunk matched \(line 9\); put the chunks of one Update File in file order/u);
  const anchor = "*** Begin Patch\n*** Update File: p.py\n@@ def close(self):\n         return None\n@@ class Parser:\n+# note\n*** End Patch";
  await assert.rejects(applyPatch(anchor, io, { nearest: true }), /the @@ line "class Parser:" is at line 3, above where the previous chunk matched/u);
  const nothing = "*** Begin Patch\n*** Update File: p.py\n@@\n-totally absent line\n+x\n*** End Patch";
  await assert.rejects(applyPatch(nothing, io, { nearest: true }), /re-read p\.py and resend the patch$/u);
  // Rare lines outvote common ones: a lone `return s` elsewhere does not pull the window away.
  assert.deepEqual(nearestWindow(["return s", "x", "y", "def f(a):", "    a = 1", "return s"], ["def f(a):", "    a = 2", "return s"], 0), { start: 2, end: 6 });
});

test("apply_patch nearest through the exec surface: one failed cell, then a fixed patch from the shown lines lands", async () => {
  const s = surfaceOf(loadoutWith({ apply_patch: { nearest: true } }), { "a.py": "def parse(s):\n    return s.strip()\n" });
  try {
    const failed = await s.cell("text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: a.py\\n@@\\n def parse(s):\\n-    return s.strip( )\\n+    return s\\n*** End Patch\"));");
    assert.match(failed.text, /the nearest lines in a\.py \(1-2\), as the file has them now:\n     1\tdef parse\(s\):\n     2\t    return s\.strip\(\)\n/u, failed.text);
    assert.equal(failed.details.failed, true);
    const fixed = await s.cell("text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: a.py\\n@@\\n def parse(s):\\n-    return s.strip()\\n+    return s\\n*** End Patch\"));");
    assert.match(fixed.text, /Success\. Updated the following files:\nM a\.py/u);
    assert.equal(readFileSync(join(s.dir, "a.py"), "utf8"), "def parse(s):\n    return s\n");
  } finally {
    await s.close();
  }
});

test("the new limits validate: describe is v0 or v1, the rest are booleans", () => {
  const env = new LocalEnv({ cwd: tmpdir() });
  try {
    assert.throws(() => execSurface({ env, loadout: loadoutWith({ exec: { describe: "v2" } }), images: false }), (error: Error) => error instanceof LoadoutError && /describe: want "v0" or "v1"/u.test(error.message));
    assert.throws(() => execSurface({ env, loadout: loadoutWith({ exec: { error_hints: "yes" } }), images: false }), /tools\.exec\.limits\.error_hints: want boolean/u);
    assert.throws(() => execSurface({ env, loadout: loadoutWith({ exec: { cut_notice: 1 } }), images: false }), /tools\.exec\.limits\.cut_notice: want boolean/u);
    assert.throws(() => execSurface({ env, loadout: loadoutWith({ apply_patch: { nearest: "on" } }), images: false }), /tools\.apply_patch\.limits\.nearest: want boolean/u);
  } finally {
    void env.close();
  }
});

test("loadouts/exec-v1.json: exec-v0 plus batch, the four exec-v1 flags and no MCP types", async () => {
  const v1 = readLoadout(join(LOADOUTS, "exec-v1.json"));
  const v0 = readLoadout("exec-v0").loadout;
  assert.equal(v1.name, "exec-v1");
  assert.deepEqual(v1.loadout.tools.exec!.limits, { ...v0.tools.exec!.limits, batch: true, describe: "v1", error_hints: true, cut_notice: true, mcp_types: false });
  assert.deepEqual(v1.loadout.tools.apply_patch!.limits, { nearest: true });
  assert.deepEqual({ ...v1.loadout, name: "", tools: {} }, { ...v0, name: "", tools: {} }, "only tools change");
  for (const name of ["exec_command", "view_image", "wait", "write_stdin"]) assert.deepEqual(v1.loadout.tools[name], v0.tools[name], name);
  const s = surfaceOf(v1.loadout);
  try {
    assert.ok(!s.tools.exec!.description.includes("Shared MCP Types"));
    assert.ok(s.tools.exec!.description.includes(BATCH_LINES));
  } finally {
    await s.close();
  }
});
