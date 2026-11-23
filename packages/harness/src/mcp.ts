/**
 * MCP servers for one run (`--mcp-config`, Claude Code's file format, so one file drives both harnesses):
 *
 *   {"mcpServers": {"<name>": {"command": "node", "args": ["server.mjs", ...], "env": {...}, "cwd": "..."}}}
 *
 * Every server is connected over stdio (pi-mcp) before the first request, and its tools are listed once: the tool set
 * is frozen for the run, so the cached prefix never changes. loadout.mcp.exposure says how the model reaches them:
 * - "direct" (the default): one model-visible tool per MCP tool, named `<server>__<tool>`, as Claude Code does.
 * - "program": only inside the program tool (src/tools/program.ts), as `tools.<server>__<tool>(args)`, which returns
 *   the result parsed as JSON when it is JSON. Raw results then stay in the program instead of the context.
 *
 * Servers run on the host with the harness, never in the task sandbox: a server's credentials stay out of the sandbox.
 */
import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type CallToolResult, type McpTransport, type Tool as McpTool } from "@earendil-works/pi-mcp";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import type { ToolDetails } from "./tools/compact.ts";
import { allowlistedEnv } from "./env/local.ts";

/** A stdio server (Claude Code's `{command, args, env, cwd}`), or a streamable HTTP one (`{type: "http", url, headers}`). */
export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface McpToolHandle {
  server: string;
  /** The server's own tool name. */
  name: string;
  /** `<server>__<tool>`, restricted to [A-Za-z0-9_-] and 64 characters (the providers' tool-name rule). */
  qualified: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
  /** The result as MCP gives it, `{content, isError?, structuredContent?}` (what Codex's code mode returns to a cell). */
  callRaw(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
}

export interface McpSession {
  tools: McpToolHandle[];
  /** Servers that did not connect (only with `tolerant`): their tools are missing, the rest work. */
  failed: { server: string; error: string }[];
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The servers of a Claude Code-format MCP config file; a malformed file throws, naming what is wrong. */
export function readMcpConfig(path: string): Record<string, McpServerConfig> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const servers = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : undefined;
  if (servers === undefined) throw new Error(`${path}: want {"mcpServers": {"<name>": {"command": ...}}}`);
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(name)) throw new Error(`${path}: server name ${JSON.stringify(name)} must match [A-Za-z][A-Za-z0-9_-]{0,31}`);
    if (isRecord(value) && value.type === "http") {
      if (typeof value.url !== "string" || value.url === "") throw new Error(`${path}: server ${name}: an http server needs a "url"`);
      const headers = value.headers === undefined ? undefined : isRecord(value.headers) && Object.values(value.headers).every((item) => typeof item === "string") ? value.headers as Record<string, string> : null;
      if (headers === null) throw new Error(`${path}: server ${name}: "headers" must map names to strings`);
      out[name] = { type: "http", url: value.url, ...(headers === undefined ? {} : { headers }) };
      continue;
    }
    if (!isRecord(value) || typeof value.command !== "string" || value.command === "") throw new Error(`${path}: server ${name} needs a "command" (or "type": "http" and a "url")`);
    const args = value.args === undefined ? undefined : Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string") ? value.args as string[] : null;
    if (args === null) throw new Error(`${path}: server ${name}: "args" must be an array of strings`);
    const env = value.env === undefined ? undefined : isRecord(value.env) && Object.values(value.env).every((item) => typeof item === "string") ? value.env as Record<string, string> : null;
    if (env === null) throw new Error(`${path}: server ${name}: "env" must map names to strings`);
    if (value.cwd !== undefined && typeof value.cwd !== "string") throw new Error(`${path}: server ${name}: "cwd" must be a string`);
    out[name] = { command: value.command, ...(args === undefined ? {} : { args }), ...(env === undefined ? {} : { env }), ...(value.cwd === undefined ? {} : { cwd: value.cwd as string }) };
  }
  return out;
}

const qualify = (server: string, tool: string) => `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);

export interface ConnectMcpOptions {
  timeoutMs?: number;
  onStderr?: (server: string, chunk: string) => void;
  /** A server that fails to connect is skipped (named in `failed`) instead of failing the whole set. */
  tolerant?: boolean;
  /** The client name servers see (default caveman-harness). */
  clientName?: string;
  /** The fetch HTTP servers are reached with (default the global one). */
  fetch?: typeof fetch;
}

function transportOf(server: string, config: McpServerConfig, options: ConnectMcpOptions): McpTransport {
  if (config.type === "http") {
    return new StreamableHttpTransport({
      url: config.url, ...(config.headers === undefined ? {} : { headers: config.headers }), ...(options.fetch === undefined ? {} : { fetch: options.fetch as never }),
    } as ConstructorParameters<typeof StreamableHttpTransport>[0]);
  }
  // No ambient secrets: a server gets the host's allowlisted variables (PATH, HOME, LANG, ...; LocalEnv's list) and its
  // own config's env, never this process's whole environment (a provider key, a Cloud credential).
  return new StdioTransport({
    command: config.command, ...(config.args === undefined ? {} : { args: config.args }), ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    inheritEnv: false, env: { ...allowlistedEnv(process.platform, process.env), ...(config.env ?? {}) }, stderr: "pipe",
    ...(options.onStderr === undefined ? {} : { onStderr: (chunk: string) => options.onStderr!(server, chunk) }),
  });
}

/**
 * Connects every server and lists its tools, in server then tool name order (a byte-stable tool set). If a server fails
 * to start, the ones already up are closed and it throws; with `tolerant`, that server is skipped and named in `failed`.
 */
export async function connectMcp(servers: Record<string, McpServerConfig>, options: ConnectMcpOptions = {}): Promise<McpSession> {
  const clients: McpClient[] = [];
  const close = async () => {
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  };
  const tools: McpToolHandle[] = [];
  const failed: McpSession["failed"] = [];
  try {
    for (const [server, config] of Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const client = new McpClient({ name: options.clientName ?? "caveman-harness", version: "4", requestTimeoutMs: options.timeoutMs ?? 120_000 });
      let listed: McpTool[];
      try {
        await client.connect(transportOf(server, config, options));
        listed = await client.listTools();
      } catch (error) {
        await client.close().catch(() => undefined);
        if (options.tolerant !== true) throw error;
        failed.push({ server, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      clients.push(client);
      for (const tool of [...listed].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const qualified = qualify(server, tool.name);
        if (tools.some((other) => other.qualified === qualified)) throw new Error(`MCP tool name collision: ${qualified}`);
        tools.push({
          server, name: tool.name, qualified, description: tool.description ?? "",
          inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema as Record<string, unknown> : { type: "object", properties: {} },
          async call(args, signal) {
            const result = await client.callTool(tool.name, args, signal === undefined ? {} : { signal });
            const text = toLlmContent(result).map((item) => (item.type === "text" ? item.text : `[${item.type} omitted]`)).join("\n");
            return { text, isError: result.isError === true };
          },
          async callRaw(args, signal) {
            const result = await client.callTool(tool.name, args, signal === undefined ? {} : { signal });
            return { content: result.content, ...(result.isError === true ? { isError: true } : {}),
              ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) };
          },
        });
      }
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { tools, failed, close };
}

/** An MCP result's content as model content: text and images kept, anything else named. */
export function mcpContent(result: CallToolResult): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text") out.push({ type: "text", text: item.text });
    else if (item.type === "image") out.push({ type: "image", data: item.data, mimeType: item.mimeType });
    else out.push({ type: "text", text: `[${item.type} omitted]` });
  }
  if (out.length === 0 && result.structuredContent !== undefined) out.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  return out.length === 0 ? [{ type: "text", text: "" }] : out;
}

/**
 * loadout.mcp.exposure "direct": one model-visible tool per MCP tool, in name order (a byte-stable tool block). With
 * `images`, an image the tool answers with reaches the model as an image (a screenshot tool); else as text.
 */
export function mcpDirectTools(handles: readonly McpToolHandle[], options: { images?: boolean } = {}): AgentTool<TSchema, ToolDetails>[] {
  return handles.map((handle) => ({
    name: handle.qualified,
    label: handle.qualified,
    description: handle.description,
    parameters: handle.inputSchema as unknown as TSchema,
    async execute(_id: string, params: unknown, signal?: AbortSignal) {
      if (options.images === true) {
        const raw = await handle.callRaw(isRecord(params) ? params : {}, signal);
        const content = mcpContent(raw);
        if (raw.isError === true) throw new Error(content.map((part) => (part.type === "text" ? part.text : "")).join("\n") || `${handle.qualified} failed`);
        return { content, details: { truncated: false } };
      }
      const { text, isError } = await handle.call(isRecord(params) ? params : {}, signal);
      if (isError) throw new Error(text === "" ? `${handle.qualified} failed` : text);
      return { content: [{ type: "text" as const, text }], details: { truncated: false } };
    },
  }));
}
