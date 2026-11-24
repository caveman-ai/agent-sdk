import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  agentFileText,
  compileAgentDefinition,
  createCloudGateProvider,
  createMemoryGateProvider,
  defineAgent,
  defineSensor,
  runInProcess,
  tool,
} from "../src/index.ts";

const fakeModel = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet 4.6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200000,
  maxTokens: 8192,
};

function makeToolCallStream(toolName: string, args: Record<string, unknown>, reply: string) {
  let calls = 0;
  return (_model: any, _context: any, _opts: any) => {
    calls++;
    const msg =
      calls === 1
        ? {
            role: "assistant",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            content: [{ type: "toolCall", id: "tc_gate_1", name: toolName, arguments: args }],
            usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.0003, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 0.0006 } },
            stopReason: "toolUse",
            timestamp: Date.now(),
          }
        : {
            role: "assistant",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: reply }],
            usage: { input: 150, output: 20, cacheRead: 80, cacheWrite: 0, totalTokens: 250, cost: { input: 0.0004, output: 0.0003, cacheRead: 0.00002, cacheWrite: 0, total: 0.00072 } },
            stopReason: "stop",
            timestamp: Date.now(),
          };
    const evs = [
      { type: "start", partial: msg },
      ...(msg.content[0].type === "text"
        ? [{ type: "text_delta", contentIndex: 0, delta: msg.content[0].text, partial: msg }]
        : [{ type: "toolcall_start", contentIndex: 0, partial: msg }, { type: "toolcall_end", contentIndex: 0, toolCall: msg.content[0], partial: msg }]),
      { type: "done", reason: msg.stopReason, message: msg },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of evs) yield e;
      },
      result: async () => msg,
    };
  };
}

test("runInProcess blocks gated tool fail-closed when no provider is configured", async () => {
  let executed = false;
  const wireFunds = tool(
    "wire_funds",
    "Wire funds to a vendor",
    { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    async () => {
      executed = true;
      return { sent: true };
    },
    { gate: { risk: "critical", summary: "Approve wire transfer" } },
  );
  const finance = defineAgent({
    name: "finance",
    instructions: "Handle vendor payments.",
    computer: "none",
    tools: [wireFunds],
  });

  const res = await runInProcess({
    agent: finance,
    task: "Wire $5000",
    model: fakeModel,
    stream: makeToolCallStream("wire_funds", { amount: 5000 }, "Transfer was blocked pending approval."),
    loadout: "general",
  });

  assert.equal(executed, false, "gated tool handler must NEVER execute without a provider");
  assert.ok(res.events.some((e) => e.type === "gate.requested" && e.data.tool === "wire_funds"));
  assert.ok(res.events.some((e) => e.type === "gate.decided" && e.data.status === "denied"));
});

test("runInProcess blocks denied gate and executes approved gate end-to-end via Cloud Gate HTTP contract", async () => {
  // 1. Denied in-memory gate never runs tool
  let deniedExecuted = false;
  const issueRefund = tool(
    "issue_refund",
    "Issue customer refund",
    { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    async (args: { amount: number }) => {
      deniedExecuted = true;
      return { refunded: args.amount };
    },
    {
      gate: {
        action: "billing.refund",
        risk: "high",
        when: (input) => Number((input as { amount?: number })?.amount ?? 0) >= 100,
      },
    },
  );
  const billing = defineAgent({
    name: "billing",
    instructions: "Process refunds.",
    computer: "none",
    tools: [issueRefund],
  });

  const deniedRes = await runInProcess({
    agent: billing,
    task: "Refund $250",
    model: fakeModel,
    stream: makeToolCallStream("issue_refund", { amount: 250 }, "Refund denied by human reviewer."),
    loadout: "general",
    gateProvider: createMemoryGateProvider(() => ({ status: "denied", reason: "Needs CFO sign-off" })),
  });
  assert.equal(deniedExecuted, false);
  assert.ok(deniedRes.events.some((e) => e.type === "gate.decided" && e.data.status === "denied" && e.data.reason === "Needs CFO sign-off"));

  // 2. Approved via real loopback /api/v1/code/gates server executes tool cleanly
  let approvedArgs: unknown = null;
  const approvedTool = tool(
    "issue_refund",
    "Issue customer refund",
    { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    async (args: { amount: number }) => {
      approvedArgs = args;
      return { refunded: args.amount };
    },
    { gate: true },
  );
  const srv = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/code/gates") {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "gate_live_42", status: "approved", decided_by: "human_approver" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  assert.ok(addr && typeof addr === "object");

  try {
    const okRes = await runInProcess({
      agent: defineAgent({ name: "billing", instructions: "Process refunds.", computer: "none", tools: [approvedTool] }),
      task: "Refund $250",
      model: fakeModel,
      stream: makeToolCallStream("issue_refund", { amount: 250 }, "Refund approved and processed."),
      loadout: "general",
      gateProvider: createCloudGateProvider({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        apiKey: "cav_test_key_placeholder",
      }),
    });
    assert.deepEqual(approvedArgs, { amount: 250 });
    assert.ok(okRes.events.some((e) => e.type === "gate.decided" && e.data.status === "approved" && e.data.gate_id === "gate_live_42"));
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("defineAgent + defineSensor compiles deterministically and rejects duplicate sensor names", () => {
  const ciSensor = defineSensor({
    name: "ci-failures",
    kind: "github",
    filter: "event.conclusion == 'failure'",
  });
  const def = defineAgent({
    name: "ci-medic",
    instructions: "Watch CI failures and propose minimal fixes.",
    computer: "none",
    sensors: [ciSensor],
  });
  const b1 = compileAgentDefinition(def);
  const b2 = compileAgentDefinition(def);
  assert.equal(b1.digest, b2.digest);
  assert.match(agentFileText(def), /"ci-failures"/);

  assert.throws(
    () =>
      agentFileText(
        defineAgent({
          name: "dup-sensors",
          instructions: "Watch sensors.",
          sensors: [ciSensor, ciSensor],
        }),
      ),
    /declares the sensor "ci-failures" twice/,
  );
});
