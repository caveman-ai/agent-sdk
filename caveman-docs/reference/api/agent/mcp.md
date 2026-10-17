# `@caveman-ai/agent/mcp`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/mcp.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `McpHost`
- **Interface**: `McpDirectTool`, `McpHostOptions`, `McpHttpServerConfig`, `McpOAuthConfig`, `McpOAuthState`, `McpOAuthStateStore`, `McpServerEntry`, `McpServerStatus`, `McpSignInPrompt`, `McpStdioServerConfig`, `McpToolOwner`, `McpValueContext`, `ParsedMcpServers`
- **Type alias**: `McpServerConfig`, `McpServerState`
- **Function**: `createMcpToolName`, `isMcpStdioConfig`, `mcpNamespace`, `parseMcpServers`, `renderMcpServersSection`, `validateMcpServerConfig`
- **Variable**: `MAX_MCP_SERVERS_SECTION_CHARS`

</details>

## Classes

### `McpHost`

Every MCP server of one session. Servers connect in the background; the
first prompt never waits. Call `waitForCell` as the code tool's cell gate so
a cell naming a server, or searching tools, waits briefly for it.

```ts
export declare class McpHost {
    #private;
    constructor(options: McpHostOptions);
    /** Connect every enabled server in the background. */
    start(): void;
    status(): readonly McpServerStatus[];
    /** Server, tool, and `isError` result count of every MCP tool called so far in this session. */
    calledTools(): Readonly<Record<string, McpToolOwner & {
        readonly isErrors: number;
    }>>;
    /** Bounded wait for servers a cell names, or for all of them when it searches tools. */
    waitForCell(code: string, signal?: AbortSignal): Promise<void>;
    /** Browser sign-in for an OAuth HTTP server, then reconnect with the new tokens. */
    signIn(name: string, prompt: McpSignInPrompt): Promise<void>;
    /**
     * A server tool as a declared tool: the host's name, description and schema,
     * so it exists before the server connects; each call goes to the server and
     * waits up to `timeoutMs`. Never retried, like every server call.
     */
    directTool(spec: McpDirectTool): ToolDefinition;
    close(): Promise<void>;
    /** @internal */
    recordCall(nestedName: string, server: string, toolName: string): void;
    /** @internal An `isError` result: resolved for scripts, counted as an error for receipts. */
    recordError(nestedName: string): void;
    /** @internal Registers tools a connection has not registered before. */
    registerTools(connection: McpConnection): void;
}
```

Declared in `packages/agent/dist/mcp.d.ts`.

## Interfaces

### `McpDirectTool`

A server tool the provider sees as a declared tool, with the host's declaration.

```ts
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
```

Declared in `packages/agent/dist/mcp.d.ts`.

### `McpHostOptions`

```ts
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
```

Declared in `packages/agent/dist/mcp.d.ts`.

### `McpHttpServerConfig`

```ts
export interface McpHttpServerConfig extends McpServerConfigBase {
    readonly type?: "http" | "streamable-http";
    readonly url: string;
    /** Values may use `${VAR}` or `!command`. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly oauth?: McpOAuthConfig;
    /** Send a host provider's token instead of OAuth; https or loopback only. */
    readonly auth?: {
        readonly provider: string;
    };
}
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `McpOAuthConfig`

OAuth client settings for HTTP servers without dynamic client registration.

```ts
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
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `McpOAuthState`

```ts
export interface McpOAuthState {
    serverUrl: string;
    clientInformation?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    /** When the access token expires, in milliseconds since the epoch, from `expires_in` at the time it was saved. */
    tokensExpireAt?: number;
    codeVerifier?: string;
    oauthState?: string;
    discovery?: OAuthDiscoveryState;
}
```

Declared in `node_modules/@earendil-works/pi-mcp/dist/oauth/provider.d.ts`.

### `McpOAuthStateStore`

```ts
export interface McpOAuthStateStore {
    load(): McpOAuthState | undefined | Promise<McpOAuthState | undefined>;
    save(state: McpOAuthState): void | Promise<void>;
}
```

Declared in `node_modules/@earendil-works/pi-mcp/dist/oauth/provider.d.ts`.

### `McpServerEntry`

```ts
export interface McpServerEntry {
    readonly name: string;
    readonly config: McpServerConfig;
    /** Config file path, or a label such as `acp` or `plugin:<name>`. */
    readonly source: string;
    /**
     * Directory a relative stdio `cwd` resolves against, normally the config
     * file's directory. Without it, the home directory. Never the session
     * workspace: a repository must not choose what `npx` or `uvx` resolves.
     */
    readonly baseDir?: string;
}
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `McpServerStatus`

```ts
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
```

Declared in `packages/agent/dist/mcp.d.ts`.

### `McpSignInPrompt`

```ts
export interface McpSignInPrompt {
    /** Show the authorization URL (and open a browser if the host can). */
    showAuthorizationUrl(url: URL): void;
}
```

Declared in `packages/agent/dist/mcp.d.ts`.

### `McpStdioServerConfig`

```ts
export interface McpStdioServerConfig extends McpServerConfigBase {
    readonly type?: "stdio";
    /** One executable, not a shell string. */
    readonly command: string;
    readonly args?: readonly string[];
    /** Added to the coding allowlist environment. Values may use `${VAR}` or `!command`. */
    readonly env?: Readonly<Record<string, string>>;
    /** Relative to the config file's directory; unset means the home directory, never the workspace. */
    readonly cwd?: string;
}
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `McpToolOwner`

Which server tool a nested tool name calls, for receipts.

```ts
export interface McpToolOwner {
    readonly server: string;
    readonly tool: string;
}
```

Declared in `packages/agent/dist/mcp.d.ts`.

### `McpValueContext`

```ts
export interface McpValueContext {
    readonly server: McpServerEntry;
    /** For messages, for example `env TOKEN` or `arg 2`. */
    readonly field: string;
    /** Whether a leading `!` runs a command; false for command, args, cwd, and url. */
    readonly commands: boolean;
}
```

Declared in `packages/agent/dist/mcp.d.ts`.

### `ParsedMcpServers`

```ts
export interface ParsedMcpServers {
    readonly servers: readonly McpServerEntry[];
    /** Invalid entries are reported here and skipped; valid entries still load. */
    readonly errors: readonly string[];
}
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

## Type aliases

### `McpServerConfig`

```ts
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `McpServerState`

`disconnected`: the connection dropped; the next call reconnects.

```ts
export type McpServerState = "idle" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "disabled" | "closed";
```

Declared in `packages/agent/dist/mcp.d.ts`.

## Functions

### `createMcpToolName`

`mcp__<server>__<tool>` with everything but `[A-Za-z0-9_]` replaced by `_`,
so the name is also a script identifier. Too-long or colliding names get a
hash suffix, like Pi and Codex.

```ts
export declare function createMcpToolName(server: string, toolName: string, isTaken?: (name: string) => boolean): string;
```

Declared in `packages/agent/dist/mcp.d.ts`.

### `isMcpStdioConfig`

```ts
export declare function isMcpStdioConfig(config: McpServerConfig): config is McpStdioServerConfig;
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `mcpNamespace`

Namespace of a server's tools: `mcp__<server>`, with `-` replaced by `_` like the tool names.

```ts
export declare function mcpNamespace(server: string): string;
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `parseMcpServers`

Parse a decoded `mcp.json` (`{ "mcpServers": { ... } }`). Names that differ
only in `-` and `_` would share a namespace, so the later one is rejected.

```ts
export declare function parseMcpServers(value: unknown, source: string, baseDir?: string): ParsedMcpServers;
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `renderMcpServersSection`

The stable `mcp_servers` prompt section, built only from config-time names
and descriptions so it never changes while servers connect, fail, or
reconnect. Server instructions stay behind `describeNamespace()`.
Undefined when no server is enabled.

```ts
export declare function renderMcpServersSection(servers: readonly McpServerEntry[], codeToolName: string): string | undefined;
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

### `validateMcpServerConfig`

Validate one `mcpServers` entry. Returns the config, or an error message.

```ts
export declare function validateMcpServerConfig(name: string, raw: unknown): McpServerConfig | string;
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

## Variables & constants

### `MAX_MCP_SERVERS_SECTION_CHARS`

Characters of the whole `mcp_servers` section; descriptions shrink, then servers are counted.

```ts
export declare const MAX_MCP_SERVERS_SECTION_CHARS = 4096;
```

Declared in `packages/agent/dist/mcp-config.d.ts`.

