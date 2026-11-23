/**
 * The policy and depth levers, offline: a scripted faux model for the run
 * logic (what is appended where, how often), and the loopback Responses
 * server for what reaches the provider (per-request effort, an append-only
 * input, the system prompt with addenda or placebo).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { capListing, formatDuration } from "../src/levers.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { estimateTokens, LEVER_TEXTS, placeboFor } from "../src/prompts.ts";
import { runHarness, systemPromptOf } from "../src/run.ts";
import { wireSetup } from "../src/wire.ts";
import { COMPACT_SCENARIO, EXEC_SCENARIO, isPrefix, runScripted, type Body, type Step } from "./openai-loopback.ts";

const base = (name = "compact-v0-plain") => structuredClone(BUILTIN_LOADOUTS[name]) as Record<string, any>;
const withLevers = (patch: (raw: Record<string, any>) => void, name?: string) => {
  const raw = base(name);
  patch(raw);
  return normalizeLoadout(raw);
};

interface FauxRun {
  result: Awaited<ReturnType<typeof runHarness>>;
  events: Record<string, any>[];
  contexts: TranscriptContext[];
  cwd: string;
}

async function fauxRun(loadout: ReturnType<typeof normalizeLoadout>, steps: FauxStep[], options: { budgets?: Budgets; setup?: (cwd: string) => void } = {}): Promise<FauxRun> {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-levers-")));
  options.setup?.(cwd);
  const env = new LocalEnv({ cwd });
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(step);
  });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-levers-trace-")), "trace.jsonl");
  try {
    const result = await runHarness({
      prompt: "do the task", model: "faux/levers", effort: "high", loadout, env, tracePath, fauxSteps: scripted,
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { result, events, contexts, cwd };
  } finally {
    await env.close();
  }
}

const bash = (command: string): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command } }] });
const write = (path: string, content: string): FauxStep => ({ toolCalls: [{ name: "write", arguments: { path, content } }] });
const textOf = (message: { content: unknown } | undefined) =>
  message === undefined ? "" : typeof message.content === "string" ? message.content
    : (message.content as { type: string; text?: string }[]).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("");
const lastUser = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "user");
const lastTool = (context: TranscriptContext) => [...context.messages].reverse().find((message) => message.role === "toolResult");
const policyEvents = (events: Record<string, any>[]) => events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.reason}`);

// ---------- loadout ----------

test("levers are off by default: absent or false normalizes and hashes like a loadout without them", () => {
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const plain = normalizeLoadout(base(name));
    assert.equal(plain.depth, undefined);
    for (const key of ["evidence_gate", "first_green", "hedge_continue", "discovery"]) assert.equal((plain.policy as unknown as Record<string, unknown>)[key], undefined);
    assert.equal(plain.prompt.addenda, undefined);
    assert.equal(plain.prompt.placebo, undefined);
    const off = withLevers((raw) => {
      raw.policy = { ...raw.policy, evidence_gate: false, first_green: false, hedge_continue: false, discovery: false };
      raw.depth = { escalate: false, wall_notice: false };
    }, name);
    assert.equal(loadoutHash(off), loadoutHash(plain), `${name}: false is off`);
    assert.equal(readLoadout(name).behaviorHash, loadoutHash(plain));
  }
});

test("true turns a lever on with its defaults; an object overrides them; the wording enters the behavior hash", () => {
  const on = withLevers((raw) => {
    raw.policy = { ...raw.policy, evidence_gate: true, first_green: true, hedge_continue: true, discovery: true };
    raw.depth = { escalate: true, wall_notice: true };
  });
  assert.deepEqual(on.policy.evidence_gate, { max: 1, probe: "mtime", text: LEVER_TEXTS.evidence_gate });
  assert.deepEqual(on.policy.first_green, { max: 1, text: LEVER_TEXTS.first_green });
  assert.equal(on.policy.hedge_continue?.max, 1);
  assert.ok((on.policy.hedge_continue?.patterns.length ?? 0) >= 5);
  assert.equal(on.policy.discovery?.max_bytes, 2048);
  assert.deepEqual(on.depth?.escalate, { effort: "xhigh", on: ["after_red", "first_write"], first_write_max: 8 });
  assert.deepEqual(on.depth?.wall_notice, { at_pct: 75, text: LEVER_TEXTS.wall_notice });
  const worded = withLevers((raw) => {
    raw.policy = { ...raw.policy, evidence_gate: { text: "Run the tests." }, first_green: true, hedge_continue: true, discovery: true };
    raw.depth = { escalate: true, wall_notice: true };
  });
  assert.equal(worded.policy.evidence_gate?.text, "Run the tests.");
  assert.notEqual(loadoutHash(worded), loadoutHash(on));
});

test("lever settings fail closed: unknown keys, bad regexes, missing placeholders, placebo without addenda", () => {
  const bad: [string, (raw: Record<string, any>) => void, RegExp][] = [
    ["unknown key", (raw) => (raw.policy.evidence_gate = { maxx: 2 }), /maxx/u],
    ["max 0", (raw) => (raw.policy.first_green = { max: 0 }), /first_green/u],
    ["bad regex", (raw) => (raw.policy.hedge_continue = { patterns: ["("] }), /hedge_continue\.patterns/u],
    ["no {items}", (raw) => (raw.policy.hedge_continue = { text: "Hedged." }), /\{items\}/u],
    ["no {listing}", (raw) => (raw.policy.discovery = { text: "Look." }), /\{listing\}/u],
    ["bad effort", (raw) => (raw.depth = { escalate: { effort: "ultra" } }), /depth/u],
    ["bad trigger", (raw) => (raw.depth = { escalate: { on: ["always"] } }), /depth/u],
    ["at_pct 100", (raw) => (raw.depth = { wall_notice: { at_pct: 100 } }), /wall_notice/u],
    ["placebo alone", (raw) => (raw.prompt.placebo = true), /placebo needs/u],
  ];
  for (const [label, patch, message] of bad) {
    assert.throws(() => withLevers(patch), (error: Error) => error instanceof LoadoutError && message.test(error.message), label);
  }
});

// ---------- P1 evidence gate ----------

test("P1: finishing after an edit with nothing run since gets one continuation; a second finish ends the run", async () => {
  const loadout = withLevers((raw) => (raw.policy.evidence_gate = { probe: "tools" }));
  const run = await fauxRun(loadout, [write("a.py", "print(1)\n"), { text: "Done." }, { text: "Done, really." }]);
  assert.equal(run.result.status, "finished");
  assert.equal(run.result.usage.requests, 3);
  assert.equal(textOf(lastUser(run.contexts[2]!)), LEVER_TEXTS.evidence_gate, "the continuation is a user message after the final answer");
  assert.deepEqual(policyEvents(run.events), ["continue:evidence_gate"]);
  assert.equal(run.events.find((event) => event.reason === "evidence_gate")?.by, "tools");
});

test("P1: a check after the last edit satisfies the gate; an edit after the check does not", async () => {
  const loadout = withLevers((raw) => (raw.policy.evidence_gate = true));
  const ok = await fauxRun(loadout, [write("t.sh", "echo ok\n"), bash("sh t.sh"), { text: "Done." }]);
  assert.equal(ok.result.usage.requests, 3);
  assert.deepEqual(policyEvents(ok.events), []);
  const late = await fauxRun(loadout, [write("t.sh", "echo ok\n"), bash("sh t.sh"), bash("sed -i 's/ok/OK/' t.sh"), { text: "Done." }, { text: "Done." }]);
  assert.equal(late.result.usage.requests, 5);
  assert.deepEqual(policyEvents(late.events), ["continue:evidence_gate"]);
  const none = await fauxRun(loadout, [bash("ls"), { text: "Nothing to change." }]);
  assert.equal(none.result.usage.requests, 2, "no change, no gate");
});

test("P1: the mtime probe catches a write the classifier cannot see; probe tools does not", async () => {
  const awkWrite = bash("awk 'BEGIN { print \"v2\" > \"a.txt\" }'");
  const mtime = await fauxRun(withLevers((raw) => (raw.policy.evidence_gate = { probe: "mtime" })), [awkWrite, { text: "Done." }, { text: "Done." }]);
  assert.equal(mtime.result.usage.requests, 3);
  const event = mtime.events.find((item) => item.reason === "evidence_gate");
  assert.equal(event?.by, "mtime");
  assert.deepEqual(event?.files, ["./a.txt"]);
  const tools = await fauxRun(withLevers((raw) => (raw.policy.evidence_gate = { probe: "tools" })), [awkWrite, { text: "Done." }]);
  assert.equal(tools.result.usage.requests, 2);
  // After a check, the marker moves: a write by an unclassified command after it fires; one before it does not.
  const after = await fauxRun(withLevers((raw) => (raw.policy.evidence_gate = true)), [
    awkWrite, bash("cmp a.txt a.txt"), { text: "Done." },
  ]);
  assert.equal(after.result.usage.requests, 3);
  assert.deepEqual(policyEvents(after.events), []);
});

test("P1: the gate counts on the exec surface (nested apply_patch, then nothing run) and its wording comes from the loadout", async () => {
  const loadout = withLevers((raw) => (raw.policy.evidence_gate = { text: "Prove it." }), "exec-v0");
  const run = await runScripted(loadout, [EXEC_SCENARIO[0]!, { text: "Done." }, { text: "Done." }]);
  assert.equal(run.bodies.length, 3);
  const last = run.bodies[2]!.input.at(-1);
  assert.deepEqual(last, { role: "user", content: [{ type: "input_text", text: "Prove it." }] });
  assert.ok(isPrefix(run.bodies[1]!, run.bodies[2]!));
  const checked = await runScripted(loadout, [EXEC_SCENARIO[0]!, EXEC_SCENARIO[1]!, { text: "Done." }], {
    setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "ok\n"),
  });
  assert.equal(checked.bodies.length, 3, "a nested exec_command check after the patch satisfies the gate");
});

// ---------- P2 first green, hedge ----------

const reminder = (text: string) => `\n[harness] ${text}`;

for (const [name, steps] of [["compact-v0-plain", COMPACT_SCENARIO], ["exec-v0", EXEC_SCENARIO]] as const) {
  test(`P2 on ${name}: the first green after a red carries the reminder; the hedged final is bounced once; every request extends the last`, async () => {
    const loadout = withLevers((raw) => {
      raw.policy.first_green = true;
      raw.policy.hedge_continue = true;
    }, name);
    const run = await runScripted(loadout, [...steps, { text: "Done. I could not verify it either." }], {
      setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n"),
    });
    assert.equal(run.result.status, "finished");
    assert.equal(run.bodies.length, 6, "five scripted requests plus one after the hedge bounce; the second hedge ends the run");
    const outputs = (body: Body): string[] => body.input.filter((item: any) => item.type?.endsWith("call_output")).map((item: any) => item.output as string);
    const red = outputs(run.bodies[2]!).at(-1)!;
    assert.doesNotMatch(red, /\[harness\]/u, "the red check carries nothing");
    const green = outputs(run.bodies[4]!).at(-1)!;
    assert.ok(green.endsWith(reminder(LEVER_TEXTS.first_green)), green);
    assert.equal(outputs(run.bodies[5]!).filter((output) => output.includes(LEVER_TEXTS.first_green)).length, 1, "only the first green");
    const bounce = run.bodies[5]!.input.at(-1);
    assert.equal(bounce.role, "user");
    assert.equal(bounce.content[0].text, LEVER_TEXTS.hedge_continue.replace("{items}", "- I could not verify the edge cases; TODO: add more tests."));
    for (let i = 1; i < run.bodies.length; i++) assert.ok(isPrefix(run.bodies[i - 1]!, run.bodies[i]!), `request ${i + 1} extends request ${i}`);
    const trace = readFileSync(run.tracePath, "utf8");
    assert.match(trace, /"action":"remind","reason":"first_green"/u);
    assert.match(trace, /"action":"continue","reason":"hedge"/u);
  });
}

const scripts = (cwd: string) => {
  writeFileSync(join(cwd, "red.sh"), "echo '1 failed, 2 passed'\n");
  writeFileSync(join(cwd, "fail.sh"), "echo '1 failed'; exit 1\n");
  writeFileSync(join(cwd, "green.sh"), "echo '3 passed'\n");
  writeFileSync(join(cwd, "slow.sh"), "sleep 1.5; echo '2 passed'\n");
};

test("P2: a green without a red before it carries nothing; a red summary under exit 0 is red", async () => {
  const loadout = withLevers((raw) => (raw.policy.first_green = { text: "Check all requirements." }));
  const plain = await fauxRun(loadout, [bash("sh green.sh"), { text: "Done." }], { setup: scripts });
  assert.equal(textOf(lastTool(plain.contexts[1]!)), "3 passed");
  const piped = await fauxRun(loadout, [bash("sh red.sh | tail -1"), bash("sh green.sh | tail -1"), { text: "Done." }], { setup: scripts });
  assert.equal(textOf(lastTool(piped.contexts[2]!)), `3 passed${reminder("Check all requirements.")}`);
});

test("P2: a check that yields resolves through wait; its outcome counts when the exit comes back", async () => {
  const loadout = withLevers((raw) => (raw.policy.first_green = true));
  const run = await fauxRun(loadout, [
    bash("sh fail.sh"),
    { toolCalls: [{ name: "bash", arguments: { command: "sh slow.sh", timeout: 1 } }] },
    { toolCalls: [{ name: "wait", arguments: { handle: "p2" } }] },
    { text: "Done." },
  ], { setup: scripts });
  assert.match(textOf(lastTool(run.contexts[2]!)), /Still running/u);
  assert.doesNotMatch(textOf(lastTool(run.contexts[2]!)), /\[harness\]/u);
  assert.ok(textOf(lastTool(run.contexts[3]!)).endsWith(reminder(LEVER_TEXTS.first_green)), textOf(lastTool(run.contexts[3]!)));
});

test("hedge: a final message without hedges ends the run; a custom pattern list is used", async () => {
  const loadout = withLevers((raw) => (raw.policy.hedge_continue = { patterns: ["\\bmaybe\\b"], text: "About:\n{items}" }));
  const clean = await fauxRun(loadout, [{ text: "Done. I could not be happier." }]);
  assert.equal(clean.result.usage.requests, 1, "the default patterns are replaced");
  const hedged = await fauxRun(loadout, [{ text: "It maybe works." }, { text: "It works." }]);
  assert.equal(hedged.result.usage.requests, 2);
  assert.equal(textOf(lastUser(hedged.contexts[1]!)), "About:\n- It maybe works.");
});

test("the gate goes first: one finish attempt gets at most one continuation", async () => {
  const loadout = withLevers((raw) => {
    raw.policy.evidence_gate = { probe: "tools" };
    raw.policy.hedge_continue = true;
  });
  const run = await fauxRun(loadout, [write("a.py", "x\n"), { text: "Not verified." }, { text: "Still not verified." }, { text: "Done." }]);
  assert.deepEqual(policyEvents(run.events), ["continue:evidence_gate", "continue:hedge"]);
  assert.equal(run.result.usage.requests, 4);
});

// ---------- P3 discovery ----------

test("P3: a pinned read-only listing joins the first message as an orientation block, the same on every trial", async () => {
  const setup = (cwd: string) => {
    mkdirSync(join(cwd, "tests"));
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "node_modules", "x", "tests"), { recursive: true });
    writeFileSync(join(cwd, "tests", "test_a.py"), "");
    writeFileSync(join(cwd, "README.md"), "");
    writeFileSync(join(cwd, "src", "app.py"), "");
    writeFileSync(join(cwd, "verify.sh"), "");
    writeFileSync(join(cwd, "expected_output.json"), "");
  };
  const loadout = withLevers((raw) => (raw.policy.discovery = true));
  const first = async () => {
    const run = await runScripted(loadout, [{ text: "Done." }], { setup });
    const task = run.bodies[0]!.input.find((item: any) => item.role === "user").content[0].text as string;
    return { task: task.slice(task.indexOf("</env>")), trace: readFileSync(run.tracePath, "utf8") };
  };
  const one = await first();
  const listing = "README.md\nexpected_output.json\ntests/\nverify.sh\ntests/test_a.py";
  assert.ok(one.task.endsWith(`Make check.sh pass.\n\n${LEVER_TEXTS.discovery.replace("{listing}", listing)}`), one.task);
  assert.match(one.trace, /"action":"orient","reason":"discovery"/u);
  assert.equal((await first()).task, one.task, "byte-identical across trials of a task");
});

test("P3: the listing is capped at max_bytes on a line boundary, shallow paths first", async () => {
  const loadout = withLevers((raw) => (raw.policy.discovery = { max_bytes: 256 }));
  const run = await runScripted(loadout, [{ text: "Done." }], {
    setup: (cwd) => {
      mkdirSync(join(cwd, "tests"));
      writeFileSync(join(cwd, "README.md"), "");
      for (let i = 0; i < 300; i++) writeFileSync(join(cwd, "tests", `test_${String(i).padStart(3, "0")}.py`), "");
    },
  });
  const task = run.bodies[0]!.input.find((item: any) => item.role === "user").content[0].text as string;
  const listing = task.slice(task.indexOf("turn:\n") + 6, task.indexOf("\n</orientation>"));
  assert.ok(Buffer.byteLength(listing) <= 256, `${Buffer.byteLength(listing)}`);
  assert.ok(listing.startsWith("README.md\ntests/\ntests/test_000.py"), listing);
  assert.match(listing, /\n\[\.\.\. \d+ more\]$/u);
  assert.equal(capListing("", 100), "(none found)");
});

// ---------- D2 effort escalation ----------

test("D2 on the plain wire: the pre-write requests and the request after a red check run at xhigh, the rest at the run's effort; the input only grows", async () => {
  const loadout = withLevers((raw) => (raw.depth = { escalate: true }));
  const steps: Step[] = [{ tool: "read", args: { path: "a.txt" } }, ...COMPACT_SCENARIO];
  const run = await runScripted(loadout, steps, { setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n") });
  assert.equal(run.bodies.length, 6);
  assert.deepEqual(run.bodies.map((body) => body.reasoning.effort), ["xhigh", "xhigh", "high", "xhigh", "high", "high"],
    "read and first write: pre-write; red check; after red; green; final");
  for (let i = 1; i < run.bodies.length; i++) assert.ok(isPrefix(run.bodies[i - 1]!, run.bodies[i]!), `request ${i + 1} extends request ${i}`);
  for (const body of run.bodies) assert.equal(body.input.filter((item: any) => item.type === "configuration_update").length, 0);
  const starts = readFileSync(run.tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "request_start");
  assert.deepEqual(starts.map((event) => event.effort), ["xhigh", "xhigh", "high", "xhigh", "high", "high"]);
});

test("D2: first_write_max caps the pre-write window; after_red alone leaves it alone; never below the run's effort", async () => {
  const reads: Step[] = [{ tool: "read", args: { path: "a.txt" } }, { tool: "read", args: { path: "a.txt" } }, { tool: "read", args: { path: "a.txt" } }];
  const setup = (cwd: string) => writeFileSync(join(cwd, "a.txt"), "x\n");
  const capped = await runScripted(withLevers((raw) => (raw.depth = { escalate: { first_write_max: 2 } })), reads, { setup });
  assert.deepEqual(capped.bodies.map((body) => body.reasoning.effort), ["xhigh", "xhigh", "high", "high"]);
  const redOnly = await runScripted(withLevers((raw) => (raw.depth = { escalate: { on: ["after_red"], effort: "max" } })), COMPACT_SCENARIO, { setup });
  assert.deepEqual(redOnly.bodies.map((body) => body.reasoning.effort), ["high", "high", "max", "high", "high"]);
  const lower = await runScripted(withLevers((raw) => (raw.depth = { escalate: { effort: "medium" } })), reads, { setup, effort: "xhigh" });
  assert.deepEqual(lower.bodies.map((body) => body.reasoning.effort), ["xhigh", "xhigh", "xhigh", "xhigh"]);
});

test("D2 on Pi's default wire (compact-v0): the per-request effort travels as appended configuration_update items", async () => {
  const loadout = withLevers((raw) => (raw.depth = { escalate: { on: ["first_write"] } }), "compact-v0");
  const run = await runScripted(loadout, [{ tool: "read", args: { path: "a.txt" } }, { tool: "write", args: { path: "b.txt", content: "y" } }], {
    setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n"),
  });
  const updates = (body: Body) => body.input.filter((item: any) => item.type === "configuration_update").map((item: any) => item.reasoning.effort);
  assert.equal(updates(run.bodies[0]!).at(-1), "xhigh");
  assert.equal(updates(run.bodies[2]!).at(-1), "high");
  for (let i = 1; i < run.bodies.length; i++) assert.ok(isPrefix(run.bodies[i - 1]!, run.bodies[i]!), `request ${i + 1} extends request ${i}`);
});

test("wire: Anthropic budget thinking follows the effort of the request being rewritten (a run refuses D2 on this wire, below)", () => {
  const model = { id: "claude-x", provider: "anthropic", api: "anthropic-messages", reasoning: true, compat: {} } as never;
  const wire = normalizeLoadout({ ...base(), wire: { mid_convo_effort: false, anthropic: { thinking: "budget" } } }).wire;
  let effort: "high" | "xhigh" = "high";
  const setup = wireSetup(wire, model, "session", () => effort);
  const body = () => ({ max_tokens: 64_000, thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  assert.equal((setup.onPayload!(body(), model) as any).thinking.budget_tokens, 16_384);
  effort = "xhigh";
  assert.equal((setup.onPayload!(body(), model) as any).thinking.budget_tokens, 32_768);
});

test("D2 on the plain wire with trace.cache_monitor: every effort change is named params_change, from and to; the other requests are append-only", async () => {
  const loadout = withLevers((raw) => {
    raw.depth = { escalate: true };
    raw.trace = { cache_monitor: true };
  });
  const run = await runScripted(loadout, [{ tool: "read", args: { path: "a.txt" } }, ...COMPACT_SCENARIO], { setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n") });
  assert.deepEqual(run.bodies.map((body) => body.reasoning.effort), ["xhigh", "xhigh", "high", "xhigh", "high", "high"]);
  const cache = readFileSync(run.tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "cache");
  assert.deepEqual(cache.map((event) => event.reason), ["none", "none", "params_change", "params_change", "params_change", "none"]);
  assert.deepEqual(cache.filter((event) => event.params !== undefined).map((event) => `${event.params.from.reasoning.effort}>${event.params.to.reasoning.effort}`),
    ["xhigh>high", "high>xhigh", "xhigh>high"]);
  for (const event of cache) assert.equal(event.first_diverging_index, null, "the input itself only grows");
});

test("D2 refuses Anthropic with effort as a top-level field (plain wire, budget thinking, no per-message effort); Pi's per-message effort wire runs", async () => {
  const server = createHttpServer((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "loopback refuses" } }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env.D2_GUARD_KEY = "sk-test";
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-d2-guard-")));
  const env = new LocalEnv({ cwd });
  const modelOptions = { anthropicBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, apiKeyEnv: "D2_GUARD_KEY" };
  const go = (loadout: ReturnType<typeof normalizeLoadout>, model = "anthropic/claude-opus-5-5") =>
    runHarness({ prompt: "Say hi.", model, effort: "high", loadout, env, modelOptions });
  try {
    const refused = /depth\.escalate: anthropic\/claude-[\w-]+ would get its effort as a top-level field/u;
    await assert.rejects(go(withLevers((raw) => (raw.depth = { escalate: true }))), refused, "plain wire");
    await assert.rejects(go(withLevers((raw) => {
      raw.depth = { escalate: true };
      raw.wire = { ...raw.wire, anthropic: { thinking: "budget" } };
    })), refused, "budget thinking");
    await assert.rejects(go(withLevers((raw) => (raw.depth = { escalate: true }), "compact-v0"), "anthropic/claude-haiku-4-5"), refused, "a model without per-message effort");
    const ran = await go(withLevers((raw) => (raw.depth = { escalate: true }), "compact-v0"));
    assert.equal(ran.stop_reason, "provider_error", "Pi's default wire passes the guard and reaches the provider");
    const plain = await go(withLevers(() => {}));
    assert.equal(plain.stop_reason, "provider_error", "without D2 the plain wire runs as before");
  } finally {
    server.close();
    await env.close();
  }
});

test("P1, P2 and D2 see an exec_command check that yielded and then finished through R2's wait(session_id, until)", async () => {
  const patch = "*** Begin Patch\n*** Add File: a.py\n+x = 1\n*** End Patch\n";
  const start = (script: string): Step => ({ exec: `const r = await tools.exec_command({ cmd: "sleep 0.3; sh ${script}", yield_time_ms: 100 }); text(String(r.session_id));` });
  const waitOn = (id: number): Step => ({ tool: "wait", args: { session_id: id, until: "exit" } });
  const loadout = withLevers((raw) => {
    raw.policy.evidence_gate = { probe: "tools" };
    raw.policy.first_green = true;
    raw.depth = { escalate: { on: ["after_red"] } };
    raw.tools.wait.limits.until = true;
  }, "exec-v0");
  const run = await runScripted(loadout, [
    { exec: `text(await tools.apply_patch(${JSON.stringify(patch)}));` },
    start("fail.sh"), waitOn(1000), start("green.sh"), waitOn(1001), { text: "Done: a.py added and the check passes." }, { text: "Done again." },
  ], { setup: scripts });
  assert.equal(run.result.status, "finished");
  assert.equal(run.bodies.length, 6, "the check after the patch satisfies the gate: no bounce");
  const trace = readFileSync(run.tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(policyEvents(trace), ["remind:first_green"]);
  const outputs = (body: Body): string[] => body.input.filter((item: any) => item.type?.endsWith("call_output")).map((item: any) => item.output as string);
  assert.match(outputs(run.bodies[3]!).at(-1)!, /Session 1000 exited with code 1/u);
  const green = outputs(run.bodies[5]!).at(-1)!;
  assert.ok(green.endsWith(reminder(LEVER_TEXTS.first_green)), green);
  assert.deepEqual(run.bodies.map((body) => body.reasoning.effort), ["high", "high", "high", "xhigh", "high", "high"], "the request after the red wait runs escalated");
});

// ---------- D3 wall notice ----------

test("D3: past at_pct of the wall budget, one tool result carries the time used and left; never again", async () => {
  const loadout = withLevers((raw) => (raw.depth = { wall_notice: { at_pct: 2 } }));
  const run = await fauxRun(loadout, [bash("sleep 0.3"), bash("echo two"), { text: "Done." }], { budgets: { wall_s: 10 } });
  const first = textOf(lastTool(run.contexts[1]!));
  assert.match(first, /^\(no output\)\n\[harness\] 0 s of the 10 s wall-clock budget is used; about 10 s is left\./u);
  assert.equal(textOf(lastTool(run.contexts[2]!)), "two");
  assert.deepEqual(policyEvents(run.events), ["remind:wall_notice"]);
  const none = await fauxRun(loadout, [bash("sleep 0.3"), { text: "Done." }]);
  assert.equal(textOf(lastTool(none.contexts[1]!)), "(no output)", "no wall budget, no notice");
  assert.equal(formatDuration(95), "95 s");
  assert.equal(formatDuration(1830), "31 min");
});

// ---------- prompt addenda and placebo ----------

test("addenda join the system prompt after the sections; the placebo arm swaps each for neutral text of the same estimated length", async () => {
  const addendum = { id: "p5.adversarial", text: "Before you finish, name what would fail if a requirement were unmet, and run a check that would catch it." };
  const real = withLevers((raw) => (raw.prompt = { ...raw.prompt, addenda: [addendum] }));
  const placebo = withLevers((raw) => (raw.prompt = { ...raw.prompt, addenda: [addendum], placebo: true }));
  const env = new LocalEnv({ cwd: tmpdir() });
  try {
    const plain = systemPromptOf(normalizeLoadout(base()), env);
    assert.equal(systemPromptOf(real, env), `${plain}\n\n${addendum.text}`);
    const swapped = systemPromptOf(placebo, env);
    assert.ok(swapped.startsWith(`${plain}\n\n`));
    const neutral = swapped.slice(plain.length + 2);
    assert.equal(estimateTokens(neutral), estimateTokens(addendum.text));
    assert.equal(neutral, placeboFor(addendum.id, addendum.text), "deterministic");
    assert.doesNotMatch(neutral, /\b(?:finish|requirement|check|fail|run)\b/iu, "asks for nothing");
    assert.notEqual(loadoutHash(real), loadoutHash(placebo));
  } finally {
    await env.close();
  }
  const run = await runScripted(placebo, [{ text: "Done." }]);
  const sent = JSON.stringify(run.bodies[0]);
  assert.ok(sent.includes(JSON.stringify(placeboFor(addendum.id, addendum.text)).slice(1, -1)));
  assert.ok(!sent.includes(addendum.text));
});

test("placebo lengths track the addendum across sizes; different ids start at different sentences", () => {
  for (const text of ["Verify.", "Run the tests. ".repeat(20), "A requirement-level adversarial check: randomized, differential, concurrent inputs. ".repeat(8)]) {
    assert.equal(estimateTokens(placeboFor("a", text)), estimateTokens(text), text.slice(0, 20));
  }
  assert.notEqual(placeboFor("a", "x ".repeat(30)), placeboFor("bb", "x ".repeat(30)));
});
