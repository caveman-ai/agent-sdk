import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DiskDurableStore, agent, auto } from "../dist/index.js";
import { createAgentServer } from "../dist/serve.js";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// The 60s recovery sweep used to load every journal in the store on every pass,
// so a deployment's recurring cost grew with everything it had ever run rather
// than with what was still in flight.

const TOKEN = "test-token-0123456789";

function fauxModel() {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return { ...handle.getModel(), contextWindow: 200_000, maxTokens: 4_000 };
}

function usage() {
  return {
    input: 100, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 110,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushMessage(selected, content, stopReason, used) {
  const messageStream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: used,
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    messageStream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    messageStream.push({ type: "done", reason: stopReason, message });
    messageStream.end(message);
  });
  return messageStream;
}

/** Wraps a store so the test can count what a sweep actually reads. */
function countingStore(inner) {
  const loads = [];
  return {
    loads,
    store: {
      load: (runId) => { loads.push(runId); return inner.load(runId); },
      append: (runId, data) => inner.append(runId, data),
      acquire: (runId) => inner.acquire(runId),
      close: (runId) => inner.close(runId),
      list: () => inner.list(),
    },
  };
}

test("a settled run is not re-read by every later sweep", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-sweep-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const counting = countingStore(new DiskDurableStore(dir));

  const server = createAgentServer({
    definition: agent({
      id: "sweep",
      instructions: "Answer briefly.",
      model: auto(),
      sandbox: "fixture",
    }),
    token: TOKEN,
    store: counting.store,
    rootDir: dir,
    runOptions: {
      ensureRuntime: false,
      model: fauxModel(),
      streamFn: (selected) =>
        pushMessage(selected, [{ type: "text", text: "done" }], "stop", usage()),
    },
  });
  const port = await server.listen(0, "127.0.0.1");
  t.after(() => server.close(1_000));
  const call = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });

  await call("/runs", {
    method: "POST",
    body: JSON.stringify({ runId: "settled-run", input: "hi" }),
  });
  // Wait for the journal to settle AND for the handler to drop the run from its
  // active set: until it does, the sweep skips it as already-admitted and the
  // memo is never reached.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await (await call("/runs/settled-run")).json();
    const ready = await (await call("/readyz")).json();
    if ((status.status === "completed" || status.status === "failed") && ready.active === 0) break;
    await new Promise((wake) => setTimeout(wake, 20));
  }

  // First sweep after it settles reads it once and remembers it.
  counting.loads.length = 0;
  await server.recover();
  const first = counting.loads.filter((runId) => runId === "settled-run").length;
  assert.equal(first, 1, "the first sweep after settling should read the journal once");

  counting.loads.length = 0;
  await server.recover();
  await server.recover();

  assert.deepEqual(
    counting.loads.filter((runId) => runId === "settled-run"),
    [],
    "a settled journal was re-read by a later sweep",
  );
});

test("the sweep still reports a store it cannot enumerate", async (t) => {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-sweep-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const inner = new DiskDurableStore(dir);
  const server = createAgentServer({
    definition: agent({ id: "sweep2", instructions: "x", model: auto(), sandbox: "fixture" }),
    token: TOKEN,
    // No `list`: an unenumerable store reports that rather than an empty sweep.
    store: {
      load: (runId) => inner.load(runId),
      append: (runId, data) => inner.append(runId, data),
      acquire: (runId) => inner.acquire(runId),
      close: (runId) => inner.close(runId),
    },
    rootDir: dir,
    singleInstance: false,
    runOptions: { ensureRuntime: false, model: fauxModel() },
  });
  await server.listen(0, "127.0.0.1");
  t.after(() => server.close(1_000));
  assert.equal((await server.recover()).listable, false);
});
