import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineAgent,
  tool,
  agentFileText,
  compileAgentDefinition,
  compileAgentFolder,
  runInProcess,
} from "../src/index.ts";

test("defineAgent + compileAgentDefinition produces byte-stable SHA-256 build", () => {
  const lookup = tool(
    "lookup_invoice",
    "Look up an invoice by ID",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async ({ id }: { id: string }) => ({ id, status: "paid", amount: 42 }),
  );
  const def = defineAgent({
    name: "billing",
    description: "Answers billing questions",
    instructions: "Be brief and accurate.",
    computer: "none",
    model: "fast",
    tools: [lookup],
  });
  const b1 = compileAgentDefinition(def);
  const b2 = compileAgentDefinition(def);
  assert.equal(b1.digest, b2.digest);
  assert.equal(b1.manifest.name, "billing");
  assert.equal(b1.manifest.computer, "none");
  assert.equal(b1.manifest.files.length, 1);
  assert.match(agentFileText(def), /name: "billing"/);
});

test("compileAgentFolder compiles AGENT.md + skills + evals deterministically", () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-agent-build-"));
  try {
    mkdirSync(join(dir, "skills/refunds"), { recursive: true });
    mkdirSync(join(dir, "evals"), { recursive: true });
    writeFileSync(join(dir, "AGENT.md"), "---\nname: triage\nmodel: fast\ncomputer: none\n---\n\nRoute support requests.\n");
    writeFileSync(join(dir, "skills/refunds/SKILL.md"), "---\nname: refunds\n---\nRefund within 30 days.\n");
    writeFileSync(join(dir, "evals/basic.eval.json"), JSON.stringify({ name: "basic", dataset: { cases: [] } }));
    const res = compileAgentFolder(dir);
    assert.equal(res.manifest.name, "triage");
    assert.equal(res.manifest.computer, "none");
    assert.deepEqual(res.manifest.files.map((f) => f.path), ["AGENT.md", "evals/basic.eval.json", "skills/refunds/SKILL.md"]);
    assert.equal(res.digest.length, 64);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runInProcess drives real Harness v4 HarnessSession end-to-end with custom tool", async () => {
  let toolCalledWith: unknown = null;
  const lookup = tool(
    "lookup_invoice",
    "Find invoice details",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async (args: { id: string }) => {
      toolCalledWith = args;
      return { id: args.id, duplicateCharge: true, refundUsd: 29 };
    },
  );
  const billing = defineAgent({
    name: "billing",
    instructions: "Answer billing questions using lookup_invoice.",
    computer: "none",
    tools: [lookup],
  });

  let callCount = 0;
  const fakeStream = (_model: any, _context: any, _opts: any) => {
    callCount++;
    const msg =
      callCount === 1
        ? {
            role: "assistant",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            content: [{ type: "toolCall", id: "tc_1", name: "lookup_invoice", arguments: { id: "4411" } }],
            usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.0003, output: 0.0004, cacheRead: 0, cacheWrite: 0, total: 0.0007 } },
            stopReason: "toolUse",
            timestamp: Date.now(),
          }
        : {
            role: "assistant",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            content: [{ type: "text", text: "Invoice 4411 had a duplicate $29 charge; refund initiated." }],
            usage: { input: 180, output: 20, cacheRead: 100, cacheWrite: 0, totalTokens: 300, cost: { input: 0.0004, output: 0.0003, cacheRead: 0.00003, cacheWrite: 0, total: 0.00073 } },
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

  const res = await runInProcess({
    agent: billing,
    task: "Customer 4411 says they were charged twice",
    model: fakeModel,
    stream: fakeStream,
    loadout: "general",
  });

  assert.equal(callCount, 2);
  assert.deepEqual(toolCalledWith, { id: "4411" });
  assert.match(res.text, /4411/);
  assert.equal(res.stop_reason, "end_turn");
  assert.equal(res.loadout, "app-general");
  assert.ok(res.events.some((e) => e.type === "agent.tool_use" && e.data.name === "lookup_invoice"));
  assert.ok(res.events.some((e) => e.type === "agent.tool_result"));
  assert.ok(res.events.some((e) => e.type === "session.usage"));
});
