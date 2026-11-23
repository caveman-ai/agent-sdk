import { defineAdapterLifecycleCapabilities } from "./lifecycle.js";
import { snapshotDataDictionary, snapshotDataRecord } from "./data.js";

const CAPABILITY_NAMES_V1 = Object.freeze([
  "run",
  "stream",
  "tools",
  "usage",
  "abort",
  "durable",
  "compile",
]);

const CAPABILITY_NAMES = Object.freeze([
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

const CAPABILITY_STATES = Object.freeze([
  "unsupported",
  "experimental",
  "certified",
]);

const MANIFEST_KEYS_V1 = Object.freeze([
  "schemaVersion",
  "id",
  "packageName",
  "adapterVersion",
  "upstream",
  "capabilities",
  "certifications",
]);

const MANIFEST_KEYS = Object.freeze([
  ...MANIFEST_KEYS_V1,
  "lifecycle",
]);

const RUN_PHASES = Object.freeze([
  "run.started",
  "run.completed",
  "run.error",
]);
const TOOL_PHASES = Object.freeze([
  "tool.proposed",
  "tool.started",
  "tool.completed",
  "tool.error",
]);
const DURABLE_PHASES = Object.freeze([
  "checkpoint.committed",
  "session.committed",
]);

const CERTIFICATION_SUITE = "@caveman-ai/adapter-conformance/v1";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PACKAGE_NAME = /^@caveman-ai\/[a-z0-9][a-z0-9-]{0,95}$/;
const EXACT_SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const UPSTREAM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;

export {
  ADAPTER_LIFECYCLE_ACCESS,
  ADAPTER_LIFECYCLE_PHASES,
  createAdapterLifecycleValidator,
  defineAdapterLifecycleCapabilities,
  defineAdapterLifecycleEvent,
  defineAdapterLifecycleIdentity,
} from "./lifecycle.js";

export const ADAPTER_CAPABILITIES = CAPABILITY_NAMES;
export const ADAPTER_CAPABILITIES_V1 = CAPABILITY_NAMES_V1;
export const ADAPTER_CAPABILITY_STATES = CAPABILITY_STATES;
export const ADAPTER_CONFORMANCE_SUITE = CERTIFICATION_SUITE;

export function defineAdapterManifest(value) {
  const manifest = snapshotDataDictionary(
    value,
    MANIFEST_KEYS.length,
    "cave_adapter_manifest_invalid",
  );
  if (manifest.schemaVersion === 1) {
    return defineAdapterManifestV1(manifest);
  }
  if (manifest.schemaVersion === 2) {
    return defineAdapterManifestV2(manifest);
  }
  throw new Error("cave_adapter_manifest_invalid");
}

export function defineAdapterPackage(value) {
  const adapterPackage = snapshotDataRecord(
    value,
    ["manifest", "createAdapter"],
    ["manifest", "createAdapter"],
    "cave_adapter_package_invalid",
  );
  if (typeof adapterPackage.createAdapter !== "function") {
    throw new Error("cave_adapter_package_invalid");
  }
  return Object.freeze({
    manifest: defineAdapterManifest(adapterPackage.manifest),
    createAdapter: adapterPackage.createAdapter,
  });
}

export function createAdapterRegistry() {
  const packagesByID = new Map();
  const idsByPackage = new Map();

  return Object.freeze({
    register(value) {
      const adapterPackage = defineAdapterPackage(value);
      const { id, packageName } = adapterPackage.manifest;
      if (packagesByID.has(id) || idsByPackage.has(packageName)) {
        throw new Error(`cave_adapter_duplicate:${id}`);
      }
      packagesByID.set(id, adapterPackage);
      idsByPackage.set(packageName, id);
      return adapterPackage;
    },
    get(id) {
      return packagesByID.get(id);
    },
    list() {
      return Object.freeze(
        [...packagesByID.values()]
          .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id)),
      );
    },
  });
}

function defineAdapterManifestV1(value) {
  const envelope = normalizeManifestEnvelope(value, 1, MANIFEST_KEYS_V1, CAPABILITY_NAMES_V1);
  const evidence = normalizeCapabilityEvidence(
    envelope.capabilities,
    envelope.certifications,
    CAPABILITY_NAMES_V1,
  );
  return deepFreeze({
    schemaVersion: 1,
    id: envelope.id,
    packageName: envelope.packageName,
    adapterVersion: envelope.adapterVersion,
    upstream: envelope.upstream,
    ...evidence,
  });
}

function defineAdapterManifestV2(value) {
  const envelope = normalizeManifestEnvelope(value, 2, MANIFEST_KEYS, CAPABILITY_NAMES);
  const evidence = normalizeCapabilityEvidence(
    envelope.capabilities,
    envelope.certifications,
    CAPABILITY_NAMES,
  );
  const lifecycle = defineAdapterLifecycleCapabilities(envelope.lifecycle);
  validateLifecycleConsistency(evidence.capabilities, lifecycle);
  return deepFreeze({
    schemaVersion: 2,
    id: envelope.id,
    packageName: envelope.packageName,
    adapterVersion: envelope.adapterVersion,
    upstream: envelope.upstream,
    ...evidence,
    lifecycle,
  });
}

function normalizeManifestEnvelope(value, schemaVersion, manifestKeys, capabilityNames) {
  const manifest = snapshotDataRecord(
    value,
    manifestKeys,
    manifestKeys,
    "cave_adapter_manifest_invalid",
  );
  const upstream = snapshotDataRecord(
    manifest.upstream,
    ["package", "version"],
    ["package", "version"],
    "cave_adapter_manifest_invalid",
  );
  const capabilities = snapshotDataRecord(
    manifest.capabilities,
    capabilityNames,
    capabilityNames,
    "cave_adapter_manifest_invalid",
  );
  const certifications = snapshotDataDictionary(
    manifest.certifications,
    capabilityNames.length,
    "cave_adapter_manifest_invalid",
  );
  if (manifest.schemaVersion !== schemaVersion || !ID.test(manifest.id) ||
      !PACKAGE_NAME.test(manifest.packageName) || !isExactSemver(manifest.adapterVersion) ||
      typeof upstream.package !== "string" || !UPSTREAM_PACKAGE.test(upstream.package) ||
      !isExactSemver(upstream.version)) {
    throw new Error("cave_adapter_manifest_invalid");
  }
  return {
    id: manifest.id,
    packageName: manifest.packageName,
    adapterVersion: manifest.adapterVersion,
    upstream: { package: upstream.package, version: upstream.version },
    capabilities,
    certifications,
    ...(schemaVersion === 2 ? { lifecycle: manifest.lifecycle } : {}),
  };
}

function normalizeCapabilityEvidence(capabilities, certifications, capabilityNames) {
  const normalizedCapabilities = {};
  const normalizedCertifications = {};
  for (const capability of capabilityNames) {
    const state = capabilities[capability];
    if (!CAPABILITY_STATES.includes(state)) {
      throw new Error(`cave_adapter_capability_state_invalid:${capability}`);
    }
    if (state === "certified") {
      normalizedCertifications[capability] = normalizeCertificationEvidence(
        capability,
        certifications[capability],
      );
    } else if (Object.hasOwn(certifications, capability)) {
      throw new Error(`cave_adapter_certification_without_capability:${capability}`);
    }
    normalizedCapabilities[capability] = state;
  }

  if (Object.keys(certifications).some((name) => !capabilityNames.includes(name))) {
    throw new Error("cave_adapter_certification_unknown_capability");
  }
  return {
    capabilities: normalizedCapabilities,
    certifications: normalizedCertifications,
  };
}

function validateLifecycleConsistency(capabilities, lifecycle) {
  assertCapabilityMatches(
    "contextTransformation",
    capabilities.contextTransformation !== "unsupported",
    lifecycle["model.requested"] === "intercept",
  );
  assertCapabilityMatches(
    "modelInterception",
    capabilities.modelInterception !== "unsupported",
    lifecycle["model.requested"] === "intercept",
  );
  assertCapabilityMatches(
    "toolObservation",
    capabilities.toolObservation !== "unsupported",
    hasObservation(lifecycle, TOOL_PHASES),
  );
  assertCapabilityMatches(
    "durableObservation",
    capabilities.durableObservation !== "unsupported",
    hasObservation(lifecycle, DURABLE_PHASES),
  );
  assertCapabilityMatches(
    "runLifecycle",
    capabilities.runLifecycle !== "unsupported",
    hasObservation(lifecycle, RUN_PHASES),
  );
}

function isExactSemver(value) {
  return typeof value === "string" && value.length <= 128 && EXACT_SEMVER.test(value);
}

function assertCapabilityMatches(capability, supported, lifecyclePresent) {
  if (supported !== lifecyclePresent) {
    throw new Error(`cave_adapter_capability_lifecycle_mismatch:${capability}`);
  }
}

function hasObservation(lifecycle, phases) {
  return phases.some((phase) => lifecycle[phase] === "observe");
}

function normalizeCertificationEvidence(capability, value) {
  let evidence;
  try {
    evidence = snapshotDataRecord(
      value,
      ["suite", "reportSHA256"],
      ["suite", "reportSHA256"],
      `cave_adapter_certification_invalid:${capability}`,
    );
  } catch {
    throw new Error(`cave_adapter_certification_invalid:${capability}`);
  }
  if (evidence.suite !== CERTIFICATION_SUITE ||
      typeof evidence.reportSHA256 !== "string" || !HEX_64.test(evidence.reportSHA256)) {
    throw new Error(`cave_adapter_certification_invalid:${capability}`);
  }
  return { suite: evidence.suite, reportSHA256: evidence.reportSHA256 };
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
