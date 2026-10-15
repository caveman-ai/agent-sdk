# Architecture

## What Caveman adds to Pi

Pi 1.0.0 owns model execution and the tool loop. Caveman adds application
controls and evidence around that execution:

- **Context lifecycle** — what enters the provider-visible prefix, what stays
  live, when it is compacted, and whether the original bytes can be recovered
  exactly.
- **Runtime evidence** — a receipt per run listing every model and tool call,
  its usage basis, its price basis, and how the run stopped.
- **Fail-closed accounting** — a budget that reserves before it spends, and
  refuses to book an imaginary `$0` against a model the catalog cannot price.
- **Eval-gated builds** — a lock artifact that only exists when declared
  quality gates passed.

Everything else — the tool loop itself, steering queues, lifecycle hooks, the
event stream — comes from exact-pinned Pi. The repo rule is explicit: consuming
a Pi hook to enforce an invariant Pi lacks is the product; re-exposing a Pi
surface under a Caveman name is refused duplication.

## Package map

```text
packages/
├── agent/                   @caveman-ai/agent          runtime, compiler, memory, compaction, CLI
├── adapter-kit/             @caveman-ai/adapter-kit    manifests, capability states, registry, lifecycle
├── adapter-conformance/     @caveman-ai/adapter-conformance   deterministic candidate-evidence runner
├── adapters/
│   ├── pi/                  @caveman-ai/adapter-pi
│   ├── claude-agent-sdk/    @caveman-ai/adapter-claude-agent-sdk
│   ├── vercel-ai-sdk/       @caveman-ai/adapter-vercel-ai-sdk
│   ├── mastra/              @caveman-ai/adapter-mastra
│   ├── eve/                 @caveman-ai/adapter-eve
│   ├── openai-agents/       @caveman-ai/adapter-openai-agents
│   ├── langgraph/           @caveman-ai/adapter-langgraph
│   ├── cloudflare-agents/   @caveman-ai/adapter-cloudflare-agents
│   └── strands-agents/      @caveman-ai/adapter-strands-agents
├── coding-agent/            @caveman-ai/coding-agent   interactive coding product + caveman-code
├── create-caveman-agent/    @caveman-ai/create-agent   project generation only
├── evals/                   @caveman-ai/evals          grader taxonomy and dispatch
├── react/                   @caveman-ai/react          browser hooks for runs and sessions
└── pebble-protocol/         @pebble-agent/protocol     frozen wire/session contract (Apache-2.0)
```

`packages/shared` holds catalog snapshots and wire schemas rather than a
published workspace package. Proprietary Pebble implementation lives in the
separate `caveman-coding-agent` repository; only its Apache-2.0 protocol lives
here. The root `package.json` defines workspace membership.

## Ownership boundaries

| Package | Owns | Explicitly does not own |
| --- | --- | --- |
| `agent` | Framework-neutral execution, tools, budgets, breakers, receipts, durability, Context IR, profile/eval/compiler, fail-closed accounting, the optional Connect protocol client | OAuth, credential storage, provider transport for Connect (that is external `cave-connectd`) |
| `adapter-kit` | Manifest schema, capability vocabulary and states, registry, lifecycle validation, conformance metadata | Any framework import, any Caveman runtime import |
| `adapters/*` | One upstream pin each, one binding entrypoint, one capability manifest | A second host implementation of anything core already does |
| `adapter-conformance` | Deterministic candidate evidence: test vector, clocks, thresholds, digests | Turning a report into a `certified` manifest state |
| `coding-agent` | Coding UX, CLI, tools, session presentation, coding benchmarks | Runtime invariants — it consumes them |
| `create-caveman-agent` | Project generation | Anything at runtime |
| `evals` | Grader names, option types, validation, verdict semantics | A second evaluator inside `agent` |
| `react` | Browser state and event-stream hooks | Server credentials, tool execution, or runtime invariants |
| `pebble-protocol` | Frozen public wire, event, and session contracts | The Pebble runtime, sessions, policy, and TUI, which live in a private sibling repository |

## Dependency direction

```text
adapter-kit  <──  adapter-*  ──peer──>  agent
coding-agent ──peer─────────────────>  agent
create-agent ──generated project────>  agent
```

Core never imports an adapter package. Installing `@caveman-ai/agent` must not
pull in Vercel, Mastra, or Eve. The shared registry stays framework-neutral so
the graph has no cycle.

## The two outward seams

Caveman attaches to a foreign framework in exactly two places.

| Seam | Module | Scales by | Carries |
| --- | --- | --- | --- |
| The wire (`fetch`) | `@caveman-ai/agent/wire` | Provider | Request ceiling, exact usage accounting, provider-native cache hints |
| The model boundary | `packages/adapters/*` | Framework | Compaction, model routing — anything that must stay in sync with framework-owned state |

The split is load-bearing, not stylistic. Compaction at the wire would leave the
framework's own message history describing a transcript the model never saw; the
framework would then rebuild the next request from stale state and silently undo
the compaction. `src/compaction.ts` is documented as the only place in the
package that rewrites model-visible context. Full rationale:
[`docs/PORTABILITY.md`](../../docs/PORTABILITY.md).

## Execution paths inside `agent`

```text
run() / stream()          ordinary run, no lock
runLocked()               validated Cave Build execution, refuses drift before provider traffic
createAgentServer()       one definition behind HTTP, every run journaled
compileProfiledNativePi() compiler-owned runner; only native tool-free Pi can lower a plan
compileProfiled()         generic caller-owned runner; baseline-equivalent v3 only
```

`run()` cannot inject a plan or a build identity. `npm run dev`, `build`, and
`check` own validated Cave Build execution.

## Where the source lives

| Concern | File |
| --- | --- |
| Run loop, options, events, conversations | `packages/agent/src/runtime.ts` |
| Budget ladder, reserve/settle, receipts | `packages/agent/src/budget.ts` |
| Circuit breakers | `packages/agent/src/breakers.ts` |
| Context rewriting (the only place) | `packages/agent/src/compaction.ts` |
| Durable journal and stores | `packages/agent/src/durable.ts` |
| HTTP server | `packages/agent/src/serve.ts` |
| Provider `fetch` transport | `packages/agent/src/wire.ts` |
| Model boundary contract | `packages/agent/src/model-boundary.ts` |
| Sandbox execution and probes | `packages/agent/src/runtime.ts`, `tool-worker.ts`, `sandbox-*.ts` |
| Memory engine and adapters | `packages/agent/src/memory*.ts` |
| Compiler and candidate search | `packages/agent/src/compiler.ts`, `compile-runner.ts`, `build.ts` |
| Optional workspace discovery | `packages/agent/src/agent-environment.ts` |
| CLI | `packages/agent/src/cli.ts` |
