import {
  durableConversationCheckpoint,
  durableRunSummary,
  validateDurableRunId,
  type DurableConversationCheckpoint,
  type DurableRunSummary,
  type DurableStore,
} from "./durable.js";
import type { AgentRunController, Conversation } from "./runtime.js";
import { PebbleEventEncoder } from "./pebble-stream.js";
import { EventBroadcast, eventStreamResponse, gapFrame, resumeSequence, type WebSocketPeer } from "./serve-events.js";
export { EventBroadcast, eventStreamResponse, type WebSocketPeer } from "./serve-events.js";

const SETTLED_RETENTION_MS = 5 * 60_000;
// ponytail: 1024 process-local sessions is enough for the built-in host; move
// session ownership to a durable indexed coordinator before raising this.
const MAX_SESSION_STATES = 1024;
// ponytail: status history is diagnostic, not durable authority; paginate a
// separate durable message index before raising this 256-message window.
const MAX_SESSION_MESSAGES = 256;
// ponytail: deleted ids suppress same-process resurrection only; replace this
// 4096-entry tombstone window with durable deletion when deletion must persist.
const MAX_DELETED_SESSIONS = 4096;


export interface SessionRun {
  readonly runId: string;
  readonly input: string;
  readonly sessionId: string;
  readonly conversation: Conversation;
  readonly controller: AgentRunController;
  readonly encoder: PebbleEventEncoder;
  readonly broadcast: EventBroadcast;
  readonly onAdmitted: () => void;
  readonly onRejected: (error: unknown) => void;
  readonly onSettled: () => void;
  /** The authenticated caller that started this run; absent for boot-recovered runs. */
  readonly principal?: Principal;
}

export interface SessionDriver {
  start(run: SessionRun): void;
  cancel(runId: string): Promise<void>;
  summary(runId: string): Promise<DurableRunSummary>;
}

/** Who a request belongs to. `id` is the isolation boundary. */
export interface Principal {
  readonly id: string;
  /** Carried for host logging and policy; the SDK isolates on `id` alone. */
  readonly tenant?: string;
}

/** Upper bound on the serialized `context` a message may attach. */
export const SESSION_MESSAGE_CONTEXT_MAX_BYTES = 64 * 1024;

/**
 * Fold caller-supplied structured context into the text the model receives.
 *
 * The context rides inside the user message as one fenced JSON block, so it is
 * exactly as trusted as the message (untrusted), replays byte-for-byte from the
 * journal, and never enters the cached prefix. `context` must be a JSON object
 * or array under {@link SESSION_MESSAGE_CONTEXT_MAX_BYTES} once serialized.
 */
export function withMessageContext(text: string, context: unknown): string {
  if (context === undefined) return text;
  if (context === null || typeof context !== "object") {
    throw new Error("cave_session_message_context_invalid");
  }
  let rendered: string | undefined;
  try { rendered = JSON.stringify(context); } catch { rendered = undefined; }
  if (typeof rendered !== "string") throw new Error("cave_session_message_context_invalid");
  if (new TextEncoder().encode(rendered).byteLength > SESSION_MESSAGE_CONTEXT_MAX_BYTES) {
    throw new Error("cave_session_message_context_too_large");
  }
  return `${text}\n\n<cave-message-context>\n${rendered}\n</cave-message-context>`;
}

interface SessionMessage {
  readonly runId: string;
  readonly text: string;
  /** What the model receives: `text` plus any attached context. */
  readonly input: string;
  /** Who sent it; carried so a queued message restarted later keeps its caller's authority. */
  readonly principal?: Principal;
  readonly author?: string;
  readonly mode: "followUp" | "steer";
  readonly queued: boolean;
  readonly at: string;
}

interface SessionState {
  /** Namespaced storage key: what run ids and journals are built from. */
  readonly sessionId: string;
  /** What the caller asked for. Echoed back so a principal never sees its tag. */
  publicId: string;
  readonly checkpoint: DurableConversationCheckpoint;
  readonly encoder: PebbleEventEncoder;
  readonly broadcast: EventBroadcast;
  readonly runs: string[];
  readonly messages: SessionMessage[];
  conversation?: Conversation;
  controller?: AgentRunController;
  nextRun: number;
  active?: string;
  admitting?: string;
  busyElsewhere?: boolean;
  settling?: Promise<void>;
  lastUsedAt: number;
  settledAt: number;
  error?: string;
}

interface SessionRecovery {
  readonly claimed: ReadonlySet<string>;
  readonly resumed: readonly string[];
  readonly skipped: ReadonlyArray<{ readonly runId: string; readonly reason: string }>;
  readonly declined: ReadonlySet<string>;
}

type JournalCache = Map<string, readonly string[]>;

function json(status: number, body: unknown): Response {
  const rendered = JSON.stringify(body);
  return new Response(rendered, {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(rendered).byteLength),
    },
  });
}

async function requestJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (reader === undefined) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) throw new Error("cave_serve_body_too_large");
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function sessionRunNumber(sessionId: string, runId: string): number | undefined {
  const prefix = `${sessionId}.`;
  if (!runId.startsWith(prefix)) return undefined;
  const value = Number(runId.slice(prefix.length));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function sessionRunIdentity(runId: string): { readonly sessionId: string; readonly n: number } | undefined {
  const match = /^(.*)\.([1-9]\d*)$/u.exec(runId);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const n = Number(match[2]);
  return Number.isSafeInteger(n) ? { sessionId: match[1], n } : undefined;
}

/** `""` for a single-principal server, which keeps existing ids byte-identical. */
function sessionKey(namespace: string, publicId: string): string {
  return namespace === "" ? publicId : `${namespace}-${publicId}`;
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string" || value === "") throw new Error("cave_session_id_required");
  validateDurableRunId(`${value}.1`);
  return value;
}

function parseEvent(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function validatedCheckpoint(
  value: unknown,
  sessionId: string,
): DurableConversationCheckpoint | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.sessionId !== sessionId || !Array.isArray(candidate.messages) ||
      typeof candidate.messagesSha256 !== "string") return undefined;
  try {
    const checkpoint = durableConversationCheckpoint(sessionId, candidate.messages);
    return checkpoint.messagesSha256 === candidate.messagesSha256 ? checkpoint : undefined;
  } catch {
    return undefined;
  }
}

function runCheckpoints(lines: readonly string[], sessionId: string): {
  readonly base?: DurableConversationCheckpoint;
  readonly terminal?: DurableConversationCheckpoint;
} {
  let base: DurableConversationCheckpoint | undefined;
  let terminal: DurableConversationCheckpoint | undefined;
  for (const line of lines) {
    const event = parseEvent(line);
    if (event?.type === "run_started") base = validatedCheckpoint(event.conversation, sessionId);
    if (event?.type === "run_completed") {
      terminal = validatedCheckpoint(event.conversation, sessionId);
    }
  }
  return {
    ...(base === undefined ? {} : { base }),
    ...(terminal === undefined ? {} : { terminal }),
  };
}

function checkpointForRun(
  summary: DurableRunSummary,
  checkpoints: ReturnType<typeof runCheckpoints>,
): DurableConversationCheckpoint | undefined {
  if (summary.status === "pending") return checkpoints.base;
  if (summary.status === "failed") return checkpoints.terminal ?? checkpoints.base;
  return checkpoints.terminal;
}

async function cachedLoad(
  store: DurableStore,
  cache: JournalCache,
  runId: string,
): Promise<readonly string[]> {
  const existing = cache.get(runId);
  if (existing !== undefined) return existing;
  const lines = await store.load(runId);
  cache.set(runId, lines);
  return lines;
}

function lockReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith("cave_durable_run_locked") ? "cave_durable_run_locked" : message;
}

function initialSession(
  sessionId: string,
  publicId: string,
  checkpoint?: DurableConversationCheckpoint,
): SessionState {
  const base = checkpoint ?? durableConversationCheckpoint(sessionId, []);
  const now = Date.now();
  return {
    sessionId,
    publicId,
    checkpoint: base,
    encoder: new PebbleEventEncoder(sessionId),
    broadcast: new EventBroadcast(),
    runs: [],
    messages: [],
    nextRun: 1,
    lastUsedAt: now,
    settledAt: now,
  };
}

/** Session lifecycle; Pi owns all active steering/follow-up queue mechanics. */
export class AgentSessions {
  private readonly sessions = new Map<string, SessionState>();
  private readonly deleted = new Set<string>();

  constructor(
    private readonly store: DurableStore,
    private readonly driver: SessionDriver,
    private readonly maxBodyBytes: number,
  ) {}

  async recover(runIds: readonly string[], journals: JournalCache): Promise<SessionRecovery> {
    const claimed = new Set<string>();
    const resumed: string[] = [];
    const skipped: Array<{ runId: string; reason: string }> = [];
    const declined = new Set<string>();
    const groups = new Map<string, Array<{
      runId: string;
      n: number;
      lines: readonly string[];
      summary: DurableRunSummary;
      checkpoints: ReturnType<typeof runCheckpoints>;
    }>>();
    const namespaceMax = new Map<string, number>();
    for (const runId of runIds) {
      const identity = sessionRunIdentity(runId);
      if (identity === undefined) continue;
      namespaceMax.set(identity.sessionId, Math.max(namespaceMax.get(identity.sessionId) ?? 0, identity.n));
      const lines = await cachedLoad(this.store, journals, runId);
      const started = parseEvent(lines[0] ?? "");
      if (started?.type !== "run_started" || started.sessionId !== identity.sessionId) continue;
      let summary: DurableRunSummary;
      try { summary = durableRunSummary(lines); }
      catch { continue; }
      const checkpoints = runCheckpoints(lines, identity.sessionId);
      if (checkpoints.base === undefined) {
        if (summary.status === "pending") {
          skipped.push({ runId, reason: "cave_session_conversation_unrecoverable" });
          declined.add(runId);
        }
        continue;
      }
      const rows = groups.get(identity.sessionId) ?? [];
      rows.push({ runId, n: identity.n, lines, summary, checkpoints });
      groups.set(identity.sessionId, rows);
    }
    for (const [sessionId, rows] of groups) {
      rows.sort((a, b) => a.n - b.n);
      for (const row of rows.slice(0, -1)) {
        if (row.summary.status !== "pending") continue;
        skipped.push({ runId: row.runId, reason: "cave_session_not_last_run" });
        declined.add(row.runId);
      }
      if (this.deleted.has(sessionId)) {
        const lastDeleted = rows.at(-1)!;
        if (lastDeleted.summary.status === "pending") declined.add(lastDeleted.runId);
        continue;
      }
      const existing = this.sessions.get(sessionId);
      if (existing !== undefined && !existing.busyElsewhere) {
        if (existing.active !== undefined) claimed.add(existing.active);
        continue;
      }
      const last = rows.at(-1)!;
      const checkpoint = checkpointForRun(last.summary, last.checkpoints);
      const state = checkpoint === undefined
        ? { ...initialSession(sessionId, sessionId), error: "cave_session_conversation_unrecoverable" }
        : initialSession(sessionId, sessionId, checkpoint);
      state.runs.push(...rows.map((row) => row.runId));
      state.nextRun = (namespaceMax.get(sessionId) ?? last.n) + 1;
      this.sessions.set(sessionId, state);
      if (last.summary.status === "pending" && checkpoint !== undefined) {
        const input = last.summary.input;
        await this.ensureKernel(state);
        state.admitting = last.runId;
        const admission = new Promise<{ admitted: boolean; reason?: string }>((resolveAdmission) => {
          let admitted = false;
          let rejectedReason: string | undefined;
          this.driver.start({
          runId: last.runId,
          input,
          sessionId,
          conversation: state.conversation!,
          controller: state.controller!,
          encoder: state.encoder,
          broadcast: state.broadcast,
            onAdmitted: () => {
              admitted = true;
              delete state.admitting;
              delete state.busyElsewhere;
              state.active = last.runId;
              resolveAdmission({ admitted: true });
            },
            onRejected: (error) => {
              delete state.admitting;
              if (state.active === last.runId) delete state.active;
              const reason = lockReason(error);
              rejectedReason = reason;
              state.busyElsewhere = reason === "cave_durable_run_locked";
            },
            onSettled: () => {
              this.runSettled(state, last.runId, admitted);
              if (!admitted) resolveAdmission({
                admitted: false,
                reason: rejectedReason ?? "cave_session_conversation_unrecoverable",
              });
            },
          });
        });
        const result = await admission;
        if (result.admitted) {
          claimed.add(last.runId);
          resumed.push(last.runId);
        } else {
          const reason = result.reason ?? "cave_session_conversation_unrecoverable";
          skipped.push({ runId: last.runId, reason });
          declined.add(last.runId);
        }
      }
    }
    this.evictSessions();
    return { claimed, resumed, skipped, declined };
  }

  async route(
    request: Request,
    path: string,
    namespace = "",
    principal?: Principal,
  ): Promise<Response | undefined> {
    if (path === "/sessions" && request.method === "POST") return this.create(request, namespace);
    const messages = /^\/sessions\/([^/]+)\/messages$/.exec(path);
    if (messages?.[1] !== undefined && request.method === "POST") {
      return this.message(messages[1], request, namespace, principal);
    }
    const events = /^\/sessions\/([^/]+)\/events$/.exec(path);
    if (events?.[1] !== undefined && request.method === "GET") {
      const state = await this.loadDecoded(events[1], namespace);
      return state instanceof Response ? state : eventStreamResponse(state.broadcast, request, false);
    }
    const websocket = /^\/sessions\/([^/]+)\/ws$/.exec(path);
    if (websocket?.[1] !== undefined && request.method === "GET") return undefined;
    const session = /^\/sessions\/([^/]+)$/.exec(path);
    if (session?.[1] !== undefined && request.method === "GET") return this.status(session[1], namespace);
    if (session?.[1] !== undefined && request.method === "DELETE") {
      return this.remove(session[1], namespace);
    }
    return undefined;
  }

  async webSocket(
    rawId: string,
    request: Request,
    socket: WebSocketPeer,
    namespace = "",
    principal?: Principal,
  ): Promise<Response> {
    const loaded = await this.loadDecoded(rawId, namespace);
    if (loaded instanceof Response) return loaded;
    const state = loaded;
    let closed = false;
    const send = (value: unknown): void => {
      if (closed) return;
      try { socket.send(JSON.stringify(value)); } catch { closed = true; }
    };
    const requested = resumeSequence(request);
    const replay = state.broadcast.since(requested, true);
    if (replay.gap) send(gapFrame(requested, replay.earliest));
    for (const event of replay.events) send(event);
    const unsubscribe = state.broadcast.subscribe(send, () => socket.close(1000, "session closed"));
    const close = (): void => { closed = true; unsubscribe(); };
    socket.addEventListener("close", close);
    socket.addEventListener("error", close);
    socket.addEventListener("message", (event) => {
      void this.socketMessage(state, event.data, principal).catch((error: unknown) => {
        socket.close(1008, error instanceof Error ? error.message : "cave_serve_websocket_message_invalid");
      });
    });
    return new Response(null, { status: 200 });
  }

  async webSocketPreflight(rawId: string, namespace = ""): Promise<Response | undefined> {
    const loaded = await this.loadDecoded(rawId, namespace);
    return loaded instanceof Response ? loaded : undefined;
  }

  close(): void {
    for (const state of this.sessions.values()) state.broadcast.close();
  }

  private async create(request: Request, namespace = ""): Promise<Response> {
    let payload: unknown;
    try { payload = await requestJson(request, this.maxBodyBytes); }
    catch (error) {
      const message = error instanceof Error ? error.message : "cave_serve_body_invalid_json";
      return json(message === "cave_serve_body_too_large" ? 413 : 400, {
        error: message === "cave_serve_body_too_large" ? message : "cave_serve_body_invalid_json",
      });
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "cave_serve_body_invalid" });
    }
    let publicId: string;
    let key: string;
    try {
      publicId = validateSessionId((payload as { sessionId?: unknown }).sessionId);
      // The namespaced key must itself be a legal id, so a long session id under
      // a tag fails here with 400 rather than producing an unaddressable run id.
      key = validateSessionId(sessionKey(namespace, publicId));
    } catch (error) {
      return json(400, {
        error: error instanceof Error && error.message === "cave_session_id_required"
          ? error.message
          : "cave_durable_run_id_invalid",
      });
    }
    this.deleted.delete(key);
    const existing = await this.load(key, publicId);
    if (existing === undefined) {
      const state = initialSession(key, publicId);
      state.nextRun = await this.nextRunNumber(key);
      this.sessions.set(key, state);
    }
    this.evictSessions();
    return json(201, { sessionId: publicId });
  }

  private async message(
    rawId: string,
    request: Request,
    namespace = "",
    principal?: Principal,
  ): Promise<Response> {
    const loaded = await this.loadDecoded(rawId, namespace);
    if (loaded instanceof Response) return loaded;
    let payload: unknown;
    try { payload = await requestJson(request, this.maxBodyBytes); }
    catch (error) {
      const message = error instanceof Error ? error.message : "cave_serve_body_invalid_json";
      return json(message === "cave_serve_body_too_large" ? 413 : 400, {
        error: message === "cave_serve_body_too_large" ? message : "cave_serve_body_invalid_json",
      });
    }
    return this.acceptMessage(loaded, payload, principal);
  }

  private async acceptMessage(
    state: SessionState,
    payload: unknown,
    principal?: Principal,
  ): Promise<Response> {
    await state.settling;
    this.touch(state);
    if (state.error !== undefined) return json(409, { error: state.error });
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return json(400, { error: "cave_serve_body_invalid" });
    }
    const { text, author, mode = "followUp", context } = payload as {
      text?: unknown; author?: unknown; mode?: unknown; context?: unknown;
    };
    if (typeof text !== "string" || text === "") {
      return json(400, { error: "cave_session_message_text_required" });
    }
    if (author !== undefined && (typeof author !== "string" || author === "")) {
      return json(400, { error: "cave_session_message_author_invalid" });
    }
    if (mode !== "followUp" && mode !== "steer") {
      return json(400, { error: "cave_session_message_mode_invalid" });
    }
    let input: string;
    try { input = withMessageContext(text, context); }
    catch (error) {
      return json(400, { error: error instanceof Error ? error.message : "cave_session_message_context_invalid" });
    }
    await this.ensureKernel(state);
    const queued = state.active !== undefined;
    if (!queued) {
      const stored = await this.sessionStoreState(state.sessionId);
      state.nextRun = Math.max(state.nextRun, stored.nextRun);
      const pending = stored.pending;
      if (pending !== undefined) {
        state.admitting = pending.runId;
        const admission = await this.launchRun(state, pending.runId, pending.input, false, principal);
        if (!admission.admitted) {
          return json(409, {
            error: admission.reason === "cave_durable_run_locked"
              ? "cave_session_busy_elsewhere"
              : admission.reason,
          });
        }
        const message = this.recordMessage(state, {
          runId: pending.runId,
          text,
          input,
          ...(principal === undefined ? {} : { principal }),
          ...(author === undefined ? {} : { author }),
          mode,
          queued: true,
          at: new Date().toISOString(),
        });
        if (message.mode === "steer") state.controller!.steer(message.input);
        else state.controller!.followUp(message.input);
        return json(202, { runId: pending.runId, queued: true });
      }
    }
    const runId = state.active ?? `${state.sessionId}.${state.nextRun++}`;
    this.recordMessage(state, {
      runId,
      text,
      input,
      ...(principal === undefined ? {} : { principal }),
      ...(author === undefined ? {} : { author }),
      mode,
      queued,
      at: new Date().toISOString(),
    });
    if (queued) {
      if (mode === "steer") state.controller!.steer(input);
      else state.controller!.followUp(input);
    } else {
      state.active = runId;
      state.runs.push(runId);
      void this.launchRun(state, runId, input, true, principal);
    }
    return json(202, { runId, queued });
  }

  private async status(rawId: string, namespace = ""): Promise<Response> {
    const loaded = await this.loadDecoded(rawId, namespace);
    if (loaded instanceof Response) return loaded;
    if (loaded.error !== undefined) return json(409, { error: loaded.error });
    const runs = await Promise.all(loaded.runs.map((runId) => this.driver.summary(runId)));
    return json(200, {
      sessionId: loaded.publicId,
      runs,
      ...(loaded.active === undefined ? {} : { active: loaded.active }),
      queued: loaded.controller?.state.queued ?? 0,
      // Status shows what the caller sent. The composed input and the caller's
      // principal are run-internal and stay off the wire.
      messages: loaded.messages.map(({ input: _input, principal: _principal, ...message }) => message),
    });
  }

  private async remove(rawId: string, namespace = ""): Promise<Response> {
    const loaded = await this.loadDecoded(rawId, namespace);
    if (loaded instanceof Response) return loaded;
    loaded.controller?.clear();
    if (loaded.active !== undefined) await this.driver.cancel(loaded.active);
    loaded.broadcast.close();
    this.sessions.delete(loaded.sessionId);
    this.rememberDeleted(loaded.sessionId);
    return json(202, { sessionId: loaded.publicId, status: "deleted" });
  }

  private async socketMessage(
    state: SessionState,
    raw: unknown,
    principal?: Principal,
  ): Promise<void> {
    const text = typeof raw === "string"
      ? raw
      : raw instanceof ArrayBuffer
        ? new TextDecoder().decode(raw)
        : ArrayBuffer.isView(raw)
          ? new TextDecoder().decode(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength))
          : String(raw);
    let payload: unknown;
    try { payload = JSON.parse(text); }
    catch { throw new Error("cave_serve_websocket_message_invalid"); }
    if (payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
        (payload as { type?: unknown }).type === "cancel") {
      state.controller?.clear();
      if (state.active !== undefined) await this.driver.cancel(state.active);
      return;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
        (payload as { type?: unknown }).type !== "message") {
      throw new Error("cave_serve_websocket_message_invalid");
    }
    const response = await this.acceptMessage(state, payload, principal);
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ??
      "cave_serve_websocket_message_invalid");
  }

  private async loadDecoded(rawId: string, namespace = ""): Promise<SessionState | Response> {
    let publicId: string;
    let key: string;
    try {
      publicId = validateSessionId(decodeURIComponent(rawId));
      key = validateSessionId(sessionKey(namespace, publicId));
    } catch { return json(400, { error: "cave_durable_run_id_invalid" }); }
    // A session outside this principal's namespace is not addressable here, so
    // it reads as absent rather than forbidden: whether another tenant happens
    // to hold this id is not this caller's to learn.
    const state = await this.load(key, publicId);
    return state ?? json(404, { error: "cave_serve_not_found" });
  }

  private async load(sessionId: string, publicId?: string): Promise<SessionState | undefined> {
    if (this.deleted.has(sessionId)) return undefined;
    const existing = this.sessions.get(sessionId);
    if (existing !== undefined) {
      // A session adopted by recovery only knows its storage key. The first
      // request that addresses it supplies the caller's id, so responses stop
      // echoing the namespace tag back.
      if (publicId !== undefined) existing.publicId = publicId;
      this.touch(existing);
      return existing;
    }
    if (this.store.list === undefined) return undefined;
    const inspected = await this.inspectSession(sessionId);
    const rows = inspected.adopted;
    const last = rows.at(-1);
    if (last === undefined) return undefined;
    const checkpoint = checkpointForRun(last.summary, last.checkpoints);
    const state = checkpoint === undefined
      ? { ...initialSession(sessionId, publicId ?? sessionId), error: "cave_session_conversation_unrecoverable" }
      : initialSession(sessionId, publicId ?? sessionId, checkpoint);
    state.runs.push(...rows.map((row) => row.runId));
    state.nextRun = inspected.nextRun;
    this.sessions.set(sessionId, state);
    this.evictSessions();
    return state;
  }

  private async inspectSession(sessionId: string): Promise<{
    readonly nextRun: number;
    readonly adopted: Array<{
      readonly runId: string;
      readonly n: number;
      readonly summary: DurableRunSummary;
      readonly checkpoints: ReturnType<typeof runCheckpoints>;
    }>;
  }> {
    if (this.store.list === undefined) return { nextRun: 1, adopted: [] };
    // ponytail: this is one O(journals) scan per unknown/idle session; add a
    // store-level session-prefix index before installations reach thousands.
    const runIds = await this.store.list();
    let max = 0;
    const adopted: Array<{
      runId: string;
      n: number;
      summary: DurableRunSummary;
      checkpoints: ReturnType<typeof runCheckpoints>;
    }> = [];
    for (const runId of runIds) {
      const n = sessionRunNumber(sessionId, runId);
      if (n === undefined) continue;
      max = Math.max(max, n);
      const lines = await this.store.load(runId);
      const started = parseEvent(lines[0] ?? "");
      if (started?.type !== "run_started" || started.sessionId !== sessionId) continue;
      const checkpoints = runCheckpoints(lines, sessionId);
      if (checkpoints.base === undefined) continue;
      try {
        adopted.push({ runId, n, summary: durableRunSummary(lines), checkpoints });
      } catch {
        // Corrupt journals are not session authority.
      }
    }
    adopted.sort((left, right) => left.n - right.n);
    return { nextRun: max + 1, adopted };
  }

  private async sessionStoreState(sessionId: string): Promise<{
    readonly nextRun: number;
    readonly pending?: { readonly runId: string; readonly input: string };
  }> {
    const inspected = await this.inspectSession(sessionId);
    const last = inspected.adopted.at(-1);
    return {
      nextRun: inspected.nextRun,
      ...(last?.summary.status === "pending"
        ? { pending: { runId: last.runId, input: last.summary.input } }
        : {}),
    };
  }

  private async nextRunNumber(sessionId: string): Promise<number> {
    if (this.store.list === undefined) return 1;
    let max = 0;
    for (const runId of await this.store.list()) {
      const n = sessionRunNumber(sessionId, runId);
      if (n !== undefined) max = Math.max(max, n);
    }
    return max + 1;
  }

  private launchRun(
    state: SessionState,
    runId: string,
    input: string,
    activeBeforeAdmission: boolean,
    principal?: Principal,
  ): Promise<{ readonly admitted: boolean; readonly reason?: string }> {
    return new Promise((resolveAdmission) => {
      let admitted = false;
      let resolved = false;
      let rejectedReason: string | undefined;
      const resolve = (value: { admitted: boolean; reason?: string }): void => {
        if (resolved) return;
        resolved = true;
        resolveAdmission(value);
      };
      this.driver.start({
        runId,
        input,
        sessionId: state.sessionId,
        ...(principal === undefined ? {} : { principal }),
        conversation: state.conversation!,
        controller: state.controller!,
        encoder: state.encoder,
        broadcast: state.broadcast,
        onAdmitted: () => {
          admitted = true;
          delete state.admitting;
          delete state.busyElsewhere;
          state.active = runId;
          resolve({ admitted: true });
        },
        onRejected: (error) => {
          delete state.admitting;
          if (state.active === runId) delete state.active;
          const reason = lockReason(error);
          rejectedReason = reason;
          state.busyElsewhere = reason === "cave_durable_run_locked";
        },
        onSettled: () => {
          this.runSettled(state, runId, admitted);
          if (!admitted) resolve({
            admitted: false,
            reason: rejectedReason ?? "cave_session_conversation_unrecoverable",
          });
        },
      });
      if (activeBeforeAdmission) state.active = runId;
    });
  }

  private runSettled(state: SessionState, runId: string, admitted: boolean): void {
    if (state.active === runId) delete state.active;
    if (state.admitting === runId) delete state.admitting;
    state.settledAt = Date.now();
    state.lastUsedAt = state.settledAt;
    if (!admitted || state.controller === undefined || state.controller.state.queued === 0) {
      this.evictSessions();
      return;
    }
    const count = state.controller.state.queued;
    const queued = state.messages
      .filter((message) => message.runId === runId && message.queued)
      .slice(-count);
    state.controller.clear();
    state.settling = this.restartQueued(state, queued)
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        delete state.settling;
        this.evictSessions();
      });
  }

  private async restartQueued(state: SessionState, queued: readonly SessionMessage[]): Promise<void> {
    if (queued.length === 0) return;
    const stored = await this.sessionStoreState(state.sessionId);
    state.nextRun = Math.max(state.nextRun, stored.nextRun);
    const runId = `${state.sessionId}.${state.nextRun++}`;
    const firstIndex = state.messages.length - queued.length;
    for (let index = 0; index < queued.length; index++) {
      const message = queued[index]!;
      state.messages[firstIndex + index] = {
        ...message,
        runId,
        mode: index === 0 ? message.mode : "followUp",
        queued: index !== 0,
      };
    }
    state.active = runId;
    state.runs.push(runId);
    for (const message of queued.slice(1)) state.controller!.followUp(message.input);
    void this.launchRun(state, runId, queued[0]!.input, true, queued[0]!.principal);
  }

  private recordMessage(state: SessionState, message: SessionMessage): SessionMessage {
    state.messages.push(message);
    while (state.messages.length > MAX_SESSION_MESSAGES) state.messages.shift();
    return message;
  }

  private touch(state: SessionState): void {
    state.lastUsedAt = Date.now();
  }

  private rememberDeleted(sessionId: string): void {
    this.deleted.delete(sessionId);
    this.deleted.add(sessionId);
    while (this.deleted.size > MAX_DELETED_SESSIONS) {
      const oldest = this.deleted.values().next().value as string | undefined;
      if (oldest === undefined) break;
      this.deleted.delete(oldest);
    }
  }

  private evictSessions(): void {
    if (this.sessions.size <= MAX_SESSION_STATES) return;
    const now = Date.now();
    const idle = [...this.sessions.values()]
      .filter((state) => state.active === undefined && state.admitting === undefined &&
        state.broadcast.subscriberCount === 0 && now - state.settledAt >= SETTLED_RETENTION_MS)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    while (this.sessions.size > MAX_SESSION_STATES) {
      const state = idle.shift();
      if (state === undefined) break;
      state.broadcast.close();
      this.sessions.delete(state.sessionId);
    }
  }

  private async ensureKernel(state: SessionState): Promise<void> {
    if (state.conversation !== undefined && state.controller !== undefined) return;
    const runtime = await import("./runtime.js");
    state.conversation = runtime.restoreConversation(state.checkpoint);
    state.controller = new runtime.AgentRunController();
  }
}
