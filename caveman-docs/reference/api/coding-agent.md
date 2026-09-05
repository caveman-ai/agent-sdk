# `@caveman-ai/coding-agent` API reference

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.1.0`.

Interactive Caveman coding agent and caveman-code CLI.

## Entrypoints

| Import specifier | Declarations | Exported symbols |
| --- | --- | --- |
| `@caveman-ai/coding-agent` | `packages/coding-agent/src/index.d.ts` | 57 |
| `@caveman-ai/coding-agent/cli` | `packages/coding-agent/src/cli.d.ts` | 4 |

## `@caveman-ai/coding-agent`

Declaration file: `packages/coding-agent/src/index.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `AgentRunController`
- **Interface**: `CodingAgent`, `CodingAgentOptions`, `CodingRecoveryProof`, `CodingSession`, `CodingSessionOptions`, `CodingSessionRunOptions`, `CodingTaskAttemptEvidence`, `CodingTaskEconomics`, `CodingTaskEconomicsOptions`, `CommandSessionReadOptions`, `CommandSessionReadResult`, `CommandSessionRuntime`, `CommandSessionRuntimeOptions`, `CommandSessionSpillOptions`, `CommandSessionStartOptions`, `CommandSessionStartResult`, `CommandSessionSummary`, `CommandSessionWriteOptions`, `CommandSessionWriteResult`, `FailedStreamingTurn`, `ProgrammaticToolRuntime`, `ProgrammaticToolStats`, `SessionBill`, `StreamingCodingTurnOptions`, `ToolOutputSample`, `TurnBill`, `TurnRecord`
- **Type alias**: `CodingTaskPriceBasis`, `CodingToolMode`, `CodingToolSet`, `CommandSessionState`, `SessionMode`, `StreamingCodingTurnResult`
- **Function**: `capOutput`, `classifyTurnFailure`, `codingModelsAtProviderBaseURL`, `createCodingAgent`, `createCommandSessionRuntime`, `createProgrammaticToolRuntime`, `defaultCodingPlan`, `formatRecoveryProof`, `formatSessionBill`, `formatTurnBill`, `programmaticToolInstructions`, `proveRecovery`, `runCodingSession`, `runCodingTurn`, `sessionBill`, `startCodingSession`, `streamCodingTurn`, `summarizeCodingTaskAttempts`
- **Variable**: `CODING_RUN_BREAKERS`, `CODING_TOOL_OUTPUT_CAPS`, `OBSERVE_ONLY_BANNER`, `PROGRAMMATIC_TOOL_NAME`, `RECOVERABLE_CODING_TRANSFORMS`

</details>

### Classes

#### `AgentRunController`

One kernel-owned control handle for an active Pi loop.

Messages queued before Pi is constructed are retained and attached once the
run starts. Queue state is observable without exposing Pi's private queues,
and one-at-a-time draining keeps the visible count exact at turn boundaries.

```ts
export declare class AgentRunController {
    private agent;
    private steering;
    private followUps;
    private listeners;
    private seenTurnStart;
    private heldAfterInterrupt;
    get state(): AgentRunQueueState;
    subscribe(listener: AgentRunQueueListener): () => void;
    steer(text: string): void;
    followUp(text: string): void;
    clear(index?: number): void;
    /** Abort active work while retaining queued messages for the next run. */
    interrupt(): void;
    /** Release retained messages so a subsequent run can drain them. */
    resume(): void;
    /** Runtime hook. Not exported from package entry points. */
    _attach(agent: Agent): void;
    /** Runtime hook. Keeps undrained messages for a retry or resumed run. */
    _detach(agent: Agent): void;
    /** Runtime hook: Pi drains one queued message immediately before next turn. */
    _observe(event: AgentEvent): void;
    private emit;
}
```

Declared in `packages/agent/dist/run-controller.d.ts`.

### Interfaces

#### `CodingAgent`

```ts
export interface CodingAgent {
    readonly definition: AgentDefinition;
    /** The default efficiency plan: recoverable routes over the live zone. */
    readonly plan: CavePlan;
    readonly workspace: string;
    readonly modelID: string;
    readonly toolMode: CodingToolMode;
    /** Present only in programmatic mode. Session APIs wire its transport automatically. */
    readonly programmaticTools?: ProgrammaticToolRuntime;
    /** Largest raw tool outputs seen this process, kept for the recovery proof. */
    readonly samples: ToolOutputSample[];
    /** Kill live command sessions owned by this agent. Idempotent. */
    close(): Promise<void>;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingAgentOptions`

```ts
export interface CodingAgentOptions {
    /** Workspace root. Tools refuse to read or write outside it. */
    workspace?: string;
    /** `provider/model`. Defaults to `CAVE_MODEL`, else the one configured provider. */
    model?: string;
    /** Agent id; also the recovery namespace and default workflow name. */
    id?: string;
    /** Extra instruction text appended to the built-in coding instructions. */
    instructions?: string;
    /** Per-tool raw output caps in bytes, before any transform. */
    outputCaps?: Partial<typeof CODING_TOOL_OUTPUT_CAPS>;
    /** Provider-visible coding tools. Generic SDK default remains the full six-tool surface. */
    toolSet?: CodingToolSet;
    /** `programmatic` collapses ordinary tools into one bounded code-cell tool. */
    toolMode?: CodingToolMode;
    /** Safe read speculation in programmatic mode. Defaults on; ignored by direct mode. */
    speculativeToolCalls?: boolean;
    /** Optional bounded disk retention for command output evicted from memory. */
    commandSessionSpill?: CommandSessionSpillOptions;
    /** Interactive bash sessions. Defaults on locally and off for non-local backends. */
    commandSessions?: boolean;
    /** Workspace and process execution. Defaults to the local host backend. */
    executionBackend?: ExecutionBackend;
    /** Trusted product adapters applied before direct/programmatic tool finalization. */
    definitionTransforms?: readonly AgentDefinitionTransform[];
    /** Provider-visible composite tool name. Product wrappers may brand it; default `caveman_code`. */
    programmaticToolName?: string;
    /** `true` enables durable ambient memory with safe local defaults. */
    memory?: boolean | MemoryDefinition;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingRecoveryProof`

```ts
export interface CodingRecoveryProof extends SegmentRecoveryProof {
    segment: string;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingSession`

```ts
export interface CodingSession {
    readonly agent: CodingAgent;
    readonly conversation: ConversationState;
    readonly options: CodingSessionOptions;
    readonly gatewayURL: string;
    /**
     * The route resolved once, at session start. Every turn is handed this
     * instead of re-probing, so a session makes exactly one runtime-ensure
     * attempt however many turns it runs.
     */
    readonly route: ResolvedCaveRoute;
    mode: SessionMode;
    /** Every notice emitted, banner included. The loud fallback leaves a record. */
    readonly notices: string[];
    readonly turns: TurnRecord[];
    proofShown: boolean;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingSessionOptions`

```ts
export interface CodingSessionOptions {
    conversation?: ConversationState;
    cave?: "auto" | "off";
    gatewayURL?: string;
    engineBin?: string;
    workflow?: string;
    /** Defaults to long: coding sessions commonly outlive providers' short cache TTL. */
    cacheRetention?: CacheRetention;
    /** Best-effort local spend cap in USD at public catalog list prices. */
    maxCostUsd?: number;
    /** Hard per-turn task budget. Mutually exclusive with maxCostUsd. */
    budget?: RunBudget;
    /** Same-provider selector invoked at every root working model-call boundary. */
    modelRouter?: ModelCallRouter;
    /** Per-turn loop/no-progress/fan-out policy. Defaults to CODING_RUN_BREAKERS. */
    breakers?: RunBreakers;
    /** Receives every notice, including the observe-only banner. */
    onNotice?: (line: string) => void;
    /** Test seam: passed through to the gateway readiness probe. */
    fetch?: typeof globalThis.fetch;
    ensureRuntime?: boolean;
    /** Runtime memory adapters. Session creates/reuses local engine when omitted. */
    memory?: MemoryRuntimeConfig;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingSessionRunOptions`

```ts
export interface CodingSessionRunOptions extends CodingSessionOptions {
    agent?: CodingAgent;
    agentOptions?: CodingAgentOptions;
    input?: Readable;
    output?: Writable;
    notice?: Writable;
    /** Test and demo seam: per-turn run option overrides, e.g. a faux model. */
    runOverrides?: RunOptions;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingTaskAttemptEvidence`

One paid attempt in a matched coding-harness evaluation.

```ts
export interface CodingTaskAttemptEvidence {
    taskId: string;
    attemptId: string;
    provider: string;
    model: string;
    /** Completion must come from the task's external verifier, never agent self-report. */
    completed: boolean;
    completionBasis: "external_verifier" | "missing";
    /** Spend for this attempt. Failed attempts remain in the numerator. */
    costUsd: number | null;
    priceBasis: CodingTaskPriceBasis;
    /** Provider-counted total tokens for this attempt. */
    tokens: number | null;
    usageBasis: "provider_reported" | "unavailable";
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingTaskEconomics`

```ts
export interface CodingTaskEconomics {
    status: "complete" | "incomplete_evidence" | "no_completed_tasks";
    attempted: number;
    completed: number;
    completionRate: number | null;
    totalCostUsd: number | null;
    costPerCompletedTaskUsd: number | null;
    priceBasis: Exclude<CodingTaskPriceBasis, "unpriced"> | null;
    totalTokens: number | null;
    tokensPerCompletedTask: number | null;
    usageBasis: "provider_reported" | null;
    provider: string | null;
    model: string | null;
    issues: readonly string[];
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingTaskEconomicsOptions`

```ts
export interface CodingTaskEconomicsOptions {
    /** Planned attempts for this arm. Missing or extra attempts fail metrics closed. */
    expectedAttempts?: number;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CommandSessionReadOptions`

```ts
export interface CommandSessionReadOptions {
    sessionId: string;
    /** Absolute byte position in this session's combined stdout/stderr stream. */
    cursor?: number;
    /** Case-sensitive literal UTF-8 byte query. Returns the first retained match. */
    query?: string;
    limit?: number;
    /** Query reads wait for a match; other reads wait for bytes after `cursor`. */
    waitMs?: number;
    /** Cancels this read only. It never kills the session. */
    signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionReadResult`

```ts
export interface CommandSessionReadResult {
    readonly sessionId: string;
    readonly state: CommandSessionState;
    /** Requested absolute cursor. */
    readonly cursor: number;
    /**
     * Absolute cursor of the first returned byte. May advance when old bytes were
     * evicted, or begin before a query cursor when one literal spans that cursor.
     */
    readonly outputStart: number;
    /** Absolute cursor immediately after the returned bytes. */
    readonly nextCursor: number;
    /** `base64` preserves an exact page whose byte boundaries are not valid UTF-8. */
    readonly outputEncoding: "utf8" | "base64";
    readonly output: string;
    readonly availableFrom: number;
    readonly availableTo: number;
    readonly truncatedBeforeCursor: boolean;
    readonly hasMore: boolean;
    /** Query reads only: absolute first match, or `null` when scanned bytes had none. */
    readonly matchStart?: number | null;
    readonly exitCode: number | null;
    readonly exitSignal: NodeJS.Signals | null;
    readonly spawnError?: string;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionRuntime`

```ts
export interface CommandSessionRuntime {
    start(options: CommandSessionStartOptions): Promise<CommandSessionStartResult>;
    /** Snapshot retained sessions in start order. Command text is not retained or exposed. */
    list(): readonly CommandSessionSummary[];
    read(options: CommandSessionReadOptions): Promise<CommandSessionReadResult>;
    write(options: CommandSessionWriteOptions): Promise<CommandSessionWriteResult>;
    kill(sessionId: string): Promise<CommandSessionReadResult>;
    /** Kill every live child and wait for local handles to close. Idempotent. */
    close(): Promise<void>;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionRuntimeOptions`

```ts
export interface CommandSessionRuntimeOptions {
    /** Maximum simultaneously retained sessions. Completed sessions are evicted first. */
    maxSessions?: number;
    /** Maximum in-memory output bytes per session. Older bytes spill or discard first. */
    maxOutputBytes?: number;
    /** Optional bounded exact-output recovery for bytes evicted from memory. */
    spill?: CommandSessionSpillOptions;
    /** Maximum bytes returned by one read. */
    maxReadBytes?: number;
    /** Maximum bytes accepted by one stdin write. */
    maxInputBytes?: number;
    /** Maximum hard process lifetime. */
    maxTimeoutMs?: number;
    /** Maximum long-poll duration for one read. */
    maxWaitMs?: number;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionSpillOptions`

```ts
export interface CommandSessionSpillOptions {
    /** Existing absolute directory for private spill files. */
    directory: string;
    /** Maximum additional retained bytes per session. */
    maxBytes: number;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionStartOptions`

```ts
export interface CommandSessionStartOptions {
    command: string;
    args?: readonly string[];
    cwd: string;
    /** Explicit child environment. Ambient `process.env` is never inherited. */
    env: NodeJS.ProcessEnv;
    /** Session commands keep stdin writable by default; foreground callers may close it at launch. */
    stdin?: "pipe" | "closed";
    timeoutMs: number;
    signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionStartResult`

```ts
export interface CommandSessionStartResult {
    readonly sessionId: string;
    readonly state: "running";
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionSummary`

```ts
export interface CommandSessionSummary {
    readonly sessionId: string;
    readonly state: CommandSessionState;
    readonly availableFrom: number;
    readonly availableTo: number;
    readonly stdinOpen: boolean;
    readonly exitCode: number | null;
    readonly exitSignal: NodeJS.Signals | null;
    readonly spawnError?: string;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionWriteOptions`

```ts
export interface CommandSessionWriteOptions {
    sessionId: string;
    input: string;
    /** End stdin after this input is flushed, allowing readers to observe EOF. */
    closeStdin?: boolean;
    /** Cancels this write operation only. It never kills the session. */
    signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `CommandSessionWriteResult`

```ts
export interface CommandSessionWriteResult {
    readonly sessionId: string;
    readonly state: CommandSessionState;
    readonly accepted: boolean;
    readonly bytes: number;
    /**
     * Absolute output end captured before the stdin write attempt. Unknown
     * sessions return `0` because no owned output stream exists.
     */
    readonly outputCursor: number;
}
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `FailedStreamingTurn`

```ts
export interface FailedStreamingTurn {
    readonly failed: true;
    readonly receipt: RunReceipt;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `ProgrammaticToolRuntime`

```ts
export interface ProgrammaticToolRuntime {
    readonly definition: AgentDefinition;
    wrapModels(models: Models): Models;
    wrapStreamFn(streamFn: StreamFn): StreamFn;
    stats(): ProgrammaticToolStats;
    close(): void;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

#### `ProgrammaticToolStats`

```ts
export interface ProgrammaticToolStats {
    readonly launched: number;
    readonly claimed: number;
    readonly missed: number;
    readonly abandoned: number;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

#### `SessionBill`

```ts
export interface SessionBill {
    turns: number;
    mode: SessionMode;
    transformedTokensBefore: number;
    transformedTokensAfter: number;
    tokensSavedInferred: number;
    /** The basis of the summed reduction. Never blended across bases. */
    tokensBasis: TransformTrace["tokensBasis"];
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Provider-reported cached share across all session input, including cold seeds. */
    cacheInputTokenHitRatio: number | null;
    cacheHitTarget: number;
    cacheHitTargetMet: boolean | null;
    costUsd: number;
    priceBasis: RunResult["priceBasis"];
    usageBasis: RunResult["usageBasis"];
    transformIDs: string[];
    transformFailures: string[];
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `StreamingCodingTurnOptions`

```ts
export interface StreamingCodingTurnOptions {
    /** Caller overrides face the same internal-option rejection as runCodingTurn. */
    overrides?: RunOptions;
    /** Shared kernel queue/control handle. A fresh handle is created when omitted. */
    controller?: AgentRunController;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `ToolOutputSample`

```ts
export interface ToolOutputSample {
    readonly label: string;
    readonly text: string;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `TurnBill`

```ts
export interface TurnBill {
    turn: number;
    mode: SessionMode;
    provider: string;
    model: string;
    /** Per-kind context tokens for this run, from `RunResult.contextBill`. */
    contextBill: Record<string, number>;
    /** Sum of `transformTrace[].beforeTokens` over applied transforms. */
    transformedTokensBefore: number;
    /** Sum of `transformTrace[].afterTokens` over applied transforms. */
    transformedTokensAfter: number;
    /** before − after. A local token estimate, never a dollar figure. */
    tokensSavedInferred: number;
    /** The basis of before/after/saved. Never blended across bases. */
    tokensBasis: TransformTrace["tokensBasis"];
    transformIDs: string[];
    transformFailures: string[];
    recoveryResolved: boolean;
    usageBasis: RunResult["usageBasis"];
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Provider-reported cached share of all input tokens; null without complete usage. */
    cacheInputTokenHitRatio: number | null;
    cacheHitTarget: number;
    cacheHitTargetMet: boolean | null;
    costUsd: number;
    priceBasis: RunResult["priceBasis"];
    latencyMs: number;
}
```

Declared in `packages/agent/dist/code.d.ts`.

#### `TurnRecord`

```ts
export interface TurnRecord {
    input: string;
    text: string;
    toolCalls: string[];
    bill: TurnBill;
    /** True when this turn is the one that took the session to observe-only. */
    degraded: boolean;
    /** Canonical economic receipt returned by the same runtime result. */
    receipt: RunReceipt;
}
```

Declared in `packages/agent/dist/code.d.ts`.

### Type aliases

#### `CodingTaskPriceBasis`

```ts
export type CodingTaskPriceBasis = "provider_invoice" | "public_catalog" | "unpriced";
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingToolMode`

```ts
export type CodingToolMode = "direct" | "programmatic";
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CodingToolSet`

```ts
export type CodingToolSet = "full" | "pebble-v1";
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CommandSessionState`

```ts
export type CommandSessionState = "running" | "exited" | "timed_out" | "killed" | "unknown_after_restart";
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `SessionMode`

```ts
export type SessionMode = "optimized" | "observe-only";
```

Declared in `packages/agent/dist/code.d.ts`.

#### `StreamingCodingTurnResult`

```ts
export type StreamingCodingTurnResult = TurnRecord | FailedStreamingTurn;
```

Declared in `packages/agent/dist/code.d.ts`.

### Functions

#### `capOutput`

```ts
export declare function capOutput(text: string, maxBytes: number): string;
```

Declared in `packages/agent/dist/shell-tools.d.ts`.

#### `classifyTurnFailure`

A run that carries a plan refuses to degrade silently — it throws
`cave_gateway_required_for_locked_plan` instead. That specific failure, and
only that failure, earns one retry without the plan.

A session answers the routing question once and pins it, so a turn is never
the thing that discovers an absent gateway; this classification is what turns
that refusal into a sticky session degradation wherever it still comes from.

```ts
export declare function classifyTurnFailure(error: unknown): "degrade_to_observe_only" | "fatal";
```

Declared in `packages/agent/dist/code.d.ts`.

#### `codingModelsAtProviderBaseURL`

Clone model records for one provider onto an explicit API base URL while
retaining Pi's provider-owned auth and wire implementation. This is an
endpoint override, not gateway routing: callers remain in direct-provider
mode and every same-provider model selected later receives the same base.

```ts
export declare function codingModelsAtProviderBaseURL(modelID: string, rawBaseURL: string, source?: Models): Models;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `createCodingAgent`

```ts
export declare function createCodingAgent(options?: CodingAgentOptions): CodingAgent;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `createCommandSessionRuntime`

Create a command-session owner. Output stays memory-only unless bounded
spill is explicitly configured. IDs deliberately name only this runtime's
children: unknown IDs are reported as `unknown_after_restart` and are never
adopted from operating-system process state.

```ts
export declare function createCommandSessionRuntime(options?: CommandSessionRuntimeOptions): CommandSessionRuntime;
```

Declared in `packages/agent/dist/command-session.d.ts`.

#### `createProgrammaticToolRuntime`

```ts
export declare function createProgrammaticToolRuntime(directDefinition: AgentDefinition, options?: {
    readonly instructions?: string;
    readonly speculate?: boolean;
    readonly toolName?: string;
}): ProgrammaticToolRuntime;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

#### `defaultCodingPlan`

The default efficiency plan for an interactive coding session.

One route per dynamic segment kind, because the runtime refuses an ambiguous
dynamic route (two routes matching one runtime segment collapse to
`dynamic_route_ambiguous` and the segment passes through untouched). Budgets
are sized for a long interactive session rather than a fixture run; they are
ceilings that fail the turn honestly rather than silently truncating context.

```ts
export declare function defaultCodingPlan(modelID: string, namespace: string): CavePlan;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `formatRecoveryProof`

```ts
export declare function formatRecoveryProof(proof: CodingRecoveryProof): string;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `formatSessionBill`

```ts
export declare function formatSessionBill(bill: SessionBill): string[];
```

Declared in `packages/agent/dist/code.d.ts`.

#### `formatTurnBill`

```ts
export declare function formatTurnBill(bill: TurnBill, sessionSaved: number): string[];
```

Declared in `packages/agent/dist/code.d.ts`.

#### `programmaticToolInstructions`

```ts
export declare function programmaticToolInstructions(additional: string | undefined, options?: ProgrammaticToolInstructionOptions): string;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

#### `proveRecovery`

Take the largest raw tool output this session produced, push it through the
same engine compress/retrieve pair the plan and `cave_retrieve` use, and
compare bytes. This is the reversibility proof, not a savings claim.

```ts
export declare function proveRecovery(session: CodingSession): Promise<CodingRecoveryProof>;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `runCodingSession`

Interactive coding session over stdin/stdout. Returns the final bill.

```ts
export declare function runCodingSession(options?: CodingSessionRunOptions): Promise<SessionBill>;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `runCodingTurn`

```ts
export declare function runCodingTurn(session: CodingSession, input: string, overrides?: RunOptions): Promise<TurnRecord>;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `sessionBill`

```ts
export declare function sessionBill(session: CodingSession): SessionBill;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `startCodingSession`

Start a session in the best mode this machine can actually deliver.

With `cave: "auto"` this probes the local Cave runtime and starts it when it
is installed but not running, so a machine with the engine present is
optimized from the first turn. When the probe fails, the session degrades to
observe-only **loudly**: the banner is emitted through `onNotice` and recorded
on the session, and every turn afterwards reports `observe-only`.

The probe happens **once**. Its answer is kept on the session and handed to
every turn, so a machine with no runtime pays one failed start attempt for the
whole session rather than one per turn.

```ts
export declare function startCodingSession(codingAgent: CodingAgent, options?: CodingSessionOptions): Promise<CodingSession>;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `streamCodingTurn`

Stream one coding turn as frozen Pebble v1 events.

Pi deltas and tool rows pass through live. Provider usage is emitted once per
assistant message. A gateway-plan refusal is retried observe-only without
painting a transient error; terminal errors appear exactly once after retry.

```ts
export declare function streamCodingTurn(session: CodingSession, input: string, options?: StreamingCodingTurnOptions): AsyncGenerator<TurnEvent, StreamingCodingTurnResult | undefined>;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `summarizeCodingTaskAttempts`

Honest harness metric: all attempt spend divided by externally verified
completions. Unknown or mixed evidence produces null, never a favorable zero.

```ts
export declare function summarizeCodingTaskAttempts(attempts: readonly CodingTaskAttemptEvidence[], options?: CodingTaskEconomicsOptions): CodingTaskEconomics;
```

Declared in `packages/agent/dist/code.d.ts`.

### Variables & constants

#### `CODING_RUN_BREAKERS`

Cost-control defaults for coding runs. No retry policy: retries require a declared budget.

```ts
export declare const CODING_RUN_BREAKERS: RunBreakers;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `CODING_TOOL_OUTPUT_CAPS`

Raw output caps, applied by each tool **before** any transform runs, so a
runaway `cat` cannot blow the context even with the engine absent. They also
sit under the runtime's 32 KiB inline tool-result ceiling, which is what keeps
observe-only sessions working on a machine with no engine at all.

```ts
export declare const CODING_TOOL_OUTPUT_CAPS: Readonly<{
    read_file: 24000;
    grep: 16000;
    bash: 24000;
    write_file: 2000;
    edit_file: 2000;
    read_tool_output: 24000;
}>;
```

Declared in `packages/agent/dist/shell-tools.d.ts`.

#### `OBSERVE_ONLY_BANNER`

```ts
export declare const OBSERVE_ONLY_BANNER: string;
```

Declared in `packages/agent/dist/code.d.ts`.

#### `PROGRAMMATIC_TOOL_NAME`

Provider-visible tool replacing an agent's ordinary tool surface in programmatic mode.

```ts
export declare const PROGRAMMATIC_TOOL_NAME = "caveman_code";
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

#### `RECOVERABLE_CODING_TRANSFORMS`

The only transforms a default coding plan may route. Every one of them is
CCR-recoverable (`recovery: exact_ccr`) and the runtime proves the round trip
byte-for-byte before a compressed body is allowed near the provider. `toon` is
excluded on purpose: it is forced-only structured re-encoding, never a default.

```ts
export declare const RECOVERABLE_CODING_TRANSFORMS: readonly string[];
```

Declared in `packages/agent/dist/code.d.ts`.

## `@caveman-ai/coding-agent/cli`

Declaration file: `packages/coding-agent/src/cli.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CodingAgentCLIOptions`
- **Function**: `main`, `parseCodingAgentCLIArgs`
- **Variable**: `CODING_AGENT_HELP`

</details>

### Interfaces

#### `CodingAgentCLIOptions`

```ts
export interface CodingAgentCLIOptions {
  readonly help: boolean;
  readonly workspace?: string;
  readonly model?: string;
  readonly cave?: "off";
  readonly maxCostUsd?: number;
  readonly ensureRuntime?: false;
}
```

Declared in `packages/coding-agent/src/cli.d.ts`.

### Functions

#### `main`

```ts
export function main(
  argv?: string[],
  io?: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  runtime?: {
    createCodingAgent(options?: { workspace?: string; model?: string }): NonNullable<CodingSessionRunOptions["agent"]>;
    runCodingSession(options?: CodingSessionRunOptions): Promise<SessionBill>;
  },
): Promise<SessionBill | undefined>;
```

Declared in `packages/coding-agent/src/cli.d.ts`.

#### `parseCodingAgentCLIArgs`

```ts
export function parseCodingAgentCLIArgs(argv: readonly string[]): CodingAgentCLIOptions;
```

Declared in `packages/coding-agent/src/cli.d.ts`.

### Variables & constants

#### `CODING_AGENT_HELP`

```ts
export const CODING_AGENT_HELP: string;
```

Declared in `packages/coding-agent/src/cli.d.ts`.

