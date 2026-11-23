// A zero-dependency stdio MCP server for tests: one tool, env_of(name), answering the value of one of its own
// environment variables (or "(unset)"). Newline-delimited JSON-RPC 2.0 on stdin/stdout.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tools = [{ name: "env_of", description: "One of this server's environment variables.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }];

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "env", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  } else if (message.method === "tools/call") {
    const value = process.env[message.params.arguments?.name ?? ""];
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: value ?? "(unset)" }] } });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  }
});
