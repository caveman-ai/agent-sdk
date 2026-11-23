import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTER_LIFECYCLE_PHASES,
  createAdapterLifecycleValidator,
  defineAdapterLifecycleCapabilities,
  defineAdapterLifecycleEvent,
  defineAdapterLifecycleIdentity,
} from "../src/index.js";

function identity(overrides = {}) {
  return {
    runId: "run-1",
    attempt: 1,
    replay: false,
    nativeIds: { frameworkRun: "native-run-1" },
    ...overrides,
  };
}

function event(seq, phase, identityOverrides = {}) {
  return {
    schemaVersion: 1,
    seq,
    phase,
    identity: identity(identityOverrides),
  };
}

function accessMap(keys, value = "unsupported") {
  return Object.fromEntries(keys.map((key) => [key, value]));
}

test("identity snapshots immutable normalized and native identities", () => {
  const source = identity({
    stepId: "step-1",
    modelCallId: "model-1",
    replay: true,
    replaySource: { runId: "run-origin", stepId: "step-origin", attempt: 2 },
    nativeIds: { frameworkRun: "native-run-1", frameworkCall: "native-model-1" },
  });
  const defined = defineAdapterLifecycleIdentity(source);

  source.nativeIds.frameworkCall = "changed";
  source.replaySource.runId = "changed";
  assert.equal(defined.nativeIds.frameworkCall, "native-model-1");
  assert.equal(defined.replaySource.runId, "run-origin");
  assert.equal(Object.isFrozen(defined), true);
  assert.equal(Object.isFrozen(defined.nativeIds), true);
  assert.equal(Object.isFrozen(defined.replaySource), true);
});

test("identity rejects missing, unstable, or contradictory identity fields", () => {
  assert.throws(
    () => defineAdapterLifecycleIdentity({ ...identity(), attempt: 0 }),
    /cave_adapter_lifecycle_identity_invalid/,
  );
  assert.throws(
    () => defineAdapterLifecycleIdentity({ ...identity(), runId: "run with spaces" }),
    /cave_adapter_lifecycle_identity_invalid/,
  );
  assert.throws(
    () => defineAdapterLifecycleIdentity({ ...identity(), nativeIds: { "bad key": "x" } }),
    /cave_adapter_lifecycle_identity_invalid/,
  );
  assert.throws(
    () => defineAdapterLifecycleIdentity({
      ...identity(),
      nativeIds: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`native${index}`, `id-${index}`]),
      ),
    }),
    /cave_adapter_lifecycle_identity_invalid/,
  );
  assert.throws(
    () => defineAdapterLifecycleIdentity({
      ...identity(),
      replaySource: { runId: "run-origin", attempt: 1 },
    }),
    /cave_adapter_lifecycle_identity_invalid:replaySource/,
  );
  assert.throws(
    () => defineAdapterLifecycleIdentity({ ...identity(), unknown: true }),
    /cave_adapter_lifecycle_identity_invalid/,
  );
});

test("lifecycle boundaries consume one own-data snapshot", () => {
  let reads = 0;
  const accessorIdentity = identity();
  Object.defineProperty(accessorIdentity, "runId", {
    enumerable: true,
    get() {
      reads++;
      return "run-1";
    },
  });
  assert.throws(
    () => defineAdapterLifecycleIdentity(accessorIdentity),
    /cave_adapter_lifecycle_identity_invalid/,
  );
  assert.equal(reads, 0);

  const nativeIds = {};
  Object.defineProperty(nativeIds, "frameworkRun", {
    enumerable: true,
    get() {
      reads++;
      return "native-run-1";
    },
  });
  assert.throws(
    () => defineAdapterLifecycleIdentity(identity({ nativeIds })),
    /cave_adapter_lifecycle_identity_invalid/,
  );
  assert.equal(reads, 0);

  Object.defineProperty(Object.prototype, "stepId", {
    configurable: true,
    enumerable: true,
    value: "polluted-step",
  });
  try {
    const defined = defineAdapterLifecycleIdentity(identity());
    assert.equal(Object.hasOwn(defined, "stepId"), false);
  } finally {
    delete Object.prototype.stepId;
  }

  const lifecycle = accessMap(ADAPTER_LIFECYCLE_PHASES);
  Object.defineProperty(lifecycle, "model.requested", {
    enumerable: true,
    get() {
      reads++;
      return "intercept";
    },
  });
  assert.throws(
    () => defineAdapterLifecycleCapabilities(lifecycle),
    /cave_adapter_lifecycle_capabilities_invalid/,
  );
  assert.equal(reads, 0);
});

test("event definition enforces exact schema and phase-specific scope", () => {
  const defined = defineAdapterLifecycleEvent(event(0, "run.started"));
  assert.equal(Object.isFrozen(defined), true);
  assert.equal(Object.isFrozen(defined.identity), true);

  assert.throws(
    () => defineAdapterLifecycleEvent(event(-1, "run.started")),
    /cave_adapter_lifecycle_event_invalid/,
  );
  assert.throws(
    () => defineAdapterLifecycleEvent(event(1, "model.requested")),
    /cave_adapter_lifecycle_scope_mismatch/,
  );
  assert.throws(
    () => defineAdapterLifecycleEvent(event(1, "run.started", { stepId: "step-1" })),
    /cave_adapter_lifecycle_scope_mismatch/,
  );
  assert.throws(
    () => defineAdapterLifecycleEvent(event(1, "tool.started", {
      stepId: "step-1",
      modelCallId: "model-1",
      toolCallId: "tool-1",
    })),
    /cave_adapter_lifecycle_scope_mismatch/,
  );
});

test("public lifecycle exposes only normalized native phases", () => {
  assert.deepEqual(ADAPTER_LIFECYCLE_PHASES, [
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
});

test("lifecycle declarations allow interception only before model I/O", () => {
  const lifecycle = accessMap(ADAPTER_LIFECYCLE_PHASES);
  lifecycle["run.started"] = "observe";
  lifecycle["model.requested"] = "intercept";
  lifecycle["tool.started"] = "observe";
  const definedLifecycle = defineAdapterLifecycleCapabilities(lifecycle);
  lifecycle["run.started"] = "unsupported";
  assert.equal(definedLifecycle["run.started"], "observe");
  assert.equal(Object.isFrozen(definedLifecycle), true);

  assert.throws(
    () => defineAdapterLifecycleCapabilities({
      ...accessMap(ADAPTER_LIFECYCLE_PHASES),
      "tool.started": "intercept",
    }),
    /cave_adapter_lifecycle_capability_observe_only:tool.started/,
  );
  assert.throws(
    () => defineAdapterLifecycleCapabilities({
      ...accessMap(ADAPTER_LIFECYCLE_PHASES),
      "model.requested": "certified",
    }),
    /cave_adapter_lifecycle_capability_invalid:model.requested/,
  );

  for (const phase of ADAPTER_LIFECYCLE_PHASES.filter(
    (phase) => phase !== "model.requested",
  )) {
    assert.throws(
      () => defineAdapterLifecycleCapabilities({
        ...accessMap(ADAPTER_LIFECYCLE_PHASES),
        [phase]: "intercept",
      }),
      new RegExp(`cave_adapter_lifecycle_capability_observe_only:${phase.replace(".", "\\.")}`),
    );
  }
});

test("validator accepts ordered run model retry tool and commit lifecycle", () => {
  const validator = createAdapterLifecycleValidator();
  const accepted = [
    event(1, "run.started"),
    event(2, "model.requested", {
      stepId: "step-1",
      modelCallId: "model-1",
      nativeIds: { frameworkCall: "native-model-1" },
    }),
    event(3, "model.error", {
      stepId: "step-1",
      modelCallId: "model-1",
      nativeIds: { frameworkCall: "native-model-1" },
    }),
    event(4, "model.requested", {
      stepId: "step-1",
      modelCallId: "model-1",
      attempt: 2,
      nativeIds: { frameworkCall: "native-model-1-retry" },
    }),
    event(5, "model.responded", {
      stepId: "step-1",
      modelCallId: "model-1",
      attempt: 2,
      nativeIds: { frameworkCall: "native-model-1-retry" },
    }),
    event(6, "tool.proposed", {
      stepId: "step-1",
      toolCallId: "tool-1",
      nativeIds: { frameworkTool: "native-tool-1" },
    }),
    event(7, "tool.started", {
      stepId: "step-1",
      toolCallId: "tool-1",
      nativeIds: { frameworkTool: "native-tool-1" },
    }),
    event(8, "tool.completed", {
      stepId: "step-1",
      toolCallId: "tool-1",
      nativeIds: { frameworkTool: "native-tool-1" },
    }),
    event(9, "checkpoint.committed", {
      stepId: "step-1",
      nativeIds: { frameworkCheckpoint: "checkpoint-1" },
    }),
    event(10, "session.committed", {
      stepId: "step-1",
      nativeIds: { frameworkSession: "session-1" },
    }),
    event(11, "run.completed"),
  ].map((value) => validator.accept(value));

  assert.equal(accepted.length, 11);
  assert.equal(accepted.at(-1).phase, "run.completed");
});

test("validator permits tool start when host exposes no proposal seam", () => {
  const validator = createAdapterLifecycleValidator();
  validator.accept(event(1, "run.started"));
  validator.accept(event(2, "tool.started", {
    stepId: "step-1",
    toolCallId: "tool-1",
    nativeIds: { frameworkTool: "native-tool-1" },
  }));
  validator.accept(event(3, "tool.error", {
    stepId: "step-1",
    toolCallId: "tool-1",
    nativeIds: { frameworkTool: "native-tool-1" },
  }));
  assert.equal(validator.accept(event(4, "run.error")).phase, "run.error");
});

test("validator represents tool failure after proposal but before execution", () => {
  const validator = createAdapterLifecycleValidator();
  validator.accept(event(1, "run.started"));
  validator.accept(event(2, "tool.proposed", {
    stepId: "step-1",
    toolCallId: "tool-1",
    nativeIds: { frameworkTool: "native-tool-1" },
  }));
  validator.accept(event(3, "tool.error", {
    stepId: "step-1",
    toolCallId: "tool-1",
    nativeIds: { frameworkTool: "native-tool-1" },
  }));
  assert.equal(validator.accept(event(4, "run.error")).phase, "run.error");
});

test("validator rejects duplicate starts", () => {
  const runValidator = createAdapterLifecycleValidator();
  runValidator.accept(event(1, "run.started"));
  assert.throws(
    () => runValidator.accept(event(2, "run.started")),
    /cave_adapter_lifecycle_duplicate_start:run.started/,
  );

  const modelValidator = createAdapterLifecycleValidator();
  modelValidator.accept(event(1, "run.started"));
  const modelStart = event(2, "model.requested", {
    stepId: "step-1",
    modelCallId: "model-1",
    nativeIds: { frameworkCall: "native-model-1" },
  });
  modelValidator.accept(modelStart);
  assert.throws(
    () => modelValidator.accept({ ...modelStart, seq: 3 }),
    /cave_adapter_lifecycle_duplicate_start:model.requested/,
  );

  const toolValidator = createAdapterLifecycleValidator();
  toolValidator.accept(event(1, "run.started"));
  const toolStart = event(2, "tool.started", {
    stepId: "step-1",
    toolCallId: "tool-1",
    nativeIds: { frameworkTool: "native-tool-1" },
  });
  toolValidator.accept(toolStart);
  assert.throws(
    () => toolValidator.accept({ ...toolStart, seq: 3 }),
    /cave_adapter_lifecycle_duplicate_start:tool.started/,
  );
});

test("validator rejects completion without matching start", () => {
  const runValidator = createAdapterLifecycleValidator();
  assert.throws(
    () => runValidator.accept(event(1, "run.completed")),
    /cave_adapter_lifecycle_completion_without_start:run.completed/,
  );

  const modelValidator = createAdapterLifecycleValidator();
  modelValidator.accept(event(1, "run.started"));
  assert.throws(
    () => modelValidator.accept(event(2, "model.responded", {
      stepId: "step-1",
      modelCallId: "model-1",
      nativeIds: { frameworkCall: "native-model-1" },
    })),
    /cave_adapter_lifecycle_completion_without_start:model.responded/,
  );

  const toolValidator = createAdapterLifecycleValidator();
  toolValidator.accept(event(1, "run.started"));
  assert.throws(
    () => toolValidator.accept(event(2, "tool.completed", {
      stepId: "step-1",
      toolCallId: "tool-1",
      nativeIds: { frameworkTool: "native-tool-1" },
    })),
    /cave_adapter_lifecycle_completion_without_start:tool.completed/,
  );
});

test("validator rejects non-monotonic seq and remains failed closed", () => {
  const validator = createAdapterLifecycleValidator();
  validator.accept(event(5, "run.started"));
  let failure;
  try {
    validator.accept(event(5, "checkpoint.committed", {
      stepId: "step-1",
      nativeIds: { frameworkCheckpoint: "checkpoint-1" },
    }));
    assert.fail("expected non-monotonic seq rejection");
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /cave_adapter_lifecycle_sequence_non_monotonic/);
  assert.throws(
    () => validator.accept(event(6, "run.completed")),
    (error) => error === failure,
  );
});

test("validator rejects every event after run terminal", () => {
  const validator = createAdapterLifecycleValidator();
  validator.accept(event(1, "run.started"));
  validator.accept(event(2, "run.completed"));
  assert.throws(
    () => validator.accept(event(3, "session.committed", {
      stepId: "step-1",
      nativeIds: { frameworkSession: "session-1" },
    })),
    /cave_adapter_lifecycle_terminal_followed_by_event/,
  );
});

test("validator rejects changed replay and entity scopes", () => {
  const replayValidator = createAdapterLifecycleValidator();
  replayValidator.accept(event(1, "run.started"));
  assert.throws(
    () => replayValidator.accept(event(2, "checkpoint.committed", {
      stepId: "step-1",
      replay: true,
      replaySource: { runId: "run-origin", attempt: 1 },
      nativeIds: { frameworkCheckpoint: "checkpoint-1" },
    })),
    /cave_adapter_lifecycle_scope_mismatch/,
  );

  const modelValidator = createAdapterLifecycleValidator();
  modelValidator.accept(event(1, "run.started"));
  modelValidator.accept(event(2, "model.requested", {
    stepId: "step-1",
    modelCallId: "model-1",
    nativeIds: { frameworkCall: "native-model-1" },
  }));
  assert.throws(
    () => modelValidator.accept(event(3, "model.responded", {
      stepId: "step-2",
      modelCallId: "model-1",
      nativeIds: { frameworkCall: "native-model-1" },
    })),
    /cave_adapter_lifecycle_scope_mismatch/,
  );

  const nativeValidator = createAdapterLifecycleValidator();
  nativeValidator.accept(event(1, "run.started"));
  nativeValidator.accept(event(2, "tool.started", {
    stepId: "step-1",
    toolCallId: "tool-1",
    nativeIds: { frameworkTool: "native-tool-1" },
  }));
  assert.throws(
    () => nativeValidator.accept(event(3, "tool.completed", {
      stepId: "step-1",
      toolCallId: "tool-1",
      nativeIds: { frameworkTool: "changed" },
    })),
    /cave_adapter_lifecycle_scope_mismatch/,
  );
});

test("validator rejects run terminal while model or started tool remains open", () => {
  const modelValidator = createAdapterLifecycleValidator();
  modelValidator.accept(event(1, "run.started"));
  modelValidator.accept(event(2, "model.requested", {
    stepId: "step-1",
    modelCallId: "model-1",
    nativeIds: { frameworkCall: "native-model-1" },
  }));
  assert.throws(
    () => modelValidator.accept(event(3, "run.error")),
    /cave_adapter_lifecycle_open_scope/,
  );

  const toolValidator = createAdapterLifecycleValidator();
  toolValidator.accept(event(1, "run.started"));
  toolValidator.accept(event(2, "tool.started", {
    stepId: "step-1",
    toolCallId: "tool-1",
    nativeIds: { frameworkTool: "native-tool-1" },
  }));
  assert.throws(
    () => toolValidator.accept(event(3, "run.error")),
    /cave_adapter_lifecycle_open_scope/,
  );
});

test("validator requires consecutive attempts after terminal call state", () => {
  const validator = createAdapterLifecycleValidator();
  validator.accept(event(1, "run.started"));
  assert.throws(
    () => validator.accept(event(2, "model.requested", {
      stepId: "step-1",
      modelCallId: "model-1",
      attempt: 2,
      nativeIds: { frameworkCall: "native-model-1" },
    })),
    /cave_adapter_lifecycle_attempt_invalid/,
  );
});

test("validator keeps normalized scopes local to each run", () => {
  const validator = createAdapterLifecycleValidator({ maxRuns: 2, maxScopesPerRun: 3 });

  for (const runId of ["run-1", "run-2"]) {
    validator.accept(event(1, "run.started", { runId }));
    validator.accept(event(2, "model.requested", {
      runId,
      stepId: "step-shared",
      modelCallId: "model-shared",
      nativeIds: { frameworkCall: "native-model-shared" },
    }));
    validator.accept(event(3, "model.responded", {
      runId,
      stepId: "step-shared",
      modelCallId: "model-shared",
      nativeIds: { frameworkCall: "native-model-shared" },
    }));
    validator.accept(event(4, "tool.started", {
      runId,
      stepId: "step-shared",
      toolCallId: "tool-shared",
      nativeIds: { frameworkTool: "native-tool-shared" },
    }));
    validator.accept(event(5, "tool.completed", {
      runId,
      stepId: "step-shared",
      toolCallId: "tool-shared",
      nativeIds: { frameworkTool: "native-tool-shared" },
    }));
    validator.accept(event(6, "run.completed", { runId }));
  }
});

test("validator capacities fail closed without eviction", () => {
  assert.throws(
    () => createAdapterLifecycleValidator({ maxRuns: 0 }),
    /cave_adapter_lifecycle_validator_options_invalid/,
  );
  assert.throws(
    () => createAdapterLifecycleValidator({ maxScopesPerRun: -1 }),
    /cave_adapter_lifecycle_validator_options_invalid/,
  );

  const runCapacity = createAdapterLifecycleValidator({ maxRuns: 1 });
  runCapacity.accept(event(1, "run.started"));
  runCapacity.accept(event(2, "run.completed"));
  assert.throws(
    () => runCapacity.accept(event(1, "run.started", { runId: "run-2" })),
    /cave_adapter_lifecycle_capacity_exceeded:run.started:run-2/,
  );

  const scopeCapacity = createAdapterLifecycleValidator({ maxScopesPerRun: 1 });
  scopeCapacity.accept(event(1, "run.started"));
  scopeCapacity.accept(event(2, "checkpoint.committed", {
    stepId: "step-1",
    nativeIds: { frameworkCheckpoint: "checkpoint-1" },
  }));
  assert.throws(
    () => scopeCapacity.accept(event(3, "model.requested", {
      stepId: "step-1",
      modelCallId: "model-1",
      nativeIds: { frameworkCall: "native-model-1" },
    })),
    /cave_adapter_lifecycle_capacity_exceeded:model.requested:run-1/,
  );
});

test("validator finish proves every accepted run reached terminal state", () => {
  const complete = createAdapterLifecycleValidator();
  complete.accept(event(1, "run.started"));
  complete.accept(event(2, "run.completed"));
  assert.equal(complete.finish(), undefined);
  assert.equal(complete.finish(), undefined);
  assert.throws(
    () => complete.accept(event(3, "run.started", { runId: "run-2" })),
    /cave_adapter_lifecycle_validator_finished/,
  );

  const open = createAdapterLifecycleValidator();
  open.accept(event(1, "run.started"));
  assert.throws(
    () => open.finish(),
    /cave_adapter_lifecycle_open_run:run-1/,
  );
  assert.throws(
    () => open.finish(),
    /cave_adapter_lifecycle_open_run:run-1/,
  );
});
