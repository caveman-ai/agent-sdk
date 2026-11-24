/**
 * Types of `@caveman-ai/harness` (dist/lib.mjs, src/lib.ts). Written by hand and kept structural: the bundle carries
 * its own Pi packages, and a host on another pi-ai version passes its own models and stream function, so nothing here
 * names a Pi type. Shapes are pi-ai's and pi-agent-core's (1.3 and 1.4 agree on all of them).
 */

/** A pi-ai model (`Model<Api>`): what the session reads of it. */
export interface HarnessModel {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** pi-agent-core's StreamFn: `(model, context, options) => AssistantMessageEventStream` (pi-ai's `streamSimple`). */
export type HarnessStreamFn = (model: any, context: any, options?: any) => any;

/** A pi-agent-core AgentTool. */
export interface HarnessTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: (partial: unknown) => void): Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details?: unknown }>;
}

/** A pi-agent-core AgentMessage: user, assistant, toolResult (or a host's own role, which never reaches the model). */
export type HarnessMessage = { role: string; content?: unknown; timestamp?: number; [key: string]: unknown };

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; data: string; mimeType: string };

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export declare const EFFORTS: readonly Effort[];

/** A normalized loadout: the surface, prompt, tools, limits, policy and wire of a run. */
export interface Loadout {
  name: string;
  surface: "compact" | "exec";
  tools: Record<string, { exposure: string; limits: Record<string, number | boolean | string>; description?: string }>;
  mcp?: { exposure: "direct" | "program" | "both" };
  [key: string]: unknown;
}

export declare const APP_CLAUDE_LOADOUT: Record<string, unknown>;
export declare const APP_GPT_LOADOUT: Record<string, unknown>;
/**
 * `app-general`: agents that do not code (the Chief, `agent exec`'s general shape), on any model. No built-in tools and
 * no prompt sections: the session's tools are the host's (`tools`, MCP tools through `mcpDirectTools`) and its system
 * prompt is the host's `instructions`; the env block (cwd, os) still opens the first message. app-claude's policy and wire.
 */
export declare const APP_GENERAL_LOADOUT: Record<string, unknown>;
/**
 * `app-code`: app-general plus the program tool without a sandbox (`computer: code`, Cloud's code tier).
 * MCP tools stay callable both inside `program` and directly (`mcp.exposure: "both"`).
 */
export declare const APP_CODE_LOADOUT: Record<string, unknown>;
export declare function appLoadouts(): { claude: Loadout; gpt: Loadout; general: Loadout; code: Loadout };
/** Codex's exec surface for a GPT model on a Responses API; the compact surface (plus programs) for every other model. */
export declare function appLoadoutFor(model: { api: string; id: string }): Loadout;
export declare function usesExecSurface(model: { api: string; id: string }): boolean;
export declare function normalizeLoadout(input: unknown, label?: string): Loadout;
export declare function loadoutHash(loadout: Loadout): string;

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  yieldMs?: number;
  background?: boolean;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
  env?: Record<string, string>;
  internal?: boolean;
}
export interface ExecResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  durationMs: number;
  totalBytes: number;
  running: boolean;
  handle?: string;
  timedOut?: boolean;
  killed?: boolean;
  watchStopped?: boolean;
  refused?: boolean;
}
export interface FileStat { kind: "file" | "directory" | "symlink" | "other"; size: number; mtimeMs: number }
export interface DirEntry { name: string; kind: FileStat["kind"] }
export interface ReadRange { offset?: number; length?: number }
/** Where tools run: every method one request and response. */
export interface ExecEnv {
  readonly id: string;
  readonly cwd: string;
  readonly user?: string | undefined;
  readonly os?: string | undefined;
  /** The env block's `shell:` line: what the model must know about its shell (LocalEnv on Windows only). */
  readonly shellNote?: string | undefined;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  poll(handle: string): Promise<ExecResult>;
  wait(handle: string, ms: number, signal?: AbortSignal): Promise<ExecResult>;
  kill(handle: string): Promise<ExecResult>;
  readFile(path: string, range?: ReadRange): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  readFiles?(paths: string[]): Promise<(Uint8Array | Error)[]>;
  writeFiles?(files: { path: string; data: Uint8Array | string }[]): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  scratchDir(): Promise<string>;
  resolvePath(path: string): string;
  close(): Promise<void>;
  configureShell?(settings: Record<string, unknown>): void;
}
export interface LocalEnvOptions {
  cwd: string;
  /** Extra variables for every command (win over the allowlisted host ones: PATH, HOME, USER, LANG, ...). */
  env?: Record<string, string>;
  keepScratch?: boolean;
  guardRoot?: number;
  /**
   * Windows only: the bash commands run in, an absolute path to a bash.exe, used as given. A relative path, WSL's
   * launcher or a missing file is refused (every command then exits 127 saying why). Default: the bash of the Git for
   * Windows install whose git.exe is on PATH, then %ProgramFiles%/%ProgramFiles(x86)% Git, then a non-WSL bash.exe on PATH.
   */
  shell?: string;
  /** The platform to behave as (default process.platform); for tests. */
  platform?: string;
}
/**
 * This host: an allowlisted environment, no ambient secrets. POSIX: /bin/bash (or /bin/sh), each command in its own
 * process group, a reaper for a harness killed outright. Windows: a real bash (Git Bash; never cmd.exe, PowerShell or
 * WSL), no console window, a command's tree ended with `taskkill /T /F`, no reaper; with no bash every command exits 127
 * with how to install Git for Windows.
 */
export declare class LocalEnv implements ExecEnv {
  constructor(options: LocalEnvOptions);
  readonly id: string;
  readonly cwd: string;
  readonly user: string | undefined;
  readonly os: string;
  /** Windows: `Git Bash (C:/Program Files/Git/bin/bash.exe), not cmd.exe or PowerShell: ...`, or that there is no bash. Undefined elsewhere. */
  readonly shellNote: string | undefined;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  poll(handle: string): Promise<ExecResult>;
  wait(handle: string, ms: number, signal?: AbortSignal): Promise<ExecResult>;
  kill(handle: string): Promise<ExecResult>;
  readFile(path: string, range?: ReadRange): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  readFiles(paths: string[]): Promise<(Uint8Array | Error)[]>;
  listDir(path: string): Promise<DirEntry[]>;
  scratchDir(): Promise<string>;
  resolvePath(path: string): string;
  close(): Promise<void>;
}

export interface DockerEnvOptions {
  container: string;
  cwd: string;
  user?: string;
  env?: Record<string, string>;
  noGroups?: boolean;
  [key: string]: unknown;
}
/** A running container through `docker exec` (benchmarks). */
export declare class DockerEnv implements ExecEnv {
  static connect(options: DockerEnvOptions): Promise<DockerEnv>;
  readonly id: string;
  readonly cwd: string;
  readonly container: string;
  user: string | undefined;
  os: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  poll(handle: string): Promise<ExecResult>;
  wait(handle: string, ms: number, signal?: AbortSignal): Promise<ExecResult>;
  kill(handle: string): Promise<ExecResult>;
  readFile(path: string, range?: ReadRange): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  listDir(path: string): Promise<DirEntry[]>;
  scratchDir(): Promise<string>;
  resolvePath(path: string): string;
  close(): Promise<void>;
}

/** What happened to the session's computer: the `data` of a `session.sandbox` event. */
export interface SandboxEvent {
  action: "made" | "attached" | "woke" | "released" | "lost";
  computer_id: string;
  size?: string;
  image?: string;
  network?: string;
  keep?: string;
  ready_ms?: number;
  slept_without_memory?: boolean;
  reason?: string;
}
export interface SandboxEnvOptions {
  /** The Caveman Cloud API origin. */
  controlURL: string;
  /** The origin that serves /relay (the streams); absent, controlURL. */
  relayURL?: string;
  /** The key the computer is made and used with (on the pool, the session's own); it never reaches the computer. */
  apiKey: string;
  /** A computer to use (kept, attached, or the session's from an earlier claim); absent, one is made on the first call. */
  computerId?: string;
  /** The create's Idempotency-Key (`session-<id>` on the pool). */
  idempotencyKey?: string;
  /** Files (relative to cwd) written into a computer this env makes, once, as one batch; never into one it attaches. */
  files?: () => Promise<{ path: string; data: Uint8Array | string }[]>;
  /**
   * The session's repository, cloned into cwd once the computer runs (made, or attached without the clone) from
   * gitURL (http or https, no credentials; on the fleet the host's git lane): the base branch checked out, origin the
   * GitHub URL, the clone's own url.<gitURL>.insteadOf for it.
   */
  repository?: { owner: string; name: string; baseBranch?: string; gitURL: string };
  /** Default /workspace. */
  cwd?: string;
  /** Default tools (the image's); the probe's answer replaces it. */
  user?: string;
  /** Every command's variables (on the pool, a build's secrets), only in the exec stream that starts it, never written into the computer. */
  env?: Record<string, string>;
  readyTimeoutMs?: number;
  onEvent?: (event: SandboxEvent) => void;
  fetch?: typeof globalThis.fetch;
  retryDelayMs?: number;
  bootIdFile?: string;
}
/**
 * A Caveman sandbox (a bare fleet computer) through the public sandbox API, `@caveman-ai/sdk/sandboxes`: made on the
 * first call that needs one (a create with no shape; the session's computer attached when the API says it has one),
 * every call one stream through the relay, the key only ever the API's bearer.
 */
export declare class SandboxEnv implements ExecEnv {
  constructor(options: SandboxEnvOptions);
  /** `sandbox:<computer id>` once there is one, `sandbox` before. */
  readonly id: string;
  readonly cwd: string;
  readonly user: string;
  readonly os: string;
  readonly computerId: string | undefined;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  poll(handle: string): Promise<ExecResult>;
  wait(handle: string, ms: number, signal?: AbortSignal): Promise<ExecResult>;
  kill(handle: string): Promise<ExecResult>;
  readFile(path: string, range?: ReadRange): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  stat(path: string): Promise<FileStat | undefined>;
  readFiles(paths: string[]): Promise<(Uint8Array | Error)[]>;
  writeFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  scratchDir(): Promise<string>;
  resolvePath(path: string): string;
  liveHandles(): string[];
  close(): Promise<void>;
}

export type McpServerConfig =
  | { type?: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers?: Record<string, string> };
export interface CallToolResult {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
}
export interface McpToolHandle {
  server: string;
  name: string;
  /** `<server>__<tool>`, [A-Za-z0-9_-], at most 64 characters. */
  qualified: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; isError: boolean }>;
  callRaw(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult>;
}
export interface McpSession {
  tools: McpToolHandle[];
  failed: { server: string; error: string }[];
  close(): Promise<void>;
}
export interface ConnectMcpOptions {
  timeoutMs?: number;
  onStderr?: (server: string, chunk: string) => void;
  tolerant?: boolean;
  clientName?: string;
  fetch?: typeof fetch;
}
export declare function connectMcp(servers: Record<string, McpServerConfig>, options?: ConnectMcpOptions): Promise<McpSession>;
export declare function mcpContent(result: CallToolResult): Array<TextPart | ImagePart>;
/** One declared tool per MCP tool, named by `qualified`; with `images`, an image answer reaches the model as one. */
export declare function mcpDirectTools(handles: readonly McpToolHandle[], options?: { images?: boolean }): HarnessTool[];

export interface NestedCall {
  id: string;
  parentId: string;
  name: string;
  args: unknown;
  mcp?: { server: string; tool: string };
}
export interface CallInfo {
  id: string;
  name: string;
  args: unknown;
  parentId?: string;
  mcp?: { server: string; tool: string };
}
export interface SessionHooks {
  beforeCall?(call: CallInfo, signal: AbortSignal | undefined): Promise<string | undefined>;
  afterCall?(call: CallInfo, result: { text: string; isError: boolean }): Promise<string | undefined>;
}
export interface TurnUsage {
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number | null;
}
export type GateRisk = "low" | "medium" | "high" | "critical";
export type GateStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type GateTerminalStatus = Exclude<GateStatus, "pending">;
export interface GateRequest {
  readonly gateId: string;
  readonly tool: string;
  readonly action: string;
  readonly summary: string;
  readonly risk: GateRisk;
  readonly input: unknown;
  readonly callId: string;
  readonly parentId?: string;
  readonly mcp?: { readonly server: string; readonly tool: string };
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface GateDecision {
  readonly gateId: string;
  readonly status: GateTerminalStatus;
  readonly reason?: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}
export interface GateProvider {
  requestApproval(request: GateRequest, signal?: AbortSignal): Promise<GateDecision>;
}
export interface GateRule {
  readonly tool: string | RegExp;
  readonly action?: string;
  readonly risk?: GateRisk;
  readonly summary?: string | ((call: CallInfo) => string);
  readonly when?: (call: CallInfo) => boolean;
}
export interface GateConfig {
  readonly provider?: GateProvider;
  readonly rules?: ReadonlyArray<GateRule>;
  readonly requireAll?: boolean;
  readonly defaultRisk?: GateRisk;
  readonly timeoutMs?: number;
  readonly sessionId?: string;
  readonly onRequest?: (request: GateRequest) => void;
  readonly onDecision?: (request: GateRequest, decision: GateDecision) => void;
}
export interface CloudGateProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}
export declare function createGateHook(
  config: GateConfig,
  emitEvent?: (event:
    | { type: "gate_requested"; request: GateRequest }
    | { type: "gate_decided"; request: GateRequest; decision: GateDecision }) => void,
): (call: CallInfo, signal: AbortSignal | undefined) => Promise<string | undefined>;
export declare function createCloudGateProvider(options: CloudGateProviderOptions): GateProvider;
export declare function createMemoryGateProvider(
  decide: (request: GateRequest, signal?: AbortSignal) => Promise<Omit<GateDecision, "gateId"> | GateTerminalStatus> | Omit<GateDecision, "gateId"> | GateTerminalStatus,
): GateProvider;

export type SessionEvent =
  | { type: "pi"; event: { type: string; [key: string]: unknown } }
  | { type: "nested_start"; call: NestedCall }
  | { type: "nested_end"; call: NestedCall; result: unknown; isError: boolean }
  | { type: "side_usage"; kind: "cache_keepalive" | "compaction"; usage: TurnUsage }
  | { type: "compacted"; summaryTokens: number; before: number }
  | { type: "retry"; attempt: number; of: number; delayMs: number; error: string | undefined }
  | { type: "gate_requested"; request: GateRequest }
  | { type: "gate_decided"; request: GateRequest; decision: GateDecision };
export interface TurnOutcome {
  status: "finished" | "stopped" | "error";
  stopReason: string;
  error?: string;
  finalText: string;
  usage: TurnUsage;
}
export interface TurnOptions {
  signal?: AbortSignal;
  onEvent?: (event: SessionEvent) => void;
  steering?: () => string[];
}
export interface HarnessSessionOptions {
  model: HarnessModel;
  stream: HarnessStreamFn;
  effort?: Effort | undefined;
  loadout: Loadout;
  env: ExecEnv;
  mcp?: readonly McpToolHandle[];
  tools?: HarnessTool[];
  instructions?: string;
  messages?: HarnessMessage[];
  hooks?: SessionHooks;
  gate?: GateConfig;
  fetch?: typeof fetch;
  compactAt?: number;
}
export declare class HarnessSession {
  constructor(options: HarnessSessionOptions);
  readonly env: ExecEnv;
  readonly model: HarnessModel;
  readonly loadout: Loadout;
  readonly messages: HarnessMessage[];
  readonly toolNames: string[];
  setModel(model: HarnessModel, effort?: Effort | undefined): void;
  runTurn(content: string | Array<TextPart | ImagePart>, options?: TurnOptions): Promise<TurnOutcome>;
  pauseKeepAlive(): void;
  close(): Promise<void>;
}
export declare function isCompactionSummary(text: string): boolean;
/** Messages another surface or engine left, with calls of tools not in `declared` (and their results) as text. */
export declare function portableMessages(messages: readonly unknown[], declared: ReadonlySet<string>): HarnessMessage[];

export interface ResolveHarnessModelOptions {
  /** Explicit API key; takes precedence over `apiKeyEnv` / default env var. */
  apiKey?: string;
  /** Environment variable holding the provider key (default `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). */
  apiKeyEnv?: string;
  /** Optional provider base URL override. */
  baseUrl?: string;
}
/**
 * Resolve a `"provider/model"` spec (`anthropic/...` or `openai/...`) from the
 * bundled catalog into `{ model, stream }` ready for `new HarnessSession(...)`
 * or `runInProcess(...)`.
 */
export declare function resolveHarnessModel(
  spec: string,
  options?: ResolveHarnessModelOptions,
): { model: HarnessModel; stream: HarnessStreamFn };
