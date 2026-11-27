/**
 * Two mechanism levers, both off by default:
 * - The yield floor (exec-v0-y10/-y30): every wait the model picks (exec_command's
 *   yield_time_ms, write_stdin's poll, a cell's pragma yield, wait's yield and
 *   until's bound, compact bash's timeout and wait's) holds to a floor; a job
 *   that ends sooner returns at once, and wait(until) still returns when its
 *   condition holds.
 * - limits.token_estimate "dense" (exec-v0-tok): output budgets count tokens by
 *   character class instead of bytes/4, calibrated against o200k_base counts.
 * Offline: LocalEnv, no model.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, loadoutHash, normalizeLoadout, readLoadout } from "../src/loadout.ts";
import { compactTools } from "../src/tools/compact.ts";
import { cellResultText, formattedTruncateText, truncateMiddleTokens } from "../src/tools/exec/format.ts";
import { unifiedRecord, type NestedShared } from "../src/tools/exec/nested.ts";
import { execSurface } from "../src/tools/exec/surface.ts";
import { cutEnd, cutStart, estimateTokens } from "../src/tools/tokens.ts";

const LOADOUTS = join(dirname(fileURLToPath(import.meta.url)), "..", "loadouts");

type Raw = Record<string, any>;

function execSetup(patch: (raw: Raw) => void = () => {}, spec?: string) {
  const env = new LocalEnv({ cwd: mkdtempSync(join(tmpdir(), "harness-yield-")) });
  let loadout;
  if (spec === undefined) {
    const raw = structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as Raw;
    patch(raw);
    loadout = normalizeLoadout(raw);
  } else loadout = readLoadout(spec).loadout;
  const surface = execSurface({ env, loadout, images: true });
  const tools = Object.fromEntries(surface.tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, args: unknown) => {
    const started = performance.now();
    const result = await tools[name]!.execute("call", tools[name]!.prepareArguments?.(args) ?? args);
    const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    return { text, ms: performance.now() - started, details: result.details as Record<string, any> };
  };
  return { call, async close() { await surface.dispose(); await env.close(); } };
}

/** exec-v0 with every model-picked wait floored at `ms`. */
const floored = (ms: number) => (raw: Raw) => {
  raw.tools.exec.limits.min_yield_ms = ms;
  raw.tools.wait.limits.min_yield_ms = ms;
  raw.tools.exec_command.limits.min_yield_ms = ms;
  raw.tools.write_stdin.limits.min_poll_ms = ms;
};

/** The exec_command record a cell printed with text(JSON.stringify(...)). */
const recordOf = (text: string) => JSON.parse(text.slice(text.indexOf("Output:\n") + 8)) as Record<string, unknown>;

describe("yield floor and token estimate", { concurrency: 4 }, () => {
test("the yield floor is off in the built-ins: exec_command's 250 ms (Codex) and no floor on cells, waits or bash", () => {
  for (const name of ["exec-v0", "compact-v0", "compact-v0-plain"]) {
    const tools = readLoadout(name).loadout.tools;
    for (const config of Object.values(tools)) {
      assert.equal(config.limits.min_yield_ms, undefined, name);
      assert.equal(config.limits.min_yield_s, undefined, name);
      assert.equal(config.limits.min_s, undefined, name);
    }
  }
});

test("exec_command: a yield below the floor holds until the command exits; a command still running at the floor yields there", async () => {
  const control = execSetup();
  const lever = execSetup(floored(1_500));
  try {
    const cell = 'text(JSON.stringify(await tools.exec_command({cmd: "sleep 0.55; echo done", yield_time_ms: 100})))';
    const before = recordOf((await control.call("exec", cell)).text);
    assert.equal(before.exit_code, undefined, "without the floor the command is still running at 250 ms");
    assert.equal(typeof before.session_id, "number");

    const held = await lever.call("exec", cell);
    const record = recordOf(held.text);
    assert.equal(record.exit_code, 0);
    assert.equal(record.output, "done\n");
    assert.equal(record.session_id, undefined);
    assert.ok(held.ms >= 450 && held.ms < 1_450, `held until the exit, not the floor (${held.ms} ms)`);

    const quick = await lever.call("exec", 'text(JSON.stringify(await tools.exec_command({cmd: "echo hi", yield_time_ms: 100})))');
    assert.equal(recordOf(quick.text).exit_code, 0);
    assert.ok(quick.ms < 1_400, `a command that exits sooner returns at once (${quick.ms} ms)`);

    const long = await lever.call("exec", 'text(JSON.stringify(await tools.exec_command({cmd: "sleep 30", yield_time_ms: 100})))');
    const running = recordOf(long.text);
    assert.equal(typeof running.session_id, "number", "past the floor the command yields with a session");
    assert.ok(long.ms >= 1_400 && long.ms < 4_500, `yielded at the floor (${long.ms} ms)`);
    assert.ok((running.wall_time_seconds as number) >= 1.4);
  } finally {
    await control.close();
    await lever.close();
  }
});

test("write_stdin: a poll below the floor holds until the session ends", async () => {
  const lever = execSetup(floored(1_000));
  try {
    // Start past the floor: the session yields at 1 s; the poll then waits up to 1 s more and returns at the exit.
    const start = recordOf((await lever.call("exec", 'text(JSON.stringify(await tools.exec_command({cmd: "sleep 1.5; echo end", yield_time_ms: 100})))')).text);
    const session = start.session_id as number;
    assert.equal(typeof session, "number");
    const poll = await lever.call("exec", `text(JSON.stringify(await tools.write_stdin({session_id: ${session}, chars: "", yield_time_ms: 100})))`);
    const record = recordOf(poll.text);
    assert.equal(record.exit_code, 0);
    assert.match(record.output as string, /end/u);
  } finally {
    await lever.close();
  }
});

test("exec cells: a pragma yield below the floor holds the cell; wait's yield and until's bound hold too, and until still returns at its condition", async () => {
  const control = execSetup((raw) => { raw.tools.wait.limits.until = true; });
  const lever = execSetup((raw) => { floored(1_200)(raw); raw.tools.wait.limits.until = true; });
  try {
    const cell = '// @exec: {"yield_time_ms": 100}\nawait new Promise((resolve) => setTimeout(resolve, 400));\ntext("finished")';
    assert.match((await control.call("exec", cell)).text, /^Script running with cell ID \d+/u);
    const held = await lever.call("exec", cell);
    assert.match(held.text, /^Script completed\n[\s\S]*finished$/u);
    assert.ok(held.ms < 1_150, `the cell returned at its end (${held.ms} ms)`);

    // A cell past the floor yields at the floor; wait with a short yield holds until the cell ends.
    const slow = '// @exec: {"yield_time_ms": 100}\nawait new Promise((resolve) => setTimeout(resolve, 1600));\ntext("slow done")';
    const yielded = await lever.call("exec", slow);
    const cellId = /cell ID (\d+)/u.exec(yielded.text)![1]!;
    assert.ok(yielded.ms >= 1_100, `yielded at the floor (${yielded.ms} ms)`);
    const waited = await lever.call("wait", { cell_id: cellId, yield_time_ms: 100 });
    assert.match(waited.text, /^Script completed[\s\S]*slow done$/u);

    // until: the model's 100 ms bound is lifted to the floor, but the wait returns as soon as the line appears.
    await Promise.all(([[control, false], [lever, true]] as const).map(async ([setup, met]) => {
      const start = recordOf((await setup.call("exec", 'text(JSON.stringify(await tools.exec_command({cmd: "sleep 1.5; echo ready; sleep 30", yield_time_ms: 1200})))')).text);
      const result = await setup.call("wait", { session_id: start.session_id, until: "regex:ready", yield_time_ms: 100 });
      assert.equal(/: met after/u.test(result.text), met, result.text);
      assert.ok(result.ms < 1_100, `until returned at the condition or the bound (${result.ms} ms)`);
    }));
  } finally {
    await control.close();
    await lever.close();
  }
});

test("a floored cell waits for a nested exec_command inside its held window instead of yielding an empty running report", async () => {
  // Same floor on the cell and the command: the cell starts first, so its floor passes a moment before the command's.
  const lever = execSetup(floored(800));
  try {
    const result = await lever.call("exec", 'text(JSON.stringify(await tools.exec_command({cmd: "sleep 30", yield_time_ms: 100})))');
    assert.match(result.text, /^Script completed\n/u, "the cell ended with the record, not 'Script running' and nothing");
    assert.equal(typeof recordOf(result.text).session_id, "number");
    // yield_control still returns at once.
    const yielded = await lever.call("exec", 'yield_control();\nawait new Promise((resolve) => setTimeout(resolve, 3000));');
    assert.match(yielded.text, /^Script running with cell ID \d+/u);
    assert.ok(yielded.ms < 1_500, `yield_control is not held (${yielded.ms} ms)`);
  } finally {
    await lever.close();
  }
});

test("exec-v0-y10 acts: a 1 s yield on a 2 s command returns the exit, not a session", async () => {
  const lever = execSetup(undefined, join(LOADOUTS, "exec-v0-y10.json"));
  try {
    const result = await lever.call("exec", 'text(JSON.stringify(await tools.exec_command({cmd: "sleep 2; echo ok", yield_time_ms: 1000})))');
    const record = recordOf(result.text);
    assert.equal(record.exit_code, 0);
    assert.equal(record.session_id, undefined);
  } finally {
    await lever.close();
  }
});

test("compact bash and wait: a timeout below min_yield_s / min_s holds until the command exits", async () => {
  const env = new LocalEnv({ cwd: mkdtempSync(join(tmpdir(), "harness-yield-compact-")) });
  const build = (floor: number) => {
    const raw = structuredClone(BUILTIN_LOADOUTS["compact-v0"]) as Raw;
    raw.tools.bash.limits = { ...(raw.tools.bash.limits ?? {}), ...(floor > 0 ? { min_yield_s: floor } : {}) };
    raw.tools.wait.limits = { ...(raw.tools.wait.limits ?? {}), ...(floor > 0 ? { min_s: floor } : {}) };
    return Object.fromEntries(compactTools({ env, loadout: normalizeLoadout(raw), images: true }).map((tool) => [tool.name, tool]));
  };
  const text = async (tools: Record<string, any>, name: string, args: Raw) =>
    (await tools[name].execute("t", args)).content.map((part: { type: string; text?: string }) => part.text ?? "").join("");
  try {
    const control = build(0);
    assert.match(await text(control, "bash", { command: "sleep 0.5; echo done", timeout: 0.1 }), /Still running after/u);
    const lever = build(1.5);
    const held = await text(lever, "bash", { command: "sleep 0.5; echo done", timeout: 0.1 });
    assert.match(held, /done/u);
    assert.doesNotMatch(held, /Still running/u);
    const started = await text(lever, "bash", { command: "sleep 2.0; echo late", timeout: 0.1 });
    const handle = /handle "(p\d+)"/u.exec(started)![1]!;
    assert.match(await text(lever, "wait", { handle, timeout: 0.1 }), /late/u);
  } finally {
    await env.close();
  }
});

test("token_estimate: bytes4 is Codex's count; dense counts digits and symbols denser than prose", () => {
  assert.equal(estimateTokens("abcdefgh"), 2);
  assert.equal(estimateTokens("é"), 1);
  const prose = "The parser reads each record and returns the result to the caller when the stream ends.\n";
  const numbers = "1734.25 9921.003 18.5 772910 0.000341 55.12\n".repeat(20);
  assert.ok(Math.abs(estimateTokens(prose, "dense") / estimateTokens(prose) - 1) < 0.35, "prose stays near bytes/4");
  assert.ok(estimateTokens(numbers, "dense") >= 1.6 * estimateTokens(numbers), "numbers count >= 1.6x bytes/4");
  assert.equal(estimateTokens("", "dense"), 0);
  // A long repeat cannot slip past a budget.
  assert.ok(estimateTokens("=".repeat(16_000), "dense") >= 1_000);
  assert.ok(estimateTokens(" ".repeat(16_000), "dense") >= 1_000);
});

test("token_estimate dense is calibrated against o200k_base (synthetic tool outputs; counts from js-tiktoken)", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/token-calibration.json", import.meta.url), "utf8")) as { samples: { kind: string; o200k: number; text: string }[] };
  const errors = (mode: "bytes4" | "dense") => fixture.samples.map((sample) => estimateTokens(sample.text, mode) / sample.o200k - 1);
  const median = (values: number[]) => [...values].map(Math.abs).sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const dense = errors("dense");
  const bytes4 = errors("bytes4");
  assert.ok(median(dense) < 0.15, `dense median |error| ${median(dense)}`);
  assert.ok(median(dense) < median(bytes4) / 2, `dense ${median(dense)} vs bytes4 ${median(bytes4)}`);
  assert.ok(Math.min(...dense) > -0.25, `dense never undercounts a sample by a quarter (${Math.min(...dense)})`);
  for (const kind of ["csv", "numbers", "hexdump", "sequence", "json"]) {
    const samples = fixture.samples.filter((sample) => sample.kind === kind);
    const real = samples.reduce((sum, sample) => sum + sample.o200k, 0);
    const ratio = (mode: "bytes4" | "dense") => samples.reduce((sum, sample) => sum + estimateTokens(sample.text, mode), 0) / real;
    assert.ok(Math.abs(ratio("dense") - 1) < 0.15, `${kind}: dense ${ratio("dense")}`);
    assert.ok(ratio("bytes4") < 0.8, `${kind}: bytes4 undercounts (${ratio("bytes4")})`);
  }
});

test("cutStart/cutEnd keep the longest prefix/suffix within a dense budget and never split a surrogate pair", () => {
  const text = "row 17: 0x7f3a 1823.55 ok\n".repeat(300) + "😀".repeat(50);
  for (const budget of [0, 1, 7, 50, 333, 2_000]) {
    const head = cutStart(text, budget);
    const tail = cutEnd(text, budget);
    assert.ok(text.startsWith(head) && text.endsWith(tail));
    assert.ok(estimateTokens(head, "dense") <= budget + 1 && estimateTokens(tail, "dense") <= budget + 1, `budget ${budget}`);
    if (head.length < text.length) assert.ok(estimateTokens(text.slice(0, head.length + 2), "dense") > budget - 1, `head is maximal at ${budget}`);
    assert.ok(head.isWellFormed() && tail.isWellFormed());
  }
  assert.equal(cutStart(text, 1e9), text);
  assert.equal(cutEnd(text, 1e9), text);
});

test("dense budgets: the same 'max_output_tokens' keeps fewer bytes of symbol-dense output; bytes4 output is unchanged", () => {
  const numbers = Array.from({ length: 3_000 }, (_, i) => `${i},${(i * 7.31).toFixed(3)},${(i * 13) % 997}`).join("\n");
  const bytes4 = formattedTruncateText(numbers, 1_000);
  assert.equal(bytes4, formattedTruncateText(numbers, 1_000, undefined, "bytes4"));
  assert.match(bytes4, /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: 3000\n\n/u);
  const dense = formattedTruncateText(numbers, 1_000, undefined, "dense");
  const body = (text: string) => text.slice(text.indexOf("\n\n") + 2);
  assert.ok(Buffer.byteLength(body(dense)) < 0.7 * Buffer.byteLength(body(bytes4)), "dense keeps fewer bytes");
  assert.ok(estimateTokens(body(dense), "dense") <= 1_000 + 20, "and about the budget in dense tokens");
  const marker = /…(\d+) tokens truncated…/u.exec(dense)!;
  assert.ok(Number(marker[1]) > 0);
  assert.equal(truncateMiddleTokens("short", 100, "dense"), "short");
  assert.equal(truncateMiddleTokens("1 2 3 4", 0, "dense"), `…${estimateTokens("1 2 3 4", "dense")} tokens truncated…`);
  // The cell's own budget and the exec_command record's original_token_count follow the mode.
  const items = [numbers];
  assert.equal(cellResultText("completed", 1, items, 1_000).truncated, true);
  const budget = Math.ceil(Buffer.byteLength(numbers) / 4) + 100;
  assert.equal(cellResultText("completed", 1, items, budget).truncated, false, "bytes4: fits");
  assert.equal(cellResultText("completed", 1, items, budget, undefined, "dense").truncated, true, "dense: digits count ~1.6x and do not");
  const shared = (tokens?: "dense") => ({ env: {} as never, sessions: new Map(), nextSession: 1, chunks: 0, inflight: new Map(), ...(tokens === undefined ? {} : { tokens }) }) as NestedShared;
  const run = { exitCode: 0, output: numbers, truncated: false, durationMs: 1, totalBytes: Buffer.byteLength(numbers), running: false };
  const codex = unifiedRecord(shared(), run, performance.now(), undefined, undefined);
  const counted = unifiedRecord(shared("dense"), run, performance.now(), undefined, undefined);
  assert.equal(codex.original_token_count, Math.ceil(Buffer.byteLength(numbers) / 4));
  assert.equal(counted.original_token_count, estimateTokens(numbers, "dense"));
});

test("exec-v0-tok: limits.token_estimate dense reaches the cell budget; bytes4 normalizes away (same behavior_hash as exec-v0)", async () => {
  const base = readLoadout("exec-v0");
  const spelled = structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as Raw;
  spelled.limits.token_estimate = "bytes4";
  assert.equal(loadoutHash(normalizeLoadout(spelled)), base.behaviorHash);
  const tok = readLoadout(join(LOADOUTS, "exec-v0-tok.json"));
  assert.equal(tok.loadout.limits.token_estimate, "dense");
  assert.notEqual(tok.behaviorHash, base.behaviorHash);
  const cell = '// @exec: {"max_output_tokens": 500}\ntext(Array.from({length: 2000}, (_, i) => i * 37).join(","))';
  const sizes: number[] = [];
  for (const setup of [execSetup(), execSetup(undefined, join(LOADOUTS, "exec-v0-tok.json"))]) {
    try {
      const result = await setup.call("exec", cell);
      assert.match(result.text, /Warning: truncated output/u);
      sizes.push(Buffer.byteLength(result.text));
    } finally {
      await setup.close();
    }
  }
  assert.ok(sizes[1]! < 0.7 * sizes[0]!, `dense ships fewer bytes of digits (${sizes.join(" vs ")})`);
});
});
