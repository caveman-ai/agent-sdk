// TS port of the deterministic planner core in the Caveman Cloud server's Go
// cache engine, plus its drift/volatile guard. The Go engine
// is the source of truth; tests/cache-planner-parity.runtime.mjs asserts this
// port against Go-exported fixtures. Plans use input-rate units, never dollars.
import { createHash } from "node:crypto";
import type {
  CacheBreakpoint,
  CacheEngineConfig,
  CachePlan,
  CachePlanProfile,
  CachePlanProfileInput,
  CachePlanRequest,
  CachePlanSegment,
} from "./types.js";
import {
  ReasonApplied,
  ReasonBelowMinimum,
  ReasonNegativeEconomics,
  ReasonNoExpectedReuse,
  ReasonNoStablePrefix,
  ReasonPrefixDrift,
  ReasonProviderManaged,
  ReasonUnsupported,
  ReasonVolatilePrefix,
} from "./types.js";

const MAX_CONFIGURED_KEY_SHARDS = 1_000_000;
const DEFAULT_INPUT_BYTE_LIMIT = 64 << 20;
const MAX_CONFIGURED_BYTE_LIMIT = 1 << 30;
const EPOCH_CAP = 8192;

export function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

/** Content-blind volatile-prefix patterns, ported from cacheguard. */
const VOLATILE_PATTERNS: readonly RegExp[] = [
  /\b20[0-9]{2}-[01][0-9]-[0-3][0-9][T ][0-2][0-9]:[0-5][0-9](?::[0-6][0-9](?:\.[0-9]+)?)?(?:Z|[+-][0-2][0-9]:?[0-5][0-9])?\b/,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  /["'](?:run|request|build|trace|span)[_-]?id["']\s*:/i,
  /["']nonce["']\s*:/i,
];

/** True when the prefix bytes match a volatile pattern (timestamps, UUIDs, …). */
export function detectVolatile(prefix: Uint8Array): boolean {
  // latin1 keeps a 1:1 byte-to-char mapping, matching Go's byte-level regexes.
  const text = Buffer.from(prefix).toString("latin1");
  return VOLATILE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Cache-plan engine: stable-prefix frontier, break-even math, volatile/drift
 * guard, scoped affinity-key sharding. Byte limits fail closed; every
 * validation error throws rather than producing a guessed plan.
 */
export class CachePlanEngine {
  private readonly maxKeyShards: number;
  readonly maxRequestBytes: number;
  private readonly maxStablePrefixBytes: number;
  /** epoch key -> frozen prefix sha256, insertion-ordered for eviction. */
  private readonly epochs = new Map<string, string>();

  constructor(config: CacheEngineConfig = {}) {
    const shards = config.maxKeyShards ?? 0;
    const requestBytes = config.maxRequestBytes ?? 0;
    const prefixBytes = config.maxStablePrefixBytes ?? 0;
    if (!Number.isSafeInteger(shards) || shards < 0 || shards > MAX_CONFIGURED_KEY_SHARDS) {
      throw new Error(`cache planner: max key shards must be within 0..${MAX_CONFIGURED_KEY_SHARDS}`);
    }
    if (!Number.isSafeInteger(requestBytes) || requestBytes < 0 || requestBytes > MAX_CONFIGURED_BYTE_LIMIT) {
      throw new Error(`cache planner: max request bytes must be within 0..${MAX_CONFIGURED_BYTE_LIMIT}`);
    }
    if (!Number.isSafeInteger(prefixBytes) || prefixBytes < 0 || prefixBytes > MAX_CONFIGURED_BYTE_LIMIT) {
      throw new Error(`cache planner: max stable prefix bytes must be within 0..${MAX_CONFIGURED_BYTE_LIMIT}`);
    }
    this.maxKeyShards = shards === 0 ? 64 : shards;
    this.maxRequestBytes = requestBytes === 0 ? DEFAULT_INPUT_BYTE_LIMIT : requestBytes;
    this.maxStablePrefixBytes = prefixBytes === 0 ? DEFAULT_INPUT_BYTE_LIMIT : prefixBytes;
  }

  /** Selects profitable stable-prefix cache boundaries without editing wire bytes. */
  plan(request: CachePlanRequest): CachePlan {
    validatePlanRequest(request);
    const profile = normalizedProfile(request.profile);
    const plan: CachePlan = {
      decision: "pass_through",
      reason: ReasonUnsupported,
      profile_id: profile.id,
      mode: profile.mode,
      attribution: profile.attribution,
      key_shard: 0,
      key_shard_count: 1,
      expected_net_input_rate_units: 0,
      economics_basis: "modeled_input_rate_units",
    };
    if (!profile.economicsKnown) {
      plan.economics_basis = "unavailable";
      plan.warnings = [...(plan.warnings ?? []), "cache_economics_unavailable"];
    }
    if (profile.mode === "unsupported") return finalize(plan);

    const { prefix, stable } = stablePrefix(request.segments, this.maxStablePrefixBytes);
    if (stable.length === 0) {
      plan.reason = ReasonNoStablePrefix;
      return finalize(plan);
    }
    const prefixSha256 = sha256Hex(prefix);
    if (detectVolatile(prefix)) {
      plan.reason = ReasonVolatilePrefix;
      plan.warnings = ["volatile_stable_slot"];
      return finalize(plan);
    }

    plan.prefix_sha256 = prefixSha256;
    const key = epochKey(request.scope, request.epoch, profile.id);
    const previous = this.epochs.get(key);
    if (previous === undefined) {
      this.epochs.set(key, prefixSha256);
      while (this.epochs.size > EPOCH_CAP) {
        const oldest = this.epochs.keys().next().value as string;
        this.epochs.delete(oldest);
      }
    } else if (previous !== prefixSha256) {
      plan.warnings = [...(plan.warnings ?? []), "prefix_drift"];
      plan.reason = ReasonPrefixDrift;
      return finalize(plan);
    }

    let expectedCalls = request.expectedCalls ?? 0;
    if (expectedCalls === 0) expectedCalls = 2;
    if (expectedCalls < 2) {
      plan.reason = ReasonNoExpectedReuse;
      return finalize(plan);
    }

    const { candidates, belowMinimum, negative } =
      breakpointCandidates(stable, expectedCalls, profile);
    if (candidates.length === 0) {
      plan.reason = belowMinimum
        ? ReasonBelowMinimum
        : negative
          ? ReasonNegativeEconomics
          : ReasonNoStablePrefix;
      return finalize(plan);
    }
    const limited = limitBreakpoints(candidates, profile.maxBreakpoints);
    plan.breakpoints = limited.map(({ index: _index, ...breakpoint }) => breakpoint);
    if (allTokenCountsUnavailable(plan.breakpoints)) {
      plan.economics_basis = "unavailable";
      plan.warnings = [...(plan.warnings ?? []), "token_count_unavailable"];
    }
    for (const breakpoint of plan.breakpoints) {
      if (breakpoint.expected_net_input_rate_units > plan.expected_net_input_rate_units) {
        plan.expected_net_input_rate_units = breakpoint.expected_net_input_rate_units;
      }
    }
    if (profile.mode === "implicit") {
      for (const breakpoint of plan.breakpoints) breakpoint.expected_net_input_rate_units = 0;
      plan.expected_net_input_rate_units = 0;
      plan.economics_basis = "provider_managed_unattributed";
    }
    if (profile.routingKey) {
      const { count, shard, capped } = keyShard(request, profile, this.maxKeyShards);
      plan.key_shard_count = count;
      plan.key_shard = shard;
      plan.routing_key = routingKey(request.scope, profile.id, plan.prefix_sha256, shard);
      if (capped) plan.warnings = [...(plan.warnings ?? []), "routing_key_shard_cap_reached"];
    }
    if (profile.mode === "implicit") {
      plan.decision = "observe_only";
      plan.reason = ReasonProviderManaged;
      return finalize(plan);
    }
    plan.decision = "apply";
    plan.reason = ReasonApplied;
    return finalize(plan);
  }
}

/** Strips Go-omitempty-absent fields so the plan equals the Go JSON exactly. */
function finalize(plan: CachePlan): CachePlan {
  if (plan.prefix_sha256 === undefined || plan.prefix_sha256 === "") delete plan.prefix_sha256;
  if (plan.routing_key === undefined || plan.routing_key === "") delete plan.routing_key;
  if (plan.breakpoints === undefined || plan.breakpoints.length === 0) delete plan.breakpoints;
  if (plan.warnings === undefined || plan.warnings.length === 0) delete plan.warnings;
  return plan;
}

export function validIdentity(value: string, maximum: number, allowEmpty: boolean): boolean {
  if (value !== value.trim() || byteLength(value) > maximum || (!allowEmpty && value === "")) {
    return false;
  }
  // Go unicode.IsControl: C0, DEL, and C1 control characters.
  return !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function validatePlanRequest(request: CachePlanRequest): void {
  if (!validIdentity(request.scope, 4096, false)) throw new Error("cache planner: invalid scope");
  if (!validIdentity(request.epoch, 4096, false)) throw new Error("cache planner: invalid epoch");
  if (!validIdentity(request.partitionKey ?? "", 4096, true)) {
    throw new Error("cache planner: invalid partition key");
  }
  if ((request.expectedCalls ?? 0) < 0 || (request.expectedRequestsPerMinute ?? 0) < 0) {
    throw new Error("cache planner: negative traffic expectation");
  }
  const profile = normalizedProfile(request.profile);
  if (!validIdentity(profile.id, 256, false) || !validIdentity(profile.provider ?? "", 64, true) ||
      !validIdentity(profile.optimizerId, 256, true)) {
    throw new Error("cache planner: invalid profile identity");
  }
  if (!["unsupported", "implicit", "affinity", "explicit"].includes(profile.mode)) {
    throw new Error(`cache planner: unknown mode ${JSON.stringify(profile.mode)}`);
  }
  if (profile.mode !== "unsupported") {
    if (profile.maxBreakpoints <= 0 || profile.minPrefixTokens < 0 ||
        profile.maxRpmPerKey < 0 || profile.ttlSeconds < 0) {
      throw new Error("cache planner: invalid cache thresholds");
    }
    if (!["none", "organic", "affinity", "causal"].includes(profile.attribution)) {
      throw new Error(`cache planner: unknown attribution ${JSON.stringify(profile.attribution)}`);
    }
    if (profile.economicsKnown &&
        (!finiteNonNegative(profile.writeMultiplier) || !finiteNonNegative(profile.readMultiplier))) {
      throw new Error("cache planner: invalid cache economics");
    }
  }
}

export function normalizedProfile(input: CachePlanProfileInput): CachePlanProfile {
  const profile: CachePlanProfile = {
    id: input.id,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    mode: input.mode,
    attribution: input.attribution ?? "",
    minPrefixTokens: input.minPrefixTokens ?? 0,
    maxBreakpoints: input.maxBreakpoints ?? 0,
    economicsKnown: input.economicsKnown ?? false,
    writeMultiplier: input.writeMultiplier ?? 0,
    readMultiplier: input.readMultiplier ?? 0,
    ttlSeconds: input.ttlSeconds ?? 0,
    rolling: input.rolling ?? false,
    routingKey: input.routingKey ?? false,
    maxRpmPerKey: input.maxRpmPerKey ?? 0,
    optimizerId: input.optimizerId ?? "",
  };
  if (profile.mode === "unsupported") {
    if (profile.id === "") profile.id = "unsupported";
    return profile;
  }
  if (profile.maxBreakpoints === 0) profile.maxBreakpoints = 1;
  if (profile.maxRpmPerKey === 0) profile.maxRpmPerKey = 15;
  if (profile.attribution === "") profile.attribution = "none";
  return profile;
}

interface StablePrefix {
  prefix: Uint8Array;
  stable: Array<{ name: string; tokens: number; expectedCalls: number; content: Uint8Array }>;
}

function stablePrefix(
  segments: readonly CachePlanSegment[],
  maxBytes: number,
): StablePrefix {
  let prefix: Buffer = Buffer.alloc(0);
  const stable: StablePrefix["stable"] = [];
  const seenNames = new Set<string>();
  for (const segment of segments) {
    if (segment.stable !== true || segment.cacheable !== true) break;
    const content = contentBytes(segment.content);
    if (!validIdentity(segment.name, 1024, false) || content.length === 0 ||
        seenNames.has(segment.name)) {
      throw new Error("cache planner: stable segment needs name and content");
    }
    seenNames.add(segment.name);
    const tokens = segment.tokens ?? 0;
    const expectedCalls = segment.expectedCalls ?? 0;
    if (tokens < 0 || expectedCalls < 0) {
      throw new Error("cache planner: negative segment measurement");
    }
    const nameBytes = Buffer.byteLength(segment.name, "utf8");
    if (maxBytes < 8 || nameBytes > maxBytes - 8 || content.length > maxBytes - 8 - nameBytes ||
        prefix.length > maxBytes - 8 - nameBytes - content.length) {
      throw new Error("cache planner: stable prefix exceeds configured byte limit");
    }
    prefix = appendFrame(prefix, segment.name, content);
    stable.push({ name: segment.name, tokens, expectedCalls, content });
  }
  return { prefix, stable };
}

export function appendFrame(dst: Buffer, name: string, content: Uint8Array): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32BE(nameBytes.length, 0);
  lengths.writeUInt32BE(content.length, 4);
  return Buffer.concat([dst, lengths, nameBytes, Buffer.from(content)]);
}

interface IndexedBreakpoint extends CacheBreakpoint {
  index: number;
}

function breakpointCandidates(
  segments: StablePrefix["stable"],
  defaultCalls: number,
  profile: CachePlanProfile,
): { candidates: IndexedBreakpoint[]; belowMinimum: boolean; negative: boolean } {
  const candidates: IndexedBreakpoint[] = [];
  let prefix: Buffer = Buffer.alloc(0);
  let cumulativeTokens = 0;
  let previousCalls = Number.MAX_SAFE_INTEGER;
  let belowMinimum = false;
  let negative = false;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    prefix = appendFrame(prefix, segment.name, segment.content);
    if (segment.tokens > Number.MAX_SAFE_INTEGER - cumulativeTokens) {
      throw new Error("cache planner: cumulative token count overflow");
    }
    cumulativeTokens += segment.tokens;
    let calls = segment.expectedCalls;
    if (calls === 0) calls = defaultCalls;
    if (calls > previousCalls) {
      throw new Error("cache planner: longer prefix cannot have higher expected reuse");
    }
    previousCalls = calls;
    if (calls < 2) continue;
    if (cumulativeTokens > 0 && cumulativeTokens < profile.minPrefixTokens) {
      belowMinimum = true;
      continue;
    }
    let net = 0;
    if (cumulativeTokens > 0 && profile.economicsKnown) {
      const rawNet = cumulativeTokens *
        (calls - profile.writeMultiplier - (calls - 1) * profile.readMultiplier);
      if (Number.isNaN(rawNet) || !Number.isFinite(rawNet)) {
        throw new Error("cache planner: cache economics overflow");
      }
      net = roundUnits(rawNet);
      if (net <= 0) {
        negative = true;
        continue;
      }
    }
    const candidate: IndexedBreakpoint = {
      after_segment: segment.name,
      prefix_sha256: sha256Hex(prefix),
      prefix_tokens: cumulativeTokens,
      expected_calls: calls,
      break_even_calls: breakEvenCalls(profile),
      expected_net_input_rate_units: net,
      index,
    };
    if (candidates.length > 0 && candidates[candidates.length - 1]!.expected_calls === calls) {
      candidates[candidates.length - 1] = candidate;
    } else {
      candidates.push(candidate);
    }
  }
  return { candidates, belowMinimum, negative };
}

function breakEvenCalls(profile: CachePlanProfile): number {
  if (!profile.economicsKnown) return 0;
  for (let calls = 2; calls <= 10_000; calls++) {
    if (calls - profile.writeMultiplier - (calls - 1) * profile.readMultiplier > 0) return calls;
  }
  return 0;
}

function limitBreakpoints(candidates: IndexedBreakpoint[], limit: number): IndexedBreakpoint[] {
  if (candidates.length <= limit) return [...candidates];
  const selected = [...candidates];
  // Array.prototype.sort is stable, matching Go's SliceStable here.
  selected.sort((a, b) =>
    a.expected_net_input_rate_units === b.expected_net_input_rate_units
      ? a.index - b.index
      : b.expected_net_input_rate_units - a.expected_net_input_rate_units);
  const kept = selected.slice(0, limit);
  kept.sort((a, b) => a.index - b.index);
  return kept;
}

function keyShard(
  request: CachePlanRequest,
  profile: CachePlanProfile,
  maxShards: number,
): { count: number; shard: number; capped: boolean } {
  let count = 1;
  let capped = false;
  const rpm = request.expectedRequestsPerMinute ?? 0;
  if (rpm > profile.maxRpmPerKey) {
    count = 1 + Math.floor((rpm - 1) / profile.maxRpmPerKey);
    if (count > maxShards) {
      count = maxShards;
      capped = true;
    }
  }
  let partition = request.partitionKey ?? "";
  if (partition === "") partition = request.epoch;
  const digest = sha256Hex(partition);
  const shard = Number(BigInt(`0x${digest.slice(0, 16)}`) % BigInt(count));
  return { count, shard, capped };
}

function routingKey(scope: string, profileId: string, prefixSha: string, shard: number): string {
  return sha256Hex(`${scope}\x00${profileId}\x00${prefixSha}\x00${shard}`).slice(0, 32);
}

export function epochKey(scope: string, epoch: string, profileId: string): string {
  return sha256Hex(`${scope}\x00${epoch}\x00${profileId}`);
}

function finiteNonNegative(value: number): boolean {
  return value >= 0 && !Number.isNaN(value) && Number.isFinite(value);
}

function roundUnits(value: number): number {
  const scaled = value * 1e9;
  if (!Number.isFinite(scaled)) return value;
  return Math.round(scaled) / 1e9;
}

function allTokenCountsUnavailable(breakpoints: readonly CacheBreakpoint[]): boolean {
  if (breakpoints.length === 0) return false;
  return breakpoints.every((breakpoint) => breakpoint.prefix_tokens <= 0);
}
