import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  completionMemorySidecar,
  cosine,
  createInMemoryMemoryStorage,
  createMemoryEngine,
  createMemoryWorkflow,
  openAICompatibleMemoryEmbedding,
  packVector,
} from "../dist/memory-api.js";
import {
  agent,
  auto,
  createConversation,
  memory,
  run,
} from "../dist/index.js";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  createCodingAgent,
  startCodingSession,
} from "../dist/code.js";

const scope = Object.freeze({ tenant: "_", agentId: "memory-test", namespace: "default" });

function keyedEmbedding() {
  return Object.freeze({
    id: "test.embedding.v1",
    async embed(texts) {
      return texts.map((text) => text.toLowerCase().includes("refund") ? [1, 0, 0] :
        text.toLowerCase().includes("escalate") ? [0, 1, 0] : [0, 0, 1]);
    },
  });
}

test("memory vectors are compact, vector-space bound, and graph recall expands one hop", async () => {
  const first = packVector("one", [1, 2, 3, 4]);
  const same = packVector("one", [1, 2, 3, 4]);
  const other = packVector("two", [1, 2, 3, 4]);
  assert.ok(first.data.length < JSON.stringify([1, 2, 3, 4]).length);
  assert.ok(cosine(first, same) > 0.999);
  assert.equal(cosine(first, other), 0);

  const engine = createMemoryEngine({
    scope,
    storage: createInMemoryMemoryStorage(),
    embedding: keyedEmbedding(),
    ttlMs: 86_400_000,
    minScore: 0.2,
  });
  const refund = await engine.remember({ text: "Refund policy is fourteen days." });
  const escalation = await engine.remember({
    text: "Escalate disputed charges to the billing owner.",
    kind: "procedure",
  });
  await engine.link(refund.id, escalation.id, "relates_to", 1);
  const hits = await engine.search("refund question", { graphDepth: 1 });
  assert.equal(hits[0].id, refund.id);
  assert.equal(hits.some((hit) => hit.id === escalation.id && hit.source === "graph"), true);
});

test("ambient workflow is non-blocking, one turn behind, and indexes session turns", async () => {
  let release;
  let delayed = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const embedding = {
    id: "test.delayed.v1",
    async embed(texts) {
      if (delayed) await gate;
      return texts.map(() => [1, 0]);
    },
  };
  const engine = createMemoryEngine({
    scope,
    storage: createInMemoryMemoryStorage(),
    embedding,
    ttlMs: 86_400_000,
  });
  await engine.remember({ text: "Refund window is fourteen days." });
  delayed = true;
  const workflow = createMemoryWorkflow(engine, "session-1");
  assert.equal(workflow.beforeTurn("What is the refund window?"), undefined);
  release();
  await engine.flush();
  const prompt = workflow.beforeTurn("Thanks, continue.");
  assert.match(prompt, /Refund window is fourteen days/);
  workflow.afterTurn("The refund window is fourteen days.");
  await engine.flush();
  const turns = await workflow.searchSessions("refund window");
  assert.equal(turns.some((turn) => turn.sessionId === "session-1"), true);
  await workflow.close();
});

test("ambient extraction runs off main turn and session end flushes remainder", async () => {
  const reasons = [];
  const engine = createMemoryEngine({
    scope,
    storage: createInMemoryMemoryStorage(),
    embedding: keyedEmbedding(),
    ttlMs: 86_400_000,
    ambient: { extractEveryTurns: 1 },
    sidecar: {
      async extract(input) {
        reasons.push(input.reason);
        return [{
          text: input.reason === "turns"
            ? "User prefers concise status updates."
            : "User ends sessions with a verification summary.",
          kind: "preference",
        }];
      },
    },
  });
  engine.beginTurn({ sessionId: "session-2", text: "Keep updates concise." });
  engine.endTurn({ sessionId: "session-2", text: "Understood." });
  await engine.flush();
  assert.deepEqual(reasons, ["turns"]);
  assert.match((await engine.search("concise updates"))[0].text, /concise/);

  engine.beginTurn({ sessionId: "session-2", text: "End with verification." });
  await engine.endSession("session-2");
  assert.deepEqual(reasons, ["turns", "session_end"]);
});

test("memory refuses obvious secrets before persistence", async () => {
  const engine = createMemoryEngine({
    scope,
    storage: createInMemoryMemoryStorage(),
    ttlMs: 86_400_000,
  });
  await assert.rejects(
    engine.remember({ text: "api_key = sk_abcdefghijklmnopqrstuvwxyz123456" }),
    /cave_memory_sensitive_value_refused/,
  );
  assert.equal(engine.beginTurn({
    sessionId: "secret-session",
    text: "password = do-not-store-this-password",
  }), undefined);
  engine.endTurn({
    sessionId: "secret-session",
    text: "access_token = do-not-store-this-token",
  });
  await engine.flush();
  assert.deepEqual(await engine.search("api key"), []);
  assert.deepEqual(await engine.searchSessions("do not store"), []);
});

test("completion sidecar accepts strict bounded ids and refuses invented ids", async () => {
  const candidate = {
    id: "known",
    text: "Known fact",
    kind: "fact",
    tags: [],
    score: 1,
    confidence: 1,
    source: "vector",
  };
  const accepted = completionMemorySidecar({
    async complete() { return JSON.stringify({ ids: ["known"] }); },
  });
  assert.deepEqual(await accepted.review({ query: "known", candidates: [candidate] }), ["known"]);

  const invented = completionMemorySidecar({
    async complete() { return JSON.stringify({ ids: ["invented"] }); },
  });
  await assert.rejects(
    invented.review({ query: "known", candidates: [candidate] }),
    /cave_memory_sidecar_review_invalid/,
  );
});

test("review sidecar may add bounded deeper-retrieval context", async () => {
  const storage = createInMemoryMemoryStorage();
  let selected = [];
  const engine = createMemoryEngine({
    scope,
    storage,
    ttlMs: 86_400_000,
    sidecar: {
      async review(input) {
        selected = input.candidates.map((candidate) => candidate.id);
        return { ids: selected, context: "Related session confirms billing owner escalation." };
      },
    },
  });
  await engine.remember({ text: "Escalate disputed charges." });
  const recalled = await engine.recall("disputed charges");
  assert.equal(selected.length, 1);
  assert.match(recalled.prompt, /sidecar-context/);
  assert.match(recalled.prompt, /billing owner escalation/);
});

test("OpenAI-compatible adapter uses explicit credential and validates response order", async () => {
  let request;
  const adapter = openAICompatibleMemoryEmbedding({
    baseURL: "https://embeddings.example/v1",
    model: "embed-small",
    apiKey: "explicit-test-key",
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(await adapter.embed(["one", "two"]), [[1, 0], [0, 1]]);
  assert.equal(request.url, "https://embeddings.example/v1/embeddings");
  assert.equal(request.init.headers.authorization, "Bearer explicit-test-key");
  assert.deepEqual(JSON.parse(request.init.body), {
    model: "embed-small",
    input: ["one", "two"],
  });
});

test("native agent runtime injects prior-turn recall without mutating conversation history", async () => {
  const defined = agent({
    id: "native-memory-agent",
    instructions: "Answer from current evidence.",
    model: auto(),
    memory: memory({ namespace: "native" }),
    sandbox: "fixture",
  });
  const engine = createMemoryEngine({
    scope: { tenant: "_", agentId: defined.id, namespace: "native" },
    storage: createInMemoryMemoryStorage(),
    ttlMs: 86_400_000,
  });
  await engine.remember({ text: "Refund window is fourteen days." });
  const conversation = createConversation();
  const first = fauxProvider({ provider: "anthropic" });
  let firstContext = "";
  first.setResponses([(context) => {
    firstContext = JSON.stringify(context.messages);
    return fauxAssistantMessage("first answer");
  }]);
  await run(defined, "What is the refund window?", {
    ensureRuntime: false,
    model: first.getModel(),
    streamFn: first.provider.streamSimple.bind(first.provider),
    conversation,
    memory: { engine },
  });
  assert.doesNotMatch(firstContext, /cave-memory-recall/);
  await engine.flush();

  const second = fauxProvider({ provider: "anthropic" });
  let secondContext = "";
  let toolNames = [];
  let secondMessages = [];
  second.setResponses([(context) => {
    secondContext = JSON.stringify(context.messages);
    secondMessages = context.messages;
    toolNames = getCurrentTools(context.messages).map((tool) => tool.name);
    return fauxAssistantMessage("second answer");
  }]);
  await run(defined, "Continue.", {
    ensureRuntime: false,
    model: second.getModel(),
    streamFn: second.provider.streamSimple.bind(second.provider),
    conversation,
    memory: { engine },
  });
  assert.match(secondContext, /cave-memory-recall/);
  assert.match(secondContext, /Refund window is fourteen days/);
  // Recall is live-zone context: after Pi's leading system message, directly
  // before the current prompt, never ahead of the system prompt.
  const recallIndex = secondMessages.findIndex((message) =>
    JSON.stringify(message).includes("cave-memory-recall"));
  assert.equal(secondMessages[0].role, "system");
  assert.equal(secondMessages.filter((message) => message.role === "system").length, 1);
  assert.equal(recallIndex > 0, true);
  assert.match(JSON.stringify(secondMessages[recallIndex + 1]), /Continue\./);
  assert.equal(toolNames.includes("cave_memory_session_search"), true);
  assert.equal(JSON.stringify(conversation.snapshot()).includes("cave-memory-recall"), false);
  await engine.endSession(conversation.sessionId);
});

test("coding sessions turn memory:true into one reused scoped engine", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cave-coding-memory-"));
  try {
    const coding = createCodingAgent({
      id: "coding-memory",
      model: "anthropic/faux-1",
      memory: true,
    });
    assert.equal(coding.definition.memory?.namespace, "coding-memory");
    const session = await startCodingSession(coding, { cave: "off", memory: { root } });
    const engine = session.options.memory?.engine;
    assert.ok(engine);
    assert.deepEqual(engine.scope, {
      tenant: "_",
      agentId: "coding-memory",
      namespace: "coding-memory",
    });
    await engine.remember({ text: "Use the targeted test before full suite." });
    assert.match((await engine.search("targeted test"))[0].text, /targeted test/);
    await engine.endSession(session.conversation.sessionId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coding session accepts storage and policy adapters without a prebuilt engine", async () => {
  const storage = createInMemoryMemoryStorage();
  const coding = createCodingAgent({
    id: "coding-memory-adapters",
    model: "anthropic/faux-1",
    memory: true,
  });
  const session = await startCodingSession(coding, {
    cave: "off",
    memory: {
      storage,
      allowStore: (text) => !text.includes("private"),
    },
  });
  const engine = session.options.memory?.engine;
  assert.equal(engine?.storage, storage);
  await assert.rejects(
    engine.remember({ text: "private application value" }),
    /cave_memory_sensitive_value_refused/,
  );
  await engine.endSession(session.conversation.sessionId);
});
