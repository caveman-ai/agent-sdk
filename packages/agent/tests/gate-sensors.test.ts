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
  Session,
  tool,
  type SessionEvent,
  type Transport,
  type UserEvent,
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
    const reqEv = okRes.events.find((e) => e.type === "gate.requested");
    const decEv = okRes.events.find((e) => e.type === "gate.decided");
    assert.ok(reqEv && reqEv.type === "gate.requested");
    assert.ok(decEv && decEv.type === "gate.decided");
    assert.equal(decEv.data.status, "approved");
    assert.equal(decEv.data.gate_id, reqEv.data.gate_id, "gate.decided must correlate with gate.requested by gate_id");
    assert.equal(decEv.data.provider_gate_id, "gate_live_42");
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});

test("per-run gate rules override agent/tool rules, agentFileText serializes definition.gate, and Session enforces tool gates fail-closed", async () => {
  // 1. Per-run rule override beats agent/tool rule
  const seenActions: string[] = [];
  const refundTool = tool(
    "refund",
    "Refund charge",
    { type: "object", properties: { amount: { type: "number" } } },
    async () => ({ ok: true }),
    { gate: { action: "refund.standard", risk: "medium" } },
  );
  const agent = defineAgent({
    name: "billing-override",
    instructions: "Handle refunds.",
    computer: "none",
    tools: [refundTool],
    gate: { rules: [{ tool: "refund", action: "refund.agent_default", risk: "high" }] },
  });
  await runInProcess({
    agent,
    task: "Refund $50",
    model: fakeModel,
    stream: makeToolCallStream("refund", { amount: 50 }, "Done."),
    loadout: "general",
    gate: {
      rules: [{ tool: "refund", action: "refund.supervisor_review", risk: "critical" }],
      provider: createMemoryGateProvider((req) => {
        seenActions.push(req.action);
        return "approved";
      }),
    },
  });
  assert.deepEqual(seenActions, ["refund.supervisor_review"]);

  // 2. Agent-level definition.gate is serialized in agentFileText and changes compile digest
  const ungated = defineAgent({ name: "ops", instructions: "Run ops." });
  const gated = defineAgent({
    name: "ops",
    instructions: "Run ops.",
    gate: { requireAll: true, defaultRisk: "critical", timeoutMs: 60_000 },
  });
  assert.notEqual(agentFileText(ungated), agentFileText(gated));
  assert.notEqual(compileAgentDefinition(ungated).digest, compileAgentDefinition(gated).digest);
  assert.match(agentFileText(gated), /^gate: /m);

  // 3. Session enforces tool.gate fail-closed even outside runInProcess!
  let sessionToolExecuted = false;
  const secretTool = tool(
    "delete_prod",
    "Delete prod",
    { type: "object", properties: {} },
    async () => {
      sessionToolExecuted = true;
      return { deleted: true };
    },
    { gate: { action: "prod.delete", risk: "critical" } },
  );
  const sentReplies: Array<Exclude<UserEvent, { readonly type: "user.message" }>> = [];
  let releaseDone!: () => void;
  const doneGate = new Promise<void>((r) => { releaseDone = r; });
  const fakeTransport: Transport = {
    id: "sess_gate_test",
    events: (async function* (): AsyncIterable<SessionEvent> {
      yield { seq: 1, type: "session.status", created_at: "2026-11-24T00:00:00Z", data: { status: "running", stop_reason: null } };
      yield { seq: 2, type: "requires_action", created_at: "2026-11-24T00:00:00Z", data: { ask_id: "ask_1", kind: "tool", name: "delete_prod", input: {} } };
      await doneGate;
      yield { seq: 3, type: "session.status", created_at: "2026-11-24T00:00:00Z", data: { status: "terminated", stop_reason: "end_turn" } };
    })(),
    async message() { return "m1"; },
    async send(ev) {
      sentReplies.push(ev);
      releaseDone();
    },
    async close() {},
    kill() {},
  };
  const sess = new Session(fakeTransport, { tools: [secretTool] }, { once: true });
  await sess.result();
  assert.equal(sessionToolExecuted, false, "Session must NEVER invoke gated tool handler without a provider");
  assert.equal(sentReplies.length, 1);
  assert.equal(sentReplies[0]?.type, "user.tool_result");
  assert.equal((sentReplies[0] as Extract<UserEvent, { type: "user.tool_result" }>).is_error, true);
  assert.match((sentReplies[0] as Extract<UserEvent, { type: "user.tool_result" }>).content, /gate_provider_missing/);

  // 4. Session interrupt during pending Gate approval aborts & NEVER runs the tool even if approval arrives later.
  let interruptedToolRan = false;
  let releaseLateApproval!: (v: "approved") => void;
  let providerSawAbort = false;
  let gateEntered!: () => void;
  const gateEnteredReady = new Promise<void>((r) => { gateEntered = r; });
  const slowRefundTool = tool(
    "issue_refund",
    "Issue refund",
    { type: "object", properties: {} },
    async () => {
      interruptedToolRan = true;
      return { refunded: true };
    },
    { gate: { action: "refund.issue", risk: "critical" } },
  );
  let endInterruptedStream!: () => void;
  const interruptedStreamDone = new Promise<void>((r) => { endInterruptedStream = r; });
  const interruptTransport: Transport = {
    id: "sess_interrupt_gate",
    events: (async function* (): AsyncIterable<SessionEvent> {
      yield { seq: 1, type: "session.status", created_at: "2026-11-24T00:00:00Z", data: { status: "running", stop_reason: null } };
      yield { seq: 2, type: "requires_action", created_at: "2026-11-24T00:00:00Z", data: { ask_id: "ask_int", kind: "tool", name: "issue_refund", input: {} } };
      await interruptedStreamDone;
      yield { seq: 3, type: "session.status", created_at: "2026-11-24T00:00:00Z", data: { status: "terminated", stop_reason: "interrupted" } };
    })(),
    async message() { return "m1"; },
    async send() {},
    async close() {},
    kill() {},
  };
  const intSess = new Session(
    interruptTransport,
    {
      tools: [slowRefundTool],
      gateProvider: createMemoryGateProvider((_req, signal) => {
        gateEntered();
        signal?.addEventListener("abort", () => { providerSawAbort = true; });
        return new Promise<"approved">((resolve) => { releaseLateApproval = resolve; });
      }),
    },
  );
  await gateEnteredReady;
  await intSess.interrupt();
  assert.equal(providerSawAbort, true, "interrupt() must abort pending Gate approval signal");
  releaseLateApproval("approved");
  await new Promise((r) => setTimeout(r, 20));
  endInterruptedStream();
  await intSess.result();
  assert.equal(interruptedToolRan, false, "late Gate approval after interrupt() must NEVER run tool handler");

  // 5. Session rule precedence matches runInProcess: override -> tool -> agent default.
  const sessionActions: string[] = [];
  const makePrecedenceSession = async (useOverride: boolean) => {
    let finish!: () => void;
    const done = new Promise<void>((r) => { finish = r; });
    const t: Transport = {
      id: useOverride ? "sess_prec_override" : "sess_prec_tool",
      events: (async function* (): AsyncIterable<SessionEvent> {
        yield { seq: 1, type: "session.status", created_at: "2026-11-24T00:00:00Z", data: { status: "running", stop_reason: null } };
        yield { seq: 2, type: "requires_action", created_at: "2026-11-24T00:00:00Z", data: { ask_id: "ask_p", kind: "tool", name: "issue_refund", input: {} } };
        await done;
        yield { seq: 3, type: "session.status", created_at: "2026-11-24T00:00:00Z", data: { status: "terminated", stop_reason: "end_turn" } };
      })(),
      async message() { return "m1"; },
      async send() { finish(); },
      async close() {},
      kill() {},
    };
    const s = new Session(t, {
      tools: [slowRefundTool],
      agentGate: { rules: [{ tool: "issue_refund", action: "billing.default", risk: "medium" }] },
      ...(useOverride ? { gate: { rules: [{ tool: "issue_refund", action: "refund.session_override", risk: "critical" }] } } : {}),
      gateProvider: createMemoryGateProvider((req) => {
        sessionActions.push(req.action);
        return "denied";
      }),
    });
    await s.result();
  };
  await makePrecedenceSession(false);
  await makePrecedenceSession(true);
  assert.deepEqual(sessionActions, ["refund.issue", "refund.session_override"]);
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
