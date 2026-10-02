import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createCodingAgent,
  startCodingSession,
  streamCodingTurn,
} from "../dist/code.js";
import { AgentRunController } from "../dist/runtime.js";
import { DiskDurableStore } from "../dist/durable.js";

test("coding turn streams frozen Pebble events with per-message usage", async () => {
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  const session = await startCodingSession(codingAgent, { cave: "off" });
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([fauxAssistantMessage("streamed answer")]);
  const events = [];
  const stream = streamCodingTurn(session, "answer briefly", {
    overrides: {
      model: { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" },
      streamFn: faux.provider.streamSimple.bind(faux.provider),
    },
  });
  let returned;
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      returned = next.value;
      break;
    }
    events.push(next.value);
  }

  assert.equal(events[0].kind, "turn.start");
  assert.equal(events.at(-1).kind, "turn.end");
  assert.equal(events.at(-1).stopReason, "end_turn");
  assert.equal(events.filter((event) => event.kind === "delta.text")
    .map((event) => event.text).join(""), "streamed answer");
  const usage = events.filter((event) => event.kind === "usage");
  assert.equal(usage.length, 1);
  assert.equal(usage[0].usage.model, "faux-1");
  assert.equal(usage[0].usage.costUsd, null, "unknown model pricing fails closed");
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
  assert.equal(new Set(events.map((event) => event.sessionId)).size, 1);
  assert.equal(session.turns.length, 1);
  assert.equal(returned.receipt.schema, "caveman.agent.run-receipt.v1");
  assert.equal(returned.receipt.claimBasis, "inferred");
});

test("durable streamed turn replays one completed task without provider spend", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "cave-pebble-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DiskDurableStore(resolve(root, "journal"));
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([fauxAssistantMessage("durable answer")]);
  let providerCalls = 0;
  const overrides = {
    model: { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" },
    streamFn(model, context, options) {
      providerCalls++;
      return faux.provider.streamSimple(model, context, options);
    },
    durable: { runId: "pebble-task-1", store },
    budget: { maxTokens: 10_000 },
  };

  const firstAgent = createCodingAgent({ workspace: root, model: "anthropic/faux-1" });
  const firstSession = await startCodingSession(firstAgent, { cave: "off" });
  let firstResult;
  const first = streamCodingTurn(firstSession, "same task", { overrides });
  for (;;) {
    const next = await first.next();
    if (next.done) {
      firstResult = next.value;
      break;
    }
  }

  const resumedAgent = createCodingAgent({ workspace: root, model: "anthropic/faux-1" });
  const resumedSession = await startCodingSession(resumedAgent, { cave: "off" });
  let resumedResult;
  const resumed = streamCodingTurn(resumedSession, "same task", { overrides });
  for (;;) {
    const next = await resumed.next();
    if (next.done) {
      resumedResult = next.value;
      break;
    }
  }

  assert.equal(providerCalls, 1);
  assert.equal(resumedResult.receipt.runId, firstResult.receipt.runId);
  assert.equal(resumedResult.receipt.spent, firstResult.receipt.spent);
  assert.equal(resumedResult.receipt.totalTokens, firstResult.receipt.totalTokens);
});

test("event sequence remains gap-free across turns in one session", async () => {
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  const session = await startCodingSession(codingAgent, { cave: "off" });
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([
    fauxAssistantMessage("first turn"),
    fauxAssistantMessage("second turn"),
  ]);
  const overrides = {
    model: { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" },
    streamFn: faux.provider.streamSimple.bind(faux.provider),
  };
  const events = [];
  for await (const event of streamCodingTurn(session, "first", { overrides })) events.push(event);
  for await (const event of streamCodingTurn(session, "second", { overrides })) events.push(event);

  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
  assert.equal(events.filter((event) => event.kind === "turn.start").length, 2);
  assert.equal(events.filter((event) => event.kind === "turn.end").length, 2);
  assert.equal(new Set(events.map((event) => event.sessionId)).size, 1);
});

test("same-provider router runs before every working model call and emits reasons", async () => {
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  const routeInputs = [];
  const session = await startCodingSession(codingAgent, {
    cave: "off",
    modelRouter(input) {
      routeInputs.push(input);
      return {
        model: input.currentModel,
        reason: input.toolErrorStreak > 0 ? "tool failure needs another pass" : "inspect first",
        signals: input.toolErrorStreak > 0 ? ["tool_error_streak"] : ["initial_task"],
      };
    },
  });
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "missing-pebble-route.txt" }, { id: "read-1" })),
    fauxAssistantMessage("recovered"),
  ]);
  const events = [];
  const stream = streamCodingTurn(session, "inspect then recover", {
    overrides: {
      model: { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" },
      streamFn: faux.provider.streamSimple.bind(faux.provider),
    },
  });
  let returned;
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      returned = next.value;
      break;
    }
    events.push(next.value);
  }

  assert.deepEqual(routeInputs.map((input) => [input.callIndex, input.toolErrorStreak]), [
    [0, 0],
    [1, 1],
  ]);
  const routes = events.filter((event) => event.kind === "route.decided");
  assert.deepEqual(routes.map((event) => [event.model, event.reason, event.signals]), [
    ["anthropic/faux-1", "inspect first", ["initial_task"]],
    ["anthropic/faux-1", "tool failure needs another pass", ["tool_error_streak"]],
  ]);
  assert.equal(returned.receipt.calls.length, 2);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index));
});

test("router can change model between calls while receipt preserves both identities", async () => {
  const faux = fauxProvider({
    provider: "anthropic",
    models: [{ id: "faux-1" }, { id: "faux-2" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  const session = await startCodingSession(codingAgent, {
    cave: "off",
    modelRouter(input) {
      return {
        model: `anthropic/${input.callIndex === 0 ? "faux-1" : "faux-2"}`,
        reason: input.callIndex === 0 ? "inspect with base" : "shift after tool evidence",
        signals: input.callIndex === 0 ? ["initial_task"] : ["tool_result"],
      };
    },
  });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "missing-pebble-switch.txt" }, { id: "read-2" })),
    fauxAssistantMessage("finished on second model"),
  ]);
  const stream = streamCodingTurn(session, "switch after inspection", {
    overrides: {
      model: faux.getModel("faux-1"),
      models,
      streamFn: faux.provider.streamSimple.bind(faux.provider),
    },
  });
  const events = [];
  let returned;
  for (;;) {
    const next = await stream.next();
    if (next.done) {
      returned = next.value;
      break;
    }
    events.push(next.value);
  }

  assert.deepEqual(
    events.filter((event) => event.kind === "route.decided").map((event) => event.model),
    ["anthropic/faux-1", "anthropic/faux-2"],
  );
  assert.deepEqual(returned.receipt.calls.map((call) => call.model), ["faux-1", "faux-2"]);
  assert.equal(returned.receipt.claimBasis, "inferred");
});

test("kernel queue follows a streaming turn and reports exact count changes", async () => {
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  const session = await startCodingSession(codingAgent, { cave: "off" });
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([
    fauxAssistantMessage("first"),
    fauxAssistantMessage("queued response"),
  ]);
  const controller = new AgentRunController();
  const stream = streamCodingTurn(session, "start", {
    controller,
    overrides: {
      model: { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" },
      streamFn: faux.provider.streamSimple.bind(faux.provider),
    },
  });
  const events = [];
  const first = await stream.next();
  assert.equal(first.value.kind, "turn.start");
  events.push(first.value);
  controller.followUp("queued input");
  for await (const event of stream) events.push(event);

  const queueStates = events
    .filter((event) => event.kind === "queue.changed")
    .map((event) => [event.queued, event.heldAfterInterrupt]);
  assert.deepEqual(queueStates, [[0, false], [1, false], [0, false]]);
  assert.equal(events.filter((event) => event.kind === "delta.text")
    .map((event) => event.text).join(""), "firstqueued response");
  assert.deepEqual(controller.state, { queued: 0, heldAfterInterrupt: false });
});

test("a route decision pins the call's reasoning and identical leaf calls are counted", async () => {
  const base = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  // The session's own level is medium, so "off" has something to remove and
  // an absent decision has something to keep.
  const codingAgent = { ...base, definition: Object.freeze({ ...base.definition, reasoning: "medium" }) };
  const routeInputs = [];
  const session = await startCodingSession(codingAgent, {
    cave: "off",
    modelRouter(input) {
      routeInputs.push(input);
      return {
        model: input.currentModel,
        reason: "policy effort",
        signals: ["policy_effort"],
        ...(input.callIndex === 0 ? { reasoning: "low" } : input.callIndex === 1 ? { reasoning: "off" } : {}),
      };
    },
  });
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_file", { path: "missing-repeat.txt" }, { id: "read-1" })),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "missing-repeat.txt" }, { id: "read-2" })),
    fauxAssistantMessage(fauxToolCall("read_file", { path: "other.txt" }, { id: "read-3" })),
    fauxAssistantMessage("done"),
  ]);
  const efforts = [];
  const stream = streamCodingTurn(session, "repeat the read", {
    overrides: {
      model: { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" },
      streamFn: (model, context, options) => {
        efforts.push(options?.reasoning ?? null);
        return faux.provider.streamSimple(model, context, options);
      },
    },
  });
  for await (const _event of stream) { /* drain */ }
  assert.deepEqual(
    routeInputs.map((input) => [input.callIndex, input.repeatedToolCallStreak]),
    [[0, 0], [1, 1], [2, 2], [3, 1]],
  );
  assert.deepEqual(efforts, ["low", null, "medium", "medium"]);
  // No efficiency plan here, so the router is told it may vary reasoning.
  assert.deepEqual(routeInputs.map((input) => input.reasoningLocked), [false, false, false, false]);
});

test("a route decision with an unknown reasoning level is rejected", async () => {
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  const session = await startCodingSession(codingAgent, {
    cave: "off",
    modelRouter(input) {
      return { model: input.currentModel, reason: "bad", signals: ["bad"], reasoning: "turbo" };
    },
  });
  const faux = fauxProvider({ provider: "anthropic" });
  faux.setResponses([fauxAssistantMessage("never")]);
  // Pi answers a thrown streamFn with a synthesized error turn, so the
  // rejection surfaces as an error event rather than an iterator failure.
  const events = [];
  for await (const event of streamCodingTurn(session, "go", {
    overrides: {
      model: { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" },
      streamFn: faux.provider.streamSimple.bind(faux.provider),
    },
  })) events.push(event);
  assert.match(JSON.stringify(events), /cave_model_route_decision_invalid/);
  assert.equal(events.some((event) => event.kind === "delta.text" && /never/.test(event.text ?? "")), false);
});
