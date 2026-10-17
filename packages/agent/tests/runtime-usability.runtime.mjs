import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  AgentRunController,
  agent,
  output,
  restoreConversation,
  run,
  schema,
  stream,
  subagent,
  tool,
} from "../dist/index.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";

function attachController(controller, options) {
  const pi = new Agent({
    initialState: { model: fauxModel(), ...options.initialState },
    ...options,
  });
  controller._attach(pi);
  pi.subscribe((event) => controller._observe(event));
  return pi;
}

test("controller removes steering delivered before the first provider request", async () => {
  const controller = new AgentRunController();
  controller.steer("adjust the task");
  const replies = scriptedStream([{ text: "done" }]);
  const requests = [];
  const pi = attachController(controller, {
    streamFn(selected, context, options) {
      requests.push(context.messages.filter((message) => message.role === "user"));
      assert.equal(controller.state.queued, 0);
      return replies(selected, context, options);
    },
  });
  await pi.prompt("start");
  controller._detach(pi);
  assert.equal(pi.state.errorMessage, undefined);
  assert.equal(requests[0].length, 2);
  assert.deepEqual(controller.state, { queued: 0, heldAfterInterrupt: false });
});

test("controller retains follow-ups across tool turns until Pi delivers them", async () => {
  const controller = new AgentRunController();
  controller.followUp("next task");
  const queuedAtRequest = [];
  const userMessagesAtRequest = [];
  const replies = scriptedStream([
    { toolCalls: [{ name: "lookup", args: {} }] },
    { text: "first task done" },
    { text: "next task done" },
  ]);
  const pi = attachController(controller, {
    initialState: {
      model: fauxModel(),
      tools: [{
        name: "lookup", label: "Lookup", description: "Read a value.",
        parameters: schema.object({}),
        async execute() { return { content: [{ type: "text", text: "value" }], details: null }; },
      }],
    },
    streamFn(selected, context, options) {
      queuedAtRequest.push(controller.state.queued);
      userMessagesAtRequest.push(context.messages.filter((message) => message.role === "user").length);
      return replies(selected, context, options);
    },
  });
  await pi.prompt("start");
  controller._detach(pi);
  assert.equal(pi.state.errorMessage, undefined);
  assert.deepEqual(queuedAtRequest, [1, 1, 0]);
  assert.deepEqual(userMessagesAtRequest, [1, 1, 2]);
  assert.deepEqual(controller.state, { queued: 0, heldAfterInterrupt: false });
});

test("controller retains undelivered follow-ups when a tool loop ends early", async () => {
  const controller = new AgentRunController();
  controller.followUp("retained task");
  const replies = scriptedStream([
    { toolCalls: [{ name: "lookup", args: {} }] },
    { text: "partial" },
  ]);
  let turns = 0;
  const pi = attachController(controller, {
    initialState: {
      model: fauxModel(),
      tools: [{
        name: "lookup", label: "Lookup", description: "Read a value.",
        parameters: schema.object({}),
        async execute() { return { content: [{ type: "text", text: "value" }], details: null }; },
      }],
    },
    streamFn: replies,
    finishTurn() { if (++turns === 2) return { action: "end" }; },
  });
  await pi.prompt("start");
  controller._detach(pi);
  assert.equal(pi.state.errorMessage, undefined);
  assert.equal(controller.state.queued, 1);

  const resumed = attachController(controller, {
    streamFn: scriptedStream([{ text: "resumed" }, { text: "retained task done" }]),
  });
  await resumed.prompt("resume");
  controller._detach(resumed);
  assert.equal(resumed.state.errorMessage, undefined);
  assert.equal(resumed.state.messages.filter((message) => message.role === "user").length, 2);
  assert.equal(controller.state.queued, 0);
});

test("indexed removal cannot requeue a follow-up Pi already selected for delivery", async () => {
  const controller = new AgentRunController();
  controller.followUp("first");
  controller.followUp("remove this");
  const requests = [];
  const replies = scriptedStream([{ text: "done" }, { text: "done" }]);
  let turns = 0;
  const defined = agent({ id: "queue-removal", instructions: "Reply.", model: fauxModel(), sandbox: "fixture" });
  for await (const event of stream(defined, "start", {
    cave: "off", controller,
    streamFn(selected, context, options) {
      requests.push(context.messages.filter((message) => message.role === "user").map((message) => message.content));
      return replies(selected, context, options);
    },
  })) {
    if (event.type !== "pi" || event.event.type !== "turn_start" || ++turns !== 2) continue;
    assert.throws(() => controller.clear(0), /cave_agent_queue_message_in_flight/);
    controller.clear(1);
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[1].length, 2);
  assert.deepEqual(requests[1][1], [{ type: "text", text: "first" }]);
  assert.equal(controller.state.queued, 0);
});

test("indexed removal preserves both native queues and treats identical text as distinct messages", async () => {
  const controller = new AgentRunController();
  controller.steer("same");
  controller.steer("remove this");
  controller.followUp("same");
  controller.followUp("last");
  const requests = [];
  const replies = scriptedStream([{ text: "done" }, { text: "done" }, { text: "done" }]);
  const pi = attachController(controller, {
    streamFn(selected, context, options) {
      requests.push(context.messages.filter((message) => message.role === "user").map((message) => message.content));
      return replies(selected, context, options);
    },
  });
  controller.clear(1);
  assert.equal(pi.steeringMode, "one-at-a-time");
  assert.equal(pi.followUpMode, "one-at-a-time");
  await pi.prompt("start");
  controller._detach(pi);
  assert.equal(pi.state.errorMessage, undefined);
  assert.deepEqual(requests.map((messages) => messages.length), [2, 3, 4]);
  assert.deepEqual(requests[2].flat(), ["start", "same", "same", "last"].map((text) => ({ type: "text", text })));
  assert.equal(controller.state.queued, 0);
});

const structuredAgent = () => agent({
  id: "structured-partial",
  model: fauxModel(),
  instructions: "Look up the answer, then return JSON.",
  sandbox: "fixture",
  tools: [tool({
    name: "lookup", description: "Read an answer.", input: schema.object({}),
    effect: "read", execute: () => "42",
  })],
  output: output({ maxTokens: 100, schema: schema.object({ answer: schema.string() }) }),
});

test("structured run returns partial work when its model-call ceiling stops the tool loop", async () => {
  const result = await run(structuredAgent(), "answer", {
    cave: "off", maxModelCalls: 1,
    streamFn: scriptedStream([{ text: "Looking up the answer.", toolCalls: [{ name: "lookup", args: {} }] }]),
  });
  assert.equal(result.stopReason, "call_budget_exhausted");
  assert.equal(result.text, "Looking up the answer.");
  assert.equal(result.output, undefined);
  assert.equal(result.receipt.calls.length, 1);
  assert.equal(result.receipt.stopReason, "call_budget_exhausted");
});

test("structured stream ends normally without output when a token budget stops the tool loop", async () => {
  const events = [];
  for await (const event of stream(structuredAgent(), "answer", {
    cave: "off", budget: { maxTokens: 5_000 },
    streamFn: scriptedStream([{
      toolCalls: [{ name: "lookup", args: {} }], usage: { input: 4_900, output: 100 },
    }]),
  })) events.push(event);
  assert.equal(events.at(-1).type, "run_end");
  const result = events.at(-1).result;
  assert.equal(result.stopReason, "budget_exhausted");
  assert.equal(result.output, undefined);
  assert.equal(result.receipt.calls.length, 1);
});

test("completed structured answers still validate and retain their parsed output", async () => {
  const result = await run(structuredAgent(), "answer", {
    cave: "off", streamFn: scriptedStream([{ text: '{"answer":"42"}' }]),
  });
  assert.equal(result.stopReason, "complete");
  assert.deepEqual(result.output, { answer: "42" });
  await assert.rejects(run(structuredAgent(), "answer", {
    cave: "off", streamFn: scriptedStream([{ text: "not JSON" }]),
  }), /cave_output_schema_invalid_json/);
});

test("a subagent under a host controller does not take the root's controller", async () => {
  const child = agent({ id: "child", instructions: "Answer.", model: "anthropic/claude-haiku-4-5", sandbox: "fixture" });
  const parent = agent({
    id: "parent",
    instructions: "Delegate.",
    model: "anthropic/claude-haiku-4-5",
    sandbox: "fixture",
    tools: [subagent({ name: "delegate", description: "Delegate.", agent: child })],
  });
  const result = await run(parent, "go", {
    ensureRuntime: false,
    cave: "off",
    model: fauxModel(),
    controller: new AgentRunController(),
    // Parent delegates, child answers, parent finishes.
    streamFn: scriptedStream([{ toolCalls: [{ name: "delegate", args: { task: "sub" } }] }, { text: "child" }, { text: "done" }]),
  });
  assert.equal(result.text, "done");
  assert.equal(typeof restoreConversation, "function", "restoreConversation is a package export");
});
