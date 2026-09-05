// Session messages carry caller-supplied structured context, and the run
// options factory sees the authenticated principal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DiskDurableStore, agent, auto } from "../dist/index.js";
import { createAgentHandler } from "../dist/serve-handler.js";
import { withMessageContext, SESSION_MESSAGE_CONTEXT_MAX_BYTES } from "../dist/serve-session.js";
import { fauxModel, scriptedStream } from "../dist/testing.js";

const TOKEN = "session-context-token-0123456789";

async function handlerFor(t, options = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-session-context-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inputs = [];
  const factoryContexts = [];
  const handler = createAgentHandler({
    definition: agent({ id: "ctx", instructions: "Answer.", model: auto(), sandbox: "fixture" }),
    store: new DiskDurableStore(dir),
    ...(options.authenticate === undefined ? { token: TOKEN } : { authenticate: options.authenticate }),
    runOptions: (context) => {
      factoryContexts.push(context);
      return {
        ensureRuntime: false,
        model: fauxModel(),
        streamFn: (selected, runContext) => {
          const user = runContext.messages.findLast((message) => message.role === "user");
          inputs.push(user.content.map((part) => part.text ?? "").join(""));
          return scriptedStream([{ text: "ok" }])(selected, runContext);
        },
      };
    },
  });
  t.after(() => handler.close(1_000));
  return { handler, inputs, factoryContexts };
}

function request(path, init = {}, headers = {}) {
  return new Request(`https://agent.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
  });
}

async function settled(handler) {
  for (let i = 0; i < 200; i++) {
    const ready = await (await handler.fetch(request("/readyz"))).json();
    if (ready.active === 0 && ready.queued === 0) return;
    await new Promise((wake) => setTimeout(wake, 25));
  }
  throw new Error("run did not settle");
}

test("withMessageContext folds bounded JSON into the message and refuses the rest", () => {
  assert.equal(withMessageContext("hi", undefined), "hi");
  assert.equal(
    withMessageContext("hi", { traceId: "t1", window: { from: "a", to: "b" } }),
    'hi\n\n<cave-message-context>\n{"traceId":"t1","window":{"from":"a","to":"b"}}\n</cave-message-context>',
  );
  assert.throws(() => withMessageContext("hi", "string"), /cave_session_message_context_invalid/);
  assert.throws(() => withMessageContext("hi", null), /cave_session_message_context_invalid/);
  assert.throws(
    () => withMessageContext("hi", { big: "x".repeat(SESSION_MESSAGE_CONTEXT_MAX_BYTES) }),
    /cave_session_message_context_too_large/,
  );
});

test("a session message's context reaches the model inside the user message", async (t) => {
  const { handler, inputs } = await handlerFor(t);
  assert.equal((await handler.fetch(request("/sessions", { method: "POST", body: JSON.stringify({ sessionId: "s1" }) }))).status, 201);
  const sent = await handler.fetch(request("/sessions/s1/messages", {
    method: "POST",
    body: JSON.stringify({ text: "Did my agent get worse?", context: { resource: "trace", id: "tr_1" } }),
  }));
  assert.equal(sent.status, 202);
  await settled(handler);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0], /^Did my agent get worse\?\n\n<cave-message-context>\n\{"resource":"trace","id":"tr_1"\}\n<\/cave-message-context>$/);
  const bad = await handler.fetch(request("/sessions/s1/messages", {
    method: "POST",
    body: JSON.stringify({ text: "x", context: 42 }),
  }));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "cave_session_message_context_invalid" });
});

test("POST /runs accepts the same context", async (t) => {
  const { handler, inputs } = await handlerFor(t);
  const response = await handler.fetch(request("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "bugbot-1", input: "investigate", context: { pr: 42 } }),
  }));
  assert.equal(response.status, 202);
  await settled(handler);
  assert.equal(inputs[0], 'investigate\n\n<cave-message-context>\n{"pr":42}\n</cave-message-context>');
});

test("the run options factory receives the authenticated principal", async (t) => {
  const { handler, factoryContexts } = await handlerFor(t, {
    authenticate: (request) => {
      const who = request.headers.get("x-who");
      return who === null ? undefined : { id: who, tenant: "acme" };
    },
  });
  const who = { "x-who": "julia" };
  assert.equal((await handler.fetch(request("/sessions", { method: "POST", body: JSON.stringify({ sessionId: "p1" }) }, who))).status, 201);
  const sent = await handler.fetch(request("/sessions/p1/messages", { method: "POST", body: JSON.stringify({ text: "hello" }) }, who));
  assert.equal(sent.status, 202);
  await settled(handler);
  assert.equal(factoryContexts.length, 1);
  assert.deepEqual(factoryContexts[0].principal, { id: "julia", tenant: "acme" });
  assert.equal(factoryContexts[0].runId.endsWith(".1"), true);
});
