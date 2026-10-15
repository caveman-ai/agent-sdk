import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskDurableStore, SUMMARY_SCHEMA_VERSION, agent, run, schema, tool } from "../dist/index.js";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Pi's long-run recovery without a budget: turn retry after a provider error
// turn and window compaction, each provider call accounted exactly once.

function model(extra = {}) {
  return { ...fauxProvider({ provider: "anthropic" }).getModel(), id: "claude-haiku-4-5", maxTokens: 4_000, ...extra };
}

function usage(input, output) {
  return {
    input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function message(selected, content, stopReason, used, extra = {}) {
  return {
    role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id,
    usage: used, stopReason, timestamp: Date.now(), ...extra,
  };
}

function reply(selected, content, stopReason, used) {
  const stream = createAssistantMessageEventStream();
  const done = message(selected, content, stopReason, used);
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...done, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: stopReason, message: done });
    stream.end(done);
  });
  return stream;
}

/** Output streams, then the connection drops: pi-ai's mid-stream `error` event. */
function midStreamError(selected, errorMessage, used = usage(0, 0)) {
  const stream = createAssistantMessageEventStream();
  const partial = message(selected, [{ type: "text", text: "half an ans" }], "error", used, { errorMessage });
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...partial, content: [], stopReason: "pending" } });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "half an ans", partial });
    stream.push({ type: "error", reason: "error", error: partial });
    stream.end();
  });
  return stream;
}

const toolCall = (id) => ({ type: "toolCall", id, name: "poll", arguments: { key: id } });

function pollingAgent(id) {
  return agent({
    id,
    instructions: "Poll until told to stop.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
    tools: [tool({
      name: "poll",
      description: "Poll a queue.",
      input: schema.object({ key: schema.string() }),
      effect: "read",
      allowRepeat: true,
      execute: (input) => `${input.key}:ok`,
    })],
  });
}

/** Scripted calls; every request's messages are kept for prefix checks. */
async function scripted(id, script, options = {}) {
  const requests = [];
  const result = await run(pollingAgent(id), "go", {
    ensureRuntime: false,
    model: model(),
    breakers: { noProgressTurns: 50 },
    turnRetry: { baseDelayMs: 1 },
    streamFn: (selected, context, streamOptions) => {
      requests.push(JSON.stringify(context.messages));
      return script(requests.length, selected, context, streamOptions);
    },
    ...options,
  });
  return { result, requests };
}

test("a mid-stream error turn is retried once, resent from the same prefix, and charged once", async () => {
  const { result, requests } = await scripted("turn-retry-mid-stream", (call, selected) => {
    if (call === 1) return reply(selected, [toolCall("a")], "toolUse", usage(1_000, 10));
    if (call === 2) return midStreamError(selected, "terminated", usage(1_200, 3));
    return reply(selected, [{ type: "text", text: "done" }], "stop", usage(1_200, 5));
  });
  assert.equal(result.text, "done");
  assert.equal(requests.length, 3);
  // The failed attempt never re-enters the context: the retry sends its exact request.
  assert.equal(requests[2], requests[1]);
  assert.equal(result.receipt.calls.length, 3);
  const tokens = result.receipt.calls.reduce((sum, call) => sum + call.inputTokens + call.outputTokens, 0);
  assert.equal(tokens, 1_010 + 1_203 + 1_205);
  assert.equal(result.receipt.totalTokens, tokens);
});

test("non-retryable errors, context overflow, and exhausted retries end the run", async () => {
  for (const [errorMessage, calls] of [["400 invalid_request_error", 2], ["context_length_exceeded", 2], ["socket hang up", 5]]) {
    await assert.rejects(
      scripted(`turn-retry-${calls}-${errorMessage.length}`, (call, selected) => call === 1
        ? reply(selected, [toolCall("a")], "toolUse", usage(100, 1))
        : midStreamError(selected, errorMessage), { turnRetry: { baseDelayMs: 1, maxRetries: 3 } }),
      /cave_provider_terminal_error/,
    );
  }
  let seen = 0;
  await assert.rejects(scripted("turn-retry-count", (call, selected) => {
    seen = call;
    return call === 1 ? reply(selected, [toolCall("a")], "toolUse", usage(100, 1)) : midStreamError(selected, "socket hang up");
  }), /cave_provider_terminal_error/);
  assert.equal(seen, 1 + 1 + 3);
  // Off unless asked for: a plain run still ends on the first error turn.
  seen = 0;
  await assert.rejects(scripted("turn-retry-off", (call, selected) => {
    seen = call;
    return call === 1 ? reply(selected, [toolCall("a")], "toolUse", usage(100, 1)) : midStreamError(selected, "terminated");
  }, { turnRetry: undefined }), /cave_provider_terminal_error/);
  assert.equal(seen, 2);
});

test("a success between failures starts a fresh retry series, as in Pi", async () => {
  const fails = new Set([2, 3, 5, 6, 7]);
  const { result } = await scripted("turn-retry-series", (call, selected) => {
    if (fails.has(call)) return midStreamError(selected, "terminated");
    if (call < 8) return reply(selected, [toolCall(`c${call}`)], "toolUse", usage(100, 1));
    return reply(selected, [{ type: "text", text: "done" }], "stop", usage(100, 1));
  });
  assert.equal(result.text, "done");
  // Dropped streams reported no usage: each is an unavailable call, and the totals say incomplete.
  assert.equal(result.receipt.calls.filter((call) => call.usageBasis === "unavailable").length, fails.size);
  assert.equal(result.usageBasis, "unavailable");
});

test("a durable run that retried a turn closes the failed call's intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "turn-retry-durable-"));
  try {
    const store = new DiskDurableStore(root);
    const { result } = await scripted("turn-retry-durable", (call, selected) => {
      if (call === 1) return reply(selected, [toolCall("a")], "toolUse", usage(100, 1));
      if (call === 2) return midStreamError(selected, "terminated");
      return reply(selected, [{ type: "text", text: "done" }], "stop", usage(100, 1));
    }, { durable: { store, runId: "turn-retry-durable" } });
    assert.equal(result.text, "done");
    // A completed journal with an open intent would not replay.
    const replay = await run(pollingAgent("turn-retry-durable"), "go", {
      ensureRuntime: false,
      model: model(),
      durable: { store, runId: "turn-retry-durable" },
      streamFn: () => assert.fail("a completed run replays without a provider call"),
    });
    assert.equal(replay.text, "done");
    assert.equal(replay.receipt.calls.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function summaryJSON(generation) {
  return JSON.stringify({
    schema_version: SUMMARY_SCHEMA_VERSION,
    generation,
    objective: "Poll until told to stop.",
    anchors: [],
    constraints_restated: [],
    decisions: [],
    artifacts: [],
    facts: [],
    state: { completed: ["polled"], active: ["polling"], blocked: [] },
    next: ["poll again"],
    citations: [],
    lookup_hints: [],
  });
}

const isSummarizer = (context) => {
  const last = context.messages.at(-1);
  return typeof last?.content === "string" && last.content.includes("Reply with a single JSON object");
};

const BULK = "x".repeat(8_000);

/**
 * Provider-reported prompt grows 30k per call in a 200k window: Pi's reserve
 * trips it. Working calls go through `onPayload` as an Anthropic payload, so
 * the recorded requests are the bytes the runtime's prefix guard lets out.
 */
async function windowRun(id, extra = {}, fail = () => false) {
  let working = 0;
  let summaries = 0;
  const workingRequests = [];
  const { result } = await scripted(id, async (call, selected, context, options) => {
    if (isSummarizer(context)) {
      summaries++;
      return reply(selected, [{ type: "text", text: summaryJSON(summaries) }], "stop", usage(5_000, 500));
    }
    working++;
    const built = { model: selected.id, system: "s", messages: context.messages
      .filter((item) => item.role !== "system")
      .map((item) => ({ role: item.role, content: JSON.stringify(item.content) })) };
    workingRequests.push(((await options?.onPayload?.(built, selected)) ?? built).messages);
    if (fail(working)) return midStreamError(selected, "terminated");
    if (working > 12) return reply(selected, [{ type: "text", text: "done" }], "stop", usage(100, 10));
    const prompt = (working % 6) * 30_000 + 10_000;
    return reply(selected, [{ type: "text", text: `${BULK}-${working}` }, toolCall(`w${working}`)], "toolUse",
      usage(prompt, 10));
  }, {
    model: model({ api: "anthropic-messages" }),
    cave: "off",
    compaction: { reserveTokens: 50_000, keepRecentTokens: 2_000, minYieldTokens: 1_000, maxCompactions: 8 },
    ...extra,
  });
  return { result, summaries, workingRequests };
}

/** Requests between compactions only append: each one starts with the previous one, byte for byte. */
function prefixBreaks(requests) {
  let breaks = 0;
  for (let index = 1; index < requests.length; index++) {
    const before = requests[index - 1].map((item) => JSON.stringify(item));
    const after = requests[index].map((item) => JSON.stringify(item));
    if (!before.every((item, position) => after[position] === item)) breaks++;
  }
  return breaks;
}

test("without a budget the window compacts before it fills, and only compactions move the prefix", async () => {
  const { result, summaries, workingRequests } = await windowRun("window-compaction");
  assert.equal(result.text, "done");
  const summarized = result.receipt.compactions.filter((entry) => entry.tier === "summarized");
  assert.equal(summarized.length >= 2, true);
  assert.equal(summaries, summarized.length);
  assert.equal(result.receipt.denomination, "none");
  // Each summary is one provider call in the receipt, alongside every working call.
  assert.equal(result.receipt.calls.length, workingRequests.length + summaries);
  assert.equal(prefixBreaks(workingRequests), summarized.length);
  // No compaction option, no compaction: the run keeps its whole history.
  const plain = await windowRun("window-compaction-off", { compaction: undefined });
  assert.equal(plain.summaries, 0);
  assert.equal(prefixBreaks(plain.workingRequests), 0);
});

test("a retry after a compaction resends the compacted window, not the full history", async () => {
  let failedAt;
  const { result, workingRequests } = await windowRun("window-compaction-retry", {}, (working) => {
    // The first call after the first summary fails mid-stream once.
    if (failedAt === undefined && working === 6) {
      failedAt = working;
      return true;
    }
    return false;
  });
  assert.equal(result.text, "done");
  const failed = workingRequests[failedAt - 1];
  const retried = workingRequests[failedAt];
  // The failed request was already compacted: shorter than the one before it.
  assert.equal(failed.length < workingRequests[failedAt - 2].length, true);
  assert.deepEqual(retried.map((item) => JSON.stringify(item)), failed.map((item) => JSON.stringify(item)));
  const summarized = result.receipt.compactions.filter((entry) => entry.tier === "summarized");
  assert.equal(prefixBreaks(workingRequests), summarized.length);
});
