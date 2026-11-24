import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defineAgent, runInProcess, tool } from "../src/index.ts";
import {
  HarnessSession,
  LocalEnv,
  appLoadoutFor,
  appLoadouts,
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
});

test("toHarnessTool bridges tool() into HarnessSession", async () => {
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

test("runInProcess selects app-gpt automatically for GPT models when computer != none", async () => {
  const gptModel: HarnessModel = {
    id: "gpt-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 16384,
  };
  const coder = defineAgent({
    name: "coder",
    instructions: "Help with code.",
    computer: "full",
  });
  const res = await runInProcess({
    agent: coder,
    task: "Say hello",
    model: gptModel,
    stream: fakeStream("hello"),
  });
  assert.equal(res.loadout, "app-gpt");
  assert.equal(res.text, "hello");
});
