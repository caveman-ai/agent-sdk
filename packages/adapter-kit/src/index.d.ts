import type { AdapterLifecycleCapabilities } from "./lifecycle.js";

export const ADAPTER_CAPABILITIES_V1: readonly [
  "run",
  "stream",
  "tools",
  "usage",
  "abort",
  "durable",
  "compile",
];

export type AdapterCapabilityV1 = typeof ADAPTER_CAPABILITIES_V1[number];

export const ADAPTER_CAPABILITIES: readonly [
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
];

export type AdapterCapability = typeof ADAPTER_CAPABILITIES[number];
export type AdapterCapabilityState = "unsupported" | "experimental" | "certified";

export const ADAPTER_CAPABILITY_STATES: readonly AdapterCapabilityState[];
export const ADAPTER_CONFORMANCE_SUITE: "@caveman-ai/adapter-conformance/v1";

export interface AdapterCertificationEvidence {
  readonly suite: typeof ADAPTER_CONFORMANCE_SUITE;
  readonly reportSHA256: string;
}

export type AdapterCertification = AdapterCertificationEvidence;

interface AdapterManifestBase {
  readonly id: string;
  readonly packageName: `@caveman-ai/${string}`;
  readonly adapterVersion: string;
  readonly upstream: {
    readonly package: string;
    readonly version: string;
  };
}

export interface AdapterManifestV1 extends AdapterManifestBase {
  readonly schemaVersion: 1;
  readonly capabilities: Readonly<Record<AdapterCapabilityV1, AdapterCapabilityState>>;
  readonly certifications: Readonly<
    Partial<Record<AdapterCapabilityV1, AdapterCertificationEvidence>>
  >;
}

export interface AdapterManifestV2 extends AdapterManifestBase {
  readonly schemaVersion: 2;
  readonly capabilities: Readonly<Record<AdapterCapability, AdapterCapabilityState>>;
  readonly lifecycle: AdapterLifecycleCapabilities;
  readonly certifications: Readonly<
    Partial<Record<AdapterCapability, AdapterCertificationEvidence>>
  >;
}

export type AdapterManifest = AdapterManifestV1 | AdapterManifestV2;

export interface AdapterPackage<TFactory extends (...args: any[]) => unknown = (...args: any[]) => unknown> {
  readonly manifest: AdapterManifest;
  readonly createAdapter: TFactory;
}

export interface AdapterRegistry {
  register<TFactory extends (...args: any[]) => unknown>(
    value: AdapterPackage<TFactory>,
  ): AdapterPackage<TFactory>;
  get(id: string): AdapterPackage | undefined;
  list(): readonly AdapterPackage[];
}

export function defineAdapterManifest<TManifest extends AdapterManifest>(
  value: TManifest,
): TManifest;
export function defineAdapterPackage<TFactory extends (...args: any[]) => unknown>(
  value: AdapterPackage<TFactory>,
): AdapterPackage<TFactory>;
export function createAdapterRegistry(): AdapterRegistry;

export * from "./lifecycle.js";
