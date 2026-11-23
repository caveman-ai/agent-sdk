import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ADAPTER_CAPABILITIES,
  ADAPTER_CAPABILITIES_V1,
  ADAPTER_CONFORMANCE_SUITE,
  ADAPTER_LIFECYCLE_PHASES,
  createAdapterRegistry,
  defineAdapterManifest,
  defineAdapterPackage,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const adaptersRoot = resolve(here, "../../adapters");

function manifestV1(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "fixture",
    packageName: "@caveman-ai/adapter-fixture",
    adapterVersion: "0.1.0",
    upstream: { package: "fixture", version: "1.0.0" },
    capabilities: {
      run: "experimental",
      stream: "unsupported",
      tools: "unsupported",
      usage: "experimental",
      abort: "unsupported",
      durable: "unsupported",
      compile: "unsupported",
    },
    certifications: {},
    ...overrides,
  };
}

function capabilityMap(overrides = {}) {
  return {
    runLifecycle: "unsupported",
    modelInterception: "unsupported",
    contextTransformation: "unsupported",
    toolObservation: "unsupported",
    usageAccounting: "unsupported",
    streaming: "unsupported",
    abort: "unsupported",
    replayAwareness: "unsupported",
    durableObservation: "unsupported",
    tracing: "unsupported",
    compilation: "unsupported",
    ...overrides,
  };
}

function lifecycleMap(overrides = {}) {
  return {
    ...Object.fromEntries(ADAPTER_LIFECYCLE_PHASES.map((phase) => [phase, "unsupported"])),
    ...overrides,
  };
}

function manifestV2(overrides = {}) {
  return {
    schemaVersion: 2,
    id: "fixture-v2",
    packageName: "@caveman-ai/adapter-fixture-v2",
    adapterVersion: "0.2.0",
    upstream: { package: "fixture", version: "2.0.0" },
    capabilities: capabilityMap(),
    lifecycle: lifecycleMap(),
    certifications: {},
    ...overrides,
  };
}

test("canonical v2 and explicit v1 capability vocabularies are exact", () => {
  assert.deepEqual(ADAPTER_CAPABILITIES, [
    "runLifecycle",
    "modelInterception",
    "contextTransformation",
    "toolObservation",
    "usageAccounting",
    "streaming",
    "abort",
    "replayAwareness",
    "durableObservation",
    "tracing",
    "compilation",
  ]);
  assert.deepEqual(ADAPTER_CAPABILITIES_V1, [
    "run",
    "stream",
    "tools",
    "usage",
    "abort",
    "durable",
    "compile",
  ]);
});

test("v1 manifests remain readable, snapshotted, and deeply frozen", () => {
  const source = manifestV1();
  const defined = defineAdapterManifest(source);
  source.capabilities.run = "certified";
  source.upstream.version = "changed";
  assert.equal(defined.schemaVersion, 1);
  assert.equal(defined.capabilities.run, "experimental");
  assert.equal(defined.upstream.version, "1.0.0");
  assert.equal(Object.isFrozen(defined), true);
  assert.equal(Object.isFrozen(defined.capabilities), true);
  assert.equal(Object.isFrozen(defined.upstream), true);

  const certified = defineAdapterManifest(manifestV1({
    capabilities: { ...manifestV1().capabilities, run: "certified" },
    certifications: {
      run: {
        suite: ADAPTER_CONFORMANCE_SUITE,
        reportSHA256: "b".repeat(64),
      },
    },
  }));
  assert.equal(certified.capabilities.run, "certified");
});

test("v2 manifests require exact capability and lifecycle maps and deep-freeze both", () => {
  const source = manifestV2({
    capabilities: capabilityMap({
      runLifecycle: "experimental",
      modelInterception: "experimental",
      contextTransformation: "experimental",
      toolObservation: "experimental",
      durableObservation: "experimental",
    }),
    lifecycle: lifecycleMap({
      "run.started": "observe",
      "run.completed": "observe",
      "run.error": "observe",
      "model.requested": "intercept",
      "tool.started": "observe",
      "tool.completed": "observe",
      "tool.error": "observe",
      "checkpoint.committed": "observe",
    }),
  });
  const defined = defineAdapterManifest(source);

  source.capabilities.runLifecycle = "unsupported";
  source.lifecycle["run.started"] = "unsupported";
  assert.equal(defined.schemaVersion, 2);
  assert.equal(defined.capabilities.runLifecycle, "experimental");
  assert.equal(defined.lifecycle["run.started"], "observe");
  assert.equal(Object.isFrozen(defined.capabilities), true);
  assert.equal(Object.isFrozen(defined.lifecycle), true);

  assert.throws(
    () => defineAdapterManifest(manifestV2({
      capabilities: { ...capabilityMap(), extra: "unsupported" },
    })),
    /cave_adapter_manifest_invalid/,
  );
  assert.throws(
    () => defineAdapterManifest(manifestV2({
      lifecycle: { ...lifecycleMap(), extra: "unsupported" },
    })),
    /cave_adapter_lifecycle_capabilities_invalid/,
  );
});

test("certified state requires exact reproducible evidence", () => {
  assert.throws(
    () => defineAdapterManifest(manifestV2({
      capabilities: capabilityMap({ usageAccounting: "certified" }),
    })),
    /cave_adapter_certification_invalid:usageAccounting/,
  );

  const defined = defineAdapterManifest(manifestV2({
    capabilities: capabilityMap({ usageAccounting: "certified" }),
    certifications: {
      usageAccounting: {
        suite: ADAPTER_CONFORMANCE_SUITE,
        reportSHA256: "a".repeat(64),
      },
    },
  }));
  assert.equal(defined.capabilities.usageAccounting, "certified");
  assert.equal(Object.isFrozen(defined.certifications.usageAccounting), true);

  assert.throws(
    () => defineAdapterManifest(manifestV2({
      capabilities: capabilityMap({ usageAccounting: "certified" }),
      certifications: {
        usageAccounting: {
          suite: ADAPTER_CONFORMANCE_SUITE,
          reportSHA256: "a".repeat(64),
          extra: true,
        },
      },
    })),
    /cave_adapter_certification_invalid:usageAccounting/,
  );
});

test("manifest and package validation never reread caller properties", () => {
  const source = manifestV2();
  const proxy = new Proxy(source, {
    get() {
      throw new Error("caller getter must not run");
    },
  });
  const defined = defineAdapterManifest(proxy);
  assert.equal(defined.id, "fixture-v2");

  let reads = 0;
  const evidence = {};
  Object.defineProperty(evidence, "suite", {
    enumerable: true,
    get() {
      reads++;
      return ADAPTER_CONFORMANCE_SUITE;
    },
  });
  Object.defineProperty(evidence, "reportSHA256", {
    enumerable: true,
    value: "a".repeat(64),
  });
  assert.throws(() => defineAdapterManifest(manifestV2({
    capabilities: capabilityMap({ usageAccounting: "certified" }),
    certifications: { usageAccounting: evidence },
  })), /cave_adapter_certification_invalid:usageAccounting/);
  assert.equal(reads, 0);

  const packageValue = { manifest: manifestV2() };
  Object.defineProperty(packageValue, "createAdapter", {
    enumerable: true,
    get() {
      reads++;
      return () => undefined;
    },
  });
  assert.throws(() => defineAdapterPackage(packageValue), /cave_adapter_package_invalid/);
  assert.equal(reads, 0);

  const symbolic = manifestV2();
  symbolic[Symbol("hidden")] = true;
  assert.throws(() => defineAdapterManifest(symbolic), /cave_adapter_manifest_invalid/);
});

test("v2 rejects aggregate and lifecycle contradictions", () => {
  const contradictions = [
    manifestV2({
      capabilities: capabilityMap({ modelInterception: "experimental" }),
    }),
    manifestV2({
      lifecycle: lifecycleMap({ "model.requested": "intercept" }),
    }),
    manifestV2({
      capabilities: capabilityMap({ contextTransformation: "experimental" }),
    }),
    manifestV2({
      capabilities: capabilityMap({ modelInterception: "experimental" }),
      lifecycle: lifecycleMap({ "model.requested": "intercept" }),
    }),
    manifestV2({
      capabilities: capabilityMap({ toolObservation: "experimental" }),
    }),
    manifestV2({
      lifecycle: lifecycleMap({ "tool.started": "observe" }),
    }),
    manifestV2({
      capabilities: capabilityMap({ durableObservation: "experimental" }),
    }),
    manifestV2({
      lifecycle: lifecycleMap({ "session.committed": "observe" }),
    }),
    manifestV2({
      capabilities: capabilityMap({ runLifecycle: "experimental" }),
    }),
    manifestV2({
      lifecycle: lifecycleMap({ "run.error": "observe" }),
    }),
  ];

  for (const value of contradictions) {
    assert.throws(
      () => defineAdapterManifest(value),
      /cave_adapter_capability_lifecycle_mismatch:/,
    );
  }

  assert.throws(
    () => defineAdapterManifest(manifestV2({
      capabilities: capabilityMap({ toolObservation: "experimental" }),
      lifecycle: lifecycleMap({ "tool.started": "intercept" }),
    })),
    /cave_adapter_lifecycle_capability_observe_only:tool.started/,
  );
});

test("manifest versions are exact SemVer, never tags or ranges", () => {
  for (const version of ["latest", "next", "^1.2.3", "~1.2.3", ">=1.2.3", "1.2", "01.2.3", "1.02.3", "1.2.03"]) {
    assert.throws(
      () => defineAdapterManifest(manifestV2({
        upstream: { package: "fixture", version },
      })),
      /cave_adapter_manifest_invalid/,
    );
  }

  for (const version of ["0.0.0", "1.2.3", "1.2.3-beta.1", "1.2.3+build.7", "1.2.3-rc.1+sha.abc"]) {
    assert.equal(defineAdapterManifest(manifestV2({
      upstream: { package: "fixture", version },
    })).upstream.version, version);
  }
});

test("registry is deterministic discovery metadata only", () => {
  const registry = createAdapterRegistry();
  const second = defineAdapterPackage({
    manifest: manifestV1({ id: "second", packageName: "@caveman-ai/adapter-second" }),
    createAdapter: () => ({ id: "second" }),
  });
  const first = defineAdapterPackage({
    manifest: manifestV2({ id: "first", packageName: "@caveman-ai/adapter-first" }),
    createAdapter: () => ({ id: "first" }),
  });

  registry.register(second);
  registry.register(first);
  assert.equal(registry.get("first")?.manifest.schemaVersion, 2);
  assert.equal(registry.get("missing"), undefined);
  assert.equal(Object.hasOwn(registry, "require"), false);
  assert.deepEqual(registry.list().map((entry) => entry.manifest.id), ["first", "second"]);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.throws(() => registry.register(first), /cave_adapter_duplicate:first/);
});

test("every discovered adapter package has a valid manifest aligned with exact package pins", async () => {
  const directories = (await readdir(adaptersRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(directories.length > 0);

  const ids = new Set();
  for (const directory of directories) {
    const packageRoot = resolve(adaptersRoot, directory);
    const packageJSON = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    const module = await import(pathToFileURL(resolve(packageRoot, "src/manifest.js")));
    const defined = defineAdapterManifest(module.adapterManifest);
    assert.ok(defined.schemaVersion === 1 || defined.schemaVersion === 2);
    assert.equal(Object.isFrozen(module.adapterManifest.capabilities), true);
    assert.equal(defined.packageName, packageJSON.name);
    assert.equal(defined.adapterVersion, packageJSON.version);
    assert.equal(packageJSON.peerDependencies[defined.upstream.package], defined.upstream.version);
    // An adapter that also carries the upstream as a devDependency is testing
    // against that copy. Dependabot bumps devDependencies and cannot see
    // peerDependencies, so without this the conformance suite silently starts
    // proving a version the published contract does not permit.
    for (const [name, range] of Object.entries(packageJSON.peerDependencies ?? {})) {
      const dev = packageJSON.devDependencies?.[name];
      if (dev !== undefined) {
        assert.equal(dev, range,
          `${packageJSON.name}: devDependency ${name}@${dev} must match peerDependency ${range}`);
      }
    }
    assert.equal(ids.has(defined.id), false, `duplicate adapter id ${defined.id}`);
    ids.add(defined.id);
  }
});
