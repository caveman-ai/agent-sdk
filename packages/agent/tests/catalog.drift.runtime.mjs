import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CATALOG_SEMANTIC_SHA256,
  CATALOG_SHA256,
  PRICE_PROVENANCE_SHA256,
  catalogCost,
  catalogCostForPrice,
  catalogModelRuntimeEligible,
  catalogPriceFingerprint,
  catalogRuntimeModel,
  catalogSearchCeiling,
} from "../dist/catalog.js";
import { generate, selectRows } from "../../../scripts/generate-agent-catalog.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const catalogYamlPath = [
  resolve(packageRoot, "../shared/provider-catalog/catalog/current.yaml"),
  resolve(packageRoot, "../../shared/provider-catalog/catalog/current.yaml"),
].find((candidate) => existsSync(candidate));
assert.ok(catalogYamlPath, "provider catalog must exist beside public/ or repository root");
const catalogModulePath = resolve(packageRoot, "src/catalog.ts");
const generatedManifestPath = [
  resolve(packageRoot, "../shared/provider-catalog/generated/manifest.json"),
  resolve(packageRoot, "../../shared/provider-catalog/generated/manifest.json"),
].find((candidate) => existsSync(candidate));
assert.ok(generatedManifestPath, "generated provider catalog manifest must exist beside public/ or repository root");

test("CATALOG_SHA256 pins the exact provider-catalog bytes it was generated from", async () => {
  const bytes = await readFile(catalogYamlPath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    CATALOG_SHA256,
    digest,
    "catalog.ts pins a digest that is not current.yaml — re-run node scripts/generate-agent-catalog.mjs",
  );
});

test("agent catalog carries canonical semantic and price provenance digests", async () => {
  const manifest = JSON.parse(await readFile(generatedManifestPath, "utf8"));
  assert.equal(CATALOG_SEMANTIC_SHA256, manifest.catalog_semantic_sha256);
  assert.equal(PRICE_PROVENANCE_SHA256, manifest.price_provenance_sha256);
  assert.notEqual(CATALOG_SEMANTIC_SHA256, PRICE_PROVENANCE_SHA256);
});

test("src/catalog.ts is exactly what the generator produces today", async () => {
  const onDisk = await readFile(catalogModulePath, "utf8");
  assert.equal(
    onDisk,
    generate(),
    "catalog.ts is stale or hand-edited — re-run node scripts/generate-agent-catalog.mjs",
  );
});

test("generated catalog prices region-agnostic rows and stays honest about the rest", () => {
  const million = {
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  // Widened beyond the former hand-typed three: a Sonnet row now compiles.
  const sonnet = catalogCost({ provider: "anthropic", model: "claude-sonnet-4-5", ...million });
  assert.equal(sonnet.priced, true);
  assert.equal(sonnet.usd, 3);
  assert.equal(catalogSearchCeiling("anthropic/claude-sonnet-4-5", 1_000_000, 0), 3.75);

  // The original three keep their prices; current.yaml is the only source.
  assert.deepEqual(catalogCost({ provider: "anthropic", model: "claude-haiku-4-5", ...million }), {
    priced: true,
    usd: 1,
  });
  assert.deepEqual(catalogCost({ provider: "openai", model: "gpt-5.4-mini", ...million }), {
    priced: true,
    usd: 0.75,
  });
  assert.deepEqual(catalogCost({ provider: "gemini", model: "gemini-2.5-flash", ...million }), {
    priced: true,
    usd: 0.3,
  });

  // google/ still normalizes to gemini/ on both surfaces.
  assert.deepEqual(catalogCost({ provider: "google", model: "gemini-2.5-flash", ...million }), {
    priced: true,
    usd: 0.3,
  });
  assert.equal(catalogSearchCeiling("google/gemini-2.5-flash", 1_000_000, 0), 0.3);

  // Pi names Vertex `google-vertex`; catalog names the billing surface `vertex`.
  // Both cost and reservation paths must cross that boundary identically.
  assert.deepEqual(catalogCost({ provider: "google-vertex", model: "gemini-2.5-flash", ...million }), {
    priced: true,
    usd: 0.3,
  });
  assert.equal(catalogSearchCeiling("google-vertex/gemini-2.5-flash", 1_000_000, 0), undefined);

  // Affinity/implicit profiles have no separately billed write class; their
  // null write rate does not make the reservation unknowable. Explicit
  // profiles still include the provider-attested write rate in the ceiling.
  assert.equal(catalogSearchCeiling("openai/gpt-5.4-mini", 1_000_000, 1_000_000), 5.25);
  assert.equal(catalogSearchCeiling("anthropic/claude-haiku-4-5", 1_000_000, 1_000_000), 6.25);

  // Regional-only rows are never borrowed: honest zero, not a us-east-1 guess.
  assert.deepEqual(
    catalogCost({ provider: "bedrock", model: "global.anthropic.claude-sonnet-4-6", ...million }),
    { priced: false, usd: 0 },
  );
  assert.equal(catalogSearchCeiling("bedrock/global.anthropic.claude-sonnet-4-6", 1_000_000, 0), undefined);
  assert.deepEqual(catalogCost({ provider: "unknown", model: "no-price", ...million }), {
    priced: false,
    usd: 0,
  });
});

test("Anthropic thinking uses the explicit provider-attested output-token rate", () => {
  // This is a catalog value backed by Anthropic's billing docs, not a generic
  // generator fallback from reasoning to visible output.
  const reasoned = catalogCost({
    provider: "anthropic",
    model: "claude-haiku-4-5",
    inputTokens: 0,
    outputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 1_000_000,
  });
  assert.deepEqual(reasoned, { priced: true, usd: 5 });
});

test("DeepSeek recurring UTC prices use explicit half-open request time and otherwise fail closed", () => {
  const flash = {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
    reasoningTokens: 1_000_000,
  };
  const cases = [
    ["2026-08-16T15:59:59Z", 0.4228],
    ["2026-08-16T16:00:00Z", 0.887],
    ["2026-08-17T00:59:59Z", 0.887],
    ["2026-08-17T01:00:00Z", 1.774],
    ["2026-08-17T03:59:59Z", 1.774],
    ["2026-08-17T04:00:00Z", 0.887],
    ["2026-08-17T05:59:59Z", 0.887],
    ["2026-08-17T06:00:00Z", 1.774],
    ["2026-08-17T09:59:59Z", 1.774],
    ["2026-08-17T10:00:00Z", 0.887],
  ];
  for (const [at, usd] of cases) {
    assert.deepEqual(catalogCost(flash, new Date(at)), { priced: true, usd }, at);
  }
  assert.deepEqual(catalogCost(flash), { priced: false, usd: 0 });
  assert.equal(catalogSearchCeiling("deepseek/deepseek-v4-flash", 1_000_000, 1_000_000), undefined);
  assert.equal(catalogSearchCeiling(
    "deepseek/deepseek-v4-flash", 1_000_000, 1_000_000, new Date("2026-08-17T01:00:00Z"),
  ), 1.76);
  const offPeak = catalogPriceFingerprint("deepseek", flash.model, new Date("2026-08-17T00:59:59Z"));
  const peak = catalogPriceFingerprint("deepseek", flash.model, new Date("2026-08-17T01:00:00Z"));
  assert.ok(offPeak?.includes(PRICE_PROVENANCE_SHA256));
  assert.notEqual(offPeak, peak);
  assert.equal(
    peak,
    catalogPriceFingerprint("deepseek", flash.model, new Date("2026-08-17T03:59:59Z")),
  );
});

test("nullable optional rates fail closed only when their token class is observed", () => {
  const unknown = {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
    reasoningPerMillion: null,
  };
  const usage = {
    provider: "fixture",
    model: "fixture",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const cases = [
    ["cacheReadPerMillion", "cacheReadTokens", false],
    ["cacheWritePerMillion", "cacheWriteTokens", false],
    ["reasoningPerMillion", "reasoningTokens", true],
  ];
  for (const [rateField, tokenField, outputClass] of cases) {
    const observed = {
      ...usage,
      [tokenField]: 1_000_000,
      outputTokens: outputClass ? 1_000_000 : 0,
    };
    assert.deepEqual(
      catalogCostForPrice(unknown, observed),
      { priced: false, usd: 0 },
      `${rateField}=null must not read as free`,
    );
    assert.deepEqual(
      catalogCostForPrice({ ...unknown, [rateField]: 0 }, observed),
      { priced: true, usd: 0 },
      `${rateField}=0 is an observed free rate`,
    );
  }

  assert.deepEqual(
    catalogCostForPrice(unknown, { ...usage, inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    { priced: true, usd: 3 },
    "unknown optional rates are irrelevant when those usage buckets are zero",
  );
});

test("discovered and retired artifact rows cannot enter agent pricing", () => {
  const row = {
    provider: "future-provider",
    model: "future-model",
    region: "global",
    currency: "USD",
    verified_at: "2026-08-13T00:00:00Z",
    pricing: { input_per_million: 1, output_per_million: 2 },
    cache_profile: { state: "unknown" },
    capabilities: {
      messages_api: "unknown",
      adaptive_thinking: "unknown",
      manual_thinking: "unknown",
    },
  };
  const result = selectRows([
    { ...row, lifecycle: { status: "discovered" } },
    { ...row, model: "retired-model", lifecycle: { status: "retired" } },
    { ...row, model: "reviewed-model", lifecycle: { status: "reviewed" } },
    { ...row, model: "routable-model", lifecycle: { status: "routable" } },
  ], "fixture");
  assert.deepEqual(result.selected.map(({ key }) => key), [
    "future-provider/reviewed-model",
    "future-provider/routable-model",
  ]);
  assert.deepEqual(
    Object.fromEntries(result.models.map(({ key, model }) => [key, model.lifecycle])),
    {
      "future-provider/future-model": "discovered",
      "future-provider/retired-model": "retired",
      "future-provider/reviewed-model": "reviewed",
      "future-provider/routable-model": "routable",
    },
  );
  assert.equal(result.skipped.some(({ key, reason }) => key.endsWith("future-model") && reason.includes("discovered")), true);
  assert.equal(result.skipped.some(({ key, reason }) => key.endsWith("retired-model") && reason.includes("retired")), true);
});

test("agent row selection preserves unknown and explicit-free optional rates", () => {
  const row = {
    provider: "fixture",
    region: "global",
    currency: "USD",
    verified_at: "2026-08-13T00:00:00Z",
    lifecycle: { status: "reviewed" },
    pricing: { input_per_million: 1, output_per_million: 2 },
    cache_profile: { state: "unknown" },
    capabilities: {
      messages_api: "unknown",
      adaptive_thinking: "unknown",
      manual_thinking: "unknown",
    },
  };
  const result = selectRows([
    { ...row, model: "unknown-optionals" },
    {
      ...row,
      model: "free-optionals",
      pricing: {
        ...row.pricing,
        cache_read_input_per_million: 0,
        cache_write_input_per_million: 0,
        reasoning_output_per_million: 0,
      },
    },
  ], "fixture");
  const prices = Object.fromEntries(result.selected.map(({ key, price }) => [key, price]));
  assert.deepEqual(prices["fixture/unknown-optionals"], {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheMode: "unknown",
    cacheReadPerMillion: null,
    cacheWritePerMillion: null,
    reasoningPerMillion: null,
    verifiedAt: "2026-08-13T00:00:00.000Z",
  });
  assert.deepEqual(prices["fixture/free-optionals"], {
    inputPerMillion: 1,
    outputPerMillion: 2,
    cacheMode: "unknown",
    cacheReadPerMillion: 0,
    cacheWritePerMillion: 0,
    reasoningPerMillion: 0,
    verifiedAt: "2026-08-13T00:00:00.000Z",
  });
});

test("agent catalog compiles exact runtime lifecycle and thinking facts", () => {
  assert.deepEqual(catalogRuntimeModel("anthropic", "claude-haiku-4-5"), {
    lifecycle: "reviewed",
    messagesAPI: "supported",
    adaptiveThinking: "unsupported",
    manualThinking: "supported",
  });
  assert.deepEqual(catalogRuntimeModel("anthropic", "claude-sonnet-4-6"), {
    lifecycle: "reviewed",
    messagesAPI: "supported",
    adaptiveThinking: "supported",
    manualThinking: "supported",
  });
  assert.equal(catalogRuntimeModel("anthropic", "claude-future-unknown"), undefined);
  const facts = {
    messagesAPI: "supported",
    adaptiveThinking: "unknown",
    manualThinking: "unknown",
  };
  assert.equal(catalogModelRuntimeEligible({ ...facts, lifecycle: "discovered" }), false);
  assert.equal(catalogModelRuntimeEligible({ ...facts, lifecycle: "retired" }), false);
  assert.equal(catalogModelRuntimeEligible({
    ...facts,
    lifecycle: "reviewed",
    messagesAPI: "unsupported",
  }), false);
  assert.equal(catalogModelRuntimeEligible({
    ...facts,
    lifecycle: "reviewed",
    messagesAPI: "unknown",
  }), false);
  assert.equal(catalogModelRuntimeEligible({ ...facts, lifecycle: "reviewed" }), true);
});

test("the Caveman Code app's current models carry a reviewed list price", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  const expected = {
    "anthropic/claude-sonnet-5-5": 12, "anthropic/claude-opus-5-5": 24, "anthropic/claude-haiku-5-5": 0.6, "anthropic/claude-fable-5-1": 60,
    "openai/gpt-6.1-sol": 12, "openai/gpt-6-sol": 12, "openai/gpt-6-luna": 0.6, "openai/gpt-6-astra": 60,
  };
  for (const [key, usd] of Object.entries(expected)) {
    const [provider, model] = key.split("/");
    assert.ok(catalogPriceFingerprint(provider, model, new Date("2026-10-17T00:00:00Z")), `${key} is unpriced`);
    assert.deepEqual(catalogCost({ provider, model, ...usage }, new Date("2026-10-17T00:00:00Z")), { priced: true, usd }, key);
  }
  // A scheduled change: Gemini 3.8 Flash is priced on either side of it.
  for (const at of ["2026-10-17T00:00:00Z", "2027-02-01T00:00:00Z"]) {
    assert.equal(catalogCost({ provider: "google", model: "gemini-3.8-flash", ...usage }, new Date(at)).priced, true, at);
  }
});
