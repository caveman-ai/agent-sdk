import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { run, schema, tool } from "../dist/index.js";
import { createCodingAgent } from "../dist/code.js";
import { DiskDurableStore } from "../dist/durable.js";
import {
  PROGRAMMATIC_TOOL_NAME,
  createProgrammaticToolRuntime,
  programmaticToolMetadata,
} from "../dist/programmatic-tools.js";
import {
  MAX_MCP_SERVERS_SECTION_CHARS,
  McpHost,
  createMcpToolName,
  parseMcpServers,
  renderMcpServersSection,
  validateMcpServerConfig,
} from "../dist/mcp.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/mcp-fixture-server.mjs");

function fixture(name, env = {}, extra = {}) {
  return Object.freeze({ name, source: "test", config: { command: process.execPath, args: [FIXTURE], env, ...extra } });
}

const lookup = tool({
  name: "lookup",
  description: "Read one value.",
  input: schema.object({ key: schema.string() }),
  effect: "read",
  result: "inline",
  execute: ({ key }) => `value:${key}`,
});

function codeRuntime() {
  const base = createCodingAgent({ workspace: process.cwd(), model: "openai/gpt-5.4", toolSet: "pebble-v1" });
  return createProgrammaticToolRuntime(
    Object.freeze({ ...base.definition, tools: Object.freeze([lookup]) }),
    { speculate: false },
  );
}

function attach(runtime, servers, options = {}) {
  const host = new McpHost({
    servers,
    cwd: process.cwd(),
    register: (tools, namespace) => runtime.registerNestedTools(tools, namespace),
    ...options,
  });
  runtime.setCellGate((code, signal) => host.waitForCell(code, signal));
  return host;
}

/** Local kernel stand-in: dispatches straight into the code tool's registry. */
async function cell(runtime, code) {
  const codeTool = runtime.definition.tools[0];
  const { registry } = programmaticToolMetadata(codeTool);
  return codeTool.execute({ code }, undefined, {
    toolCallId: "cell",
    parentToolCallId: "cell",
    dispatch: (name, input, options) => registry.get(name).execute(input, options?.signal),
  });
}

async function settled(host) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (host.status().every((server) => !["idle", "connecting"].includes(server.state))) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("mcp servers never settled");
}

function usage() {
  return {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function message(selected, content, stopReason) {
  const stream = createAssistantMessageEventStream();
  const value = {
    role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id,
    usage: usage(), stopReason, timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...value, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: stopReason, message: value });
    stream.end(value);
  });
  return stream;
}

/** First provider call runs `code` in the code tool; later calls answer with text. */
function scripted(code, results = []) {
  let calls = 0;
  return (selected, context) => {
    calls++;
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") {
      results.push(last.content.map((item) => item.type === "text" ? item.text : "").join(""));
    }
    return calls === 1
      ? message(selected, [{ type: "toolCall", id: "code-1", name: PROGRAMMATIC_TOOL_NAME, arguments: { code } }], "toolUse")
      : message(selected, [{ type: "text", text: "done" }], "stop");
  };
}

test("mcpServers config validates entries and rejects unsupported shapes", () => {
  const parsed = parseMcpServers({
    mcpServers: {
      files: { command: "npx", args: ["-y", "server"], env: { TOKEN: "${TOKEN}" }, description: "Files." },
      docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" }, timeout: 5 },
      "bad name": { command: "x" },
      legacy: { type: "sse", url: "https://example.com/sse" },
      both: { exposure: "direct", command: "x" },
      hidden: { command: "x", toolExposure: { delete_all: "hidden" } },
      slow: { command: "x", timeout: -1 },
      neither: {},
      insecure: { url: "https://example.com/mcp", oauth: { authServerMetadataUrl: "http://evil.example/meta" } },
      "a-b": { command: "x" },
      a_b: { command: "y" },
      off: { command: "x", disabled: true },
    },
  }, "/tmp/mcp.json");
  assert.deepEqual(parsed.servers.map((server) => server.name), ["files", "docs", "a-b", "off"]);
  assert.equal(parsed.servers[3].config.enabled, false, "Cline-style disabled: true is honored");
  assert.deepEqual(parsed.servers[0].config.env, { TOKEN: "${TOKEN}" });
  assert.equal(parsed.errors.length, 8);
  for (const fragment of [
    'invalid server name "bad name"',
    "legacy SSE transport is not supported",
    'exposure "direct" is not supported',
    "toolExposure is not supported",
    "timeout must be a positive number",
    'needs either "command" (stdio) or "url"',
    "authServerMetadataUrl must be an https URL",
    'server "a_b" conflicts with "a-b"',
  ]) {
    assert.ok(parsed.errors.some((error) => error.startsWith("/tmp/mcp.json: ") && error.includes(fragment)), fragment);
  }
  assert.equal(typeof validateMcpServerConfig("x".repeat(60), { command: "x" }), "string");
  assert.equal(typeof validateMcpServerConfig("local", {
    url: "http://127.0.0.1:9/mcp",
    oauth: { authServerMetadataUrl: "http://localhost:9/meta", clientName: "Claude Code" },
  }), "object");
  assert.deepEqual(parseMcpServers([], "x.json").errors, ['x.json: expected an object with an "mcpServers" object']);
  assert.equal(createMcpToolName("dev-radius", "get.item"), "mcp__dev_radius__get_item");
  assert.match(createMcpToolName("s", "t".repeat(80)), /^mcp__s__t+_[0-9a-f]{8}$/);
  assert.notEqual(createMcpToolName("s", "a-b", (name) => name === "mcp__s__a_b"), "mcp__s__a_b");
});

test("mcp_servers section uses config-time names only, sorted and capped", () => {
  const entries = [
    { name: "zeta", source: "t", config: { command: "x", description: "Zeta tools.\nSecond line." } },
    { name: "alpha", source: "t", config: { url: "https://a.example/mcp", description: "A".repeat(400) } },
    { name: "off", source: "t", config: { command: "x", enabled: false } },
  ];
  const section = renderMcpServersSection(entries, "pebble_code");
  assert.equal(section, renderMcpServersSection([...entries].reverse(), "pebble_code"));
  const lines = section.split("\n");
  assert.match(lines[0], /Call them inside pebble_code/);
  assert.match(section, /uncontained host process/);
  assert.equal(lines.at(-2).startsWith("- mcp__alpha: "), true);
  assert.equal(lines.at(-2).length, "- mcp__alpha: ".length + 250);
  assert.equal(lines.at(-1), "- mcp__zeta: Zeta tools.");
  assert.doesNotMatch(section, /mcp__off/);
  assert.equal(renderMcpServersSection([entries[2]], "pebble_code"), undefined);
  const many = Array.from({ length: 400 }, (_, index) => ({
    name: `server-${String(index).padStart(3, "0")}`,
    source: "t",
    config: { command: "x", description: "Does many useful things for the user." },
  }));
  const capped = renderMcpServersSection(many, "pebble_code");
  assert.ok(capped.length <= MAX_MCP_SERVERS_SECTION_CHARS);
  assert.match(capped.split("\n").at(-1), /^- … \d+ more servers; find their tools with searchTools\(\)$/);
});

test("stdio servers get only the coding allowlist plus their explicit env", async () => {
  process.env.CAVE_MCP_AMBIENT_SECRET = "must-not-pass";
  const runtime = codeRuntime();
  const contexts = [];
  const host = attach(runtime, [fixture("fx", { FIXTURE_TOKEN: "${TOKEN}", PLAIN: "literal" }, {
    args: [FIXTURE, "--flag=${TOKEN}", "!not-a-command"],
  })], {
    resolveValue: async (value, context) => {
      contexts.push([context.field, context.commands]);
      return value.replace("${TOKEN}", "resolved-token");
    },
  });
  try {
    host.start();
    const env = JSON.parse(await cell(runtime, [
      "const result = await tools.mcp__fx__env({});",
      "return result.content[0].text;",
    ].join("\n")));
    assert.equal(env.CAVE_MCP_AMBIENT_SECRET, undefined);
    assert.equal(env.FIXTURE_TOKEN, "resolved-token");
    assert.equal(env.PLAIN, "literal");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(env.FIXTURE_ARGV, "--flag=resolved-token !not-a-command");
    // Args interpolate ${VAR} but never run `!command`; env values may.
    assert.deepEqual(contexts.sort(), [["arg 1", false], ["env FIXTURE_TOKEN", true]]);
    assert.equal(host.status()[0].containment, "uncontained host process");
  } finally {
    delete process.env.CAVE_MCP_AMBIENT_SECRET;
    await host.close();
  }
  // Without a resolver, `${VAR}` fails closed instead of passing the literal through.
  const unresolved = attach(codeRuntime(), [fixture("fx", { FIXTURE_TOKEN: "${TOKEN}" })]);
  unresolved.start();
  await settled(unresolved);
  assert.equal(unresolved.status()[0].state, "failed");
  assert.match(unresolved.status()[0].error, /mcp_config_value_unresolved:fx:env FIXTURE_TOKEN/);
  await unresolved.close();
});

test("codemode exposes MCP tools only inside the code cell, with discovery", async () => {
  const runtime = codeRuntime();
  const description = runtime.definition.tools[0].description;
  const host = attach(runtime, [fixture("fx", { FIXTURE_INSTRUCTIONS: "Use echo for greetings.", FIXTURE_DELAY_MS: "150" }, {
    description: "Fixture tools.",
  })]);
  try {
    host.start();
    // The cell names the namespace, so it waits for the still-starting server.
    const found = JSON.parse(await cell(runtime, [
      'const hits = await searchTools("echo text", { namespace: "mcp__fx" });',
      'const ns = await describeNamespace("mcp__fx");',
      'const declared = await describeTool("mcp__fx__echo");',
      'const echoed = await tools.mcp__fx__echo({ text: "hi", note: null });',
      "return { first: hits[0].name, ns, declared, echoed,",
      '  listed: ALL_TOOLS.some((item) => item.name === "mcp__fx__write") };',
    ].join("\n")));
    assert.equal(found.first, "mcp__fx__echo");
    assert.equal(found.ns.description, "Fixture tools.");
    assert.equal(found.ns.instructions, "Use echo for greetings.");
    assert.ok(found.ns.tools.includes("mcp__fx__crash"));
    assert.match(found.declared, /declare function mcp__fx__echo\(args: \{ text: string; note\?: unknown \}\)/);
    assert.match(found.declared, /Promise<\{ content: Array<unknown>; structuredContent\?: unknown; isError\?: boolean \}>/);
    assert.deepEqual(found.echoed.content, [{ type: "text", text: "hi" }]);
    assert.equal(found.echoed.structuredContent.echoed, "hi");
    assert.equal(found.listed, true);
    assert.equal(runtime.definition.tools.length, 1);
    assert.equal(runtime.definition.tools[0].description, description);
    const { registry } = programmaticToolMetadata(runtime.definition.tools[0]);
    assert.equal(registry.get("mcp__fx__write").effect, "external", "missing annotations mean effectful");
    assert.equal(registry.get("mcp__fx__echo").effect, "external", "readOnlyHint never relaxes admission");
    assert.equal(registry.get("mcp__fx__echo").speculative, undefined);
    // An isError result resolves inside scripts, like Pi.
    assert.equal(await cell(runtime, "return (await tools.mcp__fx__fail({})).isError;"), "true");
    assert.equal(host.calledTools().mcp__fx__fail.isErrors, 1, "isError results count as errors for receipts");
  } finally {
    await host.close();
  }
});

test("prefix bytes stay identical across connect, failure, and late connect", async () => {
  const runtime = codeRuntime();
  const prefix = () => JSON.stringify({
    instructions: runtime.definition.instructions,
    tools: runtime.definition.tools.map((item) => ({ name: item.name, description: item.description, input: item.input })),
  });
  const before = prefix();
  const host = attach(runtime, [
    fixture("fast"),
    fixture("broken", { FIXTURE_FAIL: "nope" }),
    fixture("late", { FIXTURE_DELAY_MS: "400" }),
  ]);
  try {
    host.start();
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(prefix(), before);
    await settled(host);
    assert.deepEqual(host.status().map((server) => [server.name, server.state]), [
      ["fast", "connected"], ["broken", "failed"], ["late", "connected"],
    ]);
    assert.match(host.status()[1].error, /fixture refused to start: nope/);
    assert.equal(prefix(), before);
  } finally {
    await host.close();
  }
});

test("MCP calls dispatch through the kernel and the receipt names the tool", async () => {
  const runtime = codeRuntime();
  const host = attach(runtime, [fixture("fx")]);
  try {
    host.start();
    const results = [];
    const faux = fauxProvider();
    const result = await run(runtime.definition, "write once", {
      ensureRuntime: false,
      model: faux.getModel(),
      streamFn: scripted('print((await tools.mcp__fx__write({ value: "https://a.example" })).content[0].text);', results),
    });
    assert.equal(result.text, "done");
    assert.deepEqual(results, ["wrote https://a.example"]);
    assert.deepEqual(result.toolCalls, [PROGRAMMATIC_TOOL_NAME, "mcp__fx__write"]);
    assert.ok(result.receipt.tools.some((entry) => entry.name === "mcp__fx__write" && entry.calls === 1));
    assert.deepEqual(host.calledTools(), { mcp__fx__write: { server: "fx", tool: "write", isErrors: 0 } });
  } finally {
    await host.close();
  }
});

test("a crash is a tool error, is never retried, and the next call reconnects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cave-mcp-crash-"));
  const log = join(dir, "calls.log");
  const runtime = codeRuntime();
  const host = attach(runtime, [fixture("fx", { FIXTURE_LOG: log })]);
  try {
    host.start();
    const results = [];
    const faux = fauxProvider();
    const result = await run(runtime.definition, "crash it", {
      ensureRuntime: false,
      model: faux.getModel(),
      streamFn: scripted([
        "try { await tools.mcp__fx__crash({}); } catch (error) { print(error.message); }",
      ].join("\n"), results),
    });
    assert.equal(result.stopReason, "complete");
    assert.match(results[0], /mcp_server_disconnected:fx\/crash: the server closed the connection/);
    assert.match(results[0], /fixture crashing on purpose/);
    assert.match(results[0], /check whether this call took effect/);
    assert.ok(result.receipt.tools.some((entry) => entry.name === "mcp__fx__crash" && entry.errors === 1));
    assert.equal(host.status()[0].state, "disconnected");
    const echoed = JSON.parse(await cell(runtime, 'return (await tools.mcp__fx__echo({ text: "back" })).structuredContent;'));
    assert.equal(echoed.echoed, "back");
    const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => line.split(" "));
    assert.deepEqual(calls.map(([name]) => name), ["crash", "echo"], "the crashed call ran once");
    assert.notEqual(calls[0][1], calls[1][1], "a new server process answered");
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("shutdown stops the server's whole process group", async () => {
  const runtime = codeRuntime();
  const host = attach(runtime, [fixture("fx")]);
  host.start();
  const { pid } = JSON.parse(await cell(runtime, "return (await tools.mcp__fx__spawn_child({})).content[0].text;"));
  assert.doesNotThrow(() => process.kill(pid, 0));
  await host.close();
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise((done) => setTimeout(done, 30));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the server's child process outlived shutdown");
  assert.equal(host.status()[0].state, "closed");
});

function oauthServer() {
  let base = "";
  const issued = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, base);
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    let body = "";
    for await (const chunk of request) body += chunk;
    if (url.pathname === "/mcp") {
      if (request.headers.authorization !== "Bearer good-token") {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="tools"`,
        });
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const frame = JSON.parse(body);
      if (frame.id === undefined) {
        response.writeHead(202);
        response.end();
      } else if (frame.method === "initialize") {
        json(200, { jsonrpc: "2.0", id: frame.id, result: {
          protocolVersion: frame.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "remote", version: "1" },
        } });
      } else {
        json(200, { jsonrpc: "2.0", id: frame.id, result: { tools: [
          { name: "whoami", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        ] } });
      }
    } else if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    } else if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
      });
    } else if (url.pathname === "/register") {
      state.registered++;
      json(201, { ...JSON.parse(body), client_id: "client-1" });
    } else if (url.pathname === "/token") {
      const params = Object.fromEntries(new URLSearchParams(body));
      if (params.grant_type === "refresh_token" && state.refreshError !== undefined) {
        json(400, { error: state.refreshError });
        return;
      }
      issued.push(params);
      json(200, { access_token: "good-token", token_type: "Bearer", refresh_token: "refresh-1", scope: "tools" });
    } else {
      json(404, {});
    }
  });
  const state = { server, base: () => base, issued, registered: 0, refreshError: undefined };
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done(state);
  }));
}

test("OAuth sign-in rejects a mismatched iss, then succeeds with PKCE and the right issuer", async () => {
  const remote = await oauthServer();
  const states = new Map();
  const store = (name, url) => ({
    load: () => structuredClone(states.get(`${name}|${url}`)),
    save: (state) => void states.set(`${name}|${url}`, structuredClone(state)),
  });
  const runtime = codeRuntime();
  const host = attach(runtime, [{ name: "remote", source: "test", config: { url: "${MCP_BASE}/mcp" } }], {
    resolveValue: async (value) => value.replace("${MCP_BASE}", remote.base()),
    oauthStore: store,
    clientName: "pebble",
    signInHint: (server) => `Run pebble mcp login ${server}.`,
  });
  const redirectWith = (iss) => ({
    showAuthorizationUrl(url) {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.get("scope"), "tools");
      const callback = new URL(url.searchParams.get("redirect_uri"));
      callback.searchParams.set("code", "code-1");
      callback.searchParams.set("state", url.searchParams.get("state"));
      callback.searchParams.set("iss", iss);
      void fetch(callback).then((response) => response.text()).catch(() => undefined);
    },
  });
  try {
    host.start();
    await settled(host);
    assert.equal(host.status()[0].state, "needs-auth");
    await assert.rejects(host.signIn("remote", redirectWith("https://evil.example")), /issuer|iss/i);
    assert.equal(remote.issued.length, 0, "no code exchange after an iss mismatch");
    assert.equal(states.get(`remote|${remote.base()}/mcp`)?.tokens, undefined);
    await host.signIn("remote", redirectWith(remote.base()));
    assert.equal(remote.issued.length, 1);
    assert.equal(remote.issued[0].grant_type, "authorization_code");
    assert.ok(remote.issued[0].code_verifier.length >= 43);
    assert.equal(host.status()[0].state, "connected");
    assert.equal(host.status()[0].containment, "remote endpoint");
    const stored = states.get(`remote|${remote.base()}/mcp`);
    assert.equal(stored.tokens.access_token, "good-token");
    assert.equal(stored.clientInformation.client_name, "pebble");
    assert.deepEqual([...states.keys()], [`remote|${remote.base()}/mcp`], "OAuth keys on the resolved URL");
  } finally {
    await host.close();
    remote.server.close();
  }
});

function failOnceAt(store, type) {
  let armed = true;
  return {
    load: (runId) => store.load(runId),
    acquire: (runId) => store.acquire(runId),
    close: (runId) => store.close(runId),
    async append(runId, data) {
      if (armed && data.trim().split("\n").some((line) => JSON.parse(line).type === type)) {
        armed = false;
        await store.append(runId, data);
        throw new Error(`simulated_${type}_crash`);
      }
      await store.append(runId, data);
    },
  };
}

test("a resumed cell that calls an unregistered MCP tool fails closed without re-running it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cave-mcp-durable-"));
  const log = join(dir, "calls.log");
  await writeFile(log, "");
  const store = failOnceAt(new DiskDurableStore(join(dir, "journal")), "tool_settled");
  const code = 'print((await tools.mcp__fx__write({ value: "https://x.example" })).content[0].text);';
  const first = codeRuntime();
  const host = attach(first, [fixture("fx", { FIXTURE_LOG: log })]);
  try {
    host.start();
    await assert.rejects(run(first.definition, "write", {
      ensureRuntime: false,
      model: fauxProvider().getModel(),
      durable: { runId: "mcp-resume", store },
      streamFn: scripted(code),
    }), /simulated_tool_settled_crash/);
  } finally {
    await host.close();
  }
  // Resume before the server reconnects: the tool is not registered.
  const results = [];
  await assert.rejects(run(codeRuntime().definition, "write", {
    ensureRuntime: false,
    model: fauxProvider().getModel(),
    durable: { runId: "mcp-resume", store },
    streamFn: scripted(code, results),
  }), /cave_durable_tool_replay_incomplete:mcp__fx__write:/);
  assert.match(results[0], /tools\.mcp__fx__write does not exist/);
  assert.equal((await readFile(log, "utf8")).split("\n").filter((line) => line.startsWith("write ")).length, 1,
    "the effect ran exactly once");
  assert.ok(results.every((text) => !text.includes("wrote")), "no fabricated result reached the model");
  await rm(dir, { recursive: true, force: true });
});

test("code-cell argument checks accept JSON Schema type lists", async () => {
  const runtime = codeRuntime();
  runtime.registerNestedTools([tool({
    name: "nullable",
    description: "Take a nullable note.",
    input: { type: "object", properties: { note: { type: ["string", "null"] } }, required: ["note"] },
    effect: "read",
    result: "inline",
    execute: ({ note }) => `note:${note}`,
  })]);
  assert.equal(await cell(runtime, "return await tools.nullable({ note: null });"), "note:null");
  await assert.rejects(
    cell(runtime, "return await tools.nullable({ note: 3 });"),
    /- note: expected string \| null, got number/,
  );
});

test("close during a slow connect returns promptly and leaves the server closed", async () => {
  const host = attach(codeRuntime(), [fixture("slow", { FIXTURE_DELAY_MS: "10000" })]);
  host.start();
  await new Promise((done) => setTimeout(done, 100));
  const started = performance.now();
  await host.close();
  assert.ok(performance.now() - started < 3_000, "close waited for the whole connect");
  assert.equal(host.status()[0].state, "closed");
});

test("an expired HTTP session is a tool error that is not retried; the next call reconnects", async () => {
  const seen = [];
  let session = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    const frame = JSON.parse(body);
    seen.push(`${frame.method}@${request.headers["mcp-session-id"] ?? "-"}`);
    const json = (result, headers = {}) => {
      response.writeHead(200, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    };
    if (frame.id === undefined) {
      response.writeHead(202);
      response.end();
    } else if (frame.method === "initialize") {
      session++;
      json({ protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } },
        { "mcp-session-id": `s${session}` });
    } else if (frame.method === "tools/list") {
      json({ tools: [{ name: "ping", inputSchema: { type: "object" } }] });
    } else if (request.headers["mcp-session-id"] === "s1") {
      response.writeHead(404);
      response.end();
    } else {
      json({ content: [{ type: "text", text: "pong" }] });
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const runtime = codeRuntime();
  const host = attach(runtime, [{ name: "web", source: "test", config: { url, headers: { Authorization: "Bearer static" } } }]);
  try {
    host.start();
    await settled(host);
    await assert.rejects(cell(runtime, "return await tools.mcp__web__ping({});"), /mcp_server_session_expired:web\/ping: the call was not run/);
    assert.equal(host.status()[0].state, "disconnected");
    assert.equal(await cell(runtime, "return (await tools.mcp__web__ping({})).content[0].text;"), "pong");
    assert.deepEqual(seen.filter((entry) => entry.startsWith("tools/call")), ["tools/call@s1", "tools/call@s2"]);
  } finally {
    await host.close();
    server.close();
  }
});

test("a resumed cell replays a settled MCP call from the journal without calling the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cave-mcp-replay-"));
  const log = join(dir, "calls.log");
  await writeFile(log, "");
  const store = failOnceAt(new DiskDurableStore(join(dir, "journal")), "tool_settled");
  const code = 'print((await tools.mcp__fx__write({ value: "https://y.example" })).content[0].text);';
  for (const attempt of [1, 2]) {
    const runtime = codeRuntime();
    const host = attach(runtime, [fixture("fx", { FIXTURE_LOG: log })]);
    const results = [];
    try {
      host.start();
      const running = run(runtime.definition, "write", {
        ensureRuntime: false,
        model: fauxProvider().getModel(),
        durable: { runId: "mcp-replay", store },
        streamFn: scripted(code, results),
      });
      if (attempt === 1) {
        await assert.rejects(running, /simulated_tool_settled_crash/);
      } else {
        assert.equal((await running).text, "done");
        assert.deepEqual(results, ["wrote https://y.example"]);
      }
    } finally {
      await host.close();
    }
  }
  assert.equal((await readFile(log, "utf8")).split("\n").filter((line) => line.startsWith("write ")).length, 1,
    "the server ran the write once");
  await rm(dir, { recursive: true, force: true });
});

test("a background token refresh never registers a client or starts an authorization", async () => {
  const remote = await oauthServer();
  remote.refreshError = "invalid_client";
  const url = `${remote.base()}/mcp`;
  const key = `remote|${url}`;
  const clientInformation = { client_id: "client-1", redirect_uris: ["http://127.0.0.1:1/callback"] };
  const states = new Map([[key, {
    serverUrl: url,
    clientInformation,
    tokens: { access_token: "stale", token_type: "Bearer", refresh_token: "refresh-old" },
  }]]);
  const host = attach(codeRuntime(), [{ name: "remote", source: "test", config: { url } }], {
    oauthStore: (name, serverUrl) => ({
      load: () => structuredClone(states.get(`${name}|${serverUrl}`)),
      save: (state) => void states.set(`${name}|${serverUrl}`, structuredClone(state)),
    }),
  });
  try {
    host.start();
    await settled(host);
    assert.notEqual(host.status()[0].state, "connected");
    assert.equal(remote.registered, 0, "no dynamic client registration from a background connect");
    const stored = states.get(key);
    assert.deepEqual(stored.clientInformation, clientInformation, "the registered client survives");
    assert.equal(stored.codeVerifier, undefined);
    assert.equal(stored.oauthState, undefined);
  } finally {
    await host.close();
    remote.server.close();
  }
});

test("a bad plugin mcpServers path is a diagnostic, not a dropped plugin", async () => {
  const { loadAgentPlugin } = await import("../dist/agent-environment.js");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "cave-mcp-plugin-"));
  try {
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "commands"), { recursive: true });
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tools", mcpServers: "../outside.json" }));
    await writeFile(join(root, "commands", "go.md"), "---\ndescription: Go.\n---\nGo.");
    const { plugin, diagnostics } = await loadAgentPlugin(root);
    assert.deepEqual(plugin.commands.map((command) => command.id), ["tools:go"]);
    assert.equal(plugin.hasMcp, true);
    assert.deepEqual(plugin.mcpServers, []);
    assert.ok(diagnostics.some((entry) => entry.code === "agent_environment_unsupported_plugin_mcp" &&
      entry.message.includes("mcpServers")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stdio servers run in the home directory or the config file's directory, never the workspace", async () => {
  const home = await mkdtemp(join(tmpdir(), "cave-mcp-home-"));
  const configDir = await mkdtemp(join(tmpdir(), "cave-mcp-config-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  const runtime = codeRuntime();
  const host = attach(runtime, [
    fixture("athome"),
    { ...fixture("relative", {}, { cwd: "." }), baseDir: configDir },
  ]);
  try {
    host.start();
    const { realpath } = await import("node:fs/promises");
    assert.equal(await realpath(await cell(runtime, "return JSON.parse((await tools.mcp__athome__env({})).content[0].text).FIXTURE_CWD;")), await realpath(home));
    assert.equal(await realpath(await cell(runtime, "return JSON.parse((await tools.mcp__relative__env({})).content[0].text).FIXTURE_CWD;")), await realpath(configDir));
    assert.notEqual(await realpath(home), await realpath(process.cwd()));
    assert.equal(await cell(runtime, "return JSON.parse((await tools.mcp__athome__env({})).content[0].text).PWD;"), home, "PWD matches the cwd");
  } finally {
    process.env.HOME = previous;
    await host.close();
    await rm(home, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});

test("hostile server schemas cannot stall validation on the main thread", async () => {
  const { argumentErrors } = await import("../dist/programmatic-catalog.js");
  const { Value } = await import("typebox/value");
  const runtime = codeRuntime();
  const host = attach(runtime, [fixture("evil", { FIXTURE_HOSTILE: "1" })]);
  try {
    host.start();
    await settled(host);
    const { registry } = programmaticToolMetadata(runtime.definition.tools[0]);
    const lookup = registry.get("mcp__evil__lookup");
    const nested = registry.get("mcp__evil__nested");
    const combined = registry.get("mcp__evil__combined");
    const refs = registry.get("mcp__evil__refs");
    const search = registry.get("mcp__evil__search");
    assert.doesNotMatch(JSON.stringify(lookup.input), /pattern/, "pattern and patternProperties are stripped");
    assert.doesNotMatch(JSON.stringify(refs.input), /\$ref|\$defs/, "$ref graphs are stripped");
    assert.deepEqual(Object.keys(search.input.properties), ["path", "pattern"], "a property named pattern stays");
    const evil = { key: `${"a".repeat(29)}!` };
    let deep = { z: 1 };
    for (let depth = 0; depth < 22; depth++) deep = { a: deep };
    for (const [definition, value] of [[lookup, evil], [nested, deep], [combined, {}], [refs, {}]]) {
      const started = performance.now();
      argumentErrors(definition.input, value);
      Value.Check(definition.input, value);
      assert.ok(performance.now() - started < 100, `${definition.name} validation took too long`);
    }
    assert.equal(await cell(runtime, `return (await tools.mcp__evil__lookup(${JSON.stringify(evil)})).content[0].text;`), "ok");
    assert.equal(await cell(runtime, 'return (await tools.mcp__evil__search({ path: ".", pattern: "*.ts" })).content[0].text;'), "ok");
    // A 32-member union divides the 256 KiB argument limit by 32.
    await assert.rejects(cell(runtime, 'return await tools.mcp__evil__pick({ k: 1, pad: "x".repeat(9000) });'), /takes at most 8 KiB/);
    assert.equal(await cell(runtime, 'return (await tools.mcp__evil__pick({ k: 1, pad: "x".repeat(7000) })).content[0].text;'), "ok");
  } finally {
    await host.close();
  }
  // Raw 22-level type-list chain straight into the code-cell checker.
  let schema = { type: ["object", "object"], properties: {}, additionalProperties: false };
  let value = { z: 1 };
  for (let depth = 0; depth < 22; depth++) {
    schema = { type: ["object", "object"], properties: { a: schema } };
    value = { a: value };
  }
  const started = performance.now();
  assert.equal(argumentErrors(schema, value).length, 1);
  assert.ok(performance.now() - started < 100);
});

test("HTTP transport refuses redirects, so configured headers never follow one", async () => {
  const seen = [];
  const target = createServer((request, response) => {
    seen.push(request.headers["x-api-key"] ?? null);
    response.end("{}");
  });
  await new Promise((done) => target.listen(0, "127.0.0.1", done));
  const origin = createServer((_request, response) => {
    response.writeHead(307, { location: `http://localhost:${target.address().port}/mcp` });
    response.end();
  });
  await new Promise((done) => origin.listen(0, "127.0.0.1", done));
  const host = attach(codeRuntime(), [{
    name: "moved",
    source: "test",
    config: { url: `http://127.0.0.1:${origin.address().port}/mcp`, headers: { Authorization: "Bearer x", "X-Api-Key": "SECRET" } },
  }]);
  try {
    host.start();
    await settled(host);
    assert.equal(host.status()[0].state, "failed");
    assert.match(host.status()[0].error, /mcp_http_redirect_refused:307:http:\/\/localhost:\d+\/mcp/);
    assert.deepEqual(seen, [], "the redirect target never received the request");
  } finally {
    await host.close();
    origin.close();
    target.close();
  }
});

test("a loopback MCP call has no undici header or body timeout; its own timeout bounds it", async () => {
  const { TRANSPORT_FETCH } = await import("../dist/mcp-guards.js");
  // Node's fetch stops a request after 300 s without headers or body bytes, which a person
  // answering or a long subagent wait passes. Loopback calls get a dispatcher without those limits.
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => (seen.push({ url: String(input), dispatcher: init?.dispatcher }), new Response("{}"));
  try {
    await TRANSPORT_FETCH("http://127.0.0.1:9/mcp", { method: "POST", body: "{}" });
    await TRANSPORT_FETCH("https://mcp.example/mcp", { method: "POST", body: "{}" });
  } finally {
    globalThis.fetch = realFetch;
  }
  const options = (dispatcher) => dispatcher?.[Object.getOwnPropertySymbols(dispatcher).find((key) => key.description === "options")];
  assert.deepEqual([options(seen[0].dispatcher)?.headersTimeout, options(seen[0].dispatcher)?.bodyTimeout], [0, 0]);
  assert.equal(seen[1].dispatcher, undefined, "a remote server keeps the global dispatcher (and a host's proxy)");

  // Headers after 300 ms, the body 300 ms later: it arrives, and the caller's signal (pi-mcp's per-call timeout) still ends a call.
  const server = createServer((_request, response) => setTimeout(() => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    setTimeout(() => response.end('{"ok":true}'), 300);
  }, 300));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    assert.deepEqual(await (await TRANSPORT_FETCH(url, { method: "POST", body: "{}" })).json(), { ok: true });
    await assert.rejects(TRANSPORT_FETCH(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(100) }), { name: "TimeoutError" });
  } finally {
    server.close();
  }
});

test("an invalid resolved header value is reported by name only", async () => {
  const host = attach(codeRuntime(), [{
    name: "hdr",
    source: "test",
    config: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "${TOKEN}" } },
  }], { resolveValue: async () => "Bearer leaked-secret\r\nX-Injected: 1" });
  try {
    host.start();
    await settled(host);
    assert.equal(host.status()[0].state, "failed");
    assert.match(host.status()[0].error, /mcp_header_invalid:hdr:Authorization/);
    assert.doesNotMatch(host.status()[0].error, /leaked-secret/);
  } finally {
    await host.close();
  }
});

test("shutdown closes the server's stdin before any signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cave-mcp-eof-"));
  const log = join(dir, "calls.log");
  const runtime = codeRuntime();
  const host = attach(runtime, [fixture("fx", { FIXTURE_LOG: log })]);
  try {
    host.start();
    await settled(host);
    await host.close();
    assert.match(await readFile(log, "utf8"), /^eof \d+$/m, "the server saw EOF and exited on its own");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OAuth fetches require https (loopback http only for a loopback server), cap bodies, and ignore cross-origin challenges", async () => {
  const { oauthFetch, trustedChallenge } = await import("../dist/mcp-guards.js");
  await assert.rejects(oauthFetch("https://mcp.example/mcp")("http://auth.example/.well-known/oauth-authorization-server"), /mcp_fetch_insecure_url/);
  // A remote server's metadata cannot point registration or token requests at a local service.
  await assert.rejects(oauthFetch("https://mcp.example/mcp")("http://127.0.0.1:9/register"), /mcp_fetch_insecure_url:http:\/\/127\.0\.0\.1:9/);
  await assert.rejects(oauthFetch("https://mcp.example/mcp")("http://localhost:9/token"), /mcp_fetch_insecure_url/);
  const OAUTH_FETCH = oauthFetch("http://127.0.0.1:1/mcp");
  const server = createServer((_request, response) => {
    // An event-stream content type must not bypass the cap.
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("x".repeat(2 * 1024 * 1024));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    await assert.rejects(OAUTH_FETCH(`http://127.0.0.1:${server.address().port}/token`), /mcp_response_too_large/);
  } finally {
    server.close();
  }
  const same = { resourceMetadataUrl: new URL("https://mcp.example/.well-known/oauth-protected-resource"), scope: "a" };
  assert.equal(trustedChallenge(same, "https://mcp.example/mcp"), same);
  assert.deepEqual(trustedChallenge({ ...same, resourceMetadataUrl: new URL("https://evil.example/m") }, "https://mcp.example/mcp"), { scope: "a" });
});

test("a provider token reaches only an https or loopback resolved URL", async () => {
  const host = attach(codeRuntime(), [{
    name: "prov",
    source: "test",
    config: { url: "https://${HOST}/mcp", auth: { provider: "openai" } },
  }], { resolveValue: async () => "http://evil.example/mcp", providerToken: async () => "tok" });
  try {
    host.start();
    await settled(host);
    assert.equal(host.status()[0].state, "failed");
    assert.match(host.status()[0].error, /mcp_server_url_insecure:prov/);
  } finally {
    await host.close();
  }
});

test("validation work stays bounded: wide unions are dropped and MCP argument size scales with fanout", async () => {
  const { sanitizeServerSchema, schemaFanout } = await import("../dist/mcp-guards.js");
  const { argumentErrors } = await import("../dist/programmatic-catalog.js");
  const { Value } = await import("typebox/value");
  const union = (width, member) => Array.from({ length: width }, (_, i) => member(i));
  const object = (i) => ({ type: "object", properties: { z: { const: i } }, required: ["z"] });
  // The review PoC: a 64-member union per array element is dropped.
  const wide = sanitizeServerSchema({ type: "object", properties: { k: { type: "array", items: { anyOf: union(64, object) } } } });
  assert.deepEqual(wide.properties.k.items, {});
  assert.deepEqual(sanitizeServerSchema({ type: "object", properties: Object.fromEntries(
    union(5, (i) => [`p${i}`, { anyOf: union(30, (j) => ({ const: j })) }])) }), {}, "over 128 union members in total");
  let nested = { type: "number" };
  for (let depth = 0; depth < 6; depth++) nested = { anyOf: [{ type: "array", items: nested }, { type: "null" }] };
  assert.deepEqual(sanitizeServerSchema({ type: "object", properties: { k: nested } }), {}, "fanout over 32");
  const cases = [
    ["32 objects per element, last matches", { type: "object", properties: { k: { type: "array", items: { anyOf: union(32, object) } } } },
      (limit) => ({ k: Array.from({ length: Math.floor((limit - 10) / 9) }, () => ({ z: 31 })) }), 32, true],
    ["32 constants per element, last matches", { type: "object", properties: { k: { type: "array", items: { anyOf: union(32, (i) => ({ const: i })) } } } },
      (limit) => ({ k: Array.from({ length: Math.floor((limit - 10) / 3) }, () => 31) }), 32, true],
    ["32 members each walking the array", { type: "object", properties: { k: { anyOf: union(32, (i) => ({
      type: "array", items: { type: "object", properties: { [`f${i}`]: { type: "string" } } } })) } } },
      (limit) => ({ k: [...Array.from({ length: Math.floor((limit - 400) / 3) }, () => ({})), Object.fromEntries(union(32, (i) => [`f${i}`, 1]))] }), 32, false],
    ["plain numbers at the full limit", { type: "object", properties: { k: { type: "array", items: { type: "number" } } } },
      (limit) => ({ k: Array.from({ length: Math.floor((limit - 10) / 2) }, () => 1) }), 1, true],
  ];
  for (const [label, raw, make, expectedFanout, expectedValid] of cases) {
    const schema = sanitizeServerSchema(raw);
    assert.equal(schemaFanout(schema), expectedFanout, label);
    const limit = Math.floor(256 * 1024 / schemaFanout(schema));
    const value = make(limit);
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= limit, `${label} fits the limit`);
    // Deterministic regression bound for these fixtures and the pinned validators,
    // not a general runtime guarantee. They currently take at most 584,166 data
    // operations; counting avoids a wall-clock failure under test-runner contention.
    let operations = 0;
    const seen = new WeakMap();
    const visit = () => assert.ok(++operations <= 1_048_576, `${label} exceeded the traversal bound`);
    const measured = (item) => {
      if (item === null || typeof item !== "object") return item;
      if (seen.has(item)) return seen.get(item);
      const proxy = new Proxy(item, {
        get(target, key, receiver) { visit(); return measured(Reflect.get(target, key, receiver)); },
        has(target, key) { visit(); return Reflect.has(target, key); },
        ownKeys(target) { visit(); return Reflect.ownKeys(target); },
        getOwnPropertyDescriptor(target, key) { visit(); return Reflect.getOwnPropertyDescriptor(target, key); },
      });
      seen.set(item, proxy);
      return proxy;
    };
    const instrumented = measured(value);
    assert.equal(argumentErrors(schema, instrumented).length === 0, expectedValid, label);
    assert.equal(Value.Check(schema, instrumented), expectedValid, label);
    assert.ok(operations > 0, `${label} traversed instrumented arguments`);
  }

  // Over the limit, a call is refused before any check and never reaches the server.
  const dir = await mkdtemp(join(tmpdir(), "cave-mcp-size-"));
  const log = join(dir, "calls.log");
  const runtime = codeRuntime();
  const host = attach(runtime, [fixture("fx", { FIXTURE_LOG: log })]);
  try {
    host.start();
    await settled(host);
    await assert.rejects(cell(runtime, `return await tools.mcp__fx__echo({ text: "x".repeat(300 * 1024) });`),
      /cave_program_tool_arguments_too_large:mcp__fx__echo: this MCP tool takes at most 256 KiB/);
    await assert.rejects(readFile(log, "utf8"), { code: "ENOENT" });
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
