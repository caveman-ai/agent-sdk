import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createModels } from "@earendil-works/pi-ai";
import { DiskDurableStore, createConversation } from "../dist/index.js";
import { createCodingAgent, runCodingTurn, startCodingSession, streamCodingRun } from "../dist/code.js";

const FAKE_ENGINE = resolve(import.meta.dirname, "fixtures/fake-engine.mjs");

/** A faux Anthropic provider that reports reasoning usage, recording each request's messages and reasoning level. */
function recordingModels(faux, seen, levels) {
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple(selected, context, options) {
      seen.push(structuredClone(context.messages));
      levels.push(options?.reasoning);
      return faux.provider.streamSimple(selected, context, options);
    },
  });
  return models;
}

function faux() {
  const handle = fauxProvider({ provider: "anthropic" });
  return { handle, model: { ...handle.getModel(), api: "anthropic-messages", provider: "anthropic" } };
}

const reply = (content) => ({ ...fauxAssistantMessage(content), usage: { ...fauxAssistantMessage(content).usage, reasoning: 0 } });

async function drain(events) {
  let end;
  for await (const event of events) {
    if (event.type === "run_error") throw new Error(event.message ?? event.code);
    if (event.type === "run_end") end = event.result;
  }
  return end;
}

async function withDirs(body) {
  const workspace = await mkdtemp(resolve(tmpdir(), "coding-run-ws-"));
  const engineStore = await mkdtemp(resolve(tmpdir(), "coding-run-engine-"));
  const journal = await mkdtemp(resolve(tmpdir(), "coding-run-journal-"));
  const previous = process.env.CAVE_FAKE_ENGINE_STORE;
  process.env.CAVE_FAKE_ENGINE_STORE = engineStore;
  try {
    return await body({ workspace, engineStore, journal });
  } finally {
    if (previous === undefined) delete process.env.CAVE_FAKE_ENGINE_STORE;
    else process.env.CAVE_FAKE_ENGINE_STORE = previous;
    for (const dir of [workspace, engineStore, journal]) await rm(dir, { recursive: true, force: true });
  }
}

const toolText = (messages, id) => messages.find((message) => message.role === "toolResult" && message.toolCallId === id)?.content[0].text;

test("a durable coding run on the local engine bounds only a cap overrun; the next run leaves earlier results as they were", async () => {
  await withDirs(async ({ workspace, engineStore, journal }) => {
    // A credits-style model ref: a local plan binds no model, so the plan's "caveman/..." id is no mismatch.
    const codingAgent = createCodingAgent({ workspace, model: "caveman/anthropic/faux-1", outputCaps: { bash: 2_048 } });
    const { handle, model } = faux();
    const seen = [];
    const store = new DiskDurableStore(journal);
    const conversation = createConversation();
    const big = `node -e 'process.stdout.write("x".repeat(40000) + "\\n")'`;
    const options = (runId) => ({
      cave: "local", engineBin: FAKE_ENGINE, model, models: recordingModels(handle, seen, []),
      conversation, durable: { runId, store },
    });
    const engineInputs = async () => (await readdir(engineStore)).filter((name) => name.startsWith("ccr_")).length;
    handle.setResponses([
      reply([fauxToolCall("bash", { command: "echo small-output-sentinel" }, { id: "small" })]),
      reply([fauxToolCall("bash", { command: big }, { id: "big" })]),
      reply("done"),
    ]);
    const first = await drain(streamCodingRun(codingAgent, "first ask", options("bound-run-1")));
    assert.equal(first.text, "done");
    // The overrun reached the engine whole and comes back compressed; the short output is as the tool wrote it.
    assert.match(toolText(seen[2], "big"), /^exit 0\n<cave-compressed /);
    assert.equal(toolText(seen[2], "small"), "exit 0\nsmall-output-sentinel\n");
    assert.equal(await engineInputs(), 1);

    handle.setResponses([reply("done again")]);
    const second = await drain(streamCodingRun(codingAgent, "second ask", options("bound-run-2")));
    assert.equal(second.text, "done again");
    // The earlier run's results are history now: no engine call, the short output still verbatim.
    assert.equal(await engineInputs(), 1);
    assert.equal(toolText(seen[3], "small"), "exit 0\nsmall-output-sentinel\n");
    // The earlier overrun is back to its capped text: what the tool returned, as the transcript keeps it.
    assert.equal(seen[3].filter((message) => message.role === "toolResult").some((message) => /cave-compressed/.test(message.content[0].text)), false);
  });
});

test("without cave local a coding run carries no plan, and the journal still records it", async () => {
  await withDirs(async ({ workspace, engineStore, journal }) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1", outputCaps: { bash: 2_048 } });
    const { handle, model } = faux();
    const seen = [];
    handle.setResponses([
      reply([fauxToolCall("bash", { command: `node -e 'process.stdout.write("x".repeat(40000))'` }, { id: "big" })]),
      reply("done"),
    ]);
    const result = await drain(streamCodingRun(codingAgent, "ask", {
      cave: "off", engineBin: FAKE_ENGINE, model, models: recordingModels(handle, seen, []),
      durable: { runId: "plain-run", store: new DiskDurableStore(journal) },
    }));
    assert.equal(result.text, "done");
    assert.doesNotMatch(toolText(seen[1], "big"), /cave-compressed/);
    assert.equal((await readdir(engineStore)).filter((name) => name.startsWith("ccr_")).length, 0);
    assert.equal((await readdir(journal)).length > 0, true);
  });
});

test("a run's reasoning level reaches every working call; without one the definition's applies", async () => {
  await withDirs(async ({ workspace }) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const { handle, model } = faux();
    const levels = [];
    handle.setResponses([reply([fauxToolCall("bash", { command: "true" }, { id: "t" })]), reply("done"), reply("plain")]);
    await drain(streamCodingRun(codingAgent, "think", { cave: "local", engineBin: FAKE_ENGINE, model, models: recordingModels(handle, [], levels), reasoning: "xhigh" }));
    assert.deepEqual(levels, ["xhigh", "xhigh"]);
    await drain(streamCodingRun(codingAgent, "plain", { cave: "off", model, models: recordingModels(handle, [], levels) }));
    // The coding agent's own level is off: Pi sends no reasoning option.
    assert.deepEqual(levels, ["xhigh", "xhigh", undefined]);
    await assert.rejects(drain(streamCodingRun(codingAgent, "bad", { cave: "off", model, models: recordingModels(handle, [], []), reasoning: "huge" })),
      /cave_run_reasoning_invalid/);
  });
});

test("a gateway-priced plan refuses a run reasoning level other than its own", async () => {
  await withDirs(async ({ workspace }) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const healthzOnly = async (url) => String(url).endsWith("/healthz") ? new Response("ok") : new Response(null, { status: 404 });
    const session = await startCodingSession(codingAgent, { ensureRuntime: false, engineBin: FAKE_ENGINE, fetch: healthzOnly });
    assert.equal(session.mode, "optimized");
    const { handle, model } = faux();
    handle.setResponses([reply("done")]);
    await assert.rejects(runCodingTurn(session, "think hard", { model, models: recordingModels(handle, [], []), reasoning: "high" }),
      /cave_run_reasoning_locked/);
  });
});

test("a local plan is its transforms alone: a UUID in the instructions passes", async () => {
  await withDirs(async ({ workspace }) => {
    // A repository's AGENTS.md may hold a UUID; a gateway plan refuses that prefix, a local one has no cache epoch.
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1", instructions: "Ticket 123e4567-e89b-42d3-a456-426614174000 explains the layout." });
    const { handle, model } = faux();
    handle.setResponses([reply("done")]);
    const result = await drain(streamCodingRun(codingAgent, "ask", { cave: "local", engineBin: FAKE_ENGINE, model, models: recordingModels(handle, [], []) }));
    assert.equal(result.text, "done");
  });
});

test("a local plan is its transforms alone: a reasoning call without a reasoning count passes", async () => {
  await withDirs(async ({ workspace }) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const { handle, model } = faux();
    // The provider reports no reasoning breakdown: a gateway plan could not meter its reasoning budget.
    handle.setResponses([fauxAssistantMessage("done")]);
    const result = await drain(streamCodingRun(codingAgent, "ask", {
      cave: "local", engineBin: FAKE_ENGINE, model: { ...model, reasoning: true }, models: recordingModels(handle, [], []),
      modelRouter: (input) => ({ model: input.currentModel, reason: "test", signals: [], reasoning: "high" }),
    }));
    assert.equal(result.text, "done");
  });
});
