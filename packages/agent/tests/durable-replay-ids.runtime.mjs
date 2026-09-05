// A real provider mints fresh tool-call ids when a resumed run re-drives its
// lost turn. The journal's authority is position + tool + effect + argument
// digest, so a settled call replays across an id change and a changed call
// still fails closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DiskDurableStore, agent, auto, run, schema, stream, tool } from "../dist/index.js";
import { fauxModel } from "../dist/testing.js";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function usage(input = 100, output = 10) {
  return { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function pushMessage(selected, content, stopReason) {
  const messageStream = createAssistantMessageEventStream();
  const message = { role: "assistant", content, api: selected.api, provider: selected.provider,
    model: selected.id, usage: usage(), stopReason, timestamp: Date.now() };
  queueMicrotask(() => {
    messageStream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    messageStream.push({ type: "done", reason: stopReason, message });
    messageStream.end(message);
  });
  return messageStream;
}
const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });

async function crashedJournal(t, defined, runId, firstTurn) {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-replay-ids-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new DiskDurableStore(dir);
  const controller = new AbortController();
  let calls = 0;
  const iterator = stream(defined, "go", {
    ensureRuntime: false, model: fauxModel(), durable: { runId, store }, signal: controller.signal,
    budget: { maxTokens: 100_000 },
    streamFn: (selected) => {
      calls++;
      if (calls === 1) return pushMessage(selected, firstTurn, "toolUse");
      controller.abort(new Error("simulated crash"));
      throw new Error("simulated crash");
    },
  });
  for await (const _event of iterator) { /* drain */ }
  // Reproduce a killed process: settled tool events survive, the turn does not.
  const entry = (await readdir(dir)).find((name) => name.startsWith(`${runId}-`));
  const path = resolve(dir, entry, "journal.jsonl");
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const kept = lines.filter((line) => {
    const type = JSON.parse(line).type;
    return type !== "turn" && type !== "call_settled" && type !== "call_abandoned" && type !== "run_failed";
  });
  await writeFile(path, `${kept.join("\n")}\n`);
  return { store };
}

function countingAgent(id, executions) {
  return agent({
    id, instructions: "Look, then answer.", model: auto(), sandbox: "fixture",
    tools: [tool({
      name: "look", description: "Look something up.", input: schema.object({ key: schema.string() }),
      effect: "read", allowRepeat: true,
      execute: async ({ key }) => { executions.push(key); return `saw ${key}`; },
    })],
  });
}

test("a settled tool replays when the resumed provider mints a new call id", async (t) => {
  const executions = [];
  const defined = countingAgent("replay-ids", executions);
  const { store } = await crashedJournal(t, defined, "ids-1", [toolCall("provider-id-A", "look", { key: "k" })]);
  assert.deepEqual(executions, ["k"], "executed once before the crash");
  let resumedCalls = 0;
  const result = await run(defined, "go", {
    ensureRuntime: false, model: fauxModel(), durable: { runId: "ids-1", store }, budget: { maxTokens: 100_000 },
    streamFn: (selected) => {
      resumedCalls++;
      return resumedCalls === 1
        ? pushMessage(selected, [toolCall("provider-id-B", "look", { key: "k" })], "toolUse")
        : pushMessage(selected, [{ type: "text", text: "done" }], "stop");
    },
  });
  assert.equal(result.stopReason, "complete");
  assert.equal(result.resumed, true);
  assert.deepEqual(executions, ["k"], "the journaled settlement replayed; the tool did not run again");
});

test("a resumed provider that changes the call's arguments still fails closed", async (t) => {
  const executions = [];
  const defined = countingAgent("replay-ids-mismatch", executions);
  const { store } = await crashedJournal(t, defined, "ids-2", [toolCall("provider-id-A", "look", { key: "k" })]);
  await assert.rejects(
    run(defined, "go", {
      ensureRuntime: false, model: fauxModel(), durable: { runId: "ids-2", store }, budget: { maxTokens: 100_000 },
      streamFn: (selected) => pushMessage(selected, [toolCall("provider-id-B", "look", { key: "different" })], "toolUse"),
    }),
    /cave_durable_tool_replay_mismatch:look:provider-id-A/,
  );
  assert.deepEqual(executions, ["k"]);
});
