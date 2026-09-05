// Deterministic proof, no network. Every provider call is answered by a
// scripted stream from @caveman-ai/agent/testing; the tools, subagent runner,
// budget meter, breakers, journal, memory engine, and session server are real.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import {
  createConversation,
  createInMemoryMemoryStorage,
  createMemoryEngine,
  run,
  type RunOptions,
} from "@caveman-ai/agent";
import { DiskDurableStore, SqlDurableStore } from "@caveman-ai/agent/durable";
import { createAgentServer } from "@caveman-ai/agent/serve";
import { fauxModel, scriptedStream, type ScriptedTurn } from "@caveman-ai/agent/testing";
import { supportDesk } from "../src/agent.ts";
import { breakers, budget } from "../src/options.ts";

type StreamFn = NonNullable<RunOptions["streamFn"]>;

const scratch = mkdtempSync(join(tmpdir(), "support-desk-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function options(turns: ScriptedTurn[], extra: RunOptions = {}): RunOptions {
  return {
    rootDir: scratch,
    ensureRuntime: false,
    budget,
    breakers,
    model: fauxModel({ priced: true }),
    streamFn: scriptedStream(turns),
    ...extra,
  };
}

const lookup = (orderId: string): ScriptedTurn => ({
  toolCalls: [{ name: "lookup_order", args: { orderId } }],
});

test("refund ticket: lookup tool, policy skill, reviewer subagent on its own wallet, one receipt", async () => {
  const result = await run(supportDesk, "I want to return the tent from NB-5580.", options([
    lookup("NB-5580"),
    { toolCalls: [{ name: "load_skill", args: { name: "refund-policy" } }] },
    { toolCalls: [{ name: "refund_reviewer", args: { task: "NB-5580 delivered 2026-08-05, $249, unused: full refund $249?" } }] },
    // The subagent's own provider call answers next; the scripted stream is shared.
    { text: "verdict: approve\namount: 249.00\nreason: within 30 days of delivery." },
    { text: "You're eligible for a full refund of $249.00 for NB-5580 to your original payment method." },
  ]));

  assert.equal(result.stopReason, "complete");
  assert.match(result.text, /eligible/);
  assert.deepEqual(result.toolCalls, ["lookup_order", "load_skill", "refund_reviewer"]);
  assert.equal(result.receipt.calls.length, 4, "root calls");
  assert.equal(result.receipt.subagents.length, 1);
  assert.equal(result.receipt.subagents[0]?.calls.length, 1, "reviewer call");
  assert.equal(result.receipt.subagents[0]?.max, 0.02, "reviewer wallet");
  assert.deepEqual(
    result.receipt.tools.map((entry) => [entry.name, entry.calls, entry.errors]),
    [["lookup_order", 1, 0], ["load_skill", 1, 0], ["refund_reviewer", 1, 0]],
  );
  assert.equal(result.receipt.denomination, "usd");
  assert.equal(result.priceBasis, "public_catalog");
  assert.ok(result.receipt.totalEstimatedUsd > 0 && result.receipt.totalEstimatedUsd < budget.maxUsd!);
  assert.equal(result.mode, "observe-only");
});

test("a USD budget over a model the catalog cannot price fails closed before any call", async () => {
  let calls = 0;
  await assert.rejects(
    run(supportDesk, "hi", options([], {
      model: fauxModel(),
      streamFn: () => { calls++; throw new Error("must not be called"); },
    })),
    /cave_budget/,
  );
  assert.equal(calls, 0);
});

test("a repeated identical lookup trips the loop breaker between calls", async () => {
  const result = await run(supportDesk, "Keep checking NB-9999.", options([
    lookup("NB-9999"), lookup("NB-9999"), lookup("NB-9999"), { text: "unreachable" },
  ]));
  assert.equal(result.stopReason, "loop_detected");
  assert.ok(result.receipt.breakers.some((event) => event.kind === "loop_detected"));
});

test("a durable run with the same runId replays its journal and spends nothing", async () => {
  const store = new DiskDurableStore(join(scratch, "durable"));
  const durable = { runId: "ticket-1042", store };
  const first = await run(supportDesk, "Where is NB-1042?", options([
    lookup("NB-1042"), { text: "NB-1042 is with UPS, 3-5 business days from dispatch." },
  ], { durable }));
  let calls = 0;
  const replay = await run(supportDesk, "Where is NB-1042?", options([], {
    durable,
    streamFn: () => { calls++; throw new Error("must not be called"); },
  }));
  assert.equal(calls, 0);
  assert.equal(replay.text, first.text);
  assert.equal(replay.receipt.calls.length, 2);
});

test("memory: a remembered fact enters the next turn, never the permanent history", async () => {
  const tenant = "northbeam-test";
  const engine = createMemoryEngine({
    scope: { tenant, agentId: supportDesk.id, namespace: "customers" },
    storage: createInMemoryMemoryStorage(),
    ttlMs: 86_400_000,
  });
  await engine.remember({ text: "Maya prefers email over phone for updates.", kind: "preference" });
  const conversation = createConversation();
  const seen: string[] = [];
  const spy = (inner: StreamFn): StreamFn => (model, context, streamOptions) => {
    seen.push(JSON.stringify(context.messages));
    return inner(model, context, streamOptions);
  };
  const turn = (text: string) => options([], {
    conversation,
    memory: { tenant, engine },
    streamFn: spy(scriptedStream([{ text }])),
  });
  await run(supportDesk, "Hi, it's Maya. Quick question about returns.", turn("Hi Maya, happy to help."));
  await engine.flush();
  await run(supportDesk, "What's the window for a full refund?", turn("30 days from delivery."));

  assert.doesNotMatch(seen[0]!, /prefers email/);
  assert.match(seen[1]!, /prefers email/);
  assert.equal(JSON.stringify(conversation.snapshot()).includes("prefers email"), false);
  await engine.endSession(conversation.sessionId);
});

test("sessions server: bearer required, one journal per session, SSE fan-out of the turn", async (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec(SqlDurableStore.schema("sqlite"));
  const store = new SqlDurableStore({
    sql: { exec: (query, params) => db.prepare(query).all(...(params as SQLInputValue[])) },
    dialect: "sqlite",
  });
  const token = "test-token-0123456789";
  const server = createAgentServer({
    definition: supportDesk,
    token,
    store,
    rootDir: scratch,
    runOptions: () => options([lookup("NB-1042"), { text: "NB-1042 is with UPS." }]),
  });
  t.after(() => server.close(1_000));
  const port = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = (path: string, body: unknown, headers: Record<string, string> = auth) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

  assert.equal((await post("/sessions", { sessionId: "maya" }, {})).status, 401);
  assert.equal((await post("/sessions", { sessionId: "maya" })).status, 201);
  const frames = readUntilTurnEnd(await fetch(`${base}/sessions/maya/events`, { headers: auth }));
  assert.equal((await post("/sessions/maya/messages", { text: "Where is NB-1042?" })).status, 202);

  // Pebble v1 frames, in order: the turn, both provider calls with their
  // usage, the tool call in between, and a clean end. (The scripted stream
  // emits whole messages, so there are no delta.text frames to join here.)
  const events = await frames;
  assert.deepEqual(
    events.map((event) => event.kind),
    ["turn.start", "usage", "tool.start", "tool.end", "usage", "turn.end"],
  );
  assert.equal(events.find((event) => event.kind === "tool.start")?.name, "lookup_order");
  assert.equal(events.at(-1)?.stopReason, "end_turn");
  const status = await (await fetch(`${base}/sessions/maya`, { headers: auth })).json() as
    { runs: unknown[]; queued: number; messages: unknown[] };
  assert.equal(status.runs.length, 1);
  assert.equal(status.messages.length, 1);
  assert.equal(status.queued, 0);
});

interface Frame { kind: string; name?: string; stopReason?: string }

async function readUntilTurnEnd(response: Response): Promise<Frame[]> {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: Frame[] = [];
  let buffer = "";
  while (!events.some((event) => event.kind === "turn.end")) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const data = /^data: (.+)$/mu.exec(frame)?.[1];
      if (data !== undefined) events.push(JSON.parse(data));
    }
  }
  await reader.cancel();
  return events;
}
