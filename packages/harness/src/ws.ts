/**
 * W1: the OpenAI Responses WebSocket transport (`wire.transport: "ws"`), as a
 * `fetch` handed to pi-ai's openai-responses provider. pi-ai builds the body
 * and parses the event stream exactly as on HTTP; this module only moves the
 * request: one socket per run, each request one `response.create` frame (the
 * HTTP body without `stream`), and the server's events replayed to pi-ai as the
 * SSE an HTTP response carries. Usage, cache and latency fields therefore come
 * from pi-ai's own parser, transport-blind.
 *
 * Continuation (Codex 0.166 `get_incremental_items`): a request whose
 * non-input fields equal the previous one's and whose input extends the
 * previous input plus the server's output items goes out as
 * `previous_response_id` + the new items only; anything else is a full resend,
 * and the trace names why. The server's cache is connection-local and keeps the
 * latest response, so it works with `store:false` (the WebSocket guide); a
 * `previous_response_not_found` gets one full resend on the same socket.
 * Prewarm (Codex): the run's first request goes out first as `generate:false`
 * and the real one chains from it with an empty delta. The prewarm honors that
 * request's abort, and a prewarm not finished within `connect_timeout_ms`
 * drops the socket; the request then goes whole on a new one.
 * Failures: a refused or lost connection before the first event sends that one
 * request over HTTP (a `transport_fallback` trace event), and after
 * `max_failures` the rest of the run stays on HTTP. A connection lost
 * mid-response fails that response with a transient error, which the run's
 * retry re-sends. The server's 60-minute limit: reconnect before a request
 * past `max_age_s`; a `websocket_connection_limit_reached` gets one reconnect
 * and a full resend.
 */
import { createHash } from "node:crypto";
import type { WsSettings } from "./wire.ts";

type Body = Record<string, any>;
type Fetch = typeof globalThis.fetch;
type Socket = InstanceType<typeof globalThis.WebSocket>;

/** A trace event: `ws` (kind connect | prewarm | request) or `transport_fallback`. */
export type WsEventSink = (type: "ws" | "transport_fallback", fields: Record<string, unknown>) => void;

export const OPENAI_BETA_WS = "responses_websockets=2026-02-06";
const TERMINAL: ReadonlySet<string> = new Set(["response.completed", "response.incomplete", "response.failed", "error"]);
/** Handshake headers that describe an HTTP body or connection, not the caller. */
const NOT_FORWARDED: ReadonlySet<string> = new Set(["accept", "accept-encoding", "connection", "content-length", "content-type", "host", "keep-alive", "transfer-encoding", "upgrade"]);
const isRecord = (value: unknown): value is Body => typeof value === "object" && value !== null && !Array.isArray(value);

/** What the run's result.json reports under `transport` when ws is on. */
export interface WsSummary {
  kind: "ws";
  /** Requests answered over the socket, and over HTTP (fallbacks). */
  ws_requests: number;
  http_requests: number;
  /** Frames sent as previous_response_id + delta, and as full input (with the reasons). */
  incremental: number;
  full: number;
  full_reasons: Record<string, number>;
  connects: number;
  prewarm_ms: number | null;
  /** Bytes of the create frames sent, and of the HTTP bodies they stand for. */
  bytes_sent: number;
  bytes_full: number;
  failures: number;
  /** Set when the rest of the run went over HTTP. */
  fallback: string | null;
}

/**
 * The previous response on this connection: what the server holds for
 * `previous_response_id`. Its request is kept as JSON text (the non-input
 * fields, and each input item): pi-ai renders an unchanged item to the same
 * text every time, so one native stringify per item per request is the whole
 * comparison cost.
 */
export interface Continuation {
  props: string;
  inputKeys: string[];
  output: unknown[];
  responseId: string;
}

/** Each input item's JSON text: the prefix comparison's unit. */
export const inputKeysOf = (body: Body): string[] => (Array.isArray(body.input) ? body.input.map((item: unknown) => JSON.stringify(item) ?? "null") : []);

/** JSON with sorted keys and no undefined: equal values, equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The request without its input and the transport-only fields, as JSON text: what must be unchanged for a delta. */
export function propsOf(body: Body): string {
  const { input: _input, previous_response_id: _previous, stream: _stream, background: _background, generate: _generate, ...rest } = body;
  return JSON.stringify(rest);
}

/**
 * An output item as the model sees it: pi-ai replays the server's items in its
 * own rendering (no `status`, re-serialized call arguments, message text
 * rebuilt), so those differences are not a different item.
 */
function itemKey(item: unknown): string {
  if (!isRecord(item)) return canonical(item);
  const { status: _status, ...rest } = item;
  if (rest.type === "function_call" && typeof rest.arguments === "string") {
    try {
      rest.arguments = canonical(JSON.parse(rest.arguments));
    } catch { /* compared as sent */ }
  }
  if (rest.type === "message" && Array.isArray(rest.content)) {
    rest.content = rest.content.map((part: unknown) => (isRecord(part) ? { type: part.type, text: part.text ?? part.refusal } : part));
  }
  return canonical(rest);
}

/**
 * The delta of `body` past `previous` (its input, then the server's output),
 * or why there is none. Codex's NonIncrementalReason labels.
 */
/** Each top-level field as type, length and a short digest: enough to name what differs, no content. */
export function shapeOf(item: unknown): Record<string, string> {
  if (!isRecord(item)) return { _: typeof item };
  const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? `s${value.length}:${digest(value)}` : Array.isArray(value) ? `a${value.length}:${digest(canonical(value))}` : isRecord(value) ? `o:${digest(canonical(value))}` : String(value);
  }
  return out;
}

export function continuationOf(body: Body, previous: Continuation | undefined, keys: string[] = inputKeysOf(body)): { delta: unknown[]; previousResponseId: string } | { reason: string; detail?: Body } {
  if (previous === undefined) return { reason: "no_previous_response" };
  const props = propsOf(body);
  if (props !== previous.props) {
    const [before, after] = [JSON.parse(previous.props) as Body, JSON.parse(props) as Body];
    const key = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().find((name) => canonical(before[name]) !== canonical(after[name]));
    return { reason: `property_changed:${key ?? "order"}` };
  }
  const input: unknown[] = Array.isArray(body.input) ? body.input : [];
  const prefix = previous.inputKeys.length;
  const baseline = prefix + previous.output.length;
  if (input.length < baseline) return { reason: "input_shortened" };
  for (let index = 0; index < prefix; index++) if (keys[index] !== previous.inputKeys[index]) return { reason: "input_mismatch" };
  for (let index = 0; index < previous.output.length; index++) {
    if (itemKey(input[prefix + index]) !== itemKey(previous.output[index])) {
      return { reason: "output_mismatch", detail: { index, sent: shapeOf(input[prefix + index]), server: shapeOf(previous.output[index]) } };
    }
  }
  return { delta: input.slice(baseline), previousResponseId: previous.responseId };
}

/** The caller's request headers fit for the handshake, plus the WebSocket beta. */
export function handshakeHeaders(source: ConstructorParameters<typeof Headers>[0]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of new Headers(source)) {
    if (NOT_FORWARDED.has(name) || name.startsWith("x-stainless-") || name.startsWith("sec-websocket")) continue;
    out[name] = value;
  }
  const beta = out["openai-beta"];
  if (beta === undefined) out["openai-beta"] = OPENAI_BETA_WS;
  else if (!beta.includes("responses_websockets")) out["openai-beta"] = `${beta},${OPENAI_BETA_WS}`;
  return out;
}

/** A WebSocket error event as the flat shape an HTTP SSE `error` event has (pi-ai reads `code` and `message`). */
function sseError(event: Body): Body {
  const error = isRecord(event.error) ? event.error : {};
  return { type: "error", code: event.code ?? error.code ?? null, message: event.message ?? error.message ?? "WebSocket error", param: event.param ?? error.param ?? null };
}

/** The open socket and the one listener (the request in flight) its messages go to. */
class Connection {
  readonly openedAt = Date.now();
  gone: string | undefined;
  private onData: ((data: string) => void) | undefined;
  private onGone: ((why: string) => void) | undefined;

  readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const data = event.data;
      this.onData?.(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    });
    socket.addEventListener("close", (event) => this.lost(`closed ${event.code}${event.reason ? ` ${event.reason}` : ""}`));
    socket.addEventListener("error", () => this.lost("socket error"));
  }

  private lost(why: string): void {
    if (this.gone !== undefined) return;
    this.gone = why;
    this.onGone?.(why);
  }

  listen(onData: (data: string) => void, onGone: (why: string) => void): void {
    this.onData = onData;
    this.onGone = onGone;
  }

  unlisten(): void {
    this.onData = undefined;
    this.onGone = undefined;
  }

  close(reason: string): void {
    try {
      this.socket.close(1000, reason);
    } catch { /* already closing */ }
    this.lost(reason);
  }
}

type Exchange =
  | { kind: "stream"; response: Response }
  | { kind: "error"; event: Body }
  | { kind: "lost"; why: string };

export interface WsTransportOptions {
  /** For connect() ahead of the first request: the ws(s) URL of the responses endpoint and the handshake headers. */
  url?: string;
  headers?: Record<string, string>;
  event?: WsEventSink;
  /** The HTTP fetch for fallbacks and non-streaming calls (default globalThis.fetch). */
  baseFetch?: Fetch;
  /** The WebSocket class (default globalThis.WebSocket, undici's, which takes handshake headers). */
  WebSocket?: typeof globalThis.WebSocket;
}

export class WsTransport {
  /** Hand to pi-ai as the provider's `fetch`. */
  readonly fetch: Fetch;
  private conn: Connection | undefined;
  private connecting: Promise<Connection> | undefined;
  private last: Continuation | undefined;
  /** Why the next request cannot chain (a new connection, a failed response); consumed by the next full send. */
  private resetReason: string | undefined;
  private prewarmed = false;
  private failures = 0;
  private idle: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly stats: WsSummary = {
    kind: "ws", ws_requests: 0, http_requests: 0, incremental: 0, full: 0, full_reasons: {}, connects: 0, prewarm_ms: null,
    bytes_sent: 0, bytes_full: 0, failures: 0, fallback: null,
  };

  private readonly settings: WsSettings;
  private readonly options: WsTransportOptions;

  constructor(settings: WsSettings, options: WsTransportOptions = {}) {
    this.settings = settings;
    this.options = options;
    this.fetch = (input, init) => this.handle(input, init);
  }

  summary(): WsSummary {
    return { ...this.stats, full_reasons: { ...this.stats.full_reasons } };
  }

  /** Opens the run's socket before the first request, so the handshake overlaps run setup. A failure here is only traced. */
  connect(): void {
    const { url, headers } = this.options;
    if (url === undefined || headers === undefined || this.stats.fallback !== null) return;
    this.ensure(url, handshakeHeaders(headers)).catch(() => undefined);
  }

  /** Run end: the socket closes (no response is in flight then: the loop consumed the last one). */
  close(): void {
    this.closed = true;
    this.conn?.unlisten();
    this.conn?.close("run_end");
    this.conn = undefined;
  }

  private emit(type: "ws" | "transport_fallback", fields: Record<string, unknown>): void {
    this.options.event?.(type, fields);
  }

  private async handle(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const base = this.options.baseFetch ?? globalThis.fetch;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const text = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown;
    try {
      body = text === undefined ? undefined : JSON.parse(text);
    } catch { /* not JSON: HTTP */ }
    const streaming = isRecord(body) && body.stream === true && Array.isArray(body.input) && (init?.method ?? "GET").toUpperCase() === "POST" &&
      /\/responses$/u.test(new URL(url).pathname);
    if (!streaming || this.stats.fallback !== null || this.closed) {
      this.stats.http_requests++;
      return base(input, init);
    }
    if (init?.signal?.aborted === true) throw new DOMException("The operation was aborted.", "AbortError");
    // Same-lane FIFO: a request waits for the previous response to end (the loop never overlaps them).
    const previous = this.idle;
    let release!: () => void;
    this.idle = new Promise((done) => (release = done));
    await previous;
    try {
      return await this.send(url, init!, body as Body, text!, base, release);
    } catch (error) {
      release();
      throw error;
    }
  }

  private async ensure(url: string, headers: Record<string, string>): Promise<Connection> {
    if (this.conn !== undefined && this.conn.gone === undefined) {
      if (Date.now() - this.conn.openedAt < this.settings.max_age_s * 1000) return this.conn;
      this.conn.close("connection_age");
      this.conn = undefined;
      this.resetReason = "connection_age";
    }
    this.connecting ??= this.open(url, headers).finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private open(url: string, headers: Record<string, string>): Promise<Connection> {
    const Ctor = this.options.WebSocket ?? globalThis.WebSocket;
    const started = performance.now();
    const reconnect = this.stats.connects > 0;
    return new Promise<Connection>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = new (Ctor as unknown as new (url: string, init: { headers: Record<string, string> }) => Socket)(url, { headers });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      socket.binaryType = "arraybuffer";
      const done = (error?: Error) => {
        clearTimeout(timer);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
        const ms = Math.round(performance.now() - started);
        if (error !== undefined) {
          this.emit("ws", { kind: "connect", ok: false, ms, error: error.message });
          try {
            socket.close();
          } catch { /* never opened */ }
          reject(error);
          return;
        }
        this.stats.connects++;
        if (reconnect) this.resetReason ??= "reconnect";
        this.last = undefined;
        this.conn = new Connection(socket);
        this.emit("ws", { kind: "connect", ok: true, ms, ...(reconnect ? { reconnect: true } : {}) });
        resolve(this.conn);
      };
      const onOpen = () => done();
      const onError = () => done(new Error("WebSocket handshake failed"));
      const onClose = (event: CloseEvent) => done(new Error(`WebSocket closed during the handshake (${event.code})`));
      const timer = setTimeout(() => done(new Error(`WebSocket connect timed out after ${this.settings.connect_timeout_ms} ms`)), this.settings.connect_timeout_ms);
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose);
    });
  }

  /** This request over HTTP after a WebSocket failure before its first event; past max_failures the rest of the run too. */
  private viaHttp(phase: string, why: unknown, url: string, init: RequestInit, base: Fetch, release: () => void): Promise<Response> {
    this.failures++;
    this.stats.failures++;
    const reason = why instanceof Error ? why.message : String(why);
    const scope = this.failures >= this.settings.max_failures ? "run" : "request";
    if (scope === "run") {
      this.stats.fallback = reason;
      this.conn?.close("fallback");
      this.conn = undefined;
    }
    this.last = undefined;
    this.emit("transport_fallback", { from: "ws", to: "http", phase, scope, reason, failures: this.failures });
    this.stats.http_requests++;
    release();
    return base(url, init);
  }

  private async send(url: string, init: RequestInit, body: Body, text: string, base: Fetch, release: () => void): Promise<Response> {
    const wsUrl = url.replace(/^http/u, "ws");
    const headers = handshakeHeaders(init.headers ?? undefined);
    let conn: Connection;
    try {
      conn = await this.ensure(wsUrl, headers);
    } catch (error) {
      return this.viaHttp("connect", error, url, init, base, release);
    }
    if (this.settings.prewarm && this.settings.incremental && !this.prewarmed) {
      this.prewarmed = true;
      await this.prewarm(conn, body, init.signal ?? undefined);
      if (conn.gone !== undefined) {
        try {
          conn = await this.ensure(wsUrl, headers);
        } catch (error) {
          return this.viaHttp("connect", error, url, init, base, release);
        }
      }
    }
    const { stream: _stream, background: _background, ...rest } = body;
    const bytesFull = Buffer.byteLength(text);
    const keys = this.settings.incremental ? inputKeysOf(body) : [];
    for (let attempt = 0; ; attempt++) {
      const chained = this.settings.incremental ? continuationOf(body, this.last, keys) : { reason: "incremental_off" };
      const frame: Body = "delta" in chained
        ? { type: "response.create", ...rest, previous_response_id: chained.previousResponseId, input: chained.delta }
        : { type: "response.create", ...rest };
      const reason = "delta" in chained ? undefined : chained.reason === "no_previous_response" ? (this.resetReason ?? (this.stats.ws_requests === 0 ? "first_request" : chained.reason)) : chained.reason;
      // Consumed by this frame; the response's own end (or a retry below) may set the next one.
      this.resetReason = undefined;
      const payload = JSON.stringify(frame);
      const bytes = Buffer.byteLength(payload);
      this.emit("ws", {
        kind: "request", mode: reason === undefined ? "incremental" : "full", ...(reason === undefined ? {} : { reason }),
        items: (frame.input as unknown[]).length, items_full: (body.input as unknown[]).length, bytes, bytes_full: bytesFull,
        ...("delta" in chained ? { previous_response_id: chained.previousResponseId } : {}),
        ...("detail" in chained && chained.detail !== undefined ? { detail: chained.detail } : {}),
      });
      const exchange = await this.exchange(conn, payload, body, keys, init.signal ?? undefined, release);
      if (exchange.kind === "lost") return this.viaHttp("before_events", exchange.why, url, init, base, release);
      if (exchange.kind === "error") {
        const code = String(exchange.event.error?.code ?? exchange.event.code ?? "");
        if (attempt === 0 && code === "previous_response_not_found") {
          this.resetReason = "previous_response_not_found";
          continue;
        }
        if (attempt === 0 && code === "websocket_connection_limit_reached") {
          conn.close("connection_limit");
          this.conn = undefined;
          try {
            conn = await this.ensure(wsUrl, headers);
          } catch (error) {
            return this.viaHttp("connect", error, url, init, base, release);
          }
          this.resetReason = "connection_limit";
          continue;
        }
        release();
        const status = Number(exchange.event.status ?? exchange.event.error?.status) || 400;
        return new Response(JSON.stringify({ error: isRecord(exchange.event.error) ? exchange.event.error : sseError(exchange.event) }), {
          status, headers: { "content-type": "application/json" },
        });
      }
      this.stats.ws_requests++;
      this.stats.bytes_sent += bytes;
      this.stats.bytes_full += bytesFull;
      if (reason === undefined) this.stats.incremental++;
      else {
        this.stats.full++;
        this.stats.full_reasons[reason] = (this.stats.full_reasons[reason] ?? 0) + 1;
      }
      return exchange.response;
    }
  }

  /**
   * The run's first request as `generate:false`; the real request then chains
   * from it. Failures are traced and the request goes on. It is part of that
   * request, so the request's abort (the run's hard stop, the SDK's timeout)
   * rejects it as it rejects any request; and a socket that takes the frame but
   * stays silent gets `connect_timeout_ms` before it is dropped and the request
   * goes whole on a new one (`prewarm_failed`).
   */
  private async prewarm(conn: Connection, body: Body, signal: AbortSignal | undefined): Promise<void> {
    const { stream: _stream, background: _background, ...rest } = body;
    const started = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.settings.connect_timeout_ms);
    const stop = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    let exchange: Exchange | undefined;
    let terminal: Body | undefined;
    let lost: string | undefined;
    try {
      exchange = await this.exchange(conn, JSON.stringify({ type: "response.create", ...rest, generate: false }), body, inputKeysOf(body), stop, () => undefined);
      if (exchange.kind === "stream") {
        const text = await exchange.response.text();
        const last = text.trimEnd().split("\n").filter((line) => line.startsWith("data: ")).at(-1);
        terminal = last === undefined ? undefined : JSON.parse(last.slice(6)) as Body;
      }
    } catch (error) {
      lost = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    const ms = Math.round(performance.now() - started);
    this.stats.prewarm_ms = ms;
    // The request's own abort: the request ends here, as it would mid-response (the socket is already closed).
    if (signal?.aborted === true) {
      this.emit("ws", { kind: "prewarm", ok: false, ms, error: "aborted" });
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (deadline.signal.aborted && terminal === undefined) lost = `prewarm timed out after ${this.settings.connect_timeout_ms} ms`;
    const ok = terminal?.type === "response.completed";
    if (!ok) this.resetReason = "prewarm_failed";
    const error = exchange?.kind === "error" ? String(exchange.event.error?.code ?? exchange.event.error?.message ?? exchange.event.code ?? "error")
      : exchange?.kind === "lost" ? exchange.why : lost;
    this.emit("ws", {
      kind: "prewarm", ok, ms,
      ...(terminal?.response?.id === undefined ? {} : { response_id: terminal.response.id }),
      ...(terminal?.response?.usage === undefined ? {} : { usage: terminal.response.usage }),
      ...(error === undefined ? {} : { error }),
    });
  }

  /**
   * Sends one create frame and resolves at the server's first event: an
   * `error` event before the response exists, a lost socket, or the response's
   * events as an SSE stream. A completed or incomplete response becomes the
   * continuation for the next request; any other end clears it.
   */
  private exchange(conn: Connection, payload: string, logical: Body, keys: string[], signal: AbortSignal | undefined, release: () => void): Promise<Exchange> {
    return new Promise<Exchange>((resolve, reject) => {
      const encoder = new TextEncoder();
      const output = new Map<number, unknown>();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let settled = false;
      let ended = false;
      // A consumer that stopped reading must not stop the bookkeeping: the response still ends, and is the continuation.
      const push = (op: (c: ReadableStreamDefaultController<Uint8Array>) => void) => {
        try {
          if (controller !== undefined) op(controller);
        } catch { /* the reader cancelled */ }
      };
      /** Stops listening; `streamed`: the response's stream ended, so the next request may go. */
      const end = (streamed: boolean) => {
        ended = true;
        conn.unlisten();
        signal?.removeEventListener("abort", onAbort);
        if (streamed) release();
      };
      const onData = (data: string) => {
        if (ended) return;
        let event: Body;
        try {
          event = JSON.parse(data) as Body;
        } catch {
          this.last = undefined;
          this.resetReason = "invalid_json";
          if (!settled) {
            settled = true;
            end(false);
            resolve({ kind: "error", event: { type: "error", status: 502, error: { code: "invalid_websocket_json", message: "Invalid WebSocket JSON from the server" } } });
          } else {
            end(true);
            push((c) => c.error(new Error("Invalid WebSocket JSON from the server (stream was interrupted)")));
          }
          return;
        }
        const type = typeof event.type === "string" ? event.type : "";
        if (!settled) {
          settled = true;
          if (type === "error") {
            this.last = undefined;
            this.resetReason = "error_event";
            end(false);
            resolve({ kind: "error", event });
            return;
          }
          resolve({ kind: "stream", response: new Response(new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }), { status: 200, headers: { "content-type": "text/event-stream" } }) });
        }
        if (type === "response.output_item.done" && typeof event.output_index === "number") output.set(event.output_index, event.item);
        const sse = type === "error" ? JSON.stringify(sseError(event)) : data.includes("\n") ? JSON.stringify(event) : data;
        push((c) => c.enqueue(encoder.encode(`event: ${type}\ndata: ${sse}\n\n`)));
        if (!TERMINAL.has(type)) return;
        const id = event.response?.id;
        if ((type === "response.completed" || type === "response.incomplete") && typeof id === "string") {
          // The output_item.done items, the ones pi-ai replays: response.completed lists the same items with each
          // reasoning item encrypted again (other bytes), which would never match the next input.
          const items = output.size > 0
            ? [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item)
            : Array.isArray(event.response.output) ? event.response.output as unknown[] : [];
          // Without the delta nothing chains, so nothing is kept (keys is empty).
          this.last = this.settings.incremental ? { props: propsOf(logical), inputKeys: keys, output: items, responseId: id } : undefined;
        } else {
          this.last = undefined;
          this.resetReason = type === "error" ? "error_event" : "response_failed";
        }
        end(true);
        push((c) => c.close());
      };
      const onGone = (why: string) => {
        if (ended) return;
        this.last = undefined;
        if (this.conn === conn) this.conn = undefined;
        if (!settled) {
          settled = true;
          end(false);
          resolve({ kind: "lost", why });
          return;
        }
        end(true);
        this.failures++;
        this.stats.failures++;
        const scope = this.failures >= this.settings.max_failures ? "run" : "request";
        if (scope === "run") this.stats.fallback = why;
        this.emit("transport_fallback", { from: "ws", to: "http", phase: "mid_stream", scope, reason: why, failures: this.failures });
        push((c) => c.error(new Error(`WebSocket connection lost mid-response (stream was interrupted): ${why}`)));
      };
      const onAbort = () => {
        if (ended) return;
        const error = new DOMException("The operation was aborted.", "AbortError");
        end(settled);
        this.last = undefined;
        this.resetReason = "aborted";
        conn.close("aborted");
        if (this.conn === conn) this.conn = undefined;
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        push((c) => c.error(error));
      };
      if (signal?.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      conn.listen(onData, onGone);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (conn.gone !== undefined) return onGone(conn.gone);
      try {
        conn.socket.send(payload);
      } catch (error) {
        onGone(error instanceof Error ? error.message : String(error));
      }
    });
  }
}
