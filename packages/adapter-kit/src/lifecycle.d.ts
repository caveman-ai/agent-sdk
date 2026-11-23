export const ADAPTER_LIFECYCLE_PHASES: readonly [
  "run.started",
  "run.completed",
  "run.error",
  "model.requested",
  "model.responded",
  "model.error",
  "tool.proposed",
  "tool.started",
  "tool.completed",
  "tool.error",
  "checkpoint.committed",
  "session.committed",
];

export type AdapterLifecyclePhase = typeof ADAPTER_LIFECYCLE_PHASES[number];
export type AdapterLifecycleAccess = "unsupported" | "observe" | "intercept";
export const ADAPTER_LIFECYCLE_ACCESS: readonly AdapterLifecycleAccess[];

export interface AdapterLifecycleSourceIdentity {
  readonly runId: string;
  readonly stepId?: string;
  readonly modelCallId?: string;
  readonly toolCallId?: string;
  readonly attempt: number;
}

export interface AdapterLifecycleIdentity {
  readonly runId: string;
  readonly stepId?: string;
  readonly modelCallId?: string;
  readonly toolCallId?: string;
  readonly attempt: number;
  readonly replay: boolean;
  readonly replaySource?: AdapterLifecycleSourceIdentity;
  readonly nativeIds: Readonly<Record<string, string>>;
}

export interface AdapterLifecycleEvent {
  readonly schemaVersion: 1;
  readonly seq: number;
  readonly phase: AdapterLifecyclePhase;
  readonly identity: AdapterLifecycleIdentity;
}

export type AdapterLifecycleCapabilities = Readonly<
  Record<AdapterLifecyclePhase, AdapterLifecycleAccess>
>;

export interface AdapterLifecycleValidator {
  accept(value: AdapterLifecycleEvent): AdapterLifecycleEvent;
  /** Seal one bounded batch; every started run must be terminal. Idempotent. */
  finish(): void;
}

export interface AdapterLifecycleValidatorOptions {
  readonly maxRuns?: number;
  readonly maxScopesPerRun?: number;
}

export function defineAdapterLifecycleIdentity(
  value: AdapterLifecycleIdentity,
): AdapterLifecycleIdentity;
export function defineAdapterLifecycleEvent(value: AdapterLifecycleEvent): AdapterLifecycleEvent;
export function defineAdapterLifecycleCapabilities(
  value: AdapterLifecycleCapabilities,
): AdapterLifecycleCapabilities;
export function createAdapterLifecycleValidator(
  options?: AdapterLifecycleValidatorOptions,
): AdapterLifecycleValidator;
