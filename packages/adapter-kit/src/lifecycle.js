const LIFECYCLE_PHASE_NAMES = Object.freeze([
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
]);

const LIFECYCLE_ACCESS_LEVELS = Object.freeze([
  "unsupported",
  "observe",
  "intercept",
]);

const IDENTITY_KEYS = Object.freeze([
  "runId",
  "stepId",
  "modelCallId",
  "toolCallId",
  "attempt",
  "replay",
  "replaySource",
  "nativeIds",
]);
const IDENTITY_REQUIRED_KEYS = Object.freeze(["runId", "attempt", "replay", "nativeIds"]);
const SOURCE_KEYS = Object.freeze([
  "runId",
  "stepId",
  "modelCallId",
  "toolCallId",
  "attempt",
]);
const EVENT_KEYS = Object.freeze(["schemaVersion", "seq", "phase", "identity"]);
const VALIDATOR_OPTION_KEYS = Object.freeze(["maxRuns", "maxScopesPerRun"]);
const DEFAULT_MAX_RUNS = 64;
const DEFAULT_MAX_SCOPES_PER_RUN = 1_024;
const MAX_RUNS = 100_000;
const MAX_SCOPES_PER_RUN = 1_000_000;
const MAX_NATIVE_ID_ENTRIES = 16;
const MAX_NATIVE_ID_CHARS = 4_096;
const NORMALIZED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const NATIVE_ID_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const RUN_PHASES = new Set(["run.started", "run.completed", "run.error"]);
const MODEL_PHASES = new Set(["model.requested", "model.responded", "model.error"]);
const TOOL_PHASES = new Set([
  "tool.proposed",
  "tool.started",
  "tool.completed",
  "tool.error",
]);
const COMMIT_PHASES = new Set(["checkpoint.committed", "session.committed"]);

export const ADAPTER_LIFECYCLE_PHASES = LIFECYCLE_PHASE_NAMES;
export const ADAPTER_LIFECYCLE_ACCESS = LIFECYCLE_ACCESS_LEVELS;

export function defineAdapterLifecycleIdentity(value) {
  const identity = snapshotDataRecord(
    value,
    IDENTITY_KEYS,
    IDENTITY_REQUIRED_KEYS,
    "cave_adapter_lifecycle_identity_invalid",
  );
  if (!isNormalizedId(identity.runId) || !isAttempt(identity.attempt) ||
      typeof identity.replay !== "boolean") {
    throw new Error("cave_adapter_lifecycle_identity_invalid");
  }
  const nativeIds = normalizeNativeIdentityMap(identity.nativeIds);

  for (const key of ["stepId", "modelCallId", "toolCallId"]) {
    if (identity[key] !== undefined && !isNormalizedId(identity[key])) {
      throw new Error(`cave_adapter_lifecycle_identity_invalid:${key}`);
    }
  }

  let replaySource;
  if (identity.replaySource !== undefined) {
    if (!identity.replay) {
      throw new Error("cave_adapter_lifecycle_identity_invalid:replaySource");
    }
    replaySource = normalizeSourceIdentity(identity.replaySource);
  }

  const normalized = {
    runId: identity.runId,
    ...(identity.stepId === undefined ? {} : { stepId: identity.stepId }),
    ...(identity.modelCallId === undefined ? {} : { modelCallId: identity.modelCallId }),
    ...(identity.toolCallId === undefined ? {} : { toolCallId: identity.toolCallId }),
    attempt: identity.attempt,
    replay: identity.replay,
    ...(replaySource === undefined
      ? {}
      : { replaySource }),
    nativeIds: Object.fromEntries(
      Object.entries(nativeIds).sort(([left], [right]) => compareStrings(left, right)),
    ),
  };
  return deepFreeze(normalized);
}

export function defineAdapterLifecycleEvent(value) {
  const event = snapshotDataRecord(
    value,
    EVENT_KEYS,
    EVENT_KEYS,
    "cave_adapter_lifecycle_event_invalid",
  );
  if (event.schemaVersion !== 1 || !Number.isSafeInteger(event.seq) ||
      event.seq < 0 || !LIFECYCLE_PHASE_NAMES.includes(event.phase)) {
    throw new Error("cave_adapter_lifecycle_event_invalid");
  }

  const identity = defineAdapterLifecycleIdentity(event.identity);
  validatePhaseScope(event.phase, identity);
  return deepFreeze({
    schemaVersion: 1,
    seq: event.seq,
    phase: event.phase,
    identity,
  });
}

export function defineAdapterLifecycleCapabilities(value) {
  const defined = defineAccessMap(value, LIFECYCLE_PHASE_NAMES, "lifecycle");
  for (const phase of LIFECYCLE_PHASE_NAMES) {
    if (defined[phase] === "intercept" && phase !== "model.requested") {
      throw new Error(`cave_adapter_lifecycle_capability_observe_only:${phase}`);
    }
  }
  return defined;
}

export function createAdapterLifecycleValidator(options = {}) {
  const normalizedOptions = snapshotDataRecord(
    options,
    VALIDATOR_OPTION_KEYS,
    [],
    "cave_adapter_lifecycle_validator_options_invalid",
  );
  const maxRuns = normalizedOptions.maxRuns ?? DEFAULT_MAX_RUNS;
  const maxScopesPerRun = normalizedOptions.maxScopesPerRun ?? DEFAULT_MAX_SCOPES_PER_RUN;
  if (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > MAX_RUNS ||
      !Number.isSafeInteger(maxScopesPerRun) || maxScopesPerRun < 0 ||
      maxScopesPerRun > MAX_SCOPES_PER_RUN) {
    throw new Error("cave_adapter_lifecycle_validator_options_invalid");
  }

  const runs = new Map();
  let failure;
  let finished = false;

  return Object.freeze({
    accept(value) {
      if (failure !== undefined) throw failure;
      if (finished) throw new Error("cave_adapter_lifecycle_validator_finished");
      try {
        const event = defineAdapterLifecycleEvent(value);
        const { identity, phase, seq } = event;
        const existingRun = runs.get(identity.runId);

        if (phase === "run.started") {
          if (existingRun !== undefined) {
            const kind = existingRun.terminal === undefined
              ? "duplicate_start"
              : "terminal_followed_by_event";
            throw lifecycleError(kind, phase, identity.runId);
          }
          if (runs.size >= maxRuns) {
            throw lifecycleError("capacity_exceeded", phase, identity.runId);
          }
          runs.set(identity.runId, {
            lastSeq: seq,
            replaySignature: replaySignature(identity),
            runIdentitySignature: identitySignature(identity),
            terminal: undefined,
            models: new Map(),
            tools: new Map(),
            stepScopes: new Set(),
            modelScopes: new Map(),
            toolScopes: new Map(),
          });
          return event;
        }

        if (existingRun === undefined) {
          const kind = RUN_PHASES.has(phase) ? "completion_without_start" : "run_not_started";
          throw lifecycleError(kind, phase, identity.runId);
        }
        if (existingRun.terminal !== undefined) {
          throw lifecycleError("terminal_followed_by_event", phase, identity.runId);
        }
        if (seq <= existingRun.lastSeq) {
          throw lifecycleError("sequence_non_monotonic", phase, identity.runId);
        }
        if (replaySignature(identity) !== existingRun.replaySignature) {
          throw lifecycleError("scope_mismatch", phase, identity.runId);
        }

        validateKnownScopes(identity, existingRun, phase);
        validateScopeCapacity(identity, existingRun, maxScopesPerRun, phase);
        applyEvent(existingRun, event);
        registerScopes(identity, existingRun);
        existingRun.lastSeq = seq;
        return event;
      } catch (error) {
        failure = error instanceof Error
          ? error
          : new Error("cave_adapter_lifecycle_validator_failed");
        throw failure;
      }
    },
    finish() {
      if (failure !== undefined) throw failure;
      if (finished) return;
      for (const [runId, run] of runs) {
        if (run.terminal === undefined) {
          failure = new Error(`cave_adapter_lifecycle_open_run:${runId}`);
          throw failure;
        }
      }
      finished = true;
    },
  });
}

function applyEvent(run, event) {
  const { identity, phase } = event;

  if (phase === "run.completed" || phase === "run.error") {
    if (identitySignature(identity) !== run.runIdentitySignature) {
      throw lifecycleError("scope_mismatch", phase, identity.runId);
    }
    if ([...run.models.values()].some((model) => !model.terminal) ||
        [...run.tools.values()].some((tool) => tool.started && !tool.terminal)) {
      throw lifecycleError("open_scope", phase, identity.runId);
    }
    run.terminal = phase;
    return;
  }

  if (MODEL_PHASES.has(phase)) {
    applyModelEvent(run, event);
    return;
  }

  if (TOOL_PHASES.has(phase)) {
    applyToolEvent(run, event);
  }
}

function applyModelEvent(run, event) {
  const { identity, phase } = event;
  const current = run.models.get(identity.modelCallId);

  if (phase === "model.requested") {
    if (current === undefined) {
      if (identity.attempt !== 1) {
        throw lifecycleError("attempt_invalid", phase, identity.modelCallId);
      }
    } else {
      if (identity.attempt === current.attempt) {
        throw lifecycleError("duplicate_start", phase, identity.modelCallId);
      }
      if (!current.terminal || identity.attempt !== current.attempt + 1) {
        throw lifecycleError("attempt_invalid", phase, identity.modelCallId);
      }
    }
    run.models.set(identity.modelCallId, {
      attempt: identity.attempt,
      identitySignature: identitySignature(identity),
      terminal: false,
    });
    return;
  }

  if (current === undefined || current.attempt !== identity.attempt) {
    throw lifecycleError("completion_without_start", phase, identity.modelCallId);
  }
  if (current.identitySignature !== identitySignature(identity)) {
    throw lifecycleError("scope_mismatch", phase, identity.modelCallId);
  }
  if (current.terminal) {
    throw lifecycleError("terminal_followed_by_event", phase, identity.modelCallId);
  }
  current.terminal = true;
}

function applyToolEvent(run, event) {
  const { identity, phase } = event;
  const current = run.tools.get(identity.toolCallId);
  const canOpenAttempt = phase === "tool.proposed" || phase === "tool.started";
  let tool = current;
  let createsAttempt = false;

  if (tool === undefined || identity.attempt !== tool.attempt) {
    if (!canOpenAttempt) {
      throw lifecycleError("completion_without_start", phase, identity.toolCallId);
    }
    if (tool === undefined) {
      if (identity.attempt !== 1) {
        throw lifecycleError("attempt_invalid", phase, identity.toolCallId);
      }
    } else if (!tool.terminal || identity.attempt !== tool.attempt + 1) {
      throw lifecycleError("attempt_invalid", phase, identity.toolCallId);
    }
    tool = {
      attempt: identity.attempt,
      identitySignature: identitySignature(identity),
      proposed: false,
      started: false,
      terminal: false,
    };
    createsAttempt = true;
  } else if (tool.identitySignature !== identitySignature(identity)) {
    throw lifecycleError("scope_mismatch", phase, identity.toolCallId);
  }

  validateToolTransition(tool, phase, identity.toolCallId);
  if (createsAttempt) run.tools.set(identity.toolCallId, tool);

  if (phase === "tool.proposed") tool.proposed = true;
  else if (phase === "tool.started") tool.started = true;
  else if (phase === "tool.completed" || phase === "tool.error") tool.terminal = true;
}

function validateToolTransition(tool, phase, toolCallId) {
  if (tool.terminal) {
    throw lifecycleError("terminal_followed_by_event", phase, toolCallId);
  }
  if (phase === "tool.proposed" &&
      (tool.proposed || tool.started)) {
    throw lifecycleError(tool.proposed ? "duplicate_start" : "phase_out_of_order", phase, toolCallId);
  }
  if (phase === "tool.started") {
    if (tool.started) throw lifecycleError("duplicate_start", phase, toolCallId);
  }
  if (phase === "tool.completed" && !tool.started) {
    throw lifecycleError("completion_without_start", phase, toolCallId);
  }
  if (phase === "tool.error" && !tool.proposed && !tool.started) {
    throw lifecycleError("completion_without_start", phase, toolCallId);
  }
}

function validateKnownScopes(identity, run, phase) {
  if (identity.modelCallId !== undefined) {
    assertScope(
      run.modelScopes.get(identity.modelCallId),
      identity.stepId,
      phase,
      identity.modelCallId,
    );
  }
  if (identity.toolCallId !== undefined) {
    assertScope(
      run.toolScopes.get(identity.toolCallId),
      identity.stepId,
      phase,
      identity.toolCallId,
    );
  }
}

function validateScopeCapacity(identity, run, maxScopesPerRun, phase) {
  let additions = 0;
  if (identity.stepId !== undefined && !run.stepScopes.has(identity.stepId)) additions += 1;
  if (identity.modelCallId !== undefined && !run.modelScopes.has(identity.modelCallId)) additions += 1;
  if (identity.toolCallId !== undefined && !run.toolScopes.has(identity.toolCallId)) additions += 1;
  const current = run.stepScopes.size + run.modelScopes.size + run.toolScopes.size;
  if (current + additions > maxScopesPerRun) {
    throw lifecycleError("capacity_exceeded", phase, identity.runId);
  }
}

function registerScopes(identity, run) {
  if (identity.stepId !== undefined) run.stepScopes.add(identity.stepId);
  if (identity.modelCallId !== undefined && !run.modelScopes.has(identity.modelCallId)) {
    run.modelScopes.set(identity.modelCallId, identity.stepId);
  }
  if (identity.toolCallId !== undefined && !run.toolScopes.has(identity.toolCallId)) {
    run.toolScopes.set(identity.toolCallId, identity.stepId);
  }
}

function assertScope(actual, expected, phase, id) {
  if (actual !== undefined && actual !== expected) {
    throw lifecycleError("scope_mismatch", phase, id);
  }
}

function validatePhaseScope(phase, identity) {
  const hasStep = identity.stepId !== undefined;
  const hasModel = identity.modelCallId !== undefined;
  const hasTool = identity.toolCallId !== undefined;
  let valid = false;

  if (RUN_PHASES.has(phase)) valid = !hasStep && !hasModel && !hasTool && identity.attempt === 1;
  else if (MODEL_PHASES.has(phase)) valid = hasStep && hasModel && !hasTool;
  else if (TOOL_PHASES.has(phase)) {
    valid = hasStep && !hasModel && hasTool;
  } else if (COMMIT_PHASES.has(phase)) {
    valid = hasStep && !hasModel && !hasTool && identity.attempt === 1;
  }

  if (!valid) throw lifecycleError("scope_mismatch", phase, identity.runId);
}

function defineAccessMap(value, keys, kind) {
  const code = `cave_adapter_${kind}_capabilities_invalid`;
  const access = snapshotDataRecord(value, keys, keys, code);
  for (const key of keys) {
    if (!LIFECYCLE_ACCESS_LEVELS.includes(access[key])) {
      throw new Error(`cave_adapter_${kind}_capability_invalid:${key}`);
    }
  }
  return deepFreeze(Object.fromEntries(keys.map((key) => [key, access[key]])));
}

function normalizeSourceIdentity(value) {
  const source = snapshotDataRecord(
    value,
    SOURCE_KEYS,
    ["runId", "attempt"],
    "cave_adapter_lifecycle_identity_invalid:replaySource",
  );
  if (!isNormalizedId(source.runId) || !isAttempt(source.attempt) ||
      !["stepId", "modelCallId", "toolCallId"].every(
        (key) => source[key] === undefined || isNormalizedId(source[key]),
      )) {
    throw new Error("cave_adapter_lifecycle_identity_invalid:replaySource");
  }
  return {
    runId: source.runId,
    ...(source.stepId === undefined ? {} : { stepId: source.stepId }),
    ...(source.modelCallId === undefined ? {} : { modelCallId: source.modelCallId }),
    ...(source.toolCallId === undefined ? {} : { toolCallId: source.toolCallId }),
    attempt: source.attempt,
  };
}

function normalizeNativeIdentityMap(value) {
  let nativeIds;
  try {
    nativeIds = snapshotDataDictionary(
      value,
      MAX_NATIVE_ID_ENTRIES,
      "cave_adapter_lifecycle_identity_invalid",
    );
  } catch {
    throw new Error("cave_adapter_lifecycle_identity_invalid");
  }
  const entries = Object.entries(nativeIds);
  let totalChars = 0;
  for (const [key, nativeId] of entries) {
    if (!NATIVE_ID_KEY.test(key) || typeof nativeId !== "string" ||
        nativeId.length === 0 || nativeId.length > MAX_NATIVE_ID_CHARS ||
        /[\0\r\n]/u.test(nativeId)) {
      throw new Error("cave_adapter_lifecycle_identity_invalid");
    }
    totalChars += key.length + nativeId.length;
    if (totalChars > MAX_NATIVE_ID_CHARS) {
      throw new Error("cave_adapter_lifecycle_identity_invalid");
    }
  }
  return nativeIds;
}

function isNormalizedId(value) {
  return typeof value === "string" && NORMALIZED_ID.test(value);
}

function isAttempt(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function replaySignature(identity) {
  return JSON.stringify([identity.replay, identity.replaySource ?? null]);
}

function identitySignature(identity) {
  return JSON.stringify([
    identity.runId,
    identity.stepId ?? null,
    identity.modelCallId ?? null,
    identity.toolCallId ?? null,
    identity.attempt,
    identity.replay,
    identity.replaySource ?? null,
    Object.entries(identity.nativeIds).sort(([left], [right]) => compareStrings(left, right)),
  ]);
}

function lifecycleError(kind, phase, id) {
  return new Error(`cave_adapter_lifecycle_${kind}:${phase}:${id}`);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
import { snapshotDataDictionary, snapshotDataRecord } from "./data.js";
