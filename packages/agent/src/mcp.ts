/**
 * MCP client adapter: connects configured servers through `@earendil-works/pi-mcp`
 * and registers their tools as nested code-tool functions under one namespace
 * per server. Tools are never declared to the model, so the provider-visible
 * prefix stays byte-stable while servers connect, fail, or reconnect. Follows
 * Pi v1.0 `extensions/mcp/{runtime,tools,oauth}.ts` (MIT) with these product
 * rules: stdio servers never inherit the ambient environment, every call is a
 * kernel-dispatched nested call that is never retried or speculated, and
 * missing annotations mean the call is effectful.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  McpAuthRequiredError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpSessionExpiredError,
  McpTimeoutError,
  StdioTransport,
  StreamableHttpTransport,
  type AuthProvider,
  type CallToolResult,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  parseWwwAuthenticate,
  stepUpScope,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthChallenge,
  type OAuthClientInformationMixed,
} from "@earendil-works/pi-mcp/oauth";
import { buildCodingProcessEnv } from "./coding-backend.js";
import {
  HEADER_NAME,
  HEADER_VALUE,
  oauthFetch,
  oauthUrlAllowed,
  sanitizeServerSchema,
  secureUrl,
  TRANSPORT_FETCH,
  trustedChallenge,
} from "./mcp-guards.js";
import { tool, type ToolDefinition } from "./primitives.js";
import type { ProgrammaticToolNamespace } from "./programmatic-catalog.js";
import {
  isMcpStdioConfig,
  mcpNamespace,
  type McpOAuthConfig,
  type McpServerEntry,
} from "./mcp-config.js";

export * from "./mcp-config.js";
export type { McpOAuthState, McpOAuthStateStore } from "@earendil-works/pi-mcp/oauth";

const DEFAULT_TIMEOUT_SECONDS = 60;
const STDERR_TAIL_CHARS = 2_000;
/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
// ponytail: one fixed wait; per-server startup budgets if slow `npx` servers need more.
/** A cell that names a still-connecting server waits at most this long before it runs. */
const CELL_WAIT_MS = 15_000;
const DISCOVERY = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;
const TOOL_IMPLEMENTATION_SOURCE = Symbol.for("@caveman-ai/agent:tool-implementation-source");

/** `disconnected`: the connection dropped; the next call reconnects. */
export type McpServerState =
  | "idle" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "disabled" | "closed";

export interface McpServerStatus {
  readonly name: string;
  readonly source: string;
  readonly transport: "stdio" | "http";
  /** Stdio servers are uncontained host processes; HTTP servers are remote endpoints. */
  readonly containment: "uncontained host process" | "remote endpoint";
  readonly state: McpServerState;
  readonly tools: number;
  readonly error?: string;
}

/** Which server tool a nested tool name calls, for receipts. */
export interface McpToolOwner {
  readonly server: string;
  readonly tool: string;
}

export interface McpSignInPrompt {
  /** Show the authorization URL (and open a browser if the host can). */
  showAuthorizationUrl(url: URL): void;
}

export interface McpValueContext {
  readonly server: McpServerEntry;
  /** For messages, for example `env TOKEN` or `arg 2`. */
  readonly field: string;
  /** Whether a leading `!` runs a command; false for command, args, cwd, and url. */
  readonly commands: boolean;
}

export interface McpHostOptions {
  readonly servers: readonly McpServerEntry[];
  /** Session workspace, advertised to servers as the MCP root. Stdio servers never run in it. */
  readonly cwd: string;
  /** Usually `ProgrammaticToolRuntime.registerNestedTools`. */
  readonly register: (tools: readonly ToolDefinition[], namespace: ProgrammaticToolNamespace) => void;
  /**
   * Resolves `${VAR}` everywhere and whole-value `!command` where `commands`
   * is true (env, headers, oauth.clientSecret). Without it such values fail closed.
   */
  readonly resolveValue?: (value: string, context: McpValueContext) => Promise<string>;
  /** OAuth state keyed by server name and URL. Without it OAuth servers stay `needs-auth`. */
  readonly oauthStore?: (server: string, url: string) => McpOAuthStateStore;
  /** Token for `auth.provider` servers. */
  readonly providerToken?: (provider: string) => Promise<string | undefined>;
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Appended to sign-in errors, for example the host's login command. */
  readonly signInHint?: (server: string) => string;
  /** Called when a server's state, error, or tool count changes. */
  readonly onChange?: (status: McpServerStatus) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

/**
 * `mcp__<server>__<tool>` with everything but `[A-Za-z0-9_]` replaced by `_`,
 * so the name is also a script identifier. Too-long or colliding names get a
 * hash suffix, like Pi and Codex.
 */
export function createMcpToolName(
  server: string,
  toolName: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = `mcp__${server}__${toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash("sha256").update(`${server}\0${toolName}`).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** Scripts receive the whole `CallToolResult` without `_meta`. */
const RESULT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    content: { type: "array", items: { type: "object" } },
    structuredContent: { type: "object" },
    isError: { type: "boolean" },
  },
  required: ["content"],
});

/** A server tool the provider sees as a declared tool, with the host's declaration. */
export interface McpDirectTool {
  readonly server: string;
  /** The server's own tool name. */
  readonly tool: string;
  readonly description: string;
  /** JSON Schema of the arguments, as the server lists them. */
  readonly input: Record<string, unknown>;
  /** How long one call waits for the server's answer. Defaults to the server's `timeout`. */
  readonly timeoutMs?: number;
}

function createMcpToolDefinition(
  connection: McpConnection,
  mcpTool: McpTool,
  name: string,
  timeoutMs = connection.timeoutMs,
): ToolDefinition {
  const server = connection.entry.name;
  const hints = mcpTool.annotations;
  const schema = sanitizeServerSchema(mcpTool.inputSchema) as Record<string, unknown>;
  const input = {
    ...schema,
    type: schema.type ?? "object",
    ...(schema.properties === undefined ? { properties: {} } : {}),
  };
  const title = mcpTool.title ?? hints?.title;
  const options = {
    name,
    description: mcpTool.description?.trim() || title || `MCP tool ${mcpTool.name} from server ${server}`,
    input,
    output: RESULT_SCHEMA,
    // Server schemas are plain JSON checked by the pinned validator; the digest
    // lets locked/durable gates accept `format` keywords in them.
    schemaSemanticsSHA256: createHash("sha256")
      .update(JSON.stringify({ server, tool: mcpTool.name, input })).digest("hex"),
    // Server annotations are untrusted and never relax admission: "external"
    // is serialized, never speculated, and never re-run on durable resume.
    effect: "external",
    result: "inline",
    timeoutMs: timeoutMs + 5_000,
    [TOOL_IMPLEMENTATION_SOURCE]: `mcp:${server}/${mcpTool.name}`,
    execute: (args: Record<string, unknown>, signal?: AbortSignal) =>
      connection.call(mcpTool.name, name, args, signal, timeoutMs),
  };
  return tool(options as unknown as Parameters<typeof tool>[0]) as ToolDefinition;
}

interface OAuthSettings {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackPort?: number;
  readonly callbackUrl?: string;
  readonly scope?: string;
  readonly clientName?: string;
  readonly authServerMetadataUrl?: URL;
}

function callbackSettings(settings: OAuthSettings): {
  host: string;
  redirectHost: string;
  port: number | undefined;
  path: string;
  fixedRedirectUrl: string | undefined;
} {
  const url = new URL(settings.callbackUrl ?? FALLBACK_REDIRECT_URL);
  const address = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port ? Number(url.port) : settings.callbackPort;
  let fixedRedirectUrl: string | undefined;
  if (url.port) fixedRedirectUrl = settings.callbackUrl;
  else if (port !== undefined) {
    url.port = String(port);
    fixedRedirectUrl = url.href;
  }
  return {
    host: address === "localhost" ? CALLBACK_HOST : address,
    redirectHost: address,
    port,
    path: url.pathname,
    fixedRedirectUrl,
  };
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
  return client !== undefined && "redirect_uris" in client ? client.redirect_uris : [];
}

function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
  const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))];
  return merged.length > 0 ? merged.join(" ") : undefined;
}

function oauthProvider(
  serverUrl: string,
  store: McpOAuthStateStore,
  settings: OAuthSettings,
  clientName: string,
  redirectUrl: string,
  onRedirect: (url: URL) => void,
  Provider: typeof McpOAuthProvider = McpOAuthProvider,
): McpOAuthProvider {
  return new Provider({
    serverUrl,
    redirectUrl,
    clientMetadata: { client_name: settings.clientName ?? clientName },
    ...(settings.clientId === undefined ? {} : { clientId: settings.clientId }),
    ...(settings.clientSecret === undefined ? {} : { clientSecret: settings.clientSecret }),
    store,
    onRedirect,
  });
}

/**
 * Background refreshes may only rotate tokens: anything that would start an
 * authorization (new verifier, state, client registration) or discard the
 * registered client means the user has to sign in instead.
 */
class RefreshOnlyProvider extends McpOAuthProvider {
  override async state(): Promise<string> {
    throw new McpOAuthAuthorizationRequiredError();
  }

  override async saveCodeVerifier(): Promise<void> {
    throw new McpOAuthAuthorizationRequiredError();
  }

  override async saveClientInformation(): Promise<void> {
    throw new McpOAuthAuthorizationRequiredError();
  }

  override async invalidateCredentials(kind: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (kind === "tokens") await super.invalidateCredentials(kind);
  }
}

/**
 * Connections never start a browser flow: they send the stored token and,
 * after a 401, try the stored refresh token. Otherwise they fail with
 * `McpOAuthAuthorizationRequiredError` and the user signs in explicitly. A
 * request for more scope (`insufficient_scope`) always needs a new sign-in.
 */
function connectionAuth(
  serverUrl: string,
  store: McpOAuthStateStore,
  settings: () => Promise<OAuthSettings>,
  clientName: string,
  onChallenge: (challenge: OAuthChallenge) => void,
): AuthProvider {
  let refreshing: Promise<void> | undefined;
  const refresh = (stale: string | undefined, challenge?: OAuthChallenge): Promise<void> =>
    refreshing ??= (async () => {
      const state = await store.load();
      if (state?.tokens?.access_token !== stale) return;
      if (state?.tokens?.refresh_token === undefined) throw new McpOAuthAuthorizationRequiredError();
      const resolved = await settings();
      const redirectUrl = callbackSettings(resolved).fixedRedirectUrl ??
        registeredRedirectUrls(state.clientInformation)[0] ?? FALLBACK_REDIRECT_URL;
      const provider = oauthProvider(serverUrl, store, resolved, clientName, redirectUrl, () => {}, RefreshOnlyProvider);
      const result = await authorizeMcp(provider, {
        serverUrl,
        ...(challenge?.resourceMetadataUrl === undefined ? {} : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
        ...(resolved.authServerMetadataUrl === undefined
          ? {}
          : { authorizationServerMetadataUrl: resolved.authServerMetadataUrl }),
        ...(challenge?.scope === undefined ? {} : { scope: challenge.scope }),
        fetch: oauthFetch(serverUrl),
      });
      if (result === "REDIRECT") throw new McpOAuthAuthorizationRequiredError();
    })().finally(() => {
      refreshing = undefined;
    });
  return {
    async token() {
      await refreshing?.catch(() => undefined);
      // An unreadable store means no token; the server's 401 (if any) decides.
      const state = await Promise.resolve(store.load()).catch(() => undefined);
      const token = state?.tokens?.access_token;
      const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
      if (!expired || state?.tokens?.refresh_token === undefined) return token;
      // A failed refresh sends the old token; the 401 decides.
      await refresh(token).catch(() => undefined);
      return (await store.load())?.tokens?.access_token;
    },
    async onUnauthorized(context) {
      const challenge = trustedChallenge(parseWwwAuthenticate(context.response.headers.get("www-authenticate")), serverUrl);
      onChallenge(challenge);
      if (challenge.error === "insufficient_scope") {
        // Remember the requested scope so a later sign-in (another process) can step up.
        const state = await store.load();
        if (state !== undefined && challenge.scope !== undefined) await store.save({ ...state, stepUpScope: challenge.scope } as McpOAuthState);
        throw new McpOAuthAuthorizationRequiredError();
      }
      await refresh(context.token, challenge);
    },
  };
}

async function signInMcpServer(options: {
  readonly serverUrl: string;
  readonly store: McpOAuthStateStore;
  readonly settings: OAuthSettings;
  readonly clientName: string;
  readonly challenge: OAuthChallenge | undefined;
  readonly prompt: McpSignInPrompt;
}): Promise<void> {
  const { serverUrl, store, settings } = options;
  const stored = await store.load();
  const pending = (stored as { stepUpScope?: unknown } | undefined)?.stepUpScope;
  const given = options.challenge === undefined ? undefined : trustedChallenge(options.challenge, serverUrl);
  const challenge: OAuthChallenge | undefined = given?.error === "insufficient_scope" || typeof pending !== "string"
    ? given
    : { ...given, error: "insufficient_scope", scope: pending };
  const stepUp = challenge?.error === "insufficient_scope";
  const callback = callbackSettings(settings);
  // Reuse the registered redirect port so a registered client stays valid.
  const registered = registeredRedirectUrls(stored?.clientInformation)[0];
  const port = callback.port ?? (registered === undefined ? undefined : Number(new URL(registered).port) || undefined);
  const listen = (selected: number | undefined) => OAuthCallbackServer.listen({
    host: callback.host,
    redirectHost: callback.redirectHost,
    path: callback.path,
    port: selected ?? 0,
  });
  const server = await listen(port).catch((error: unknown) => {
    if (callback.port !== undefined || port === undefined) throw error;
    return listen(undefined);
  });
  const redirectUrl = callback.fixedRedirectUrl ?? server.redirectUrl;
  try {
    if (stored !== undefined) {
      const next: McpOAuthState & { stepUpScope?: string } = { ...stored };
      delete next.oauthState;
      delete next.stepUpScope;
      // A registered client cannot use another redirect URI, and its tokens belong to it.
      if (settings.clientId === undefined && !registeredRedirectUrls(stored.clientInformation).includes(redirectUrl)) {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      await store.save(next);
    }
    let authorizationUrl: URL | undefined;
    const provider = oauthProvider(serverUrl, store, settings, options.clientName, redirectUrl, (url) => {
      authorizationUrl = url;
    });
    // Step-up keeps the granted scope: the challenge may list only the missing scopes.
    const scope = mergeScopes(
      settings.scope,
      stepUp ? stepUpScope(stored?.tokens?.scope, challenge?.scope) : challenge?.scope,
    );
    const flow = {
      serverUrl,
      ...(challenge?.resourceMetadataUrl === undefined
        ? {}
        : { resourceMetadataUrl: challenge.resourceMetadataUrl }),
      ...(settings.authServerMetadataUrl === undefined
        ? {}
        : { authorizationServerMetadataUrl: settings.authServerMetadataUrl }),
      ...(scope === undefined ? {} : { scope }),
    };
    if (await authorizeMcp(provider, { ...flow, skipRefresh: stepUp, fetch: oauthFetch(serverUrl) }) === "AUTHORIZED") return;
    if (authorizationUrl === undefined) throw new Error("mcp_oauth_authorization_url_missing");
    // pi-mcp does not check the scheme of the endpoint the user is sent to.
    if (!oauthUrlAllowed(authorizationUrl, serverUrl)) throw new Error(`mcp_oauth_authorization_endpoint_insecure:${authorizationUrl.origin}`);
    const state = await provider.state();
    options.prompt.showAuthorizationUrl(authorizationUrl);
    const { code, iss } = await server.waitForCallback(state);
    // RFC 9207: authorizeMcp rejects an `iss` that is not the discovered issuer.
    await authorizeMcp(provider, {
      ...flow,
      authorizationCode: code,
      ...(iss === undefined ? {} : { iss }),
      fetch: oauthFetch(serverUrl),
    });
  } finally {
    await server.close();
  }
}

/** One configured server. Reconnects lazily when a call finds the connection gone. */
class McpConnection {
  readonly entry: McpServerEntry;
  state: McpServerState = "idle";
  error: string | undefined;
  tools: readonly McpTool[] = [];
  instructions: string | undefined;
  challenge: OAuthChallenge | undefined;
  #client: McpClient | undefined;
  /** Client of the connect in flight, so `close()` can abort it. */
  #connecting: McpClient | undefined;
  #opening: Promise<McpClient> | undefined;
  #closed = false;
  #stderrTail: string | undefined;
  readonly #host: McpHost;
  readonly #options: McpHostOptions;
  #auth: AuthProvider | undefined;
  #url: string | undefined;
  /** Clients this connection closed on purpose; their close is not a crash. */
  readonly #closing = new WeakSet<McpClient>();

  constructor(entry: McpServerEntry, host: McpHost, options: McpHostOptions) {
    this.entry = entry;
    this.#host = host;
    this.#options = options;
    if (entry.config.enabled === false) this.state = "disabled";
    const provider = !isMcpStdioConfig(entry.config) ? entry.config.auth?.provider : undefined;
    if (provider !== undefined) this.#auth = { token: async () => options.providerToken?.(provider) };
  }

  /** The server URL with `${VAR}` resolved; OAuth discovery and the token store key use it. */
  async url(): Promise<string> {
    const { config } = this.entry;
    if (isMcpStdioConfig(config)) throw new Error(`mcp_server_not_http:${this.name}`);
    this.#url ??= await this.#resolve(config.url, "url", false);
    if (!URL.canParse(this.#url) || !/^https?:$/.test(new URL(this.#url).protocol)) {
      throw new Error(`mcp_server_url_invalid:${this.name}`);
    }
    // Config checks the raw URL; a `${VAR}` could still resolve to a remote http host.
    if (config.auth !== undefined && !secureUrl(new URL(this.#url))) throw new Error(`mcp_server_url_insecure:${this.name}`);
    return this.#url;
  }

  #authFor(url: string): AuthProvider | undefined {
    if (this.#auth !== undefined || !this.usesOAuth || this.#options.oauthStore === undefined) return this.#auth;
    this.#auth = connectionAuth(
      url,
      this.#options.oauthStore(this.name, url),
      () => this.oauthSettings(),
      this.#options.clientName ?? "caveman-agent",
      (challenge) => {
        this.challenge = challenge;
      },
    );
    return this.#auth;
  }

  get name(): string {
    return this.entry.name;
  }

  get timeoutMs(): number {
    return Math.round((this.entry.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000);
  }

  get opening(): Promise<McpClient> | undefined {
    return this.#opening;
  }

  /** HTTP servers use OAuth unless the config supplies `auth` or an Authorization header. */
  get usesOAuth(): boolean {
    const { config } = this.entry;
    if (isMcpStdioConfig(config) || config.auth !== undefined) return false;
    return !Object.keys(config.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
  }

  status(): McpServerStatus {
    const stdio = isMcpStdioConfig(this.entry.config);
    return Object.freeze({
      name: this.entry.name,
      source: this.entry.source,
      transport: stdio ? "stdio" : "http",
      containment: stdio ? "uncontained host process" : "remote endpoint",
      state: this.state,
      tools: this.tools.length,
      ...(this.error === undefined ? {} : { error: this.error }),
    });
  }

  async oauthSettings(): Promise<OAuthSettings> {
    const oauth: McpOAuthConfig | undefined = isMcpStdioConfig(this.entry.config) ? undefined : this.entry.config.oauth;
    if (oauth === undefined) return {};
    return {
      ...(oauth.clientId === undefined ? {} : { clientId: oauth.clientId }),
      ...(oauth.clientSecret === undefined
        ? {}
        : { clientSecret: await this.#resolve(oauth.clientSecret, "oauth.clientSecret") }),
      ...(oauth.callbackPort === undefined ? {} : { callbackPort: oauth.callbackPort }),
      ...(oauth.callbackUrl === undefined ? {} : { callbackUrl: oauth.callbackUrl }),
      ...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
      ...(oauth.clientName === undefined ? {} : { clientName: oauth.clientName }),
      ...(oauth.authServerMetadataUrl === undefined
        ? {}
        : { authServerMetadataUrl: new URL(oauth.authServerMetadataUrl) }),
    };
  }

  getClient(): Promise<McpClient> {
    if (this.#closed) return Promise.reject(new Error(`mcp_server_closed:${this.name}`));
    if (this.state === "disabled") return Promise.reject(new Error(`mcp_server_disabled:${this.name}`));
    if (this.#client?.connectionState === "connected") return Promise.resolve(this.#client);
    this.#opening ??= this.#open().finally(() => {
      this.#opening = undefined;
    });
    return this.#opening;
  }

  /** One server call. Never retried: the server may already have acted. */
  async call(
    toolName: string,
    nestedName: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
    timeoutMs = this.timeoutMs,
  ): Promise<Omit<CallToolResult, "_meta">> {
    const label = `${this.name}/${toolName}`;
    this.#host.recordCall(nestedName, this.name, toolName);
    let client: McpClient;
    try {
      client = await this.getClient();
    } catch (error) {
      throw new Error(`mcp_server_unavailable:${label}: ${errorMessage(error)}. The call was not sent.`);
    }
    try {
      const { _meta: _ignored, ...result } = await client.callTool(toolName, args, {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
      });
      if (result.isError === true) this.#host.recordError(nestedName);
      return result;
    } catch (error) {
      if (this.#needsSignIn(error)) {
        await this.#drop(client);
        this.#markNeedsAuth();
        throw new Error(`mcp_server_needs_auth:${label}: ${this.#signInMessage()}`);
      }
      if (error instanceof McpConnectionClosedError) {
        const stderr = this.#stderrTail === undefined ? "" : ` Server stderr: ${this.#stderrTail}`;
        throw new Error(
          `mcp_server_disconnected:${label}: the server closed the connection during the call.${stderr} ` +
          "The next call reconnects; check whether this call took effect before repeating it.",
        );
      }
      if (error instanceof McpSessionExpiredError) {
        // The server forgot the session and did not run the call; reconnect on the next one.
        await this.#drop(client);
        this.state = "disconnected";
        this.error = "HTTP session expired";
        this.#changed();
        throw new Error(`mcp_server_session_expired:${label}: the call was not run. The next call reconnects.`);
      }
      if (error instanceof McpTimeoutError) {
        throw new Error(
          `mcp_tool_timeout:${label}: no answer within ${timeoutMs} ms; the call may still have run on the server.`,
        );
      }
      // pi-mcp synthesizes this when an HTTP response stream breaks mid-call.
      if (error instanceof McpError && error.message.startsWith("MCP response stream failed")) {
        throw new Error(
          `mcp_tool_outcome_unknown:${label}: ${error.message}; the call may still have run, check before repeating it.`,
        );
      }
      if (error instanceof McpError) throw new Error(`mcp_tool_error:${label}: ${error.message}`);
      // The request may have reached the server (reset, 5xx, oversized answer, abort).
      throw new Error(
        `mcp_tool_outcome_unknown:${label}: ${errorMessage(error)}; the call may still have run, check before repeating it.`,
      );
    }
  }

  async reconnect(): Promise<void> {
    await this.#opening?.catch(() => undefined);
    if (this.#client !== undefined) await this.#drop(this.#client);
    await this.getClient();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.state = "closed";
    const client = this.#client;
    this.#client = undefined;
    const opening = this.#opening;
    // Closing the in-flight client rejects its initialize at once.
    for (const pending of [client, this.#connecting]) if (pending !== undefined) this.#closing.add(pending);
    await Promise.all([client?.close(), this.#connecting?.close()].map((done) => done?.catch(() => undefined)));
    await opening?.catch(() => undefined);
  }

  async #resolve(value: string, field: string, commands = true): Promise<string> {
    if (!value.includes("${") && !(commands && value.startsWith("!"))) return value;
    const resolver = this.#options.resolveValue;
    if (resolver === undefined) throw new Error(`mcp_config_value_unresolved:${this.name}:${field}`);
    return resolver(value, { server: this.entry, field, commands });
  }

  async #transport(): Promise<McpTransport> {
    const { config } = this.entry;
    if (!isMcpStdioConfig(config)) {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.headers ?? {})) {
        const resolved = await this.#resolve(value, `header ${key}`);
        // Errors name the header only; fetch would echo an invalid value back.
        if (!HEADER_NAME.test(key) || !HEADER_VALUE.test(resolved)) {
          throw new Error(`mcp_header_invalid:${this.name}:${key}`);
        }
        headers[key] = resolved;
      }
      const url = await this.url();
      const auth = this.#authFor(url);
      return new StreamableHttpTransport({
        url,
        headers,
        fetch: TRANSPORT_FETCH,
        ...(auth === undefined ? {} : {
          authProvider: {
            ...auth,
            // fetch would echo a malformed token back in its error.
            token: async () => {
              const token = await auth.token();
              if (token !== undefined && !HEADER_VALUE.test(token)) throw new Error(`mcp_token_invalid:${this.name}`);
              return token;
            },
          },
        }),
      });
    }
    // The coding allowlist plus only what the entry names: provider and account
    // secrets reach a server only when the user writes them into its `env`.
    const env = buildCodingProcessEnv(true);
    for (const [key, value] of Object.entries(config.env ?? {})) {
      env[key] = await this.#resolve(value, `env ${key}`);
    }
    const args: string[] = [];
    for (const [index, arg] of (config.args ?? []).entries()) {
      args.push(expandHome(await this.#resolve(arg, `arg ${index}`, false)));
    }
    // Never the session workspace: a repository could plant node_modules/.bin,
    // .npmrc, or pyproject files that npx, uvx, or python -m would then run.
    const cwd = config.cwd === undefined
      ? homedir()
      : resolve(this.entry.baseDir ?? homedir(), expandHome(await this.#resolve(config.cwd, "cwd", false)));
    // The allowlist passes Pebble's launch PWD; servers that read $PWD must see their real cwd.
    if (config.env?.PWD === undefined) env.PWD = cwd;
    return new StdioTransport({
      command: expandHome(await this.#resolve(config.command, "command", false)),
      args,
      cwd,
      env,
      inheritEnv: false,
      stderr: "pipe",
    });
  }

  async #open(): Promise<McpClient> {
    this.state = "connecting";
    this.#changed();
    this.#stderrTail = undefined;
    const client = new McpClient({
      name: this.#options.clientName ?? "caveman-agent",
      version: this.#options.clientVersion ?? "0.0.0",
      requestTimeoutMs: this.timeoutMs,
      roots: [{ uri: pathToFileURL(this.#options.cwd).href, name: basename(this.#options.cwd) }],
    });
    let transport: McpTransport | undefined;
    this.#connecting = client;
    try {
      transport = await this.#transport();
      if (this.#closed) throw new Error("shut down while connecting");
      await client.connect(transport);
      const stdio = transport instanceof StdioTransport ? transport : undefined;
      const pid = stdio?.pid;
      client.onClose(() => this.#handleClose(client, stdio, pid));
      // A malformed or oversized frame drops its response; fail the connection instead of waiting out the timeout.
      client.onError((error) => {
        // Not deliberate: like a crash, the group's leftovers are stopped.
        if (!error.message.startsWith("Received response for unknown")) void client.close();
      });
      client.onNotification("notifications/tools/list_changed", () => {
        void this.#refreshTools(client);
      });
      const tools = client.serverCapabilities?.tools === undefined ? [] : await client.listTools();
      if (this.#closed) throw new Error("shut down while connecting");
      if (client.connectionState !== "connected") throw new Error("connection closed during setup");
      this.#connecting = undefined;
      this.#client = client;
      this.tools = tools;
      this.instructions = client.instructions?.trim() || undefined;
      this.state = "connected";
      this.error = undefined;
      this.#host.registerTools(this);
      this.#changed();
      return client;
    } catch (error) {
      this.#connecting = undefined;
      this.#closing.add(client);
      await client.close().catch(() => undefined);
      if (transport instanceof StdioTransport) {
        this.#stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
      }
      if (this.#needsSignIn(error) && !this.#closed) {
        this.#markNeedsAuth();
        throw new Error(this.#signInMessage());
      }
      this.state = this.#closed ? "closed" : "failed";
      this.error = this.#stderrTail === undefined
        ? errorMessage(error)
        : `${errorMessage(error)}\n${this.#stderrTail}`;
      this.#changed();
      throw new Error(`mcp_server_connect_failed:${this.name}: ${this.error}`);
    }
  }

  #needsSignIn(error: unknown): boolean {
    return error instanceof McpOAuthAuthorizationRequiredError || error instanceof McpAuthRequiredError;
  }

  #signInMessage(): string {
    return `MCP server "${this.name}" requires sign-in.${this.#options.signInHint === undefined
      ? ""
      : ` ${this.#options.signInHint(this.name)}`}`;
  }

  #markNeedsAuth(): void {
    this.state = "needs-auth";
    this.error = undefined;
    this.#changed();
  }

  #changed(): void {
    this.#options.onChange?.(this.status());
  }

  async #drop(client: McpClient): Promise<void> {
    this.#closing.add(client);
    if (this.#client === client) this.#client = undefined;
    await client.close().catch(() => undefined);
  }

  #handleClose(client: McpClient, stdio: StdioTransport | undefined, pid: number | undefined): void {
    // Deliberate closes go through pi-mcp: stdin close, then SIGTERM, then
    // SIGKILL. An unexpected one means the server already exited (its stdin is
    // gone); a crashed wrapper (npx, uvx) can leave children in its group.
    if (!this.#closing.has(client) && pid !== undefined && process.platform !== "win32") {
      const signal = (name: NodeJS.Signals) => {
        try {
          process.kill(-pid, name);
        } catch {
          // The group is already gone.
        }
      };
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), 2_000).unref();
    }
    if (this.#client !== client || this.#closed) return;
    this.#client = undefined;
    this.state = "disconnected";
    this.#stderrTail = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
    this.error = this.#stderrTail === undefined ? "Connection closed" : `Connection closed\n${this.#stderrTail}`;
    this.#changed();
  }

  async #refreshTools(client: McpClient): Promise<void> {
    try {
      const tools = await client.listTools();
      if (this.#client !== client || this.#closed) return;
      this.tools = tools;
      this.#host.registerTools(this);
    } catch (error) {
      this.error = `Failed to refresh tools: ${errorMessage(error)}`;
    }
    this.#changed();
  }
}

/**
 * Every MCP server of one session. Servers connect in the background; the
 * first prompt never waits. Call `waitForCell` as the code tool's cell gate so
 * a cell naming a server, or searching tools, waits briefly for it.
 */
export class McpHost {
  readonly #options: McpHostOptions;
  readonly #connections = new Map<string, McpConnection>();
  /** Nested tool name → server tool, for every registered tool. */
  readonly #owners = new Map<string, McpToolOwner>();
  readonly #registered = new Set<string>();
  readonly #called = new Map<string, McpToolOwner>();
  readonly #isErrors = new Map<string, number>();

  constructor(options: McpHostOptions) {
    this.#options = options;
    for (const entry of options.servers) {
      if (this.#connections.has(entry.name)) throw new Error(`mcp_server_duplicate:${entry.name}`);
      this.#connections.set(entry.name, new McpConnection(entry, this, options));
    }
  }

  /** Connect every enabled server in the background. */
  start(): void {
    for (const connection of this.#connections.values()) {
      if (connection.state === "idle") void connection.getClient().catch(() => undefined);
    }
  }

  status(): readonly McpServerStatus[] {
    return [...this.#connections.values()].map((connection) => connection.status());
  }

  /** Server, tool, and `isError` result count of every MCP tool called so far in this session. */
  calledTools(): Readonly<Record<string, McpToolOwner & { readonly isErrors: number }>> {
    return Object.fromEntries([...this.#called].map(([name, owner]) =>
      [name, Object.freeze({ ...owner, isErrors: this.#isErrors.get(name) ?? 0 })]));
  }

  /** Bounded wait for servers a cell names, or for all of them when it searches tools. */
  async waitForCell(code: string, signal?: AbortSignal): Promise<void> {
    const discovery = DISCOVERY.test(code);
    const waits: Promise<unknown>[] = [];
    for (const connection of this.#connections.values()) {
      const named = code.includes(mcpNamespace(connection.name));
      if (!named && !discovery) continue;
      if (connection.state === "connecting" && connection.opening !== undefined) waits.push(connection.opening);
      // Lazy reconnect: a failed or dropped server reconnects when a cell names it.
      else if (named && (connection.state === "failed" || connection.state === "disconnected")) {
        waits.push(connection.getClient());
      }
    }
    if (waits.length === 0 || signal?.aborted === true) return;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    await Promise.race([
      Promise.allSettled(waits),
      new Promise<void>((done) => {
        timer = setTimeout(done, CELL_WAIT_MS);
        onAbort = done;
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }

  /** Browser sign-in for an OAuth HTTP server, then reconnect with the new tokens. */
  async signIn(name: string, prompt: McpSignInPrompt): Promise<void> {
    const connection = this.#connections.get(name);
    if (connection === undefined) throw new Error(`mcp_server_unknown:${name}`);
    if (!connection.usesOAuth) throw new Error(`mcp_server_oauth_unused:${name}`);
    if (connection.state === "disabled") throw new Error(`mcp_server_disabled:${name}`);
    const url = await connection.url();
    if (this.#options.oauthStore === undefined) throw new Error("mcp_oauth_store_required");
    // The server's 401 challenge names its resource metadata and scope. A
    // connected server still signs in: a stored step-up request needs the browser,
    // otherwise the stored refresh token completes without one.
    if (connection.challenge === undefined) await connection.getClient().catch(() => undefined);
    await signInMcpServer({
      serverUrl: url,
      store: this.#options.oauthStore(name, url),
      settings: await connection.oauthSettings(),
      clientName: this.#options.clientName ?? "caveman-agent",
      challenge: connection.challenge,
      prompt,
    });
    await connection.reconnect();
  }

  /**
   * A server tool as a declared tool: the host's name, description and schema,
   * so it exists before the server connects; each call goes to the server and
   * waits up to `timeoutMs`. Never retried, like every server call.
   */
  directTool(spec: McpDirectTool): ToolDefinition {
    const connection = this.#connections.get(spec.server);
    if (connection === undefined) throw new Error(`mcp_server_unknown:${spec.server}`);
    if (spec.timeoutMs !== undefined && (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0)) {
      throw new Error(`mcp_direct_tool_timeout_invalid:${spec.server}/${spec.tool}`);
    }
    const mcpTool = { name: spec.tool, description: spec.description, inputSchema: spec.input } as McpTool;
    return createMcpToolDefinition(connection, mcpTool, createMcpToolName(spec.server, spec.tool), spec.timeoutMs);
  }

  async close(): Promise<void> {
    await Promise.all([...this.#connections.values()].map((connection) => connection.close()));
  }

  /** @internal */
  recordCall(nestedName: string, server: string, toolName: string): void {
    this.#called.set(nestedName, Object.freeze({ server, tool: toolName }));
  }

  /** @internal An `isError` result: resolved for scripts, counted as an error for receipts. */
  recordError(nestedName: string): void {
    this.#isErrors.set(nestedName, (this.#isErrors.get(nestedName) ?? 0) + 1);
  }

  /** @internal Registers tools a connection has not registered before. */
  registerTools(connection: McpConnection): void {
    const server = connection.name;
    const description = connection.entry.config.description?.trim();
    const namespace: ProgrammaticToolNamespace = {
      name: mcpNamespace(server),
      ...(description ? { description } : {}),
      ...(connection.instructions === undefined ? {} : { instructions: connection.instructions }),
    };
    const failures: string[] = [];
    for (const mcpTool of connection.tools) {
      const key = `${server}\0${mcpTool.name}`;
      if (this.#registered.has(key)) continue;
      const name = createMcpToolName(server, mcpTool.name, (candidate) => this.#owners.has(candidate));
      try {
        this.#options.register([createMcpToolDefinition(connection, mcpTool, name)], namespace);
        this.#registered.add(key);
        this.#owners.set(name, Object.freeze({ server, tool: mcpTool.name }));
      } catch (error) {
        failures.push(`${mcpTool.name}: ${errorMessage(error)}`);
      }
    }
    if (failures.length > 0) connection.error = `Tools not registered: ${failures.join("; ")}`;
  }
}
