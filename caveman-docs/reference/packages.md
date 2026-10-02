# Packages

Every workspace package, what it is for, and how to install it.

## Published products

### `@caveman-ai/agent` — 0.2.0

The core runtime, compiler, memory, compaction, programmatic-tool kernel,
durable execution, HTTP server, wire transport, and CLI.

```bash
npm install @caveman-ai/agent
```

Binary: `caveman-agent`. Node `>=22.19.0`.

24 published entrypoints:

| Specifier | Covers |
| --- | --- |
| `@caveman-ai/agent` | Builder API, run/stream, receipts, memory, compaction, Context IR |
| `/build` | Compiler API, lock parsing, build config |
| `/compiler` | `compileProfiled`, `compileProfiledNativePi`, candidate search |
| `/profile` | Workload profile construction |
| `/claude` | Compatibility: unlocked Claude Agent SDK facade (needs optional peers `@anthropic-ai/claude-agent-sdk`, `zod`) |
| `/code` | Compatibility: coding agent implementation |
| `/command-session` | Persistent shell command sessions |
| `/catalog` | Generated public price catalog |
| `/programmatic-tools` | The `caveman_code` composite tool kernel |
| `/connect` | Caveman Connect client, `ConnectRuntime`, efficiency comparison |
| `/plugins` | Optional workspace/Agent Skills/plugin compatibility |
| `/compaction` | Capsule parsing, transition validation, stability harness |
| `/memory` | Engine, adapters, embeddings, sidecars, workflows |
| `/durable` | Journals, stores, run summaries |
| `/serve` | `createAgentServer` |
| `/model-boundary` | Adapter mutation seam |
| `/model-usage` | Usage record contract |
| `/input` | `AgentInput` parts |
| `/run-receipt` | Receipt contract |
| `/cache-engine` | Cache planner (internal-facing) |
| `/adapters` | Compatibility: generic locked-build harness |
| `/wire` | `createCavemanTransport` |

Reference: [API index](api/agent/README.md).

### `@caveman-ai/coding-agent` — 0.1.0

The interactive coding agent and `caveman-code` CLI.

```bash
npm install @caveman-ai/agent @caveman-ai/coding-agent
```

Entrypoints: `.` and `./cli`. Reference: [coding-agent](api/coding-agent.md).

### `@caveman-ai/create-agent` — 0.1.0

Zero-runtime-dependency project scaffold.

```bash
npm create @caveman-ai/agent@latest my-agent
```

Binary: `create-caveman-agent`.

### `@caveman-ai/adapter-kit` — 0.1.0

Framework-neutral adapter manifests, capability states, registry, and lifecycle
validation. Imports no framework and no Caveman runtime.

Reference: [adapter-kit](api/adapter-kit.md).

### `@caveman-ai/adapter-conformance` — 0.1.0

Deterministic candidate-evidence runner for adapter releases. Exports no API that
converts a report into `certified` state.

Reference: [adapter-conformance](api/adapter-conformance.md).

### `@caveman-ai/evals` — 0.1.0

The grader engine: 27 canonical grader names, one `grade()` dispatch, fail-closed
verdicts. Zero runtime dependencies, ESM only.

Reference: [evals](api/evals.md).

### `@pebble-agent/protocol` — 0.1.0

The frozen Pebble wire and session contract. Apache-2.0, zero runtime
dependencies, byte-sensitive.

Reference: [pebble-protocol](api/pebble-protocol.md),
[guide](../guides/19-pebble-protocol.md).

## Adapters

Each pins exactly one upstream version as a peer dependency. Installing core must
not install any of them.

| Package | Upstream pin | Node | Reference |
| --- | --- | --- | --- |
| `@caveman-ai/adapter-pi` | `@earendil-works/pi-agent-core@1.0.0` | ≥22.19 | [pi](api/adapters-pi.md) |
| `@caveman-ai/adapter-claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk@0.3.220` | ≥22.19 | [claude-agent-sdk](api/adapters-claude-agent-sdk.md) |
| `@caveman-ai/adapter-vercel-ai-sdk` | `ai@7.0.84` | ≥22.19 | [vercel-ai-sdk](api/adapters-vercel-ai-sdk.md) |
| `@caveman-ai/adapter-mastra` | `@mastra/core@1.63.2` | ≥22.19 | [mastra](api/adapters-mastra.md) |
| `@caveman-ai/adapter-eve` | `eve@0.29.2` | **≥24** | [eve](api/adapters-eve.md) |
| `@caveman-ai/adapter-openai-agents` | `@openai/agents@0.17.0` | ≥22.19 | [openai-agents](api/adapters-openai-agents.md) |
| `@caveman-ai/adapter-langgraph` | `@langchain/langgraph@1.4.13` | ≥22.19 | [langgraph](api/adapters-langgraph.md) |
| `@caveman-ai/adapter-cloudflare-agents` | `agents@0.22.0` | ≥22.19 | [cloudflare-agents](api/adapters-cloudflare-agents.md) |
| `@caveman-ai/adapter-strands-agents` | `@strands-agents/sdk@1.15.0` | ≥22.19 | [strands-agents](api/adapters-strands-agents.md) |

Every adapter exports `manifest`, `createAdapter`, a default adapter package
definition, and a `./manifest` subpath.

## Supporting directories

Not in the root `workspaces` array; treat them as internal unless a task
explicitly requires them.

| Directory | Contents |
| --- | --- |
| `packages/shared` | Pinned wire schemas and the provider-catalog snapshot used to regenerate and verify artifacts |
| `packages/pebble`, `pebble-sessions`, `pebble-tui`, `libpebble` | Supporting Pebble material; the real implementation lives in a private sibling repository |
| `examples/coding-agent` | Runnable example built on `@caveman-ai/coding-agent`; part of the public story and covered by tests |
| `scripts/` | Catalog generation, licensing lint, pack verification, package type checks, docs generation |

## Dependency direction

```text
adapter-kit  <──  adapter-*  ──peer──>  agent
coding-agent ──peer─────────────────>  agent
create-agent ──generated project────>  agent
```

Core never imports an adapter package. Full rules:
[`docs/MONOREPO.md`](../../docs/MONOREPO.md).
