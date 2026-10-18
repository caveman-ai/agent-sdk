import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  DiskDurableStore,
  agent,
  auto,
  createConversation,
  run,
  schema,
  stream,
  subagent,
  tool,
} from "../dist/index.js";
import sandboxAgent from "./fixtures/sandbox-agent.mjs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxModel } from "../dist/testing.js";

const receiptSchema = JSON.parse(readFileSync(
  new URL("../../shared/contracts/schemas/agent-run-receipt.schema.json", import.meta.url),
  "utf8",
));
const validateReceipt = new Ajv2020({ strict: true, allErrors: true }).compile(receiptSchema);

function assertSharedReceiptContract(receipt) {
  const wire = JSON.parse(JSON.stringify(receipt));
  assert.equal(
    validateReceipt(wire),
    true,
    validateReceipt.errors === null ? "invalid receipt" : JSON.stringify(validateReceipt.errors),
  );
}

const pricedFauxModel = () => fauxModel({ priced: true });

function usage(fields = {}) {
  const input = fields.input ?? 100;
  const output = fields.output ?? 10;
  return {
    input,
    output,
    cacheRead: fields.cacheRead ?? 0,
    cacheWrite: fields.cacheWrite ?? 0,
    reasoning: 0,
    totalTokens: input + output + (fields.cacheRead ?? 0) + (fields.cacheWrite ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushMessage(selected, content, stopReason, used) {
  const messageStream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: used,
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    messageStream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    messageStream.push({ type: "done", reason: stopReason, message });
    messageStream.end(message);
  });
  return messageStream;
}

function durableCompactionOptions(runId, store) {
  const model = {
    ...pricedFauxModel(),
    id: "claude-opus-4-1",
    contextWindow: 200_000,
    maxTokens: 4_000,
  };
  const summarizerModel = pricedFauxModel();
  return (streamFn) => ({
    ensureRuntime: false,
    model,
    durable: { runId, store },
    budget: {
      maxUsd: 4,
      onExhausted: "compact",
      compaction: {
        minYieldTokens: 1_000,
        headroomCalls: 1,
        keepRecentTokens: 2_000,
        summarizerModel,
      },
    },
    streamFn,
  });
}

function isSummarizerContext(runContext) {
  const last = runContext.messages.at(-1);
  return typeof last?.content === "string" &&
    last.content.includes("Reply with a single JSON object");
}

function compactionWorkingTurn(selected, call) {
  return pushMessage(
    selected,
    [
      { type: "text", text: `${"x".repeat(8_000)}-${call}` },
      { type: "toolCall", id: `poll-${call}`, name: "poll", arguments: {} },
    ],
    "toolUse",
    usage({ input: 500, output: 800, cacheRead: 8_000 }),
  );
}

function pollingAgent(id, onPoll = () => "polled: 3 items") {
  return agent({
    id,
    instructions: "Poll, then answer.",
    model: auto(),
    sandbox: "fixture",
    tools: [tool({
      name: "poll",
      description: "Poll the queue.",
      input: schema.object({}),
      effect: "read",
      allowRepeat: true,
      execute: onPoll,
    })],
  });
}

async function scratchStore() {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-durable-"));
  return { dir, store: new DiskDurableStore(dir) };
}

function batchHasEvent(data, type) {
  return data.trim().split("\n").some((line) => JSON.parse(line).type === type);
}

function failOnceAt(store, type, timing) {
  let armed = true;
  return {
    load: (runId) => store.load(runId),
    acquire: (runId) => store.acquire(runId),
    close: (runId) => store.close(runId),
    async append(runId, data) {
      if (armed && batchHasEvent(data, type)) {
        armed = false;
        if (timing === "after") await store.append(runId, data);
        throw new Error(`simulated_${type}_${timing}_failure`);
      }
      await store.append(runId, data);
    },
  };
}

function effectAgent(id, effect, execute, input = schema.object({})) {
  return agent({
    id,
    instructions: "Call act, then answer.",
    model: auto(),
    sandbox: effect === "write" || effect === "external" ? "host" : "fixture",
    tools: [tool({
      name: "act",
      description: "Execute one test effect.",
      input,
      effect,
      allowRepeat: true,
      execute,
    })],
  });
}

async function journalPath(dir, runId) {
  const { readdir } = await import("node:fs/promises");
  const entry = (await readdir(dir)).find((name) => name.startsWith(`${runId}-`));
  assert.notEqual(entry, undefined, `no journal directory for ${runId}`);
  return resolve(dir, entry, "journal.jsonl");
}

async function journalLines(dir, runId) {
  const raw = await readFile(await journalPath(dir, runId), "utf8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Crash mid-provider-call, resume continues from the completed turn.
// ---------------------------------------------------------------------------

test("a run crashed mid-call resumes from its last completed turn without re-asking", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-continue");
  const runId = "ticket-1";
  const controller = new AbortController();
  let firstAttemptCalls = 0;
  const iterator = stream(defined, "how many items are queued?", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected) => {
      firstAttemptCalls++;
      if (firstAttemptCalls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage({ input: 120, output: 15 }),
        );
      }
      // The "crash": the process dies while call 2 is in flight. Its intent
      // is journaled; its usage never lands.
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  const events = [];
  for await (const event of iterator) events.push(event);
  assert.equal(events.at(-1).type, "run_error");
  assert.equal(firstAttemptCalls, 2);

  // The in-process abort unwinds cleanly enough to close a pre-stream intent.
  // A process death cannot write that final abandonment, so trim it to model
  // the exact crash window this test covers.
  const crashedPath = await journalPath(dir, runId);
  const written = (await readFile(crashedPath, "utf8")).split("\n").filter(Boolean);
  const lastIntent = written.findLastIndex((entry) => JSON.parse(entry).type === "call_started");
  const survived = written.filter((entry, index) =>
    !(index > lastIntent && JSON.parse(entry).type === "call_abandoned"));
  await writeFile(crashedPath, `${survived.join("\n")}\n`);

  // The journal is pending (no terminal event), holds the completed turn,
  // the settled first call, and the unmatched second intent.
  const lines = await journalLines(dir, runId);
  assert.equal(lines.some((entry) => entry.type === "run_failed"), false);
  assert.equal(lines.some((entry) => entry.type === "run_completed"), false);
  assert.equal(lines.filter((entry) => entry.type === "turn").length, 1);
  assert.equal(lines.filter((entry) => entry.type === "call_settled").length, 1);
  assert.equal(lines.filter((entry) => entry.type === "call_started").length, 2);
  // Pi 1.0's leading system message is rebuilt from the definition each run;
  // the journal never carries one a resume would then trust.
  assert.equal(lines.some((entry) => Array.isArray(entry.messages) &&
    entry.messages.some((message) => message.role === "system")), false);

  let secondAttemptContexts = [];
  const result = await run(defined, "how many items are queued?", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn: (selected, context) => {
      secondAttemptContexts.push(context.messages.map((message) => message.role));
      return pushMessage(
        selected,
        [{ type: "text", text: "3 items are queued" }],
        "stop",
        usage({ input: 200, output: 20 }),
      );
    },
  });
  assert.equal(result.text, "3 items are queued");
  assert.equal(result.resumed, true);
  // The resumed context continues the transcript: exactly one user message
  // (never the prompt twice), ending at the crashed run's tool result.
  assert.equal(secondAttemptContexts.length, 1);
  const roles = secondAttemptContexts[0];
  assert.equal(roles.filter((role) => role === "user").length, 1);
  assert.equal(roles[0], "system");
  assert.equal(roles.filter((role) => role === "system").length, 1);
  assert.equal(roles.at(-1), "toolResult");
  // Totals cover the whole logical run; the resume block attributes it.
  assert.equal(result.inputTokens, 120 + 200);
  assert.equal(result.outputTokens, 15 + 20);
  assert.equal(result.receipt.resume.attempts, 2);
  assert.equal(result.receipt.resume.priorCalls, 1);
  assert.equal(result.receipt.resume.possibleDoubleCountCalls, 1);
  assert.equal(result.receipt.resume.discardedPartialTurn, false);
  assert.equal(result.receipt.calls.length, 1);
  assertSharedReceiptContract(result.receipt);
});

// ---------------------------------------------------------------------------
// Crash mid-tool (no completed turn): fresh restart, spend still counted.
// ---------------------------------------------------------------------------

test("a run whose crash lost the turn replays its settled tool without losing spend", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const controller = new AbortController();
  const defined = pollingAgent("durable-fresh");
  const runId = "ticket-2";
  let calls = 0;
  const iterator = stream(defined, "poll once", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    budget: { maxTokens: 100_000 },
    streamFn: (selected) => {
      calls++;
      if (calls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage({ input: 300, output: 30 }),
        );
      }
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  for await (const _event of iterator) { /* drain to termination */ }

  // A SIGKILL loses whatever was not yet flushed. The in-process simulation
  // above flushes everything on its way down, so reproduce the killed
  // process's journal directly: settled money made it to disk, the turn's
  // conversation state did not.
  const truncatedPath = await journalPath(dir, runId);
  const written = (await readFile(truncatedPath, "utf8")).split("\n").filter(Boolean);
  const lastIntent = written.findLastIndex((line) => JSON.parse(line).type === "call_started");
  const survived = written.filter((line, index) => {
    const type = JSON.parse(line).type;
    if (type === "turn") return false;
    // The graceful in-process teardown may close or settle the last intent;
    // a killed process writes neither terminal provider event.
    if ((type === "call_settled" || type === "call_abandoned") && index > lastIntent) return false;
    return true;
  });
  await writeFile(truncatedPath, `${survived.join("\n")}\n`);

  const contexts = [];
  let resumedCalls = 0;
  const result = await run(defined, "poll once", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    budget: { maxTokens: 100_000 },
    streamFn: (selected, context) => {
      contexts.push(context.messages.map((message) => message.role));
      resumedCalls++;
      if (resumedCalls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage({ input: 150, output: 12 }),
        );
      }
      return pushMessage(
        selected,
        [{ type: "text", text: "done" }],
        "stop",
        usage({ input: 100, output: 10 }),
      );
    },
  });
  // No completed turn survived, so the run restarted from the prompt alone…
  assert.equal(contexts[0].filter((role) => role === "user").length, 1);
  assert.equal(contexts[0].at(-1), "user");
  assert.equal(contexts[1].at(-1), "toolResult");
  // …but the crashed attempt's settled call is preloaded, not forgotten: the
  // meter's spent figure covers both attempts, and the call that was in
  // flight at the crash is surfaced, not guessed at.
  assert.equal(result.receipt.resume.priorCalls, 1);
  assert.equal(result.receipt.resume.priorSettled, 330);
  assert.equal(result.receipt.resume.possibleDoubleCountCalls, 1);
  assert.equal(result.receipt.spent, 330 + 162 + 110);
  assert.equal(result.resumed, true);
  assertSharedReceiptContract(result.receipt);
});

// ---------------------------------------------------------------------------
// Terminal outcomes replay without spending (idempotency key semantics).
// ---------------------------------------------------------------------------

test("a completed durable run returns its journaled result without spending again", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-idempotent");
  const runId = "ticket-3";
  const options = (streamFn) => ({
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn,
  });
  const first = await run(defined, "answer", options((selected) => pushMessage(
    selected,
    [{ type: "text", text: "the answer" }],
    "stop",
    usage(),
  )));
  assert.equal(first.text, "the answer");
  let replayCalls = 0;
  const replay = await run(defined, "answer", options(() => {
    replayCalls++;
    throw new Error("must not be called");
  }));
  assert.equal(replayCalls, 0);
  assert.equal(replay.text, "the answer");
  assert.equal(replay.runId, runId);
});

test("a failed durable run replays its error without spending again", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-terminal-error");
  const runId = "ticket-4";
  const options = (streamFn) => ({
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn,
  });
  let firstError;
  try {
    await run(defined, "answer", options(() => {
      throw new Error("provider exploded");
    }));
  } catch (error) {
    firstError = error;
  }
  assert.notEqual(firstError, undefined);
  let replayCalls = 0;
  let replayError;
  try {
    await run(defined, "answer", options(() => {
      replayCalls++;
      throw new Error("must not be called");
    }));
  } catch (error) {
    replayError = error;
  }
  assert.equal(replayCalls, 0);
  assert.notEqual(replayError, undefined);
  assert.equal(replayError.message, firstError.message);
});

test("budgeted unavailable compaction journals its reservation and replays terminal failure", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-unavailable-compaction");
  const runId = "durable-unavailable-compaction";
  const summary = JSON.stringify({
    schema_version: 2,
    generation: 1,
    objective: "Answer the user's question.",
    anchors: [],
    constraints_restated: ["reply in one word"],
    decisions: [{ decision: "polled", why: "pending" }],
    artifacts: [{ path: "queue", change: "observed" }],
    facts: ["job id 7"],
    state: { completed: ["polled"], active: ["waiting"], blocked: [] },
    next: ["poll again"],
    citations: [],
    lookup_hints: ["queue status"],
  });
  const options = durableCompactionOptions(runId, store);

  let workingCalls = 0;
  let summarizerCalls = 0;
  let firstError;
  try {
    await run(defined, "go", options((selected, runContext) => {
      if (isSummarizerContext(runContext)) {
        summarizerCalls += 1;
        return pushMessage(
          selected,
          [{ type: "text", text: summary }],
          "stop",
          {
            input: 5_000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        );
      }
      workingCalls += 1;
      if (summarizerCalls > 0) {
        return pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
      }
      return compactionWorkingTurn(selected, workingCalls);
    }));
  } catch (error) {
    firstError = error;
  }
  assert.match(firstError?.message ?? "", /cave_provider_terminal_error/);
  assert.equal(summarizerCalls, 1);
  assert.equal(firstError.receipt.calls.length, workingCalls + summarizerCalls);

  const events = await journalLines(dir, runId);
  const meterCalls = events.filter((event) => event.type === "meter_call");
  assert.deepEqual(meterCalls.map((event) => event.atCall),
    Array.from({ length: workingCalls + summarizerCalls }, (_, index) => index + 1));
  const unavailable = events.find((event) =>
    event.type === "call_settled" && event.kind === "compaction" &&
    event.call.usageBasis === "unavailable");
  assert.notEqual(unavailable, undefined);
  assert.equal(Number.isFinite(unavailable.settledAmount), true);
  assert.equal(unavailable.settledAmount > 0, true);
  assert.equal(events.some((event) => event.type === "run_failed"), true);

  let replayCalls = 0;
  let replayError;
  try {
    await run(defined, "go", options(() => {
      replayCalls += 1;
      throw new Error("terminal replay must not call provider");
    }));
  } catch (error) {
    replayError = error;
  }
  assert.equal(replayCalls, 0);
  assert.equal(replayError?.message, firstError.message);
});

test("a pre-stream compaction rejection is abandoned and completed replay spends nothing", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-abandoned-compaction");
  const runId = "durable-abandoned-compaction";
  const options = durableCompactionOptions(runId, store);
  let workingCalls = 0;
  let summarizerAttempts = 0;

  const first = await run(defined, "go", options((selected, runContext) => {
    if (isSummarizerContext(runContext)) {
      summarizerAttempts += 1;
      throw new Error("summarizer unavailable before stream");
    }
    workingCalls += 1;
    if (summarizerAttempts > 0) {
      return pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
    }
    return compactionWorkingTurn(selected, workingCalls);
  }));

  assert.equal(first.text, "done");
  assert.equal(summarizerAttempts, 1);
  assert.equal(first.receipt.calls.length, workingCalls);
  const events = await journalLines(dir, runId);
  const meterCalls = events.filter((event) => event.type === "meter_call");
  assert.deepEqual(meterCalls.map((event) => event.atCall),
    Array.from({ length: workingCalls + 1 }, (_, index) => index + 1));
  assert.equal(events.filter((event) =>
    event.type === "call_started" && event.kind === "compaction").length, 1);
  assert.equal(events.filter((event) => event.type === "call_abandoned").length, 1);
  assert.equal(events.filter((event) =>
    event.type === "call_settled" && event.kind === "compaction").length, 0);
  assert.equal(events.filter((event) => event.type === "run_completed").length, 1);

  let replayCalls = 0;
  const replay = await run(defined, "go", options(() => {
    replayCalls += 1;
    throw new Error("completed replay must not call provider");
  }));
  assert.equal(replayCalls, 0);
  assert.deepEqual(replay, first);
});

test("a post-stream compaction failure settles worst case and replays terminal failure", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-partial-compaction");
  const runId = "durable-partial-compaction";
  const options = durableCompactionOptions(runId, store);
  let providerInvocations = 0;
  let workingCalls = 0;
  let summarizerCalls = 0;
  let firstError;

  await assert.rejects(
    run(defined, "go", options((selected, runContext) => {
      providerInvocations += 1;
      if (isSummarizerContext(runContext)) {
        summarizerCalls += 1;
        const partial = {
          role: "assistant",
          content: [],
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          usage: usage({ input: 0, output: 0 }),
          stopReason: "pending",
          timestamp: Date.now(),
        };
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial };
            throw new Error("summarizer stream interrupted");
          },
          async result() {
            throw new Error("summarizer terminal unavailable");
          },
        };
      }
      workingCalls += 1;
      return compactionWorkingTurn(selected, workingCalls);
    })),
    (error) => {
      firstError = error;
      return /cave_provider_terminal_error/.test(error.message);
    },
  );

  assert.equal(summarizerCalls, 1);
  assert.equal(firstError.receipt.calls.length, providerInvocations);
  assert.equal(firstError.receipt.calls.at(-1).usageBasis, "unavailable");
  assert.equal(firstError.receipt.spent <= firstError.receipt.released, true);
  const events = await journalLines(dir, runId);
  const meterCalls = events.filter((event) => event.type === "meter_call");
  assert.deepEqual(meterCalls.map((event) => event.atCall),
    Array.from({ length: providerInvocations }, (_, index) => index + 1));
  const settlement = events.find((event) =>
    event.type === "call_settled" && event.kind === "compaction" &&
    event.call.usageBasis === "unavailable");
  assert.notEqual(settlement, undefined);
  assert.equal(settlement.settledAmount > 0, true);
  assert.equal(events.filter((event) => event.type === "call_abandoned").length, 0);
  assert.equal(events.filter((event) => event.type === "run_failed").length, 1);

  let replayCalls = 0;
  let replayError;
  await assert.rejects(
    run(defined, "go", options(() => {
      replayCalls += 1;
      throw new Error("failed replay must not call provider");
    })),
    (error) => {
      replayError = error;
      return true;
    },
  );
  assert.equal(replayCalls, 0);
  assert.equal(replayError.message, firstError.message);
  assert.deepEqual(replayError.receipt, firstError.receipt);
});

// ---------------------------------------------------------------------------
// Identity fails closed.
// ---------------------------------------------------------------------------

test("resume with a changed definition or input fails closed", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runId = "ticket-5";
  const controller = new AbortController();
  let crash = true;
  const defined = pollingAgent("durable-identity", () => {
    if (crash) {
      controller.abort(new Error("crash"));
      return new Promise(() => {});
    }
    return "polled";
  });
  const iterator = stream(defined, "original input", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
      "toolUse",
      usage(),
    ),
  });
  for await (const _event of iterator) { /* drain */ }

  const changedDefinition = agent({
    id: "durable-identity",
    instructions: "Different brain entirely.",
    model: auto(),
    sandbox: "fixture",
  });
  await assert.rejects(
    run(changedDefinition, "original input", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId, store },
      streamFn: () => { throw new Error("must not be called"); },
    }),
    /cave_durable_definition_changed/,
  );
  await assert.rejects(
    run(defined, "different input", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId, store },
      streamFn: () => { throw new Error("must not be called"); },
    }),
    /cave_durable_input_mismatch/,
  );
  await assert.rejects(
    run(defined, "original input", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId, store },
      budget: { maxTokens: 5_000 },
      streamFn: () => { throw new Error("must not be called"); },
    }),
    /cave_durable_budget_changed/,
  );
});

// ---------------------------------------------------------------------------
// Option guards and the lock.
// ---------------------------------------------------------------------------

test("durable option combinations fail closed before any spend", async () => {
  const defined = pollingAgent("durable-guards");
  const base = {
    ensureRuntime: false,
    model: fauxModel(),
    streamFn: () => { throw new Error("must not be called"); },
  };
  await assert.rejects(
    run(defined, "go", { ...base, durable: { runId: "bad id with spaces" } }),
    /cave_durable_run_id_invalid/,
  );
  await assert.rejects(
    run(defined, "go", { ...base, durable: { runId: "ok-2" }, maxCostUsd: 5 }),
    /cave_durable_max_cost_usd_unsupported/,
  );
});

test("two processes cannot drive one durable run", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = await store.acquire("ticket-6");
  await assert.rejects(store.acquire("ticket-6"), /cave_durable_run_locked/);
  await release();
  const again = await store.acquire("ticket-6");
  await again();
});

test("terminal fsync repairs one public conversation without repeating intent or spend", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faulting = failOnceAt(store, "run_completed", "after");
  const conversation = createConversation();
  const defined = agent({
    id: "durable-conversation",
    instructions: "Answer once.",
    model: auto(),
    sandbox: "fixture",
  });
  let providerCalls = 0;
  await assert.rejects(
    run(defined, "one durable intent", {
      ensureRuntime: false,
      conversation,
      model: fauxModel(),
      durable: { runId: "conversation-terminal", store: faulting },
      streamFn: (selected) => {
        providerCalls++;
        return pushMessage(selected, [{ type: "text", text: "one answer" }], "stop", usage());
      },
    }),
    /simulated_run_completed_after_failure/,
  );
  assert.equal(providerCalls, 1);
  assert.equal(conversation.snapshot().messages.length, 0);

  let replayProviderCalls = 0;
  const result = await run(defined, "one durable intent", {
    ensureRuntime: false,
    conversation,
    model: fauxModel(),
    durable: { runId: "conversation-terminal", store: faulting },
    streamFn: () => {
      replayProviderCalls++;
      throw new Error("completed replay must not call provider");
    },
  });
  assert.equal(result.text, "one answer");
  assert.equal(replayProviderCalls, 0);
  assert.equal(
    (JSON.stringify(conversation.snapshot().messages).match(/one durable intent/g) ?? []).length,
    1,
  );
  assert.equal(conversation.snapshot().messages.some((message) => message.role === "system"), false);

  let mismatchedProviderCalls = 0;
  await assert.rejects(
    run(defined, "one durable intent", {
      ensureRuntime: false,
      conversation: createConversation(),
      model: fauxModel(),
      durable: { runId: "conversation-terminal", store: faulting },
      streamFn: () => {
        mismatchedProviderCalls++;
        throw new Error("must not spend for a mismatched conversation");
      },
    }),
    /cave_durable_(?:session|conversation)_mismatch/,
  );
  assert.equal(mismatchedProviderCalls, 0);
});

test("failed replay refuses a conversation advanced beyond its bound base", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const conversation = createConversation();
  const defined = agent({
    id: "durable-failed-conversation",
    instructions: "Answer.",
    model: auto(),
    sandbox: "fixture",
  });
  await assert.rejects(
    run(defined, "fail once", {
      ensureRuntime: false,
      conversation,
      model: fauxModel(),
      durable: { runId: "failed-conversation", store },
      streamFn: () => { throw new Error("provider failed"); },
    }),
    /cave_provider_terminal_error/,
  );
  await run(defined, "advance", {
    ensureRuntime: false,
    conversation,
    model: fauxModel(),
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "text", text: "advanced" }],
      "stop",
      usage(),
    ),
  });
  let replayProviderCalls = 0;
  await assert.rejects(
    run(defined, "fail once", {
      ensureRuntime: false,
      conversation,
      model: fauxModel(),
      durable: { runId: "failed-conversation", store },
      streamFn: () => {
        replayProviderCalls++;
        throw new Error("must not spend");
      },
    }),
    /cave_durable_conversation_mismatch/,
  );
  assert.equal(replayProviderCalls, 0);
});

test("conversation lock wins before a competing durable journal is created", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const conversation = createConversation();
  const defined = agent({
    id: "durable-conversation-lock",
    instructions: "Answer.",
    model: auto(),
    sandbox: "fixture",
  });
  const active = stream(defined, "first", {
    ensureRuntime: false,
    conversation,
    model: fauxModel(),
    durable: { runId: "conversation-lock-owner", store },
    streamFn: () => { throw new Error("must not be called"); },
  });
  assert.equal((await active.next()).value.type, "run_start");
  await assert.rejects(
    run(defined, "second", {
      ensureRuntime: false,
      conversation,
      model: fauxModel(),
      durable: { runId: "conversation-lock-loser", store },
      streamFn: () => { throw new Error("must not be called"); },
    }),
    /cave_conversation_in_use/,
  );
  assert.deepEqual(await store.load("conversation-lock-loser"), []);
  await active.return();
});

test("crash after read intent but before I/O safely re-drives exactly once", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faulting = failOnceAt(store, "tool_intent", "after");
  const conversation = createConversation();
  const invocations = [];
  const defined = effectAgent("durable-read-redrive", "read", (_input, _signal, context) => {
    invocations.push(context?.durable);
    return "read-value";
  });
  let firstProviderCalls = 0;
  await assert.rejects(
    run(defined, "read", {
      ensureRuntime: false,
      conversation,
      model: fauxModel(),
      durable: { runId: "read-intent-crash", store: faulting },
      streamFn: (selected) => {
        firstProviderCalls++;
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "read-1", name: "act", arguments: {} }],
          "toolUse",
          usage(),
        );
      },
    }),
    /simulated_tool_intent_after_failure/,
  );
  assert.equal(firstProviderCalls, 1);
  assert.equal(invocations.length, 0);

  let resumeProviderCalls = 0;
  const result = await run(defined, "read", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId: "read-intent-crash", store: faulting },
    streamFn: (selected) => {
      resumeProviderCalls++;
      return resumeProviderCalls === 1
        ? pushMessage(
          selected,
          [{ type: "toolCall", id: "read-1", name: "act", arguments: {} }],
          "toolUse",
          usage(),
        )
        : pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
    },
  });
  assert.equal(result.text, "done");
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].resumed, true);
  assert.match(invocations[0].idempotencyKey, /^cave-[0-9a-f]{64}$/);
  const completed = (await journalLines(dir, "read-intent-crash"))
    .find((event) => event.type === "run_completed");
  assert.equal(completed.conversation.sessionId, conversation.sessionId);
  let replayProviderCalls = 0;
  await run(defined, "read", {
    ensureRuntime: false,
    conversation,
    model: fauxModel(),
    durable: { runId: "read-intent-crash", store: faulting },
    streamFn: () => {
      replayProviderCalls++;
      throw new Error("completed replay must not spend");
    },
  });
  assert.equal(replayProviderCalls, 0);
  assert.equal(
    (JSON.stringify(conversation.snapshot().messages).match(/"text":"read"/g) ?? []).length,
    1,
  );
});

test("crash after a write effect but before settlement fails closed without re-execution", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faulting = failOnceAt(store, "tool_settled", "before");
  let effects = 0;
  const defined = effectAgent("durable-write-uncertain", "write", () => {
    effects++;
    return "written";
  });
  await assert.rejects(
    run(defined, "write", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "write-settlement-crash", store: faulting },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "write-1", name: "act", arguments: {} }],
        "toolUse",
        usage(),
      ),
    }),
    /simulated_tool_settled_before_failure/,
  );
  assert.equal(effects, 1);

  let resumedProviderCalls = 0;
  await assert.rejects(
    run(defined, "write", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "write-settlement-crash", store: faulting },
      streamFn: () => {
        resumedProviderCalls++;
        throw new Error("must not call provider for uncertain write");
      },
    }),
    /cave_durable_tool_effect_uncertain:act:write-1/,
  );
  assert.equal(resumedProviderCalls, 0);
  assert.equal(effects, 1);
});

test("idempotent redrive receives the same key and explicit resume identity", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faulting = failOnceAt(store, "tool_settled", "before");
  const invocations = [];
  const defined = effectAgent("durable-idempotent-redrive", "idempotent", (_input, _signal, context) => {
    invocations.push(context?.durable);
    return "accepted";
  });
  await assert.rejects(
    run(defined, "submit", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "idempotent-settlement-crash", store: faulting },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "submit-1", name: "act", arguments: {} }],
        "toolUse",
        usage(),
      ),
    }),
    /simulated_tool_settled_before_failure/,
  );
  assert.equal(invocations.length, 1);

  let calls = 0;
  const result = await run(defined, "submit", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId: "idempotent-settlement-crash", store: faulting },
    streamFn: (selected) => {
      calls++;
      return calls === 1
        ? pushMessage(
          selected,
          [{ type: "toolCall", id: "submit-1", name: "act", arguments: {} }],
          "toolUse",
          usage(),
        )
        : pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
    },
  });
  assert.equal(result.text, "done");
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].resumed, false);
  assert.equal(invocations[1].resumed, true);
  assert.equal(invocations[0].idempotencyKey, invocations[1].idempotencyKey);
});

test("durable settlement replays exactly and argument mismatch stops before another provider call", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faulting = failOnceAt(store, "tool_settled", "after");
  let effects = 0;
  const defined = effectAgent(
    "durable-settled-replay",
    "write",
    ({ key }) => {
      effects++;
      return `value:${key}`;
    },
    schema.object({ key: schema.string() }),
  );
  await assert.rejects(
    run(defined, "lookup", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "settled-tool-replay", store: faulting },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "lookup-1", name: "act", arguments: { key: "a" } }],
        "toolUse",
        usage(),
      ),
    }),
    /simulated_tool_settled_after_failure/,
  );
  assert.equal(effects, 1);

  let calls = 0;
  let replayContext = "";
  const result = await run(defined, "lookup", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId: "settled-tool-replay", store: faulting },
    streamFn: (selected, context) => {
      calls++;
      if (calls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "lookup-1", name: "act", arguments: { key: "a" } }],
          "toolUse",
          usage(),
        );
      }
      replayContext = JSON.stringify(context.messages);
      return pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
    },
  });
  assert.equal(result.text, "done");
  assert.match(replayContext, /value:a/);
  assert.equal(effects, 1);

  const { dir: mismatchDir, store: mismatchBase } = await scratchStore();
  t.after(() => rm(mismatchDir, { recursive: true, force: true }));
  const mismatchStore = failOnceAt(mismatchBase, "tool_settled", "after");
  await assert.rejects(
    run(defined, "lookup mismatch", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "settled-tool-mismatch", store: mismatchStore },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "lookup-2", name: "act", arguments: { key: "a" } }],
        "toolUse",
        usage(),
      ),
    }),
    /simulated_tool_settled_after_failure/,
  );
  assert.equal(effects, 2);
  let mismatchProviderCalls = 0;
  await assert.rejects(
    run(defined, "lookup mismatch", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "settled-tool-mismatch", store: mismatchStore },
      streamFn: (selected) => {
        mismatchProviderCalls++;
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "lookup-2", name: "act", arguments: { key: "b" } }],
          "toolUse",
          usage(),
        );
      },
    }),
    /cave_durable_tool_replay_mismatch:act:lookup-2/,
  );
  assert.equal(mismatchProviderCalls, 1);
  assert.equal(effects, 2);
});

test("durable replay preserves output-schema failure without re-executing tool", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faulting = failOnceAt(store, "tool_settled", "after");
  let effects = 0;
  const defined = agent({
    id: "durable-output-schema",
    instructions: "Call act, then answer.",
    model: auto(),
    sandbox: "fixture",
    tools: [tool({
      name: "act",
      description: "Return malformed output.",
      input: schema.object({}),
      output: schema.object({ value: schema.string() }),
      effect: "read",
      allowRepeat: true,
      execute() {
        effects += 1;
        return { value: 7, secret: "RAW_DURABLE_VALUE" };
      },
    })],
  });
  await assert.rejects(
    run(defined, "validate", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "durable-output-schema", store: faulting },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "output-1", name: "act", arguments: {} }],
        "toolUse",
        usage(),
      ),
    }),
    /simulated_tool_settled_after_failure/,
  );
  assert.equal(effects, 1);
  const settlement = (await journalLines(dir, "durable-output-schema"))
    .find((entry) => entry.type === "tool_settled");
  assert.equal(settlement.outcome, "threw");
  assert.match(settlement.error.message, /cave_tool_output_schema_mismatch:act/);

  let providerCalls = 0;
  let observed = "";
  const result = await run(defined, "validate", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId: "durable-output-schema", store: faulting },
    streamFn: (selected, context) => {
      providerCalls += 1;
      if (providerCalls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "output-1", name: "act", arguments: {} }],
          "toolUse",
          usage(),
        );
      }
      observed = JSON.stringify(context.messages);
      return pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
    },
  });
  assert.equal(result.text, "done");
  assert.equal(effects, 1);
  assert.match(observed, /cave_tool_output_schema_mismatch:act/);
  assert.doesNotMatch(observed, /RAW_DURABLE_VALUE/);
});

test("sandbox worker receives the same bounded durable identity on safe redrive", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const faulting = failOnceAt(store, "tool_settled", "before");
  const runId = "sandbox-durable-redrive";
  await assert.rejects(
    run(sandboxAgent, "context", {
      ensureRuntime: false,
      entryPath: "tests/fixtures/sandbox-agent.mjs",
      model: fauxModel(),
      durable: { runId, store: faulting },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "sandbox-1", name: "durable_context", arguments: {} }],
        "toolUse",
        usage(),
      ),
    }),
    /simulated_tool_settled_before_failure/,
  );
  const intent = (await journalLines(dir, runId)).find((event) => event.type === "tool_intent");
  assert.ok(intent);

  let calls = 0;
  let resumedMessages;
  const result = await run(sandboxAgent, "context", {
    ensureRuntime: false,
    entryPath: "tests/fixtures/sandbox-agent.mjs",
    model: fauxModel(),
    durable: { runId, store: faulting },
    streamFn: (selected, context) => {
      calls++;
      if (calls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "sandbox-1", name: "durable_context", arguments: {} }],
          "toolUse",
          usage(),
        );
      }
      resumedMessages = context.messages;
      return pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage());
    },
  });
  assert.equal(result.text, "done");
  const toolResult = resumedMessages.find((message) => message.role === "toolResult");
  const returned = JSON.parse(toolResult.content[0].text);
  assert.deepEqual(returned, {
    toolCallId: "sandbox-1",
    durable: {
      idempotencyKey: intent.idempotencyKey,
      resumed: true,
    },
  });
});

// ---------------------------------------------------------------------------
// Subagent money events land in the root journal.
// ---------------------------------------------------------------------------

test("a subagent's settled calls journal through the root and restore on resume", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = agent({
    id: "durable-child",
    instructions: "Answer the delegated task.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
  });
  const controller = new AbortController();
  const parent = agent({
    id: "durable-parent",
    instructions: "Delegate, then answer.",
    model: auto(),
    sandbox: "fixture",
    tools: [subagent({
      name: "delegate",
      description: "Delegate a task.",
      agent: child,
      maxCostUsd: 10,
    })],
  });
  const runId = "ticket-7";
  let call = 0;
  const iterator = stream(parent, "delegate this", {
    ensureRuntime: false,
    model: pricedFauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    streamFn: (selected) => {
      call++;
      if (call === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "d1", name: "delegate", arguments: { task: "sub" } }],
          "toolUse",
          usage({ input: 500, output: 50 }),
        );
      }
      if (call === 2) {
        // The child's own provider call.
        return pushMessage(
          selected,
          [{ type: "text", text: "child answer" }],
          "stop",
          usage({ input: 400, output: 40 }),
        );
      }
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  for await (const _event of iterator) { /* drain */ }

  const lines = await journalLines(dir, runId);
  const settled = lines.filter((entry) => entry.type === "call_settled");
  assert.equal(settled.length, 2);
  assert.equal(settled.some((entry) => entry.path === ""), true);
  assert.equal(
    settled.some((entry) => /^delegate:[0-9a-f]{64}$/.test(entry.path)),
    true,
  );

  const result = await run(parent, "delegate this", {
    ensureRuntime: false,
    model: pricedFauxModel(),
    durable: { runId, store },
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "text", text: "final" }],
      "stop",
      usage({ input: 100, output: 10 }),
    ),
  });
  assert.equal(result.receipt.resume.priorCalls, 2);
  // Root call (550) + child call (440) both restore into the logical totals.
  assert.equal(result.inputTokens, 500 + 400 + 100);
  assertSharedReceiptContract(result.receipt);
});

// ---------------------------------------------------------------------------
// analyzeJournal: reconstruction and fail-closed validation (review findings
// 3/11/14 — journaled money is validated, never trusted).
// ---------------------------------------------------------------------------

const {
  analyzeJournal,
  durableToolArgsSHA256,
  durableToolIdempotencyKey,
  DURABLE_JOURNAL_VERSION,
  validateReplayReceipt,
} = await import("../dist/durable.js");
const { BudgetMeter, ReceiptRecorder, normalizeRunBudget } = await import("../dist/budget.js");
const DEFINITION_SHA256 = "d".repeat(64);

const IDENTITY = {
  runId: "u1",
  agentId: "a",
  definitionSha256: DEFINITION_SHA256,
  input: "i",
  denomination: "none",
  budgetMax: undefined,
  budgetInitial: undefined,
  budgetSha256: "none",
};

function line(event) {
  return JSON.stringify({ v: DURABLE_JOURNAL_VERSION, at: "2026-08-15T00:00:00.000Z", ...event });
}

function startedLine(overrides = {}) {
  return line({
    type: "run_started",
    runId: "u1",
    agentId: "a",
    definitionSha256: DEFINITION_SHA256,
    input: "i",
    sessionId: "s",
    denomination: "none",
    budgetMax: undefined,
    budgetSha256: "none",
    pid: 1,
    ...overrides,
  });
}

function settledLine(overrides = {}, eventOverrides = {}) {
  return line({
    type: "call_settled",
    path: "",
    kind: "model",
    call: {
      provider: "anthropic",
      model: "m",
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      estimatedUsd: 0.01,
      unpriced: false,
      usageBasis: "provider_reported",
      ...overrides,
    },
    ...eventOverrides,
  });
}

function callStartedLine() {
  return line({
    type: "call_started",
    path: "",
    kind: "model",
    provider: "anthropic",
    model: "m",
  });
}

function replayReceipt(call, meter) {
  const recorder = new ReceiptRecorder();
  if (call !== undefined) recorder.recordCall(call);
  return recorder.build({
    runId: "u1",
    agentId: "a",
    stopReason: "complete",
    meter,
  });
}

function replayResult(receipt, overrides = {}) {
  return {
    runId: "u1",
    agentId: "a",
    text: "done",
    claimBasis: "inferred",
    usageBasis: "provider_reported",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    priceBasis: "public_catalog",
    stopReason: "complete",
    capBreached: false,
    overspent: 0,
    toolCalls: [],
    receipt,
    ...overrides,
  };
}

test("analyzeJournal fails closed on malformed journaled money", () => {
  assert.throws(
    () => analyzeJournal([startedLine(), settledLine({ estimatedUsd: "12" })], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal([startedLine(), settledLine({ inputTokens: -5 })], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal([
      startedLine(),
      line({ type: "tranche", amount: 0, reason: "invalid", atCall: 0 }),
    ], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal([startedLine(), line({ type: "turn", messages: "oops" })], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal(
      [startedLine(), line({ type: "run_completed", result: { runId: "u1", costUsd: "lots" } })],
      IDENTITY,
    ),
    /cave_durable_journal_corrupt/,
  );
});

test("analyzeJournal reconciles each settled call to its budget denomination", () => {
  const budgetSha256 = "b".repeat(64);
  const usdIdentity = {
    ...IDENTITY,
    denomination: "usd",
    budgetMax: 10,
    budgetSha256,
  };
  const usdStart = startedLine({
    denomination: "usd",
    budgetMax: 10,
    budgetSha256,
  });
  assert.throws(
    () => analyzeJournal([
      usdStart,
      callStartedLine(),
      settledLine({ estimatedUsd: 5 }, { settledAmount: 1 }),
    ], usdIdentity),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal([
      usdStart,
      callStartedLine(),
      settledLine({ estimatedUsd: 5 }),
    ], usdIdentity),
    /cave_durable_journal_corrupt/,
  );
  const usd = analyzeJournal([
    usdStart,
    callStartedLine(),
    settledLine({ estimatedUsd: 5 }, { settledAmount: 5 }),
  ], usdIdentity);
  assert.equal(usd.resume.priorSettled, 5);

  const tokenIdentity = {
    ...IDENTITY,
    denomination: "tokens",
    budgetMax: 20,
    budgetSha256,
  };
  const tokenStart = startedLine({
    denomination: "tokens",
    budgetMax: 20,
    budgetSha256,
  });
  assert.throws(
    () => analyzeJournal([
      tokenStart,
      callStartedLine(),
      settledLine({}, { settledAmount: 1 }),
    ], tokenIdentity),
    /cave_durable_journal_corrupt/,
  );
  const tokens = analyzeJournal([
    tokenStart,
    callStartedLine(),
    settledLine({}, { settledAmount: 12 }),
  ], tokenIdentity);
  assert.equal(tokens.resume.priorSettled, 12);

  assert.throws(
    () => analyzeJournal([
      startedLine(),
      callStartedLine(),
      settledLine({}, { settledAmount: 12 }),
    ], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
});

test("analyzeJournal accepts only canonical unavailable and internally consistent usage", () => {
  const budgetSha256 = "b".repeat(64);
  const identity = {
    ...IDENTITY,
    denomination: "tokens",
    budgetMax: 20,
    budgetSha256,
  };
  const start = startedLine({
    denomination: "tokens",
    budgetMax: 20,
    budgetSha256,
  });
  const unavailable = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0,
    unpriced: true,
    usageBasis: "unavailable",
  };
  const state = analyzeJournal([
    start,
    callStartedLine(),
    settledLine(unavailable, { settledAmount: 20 }),
  ], identity);
  assert.equal(state.resume.priorSettled, 20);
  for (const invalid of [
    { ...unavailable, inputTokens: 1 },
    { ...unavailable, unpriced: false },
    { reasoningTokens: 3, outputTokens: 2 },
    { unpriced: true, estimatedUsd: 1 },
  ]) {
    assert.throws(
      () => analyzeJournal([
        start,
        callStartedLine(),
        settledLine(invalid, { settledAmount: 20 }),
      ], identity),
      /cave_durable_journal_corrupt/,
    );
  }
});

test("durable replay delegates complete receipt validation to the canonical parser", () => {
  assert.throws(
    () => validateReplayReceipt({
      schema: "caveman.agent.run-receipt.v1",
      runId: "u1",
      agentId: "a",
      basis: "estimated_list_price_subtotal",
      claimBasis: "inferred",
      totalEstimatedUsd: 0,
      totalTokens: 0,
    }, "u1", "a"),
    /cave_durable_journal_corrupt/,
  );
  const child = {
    schema: "caveman.agent.run-receipt.v1",
    runId: "duplicate",
    agentId: "child",
    basis: "estimated_list_price_subtotal",
    claimBasis: "inferred",
    stopReason: "complete",
    denomination: "none",
    capBreached: false,
    overspent: 0,
    totalEstimatedUsd: 0,
    totalTokens: 0,
    unpriced: false,
    calls: [],
    tools: [],
    subagents: [],
    tranches: [],
    breakers: [],
    compactions: [],
  };
  assert.throws(
    () => validateReplayReceipt({
      ...child,
      runId: "u1",
      agentId: "a",
      subagents: [child, { ...child }],
    }, "u1", "a"),
    /cave_durable_journal_corrupt/,
  );
});

test("analyzeJournal fails closed on a changed budget contract digest", () => {
  assert.throws(
    () => analyzeJournal([startedLine({ budgetSha256: "e".repeat(64) })], IDENTITY),
    /cave_durable_budget_changed/,
  );
});

test("analyzeJournal fails closed on a changed root agent identity", () => {
  assert.throws(
    () => analyzeJournal([startedLine({ agentId: "other" })], IDENTITY),
    /cave_durable_agent_mismatch/,
  );
});

test("analyzeJournal exact-validates tool identity and terminal reconciliation", () => {
  const argsSha256 = durableToolArgsSHA256({});
  const intent = {
    type: "tool_intent",
    path: "",
    toolCallId: "tool-1",
    name: "act",
    effect: "read",
    argsSha256,
    idempotencyKey: durableToolIdempotencyKey({
      runId: "u1",
      path: "",
      toolCallId: "tool-1",
      name: "act",
      argsSha256,
    }),
  };
  assert.throws(
    () => analyzeJournal([startedLine(), line({ ...intent, unknown: true })], IDENTITY),
    /cave_durable_journal_corrupt/,
  );
  assert.throws(
    () => analyzeJournal([
      startedLine(),
      line(intent),
      line({ type: "run_completed", result: {} }),
    ], IDENTITY),
    /completed run crosses uncheckpointed tool intent/,
  );
  assert.throws(
    () => analyzeJournal([
      startedLine(),
      line({ type: "call_started", path: "", kind: "model", provider: "p", model: "m" }),
      settledLine({ provider: "other" }),
    ], IDENTITY),
    /call settlement identity mismatch/,
  );
});

test("a failed terminal cannot hide an unsettled provider intent", () => {
  const receipt = new ReceiptRecorder().build({
    runId: "u1",
    agentId: "a",
    stopReason: "complete",
    meter: undefined,
  });
  assert.throws(
    () => analyzeJournal([
      startedLine(),
      callStartedLine(),
      line({
        type: "run_failed",
        code: "cave_agent_run_failed",
        message: "provider failed",
        receipt,
      }),
    ], IDENTITY),
    /failed run crosses unsettled provider intent/,
  );
});

test("terminal replay reconciles result, receipt, and journal economics", () => {
  const zeroReceipt = replayReceipt();
  assert.throws(
    () => analyzeJournal([
      startedLine(),
      line({
        type: "run_completed",
        result: replayResult(zeroReceipt, { inputTokens: 100, costUsd: 999 }),
      }),
    ], IDENTITY),
    /replayed result usage disagrees with receipt/,
  );
  assert.throws(
    () => analyzeJournal([
      startedLine(),
      callStartedLine(),
      settledLine(),
      line({ type: "run_completed", result: replayResult(zeroReceipt) }),
    ], IDENTITY),
    /terminal receipt disagrees with journaled provider usage/,
  );

  const call = {
    provider: "anthropic",
    model: "m",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0.01,
    unpriced: false,
    usageBasis: "provider_reported",
    clampedOutputTokens: undefined,
  };
  const receipt = replayReceipt(call);
  const forgedCall = { ...call, provider: "openai", model: "forged" };
  assert.throws(
    () => analyzeJournal([
      startedLine(),
      callStartedLine(),
      settledLine(),
      line({
        type: "run_completed",
        result: replayResult(replayReceipt(forgedCall), {
          inputTokens: 10,
          outputTokens: 2,
          costUsd: 0.01,
        }),
      }),
    ], IDENTITY),
    /terminal receipt call evidence disagrees with journal/,
  );
  const completed = analyzeJournal([
    startedLine(),
    callStartedLine(),
    settledLine(),
    line({
      type: "run_completed",
      result: replayResult(receipt, { inputTokens: 10, outputTokens: 2, costUsd: 0.01 }),
    }),
  ], IDENTITY);
  assert.equal(completed.status, "completed");
  assert.equal(Object.isFrozen(completed.result.receipt), true);
  assert.equal(Object.isFrozen(completed.result.receipt.calls), true);
  assert.equal(Object.isFrozen(completed.result.receipt.calls[0]), true);
  assert.throws(() => completed.result.receipt.calls.push(call), TypeError);

  const failed = analyzeJournal([
    startedLine(),
    line({
      type: "run_failed",
      code: "cave_agent_run_failed",
      message: "failed",
      receipt: zeroReceipt,
    }),
  ], IDENTITY);
  assert.equal(failed.status, "failed");
  assert.equal(Object.isFrozen(failed.receipt), true);
  assert.equal(Object.isFrozen(failed.receipt.calls), true);
  assert.throws(() => failed.receipt.calls.push(call), TypeError);

  const budgetSha256 = "b".repeat(64);
  const originalBudget = {
    ...IDENTITY,
    denomination: "tokens",
    budgetMax: 100,
    budgetInitial: 100,
    budgetSha256,
  };
  const widened = new BudgetMeter(normalizeRunBudget({ maxTokens: 200 }));
  const hold = widened.reserve(150, 1);
  widened.settle(hold, 150);
  const unavailable = {
    provider: "anthropic",
    model: "m",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0,
    unpriced: true,
    usageBasis: "unavailable",
    clampedOutputTokens: undefined,
  };
  const widenedReceipt = replayReceipt(unavailable, widened);
  assert.throws(
    () => analyzeJournal([
      startedLine({ denomination: "tokens", budgetMax: 100, budgetSha256 }),
      callStartedLine(),
      settledLine(unavailable, { settledAmount: 150 }),
      line({
        type: "run_completed",
        result: replayResult(widenedReceipt, {
          usageBasis: "unavailable",
          priceBasis: "unpriced",
        }),
      }),
    ], originalBudget),
    /terminal receipt max disagrees with journal contract/,
  );
});

test("a snapshot resets the reconstruction and later turns append to it", () => {
  const state = analyzeJournal([
    startedLine(),
    line({ type: "turn", messages: [{ role: "user" }, { role: "assistant" }, { role: "toolResult" }] }),
    line({ type: "snapshot", messages: [{ role: "user", note: "compacted" }] }),
    line({ type: "turn", messages: [{ role: "assistant" }, { role: "toolResult", note: "after" }] }),
  ], IDENTITY);
  assert.equal(state.status, "pending");
  assert.deepEqual(
    state.resume.messages.map((message) => message.role),
    ["user", "assistant", "toolResult"],
  );
  assert.equal(state.resume.messages[0].note, "compacted");
  assert.equal(state.resume.messages.at(-1).note, "after");
});

test("double resume accumulates attempts and unmatched intents", () => {
  const intent = line({ type: "call_started", path: "", kind: "model", provider: "p", model: "m" });
  const state = analyzeJournal([
    startedLine(),
    intent,
    line({ type: "resumed", attempt: 2, unmatchedIntents: 1, pid: 2 }),
    intent,
  ], IDENTITY);
  assert.equal(state.status, "pending");
  assert.equal(state.resume.attempts, 2);
  assert.equal(state.resume.possibleDoubleCountCalls, 2);
});

test("abandoned intents consume no call ceiling and no double-count", () => {
  const state = analyzeJournal([
    startedLine(),
    line({ type: "call_started", path: "", kind: "model", provider: "p", model: "m" }),
    line({ type: "call_abandoned", path: "" }),
  ], IDENTITY);
  assert.equal(state.resume.priorRootModelCalls, 0);
  assert.equal(state.resume.possibleDoubleCountCalls, 0);

  const compactionAbandoned = analyzeJournal([
    startedLine(),
    callStartedLine(),
    settledLine(),
    line({
      type: "call_started",
      path: "",
      kind: "compaction",
      provider: "anthropic",
      model: "m",
    }),
    line({ type: "call_abandoned", path: "" }),
  ], IDENTITY);
  assert.equal(compactionAbandoned.resume.priorRootModelCalls, 1);
  assert.equal(compactionAbandoned.resume.priorRootCompactions, 1);
  assert.equal(compactionAbandoned.resume.priorRootMeterCalls, 2);
});

test("resume restores the exact compaction and retry reservation watermark", () => {
  const budgetSha256 = "b".repeat(64);
  const identity = {
    ...IDENTITY,
    denomination: "tokens",
    budgetMax: 100,
    budgetSha256,
  };
  const start = startedLine({
    denomination: "tokens",
    budgetMax: 100,
    budgetSha256,
  });
  const state = analyzeJournal([
    start,
    line({ type: "meter_call", path: "", atCall: 1 }),
    line({
      type: "call_started",
      path: "",
      kind: "compaction",
      provider: "anthropic",
      model: "m",
    }),
    settledLine({}, { kind: "compaction", settledAmount: 12 }),
    line({ type: "meter_call", path: "", atCall: 2 }),
    callStartedLine(),
    // The retry shares the logical call intent but takes a second real meter
    // reservation, so it advances the explicit watermark independently.
    line({ type: "meter_call", path: "", atCall: 3 }),
    settledLine({}, { settledAmount: 12 }),
  ], identity);
  assert.equal(state.status, "pending");
  assert.equal(state.resume.priorRootModelCalls, 1);
  assert.equal(state.resume.priorRootCompactions, 1);
  assert.equal(state.resume.priorRootMeterCalls, 3);

  const meter = new BudgetMeter(normalizeRunBudget({ maxTokens: 100, initialTokens: 50 }));
  meter.restorePrior({
    settled: state.resume.priorSettled,
    calls: state.resume.priorRootMeterCalls,
    tranches: state.resume.priorTranches,
  });
  assert.equal(meter.release(10, "resumed checkpoint").atCall, 3);

  assert.throws(
    () => analyzeJournal([
      start,
      line({ type: "meter_call", path: "", atCall: 1 }),
      line({ type: "meter_call", path: "", atCall: 1 }),
    ], identity),
    /cave_durable_journal_corrupt/,
  );

  // Legacy journals have no explicit reservation events. Their safe fallback
  // still includes both model and compaction intents rather than model calls
  // alone, which was the original regression.
  const legacy = analyzeJournal([
    start,
    callStartedLine(),
    settledLine({}, { settledAmount: 12 }),
    line({
      type: "call_started",
      path: "",
      kind: "compaction",
      provider: "anthropic",
      model: "m",
    }),
    settledLine({}, { kind: "compaction", settledAmount: 12 }),
  ], identity);
  assert.equal(legacy.resume.priorRootMeterCalls, 2);
});

// ---------------------------------------------------------------------------
// The lock: single-winner stale takeover (review finding 2).
// ---------------------------------------------------------------------------

test("stale-lock takeover has exactly one winner", async (t) => {
  const { spawn } = await import("node:child_process");
  const { mkdir: mkdirP, writeFile: writeFileP, readdir } = await import("node:fs/promises");
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A genuinely dead pid: spawn a process and wait for it to exit.
  const deadPid = await new Promise((done) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("exit", () => done(child.pid));
  });
  // Plant the stale lock where the store expects it (digest-suffixed dir).
  await store.append("stale-1", "");
  const runDir = resolve(dir, (await readdir(dir)).find((name) => name.startsWith("stale-1")));
  await store.close("stale-1");
  const lockDir = resolve(runDir, "lock.d");
  await mkdirP(lockDir);
  await writeFileP(resolve(lockDir, "owner.json"), JSON.stringify({ pid: deadPid }));

  const attempts = await Promise.allSettled([
    store.acquire("stale-1"),
    store.acquire("stale-1"),
  ]);
  const winners = attempts.filter((entry) => entry.status === "fulfilled");
  const losers = attempts.filter((entry) => entry.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.match(losers[0].reason.message, /cave_durable_run_locked/);
  await winners[0].value();
});

// ---------------------------------------------------------------------------
// Cancelling at run_start releases the lock (review finding 5).
// ---------------------------------------------------------------------------

test("a consumer that cancels at run_start does not strand the lock", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-cancel");
  const runId = "ticket-9";
  const iterator = stream(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn: () => { throw new Error("must not be called"); },
  });
  const first = await iterator.next();
  assert.equal(first.value.type, "run_start");
  await iterator.return();

  const result = await run(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "text", text: "fresh" }],
      "stop",
      usage(),
    ),
  });
  assert.equal(result.text, "fresh");
});

// ---------------------------------------------------------------------------
// A journal that stops recording refuses to keep spending (review finding 7).
// ---------------------------------------------------------------------------

test("a failing store surfaces loudly instead of spending blind", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let appends = 0;
  const failing = {
    load: (runId) => store.load(runId),
    acquire: (runId) => store.acquire(runId),
    close: (runId) => store.close(runId),
    append: (runId, data) => {
      appends++;
      if (appends > 1) return Promise.reject(new Error("disk full"));
      return store.append(runId, data);
    },
  };
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.removeListener("unhandledRejection", onUnhandled));
  await assert.rejects(
    run(pollingAgent("durable-disk-full"), "go", {
      ensureRuntime: false,
      model: fauxModel(),
      durable: { runId: "ticket-10", store: failing },
      streamFn: (selected) => pushMessage(
        selected,
        [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
        "toolUse",
        usage(),
      ),
    }),
  );
  await new Promise((done) => setTimeout(done, 20));
  assert.deepEqual(unhandled, []);
});

// ---------------------------------------------------------------------------
// Tranches journal and restore (review coverage gap 3).
// ---------------------------------------------------------------------------

test("released tranches survive a crash and fund the resumed run", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const defined = pollingAgent("durable-tranche");
  const runId = "ticket-11";
  const controller = new AbortController();
  let calls = 0;
  const iterator = stream(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    signal: controller.signal,
    budget: { maxTokens: 200_000, initialTokens: 1 },
    onBudgetExhausted: () => ({ release: 199_999, reason: "top-up" }),
    streamFn: (selected) => {
      calls++;
      if (calls === 1) {
        return pushMessage(
          selected,
          [{ type: "toolCall", id: "p1", name: "poll", arguments: {} }],
          "toolUse",
          usage({ input: 120, output: 15 }),
        );
      }
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  for await (const _event of iterator) { /* drain */ }

  const lines = await journalLines(dir, runId);
  const tranches = lines.filter((entry) => entry.type === "tranche");
  assert.equal(tranches.length, 1);
  assert.equal(tranches[0].amount, 199_999);

  const result = await run(defined, "go", {
    ensureRuntime: false,
    model: fauxModel(),
    durable: { runId, store },
    budget: { maxTokens: 200_000, initialTokens: 1 },
    onBudgetExhausted: () => { throw new Error("must not re-escalate: the tranche is restored"); },
    streamFn: (selected) => pushMessage(
      selected,
      [{ type: "text", text: "done" }],
      "stop",
      usage({ input: 100, output: 10 }),
    ),
  });
  assert.equal(result.resumed, true);
  assert.equal(result.receipt.tranches.length, 1);
  assert.equal(result.receipt.tranches[0].amount, 199_999);
  // Prior settles include turn 1 (135) plus the crashed call's worst-case
  // settle (byte-derived, not a stable constant) — assert the relation, not
  // the hold: the resumed spend is exactly prior + this attempt's usage.
  assert.equal(result.receipt.resume.priorSettled >= 135, true);
  assert.equal(result.receipt.spent, result.receipt.resume.priorSettled + 110);
});
