/** Web-standard agent handler. Node listener and upgrades live in serve.ts. */

import type { TurnEvent } from "@pebble-agent/protocol";
import type { AnyCaveBuildLock } from "./build.js";
import {
  DURABLE_CANCELLED_CODE,
  durableCancelRequest,
  durableRunIsDue,
  nextDurableWake,
  requestDurableCancel,
  settleCancelledRun,
} from "./durable-control.js";
import {
  DiskDurableStore,
  durableInputIsReplayable,
  durableRunSummary,
  validateDurableRunId,
  type DurableRunSummary,
  type DurableStore,
} from "./durable.js";
import type { AgentDefinition } from "./definition.js";
import { encodeRunEvent, PebbleEventEncoder } from "./pebble-stream.js";
import {
  AgentSessions,
  EventBroadcast,
  eventStreamResponse,
  withMessageContext,
  type Principal,
  type SessionRun,
} from "./serve-session.js";
export type { Principal } from "./serve-session.js";
import type { CavemanRunEvent, RunOptions } from "./runtime.js";
import type { AgentServerOptions } from "./serve.js";

export interface AgentHandlerOptions extends Omit<AgentServerOptions, "runOptions"> {
  /**
   * Resolve a request to the principal making it, or `undefined` to reject it.
   *
   * The SDK does not own identity: verify a JWT, an mTLS peer, or a session
   * cookie however the deployment already does, and return who it belongs to.
   * What the SDK does own is what follows — sessions are namespaced per
   * principal, so one principal cannot read, steer, or delete another's.
   *
   * Supplying this replaces `token`, which is the single-principal shorthand.
   */
  authenticate?: (request: Request) => Promise<Principal | undefined> | Principal | undefined;
  /** Per-run options; controllers, signals, conversations, and durability are handler-owned. */
  /**
   * Per-run options. `principal` is the authenticated caller that started the
   * run (only under `authenticate`); it is absent for runs re-driven by boot
   * recovery, whose caller identity the journal does not carry.
   */
  runOptions?: (context: { sessionId: string; runId: string; principal?: Principal }) =>
    Omit<RunOptions, "durable" | "controller" | "signal" | "conversation">;
  /** Host-owned WebSocket upgrade (Cloudflare WebSocketPair, Deno, Bun, or Node ws wrapper). */
  upgrade?: (request: Request) => { response: Response; socket: WebSocketLike } | undefined;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    fn: (event: { data?: unknown }) => void,
  ): void;
}

export interface RecoveryReport {
  readonly listable: boolean;
  readonly resumed: readonly string[];
  readonly sleeping: ReadonlyArray<{ readonly runId: string; readonly wakeAt: string }>;
  readonly skipped: ReadonlyArray<{ readonly runId: string; readonly reason: string }>;
}

export interface AgentHandler {
  fetch(request: Request): Promise<Response>;
  recover(): Promise<RecoveryReport>;
  nextWakeAt(): Promise<Date | undefined>;
  close(graceMs?: number): Promise<void>;
}

interface Job {
  readonly runId: string;
  readonly input: string;
  readonly sessionId: string;
  readonly encoder: PebbleEventEncoder;
  readonly broadcast: EventBroadcast;
  readonly session?: SessionRun;
}

/**
 * Run id reserved for the instance lease in `serve.ts`. It is a lock, not a
 * journal, so it is filtered out of every sweep rather than being reported as a
 * corrupt run.
 */
export const INSTANCE_LOCK_RUN_ID = "caveman.instance.lock";
/**
 * Run ids the sweep has already seen settle.
 *
 * The 60s sweep used to load every journal in the store on every pass, so a
 * deployment's recurring cost grew with everything it had ever run rather than
 * with what is still in flight. A journal is append-only and
 * {@link durableRunSummary} searches all of it for a terminal event, so a run
 * that has settled can never read as pending again: remembering it is sound,
 * and it takes the steady-state sweep down to the runs that are actually
 * pending plus whatever is new since the last pass.
 *
 * Bounded, because a long-lived instance would otherwise hold every run id it
 * has ever swept. Eviction costs a re-read, never correctness.
 */
const MAX_SETTLED_MEMO = 50_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const SETTLED_RETENTION_MS = 5 * 60_000;
const MAX_RETAINED_BROADCASTS = 256;

function processRoot(): string {
  return typeof process === "undefined" ? "." : process.cwd();
}

function joinPath(root: string, path: string): string {
  return `${root.replace(/[\\/]$/u, "")}/${path}`;
}

/**
 * A session belongs to whoever created it, and that has to survive a restart.
 * The journal cannot say so — `run_started` is frozen protocol — so ownership is
 * structural instead: the storage key is the caller's id prefixed with a tag
 * derived from its principal. A principal can only address sessions under its
 * own tag, and a recovered session lands back under the tag it was written with,
 * so no separate owner record can drift from the journal.
 *
 * The tag is a hash, not the principal id: principal ids are arbitrary strings
 * (a JWT `sub` may hold characters run ids forbid), tenant identity should not
 * be readable off a run id, and a fixed 16 chars keeps the 128-char id budget
 * predictable.
 */
async function principalTag(principalId: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(principalId),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Length-independent comparison without importing a host crypto module. */
function tokenMatches(presented: string, expected: string): boolean {
  const left = new TextEncoder().encode(presented);
  const right = new TextEncoder().encode(expected);
  let mismatch = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index++) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}

function bearer(request: Request): string | undefined {
  const direct = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
  if (direct !== undefined) return direct;
  const encoded = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("cave-bearer."))
    ?.slice("cave-bearer.".length);
  if (encoded === undefined || encoded === "") return undefined;
  try {
    const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    if (typeof atob === "function") {
      const binary = atob(padded);
      return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    }
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  const rendered = JSON.stringify(body);
  return new Response(rendered, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(rendered).byteLength),
      ...headers,
    },
  });
}

async function textBody(request: Request, maxBytes: number): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let rendered = "";
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) throw new Error("cave_serve_body_too_large");
    rendered += decoder.decode(next.value, { stream: true });
  }
  return rendered + decoder.decode();
}

export function createAgentHandler(options: AgentHandlerOptions): AgentHandler {
  const authenticate = options.authenticate;
  const token = options.token ?? "";
  if (authenticate === undefined && token.length < 16) {
    throw new Error(
      "cave_serve_token_required: set a bearer token of at least 16 characters, or pass authenticate(); this endpoint spends money",
    );
  }
  const rootDir = options.rootDir ?? processRoot();
  const store = options.store ?? new DiskDurableStore(joinPath(rootDir, ".caveman/runs/durable"));
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 2;
  const maxQueuedRuns = options.maxQueuedRuns ?? 64;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1) {
    throw new Error("cave_serve_concurrency_invalid");
  }
  const entryPathKnown = options.runOptions !== undefined &&
    (options.runOptions as unknown as Record<PropertyKey, unknown>)[
      Symbol.for("caveman.agent.serve.entryPathKnown")
    ] === true;
  if (options.definition.sandboxDeclared === false && !entryPathKnown &&
      typeof process !== "undefined") {
    process.stderr.write(
      `cave: ${options.definition.id} serves with host execution — tools are not isolated\n`,
    );
  }

  const queue: Job[] = [];
  const active = new Map<string, Promise<void>>();
  const cancellers = new Map<string, AbortController>();
  const broadcasts = new Map<string, EventBroadcast>();
  let ready = false;
  let draining = false;
  let sweeping = false;

  function admitted(runId: string): boolean {
    return active.has(runId) || queue.some((job) => job.runId === runId);
  }

  function evictRetainedBroadcasts(): void {
    const now = Date.now();
    const settled: Array<[string, EventBroadcast]> = [];
    for (const entry of broadcasts) {
      if (!entry[1].settled) continue;
      if (now - entry[1].settledAt >= SETTLED_RETENTION_MS) {
        broadcasts.delete(entry[0]);
        continue;
      }
      settled.push(entry);
    }
    settled.sort((left, right) => left[1].settledAt - right[1].settledAt);
    while (settled.length > MAX_RETAINED_BROADCASTS) {
      const oldest = settled.shift();
      if (oldest !== undefined) broadcasts.delete(oldest[0]);
    }
  }

  function enqueue(job: Job): void {
    queue.push(job);
    pump();
  }

  function enqueueLegacy(runId: string, input: string): void {
    const broadcast = new EventBroadcast();
    broadcasts.set(runId, broadcast);
    evictRetainedBroadcasts();
    enqueue({ runId, input, sessionId: runId, encoder: new PebbleEventEncoder(runId), broadcast });
  }

  function pump(): void {
    while (!draining && active.size < maxConcurrentRuns && queue.length > 0) {
      const job = queue.shift();
      if (job === undefined) return;
      active.set(job.runId, drive(job));
    }
  }

  async function drive(job: Job): Promise<void> {
    const canceller = new AbortController();
    cancellers.set(job.runId, canceller);
    let admissionDecided = false;
    const admit = (): void => {
      if (admissionDecided) return;
      admissionDecided = true;
      job.session?.onAdmitted();
    };
    const reject = (error: unknown): void => {
      if (admissionDecided) return;
      admissionDecided = true;
      job.session?.onRejected(error);
    };
    const runStore: DurableStore = job.session === undefined ? store : {
      load: (runId) => store.load(runId),
      append: (runId, data) => store.append(runId, data),
      async acquire(runId) {
        try {
          const release = await store.acquire(runId);
          admit();
          return release;
        } catch (error) {
          reject(error);
          throw error;
        }
      },
      close: (runId) => store.close(runId),
      ...(store.list === undefined ? {} : { list: () => store.list!() }),
    };
    let closedTurn = false;
    const emit = (event: CavemanRunEvent): void => {
      for (const encoded of encodeRunEvent(job.encoder, event)) {
        job.broadcast.push(encoded);
        if (encoded.kind === "turn.end") closedTurn = true;
      }
    };
    const closeTurn = (message: string): void => {
      if (closedTurn) return;
      closedTurn = true;
      job.broadcast.push(job.encoder.event({ kind: "error", message, retryable: false }));
      job.broadcast.push(job.encoder.event({ kind: "turn.end", stopReason: "error" }));
    };
    try {
      const factoryOptions = options.runOptions?.({
        sessionId: job.sessionId,
        runId: job.runId,
        ...(job.session?.principal === undefined ? {} : { principal: job.session.principal }),
      }) ?? {};
      const runOptions: RunOptions = {
        ...factoryOptions,
        rootDir: factoryOptions.rootDir ?? rootDir,
        durable: { runId: job.runId, store: runStore },
        signal: canceller.signal,
        ...(job.session === undefined
          ? {}
          : {
            sessionId: job.session.sessionId,
            conversation: job.session.conversation,
            controller: job.session.controller,
          }),
      };
      const pendingCancel = await durableCancelRequest(store, job.runId);
      if (pendingCancel !== undefined) {
        cancellers.delete(job.runId);
        await settleCancelledRun(runStore, job.runId, pendingCancel);
        closeTurn(DURABLE_CANCELLED_CODE);
        return;
      }
      job.broadcast.push(job.encoder.event({ kind: "turn.start" }));
      const runtime = await import("./runtime.js");
      const events = options.build === undefined
        ? runtime.streamAgent(options.definition, job.input, runOptions)
        : runtime.streamLockedAgent(options.definition, job.input, options.build, runOptions);
      for await (const event of events) emit(event);
    } catch (error) {
      reject(error);
      const message = error instanceof Error ? error.message : String(error);
      if (typeof process !== "undefined") {
        process.stderr.write(`caveman-agent serve: run ${job.runId} failed: ${message}\n`);
      }
      closeTurn(message);
    } finally {
      closeTurn("cave_serve_run_ended_without_terminal_event");
      if (job.session === undefined) job.broadcast.settle();
      cancellers.delete(job.runId);
      active.delete(job.runId);
      job.session?.onSettled();
      const cancelled = await durableCancelRequest(store, job.runId).catch(() => undefined);
      if (cancelled !== undefined) {
        await settleCancelledRun(store, job.runId, cancelled).catch(() => undefined);
      }
      pump();
    }
  }

  async function summarize(runId: string): Promise<DurableRunSummary> {
    return durableRunSummary(await store.load(runId));
  }

  async function cancelSessionRun(runId: string): Promise<void> {
    const queued = queue.findIndex((job) => job.runId === runId);
    if (queued !== -1) {
      const [removed] = queue.splice(queued, 1);
      removed?.session?.onSettled();
      return;
    }
    const outcome = await requestDurableCancel(store, runId);
    if (outcome.status === "requested") cancellers.get(runId)?.abort();
  }

  const sessions = new AgentSessions(store, {
    start(session): void {
      enqueue({
        runId: session.runId,
        input: session.input,
        sessionId: session.sessionId,
        encoder: session.encoder,
        broadcast: session.broadcast,
        session,
      });
    },
    cancel: cancelSessionRun,
    summary: summarize,
  }, maxBodyBytes);

  const settled = new Set<string>();
  function rememberSettled(runId: string): void {
    if (settled.size >= MAX_SETTLED_MEMO) {
      // Insertion-ordered, so this drops the oldest memo first.
      const oldest = settled.values().next();
      if (!oldest.done) settled.delete(oldest.value);
    }
    settled.add(runId);
  }

  /**
   * One pass over the store. Repeated on an interval, not just at boot,
   * because a run stranded by a PEER instance's death is only reclaimed once
   * somebody looks again — its journal lock is released by the peer's demise,
   * but nothing re-drives it until a sweep notices.
   *
   * Settled runs are remembered (see {@link MAX_SETTLED_MEMO}), so a pass reads
   * only the journals that are still pending plus whatever is new. The first
   * pass after a restart still reads everything.
   *
   * ponytail: `store.list()` itself is still O(all runs) per sweep, which is
   * cheap next to loading them but is the next ceiling; a
   * `list({ status: "pending" })` the SQL/DO store answers from an index is the
   * upgrade when a store holds enough runs for the enumeration alone to hurt.
   */
  async function sweep(
    resumed: string[],
    skipped: Array<{ runId: string; reason: string }>,
    sleeping: Array<{ runId: string; wakeAt: string }>,
    claimed: ReadonlySet<string>,
    declined: ReadonlySet<string>,
    runIds: readonly string[],
    journals: Map<string, readonly string[]>,
  ): Promise<RecoveryReport> {
    if (store.list === undefined) return { listable: false, resumed, skipped, sleeping };
    for (const runId of runIds) {
      if (claimed.has(runId) || declined.has(runId) || admitted(runId)) continue;
      if (settled.has(runId)) continue;
      let summary: DurableRunSummary;
      try {
        let lines = journals.get(runId);
        if (lines === undefined) {
          lines = await store.load(runId);
          journals.set(runId, lines);
        }
        summary = durableRunSummary(lines);
      }
      catch (error) {
        skipped.push({ runId, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (summary.status !== "pending") {
        // A corrupt journal is not memoized above: that read can fail for
        // reasons the store may recover from, and skipping it forever would
        // turn a transient fault into a permanently invisible run.
        rememberSettled(runId);
        continue;
      }
      if (summary.cancelRequested !== undefined) {
        await settleCancelledRun(store, runId, summary.cancelRequested);
        skipped.push({ runId, reason: DURABLE_CANCELLED_CODE });
        continue;
      }
      if (!durableRunIsDue(summary)) {
        sleeping.push({ runId, wakeAt: summary.wakeAt ?? "" });
        continue;
      }
      if (!durableInputIsReplayable(summary.input)) {
        skipped.push({ runId, reason: "cave_serve_resume_needs_original_input" });
        continue;
      }
      enqueueLegacy(runId, summary.input);
      resumed.push(runId);
    }
    return { listable: true, resumed, skipped, sleeping };
  }

  async function recover(): Promise<RecoveryReport> {
    const resumed: string[] = [];
    const skipped: Array<{ runId: string; reason: string }> = [];
    const sleeping: Array<{ runId: string; wakeAt: string }> = [];
    if (store.list === undefined || sweeping || draining) {
      ready = true;
      return { listable: store.list !== undefined, resumed, skipped, sleeping };
    }
    sweeping = true;
    try {
      const runIds = (await store.list()).filter((runId) => runId !== INSTANCE_LOCK_RUN_ID);
      const journals = new Map<string, readonly string[]>();
      const sessionRecovery = await sessions.recover(runIds, journals);
      resumed.push(...sessionRecovery.resumed);
      skipped.push(...sessionRecovery.skipped);
      return await sweep(
        resumed,
        skipped,
        sleeping,
        sessionRecovery.claimed,
        sessionRecovery.declined,
        runIds,
        journals,
      );
    } finally {
      sweeping = false;
      ready = true;
    }
  }

  async function submit(request: Request): Promise<Response> {
    if (draining) return json(503, { error: "cave_serve_draining" }, { "retry-after": "5" });
    let body: string;
    try { body = await textBody(request, maxBodyBytes); }
    catch (error) {
      return json(413, { error: error instanceof Error ? error.message : "cave_serve_body_too_large" });
    }
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { return json(400, { error: "cave_serve_body_invalid_json" }); }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "cave_serve_body_invalid" });
    }
    const { runId: rawRunId, input: rawInput, context } = payload as {
      runId?: unknown; input?: unknown; context?: unknown;
    };
    if (typeof rawRunId !== "string") return json(400, { error: "cave_serve_run_id_required" });
    try { validateDurableRunId(rawRunId); }
    catch (error) {
      return json(400, {
        error: "cave_durable_run_id_invalid",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (/\.\d+$/u.test(rawRunId)) {
      return json(400, { error: "cave_serve_run_id_reserved" });
    }
    if (typeof rawInput !== "string" || rawInput === "") {
      return json(400, { error: "cave_serve_input_must_be_text" });
    }
    let input: string;
    try { input = withMessageContext(rawInput, context); }
    catch (error) {
      return json(400, { error: error instanceof Error ? error.message : "cave_serve_body_invalid" });
    }
    const summary = await summarize(rawRunId);
    if (summary.status === "completed" || summary.status === "failed") return json(200, summary);
    if (admitted(rawRunId)) return json(202, { runId: rawRunId, status: "running" });
    if (summary.status === "pending" && !durableRunIsDue(summary)) {
      return json(202, { runId: rawRunId, status: "sleeping", wakeAt: summary.wakeAt });
    }
    if (queue.length >= maxQueuedRuns) {
      return json(503, { error: "cave_serve_queue_full" }, { "retry-after": "5" });
    }
    enqueueLegacy(rawRunId, input);
    return json(202, {
      runId: rawRunId,
      status: summary.status === "pending" ? "resuming" : "running",
    });
  }

  async function legacyEvents(rawRunId: string, request: Request): Promise<Response> {
    let runId: string;
    try { runId = decodeURIComponent(rawRunId); validateDurableRunId(runId); }
    catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
    const broadcast = broadcasts.get(runId);
    if (broadcast === undefined) {
      const summary = await summarize(runId);
      return json(summary.status === "missing" ? 404 : 409, {
        error: summary.status === "missing" ? "cave_serve_not_found" : "cave_serve_events_not_retained",
        message: summary.status === "missing"
          ? undefined
          : "events are held in memory for a limited window; read GET /runs/:id for the outcome",
        status: summary.status,
      });
    }
    return eventStreamResponse(broadcast, request, true);
  }

  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/healthz") return json(200, { status: "ok" });
    if (path === "/readyz") {
      return json(ready ? 200 : 503, {
        status: ready ? "ready" : "recovering",
        active: active.size,
        queued: queue.length,
      });
    }
    let namespace = "";
    let principal: Principal | undefined;
    if (authenticate === undefined) {
      const presented = bearer(request);
      if (presented === undefined || !tokenMatches(presented, token)) {
        return json(401, { error: "cave_serve_unauthorized" });
      }
    } else {
      // A hook that throws is an authentication failure, not a 500: a verifier
      // that cannot reach its JWKS must not fall open.
      try { principal = await authenticate(request); }
      catch { return json(401, { error: "cave_serve_unauthorized" }); }
      if (principal === undefined || typeof principal.id !== "string" || principal.id === "") {
        return json(401, { error: "cave_serve_unauthorized" });
      }
      namespace = await principalTag(principal.id);
    }
    const wsMatch = /^\/sessions\/([^/]+)\/ws$/.exec(path);
    if (wsMatch?.[1] !== undefined && request.method === "GET") {
      const rejected = await sessions.webSocketPreflight(wsMatch[1], namespace);
      if (rejected !== undefined) return rejected;
      const upgraded = options.upgrade?.(request);
      if (upgraded === undefined) return json(501, { error: "cave_serve_websocket_unavailable" });
      const attached = await sessions.webSocket(wsMatch[1], request, upgraded.socket, namespace, principal);
      if (!attached.ok) {
        upgraded.socket.close(1008, (await attached.json() as { error?: string }).error ?? "rejected");
      }
      return upgraded.response;
    }
    const sessionResponse = await sessions.route(request, path, namespace, principal);
    if (sessionResponse !== undefined) return sessionResponse;
    // `/runs` addresses journals by raw run id, with nothing tying a run to a
    // principal. Under a single token that is the whole API; under authenticate()
    // it would hand any principal every other principal's runs, so it closes
    // rather than silently spanning the isolation boundary sessions provide.
    if (authenticate !== undefined && path.startsWith("/runs")) {
      return json(403, {
        error: "cave_serve_runs_require_single_principal",
        message: "with authenticate() configured, use /sessions; /runs is not principal-scoped",
      });
    }
    if (path === "/runs" && request.method === "POST") return submit(request);
    const streamMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
    if (streamMatch?.[1] !== undefined && request.method === "GET") {
      return legacyEvents(streamMatch[1], request);
    }
    const match = /^\/runs\/([^/]+)$/.exec(path);
    if (match?.[1] !== undefined && request.method === "DELETE") {
      let runId: string;
      try { runId = decodeURIComponent(match[1]); validateDurableRunId(runId); }
      catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
      const outcome = await requestDurableCancel(store, runId);
      if (outcome.status === "requested") cancellers.get(runId)?.abort();
      return json(outcome.status === "missing" ? 404 : outcome.status === "already_settled" ? 409 : 202, outcome);
    }
    if (match?.[1] !== undefined && request.method === "GET") {
      let runId: string;
      try { runId = decodeURIComponent(match[1]); validateDurableRunId(runId); }
      catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
      const summary = await summarize(runId);
      return json(summary.status === "missing" ? 404 : 200, {
        ...summary,
        ...(summary.status === "pending" ? { driving: active.has(runId) } : {}),
      });
    }
    return json(404, { error: "cave_serve_not_found" });
  }

  return {
    fetch: fetchHandler,
    recover,
    nextWakeAt: () => nextDurableWake(store),
    async close(graceMs = 30_000): Promise<void> {
      draining = true;
      const deadline = Date.now() + graceMs;
      while (active.size > 0 && Date.now() < deadline) {
        await Promise.race([
          Promise.allSettled([...active.values()]),
          new Promise((wake) => setTimeout(wake, 250)),
        ]);
      }
      sessions.close();
    },
  };
}
