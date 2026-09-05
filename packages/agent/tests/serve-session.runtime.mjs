import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DiskDurableStore,
  agent,
  auto,
} from "../dist/index.js";
import { createAgentHandler } from "../dist/serve-handler.js";
import { createAgentServer } from "../dist/serve.js";
import { AgentSessions } from "../dist/serve-session.js";
import { agentDefinitionSHA256 } from "../dist/build.js";
import { durableConversationCheckpoint } from "../dist/durable.js";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import WebSocket from "ws";

const TOKEN = "test-token-0123456789";
const execFileAsync = promisify(execFile);
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

function fauxModel() {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return { ...handle.getModel(), contextWindow: 200_000, maxTokens: 4_000 };
}

function usage() {
  return {
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushMessage(selected, text, wait) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: usage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  void Promise.resolve(wait).then(() => {
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function definition(id) {
  return agent({ id, instructions: "Remember every user message.", model: auto(), sandbox: "fixture" });
}

function startedLine(runId, selected, checkpoint, input = "pending") {
  return JSON.stringify({
    v: 2,
    at: new Date().toISOString(),
    type: "run_started",
    runId,
    agentId: selected.id,
    definitionSha256: agentDefinitionSHA256(selected),
    input,
    sessionId: checkpoint.sessionId,
    denomination: "none",
    budgetSha256: "none",
    conversation: checkpoint,
    pid: process.pid,
  });
}

async function scratchStore() {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-session-"));
  return { dir, store: new DiskDurableStore(dir) };
}

function request(path, init = {}) {
  return new Request(`https://agent.test${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

async function call(handler, path, init) {
  return handler.fetch(request(path, init));
}

async function createSession(handler, sessionId) {
  const response = await call(handler, "/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { sessionId });
}

async function send(handler, sessionId, text, options = {}) {
  const response = await call(handler, `/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...options }),
  });
  return { response, body: await response.json() };
}

async function sessionStatus(handler, sessionId) {
  const response = await call(handler, `/sessions/${sessionId}`);
  return { response, body: await response.json() };
}

async function idle(handler, sessionId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await sessionStatus(handler, sessionId);
    if (status.response.ok && status.body.active === undefined) return status.body;
    await new Promise((wake) => setTimeout(wake, 10));
  }
  throw new Error(`session ${sessionId} did not become idle`);
}

function makeHandler({ definition: selected, store, dir, streamFn }) {
  return createAgentHandler({
    definition: selected,
    token: TOKEN,
    store,
    rootDir: dir,
    runOptions: () => ({ ensureRuntime: false, model: fauxModel(), streamFn }),
  });
}

async function readTurns(response, turns) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events = [];
  while (events.filter((event) => event.kind === "turn.end").length < turns) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      if (frame.startsWith(":")) continue;
      if (/^event: gap$/mu.test(frame)) throw new Error("unexpected SSE gap");
      const data = /^data: (.+)$/mu.exec(frame)?.[1];
      if (data !== undefined) events.push(JSON.parse(data));
    }
  }
  await reader.cancel();
  return events;
}

test("two session clients receive two consecutive runs", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const contexts = [];
  const handler = makeHandler({
    definition: definition("session-broadcast"),
    store,
    dir,
    streamFn: (selected, context) => {
      contexts.push(structuredClone(context.messages));
      return pushMessage(selected, `answer-${contexts.length}`);
    },
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  await createSession(handler, "shared");
  const clientOne = readTurns(await call(handler, "/sessions/shared/events"), 2);
  const clientTwo = readTurns(await call(handler, "/sessions/shared/events"), 2);

  assert.deepEqual((await send(handler, "shared", "first", { author: "ada" })).body, {
    runId: "shared.1", queued: false,
  });
  await idle(handler, "shared");
  assert.deepEqual((await send(handler, "shared", "second", { author: "lin" })).body, {
    runId: "shared.2", queued: false,
  });
  const [one, two] = await Promise.all([clientOne, clientTwo]);
  assert.deepEqual(one, two);
  assert.deepEqual(one.map((event) => event.seq), one.map((_, index) => index));
  assert.equal(one.filter((event) => event.kind === "turn.start").length, 2);
  assert.equal(one.filter((event) => event.kind === "turn.end").length, 2);
  assert.match(JSON.stringify(contexts[1]), /first/u);

  const status = (await sessionStatus(handler, "shared")).body;
  assert.deepEqual(status.runs.map((run) => run.runId), ["shared.1", "shared.2"]);
  assert.deepEqual(status.messages.map((message) => message.author), ["ada", "lin"]);
  assert.ok(one.every((event) => event.author === undefined));
});

test("active-run follow-up uses Pi queue and drains inside same run", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let release;
  const blocked = new Promise((resolveWait) => { release = resolveWait; });
  const contexts = [];
  const handler = makeHandler({
    definition: definition("session-follow-up"),
    store,
    dir,
    streamFn: (selected, context) => {
      contexts.push(structuredClone(context.messages));
      return pushMessage(selected, `call-${contexts.length}`, contexts.length === 1 ? blocked : undefined);
    },
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  await createSession(handler, "queued");
  assert.deepEqual((await send(handler, "queued", "start")).body, {
    runId: "queued.1", queued: false,
  });
  await new Promise((wake) => setTimeout(wake, 0));
  assert.deepEqual((await send(handler, "queued", "while active", { mode: "followUp" })).body, {
    runId: "queued.1", queued: true,
  });
  assert.equal((await sessionStatus(handler, "queued")).body.queued, 1);
  release();
  const done = await idle(handler, "queued");
  assert.equal(done.queued, 0);
  assert.equal(done.runs.length, 1);
  assert.equal(contexts.length, 2);
  assert.match(JSON.stringify(contexts[1]), /while active/u);
});

test("restart rehydrates checkpoint and third run sees prior messages", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const firstHandler = makeHandler({
    definition: definition("session-restart"),
    store,
    dir,
    streamFn: (selected) => pushMessage(selected, "remembered"),
  });
  await firstHandler.recover();
  await createSession(firstHandler, "restart");
  await send(firstHandler, "restart", "one");
  await idle(firstHandler, "restart");
  await send(firstHandler, "restart", "two");
  await idle(firstHandler, "restart");
  await firstHandler.close(1_000);

  const contexts = [];
  const restarted = makeHandler({
    definition: definition("session-restart"),
    store,
    dir,
    streamFn: (selected, context) => {
      contexts.push(structuredClone(context.messages));
      return pushMessage(selected, "third answer");
    },
  });
  t.after(() => restarted.close(1_000));
  await restarted.recover();
  assert.deepEqual((await send(restarted, "restart", "three")).body, {
    runId: "restart.3", queued: false,
  });
  await idle(restarted, "restart");
  assert.match(JSON.stringify(contexts[0]), /one/u);
  assert.match(JSON.stringify(contexts[0]), /two/u);
  assert.match(JSON.stringify(contexts[0]), /three/u);
});

test("pending session-shaped journal without checkpoint is reported, not claimed", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await store.append("broken.1", `${JSON.stringify({
    v: 2,
    at: new Date().toISOString(),
    type: "run_started",
    runId: "broken.1",
    agentId: "session-broken",
    definitionSha256: "a".repeat(64),
    input: "lost",
    sessionId: "broken",
    denomination: "none",
    budgetSha256: "none",
    pid: process.pid,
  })}\n`);
  const handler = makeHandler({
    definition: definition("session-broken"),
    store,
    dir,
    streamFn: () => { throw new Error("must not spend"); },
  });
  t.after(() => handler.close(1_000));
  const report = await handler.recover();
  assert.deepEqual(report.resumed, []);
  assert.deepEqual(report.skipped, [{
    runId: "broken.1", reason: "cave_session_conversation_unrecoverable",
  }]);
  const status = await sessionStatus(handler, "broken");
  assert.equal(status.response.status, 404);
  assert.deepEqual(status.body, { error: "cave_serve_not_found" });
  const message = await send(handler, "broken", "must fail");
  assert.equal(message.response.status, 404);
  assert.equal(message.body.error, "cave_serve_not_found");
});

test("post-terminal message starts a new run before journal cleanup awaits", async (t) => {
  const { dir, store: disk } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  let handler;
  let injected = false;
  const store = {
    load: async (runId) => {
      const lines = await disk.load(runId);
      if (runId === "terminal-window.1" && !injected &&
          lines.some((line) => JSON.parse(line).type === "run_completed")) {
        injected = true;
        const posted = await send(handler, "terminal-window", "after terminal");
        assert.equal(posted.response.status, 202);
        assert.deepEqual(posted.body, { runId: "terminal-window.2", queued: false });
      }
      return lines;
    },
    append: (runId, data) => disk.append(runId, data),
    acquire: (runId) => disk.acquire(runId),
    close: (runId) => disk.close(runId),
    list: () => disk.list(),
  };
  handler = makeHandler({
    definition: definition("terminal-window"), store, dir,
    streamFn: (selected) => pushMessage(selected, "done"),
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  await createSession(handler, "terminal-window");
  const turns = readTurns(await call(handler, "/sessions/terminal-window/events"), 2);
  await send(handler, "terminal-window", "first");
  const events = await turns;
  const status = await idle(handler, "terminal-window");
  assert.equal(injected, true);
  assert.equal(events.filter((event) => event.kind === "turn.start").length, 2);
  assert.equal(events.filter((event) => event.kind === "turn.end").length, 2);
  assert.equal(status.queued, 0);
});

test("failed last session run restarts from its base checkpoint", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const selected = definition("failed-restart");
  const first = makeHandler({
    definition: selected, store, dir,
    streamFn: (model) => pushMessage(model, "remembered"),
  });
  await first.recover();
  await createSession(first, "failed-restart");
  await send(first, "failed-restart", "one");
  await idle(first, "failed-restart");
  await first.close(1_000);
  const completed = (await store.load("failed-restart.1"))
    .map((line) => JSON.parse(line))
    .find((event) => event.type === "run_completed");
  assert.ok(completed?.conversation);
  await store.append("failed-restart.2", `${startedLine(
    "failed-restart.2", selected, completed.conversation, "fails",
  )}\n${JSON.stringify({
    v: 2, at: new Date().toISOString(), type: "run_failed",
    code: "fixture_failure", message: "failed", receipt: null,
  })}\n`);

  const contexts = [];
  const restarted = makeHandler({
    definition: selected, store, dir,
    streamFn: (model, context) => {
      contexts.push(structuredClone(context.messages));
      return pushMessage(model, "recovered");
    },
  });
  t.after(() => restarted.close(1_000));
  await restarted.recover();
  assert.deepEqual((await send(restarted, "failed-restart", "three")).body, {
    runId: "failed-restart.3", queued: false,
  });
  await idle(restarted, "failed-restart");
  assert.match(JSON.stringify(contexts[0]), /one/u);
  assert.match(JSON.stringify(contexts[0]), /three/u);
});

test("session namespace adopts checkpoints, skips squatters, and reserves numeric suffixes", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const selected = definition("namespace");
  const legacy = {
    v: 2, at: new Date().toISOString(), type: "run_started", runId: "sq.1",
    agentId: selected.id, definitionSha256: agentDefinitionSHA256(selected), input: "legacy",
    sessionId: "sq", denomination: "none", budgetSha256: "none", pid: process.pid,
  };
  await store.append("sq.1", `${JSON.stringify(legacy)}\n`);
  const wrongCheckpoint = durableConversationCheckpoint("other", []);
  await store.append("wrong.1", `${JSON.stringify({
    ...JSON.parse(startedLine("wrong.1", selected, wrongCheckpoint)), sessionId: "wrong",
  })}\n`);
  const handler = makeHandler({
    definition: selected, store, dir,
    streamFn: (model) => pushMessage(model, "ok"),
  });
  t.after(() => handler.close(1_000));
  const recovery = await handler.recover();
  assert.ok(recovery.skipped.some((entry) => entry.runId === "sq.1" &&
    entry.reason === "cave_session_conversation_unrecoverable"));
  await createSession(handler, "sq");
  assert.deepEqual((await send(handler, "sq", "hello")).body, { runId: "sq.2", queued: false });
  await idle(handler, "sq");
  await createSession(handler, "wrong");
  assert.deepEqual((await send(handler, "wrong", "hello")).body, {
    runId: "wrong.2", queued: false,
  });
  await idle(handler, "wrong");
  const reserved = await call(handler, "/runs", {
    method: "POST", body: JSON.stringify({ runId: "caller.9", input: "no" }),
  });
  assert.equal(reserved.status, 400);
  assert.deepEqual(await reserved.json(), { error: "cave_serve_run_id_reserved" });
});

test("shared journal lock admits one session owner and rejects the other", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const selected = definition("single-writer");
  const checkpoint = durableConversationCheckpoint("single-writer", []);
  await store.append("single-writer.1", `${startedLine(
    "single-writer.1", selected, checkpoint,
  )}\n`);
  let release;
  const blocked = new Promise((resolveWait) => { release = resolveWait; });
  const owner = makeHandler({
    definition: selected, store, dir,
    streamFn: (model) => pushMessage(model, "owner", blocked),
  });
  const loser = makeHandler({
    definition: selected, store, dir,
    streamFn: () => { throw new Error("loser must not spend"); },
  });
  t.after(() => Promise.all([owner.close(1_000), loser.close(1_000)]));
  const ownerReport = await owner.recover();
  assert.deepEqual(ownerReport.resumed, ["single-writer.1"]);
  const loserReport = await loser.recover();
  assert.deepEqual(loserReport.resumed, []);
  assert.ok(loserReport.skipped.some((entry) => entry.runId === "single-writer.1" &&
    entry.reason === "cave_durable_run_locked"));
  const status = await sessionStatus(loser, "single-writer");
  assert.equal(status.response.status, 200);
  assert.equal(status.body.active, undefined);
  const rejected = await send(loser, "single-writer", "do not fork");
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error, "cave_session_busy_elsewhere");
  release();
  await idle(owner, "single-writer");
});

test("session recovery shares journal loads with legacy sweep", async (t) => {
  const selected = definition("load-once");
  const checkpoint = durableConversationCheckpoint("load-once", []);
  const failed = JSON.stringify({
    v: 2, at: new Date().toISOString(), type: "run_failed",
    code: "fixture", message: "done", receipt: null,
  });
  const journals = new Map([
    ["load-once.1", [startedLine("load-once.1", selected, checkpoint), failed]],
    ["legacy", [JSON.stringify({
      v: 2, at: new Date().toISOString(), type: "run_started", runId: "legacy",
      agentId: selected.id, definitionSha256: "a".repeat(64), input: "x",
      sessionId: "legacy", denomination: "none", budgetSha256: "none", pid: process.pid,
    }), failed]],
  ]);
  const loads = new Map();
  const store = {
    list: async () => [...journals.keys()],
    load: async (runId) => {
      loads.set(runId, (loads.get(runId) ?? 0) + 1);
      return journals.get(runId) ?? [];
    },
    append: async () => {}, acquire: async () => async () => {}, close: async () => {},
  };
  const handler = makeHandler({
    definition: selected, store, dir: ".",
    streamFn: () => { throw new Error("must not run"); },
  });
  t.after(() => handler.close(0));
  await handler.recover();
  assert.deepEqual(Object.fromEntries(loads), { "load-once.1": 1, legacy: 1 });
});

test("fetch handler serves sessions without importing node:http", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const handler = makeHandler({
    definition: definition("session-fetch"),
    store,
    dir,
    streamFn: (selected) => pushMessage(selected, "ok"),
  });
  t.after(() => handler.close(1_000));
  await handler.recover();
  await createSession(handler, "fetch-only");
  assert.equal((await sessionStatus(handler, "fetch-only")).response.status, 200);

  const moduleUrl = pathToFileURL(resolve(DIST, "serve-handler.js")).href;
  const script = `
    const { createAgentHandler } = await import(${JSON.stringify(moduleUrl)});
    const journals = new Map();
    const store = {
      load: async (id) => journals.get(id) ?? [],
      append: async (id, data) => journals.set(id, [...(journals.get(id) ?? []), data]),
      acquire: async () => async () => {}, close: async () => {}, list: async () => [...journals.keys()],
    };
    const handler = createAgentHandler({
      definition: { id: "fetch-child", instructions: "unused", model: "auto", tools: [] },
      token: ${JSON.stringify(TOKEN)}, store,
    });
    const headers = { authorization: "Bearer ${TOKEN}", "content-type": "application/json" };
    const created = await handler.fetch(new Request("https://agent.test/sessions", {
      method: "POST", headers, body: JSON.stringify({ sessionId: "plain" }),
    }));
    const status = await handler.fetch(new Request("https://agent.test/sessions/plain", { headers }));
    if (created.status !== 201 || status.status !== 200) process.exit(2);
    if (process.moduleLoadList.includes("NativeModule node:http")) process.exit(3);
    await handler.close(0);
  `;
  const child = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
  assert.equal(child.stderr, "");
});

test("Node WebSocket session path is bidirectional", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createAgentServer({
    definition: definition("session-websocket"),
    token: TOKEN,
    store,
    rootDir: dir,
    runOptions: () => ({
      ensureRuntime: false,
      model: fauxModel(),
      streamFn: (selected) => pushMessage(selected, "over ws"),
    }),
  });
  t.after(() => server.close(1_000));
  const port = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "socket" }),
  });
  assert.equal(created.status, 201);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/sessions/socket/ws`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  t.after(() => socket.close());
  const events = [];
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  const ended = new Promise((resolveEnd, rejectEnd) => {
    socket.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString("utf8"));
        events.push(event);
        if (event.kind === "turn.end") resolveEnd();
      } catch (error) { rejectEnd(error); }
    });
    socket.once("error", rejectEnd);
  });
  socket.send(JSON.stringify({ type: "message", text: "hello", author: "ws-user" }));
  await ended;
  assert.equal(events[0].kind, "turn.start");
  assert.equal(events.at(-1).kind, "turn.end");
  // The faux stream pushes one whole message, so no delta frames exist on any
  // transport; the proof of bidirectionality is that the message sent over the
  // socket started a run and was attributed.
  const status = await fetch(`${base}/sessions/socket`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.messages[0].author, "ws-user");
  assert.equal(body.messages[0].text, "hello");
});

test("Node upgrade fails closed when optional ws import is unavailable", async () => {
  const moduleUrl = pathToFileURL(resolve(DIST, "serve.js")).href;
  const script = `
    import { mock } from "node:test";
    mock.module("ws", { namedExports: {} });
    const { createAgentServer } = await import(${JSON.stringify(moduleUrl)});
    const started = JSON.stringify({
      v: 2, at: new Date().toISOString(), type: "run_started", runId: "missing.1",
      agentId: "ws-missing", definitionSha256: "a".repeat(64), input: "pending",
      sessionId: "missing", denomination: "none", budgetSha256: "none", pid: process.pid,
      conversation: {
        sessionId: "missing",
        messagesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        messages: [],
      },
    });
    const store = {
      load: async (id) => id === "missing.1" ? [started] : [],
      append: async () => {}, acquire: async () => async () => {}, close: async () => {},
      list: async () => ["missing.1"],
    };
    const server = createAgentServer({
      definition: { id: "ws-missing", instructions: "unused", model: "auto", tools: [] },
      token: ${JSON.stringify(TOKEN)}, store,
    });
    let output = "";
    let done;
    const ended = new Promise((resolve) => { done = resolve; });
    const socket = {
      end(value) { output += value; done(); },
      destroy() { done(); },
    };
    server.server.emit("upgrade", {
      headers: { host: "agent.test", authorization: "Bearer ${TOKEN}", upgrade: "websocket" },
      method: "GET", url: "/sessions/missing/ws",
    }, socket, Buffer.alloc(0));
    await ended;
    if (!output.includes("501") || !output.includes("cave_serve_websocket_unavailable")) process.exit(4);
    await server.close(0);
  `;
  await execFileAsync(process.execPath, [
    "--experimental-test-module-mocks",
    "--input-type=module",
    "--eval",
    script,
  ]);
});

test("Node flushes SSE response headers before the first event", async (t) => {
  // Node buffers the head until the first body write; without an explicit
  // flush a fetch() client attached to an idle session saw nothing until the
  // 15s keepalive, so its headers promise stalled that long.
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createAgentServer({
    definition: definition("sse-flush"), token: TOKEN, store, rootDir: dir,
    runOptions: { ensureRuntime: false, model: fauxModel() },
  });
  t.after(() => server.close(1_000));
  const port = await server.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  await fetch(`${base}/sessions`, { method: "POST", headers, body: JSON.stringify({ sessionId: "idle" }) });
  const response = await fetch(`${base}/sessions/idle/events`, {
    headers,
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  await response.body.cancel();
});

test("Node rejects upgrades outside the session WebSocket path without reading SSE", async (t) => {
  const { dir, store } = await scratchStore();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = createAgentServer({
    definition: definition("upgrade-route"), token: TOKEN, store, rootDir: dir,
    runOptions: { ensureRuntime: false, model: fauxModel() },
  });
  t.after(() => server.close(1_000));
  const port = await server.listen(0, "127.0.0.1");
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    let raw = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("upgrade response timed out")));
    socket.on("connect", () => socket.write([
      "GET /sessions/nope/events HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Authorization: Bearer ${TOKEN}`,
      "",
      "",
    ].join("\r\n")));
    socket.on("data", (chunk) => { raw += chunk.toString("utf8"); });
    socket.on("end", () => resolveResponse(raw));
    socket.on("error", rejectResponse);
  });
  assert.match(response, /^HTTP\/1\.1 426 Upgrade Required/mu);
  assert.match(response, /cave_serve_upgrade_required/u);
});

test("session state caps messages and evicts retained idle sessions", async () => {
  const store = {
    load: async () => [], append: async () => {}, acquire: async () => async () => {},
    close: async () => {}, list: async () => [],
  };
  const driver = {
    start(run) { run.onAdmitted(); },
    cancel: async () => {},
    summary: async (runId) => ({ status: "missing", runId }),
  };
  const sessions = new AgentSessions(store, driver, 1024 * 1024);
  const route = (path, method = "GET", body) => sessions.route(new Request(`https://agent.test${path}`, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  }), path);
  await route("/sessions", "POST", { sessionId: "bounded" });
  for (let index = 0; index < 260; index++) {
    const response = await route("/sessions/bounded/messages", "POST", { text: `m-${index}` });
    assert.equal(response.status, 202);
  }
  const bounded = await route("/sessions/bounded");
  assert.equal((await bounded.json()).messages.length, 256);

  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    for (let index = 0; index < 1024; index++) {
      await route("/sessions", "POST", { sessionId: `idle-${index}` });
    }
    now += 5 * 60_000 + 1;
    await route("/sessions", "POST", { sessionId: "idle-new" });
    const evicted = await route("/sessions/idle-0");
    assert.equal(evicted.status, 404);
  } finally {
    Date.now = realNow;
    sessions.close();
  }
});

test("WebSocketLike declaration uses a shaped listener event", async () => {
  const declaration = await readFile(resolve(DIST, "serve-handler.d.ts"), "utf8");
  assert.doesNotMatch(declaration, /addEventListener\([^;]+event: any/su);
  assert.match(declaration, /fn: \(event: \{\s*data\?: unknown;\s*\}\) => void/su);
});

test("undeclared sandbox announces host execution at handler construction", async () => {
  const moduleUrl = pathToFileURL(resolve(DIST, "serve-handler.js")).href;
  const script = `
    const { createAgentHandler } = await import(${JSON.stringify(moduleUrl)});
    const store = {
      load: async () => [], append: async () => {}, acquire: async () => async () => {},
      close: async () => {}, list: async () => [],
    };
    const handler = createAgentHandler({
      definition: {
        kind: "agent", id: "host-warning", instructions: "x", model: "auto",
        reasoning: "low", tools: [], contexts: [], sandbox: "required", sandboxDeclared: false,
      },
      token: ${JSON.stringify(TOKEN)}, store, runOptions: () => ({ entryPath: "agent.ts" }),
    });
    await handler.close(0);
  `;
  const child = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "cave: host-warning serves with host execution — tools are not isolated\n");
});

test("serving guide documents ownership, deletion, reserved ids, and valid run options", async () => {
  const guide = await readFile(resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../caveman-docs/guides/11-serving-and-hosting.md",
  ), "utf8");
  assert.match(guide, /process-local/u);
  assert.match(guide, /cave_session_busy_elsewhere/u);
  assert.match(guide, /reserved for session journals/u);
  assert.match(guide, /executionBackend.*createCodingAgent/u);
  assert.doesNotMatch(guide, /runOptions:[\s\S]{0,160}executionBackend/u);
});
