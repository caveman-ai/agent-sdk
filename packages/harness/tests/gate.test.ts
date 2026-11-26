import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  createCloudGateProvider,
  createGateHook,
  createMemoryGateProvider,
  type GateDecision,
  type GateRequest,
} from "../src/gate.ts";

test("createGateHook fails closed when provider is missing", async () => {
  const events: string[] = [];
  const hook = createGateHook(
    { rules: [{ tool: "wire_transfer", risk: "critical" }] },
    (ev) => events.push(ev.type),
  );
  const reason = await hook({ id: "tc_1", name: "wire_transfer", args: { amount: 5000 } }, undefined);
  assert.ok(reason && reason.includes("gate_provider_missing"));
  assert.deepEqual(events, ["gate_requested", "gate_decided"]);
});

test("createGateHook fails closed on thrown error, timeout, abort, or invalid status", async () => {
  // 1. Thrown error
  const errHook = createGateHook({
    rules: [{ tool: "deploy" }],
    provider: {
      async requestApproval() {
        throw new Error("upstream unavailable");
      },
    },
  });
  const errReason = await errHook({ id: "c1", name: "deploy", args: {} }, undefined);
  assert.ok(errReason && errReason.includes("fail-closed") && errReason.includes("upstream unavailable"));

  // 2. Timeout — even when a provider completely ignores AbortSignal!
  const timeoutHook = createGateHook({
    rules: [{ tool: "deploy" }],
    timeoutMs: 25,
    provider: {
      async requestApproval() {
        return await new Promise<GateDecision>(() => {
          // Intentionally never settles and ignores signal
        });
      },
    },
  });
  const timeoutReason = await timeoutHook({ id: "c2", name: "deploy", args: {} }, undefined);
  assert.ok(timeoutReason && timeoutReason.includes("expired"));

  // 3. Invalid/non-terminal status ("pending" must never pass!)
  const badStatusHook = createGateHook({
    rules: [{ tool: "deploy" }],
    provider: {
      async requestApproval(req) {
        return { gateId: req.gateId, status: "pending" as unknown as "approved" };
      },
    },
  });
  const badReason = await badStatusHook({ id: "c3", name: "deploy", args: {} }, undefined);
  assert.ok(badReason && badReason.includes("invalid provider status"));
});

test("createGateHook supports regex, MCP server__tool, when predicate, and idempotent deduplication", async () => {
  let calls = 0;
  const seenKeys: string[] = [];
  const provider = createMemoryGateProvider(async (req: GateRequest) => {
    calls++;
    seenKeys.push(req.idempotencyKey);
    return { status: "approved", decidedBy: "human@caveman.so" };
  });

  const hook = createGateHook({
    sessionId: "sess_123",
    provider,
    rules: [
      {
        tool: /^stripe__/,
        risk: "high",
        when: (call) => Number((call.args as { amount?: number })?.amount ?? 0) >= 100,
      },
    ],
  });

  // Below threshold -> bypassed without calling provider
  const small = await hook({ id: "1", name: "refund", mcp: { server: "stripe", tool: "refund" }, args: { amount: 25 } }, undefined);
  assert.equal(small, undefined);
  assert.equal(calls, 0);

  // Above threshold -> approved via provider
  const big1 = await hook({ id: "call_2", name: "refund", mcp: { server: "stripe", tool: "refund" }, args: { amount: 250, currency: "usd" } }, undefined);
  assert.equal(big1, undefined);
  assert.equal(calls, 1);

  // Network retry of the SAME call id + canonical args -> deduplicated!
  const retrySameCall = await hook({ id: "call_2", name: "refund", mcp: { server: "stripe", tool: "refund" }, args: { currency: "usd", amount: 250 } }, undefined);
  assert.equal(retrySameCall, undefined);
  assert.equal(calls, 1);

  // A SECOND distinct tool execution with identical args MUST require a fresh human approval!
  const big2 = await hook({ id: "call_3", name: "refund", mcp: { server: "stripe", tool: "refund" }, args: { currency: "usd", amount: 250 } }, undefined);
  assert.equal(big2, undefined);
  assert.equal(calls, 2);
  assert.equal(seenKeys.length, 2);
  assert.notEqual(seenKeys[0], seenKeys[1]);

  // Normalized MCP exec-cell tool name (mcp__my_server__create_issue) matches exact qualified rule!
  let mcpGated = 0;
  const mcpHook = createGateHook({
    sessionId: "sess_mcp",
    provider: createMemoryGateProvider(() => {
      mcpGated++;
      return { status: "denied", reason: "blocked" };
    }),
    rules: [{ tool: "my_server__create_issue", risk: "high" }],
  });
  const blockedExecMcp = await mcpHook(
    { id: "c_exec_1", name: "mcp__my_server__create_issue", mcp: { server: "my-server", tool: "create-issue" }, args: {} },
    undefined,
  );
  assert.ok(blockedExecMcp && blockedExecMcp.includes("denied"));
  assert.equal(mcpGated, 1);
});

test("createCloudGateProvider enforces HTTPS on remote URLs and polls real loopback /api/v1/code/gates E2E", async () => {
  assert.throws(
    () => createCloudGateProvider({ baseUrl: "http://api.caveman.so", apiKey: "test-key" }),
    /HTTPS is required/,
  );

  let polls = 0;
  let lastIdempotencyKey = "";
  let lastAuth = "";
  const srv = createServer((req, res) => {
    lastAuth = String(req.headers.authorization ?? "");
    if (req.method === "POST" && req.url === "/api/v1/code/gates") {
      lastIdempotencyKey = String(req.headers["idempotency-key"] ?? "");
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "gate_srv_1", status: "pending" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/v1/code/gates/gate_srv_1") {
      polls++;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (polls === 1) {
        res.end(JSON.stringify({ id: "gate_srv_1", status: "pending" }));
      } else {
        res.end(JSON.stringify({ id: "gate_srv_1", status: "approved", decided_by: "usr_human_1" }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  assert.ok(addr && typeof addr === "object");

  try {
    const provider = createCloudGateProvider({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      apiKey: "cav_test_key_placeholder",
      pollIntervalMs: 100,
    });
    const hook = createGateHook({
      sessionId: "sess_cloud_e2e",
      provider,
      rules: [{ tool: "prod_deploy", action: "deploy.production", risk: "critical" }],
    });
    const refused = await hook({ id: "tc_deploy", name: "prod_deploy", args: { sha: "abc123" } }, undefined);
    assert.equal(refused, undefined);
    assert.equal(lastAuth, "Bearer cav_test_key_placeholder");
    assert.ok(lastIdempotencyKey.startsWith("gate_"));
    assert.equal(polls, 2);
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
});
