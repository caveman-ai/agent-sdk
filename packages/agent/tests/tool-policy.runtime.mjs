// RunOptions.toolPolicy: host-owned authorization decided outside model
// output, plus RunResult.output for declared output schemas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import {
  agent,
  agentStaticContextDiagnostics,
  auto,
  decideToolCall,
  output,
  run,
  schema,
  stream,
  subagent,
  tool,
} from "../dist/index.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";

const receiptSchema = JSON.parse(readFileSync(
  new URL("../../shared/contracts/schemas/agent-run-receipt.schema.json", import.meta.url),
  "utf8",
));
const validateReceipt = new Ajv2020({ strict: true, allErrors: true }).compile(receiptSchema);

function tools(log) {
  return [
    tool({
      name: "read_thing",
      description: "Read.",
      input: schema.object({ key: schema.string() }),
      effect: "read",
      execute: async ({ key }) => { log.push(`read:${key}`); return `value:${key}`; },
    }),
    tool({
      name: "write_thing",
      description: "Write.",
      input: schema.object({ key: schema.string() }),
      effect: "write",
      execute: async ({ key }) => { log.push(`write:${key}`); return "written"; },
    }),
  ];
}

function policyAgent(id, log, extra = {}) {
  return agent({
    id,
    instructions: "Use the tools, then answer.",
    model: auto(),
    sandbox: "host",
    tools: tools(log),
    ...extra,
  });
}

const base = () => ({ ensureRuntime: false, model: fauxModel() });

test("a denied call reaches the model as cave_tool_denied:<code>, lands on the receipt, and never executes", async () => {
  const log = [];
  const seen = [];
  const result = await run(policyAgent("policy-deny", log), "go", {
    ...base(),
    toolPolicy: (call) => {
      seen.push(call);
      return call.effect === "write" ? { deny: "grant_scope" } : undefined;
    },
    streamFn: scriptedStream([
      { toolCalls: [{ name: "read_thing", args: { key: "a" } }, { name: "write_thing", args: { key: "b" } }] },
      { text: "done" },
    ]),
  });
  assert.equal(result.stopReason, "complete");
  assert.deepEqual(log, ["read:a"], "the denied write never executed");
  assert.deepEqual(seen.map((call) => [call.name, call.effect, call.agentPath, call.args]), [
    ["read_thing", "read", [], { key: "a" }],
    ["write_thing", "write", [], { key: "b" }],
  ]);
  assert.equal(seen[0].agentId, "policy-deny");
  assert.equal(seen[0].runId, result.runId);
  const write = result.receipt.tools.find((entry) => entry.name === "write_thing");
  assert.deepEqual(write, { name: "write_thing", calls: 1, errors: 1, denied: 1 });
  const read = result.receipt.tools.find((entry) => entry.name === "read_thing");
  assert.equal(read.denied, undefined, "an admitted tool carries no denied field");
  assert.ok(validateReceipt(result.receipt), JSON.stringify(validateReceipt.errors));
});

test("the model sees the denial reason as the tool result", async () => {
  const log = [];
  const toolResults = [];
  for await (const event of stream(policyAgent("policy-visible", log), "go", {
    ...base(),
    toolPolicy: () => ({ deny: "not_in_profile" }),
    streamFn: scriptedStream([
      { toolCalls: [{ name: "read_thing", args: { key: "a" } }] },
      { text: "done" },
    ]),
  })) {
    if (event.type === "pi" && event.event.type === "tool_execution_end") toolResults.push(event.event);
  }
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].isError, true);
  assert.match(JSON.stringify(toolResults[0].result), /cave_tool_denied:not_in_profile/);
  assert.deepEqual(log, []);
});

test("a policy that throws ends the run with cave_tool_policy_failed and its receipt, executing nothing", async () => {
  const log = [];
  await assert.rejects(
    run(policyAgent("policy-throws", log), "go", {
      ...base(),
      toolPolicy: () => { throw new Error("grant service unreachable"); },
      streamFn: scriptedStream([
        { toolCalls: [{ name: "read_thing", args: { key: "a" } }] },
        { text: "must not be reached" },
      ]),
    }),
    (error) => {
      assert.equal(error.code, "cave_tool_policy_failed");
      assert.match(error.message, /cave_tool_policy_failed/);
      assert.ok(error.receipt, "the failure carries the partial receipt");
      return true;
    },
  );
  assert.deepEqual(log, []);
});

test("a malformed decision or an invalid deny code is a policy failure, not an allow", async () => {
  const input = { runId: "r", agentId: "a", agentPath: [], toolCallId: "t", name: "x", effect: "read", args: {} };
  await assert.rejects(decideToolCall(() => ({ deny: "Bad Code!" }), input), /cave_tool_policy_reason_invalid/);
  await assert.rejects(decideToolCall(() => "yes", input), /cave_tool_policy_decision_invalid/);
  await assert.rejects(decideToolCall(() => ({ allow: false }), input), /cave_tool_policy_decision_invalid/);
  assert.equal(await decideToolCall(() => ({ allow: true }), input), undefined);
  assert.equal(await decideToolCall(async () => undefined, input), undefined);
  assert.deepEqual(await decideToolCall(() => ({ deny: "scope" }), input), { block: true, reason: "cave_tool_denied:scope" });
});

test("nested composite dispatch is gated with parentToolCallId", async () => {
  const log = [];
  const seen = [];
  const inner = tool({
    name: "inner_write",
    description: "Nested write.",
    input: schema.object({ key: schema.string() }),
    effect: "write",
    result: "inline",
    execute: async ({ key }) => { log.push(`inner:${key}`); return "ok"; },
  });
  const cell = tool({
    name: "code_cell",
    description: "Composite.",
    input: schema.object({ cell: schema.string() }),
    effect: "write",
    result: "inline",
    nestedTools: [inner],
    async execute(_input, _signal, context) {
      try {
        return await context.dispatch("inner_write", { key: "k" });
      } catch (error) {
        return `nested failed: ${error.message}`;
      }
    },
  });
  const composite = agent({
    id: "policy-nested",
    instructions: "Run the cell.",
    model: auto(),
    sandbox: "host",
    tools: [cell],
  });
  const result = await run(composite, "go", {
    ...base(),
    toolPolicy: (call) => { seen.push(call); return call.name === "inner_write" ? { deny: "nested_scope" } : undefined; },
    streamFn: scriptedStream([
      { toolCalls: [{ name: "code_cell", args: { cell: "x" } }] },
      { text: "done" },
    ]),
  });
  assert.equal(result.stopReason, "complete");
  assert.deepEqual(log, []);
  const nested = seen.find((call) => call.name === "inner_write");
  assert.ok(nested?.parentToolCallId, "the nested call names its composite parent");
  assert.equal(seen.find((call) => call.name === "code_cell").parentToolCallId, undefined);
  assert.deepEqual(result.receipt.tools.find((entry) => entry.name === "inner_write"), {
    name: "inner_write", calls: 1, errors: 1, denied: 1,
  });
});

test("a subagent inherits the policy and reports its agentPath", async () => {
  const log = [];
  const seen = [];
  const child = policyAgent("policy-child", log, { model: "anthropic/claude-haiku-4-5" });
  const parent = agent({
    id: "policy-parent",
    instructions: "Delegate.",
    model: auto(),
    sandbox: "host",
    tools: [subagent({ name: "delegate", description: "Delegate.", agent: child })],
  });
  const result = await run(parent, "go", {
    ...base(),
    model: fauxModel({ priced: true }),
    toolPolicy: (call) => { seen.push([call.agentId, call.agentPath, call.name]); return undefined; },
    streamFn: scriptedStream([
      { toolCalls: [{ name: "delegate", args: { task: "child task" } }] },
      { toolCalls: [{ name: "read_thing", args: { key: "c" } }] },
      { text: "child done" },
      { text: "parent done" },
    ]),
  });
  assert.equal(result.stopReason, "complete");
  assert.deepEqual(seen, [
    ["policy-parent", [], "delegate"],
    ["policy-child", ["delegate"], "read_thing"],
  ]);
  assert.deepEqual(log, ["read:c"]);
});

test("RunResult.output carries the parsed final message and the prompt renders the schema", async () => {
  const finding = schema.object({ severity: schema.string(), evidence: schema.array(schema.string()) });
  const investigator = agent({
    id: "typed-output",
    instructions: "Investigate.",
    model: auto(),
    sandbox: "fixture",
    output: output({ maxTokens: 500, schema: finding }),
  });
  const result = await run(investigator, "go", {
    ...base(),
    streamFn: scriptedStream([{ text: JSON.stringify({ severity: "high", evidence: ["q1"] }) }]),
  });
  assert.deepEqual(result.output, { severity: "high", evidence: ["q1"] });
  assert.equal(result.text, JSON.stringify(result.output));
  await assert.rejects(
    run(investigator, "go", { ...base(), streamFn: scriptedStream([{ text: JSON.stringify({ severity: 1 }) }]) }),
    /cave_output_schema_mismatch/,
  );
  const untyped = await run(policyAgent("untyped-output", []), "go", {
    ...base(),
    streamFn: scriptedStream([{ text: "plain" }]),
  });
  assert.equal("output" in untyped, false, "no schema, no output field");
  const diagnostics = await agentStaticContextDiagnostics(investigator);
  const withoutSchema = await agentStaticContextDiagnostics(agent({
    id: "typed-output-no-schema",
    instructions: "Investigate.",
    model: auto(),
    sandbox: "fixture",
    output: output({ maxTokens: 500 }),
  }));
  assert.ok(diagnostics.staticContextBytes > withoutSchema.staticContextBytes + 40,
    "the declared JSON Schema is rendered into the system prompt");
});
