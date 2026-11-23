# `@caveman-ai/adapter-kit`

Framework-neutral contracts for Caveman adapter packages.

Manifest schema v2 publishes one exact upstream version, one exact lifecycle
access map, and this complete capability vocabulary:

- `runLifecycle`
- `modelInterception`
- `contextTransformation`
- `toolObservation`
- `usageAccounting`
- `streaming`
- `abort`
- `replayAwareness`
- `durableObservation`
- `tracing`
- `compilation`

Capability states are `unsupported`, `experimental`, or `certified`. A
`certified` entry requires exact conformance suite and report digest fields.
Those fields make results reproducible; they do not establish runtime safety.
Consumers compare expected package, vector, and report digests independently.

Schema v1 manifests remain readable. `ADAPTER_CAPABILITIES_V1` exposes legacy
vocabulary explicitly; `ADAPTER_CAPABILITIES` exposes canonical v2 vocabulary.

## Discovery registry

Registry stores validated packages and returns deterministic metadata. It does
not decide whether callers run an adapter.

```js
import { createAdapterRegistry } from "@caveman-ai/adapter-kit";
import vercel from "@caveman-ai/adapter-vercel-ai-sdk";

const adapters = createAdapterRegistry();
adapters.register(vercel);

console.log(adapters.get("vercel-ai-sdk")?.manifest.capabilities);
console.log(adapters.list().map(({ manifest }) => manifest.id));
```

Registry does not turn local execution into verified savings. Adapter results
remain subject to core runtime accounting and claim rules.

## Lifecycle spine

Adapters translate native callbacks into immutable normalized events without
replacing host loop, persistence, or tool execution. Each event carries stable
run/step/model/tool identity, attempt, replay source, and upstream-native IDs.
Stateful validator rejects broken ordering before events reach accounting or
durability hooks.

```js
import { createAdapterLifecycleValidator } from "@caveman-ai/adapter-kit";

const validator = createAdapterLifecycleValidator();
validator.accept({
  schemaVersion: 1,
  seq: 1,
  phase: "run.started",
  identity: {
    runId: "run-1",
    attempt: 1,
    replay: false,
    nativeIds: { frameworkRun: "native-run-42" },
  },
});

// After complete batch/stream: proves no run remains open.
validator.finish();
```

Validator retains at most 64 runs and 1,024 normalized scopes per run by
default. `maxRuns` and `maxScopesPerRun` may lower or raise bounds explicitly.
No state is evicted silently. First invalid event permanently fails that
validator, preventing consumers from resynchronizing across an evidence gap.
`finish()` seals validator and rejects any incomplete run or later event.

Lifecycle declarations use `unsupported`, `observe`, or `intercept`. Tool
phases remain observe-only. `model.requested` may use `intercept` when native
seam runs before provider I/O.
