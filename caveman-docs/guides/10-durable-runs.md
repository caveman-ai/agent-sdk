# Durable runs

Opt-in crash-recoverable execution. The journal is the state; the process is
replaceable.

```ts
const result = await run(definition, "Analyze case 42", {
  durable: { runId: "case-42-analysis-1" },
  budget: { maxTokens: 120_000 },
});
```

## `runId` is the idempotency key

The caller assigns it. The same `runId` always refers to the same logical run.

| Resubmitting the same `runId` | What happens |
| --- | --- |
| Run finished | The journaled result is returned. Nothing is spent |
| Run failed terminally | The same error is returned. Nothing is spent |
| Run was interrupted (crash or abort) | It resumes from its last journaled boundary |
| Run is in flight elsewhere | The per-run lock refuses a second driver (`cave_durable_run_locked`) |

Format: `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — filename-safe. Invalid ids fail with
`cave_durable_run_id_invalid`.

## What is journaled, and when

The ledger is event-sourced and fine-grained:

- `call_started` — **fsynced before every provider call** (root, subagents
  through the inherited execution-context journal, and compaction summarizers).
- `call_settled` — after the call returns.
- Conversation state — checkpointed per turn, so the turn is durable before the
  next call.

Resume preloads the meter with journaled settlements, so settled money is never
re-reserved and never lost.

## The at-least-once ceiling

An intent with no settlement means the provider may have billed money this
ledger could not see. That surfaces as
`receipt.resume.possibleDoubleCountCalls` — never silently. Those calls appear
in **no other figure** on the receipt.

## How resume works

Resume rebuilds to the last boundary ending in a user or tool-result message and
re-enters through `pi.continue()`, so the prompt is never asked twice. A lost
partial turn is re-driven with its prior spend kept
(`resume.discardedPartialTurn`).

Pi's `state.messages` is append-only, so a compaction's replacement context
lives only in the loop's local view. A resume therefore rebuilds the
**uncompacted** transcript, and compaction counters are deliberately not
restored: the resumed run may pay — metered and journaled — to compact it again.
The budget is the real bound.

An abort is the deliberate twin of a crash and stays resumable.

When a re-driven turn calls tools, the provider mints fresh tool-call ids, so
the journal's replay is matched by position, tool name, effect, and argument
digest, never by the provider's id: a call the crashed attempt already settled
replays its journaled result without running again, and a re-driven turn that
asks for a different call fails closed with `cave_durable_tool_replay_mismatch`.
A `toolPolicy` is evaluated again on every resume, before replay: a policy
that now denies a call the crashed attempt already settled ends the resume
fail-closed with `cave_durable_tool_replay_incomplete` rather than skipping
the journaled result. Keep grants stable across a resume, or start a new run.

## Fail-closed identity

The journal must match the run being resumed:

| Refusal | Meaning |
| --- | --- |
| `cave_durable_definition_changed` | The definition digest drifted |
| `cave_durable_input_mismatch` | A different input under the same `runId` |
| `cave_durable_budget_changed` | The budget contract drifted |
| `cave_durable_conversation_mismatch` | Session identity drifted |
| `cave_durable_journal_corrupt` | Unreadable or unknown journal events |
| `cave_durable_journal_limit` | Journal exceeded its bound |
| `cave_durable_run_locked` | Another live process holds the per-run lock |
| `cave_durable_run_lock_lost` | This process held the lock and no longer does; every later append refuses rather than writing into a journal another driver now owns |
| `cave_durable_append_conflict` | The object store could not claim a free journal sequence; chunks are created, never overwritten |

Journal identity includes the **build and plan digests**, so one run id cannot
replay under another build.

## v1 scope gates

Each of these fails closed:

- No `conversation` — durable runs own their own state.
- No `maxCostUsd` — use `budget`.
- Root runs only.
- Breaker windows and `previousSummary` restart on resume.

Synthesized refusal, error, and aborted turns are never journaled as state, and
an error turn without a live reservation journals no settlement — a phantom zero
settle would hide a double count.

## Stores

```ts
export interface DurableStore {
  load(runId): Promise<readonly string[]>;
  append(runId, data: string): Promise<void>;
  acquire(runId): Promise<() => Promise<void>>;
  close(runId): Promise<void>;
  list?(): Promise<readonly string[]>;
}
```

| Store | Use when |
| --- | --- |
| `DiskDurableStore` (default) | The instance has a volume that survives restarts. Journals live under `<rootDir>/.caveman/runs/durable/<runId>/`, `0700`/`0600`, because they necessarily hold message content |
| `HttpDurableStore` | The instance does not — container platforms, autoscaled fleets |
| `SqlDurableStore` | You already have a database: Durable Object SQLite, better-sqlite3, Postgres |
| `ObjectDurableStore` | You already have a bucket: S3, R2, GCS, Azure Blob |
| Your own | Anything else |

`list()` is optional. A store that cannot enumerate is still a valid journal
store; it just cannot back crash recovery, and the recovery sweep reports
`listable: false` rather than pretending the store is empty.

Two deliberate refusals:

- An append is **never retried** — a duplicated settlement is silently wrong
  money, so the run fails and the resume re-drives instead.
- Losing the lock lease **poisons the store** for that run, because this process
  can no longer prove it is the only driver.

### `HttpDurableStore`

```ts
new HttpDurableStore({
  url: "https://journal.example",   // https required outside localhost
  token: journalToken,              // required; an unauthenticated journal is an open ledger
  fetchFn,                          // optional injectable transport
  lockTtlMs: 30_000,                // holder renews at a third of it
  requestTimeoutMs: 10_000,
});
```

The endpoint must implement six routes:

```text
GET    {base}/runs                  → {"runIds": [...]}
GET    {base}/runs/{id}/journal     → raw journal text (404 = none)
POST   {base}/runs/{id}/journal     → 204 once the bytes are DURABLE
POST   {base}/runs/{id}/lock        → {"token","expiresAt"} | 409 held
POST   {base}/runs/{id}/lock/renew  → 204 | 409 lease lost
DELETE {base}/runs/{id}/lock        → 204
```

`packages/agent/hosting/cloudflare/worker.ts` is a complete implementation
(Durable Object journal).

### `SqlDurableStore`

The whole database dependency is one method, so there is no driver-specific
code and no dependency to install:

```ts
import { SqlDurableStore } from "@caveman-ai/agent/durable";

// Cloudflare Durable Object SQLite (synchronous SqlStorage)
new SqlDurableStore({
  sql: { exec: (q, p) => [...this.ctx.storage.sql.exec(q, ...p)] },
  dialect: "sqlite",
});

// better-sqlite3
new SqlDurableStore({
  sql: { exec: (q, p) => db.prepare(q).all(...p) },
  dialect: "sqlite",
});

// node-postgres
new SqlDurableStore({
  sql: { exec: async (q, p) => (await pool.query(q, [...p])).rows },
  dialect: "postgres",
});
```

`dialect` picks the placeholder grammar (`?` for sqlite, `$1…$n` for postgres).
Run the DDL once yourself — this store never issues DDL, because a journal
store that can create tables can also drop them:

```ts
await migrate(SqlDurableStore.schema("postgres"));   // or ("sqlite"), or (dialect, table)
```

One row per journal line in `<table>` (default `caveman_durable_journal`), and
one lease row per in-flight run in `<table>_leases`. The lease carries an expiry
and is renewed at a third of its TTL; a renewal this process cannot complete
poisons the run's appends rather than risking two drivers.

### `ObjectDurableStore`

Object storage cannot append, so a journal is a sequence of immutable chunk
objects concatenated in key order. The adapter is three methods:

```ts
import { ObjectDurableStore } from "@caveman-ai/agent/durable";

new ObjectDurableStore({
  storage: {
    get: async (key) => (await bucket.get(key))?.bytes(),   // undefined when absent
    put: async (key, data, opts) => bucket.put(key, data, opts),
    list: async (prefix) => (await bucket.list({ prefix })).keys,
  },
  prefix: "caveman/durable/",
  conditionalPut: true,
});
```

`conditionalPut` is not optional and is not guessed. `acquire` needs a
**create-if-absent** put — `put(key, data, { ifMatch: "" })`, which is S3/R2
`If-None-Match: *`, GCS `ifGenerationMatch: 0`, Azure `If-None-Match: *` — and
an adapter that silently ignored `opts` would produce a lock that looks taken
and is not. Until you declare it, `acquire` fails closed with
`cave_durable_object_conditional_put_required`. The lease is taken by creating
the next generation of the lease key, so a takeover after an expiry is a create
and stays single-winner.

## Inspecting a journal

```ts
import { durableRunSummary, durableInputIsReplayable } from "@caveman-ai/agent";

const summary = durableRunSummary(await store.load(runId));
// { status: "missing" | "pending" | "completed" | "failed", … }
```

`durableRunSummary` is the read-only view: it answers "is this run finished, and
with what" for a status endpoint or a recovery sweep, and deliberately cannot
resume anything. Every resume goes through the internal journal analysis, which
fails closed on drifted definition, input, or budget.

`durableInputIsReplayable(input)` is false for the multimodal digest form: a
multimodal run journals a digest, not the content, so only a caller still
holding the original input can resume it.

Full API: [`@caveman-ai/agent/durable`](../reference/api/agent/durable.md).
