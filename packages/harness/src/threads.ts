/**
 * Anthropic message threads (`wire.anthropic.thread`, beta `message-threads-2026-08-12`): the API keeps the conversation
 * for 5 minutes after each request, so a request that extends the previous one sends only its new messages
 * ("continue"), not the whole history. Time to first token stays low as the conversation grows; pricing and the prompt
 * cache are unchanged (pi-ai's cache breakpoints ride along as they are: system, last tool, last message).
 *
 * A fetch wrapper under pi-ai, so the loop and every other layer still see full requests and responses:
 * - A streamed POST to `/v1/messages` with max_tokens > 0 is threaded. If its system, tools and fixed fields match the
 *   previous request's, and its messages are the previous request's messages, then the previous response, then new
 *   ones, it goes as `thread: continue` with only the new messages and no system or tools. Anything else goes as
 *   `thread: create` with the whole conversation.
 * - The previous response's id is read from the response stream (message_start); it is used only once the stream reached
 *   message_stop, since the API stores a turn only when it completes.
 * - thread_not_found (expired, not stored), thread_already_continued and thread_continue_in_flight: the same request is
 *   replayed at once as a create with the whole conversation. thread_unsupported_request, or thread_not_found right after
 *   a replay: threads are turned off for the run and requests go out as pi-ai built them.
 * - Anything else (keep-alive pings with max_tokens 0, non-streamed or non-Messages calls) passes through untouched.
 */

const BETA = "message-threads-2026-08-12";
/** Fields that must be the same on every request of a thread (a change is a 400): compared to decide create vs continue. */
const FIXED = ["model", "tool_choice", "thinking", "context_management", "output_config", "cache_control", "mcp_servers"] as const;

type Body = Record<string, unknown> & { messages?: unknown[]; system?: unknown; tools?: unknown };
type Mode = "create" | "continue" | "replay" | "off";

export interface ThreadEvent {
  mode: Mode;
  /** Request body bytes as sent, and as pi-ai built it (the full conversation). */
  bytes: number;
  full_bytes: number;
  /** Why a continue was not possible, or why threads went off. */
  reason?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A value with every cache_control removed: pi-ai moves its last-message breakpoint each turn. */
function withoutCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (key !== "cache_control") out[key] = withoutCacheControl(item);
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(withoutCacheControl(a)) === JSON.stringify(withoutCacheControl(b));

function headerList(init: RequestInit | undefined): Headers {
  return new Headers(init?.headers ?? {});
}

interface Previous {
  body: Body;
  betas: string;
  /** The response id to continue from; undefined while its stream runs or if it never completed. */
  id: string | undefined;
  /** Settles when the response stream has been read to its end. */
  done: Promise<void> | undefined;
}

export class AnthropicThreads {
  readonly #base: typeof fetch;
  readonly #onEvent: ((event: ThreadEvent) => void) | undefined;
  #previous: Previous | undefined;
  #off = false;
  /** The last request was a replay: a continue lost right after it means the API can't keep this conversation. */
  #replayedLast = false;

  constructor(options: { base: typeof fetch; onEvent?: (event: ThreadEvent) => void }) {
    this.#base = options.base;
    this.#onEvent = options.onEvent;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (this.#off || (init?.method ?? "GET").toUpperCase() !== "POST" || !/\/v1\/messages(\?|$)/u.test(url) || typeof init?.body !== "string") {
      return this.#base(input, init);
    }
    let body: Body;
    try {
      body = JSON.parse(init.body) as Body;
    } catch {
      return this.#base(input, init);
    }
    if (body.stream !== true || typeof body.max_tokens !== "number" || body.max_tokens <= 0 || !Array.isArray(body.messages)) return this.#base(input, init);

    const headers = headerList(init);
    const betas = [...new Set([...(headers.get("anthropic-beta") ?? "").split(",").map((item) => item.trim()).filter(Boolean), BETA])].join(",");
    headers.set("anthropic-beta", betas);
    headers.delete("content-length");
    const fullBytes = init.body.length;
    const send = (payload: Body) => this.#base(input, { ...init, headers, body: JSON.stringify(payload) });

    // The previous response's stream is read in parallel; wait for it to finish (it normally has) before deciding.
    if (this.#previous?.done !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([this.#previous.done, new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
          timer.unref();
        })]);
      } finally {
        clearTimeout(timer);
      }
    }
    const previous = this.#previous;
    const reason = this.#continueProblem(previous, body, betas);
    let mode: Mode = reason === undefined ? "continue" : "create";
    let payload: Body = mode === "continue" ? this.#continueBody(body, previous!) : { ...body, thread: { type: "create" } };
    const entry: Previous = { body, betas, id: undefined, done: undefined };
    this.#previous = entry;
    const goOff = (code: string | undefined) => {
      this.#off = true;
      this.#previous = undefined;
      this.#event("off", fullBytes, fullBytes, code);
      return this.#base(input, init);
    };
    let response = await send(payload);
    if (!response.ok) {
      const error = await errorCode(response);
      if (error.code === "thread_unsupported_request") return goOff(error.code);
      const lost = error.code === "thread_not_found" || error.code === "thread_already_continued" || error.code === "thread_continue_in_flight";
      if (mode !== "continue" || !lost) {
        this.#previous = undefined;
        return error.response;
      }
      // A conversation the API can't store: lost again right after a replay.
      if (error.code === "thread_not_found" && this.#replayedLast) return goOff("thread_not_found after a replay");
      mode = "replay";
      payload = { ...body, thread: { type: "create" } };
      response = await send(payload);
      if (!response.ok) {
        const again = await errorCode(response);
        if (again.code === "thread_unsupported_request") return goOff(again.code);
        this.#previous = undefined;
        return again.response;
      }
    }
    this.#replayedLast = mode === "replay";
    this.#event(mode, JSON.stringify(payload).length, fullBytes, mode === "continue" ? undefined : mode === "replay" ? "thread lost" : reason);
    return this.#watch(response, entry);
  };

  /** Undefined when `body` continues the previous request; else why not. */
  #continueProblem(previous: Previous | undefined, body: Body, betas: string): string | undefined {
    if (previous === undefined) return "first request";
    if (previous.id === undefined) return "previous response not complete";
    if (previous.betas !== betas) return "betas changed";
    for (const field of FIXED) if (!same(previous.body[field], body[field])) return `${field} changed`;
    if (!same(previous.body.system, body.system)) return "system changed";
    if (!same(previous.body.tools, body.tools)) return "tools changed";
    const before = previous.body.messages ?? [];
    const now = body.messages ?? [];
    if (now.length <= before.length + 1) return "no new messages";
    if (!same(before, now.slice(0, before.length))) return "history changed";
    const reply = now[before.length];
    if (!isRecord(reply) || reply.role !== "assistant") return "no assistant reply after the previous request";
    return undefined;
  }

  #continueBody(body: Body, previous: Previous): Body {
    const { system: _system, tools: _tools, messages, ...rest } = body;
    return { ...rest, messages: (messages ?? []).slice((previous.body.messages ?? []).length + 1), thread: { type: "continue", previous_message_id: previous.id } };
  }

  /** Passes the stream through, reading a copy for the response id and its completion. */
  #watch(response: Response, entry: Previous): Response {
    if (response.body === null) return response;
    const [mine, theirs] = response.body.tee();
    entry.done = (async () => {
      const reader = mine.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let id: string | undefined;
      let stopped = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            try {
              const event = JSON.parse(line.slice(5).trim()) as { type?: string; message?: { id?: string }; delta?: { stop_reason?: string } };
              if (event.type === "message_start" && typeof event.message?.id === "string") id = event.message.id;
              if (event.type === "message_delta" && event.delta?.stop_reason === "refusal") id = undefined;
              if (event.type === "message_stop") stopped = true;
            } catch {
              /* not JSON */
            }
          }
        }
      } catch {
        /* aborted: the turn wasn't stored */
      }
      if (stopped && id !== undefined && this.#previous === entry) entry.id = id;
    })();
    return new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  #event(mode: Mode, bytes: number, fullBytes: number, reason?: string): void {
    this.#onEvent?.({ mode, bytes, full_bytes: fullBytes, ...(reason === undefined ? {} : { reason }) });
  }
}

/** A failed response's thread error code, and the response rebuilt so pi-ai can still read it. */
async function errorCode(response: Response): Promise<{ code: string | undefined; response: Response }> {
  const text = await response.text();
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as { error?: { details?: { error_code?: unknown } } };
    code = typeof parsed.error?.details?.error_code === "string" ? parsed.error.details.error_code : undefined;
  } catch {
    code = undefined;
  }
  return { code, response: new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }) };
}
