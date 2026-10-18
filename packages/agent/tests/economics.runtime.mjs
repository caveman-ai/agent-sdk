import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CavemanRunError,
  DiskDurableStore,
  agent,
  createConversation,
  createBudgetController,
  run,
  schema,
  stream,
  tool,
} from "../dist/index.js";
import { BreakerState, failFastPreStream, normalizeRunBreakers, serverRetryDelayMs } from "../dist/breakers.js";
import {
  CACHE_WARM_QUIESCE_MS,
  CacheWarmer,
  cacheWarmDecision,
  cacheWarmingDelayMs,
  promptCacheTtlMs,
  warmPayload,
} from "../dist/cache-warmer.js";
import { imageInputLimitViolation } from "../dist/image-limits.js";
import { renderReceipt } from "../dist/receipt-print.js";
import { PebbleEventEncoder, encodeRunEvent } from "../dist/pebble-stream.js";
import { compactionForModel, contextWindowFull, normalizeCompaction } from "../dist/compaction.js";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

const PRICED = "claude-haiku-4-5";

function model(extra = {}) {
  return { ...fauxProvider({ provider: "anthropic" }).getModel(), id: PRICED, ...extra };
}

function usage(input, output, extra = {}) {
  const cacheRead = extra.cacheRead ?? 0;
  const cacheWrite = extra.cacheWrite ?? 0;
  return {
    input, output, cacheRead, cacheWrite, reasoning: 0,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function reply(selected, content, stopReason, used) {
  const result = createAssistantMessageEventStream();
  const message = {
    role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id,
    usage: used, stopReason, timestamp: Date.now(),
  };
  queueMicrotask(() => {
    result.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    result.push({ type: "done", reason: stopReason, message });
    result.end(message);
  });
  return result;
}

function delayedReply(selected, content, stopReason, used, delayMs) {
  const result = createAssistantMessageEventStream();
  const message = {
    role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id,
    usage: used, stopReason, timestamp: Date.now(),
  };
  setTimeout(() => {
    result.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    result.push({ type: "done", reason: stopReason, message });
    result.end(message);
  }, delayMs);
  return result;
}

/** A provider failure delivered the pi-ai way: an `error` event before any output. */
function preStreamError(selected, errorMessage) {
  const result = createAssistantMessageEventStream();
  const message = {
    role: "assistant", content: [], api: selected.api, provider: selected.provider, model: selected.id,
    usage: usage(0, 0), stopReason: "error", errorMessage, timestamp: Date.now(),
  };
  queueMicrotask(() => {
    result.push({ type: "error", reason: "error", error: message });
    result.end();
  });
  return result;
}

const toolCall = (id, name = "poll") => ({ type: "toolCall", id, name, arguments: {} });

function pollingAgent(id, execute = () => "again") {
  return agent({
    id,
    instructions: "Poll.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
    tools: [tool({
      name: "poll",
      description: "Poll.",
      input: schema.object({}),
      effect: "read",
      allowRepeat: true,
      execute,
    })],
  });
}

const replyAgent = (id) => agent({ id, instructions: "Reply.", model: "anthropic/claude-haiku-4-5", sandbox: "fixture" });

// --- finishTurn graceful stop -------------------------------------------------

async function collect(events) {
  const seen = [];
  let result;
  for await (const event of events) {
    seen.push(event);
    if (event.type === "run_end") result = event.result;
  }
  return { seen, result };
}

const errorTurns = (seen) => seen.filter((event) =>
  event.type === "pi" && event.event.type === "turn_end" && event.event.message.stopReason === "error");

test("a call-budget stop ends through finishTurn with no synthesized error turn", async () => {
  let calls = 0;
  const { seen, result } = await collect(stream(pollingAgent("finish-call-cap"), "go", {
    ensureRuntime: false,
    model: model(),
    maxModelCalls: 2,
    breakers: { noProgressTurns: 10 },
    streamFn: (selected) => reply(selected, [toolCall(`c${++calls}`)], "toolUse", usage(10, 1)),
  }));
  assert.equal(result.stopReason, "call_budget_exhausted");
  assert.equal(calls, 2);
  assert.equal(result.receipt.calls.length, 2);
  assert.deepEqual(errorTurns(seen), []);
});

test("a wallet stop before the first call ends gracefully with the same stop reason", async () => {
  let calls = 0;
  const { seen, result } = await collect(stream(replyAgent("finish-wallet"), "go", {
    ensureRuntime: false,
    model: model(),
    budget: { maxTokens: 10, onExhausted: "stop" },
    streamFn: (selected) => {
      calls++;
      return reply(selected, [{ type: "text", text: "no" }], "stop", usage(1, 1));
    },
  }));
  assert.equal(result.stopReason, "budget_exhausted");
  assert.equal(calls, 0);
  assert.equal(result.text, "");
  assert.deepEqual(result.receipt.calls, []);
  assert.deepEqual(errorTurns(seen), []);
});

// --- retry --------------------------------------------------------------------

const retryOptions = (extra = {}) => ({
  ensureRuntime: false,
  model: model(),
  budget: { maxTokens: 500_000 },
  breakers: { retry: { maxSpend: 500_000, backoffMs: 0, ...extra } },
});

test("a thrown provider error's Retry-After is honoured", async () => {
  let attempts = 0;
  const started = performance.now();
  const result = await run(replyAgent("retry-after"), "go", {
    ...retryOptions(),
    streamFn: (selected) => {
      if (++attempts === 1) {
        throw Object.assign(new Error("429 rate limited"), { headers: new Headers({ "retry-after-ms": "150" }) });
      }
      return reply(selected, [{ type: "text", text: "done" }], "stop", usage(10, 1));
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.text, "done");
  assert.equal(performance.now() - started >= 140, true);
  assert.equal(result.receipt.breakers.filter((event) => event.kind === "retry_attempted").length, 1);
});

test("a Retry-After beyond maxAgentDelayMs fails fast instead of sleeping", async () => {
  let attempts = 0;
  const started = performance.now();
  await assert.rejects(run(replyAgent("retry-after-cap"), "go", {
    ...retryOptions({ maxAgentDelayMs: 1_000 }),
    streamFn: () => {
      attempts++;
      throw Object.assign(new Error("429 rate limited"), { headers: new Headers({ "retry-after": "120" }) });
    },
  }), CavemanRunError);
  assert.equal(attempts, 1);
  assert.equal(performance.now() - started < 1_000, true);
});

test("a transient provider error event before any output is retried under the wallet", async () => {
  let attempts = 0;
  const result = await run(replyAgent("retry-error-event"), "go", {
    ...retryOptions(),
    streamFn: (selected) => ++attempts <= 2
      ? preStreamError(selected, "429 Too Many Requests: rate limit exceeded")
      : reply(selected, [{ type: "text", text: "done" }], "stop", usage(10, 1)),
  });
  assert.equal(attempts, 3);
  assert.equal(result.stopReason, "complete");
  const retries = result.receipt.breakers.filter((event) => event.kind === "retry_attempted");
  assert.deepEqual(retries.map((event) => event.spendBasis), ["pre_stream_no_usage", "provider_reported"]);
  assert.equal(retries.every((event) => event.reservedSpend > 0), true);
  assert.equal(result.receipt.calls.length, 1);
});

test("a context overflow is never retried, as an error event or a throw", async () => {
  for (const shape of ["event", "throw"]) {
    let attempts = 0;
    await assert.rejects(run(replyAgent(`retry-overflow-${shape}`), "go", {
      ...retryOptions(),
      streamFn: (selected) => {
        attempts++;
        const text = "prompt is too long: 250000 tokens > 200000 maximum";
        if (shape === "throw") throw new Error(text);
        return preStreamError(selected, text);
      },
    }), CavemanRunError);
    assert.equal(attempts, 1, shape);
  }
});

test("retry backoff is capped, honours server delays, and counts retries", () => {
  const breakers = new BreakerState(normalizeRunBreakers({
    retry: { maxSpend: 10, backoffMs: 1_000, maxAgentDelayMs: 5_000, maxRetries: 3 },
  }, true));
  assert.equal(breakers.backoffMs(1), 1_000);
  assert.equal(breakers.backoffMs(10), 5_000);
  assert.equal(breakers.backoffMs(1, 2_500), 2_500);
  assert.equal(breakers.backoffMs(1, 6_000), undefined);
  assert.equal(breakers.retryExposureAvailable(1, 3), true);
  assert.equal(breakers.retryExposureAvailable(1, 4), false);
  assert.equal(serverRetryDelayMs({ headers: new Headers({ "retry-after-ms": "250" }) }), 250);
  assert.equal(serverRetryDelayMs({ headers: { "retry-after": "2" } }), 2_000);
  assert.equal(serverRetryDelayMs(new Error("no headers")), undefined);
  assert.throws(() => normalizeRunBreakers({ retry: { maxSpend: 1, maxRetries: -1 } }, true),
    /cave_breaker_retry_backoff_invalid/);
});

test("a source that breaks mid-stream ends as an error turn instead of hanging", async () => {
  const selected = model();
  const source = {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { role: "assistant", content: [] } };
      throw new Error("wrapper closed");
    },
  };
  const replay = await failFastPreStream(source, selected);
  const events = [];
  for await (const event of replay) events.push(event.type);
  assert.deepEqual(events, ["start", "error"]);
  assert.equal((await replay.result()).errorMessage, "wrapper closed");
  const ended = await failFastPreStream({
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { role: "assistant", content: [] } };
    },
  }, selected);
  assert.equal((await ended.result()).errorMessage, "cave_stream_ended_without_terminal");
});

// --- sticky routing input -----------------------------------------------------

test("the router learns whether a call follows user input or tool results", async () => {
  const reasons = [];
  let calls = 0;
  await run(pollingAgent("route-reason"), "go", {
    ensureRuntime: false,
    model: model(),
    modelRouter: (input) => {
      reasons.push(input.reason);
      return { model: input.currentModel, reason: "pinned", signals: ["test"] };
    },
    streamFn: (selected) => ++calls === 1
      ? reply(selected, [toolCall("r1")], "toolUse", usage(10, 1))
      : reply(selected, [{ type: "text", text: "done" }], "stop", usage(10, 1)),
  });
  assert.deepEqual(reasons, ["user", "continuation"]);
});

// --- image input limits -------------------------------------------------------

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const image = (bytes) => ({ type: "image", mimeType: "image/png", source: { type: "base64", data: bytes.toString("base64") } });
const imageModel = (inputLimits) => model({ input: ["text", "image"], inputLimits });

test("hard image limits refuse before any provider call", async () => {
  const cases = [
    [{ images: { maxPerMessage: 1 } }, [image(png(10, 10)), image(png(10, 10))], /images_per_message/],
    [{ images: { maxPerRequest: 1 } }, [image(png(10, 10)), image(png(10, 10))], /images_per_request/],
    [{ maxRequestBytes: 4_096 }, [image(Buffer.concat([png(10, 10), Buffer.alloc(4_096)]))], /request_bytes/],
  ];
  for (const [limits, parts, expected] of cases) {
    let calls = 0;
    await assert.rejects(run(replyAgent("image-limits"), [{ type: "text", text: "look" }, ...parts], {
      ensureRuntime: false,
      model: imageModel(limits),
      streamFn: (selected) => {
        calls++;
        return reply(selected, [{ type: "text", text: "ok" }], "stop", usage(10, 1));
      },
    }), new RegExp(`cave_model_input_limit:anthropic/claude-haiku-4-5:${expected.source}`));
    assert.equal(calls, 0);
  }
  assert.equal(imageInputLimitViolation(imageModel({ images: { maxPerRequest: 0 } }),
    [{ role: "user", content: "text only" }]), undefined);
});

test("images over the resize profile pass through byte for byte, now and in later history", async () => {
  // Pi's resize profile is a preprocessing target, not a provider limit. With
  // no resizer the image is sent unchanged rather than refused.
  const limited = imageModel({ images: { resize: { maxWidth: 100, maxHeight: 100, maxBytes: 64 } } });
  const screenshot = png(2_560, 1_600);
  const sentImages = [];
  const conversation = createConversation();
  const options = {
    ensureRuntime: false,
    model: limited,
    conversation,
    streamFn: (selected, context) => {
      sentImages.push(context.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : []));
      return reply(selected, [{ type: "text", text: "seen" }], "stop", usage(10, 1));
    },
  };
  const first = await run(replyAgent("image-pass"), [{ type: "text", text: "look" }, image(screenshot)], options);
  assert.equal(first.text, "seen");
  await run(replyAgent("image-pass"), "and now?", options);
  assert.equal(sentImages.length, 2);
  for (const images of sentImages) {
    assert.equal(images.length, 1);
    assert.equal(images[0].data, screenshot.toString("base64"));
  }
});

// --- per-model compaction knobs -----------------------------------------------

test("compaction model overrides resolve value by value and validate", () => {
  const config = normalizeCompaction({
    reserveTokens: 16_384,
    keepRecentTokens: 20_000,
    modelOverrides: { "anthropic/big": { reserveTokens: 400_000 } },
  });
  assert.deepEqual(
    [compactionForModel(config, "anthropic/big").reserveTokens, compactionForModel(config, "anthropic/big").keepRecentTokens],
    [400_000, 20_000],
  );
  assert.equal(compactionForModel(config, "anthropic/small"), config);
  assert.equal(compactionForModel(config, "__proto__"), config);
  for (const invalid of [{ reserveTokens: -1 }, { modelOverrides: { a: { keepRecentTokens: 0 } } }, { modelOverrides: { a: null } }]) {
    assert.throws(() => normalizeCompaction(invalid), /cave_compaction_option_invalid/);
  }
  // A reserve wider than the window minus minYieldTokens is clamped: no rung could free enough sooner.
  const small = normalizeCompaction({ reserveTokens: 16_384, minYieldTokens: 20_000 });
  const prompt = (inputTokens) => ({ inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  assert.equal(contextWindowFull(small, model({ contextWindow: 32_000 }), prompt(19_000), []), false);
  assert.equal(contextWindowFull(small, model({ contextWindow: 32_000 }), prompt(20_001), []), true);
  assert.equal(contextWindowFull(small, model({ contextWindow: 200_000 }), prompt(183_617), []), true);
  assert.equal(contextWindowFull(normalizeCompaction({}), model(), prompt(10_000_000), []), false);
});

const BULK = "x".repeat(8_000);

async function windowRun(compaction, { contextWindow = 200_000, perCall = 30_000, calls = 6 } = {}) {
  const windows = [];
  let working = 0;
  const result = await run(pollingAgent("compaction-reserve"), "go", {
    ensureRuntime: false,
    model: model({ contextWindow, maxTokens: 4_000 }),
    breakers: { noProgressTurns: 20 },
    budget: {
      maxUsd: 50,
      onExhausted: "compact",
      compaction: {
        minYieldTokens: 1_000,
        mode: "new-context",
        newContext: (input) => {
          windows.push(input.generation);
          return "keep polling";
        },
        ...compaction,
      },
    },
    streamFn: (selected) => {
      working++;
      if (working > calls) return reply(selected, [{ type: "text", text: "done" }], "stop", usage(100, 10));
      // Provider-reported prompt grows `perCall` per call; the wallet never binds.
      return reply(selected, [{ type: "text", text: `${BULK}-${working}` }, toolCall(`w${working}`)],
        "toolUse", usage(working * perCall, 10));
    },
  });
  return { result, windows };
}

test("reserveTokens rolls the window over before it overflows, per model", async () => {
  const reserved = await windowRun({ reserveTokens: 50_000 });
  assert.equal(reserved.windows.length, 1);
  const rollover = reserved.result.receipt.compactions.find((entry) => entry.tier === "new-context");
  assert.equal(rollover.meteredCost, 0);
  assert.equal(rollover.summarySchemaVersion, undefined);
  assert.equal(reserved.result.receipt.spent < 5, true);

  const overridden = await windowRun({
    reserveTokens: 50_000,
    modelOverrides: { "anthropic/claude-haiku-4-5": { reserveTokens: 0 } },
  });
  assert.deepEqual(overridden.windows, []);
  const unset = await windowRun({});
  assert.deepEqual(unset.windows, []);
});

test("a small window on Pebble's defaults never archives a rollover it then declines", async () => {
  // 32k window, 16k reserve: the window is full long before a rollover can
  // free minYieldTokens, so every early turn would archive and decline.
  const { result, windows } = await windowRun({
    maxCompactions: 1, keepRecentTokens: 8_000, minYieldTokens: 20_000, reserveTokens: 16_384,
  }, { contextWindow: 32_000, perCall: 2_500, calls: 14 });
  const rollovers = result.receipt.compactions.filter((entry) => entry.tier === "new-context");
  assert.deepEqual(windows, [1]);
  assert.equal(rollovers.length, 1);
});

// --- prompt-cache warming -----------------------------------------------------

test("warm decision: profitable warms, unknown price or prompt does not, savings stay inferred", () => {
  const at = new Date("2026-10-02T00:00:00Z");
  const decision = cacheWarmDecision("anthropic", PRICED, 100_000, at);
  assert.equal(decision.action, "warm");
  assert.equal(decision.basis, "inferred");
  assert.equal(decision.expectedSavingsUsd >= 0.05, true);
  assert.equal(cacheWarmDecision("anthropic", PRICED, 5_000, at).action, "stop");
  assert.equal(cacheWarmDecision("anthropic", "not-a-cataloged-model", 100_000, at), undefined);
  // The catalog prices its cache reads but calls its cache semantics unknown.
  assert.equal(cacheWarmDecision("openai", "gpt-5.4-nano", 5_000_000, at), undefined);
  // An affinity cache bills a miss as fresh input: 1M tokens at $5 vs $0.5 cached.
  assert.equal(cacheWarmDecision("openai", "gpt-5.5", 1_000_000, at).missCostUsd, 4.5);
  assert.equal(cacheWarmDecision("anthropic", PRICED, 0, at), undefined);
  assert.equal(promptCacheTtlMs(model({ promptCache: undefined }), "short"), undefined);
  assert.equal(promptCacheTtlMs(model({ promptCache: { short: 300 } }), "none"), undefined);
  assert.equal(promptCacheTtlMs(model({ promptCache: { short: 300, long: 3600 } }), "long"), 3_600_000);
  // pi-ai reads PI_CACHE_RETENTION from the request env, else the process env.
  const ambient = process.env.PI_CACHE_RETENTION;
  process.env.PI_CACHE_RETENTION = "long";
  try {
    assert.equal(promptCacheTtlMs(model({ promptCache: { short: 300, long: 3600 } }), undefined, {}), 3_600_000);
    assert.equal(promptCacheTtlMs(model({ promptCache: { short: 300, long: 3600 } }), undefined,
      { PI_CACHE_RETENTION: "short" }), 300_000);
  } finally {
    if (ambient === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = ambient;
  }
  assert.equal(cacheWarmingDelayMs(300_000), 270_000);
  assert.equal(cacheWarmingDelayMs(10_000), undefined);
});

test("a warm replays the sent request byte for byte; only a bounding output cap may change", () => {
  const raw = { model: "m", max_tokens: 4_096, messages: [{ role: "user", content: "hi" }] };
  const sent = { ...raw, prompt_cache_key: "session" };
  assert.deepEqual(warmPayload({ ...raw, max_tokens: 1 }, raw, sent), { ...sent, max_tokens: 1 });
  assert.equal(warmPayload({ ...raw, max_tokens: 1, messages: [] }, raw, sent), undefined);
  // An API without an output cap (Codex) cannot bound the warm: never sent.
  const uncapped = { model: "m", input: [] };
  assert.equal(warmPayload(uncapped, uncapped, uncapped), undefined);
  assert.equal(warmPayload({ ...raw, max_tokens: 64 }, raw, sent), undefined);
});

test("a warmer times refreshes from the request's start, skips missed deadlines, and aborts on stop", async () => {
  const warmer = new CacheWarmer();
  let refreshes = 0;
  warmer.start(10_100, async () => {
    refreshes++;
    return true;
  });
  await warmer.stop();
  await sleep(150);
  assert.equal(refreshes, 0);
  // 11s lifetime: due 1s after the start, deadline 5s later.
  warmer.start(11_000, async () => {
    refreshes++;
    return false;
  }, Date.now() - 7_000);
  await sleep(50);
  assert.equal(refreshes, 0, "past its deadline a refresh would be a full-price write");
  let signal;
  warmer.start(11_000, (abortable) => {
    refreshes++;
    signal = abortable;
    // A refresh that never answers ends only when its signal aborts.
    return new Promise((resolve) => abortable.addEventListener("abort", () => resolve(false)));
  }, Date.now() - 3_000);
  await sleep(50);
  assert.equal(refreshes, 1, "an overdue refresh still inside its deadline goes at once");
  await Promise.race([warmer.stop(), sleep(1_000).then(() => assert.fail("stop waited on a hung refresh"))]);
  assert.equal(signal.aborted, true);
});

async function warmingRun(selectedModel, extra = {}, warmReply = undefined) {
  const payloads = [];
  const held = [];
  const controller = createBudgetController();
  let working = 0;
  const { seen, result } = await collect(stream(pollingAgent("cache-warm", async () => {
    await sleep(1_600);
    return "done polling";
  }), "go", {
    ensureRuntime: false,
    model: selectedModel,
    cacheWarming: "streaming",
    budget: { maxTokens: 5_000_000 },
    budgetController: controller,
    ...extra,
    streamFn: async (selected, context, options) => {
      const built = { model: selected.id, max_tokens: options?.maxTokens ?? 4_096, turns: context.messages.length };
      const sent = (await options?.onPayload?.(built, selected)) ?? built;
      payloads.push(sent);
      if (sent.max_tokens === 1) {
        held.push(controller.released - controller.spent - controller.remaining);
        return warmReply?.(selected) ??
          reply(selected, [{ type: "text", text: "." }], "stop", usage(0, 1, { cacheRead: 100_000 }));
      }
      return ++working === 1
        ? reply(selected, [toolCall("slow")], "toolUse", usage(10, 20, { cacheWrite: 100_000 }))
        : reply(selected, [{ type: "text", text: "done" }], "stop", usage(10, 5, { cacheRead: 100_000 }));
    },
  }));
  return { result, payloads, held, seen };
}

test("streaming warming refreshes a valuable cache during a long tool run, reserved and receipted", async () => {
  const { result, payloads, held, seen } = await warmingRun(model({ promptCache: { short: 11 } }));
  const warms = result.receipt.calls.filter((call) => call.purpose === "cache_warm");
  // Live surfaces see the warm as it settles: a run event that encodes as usage.
  const warmEvents = seen.filter((event) => event.type === "cache_warm");
  assert.deepEqual(JSON.parse(JSON.stringify(warmEvents.map((event) => event.call))), warms);
  const [frame] = encodeRunEvent(new PebbleEventEncoder("s"), warmEvents[0]);
  assert.equal(frame.kind, "usage");
  assert.equal(frame.usage.cacheRead, 100_000);
  assert.equal(frame.usage.costUsd, warms[0].estimatedUsd);
  assert.equal(warms.length, 1);
  assert.equal(warms[0].cacheReadTokens, 100_000);
  assert.equal(held.length, 1);
  assert.equal(held[0] > 0, true, "the warm held a wallet reservation while in flight");
  const warmSent = payloads.find((payload) => payload.max_tokens === 1);
  assert.deepEqual({ ...warmSent, max_tokens: 0 }, { ...payloads[0], max_tokens: 0 });
  // Metered like any call: the wallet and totals include the refresh.
  const tokens = result.receipt.calls.reduce((total, call) =>
    total + call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheWriteTokens, 0);
  assert.equal(result.receipt.spent, tokens);
  assert.equal(result.cacheReadTokens >= 200_000, true);
  assert.equal(result.receipt.claimBasis, "inferred");
  assert.equal(result.receipt.calls.filter((call) => call.purpose === undefined).length, 2);
  // A warm is spend, not a turn, and has no place in the no-cache counterfactual.
  const print = (calls) => renderReceipt({
    ...result.receipt, calls, durationMs: 1_000, mode: result.mode, totalEstimatedUsd: 1, unpriced: false,
  });
  const withWarm = print(result.receipt.calls);
  assert.match(withWarm, /· 2 turns ·/);
  const cold = (text) => text.match(/cold estimate +(\S+)/)?.[1];
  assert.notEqual(cold(withWarm), undefined);
  assert.equal(cold(withWarm), cold(print(result.receipt.calls.filter((call) => call.purpose === undefined))));
});

test("a tool that finishes mid-warm lets the warm settle normally first", async () => {
  // The warm leaves at 1s and answers 0.8s later; the tool finishes at 1.6s.
  const { result } = await warmingRun(model({ promptCache: { short: 11 } }), {}, (selected) =>
    delayedReply(selected, [{ type: "text", text: "." }], "length", usage(0, 1, { cacheRead: 100_000 }), 800));
  const warm = result.receipt.calls.find((call) => call.purpose === "cache_warm");
  assert.equal(warm.usageBasis, "provider_reported");
  assert.equal(warm.cacheReadTokens, 100_000);
  assert.equal(result.usageBasis, "provider_reported");
  assert.equal(result.priceBasis, "public_catalog");
});

test("a warm that never answers is abandoned after the grace and settles at worst case", async () => {
  const started = Date.now();
  const { result, held } = await warmingRun(model({ promptCache: { short: 11 } }), {},
    () => createAssistantMessageEventStream());
  const elapsed = Date.now() - started;
  assert.equal(elapsed >= CACHE_WARM_QUIESCE_MS && elapsed < CACHE_WARM_QUIESCE_MS + 3_000, true,
    "the next working call waited out the grace, and no longer");
  const warm = result.receipt.calls.find((call) => call.purpose === "cache_warm");
  assert.equal(warm.usageBasis, "unavailable");
  const working = result.receipt.calls.filter((call) => call.purpose === undefined).reduce((total, call) =>
    total + call.inputTokens + call.outputTokens + call.cacheReadTokens + call.cacheWriteTokens, 0);
  assert.equal(result.receipt.spent, working + held[0], "the abandoned warm settled at its reservation");
  // Like an unreadable compaction: the run's own usage report admits the gap.
  assert.equal(result.usageBasis, "unavailable");
  assert.equal(result.priceBasis, "unpriced");
});

test("a warm waits for its request to finish and counts its delay from the request's start", async () => {
  let inFlight = 0;
  const atWarm = [];
  let working = 0;
  const result = await run(pollingAgent("warm-timing", async () => {
    await sleep(600);
    return "done polling";
  }), "go", {
    ensureRuntime: false,
    model: model({ promptCache: { short: 11 } }),
    cacheWarming: "streaming",
    budget: { maxTokens: 5_000_000 },
    streamFn: async (selected, context, options) => {
      const built = { model: selected.id, max_tokens: options?.maxTokens ?? 4_096 };
      const sent = (await options?.onPayload?.(built, selected)) ?? built;
      if (sent.max_tokens === 1) {
        atWarm.push(inFlight);
        return reply(selected, [{ type: "text", text: "." }], "stop", usage(0, 1, { cacheRead: 100_000 }));
      }
      inFlight++;
      // The first request streams past the 1s warm delay; its tool then runs 0.6s.
      if (++working === 1) await sleep(1_200);
      const source = working === 1
        ? reply(selected, [toolCall("slow")], "toolUse", usage(10, 20, { cacheWrite: 100_000 }))
        : reply(selected, [{ type: "text", text: "done" }], "stop", usage(10, 5, { cacheRead: 100_000 }));
      source.result().then(() => inFlight--);
      return source;
    },
  });
  assert.deepEqual(atWarm, [0], "one warm, sent only once no real request was in flight");
  assert.equal(result.receipt.calls.filter((call) => call.purpose === "cache_warm").length, 1);
});

test("warming fails closed on an unknown price, unknown cache lifetime, or when off", async () => {
  for (const [label, selected, extra] of [
    ["unpriced", model({ id: "faux-unpriced", promptCache: { short: 11 } }), {}],
    ["no lifetime", model({ promptCache: undefined }), {}],
    ["off", model({ promptCache: { short: 11 } }), { cacheWarming: "off" }],
  ]) {
    const { result, payloads } = await warmingRun(selected, extra);
    assert.equal(result.receipt.calls.some((call) => call.purpose === "cache_warm"), false, label);
    assert.equal(payloads.some((payload) => payload.max_tokens === 1), false, label);
  }
});

test("a warm abandoned before its transport reaches onPayload is never sent or journaled", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cave-warm-abandoned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DiskDurableStore(dir);
  const wire = [];
  let working = 0;
  const polling = pollingAgent("warm-abandoned", async () => {
    await sleep(1_300);
    return "done polling";
  });
  const options = (signal) => ({
    ensureRuntime: false,
    model: model({ promptCache: { short: 11 } }),
    cacheWarming: "streaming",
    budget: { maxTokens: 5_000_000 },
    durable: { runId: "warm-abandoned", store },
    ...(signal === undefined ? {} : { signal }),
    streamFn: async (selected, context, options) => {
      // Transport setup (auth, gateway) that ignores the abort signal.
      if (options?.maxTokens === 1) await sleep(600);
      const built = { model: selected.id, max_tokens: options?.maxTokens ?? 4_096 };
      let sent;
      try {
        sent = (await options?.onPayload?.(built, selected)) ?? built;
      } catch (error) {
        wire.push(error.message);
        throw error;
      }
      if (sent.max_tokens === 1) {
        wire.push("warm sent");
        return reply(selected, [{ type: "text", text: "." }], "length", usage(0, 1, { cacheRead: 100_000 }));
      }
      return ++working === 1
        ? reply(selected, [toolCall("slow")], "toolUse", usage(10, 20, { cacheWrite: 100_000 }))
        : reply(selected, [{ type: "text", text: "done" }], "stop", usage(10, 5, { cacheRead: 100_000 }));
    },
  });
  // The run is torn down at 1.2s, while the 1s warm is still in its transport setup.
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 1_200);
  await assert.rejects(run(polling, "go", options(abort.signal)));
  await sleep(800);
  assert.deepEqual(wire, ["cave_cache_warm_abandoned"]);
  const journal = [];
  for (const file of await readdir(dir, { recursive: true })) {
    if (String(file).endsWith(".jsonl")) journal.push(...(await readFile(join(dir, file), "utf8")).trim().split("\n"));
  }
  assert.equal(journal.length > 0, true);
  assert.equal(journal.some((line) => JSON.parse(line).kind === "cache_warm"), false);
  const resumed = await run(polling, "go", options());
  assert.equal(resumed.receipt.calls.some((call) => call.purpose === "cache_warm"), false);
});

test("a warm aborted with its run still reaches the event stream before run_error", async () => {
  const abort = new AbortController();
  // The warm reaches the provider at 1s; the run is aborted at 1.2s, mid-warm.
  setTimeout(() => abort.abort(), 1_200);
  const { seen } = await warmingRun(model({ promptCache: { short: 11 } }), { signal: abort.signal }, (selected) =>
    delayedReply(selected, [{ type: "text", text: "." }], "length", usage(0, 1, { cacheRead: 100_000 }), 800));
  const types = seen.map((event) => event.type);
  assert.equal(types.at(-1), "run_error");
  assert.equal(types.includes("cache_warm"), true, "the warm's spend was surfaced before run_error");
});

test("durable warming journals each refresh as a paired intent and settle that replays cleanly", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cave-warm-durable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DiskDurableStore(dir);
  for (const [runId, warmReply] of [
    ["warm-billed", undefined],
    // A provider error before any usage: unbilled, receipted at zero, journaled at zero.
    ["warm-unbilled", (selected) => preStreamError(selected, "529 overloaded")],
  ]) {
    const first = await warmingRun(model({ promptCache: { short: 11 } }), { durable: { runId, store } }, warmReply);
    const warms = first.result.receipt.calls.filter((call) => call.purpose === "cache_warm");
    assert.equal(warms.length, 1, runId);
    // Re-invoking a completed durable run reconciles its receipt with the journal.
    const replayed = await warmingRun(model({ promptCache: { short: 11 } }), { durable: { runId, store } });
    assert.equal(replayed.payloads.length, 0, runId);
    assert.deepEqual(replayed.result.receipt.calls, first.result.receipt.calls, runId);
  }
});
