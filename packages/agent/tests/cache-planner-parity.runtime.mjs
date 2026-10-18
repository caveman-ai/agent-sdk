import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { catalogCacheProfile } from "../dist/catalog.js";
import { CachePlanEngine, optimizeNativeRequest } from "../dist/cache-planner/index.js";

// Parity suite for the TS cache-planner port (Agent SDK v2 phase 2).
//
// planner-fixtures/{planner,wire}.json are EXPORTED BY THE GO ENGINE
// (public/cacheengine/export_fixtures_test.go) — the source of truth. A
// disagreement here is a TS bug or a stale fixture, never a fixture hand-edit.
// Wire bodies are compared byte-for-byte: they pin the splice-vs-reserialize
// behavior of each wire (Anthropic/OpenAI splice; Bedrock reserializes
// sorted-key JSON).

const REGENERATE =
  "regenerate: cd public && CAVE_EXPORT_PLANNER_FIXTURES=1 go test ./cacheengine -run TestExportPlannerFixtures";

async function fixtureFile(name) {
  return JSON.parse(await readFile(
    new URL(`../planner-fixtures/${name}`, import.meta.url),
    "utf8",
  ));
}

const plannerFixtures = await fixtureFile("planner.json");
const wireFixtures = await fixtureFile("wire.json");

// The fixtures were exported against catalog 44f273c9…, and the Go exporter is
// gone from Caveman-Cloud, so they stay pinned to it. The planner reads only
// cache profiles from the catalog: the profiles of the models the wire fixtures
// name must equal the ones in that catalog (digest taken from it). Rows added
// to the catalog since change nothing here; a changed profile fails.
const EXPORT_CATALOG_SHA256 = "44f273c90cd7ab4707888fdf7ac5aea21d668e2204ef8a66683644e9151e1ce8";
const EXPORT_PROFILES_SHA256 = "54b382a9235e19492c9aa8c4c278a771eb992fe1cea187e6a4e25bdd587e3f22";

test("fixture cache economics equal the TS catalog's", () => {
  for (const file of [plannerFixtures, wireFixtures]) assert.equal(file.catalog_sha256, EXPORT_CATALOG_SHA256);
  const keys = [...new Set(wireFixtures.cases.map(({ request: r }) => JSON.stringify([r.provider, r.model ?? "", r.region ?? ""])))].sort();
  const rows = keys.map((key) => {
    const [provider, model, region] = JSON.parse(key);
    return [provider, model, region, catalogCacheProfile(provider, model, region) ?? null];
  });
  assert.equal(
    createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    EXPORT_PROFILES_SHA256,
    "a fixture model's cache profile in src/catalog.ts differs from the one the fixtures were exported against — " +
      `fixture cache economics no longer match the planner's. ${REGENERATE}, then node scripts/generate-agent-catalog.mjs`,
  );
});

function profileFromFixture(profile) {
  return {
    id: profile.id,
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    mode: profile.mode,
    attribution: profile.attribution ?? "",
    minPrefixTokens: profile.min_prefix_tokens ?? 0,
    maxBreakpoints: profile.max_breakpoints ?? 0,
    economicsKnown: profile.economics_known ?? false,
    writeMultiplier: profile.write_multiplier ?? 0,
    readMultiplier: profile.read_multiplier ?? 0,
    ttlSeconds: profile.ttl_seconds ?? 0,
    rolling: profile.rolling ?? false,
    routingKey: profile.routing_key ?? false,
    maxRpmPerKey: profile.max_rpm_per_key ?? 0,
    optimizerId: profile.optimizer_id ?? "",
  };
}

function planRequestFromFixture(request) {
  return {
    scope: request.scope,
    epoch: request.epoch,
    partitionKey: request.partition_key ?? "",
    expectedRequestsPerMinute: request.expected_requests_per_minute ?? 0,
    expectedCalls: request.expected_calls ?? 0,
    profile: profileFromFixture(request.profile),
    segments: request.segments.map((segment) => ({
      name: segment.name,
      content: segment.content,
      tokens: segment.tokens ?? 0,
      stable: segment.stable ?? false,
      cacheable: segment.cacheable ?? false,
      expectedCalls: segment.expected_calls ?? 0,
    })),
  };
}

// Round-trip through JSON so absent optional fields compare as absent, exactly
// like the Go engine's own marshaled plan in the fixture.
function wireShape(value) {
  return JSON.parse(JSON.stringify(value));
}

for (const fixture of plannerFixtures.cases) {
  test(`planner parity: ${fixture.name}`, () => {
    const engine = new CachePlanEngine({
      maxKeyShards: fixture.config.max_key_shards ?? 0,
    });
    for (const [index, step] of fixture.steps.entries()) {
      const plan = engine.plan(planRequestFromFixture(step.request));
      assert.deepEqual(
        wireShape(plan),
        step.plan,
        `step ${index} diverged from the Go engine (${REGENERATE})`,
      );
    }
  });
}

for (const fixture of wireFixtures.cases) {
  test(`wire parity: ${fixture.name}`, () => {
    const engine = new CachePlanEngine({});
    const request = fixture.request;
    const result = optimizeNativeRequest(engine, {
      scope: request.scope,
      epoch: request.epoch,
      partitionKey: request.partition_key ?? "",
      expectedCalls: request.expected_calls ?? 0,
      provider: request.provider,
      model: request.model,
      region: request.region ?? "",
      endpoint: request.endpoint,
      body: request.body,
      runtimeMode: request.runtime_mode ?? "",
      authMode: request.auth_mode ?? "",
      prefixTokens: request.prefix_tokens ?? 0,
    });
    // Byte-exact: the fixture pins each wire's splice/reserialize output.
    assert.equal(result.body, fixture.result.body, `body diverged (${REGENERATE})`);
    assert.equal(result.applied, fixture.result.applied);
    assert.equal(result.decision, fixture.result.decision);
    assert.equal(result.reason, fixture.result.reason);
    assert.deepEqual(result.optimizerIds, fixture.result.optimizer_ids ?? []);
    assert.equal(result.claimBasis, fixture.result.claim_basis);
    assert.deepEqual(wireShape(result.plan), fixture.result.plan);
    assert.equal(result.verifiedSavingsUsd, 0);
  });
}

test("all 41 parity cases are present", () => {
  assert.equal(plannerFixtures.cases.length, 20);
  assert.equal(wireFixtures.cases.length, 21);
});
