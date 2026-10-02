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

const TOOLS = [
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
    case "env": return text({ ...process.env, FIXTURE_ARGV: process.argv.slice(2).join(" ") });
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
  lines.on("close", () => process.exit(0));
}

const delay = Number(process.env.FIXTURE_DELAY_MS ?? 0);
if (delay > 0) setTimeout(serve, delay);
else serve();
