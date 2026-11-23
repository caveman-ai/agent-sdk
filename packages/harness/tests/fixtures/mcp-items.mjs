// A zero-dependency stdio MCP server for tests: 60 items, paginated 25 a page; get_item; update_item (fails once on
// item 7 with a transient error); boom (always an MCP error). Newline-delimited JSON-RPC 2.0 on stdin/stdout.
import { createInterface } from "node:readline";

const items = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, title: `Item ${i + 1}`, status: i % 3 === 0 ? "approved" : "open", body: "x".repeat(200) }));
let failedOnce = false;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const tools = [
  { name: "list_items", description: "List items, 25 a page.", inputSchema: { type: "object", properties: { cursor: { type: "integer" } } } },
  { name: "get_item", description: "Get one item.", inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
  { name: "update_item", description: "Set an item's status.", inputSchema: { type: "object", properties: { id: { type: "integer" }, status: { type: "string" } }, required: ["id", "status"] } },
  { name: "boom", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
];

function call(name, args) {
  if (name === "list_items") {
    const start = args.cursor ?? 0;
    return text({ items: items.slice(start, start + 25).map(({ id, title, status }) => ({ id, title, status })), next_cursor: start + 25 < items.length ? start + 25 : null });
  }
  if (name === "get_item") {
    const item = items.find((entry) => entry.id === args.id);
    return item === undefined ? { ...text(`no item ${args.id}`), isError: true } : text(item);
  }
  if (name === "update_item") {
    const item = items.find((entry) => entry.id === args.id);
    if (item === undefined) return { ...text(`no item ${args.id}`), isError: true };
    if (item.id === 7 && !failedOnce) {
      failedOnce = true;
      return { ...text("transient: try again"), isError: true };
    }
    item.status = args.status;
    return text({ ok: true, id: item.id, status: item.status });
  }
  if (name === "boom") return { ...text("boom failed"), isError: true };
  return { ...text(`unknown tool ${name}`), isError: true };
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "items", version: "1" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: call(message.params.name, message.params.arguments ?? {}) });
  } else if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  }
});
