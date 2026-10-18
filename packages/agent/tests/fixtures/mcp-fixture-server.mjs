#!/usr/bin/env node
// Tiny newline-delimited JSON-RPC MCP server for tests. Plain Node, no deps.
// FIXTURE_DELAY_MS delays startup, FIXTURE_FAIL exits at once, FIXTURE_LOG
// appends each tools/call name, FIXTURE_INSTRUCTIONS sets server instructions.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FIXTURE_FAIL) {
  process.stderr.write(`fixture refused to start: ${process.env.FIXTURE_FAIL}\n`);
  process.exit(3);
}

let chain = { type: ["object", "object"], properties: {}, additionalProperties: false };
for (let depth = 0; depth < 22; depth++) chain = { type: ["object", "object", "integer", "number"], properties: { a: chain } };
let combined = { type: "object" };
for (let depth = 0; depth < 24; depth++) combined = { type: ["object", "null"], allOf: [combined] };
const defs = { d18: { type: "object" } };
for (let depth = 0; depth < 18; depth++) {
  defs[`d${depth}`] = { allOf: [{ $ref: `#/$defs/d${depth + 1}` }, { $ref: `#/$defs/d${depth + 1}` }] };
}
const HOSTILE = [
  { name: "lookup", description: "Look up a key.", inputSchema: {
    type: "object",
    properties: { key: { type: "string", pattern: "^(a+)+$" } },
    patternProperties: { "^(b+)+$": { type: "string" } },
    required: ["key"],
  } },
  { name: "nested", description: "Deep type lists.", inputSchema: chain },
  { name: "combined", description: "Type lists over allOf.", inputSchema: combined },
  { name: "refs", description: "A $ref graph.", inputSchema: { $defs: defs, $ref: "#/$defs/d0" } },
  { name: "pick", description: "Pick one of 32.", inputSchema: {
    type: "object",
    properties: { k: { anyOf: Array.from({ length: 32 }, (_, i) => ({ const: i })) } },
  } },
  { name: "search", description: "Search files.", inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, pattern: { type: "string" } },
    required: ["path", "pattern"],
    additionalProperties: false,
  } },
];
const TOOLS = process.env.FIXTURE_HOSTILE ? HOSTILE : [
  {
    name: "echo",
    description: "Echo text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" }, note: { type: ["string", "null"] } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "env",
    description: "Report the server process environment.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "write",
    description: "Record one write.",
    inputSchema: { type: "object", properties: { value: { type: "string", format: "uri" } } },
  },
  { name: "crash", description: "Exit the server during the call.", inputSchema: { type: "object" } },
  { name: "spawn_child", description: "Start a long-lived child process.", inputSchema: { type: "object" } },
  { name: "fail", description: "Return an MCP error result.", inputSchema: { type: "object" } },
  { name: "sleep", description: "Answer after ms milliseconds.", inputSchema: { type: "object", properties: { ms: { type: "integer" } } } },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function text(value) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function call(name, args) {
  if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `${name} ${process.pid}\n`);
  switch (name) {
    case "echo": return { ...text(args.text), structuredContent: { echoed: args.text, pid: process.pid } };
    case "env": return text({ ...process.env, FIXTURE_ARGV: process.argv.slice(2).join(" "), FIXTURE_CWD: process.cwd() });
    case "write": return text(`wrote ${args.value ?? ""}`);
    case "crash":
      process.stderr.write("fixture crashing on purpose\n");
      process.exit(7);
      return undefined;
    case "spawn_child": {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      return text({ pid: child.pid });
    }
    case "fail": return { ...text("fixture failure"), isError: true };
    case "lookup":
    case "nested":
    case "combined":
    case "refs":
    case "pick":
    case "search": return text("ok");
    default: return undefined;
  }
}

function serve() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    const frame = JSON.parse(line);
    if (frame.id === undefined) return;
    if (frame.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: frame.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1.0.0" },
          ...(process.env.FIXTURE_INSTRUCTIONS ? { instructions: process.env.FIXTURE_INSTRUCTIONS } : {}),
        },
      });
    } else if (frame.method === "tools/list") {
      send({ jsonrpc: "2.0", id: frame.id, result: { tools: TOOLS } });
    } else if (frame.method === "tools/call" && frame.params.name === "sleep") {
      const ms = Number(frame.params.arguments?.ms ?? 0);
      setTimeout(() => send({ jsonrpc: "2.0", id: frame.id, result: text(`slept ${ms}`) }), ms);
    } else if (frame.method === "tools/call") {
      const result = call(frame.params.name, frame.params.arguments ?? {});
      if (result === undefined) {
        send({ jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: `unknown tool ${frame.params.name}` } });
      } else {
        send({ jsonrpc: "2.0", id: frame.id, result });
      }
    } else if (frame.method === "ping") {
      send({ jsonrpc: "2.0", id: frame.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } });
    }
  });
  // Exit once stdin closes, like real servers.
  lines.on("close", () => {
    if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, `eof ${process.pid}\n`);
    process.exit(0);
  });
}

const delay = Number(process.env.FIXTURE_DELAY_MS ?? 0);
if (delay > 0) setTimeout(serve, delay);
else serve();
