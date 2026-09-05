/**
 * Opt-in durable execution: an append-only per-run journal plus crash resume.
 *
 * Design provenance (founder decision 2026-08-15, issue #218): no embeddable
 * durable-execution library exists for TypeScript with a zero-infra local
 * story, so this file is the substrate — deliberately thin, borrowing the
 * proven parts of the field instead of inventing new semantics:
 *
 * - DBOS: checkpoint-resume (re-drive the run, skip completed work) rather
 *   than event-history diffing; caller-assigned run ID as the idempotency
 *   key; a run without a terminal journal event is PENDING and resumable;
 *   the honest guarantee is at-least-once at the step boundary.
 * - Inngest: journal events carry named identity and nothing is durable
 *   until the store acknowledges the write.
 * - Temporal: version identity lives in the journal itself; a definition
 *   digest mismatch on resume fails closed, never silently diverges.
 *
 * The ledger is event-sourced fine-grained (`call_started` intent before a
 * provider call, `call_settled` after), so a resume preloads the meter with
 * every journaled settle: settled money is never re-reserved and never lost.
 * Conversation state checkpoints at turn boundaries; a partial turn is
 * discarded on resume while its journaled spend is kept. A `call_started`
 * with no matching `call_settled` is the honest provider-call uncertainty
 * window — the provider may or may not have billed it — and surfaces on the
 * receipt as `resume.possibleDoubleCountCalls`, never silently. Tool effects
 * use a stricter intent/settlement protocol: reads may re-drive, idempotent
 * calls re-drive with a stable key, and unmatched writes/externals fail closed.
 *
 * The journal necessarily contains message content (unlike receipts, which
 * are content-blind): resuming a conversation requires the conversation.
 * The disk store therefore writes 0o700 directories and 0o600 files, the
 * same posture as `memory-store.ts`.
 */

import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MAX_JOURNAL_BYTES,
  RUN_ID_PATTERN,
  isPlainRecord,
  utf8Bytes,
  validateDurableRunId,
} from "./durable-limits.js";
export { validateDurableRunId } from "./durable-limits.js";
import { validateRunReceipt } from "./run-receipt.js";
import { snapshotDataDictionary, snapshotDenseArray } from "./strict-data.js";

/** Journal schema version. Bump on any incompatible event-shape change. */
export const DURABLE_JOURNAL_VERSION = 2;

const TOOL_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_JOURNAL_EVENTS = 100_000;
const MAX_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_ARGUMENT_BYTES = 1024 * 1024;
const MAX_TOOL_CALL_ID_BYTES = 1024;
const MAX_TOOL_PATH_BYTES = 4096;
const MAX_SESSION_ID_BYTES = 1024;
const MAX_ERROR_BYTES = 4096;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 200_000;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

export type DurableToolEffect = "read" | "write" | "idempotent" | "external";

/** Non-secret identity passed to an idempotent tool on every attempt. */
export interface DurableToolInvocation {
  readonly idempotencyKey: string;
  readonly resumed: boolean;
}

/** Message-only checkpoint. Cache internals are intentionally recomputed. */
export interface DurableConversationCheckpoint {
  readonly sessionId: string;
  readonly messagesSha256: string;
  readonly messages: readonly unknown[];
}

/** Caller-facing durable options on RunOptions. */
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

/**
 * Storage contract for run journals. Lines are opaque JSON strings; the
 * store guarantees ordered, durable appends — `append` resolving means the
 * data survives a process crash (fsync or the store's strongest equivalent).
 */
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

// The stores live in `durable-stores.ts` (storage, not semantics) and are
// re-exported here so `@caveman-ai/agent/durable` stays their single import
// site — the same pattern `runtime.ts` uses for its split modules.
export { DiskDurableStore, HttpDurableStore, type HttpDurableStoreOptions } from "./durable-stores.js";
// The SQL and object-storage stores are the two shapes a deployment without a
// local volume actually has, and they follow the same rule: storage only.
export { SqlDurableStore, type SqlDurableStoreOptions, type SqlExecutor } from "./durable-sql-store.js";
export {
  ObjectDurableStore,
  type ObjectDurableStoreOptions,
  type ObjectStorage,
} from "./durable-object-store.js";
// Cancellation is journal-level control over a run, so it belongs on the same
// entrypoint as the journal it is written into.
export {
  DURABLE_CANCELLED_CODE,
  durableCancelRequest,
  requestDurableCancel,
  settleCancelledRun,
  type DurableCancelOutcome,
} from "./durable-control.js";
export {
  MAX_DURABLE_SLEEP_MS,
  durableRunIsDue,
  nextDurableWake,
  scheduleDurableWake,
  type DurableSleepOutcome,
} from "./durable-control.js";


type JsonSnapshot = {
  readonly value: unknown;
  readonly canonical: string;
};

type JsonWalkState = {
  nodes: number;
  readonly seen: Set<object>;
};


function jsonInvalid(code: string): () => never {
  return () => {
    throw new Error(code);
  };
}

function normalizeJson(
  value: unknown,
  state: JsonWalkState,
  depth: number,
): unknown {
  state.nodes++;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new Error("cave_durable_value_limit");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cave_durable_value_not_json");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "undefined") return undefined;
  if (typeof value !== "object") throw new Error("cave_durable_value_not_json");
  if (state.seen.has(value)) throw new Error("cave_durable_value_cycle");
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const source = snapshotDenseArray(
        value,
        MAX_JSON_NODES,
        jsonInvalid("cave_durable_value_not_plain_data"),
      );
      return source.map((entry) => normalizeJson(entry, state, depth + 1) ?? null);
    }
    const source = snapshotDataDictionary(
      value,
      MAX_JSON_NODES,
      jsonInvalid("cave_durable_value_not_plain_data"),
    );
    const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(source).sort()) {
      const normalized = normalizeJson(source[key], state, depth + 1);
      // Match JSON object semantics, but reject functions/symbols above rather
      // than silently erasing executable or opaque state.
      if (normalized !== undefined) target[key] = normalized;
    }
    return target;
  } finally {
    state.seen.delete(value);
  }
}

function snapshotJson(value: unknown, maximumBytes: number): JsonSnapshot {
  const normalized = normalizeJson(value, { nodes: 0, seen: new Set() }, 0);
  if (normalized === undefined) throw new Error("cave_durable_value_not_json");
  const canonical = JSON.stringify(normalized);
  if (utf8Bytes(canonical) > maximumBytes) throw new Error("cave_durable_value_limit");
  return { value: normalized, canonical };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function requireBoundedString(value: unknown, maxBytes: number, code: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > maxBytes) {
    throw new Error(code);
  }
  return value;
}

/** Canonical JSON identity for tool arguments. Content never enters intent records. */
export function durableToolArgsSHA256(args: unknown): string {
  return sha256(snapshotJson(args, MAX_ARGUMENT_BYTES).canonical);
}

export function durableToolIdempotencyKey(input: {
  runId: string;
  path: string;
  toolCallId: string;
  name: string;
  argsSha256: string;
}): string {
  validateDurableRunId(input.runId);
  if (!validToolPath(input.path)) throw new Error("cave_durable_tool_path_invalid");
  if (!validToolCallId(input.toolCallId)) {
    throw new Error("cave_durable_tool_call_id_invalid");
  }
  if (!TOOL_NAME_PATTERN.test(input.name) || !SHA256_PATTERN.test(input.argsSha256)) {
    throw new Error("cave_durable_tool_identity_invalid");
  }
  return `cave-${sha256(JSON.stringify([
    input.runId,
    input.path,
    input.toolCallId,
    input.name,
    input.argsSha256,
  ]))}`;
}

export function durableConversationCheckpoint(
  sessionId: string,
  messages: readonly unknown[],
): DurableConversationCheckpoint {
  requireBoundedString(sessionId, MAX_SESSION_ID_BYTES, "cave_durable_session_id_invalid");
  const snapshot = snapshotJson(messages, MAX_EVENT_BYTES / 2);
  if (!Array.isArray(snapshot.value)) throw new Error("cave_durable_conversation_invalid");
  return Object.freeze({
    sessionId,
    messagesSha256: sha256(snapshot.canonical),
    messages: Object.freeze(snapshot.value),
  });
}

export function durableConversationMessagesSHA256(messages: readonly unknown[]): string {
  const snapshot = snapshotJson(messages, MAX_EVENT_BYTES / 2);
  if (!Array.isArray(snapshot.value)) throw new Error("cave_durable_conversation_invalid");
  return sha256(snapshot.canonical);
}

function encodeToolValue(value: unknown): DurableEncodedToolValue {
  if (value === undefined) return Object.freeze({ encoding: "undefined" });
  const snapshot = snapshotJson(value, MAX_EVENT_BYTES / 2);
  return Object.freeze({ encoding: "json", json: snapshot.canonical });
}

function decodeToolValue(value: DurableEncodedToolValue): unknown {
  if (value.encoding === "undefined") return undefined;
  if (value.encoding !== "json" || typeof value.json !== "string" ||
      utf8Bytes(value.json) > MAX_EVENT_BYTES / 2) {
    throw new Error("cave_durable_journal_corrupt: malformed tool value");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.json);
  } catch {
    throw new Error("cave_durable_journal_corrupt: malformed tool value");
  }
  const snapshot = snapshotJson(parsed, MAX_EVENT_BYTES / 2);
  if (snapshot.canonical !== value.json) {
    throw new Error("cave_durable_journal_corrupt: non-canonical tool value");
  }
  return snapshot.value;
}

function boundedError(error: unknown): DurableToolError {
  const sourceName = error instanceof Error && error.name !== "" ? error.name : "Error";
  const sourceMessage = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    name: boundText(sourceName.split("\n", 1)[0]!, 256),
    message: boundText(sourceMessage.split("\n", 1)[0]!, MAX_ERROR_BYTES),
  });
}

function boundText(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  let output = "";
  for (const point of value) {
    if (utf8Bytes(output + point) > maxBytes) break;
    output += point;
  }
  return output;
}

// ---------------------------------------------------------------------------
// Journal events
// ---------------------------------------------------------------------------

/**
 * `path` is the agent path of the emitter: "" for the root run, a
 * "/"-joined tool path for subagents. Money events from every depth land in
 * the ROOT journal so a resume can restore the whole tree's spend into the
 * root meter — each real provider call settles exactly once in exactly one
 * event, so summing settles never double-counts.
 */
interface JournalEventBase {
  v: number;
  at: string;
  type: string;
}

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

export interface ResumedEvent extends JournalEventBase {
  type: "resumed";
  attempt: number;
  unmatchedIntents: number;
  pid: number;
}

export interface CallStartedEvent extends JournalEventBase {
  type: "call_started";
  path: string;
  kind: "model" | "compaction";
  provider: string;
  model: string;
}

/** Absolute reservation counter for one budget meter path. */
export interface MeterCallEvent extends JournalEventBase {
  type: "meter_call";
  path: string;
  atCall: number;
}

/** Mirrors the receipt's per-call shape so prior spend can be summarized honestly. */
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

export interface CallSettledEvent extends JournalEventBase {
  type: "call_settled";
  path: string;
  kind: "model" | "compaction";
  call: JournaledCallUsage;
  /** Amount settled into the run's meter, in its denomination. Absent on unmetered runs. */
  settledAmount?: number;
}

export interface CallAbandonedEvent extends JournalEventBase {
  type: "call_abandoned";
  path: string;
}

export interface ToolIntentEvent extends JournalEventBase {
  type: "tool_intent";
  path: string;
  toolCallId: string;
  name: string;
  effect: DurableToolEffect;
  argsSha256: string;
  idempotencyKey: string;
}

export interface DurableEncodedToolValue {
  readonly encoding: "json" | "undefined";
  readonly json?: string;
}

export interface DurableToolError {
  readonly name: string;
  readonly message: string;
}

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

export interface DurableReplayTool {
  readonly intent: ToolIntentEvent;
  readonly settlement?: ToolSettledEvent;
}

export interface TurnEvent extends JournalEventBase {
  type: "turn";
  messages: unknown[];
}

export interface SnapshotEvent extends JournalEventBase {
  type: "snapshot";
  messages: unknown[];
}

export interface TrancheEvent extends JournalEventBase {
  type: "tranche";
  amount: number;
  reason: string;
  atCall: number;
}

export interface RunCompletedEvent extends JournalEventBase {
  type: "run_completed";
  result: unknown;
  /** Final public conversation state, applied after terminal fsync or on replay. */
  conversation?: DurableConversationCheckpoint;
}

/**
 * A cancellation REQUEST, not a cancellation. Appended by whoever wants the run
 * stopped — a `DELETE /runs/{id}`, an operator, another process — and observed
 * by whoever is driving it.
 *
 * This is Temporal's cancel, not its terminate: the request is graceful and the
 * run still ends with a terminal event of its own, so spend already journaled
 * stays accounted and a compensating step still gets to run. Forcing a run to
 * stop without letting its driver settle is what killing the process already
 * does, and that path is a crash, which the journal already handles.
 *
 * The event is idempotent by construction: a second request on a run that
 * already carries one changes nothing, so a retried DELETE is free.
 */
export interface CancelRequestedEvent extends JournalEventBase {
  type: "cancel_requested";
  reason: string;
}

/**
 * A durable timer: this run is not eligible to be driven until `wakeAt`.
 *
 * The point is economic, not functional. An agent waiting on a rate limit, a
 * retry window, or tomorrow morning's approval does not need a process — it
 * needs a date. Blocking a process for it means paying for wall-clock in which
 * nothing happens, which on every container platform is the single largest
 * avoidable cost in an agent workload. So a sleep is journaled and the driver
 * RETURNS: the instance is free, the container can scale to zero, and the run
 * is picked up again when it is due.
 *
 * The wake time is absolute and last-write-wins, which is what makes this one
 * event instead of two. There is no `sleep_settled`: once `wakeAt` has passed
 * the sleep is over by definition, so a crash-resume cannot re-wait it, and a
 * second sleep is simply a later `wakeAt`.
 */
export interface SleepScheduledEvent extends JournalEventBase {
  type: "sleep_scheduled";
  wakeAt: string;
  reason: string;
}

export interface RunFailedEvent extends JournalEventBase {
  type: "run_failed";
  code: string;
  message: string;
  receipt: unknown;
}

export type DurableJournalEvent =
  | RunStartedEvent
  | ResumedEvent
  | MeterCallEvent
  | CallStartedEvent
  | CallSettledEvent
  | CallAbandonedEvent
  | ToolIntentEvent
  | ToolSettledEvent
  | TurnEvent
  | SnapshotEvent
  | TrancheEvent
  | CancelRequestedEvent
  | SleepScheduledEvent
  | RunCompletedEvent
  | RunFailedEvent;

// ---------------------------------------------------------------------------

/**
 * Serialized append pipeline over a {@link DurableStore}. `emit` queues
 * (stringifying immediately so an unserializable event fails at its source),
 * `flush` durably writes everything queued. Writes are chained: flush order
 * is emit order, and a flush resolves only when its own events are durable.
 */
export class DurableJournal {
  readonly runId: string;
  private readonly store: DurableStore;
  private queue: string[] = [];
  private chain: Promise<void> = Promise.resolve();
  private eventCount: number;
  private byteCount: number;
  // Sticky: once an append fails, this journal has a hole and must refuse to
  // keep recording (a resumed run would trust a ledger that stopped mid-run).
  // The chain itself never carries a rejection — an unobserved rejected
  // promise on a `void flush()` would take the whole process down.
  private failed: Error | undefined;

  constructor(store: DurableStore, runId: string, priorEvents: readonly string[] = []) {
    const priorBytes = priorEvents.reduce((total, line) => total + utf8Bytes(line) + 1, 0);
    if (priorEvents.length > MAX_JOURNAL_EVENTS || priorBytes > MAX_JOURNAL_BYTES ||
        priorEvents.some((line) => utf8Bytes(line) > MAX_EVENT_BYTES)) {
      throw new Error("cave_durable_journal_limit");
    }
    this.store = store;
    this.runId = runId;
    this.eventCount = priorEvents.length;
    this.byteCount = priorBytes;
  }

  emit(event: DurableJournalEvent): void {
    if (this.eventCount >= MAX_JOURNAL_EVENTS) {
      throw new Error("cave_durable_journal_limit");
    }
    let line: string;
    try {
      validateEvent(event);
      line = JSON.stringify(event);
      if (typeof line !== "string") throw new Error("not serializable");
    } catch {
      // A durable run whose evidence cannot be journaled must fail loudly at
      // the source; a silent skip would resume from a lying journal.
      throw new Error(`cave_durable_event_not_serializable: ${event.type}`);
    }
    const lineBytes = utf8Bytes(line);
    if (lineBytes > MAX_EVENT_BYTES) {
      throw new Error(`cave_durable_event_limit: ${event.type}`);
    }
    if (this.byteCount + lineBytes + 1 > MAX_JOURNAL_BYTES) {
      throw new Error("cave_durable_journal_limit");
    }
    this.queue.push(line);
    this.eventCount++;
    this.byteCount += lineBytes + 1;
  }

  flush(): Promise<void> {
    if (this.failed !== undefined) return Promise.reject(this.failed);
    if (this.queue.length === 0) return Promise.resolve();
    const batch = this.queue;
    this.queue = [];
    const data = batch.map((line) => `${line}\n`).join("");
    this.chain = this.chain.then(async () => {
      if (this.failed !== undefined) return;
      try {
        await this.store.append(this.runId, data);
      } catch (error) {
        this.failed = error instanceof Error ? error : new Error(String(error));
      }
    });
    return this.chain.then(() => {
      if (this.failed !== undefined) throw this.failed;
    });
  }

  now(): string {
    return new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// Tool intent/settlement coordinator
// ---------------------------------------------------------------------------

type ToolInvocationIdentity = {
  readonly path: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly effect: DurableToolEffect;
  readonly argsSha256: string;
  readonly idempotencyKey: string;
};

export class DurableToolCoordinator {
  readonly #journal: DurableJournal;
  readonly #runId: string;
  readonly #replay: readonly DurableReplayTool[];
  readonly #seen = new Set<string>();
  #cursor = 0;
  #fatal: Error | undefined;

  constructor(journal: DurableJournal, replay: readonly DurableReplayTool[] = []) {
    this.#journal = journal;
    this.#runId = journal.runId;
    if (replay.length > MAX_JOURNAL_EVENTS) throw new Error("cave_durable_tool_limit");
    this.#replay = Object.freeze([...replay]);
  }

  /** Refuse ambiguity before another provider call can spend. */
  assertResumeSafe(): void {
    if (this.#fatal !== undefined) throw this.#fatal;
    const uncertain = this.#replay.find((record) =>
      record.settlement === undefined &&
      (record.intent.effect === "write" || record.intent.effect === "external")
    );
    if (uncertain !== undefined) {
      throw new Error(
        `cave_durable_tool_effect_uncertain:${uncertain.intent.name}:${uncertain.intent.toolCallId}`,
      );
    }
  }

  /** Every uncheckpointed prior call must reconcile in original intent order. */
  assertReconciled(): void {
    if (this.#fatal !== undefined) throw this.#fatal;
    if (this.#cursor !== this.#replay.length) {
      const pending = this.#replay[this.#cursor]!;
      throw new Error(
        `cave_durable_tool_replay_incomplete:${pending.intent.name}:${pending.intent.toolCallId}`,
      );
    }
  }

  async execute<T>(
    input: {
      readonly path: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly effect: DurableToolEffect;
      readonly args: unknown;
    },
    work: (invocation: DurableToolInvocation) => Promise<T>,
  ): Promise<T> {
    const identity = this.#identity(input);
    const key = toolRecordKey(identity.path, identity.toolCallId);
    if (this.#seen.has(key)) {
      throw this.#fail(new Error("cave_durable_tool_call_id_reused"));
    }
    this.#seen.add(key);

    const replay = this.#replay[this.#cursor];
    if (replay !== undefined) {
      // A resumed run re-drives its lost turn through the provider, which
      // mints fresh tool-call ids, so the recorded id can only match a faux
      // stream that replays the same literal ids. The journal's authority is
      // the call's position, tool, effect, and argument digest; when those
      // agree the recorded identity is adopted for the rest of the call so
      // the settlement pairs with its own intent.
      if (!sameToolCall(replay.intent, identity)) {
        throw this.#fail(new Error(
          `cave_durable_tool_replay_mismatch:${replay.intent.name}:${replay.intent.toolCallId}`,
        ));
      }
      this.#cursor++;
      if (replay.settlement !== undefined) {
        return replayToolSettlement<T>(replay.settlement);
      }
      // Only read/idempotent unmatched intents reach here; assertResumeSafe
      // rejects effects whose outcome cannot be known.
      const { v: _v, at: _at, type: _type, ...recorded } = replay.intent;
      return this.#drive(recorded, true, work);
    }
    return this.#drive(identity, false, work);
  }

  #fail(error: Error): Error {
    this.#fatal ??= error;
    return this.#fatal;
  }

  #identity(input: {
    readonly path: string;
    readonly toolCallId: string;
    readonly name: string;
    readonly effect: DurableToolEffect;
    readonly args: unknown;
  }): ToolInvocationIdentity {
    if (!validToolPath(input.path) || !validToolCallId(input.toolCallId) ||
        !TOOL_NAME_PATTERN.test(input.name) ||
        !["read", "write", "idempotent", "external"].includes(input.effect)) {
      throw new Error("cave_durable_tool_identity_invalid");
    }
    const argsSha256 = durableToolArgsSHA256(input.args);
    return {
      path: input.path,
      toolCallId: input.toolCallId,
      name: input.name,
      effect: input.effect,
      argsSha256,
      idempotencyKey: durableToolIdempotencyKey({
        runId: this.#runId,
        path: input.path,
        toolCallId: input.toolCallId,
        name: input.name,
        argsSha256,
      }),
    };
  }

  async #drive<T>(
    identity: ToolInvocationIdentity,
    resumed: boolean,
    work: (invocation: DurableToolInvocation) => Promise<T>,
  ): Promise<T> {
    if (!resumed) {
      try {
        this.#journal.emit({
          v: DURABLE_JOURNAL_VERSION,
          at: this.#journal.now(),
          type: "tool_intent",
          ...identity,
        });
        await this.#journal.flush();
      } catch (error) {
        throw this.#fail(asError(error));
      }
    }
    const invocation = Object.freeze({
      idempotencyKey: identity.idempotencyKey,
      resumed,
    });
    let returned: T | undefined;
    let thrown: unknown;
    let failed = false;
    try {
      returned = await work(invocation);
    } catch (error) {
      failed = true;
      thrown = error;
    }

    let settlement: ToolSettledEvent;
    try {
      settlement = failed
        ? {
          v: DURABLE_JOURNAL_VERSION,
          at: this.#journal.now(),
          type: "tool_settled",
          ...identity,
          outcome: "threw",
          error: boundedError(thrown),
        }
        : {
          v: DURABLE_JOURNAL_VERSION,
          at: this.#journal.now(),
          type: "tool_settled",
          ...identity,
          outcome: "returned",
          value: encodeToolValue(returned),
        };
      this.#journal.emit(settlement);
      await this.#journal.flush();
    } catch (error) {
      // Once I/O ran, inability to durably settle it is a run-fatal hole. Pi
      // may render this invocation as a native tool error, but the coordinator
      // prevents another provider call and rethrows the exact bounded cause.
      throw this.#fail(asError(error));
    }
    if (failed) throw thrown;
    // Return same JSON snapshot future resumes see. Caller mutation after
    // settlement cannot change journal truth.
    return decodeToolValue(settlement.value!) as T;
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function toolRecordKey(path: string, toolCallId: string): string {
  return JSON.stringify([path, toolCallId]);
}

function validToolPath(value: unknown): value is string {
  return typeof value === "string" && utf8Bytes(value) <= MAX_TOOL_PATH_BYTES &&
    !CONTROL_CHARACTER_PATTERN.test(value);
}

function validToolCallId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    utf8Bytes(value) <= MAX_TOOL_CALL_ID_BYTES && !CONTROL_CHARACTER_PATTERN.test(value);
}

/** Positional replay match: everything but the provider-minted call id. */
function sameToolCall(recorded: ToolIntentEvent, current: ToolInvocationIdentity): boolean {
  return recorded.path === current.path &&
    recorded.name === current.name &&
    recorded.effect === current.effect &&
    recorded.argsSha256 === current.argsSha256;
}

function sameToolIdentity(
  recorded: ToolIntentEvent,
  current: ToolInvocationIdentity,
): boolean {
  return recorded.path === current.path &&
    recorded.toolCallId === current.toolCallId &&
    recorded.name === current.name &&
    recorded.effect === current.effect &&
    recorded.argsSha256 === current.argsSha256 &&
    recorded.idempotencyKey === current.idempotencyKey;
}

function replayToolSettlement<T>(settlement: ToolSettledEvent): T {
  if (settlement.outcome === "returned") {
    if (settlement.value === undefined || settlement.error !== undefined) {
      throw new Error("cave_durable_journal_corrupt: malformed tool settlement");
    }
    return decodeToolValue(settlement.value) as T;
  }
  if (settlement.outcome !== "threw" || settlement.error === undefined ||
      settlement.value !== undefined) {
    throw new Error("cave_durable_journal_corrupt: malformed tool settlement");
  }
  const replayed = new Error(settlement.error.message);
  replayed.name = settlement.error.name;
  throw replayed;
}

// ---------------------------------------------------------------------------
// Journal analysis (resume reconstruction)
// ---------------------------------------------------------------------------

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
  priorToolEvents: ReadonlyArray<{ name: string; isError: boolean }>;
  /** Uncheckpointed calls requiring exact replay or safe redrive. */
  replayTools: readonly DurableReplayTool[];
  priorSettled: number;
  priorTranches: ReadonlyArray<{ amount: number; reason: string; atCall: number }>;
  priorCalls: number;
  priorTotals: DurablePriorTotals;
  /**
   * Journaled provider-call intents that never settled or were abandoned.
   * Each is one call that may have been billed by the provider without this
   * ledger ever seeing its usage — the documented at-least-once ceiling.
   */
  possibleDoubleCountCalls: number;
}

export type DurableJournalState =
  | { status: "fresh" }
  | {
    status: "completed";
    result: unknown;
    conversation?: DurableConversationCheckpoint;
    baseConversation?: DurableConversationCheckpoint;
  }
  | {
    status: "failed";
    code: string;
    message: string;
    receipt: unknown;
    baseConversation?: DurableConversationCheckpoint;
  }
  | { status: "pending"; resume: DurableResumeState };

function parseEvents(lines: readonly string[]): DurableJournalEvent[] {
  if (lines.length > MAX_JOURNAL_EVENTS) throw corrupt("journal event limit exceeded");
  const events: DurableJournalEvent[] = [];
  let totalBytes = 0;
  for (const line of lines) {
    const lineBytes = utf8Bytes(line);
    totalBytes += lineBytes + 1;
    if (lineBytes > MAX_EVENT_BYTES || totalBytes > MAX_JOURNAL_BYTES) {
      throw corrupt("journal byte limit exceeded");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("cave_durable_journal_corrupt: unparseable journal line");
    }
    if (!isPlainRecord(parsed) || typeof parsed.type !== "string") {
      throw new Error("cave_durable_journal_corrupt: malformed journal event");
    }
    const event = parsed as unknown as DurableJournalEvent;
    if (event.v !== DURABLE_JOURNAL_VERSION) {
      throw new Error(
        `cave_durable_journal_version_unsupported: journal v${String(event.v)}, this runtime reads v${DURABLE_JOURNAL_VERSION}`,
      );
    }
    validateEvent(event);
    events.push(event);
  }
  return events;
}

function validateEvent(event: DurableJournalEvent): void {
  const base = ["v", "at", "type"];
  const parsedAt = typeof event.at === "string" ? Date.parse(event.at) : Number.NaN;
  if (typeof event.at !== "string" || utf8Bytes(event.at) > 64 ||
      !Number.isFinite(parsedAt) || new Date(parsedAt).toISOString() !== event.at) {
    throw corrupt("malformed event timestamp");
  }
  switch (event.type) {
    case "run_started":
      requireEventKeys(event, [...base, "runId", "agentId", "definitionSha256", "input",
        "sessionId", "denomination", "budgetSha256", "pid"], ["budgetMax", "conversation"]);
      validateDurableRunIdCorrupt(event.runId);
      requireJournalString(event.agentId, 512, "agent identity");
      requireSha(event.definitionSha256, "definition digest");
      if (typeof event.input !== "string" || utf8Bytes(event.input) > MAX_EVENT_BYTES / 2) {
        throw corrupt("malformed input");
      }
      requireJournalString(event.sessionId, MAX_SESSION_ID_BYTES, "session identity");
      if (!["usd", "tokens", "none"].includes(event.denomination)) {
        throw corrupt("malformed denomination");
      }
      if (event.budgetMax !== undefined) requireMoney(event.budgetMax, "budgetMax");
      if (event.budgetSha256 !== "none") requireSha(event.budgetSha256, "budget digest");
      requirePositiveInteger(event.pid, "pid");
      if (event.conversation !== undefined) validateConversationCheckpoint(event.conversation);
      break;
    case "resumed":
      requireEventKeys(event, [...base, "attempt", "unmatchedIntents", "pid"]);
      requirePositiveInteger(event.attempt, "attempt");
      requireTokens(event.unmatchedIntents, "unmatchedIntents");
      requirePositiveInteger(event.pid, "pid");
      break;
    case "meter_call":
      requireEventKeys(event, [...base, "path", "atCall"]);
      requireJournalPath(event.path);
      requirePositiveInteger(event.atCall, "meter atCall");
      break;
    case "call_started":
      requireEventKeys(event, [...base, "path", "kind", "provider", "model"]);
      validateCallIdentity(event.path, event.kind, event.provider, event.model);
      break;
    case "call_settled":
      requireEventKeys(event, [...base, "path", "kind", "call"], ["settledAmount"]);
      validateCallIdentity(event.path, event.kind, event.call?.provider, event.call?.model);
      validateJournaledCall(event.call);
      if (event.settledAmount !== undefined) requireMoney(event.settledAmount, "settledAmount");
      break;
    case "call_abandoned":
      requireEventKeys(event, [...base, "path"]);
      requireJournalPath(event.path);
      break;
    case "tool_intent":
      requireEventKeys(event, [...base, "path", "toolCallId", "name", "effect",
        "argsSha256", "idempotencyKey"]);
      validateToolIdentity(event);
      break;
    case "tool_settled":
      requireEventKeys(event, [...base, "path", "toolCallId", "name", "effect",
        "argsSha256", "idempotencyKey", "outcome"], ["value", "error"]);
      validateToolIdentity(event);
      validateToolSettlement(event);
      break;
    case "turn":
    case "snapshot":
      requireEventKeys(event, [...base, "messages"]);
      if (!Array.isArray(event.messages)) throw corrupt(`${event.type} without a message array`);
      snapshotJson(event.messages, MAX_EVENT_BYTES / 2);
      break;
    case "tranche":
      requireEventKeys(event, [...base, "amount", "reason", "atCall"]);
      requirePositiveMoney(event.amount, "tranche amount");
      requireJournalString(event.reason, MAX_ERROR_BYTES, "tranche reason");
      requireTokens(event.atCall, "tranche atCall");
      break;
    case "cancel_requested":
      requireEventKeys(event, [...base, "reason"]);
      requireJournalString(event.reason, MAX_ERROR_BYTES, "cancellation reason");
      break;
    case "sleep_scheduled": {
      requireEventKeys(event, [...base, "wakeAt", "reason"]);
      requireJournalString(event.reason, MAX_ERROR_BYTES, "sleep reason");
      const wakeAt = typeof event.wakeAt === "string" ? Date.parse(event.wakeAt) : Number.NaN;
      if (typeof event.wakeAt !== "string" || !Number.isFinite(wakeAt) ||
          new Date(wakeAt).toISOString() !== event.wakeAt) {
        throw corrupt("malformed sleep wake time");
      }
      break;
    }
    case "run_completed":
      requireEventKeys(event, [...base, "result"], ["conversation"]);
      snapshotJson(event.result, MAX_EVENT_BYTES / 2);
      if (event.conversation !== undefined) validateConversationCheckpoint(event.conversation);
      break;
    case "run_failed":
      requireEventKeys(event, [...base, "code", "message", "receipt"]);
      requireJournalString(event.code, 512, "failure code");
      if (typeof event.message !== "string" || utf8Bytes(event.message) > MAX_ERROR_BYTES) {
        throw corrupt("malformed failure message");
      }
      snapshotJson(event.receipt, MAX_EVENT_BYTES / 2);
      break;
    default:
      throw new Error(`cave_durable_journal_event_unknown: ${(event as { type: string }).type}`);
  }
}


function requireEventKeys(
  event: DurableJournalEvent,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(event);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) ||
      required.some((key) => !Object.hasOwn(event, key))) {
    throw corrupt(`malformed ${event.type} fields`);
  }
}

function requireJournalString(value: unknown, maxBytes: number, field: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > maxBytes) {
    throw corrupt(`malformed ${field}`);
  }
  return value;
}

function requireSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw corrupt(`malformed ${field}`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw corrupt(`malformed ${field}`);
  }
  return value;
}

function validateDurableRunIdCorrupt(runId: unknown): void {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) throw corrupt("malformed runId");
}

function requireJournalPath(path: unknown): string {
  if (!validToolPath(path)) {
    throw corrupt("malformed path");
  }
  return path;
}

function validateCallIdentity(
  path: unknown,
  kind: unknown,
  provider: unknown,
  model: unknown,
): void {
  requireJournalPath(path);
  if (kind !== "model" && kind !== "compaction") throw corrupt("malformed call kind");
  requireJournalString(provider, 512, "provider identity");
  requireJournalString(model, 512, "model identity");
}

function validateToolIdentity(
  event: ToolIntentEvent | ToolSettledEvent,
): void {
  requireJournalPath(event.path);
  if (!validToolCallId(event.toolCallId)) throw corrupt("malformed tool call identity");
  if (!TOOL_NAME_PATTERN.test(event.name) ||
      !["read", "write", "idempotent", "external"].includes(event.effect) ||
      !SHA256_PATTERN.test(event.argsSha256) ||
      !/^cave-[0-9a-f]{64}$/.test(event.idempotencyKey)) {
    throw corrupt("malformed tool identity");
  }
}

function validateToolSettlement(event: ToolSettledEvent): void {
  if (event.outcome === "returned") {
    if (event.value === undefined || event.error !== undefined) {
      throw corrupt("malformed tool settlement");
    }
    if (!isPlainRecord(event.value)) throw corrupt("malformed tool value");
    if (event.value.encoding === "undefined") {
      if (Object.keys(event.value).length !== 1) throw corrupt("malformed tool value");
    } else if (event.value.encoding === "json" && typeof event.value.json === "string") {
      if (Object.keys(event.value).length !== 2) throw corrupt("malformed tool value");
      decodeToolValue(event.value);
    } else {
      throw corrupt("malformed tool value");
    }
    return;
  }
  if (event.outcome !== "threw" || event.error === undefined || event.value !== undefined ||
      !isPlainRecord(event.error) ||
      Object.keys(event.error).sort().join(",") !== "message,name" ||
      typeof event.error.name !== "string" || event.error.name.length === 0 ||
      utf8Bytes(event.error.name) > 256 || typeof event.error.message !== "string" ||
      utf8Bytes(event.error.message) > MAX_ERROR_BYTES) {
    throw corrupt("malformed tool settlement");
  }
}

function validateConversationCheckpoint(value: unknown): DurableConversationCheckpoint {
  if (!isPlainRecord(value) ||
      Object.keys(value).sort().join(",") !== "messages,messagesSha256,sessionId" ||
      typeof value.sessionId !== "string" || value.sessionId.length === 0 ||
      utf8Bytes(value.sessionId) > MAX_SESSION_ID_BYTES ||
      typeof value.messagesSha256 !== "string" || !SHA256_PATTERN.test(value.messagesSha256) ||
      !Array.isArray(value.messages)) {
    throw corrupt("malformed conversation checkpoint");
  }
  const checkpoint = durableConversationCheckpoint(value.sessionId, value.messages);
  if (checkpoint.messagesSha256 !== value.messagesSha256) {
    throw corrupt("conversation checkpoint digest mismatch");
  }
  return value as unknown as DurableConversationCheckpoint;
}

function messageRole(message: unknown): string | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function corrupt(detail: string): Error {
  return new Error(`cave_durable_journal_corrupt: ${detail}`);
}

function requireMoney(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw corrupt(`invalid journaled ${field}`);
  }
  return value;
}

function requirePositiveMoney(value: unknown, field: string): number {
  const amount = requireMoney(value, field);
  if (amount === 0) throw corrupt(`invalid journaled ${field}`);
  return amount;
}

function requireTokens(value: unknown, field: string): number {
  const amount = requireMoney(value, field);
  if (!Number.isSafeInteger(amount)) throw corrupt(`invalid journaled ${field}`);
  return amount;
}

function accumulateMoney(total: number, value: number, field: string): number {
  const next = total + value;
  if (!Number.isFinite(next)) throw corrupt(`overflowed journaled ${field}`);
  return next;
}

function accumulateTokens(total: number, value: number, field: string): number {
  const next = total + value;
  if (!Number.isSafeInteger(next)) throw corrupt(`overflowed journaled ${field}`);
  return next;
}

/**
 * Journaled money is still money: every figure that will reach a meter, a
 * RunResult total, or a receipt is validated with the same posture as
 * `BudgetMeter.restorePrior`, never trusted from disk. The store is a
 * pluggable trust boundary, not just a local file.
 */
function validateJournaledCall(value: unknown): JournaledCallUsage {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(",") !== [
    "cacheReadTokens", "cacheWriteTokens", "estimatedUsd", "inputTokens", "model",
    "outputTokens", "provider", "reasoningTokens", "unpriced", "usageBasis",
  ].sort().join(",")) {
    throw corrupt("call_settled without a call record");
  }
  const call = value as unknown as JournaledCallUsage;
  if (typeof call.provider !== "string" || typeof call.model !== "string") {
    throw corrupt("call_settled with a malformed identity");
  }
  requireTokens(call.inputTokens, "inputTokens");
  requireTokens(call.outputTokens, "outputTokens");
  requireTokens(call.cacheReadTokens, "cacheReadTokens");
  requireTokens(call.cacheWriteTokens, "cacheWriteTokens");
  requireTokens(call.reasoningTokens, "reasoningTokens");
  requireMoney(call.estimatedUsd, "estimatedUsd");
  if (typeof call.unpriced !== "boolean" ||
      (call.usageBasis !== "provider_reported" && call.usageBasis !== "unavailable")) {
    throw corrupt("call_settled with malformed flags");
  }
  if (call.reasoningTokens > call.outputTokens ||
      (call.unpriced && call.estimatedUsd !== 0)) {
    throw corrupt("call_settled with inconsistent usage");
  }
  if (call.usageBasis === "unavailable" &&
      (!call.unpriced || call.estimatedUsd !== 0 ||
        call.inputTokens !== 0 || call.outputTokens !== 0 ||
        call.cacheReadTokens !== 0 || call.cacheWriteTokens !== 0 ||
        call.reasoningTokens !== 0)) {
    throw corrupt("call_settled with malformed unavailable usage");
  }
  return call;
}

function settlementForDenomination(
  denomination: "usd" | "tokens" | "none",
  settledAmount: number | undefined,
  call: JournaledCallUsage,
): number | undefined {
  if (denomination === "none") {
    if (settledAmount !== undefined) {
      throw corrupt("unmetered call settlement carries settledAmount");
    }
    return undefined;
  }
  if (settledAmount === undefined) {
    throw corrupt("metered call settlement is missing settledAmount");
  }
  const settled = denomination === "tokens"
    ? requireTokens(settledAmount, "settledAmount")
    : requireMoney(settledAmount, "settledAmount");
  if (call.usageBasis === "unavailable") return settled;

  const evidenced = denomination === "usd"
    ? call.estimatedUsd
    : [
      call.inputTokens,
      call.outputTokens,
      call.cacheReadTokens,
      call.cacheWriteTokens,
    ].reduce((total, value) => accumulateTokens(total, value, "settledAmount"), 0);
  const matches = denomination === "tokens"
    ? settled === evidenced
    : Math.abs(settled - evidenced) <= moneyTolerance(settled, evidenced);
  if (!matches) throw corrupt("call settledAmount does not match provider usage");
  return settled;
}

function moneyTolerance(left: number, right: number): number {
  return Math.max(1e-10, Number.EPSILON * Math.max(Math.abs(left), Math.abs(right)) * 8);
}

/**
 * Minimal fail-closed shape check on a journaled terminal outcome before it
 * is replayed to a caller as a `RunResult`/`RunReceipt`. Not a full schema
 * pass — it pins the identity and every money-bearing field so a corrupted
 * or hostile store cannot mint arbitrary figures through the replay path.
 */
export function validateReplayResult(
  value: unknown,
  runId: string,
  agentId?: string,
): ReturnType<typeof validateRunReceipt> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw corrupt("run_completed without a result");
  }
  const result = value as Record<string, unknown>;
  if (result.runId !== runId || typeof result.agentId !== "string" ||
      (agentId !== undefined && result.agentId !== agentId) ||
      typeof result.text !== "string" || result.claimBasis !== "inferred" ||
      Object.hasOwn(result, "verifiedSavingsUsd")) {
    throw corrupt("replayed result identity mismatch");
  }
  for (const field of [
    "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
    "reasoningTokens",
  ]) {
    requireTokens(result[field], `result.${field}`);
  }
  requireMoney(result.costUsd, "result.costUsd");
  if (result.usageBasis !== "provider_reported" && result.usageBasis !== "unavailable") {
    throw corrupt("replayed result has invalid usage basis");
  }
  if (result.priceBasis !== "public_catalog" && result.priceBasis !== "unpriced") {
    throw corrupt("replayed result has invalid price basis");
  }
  if (!Array.isArray(result.toolCalls) || result.toolCalls.length > MAX_JOURNAL_EVENTS ||
      result.toolCalls.some((name) => typeof name !== "string" || utf8Bytes(name) > 512)) {
    throw corrupt("replayed result has invalid tool calls");
  }
  const receipt = validateReplayReceipt(result.receipt, runId, result.agentId);
  const receiptEvidence = terminalReceiptEvidence(receipt);
  const resultTokens = ([
    result.inputTokens,
    result.outputTokens,
    result.cacheReadTokens,
    result.cacheWriteTokens,
  ] as number[]).reduce((total, amount) =>
    accumulateTokens(total, amount, "result.totalTokens"), 0);
  if (result.usageBasis === "provider_reported" &&
      (resultTokens !== receiptEvidence.tokens ||
        !moneyMatches(result.costUsd as number, receiptEvidence.estimatedUsd))) {
    throw corrupt("replayed result usage disagrees with receipt");
  }
  if (result.stopReason !== receipt.stopReason ||
      result.capBreached !== receipt.capBreached ||
      typeof result.overspent !== "number" ||
      !moneyMatches(requireMoney(result.overspent, "result.overspent"), receipt.overspent) ||
      result.priceBasis !== (receipt.unpriced ? "unpriced" : "public_catalog")) {
    throw corrupt("replayed result outcome disagrees with receipt");
  }
  const resumed = Object.hasOwn(result, "resumed") ? result.resumed : undefined;
  if ((resumed !== undefined && resumed !== true) ||
      (resumed === true) !== (receipt.resume !== undefined)) {
    throw corrupt("replayed result resume state disagrees with receipt");
  }
  if (receipt.resume === undefined) {
    const toolCounts = new Map<string, number>();
    for (const name of result.toolCalls as string[]) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
    }
    if (toolCounts.size !== receipt.tools.length || receipt.tools.some((entry) =>
      toolCounts.get(entry.name) !== entry.calls)) {
      throw corrupt("replayed result tool calls disagree with receipt");
    }
  }
  return receipt;
}

export function validateReplayReceipt(
  value: unknown,
  runId: string,
  agentId?: string,
): ReturnType<typeof validateRunReceipt> {
  let receipt;
  try {
    receipt = validateRunReceipt(value);
  } catch {
    throw corrupt("terminal event contains an invalid receipt");
  }
  if (receipt.runId !== runId ||
      (agentId !== undefined && receipt.agentId !== agentId)) {
    throw corrupt("replayed receipt identity mismatch");
  }
  return receipt;
}

function moneyMatches(left: number, right: number): boolean {
  return Math.abs(left - right) <= moneyTolerance(left, right);
}

function terminalReceiptEvidence(receipt: ReturnType<typeof validateRunReceipt>): {
  tokens: number;
  estimatedUsd: number;
  calls: number;
  unpriced: boolean;
} {
  let tokens = receipt.resume?.priorTokens ?? 0;
  let estimatedUsd = receipt.resume?.priorEstimatedUsd ?? 0;
  let calls = receipt.resume?.priorCalls ?? 0;
  let unpriced = receipt.resume?.priorUnpriced ?? false;
  for (const call of receipt.calls) {
    tokens = [
      call.inputTokens,
      call.outputTokens,
      call.cacheReadTokens,
      call.cacheWriteTokens,
    ].reduce((total, amount) => accumulateTokens(total, amount, "receipt tokens"), tokens);
    estimatedUsd = accumulateMoney(estimatedUsd, call.estimatedUsd, "receipt estimatedUsd");
    calls = accumulateTokens(calls, 1, "receipt call count");
    if (call.unpriced) unpriced = true;
  }
  for (const child of receipt.subagents) {
    const nested = terminalReceiptEvidence(child);
    tokens = accumulateTokens(tokens, nested.tokens, "receipt tokens");
    estimatedUsd = accumulateMoney(
      estimatedUsd,
      nested.estimatedUsd,
      "receipt estimatedUsd",
    );
    calls = accumulateTokens(calls, nested.calls, "receipt call count");
    if (nested.unpriced) unpriced = true;
  }
  return { tokens, estimatedUsd, calls, unpriced };
}

function terminalCurrentCalls(
  receipt: ReturnType<typeof validateRunReceipt>,
): JournaledCallUsage[] {
  const calls = receipt.calls.map((call) => ({
    provider: call.provider,
    model: call.model,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheReadTokens: call.cacheReadTokens,
    cacheWriteTokens: call.cacheWriteTokens,
    reasoningTokens: call.reasoningTokens,
    estimatedUsd: call.estimatedUsd,
    unpriced: call.unpriced,
    usageBasis: call.usageBasis,
  }));
  for (const child of receipt.subagents) calls.push(...terminalCurrentCalls(child));
  return calls;
}

function callEvidenceKey(call: JournaledCallUsage): string {
  return JSON.stringify([
    call.provider,
    call.model,
    call.inputTokens,
    call.outputTokens,
    call.cacheReadTokens,
    call.cacheWriteTokens,
    call.reasoningTokens,
    call.estimatedUsd,
    call.unpriced,
    call.usageBasis,
  ]);
}

function reconcileTerminalReceipt(
  receipt: ReturnType<typeof validateRunReceipt>,
  started: RunStartedEvent,
  priorTotals: DurablePriorTotals,
  priorSettled: number,
  priorTranches: ReadonlyArray<{ amount: number; reason: string; atCall: number }>,
  settles: number,
  currentAttemptCalls: readonly JournaledCallUsage[],
  expectedBudgetInitial: number | undefined,
): void {
  const evidence = terminalReceiptEvidence(receipt);
  if (receipt.denomination !== started.denomination ||
      evidence.tokens !== priorTotals.totalTokens ||
      !moneyMatches(evidence.estimatedUsd, priorTotals.estimatedUsd) ||
      evidence.unpriced !== priorTotals.unpriced) {
    throw corrupt("terminal receipt disagrees with journaled provider usage");
  }
  if (evidence.calls !== settles) {
    throw corrupt("terminal receipt call count disagrees with journal");
  }
  const journaledCalls = new Map<string, number>();
  for (const call of currentAttemptCalls) {
    const key = callEvidenceKey(call);
    journaledCalls.set(key, (journaledCalls.get(key) ?? 0) + 1);
  }
  for (const call of terminalCurrentCalls(receipt)) {
    const key = callEvidenceKey(call);
    const remaining = journaledCalls.get(key) ?? 0;
    if (remaining === 0) throw corrupt("terminal receipt call evidence disagrees with journal");
    if (remaining === 1) journaledCalls.delete(key);
    else journaledCalls.set(key, remaining - 1);
  }
  if (journaledCalls.size !== 0) {
    throw corrupt("terminal receipt call evidence disagrees with journal");
  }
  if (started.denomination !== "none" &&
      (receipt.spent === undefined || !moneyMatches(receipt.spent, priorSettled))) {
    throw corrupt("terminal receipt spend disagrees with journal");
  }
  if (started.denomination !== "none" &&
      (receipt.max === undefined || started.budgetMax === undefined ||
        !moneyMatches(receipt.max, started.budgetMax))) {
    throw corrupt("terminal receipt max disagrees with journal contract");
  }
  if (receipt.tranches.length !== priorTranches.length || receipt.tranches.some((tranche, index) => {
    const journaled = priorTranches[index];
    return journaled === undefined || tranche.atCall !== journaled.atCall ||
      tranche.reason !== journaled.reason || !moneyMatches(tranche.amount, journaled.amount);
  })) {
    throw corrupt("terminal receipt tranches disagree with journal");
  }
  const trancheTotal = receipt.tranches.reduce(
    (total, tranche) => accumulateMoney(total, tranche.amount, "receipt tranches"),
    0,
  );
  const receiptInitial = receipt.released === undefined
    ? undefined
    : receipt.released - trancheTotal;
  if ((expectedBudgetInitial === undefined) !== (receiptInitial === undefined) ||
      (expectedBudgetInitial !== undefined && receiptInitial !== undefined &&
        !moneyMatches(receiptInitial, expectedBudgetInitial))) {
    throw corrupt("terminal receipt initial release disagrees with budget contract");
  }
}

/**
 * Classify a journal and, for a pending run, rebuild everything a resume
 * needs. `expected` is the CURRENT caller's identity; any mismatch with the
 * journaled identity fails closed — a resume must continue the same run, not
 * silently become a different one (Temporal's versioning lesson).
 */
/**
 * Journal-encoded stand-in for a non-string input. A multimodal run journals
 * the digest of its lowered context instead of the content, so its `input`
 * cannot be replayed from the journal alone — see
 * {@link durableInputIsReplayable}.
 */
export const MULTIMODAL_DURABLE_INPUT_PREFIX = "\u0000cave.multimodal.v1:";

/**
 * True when a journaled `input` is the literal input and can therefore drive
 * an unattended resume. False for the multimodal digest form, which needs the
 * original input supplied by the caller.
 */
export function durableInputIsReplayable(input: string): boolean {
  return !input.startsWith(MULTIMODAL_DURABLE_INPUT_PREFIX);
}

/**
 * What a journal says about a run, WITHOUT the definition, budget, or input
 * the caller would need for {@link analyzeJournal}. This is the read-only
 * view: it answers "is this run finished, and with what" for a status
 * endpoint or a recovery sweep. It deliberately cannot resume anything —
 * every resume still goes through `analyzeJournal`, which fails closed on a
 * definition, input, or budget that drifted.
 */
export type DurableRunSummary =
  | { readonly status: "missing" }
  | {
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
    readonly cancelRequested?: { readonly reason: string; readonly at: string };
    /**
     * Absolute time before which this run must not be driven. Present while a
     * durable sleep is outstanding — including one already due, so a caller can
     * tell "asleep until later" from "never slept" without a clock comparison
     * of its own.
     */
    readonly wakeAt?: string;
    /** Why it is sleeping. Operator-facing; never a secret. */
    readonly sleepReason?: string;
  }
  | {
    readonly status: "completed";
    readonly runId: string;
    readonly agentId: string;
    readonly result: unknown;
    readonly settledAt: string;
  }
  | {
    readonly status: "failed";
    readonly runId: string;
    readonly agentId: string;
    readonly code: string;
    readonly message: string;
    readonly receipt: unknown;
    readonly settledAt: string;
  };

export function durableRunSummary(lines: readonly string[]): DurableRunSummary {
  const events = parseEvents(lines);
  const started = events[0];
  if (started === undefined) return { status: "missing" };
  if (started.type !== "run_started") {
    throw new Error("cave_durable_journal_corrupt: journal does not begin with run_started");
  }
  // The terminal event is journaled last, but the search covers the whole
  // journal rather than just the tail: a settled run must never be reported
  // as pending because something was appended after it.
  const terminal = events.find(
    (event) => event.type === "run_completed" || event.type === "run_failed",
  );
  const identity = { runId: started.runId, agentId: started.agentId };
  if (terminal?.type === "run_completed") {
    return { status: "completed", ...identity, result: terminal.result, settledAt: terminal.at };
  }
  if (terminal?.type === "run_failed") {
    return {
      status: "failed",
      ...identity,
      code: terminal.code,
      message: terminal.message,
      receipt: terminal.receipt,
      settledAt: terminal.at,
    };
  }
  const cancel = events.find((event) => event.type === "cancel_requested");
  // Last write wins: a run that slept twice is due at the later time.
  const sleep = events.reduce<SleepScheduledEvent | undefined>(
    (latest, event) => event.type === "sleep_scheduled" ? event : latest,
    undefined,
  );
  return {
    status: "pending",
    ...identity,
    input: started.input,
    startedAt: started.at,
    attempts: 1 + events.filter((event) => event.type === "resumed").length,
    ...(cancel === undefined
      ? {}
      : { cancelRequested: { reason: cancel.reason, at: cancel.at } }),
    ...(sleep === undefined ? {} : { wakeAt: sleep.wakeAt, sleepReason: sleep.reason }),
  };
}

export function analyzeJournal(
  lines: readonly string[],
  expected: {
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
  },
): DurableJournalState {
  const events = parseEvents(lines);
  const started = events[0];
  if (started === undefined) return { status: "fresh" };
  if (started.type !== "run_started") {
    throw new Error("cave_durable_journal_corrupt: journal does not begin with run_started");
  }
  if (started.runId !== expected.runId) {
    throw new Error("cave_durable_journal_corrupt: journaled runId mismatch");
  }
  if (started.definitionSha256 !== expected.definitionSha256) {
    throw new Error(
      "cave_durable_definition_changed: the agent definition differs from the one this run started with — resume with the original definition, or use a new durable.runId",
    );
  }
  if (expected.agentId !== undefined && started.agentId !== expected.agentId) {
    throw new Error("cave_durable_agent_mismatch");
  }
  if (started.input !== expected.input) {
    throw new Error(
      "cave_durable_input_mismatch: this durable.runId was started with different input — a new task needs a new runId",
    );
  }
  if (started.denomination !== expected.denomination ||
      started.budgetMax !== expected.budgetMax ||
      started.budgetSha256 !== expected.budgetSha256) {
    throw new Error(
      "cave_durable_budget_changed: the budget differs from the one this run started with — a resume continues the original money contract",
    );
  }
  if (expected.sessionId !== undefined && started.sessionId !== expected.sessionId) {
    throw new Error("cave_durable_session_mismatch");
  }
  const startedConversationSession = started.conversation?.sessionId;
  const callerAttachedConversation = Object.hasOwn(expected, "conversationSessionId");
  if ((callerAttachedConversation &&
        startedConversationSession !== expected.conversationSessionId) ||
      (started.conversation !== undefined && started.sessionId !== startedConversationSession)) {
    throw new Error("cave_durable_conversation_mismatch");
  }

  let attempts = 1;
  let base: unknown[] = started.conversation === undefined
    ? []
    : [...started.conversation.messages];
  let turns: unknown[][] = [];
  let hasCompletedTurn = false;
  let intents = 0;
  let settles = 0;
  let abandoned = 0;
  let rootModelIntents = 0;
  let rootModelAbandoned = 0;
  let priorRootCompactions = 0;
  let priorRootMeterCalls = 0;
  let priorRootTrancheAtCall = 0;
  const meterCallWatermarks = new Map<string, number>();
  const priorToolEvents: Array<{ name: string; isError: boolean }> = [];
  const toolRecords = new Map<string, {
    intent: ToolIntentEvent;
    settlement?: ToolSettledEvent;
    committed: boolean;
  }>();
  const toolOrder: string[] = [];
  const pendingCalls = new Map<string, CallStartedEvent[]>();
  let priorSettled = 0;
  const priorTranches: Array<{ amount: number; reason: string; atCall: number }> = [];
  const priorTotals: DurablePriorTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0,
    totalTokens: 0,
    unpriced: false,
    anyUsageUnavailable: false,
  };
  let currentAttemptCalls: JournaledCallUsage[] = [];

  const checkpointTools = (): void => {
    for (const key of toolOrder) {
      const record = toolRecords.get(key)!;
      if (record.committed) continue;
      if (record.settlement === undefined) {
        throw corrupt("turn checkpoint crosses unsettled tool intent");
      }
      record.committed = true;
      priorToolEvents.push({
        name: record.intent.name,
        isError: record.settlement.outcome === "threw",
      });
    }
  };

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    switch (event.type) {
      case "run_started":
        if (index !== 0) throw corrupt("multiple run_started events");
        break;
      case "resumed":
        if (event.attempt !== attempts + 1) throw corrupt("non-monotonic resume attempt");
        if (event.unmatchedIntents !== intents - settles - abandoned) {
          throw corrupt("resume unmatched intent count mismatch");
        }
        attempts += 1;
        currentAttemptCalls = [];
        break;
      case "meter_call": {
        const previous = meterCallWatermarks.get(event.path);
        if (previous !== undefined && event.atCall !== previous + 1) {
          throw corrupt("non-monotonic meter call watermark");
        }
        if (event.path === "" && previous === undefined) {
          const legacyWatermark = Math.max(
            rootModelIntents + priorRootCompactions,
            priorRootTrancheAtCall,
          );
          if (event.atCall !== legacyWatermark + 1) {
            throw corrupt("invalid root meter call watermark");
          }
        }
        meterCallWatermarks.set(event.path, event.atCall);
        if (event.path === "") priorRootMeterCalls = event.atCall;
        break;
      }
      case "call_started": {
        intents += 1;
        const key = `${event.path}\u0000${event.kind}`;
        const pending = pendingCalls.get(key) ?? [];
        pending.push(event);
        pendingCalls.set(key, pending);
        if (event.path === "") {
          if (event.kind === "model") rootModelIntents += 1;
          else priorRootCompactions += 1;
        }
        break;
      }
      case "call_settled": {
        const key = `${event.path}\u0000${event.kind}`;
        const pending = pendingCalls.get(key);
        const intent = pending?.shift();
        if (intent === undefined) throw corrupt("call settlement without matching intent");
        settles += 1;
        const call = validateJournaledCall(event.call);
        const settledAmount = settlementForDenomination(
          started.denomination,
          event.settledAmount,
          call,
        );
        if (settledAmount !== undefined) {
          priorSettled = accumulateMoney(
            priorSettled,
            settledAmount,
            "settledAmount",
          );
        }
        if (call.provider !== intent.provider || call.model !== intent.model) {
          throw corrupt("call settlement identity mismatch");
        }
        priorTotals.inputTokens = accumulateTokens(
          priorTotals.inputTokens, call.inputTokens, "inputTokens",
        );
        priorTotals.outputTokens = accumulateTokens(
          priorTotals.outputTokens, call.outputTokens, "outputTokens",
        );
        priorTotals.cacheReadTokens = accumulateTokens(
          priorTotals.cacheReadTokens, call.cacheReadTokens, "cacheReadTokens",
        );
        priorTotals.cacheWriteTokens = accumulateTokens(
          priorTotals.cacheWriteTokens, call.cacheWriteTokens, "cacheWriteTokens",
        );
        priorTotals.reasoningTokens = accumulateTokens(
          priorTotals.reasoningTokens, call.reasoningTokens, "reasoningTokens",
        );
        priorTotals.estimatedUsd = accumulateMoney(
          priorTotals.estimatedUsd, call.estimatedUsd, "estimatedUsd",
        );
        const callTokens = [
          call.inputTokens,
          call.outputTokens,
          call.cacheReadTokens,
          call.cacheWriteTokens,
        ].reduce((total, value) => accumulateTokens(total, value, "totalTokens"), 0);
        priorTotals.totalTokens = accumulateTokens(
          priorTotals.totalTokens, callTokens, "totalTokens",
        );
        if (call.unpriced) priorTotals.unpriced = true;
        if (call.usageBasis === "unavailable") priorTotals.anyUsageUnavailable = true;
        currentAttemptCalls.push(call);
        break;
      }
      case "call_abandoned": {
        const candidates = ["model", "compaction"]
          .map((kind) => `${event.path}\u0000${kind}`)
          .filter((key) => (pendingCalls.get(key)?.length ?? 0) > 0);
        if (candidates.length !== 1) throw corrupt("call abandonment is ambiguous");
        const key = candidates[0]!;
        pendingCalls.get(key)!.shift();
        abandoned += 1;
        if (event.path === "" && key.endsWith("\u0000model")) rootModelAbandoned += 1;
        break;
      }
      case "tool_intent": {
        const key = toolRecordKey(event.path, event.toolCallId);
        if (toolRecords.has(key)) throw corrupt("duplicate tool intent identity");
        const expectedIdempotencyKey = durableToolIdempotencyKey({
          runId: started.runId,
          path: event.path,
          toolCallId: event.toolCallId,
          name: event.name,
          argsSha256: event.argsSha256,
        });
        if (event.idempotencyKey !== expectedIdempotencyKey) {
          throw corrupt("tool idempotency identity mismatch");
        }
        toolRecords.set(key, { intent: event, committed: false });
        toolOrder.push(key);
        break;
      }
      case "tool_settled": {
        const key = toolRecordKey(event.path, event.toolCallId);
        const record = toolRecords.get(key);
        if (record === undefined || record.settlement !== undefined || record.committed ||
            !sameToolIdentity(record.intent, event)) {
          throw corrupt("tool settlement without matching intent");
        }
        record.settlement = event;
        break;
      }
      case "turn":
        turns.push(event.messages);
        hasCompletedTurn = true;
        checkpointTools();
        break;
      case "snapshot":
        base = event.messages;
        turns = [];
        hasCompletedTurn = true;
        checkpointTools();
        break;
      case "tranche": {
        const trancheAtCall = requireTokens(event.atCall, "tranche atCall");
        priorRootTrancheAtCall = Math.max(priorRootTrancheAtCall, trancheAtCall);
        priorTranches.push({
          amount: requirePositiveMoney(event.amount, "tranche amount"),
          reason: typeof event.reason === "string" ? event.reason : "journaled",
          atCall: trancheAtCall,
        });
        break;
      }
      case "cancel_requested":
      case "sleep_scheduled":
        // Control signals, not state: they say what someone WANTS to happen and
        // contribute nothing to the reconstructed conversation or ledger. The
        // driver reads them through `durable-control.ts`; replay ignores them.
        break;
      case "run_completed":
        if (index !== events.length - 1) throw corrupt("events follow terminal outcome");
        if ([...pendingCalls.values()].some((pending) => pending.length !== 0)) {
          throw corrupt("completed run crosses unsettled provider intent");
        }
        if (toolOrder.some((key) => !toolRecords.get(key)!.committed)) {
          throw corrupt("completed run crosses uncheckpointed tool intent");
        }
        {
          const receipt = validateReplayResult(event.result, expected.runId, started.agentId);
          reconcileTerminalReceipt(
            receipt,
            started,
            priorTotals,
            priorSettled,
            priorTranches,
            settles,
            currentAttemptCalls,
            expected.budgetInitial,
          );
          if ((started.conversation === undefined) !== (event.conversation === undefined) ||
              (event.conversation !== undefined &&
                event.conversation.sessionId !== started.conversation?.sessionId)) {
            throw corrupt("terminal conversation binding mismatch");
          }
          return {
            status: "completed",
            result: { ...(event.result as Record<string, unknown>), receipt },
            ...(event.conversation === undefined ? {} : { conversation: event.conversation }),
            ...(started.conversation === undefined ? {} : { baseConversation: started.conversation }),
          };
        }
      case "run_failed":
        if (index !== events.length - 1) throw corrupt("events follow terminal outcome");
        if ([...pendingCalls.values()].some((pending) => pending.length !== 0)) {
          throw corrupt("failed run crosses unsettled provider intent");
        }
        {
          const receipt = validateReplayReceipt(event.receipt, expected.runId, started.agentId);
          reconcileTerminalReceipt(
            receipt,
            started,
            priorTotals,
            priorSettled,
            priorTranches,
            settles,
            currentAttemptCalls,
            expected.budgetInitial,
          );
          return {
            status: "failed",
            code: event.code,
            message: event.message,
            receipt,
            ...(started.conversation === undefined ? {} : { baseConversation: started.conversation }),
          };
        }
    }
  }

  // Trim to the last resumable boundary: `pi.continue()` requires the last
  // message to be a user or tool-result message, and anything after that
  // boundary is a turn the crash left incomplete. Its journaled spend stays
  // counted; only its messages are discarded and re-driven.
  const messages = [...base, ...turns.flat()];
  let end = messages.length;
  if (hasCompletedTurn) {
    while (end > 0) {
      const role = messageRole(messages[end - 1]);
      if (role === "user" || role === "toolResult") break;
      end -= 1;
    }
  }
  const discardedPartialTurn = end !== messages.length;

  return {
    status: "pending",
    resume: {
      attempts,
      sessionId: started.sessionId,
      input: started.input,
      hasCompletedTurn,
      ...(started.conversation === undefined ? {} : { conversation: started.conversation }),
      messages: messages.slice(0, end),
      discardedPartialTurn,
      // Abandoned intents never reached a provider, so they do not consume
      // the resumed run's call ceiling. Unmatched in-flight intents do: they
      // were real attempts.
      priorRootModelCalls: Math.max(0, rootModelIntents - rootModelAbandoned),
      priorRootCompactions,
      priorRootMeterCalls: Math.max(
        priorRootMeterCalls,
        rootModelIntents + priorRootCompactions,
        priorRootTrancheAtCall,
      ),
      priorToolEvents,
      replayTools: Object.freeze(toolOrder
        .map((key) => toolRecords.get(key)!)
        .filter((record) => !record.committed)
        .map((record) => Object.freeze({
          intent: record.intent,
          ...(record.settlement === undefined ? {} : { settlement: record.settlement }),
        }))),
      priorSettled,
      priorTranches,
      priorCalls: settles,
      priorTotals,
      possibleDoubleCountCalls: Math.max(0, intents - settles - abandoned),
    },
  };
}
