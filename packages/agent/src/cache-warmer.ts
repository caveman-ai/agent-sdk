import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, CacheRetention, Model } from "@earendil-works/pi-ai";
import { catalogCacheMode, catalogCost } from "./catalog.js";
import { validateProviderUsage, type ValidatedProviderUsage } from "./execution-kernel.js";

/**
 * Prompt-cache warming, after Pi's `cache-warmer.ts` (streaming mode).
 *
 * While a run's tools execute, the provider cache entry the last request wrote
 * can expire. Re-sending that exact request with a tiny output cap before the
 * entry's lifetime ends keeps it warm, when the expected avoided miss beats
 * the refresh price by Pi's threshold. Every input is fail-closed: an unknown
 * lifetime, price, or cache billing mode means no refresh. The expected saving
 * is a local catalog estimate and stays `inferred`; it is never receipted as a
 * saving.
 */
export type CacheWarmingMode = "off" | "streaming";

/** Pi's threshold: a refresh is sent only when it is expected to save at least this. */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS_USD = 0.05;
/** Largest output any pi-ai API forces on a one-token warm (OpenAI Responses floors at 16). */
export const CACHE_WARM_OUTPUT_TOKENS = 16;
/** How long the next real request waits for an in-flight refresh before abandoning it. */
export const CACHE_WARM_QUIESCE_MS = 5_000;
/** Pi: streaming warming never continues past this long after the request that started it. */
const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Top-level output caps pi-ai writes. Any other difference makes a request not replayable. */
const OUTPUT_CAP_KEYS = new Set(["max_tokens", "max_output_tokens", "max_completion_tokens"]);

/** Pi: refresh at 90% of the lifetime while keeping at least ten seconds of margin. */
export function cacheWarmingDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/** Lifetime of the entry a request writes, from pi-ai `promptCache`; undefined when unknown or off. */
export function promptCacheTtlMs(
  model: Model<Api>,
  retention: CacheRetention | undefined,
  env?: Readonly<Record<string, string | undefined>>,
): number | undefined {
  // pi-ai reads the variable from the request's env, else the process's.
  const tier = retention ?? ((env?.PI_CACHE_RETENTION || process.env.PI_CACHE_RETENTION) === "long" ? "long" : "short");
  if (tier === "none") return undefined;
  const seconds = model.promptCache?.[tier];
  return seconds === undefined ? undefined : seconds * 1000;
}

/**
 * Pi: Anthropic budget thinking derives `budget_tokens` from `max_tokens`, so a
 * one-token replay changes the cache key. Adaptive thinking is replayable.
 */
export function isReplayable(model: Model<Api>, reasoning: unknown): boolean {
  if (!reasoning || model.api !== "anthropic-messages") return true;
  return (model.compat as { forceAdaptiveThinking?: boolean } | undefined)?.forceAdaptiveThinking === true;
}

export interface CacheWarmDecision {
  /** A cache read of the prompt plus the warm output allowance. */
  readonly warmCostUsd: number;
  /** Extra list price of the next request if the entry is lost. */
  readonly missCostUsd: number;
  readonly expectedSavingsUsd: number;
  readonly basis: "inferred";
  readonly action: "warm" | "stop";
}

/**
 * Pi's streaming-phase economics priced by the SDK catalog. Undefined when the
 * prompt size, the catalog's cache billing mode, or any rate it needs is
 * unknown: no economics, no warm. An explicit cache bills a miss as a cache
 * write; implicit, automatic, and affinity caches bill it as fresh input.
 */
export function cacheWarmDecision(
  provider: string,
  model: string,
  promptTokens: number,
  accountingAt: Date,
): CacheWarmDecision | undefined {
  if (!Number.isSafeInteger(promptTokens) || promptTokens <= 0) return undefined;
  const mode = catalogCacheMode(provider, model, accountingAt);
  if (mode !== "explicit" && mode !== "implicit" && mode !== "automatic" && mode !== "affinity") return undefined;
  const price = (tokens: Partial<Record<"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens", number>>) =>
    catalogCost({
      provider, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, ...tokens,
    }, accountingAt);
  const hit = price({ cacheReadTokens: promptTokens });
  const miss = price(mode === "explicit" ? { cacheWriteTokens: promptTokens } : { inputTokens: promptTokens });
  const warm = price({ cacheReadTokens: promptTokens, outputTokens: CACHE_WARM_OUTPUT_TOKENS });
  if (!hit.priced || !miss.priced || !warm.priced || hit.usd <= 0) return undefined;
  const missCostUsd = Math.max(0, miss.usd - hit.usd);
  const expectedSavingsUsd = missCostUsd - warm.usd;
  return Object.freeze({
    warmCostUsd: warm.usd,
    missCostUsd,
    expectedSavingsUsd,
    basis: "inferred",
    action: expectedSavingsUsd >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS_USD ? "warm" : "stop",
  });
}

/**
 * The sent request with only its output cap taken from the freshly built warm
 * request. Undefined, so nothing is sent, unless the fresh build equals the
 * original build everywhere except a top-level output cap that bounds the warm.
 */
export function warmPayload(fresh: unknown, raw: unknown, sent: unknown): unknown {
  if (!isObject(fresh) || !isObject(raw) || !isObject(sent)) return undefined;
  const keys = new Set([...Object.keys(fresh), ...Object.keys(raw)]);
  const caps: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(fresh[key]) === JSON.stringify(raw[key])) continue;
    if (!OUTPUT_CAP_KEYS.has(key)) return undefined;
    caps.push(key);
  }
  if (caps.length === 0 || caps.some((key) =>
    typeof fresh[key] !== "number" || (fresh[key] as number) > CACHE_WARM_OUTPUT_TOKENS)) {
    return undefined;
  }
  const replay = structuredClone(sent);
  for (const key of caps) replay[key] = fresh[key];
  return replay;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One real request as sent: pi-ai's build and the bytes that left, captured in onPayload. */
export interface CacheWarmRequest {
  readonly model: Model<Api>;
  readonly context: Parameters<StreamFn>[1];
  readonly options: Parameters<StreamFn>[2];
  raw?: unknown;
  sent?: unknown;
}

/**
 * Sends one warm, abandoned when `signal` or the request's own signal aborts.
 * `beforeSend` runs once the replay is verified, immediately before the
 * request can leave, so the caller makes its intent durable there. Undefined:
 * refused before sending. `usage` undefined: it may have billed but is
 * unreadable or was abandoned, so the caller settles it at worst case.
 */
export async function sendCacheWarm(
  stream: StreamFn,
  request: CacheWarmRequest,
  accountingAt: Date,
  requirePriced: boolean,
  beforeSend: () => Promise<void>,
  signal: AbortSignal,
): Promise<{ readonly usage?: ValidatedProviderUsage; readonly ok: boolean } | undefined> {
  let reached = false;
  let returned = false;
  const warmSignal = request.options?.signal === undefined ? signal : AbortSignal.any([signal, request.options.signal]);
  // A provider that ignores the signal must not hold the warm, and with it the run, open.
  const abandoned = new Promise<never>((_, reject) => {
    if (warmSignal.aborted) reject(warmSignal.reason);
    warmSignal.addEventListener("abort", () => reject(warmSignal.reason), { once: true });
  });
  abandoned.catch(() => undefined);
  let message: AssistantMessage;
  try {
    const source = await Promise.race([stream(request.model, request.context, {
      ...request.options,
      maxTokens: 1,
      signal: warmSignal,
      onPayload: async (fresh) => {
        // A transport finishing its setup after the warm was abandoned must not send it.
        if (warmSignal.aborted || returned) throw new Error("cave_cache_warm_abandoned");
        const replay = warmPayload(fresh, request.raw, request.sent);
        if (replay === undefined) throw new Error("cave_cache_warm_not_replayable");
        reached = true;
        await beforeSend();
        return replay;
      },
    }), abandoned]);
    message = await Promise.race([source.result(), abandoned]);
  } catch {
    returned = true;
    return reached ? { ok: false } : undefined;
  }
  returned = true;
  if (!reached) return undefined;
  const used = message.usage;
  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  // An abandoned warm may have billed, whatever its stream reports afterwards.
  if (failed && warmSignal.aborted) return { ok: false };
  // A failure that reported no usage at all billed nothing, as for a working call.
  const billed = !failed || Boolean(used.input || used.output || used.cacheRead || used.cacheWrite);
  try {
    const usage = validateProviderUsage(billed ? {
      provider: message.provider, model: message.model, inputTokens: used.input, outputTokens: used.output,
      cacheReadTokens: used.cacheRead, cacheWriteTokens: used.cacheWrite, reasoningTokens: used.reasoning ?? 0,
      totalTokens: used.totalTokens,
    } : {
      provider: request.model.provider, model: request.model.id, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0,
    }, { expected: { provider: request.model.provider, model: request.model.id }, requirePriced, accountingAt });
    return { usage, ok: !failed };
  } catch {
    return { ok: false };
  }
}

/**
 * One timer per run. `start` replaces any earlier request; `stop` cancels the
 * timer and resolves once an in-flight refresh has settled, so the caller can
 * quiesce warming before the next real request or the run's receipt.
 */
export class CacheWarmer {
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #abort: AbortController | undefined;

  /**
   * Wraps the real request stream: captures each request's exact payload and,
   * once it completes with tool calls, keeps the entry it wrote warm when its
   * lifetime is known and a replay is safe. Timing counts from its start.
   */
  wrap(stream: StreamFn, refresh: (request: CacheWarmRequest, signal: AbortSignal) => Promise<boolean>): StreamFn {
    return async (model, context, options) => {
      await this.stop(CACHE_WARM_QUIESCE_MS);
      const generation = this.#generation;
      const startedAt = Date.now();
      const ttlMs = promptCacheTtlMs(model, options?.cacheRetention, options?.env);
      if (ttlMs === undefined || !isReplayable(model, options?.reasoning)) return stream(model, context, options);
      const request: CacheWarmRequest = { model, context, options };
      const result = await stream(model, context, {
        ...options,
        async onPayload(payload, providerModel) {
          const replaced = await options?.onPayload?.(payload, providerModel);
          request.raw = structuredClone(payload);
          request.sent = structuredClone(replaced === undefined ? payload : replaced);
          return replaced === undefined ? payload : replaced;
        },
      });
      result.result().then((message) => {
        // Streaming warming covers the tools a turn runs; any other turn ends the run or failed.
        if (generation !== this.#generation || message.stopReason !== "toolUse") return;
        this.start(ttlMs, (signal) => refresh(request, signal), startedAt);
      }, () => undefined);
      return result;
    };
  }

  /** `refresh` returns whether warming should continue for this request. */
  start(ttlMs: number, refresh: (signal: AbortSignal) => Promise<boolean>, startedAt = Date.now()): void {
    void this.stop();
    const delayMs = cacheWarmingDelayMs(ttlMs);
    if (delayMs === undefined) return;
    const generation = this.#generation;
    const schedule = (from: number): void => {
      const dueAt = from + delayMs;
      // A timer that fires late (sleep, blocked loop) keeps half the planned
      // margin; past it a refresh is likely a full-price write, not a warm.
      const deadlineAt = dueAt + Math.floor((ttlMs - delayMs) / 2);
      if (dueAt > startedAt + MAX_WARMING_AGE_MS || Date.now() > deadlineAt) return;
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        if (generation !== this.#generation || Date.now() > deadlineAt) return;
        const sentAt = Date.now();
        const abort = new AbortController();
        // A refresh still unanswered when the entry would have expired is lost either way.
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(ttlMs - delayMs)]);
        const inFlight: Promise<void> = refresh(signal).catch(() => false).then((again) => {
          if (this.#inFlight === inFlight) {
            this.#inFlight = undefined;
            this.#abort = undefined;
          }
          if (again && generation === this.#generation) schedule(sentAt);
        });
        this.#inFlight = inFlight;
        this.#abort = abort;
      }, Math.max(0, dueAt - Date.now()));
      this.#timer.unref?.();
    };
    schedule(startedAt);
  }

  /**
   * A refresh still in flight after `graceMs` is aborted and settles at worst
   * case: quiescing before a real request waits; teardown passes nothing.
   */
  async stop(graceMs = 0): Promise<void> {
    this.#generation++;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    const inFlight = this.#inFlight;
    if (inFlight === undefined) return;
    if (graceMs > 0) {
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([inFlight, new Promise<void>((resolve) => {
        grace = setTimeout(resolve, graceMs);
      })]);
      clearTimeout(grace);
    }
    this.#abort?.abort(new Error("cave_cache_warm_stopped"));
    await inFlight;
  }
}
