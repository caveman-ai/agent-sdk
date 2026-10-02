#!/usr/bin/env node
// Generates public/agent/src/catalog.ts from the typed JSON artifact compiled
// from the repo's single provider-catalog source of truth.
//
// The generated module carries a truthful CATALOG_SHA256 (the sha256 of the
// catalog bytes it was generated from). public/agent/tests/catalog.drift.runtime.mjs
// recomputes both the digest and the rendered module, so an edited catalog fails
// the suite until this script is re-run.
//
// Usage:
//   node scripts/generate-agent-catalog.mjs            # write public/agent/src/catalog.ts
//   node scripts/generate-agent-catalog.mjs --out FILE # write elsewhere
//   node scripts/generate-agent-catalog.mjs --check    # exit 1 if the file is stale
//
// No YAML parser lives here. Go catalog validation + typed export compile one
// canonical JSON artifact first; this renderer consumes only that artifact.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PUBLIC_ROOT = resolve(REPO_ROOT, "public");
const AGENT_ROOT = existsSync(resolve(SOURCE_PUBLIC_ROOT, "agent/package.json"))
  ? resolve(SOURCE_PUBLIC_ROOT, "agent")
  : resolve(REPO_ROOT, "packages/agent");
const catalogCandidates = [
  resolve(SOURCE_PUBLIC_ROOT, "shared/provider-catalog/catalog/current.yaml"),
  resolve(REPO_ROOT, "shared/provider-catalog/catalog/current.yaml"),
  resolve(REPO_ROOT, "packages/shared/provider-catalog/catalog/current.yaml"),
];
export const CATALOG_PATH = catalogCandidates.find((candidate) => existsSync(candidate)) ?? catalogCandidates[0];
export const OUTPUT_PATH = resolve(AGENT_ROOT, "src/catalog.ts");
const artifactCandidates = [
  resolve(SOURCE_PUBLIC_ROOT, "shared/provider-catalog/generated/catalog.json"),
  resolve(REPO_ROOT, "shared/provider-catalog/generated/catalog.json"),
  resolve(REPO_ROOT, "packages/shared/provider-catalog/generated/catalog.json"),
];
export const ARTIFACT_PATH = artifactCandidates.find((candidate) => existsSync(candidate)) ?? artifactCandidates[0];

const CATALOG_LABEL = "public/shared/provider-catalog/catalog/current.yaml";
const GENERATOR_LABEL = "scripts/generate-agent-catalog.mjs";

// Catalog's own region-agnostic marker. catalog/catalog.go uses same
// rule: only a `global` row answers a generic, region-free price lookup, because
// borrowing a regional row would fabricate spend.
const REGION_AGNOSTIC = "global";
const REQUIRED_CURRENCY = "USD";
const PRICEABLE_LIFECYCLES = new Set(["reviewed", "routable"]);
const LIFECYCLES = new Set(["discovered", "reviewed", "routable", "retired"]);
const CACHE_MODES = new Set(["explicit", "implicit", "affinity", "automatic"]);

/** Selects the runtime-eligible, region-agnostic, USD rows the agent can use. */
export function selectRows(rows, label = CATALOG_LABEL) {
  const selected = [];
  const models = [];
  const skippedByKey = new Map();
  const seenPrices = new Set();
  const seenModels = new Set();
  const record = (key) => {
    let entry = skippedByKey.get(key);
    if (entry === undefined) {
      entry = { regions: [], reasons: [] };
      skippedByKey.set(key, entry);
    }
    return entry;
  };
  const skipRegional = (key, region) => {
    const entry = record(key);
    if (!entry.regions.includes(region)) entry.regions.push(region);
  };
  const skip = (key, reason) => {
    const entry = record(key);
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  };
  for (const row of rows) {
    for (const field of ["provider", "model", "region", "currency"]) {
      if (typeof row[field] !== "string" || row[field] === "") {
        throw new Error(`${label}: row is missing a string "${field}"`);
      }
    }
    const key = `${row.provider}/${row.model}`;
    const lifecycle = row.lifecycle?.status;
    if (!LIFECYCLES.has(lifecycle)) {
      throw new Error(`${label}: ${key} has invalid lifecycle ${String(lifecycle)}`);
    }
    if (row.region === REGION_AGNOSTIC && row.currency === REQUIRED_CURRENCY) {
      if (seenModels.has(key)) throw new Error(`${label}: duplicate region-agnostic model ${key}`);
      seenModels.add(key);
      models.push({
        key,
        model: {
          lifecycle,
          messagesAPI: supportState(row.capabilities?.messages_api, `${key}.messages_api`, label),
          adaptiveThinking: supportState(row.capabilities?.adaptive_thinking, `${key}.adaptive_thinking`, label),
          manualThinking: supportState(row.capabilities?.manual_thinking, `${key}.manual_thinking`, label),
        },
      });
    }
    if (!PRICEABLE_LIFECYCLES.has(lifecycle)) {
      skip(key, `lifecycle ${lifecycle} is not priceable`);
      continue;
    }
    if (row.region !== REGION_AGNOSTIC) {
      skipRegional(key, row.region);
      continue;
    }
    if (row.currency !== REQUIRED_CURRENCY) {
      skip(key, `priced in ${row.currency}, not ${REQUIRED_CURRENCY}`);
      continue;
    }
    if (row.pricing === null || typeof row.pricing !== "object" || Array.isArray(row.pricing)) {
      throw new Error(`${label}: ${key} has no pricing block`);
    }
    const input = rate(row.pricing.input_per_million, `${key}.input_per_million`, label);
    const output = rate(row.pricing.output_per_million, `${key}.output_per_million`, label);
    if (input === null || output === null) {
      skip(key, "no list price for input or output tokens");
      continue;
    }
    if (seenPrices.has(key)) throw new Error(`${label}: duplicate region-agnostic row ${key}`);
    seenPrices.add(key);
    const mode = cacheMode(row.cache_profile, key, label);
    const schedule = recurringUTCPricing(row.recurring_utc_pricing, mode, key, label);
    const priceVerifiedAt = verifiedAt(
      row.recurring_utc_pricing?.verified_at ?? row.verified_at,
      `${key}.pricing_verified_at`,
      label,
    );
    selected.push({
      key,
      price: {
        inputPerMillion: input,
        outputPerMillion: output,
        cacheMode: mode,
        cacheReadPerMillion: rate(row.pricing.cache_read_input_per_million, `${key}.cache_read_input_per_million`, label),
        cacheWritePerMillion: rate(row.pricing.cache_write_input_per_million, `${key}.cache_write_input_per_million`, label),
        reasoningPerMillion: rate(row.pricing.reasoning_output_per_million, `${key}.reasoning_output_per_million`, label),
        verifiedAt: priceVerifiedAt,
        ...(schedule === null ? {} : { recurringUTCPricing: schedule }),
      },
    });
  }
  selected.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  models.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const skipped = [...skippedByKey.entries()]
    .map(([key, entry]) => {
      const reasons = [...entry.reasons].sort();
      if (entry.regions.length > 0) {
        reasons.unshift(`priced per region only (${[...entry.regions].sort().join(", ")})`);
      }
      return { key, reason: reasons.join("; ") };
    })
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return { selected, models, skipped };
}

function supportState(value, field, label) {
  if (value === "supported" || value === "unsupported" || value === "unknown") return value;
  throw new Error(`${label}: ${field} must be supported, unsupported, or unknown`);
}

/**
 * Selects every runtime-eligible USD row carrying a supported cache profile —
 * ALL regions, because provider cache facts (Bedrock especially) are regional.
 * These are capability facts plus the grounded rates the in-SDK cache planner
 * derives write/read multipliers from; unknown rates stay null, never guessed.
 */
export function selectCacheProfiles(rows, label = CATALOG_LABEL) {
  const selected = [];
  const seen = new Set();
  for (const row of rows) {
    const lifecycle = row.lifecycle?.status;
    if (!PRICEABLE_LIFECYCLES.has(lifecycle)) continue;
    if (row.currency !== REQUIRED_CURRENCY) continue;
    const profile = row.cache_profile;
    if (profile?.state !== "supported") continue;
    const key = `${row.provider}/${row.model}@${row.region}`;
    if (seen.has(key)) throw new Error(`${label}: duplicate cache-profile row ${key}`);
    seen.add(key);
    if (typeof profile.id !== "string" || profile.id === "" || !CACHE_MODES.has(profile.mode) ||
        typeof profile.attribution !== "string" || profile.attribution === "") {
      throw new Error(`${label}: ${key}.cache_profile has invalid id, mode, or attribution`);
    }
    const bound = (value, field) => {
      if (value === undefined || value === null) return 0;
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label}: ${key}.cache_profile.${field} must be a non-negative integer`);
      }
      return value;
    };
    const endpoints = profile.endpoints;
    if (!Array.isArray(endpoints) || endpoints.some((item) => typeof item !== "string" || item === "")) {
      throw new Error(`${label}: ${key}.cache_profile.endpoints must be non-empty strings`);
    }
    selected.push({
      key,
      profile: {
        id: profile.id,
        mode: profile.mode,
        attribution: profile.attribution,
        minPrefixTokens: bound(profile.min_prefix_tokens, "min_prefix_tokens"),
        maxBreakpoints: bound(profile.max_breakpoints, "max_breakpoints"),
        ttlSeconds: bound(profile.ttl_seconds, "ttl_seconds"),
        rolling: profile.rolling === true,
        routingKey: profile.routing_key === true,
        maxRpmPerKey: bound(profile.max_rpm_per_key, "max_rpm_per_key"),
        endpoints: [...endpoints],
        inputPerMillion: rate(row.pricing?.input_per_million, `${key}.input_per_million`, label),
        cacheReadPerMillion: rate(row.pricing?.cache_read_input_per_million, `${key}.cache_read_input_per_million`, label),
        cacheWritePerMillion: rate(row.pricing?.cache_write_input_per_million, `${key}.cache_write_input_per_million`, label),
      },
    });
  }
  selected.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return selected;
}

function cacheMode(profile, key, label) {
  const state = profile?.state;
  if (state === "unknown" || state === "unsupported") return state;
  if (state === "supported" && CACHE_MODES.has(profile.mode)) return profile.mode;
  throw new Error(`${label}: ${key}.cache_profile has invalid state or mode`);
}

function rate(value, field, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}: ${field} must be a finite non-negative number`);
  }
  return value;
}

function verifiedAt(value, field, label) {
  if (typeof value !== "string") {
    throw new Error(`${label}: ${field} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) {
    throw new Error(`${label}: ${field} must be an ISO timestamp`);
  }
  return parsed.toISOString();
}

function recurringUTCPricing(value, mode, key, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) ||
      typeof value.effective_from !== "string" || !Number.isFinite(Date.parse(value.effective_from)) ||
      !Array.isArray(value.windows) || value.windows.length === 0) {
    throw new Error(`${label}: ${key}.recurring_utc_pricing is malformed`);
  }
  const timeOfDay = (text, field) => {
    const match = typeof text === "string" && /^(\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if (match === false || match === null) {
      throw new Error(`${label}: ${key}.recurring_utc_pricing.${field} must be HH:MM:SS`);
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3]);
    if (hour > 23 || minute > 59 || second > 59) {
      throw new Error(`${label}: ${key}.recurring_utc_pricing.${field} is outside a UTC day`);
    }
    return hour * 3600 + minute * 60 + second;
  };
  const pricing = (raw, field) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${label}: ${key}.recurring_utc_pricing.${field} is malformed`);
    }
    const input = rate(raw.input_per_million, `${key}.recurring_utc_pricing.${field}.input_per_million`, label);
    const output = rate(raw.output_per_million, `${key}.recurring_utc_pricing.${field}.output_per_million`, label);
    if (input === null || output === null) {
      throw new Error(`${label}: ${key}.recurring_utc_pricing.${field} needs input and output rates`);
    }
    return {
      inputPerMillion: input,
      outputPerMillion: output,
      cacheMode: mode,
      cacheReadPerMillion: rate(raw.cache_read_input_per_million, `${key}.recurring_utc_pricing.${field}.cache_read_input_per_million`, label),
      cacheWritePerMillion: rate(raw.cache_write_input_per_million, `${key}.recurring_utc_pricing.${field}.cache_write_input_per_million`, label),
      reasoningPerMillion: rate(raw.reasoning_output_per_million, `${key}.recurring_utc_pricing.${field}.reasoning_output_per_million`, label),
    };
  };
  let previousEnd = -1;
  const windows = value.windows.map((window, index) => {
    if (window === null || typeof window !== "object" || Array.isArray(window)) {
      throw new Error(`${label}: ${key}.recurring_utc_pricing.windows[${index}] is malformed`);
    }
    const startSecondUTC = timeOfDay(window.start, `windows[${index}].start`);
    const endSecondUTC = timeOfDay(window.end, `windows[${index}].end`);
    if (startSecondUTC >= endSecondUTC || startSecondUTC < previousEnd) {
      throw new Error(`${label}: ${key}.recurring_utc_pricing.windows must be ordered non-overlapping half-open ranges`);
    }
    previousEnd = endSecondUTC;
    return {
      startSecondUTC,
      endSecondUTC,
      price: pricing(window.pricing, `windows[${index}].pricing`),
    };
  });
  return {
    effectiveFrom: value.effective_from,
    defaultPrice: pricing(value.default_pricing, "default_pricing"),
    windows,
  };
}

function number(value) {
  const text = String(value);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?(e[+-]?[0-9]+)?$/.test(text)) {
    throw new Error(`cannot render ${text} as a stable numeric literal`);
  }
  return text;
}

function nullableNumber(value) {
  return value === null ? "null" : number(value);
}

function renderPriceRates(price, indent) {
  return [
    `${indent}inputPerMillion: ${number(price.inputPerMillion)},`,
    `${indent}outputPerMillion: ${number(price.outputPerMillion)},`,
    `${indent}cacheMode: ${JSON.stringify(price.cacheMode)},`,
    `${indent}cacheReadPerMillion: ${nullableNumber(price.cacheReadPerMillion)},`,
    `${indent}cacheWritePerMillion: ${nullableNumber(price.cacheWritePerMillion)},`,
    `${indent}reasoningPerMillion: ${nullableNumber(price.reasoningPerMillion)},`,
  ];
}

function renderRecurringUTCPricing(schedule, indent) {
  if (schedule === undefined || schedule === null) return [];
  const child = `${indent}  `;
  const grandchild = `${child}  `;
  const windows = schedule.windows.flatMap((window) => [
    `${grandchild}Object.freeze({`,
    `${grandchild}  startSecondUTC: ${number(window.startSecondUTC)},`,
    `${grandchild}  endSecondUTC: ${number(window.endSecondUTC)},`,
    `${grandchild}  price: Object.freeze({`,
    ...renderPriceRates(window.price, `${grandchild}    `),
    `${grandchild}  }),`,
    `${grandchild}}),`,
  ]);
  return [
    `${indent}recurringUTCPricing: Object.freeze({`,
    `${child}effectiveFrom: ${JSON.stringify(schedule.effectiveFrom)},`,
    `${child}defaultPrice: Object.freeze({`,
    ...renderPriceRates(schedule.defaultPrice, `${child}  `),
    `${child}}),`,
    `${child}windows: Object.freeze([`,
    ...windows,
    `${child}]),`,
    `${indent}}),`,
  ];
}

/** Renders the full public/agent/src/catalog.ts module text. */
export function renderCatalogModule(catalogBytes, artifact, label = CATALOG_LABEL) {
  const digest = createHash("sha256").update(catalogBytes).digest("hex");
  if (artifact?.schema_version !== "provider-catalog.generated.v1" ||
      !Array.isArray(artifact.entries) || artifact.entries.length === 0 ||
      !/^[0-9a-f]{64}$/.test(artifact.catalog_semantic_sha256 ?? "") ||
      !/^[0-9a-f]{64}$/.test(artifact.price_provenance_sha256 ?? "") ||
      artifact.source_sha256 !== digest) {
    throw new Error(`${label}: generated provider artifact is missing, malformed, or stale`);
  }
  const { selected, models: selectedModels, skipped } = selectRows(artifact.entries, label);
  if (selected.length === 0) throw new Error(`${label}: no priced region-agnostic rows found`);
  const cacheProfiles = selectCacheProfiles(artifact.entries, label).map(({ key, profile }) => [
    `  ${JSON.stringify(key)}: Object.freeze({`,
    `    id: ${JSON.stringify(profile.id)},`,
    `    mode: ${JSON.stringify(profile.mode)},`,
    `    attribution: ${JSON.stringify(profile.attribution)},`,
    `    minPrefixTokens: ${number(profile.minPrefixTokens)},`,
    `    maxBreakpoints: ${number(profile.maxBreakpoints)},`,
    `    ttlSeconds: ${number(profile.ttlSeconds)},`,
    `    rolling: ${profile.rolling},`,
    `    routingKey: ${profile.routingKey},`,
    `    maxRpmPerKey: ${number(profile.maxRpmPerKey)},`,
    `    endpoints: Object.freeze([${profile.endpoints.map((item) => JSON.stringify(item)).join(", ")}]),`,
    `    inputPerMillion: ${nullableNumber(profile.inputPerMillion)},`,
    `    cacheReadPerMillion: ${nullableNumber(profile.cacheReadPerMillion)},`,
    `    cacheWritePerMillion: ${nullableNumber(profile.cacheWritePerMillion)},`,
    `  }),`,
  ].join("\n")).join("\n");
  const entries = selected.map(({ key, price }) => [
    `  ${JSON.stringify(key)}: Object.freeze({`,
    ...renderPriceRates(price, "    "),
    `    verifiedAt: ${JSON.stringify(price.verifiedAt)},`,
    ...renderRecurringUTCPricing(price.recurringUTCPricing, "    "),
    `  }),`,
  ].join("\n")).join("\n");
  const models = selectedModels.map(({ key, model }) => [
    `  ${JSON.stringify(key)}: Object.freeze({`,
    `    lifecycle: ${JSON.stringify(model.lifecycle)},`,
    `    messagesAPI: ${JSON.stringify(model.messagesAPI)},`,
    `    adaptiveThinking: ${JSON.stringify(model.adaptiveThinking)},`,
    `    manualThinking: ${JSON.stringify(model.manualThinking)},`,
    `  }),`,
  ].join("\n")).join("\n");
  const skippedLines = skipped.length === 0
    ? "// Every catalog row is represented above.\n"
    : [
      "// Rows deliberately absent above. A regional rate is not a region-free",
      "// rate, so these are omitted rather than borrowed; a run on one of these",
      "// models prices as unpriced (honest zero) instead of plausibly wrong.",
      ...skipped.map(({ key, reason }) => `//   ${key} — ${reason}`),
      "",
    ].join("\n");

  return `// GENERATED by ${GENERATOR_LABEL} — do not edit.
// Source: ${CATALOG_LABEL}, the repo's single pricing source of truth.
// CATALOG_SHA256 is the sha256 of those exact catalog bytes; the drift test in
// tests/catalog.drift.runtime.mjs fails until the generator is re-run.
//
// Included: every reviewed or routable USD row the catalog prices
// region-agnostically (region: ${REGION_AGNOSTIC}). Field mapping, catalog key
// -> TypeScript field:
//   input_per_million             -> inputPerMillion
//   output_per_million            -> outputPerMillion
//   cache_read_input_per_million  -> cacheReadPerMillion
//   cache_write_input_per_million -> cacheWritePerMillion
//   reasoning_output_per_million  -> reasoningPerMillion
// Optional null rates remain unknown. Costing and reservation fail closed when
// a corresponding observed or potentially used token class is nonzero; an
// explicit numeric 0 remains a reviewed free rate.
// Not modeled: 1h cache-write rates, batch discounts, cache storage, and
// long-context multipliers. These numbers are standard-tier public list-price
// subtotals, never an invoice.
export const CATALOG_SHA256 = "${digest}";
export const CATALOG_SEMANTIC_SHA256 = "${artifact.catalog_semantic_sha256}";
export const PRICE_PROVENANCE_SHA256 = "${artifact.price_provenance_sha256}";

export interface CatalogPriceRates {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheMode: "unknown" | "unsupported" | "explicit" | "implicit" | "affinity" | "automatic";
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
  reasoningPerMillion: number | null;
}

export interface CatalogRecurringUTCPriceWindow {
  startSecondUTC: number;
  endSecondUTC: number;
  price: CatalogPriceRates;
}

export interface CatalogRecurringUTCPricing {
  effectiveFrom: string;
  defaultPrice: CatalogPriceRates;
  windows: readonly CatalogRecurringUTCPriceWindow[];
}

export interface CatalogPrice extends CatalogPriceRates {
  verifiedAt: string;
  recurringUTCPricing?: CatalogRecurringUTCPricing;
}

export type CatalogSupportState = "unknown" | "unsupported" | "supported";

export interface CatalogModelFacts {
  lifecycle: "discovered" | "reviewed" | "routable" | "retired";
  messagesAPI: CatalogSupportState;
  adaptiveThinking: CatalogSupportState;
  manualThinking: CatalogSupportState;
}

export interface CatalogUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

const PRICES: Readonly<Record<string, CatalogPrice>> = Object.freeze({
${entries}
});

const MODELS: Readonly<Record<string, CatalogModelFacts>> = Object.freeze({
${models}
});

/**
 * Provider cache-capability facts for the in-SDK cache planner, one entry per
 * runtime-eligible USD catalog row with a supported cache profile — every
 * region, keyed "provider/model@region", because cache facts are regional.
 * Rates ground write/read multipliers; null stays unknown, never guessed.
 */
export interface CatalogCacheProfile {
  id: string;
  mode: "explicit" | "implicit" | "affinity" | "automatic";
  attribution: string;
  minPrefixTokens: number;
  maxBreakpoints: number;
  ttlSeconds: number;
  rolling: boolean;
  routingKey: boolean;
  maxRpmPerKey: number;
  endpoints: readonly string[];
  inputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  cacheWritePerMillion: number | null;
}

const CACHE_PROFILES: Readonly<Record<string, CatalogCacheProfile>> = Object.freeze({
${cacheProfiles}
});

/** Cache profile lookup mirroring the Go engine: empty region means "global". */
export function catalogCacheProfile(
  provider: string,
  model: string,
  region?: string,
): CatalogCacheProfile | undefined {
  const where = (region ?? "").trim() === "" ? "global" : (region ?? "").trim();
  return CACHE_PROFILES[\`\${catalogProvider(provider.toLowerCase().trim())}/\${model.trim()}@\${where}\`];
}

${skippedLines}
function catalogProvider(provider: string): string {
  // Runtime provider IDs come from Pi; catalog IDs name billing surfaces.
  if (provider === "google") return "gemini";
  if (provider === "google-vertex") return "vertex";
  return provider;
}

export function catalogRuntimeModel(
  provider: string,
  model: string,
): CatalogModelFacts | undefined {
  const facts = catalogModelFacts(provider, model);
  return catalogModelRuntimeEligible(facts) ? facts : undefined;
}

export function catalogModelFacts(
  provider: string,
  model: string,
): CatalogModelFacts | undefined {
  return MODELS[\`\${catalogProvider(provider)}/\${model}\`];
}

export function catalogModelRuntimeEligible(
  facts: CatalogModelFacts | undefined,
): facts is CatalogModelFacts {
  return facts !== undefined &&
    (facts.lifecycle === "reviewed" || facts.lifecycle === "routable") &&
    facts.messagesAPI === "supported";
}

export function catalogSearchCeiling(
  model: string,
  inputTokens: number,
  outputTokens: number,
  accountingAt?: Date,
): number | undefined {
  const slash = model.indexOf("/");
  const normalized = slash < 0
    ? model
    : \`\${catalogProvider(model.slice(0, slash))}/\${model.slice(slash + 1)}\`;
  const price = catalogPriceAt(PRICES[normalized], accountingAt);
  if (!price || !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    return undefined;
  }
  const cacheReadPossible = price.cacheMode !== "unsupported";
  const separatelyBilledCacheWritePossible =
    price.cacheMode === "unknown" || price.cacheMode === "explicit";
  if (inputTokens > 0) {
    if (cacheReadPossible && price.cacheReadPerMillion === null) return undefined;
    if (separatelyBilledCacheWritePossible && price.cacheWritePerMillion === null) return undefined;
  }
  if (outputTokens > 0 && price.reasoningPerMillion === null) return undefined;
  const inputRates = [price.inputPerMillion];
  if (inputTokens > 0 && cacheReadPossible) inputRates.push(price.cacheReadPerMillion!);
  if (inputTokens > 0 && separatelyBilledCacheWritePossible) {
    inputRates.push(price.cacheWritePerMillion!);
  }
  const worstInputRate = Math.max(...inputRates);
  const worstOutputRate = outputTokens === 0
    ? price.outputPerMillion
    : Math.max(price.outputPerMillion, price.reasoningPerMillion!);
  const usd = (inputTokens * worstInputRate + outputTokens * worstOutputRate) / 1_000_000;
  return Math.ceil(usd * 1e10) / 1e10;
}

export function catalogCostForPrice(
  price: CatalogPriceRates | undefined,
  usage: CatalogUsage,
): { priced: boolean; usd: number } {
  if (!price) return { priced: false, usd: 0 };
  if ((usage.cacheReadTokens > 0 && price.cacheReadPerMillion === null) ||
      (usage.cacheWriteTokens > 0 && price.cacheWritePerMillion === null) ||
      (usage.reasoningTokens > 0 && price.reasoningPerMillion === null)) {
    return { priced: false, usd: 0 };
  }
  // Pi normalizes input as uncached input. cacheRead/cacheWrite are disjoint
  // classes, while reasoning remains a subset of output.
  const billableInput = usage.inputTokens;
  const visibleOutput = usage.outputTokens - usage.reasoningTokens;
  if (
    billableInput < 0 ||
    visibleOutput < 0 ||
    Object.values(usage).some((value) => typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
  ) {
    return { priced: false, usd: 0 };
  }
  const usd = (
    billableInput * price.inputPerMillion +
    usage.cacheReadTokens * (price.cacheReadPerMillion ?? 0) +
    usage.cacheWriteTokens * (price.cacheWritePerMillion ?? 0) +
    visibleOutput * price.outputPerMillion +
    usage.reasoningTokens * (price.reasoningPerMillion ?? 0)
  ) / 1_000_000;
  return { priced: true, usd: Math.round((usd + Number.EPSILON) * 1e10) / 1e10 };
}

export function catalogPriceAt(
  price: CatalogPrice | undefined,
  accountingAt?: Date,
): CatalogPriceRates | undefined {
  return catalogPriceResolution(price, accountingAt)?.price;
}

function catalogPriceResolution(
  price: CatalogPrice | undefined,
  accountingAt?: Date,
): { price: CatalogPriceRates; epoch: string } | undefined {
  if (price === undefined) return undefined;
  if (price.recurringUTCPricing === undefined) return { price, epoch: "static" };
  if (accountingAt === undefined || Number.isNaN(accountingAt.getTime())) return undefined;
  const effective = Date.parse(price.recurringUTCPricing.effectiveFrom);
  if (!Number.isFinite(effective)) return undefined;
  if (accountingAt.getTime() < effective) return { price, epoch: "pre-effective" };
  const secondUTC = accountingAt.getUTCHours() * 3600 + accountingAt.getUTCMinutes() * 60 + accountingAt.getUTCSeconds();
  for (const window of price.recurringUTCPricing.windows) {
    if (secondUTC >= window.startSecondUTC && secondUTC < window.endSecondUTC) {
      return { price: window.price, epoch: \`window:\${window.startSecondUTC}-\${window.endSecondUTC}\` };
    }
  }
  return { price: price.recurringUTCPricing.defaultPrice, epoch: "default" };
}

/** Exact money-rate identity at a request time. It includes every nullable rate,
 * cache semantics, schedule epoch, and the generated price-provenance digest. */
export function catalogPriceFingerprint(
  provider: string,
  model: string,
  accountingAt?: Date,
): string | undefined {
  const catalogPrice = PRICES[\`\${catalogProvider(provider)}/\${model}\`];
  if (catalogPrice === undefined) return undefined;
  const resolution = catalogPriceResolution(catalogPrice, accountingAt);
  if (resolution === undefined) return undefined;
  const price = resolution.price;
  return JSON.stringify([
    PRICE_PROVENANCE_SHA256,
    resolution.epoch,
    price.inputPerMillion,
    price.outputPerMillion,
    price.cacheMode,
    price.cacheReadPerMillion,
    price.cacheWritePerMillion,
    price.reasoningPerMillion,
    catalogPrice.verifiedAt,
  ]);
}

/** Exact pricing-review instant from the generated catalog source. */
export function catalogPriceVerifiedAt(
  provider: string,
  model: string,
): string | undefined {
  return PRICES[\`\${catalogProvider(provider)}/\${model}\`]?.verifiedAt;
}

/** Cache billing semantics in force at a request time; undefined when unpriced then. */
export function catalogCacheMode(
  provider: string,
  model: string,
  accountingAt?: Date,
): CatalogPriceRates["cacheMode"] | undefined {
  return catalogPriceResolution(PRICES[\`\${catalogProvider(provider)}/\${model}\`], accountingAt)?.price.cacheMode;
}

export function catalogCost(
  usage: CatalogUsage,
  accountingAt?: Date,
): { priced: boolean; usd: number } {
  const provider = catalogProvider(usage.provider);
  return catalogCostForPrice(catalogPriceAt(PRICES[\`\${provider}/\${usage.model}\`], accountingAt), usage);
}
`;
}

export function generate() {
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  return renderCatalogModule(readFileSync(CATALOG_PATH), artifact);
}

function main(argv) {
  const check = argv.includes("--check");
  const outIndex = argv.indexOf("--out");
  const outPath = outIndex === -1 ? OUTPUT_PATH : resolve(process.cwd(), argv[outIndex + 1] ?? "");
  if (outIndex !== -1 && argv[outIndex + 1] === undefined) {
    process.stderr.write("--out requires a path\n");
    return 2;
  }
  const rendered = generate();
  if (check) {
    const current = readFileSync(outPath, "utf8");
    if (current === rendered) {
      process.stdout.write(`${GENERATOR_LABEL}: catalog.ts is current\n`);
      return 0;
    }
    process.stderr.write(`${GENERATOR_LABEL}: catalog.ts is stale — re-run the generator\n`);
    return 1;
  }
  writeFileSync(outPath, rendered);
  process.stdout.write(`${GENERATOR_LABEL}: wrote ${outPath}\n`);
  return 0;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
