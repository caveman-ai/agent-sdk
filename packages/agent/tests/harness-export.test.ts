import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMemoryGateProvider, defineAgent, runInProcess, tool } from "../src/index.ts";
import {
  HarnessSession,
  LocalEnv,
  appLoadoutFor,
  appLoadouts,
  gateRulesForTools,
  resolveHarnessModel,
  toHarnessTool,
  usesExecSurface,
  type HarnessModel,
  type HarnessStreamFn,
} from "../src/harness.ts";

function fakeStream(text: string): HarnessStreamFn {
  return (model: HarnessModel) => {
    const msg = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text" as const, text }],
      usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const events = [
      { type: "start", partial: msg },
      { type: "text_delta", contentIndex: 0, delta: text, partial: msg },
      { type: "done", reason: "stop", message: msg },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev;
      },
      result: async () => msg,
    };
  };
}

test("@caveman-ai/agent/harness exposes model-native loadouts and fails closed on resolveHarnessModel", () => {
  assert.equal(appLoadoutFor({ api: "openai-responses", id: "gpt-5.4" }).name, "app-gpt");
  assert.equal(usesExecSurface({ api: "openai-responses", id: "gpt-5.4" }), true);
  assert.equal(appLoadoutFor({ api: "anthropic-messages", id: "claude-sonnet-4-6" }).name, "app-claude");
  assert.equal(appLoadouts().general.name, "app-general");

  assert.throws(() => resolveHarnessModel("invalid"), /want provider\/id/);
  assert.throws(() => resolveHarnessModel("anthropic/claude-sonnet-4-6", { apiKey: "  " }), /must not be empty/);

  // Successful catalog lookup from a "provider/model" string with explicit apiKey
  const claude = resolveHarnessModel("anthropic/claude-sonnet-4-6", { apiKey: "test-key" });
  assert.equal(claude.model.provider, "anthropic");
  assert.equal(claude.model.id, "claude-sonnet-4-6");
  assert.equal(typeof claude.stream, "function");

  const gpt = resolveHarnessModel("openai/gpt-5.4", { apiKey: "test-key" });
  assert.equal(gpt.model.provider, "openai");
  assert.equal(gpt.model.id, "gpt-5.4");
  assert.equal(appLoadoutFor(gpt.model).name, "app-gpt");
});

test("toHarnessTool bridges tool(), propagates errors as throws, and enforces Caveman Gates fail-closed", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "caveman-agent-bridge-")));
  const env = new LocalEnv({ cwd });
  const ping = tool(
    "ping",
    "Return pong.",
    { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
    async ({ msg }: { msg: string }) => ({ pong: msg }),
  );
  const adapted = toHarnessTool(ping);
  const direct = await adapted.execute("tc_1", { msg: "hi" });
  assert.deepEqual(direct.content, [{ type: "text", text: JSON.stringify({ pong: "hi" }) }]);

  // Tool errors throw so Pi sets top-level isError: true
  const failing = tool(
    "boom",
    "Always fails.",
    { type: "object", properties: {} },
    async () => {
      throw new Error("boom-failed");
    },
  );
  await assert.rejects(() => toHarnessTool(failing).execute("tc_err", {}), /boom-failed/);

  // Gated tool fails closed without gateProvider (unless sessionGated: true)
  let ranGated = false;
  const gated = tool(
    "delete_record",
    "Delete a record.",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async ({ id }: { id: string }) => {
      ranGated = true;
      return { deleted: id };
    },
    { gate: { risk: "high" } },
  );
  assert.throws(() => toHarnessTool(gated), /Caveman Gate policy/);
  assert.equal(gateRulesForTools([gated]).length, 1);

  // Denied gate blocks handler execution and throws
  const deniedTool = toHarnessTool(gated, {
    gateProvider: createMemoryGateProvider(async (req) => ({
      gateId: req.gateId,
      status: "denied",
      reason: "policy blocked",
    })),
  });
  await assert.rejects(() => deniedTool.execute("tc_deny", { id: "42" }), /policy blocked/);
  assert.equal(ranGated, false);

  // Approved gate allows handler execution
  const approvedTool = toHarnessTool(gated, {
    gateProvider: createMemoryGateProvider(async (req) => ({
      gateId: req.gateId,
      status: "approved",
    })),
  });
  const ok = await approvedTool.execute("tc_ok", { id: "42" });
  assert.equal(ranGated, true);
  assert.deepEqual(ok.content, [{ type: "text", text: JSON.stringify({ deleted: "42" }) }]);

  const model: HarnessModel = {
    id: "claude-sonnet-4-6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8192,
  };
  const session = new HarnessSession({
    model,
    stream: fakeStream("ready"),
    loadout: appLoadouts().general,
    env,
    tools: [adapted],
  });
  try {
    const outcome = await session.runTurn("hi");
    assert.equal(outcome.status, "finished");
    assert.equal(outcome.finalText, "ready");
  } finally {
    await session.close();
    await env.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runInProcess resolves a catalog model string and selects app-gpt / app-claude automatically", async () => {
  const coder = defineAgent({
    name: "coder",
    instructions: "Help with code.",
    computer: "full",
  });

  const gptRes = await runInProcess({
    agent: coder,
    task: "Say hello",
    model: "openai/gpt-5.4",
    apiKey: "test-openai-key",
    stream: fakeStream("hello-gpt"),
  });
  assert.equal(gptRes.loadout, "app-gpt");
  assert.equal(gptRes.text, "hello-gpt");

  const claudeRes = await runInProcess({
    agent: coder,
    task: "Say hello",
    model: "anthropic/claude-sonnet-4-6",
    apiKey: "test-anthropic-key",
    stream: fakeStream("hello-claude"),
  });
  assert.equal(claudeRes.loadout, "app-claude");
  assert.equal(claudeRes.text, "hello-claude");
});
