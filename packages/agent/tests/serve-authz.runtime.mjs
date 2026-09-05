import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DiskDurableStore, agent, auto } from "../dist/index.js";
import { createAgentHandler } from "../dist/serve-handler.js";
import { createAgentServer } from "../dist/serve.js";

// Multi-principal isolation. A single bearer token is one tenant by definition;
// authenticate() hands identity to the host and makes the SDK responsible for
// keeping one principal's sessions out of another's reach.

function definition(id) {
  return agent({ id, instructions: "Remember every user message.", model: auto(), sandbox: "fixture" });
}

async function scratchStore(t) {
  const dir = await mkdtemp(resolve(tmpdir(), "cave-authz-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, store: new DiskDurableStore(dir) };
}

// The principal is whatever the host says it is; a header keeps the test about
// isolation rather than about JWT parsing.
function principalFromHeader(request) {
  const id = request.headers.get("x-principal");
  return id === null || id === "" ? undefined : { id, tenant: `tenant-${id}` };
}

async function handlerFor(t, extra = {}) {
  const { dir, store } = await scratchStore(t);
  return createAgentHandler({
    definition: definition("authz"),
    store,
    rootDir: dir,
    runOptions: () => ({ ensureRuntime: false }),
    ...extra,
  });
}

function as(principal, path, init = {}) {
  return new Request(`https://agent.test${path}`, {
    ...init,
    headers: {
      ...(principal === undefined ? {} : { "x-principal": principal }),
      ...init.headers,
    },
  });
}

test("authenticate() replaces the token requirement at construction", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  assert.equal(typeof handler.fetch, "function");
});

test("a server with neither token nor authenticate still refuses to start", async (t) => {
  const { dir, store } = await scratchStore(t);
  assert.throws(
    () => createAgentHandler({ definition: definition("authz"), store, rootDir: dir }),
    /cave_serve_token_required/,
  );
});

test("a request with no principal is unauthorized", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  const response = await handler.fetch(as(undefined, "/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "s1" }),
  }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "cave_serve_unauthorized");
});

test("an authenticate() that throws fails closed rather than open", async (t) => {
  // A verifier that cannot reach its JWKS must not become an open door.
  const handler = await handlerFor(t, {
    authenticate: () => { throw new Error("jwks unreachable"); },
  });
  const response = await handler.fetch(as("anyone", "/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "s1" }),
  }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "cave_serve_unauthorized");
});

test("an authenticate() returning a blank id is unauthorized", async (t) => {
  const handler = await handlerFor(t, { authenticate: () => ({ id: "" }) });
  const response = await handler.fetch(as("x", "/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "s1" }),
  }));
  assert.equal(response.status, 401);
});

test("two principals hold the same session id without seeing each other", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  const create = (who) => handler.fetch(as(who, "/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "shared-name" }),
  }));
  assert.equal((await create("alice")).status, 201);
  assert.equal((await create("bob")).status, 201);

  // Each principal sees its own session under the id it chose, and the tag it
  // was stored under never leaks back into the response.
  for (const who of ["alice", "bob"]) {
    const status = await handler.fetch(as(who, "/sessions/shared-name"));
    assert.equal(status.status, 200);
    assert.equal((await status.json()).sessionId, "shared-name");
  }
});

test("a principal cannot reach a session it did not create", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  assert.equal((await handler.fetch(as("alice", "/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "alice-only" }),
  }))).status, 201);

  // Absent rather than forbidden: whether alice happens to hold this id is not
  // bob's to learn from a status code.
  for (const [method, path] of [
    ["GET", "/sessions/alice-only"],
    ["DELETE", "/sessions/alice-only"],
    ["GET", "/sessions/alice-only/events"],
  ]) {
    const response = await handler.fetch(as("bob", path, { method }));
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  const message = await handler.fetch(as("bob", "/sessions/alice-only/messages", {
    method: "POST",
    body: JSON.stringify({ text: "let me in" }),
  }));
  assert.equal(message.status, 404);
});

test("deleting one principal's session leaves the other principal's intact", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  for (const who of ["alice", "bob"]) {
    await handler.fetch(as(who, "/sessions", {
      method: "POST",
      body: JSON.stringify({ sessionId: "shared-name" }),
    }));
  }
  assert.equal((await handler.fetch(as("alice", "/sessions/shared-name", { method: "DELETE" }))).status, 202);
  assert.equal((await handler.fetch(as("alice", "/sessions/shared-name"))).status, 404);
  assert.equal((await handler.fetch(as("bob", "/sessions/shared-name"))).status, 200);
});

test("the unscoped /runs surface closes when authenticate() is configured", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  // /runs addresses journals by raw run id with nothing binding a run to a
  // principal, so it would hand any principal every other principal's runs.
  for (const [method, path] of [
    ["POST", "/runs"],
    ["GET", "/runs/some-run"],
    ["DELETE", "/runs/some-run"],
    ["GET", "/runs/some-run/events"],
  ]) {
    const response = await handler.fetch(as("alice", path, {
      method,
      ...(method === "POST" ? { body: JSON.stringify({ runId: "r1", input: "hi" }) } : {}),
    }));
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal((await response.json()).error, "cave_serve_runs_require_single_principal");
  }
});

test("principal isolation survives a restart", async (t) => {
  // The whole reason ownership is structural rather than a side record: after a
  // restart the server rebuilds sessions from run ids alone, so isolation has to
  // fall out of the id it stored, not out of anything held in memory.
  const { dir, store } = await scratchStore(t);
  const build = () => createAgentHandler({
    definition: definition("authz"),
    store,
    rootDir: dir,
    runOptions: () => ({ ensureRuntime: false }),
    authenticate: principalFromHeader,
  });

  const first = build();
  assert.equal((await first.fetch(as("alice", "/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "survivor" }),
  }))).status, 201);
  await first.fetch(as("alice", "/sessions/survivor/messages", {
    method: "POST",
    body: JSON.stringify({ text: "remember me" }),
  }));
  await first.close(1_000);

  const second = build();
  t.after(() => second.close(1_000));
  await second.recover();
  assert.equal((await second.fetch(as("bob", "/sessions/survivor"))).status, 404);
  const alice = await second.fetch(as("alice", "/sessions/survivor"));
  assert.equal([200, 409].includes(alice.status), true, `alice lost her session: ${alice.status}`);
});

test("health and readiness stay open, as unauthenticated probes must", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  assert.equal((await handler.fetch(as(undefined, "/healthz"))).status, 200);
  assert.equal([200, 503].includes((await handler.fetch(as(undefined, "/readyz"))).status), true);
});

test("a session id that overflows the id budget under its tag fails as a 400", async (t) => {
  const handler = await handlerFor(t, { authenticate: principalFromHeader });
  const response = await handler.fetch(as("alice", "/sessions", {
    method: "POST",
    body: JSON.stringify({ sessionId: "s".repeat(126) }),
  }));
  assert.equal(response.status, 400);
});

// --- single-instance guard -------------------------------------------------

test("a second instance against one store refuses to start", async (t) => {
  const { dir, store } = await scratchStore(t);
  const build = () => createAgentServer({
    definition: definition("authz"),
    token: "test-token-0123456789",
    store,
    rootDir: dir,
    runOptions: { ensureRuntime: false },
  });
  const first = build();
  await first.listen(0, "127.0.0.1");
  const second = build();
  // Session state is per-process, so two live instances would drive one session
  // blind to each other. That is a startup refusal, not a runtime surprise.
  await assert.rejects(
    () => second.listen(0, "127.0.0.1"),
    /cave_serve_instance_already_active/,
  );
  await first.close(1_000);
  await second.close(1_000);
});

test("the instance lease is handed on after the holder closes", async (t) => {
  const { dir, store } = await scratchStore(t);
  const build = () => createAgentServer({
    definition: definition("authz"),
    token: "test-token-0123456789",
    store,
    rootDir: dir,
    runOptions: { ensureRuntime: false },
  });
  const first = build();
  await first.listen(0, "127.0.0.1");
  await first.close(1_000);
  const second = build();
  assert.equal(typeof await second.listen(0, "127.0.0.1"), "number");
  await second.close(1_000);
});

test("singleInstance: false is available for deployments that do not share sessions",
  async (t) => {
    const { dir, store } = await scratchStore(t);
    const build = () => createAgentServer({
      definition: definition("authz"),
      token: "test-token-0123456789",
      store,
      rootDir: dir,
      singleInstance: false,
      runOptions: { ensureRuntime: false },
    });
    const first = build();
    const second = build();
    await first.listen(0, "127.0.0.1");
    assert.equal(typeof await second.listen(0, "127.0.0.1"), "number");
    await first.close(1_000);
    await second.close(1_000);
  });

test("the instance lease is never reported as a run", async (t) => {
  const { dir, store } = await scratchStore(t);
  const server = createAgentServer({
    definition: definition("authz"),
    token: "test-token-0123456789",
    store,
    rootDir: dir,
    runOptions: { ensureRuntime: false },
  });
  await server.listen(0, "127.0.0.1");
  t.after(() => server.close(1_000));
  // It is a lock, not a journal: a sweep must not surface it as a corrupt run.
  const report = await server.recover();
  assert.equal(report.listable, true);
  assert.equal(report.skipped.some((entry) => entry.runId.includes("instance")), false);
  assert.equal(report.resumed.length, 0);
});
