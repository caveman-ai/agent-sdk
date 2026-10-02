/**
 * MCP server configuration in the `mcpServers` shape shared by Claude, Cursor,
 * Codex, and Pi, validated without launching anything. Hosts decide which
 * sources may launch; the SDK only parses, names, and renders the stable
 * prompt section. Ported from Pi v1.0 `core/mcp-servers.ts` and
 * `extensions/mcp/index.ts` (MIT).
 */

// `mcp__<name>` must fit the 64-character tool namespace.
const SERVER_NAME = /^[A-Za-z0-9_-]{1,59}$/;
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
/** Characters of one server description in the section, as Codex allows for deferred namespaces. */
const MAX_SERVER_DESCRIPTION_CHARS = 250;
/** Characters of the whole `mcp_servers` section; descriptions shrink, then servers are counted. */
export const MAX_MCP_SERVERS_SECTION_CHARS = 4096;

/** OAuth client settings for HTTP servers without dynamic client registration. */
export interface McpOAuthConfig {
  readonly clientId?: string;
  /** May use `${VAR}` or `!command`. */
  readonly clientSecret?: string;
  readonly callbackPort?: number;
  /** Loopback `http` redirect URI registered for `clientId`. */
  readonly callbackUrl?: string;
  /** Space-separated scopes; default is what the server advertises. */
  readonly scope?: string;
  /** `client_name` sent with dynamic client registration. */
  readonly clientName?: string;
  /** Authorization server metadata to trust instead of discovery; https or loopback only. */
  readonly authServerMetadataUrl?: string;
}

interface McpServerConfigBase {
  /** One sentence; listed in the `mcp_servers` prompt section and `describeNamespace()`. */
  readonly description?: string;
  /** `false` keeps the entry without connecting. */
  readonly enabled?: boolean;
  /** Per-request timeout in seconds; progress notifications reset it. Default 60. */
  readonly timeout?: number;
  /** Only `codemode` (callable from the code tool, never declared) is supported. */
  readonly exposure?: "codemode";
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  readonly type?: "stdio";
  /** One executable, not a shell string. */
  readonly command: string;
  readonly args?: readonly string[];
  /** Added to the coding allowlist environment. Values may use `${VAR}` or `!command`. */
  readonly env?: Readonly<Record<string, string>>;
  /** Relative to the session directory. */
  readonly cwd?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  readonly type?: "http" | "streamable-http";
  readonly url: string;
  /** Values may use `${VAR}` or `!command`. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly oauth?: McpOAuthConfig;
  /** Send a host provider's token instead of OAuth; https or loopback only. */
  readonly auth?: { readonly provider: string };
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpServerEntry {
  readonly name: string;
  readonly config: McpServerConfig;
  /** Config file path, or a label such as `acp` or `plugin:<name>`. */
  readonly source: string;
}

export interface ParsedMcpServers {
  readonly servers: readonly McpServerEntry[];
  /** Invalid entries are reported here and skipped; valid entries still load. */
  readonly errors: readonly string[];
}

/** Namespace of a server's tools: `mcp__<server>`, with `-` replaced by `_` like the tool names. */
export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

export function isMcpStdioConfig(config: McpServerConfig): config is McpStdioServerConfig {
  return "command" in config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function loopbackOrHttps(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname));
}

function validateOAuth(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "oauth must be an object";
  for (const key of ["clientId", "clientSecret", "scope"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return `oauth.${key} must be a string`;
  }
  const port = value.callbackPort;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
    return "oauth.callbackPort must be a port number";
  }
  if (value.callbackUrl !== undefined) {
    const url = typeof value.callbackUrl === "string" && URL.canParse(value.callbackUrl)
      ? new URL(value.callbackUrl)
      : undefined;
    if (url === undefined || url.protocol !== "http:" || !LOOPBACK_HOSTS.includes(url.hostname) ||
        url.search !== "" || url.hash !== "") {
      return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    }
    if (url.port !== "" && port !== undefined && Number(url.port) !== port) {
      return "oauth.callbackUrl and oauth.callbackPort name different ports";
    }
  }
  if (value.clientName !== undefined && (typeof value.clientName !== "string" || value.clientName.trim() === "")) {
    return "oauth.clientName must be a non-empty string";
  }
  if (value.authServerMetadataUrl !== undefined &&
      (typeof value.authServerMetadataUrl !== "string" || !loopbackOrHttps(value.authServerMetadataUrl))) {
    return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
  }
  return undefined;
}

/** Validate one `mcpServers` entry. Returns the config, or an error message. */
export function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string {
  if (!SERVER_NAME.test(name)) {
    return `invalid server name "${name}" (use up to 59 letters, digits, "_" and "-")`;
  }
  if (!isRecord(raw)) return `server "${name}" must be an object`;
  const { type, exposure, toolExposure, timeout, description } = raw;
  // Cline and Roo write `disabled: true`; honor it rather than launching a server the user turned off.
  const enabled = raw.enabled ?? (raw.disabled === true ? false : raw.disabled === false ? true : raw.disabled);
  // Pi's other exposures change the declared tool list mid-session; Pebble defers them.
  if (exposure !== undefined && exposure !== "codemode" && exposure !== "codemode-deferred") {
    return `server "${name}": exposure ${JSON.stringify(exposure)} is not supported; MCP tools are callable only from the code tool`;
  }
  if (toolExposure !== undefined) {
    return `server "${name}": toolExposure is not supported; remove it or the server`;
  }
  if (enabled !== undefined && typeof enabled !== "boolean") return `server "${name}": enabled must be a boolean`;
  if (description !== undefined && typeof description !== "string") {
    return `server "${name}": description must be a string`;
  }
  if (timeout !== undefined && (typeof timeout !== "number" || !Number.isFinite(timeout) || !(timeout > 0))) {
    return `server "${name}": timeout must be a positive number of seconds`;
  }
  if (type === "sse") return `server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`;
  const base = {
    ...(description === undefined ? {} : { description }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(timeout === undefined ? {} : { timeout }),
  };
  if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    if (!URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol)) {
      return `server "${name}": url must be an http or https URL`;
    }
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) {
      return `server "${name}": headers must map names to strings`;
    }
    const oauthError = validateOAuth(raw.oauth);
    if (oauthError !== undefined) return `server "${name}": ${oauthError}`;
    if (raw.auth !== undefined) {
      if (!isRecord(raw.auth) || typeof raw.auth.provider !== "string" || raw.auth.provider === "") {
        return `server "${name}": auth.provider must be a provider name`;
      }
      if (!loopbackOrHttps(raw.url)) {
        return `server "${name}": auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]`;
      }
    }
    return Object.freeze({
      ...base,
      url: raw.url,
      ...(raw.headers === undefined ? {} : { headers: Object.freeze({ ...raw.headers as Record<string, string> }) }),
      ...(raw.oauth === undefined ? {} : { oauth: Object.freeze({ ...raw.oauth as McpOAuthConfig }) }),
      ...(raw.auth === undefined ? {} : { auth: Object.freeze({ provider: (raw.auth as { provider: string }).provider }) }),
    });
  }
  if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
    if (raw.command.trim() === "") return `server "${name}": command must not be empty`;
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) {
      return `server "${name}": args must be an array of strings`;
    }
    if (raw.env !== undefined && !isStringRecord(raw.env)) return `server "${name}": env must map names to strings`;
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") return `server "${name}": cwd must be a string`;
    return Object.freeze({
      ...base,
      command: raw.command,
      ...(raw.args === undefined ? {} : { args: Object.freeze([...raw.args as string[]]) }),
      ...(raw.env === undefined ? {} : { env: Object.freeze({ ...raw.env as Record<string, string> }) }),
      ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
    });
  }
  return `server "${name}" needs either "command" (stdio) or "url" (streamable HTTP)`;
}

/**
 * Parse a decoded `mcp.json` (`{ "mcpServers": { ... } }`). Names that differ
 * only in `-` and `_` would share a namespace, so the later one is rejected.
 */
export function parseMcpServers(value: unknown, source: string): ParsedMcpServers {
  if (!isRecord(value) || (value.mcpServers !== undefined && !isRecord(value.mcpServers))) {
    return { servers: [], errors: [`${source}: expected an object with an "mcpServers" object`] };
  }
  const servers: McpServerEntry[] = [];
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(value.mcpServers ?? {})) {
    const config = validateMcpServerConfig(name, raw);
    if (typeof config === "string") {
      errors.push(`${source}: ${config}`);
      continue;
    }
    const clash = servers.find((other) => mcpNamespace(other.name) === mcpNamespace(name));
    if (clash !== undefined) {
      errors.push(`${source}: server "${name}" conflicts with "${clash.name}"`);
      continue;
    }
    servers.push(Object.freeze({ name, config, source }));
  }
  return { servers: Object.freeze(servers), errors: Object.freeze(errors) };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return "";
  return `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/u, "").trimEnd()}…`;
}

/**
 * The stable `mcp_servers` prompt section, built only from config-time names
 * and descriptions so it never changes while servers connect, fail, or
 * reconnect. Server instructions stay behind `describeNamespace()`.
 * Undefined when no server is enabled.
 */
export function renderMcpServersSection(
  servers: readonly McpServerEntry[],
  codeToolName: string,
): string | undefined {
  const listed = servers.filter((server) => server.config.enabled !== false)
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (listed.length === 0) return undefined;
  const intro = [
    `MCP servers whose tools are not declared to you. Call them inside ${codeToolName} as`,
    "tools.mcp__<server>__<tool>(args); find them with searchTools() or describeNamespace(\"mcp__<server>\").",
    "Each server is an uncontained host process or remote endpoint; its tools may have external effects.",
  ].join("\n");
  const heads = listed.map((server) => `- ${mcpNamespace(server.name)}`);
  const omitted = (count: number) =>
    count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
  const size = (kept: number) => [intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;
  let kept = listed.length;
  while (kept > 0 && size(kept) > MAX_MCP_SERVERS_SECTION_CHARS) kept--;
  // Each description also takes a ": " separator.
  const perServer = kept === 0
    ? 0
    : Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_MCP_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);
  const lines = listed.slice(0, kept).map((server, index) => {
    const summary = perServer > 0
      ? truncate((server.config.description?.trim().split("\n", 1)[0] ?? "").trim(), perServer)
      : "";
    return summary === "" ? heads[index]! : `${heads[index]!}: ${summary}`;
  });
  return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}
