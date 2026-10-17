// What a host gets from createCodingAgent: hybrid code mode, its own
// instruction sections, explicit MCP servers, coding run defaults for
// stream(), and the engine levers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, createModels, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage as upstreamFaux, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { run, schema, stream, tool } from "../dist/index.js";
import {
  CODING_RUN_BREAKERS,
  codingRunOptions,
  createCodingAgent,
  runCodingTurn,
  startCodingSession,
} from "../dist/code.js";
import { programmaticToolMetadata } from "../dist/programmatic-tools.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_ENGINE = resolve(here, "fixtures/fake-engine.mjs");
const MCP_FIXTURE = resolve(here, "fixtures/mcp-fixture-server.mjs");
const CORE = ["read_file", "grep", "bash", "write_file", "edit_file", "read_tool_output"];

const lookup = tool({
  name: "lookup",
  description: "Read one value.",
  input: schema.object({ key: schema.string() }),
  effect: "read",
  result: "inline",
  execute: ({ key }) => `value:${key}`,
});

async function withWorkspace(body) {
  const workspace = await mkdtemp(resolve(tmpdir(), "coding-host-ws-"));
  const store = await mkdtemp(resolve(tmpdir(), "coding-host-engine-"));
  const previous = process.env.CAVE_FAKE_ENGINE_STORE;
  process.env.CAVE_FAKE_ENGINE_STORE = store;
  try {
    return await body(workspace, store);
  } finally {
    if (previous === undefined) delete process.env.CAVE_FAKE_ENGINE_STORE;
    else process.env.CAVE_FAKE_ENGINE_STORE = previous;
    await rm(workspace, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

function usage() {
  return {
    input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function message(selected, content, stopReason) {
  const output = createAssistantMessageEventStream();
  const value = {
    role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id,
    usage: usage(), stopReason, timestamp: Date.now(),
  };
  queueMicrotask(() => {
    output.push({ type: "start", partial: { ...value, content: [], stopReason: "pending" } });
    output.push({ type: "done", reason: stopReason, message: value });
    output.end(value);
  });
  return output;
}

/** Each provider call answers with the next tool call; then "done". Tool results land in `results`. */
function scripted(calls, results = [], seen = []) {
  let index = 0;
  return (selected, context, options) => {
    seen.push({ context: structuredClone(context), options });
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") results.push(last.content.map((item) => item.type === "text" ? item.text : "").join(""));
    const next = calls[index++];
    return next === undefined
      ? message(selected, [{ type: "text", text: "done" }], "stop")
      : message(selected, [{ type: "toolCall", id: `call-${index}`, name: next.name, arguments: next.args }], "toolUse");
  };
}

function prefix(codingAgent) {
  return JSON.stringify({
    instructions: codingAgent.definition.instructions,
    tools: codingAgent.definition.tools.map((item) => ({ name: item.name, description: item.description, input: item.input })),
  });
}

test("hybrid is the default: coding tools stay declared, one code tool carries the rest", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(resolve(workspace, "a.txt"), "alpha\n");
    await writeFile(resolve(workspace, "b.txt"), "beta\n");
    const codingAgent = createCodingAgent({
      workspace,
      model: "openai/gpt-5.4",
      definitionTransforms: [{ id: "add-lookup", apply: (definition) => ({ ...definition, tools: [...definition.tools, lookup] }) }],
    });
    try {
      assert.equal(codingAgent.toolMode, "hybrid");
      assert.deepEqual(codingAgent.definition.tools.map((item) => item.name), [...CORE, "caveman_code"]);
      const codeTool = codingAgent.definition.tools.at(-1);
      // A transform's new tool is reachable only in the cell; the coding tools are both.
      assert.deepEqual(codeTool.nestedTools.map((item) => item.name), [...CORE, "lookup"]);
      assert.match(codeTool.description, /\/\/ Read one value\.\ndeclare function lookup\(/);
      // A declared tool keeps its cell signature (its result differs from the declared text), not its description.
      const readFile = codingAgent.definition.tools.find((item) => item.name === "read_file");
      assert.match(codeTool.description, /\ndeclare function read_file\(args: \{ path: string[^\n]*\): Promise<string>;/);
      assert.equal(codeTool.description.includes(readFile.description.split("\n")[0]), false, "descriptions are not repeated");
      const instructions = String(codingAgent.definition.instructions);
      assert.match(instructions, /\nTools:\n- read_file prefixes each line/);
      assert.match(instructions, /caveman_code runs one bounded async JS cell\. Use it for what the tools above do not cover/);

      // Fan-out in one cell, then one direct call, on the same run.
      const results = [];
      const faux = fauxProvider();
      const result = await run(codingAgent.definition, "read both", codingRunOptions(codingAgent, {
        ensureRuntime: false,
        cave: "off",
        model: faux.getModel(),
        streamFn: scripted([
          { name: "caveman_code", args: { code: 'const [a, b] = await Promise.all([read_file({ path: "a.txt" }), read_file({ path: "b.txt" })]);\nprint(JSON.stringify([a, b]), (await lookup({ key: "k" })));' } },
          { name: "read_file", args: { path: "a.txt" } },
        ], results),
      }));
      assert.equal(result.text, "done");
      assert.match(results[0], /alpha/);
      assert.match(results[0], /beta/);
      assert.match(results[0], /value:k/);
      assert.match(results[1], /^1\talpha/);
      assert.deepEqual(result.toolCalls, ["caveman_code", "read_file", "read_file", "lookup", "read_file"]);
    } finally {
      await codingAgent.close();
    }
  });
});

test("direct and programmatic stay selectable", () => {
  const direct = createCodingAgent({ workspace: tmpdir(), model: "openai/gpt-5.4", toolMode: "direct" });
  assert.deepEqual(direct.definition.tools.map((item) => item.name), CORE);
  assert.equal(direct.programmaticTools, undefined);
  const programmatic = createCodingAgent({ workspace: tmpdir(), model: "openai/gpt-5.4", toolMode: "programmatic" });
  assert.deepEqual(programmatic.definition.tools.map((item) => item.name), ["caveman_code"]);
  assert.throws(() => createCodingAgent({ workspace: tmpdir(), model: "openai/gpt-5.4", toolMode: "code" }),
    /coding_tool_mode_invalid:code/);
});

test("host instruction sections follow the SDK text in order; the SDK reads no workspace file", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(resolve(workspace, "AGENTS.md"), "AUTO_DISCOVERED_SENTINEL\n");
    const options = {
      workspace,
      model: "openai/gpt-5.4",
      instructions: "Host addition.",
      instructionSections: [
        { title: "AGENTS.md", text: "Run make test-fast.\n" },
        { title: "Project instructions", text: "   " },
        { title: "Memory", text: "Prefers pnpm." },
      ],
    };
    for (const toolMode of ["hybrid", "programmatic", "direct"]) {
      const codingAgent = createCodingAgent({ ...options, toolMode });
      const instructions = String(codingAgent.definition.instructions);
      assert.ok(instructions.endsWith("Host addition.\n\n# AGENTS.md\n\nRun make test-fast.\n\n# Memory\n\nPrefers pnpm."), toolMode);
      assert.doesNotMatch(instructions, /Project instructions/, "an empty section is left out");
      assert.doesNotMatch(instructions, /AUTO_DISCOVERED_SENTINEL/);
      // Same input, same bytes: the prefix is cache-stable across agents.
      assert.equal(prefix(createCodingAgent({ ...options, toolMode })), prefix(codingAgent));
    }
    assert.throws(() => createCodingAgent({ ...options, instructionSections: [{ title: "two\nlines", text: "x" }] }),
      /coding_instruction_section_title_invalid/);
  });
});

test("host MCP servers are callable inside the code tool, with a byte-stable prefix", async () => {
  await withWorkspace(async (workspace) => {
    const server = { name: "fx", source: "host", config: { command: process.execPath, args: [MCP_FIXTURE],
      env: { FIXTURE_DELAY_MS: "150" }, description: "Fixture tools." } };
    assert.throws(() => createCodingAgent({ workspace, model: "openai/gpt-5.4", toolMode: "direct", mcp: { servers: [server] } }),
      /coding_mcp_requires_code_tool/);
    const states = [];
    const codingAgent = createCodingAgent({
      workspace,
      model: "openai/gpt-5.4",
      mcp: { servers: [server], onChange: (status) => states.push(status.state) },
    });
    try {
      const before = prefix(codingAgent);
      assert.match(String(codingAgent.definition.instructions), /MCP servers whose tools are not declared to you\. Call them inside caveman_code/);
      assert.match(String(codingAgent.definition.instructions), /- mcp__fx: Fixture tools\./);
      assert.equal(codingAgent.definition.tools.some((item) => item.name.startsWith("mcp__")), false);
      const results = [];
      const faux = fauxProvider();
      // The cell names the server, so it waits for the still-starting connection.
      const result = await run(codingAgent.definition, "echo", codingRunOptions(codingAgent, {
        ensureRuntime: false,
        cave: "off",
        model: faux.getModel(),
        streamFn: scripted([{ name: "caveman_code", args: { code: 'print((await tools.mcp__fx__echo({ text: "hi" })).content[0].text);' } }], results),
      }));
      assert.equal(result.text, "done");
      assert.deepEqual(results, ["hi"]);
      assert.deepEqual(result.toolCalls, ["caveman_code", "mcp__fx__echo"]);
      assert.equal(codingAgent.mcp.status()[0].state, "connected");
      assert.equal(prefix(codingAgent), before, "connecting a server never changes the prefix");
    } finally {
      await codingAgent.close();
    }
    assert.equal(codingAgent.mcp.status()[0].state, "closed");
    assert.ok(states.includes("connected"));
  });
});

function bearerMcpServer(token) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    const frame = JSON.parse(body);
    const reply = (result) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    };
    if (frame.id === undefined) {
      response.writeHead(202);
      response.end();
    } else if (frame.method === "initialize") {
      reply({ protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "remote", version: "1" } });
    } else if (frame.method === "tools/list") {
      reply({ tools: [{ name: "whoami", inputSchema: { type: "object" } }] });
    } else {
      reply({ content: [{ type: "text", text: `called ${frame.params.name}` }] });
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

test("a streamable HTTP MCP server takes a bearer header", async () => {
  const server = await bearerMcpServer("t0k");
  const codingAgent = createCodingAgent({
    workspace: tmpdir(),
    model: "openai/gpt-5.4",
    mcp: { servers: [{ name: "remote", source: "host", config: {
      type: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: "Bearer t0k" },
    } }] },
  });
  try {
    const results = [];
    const faux = fauxProvider();
    await run(codingAgent.definition, "who", codingRunOptions(codingAgent, {
      ensureRuntime: false,
      cave: "off",
      model: faux.getModel(),
      streamFn: scripted([{ name: "caveman_code", args: { code: 'print((await tools.mcp__remote__whoami({})).content[0].text);' } }], results),
    }));
    assert.deepEqual(results, ["called whoami"]);
    assert.equal(codingAgent.mcp.status()[0].transport, "http");
  } finally {
    await codingAgent.close();
    server.close();
  }
});

test("codingRunOptions gives stream() the coding defaults; host values win", async () => {
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "openai/gpt-5.4" });
  const options = codingRunOptions(codingAgent, { cacheRetention: "short" });
  assert.equal(options.maxModelCalls, 1_000);
  assert.equal(options.maxToolCalls, 4_000);
  assert.deepEqual(options.turnRetry, {});
  assert.equal(options.compaction.reserveTokens, 16_384);
  assert.equal(options.breakers, CODING_RUN_BREAKERS);
  assert.equal(options.cacheRetention, "short");
  assert.equal(codingRunOptions(codingAgent).cacheRetention, "long");
  assert.equal(codingAgent.definition.output.maxTokens, 32_000);

  // Past the generic 64-call ceiling, through stream() itself.
  await withWorkspace(async (workspace) => {
    const agentHere = createCodingAgent({ workspace, model: "openai/gpt-5.4" });
    const faux = fauxProvider();
    const seen = [];
    const calls = Array.from({ length: 70 }, (_, n) => ({ name: "bash", args: { command: `echo ${n}` } }));
    let end;
    for await (const event of stream(agentHere.definition, "count", codingRunOptions(agentHere, {
      ensureRuntime: false, cave: "off", model: faux.getModel(), streamFn: scripted(calls, [], seen),
    }))) {
      if (event.type === "run_end") end = event.result;
      if (event.type === "run_error") throw new Error(event.message);
    }
    assert.equal(end.text, "done");
    assert.equal(end.toolCalls.length, 70);
    assert.equal(seen[0].options.cacheRetention, "long");
    await agentHere.close();
  });
});

function engineModels(faux, seen) {
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple(selected, context, options) {
      seen.push(structuredClone(context.messages));
      options.onPayload({ system: getCurrentSystemPrompt(context.messages), tools: [],
        messages: context.messages.filter((item) => item.role !== "system") }, selected);
      return faux.provider.streamSimple(selected, context, { ...options, onPayload: undefined });
    },
  });
  return models;
}

function fauxMessage(...args) {
  const value = upstreamFaux(...args);
  return { ...value, usage: { ...value.usage, reasoning: 0 } };
}

test("bound lever: the engine sees only a capped output; history and short outputs pass as they are", async () => {
  await withWorkspace(async (workspace, store) => {
    // ~17 KB: over the old 8 KiB compression floor, under bash's 24,000-byte cap.
    await writeFile(resolve(workspace, "big.txt"), Array.from({ length: 240 }, (_, index) =>
      `line ${index}: the quick brown fox jumps over the lazy dog repeatedly`).join("\n"));
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1", toolMode: "direct", outputCaps: { bash: 2_048 } });
    assert.deepEqual(codingAgent.levers, { compression: "bound", keep: true });
    assert.deepEqual(codingAgent.plan.segment_routes.map((route) => route.segment_kind), ["tool_result"]);
    const session = await startCodingSession(codingAgent, { cave: "local", engineBin: FAKE_ENGINE });
    const faux = fauxProvider({ provider: "anthropic" });
    const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
    const seen = [];
    faux.setResponses([
      fauxMessage([{ type: "text", text: "a long history line that the engine would shrink ".repeat(20) },
        fauxToolCall("bash", { command: "head -c 1500 big.txt" }, { id: "short-1" })]),
      fauxMessage(fauxToolCall("bash", { command: "cat big.txt" }, { id: "long-1" })),
      fauxMessage("done"),
    ]);
    const turn = await runCodingTurn(session, "which line mentions the lazy dog?", {
      model, models: engineModels(faux, seen), providerPayloadContract: "pi-on-payload-v1",
    });
    const results = Object.fromEntries(seen.at(-1).filter((item) => item.role === "toolResult")
      .map((item) => [item.toolCallId, item.content[0].text]));
    assert.doesNotMatch(results["short-1"], /cave-compressed/);
    assert.match(results["long-1"], /<cave-compressed /);
    assert.deepEqual(turn.bill.transformIDs, ["caveman.engine.terminal.v1"], "no history transform");
    // One engine call: the overrun output. Keep got the ask from a private file.
    const argv = (await readFile(resolve(store, "argv.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const compress = argv.filter((entry) => entry[0] === "compress");
    assert.equal(compress.length, 1);
    assert.equal(compress[0].includes("--query-file"), true);
  });
});

test("keep lever off: compression runs without the ask", async () => {
  await withWorkspace(async (workspace, store) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1", toolMode: "direct",
      outputCaps: { bash: 2_048 }, levers: { keep: false } });
    const session = await startCodingSession(codingAgent, { cave: "local", engineBin: FAKE_ENGINE });
    const faux = fauxProvider({ provider: "anthropic" });
    const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
    faux.setResponses([
      fauxMessage(fauxToolCall("bash", { command: `node -e 'process.stdout.write("x".repeat(9000))'` }, { id: "long-1" })),
      fauxMessage("done"),
    ]);
    await runCodingTurn(session, "secret ask", { model, models: engineModels(faux, []), providerPayloadContract: "pi-on-payload-v1" });
    const argv = (await readFile(resolve(store, "argv.jsonl"), "utf8")).trim();
    assert.match(argv, /"compress"/);
    assert.doesNotMatch(argv, /--query-file|secret ask/);
    assert.throws(() => createCodingAgent({ workspace, model: "anthropic/faux-1", levers: { compression: "max" } }),
      /coding_levers_compression_invalid:max/);
  });
});
