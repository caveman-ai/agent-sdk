# `@caveman-ai/agent/durable`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/durable.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `DiskDurableStore`, `DurableJournal`, `DurableToolCoordinator`, `HttpDurableStore`, `ObjectDurableStore`, `SqlDurableStore`
- **Interface**: `CallAbandonedEvent`, `CallSettledEvent`, `CallStartedEvent`, `CancelRequestedEvent`, `DurableConversationCheckpoint`, `DurableEncodedToolValue`, `DurablePriorTotals`, `DurableReplayTool`, `DurableResumeState`, `DurableRunOptions`, `DurableStore`, `DurableToolError`, `DurableToolInvocation`, `HttpDurableStoreOptions`, `JournaledCallUsage`, `MeterCallEvent`, `ObjectDurableStoreOptions`, `ObjectStorage`, `ResumedEvent`, `RunCompletedEvent`, `RunFailedEvent`, `RunStartedEvent`, `SleepScheduledEvent`, `SnapshotEvent`, `SqlDurableStoreOptions`, `SqlExecutor`, `ToolIntentEvent`, `ToolSettledEvent`, `TrancheEvent`, `TurnEvent`
- **Type alias**: `DurableCancelOutcome`, `DurableJournalEvent`, `DurableJournalState`, `DurableRunSummary`, `DurableSleepOutcome`, `DurableToolEffect`
- **Function**: `analyzeJournal`, `durableCancelRequest`, `durableConversationCheckpoint`, `durableConversationMessagesSHA256`, `durableInputIsReplayable`, `durableRunIsDue`, `durableRunSummary`, `durableToolArgsSHA256`, `durableToolIdempotencyKey`, `nextDurableWake`, `requestDurableCancel`, `scheduleDurableWake`, `settleCancelledRun`, `validateDurableRunId`, `validateReplayReceipt`, `validateReplayResult`
- **Variable**: `DURABLE_CANCELLED_CODE`, `DURABLE_JOURNAL_VERSION`, `MAX_DURABLE_SLEEP_MS`, `MULTIMODAL_DURABLE_INPUT_PREFIX`

</details>

## Classes

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

### `DurableJournal`

Serialized append pipeline over a {@link DurableStore}. `emit` queues
(stringifying immediately so an unserializable event fails at its source),
`flush` durably writes everything queued. Writes are chained: flush order
is emit order, and a flush resolves only when its own events are durable.

```ts
export declare class DurableJournal {
    readonly runId: string;
    private readonly store;
    private queue;
    private chain;
    private eventCount;
    private byteCount;
    private failed;
    constructor(store: DurableStore, runId: string, priorEvents?: readonly string[]);
    emit(event: DurableJournalEvent): void;
    flush(): Promise<void>;
    now(): string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableToolCoordinator`

```ts
export declare class DurableToolCoordinator {
    #private;
    constructor(journal: DurableJournal, replay?: readonly DurableReplayTool[]);
    /** Refuse ambiguity before another provider call can spend. */
    assertResumeSafe(): void;
    /** Every uncheckpointed prior call must reconcile in original intent order. */
    assertReconciled(): void;
    execute<T>(input: {
        readonly path: string;
        readonly toolCallId: string;
        readonly name: string;
        readonly effect: DurableToolEffect;
        readonly args: unknown;
    }, work: (invocation: DurableToolInvocation) => Promise<T>): Promise<T>;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

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

### `ObjectDurableStore`

```ts
export declare class ObjectDurableStore implements DurableStore {
    private readonly storage;
    private readonly prefix;
    private readonly conditionalPut;
    private readonly leaseTtlMs;
    /** Per run: next free chunk sequence and the journal's total bytes. */
    private readonly journal;
    private readonly leases;
    private readonly lost;
    constructor(options: ObjectDurableStoreOptions);
    private journalPrefix;
    private leasePrefix;
    load(runId: string): Promise<readonly string[]>;
    /**
     * Every chunk is created, never overwritten: the put is create-if-absent, and
     * a taken sequence means somebody else wrote there — the lock-free
     * `requestDurableCancel` is exactly that somebody — so the next free sequence
     * is re-derived and the write retried instead of silently replacing it.
     */
    append(runId: string, data: string): Promise<void>;
    /**
     * Highest written sequence and total journal bytes, once per run per process.
     *
     * ponytail: sizes come from reading the chunks, the same walk `load()` does,
     * because `ObjectStorage.list` returns keys only. A size-carrying listing
     * would make this one request instead of one per chunk.
     */
    private seedJournal;
    acquire(runId: string): Promise<() => Promise<void>>;
    private readLease;
    private putLease;
    /**
     * Is the generation this process created still the newest one under the lease
     * prefix? A takeover after an expiry creates a *higher* generation, so this is
     * the only question that can tell a stale holder it lost — reading its own key
     * back can only ever report itself.
     */
    private stillNewestGeneration;
    /** Losing the lease poisons the run rather than risking two drivers. */
    private markLost;
    /**
     * An append by a process that holds this run's lease must still be able to
     * prove it holds it. A store with no lease here is a deliberately lock-free
     * writer (`requestDurableCancel`) and is not asked to prove anything.
     */
    private assertStillHeld;
    /** Losing the lease poisons the run rather than risking two drivers. */
    private renew;
    close(runId: string): Promise<void>;
    list(): Promise<readonly string[]>;
}
```

Declared in `packages/agent/dist/durable-object-store.d.ts`.

### `SqlDurableStore`

```ts
export declare class SqlDurableStore implements DurableStore {
    private readonly sql;
    private readonly dialect;
    private readonly table;
    private readonly leaseTable;
    private readonly leaseTtlMs;
    private readonly leases;
    private readonly lost;
    constructor(options: SqlDurableStoreOptions);
    /** DDL for the two tables this store reads and writes. Run it once. */
    static schema(dialect: "sqlite" | "postgres", table?: string): string;
    /** `?` is the written grammar; postgres gets `$1…$n` on the way out. */
    private query;
    load(runId: string): Promise<readonly string[]>;
    /**
     * One row per journal line. A row is the atomic unit here, which is the SQL
     * equivalent of the disk store's torn-tail rule: a crash mid-append leaves
     * whole lines, never half of one.
     */
    append(runId: string, data: string): Promise<void>;
    /**
     * `SELECT COALESCE(MAX(seq), 0) + 1` inside the INSERT is only atomic on an
     * engine that serializes the statement. SQLite does; Postgres at READ
     * COMMITTED does not, and concurrent appends to one run collided on the
     * primary key (9 of 12 writers lost, against a real server). Losing an append
     * silently is not an option for a journal, so a collision is retried: the
     * PRIMARY KEY is the arbiter, and the loser re-reads MAX and tries the next
     * sequence. Retries are bounded, and exhausting them throws rather than
     * dropping the line.
     */
    private insertLine;
    /**
     * An append by a process that holds this run's lease must still be able to
     * prove it holds it, at append time rather than only on the renewal tick. A
     * store with no lease for this run is a deliberately lock-free writer
     * (`requestDurableCancel`) and is not asked to prove anything.
     */
    private assertStillHeld;
    acquire(runId: string): Promise<() => Promise<void>>;
    /** Losing the lease poisons the run rather than risking two drivers. */
    private renew;
    close(runId: string): Promise<void>;
    list(): Promise<readonly string[]>;
}
```

Declared in `packages/agent/dist/durable-sql-store.d.ts`.

## Interfaces

### `CallAbandonedEvent`

```ts
export interface CallAbandonedEvent extends JournalEventBase {
    type: "call_abandoned";
    path: string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `CallSettledEvent`

```ts
export interface CallSettledEvent extends JournalEventBase {
    type: "call_settled";
    path: string;
    kind: "model" | "compaction";
    call: JournaledCallUsage;
    /** Amount settled into the run's meter, in its denomination. Absent on unmetered runs. */
    settledAmount?: number;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `CallStartedEvent`

```ts
export interface CallStartedEvent extends JournalEventBase {
    type: "call_started";
    path: string;
    kind: "model" | "compaction";
    provider: string;
    model: string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `CancelRequestedEvent`

A cancellation REQUEST, not a cancellation. Appended by whoever wants the run
stopped — a `DELETE /runs/{id}`, an operator, another process — and observed
by whoever is driving it.

This is Temporal's cancel, not its terminate: the request is graceful and the
run still ends with a terminal event of its own, so spend already journaled
stays accounted and a compensating step still gets to run. Forcing a run to
stop without letting its driver settle is what killing the process already
does, and that path is a crash, which the journal already handles.

The event is idempotent by construction: a second request on a run that
already carries one changes nothing, so a retried DELETE is free.

```ts
export interface CancelRequestedEvent extends JournalEventBase {
    type: "cancel_requested";
    reason: string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableConversationCheckpoint`

Message-only checkpoint. Cache internals are intentionally recomputed.

```ts
export interface DurableConversationCheckpoint {
    readonly sessionId: string;
    readonly messagesSha256: string;
    readonly messages: readonly unknown[];
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableEncodedToolValue`

```ts
export interface DurableEncodedToolValue {
    readonly encoding: "json" | "undefined";
    readonly json?: string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurablePriorTotals`

```ts
export interface DurablePriorTotals {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    estimatedUsd: number;
    totalTokens: number;
    unpriced: boolean;
    anyUsageUnavailable: boolean;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableReplayTool`

```ts
export interface DurableReplayTool {
    readonly intent: ToolIntentEvent;
    readonly settlement?: ToolSettledEvent;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableResumeState`

```ts
export interface DurableResumeState {
    attempts: number;
    sessionId: string;
    input: string;
    /** True once journal contains a completed Pi turn including original input. */
    hasCompletedTurn: boolean;
    /** Base checkpoint only for caller-attached conversations. */
    conversation?: DurableConversationCheckpoint;
    /** Conversation reconstructed to the last resumable boundary. Empty = start fresh. */
    messages: unknown[];
    /** Trailing journaled messages discarded because their turn never completed. */
    discardedPartialTurn: boolean;
    priorRootModelCalls: number;
    priorRootCompactions: number;
    /** Exact root BudgetMeter reservation watermark, including retries and compactions. */
    priorRootMeterCalls: number;
    priorToolEvents: ReadonlyArray<{
        name: string;
        isError: boolean;
    }>;
    /** Uncheckpointed calls requiring exact replay or safe redrive. */
    replayTools: readonly DurableReplayTool[];
    priorSettled: number;
    priorTranches: ReadonlyArray<{
        amount: number;
        reason: string;
        atCall: number;
    }>;
    priorCalls: number;
    priorTotals: DurablePriorTotals;
    /**
     * Journaled provider-call intents that never settled or were abandoned.
     * Each is one call that may have been billed by the provider without this
     * ledger ever seeing its usage — the documented at-least-once ceiling.
     */
    possibleDoubleCountCalls: number;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

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

### `DurableToolError`

```ts
export interface DurableToolError {
    readonly name: string;
    readonly message: string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableToolInvocation`

Non-secret identity passed to an idempotent tool on every attempt.

```ts
export interface DurableToolInvocation {
    readonly idempotencyKey: string;
    readonly resumed: boolean;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

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

### `JournaledCallUsage`

Mirrors the receipt's per-call shape so prior spend can be summarized honestly.

```ts
export interface JournaledCallUsage {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    estimatedUsd: number;
    unpriced: boolean;
    usageBasis: "provider_reported" | "unavailable";
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `MeterCallEvent`

Absolute reservation counter for one budget meter path.

```ts
export interface MeterCallEvent extends JournalEventBase {
    type: "meter_call";
    path: string;
    atCall: number;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `ObjectDurableStoreOptions`

```ts
export interface ObjectDurableStoreOptions {
    readonly storage: ObjectStorage;
    /** Key namespace. Default `caveman/durable/`. */
    readonly prefix?: string;
    /** Declare that `storage.put` honors `ifMatch: ""` as create-if-absent. */
    readonly conditionalPut?: boolean;
    /** Lease length; the holder renews at a third of it. Default 30s. */
    readonly leaseTtlMs?: number;
}
```

Declared in `packages/agent/dist/durable-object-store.d.ts`.

### `ObjectStorage`

```ts
export interface ObjectStorage {
    get(key: string): Promise<Uint8Array | undefined>;
    /**
     * `opts.ifMatch === ""` must create the object only if the key is absent and
     * reject (throw) otherwise. Any other value is never passed by this store.
     */
    put(key: string, data: Uint8Array, opts?: {
        ifMatch?: string;
    }): Promise<void>;
    list(prefix: string): Promise<readonly string[]>;
}
```

Declared in `packages/agent/dist/durable-object-store.d.ts`.

### `ResumedEvent`

```ts
export interface ResumedEvent extends JournalEventBase {
    type: "resumed";
    attempt: number;
    unmatchedIntents: number;
    pid: number;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `RunCompletedEvent`

```ts
export interface RunCompletedEvent extends JournalEventBase {
    type: "run_completed";
    result: unknown;
    /** Final public conversation state, applied after terminal fsync or on replay. */
    conversation?: DurableConversationCheckpoint;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `RunFailedEvent`

```ts
export interface RunFailedEvent extends JournalEventBase {
    type: "run_failed";
    code: string;
    message: string;
    receipt: unknown;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `RunStartedEvent`

```ts
export interface RunStartedEvent extends JournalEventBase {
    type: "run_started";
    runId: string;
    agentId: string;
    definitionSha256: string;
    input: string;
    sessionId: string;
    denomination: "usd" | "tokens" | "none";
    budgetMax: number | undefined;
    /**
     * Digest of the FULL normalized budget (initial tranche, exhaustion mode,
     * output floor, compaction config — not just denomination and max), so a
     * resume under any different money contract fails closed.
     */
    budgetSha256: string;
    /** Present only when caller attached a public Conversation. */
    conversation?: DurableConversationCheckpoint;
    pid: number;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `SleepScheduledEvent`

A durable timer: this run is not eligible to be driven until `wakeAt`.

The point is economic, not functional. An agent waiting on a rate limit, a
retry window, or tomorrow morning's approval does not need a process — it
needs a date. Blocking a process for it means paying for wall-clock in which
nothing happens, which on every container platform is the single largest
avoidable cost in an agent workload. So a sleep is journaled and the driver
RETURNS: the instance is free, the container can scale to zero, and the run
is picked up again when it is due.

The wake time is absolute and last-write-wins, which is what makes this one
event instead of two. There is no `sleep_settled`: once `wakeAt` has passed
the sleep is over by definition, so a crash-resume cannot re-wait it, and a
second sleep is simply a later `wakeAt`.

```ts
export interface SleepScheduledEvent extends JournalEventBase {
    type: "sleep_scheduled";
    wakeAt: string;
    reason: string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `SnapshotEvent`

```ts
export interface SnapshotEvent extends JournalEventBase {
    type: "snapshot";
    messages: unknown[];
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `SqlDurableStoreOptions`

```ts
export interface SqlDurableStoreOptions {
    readonly sql: SqlExecutor;
    /** Placeholder grammar: `?` for sqlite, `$1…$n` for postgres. */
    readonly dialect: "sqlite" | "postgres";
    /** Journal table. The lease table is `<table>_leases`. */
    readonly table?: string;
    /** Lease length; the holder renews at a third of it. Default 30s. */
    readonly leaseTtlMs?: number;
}
```

Declared in `packages/agent/dist/durable-sql-store.d.ts`.

### `SqlExecutor`

One method, because that is all every SQL driver already agrees on.

```ts
export interface SqlExecutor {
    exec(sql: string, params: readonly unknown[]): Promise<ReadonlyArray<Record<string, unknown>>> | ReadonlyArray<Record<string, unknown>>;
}
```

Declared in `packages/agent/dist/durable-sql-store.d.ts`.

### `ToolIntentEvent`

```ts
export interface ToolIntentEvent extends JournalEventBase {
    type: "tool_intent";
    path: string;
    toolCallId: string;
    name: string;
    effect: DurableToolEffect;
    argsSha256: string;
    idempotencyKey: string;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `ToolSettledEvent`

```ts
export interface ToolSettledEvent extends JournalEventBase {
    type: "tool_settled";
    path: string;
    toolCallId: string;
    name: string;
    effect: DurableToolEffect;
    argsSha256: string;
    idempotencyKey: string;
    outcome: "returned" | "threw";
    value?: DurableEncodedToolValue;
    error?: DurableToolError;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `TrancheEvent`

```ts
export interface TrancheEvent extends JournalEventBase {
    type: "tranche";
    amount: number;
    reason: string;
    atCall: number;
}
```

Declared in `packages/agent/dist/durable.d.ts`.

### `TurnEvent`

```ts
export interface TurnEvent extends JournalEventBase {
    type: "turn";
    messages: unknown[];
}
```

Declared in `packages/agent/dist/durable.d.ts`.

## Type aliases

### `DurableCancelOutcome`

```ts
export type DurableCancelOutcome = {
    readonly status: "requested";
    readonly reason: string;
} | {
    readonly status: "already_requested";
    readonly reason: string;
} | {
    readonly status: "already_settled";
    readonly terminal: "completed" | "failed";
} | {
    readonly status: "missing";
};
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `DurableJournalEvent`

```ts
export type DurableJournalEvent = RunStartedEvent | ResumedEvent | MeterCallEvent | CallStartedEvent | CallSettledEvent | CallAbandonedEvent | ToolIntentEvent | ToolSettledEvent | TurnEvent | SnapshotEvent | TrancheEvent | CancelRequestedEvent | SleepScheduledEvent | RunCompletedEvent | RunFailedEvent;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `DurableJournalState`

```ts
export type DurableJournalState = {
    status: "fresh";
} | {
    status: "completed";
    result: unknown;
    conversation?: DurableConversationCheckpoint;
    baseConversation?: DurableConversationCheckpoint;
} | {
    status: "failed";
    code: string;
    message: string;
    receipt: unknown;
    baseConversation?: DurableConversationCheckpoint;
} | {
    status: "pending";
    resume: DurableResumeState;
};
```

Declared in `packages/agent/dist/durable.d.ts`.

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

### `DurableSleepOutcome`

```ts
export type DurableSleepOutcome = {
    readonly status: "scheduled";
    readonly wakeAt: string;
} | {
    readonly status: "already_settled";
    readonly terminal: "completed" | "failed";
} | {
    readonly status: "cancelled";
} | {
    readonly status: "missing";
};
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `DurableToolEffect`

```ts
export type DurableToolEffect = "read" | "write" | "idempotent" | "external";
```

Declared in `packages/agent/dist/durable.d.ts`.

## Functions

### `analyzeJournal`

```ts
export declare function analyzeJournal(lines: readonly string[], expected: {
    runId: string;
    /** Exact root agent identity when called by the runtime. */
    agentId?: string;
    definitionSha256: string;
    input: string;
    denomination: "usd" | "tokens" | "none";
    budgetMax: number | undefined;
    budgetInitial: number | undefined;
    budgetSha256: string;
    /** When supplied, caller requires this exact logical runtime session. */
    sessionId?: string;
    /** Presence and value bind a durable run to one public Conversation. */
    conversationSessionId?: string;
}): DurableJournalState;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `durableCancelRequest`

The outstanding cancellation request on a run, if it has one.

```ts
export declare function durableCancelRequest(store: DurableStore, runId: string): Promise<{
    readonly reason: string;
    readonly at: string;
} | undefined>;
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `durableConversationCheckpoint`

```ts
export declare function durableConversationCheckpoint(sessionId: string, messages: readonly unknown[]): DurableConversationCheckpoint;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `durableConversationMessagesSHA256`

```ts
export declare function durableConversationMessagesSHA256(messages: readonly unknown[]): string;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `durableInputIsReplayable`

True when a journaled `input` is the literal input and can therefore drive
an unattended resume. False for the multimodal digest form, which needs the
original input supplied by the caller.

```ts
export declare function durableInputIsReplayable(input: string): boolean;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `durableRunIsDue`

Is this run eligible to be driven right now? The one predicate a recovery
sweep needs, so "not due yet" is never confused with "stranded".

```ts
export declare function durableRunIsDue(summary: {
    readonly status: string;
    readonly wakeAt?: string;
}, now?: number): boolean;
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `durableRunSummary`

```ts
export declare function durableRunSummary(lines: readonly string[]): DurableRunSummary;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `durableToolArgsSHA256`

Canonical JSON identity for tool arguments. Content never enters intent records.

```ts
export declare function durableToolArgsSHA256(args: unknown): string;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `durableToolIdempotencyKey`

```ts
export declare function durableToolIdempotencyKey(input: {
    runId: string;
    path: string;
    toolCallId: string;
    name: string;
    argsSha256: string;
}): string;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `nextDurableWake`

Earliest time any run in `store` becomes due, or undefined when none is
sleeping. This is what lets a host scale to zero honestly: set one timer for
this instant, shut the instance down, and bring it back exactly when there is
work — instead of keeping a process alive to watch a clock.

An OVERDUE sleeper is reported too: a wake time in the past means "there is
work right now", not "nothing to wake for". A store that cannot enumerate
returns undefined, which a caller must likewise read as "unknown", never as
"nothing pending".

```ts
export declare function nextDurableWake(store: DurableStore): Promise<Date | undefined>;
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `requestDurableCancel`

Ask for `runId` to stop. Returns what was true, so a caller can answer a
DELETE honestly instead of pretending every request cancelled something.

A settled run is never marked cancelled: its outcome is already a fact, and
rewriting history to say otherwise would make the journal lie about money it
already spent.

```ts
export declare function requestDurableCancel(store: DurableStore, runId: string, reason?: string): Promise<DurableCancelOutcome>;
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `scheduleDurableWake`

Park `runId` until `wakeAt`. The run stays pending and is not eligible to be
driven before then.

This is the cost primitive. A blocked process is billed for wall-clock in
which nothing happens; a journaled wake time is billed for nothing at all,
and the platform is free to evict the instance and bring one back when the
run is due. Waiting a week costs the same as waiting a second.

A cancellation outranks a sleep: parking a run somebody already asked to stop
would turn a cancelled run into one that wakes up later to be cancelled.

```ts
export declare function scheduleDurableWake(store: DurableStore, runId: string, wakeAt: Date, reason?: string): Promise<DurableSleepOutcome>;
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `settleCancelledRun`

Settle a cancelled run that nobody is driving. Called by a recovery sweep
when it finds a pending journal carrying a cancellation request: the run is
closed out where it stopped, with no provider call and no spend, instead of
being resumed only to be cancelled again.

```ts
export declare function settleCancelledRun(store: DurableStore, runId: string, request: {
    readonly reason: string;
}): Promise<void>;
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `validateDurableRunId`

Filename-safe caller-assigned idempotency key.

```ts
export declare function validateDurableRunId(runId: string): void;
```

Declared in `packages/agent/dist/durable-limits.d.ts`.

### `validateReplayReceipt`

```ts
export declare function validateReplayReceipt(value: unknown, runId: string, agentId?: string): ReturnType<typeof validateRunReceipt>;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `validateReplayResult`

Minimal fail-closed shape check on a journaled terminal outcome before it
is replayed to a caller as a `RunResult`/`RunReceipt`. Not a full schema
pass — it pins the identity and every money-bearing field so a corrupted
or hostile store cannot mint arbitrary figures through the replay path.

```ts
export declare function validateReplayResult(value: unknown, runId: string, agentId?: string): ReturnType<typeof validateRunReceipt>;
```

Declared in `packages/agent/dist/durable.d.ts`.

## Variables & constants

### `DURABLE_CANCELLED_CODE`

Terminal failure code a cancelled run settles with. It is a `run_failed`
rather than a fourth terminal event type: consumers already branch on the
code, and a new terminal shape would silently mean "still pending" to every
reader that has not been taught about it.

```ts
export declare const DURABLE_CANCELLED_CODE = "cave_durable_run_cancelled";
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `DURABLE_JOURNAL_VERSION`

Journal schema version. Bump on any incompatible event-shape change.

```ts
export declare const DURABLE_JOURNAL_VERSION = 2;
```

Declared in `packages/agent/dist/durable.d.ts`.

### `MAX_DURABLE_SLEEP_MS`

The longest a run may sleep. Not a technical limit — a blast radius. A typo
that schedules a wake in the year 3000 should fail at the call site, not
become a journal that a recovery sweep politely skips forever.

```ts
export declare const MAX_DURABLE_SLEEP_MS: number;
```

Declared in `packages/agent/dist/durable-control.d.ts`.

### `MULTIMODAL_DURABLE_INPUT_PREFIX`

Journal-encoded stand-in for a non-string input. A multimodal run journals
the digest of its lowered context instead of the content, so its `input`
cannot be replayed from the journal alone — see
{@link durableInputIsReplayable}.

```ts
export declare const MULTIMODAL_DURABLE_INPUT_PREFIX = "\0cave.multimodal.v1:";
```

Declared in `packages/agent/dist/durable.d.ts`.

