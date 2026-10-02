# Adapters and the wire transport

Two seams, two scaling laws.

| Seam | Module | Scales by | Carries |
| --- | --- | --- | --- |
| The wire (`fetch`) | `@caveman-ai/agent/wire` | **Provider** | Request ceiling, exact usage accounting, provider-native cache hints |
| The model boundary | `packages/adapters/*` | **Framework** | Compaction, model routing — anything that must stay in sync with framework state |

They compose: the transport can carry the budget and the cache hints while the
boundary carries compaction.

---

# 1. The wire transport

Every provider client in this adapter set accepts a custom `fetch`. That is the
whole integration.

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCavemanTransport } from "@caveman-ai/agent/wire";

const caveman = createCavemanTransport({ budget: { maxTokens: 2_000_000 } });
const anthropic = createAnthropic({ fetch: caveman.fetch });
// caveman.meter.settled is exact, provider-reported spend.
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `budget` | none | `RunBudget`. `maxTokens` is the honest default; `maxUsd` asserts this transport's key is billed in dollars |
| `cache` | `"gated"` | `WireCacheScope`. `"all"` is an explicit opt-in to unproven-live grammars |
| `scope` | derived | Cache scope id. Requests sharing a prefix must share it |
| `onModelUsage` | — | Exact provider-reported usage, once per completed call |
| `onCacheDecision` | — | Every cache decision, applied or not. Diagnostic only |
| `fetch` | `globalThis.fetch` | Underlying transport |

Returns `{ fetch, meter }`. `meter` is present when a budget was configured.

## What it recognizes

Matched on **host and path**:

- Anthropic `/v1/messages`
- OpenAI `/v1/chat/completions` and `/v1/responses`

Every other target, non-`POST` request, or unparseable body **passes through
unmetered and unedited** rather than being rewritten by a grammar nobody proved.
That includes Bedrock (its URL carries model and region and it needs SigV4-aware
re-signing after any body edit) and Azure OpenAI.

## What it delivers today

**Unblocked and portable:**

- **Request ceiling.** Every call reserves its worst case before it leaves. A
  remainder that cannot fund the full output allowance clamps the outgoing
  `max_tokens` down to `OUTPUT_CLAMP_FLOOR_TOKENS`; below that the call is
  refused before any provider spend.
- **Exact accounting.** Provider-reported usage settles the meter, merged across
  Anthropic's split `message_start`/`message_delta` events and OpenAI's final
  chunk. A response whose usage cannot be measured settles at the **full
  reserve**, never at zero. A transport error cancels the reservation.

**Gated:**

- **Cache hints** default to `cache: "gated"`, mirroring `runtime.ts` exactly:
  only grammars proven against a live provider leave the SDK, and today that is
  the OpenAI affinity routing key alone. The Anthropic and Bedrock splices are
  byte-parity tested against the Go engine's 41 fixtures but have never been sent
  to a live endpoint from this SDK. `cache: "all"` is the documented opt-in.

The cache epoch digests the stable slice (`system`, `tools`, `instructions`,
`toolConfig`), so changed instructions open a new epoch instead of permanently
tripping prefix drift.

## Limits worth knowing

- **Denial is a transport error.** Refusing a call surfaces to the framework as
  a failed request, and the framework's own retry policy decides what happens
  next. The clean stop is host-side: own the `AbortController` and abort when
  `transport.meter.remaining()` runs out.
- **Streaming settles asynchronously.** The scanning branch of the teed response
  finishes after the caller's last read, so the meter is exact but trails the
  stream's end by a tick.
- **It cannot compact or reroute.** Both rewrite what the framework believes it
  sent. Those live one layer up.
- `ModelUsage.cost` is priced only when every count including reasoning is
  known, so Anthropic records are honestly `unknown`-cost. The meter can still
  settle exactly when both extremes of an unknown reasoning split price
  identically.
- OpenAI's absent cache-write count is the **only** field defaulted to zero,
  because OpenAI has no cache-write class. Every other absent count stays `null`.

---

# 2. The model boundary

```ts
import { createModelBoundary, captureModelBoundary } from "@caveman-ai/agent/model-boundary";
```

`boundary.prepare(request, context)` returns a **replacement** request that the
adapter sends to the provider. It is a mutation seam, not an observation one,
which is why compaction and routing live here: the boundary hands the rewritten
request back to the framework instead of sending it behind the framework's back.

```ts
const middleware: ModelBoundaryMiddleware<Request, Response> = {
  id: "compact",
  prepare: ({ request, context }) => rewrite(request),   // return undefined to pass through
  settled: ({ request, response, context }) => { … },
  failed: ({ request, error, context }) => { … },
};
```

Middleware receives **no `next` and no provider function**. An adapter cannot
call the model, cannot retry, and cannot become the thing that talks to the
provider. Bounds: `MODEL_BOUNDARY_MAX_MIDDLEWARE`,
`MODEL_BOUNDARY_MAX_ID_LENGTH`, `MODEL_BOUNDARY_MAX_CONTEXT_STRING_LENGTH`.

`ModelBoundaryContext` carries the lifecycle `identity` (with a required
`modelCallId`), the `role`, `provider`, `model`, and the run's `signal`.

---

# 3. The adapter lanes

Every adapter is an **observability adapter**: it records lifecycle and usage
from a native framework loop, and it does not run a Caveman agent. The framework
keeps its own loop, tools, retries, and provider call.

Adapters install separately and pin **one exact upstream version** each.

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-vercel-ai-sdk ai@7.0.84
npm install @caveman-ai/agent @caveman-ai/adapter-mastra @mastra/core@1.63.2
npm install @caveman-ai/agent @caveman-ai/adapter-eve eve@0.29.2
```

| Lane | Package | Upstream pin | Node |
| --- | --- | --- | --- |
| Pi | `@caveman-ai/adapter-pi` | `@earendil-works/pi-agent-core@1.0.0` | ≥22.19 |
| Claude Agent SDK | `@caveman-ai/adapter-claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk@0.3.220` | ≥22.19 |
| Vercel AI SDK | `@caveman-ai/adapter-vercel-ai-sdk` | `ai@7.0.84` | ≥22.19 |
| Mastra | `@caveman-ai/adapter-mastra` | `@mastra/core@1.63.2` | ≥22.19 |
| Eve | `@caveman-ai/adapter-eve` | `eve@0.29.2` | **≥24** |
| OpenAI Agents | `@caveman-ai/adapter-openai-agents` | `@openai/agents@0.17.0` | ≥22.19 |
| LangGraph | `@caveman-ai/adapter-langgraph` | `@langchain/langgraph@1.4.13`, `@langchain/core@1.2.9` | ≥22.19 |
| Cloudflare Agents | `@caveman-ai/adapter-cloudflare-agents` | `agents@0.22.0` | ≥22.19 |
| Strands | `@caveman-ai/adapter-strands-agents` | `@strands-agents/sdk@1.15.0` | ≥22.19 |

Each package exports `manifest`, `createAdapter`, and a default adapter package
definition, plus a `./manifest` subpath.

## Declared capabilities

Every adapter declares **all** capabilities. Unknown support is `unsupported`,
never guessed.

Manifest v2 vocabulary (`runLifecycle`, `modelInterception`,
`contextTransformation`, `toolObservation`, `usageAccounting`, `streaming`,
`abort`, `replayAwareness`, `durableObservation`, `tracing`, `compilation`):

| Adapter | run | model | context | tool | usage | stream | abort | replay | durable | tracing | compile |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| vercel-ai-sdk | exp | exp | exp | exp | exp | exp | exp | — | — | — | — |
| mastra | exp | exp | exp | exp | exp | exp | exp | — | — | — | — |
| strands-agents | exp | exp | exp | exp | exp | exp | exp | — | — | — | — |
| openai-agents | — | exp | exp | — | exp | exp | exp | — | — | — | — |
| langgraph | exp | — | — | exp | exp | exp | — | — | — | — | — |
| cloudflare-agents | exp | — | — | — | — | — | — | — | — | — | — |

`exp` = `experimental`, `—` = `unsupported`. No entry in this repository is
`certified`.

Manifest v1 vocabulary (`run`, `stream`, `tools`, `usage`, `abort`, `durable`,
`compile`) is still used by three lanes:

| Adapter | run | stream | tools | usage | abort | durable | compile |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pi | exp | — | exp | exp | exp | exp | exp |
| eve | exp | — | exp | exp | exp | exp | — |
| claude-agent-sdk | exp | — | exp | exp | exp | — | — |

### What the states mean

| State | Meaning |
| --- | --- |
| `unsupported` | The adapter does not provide the capability |
| `experimental` | The code path exists, but package conformance has not certified it |
| `certified` | A matching conformance suite report digest exists in the manifest |

No manifest state changes the savings basis. Local results stay `inferred` and
`verifiedSavingsUsd` stays zero. Adapter presence never implies behavioral
compiler support or live provider certification.

## The registry

```js
import { createAdapterRegistry } from "@caveman-ai/adapter-kit";
import vercel from "@caveman-ai/adapter-vercel-ai-sdk";

const adapters = createAdapterRegistry();
adapters.register(vercel);
adapters.get("vercel-ai-sdk")?.manifest.capabilities;
adapters.list().map(({ manifest }) => manifest.id);
```

Lookup returns **metadata only**. It never decides whether a caller may run an
adapter.

## The lifecycle spine

Adapters translate native callbacks into immutable normalized events without
replacing the host loop, persistence, or tool execution. Each event carries
stable run/step/model/tool identity, attempt, replay source, and upstream-native
ids.

```js
import { createAdapterLifecycleValidator } from "@caveman-ai/adapter-kit";

const validator = createAdapterLifecycleValidator();
validator.accept({
  schemaVersion: 1,
  seq: 1,
  phase: "run.started",
  identity: { runId: "run-1", attempt: 1, replay: false, nativeIds: { frameworkRun: "native-run-42" } },
});
validator.finish();   // proves no run remains open
```

The validator retains at most 64 runs and 1,024 normalized scopes per run by
default (`maxRuns`, `maxScopesPerRun` raise or lower it explicitly). Nothing is
evicted silently. The **first invalid event permanently fails that validator**,
so consumers cannot resynchronize across an evidence gap. `finish()` seals it and
rejects any incomplete run or later event.

Lifecycle declarations use `unsupported`, `observe`, or `intercept`. Tool phases
stay observe-only — no adapter can deny a tool call today, which is exactly what
`toolObservation` is named for. Real tool gating needs a per-framework
tool-wrapping seam and is a separate axis.

## Conformance

`@caveman-ai/adapter-conformance` is a deterministic candidate-evidence runner.
`ADAPTER_CONFORMANCE_TEST_VECTOR` owns every case id, capability assignment,
benchmark clock, warmup count, sample count, percentile, threshold, and vector
digest. The caller supplies executors for the complete required set; missing,
extra, reassigned, or caller-measured entries fail before execution.

- Hot benchmark callbacks must be synchronous and return `undefined`.
- Numeric observations, sample counts, clocks, and threshold inputs are **not**
  accepted from the caller.
- Successful cases return non-empty evidence bytes; the report stores only the
  SHA-256.
- `undefined`, malformed results, thrown errors, failed cases, skips, callback
  failures, and missed thresholds all block qualification.
- Execution is recorded as `uncontained-host`.

The package exports **no** API that converts a report into manifest `certified`
state. An external release process owns certification after independently
reproducing results, checking artifacts, and reviewing behavior.

## Adding an adapter

1. Add `packages/adapters/<id>` with one exact upstream peer pin.
2. Export `manifest`, `createAdapter`, and a default adapter package definition.
3. Declare **every** capability; unknown support is `unsupported`.
4. Add framework tests and conformance evidence before marking anything
   `certified`.
5. Run `npm test` and `npm run pack:check`.

References:
[`@caveman-ai/adapter-kit`](../reference/api/adapter-kit.md),
[`@caveman-ai/adapter-conformance`](../reference/api/adapter-conformance.md),
[`docs/PORTABILITY.md`](../../docs/PORTABILITY.md).
