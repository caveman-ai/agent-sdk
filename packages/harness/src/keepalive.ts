/**
 * wire.anthropic.keepalive_s: keep Anthropic's 5-minute prompt cache warm while a long tool call runs.
 *
 * The cache entry for a request's prefix lives 5 minutes from the start of the last request that read or wrote it.
 * When a command or a wait runs longer than that, the next request rewrites the whole history at the write price
 * (1.25x input) instead of reading it at the read price (0.05x on Opus 5.5). On 196 Opus 5.5 trials of the v3 harness
 * these expiries cost 6.0% of spend (0.31 per trial, median gap 584 s; iters/r7-plan.md 2026-11-06).
 *
 * The keep-alive is Anthropic's documented pattern: re-send the last request with `max_tokens: 0` and `stream: false`
 * shortly before the entry expires. The API runs prefill only, refreshes the entry's timer, returns no content and
 * bills only the cache read. Every byte that renders into the prompt (system, tools, messages, thinking, effort) is the
 * last request's own, sent with the last request's own headers, so it reads exactly the entry the next request needs.
 *
 * It sits in the request path as a fetch wrapper: each streamed POST to /v1/messages is remembered and arms a timer for
 * `intervalMs`; when the timer fires before another request starts, the remembered request is re-sent and the timer is
 * re-armed from that ping's start (the TTL counts from a request's start). At most `maxPerGap` pings follow one real
 * request, so a job that runs for hours stops costing reads and lets the entry go. A ping's usage is reported through
 * `onPing` (the recorder counts it as a side request, so budgets see it). A failed ping is reported and changes nothing.
 */

export interface KeepAliveUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface KeepAliveOptions {
  intervalMs: number;
  maxPerGap: number;
  /** The fetch every request (and every ping) goes through. */
  base: typeof fetch;
  onPing: (usage: KeepAliveUsage | undefined, latencyMs: number, error?: string) => void;
}

interface Remembered {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export class CacheKeepAlive {
  readonly #options: KeepAliveOptions;
  #last: Remembered | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pings = 0;
  #closed = false;

  constructor(options: KeepAliveOptions) {
    this.#options = options;
  }

  /** Pings sent since the last real request. */
  get pingsInGap(): number {
    return this.#pings;
  }

  readonly fetch: typeof fetch = (input, init) => {
    this.#remember(input, init);
    return this.#options.base(input, init);
  };

  /** Forgets the remembered request and stops pinging it; the next real request arms the timer again. */
  pause(): void {
    this.#last = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #remember(input: Parameters<typeof fetch>[0], init: RequestInit | undefined): void {
    if (this.#closed || (init?.method ?? "GET").toUpperCase() !== "POST" || typeof init?.body !== "string") return;
    const url = urlOf(input);
    if (!/\/v1\/messages(?:\?|$)/u.test(url)) return;
    let body: unknown;
    try {
      body = JSON.parse(init.body);
    } catch {
      return;
    }
    // Only the agent loop's streamed turns: a ping (stream false) or a token count must not re-arm the timer.
    if (!isRecord(body) || body.stream !== true) return;
    const headers = new Headers(init.headers);
    headers.delete("content-length");
    this.#last = { url, headers, body };
    this.#pings = 0;
    this.#arm();
  }

  #arm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#closed || this.#last === undefined || this.#pings >= this.#options.maxPerGap) return;
    this.#timer = setTimeout(() => void this.#ping(), this.#options.intervalMs);
    (this.#timer as { unref?: () => void }).unref?.();
  }

  async #ping(): Promise<void> {
    const last = this.#last;
    if (this.#closed || last === undefined || this.#pings >= this.#options.maxPerGap) return;
    this.#pings++;
    const started = performance.now();
    this.#arm();
    try {
      const response = await this.#options.base(last.url, {
        method: "POST",
        headers: last.headers,
        body: JSON.stringify({ ...last.body, max_tokens: 0, stream: false }),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      const latency = performance.now() - started;
      if (!response.ok) {
        const message = isRecord(json) && isRecord(json.error) && typeof json.error.message === "string" ? json.error.message : text.slice(0, 200);
        this.#options.onPing(undefined, latency, `HTTP ${response.status}: ${message}`);
        return;
      }
      const usage = isRecord(json) && isRecord(json.usage) ? json.usage : {};
      this.#options.onPing({
        input: count(usage.input_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite: count(usage.cache_creation_input_tokens),
        output: count(usage.output_tokens),
      }, latency);
    } catch (error) {
      this.#options.onPing(undefined, performance.now() - started, error instanceof Error ? error.message : String(error));
    }
  }
}
