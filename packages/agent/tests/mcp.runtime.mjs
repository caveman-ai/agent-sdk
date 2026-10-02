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
    assert.deepEqual(host.calledTools(), { mcp__fx__write: { server: "fx", tool: "write" } });
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
  const host = attach(runtime, [{ name: "remote", source: "test", config: { url: `${remote.base()}/mcp` } }], {
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
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1, "the effect ran exactly once");
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
    /- note: expected string, got number/,
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
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1, "the server ran the write once");
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
