/**
 * Guards for what an MCP server or its auth server sends back: fetch policy,
 * body caps, challenge origin, header syntax, and schemas that validators can
 * run on the main thread without stalling it.
 */
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { OAuthChallenge } from "@earendil-works/pi-mcp/oauth";
import type { Agent } from "undici";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** OAuth metadata, registration, and token responses are small JSON documents. */
const MAX_OAUTH_BODY_BYTES = 1024 * 1024;
/** Matches pi-mcp's default per-message cap. */
const MAX_TRANSPORT_BODY_BYTES = 16 * 1024 * 1024;

export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

const isLoopback = (url: URL): boolean => LOOPBACK_HOSTS.has(url.hostname);

export const secureUrl = (url: URL): boolean => url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url));

/** OAuth endpoints use https; loopback http only for a loopback MCP server (local development). */
export const oauthUrlAllowed = (url: URL, serverUrl: string): boolean =>
  url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url) && isLoopback(new URL(serverUrl)));

async function cappedBody(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`mcp_response_too_large:${maxBytes}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A loopback server (a host's own, like an app runtime's /mcp) may hold a call
 * open as long as its timeoutMs (a person answering, a subagent's wait), but
 * undici's 300 s header and body timeouts would cut it first. The client's
 * per-call timeout and abort signal bound those calls instead.
 * ponytail: remote servers keep the global dispatcher (and with it a host's
 * proxy), so a remote call still stops after 300 s without a byte.
 */
let untimedDispatcher: Promise<Agent> | undefined;
const loopbackDispatcher = () =>
  (untimedDispatcher ??= import("undici").then(({ Agent }) => new Agent({ headersTimeout: 0, bodyTimeout: 0 })));

/**
 * Fetch for MCP traffic: redirects are refused (configured headers and tokens
 * must not follow one to another origin or to http), bodies are size-capped
 * except successful event streams when `streams` is set (pi-mcp caps each
 * event), and only URLs that pass `allowed` are fetched.
 */
function guardedFetch(options: {
  readonly allowed: (url: URL) => boolean;
  readonly streams: boolean;
  readonly maxBodyBytes: number;
  readonly untimedLoopback?: boolean;
}): McpFetch {
  return async (input, init) => {
    const url = new URL(input);
    if (!options.allowed(url)) throw new Error(`mcp_fetch_insecure_url:${url.origin}`);
    const dispatcher = options.untimedLoopback === true && isLoopback(url) ? await loopbackDispatcher() : undefined;
    // `dispatcher` is Node's fetch extension (undici), absent from the DOM RequestInit type.
    const response = await globalThis.fetch(input, { ...init, redirect: "manual", ...(dispatcher === undefined ? {} : { dispatcher }) } as RequestInit);
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel().catch(() => undefined);
      const location = URL.canParse(response.headers.get("location") ?? "", url)
        ? new URL(response.headers.get("location")!, url) : undefined;
      throw new Error(`mcp_http_redirect_refused:${response.status}` +
        (location === undefined ? "" : `:${location.origin}${location.pathname}; use that URL in the config`));
    }
    const stream = options.streams && response.ok &&
      (response.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream");
    if (response.body === null || stream || [101, 204, 205, 304].includes(response.status)) return response;
    const { status, statusText, headers } = response;
    return new Response(await cappedBody(response.body, options.maxBodyBytes), { status, statusText, headers });
  };
}

/** Fetch for discovery, registration, and tokens of the MCP server at `serverUrl`. */
export const oauthFetch = (serverUrl: string): McpFetch => guardedFetch({
  allowed: (url) => oauthUrlAllowed(url, serverUrl),
  streams: false,
  maxBodyBytes: MAX_OAUTH_BODY_BYTES,
});
export const TRANSPORT_FETCH = guardedFetch({
  allowed: () => true,
  streams: true,
  maxBodyBytes: MAX_TRANSPORT_BODY_BYTES,
  untimedLoopback: true,
});

/** Only a same-origin `resource_metadata` from a 401 challenge is followed. */
export function trustedChallenge(challenge: OAuthChallenge, serverUrl: string): OAuthChallenge {
  if (challenge.resourceMetadataUrl === undefined ||
      challenge.resourceMetadataUrl.origin === new URL(serverUrl).origin) {
    return challenge;
  }
  const { resourceMetadataUrl: _dropped, ...rest } = challenge;
  return rest;
}

/** Keywords that can make a validator slow: regex backtracking and `$ref` graphs (2^n paths). */
const DROPPED_KEYWORDS = new Set([
  "pattern", "patternProperties", "$ref", "$dynamicRef", "$recursiveRef", "$defs", "definitions",
]);
/** Values that are data, not schemas. */
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
/** Objects keyed by property name, whose values are schemas or name lists. */
const NAMED_KEYWORDS = new Set(["properties", "dependentSchemas", "dependencies", "dependentRequired"]);
/** Each member is checked per value, so wide unions multiply with argument size. */
const COMBINATORS = ["anyOf", "oneOf", "allOf"] as const;
const MAX_COMBINATOR_MEMBERS = 32;
const MAX_TOTAL_COMBINATOR_MEMBERS = 128;

/**
 * Server schemas run through validators on the main thread, so drop what can
 * make them slow (the server validates its own input): regex and `$ref`
 * keywords, duplicate `type` list members, and wide unions, which become `{}`.
 * Property names, including `pattern`, are kept.
 */
export function sanitizeServerSchema(value: unknown): unknown {
  const budget = { members: 0 };
  const output = stripSchema(value, budget);
  return budget.members > MAX_TOTAL_COMBINATOR_MEMBERS || schemaFanout(output) > MAX_COMBINATOR_MEMBERS ? {} : output;
}

/**
 * Largest product of `anyOf`/`oneOf`/`allOf` widths along one schema path: how
 * often one argument value can be re-checked. Validation work grows with
 * argument size times this, so MCP argument limits divide by it.
 */
export function schemaFanout(schema: unknown): number {
  if (Array.isArray(schema)) return schema.reduce((max: number, item) => Math.max(max, schemaFanout(item)), 1);
  if (schema === null || typeof schema !== "object") return 1;
  let max = 1;
  for (const [key, child] of Object.entries(schema)) {
    if (DATA_KEYWORDS.has(key)) continue;
    const width = (COMBINATORS as readonly string[]).includes(key) && Array.isArray(child) ? child.length : 1;
    const named = NAMED_KEYWORDS.has(key) && child !== null && typeof child === "object" && !Array.isArray(child);
    max = Math.max(max, width * schemaFanout(named ? Object.values(child) : child));
  }
  return max;
}

function stripSchema(value: unknown, budget: { members: number }): unknown {
  if (Array.isArray(value)) return value.map((item) => stripSchema(item, budget));
  if (value === null || typeof value !== "object") return value;
  for (const key of COMBINATORS) {
    const members = (value as Record<string, unknown>)[key];
    if (!Array.isArray(members)) continue;
    if (members.length > MAX_COMBINATOR_MEMBERS) return {};
    budget.members += members.length;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (DATA_KEYWORDS.has(key)) {
      output[key] = child;
    } else if (key === "type" && Array.isArray(child)) {
      const types = [...new Set(child)].filter((type) => !(type === "integer" && child.includes("number")));
      output.type = types.length === 1 ? types[0] : types;
    } else if (NAMED_KEYWORDS.has(key) && child !== null && typeof child === "object" && !Array.isArray(child)) {
      output[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, stripSchema(schema, budget)]));
    } else {
      output[key] = stripSchema(child, budget);
    }
  }
  return output;
}
