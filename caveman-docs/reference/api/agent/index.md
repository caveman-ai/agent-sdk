# `@caveman-ai/agent`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/index.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `AgentRunController`, `BudgetController`, `CavemanRunError`, `ConnectRuntime`, `DiskDurableStore`, `HttpDurableStore`, `MemoryEngine`, `ProgrammaticSpeculationScope`
- **Interface**: `AgentAudioInputPart`, `AgentDefinition`, `AgentDefinitionTransform`, `AgentDirConfig`, `AgentDirModules`, `AgentDirRunDefaults`, `AgentFileInputPart`, `AgentImageInputPart`, `AgentInputBase64Source`, `AgentInputEncoder`, `AgentInputURLSource`, `AgentOpaqueInputPart`, `AgentStaticContextDiagnostics`, `AgentTextInputPart`, `ArtifactDefinition`, `BreakerEvent`, `BudgetExhaustionContext`, `BudgetTranche`, `CapturedModelBoundary`, `CapturedModelBoundaryCall`, `CompactionOptions`, `CompiledPipelineResult`, `CompileProfiledInput`, `CompileProfiledNativePiInput`, `CompileProfiledResult`, `CompilerTarget`, `CompleteModelUsage`, `CompletionMemorySidecarOptions`, `ConnectAction`, `ConnectConnection`, `ConnectEfficiencyComparison`, `ConnectEfficiencyRun`, `ConnectExecuteOptions`, `ConnectIntegration`, `ConnectMcpCallResult`, `ConnectMcpTool`, `ConnectMcpToolAnnotations`, `ConnectMcpToolExecution`, `ConnectMcpToolIcon`, `ConnectOptions`, `ConnectProcessResult`, `ConnectQualityPolicy`, `ConnectRuntimeOptions`, `ConnectSource`, `ConnectToolRuntimeDefinition`, `ContextAnchor`, `ContextCompactionFixture`, `ContextCompactionFixtureRound`, `ContextCompactionHarnessOptions`, `ContextCompactionHarnessResult`, `ContextCompactionHarnessRoundResult`, `ContextCompactionSummarizerRequest`, `ContextDefinition`, `ContextIR`, `ContextIRWire`, `ContextSegment`, `ContextSegmentWire`, `ContextSummary`, `ContextSummaryEvaluation`, `ContextSummaryEvaluationInput`, `ContextSummaryRound`, `ContextSummarySource`, `ContextSummaryStability`, `ContextSummaryValidation`, `CreateMemoryEngineOptions`, `DurableRunOptions`, `DurableStore`, `EvalDefinition`, `ExecRequest`, `ExecResult`, `ExecuteCompiledPipelineInput`, `ExecutionBackend`, `ExpectedContextAnchor`, `FileSource`, `HttpDurableStoreOptions`, `LoweredContext`, `MemoryAmbientOptions`, `MemoryCompletionRequest`, `MemoryConsolidationInput`, `MemoryDefinition`, `MemoryDraft`, `MemoryEdge`, `MemoryEmbeddingAdapter`, `MemoryExtractionInput`, `MemoryHit`, `MemoryRecall`, `MemoryRecord`, `MemoryRememberInput`, `MemoryReviewInput`, `MemoryReviewResult`, `MemoryRuntimeConfig`, `MemoryScope`, `MemorySearchOptions`, `MemorySessionHit`, `MemorySidecarAdapter`, `MemorySource`, `MemoryState`, `MemoryStorageAdapter`, `MemoryStoreConfig`, `MemoryTurn`, `MemoryTurnInput`, `MemoryVector`, `ModelBoundary`, `ModelBoundaryContext`, `ModelBoundaryFailed`, `ModelBoundaryMiddleware`, `ModelBoundaryPrepare`, `ModelBoundarySettled`, `ModelCallRouteDecision`, `ModelCallRouteInput`, `ModelUsage`, `NativePiCandidatePlanningInput`, `NestedToolDispatchOptions`, `NormalizedAgentInput`, `NormalizedCompaction`, `NormalizedConnectAction`, `NormalizedConnectQualityPolicy`, `NormalizedConnectSource`, `NormalizedToolActivity`, `NormalizedTrajectory`, `NormalizeTrajectoryOptions`, `OpenAICompatibleMemoryEmbeddingOptions`, `OutputDefinition`, `PreparedModelBoundaryCall`, `ProfileToolEffect`, `ProgrammaticSpeculationActivation`, `ProgrammaticSpeculationLaunch`, `ProgrammaticToolInstructionOptions`, `ProgrammaticToolRuntime`, `ProgrammaticToolStats`, `ReceiptCall`, `ReceiptCompaction`, `ReceiptLike`, `ReceiptPrintCall`, `ReceiptResume`, `ReceiptTool`, `ResolvedEgressPolicy`, `RoutineOutcomeCount`, `RunBreakers`, `RunBudget`, `RunOptions`, `RunReceipt`, `RunResult`, `RuntimeContextSegment`, `SandboxEgressPolicy`, `ShellToolsOptions`, `StandardInputOutputToolOptions`, `StandardJSONOutputToolOptions`, `StandardJSONToolOptions`, `StandardJSONTypeBoxOutputToolOptions`, `StandardOutputToolOptions`, `StandardToolOptions`, `StandardTypeBoxOutputToolOptions`, `SubagentRuntimeDefinition`, `ToolCallDenial`, `ToolCallPolicyInput`, `ToolDefinition`, `ToolExecutionContext`, `ToolOptions`, `TypeBoxOutputToolOptions`, `WorkloadPartition`, `WorkloadProfile`
- **Type alias**: `AgentDirContextValue`, `AgentInput`, `AgentInputPart`, `AgentInputSource`, `AgentOutput`, `Auto`, `BudgetDenomination`, `BudgetExhaustionHandler`, `CacheRegion`, `CavemanRunEvent`, `ConnectActionBindValue`, `ConnectExecutor`, `ContextAnchorKind`, `ContextCompactionSummarizer`, `ContextKind`, `ContextPriority`, `ContextStability`, `ConversationState`, `DurableRunSummary`, `EvalGuardrail`, `EvalSplit`, `FiniteJSON`, `MemoryKind`, `MemoryRelation`, `ModelBoundaryRole`, `ModelCallRouter`, `ModelUsageAccountingStatus`, `ModelUsageCost`, `ModelUsageTokenCount`, `PrivacyClass`, `ProfiledCompileStatus`, `ProgrammaticSpeculationDispatch`, `QualityGrader`, `RecoveryKind`, `RoutineOutcome`, `RunStopReason`, `SafetyClass`, `SandboxEgress`, `ShellToolName`, `StandardToolSchema`, `ToolCallDecision`, `ToolCallPolicy`, `ToolEffect`, `ToolResultPolicy`, `ToolRuntimeDefinition`, `TrajectorySource`, `WorkloadSplit`
- **Function**: `agent`, `agentStaticContextDiagnostics`, `appendRuntimeContextSegment`, `applyAgentDefinitionTransforms`, `artifact`, `assertProfiledBuildTarget`, `assertQualityGrader`, `auto`, `capabilityManifestFor`, `captureModelBoundary`, `compareConnectEfficiency`, `compileProfiled`, `compileProfiledNativePi`, `completionMemorySidecar`, `composeAgentDir`, `connectEnvironment`, `context`, `contextBill`, `contextIRFromWire`, `contextIRToWire`, `contextSummarySources`, `cosine`, `createBudgetController`, `createCompilerWorkloadProfile`, `createConnect`, `createConversation`, `createFileMemoryAdapter`, `createInMemoryMemoryStorage`, `createMemoryEngine`, `createMemoryWorkflow`, `createModelBoundary`, `createProgrammaticToolErrorWrapper`, `createProgrammaticToolRuntime`, `createSparseEmbeddingAdapter`, `createWorkloadProfile`, `decideToolCall`, `defineAgentInputEncoder`, `defineModelUsage`, `defineRunReceipt`, `durableInputIsReplayable`, `durableRunSummary`, `egressAllowed`, `emptyMemoryState`, `encodeAgentInput`, `eval`, `evalFixture`, `evaluateContextSummary`, `evaluateContextSummaryStability`, `executeCompiledPipeline`, `executeConnectTool`, `file`, `httpExecutionBackend`, `latestContextSummary`, `loadAgentDir`, `localExecutionBackend`, `lowerContext`, `memory`, `memoryTTLMilliseconds`, `modelUsageAccountingStatus`, `nativePiCompilerTarget`, `normalizeAgentInput`, `normalizeCompaction`, `normalizeTrajectory`, `opaquePayload`, `openAICompatibleMemoryEmbedding`, `output`, `packVector`, `parseContextSummary`, `parseNormalizedTrajectory`, `parseWorkloadProfile`, `planNativePiCandidates`, `programmaticToolInstructions`, `programmaticToolMetadata`, `renderReceipt`, `renderSummary`, `requireCompleteModelUsage`, `resolveConnectBinary`, `resolveEgressPolicy`, `routine`, `routineOutcomes`, `run`, `runContextCompactionHarness`, `runLocked`, `sha256`, `shellTools`, `stableStringify`, `stream`, `subagent`, `summarizationInstruction`, `tool`, `validateContextSummaryTransition`, `verifySandboxConformance`, `workloadSplitSHA256`
- **Variable**: `AGENT_DIR_ENTRY`, `AGENT_INPUT_MAX_BASE64_BYTES_PER_PART`, `AGENT_INPUT_MAX_BASE64_BYTES_TOTAL`, `AGENT_INPUT_MAX_FILE_NAME_LENGTH`, `AGENT_INPUT_MAX_MIME_LENGTH`, `AGENT_INPUT_MAX_PARTS`, `AGENT_INPUT_MAX_TEXT_BYTES`, `AGENT_INPUT_MAX_URL_LENGTH`, `AGENT_RUN_RECEIPT_SCHEMA`, `AUTO`, `MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH`, `MODEL_BOUNDARY_MAX_ID_LENGTH`, `MODEL_BOUNDARY_MAX_MIDDLEWARE`, `OUTPUT_CLAMP_FLOOR_TOKENS`, `PROFILED_COMPILER_SHA256`, `PROFILED_COMPILER_VERSION`, `PROGRAMMATIC_TOOL_NAME`, `schema`, `SUMMARY_SCHEMA_VERSION`, `TARGET_CAPABILITY_LATTICE`, `TOOL_POLICY_TIMEOUT_MS`, `TRAJECTORY_IR_SCHEMA_VERSION`, `validateRunReceipt`, `WORKLOAD_PROFILE_SCHEMA_VERSION`

</details>

## Classes

### `AgentRunController`

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

### `BudgetController`

The handle a developer uses to release staged budget.

Tranches are released at **deterministic, developer-defined** checkpoints —
a plan produced, a build compiled, tests located. Nothing the model says can
reach this object: it exists only in the embedding application's own code and
in tool implementations the developer wrote, which keeps every model out of
the money path.

A controller is bound to exactly one live run at a time and is inert outside
one, so a stale handle cannot quietly release budget into nothing.

```ts
export declare class BudgetController {
    /**
     * Release a further tranche. Throws past `max`, at the release site: the
     * checkpoint asked for something the run's contract cannot grant, and that is
     * a programming error rather than a run outcome.
     */
    releaseBudget(amount: number, reason: string): BudgetTranche;
    /** Metered spend so far, in the run's denomination. */
    get spent(): number;
    /** Budget available to the next call right now. */
    get remaining(): number;
    /** Total released so far, across every tranche. */
    get released(): number;
    get max(): number;
    get denomination(): BudgetDenomination;
    get tranches(): readonly BudgetTranche[];
    private meter;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `CavemanRunError`

The error thrown by the promise-returning run entry points (`runAgent`,
`runAgentInternal`) when a run fails. Unlike a bare `Error`, it carries the
failing run's partial `receipt` so a caller that only awaits the promise —
never consuming the event stream — can still read the ledger of what was
spent before the failure. The `cave_*` code is on `code`.

```ts
export declare class CavemanRunError extends Error {
    readonly code: string;
    readonly receipt: RunReceipt;
    constructor(code: string, message: string, receipt: RunReceipt);
}
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `ConnectRuntime`

```ts
export declare class ConnectRuntime {
    #private;
    constructor(options?: ConnectRuntimeOptions);
    delegate(args: readonly string[], signal?: AbortSignal): Promise<number>;
    connect(provider: string, onOutput?: ConnectExecuteOptions["onOutput"], signal?: AbortSignal): Promise<void>;
    call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ConnectMcpCallResult>;
    /** Lists detached connection metadata. Credential fields are never projected. */
    connections(signal?: AbortSignal): Promise<readonly ConnectConnection[]>;
    /**
     * Lists every MCP tool through exact cursor pagination. Discovery is bounded
     * and returns only detached, deeply frozen plain data.
     */
    listTools(signal?: AbortSignal): Promise<readonly ConnectMcpTool[]>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `DiskDurableStore`

JSONL journal on local disk: `<root>/<runId>/journal.jsonl` plus a `lock`
file holding the owning pid. Appends fsync before resolving. This is the
dev/default store; production deployments that need shared storage supply
their own {@link DurableStore}.

```ts
export declare class DiskDurableStore implements DurableStore {
    private readonly root;
    private readonly handles;
    constructor(root: string);
    private runDir;
    load(runId: string): Promise<readonly string[]>;
    private handle;
    append(runId: string, data: string): Promise<void>;
    acquire(runId: string): Promise<() => Promise<void>>;
    close(runId: string): Promise<void>;
    /**
     * The runId of every journal under the root, read from each journal's own
     * `run_started` event rather than reconstructed from the directory name —
     * the name carries a digest suffix and is not the identity. A directory
     * without a readable first event is skipped: an unreadable journal is not
     * a run this store can name, and inventing an id would be worse than
     * omitting it.
     */
    list(): Promise<readonly string[]>;
    /** First newline-terminated line, without reading a multi-megabyte journal. */
    private firstLine;
}
```

Declared in `packages/agent/dist/durable-stores.d.ts`.

### `HttpDurableStore`

A {@link DurableStore} over HTTP, so the journal can outlive the process
AND the machine — the shape a container platform needs, where local disk is
scratch space that disappears with the instance.

Two deliberate refusals:

- **Appends are never retried.** A retried append after an ambiguous
  failure could duplicate journal events, and a duplicated `call_settled`
  is silently wrong money. The append fails, the run fails, and the resume
  re-drives from a journal that is still true.
- **A lost lock lease poisons the store.** The lease is what stops two
  instances driving one run. If a renewal fails, this process can no longer
  prove it is the only driver, so every later append throws rather than
  writing into a journal another instance may now own.

```ts
export declare class HttpDurableStore implements DurableStore {
    private readonly base;
    private readonly token;
    private readonly fetchFn;
    private readonly lockTtlMs;
    private readonly requestTimeoutMs;
    private readonly leases;
    private readonly lost;
    constructor(options: HttpDurableStoreOptions);
    private request;
    private runPath;
    load(runId: string): Promise<readonly string[]>;
    append(runId: string, data: string): Promise<void>;
    acquire(runId: string): Promise<() => Promise<void>>;
    /** Lease renewal. Losing it poisons the run rather than risking two drivers. */
    private renew;
    close(runId: string): Promise<void>;
    list(): Promise<readonly string[]>;
}
```

Declared in `packages/agent/dist/durable-stores.d.ts`.

### `MemoryEngine`

```ts
export declare class MemoryEngine {
    readonly scope: MemoryScope;
    readonly storage: MemoryStorageAdapter;
    readonly embedding: MemoryEmbeddingAdapter | undefined;
    private readonly sidecar;
    private readonly ttlMs;
    private readonly recallTokens;
    private readonly maxResults;
    private readonly minScore;
    private readonly graphDepth;
    private readonly maxSessionTurns;
    private readonly ambient;
    private readonly now;
    private readonly onError;
    private readonly allowStore;
    private readonly sessions;
    private readonly pending;
    private tail;
    private writesSinceConsolidation;
    private consolidating;
    constructor(options: CreateMemoryEngineOptions);
    /**
     * Zero-latency passive seam. Returns completed recall from prior turn, then
     * queues current turn. Slow embeddings or sidecars never delay main agent.
     */
    beginTurn(input: MemoryTurnInput): MemoryRecall | undefined;
    /** Queues assistant response for session RAG and ambient extraction. */
    endTurn(input: MemoryTurnInput): void;
    /** Waits only when caller deliberately closes/flushes session. */
    endSession(sessionId: string, signal?: AbortSignal): Promise<void>;
    flush(): Promise<void>;
    remember(input: MemoryRememberInput, signal?: AbortSignal): Promise<MemoryRecord>;
    search(query: string, options?: MemorySearchOptions): Promise<readonly MemoryHit[]>;
    recall(query: string, options?: MemorySearchOptions): Promise<MemoryRecall>;
    searchSessions(query: string, options?: Omit<MemorySearchOptions, "graphDepth">): Promise<readonly MemorySessionHit[]>;
    forget(id: string): Promise<boolean>;
    link(from: string, to: string, relation: MemoryRelation, weight?: number): Promise<void>;
    consolidate(signal?: AbortSignal): Promise<void>;
    private enqueue;
    private processTurn;
    private extract;
    private reinforceRecall;
    private embedOne;
    private assertStoreAllowed;
    private canStore;
    private report;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `ProgrammaticSpeculationScope`

One run's speculation state. It never outlives run(), and claim identity is
the conjunction of run scope, provider stream turn, final message object,
final provider tool-call ID, and source bytes.

```ts
export declare class ProgrammaticSpeculationScope {
    readonly runId: string;
    readonly parent: ToolDefinition;
    readonly metadata: ProgrammaticMetadata;
    readonly dispatch: ProgrammaticSpeculationDispatch;
    readonly onAbandoned: ((provisionalParentToolCallId: string) => void) | undefined;
    readonly turns: Set<KernelSpeculationTurn>;
    readonly turnsByMessage: WeakMap<object, KernelSpeculationTurn>;
    readonly activeByParent: Map<string, KernelSpeculativeCell>;
    turnSequence: number;
    closed: boolean;
    closePromise: Promise<void> | undefined;
    settlementError: Error | undefined;
    constructor(runId: string, parent: ToolDefinition, dispatch: ProgrammaticSpeculationDispatch, onAbandoned?: (provisionalParentToolCallId: string) => void);
    wrapStream(source: AssistantMessageEventStream): AssistantMessageEventStream;
    activate(parentToolCallId: string, assistantMessage: AssistantMessage, code: unknown): ProgrammaticSpeculationActivation | undefined;
    claim(parentToolCallId: string, name: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> | undefined;
    finish(parentToolCallId: string): Promise<void>;
    settleBeforeNextStream(): Promise<void>;
    close(): Promise<void>;
    private settleAndClose;
    forget(turn: KernelSpeculationTurn): void;
    recordSettlementError(error: unknown): void;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

## Interfaces

### `AgentAudioInputPart`

```ts
export interface AgentAudioInputPart {
    readonly type: "audio";
    readonly mimeType: string;
    readonly source: AgentInputSource;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentDefinition`

```ts
export interface AgentDefinition<TOutput extends TSchema | undefined = TSchema | undefined> {
    readonly kind: "agent";
    readonly id: string;
    readonly instructions: string | FileSource;
    readonly model: Auto | string | Model<Api>;
    readonly reasoning: "off" | "minimal" | "low" | "medium" | "high";
    readonly tools: readonly ToolDefinition[];
    readonly contexts: readonly ContextDefinition[];
    readonly memory?: MemoryDefinition;
    /** Declared output contract; its schema types `RunResult.output`. */
    readonly output?: OutputDefinition<TOutput>;
    /**
     * Tool containment posture.
     *
     * - `"required"` (default): tool closures run in network-denied isolated
     *   Node workers imported from an immutable staged source graph, so
     *   `RunOptions.entryPath` is mandatory.
     * - `"fixture"`: trusted tests only — closures run in the host process and
     *   `effect: "write"` tools are blocked before they execute.
     * - `"host"`: explicit opt-in for interactive and coding agents whose tools
     *   need real host access. Closures run in the host process with no worker
     *   spawn and no `entryPath` requirement, and `effect: "write"` tools do
     *   execute. Effect declarations stay mandatory — host mode changes
     *   enforcement, not declaration. A host-mode agent is never lock-eligible:
     *   `compile` refuses it with `cave_host_sandbox_lock_ineligible`, and locked
     *   builds for coding agents compile against fixture corpora instead. Host
     *   mode is refused under a sandbox-required ancestor so a subagent cannot
     *   escape its root's containment. Host execution is never isolation.
     */
    readonly sandbox: "required" | "fixture" | "host";
    /**
     * Whether the author named a sandbox posture. `false` means the `"required"`
     * above is the type-level default rather than a stated intent, which is what
     * lets `run()`/`stream()` execute on the host (loudly) when no `entryPath` is
     * supplied. An explicit posture — including an explicit `"required"` — is
     * never reinterpreted.
     */
    readonly sandboxDeclared: boolean;
}
```

Declared in `packages/agent/dist/definition.d.ts`.

### `AgentDefinitionTransform`

Trusted, explicit definition transform applied by an embedding product.

```ts
export interface AgentDefinitionTransform {
    readonly id: string;
    readonly apply: (definition: AgentDefinition) => AgentDefinition;
}
```

Declared in `packages/agent/dist/definition.d.ts`.

### `AgentDirConfig`

The shape `agent.ts` default-exports in an agent directory.

```ts
export interface AgentDirConfig {
    model: AgentDefinition["model"];
    /** Run default; an explicit `RunOptions.budget` overrides it. */
    budget?: RunBudget;
    /** Run default; explicit `RunOptions.breakers` override it. */
    breakers?: RunBreakers;
    /** Extra prefix segments, lowered through the `context()` primitive. */
    context?: Record<string, AgentDirContextValue>;
}
```

Declared in `packages/agent/dist/dir-loader.d.ts`.

### `AgentDirModules`

What the generated entry hands `composeAgentDir` — see `loadAgentDir`.

```ts
export interface AgentDirModules {
    id: string;
    instructions: string;
    config: AgentDirConfig;
    /** Keyed by tool filename minus `.ts`; values must be `tool()` results. */
    tools: Record<string, unknown>;
    subagents?: Record<string, AgentDefinition>;
}
```

Declared in `packages/agent/dist/dir-loader.d.ts`.

### `AgentDirRunDefaults`

```ts
export interface AgentDirRunDefaults {
    rootDir?: string;
    /** Relative to `rootDir`; the generated module entry the sandbox stages from. */
    entryPath?: string;
    budget?: RunBudget;
    breakers?: RunBreakers;
}
```

Declared in `packages/agent/dist/dir-loader.d.ts`.

### `AgentFileInputPart`

```ts
export interface AgentFileInputPart {
    readonly type: "file";
    readonly mimeType: string;
    readonly source: AgentInputSource;
    readonly name?: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentImageInputPart`

```ts
export interface AgentImageInputPart {
    readonly type: "image";
    readonly mimeType: string;
    readonly source: AgentInputSource;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputBase64Source`

```ts
export interface AgentInputBase64Source {
    readonly type: "base64";
    readonly data: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputEncoder`

```ts
export interface AgentInputEncoder<Output> {
    readonly id: string;
    /** Pure capability check. Called for every part before `encode`. */
    readonly supports: (part: AgentInputPart) => boolean;
    /** Encodes normalized data only. URL retrieval remains provider/host-owned. */
    readonly encode: (input: NormalizedAgentInput, signal: AbortSignal) => Output | Promise<Output>;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputURLSource`

```ts
export interface AgentInputURLSource {
    readonly type: "url";
    readonly url: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentOpaqueInputPart`

```ts
export interface AgentOpaqueInputPart {
    readonly type: "opaque";
    readonly provider: string;
    readonly value: FiniteJSON;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentStaticContextDiagnostics`

```ts
export interface AgentStaticContextDiagnostics {
    /** UTF-8 JSON bytes for provider-visible system prompt plus active tool schemas. */
    readonly staticContextBytes: number;
    readonly availableToolCount: number;
    readonly basis: "system_prompt_plus_active_tool_definitions_json_utf8";
}
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `AgentTextInputPart`

```ts
export interface AgentTextInputPart {
    readonly type: "text";
    readonly text: string;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `ArtifactDefinition`

```ts
export interface ArtifactDefinition {
    readonly kind: "artifact";
    readonly strategy: "verbatim" | "json-index" | "page";
    readonly maxInlineTokens: number;
    readonly recovery: "exact_ccr" | "source_ref";
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `BreakerEvent`

One breaker decision, recorded on the receipt so a break is never silent.

```ts
export interface BreakerEvent {
    readonly kind: "loop_detected" | "no_progress" | "fan_out_blocked" | "retry_attempted" | "retry_exhausted";
    readonly tool: string | undefined;
    /** Repeats for a loop, identical turns for no-progress, blocked calls for fan-out, attempt number for a retry. */
    readonly count: number;
    /** The call hash for a loop break, so the offending window is identifiable. */
    readonly signature: string | undefined;
    /** Worst-case hold taken for this retry, in the run budget's denomination. */
    readonly reservedSpend?: number;
    /** Provider-measured spend, zero for the only retryable pre-stream failure. */
    readonly measuredSpend?: number;
    /** Why measuredSpend is trustworthy, or why worst-case settlement was used. */
    readonly spendBasis?: "pre_stream_no_usage" | "provider_reported" | "unavailable_worst_case";
}
```

Declared in `packages/agent/dist/breakers.d.ts`.

### `BudgetExhaustionContext`

What the numeric continuation hook receives when a budget binds. Read-only;
every figure is in the run's own denomination.

```ts
export interface BudgetExhaustionContext {
    readonly denomination: BudgetDenomination;
    readonly max: number;
    readonly released: number;
    readonly spent: number;
    readonly remaining: number;
    /** How much could still be released without breaching `max`. */
    readonly releasable: number;
    /** Provider calls this run has already made. */
    readonly calls: number;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `BudgetTranche`

One staged release of budget.

```ts
export interface BudgetTranche {
    readonly amount: number;
    readonly reason: string;
    readonly atCall: number;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `CapturedModelBoundary`

Host-side, hostile-safe view of one configured model boundary.

```ts
export interface CapturedModelBoundary<Request, Response> {
    prepare(request: Request, context: ModelBoundaryContext): Promise<CapturedModelBoundaryCall<Request, Response>>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `CapturedModelBoundaryCall`

A prepared call whose terminal observer is diagnostic-only and can fire at
most once. The host retains provider I/O and native result ownership.

```ts
export interface CapturedModelBoundaryCall<Request, Response> {
    readonly request: Request;
    settled(response: Response): void;
    failed(error: unknown): void;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `CompactionOptions`

Budget-triggered compaction: while four full cold next-call ceilings remain,
compress instead of waiting for exhaustion to make the rewrite unaffordable.

This file is the only place in

```ts
export interface CompactionOptions {
    /**
     * How many times one run may compact. Defaults to 1: repeated-compaction
     * degradation is real and unmeasured, a budget-bound run is short by
     * construction, and one compaction is the case the affordability model can
     * actually predict.
     */
    readonly maxCompactions?: number;
    /** Token budget for the verbatim recent tail. Defaults to 8,000. */
    readonly keepRecentTokens?: number;
    /**
     * Hard cap on the summary's own output. Output length is the dominant cost
     * term of a compaction event. Defaults to 2,048.
     */
    readonly summaryMaxTokens?: number;
    /**
     * Minimum context reduction that makes a compaction worth its call. A rewrite
     * that frees a few thousand tokens has paid a summarizer call and a full
     * cache rewrite for nothing. Defaults to 20,000.
     */
    readonly minYieldTokens?: number;
    /**
     * Working calls the post-compaction budget must still cover. Break-even is
     * several calls, so a compaction that buys exactly one is guaranteed to lose.
     * Defaults to 3.
     */
    readonly headroomCalls?: number;
    /**
     * Cap on pinned user-intent text carried verbatim through a compaction,
     * newest-first. Defaults to 20,000.
     */
    readonly pinnedUserTokens?: number;
    /**
     * Preserve the first real user message verbatim even when it exceeds the
     * normal pin budget. Defaults to true. A compaction may decline for poor
     * yield, but it may not silently replace the task that created the run.
     */
    readonly preserveFirstUserMessage?: boolean;
    /**
     * Opt in to a different, usually cheaper summarizer.
     *
     * The default is deliberately the run's **own working model**, with the
     * compaction request built by the same request builder as a working call —
     * same system prompt, same tool definitions, same history, the compaction
     * instruction appended as the final user message. A summarizer with its own
     * prompt shape diverges at the first token and forfeits the entire cached
     * prefix, which costs more than the cheaper rate saves on every mid-tier
     * model. Opting in is gated on the summarizer's context window covering the
     * history it has to read; below that it fails closed to the working model.
     */
    readonly summarizerModel?: Model<Api>;
    /**
     * What the compaction rung does once free eviction is not enough.
     *
     * `"summarize"` (default) pays one summarizer call and keeps a lossy capsule
     * plus the recent tail. `"new-context"` skips the provider call entirely and
     * installs a fresh context window: pinned user intent, then whatever
     * `newContext` hands back as the seed. It is free, so it is strictly cheaper
     * than a summary — but it only stays honest when the caller persists the
     * outgoing window somewhere the model can search afterwards. `newContext` is
     * the moment to do that, and the mode fails closed to the ordinary ladder
     * when no `newContext` is supplied.
     */
    readonly mode?: "summarize" | "new-context";
    /**
     * Called once per `"new-context"` rollover, with the window about to be
     * dropped. Returns the seed text for the fresh window — the small hint that
     * carries plan, decisions, and unresolved work across the boundary.
     *
     * Persist `messages` here if they need to be recoverable: past this call the
     * runtime no longer holds them. Throwing declines the rollover and falls back
     * to the eviction/clamp rungs, so an unwritable archive never silently costs
     * the run its history.
     */
    readonly newContext?: (input: {
        readonly messages: readonly AgentMessage[];
        /** 1-based rollover number within this run. */
        readonly generation: number;
    }) => string | Promise<string>;
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `CompiledPipelineResult`

```ts
export interface CompiledPipelineResult {
    readonly buildSHA256: string;
    readonly semanticPlanSHA256: string;
    readonly target: BuildHarnessID;
    readonly fallbackUsed: boolean;
    readonly execution: HarnessResult;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompileProfiledInput`

```ts
export interface CompileProfiledInput extends Omit<CompileInput, "evals" | "runner" | "seeds" | "adapterVersion" | "upstreamVersion" | "harnessId"> {
    readonly profile: WorkloadProfile;
    readonly developmentEvals: readonly EvalDefinition[];
    readonly holdoutEvals: readonly EvalDefinition[];
    readonly developmentSeeds?: readonly number[];
    readonly holdoutSeeds?: readonly number[];
    readonly developmentRunner: CompileInput["runner"];
    readonly holdoutRunner: CompileInput["runner"];
    readonly target: CompilerTarget;
    readonly requiredSemantics?: readonly CompilerSemantic[];
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompileProfiledNativePiInput`

```ts
export interface CompileProfiledNativePiInput extends Omit<CompileProfiledInput, "developmentRunner" | "holdoutRunner" | "target" | "candidates" | "requiredSemantics"> {
    readonly rootDir: string;
    readonly entryPath: string;
    readonly transformCapabilities?: readonly TransformCapability[];
    readonly preferredTransforms?: ReadonlyMap<string, string>;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompileProfiledResult`

```ts
export interface CompileProfiledResult {
    readonly status: ProfiledCompileStatus;
    readonly estimated_ceiling_usd: number;
    readonly actual_cost_usd: number | null;
    readonly development?: CompileResult;
    readonly holdout?: CompileResult;
    readonly lock?: CaveBuildLockV3;
    readonly reason?: string;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompilerTarget`

```ts
export interface CompilerTarget {
    readonly id: BuildHarnessID;
    readonly adapterVersion: string;
    readonly upstreamVersion: string;
    readonly adapterContractSHA256: string;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `CompleteModelUsage`

```ts
export interface CompleteModelUsage extends ModelUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
    readonly totalTokens: number;
}
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `CompletionMemorySidecarOptions`

```ts
export interface CompletionMemorySidecarOptions {
    readonly complete: (request: MemoryCompletionRequest) => Promise<string>;
}
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `ConnectAction`

```ts
export interface ConnectAction {
    /** Curated provider action name. */
    readonly name: string;
    /** Argument values fixed by config. Model input may not set these keys. */
    readonly bind?: Readonly<Record<string, ConnectActionBindValue>>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectConnection`

Credential-free saved-connection projection returned by cave-connectd.

```ts
export interface ConnectConnection {
    readonly connectionId: string;
    readonly provider: string;
    readonly authMode: string;
    readonly status: string;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectEfficiencyComparison`

```ts
export interface ConnectEfficiencyComparison {
    readonly evidence: "inferred";
    readonly accepted: boolean;
    readonly reasons: readonly string[];
    readonly baselineTotalCostUsd: number | null;
    readonly connectedTotalCostUsd: number | null;
    readonly costDeltaUsd: number | null;
    readonly inputTokenDelta: number | null;
    readonly retryDelta: number;
    readonly qualityDelta: number;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectEfficiencyRun`

```ts
export interface ConnectEfficiencyRun {
    readonly taskSuccess: boolean;
    /** Same grader and scale required for baseline and connected run. */
    readonly quality: number;
    /** Provider/model spend only when complete; otherwise null. */
    readonly providerCostUsd: number | null;
    readonly providerInputTokens: number | null;
    readonly providerOutputTokens: number | null;
    readonly retries: number;
    readonly retrievalCalls: number;
    readonly retrievalCostUsd: number | null;
    readonly collectionCostUsd: number | null;
    readonly completeData: boolean;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectExecuteOptions`

```ts
export interface ConnectExecuteOptions {
    readonly environment: Readonly<Record<string, string>>;
    readonly capture: boolean;
    readonly input?: string;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
    readonly maxCaptureBytes: number;
    readonly onOutput?: (value: string, stream: "stdout" | "stderr") => void;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectIntegration`

```ts
export interface ConnectIntegration {
    readonly tool: ToolDefinition;
    readonly sources: readonly NormalizedConnectSource[];
    readonly quality: NormalizedConnectQualityPolicy;
    /** Open provider authorization. Credentials remain owned by cave-connectd. */
    connect(sourceId: string, onOutput?: ConnectExecuteOptions["onOutput"]): Promise<void>;
    /** Trigger every configured sync once. Returns exact daemon acknowledgements. */
    collect(sourceId?: string, signal?: AbortSignal): Promise<readonly unknown[]>;
    /** Read saved connections without credential material. */
    connections(signal?: AbortSignal): Promise<readonly ConnectConnection[]>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpCallResult`

```ts
export interface ConnectMcpCallResult {
    readonly isError: boolean;
    readonly structuredContent: unknown;
    readonly content: readonly unknown[];
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpTool`

Detached, deeply frozen MCP tool descriptor. Annotation values remain hints.

```ts
export interface ConnectMcpTool {
    readonly name: string;
    readonly title?: string;
    readonly description?: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly outputSchema?: Readonly<Record<string, unknown>>;
    readonly annotations?: ConnectMcpToolAnnotations;
    readonly execution?: ConnectMcpToolExecution;
    readonly icons?: readonly ConnectMcpToolIcon[];
    readonly _meta?: Readonly<Record<string, unknown>>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpToolAnnotations`

```ts
export interface ConnectMcpToolAnnotations {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpToolExecution`

```ts
export interface ConnectMcpToolExecution {
    readonly taskSupport?: "forbidden" | "optional" | "required";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectMcpToolIcon`

```ts
export interface ConnectMcpToolIcon {
    readonly src: string;
    readonly mimeType?: string;
    readonly sizes?: readonly string[];
    readonly theme?: "light" | "dark";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectOptions`

```ts
export interface ConnectOptions extends ConnectRuntimeOptions {
    readonly sources: readonly ConnectSource[];
    readonly quality?: ConnectQualityPolicy;
    readonly toolName?: string;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectProcessResult`

```ts
export interface ConnectProcessResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectQualityPolicy`

```ts
export interface ConnectQualityPolicy {
    /** Maximum records returned by one tool call across pages. */
    readonly maxRecords?: number;
    /** Maximum exact pages read by one tool call. */
    readonly maxPages?: number;
    /** Maximum serialized result bytes exposed to model. */
    readonly maxResultBytes?: number;
    /** Default refuses completeness-dependent answers after any cap is reached. */
    readonly incomplete?: "refuse";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectRuntimeOptions`

```ts
export interface ConnectRuntimeOptions {
    /** Absolute path preferred. Otherwise CAVE_CONNECT_BIN, then PATH is checked. */
    readonly binary?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly execute?: ConnectExecutor;
    readonly maxCaptureBytes?: number;
    readonly timeoutMs?: number;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectSource`

```ts
export interface ConnectSource {
    /** Short agent-facing name, for example "work-github". */
    readonly id: string;
    /** Caveman Connect provider slug. */
    readonly provider: string;
    /** Optional exact saved connection. Omit only when provider has exactly one active connection. */
    readonly connectionId?: string;
    /** Syncs agent may trigger. Empty/omitted means read existing records only. */
    readonly collect?: readonly string[];
    /** Record models agent may read. Empty/omitted means any model under this allowed connection. */
    readonly models?: readonly string[];
    /**
     * Curated provider actions agent may execute. Default none. A bare string
     * lets the model choose every argument; the object form fixes destination or
     * credential-shaped arguments in trusted config instead.
     */
    readonly actions?: readonly (string | ConnectAction)[];
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectToolRuntimeDefinition`

Serializable runtime marker. Contains source allowlists, never credentials.

```ts
export interface ConnectToolRuntimeDefinition {
    readonly kind: "caveman-connect";
    readonly sources: readonly NormalizedConnectSource[];
    readonly quality: NormalizedConnectQualityPolicy;
    readonly binary?: string;
    readonly timeoutMs: number;
    readonly maxCaptureBytes: number;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ContextAnchor`

```ts
export interface ContextAnchor {
    /** Stable across generations. A changed commitment gets a new key. */
    readonly key: string;
    readonly kind: ContextAnchorKind;
    readonly text: string;
    /** Critical anchors cannot be retired or paraphrased by a summarizer. */
    readonly critical: boolean;
    readonly sourceSegmentId: string;
    readonly sourceDigest: string;
    /** Prior critical keys this later user-sourced anchor explicitly replaces. */
    readonly supersedes: readonly string[];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextCompactionFixture`

```ts
export interface ContextCompactionFixture {
    readonly id: string;
    readonly rounds: readonly ContextCompactionFixtureRound[];
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionFixtureRound`

```ts
export interface ContextCompactionFixtureRound {
    readonly messages: readonly AgentMessage[];
    /** Defaults to every message in `messages`. */
    readonly summarizable?: readonly number[];
    /** Cumulative active anchors expected after this round. */
    readonly expected: readonly ExpectedContextAnchor[];
    readonly expectedRecoveryDigests?: readonly string[];
    /** Verbatim tail/pins outside capsule, in estimated tokens. */
    readonly retainedTokens?: number;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionHarnessOptions`

```ts
export interface ContextCompactionHarnessOptions {
    readonly repetitions?: number;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionHarnessResult`

```ts
export interface ContextCompactionHarnessResult {
    readonly fixtureId: string;
    readonly repetitions: number;
    readonly rounds: number;
    readonly validRounds: number;
    readonly criticalAnchorRecall: number;
    readonly weightedAnchorRecall: number;
    readonly exactRecoveryCoverage: number;
    readonly meanCompressionRatio: number;
    readonly stable: boolean;
    readonly failures: readonly string[];
    readonly results: readonly ContextCompactionHarnessRoundResult[];
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionHarnessRoundResult`

```ts
export interface ContextCompactionHarnessRoundResult {
    readonly repetition: number;
    readonly round: number;
    readonly parsed: boolean;
    readonly transitionValid: boolean;
    readonly transitionFailures: readonly string[];
    readonly evaluation: ContextSummaryEvaluation | undefined;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionSummarizerRequest`

```ts
export interface ContextCompactionSummarizerRequest {
    readonly fixtureId: string;
    readonly repetition: number;
    readonly round: number;
    readonly messages: readonly AgentMessage[];
    readonly previous: ContextSummary | undefined;
    readonly sources: readonly ContextSummarySource[];
    readonly instruction: string;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextDefinition`

```ts
export interface ContextDefinition {
    readonly kind: "context";
    readonly id: string;
    readonly segmentKind: ContextKind;
    readonly source: string | FileSource;
    readonly stability: ContextStability;
    readonly safety: SafetyClass;
    readonly priority: ContextPriority;
    readonly recovery: RecoveryKind;
    readonly cacheRegion: CacheRegion;
    readonly privacy: PrivacyClass;
    readonly opaque: boolean;
    readonly ttlTurns?: number;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ContextIR`

```ts
export interface ContextIR {
    schemaVersion: 1;
    segments: ContextSegment[];
}
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `ContextIRWire`

```ts
export interface ContextIRWire {
    schema_version: 1;
    segments: ContextSegmentWire[];
}
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `ContextSegment`

```ts
export interface ContextSegment {
    id: string;
    kind: ContextKind;
    stability: ContextStability;
    safety: SafetyClass;
    priority: ContextPriority;
    recovery: RecoveryKind;
    cacheRegion: CacheRegion;
    privacy: PrivacyClass;
    opaque: boolean;
    ttlTurns?: number;
    provenanceDigest: string;
    tokenCount: number;
    bodyHandle: string;
}
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `ContextSegmentWire`

```ts
export interface ContextSegmentWire {
    id: string;
    kind: ContextKind;
    stability: ContextStability;
    safety: SafetyClass;
    priority: ContextPriority;
    recovery: RecoveryKind;
    cache_region: CacheRegion;
    privacy: PrivacyClass;
    opaque: boolean;
    ttl_turns?: number;
    provenance_digest: string;
    token_count: number;
    body_handle: string;
}
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `ContextSummary`

```ts
export interface ContextSummary {
    readonly schemaVersion: number;
    readonly generation: number;
    readonly objective: string;
    readonly anchors: readonly ContextAnchor[];
    readonly constraintsRestated: readonly string[];
    readonly decisions: readonly {
        readonly decision: string;
        readonly why: string;
    }[];
    readonly artifacts: readonly {
        readonly path: string;
        readonly change: string;
    }[];
    readonly facts: readonly string[];
    readonly state: {
        readonly completed: readonly string[];
        readonly active: readonly string[];
        readonly blocked: readonly string[];
    };
    readonly next: readonly string[];
    readonly citations: readonly {
        readonly segmentId: string;
        readonly digest: string;
        readonly what: string;
    }[];
    readonly lookupHints: readonly string[];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextSummaryEvaluation`

```ts
export interface ContextSummaryEvaluation {
    readonly criticalAnchorRecall: number;
    readonly weightedAnchorRecall: number;
    readonly exactRecoveryCoverage: number;
    readonly compressionRatio: number;
    readonly commitmentDensity: number;
    readonly stable: boolean;
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummaryEvaluationInput`

```ts
export interface ContextSummaryEvaluationInput {
    readonly expected: readonly ExpectedContextAnchor[];
    readonly sourceTokens: number;
    readonly compactedTokens: number;
    readonly expectedRecoveryDigests?: readonly string[];
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummaryRound`

```ts
export interface ContextSummaryRound {
    readonly summary: ContextSummary;
    readonly sources: readonly ContextSummarySource[];
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummarySource`

Digest-addressed input the capsule is allowed to make claims about.

```ts
export interface ContextSummarySource {
    readonly segmentId: string;
    readonly digest: string;
    readonly role: ContextSummarySourceRole;
    /** Every required source needs at least one anchor in the new capsule. */
    readonly required: boolean;
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextSummaryStability`

```ts
export interface ContextSummaryStability {
    readonly rounds: number;
    readonly validTransitions: number;
    readonly criticalAnchorRetention: number;
    readonly stable: boolean;
    readonly failures: readonly string[];
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummaryValidation`

```ts
export interface ContextSummaryValidation {
    readonly ok: boolean;
    readonly failures: readonly string[];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `CreateMemoryEngineOptions`

```ts
export interface CreateMemoryEngineOptions {
    readonly scope: MemoryScope;
    readonly storage?: MemoryStorageAdapter;
    /** Default is dependency-free sparse cosine. Supply a semantic adapter to upgrade recall. */
    readonly embedding?: MemoryEmbeddingAdapter | false;
    readonly sidecar?: MemorySidecarAdapter;
    readonly ttlMs: number;
    readonly recallTokens?: number;
    readonly maxResults?: number;
    readonly minScore?: number;
    readonly graphDepth?: number;
    readonly maxSessionTurns?: number;
    readonly ambient?: false | MemoryAmbientOptions;
    readonly now?: () => number;
    readonly onError?: (error: Error) => void;
    /** Extra application policy. Returning false refuses persistence. */
    readonly allowStore?: (text: string) => boolean;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `DurableRunOptions`

Caller-facing durable options on RunOptions.

```ts
export interface DurableRunOptions {
    /**
     * Caller-assigned idempotency key for this run. The same runId always
     * refers to the same logical run: a crashed run resumes, a completed run
     * returns its journaled result without spending again, and a run that
     * ended in a terminal error re-reports that error. Filename-safe:
     * `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
     */
    runId: string;
    /**
     * Where the journal lives. Defaults to a disk store under
     * `<rootDir>/.caveman/runs/durable/`. Supply a custom store (e.g. a
     * database-backed one) for shared or production storage.
     */
    store?: DurableStore;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableStore`

Storage contract for run journals. Lines are opaque JSON strings; the
store guarantees ordered, durable appends — `append` resolving means the
data survives a process crash (fsync or the store's strongest equivalent).

```ts
export interface DurableStore {
    /** Full journal for `runId`, in append order. Empty array when none exists. */
    load(runId: string): Promise<readonly string[]>;
    /** Durably append `data` (one or more newline-terminated lines). */
    append(runId: string, data: string): Promise<void>;
    /**
     * Take the exclusive per-run lock, so two processes cannot drive (and
     * double-spend) the same run. Returns the release function. Throws
     * `cave_durable_run_locked` when another live process holds it.
     */
    acquire(runId: string): Promise<() => Promise<void>>;
    /** Release any open handles for `runId`. Idempotent. */
    close(runId: string): Promise<void>;
    /**
     * Every runId this store holds a journal for. Optional: a store that cannot
     * enumerate its runs is still a valid journal store, it just cannot back
     * crash recovery — {@link recoverableRuns} reports that honestly rather
     * than pretending the store is empty.
     */
    list?(): Promise<readonly string[]>;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `EvalDefinition`

```ts
export interface EvalDefinition {
    readonly kind: "eval";
    readonly id: string;
    /** Stable task-family identifier; required by profile-guided split isolation. */
    readonly lineageId?: string;
    /**
     * Explicit compiler role. Omit for legacy v2 builds. A v3 build requires
     * every fixture to declare one role and a lineageId; it never
     * invents or randomly splits holdout evidence.
     */
    readonly split?: EvalSplit;
    readonly input: unknown;
    readonly tools: {
        mode: "fixture" | "live";
        sandbox?: string;
    };
    readonly quality: readonly QualityGrader[];
    readonly guardrails: readonly EvalGuardrail[];
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ExecRequest`

```ts
export interface ExecRequest {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `ExecResult`

```ts
export interface ExecResult {
    readonly stdout: string;
    readonly stderr: string;
    readonly code: number | null;
    readonly timedOut: boolean;
    readonly truncated: boolean;
    readonly startFailed?: boolean;
}
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `ExecuteCompiledPipelineInput`

```ts
export interface ExecuteCompiledPipelineInput {
    readonly build: CaveBuildLockV3;
    readonly adapter: HarnessAdapter;
    readonly contextIR: HarnessRequest["contextIR"];
    readonly prompt: string;
    readonly runID: string;
    readonly evaluatedTransformIDs: readonly string[];
    readonly appliedTransformIDs: readonly string[];
    readonly recoveryResolved: boolean;
    readonly signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `ExecutionBackend`

```ts
export interface ExecutionBackend {
    readonly id: string;
    exec(request: ExecRequest): Promise<ExecResult>;
    readFile(path: string, opts?: {
        maxBytes?: number;
    }): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array): Promise<void>;
    prepare?(): Promise<void>;
    snapshot?(): Promise<string>;
    restore?(snapshotId: string): Promise<void>;
    close?(): Promise<void>;
}
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `ExpectedContextAnchor`

```ts
export interface ExpectedContextAnchor {
    readonly key?: string;
    readonly kind: ContextAnchorKind;
    readonly text: string;
    readonly critical?: boolean;
    readonly weight?: number;
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `FileSource`

```ts
export interface FileSource {
    readonly kind: "file";
    readonly path: string;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `HttpDurableStoreOptions`

Wire contract a {@link HttpDurableStore} endpoint must implement. Every
request carries `Authorization: Bearer <token>`; every response outside the
documented set is a failure, never an empty journal.

- `GET    {base}/runs`                  → `{"runIds": [...]}`
- `GET    {base}/runs/{id}/journal`     → the raw journal text (404 = none)
- `POST   {base}/runs/{id}/journal`     → 204 once the bytes are DURABLE
- `POST   {base}/runs/{id}/lock`        → `{"token","expiresAt"}` | 409 held
- `POST   {base}/runs/{id}/lock/renew`  → 204 | 409 lease lost
- `DELETE {base}/runs/{id}/lock`        → 204

The 204 on append is the whole guarantee: a server that answers before the
write is durable turns this store into a liar and the resume math with it.

```ts
export interface HttpDurableStoreOptions {
    /** Base URL of the journal service. Must be https:// outside localhost. */
    url: string;
    /** Bearer token. Required — an unauthenticated journal is an open ledger. */
    token: string;
    /** Injectable transport, for tests and for platform-native fetch bindings. */
    fetchFn?: typeof fetch;
    /** Lock lease length. The holder renews at a third of it. Default 30s. */
    lockTtlMs?: number;
    /** Per-request timeout. Default 10s. */
    requestTimeoutMs?: number;
}
```

Declared in `packages/agent/dist/durable-stores.d.ts`.

### `LoweredContext`

```ts
export interface LoweredContext {
    ir: ContextIR;
    bodies: ReadonlyMap<string, Uint8Array>;
}
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `MemoryAmbientOptions`

```ts
export interface MemoryAmbientOptions {
    /** Assistant turns between extraction passes. Defaults to 8. */
    readonly extractEveryTurns?: number;
    /** Extract old topic when user-vector similarity drops below this. Defaults to 0.35. */
    readonly driftThreshold?: number;
    /** New memories between deep consolidation passes. Defaults to 32. */
    readonly consolidateEveryWrites?: number;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryCompletionRequest`

```ts
export interface MemoryCompletionRequest {
    readonly purpose: "review" | "extract" | "consolidate";
    readonly system: string;
    readonly input: string;
    readonly signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `MemoryConsolidationInput`

```ts
export interface MemoryConsolidationInput {
    readonly memories: readonly MemoryRecord[];
    readonly edges: readonly MemoryEdge[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryDefinition`

```ts
export interface MemoryDefinition {
    readonly kind: "memory";
    readonly namespace: string;
    readonly provenance: "local" | "project" | "external";
    readonly ttl: string;
    readonly recallBudget: number;
    readonly consent: "local_only" | "project_shared";
    /** Async passive recall/extraction policy. False keeps explicit tools only. */
    readonly ambient: false | MemoryAmbientOptions;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `MemoryDraft`

```ts
export interface MemoryDraft {
    readonly text: string;
    readonly kind?: MemoryKind;
    readonly tags?: readonly string[];
    readonly confidence?: number;
    readonly supersedes?: readonly string[];
    readonly contradicts?: readonly string[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryEdge`

```ts
export interface MemoryEdge {
    readonly from: string;
    readonly to: string;
    readonly relation: MemoryRelation;
    readonly weight: number;
    readonly createdAt: number;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryEmbeddingAdapter`

```ts
export interface MemoryEmbeddingAdapter {
    /** Stable model/vector-space identity. Different ids are never compared. */
    readonly id: string;
    embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryExtractionInput`

```ts
export interface MemoryExtractionInput {
    readonly sessionId: string;
    readonly turns: readonly MemoryTurn[];
    readonly existing: readonly MemoryRecord[];
    readonly reason: "turns" | "drift" | "session_end";
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryHit`

```ts
export interface MemoryHit {
    readonly id: string;
    readonly text: string;
    readonly kind: MemoryKind;
    readonly tags: readonly string[];
    readonly score: number;
    readonly confidence: number;
    readonly source: "vector" | "lexical" | "graph";
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRecall`

```ts
export interface MemoryRecall {
    readonly query: string;
    readonly hits: readonly MemoryHit[];
    readonly prompt: string;
    readonly basis: "inferred";
    readonly sidecarContext?: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRecord`

```ts
export interface MemoryRecord {
    readonly id: string;
    readonly text: string;
    readonly kind: MemoryKind;
    readonly tags: readonly string[];
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly expiresAt: number;
    readonly confidence: number;
    readonly strength: number;
    readonly active: boolean;
    readonly sources: readonly MemorySource[];
    readonly vector?: MemoryVector;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRememberInput`

```ts
export interface MemoryRememberInput {
    readonly text: string;
    readonly kind?: MemoryKind;
    readonly tags?: readonly string[];
    readonly confidence?: number;
    readonly sessionId?: string;
    readonly turnId?: string;
    readonly supersedes?: readonly string[];
    readonly contradicts?: readonly string[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryReviewInput`

```ts
export interface MemoryReviewInput {
    readonly query: string;
    readonly candidates: readonly MemoryHit[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryReviewResult`

```ts
export interface MemoryReviewResult {
    readonly ids: readonly string[];
    /** Optional bounded result of sidecar-owned deeper retrieval. Still untrusted. */
    readonly context?: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRuntimeConfig`

```ts
export interface MemoryRuntimeConfig extends MemoryStoreConfig {
    /** Reuse one engine across turns. Pebble and adapters do this automatically. */
    readonly engine?: MemoryEngine;
    /** Custom durable backend. Omit for private atomic local JSON. */
    readonly storage?: MemoryStorageAdapter;
    readonly embedding?: MemoryEmbeddingAdapter | false;
    readonly sidecar?: MemorySidecarAdapter;
    readonly onError?: (error: Error) => void;
    /** Extra application policy. Returning false refuses all turn and explicit persistence. */
    readonly allowStore?: (text: string) => boolean;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryScope`

```ts
export interface MemoryScope {
    readonly tenant: string;
    readonly agentId: string;
    readonly namespace: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySearchOptions`

```ts
export interface MemorySearchOptions {
    readonly maxResults?: number;
    readonly minScore?: number;
    readonly graphDepth?: number;
    readonly exclude?: ReadonlySet<string>;
    readonly signal?: AbortSignal;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySessionHit`

```ts
export interface MemorySessionHit {
    readonly id: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly score: number;
    readonly source: "vector" | "lexical";
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySidecarAdapter`

Optional small-model seam. Nothing invokes another model unless supplied.

```ts
export interface MemorySidecarAdapter {
    review?(input: MemoryReviewInput, signal?: AbortSignal): Promise<readonly string[] | MemoryReviewResult>;
    extract?(input: MemoryExtractionInput, signal?: AbortSignal): Promise<readonly MemoryDraft[]>;
    consolidate?(input: MemoryConsolidationInput, signal?: AbortSignal): Promise<readonly MemoryDraft[]>;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemorySource`

```ts
export interface MemorySource {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly at: number;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryState`

```ts
export interface MemoryState {
    readonly schemaVersion: 1;
    readonly revision: number;
    readonly memories: readonly MemoryRecord[];
    readonly turns: readonly MemoryTurn[];
    readonly edges: readonly MemoryEdge[];
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryStorageAdapter`

```ts
export interface MemoryStorageAdapter {
    read(scope: MemoryScope): Promise<MemoryState>;
    update(scope: MemoryScope, mutate: (state: MemoryState) => MemoryState): Promise<MemoryState>;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryStoreConfig`

Where durable memory lives, and for whom. Threaded from
`RunOptions.memory` so an embedding server can point at its own location AND
scope per tenant, so two tenants sharing an agent id + namespace never see
each other's memories.

```ts
export interface MemoryStoreConfig {
    /**
     * Base directory. Defaults to `CAVE_AGENT_MEMORY_ROOT`, else
     * `~/.caveman/agent-memory`. A stable location so a 30-day ttl survives
     * reboots, not just process restarts.
     */
    readonly root?: string;
    /** Tenant scope. Defaults to `_` (single-tenant). Isolates per tenant. */
    readonly tenant?: string;
}
```

Declared in `packages/agent/dist/memory-store.d.ts`.

### `MemoryTurn`

```ts
export interface MemoryTurn {
    readonly id: string;
    readonly sessionId: string;
    readonly sequence: number;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly createdAt: number;
    readonly vector?: MemoryVector;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryTurnInput`

```ts
export interface MemoryTurnInput {
    readonly sessionId: string;
    readonly text: string;
    readonly turnId?: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryVector`

Quantized vector. JSON stays small enough for a local, dependency-free adapter.

```ts
export interface MemoryVector {
    readonly adapter: string;
    readonly dimensions: number;
    readonly scale: number;
    readonly data: string;
}
```

Declared in `packages/agent/dist/memory.d.ts`.

### `ModelBoundary`

```ts
export interface ModelBoundary<Request, Response> {
    readonly middlewareIds: readonly string[];
    prepare(request: Request, context: ModelBoundaryContext): Promise<PreparedModelBoundaryCall<Request, Response>>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryContext`

```ts
export interface ModelBoundaryContext {
    readonly identity: AdapterLifecycleIdentity & {
        readonly modelCallId: string;
    };
    readonly role: ModelBoundaryRole;
    readonly provider: string;
    readonly model: string;
    readonly signal: AbortSignal;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryFailed`

```ts
export interface ModelBoundaryFailed<Request> {
    readonly request: Request;
    readonly error: unknown;
    readonly context: ModelBoundaryContext;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryMiddleware`

Model middleware transforms a request before provider I/O and observes one
terminal outcome. It deliberately receives no `next` callback or provider
function: only the owning runtime may perform model I/O.

```ts
export interface ModelBoundaryMiddleware<Request, Response> {
    readonly id: string;
    readonly prepare?: (input: ModelBoundaryPrepare<Request>) => Request | undefined | Promise<Request | undefined>;
    readonly settled?: (input: ModelBoundarySettled<Request, Response>) => void | Promise<void>;
    readonly failed?: (input: ModelBoundaryFailed<Request>) => void | Promise<void>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundaryPrepare`

```ts
export interface ModelBoundaryPrepare<Request> {
    readonly request: Request;
    readonly context: ModelBoundaryContext;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelBoundarySettled`

```ts
export interface ModelBoundarySettled<Request, Response> {
    readonly request: Request;
    readonly response: Response;
    readonly context: ModelBoundaryContext;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelCallRouteDecision`

```ts
export interface ModelCallRouteDecision {
    /** Full `provider/model` identity. V1 routing cannot cross providers. */
    readonly model: string;
    readonly reason: string;
    readonly signals: readonly string[];
}
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `ModelCallRouteInput`

```ts
export interface ModelCallRouteInput {
    /** Zero-based root provider-call index, including paid compactions. */
    readonly callIndex: number;
    readonly role: "working" | "compaction";
    readonly provider: string;
    readonly currentModel: string;
    /** Conservative serialized-context ceiling used by wallet admission. */
    readonly ctxTokens: number;
    readonly hasImages: boolean;
    readonly toolErrorStreak: number;
    readonly previousUsage?: {
        readonly model: string;
        /** Uncached provider input. Optional for compatibility with older routers. */
        readonly inputTokens?: number;
        readonly cacheReadTokens: number;
        readonly cacheWriteTokens: number;
    };
}
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `ModelUsage`

One provider call's disjoint usage. `inputTokens` excludes cache read/write;
reasoning tokens are a subset of output tokens. `null` means unknown and is
never coerced to zero. Raw provider payloads are intentionally excluded.

```ts
export interface ModelUsage {
    readonly schemaVersion: 1;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: ModelUsageTokenCount;
    readonly outputTokens: ModelUsageTokenCount;
    readonly cacheReadTokens: ModelUsageTokenCount;
    readonly cacheWriteTokens: ModelUsageTokenCount;
    readonly reasoningTokens: ModelUsageTokenCount;
    readonly totalTokens: ModelUsageTokenCount;
    readonly cost: ModelUsageCost;
}
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `NativePiCandidatePlanningInput`

```ts
export interface NativePiCandidatePlanningInput {
    readonly agent: CompileProfiledInput["agent"];
    readonly contextIR: CompileProfiledInput["contextIR"];
    readonly baselinePlan: CavePlan;
    readonly modelCandidates?: readonly string[];
    readonly config: CompileProfiledInput["config"];
    readonly observedDynamicKinds: ReadonlySet<ContextKind>;
    readonly transformCapabilities?: readonly TransformCapability[];
    readonly preferredTransforms?: ReadonlyMap<string, string>;
    /** One accounting instant for the entire static reservation frontier. */
    readonly accountingAt?: Date;
}
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `NestedToolDispatchOptions`

```ts
export interface NestedToolDispatchOptions {
    /** Additional cancellation owned by the composite program. */
    readonly signal?: AbortSignal;
    /**
     * Claim a matching read that this run's kernel already admitted while the
     * provider streamed the composite call. Missing or ambiguous provenance
     * fails closed and executes the call normally.
     */
    readonly claimSpeculation?: boolean;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `NormalizedAgentInput`

```ts
export interface NormalizedAgentInput {
    readonly parts: readonly AgentInputPart[];
    readonly textBytes: number;
    readonly base64Bytes: number;
    readonly remoteReferences: number;
}
```

Declared in `packages/agent/dist/input.d.ts`.

### `NormalizedCompaction`

```ts
export interface NormalizedCompaction {
    readonly maxCompactions: number;
    readonly keepRecentTokens: number;
    readonly summaryMaxTokens: number;
    readonly minYieldTokens: number;
    readonly headroomCalls: number;
    readonly pinnedUserTokens: number;
    readonly preserveFirstUserMessage: boolean;
    readonly summarizerModel: Model<Api> | undefined;
    readonly mode: "summarize" | "new-context";
    readonly newContext: CompactionOptions["newContext"];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `NormalizedConnectAction`

```ts
export interface NormalizedConnectAction {
    readonly name: string;
    readonly bind: Readonly<Record<string, ConnectActionBindValue>>;
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `NormalizedConnectQualityPolicy`

```ts
export interface NormalizedConnectQualityPolicy {
    readonly maxRecords: number;
    readonly maxPages: number;
    readonly maxResultBytes: number;
    readonly incomplete: "refuse";
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `NormalizedConnectSource`

```ts
export interface NormalizedConnectSource {
    readonly id: string;
    readonly provider: string;
    readonly connectionId?: string;
    readonly collect: readonly string[];
    readonly models: readonly string[];
    readonly actions: readonly NormalizedConnectAction[];
}
```

Declared in `packages/agent/dist/connect.d.ts`.

### `NormalizedToolActivity`

```ts
export interface NormalizedToolActivity {
    readonly tool_sha256: string;
    readonly effect: ToolEffect;
    readonly calls: number;
    readonly errors: number;
}
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

### `NormalizedTrajectory`

```ts
export interface NormalizedTrajectory {
    readonly schema_version: typeof TRAJECTORY_IR_SCHEMA_VERSION;
    readonly trajectory_sha256: string;
    readonly case_sha256: string;
    readonly lineage_sha256: string;
    readonly input_sha256: string;
    readonly run_sha256: string;
    readonly agent_sha256: string;
    readonly source: TrajectorySource;
    readonly split: WorkloadSplit;
    readonly provider: string;
    readonly model: string;
    readonly terminal: boolean;
    readonly outcome: "complete" | "stopped" | "error";
    readonly usage_basis: "provider_reported" | "unavailable";
    readonly price_basis: "public_catalog" | "unpriced";
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cache_read_tokens: number;
    readonly cache_write_tokens: number;
    readonly reasoning_tokens: number;
    readonly cost_usd: number;
    readonly latency_ms: number;
    readonly model_calls: number;
    readonly context_bill: Readonly<Partial<Record<ContextKind, number>>>;
    readonly tools: readonly NormalizedToolActivity[];
    readonly evaluated_transform_ids: readonly string[];
    readonly applied_transform_ids: readonly string[];
    readonly recovery_resolved: boolean;
}
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

### `NormalizeTrajectoryOptions`

```ts
export interface NormalizeTrajectoryOptions {
    /** Stable workload-case identity. Only its SHA-256 digest is retained. */
    readonly caseId: string;
    /** Family/lineage identity shared by derived variants. Only its digest is retained. */
    readonly lineageId: string;
    /** SHA-256 of canonical task input bytes. Raw input is never retained. */
    readonly inputSha256: string;
    /** Expected target-agent digest. Imported traces must bind to it. */
    readonly agentSha256?: string;
    readonly split: WorkloadSplit;
    /** Tool declarations keyed by runtime name. Missing tools become `external`. */
    readonly toolEffects?: Readonly<Record<string, ToolEffect>>;
    /** Compiler-owned boundaries for a live Caveman run. Scheduled imported
     * traces without both times remain unpriced. */
    readonly accountingStartedAt?: Date;
    readonly accountingFinishedAt?: Date;
}
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

### `OpenAICompatibleMemoryEmbeddingOptions`

```ts
export interface OpenAICompatibleMemoryEmbeddingOptions {
    /** API root such as `https://api.openai.com/v1` or a local compatible server. */
    readonly baseURL: string;
    readonly model: string;
    /** Explicit credential only. Adapter never reads ambient environment variables. */
    readonly apiKey?: string;
    readonly dimensions?: number;
    readonly fetch?: typeof globalThis.fetch;
}
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `OutputDefinition`

```ts
export interface OutputDefinition<TSchemaValue extends TSchema | undefined = TSchema | undefined> {
    readonly kind: "output";
    readonly maxTokens: number;
    readonly schema?: TSchemaValue;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `PreparedModelBoundaryCall`

```ts
export interface PreparedModelBoundaryCall<Request, Response> {
    readonly request: Request;
    readonly context: ModelBoundaryContext;
    /** Best-effort observation; always returns the native response unchanged. */
    settled(response: Response): Promise<Response>;
    /** Best-effort observation; always throws the exact native failure. */
    failed(error: unknown): Promise<never>;
}
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ProfileToolEffect`

```ts
export interface ProfileToolEffect {
    readonly tool_sha256: string;
    readonly effect: ToolEffect;
    readonly calls: number;
    readonly errors: number;
}
```

Declared in `packages/agent/dist/profile.d.ts`.

### `ProgrammaticSpeculationActivation`

```ts
export interface ProgrammaticSpeculationActivation {
    readonly provisionalParentToolCallId: string;
    readonly turnKey: object;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticSpeculationLaunch`

```ts
export interface ProgrammaticSpeculationLaunch {
    readonly parentToolCallId: string;
    readonly turnKey: object;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly signal: AbortSignal;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticToolInstructionOptions`

```ts
export interface ProgrammaticToolInstructionOptions {
    /** Provider-visible composite tool name. Defaults to `caveman_code`. */
    readonly toolName?: string;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticToolRuntime`

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

### `ProgrammaticToolStats`

```ts
export interface ProgrammaticToolStats {
    readonly launched: number;
    readonly claimed: number;
    readonly missed: number;
    readonly abandoned: number;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ReceiptCall`

One provider call as the receipt records it.

`estimatedUsd` is a public-catalog list-price subtotal for this call — what
the call would list at, never what any invoice said. `unpriced` marks a call
the catalog could not price at all, whose contribution to the total is an
honest zero rather than a measured amount.

```ts
export interface ReceiptCall {
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
    readonly estimatedUsd: number;
    readonly unpriced: boolean;
    /** How the tokens above were arrived at. `unavailable` means the provider's report was unreadable. */
    readonly usageBasis: "provider_reported" | "unavailable";
    /** The output allowance this call was given when the budget lowered it below the configured cap. */
    readonly clampedOutputTokens: number | undefined;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `ReceiptCompaction`

One compaction event.

`meteredCost` is REAL: what the summarization call actually cost, in the
run's denomination, zero for a free eviction. `modeledNetTokens` is MODELED
and labelled so — the context reduction this rewrite bought over the working
calls that actually followed it, net of the cache-write penalty the rewrite
forced. It is not a saving and is never called one.

```ts
export interface ReceiptCompaction {
    readonly index: number;
    readonly tier: "evicted" | "summarized" | "new-context";
    readonly preTokens: number;
    readonly postTokens: number;
    readonly pinnedSegmentIds: readonly string[];
    readonly elidedSegmentDigests: readonly string[];
    readonly summarySchemaVersion: number | undefined;
    /**
     * The cache state the provider's own usage reported on the last working call,
     * recorded as evidence. The affordability model prices the summarizer COLD
     * whatever this says: the rewrite diverges from the working call's prefix at
     * its first changed message, so a warm read there is not evidence for a warm
     * read here.
     */
    readonly cacheState: "warm" | "cold" | "unknown";
    readonly meteredCost: number;
    readonly meteredBasis: "measured";
    readonly modeledNetTokens: number;
    readonly modeledBasis: "modeled";
    /** Working calls that actually followed this compaction, the multiplier in the modeled figure. */
    readonly workingCallsAfter: number;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `ReceiptLike`

What the renderer consumes: the run's own `RunReceipt` fields it reads,
plus the print-only facts the receipt does not carry (mode, duration, and
the path the receipt JSON was written to). Built by spreading a `RunReceipt`
and adding the three extras, so the receipt file itself stays exactly the
`caveman.agent.run-receipt.v1` contract.

```ts
export interface ReceiptLike extends ReceiptCallTree {
    /** Estimated list-price subtotal of the run and everything under it. */
    readonly totalEstimatedUsd: number;
    /** True when any call in the run (or a subagent's) went unpriced. */
    readonly unpriced: boolean;
    readonly stopReason: string;
    readonly denomination: "usd" | "tokens" | "none";
    readonly max?: number | undefined;
    readonly spent?: number | undefined;
    readonly capBreached?: boolean | undefined;
    readonly mode: "optimized" | "observe-only";
    readonly durationMs: number;
    /** Where the full receipt JSON was written, as printed. */
    readonly receiptPath: string;
    /** Present only on resumed durable runs. Structurally satisfied by ReceiptResume. */
    readonly resume?: {
        readonly attempts: number;
        readonly priorCalls: number;
        readonly priorEstimatedUsd: number;
        readonly priorUnpriced: boolean;
        readonly possibleDoubleCountCalls: number;
    } | undefined;
}
```

Declared in `packages/agent/dist/receipt-print.d.ts`.

### `ReceiptPrintCall`

One model call, as the print needs it. Structurally satisfied by ReceiptCall.

```ts
export interface ReceiptPrintCall {
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly reasoningTokens: number;
    readonly unpriced: boolean;
}
```

Declared in `packages/agent/dist/receipt-print.d.ts`.

### `ReceiptResume`

Summary of the attempts a durable run made before this process. Per-call
detail for prior attempts lives in the run's journal, not here: `calls`
above lists only this attempt's calls, while `totalEstimatedUsd`,
`totalTokens`, and `spent` cover the whole logical run so the receipt and
the result can never disagree about what the run cost.

```ts
export interface ReceiptResume {
    /** Total attempts including this one (a first resume reports 2). */
    readonly attempts: number;
    /** Provider calls settled by prior attempts, across the whole agent tree. */
    readonly priorCalls: number;
    /** Estimated list-price subtotal of prior attempts' settled calls. */
    readonly priorEstimatedUsd: number;
    readonly priorTokens: number;
    /** True when any prior attempt's call went unpriced; rolls into `unpriced` above. */
    readonly priorUnpriced: boolean;
    /** Prior settled spend in the budget's denomination; `undefined` without a budget. */
    readonly priorSettled: number | undefined;
    /**
     * Provider calls that were in flight at a crash: their intent was journaled
     * but their usage never came back, so the provider may have billed money
     * this ledger could not see. The at-least-once ceiling, surfaced instead of
     * hidden — these calls appear in NO other figure on this receipt.
     */
    readonly possibleDoubleCountCalls: number;
    /** True when the crash left a partial turn that resume discarded and re-drove. */
    readonly discardedPartialTurn: boolean;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `ReceiptTool`

Tool activity for one tool name. Tools carry no model spend of their own —
a subagent tool's spend is its nested receipt under `subagents`.

```ts
export interface ReceiptTool {
    readonly name: string;
    readonly calls: number;
    readonly errors: number;
    /** Calls refused by `RunOptions.toolPolicy`; absent when zero, and counted under `errors` too. */
    readonly denied?: number;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `ResolvedEgressPolicy`

```ts
export interface ResolvedEgressPolicy {
    readonly allowedHosts: readonly string[];
    readonly allowedPorts: readonly number[];
}
```

Declared in `packages/agent/dist/sandbox/policy.d.ts`.

### `RoutineOutcomeCount`

```ts
export interface RoutineOutcomeCount {
    readonly tool: string;
    readonly outcome: RoutineOutcome;
    readonly count: number;
}
```

Declared in `packages/agent/dist/routine.d.ts`.

### `RunBreakers`

Deterministic circuit breakers.

Every decision in this file is a hash comparison or an integer count. No
model runs anywhere in the breaker path: a model judge cannot participate in
stopping or accounting, so all breaker decisions stay deterministic.

Local enforcement shares the worker detector's H6 repeat edge: same tool +
normalized arguments, excluding a repeat whose immediately-preceding
attempt failed. Exact repeats expire after a bounded turn window, so old
successful work cannot poison the rest of a long run. Worker-side finding
arithmetic is intentionally broader: session graph SCCs plus a population
Isolation-Forest confirmation. Local runtime has neither full-session
population nor authority to mint findings.

```ts
export interface RunBreakers {
    /**
     * How many identical tool calls — same tool, same normalized arguments — end
     * the run. Counted per hash, reset by an intervening failure. Defaults to 3.
     */
    readonly repeatedToolCalls?: number;
    /**
     * Assistant-turn window in which identical calls count toward
     * `repeatedToolCalls`. Older calls decay out. Defaults to 8.
     */
    readonly repeatedToolCallWindowTurns?: number;
    /**
     * How many consecutive read-only turns with an identical outcome signature
     * (same model conclusion and tool identities/results) end the run. Successful
     * declared writes reset the window because equal display text is not proof
     * that host state stayed equal. Defaults to 3.
     */
    readonly noProgressTurns?: number;
    /** Most tool calls one assistant turn may fan out to. Extras are blocked. Defaults to 8. */
    readonly maxToolCallsPerTurn?: number;
    /**
     * Cost-aware retry for model calls that fail before producing any usage.
     * Every retry takes a real hold from the run's BudgetMeter. A pre-stream
     * failure cancels that hold and records measured zero; a successful retry
     * settles provider usage. Worst-case reserved exposure is still capped, so a
     * zero-spend error storm cannot retry forever. A retry policy requires a
     * budget: there is no denomination to reserve without one.
     */
    readonly retry?: {
        /** Worst-case spend the run will expose to retries, in the budget's denomination. */
        readonly maxSpend: number;
        /** First backoff, doubled each attempt. Deterministic — no jitter. Defaults to 250ms. */
        readonly backoffMs?: number;
    };
}
```

Declared in `packages/agent/dist/breakers.d.ts`.

### `RunBudget`

```ts
export interface RunBudget {
    /** Hard cap in USD at public catalog list prices. Mutually exclusive with `maxTokens`. */
    readonly maxUsd?: number;
    /** Hard cap in provider-counted tokens. Mutually exclusive with `maxUsd`. */
    readonly maxTokens?: number;
    /** Staged release: the run starts metered against this, not `maxUsd`. */
    readonly initialUsd?: number;
    /** Staged release: the run starts metered against this, not `maxTokens`. */
    readonly initialTokens?: number;
    /** Output floor for the clamp rung. Defaults to {@link OUTPUT_CLAMP_FLOOR_TOKENS}. */
    readonly outputFloorTokens?: number;
    /**
     * What the run does as reserve headroom approaches exhaustion. `"compact"`
     * is the default: compress context while the same cap can still fund the
     * rewrite and useful work. `"stop"` skips compaction and clamps/stops only
     * when the next call itself no longer fits.
     */
    readonly onExhausted?: "compact" | "stop";
    /** Tuning for the compaction rung. Ignored when `onExhausted` is `"stop"`. */
    readonly compaction?: CompactionOptions;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `RunOptions`

```ts
export interface RunOptions {
    rootDir?: string;
    workflow?: string;
    sessionId?: string;
    /** Provider-native prompt-cache retention. Generic runs inherit Pi's short default. */
    cacheRetention?: CacheRetention;
    gatewayURL?: string;
    ensureRuntime?: boolean;
    /**
     * How this run treats the Caveman gateway. `auto` (default) routes through it
     * and, when the local gateway cannot be reached, degrades to observe-only:
     * the provider's own base URL, no transforms, no gateway telemetry, and
     * `RunResult.mode: "observe-only"`. `off` never contacts or starts the
     * gateway. A run carrying a Cave Build lock or candidate plan never degrades
     * silently — it fails with `cave_gateway_required_for_locked_plan` instead.
     */
    cave?: "auto" | "off";
    /**
     * Best-effort local spend cap for this run, in USD at public catalog list
     * prices. It is not financial enforcement: no provider invoice, no
     * platform quota, and no reservation outside this process is involved. Unset
     * leaves the run bounded only by its model/tool call ceilings.
     * When set, every root and descendant model call reserves the catalog
     * worst-case price of the call against the cap before the provider request
     * and settles measured catalog cost after it. Exhaustion terminates the run
     * with `cave_run_cost_budget_exceeded` before the next model call; partial
     * records stay in the emitted events and no `run_end` result is produced.
     * A model the public catalog cannot price cannot be capped: with the cap set,
     * such a call fails closed with `cave_subagent_unpriced_budget` rather than
     * consuming $0 of budget. Runs on unpriced models must stay uncapped and rely
     * on call ceilings instead.
     */
    maxCostUsd?: number;
    /**
     * The run's budget contract. Declares exactly one denomination:
     * `maxUsd` at public catalog list prices, or `maxTokens` in provider-counted
     * tokens. A denomination this runtime cannot honestly meter fails closed
     * before the first provider call — `maxUsd` needs a catalog-priced model,
     * because a cap that cannot be measured is not a cap.
     *
     * Enforcement is reserve-and-clamp with one mode and no soft option. Before
     * every provider call the runtime holds that call's worst-case price against
     * the budget; when the remainder cannot cover the configured output
     * allowance it clamps the call's output down to what the remainder affords,
     * and below the output floor it stops. Stopping is a normal result carrying
     * `stopReason`, never a throw: an in-flight call always finishes and is
     * counted, and the runtime never stops mid-tool.
     *
     * The guarantee, exactly: **the runtime never CHOOSES to spend past `max`.**
     * Every call is held at its worst case first, and that hold bounds the
     * payload that actually leaves. When a provider nonetheless reports more
     * than could be bounded, the run settles at the TRUE amount — a ledger that
     * clamps what a call cost is a fake ledger — sets `capBreached` with a
     * signed `overspent` on the result and its receipt, and stops. A breach is
     * loud and terminal; `spent > max` never appears without that flag, and the
     * flag rolls up from any subagent wallet that breached beneath the run.
     *
     * Unlike `maxCostUsd`, which terminates the run with an error, a budget is a
     * planned end state. The two are mutually exclusive.
     */
    budget?: RunBudget;
    /**
     * Optional pre-call model selector. It runs before every root working model
     * request, before budget reservation and before provider I/O. Returned models
     * must exist in the configured Pi catalog and stay within the initial
     * provider; unknown or cross-provider decisions fail closed.
     */
    modelRouter?: ModelCallRouter;
    /**
     * Escape hatch for the credential-regime gate. A USD budget on
     * Pi's own transport, off the gateway, is refused when the local credential
     * store cannot prove the credential is a metered API key — an unprovable
     * regime fails closed rather than booking fictional dollars against what may
     * be a subscription. Set this to `true` to assert, on your own authority,
     * that the credential IS metered per token, so a dollar budget is honest.
     * Ignored for a caller-supplied `streamFn` and for an actually routed gateway
     * whose identified readiness response proves `billing: "managed"`. BYOK or
     * unknown gateway billing still uses this local credential assertion.
     */
    assumeMeteredCredential?: boolean;
    /**
     * Where durable agent memory lives, and for whom. `memory()`
     * entries persist to a per-namespace file scoped by (tenant, agentId,
     * namespace), so a `ttl: "30d"` is a real 30-day promise across process
     * restarts. Set `root` to point an embedding server at its own location, and
     * `tenant` to isolate one tenant's memories from another's even when they
     * share an agent id and namespace. Defaults: `CAVE_AGENT_MEMORY_ROOT` or
     * `~/.caveman/agent-memory`, single-tenant.
     */
    memory?: MemoryRuntimeConfig;
    /**
     * Handle for releasing staged budget during this run. Pair it
     * with `budget.initialUsd` / `budget.initialTokens`: the run starts metered
     * against the initial tranche, and the developer's own checkpoint logic calls
     * `releaseBudget(amount, reason)` to hand it more, up to `max`. Nothing the
     * model produces can reach it.
     */
    budgetController?: BudgetController;
    /**
     * What happens when the budget binds. `"stop"` is the default:
     * stop between calls, return partial work plus the receipt. A handler may
     * release one numeric tranche through the budget controller or stop. It sees
     * only meter figures, runs between calls with nothing in flight, and never
     * receives prompt, output, tool, or model content.
     *
     * Continuation never crosses `max`: a handler that asks for more than the
     * contract allows throws at the release, exactly as a checkpoint would.
     */
    onBudgetExhausted?: "stop" | BudgetExhaustionHandler;
    /**
     * Wall-clock allowance for this run in milliseconds, enforced at the same
     * between-calls points as the budget: the runtime finishes what is in flight,
     * declines to start another call, and returns `stopReason: "deadline"`.
     */
    deadlineMs?: number;
    /**
     * How deep a subagent graph this run may spawn, counted from the root. The
     * default is deliberately small: delegation multiplies spend, so a graph that
     * wants to go deeper says so. Capped at {@link ABSOLUTE_SUBAGENT_DEPTH_LIMIT}.
     */
    maxSubagentDepth?: number;
    /**
     * Opt-in root-tree ceiling on admitted subagent invocations. One shared
     * monotonic counter covers every subagent tool and every descendant depth;
     * failures and aborts still consume an admission once the child starts.
     * Unset preserves per-tool `maxCalls` behavior with no tree-wide total.
     */
    maxSubagentInvocations?: number;
    /**
     * Opt-in root-tree ceiling on simultaneously active descendants. Reservation
     * is synchronous and released on success, failure, or abort. Unset preserves
     * existing behavior with no tree-wide concurrency ceiling.
     */
    maxConcurrentSubagents?: number;
    /**
     * Hard ceiling on the number of provider model calls this run may issue
     * Defaults to 64. When the run reaches it, the runtime stops
     * gracefully between calls with `stopReason: "call_budget_exhausted"` — the
     * partial text, usage, and receipt are returned, never a throw that would
     * destroy the ledger of what was already spent. An efficiency-plan run
     * derives a tighter default from its retry-cascade reserve; a caller value
     * here always overrides. Must be a positive integer.
     */
    maxModelCalls?: number;
    /**
     * Hard ceiling on the number of tool calls this run may issue.
     * Defaults to 64. A tool call beyond it is blocked (the model sees a blocked
     * result and the run continues), never a throw. An efficiency-plan run
     * derives its default from the model-call ceiling and tool count; a caller
     * value here always overrides. Must be a positive integer.
     */
    maxToolCalls?: number;
    /**
     * Deterministic circuit breakers: repeated-tool-call loop
     * detection, a no-progress window, a per-turn fan-out cap, and cost-aware
     * retry. Opt-in — a run that declares none behaves exactly as before, because
     * a false loop break is worse than the loop it thought it saw. Breaking is a
     * between-calls stop like any other, with `stopReason: "loop_detected"` or
     * `"no_progress"` and the offending window on the receipt.
     */
    breakers?: RunBreakers;
    /**
     * Print the end-of-run receipt to stdout and write its JSON under
     * `rootDir/.caveman/runs/`. Off by default: stdout may be a protocol
     * channel (an MCP server, a pipe) that receipt text would corrupt.
     * Directory-loaded agents (`loadAgentDir`) default it ON so the scaffold
     * keeps the receipt with zero config; an explicit value always wins.
     */
    printReceipt?: boolean;
    /**
     * Opt-in durable execution. The run journals its ledger and turn state as
     * it goes (append-only JSONL, disk by default under
     * `rootDir/.caveman/runs/durable/<runId>/`); a crashed or cancelled run
     * called again with the same `runId` RESUMES from the last completed turn
     * instead of starting over — settled spend is never re-reserved and never
     * lost, and a completed run returns its journaled result without spending
     * again. Honest ceiling (at-least-once): a crash mid-provider-call can
     * leave one in-flight call the provider may have billed but whose usage
     * this ledger never saw; resume surfaces it as
     * `receipt.resume.possibleDoubleCountCalls` rather than guessing. That
     * figure counts RESERVED provider calls, not HTTP attempts — a breaker
     * retry cascade inside one reserved call is one intent. A replayed
     * terminal outcome yields only `run_start` then `run_end`/`run_error`
     * (no `context_ready`).
     * The journal contains message content (a resume needs the conversation),
     * unlike the content-blind receipt — the disk store writes 0o700/0o600.
     * A supplied `conversation` is bound by exact session and base-message
     * digest. Completed replay synchronizes it without appending input twice;
     * concurrent reuse fails before journal mutation. Tool intents fsync before
     * I/O. Read tools may redrive, idempotent tools receive a stable key, and an
     * unmatched write/external intent fails closed. Still not combinable with
     * `maxCostUsd` (use `budget`); durability is a root-run contract and child
     * evidence shares its journal. Breaker windows restart on resume.
     */
    durable?: DurableRunOptions;
    /**
     * Host-owned authorization for every declared tool call, decided outside
     * model output (the Claude Agent SDK `canUseTool` shape). Runs after the
     * kernel's own admission (deadline, budget, caps, breakers, sandbox posture,
     * argument shape) for root, subagent, and nested composite calls alike;
     * framework `cave_*` tools are not gated. `{ deny: code }` blocks the call:
     * the model reads `cave_tool_denied:<code>` as the tool result, the receipt
     * counts it under `denied`, and the run continues. A policy that throws,
     * hangs past 10s, or returns a malformed decision ends the run with
     * `cave_tool_policy_failed`: unknown authorization state never executes a
     * tool. Evaluated again on durable resume, before replay: denying a call the
     * crashed attempt already settled ends the resume fail-closed
     * (`cave_durable_tool_replay_incomplete`), never as a quiet skip. A policy
     * cannot rewrite arguments.
     */
    toolPolicy?: ToolCallPolicy;
    model?: Model<Api>;
    models?: Models;
    streamFn?: StreamFn;
    providerPayloadContract?: "pi-on-payload-v1";
    conversation?: Conversation;
    fetch?: typeof globalThis.fetch;
    entryPath?: string;
    engineBin?: string;
    signal?: AbortSignal;
    /** Optional queue/steering/interrupt handle for an active Pi run. */
    controller?: AgentRunController;
    sandboxProfile?: {
        /**
         * Egress for contained tools, in three values:
         *
         * - `false` — no network at all. The kernel removes every route out.
         * - a {@link SandboxEgressPolicy} — scoped egress. The child still has no
         *   network stack; its only peer is a parent-owned proxy that dials the
         *   allowlisted hosts and refuses everything else. Requires a backend that
         *   can provide a reachable proxy path, else
         *   `cave_sandbox_scoped_egress_unavailable`.
         * - `true` — unbounded egress. Still FAILS CLOSED with
         *   `cave_sandbox_network_egress_unbounded`: tool code holding a provider
         *   credential does not get an unfiltered socket. Name the hosts instead.
         *
         * The proxy does not terminate TLS, so it constrains the destination the
         * client names, never the bytes inside the tunnel.
         */
        network: boolean | SandboxEgressPolicy;
        childProcess: boolean;
        credentialEnv: readonly string[];
    };
}
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `RunReceipt`

The economic receipt every run returns.

Every money figure here is a public-catalog price estimate. It is not an
invoice, bill, or provider savings claim.

```ts
export interface RunReceipt {
    readonly schema: typeof AGENT_RUN_RECEIPT_SCHEMA;
    readonly runId: string;
    readonly agentId: string;
    readonly basis: "estimated_list_price_subtotal";
    readonly claimBasis: "inferred";
    readonly stopReason: RunStopReason;
    /** `none` when the run declared no budget: the receipt still reports, nothing enforces. */
    readonly denomination: BudgetDenomination | "none";
    readonly max: number | undefined;
    readonly released: number | undefined;
    /** Metered spend in the run's own denomination, `undefined` without a budget. */
    readonly spent: number | undefined;
    /**
     * True when measured spend crossed `max`. The runtime never chooses to spend
     * past max — every call is reserved at its worst case first — so this means
     * a provider-side amount came in above what could be bounded. The receipt
     * never shows `spent > max` without this flag set.
     */
    readonly capBreached: boolean;
    /**
     * Signed amount **this run's own meter** went past its `max`, zero when its
     * own cap held. Deliberately not a tree total: settling a subagent's carve
     * books the child's real spend against this run, so a child's overspend
     * usually shows up here too and adding the two would count the same money
     * twice. Each subagent's own figure is on its own receipt under `subagents`.
     */
    readonly overspent: number;
    /** Estimated list-price subtotal of this run and everything under it. */
    readonly totalEstimatedUsd: number;
    readonly totalTokens: number;
    /** True when any call in this receipt or its subagents went unpriced. */
    readonly unpriced: boolean;
    readonly calls: readonly ReceiptCall[];
    readonly tools: readonly ReceiptTool[];
    readonly subagents: readonly RunReceipt[];
    readonly tranches: readonly BudgetTranche[];
    /** Every deterministic breaker decision this run made, so a break is never silent. */
    readonly breakers: readonly BreakerEvent[];
    /** Every context compaction, with its real cost and its modeled effect kept apart. */
    readonly compactions: readonly ReceiptCompaction[];
    /** Present only on a resumed durable run. */
    readonly resume?: ReceiptResume;
}
```

Declared in `packages/agent/dist/budget.d.ts`.

### `RunResult`

```ts
export interface RunResult<TOutput = unknown> {
    runId: string;
    agentId: string;
    text: string;
    /**
     * The final message parsed against `definition.output.schema`. Present only
     * when a schema is declared and the text validated against it; absent when
     * the run stopped before a final message.
     */
    output?: TOutput;
    contextIR: ContextIR;
    contextBill: Record<string, number>;
    cachePrefixSHA256: string;
    cacheBoundaryKnown: boolean;
    cacheBust: boolean;
    usageBasis: "provider_reported" | "unavailable";
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Only interpret reasoningTokens when this basis is provider_reported. */
    reasoningUsageBasis: "provider_reported" | "unavailable";
    reasoningTokens: number;
    costUsd: number;
    /**
     * How costUsd was arrived at. `unpriced` means at least one accumulated model
     * call had no public-catalog price, so costUsd is an honest zero-contribution
     * for that call rather than a measured amount — never read it as "$0 spent".
     */
    priceBasis: "public_catalog" | "unpriced";
    /**
     * `optimized` means every model call this run made — its own and every
     * subagent's — actually went through the Caveman gateway, so transforms and
     * gateway telemetry were available to all of it. `observe-only` means at least
     * one call went straight to the provider: either the gateway was unreachable
     * or `cave: "off"`, or the model's provider is not one the gateway proxies
     * (only anthropic, openai, and google are). A mixed graph reports
     * `observe-only`; the label under-claims rather than averaging, because the
     * gateway measured nothing about the calls that bypassed it. Local results are
     * estimates in both modes; no provider savings claim is made.
     */
    mode: "optimized" | "observe-only";
    provider: string;
    model: string;
    latencyMs: number;
    toolCalls: string[];
    evaluatedTransformIDs: string[];
    transformIDs: string[];
    transformFailures: string[];
    transformTrace: TransformTrace[];
    recoveryResolved: boolean;
    /**
     * Why the run stopped issuing calls. `complete` is the ordinary end of the
     * agent loop. Every other value means the runtime stopped between calls with
     * partial work in hand: the text, usage, and cost above cover exactly the
     * calls that did happen, and no call was interrupted mid-flight.
     */
    stopReason: RunStopReason;
    /**
     * True when measured spend crossed the budget's `max`, here or in any
     * subagent wallet beneath this run.
     *
     * It sits beside `stopReason` because the two answer different questions: a
     * run can stop cleanly at its cap, or stop having already gone past it, and
     * a caller switching on `stopReason` alone cannot tell those apart. The
     * runtime never chooses to spend past max — this means a provider reported
     * more than the hold could bound.
     */
    capBreached: boolean;
    /**
     * Signed amount **this run's own meter** went past its `max`, zero when its
     * own cap held. `capBreached` rolls up from subagents; this figure does not,
     * because settling a carve books the child's real spend here too and adding
     * both would count the same money twice. Each subagent's own amount is on
     * its receipt under `receipt.subagents`.
     */
    overspent: number;
    /**
     * This run's economic receipt: every provider call, every tool, every
     * subagent's own receipt, and the budget's tranche history. Its money figures
     * are estimated public-catalog list-price subtotals, never invoices.
     */
    receipt: RunReceipt;
    claimBasis: "inferred";
    unlocked: boolean;
    /**
     * True when this durable run resumed from a prior attempt's journal. Its
     * usage and cost totals cover the whole logical run — prior attempts
     * included — and `receipt.resume` summarizes what happened before this
     * process, including any in-flight call the crash made unaccountable.
     */
    resumed?: boolean;
}
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `RuntimeContextSegment`

```ts
export interface RuntimeContextSegment {
    id: string;
    kind: "history" | "tool_result";
    body: Uint8Array;
    /** Provider-visible bytes when body is a bounded content-blind projection. */
    providerVisibleBytes?: number;
    /** Prevent transforms when body represents opaque provider-visible media. */
    opaque?: boolean;
}
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `SandboxEgressPolicy`

```ts
export interface SandboxEgressPolicy {
    /**
     * Hosts the tool may dial. Exact (`api.example.com`) or one leading-label
     * wildcard (`*.example.com`, which matches `a.example.com` and
     * `a.b.example.com` but never `example.com` itself).
     */
    readonly allowedHosts: readonly string[];
    /** Ports the tool may dial. Defaults to `[443]` when omitted. */
    readonly allowedPorts?: readonly number[];
}
```

Declared in `packages/agent/dist/sandbox/policy.d.ts`.

### `ShellToolsOptions`

```ts
export interface ShellToolsOptions {
    /** Workspace root; tools refuse paths outside it (realpath-based on the local backend). */
    workspace: string;
    /** Where processes run and files live. Default `localExecutionBackend()` — host execution, not isolation. */
    executionBackend?: ExecutionBackend;
    /** Which tools to build, in this order. Default: all six. */
    tools?: readonly ShellToolName[];
    /** Per-tool raw output caps in bytes, applied before any transform. */
    outputCaps?: Partial<Record<ShellToolName, number>>;
    /** Interactive bash sessions (local backend only). Omit for one-shot bounded bash. */
    commandSessions?: CommandSessionRuntime;
    /** Observes every capped tool output. */
    onOutput?: (label: string, text: string) => void;
}
```

Declared in `packages/agent/dist/shell-tools.d.ts`.

### `StandardInputOutputToolOptions`

```ts
export interface StandardInputOutputToolOptions<Input, Output, TOutput extends StandardSchemaV1> extends Omit<StandardToolOptions<Input, Output, StandardSchemaV1.InferInput<TOutput>, StandardSchemaV1.InferOutput<TOutput>>, "output"> {
    output: TOutput;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `StandardJSONOutputToolOptions`

```ts
export interface StandardJSONOutputToolOptions<Input, Output, TOutput extends StandardSchemaV1> extends Omit<StandardJSONToolOptions<Input, Output, StandardSchemaV1.InferInput<TOutput>, StandardSchemaV1.InferOutput<TOutput>>, "output"> {
    output: TOutput;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `StandardJSONToolOptions`

```ts
export interface StandardJSONToolOptions<Input, Output, TExecuteResult, TResult = TExecuteResult> extends Omit<StandardToolOptions<Input, Output, TExecuteResult, TResult>, "input" | "inputJSONSchema"> {
    input: StandardToolSchema<Input, Output>;
    inputJSONSchema?: never;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `StandardJSONTypeBoxOutputToolOptions`

```ts
export interface StandardJSONTypeBoxOutputToolOptions<Input, Output, TOutput extends TSchema> extends Omit<StandardJSONToolOptions<Input, Output, Static<TOutput>, Static<TOutput>>, "output" | "outputJSONSchema"> {
    output: TOutput & {
        readonly "~standard"?: never;
    };
    outputJSONSchema?: never;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `StandardOutputToolOptions`

```ts
export interface StandardOutputToolOptions<TInput extends TSchema, TOutput extends StandardSchemaV1> extends Omit<ToolOptions<TInput, StandardSchemaV1.InferInput<TOutput>, StandardSchemaV1.InferOutput<TOutput>>, "output"> {
    output: TOutput;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `StandardToolOptions`

```ts
export interface StandardToolOptions<Input, Output, TExecuteResult, TResult = TExecuteResult> {
    name: string;
    description: string;
    input: StandardSchemaV1<Input, Output>;
    inputJSONSchema: TSchema;
    /** TypeBox/JSON Schema or Standard Schema result contract. */
    output?: StandardSchemaV1<TExecuteResult, TResult>;
    /** Required only when a Standard output schema cannot emit draft-07. */
    outputJSONSchema?: TSchema;
    /** SHA-256 of Standard/custom-format validator semantics and captured state. */
    schemaSemanticsSHA256?: string;
    effect: ToolEffect;
    result?: ToolResultPolicy | ArtifactDefinition;
    /** See {@link ToolDefinition.allowRepeat}. */
    allowRepeat?: boolean;
    /** See {@link ToolDefinition.speculative}. */
    speculative?: boolean;
    timeoutMs?: number;
    runtime?: ToolRuntimeDefinition;
    nestedTools?: readonly ToolDefinition[];
    speculativeTools?: readonly string[];
    execute: (input: Output, signal?: AbortSignal, context?: ToolExecutionContext) => TExecuteResult | Promise<TExecuteResult>;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `StandardTypeBoxOutputToolOptions`

```ts
export interface StandardTypeBoxOutputToolOptions<Input, Output, TOutput extends TSchema> extends Omit<StandardToolOptions<Input, Output, Static<TOutput>, Static<TOutput>>, "output" | "outputJSONSchema"> {
    output: TOutput & {
        readonly "~standard"?: never;
    };
    outputJSONSchema?: never;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `SubagentRuntimeDefinition`

```ts
export interface SubagentRuntimeDefinition {
    readonly kind: "subagent";
    readonly definition: unknown;
    readonly maxInputChars: number;
    readonly maxCalls: number;
    readonly maxCostUsd: number;
    /**
     * The token-denominated sibling of `maxCostUsd`. A run metered in tokens
     * carves this child's wallet from it; without it, such a run cannot fund
     * this subagent at all.
     */
    readonly maxTokens?: number;
    readonly maxContextTokens: number;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ToolCallDenial`

```ts
export interface ToolCallDenial {
    readonly block: true;
    readonly reason: string;
}
```

Declared in `packages/agent/dist/tool-policy.d.ts`.

### `ToolCallPolicyInput`

```ts
export interface ToolCallPolicyInput {
    readonly runId: string;
    readonly agentId: string;
    /** `[]` for the root agent; the subagent tool names leading here otherwise. */
    readonly agentPath: readonly string[];
    readonly toolCallId: string;
    /** Present only for a nested call dispatched by a composite/programmatic tool. */
    readonly parentToolCallId?: string;
    readonly name: string;
    readonly effect: ToolEffect;
    /** Validated arguments, exactly what the tool would receive. Read-only. */
    readonly args: unknown;
}
```

Declared in `packages/agent/dist/tool-policy.d.ts`.

### `ToolDefinition`

```ts
export interface ToolDefinition<TInput = unknown, TResult = unknown> {
    readonly kind: "tool";
    readonly name: string;
    readonly description: string;
    readonly input: TSchema;
    /** Declared result contract. Validated before any result reaches model context. */
    readonly output?: TSchema;
    /** Stable digest required to lock/durably replay mutable custom schema semantics. */
    readonly schemaSemanticsSHA256?: string;
    readonly effect: ToolEffect;
    readonly result: ToolResultPolicy;
    readonly artifact?: ArtifactDefinition;
    /**
     * Opt this tool out of the repeated-call loop breaker. Set it on tools whose
     * job is to be called again with the same arguments — polling a queue,
     * waiting on a build, re-reading a file that changes underneath.
     */
    readonly allowRepeat?: boolean;
    /** Explicit opt-in for kernel-owned streaming speculation. Read tools only. */
    readonly speculative?: boolean;
    readonly timeoutMs: number;
    readonly runtime?: ToolRuntimeDefinition;
    /** Flat, kernel-dispatched tools available only inside this composite tool. */
    readonly nestedTools?: readonly ToolDefinition[];
    /** Nested read tools whose already-started result may be consumed safely. */
    readonly speculativeTools?: readonly string[];
    readonly execute: {
        bivarianceHack(input: TInput, signal?: AbortSignal, context?: ToolExecutionContext): TResult | Promise<TResult>;
    }["bivarianceHack"];
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ToolExecutionContext`

```ts
export interface ToolExecutionContext {
    /** Provider identity for this exact tool invocation. */
    readonly toolCallId: string;
    /** Stable, non-secret durable identity. Present only on durable runs. */
    readonly durable?: {
        readonly idempotencyKey: string;
        /** True when this invocation safely re-drives an unmatched prior intent. */
        readonly resumed: boolean;
    };
    /** Composite parent identity; equals toolCallId on a top-level invocation. */
    readonly parentToolCallId: string;
    /** Dispatch one declared nested tool through the run's canonical kernel. */
    dispatch(name: string, input: unknown, options?: NestedToolDispatchOptions): Promise<unknown>;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ToolOptions`

```ts
export interface ToolOptions<TInput extends TSchema, TExecuteResult, TResult = TExecuteResult> {
    name: string;
    description: string;
    input: TInput & {
        readonly "~standard"?: never;
    };
    /** TypeBox/JSON Schema or Standard Schema result contract. */
    output?: StandardSchemaV1<TExecuteResult, TResult>;
    /** Required only when a Standard output schema cannot emit draft-07. */
    outputJSONSchema?: TSchema;
    /** SHA-256 of Standard/custom-format validator semantics and captured state. */
    schemaSemanticsSHA256?: string;
    effect: ToolEffect;
    result?: ToolResultPolicy | ArtifactDefinition;
    /** See {@link ToolDefinition.allowRepeat}. */
    allowRepeat?: boolean;
    /** See {@link ToolDefinition.speculative}. */
    speculative?: boolean;
    timeoutMs?: number;
    runtime?: ToolRuntimeDefinition;
    nestedTools?: readonly ToolDefinition[];
    speculativeTools?: readonly string[];
    execute: (input: Static<TInput>, signal?: AbortSignal, context?: ToolExecutionContext) => TExecuteResult | Promise<TExecuteResult>;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `TypeBoxOutputToolOptions`

```ts
export interface TypeBoxOutputToolOptions<TInput extends TSchema, TOutput extends TSchema> extends Omit<ToolOptions<TInput, Static<TOutput>, Static<TOutput>>, "output" | "outputJSONSchema"> {
    output: TOutput & {
        readonly "~standard"?: never;
    };
    outputJSONSchema?: never;
}
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `WorkloadPartition`

```ts
export interface WorkloadPartition {
    readonly split: WorkloadSplit;
    readonly split_sha256: string;
    readonly trajectory_count: number;
    readonly case_count: number;
    readonly model_calls: number;
    readonly provider_visible_tokens: number;
    /** Public-catalog subtotal for priced rows only; completeness is reported beside it. */
    readonly catalog_cost_usd: number;
    readonly provider_reported_count: number;
    readonly usage_incomplete_count: number;
    readonly priced_count: number;
    readonly unpriced_count: number;
    readonly error_count: number;
    readonly tool_effects: readonly ProfileToolEffect[];
    readonly trajectories: readonly NormalizedTrajectory[];
}
```

Declared in `packages/agent/dist/profile.d.ts`.

### `WorkloadProfile`

```ts
export interface WorkloadProfile {
    readonly schema_version: typeof WORKLOAD_PROFILE_SCHEMA_VERSION;
    readonly profile_sha256: string;
    readonly partitions: {
        readonly profile: WorkloadPartition;
        readonly development: WorkloadPartition;
        readonly holdout: WorkloadPartition;
    };
    readonly tool_effects: readonly ProfileToolEffect[];
}
```

Declared in `packages/agent/dist/profile.d.ts`.

## Type aliases

### `AgentDirContextValue`

```ts
export type AgentDirContextValue = string | (() => string) | {
    value: string | (() => string);
    /**
     * Defaults to `"build"` — LOAD-BEARING: bare entries land in the frozen
     * prefix, which is exactly what Phase 2's volatile-prefix check inspects.
     * `"turn"` places the value in the live zone instead. Either way the
     * value is evaluated ONCE, when the directory is loaded — `"turn"` does
     * not re-evaluate a function per turn (per-turn re-evaluation is issue
     * #224, Phase 2); today it only decides which cache region the segment
     * sits in.
     */
    stability?: "build" | "turn";
};
```

Declared in `packages/agent/dist/dir-loader.d.ts`.

### `AgentInput`

```ts
export type AgentInput = string | readonly AgentInputPart[];
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputPart`

```ts
export type AgentInputPart = AgentTextInputPart | AgentImageInputPart | AgentAudioInputPart | AgentFileInputPart | AgentOpaqueInputPart;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentInputSource`

```ts
export type AgentInputSource = AgentInputURLSource | AgentInputBase64Source;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AgentOutput`

The parsed `RunResult.output` type for a definition whose `output()` declares a schema.

```ts
export type AgentOutput<D> = D extends AgentDefinition<infer S> ? S extends TSchema ? Static<S> : never : never;
```

Declared in `packages/agent/dist/index.d.ts`.

### `Auto`

```ts
export type Auto = {
    readonly kind: "auto";
    readonly [AUTO]: true;
};
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `BudgetDenomination`

The economic runtime's meter.

Every figure here is a public-catalog **list-price subtotal**, not an
invoice. A USD budget can only bind on a model the catalog prices; an
unpriced model fails closed rather than treating an unknown price as zero.

Denominations are runtime-gated: dollars only where the runtime
honestly meters dollars — the API-key provider paths this package drives —
and raw tokens where it does not. A run declares exactly one.

```ts
export type BudgetDenomination = "usd" | "tokens";
```

Declared in `packages/agent/dist/budget.d.ts`.

### `BudgetExhaustionHandler`

Caller-side numeric tranche allocator for budget exhaustion.

Called **between** calls, never mid-tool, and never with anything in flight.
Return `"stop"` to take the default outcome — partial work plus receipt — or
`{ release, reason }` to top up a tranche through the budget controller and carry
on. A release past `max` throws, because `max` is the contract.

This is not an action gate, permission system, or approval workflow. It sees
only bounded meter figures; prompt, output, tool, and model content never
reaches it.

Out of scope for v1: pausing a run and resuming it later from a serializable
handle. The hook is synchronous with the run it belongs to.

```ts
export type BudgetExhaustionHandler = (context: BudgetExhaustionContext) => Promise<"stop" | {
    release: number;
    reason: string;
}>;
```

Declared in `packages/agent/dist/budget.d.ts`.

### `CacheRegion`

```ts
export type CacheRegion = "frozen_prefix" | "live_zone" | "uncached";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `CavemanRunEvent`

```ts
export type CavemanRunEvent = {
    type: "run_start";
    runId: string;
    agentId: string;
} | {
    type: "context_ready";
    runId: string;
    contextIR: ContextIR;
    bill: Record<string, number>;
} | {
    type: "model_route";
    runId: string;
    decision: ModelCallRouteDecision;
} | {
    type: "pi";
    runId: string;
    event: AgentEvent;
} | {
    type: "nested_tool_start";
    runId: string;
    id: string;
    name: string;
    args: unknown;
} | {
    type: "nested_tool_end";
    runId: string;
    id: string;
    name: string;
    isError: boolean;
    result: unknown;
} | {
    type: "run_end";
    runId: string;
    result: RunResult;
} | {
    type: "run_error";
    runId: string;
    code: string;
    message: string;
    receipt: RunReceipt;
};
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `ConnectActionBindValue`

Values trusted config may fix on an action. Must stay serializable.

```ts
export type ConnectActionBindValue = string | number | boolean | null;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ConnectExecutor`

```ts
export type ConnectExecutor = (binary: string, args: readonly string[], options: ConnectExecuteOptions) => Promise<ConnectProcessResult>;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `ContextAnchorKind`

The sectioned summary the summarizer must produce.

Structure rather than prose keeps required fields explicit. `constraintsRestated`
is a restatement only — the pinned buffer is the carrier, and a summary that
becomes the only carrier reproduces the failure this design exists to avoid.

```ts
export type ContextAnchorKind = "objective" | "constraint" | "decision" | "artifact" | "fact" | "blocker" | "next";
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextCompactionSummarizer`

Adapter seam for provider, local model, replay, or deterministic oracle.

```ts
export type ContextCompactionSummarizer = (request: ContextCompactionSummarizerRequest) => Promise<string> | string;
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextKind`

```ts
export type ContextKind = "instruction" | "user_intent" | "tool_schema" | "skill" | "memory" | "history" | "tool_result" | "artifact" | "error" | "output_contract";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ContextPriority`

```ts
export type ContextPriority = "required" | "high" | "normal" | "low";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ContextStability`

```ts
export type ContextStability = "build" | "session" | "turn";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ConversationState`

```ts
export type ConversationState = Conversation;
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `DurableRunSummary`

What a journal says about a run, WITHOUT the definition, budget, or input
the caller would need for {@link analyzeJournal}. This is the read-only
view: it answers "is this run finished, and with what" for a status
endpoint or a recovery sweep. It deliberately cannot resume anything —
every resume still goes through `analyzeJournal`, which fails closed on a
definition, input, or budget that drifted.

```ts
export type DurableRunSummary = {
    readonly status: "missing";
} | {
    readonly status: "pending";
    readonly runId: string;
    readonly agentId: string;
    readonly input: string;
    readonly startedAt: string;
    readonly attempts: number;
    /**
     * Set when a cancellation was requested and the run has not settled yet.
     * A recovery sweep must honour this instead of re-driving the run.
     */
    readonly cancelRequested?: {
        readonly reason: string;
        readonly at: string;
    };
    /**
     * Absolute time before which this run must not be driven. Present while a
     * durable sleep is outstanding — including one already due, so a caller can
     * tell "asleep until later" from "never slept" without a clock comparison
     * of its own.
     */
    readonly wakeAt?: string;
    /** Why it is sleeping. Operator-facing; never a secret. */
    readonly sleepReason?: string;
} | {
    readonly status: "completed";
    readonly runId: string;
    readonly agentId: string;
    readonly result: unknown;
    readonly settledAt: string;
} | {
    readonly status: "failed";
    readonly runId: string;
    readonly agentId: string;
    readonly code: string;
    readonly message: string;
    readonly receipt: unknown;
    readonly settledAt: string;
};
```

Declared in `packages/agent/dist/durable.d.ts`.

### `EvalGuardrail`

```ts
export type EvalGuardrail = {
    type: "latency_threshold";
    p95_ms: number;
} | {
    type: "error_rate";
    max: number;
};
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `EvalSplit`

```ts
export type EvalSplit = "profile" | "development" | "holdout";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `FiniteJSON`

```ts
export type FiniteJSON = null | boolean | number | string | readonly FiniteJSON[] | {
    readonly [key: string]: FiniteJSON;
};
```

Declared in `packages/agent/dist/input.d.ts`.

### `MemoryKind`

```ts
export type MemoryKind = "fact" | "preference" | "procedure" | "correction" | "decision";
```

Declared in `packages/agent/dist/memory.d.ts`.

### `MemoryRelation`

```ts
export type MemoryRelation = "relates_to" | "supersedes" | "contradicts" | "derived_from";
```

Declared in `packages/agent/dist/memory.d.ts`.

### `ModelBoundaryRole`

```ts
export type ModelBoundaryRole = "working" | "compaction";
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `ModelCallRouter`

```ts
export type ModelCallRouter = (input: ModelCallRouteInput) => ModelCallRouteDecision | Promise<ModelCallRouteDecision>;
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `ModelUsageAccountingStatus`

```ts
export type ModelUsageAccountingStatus = "complete_priced" | "complete_unpriced" | "incomplete";
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `ModelUsageCost`

```ts
export type ModelUsageCost = {
    readonly status: "estimated";
    readonly basis: "public_catalog";
    readonly usd: number;
} | {
    readonly status: "unpriced";
} | {
    readonly status: "unknown";
};
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `ModelUsageTokenCount`

```ts
export type ModelUsageTokenCount = number | null;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `PrivacyClass`

```ts
export type PrivacyClass = "content_blind" | "local_sensitive" | "connected_allowed";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ProfiledCompileStatus`

```ts
export type ProfiledCompileStatus = CompileResult["status"] | "holdout_failed" | "capability_refused";
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `ProgrammaticSpeculationDispatch`

```ts
export type ProgrammaticSpeculationDispatch = (launch: ProgrammaticSpeculationLaunch) => Promise<unknown>;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `QualityGrader`

Graders the native compiler can lower without model or network dependencies.
`exact_match` uses canonical eval semantics: trimmed, case-insensitive text by
default; `case_sensitive` and `remove_punctuation` opt into stricter variants.

```ts
export type QualityGrader = Extract<Grader, {
    type: LowerableQualityGraderType;
}>;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `RecoveryKind`

```ts
export type RecoveryKind = "none" | "exact_ccr" | "source_ref" | "recompute";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `RoutineOutcome`

Closed, runtime-declared outcome vocabulary for a routine call. Unknown
states do not exist: every invocation lands on exactly one of these three.

Observability only. These counts feed `observed` before/after measurement of
a step's spend; they are never a savings claim, never a receipt line, and
never touch cost math.

```ts
export type RoutineOutcome = "routine_hit" | "routine_deopt_guard" | "routine_deopt_error";
```

Declared in `packages/agent/dist/routine.d.ts`.

### `RunStopReason`

Why a run stopped issuing calls. `complete` is the ordinary end of an agent
loop; every other value means the runtime stopped the run between calls with
partial work in hand. Unknown values are not representable — a stop reason is
always one of these, so a consumer switch can fail closed on the default.

```ts
export type RunStopReason = "complete" | "budget_exhausted" | "deadline" | "loop_detected" | "no_progress" | "wallet_revoked" | "call_budget_exhausted";
```

Declared in `packages/agent/dist/budget.d.ts`.

### `SafetyClass`

```ts
export type SafetyClass = "S0" | "S1" | "S2" | "S3" | "S4";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `SandboxEgress`

A tool's requested egress. `"none"` is the default and the safe value.

```ts
export type SandboxEgress = "none" | SandboxEgressPolicy;
```

Declared in `packages/agent/dist/sandbox/policy.d.ts`.

### `ShellToolName`

```ts
export type ShellToolName = "bash" | "read_file" | "grep" | "write_file" | "edit_file" | "read_tool_output";
```

Declared in `packages/agent/dist/shell-tools.d.ts`.

### `StandardToolSchema`

```ts
export type StandardToolSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output> & StandardJSONSchemaV1<Input, Output>;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ToolCallDecision`

`undefined` or `{ allow: true }` admits the call. `{ deny: code }` blocks it:
the model reads `cave_tool_denied:<code>` as the tool result and the receipt
counts the call under `denied`. `code` is a short identifier, never tenant
text, so receipts and journals stay content-blind.

```ts
export type ToolCallDecision = undefined | void | {
    readonly allow: true;
} | {
    readonly deny: string;
};
```

Declared in `packages/agent/dist/tool-policy.d.ts`.

### `ToolCallPolicy`

```ts
export type ToolCallPolicy = (call: ToolCallPolicyInput) => ToolCallDecision | Promise<ToolCallDecision>;
```

Declared in `packages/agent/dist/tool-policy.d.ts`.

### `ToolEffect`

```ts
export type ToolEffect = "read" | "write" | "idempotent" | "external";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ToolResultPolicy`

```ts
export type ToolResultPolicy = "auto" | "inline" | "page" | "compress" | "exact_ccr";
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `ToolRuntimeDefinition`

```ts
export type ToolRuntimeDefinition = SubagentRuntimeDefinition | ConnectToolRuntimeDefinition;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `TrajectorySource`

```ts
export type TrajectorySource = "caveman_run_result" | "otel_span" | "openinference_span";
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

### `WorkloadSplit`

```ts
export type WorkloadSplit = "profile" | "development" | "holdout";
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

## Functions

### `agent`

```ts
export declare function agent<TOutput extends TSchema | undefined = undefined>(options: {
    id: string;
    instructions: string | FileSource;
    model: Auto | string | Model<Api>;
    reasoning?: AgentDefinition["reasoning"];
    tools?: ToolDefinition[];
    contexts?: ContextDefinition[];
    memory?: MemoryDefinition;
    output?: OutputDefinition<TOutput>;
    sandbox?: AgentDefinition["sandbox"];
}): AgentDefinition<TOutput>;
```

Declared in `packages/agent/dist/definition.d.ts`.

### `agentStaticContextDiagnostics`

Inspect provider-visible static context without starting a model call.
Uses the same canonical context lowering and system-prompt assembly as runtime.

```ts
export declare function agentStaticContextDiagnostics(definition: AgentDefinition, rootDir?: string): Promise<AgentStaticContextDiagnostics>;
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `appendRuntimeContextSegment`

```ts
export declare function appendRuntimeContextSegment(lowered: LoweredContext, segment: RuntimeContextSegment): ContextSegment;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `applyAgentDefinitionTransforms`

```ts
export declare function applyAgentDefinitionTransforms(definition: AgentDefinition, transforms: readonly AgentDefinitionTransform[]): AgentDefinition;
```

Declared in `packages/agent/dist/definition.d.ts`.

### `artifact`

```ts
export declare function artifact(options?: {
    strategy?: ArtifactDefinition["strategy"];
    maxInlineTokens?: number;
    recovery?: ArtifactDefinition["recovery"];
}): ArtifactDefinition;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `assertProfiledBuildTarget`

Validate that an existing target-specific build still matches exact adapter identity.

```ts
export declare function assertProfiledBuildTarget(value: CaveBuildLockV3, target: CompilerTarget): CaveBuildLockV3;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `assertQualityGrader`

Runtime gate shared by fixture construction and compiler admission.

```ts
export declare function assertQualityGrader(grader: unknown): asserts grader is QualityGrader;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `auto`

```ts
export declare function auto(): Auto;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `capabilityManifestFor`

```ts
export declare function capabilityManifestFor(target: CompilerTarget, required: readonly CompilerSemantic[]): CompilerCapabilityManifest;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `captureModelBoundary`

Capture an optional boundary once at an adapter trust boundary.

Only own data properties are accepted, so inherited methods and accessors
never execute. The boundary and prepared-call receivers are preserved while
terminal observation stays best-effort and exactly-once.

```ts
export declare function captureModelBoundary<Request, Response>(value: ModelBoundary<Request, Response> | undefined): CapturedModelBoundary<Request, Response> | undefined;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `compareConnectEfficiency`

Fail-closed local comparison. Token reduction alone never passes: connected
run must preserve task success/quality, use complete data, and lower total
measured cost after retrieval, retries, and collection.

```ts
export declare function compareConnectEfficiency(baseline: ConnectEfficiencyRun, connected: ConnectEfficiencyRun, options?: {
    readonly maxQualityRegression?: number;
}): ConnectEfficiencyComparison;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `compileProfiled`

Generic profiled compiler. Caller-owned runners are useful for adapters, but
cannot prove behavioral lowering; this lane deliberately emits baseline-only
locks.

```ts
export declare function compileProfiled(input: CompileProfiledInput): Promise<CompileProfiledResult>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `compileProfiledNativePi`

Native Pi lane. Compiler owns candidate shape plus both runAgentInternal
validation runners; callers cannot inject alternate behavioral plans.

```ts
export declare function compileProfiledNativePi(input: CompileProfiledNativePiInput): Promise<CompileProfiledResult>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `completionMemorySidecar`

Turns any small structured-output model into memory sidecar. Parser accepts
strict JSON only; unknown ids, fields, kinds, or oversized output fail closed.

```ts
export declare function completionMemorySidecar(options: CompletionMemorySidecarOptions): MemorySidecarAdapter;
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `composeAgentDir`

The shared lowering: validated modules in, one `agent()` call out.

Both `loadAgentDir` (dynamic directory scan) and the generated
`.caveman/agent-dir-entry.mjs` (static imports, so the sandbox source graph
is complete and the tool worker recomposes the identical definition) call
this same function.

```ts
export declare function composeAgentDir(input: AgentDirModules): AgentDefinition;
```

Declared in `packages/agent/dist/dir-loader.d.ts`.

### `connectEnvironment`

```ts
export declare function connectEnvironment(source?: NodeJS.ProcessEnv): Record<string, string>;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `context`

```ts
export declare function context(options: {
    id: string;
    kind: ContextKind;
    source: string | FileSource;
    stability: ContextStability;
    safety?: SafetyClass;
    priority?: ContextPriority;
    recovery?: RecoveryKind;
    cacheRegion?: CacheRegion;
    privacy?: PrivacyClass;
    opaque?: boolean;
    ttlTurns?: number;
}): ContextDefinition;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `contextBill`

```ts
export declare function contextBill(ir: ContextIR): Record<string, number>;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `contextIRFromWire`

```ts
export declare function contextIRFromWire(value: unknown): ContextIR;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `contextIRToWire`

```ts
export declare function contextIRToWire(ir: ContextIR): ContextIRWire;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `contextSummarySources`

Build the digest-addressed manifest for messages a rewrite may remove.

```ts
export declare function contextSummarySources(messages: readonly AgentMessage[], indexes: readonly number[]): readonly ContextSummarySource[];
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `cosine`

```ts
export declare function cosine(first: MemoryVector, second: MemoryVector): number;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `createBudgetController`

```ts
export declare function createBudgetController(): BudgetController;
```

Declared in `packages/agent/dist/budget.d.ts`.

### `createCompilerWorkloadProfile`

Build compiler input before development selection and holdout execution.
Only profile observations exist at this point by design. Development and
holdout stay empty until their eval runners execute, so compiler cannot
inspect either before plan freeze.

```ts
export declare function createCompilerWorkloadProfile(input: readonly NormalizedTrajectory[]): WorkloadProfile;
```

Declared in `packages/agent/dist/profile.d.ts`.

### `createConnect`

```ts
export declare function createConnect(options: ConnectOptions): ConnectIntegration;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `createConversation`

```ts
export declare function createConversation(): Conversation;
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `createFileMemoryAdapter`

Default dependency-free adapter. Scope chooses tenant/agent/namespace.

```ts
export declare function createFileMemoryAdapter(config?: Pick<MemoryStoreConfig, "root">): MemoryStorageAdapter;
```

Declared in `packages/agent/dist/memory-store.d.ts`.

### `createInMemoryMemoryStorage`

Useful for tests, server adapters, and fully ephemeral workflows.

```ts
export declare function createInMemoryMemoryStorage(): MemoryStorageAdapter;
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `createMemoryEngine`

```ts
export declare function createMemoryEngine(options: CreateMemoryEngineOptions): MemoryEngine;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `createMemoryWorkflow`

Minimal adapter for any agent workflow, independent of provider/framework.

```ts
export declare function createMemoryWorkflow(engine: MemoryEngine, sessionId: string): Readonly<{
    beforeTurn(text: string): string | undefined;
    afterTurn(text: string): void;
    search(query: string, options?: MemorySearchOptions): Promise<readonly MemoryHit[]>;
    remember(input: string | MemoryRememberInput, signal?: AbortSignal): Promise<MemoryRecord>;
    searchSessions(query: string, options?: Omit<MemorySearchOptions, "graphDepth">): Promise<readonly MemorySessionHit[]>;
    close(signal?: AbortSignal): Promise<void>;
}>;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `createModelBoundary`

```ts
export declare function createModelBoundary<Request, Response>(middleware: readonly ModelBoundaryMiddleware<Request, Response>[]): ModelBoundary<Request, Response>;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `createProgrammaticToolErrorWrapper`

```ts
export declare function createProgrammaticToolErrorWrapper<TInput, TResult>(source: ToolDefinition<TInput, TResult>, mapError: (error: unknown) => Error): ToolDefinition<TInput, TResult>;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `createProgrammaticToolRuntime`

```ts
export declare function createProgrammaticToolRuntime(directDefinition: AgentDefinition, options?: {
    readonly instructions?: string;
    readonly speculate?: boolean;
    readonly toolName?: string;
}): ProgrammaticToolRuntime;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `createSparseEmbeddingAdapter`

Dependency-free fallback. Sparse lexical vector, not claimed as semantic.

```ts
export declare function createSparseEmbeddingAdapter(dimensions?: number): MemoryEmbeddingAdapter;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `createWorkloadProfile`

Build a deterministic, content-blind workload profile. Input order has no
effect on any digest. A workload case may occur in exactly one split.

```ts
export declare function createWorkloadProfile(input: readonly NormalizedTrajectory[]): WorkloadProfile;
```

Declared in `packages/agent/dist/profile.d.ts`.

### `decideToolCall`

Evaluate a policy for one call. Returns the block result for a denial,
`undefined` to admit. Throws `cave_tool_policy_failed` when the policy
throws or hangs past {@link TOOL_POLICY_TIMEOUT_MS},
`cave_tool_policy_decision_invalid` for a malformed decision, and
`cave_tool_policy_reason_invalid` for a deny code outside `[a-z][a-z0-9_]*`.
Every throw is run-fatal to the caller: unknown authorization never executes.

```ts
export declare function decideToolCall(policy: ToolCallPolicy, input: ToolCallPolicyInput): Promise<ToolCallDenial | undefined>;
```

Declared in `packages/agent/dist/tool-policy.d.ts`.

### `defineAgentInputEncoder`

```ts
export declare function defineAgentInputEncoder<Output>(encoder: AgentInputEncoder<Output>): AgentInputEncoder<Output>;
```

Declared in `packages/agent/dist/input.d.ts`.

### `defineModelUsage`

Validate, detach, and freeze one model-call usage record.

```ts
export declare function defineModelUsage(value: unknown): ModelUsage;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `defineRunReceipt`

Validate one complete receipt, detach every nested value, and deeply freeze
the result. This is the sole public receipt parser; it accepts both JSON wire
objects (optional `undefined` fields absent) and SDK in-memory receipts.

```ts
export declare function defineRunReceipt(value: unknown): RunReceipt;
```

Declared in `packages/agent/dist/run-receipt.d.ts`.

### `durableInputIsReplayable`

True when a journaled `input` is the literal input and can therefore drive
an unattended resume. False for the multimodal digest form, which needs the
original input supplied by the caller.

```ts
export declare function durableInputIsReplayable(input: string): boolean;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `durableRunSummary`

```ts
export declare function durableRunSummary(lines: readonly string[]): DurableRunSummary;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `egressAllowed`

Does `host:port` satisfy `policy`? The only decision point; the proxy calls
exactly this and nothing else, so there is one place to audit.

```ts
export declare function egressAllowed(policy: ResolvedEgressPolicy, host: string, port: number): boolean;
```

Declared in `packages/agent/dist/sandbox/policy.d.ts`.

### `emptyMemoryState`

```ts
export declare function emptyMemoryState(): MemoryState;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `encodeAgentInput`

Normalizes once, preflights every part, then invokes one selected encoder.

```ts
export declare function encodeAgentInput<Output>(input: AgentInput, selectedEncoder: AgentInputEncoder<Output>, signal?: AbortSignal): Promise<Output>;
```

Declared in `packages/agent/dist/input.d.ts`.

### `eval`

```ts
export declare function evalFixture(options: {
    id: string;
    lineageId?: string;
    split?: EvalSplit;
    input: unknown;
    tools?: {
        mode: "fixture" | "live";
        sandbox?: string;
    };
    quality: QualityGrader[];
    guardrails?: EvalGuardrail[];
}): EvalDefinition;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `evalFixture`

```ts
export declare function evalFixture(options: {
    id: string;
    lineageId?: string;
    split?: EvalSplit;
    input: unknown;
    tools?: {
        mode: "fixture" | "live";
        sandbox?: string;
    };
    quality: QualityGrader[];
    guardrails?: EvalGuardrail[];
}): EvalDefinition;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `evaluateContextSummary`

Exact-match evaluator. Paraphrase is drift for paths, commands, and contracts.

```ts
export declare function evaluateContextSummary(summary: ContextSummary, input: ContextSummaryEvaluationInput): ContextSummaryEvaluation;
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `evaluateContextSummaryStability`

Validate a repeated-compaction series, including generation and anchor drift.

```ts
export declare function evaluateContextSummaryStability(rounds: readonly ContextSummaryRound[]): ContextSummaryStability;
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `executeCompiledPipeline`

Execute a locked target build. v0.2 aborts every adapter failure.

```ts
export declare function executeCompiledPipeline(input: ExecuteCompiledPipelineInput): Promise<CompiledPipelineResult>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `executeConnectTool`

Kernel-owned execution for `ConnectToolRuntimeDefinition`; never runs arbitrary host closure.

```ts
export declare function executeConnectTool(runtime: ConnectToolRuntimeDefinition, params: unknown, signal?: AbortSignal): Promise<unknown>;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `file`

```ts
export declare function file(path: string): FileSource;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `httpExecutionBackend`

```ts
export declare function httpExecutionBackend(opts: {
    url: string;
    token: string;
    fetch?: typeof fetch;
}): ExecutionBackend;
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `latestContextSummary`

Recover the newest trusted capsule from model-visible conversation history.

```ts
export declare function latestContextSummary(messages: readonly AgentMessage[]): ContextSummary | undefined;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `loadAgentDir`

Load an agent directory into an `AgentDefinition`.

The agent id is the directory basename slugified; `options.id` pins it and
is used by the generated entry so a staged copy (whose temp directory has a
different basename) recomposes the identical definition. When `options.id`
is absent — the ordinary public call — the generated module entry is
(re)written at `.caveman/agent-dir-entry.mjs` so sandboxed runs can stage a
complete source graph from static imports.

```ts
export declare function loadAgentDir(rootDir: string, options?: {
    id?: string;
}): Promise<AgentDefinition>;
```

Declared in `packages/agent/dist/dir-loader.d.ts`.

### `localExecutionBackend`

```ts
export declare function localExecutionBackend(): ExecutionBackend;
```

Declared in `packages/agent/dist/execution-backend.d.ts`.

### `lowerContext`

```ts
export declare function lowerContext(options: {
    rootDir?: string;
    instructions: string | FileSource;
    tools: readonly ToolDefinition[];
    contexts?: readonly ContextDefinition[];
    memory?: {
        namespace: string;
        recallBudget: number;
    };
    output?: {
        maxTokens: number;
        schema?: TSchema;
    };
    runtimeSegments?: readonly RuntimeContextSegment[];
    input?: unknown;
    /** Provider-visible bytes when input is represented by bounded metadata. */
    inputProviderVisibleBytes?: number;
    /** Marks projected input as non-transformable opaque content. */
    inputOpaque?: boolean;
}): Promise<LoweredContext>;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `memory`

```ts
export declare function memory(options: {
    namespace: string;
    provenance?: MemoryDefinition["provenance"];
    ttl?: string;
    recallBudget?: number;
    consent?: MemoryDefinition["consent"];
    ambient?: false | MemoryAmbientOptions;
}): MemoryDefinition;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `memoryTTLMilliseconds`

```ts
export declare function memoryTTLMilliseconds(value: string): number;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `modelUsageAccountingStatus`

```ts
export declare function modelUsageAccountingStatus(value: ModelUsage): ModelUsageAccountingStatus;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `nativePiCompilerTarget`

```ts
export declare function nativePiCompilerTarget(): CompilerTarget;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `normalizeAgentInput`

```ts
export declare function normalizeAgentInput(input: AgentInput): NormalizedAgentInput;
```

Declared in `packages/agent/dist/input.d.ts`.

### `normalizeCompaction`

```ts
export declare function normalizeCompaction(options?: CompactionOptions): NormalizedCompaction;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `normalizeTrajectory`

Project a Caveman result or a content-blind OTel/OpenInference span into the
compiler's normalized trajectory IR. Prompt, message, result and output
bodies are never copied into the returned object or its digest.

```ts
export declare function normalizeTrajectory(value: unknown, options: NormalizeTrajectoryOptions): NormalizedTrajectory;
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

### `opaquePayload`

```ts
export declare function opaquePayload(input: Uint8Array): boolean;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `openAICompatibleMemoryEmbedding`

Lazy, fetch-only embedding adapter. Adds no provider SDK dependency.

```ts
export declare function openAICompatibleMemoryEmbedding(options: OpenAICompatibleMemoryEmbeddingOptions): MemoryEmbeddingAdapter;
```

Declared in `packages/agent/dist/memory-adapters.d.ts`.

### `output`

```ts
export declare function output<T extends TSchema | undefined = undefined>(options: {
    maxTokens: number;
    schema?: T;
}): OutputDefinition<T>;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `packVector`

```ts
export declare function packVector(adapter: string, input: readonly number[]): MemoryVector;
```

Declared in `packages/agent/dist/memory.d.ts`.

### `parseContextSummary`

Parse and validate a summarizer response. Fails closed: an unparseable or
structurally wrong summary is discarded and the caller falls through to the
clamp rung. A malformed summary is never accepted.

```ts
export declare function parseContextSummary(text: string): ContextSummary | undefined;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `parseNormalizedTrajectory`

Strictly parse already-normalized, content-blind trajectory data.

```ts
export declare function parseNormalizedTrajectory(value: unknown): NormalizedTrajectory;
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

### `parseWorkloadProfile`

Strict parser: unknown fields, altered summaries, and altered digests fail.

```ts
export declare function parseWorkloadProfile(value: unknown): WorkloadProfile;
```

Declared in `packages/agent/dist/profile.d.ts`.

### `planNativePiCandidates`

Pure, compiler-owned finite candidate frontier for exact native Pi.

```ts
export declare function planNativePiCandidates(input: NativePiCandidatePlanningInput): CandidatePlan[];
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `programmaticToolInstructions`

```ts
export declare function programmaticToolInstructions(additional: string | undefined, options?: ProgrammaticToolInstructionOptions): string;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `programmaticToolMetadata`

Internal runtime hook. Metadata identity cannot be forged through JSON.

```ts
export declare function programmaticToolMetadata(definition: ToolDefinition): ProgrammaticMetadata | undefined;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `renderReceipt`

```ts
export declare function renderReceipt(receipt: ReceiptLike): string;
```

Declared in `packages/agent/dist/receipt-print.d.ts`.

### `renderSummary`

Render a validated summary back to the wire shape used in a follow-up request.

```ts
export declare function renderSummary(summary: ContextSummary): Record<string, unknown>;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `requireCompleteModelUsage`

Fail closed where token accounting requires every disjoint component.

```ts
export declare function requireCompleteModelUsage(value: ModelUsage): CompleteModelUsage;
```

Declared in `packages/agent/dist/model-usage.d.ts`.

### `resolveConnectBinary`

```ts
export declare function resolveConnectBinary(options?: Pick<ConnectRuntimeOptions, "binary" | "environment">): Promise<string>;
```

Declared in `packages/agent/dist/connect.d.ts`.

### `resolveEgressPolicy`

Normalize and validate a policy. Throws rather than silently narrowing: a
policy the caller cannot parse is a policy the caller cannot reason about.

```ts
export declare function resolveEgressPolicy(policy: SandboxEgressPolicy): ResolvedEgressPolicy;
```

Declared in `packages/agent/dist/sandbox/policy.d.ts`.

### `routine`

Wrap a witnessed-deterministic tool in generated code, with the guard and
deopt that make the substitution safe.

The returned tool keeps `original`'s name, description, and input schema, so
the model sees no change and the framework treats it as an ordinary tool —
the same sandbox, breaker, budget, and receipt rules apply unchanged.

On each call: the input is checked against the original tool's schema, then
the optional `guard` runs. Only when both admit does `impl` run. A schema
failure, a guard rejection, a throwing guard, or a throwing `impl` **deopts**:
the original tool runs unchanged and its result is returned. No error from
`impl` escapes the fallback. The guard is load-bearing, not decoration —
loosening it is how a compiled step starts silently returning wrong answers.

Outcomes are recorded as `routine_hit`, `routine_deopt_guard`, or
`routine_deopt_error` (see {@link routineOutcomes}). Hits and deopts feed
`observed` before/after measurement only. This helper mints nothing: no
receipt line, no metering change, no cost math, no savings claim of any
basis.

Declared TypeBox output contracts remain attached. Both optimized and deopt
results cross the same canonical tool-output validator before exposure.

Refused at construction: a framework-reserved `cave_` tool name; a subagent
tool (its execute is framework-run, so a deopt could not reach the original —
fail closed rather than ship a routine that cannot deopt); a tool whose input
is a Standard Schema (v1 can only re-check the converted draft-07 JSON
Schema, which loses the vendor's refinements and transforms — JSON-schema
tools only, Standard Schema support is a follow-up); another routine (the
inner one would double-count its own outcomes); and an `async` guard (a guard
must answer synchronously — a thenable is truthy, so an async guard would
admit everything).

```ts
export declare function routine<TInput, TResult>(original: ToolDefinition<TInput, TResult>, impl: (input: TInput, signal?: AbortSignal) => TResult | Promise<TResult>, opts?: {
    guard?: (input: TInput) => boolean;
}): ToolDefinition<TInput, TResult>;
```

Declared in `packages/agent/dist/routine.d.ts`.

### `routineOutcomes`

Routine hit/deopt counts observed **in this process**, in first-seen order.

Scope is deliberate and honest: under the default `sandbox: "required"` a
tool closure runs in its own short-lived worker process, so the counts a
routine records there are not visible to the host and this list stays empty
for those runs. Empty means "not observed here", never "no deopts happened".
Carrying them across the worker boundary needs a tool-result protocol change
plus a closed-vocabulary extension on the Cloud side (`caveman.tool_events`
`outcome` is pinned to `ok`/`error`/`unknown` and is assigned by the gateway,
not accepted from a client), so it is a tracked follow-up rather than a
marker smuggled through a free-form field.

```ts
export declare function routineOutcomes(): readonly RoutineOutcomeCount[];
```

Declared in `packages/agent/dist/routine.d.ts`.

### `run`

```ts
export declare function run<D extends AgentDefinition>(definition: D, input: AgentInput, options?: RunOptions): Promise<RunResult<AgentOutput<D>>>;
```

Declared in `packages/agent/dist/index.d.ts`.

### `runContextCompactionHarness`

Run repeated, generational compaction against any injected summarizer.
Provider credentials and transport remain adapter-owned and explicit.

```ts
export declare function runContextCompactionHarness(fixture: ContextCompactionFixture, summarize: ContextCompactionSummarizer, options?: ContextCompactionHarnessOptions): Promise<ContextCompactionHarnessResult>;
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `runLocked`

Execute a validated Pi Cave Build from an embedded application.

```ts
export declare function runLocked<D extends AgentDefinition>(definition: D, input: AgentInput, build: import("./build.js").AnyCaveBuildLock, options?: RunOptions): Promise<RunResult<AgentOutput<D>>>;
```

Declared in `packages/agent/dist/index.d.ts`.

### `sha256`

```ts
export declare function sha256(value: Uint8Array | string): string;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `shellTools`

Build the workspace shell/file tools for any agent definition.

`read_tool_output` is what makes a capped result recoverable: select it and
over-long output is stored behind an opaque handle, leave it out and a capped
result says so and stops there.

```ts
export declare function shellTools(options: ShellToolsOptions): ToolDefinition[];
```

Declared in `packages/agent/dist/shell-tools.d.ts`.

### `stableStringify`

```ts
export declare function stableStringify(value: unknown): string;
```

Declared in `packages/agent/dist/context-ir.d.ts`.

### `stream`

```ts
export declare function stream(definition: AgentDefinition, input: AgentInput, options?: RunOptions): AsyncGenerator<import("./runtime.js").CavemanRunEvent, any, any>;
```

Declared in `packages/agent/dist/index.d.ts`.

### `subagent`

```ts
export declare function subagent(options: {
    name: string;
    description: string;
    agent: AgentDefinition;
    timeoutMs?: number;
    maxInputChars?: number;
    maxCalls?: number;
    /**
     * This child's wallet in USD. Under a USD-metered run the wallet is carved
     * out of the parent's **remaining** budget when the child is spawned, and its
     * unspent remainder returns to the parent when the child finishes.
     */
    maxCostUsd?: number;
    /**
     * This child's wallet in tokens — the denomination sibling of `maxCostUsd`,
     * used by a token-metered run. A token-metered run cannot fund a subagent
     * that declares no token wallet.
     */
    maxTokens?: number;
    maxContextTokens?: number;
}): ToolDefinition;
```

Declared in `packages/agent/dist/index.d.ts`.

### `summarizationInstruction`

The instruction appended as the final user message of the summarization request.

```ts
export declare function summarizationInstruction(previous: ContextSummary | undefined, sources?: readonly ContextSummarySource[]): string;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `tool`

```ts
export declare function tool<TInput extends TSchema, TOutput extends TSchema>(options: TypeBoxOutputToolOptions<TInput, TOutput>): ToolDefinition<Static<TInput>, Static<TOutput>>;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `validateContextSummaryTransition`

Validate one capsule transition against its source manifest. This check is
deterministic and model-independent. A caller commits only when `ok`.

```ts
export declare function validateContextSummaryTransition(summary: ContextSummary, previous: ContextSummary | undefined, sources: readonly ContextSummarySource[]): ContextSummaryValidation;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `verifySandboxConformance`

```ts
export declare function verifySandboxConformance(): Promise<boolean>;
```

Declared in `packages/agent/dist/runtime.d.ts`.

### `workloadSplitSHA256`

```ts
export declare function workloadSplitSHA256(profile: WorkloadProfile, split: WorkloadSplit): string;
```

Declared in `packages/agent/dist/profile.d.ts`.

## Variables & constants

### `AGENT_DIR_ENTRY`

Where `loadAgentDir` writes the generated module entry, relative to the directory.

```ts
export declare const AGENT_DIR_ENTRY = ".caveman/agent-dir-entry.mjs";
```

Declared in `packages/agent/dist/dir-loader.d.ts`.

### `AGENT_INPUT_MAX_BASE64_BYTES_PER_PART`

```ts
export declare const AGENT_INPUT_MAX_BASE64_BYTES_PER_PART: number;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_BASE64_BYTES_TOTAL`

```ts
export declare const AGENT_INPUT_MAX_BASE64_BYTES_TOTAL: number;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_FILE_NAME_LENGTH`

```ts
export declare const AGENT_INPUT_MAX_FILE_NAME_LENGTH = 255;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_MIME_LENGTH`

```ts
export declare const AGENT_INPUT_MAX_MIME_LENGTH = 127;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_PARTS`

```ts
export declare const AGENT_INPUT_MAX_PARTS = 64;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_TEXT_BYTES`

```ts
export declare const AGENT_INPUT_MAX_TEXT_BYTES: number;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_INPUT_MAX_URL_LENGTH`

```ts
export declare const AGENT_INPUT_MAX_URL_LENGTH = 8192;
```

Declared in `packages/agent/dist/input.d.ts`.

### `AGENT_RUN_RECEIPT_SCHEMA`

Versioned cross-package wire identity for an SDK economic receipt.

```ts
export declare const AGENT_RUN_RECEIPT_SCHEMA: "caveman.agent.run-receipt.v1";
```

Declared in `packages/agent/dist/run-receipt.d.ts`.

### `AUTO`

Marks a definition whose input is a Standard Schema, so a wrapper that can
only re-check the converted draft-07 JSON Schema (see `routine()`) can refuse
rather than silently drop the vendor's refinements and transforms.

```ts
export declare const AUTO: unique symbol;
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH`

```ts
export declare const MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH = 512;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `MODEL_BOUNDARY_MAX_ID_LENGTH`

```ts
export declare const MODEL_BOUNDARY_MAX_ID_LENGTH = 64;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `MODEL_BOUNDARY_MAX_MIDDLEWARE`

```ts
export declare const MODEL_BOUNDARY_MAX_MIDDLEWARE = 64;
```

Declared in `packages/agent/dist/model-boundary.d.ts`.

### `OUTPUT_CLAMP_FLOOR_TOKENS`

Smallest output allowance the clamp will hand a provider call. Below it a
clamped call buys a truncated fragment rather than progress, so the runtime
enters the exhaustion ladder instead of spending on one.

```ts
export declare const OUTPUT_CLAMP_FLOOR_TOKENS = 256;
```

Declared in `packages/agent/dist/budget.d.ts`.

### `PROFILED_COMPILER_SHA256`

```ts
export declare const PROFILED_COMPILER_SHA256: string;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `PROFILED_COMPILER_VERSION`

```ts
export declare const PROFILED_COMPILER_VERSION: "0.2.0";
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `PROGRAMMATIC_TOOL_NAME`

Provider-visible tool replacing an agent's ordinary tool surface in programmatic mode.

```ts
export declare const PROGRAMMATIC_TOOL_NAME = "caveman_code";
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `schema`

```ts
export declare const schema: {
    any: () => Type.TAny;
    array: <T extends TSchema>(items: T) => Type.TArray<T>;
    boolean: () => Type.TBoolean;
    integer: () => Type.TInteger;
    literal: <T extends string | number | boolean>(value: T) => Type.TLiteral<T>;
    null: () => Type.TNull;
    number: () => Type.TNumber;
    object: <T extends Record<string, TSchema>>(properties: T) => Type.TObject<T>;
    optional: <T extends TSchema>(value: T) => "~optional" extends keyof T ? T : Type.TOptional<T>;
    string: () => Type.TString;
    union: <T extends TSchema[]>(values: [...T]) => Type.TUnion<T>;
};
```

Declared in `packages/agent/dist/primitives.d.ts`.

### `SUMMARY_SCHEMA_VERSION`

Version of the summary contract the summarizer is asked to emit.

```ts
export declare const SUMMARY_SCHEMA_VERSION = 2;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `TARGET_CAPABILITY_LATTICE`

Generic targets stay baseline-only; exact native Pi has a separate owned lane.

```ts
export declare const TARGET_CAPABILITY_LATTICE: Readonly<Record<BuildHarnessID, readonly CompilerSemantic[]>>;
```

Declared in `packages/agent/dist/compiler.d.ts`.

### `TOOL_POLICY_TIMEOUT_MS`

A policy that cannot answer is an unknown authorization state: fail closed.

```ts
export declare const TOOL_POLICY_TIMEOUT_MS = 10000;
```

Declared in `packages/agent/dist/tool-policy.d.ts`.

### `TRAJECTORY_IR_SCHEMA_VERSION`

```ts
export declare const TRAJECTORY_IR_SCHEMA_VERSION: 1;
```

Declared in `packages/agent/dist/trajectory-ir.d.ts`.

### `validateRunReceipt`

Alias: validation and definition share one strict parser, never two rulesets.

```ts
export declare const validateRunReceipt: typeof defineRunReceipt;
```

Declared in `packages/agent/dist/run-receipt.d.ts`.

### `WORKLOAD_PROFILE_SCHEMA_VERSION`

```ts
export declare const WORKLOAD_PROFILE_SCHEMA_VERSION: 1;
```

Declared in `packages/agent/dist/profile.d.ts`.

