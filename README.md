<p align="center">
  <img src="docs/assets/caveman-logo-banner.png" alt="Caveman" width="720">
</p>

<p align="center"><strong>The session kernel for agents.</strong></p>
<p align="center"><strong>IN BETA</strong></p>

<p align="center">
  <a href="#license"><img src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat" alt="Apache-2.0"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.19-blue?style=flat" alt="Node 22.19+">
  <img src="https://img.shields.io/badge/savings-always_inferred-orange?style=flat" alt="local savings stay inferred">
</p>

---

Put your agent in it and it becomes durable, budgeted, resumable, multi-client,
and able to run its tools anywhere. Your key, your provider, any sandbox. There
is no account, no proxy, and no hosted service in the path: `@caveman-ai/agent`
is a TypeScript runtime you install, and the first sample below runs on one API
key and zero configuration.

> **Development status:** this README documents current `main`, including
> `@caveman-ai/agent` v0.2 source. That release is not yet published to npm;
> registry installs may expose an older surface. Use this checkout when testing
> capabilities described below.

```bash
npm install @caveman-ai/agent      # Node 22.19+, one provider key
```

## Why use it

Most agent SDKs hand you a loop and leave the bill to you. This one is built
around the spend.

- **A run can be capped.** `budget: { maxUsd: 1 }` reserves the worst case
  before a call leaves and settles measured cost after. A model the catalog
  cannot price fails closed instead of counting as `$0`.
- **You get a receipt, not a dashboard.** Every run returns per-call,
  per-tool, per-subagent spend in the result object.
- **A crash does not buy the same tokens twice.** Runs journal their intent
  before network work, so a resumed run restores what it already spent.
- **Context stays small on purpose.** Skill descriptions enter stable context;
  skill bodies stay on disk until invoked. When the budget tightens,
  compaction evicts, then summarizes, then clamps, then stops, preserving
  exact commitments at each step.
- **One tool instead of forty.** Programmatic mode gives the model a single
  bounded code cell that calls your tools through typed proxies, so a wall of
  JSON schemas never enters the prompt.
- **Recall does not stall the turn.** Memory retrieval starts during turn N
  and lands in turn N+1.

Local savings stay **inferred**. The default direct mode is observe-only and
makes no efficiency claim; what it gives you is the ledger.

## Define

```ts
import { agent, auto } from "@caveman-ai/agent";

export const reviewer = agent({
  id: "reviewer",
  instructions: "Review the change. Name the root cause, not the symptom.",
  model: auto(),
});
```

`auto()` reads `CAVE_MODEL`, then `.caveman/provider.json`, then the credential
in your environment. It never classifies a task and never routes on quality.

## Run

```ts
import { run } from "@caveman-ai/agent";

const result = await run(reviewer, "Why does the parser drop trailing commas?");
console.log(result.text);
console.log(result.receipt);      // per-call, per-tool, per-subagent spend
```

That is the whole zero-config path: one key, direct to your provider.

## Serve sessions

A session owns one conversation and one run controller. Messages that arrive
while a run is active queue onto it instead of starting a second one, and every
client attached to the session sees the same event stream.

```ts
import { createAgentServer } from "@caveman-ai/agent/serve";

const server = createAgentServer({
  definition: reviewer,
  token: process.env.CAVE_SERVE_TOKEN!,   // ≥16 chars; this endpoint spends money
});
await server.listen(8080);
```

```text
POST   /sessions                  {sessionId}       caller-assigned; also the journal key
POST   /sessions/{id}/messages    → {runId, queued}   follow-up while a run is active
GET    /sessions/{id}             → runs, active run, queue depth
GET    /sessions/{id}/events      → Server-Sent Events, across every run
DELETE /sessions/{id}             → cancel the active run, drop the queue
WS     /sessions/{id}/ws          → the same frames, bidirectional
```

`createAgentHandler` from `@caveman-ai/agent/serve-handler` is the same server
as a web-standard `fetch(Request)`, for Cloudflare Durable Objects, Deno, and
Bun. In the browser, `useSession` from `@caveman-ai/react` speaks to it through
a same-origin path your app proxies, and never holds the token.

## Keep the session (durable store)

```ts
import { SqlDurableStore } from "@caveman-ai/agent/durable";

const store = new SqlDurableStore({
  sql: { exec: (query, params) => db.prepare(query).all(...params) },
  dialect: "sqlite",
});
```

The whole database dependency is one method, so Durable Object SQLite,
better-sqlite3, `node:sqlite`, and Postgres are all the same three lines.
`ObjectDurableStore` does the same over S3/R2/GCS. Runs journal their call
intent before network work, so a resumed run restores known spend and its
execution boundary; a request in flight during a crash stays `unknown`, because
the SDK cannot know whether the provider billed it.

## Run the tools somewhere else (execution backend)

```ts
import { httpExecutionBackend } from "@caveman-ai/agent";
import { createCodingAgent } from "@caveman-ai/agent/code";

const coding = createCodingAgent({
  workspace: process.cwd(),
  executionBackend: httpExecutionBackend({ url: process.env.CAVE_EXEC_URL!, token }),
});
```

Every tool that shells out or touches the workspace goes through the backend.
The same six tools compose into any agent as `shellTools({ workspace,
executionBackend, tools: ["bash", "read_file"] })`, next to your own tools.
The default is the local host, which is uncontained host execution and not
isolation. The remote contract is a bearer token and three JSON endpoints
(`/exec`, `/read`, `/write`), so any container, microVM, or sandbox provider
satisfies it in about forty lines:
[execution backends](./packages/agent/docs/execution-backend.md).

## Budget

```ts
const result = await run(reviewer, input, {
  budget: { maxUsd: 1.0, onExhausted: "compact" },
});
```

Every priced call reserves its worst case before it leaves and settles measured
public-catalog cost after. A model the catalog cannot price cannot be capped:
under a USD budget such a call fails closed rather than consuming an imaginary
`$0`. Token budgets use the same ledger. These are local controls, not provider
invoices or platform quotas.

## Authorize tools and type the output

```ts
import { agent, auto, output, run, schema } from "@caveman-ai/agent";

const finding = schema.object({ severity: schema.string(), evidence: schema.array(schema.string()) });
const investigator = agent({
  id: "investigator",
  instructions: "Find the failure mechanism. Cite the evidence you actually read.",
  model: auto(),
  tools: [searchTraces, readTrace, openPr],
  output: output({ maxTokens: 800, schema: finding }),
});

const result = await run(investigator, question, {
  toolPolicy: ({ name, effect }) =>
    effect === "write" && !grant.allows(name) ? { deny: "grant_scope" } : undefined,
});
result.output;        // { severity: string; evidence: string[] } — validated, typed from the schema
```

`toolPolicy` is the host's authorization decision, made outside model output
for every tool call in the run, subagents and nested calls included. A denied
call never executes: the model reads `cave_tool_denied:grant_scope`, the
receipt counts it, and the run continues. A policy that cannot answer ends the
run, because unknown authorization never executes a tool. The declared output
schema is rendered into the prompt and the final message is parsed against it.

## Modes

The default is **direct**: your key, your provider, no proxy. The receipt value
for that is `observe-only` — no transforms, no gateway telemetry, and no
efficiency claim. `optimized` is optional and needs the local Caveman gateway;
see [execution modes](./caveman-docs/concepts/execution-modes.md).

## Going further

- [Build against evals and lock a plan](#compile-against-evals-not-vibes) —
  profile evals, candidate search, frozen holdouts, `.caveman/agent.lock.json`.
- [Execution modes and the gateway](./caveman-docs/concepts/execution-modes.md) —
  what `optimized` adds, and what it does not claim.
- [Caveman Connect](./packages/agent/docs/connect.md) — provider data through
  one stable tool, with pagination that refuses instead of omitting.
- [Memory](#memory-that-does-not-block-current-turn) — next-turn recall, session
  search, TTL, tenant isolation.
- [Compaction](#compaction-that-preserves-commitments) — typed capsules that
  preserve exact commitments under a declared budget.
- [Programmatic tools](#one-tool-instead-of-a-wall-of-tools) — one bounded code
  cell instead of a wall of JSON tools.
- [Framework adapters](#framework-adapters) — observability for a native Pi,
  Claude, Vercel AI SDK, Mastra, Eve, LangGraph, OpenAI Agents, Strands, or
  Cloudflare Agents loop.
- [Full documentation](./caveman-docs/README.md) — guides, concepts, and the
  generated API reference for every published entrypoint.

## Try this repository

```bash
git clone https://github.com/JuliusBrussee/agent-sdk.git
cd agent-sdk
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
```

Or scaffold a project — `--template background-agent` is the server-first
session agent from this front door:

```bash
npm create @caveman-ai/agent@latest my-agent -- --template background-agent
```

Filesystem-first authoring works too: `instructions.md`, `agent.ts`, `tools/`,
`skills/`, `subagents/`, and `evals/` in a directory, composed by
`loadAgentDir()` into one ordinary `agent()` call. Skill descriptions enter
stable context; skill bodies stay on disk until invoked, so adding a large
skill does not expand every request.

## One tool instead of a wall of tools

Programmatic mode gives a coding model one provider-visible tool named
`caveman_code`. Model writes a bounded JavaScript cell and calls nested tools
through typed proxies:

```ts
import {
  createCodingAgent,
  runCodingTurn,
  startCodingSession,
} from "@caveman-ai/agent/code";

const codingAgent = createCodingAgent({
  workspace: process.cwd(),
  toolMode: "programmatic",
});

const session = await startCodingSession(codingAgent);
await runCodingTurn(session, "Find failing tests and fix root cause.");
```

Transport wrapping is automatic. Nested calls still use the runtime's normal
tool dispatcher; code cells do not bypass schemas, effect policy, call limits,
receipts, timeouts, or abort signals. Receipt records both composite cell and
each nested tool call.

Literal `effect: "read"` calls may start while cell source is streaming. Writes,
idempotent or external operations, variable-dependent arguments, and reads
after possible writes never speculate. Set `speculativeToolCalls: false` to
keep programmatic mode without early reads, or `toolMode: "direct"` to expose
ordinary JSON tools.

Programmatic mode currently supports host agents. Its Worker and host tool
execution are not isolation boundaries. Use normal `sandbox: "required"`
agents when containment matters.

Generic embedders can use `createProgrammaticToolRuntime` from
`@caveman-ai/agent/programmatic-tools` without adopting coding-agent helpers.

## Memory that does not block current turn

```ts
import {
  agent,
  auto,
  createMemoryEngine,
  memory,
  run,
} from "@caveman-ai/agent";

const definition = agent({
  id: "support",
  instructions: "Resolve support requests.",
  model: auto(),
  memory: memory({ namespace: "support" }),
});

const engine = createMemoryEngine({
  scope: { tenant: "tenant-1", agentId: "support", namespace: "support" },
  ttlMs: 30 * 86_400_000,
});

await run(definition, "Remember that I prefer email updates.", {
  memory: { tenant: "tenant-1", engine },
});
```

Passive retrieval starts during turn N; completed recall enters turn N+1
without blocking current model. Recalled context appears immediately before
current user message, never inside cache-stable system prefix or permanent
conversation history.

Built-in paths include:

- explicit remember, search, forget, link, and prior-session search;
- dependency-free sparse lexical vectors by default;
- optional explicit embedding adapters and bounded graph expansion;
- optional model-backed extraction, relevance review, and consolidation;
- atomic local storage plus in-memory and custom storage adapters;
- inactive evidence and relation edges for reversible consolidation.

Memory scope is `(tenant, agentId, namespace)`. Obvious private keys, provider
tokens, credential assignments, and access keys are rejected before storage,
indexing, or sidecar processing. Retrieved memory is marked inferred and
potentially stale; code, tools, current user intent, and runtime evidence win.

Full contract: [agent memory](./packages/agent/docs/memory.md).

## Compaction that preserves commitments

Compaction is one stage in a fail-closed budget ladder: exact-recovery eviction,
typed summary, output clamp, then stop.

```ts
import { run, type RunBudget } from "@caveman-ai/agent";

const budget: RunBudget = {
  maxTokens: 120_000,
  onExhausted: "compact",
  compaction: {
    keepRecentTokens: 8_000,
    summaryMaxTokens: 2_048,
    preserveFirstUserMessage: true,
  },
};

const result = await run(support, "Continue investigation.", { budget });
```

`cave.context-summary.v2` uses source IDs, SHA-256 digests, generations, typed
anchors, and transition validation. Runtime rejects a replacement unless it is
smaller and preserves root intent, required user sources, byte-identical prior
critical anchors, and recent self-contained tail. Tool content cannot mint
critical policy. Later user-grounded decisions can supersede earlier ones only
through explicit edges.

Public harness measures transition validity, anchor recall, exact-recovery
coverage, and compression ratio across repeated runs. Structural stability is
tested; semantic superiority is not claimed.

Full contract: [context compaction](./packages/agent/docs/compaction.md).

## Compile against evals, not vibes

```bash
npm run build
```

Checked-in profile evals characterize workload. Candidate plans search on
development cases. Selected plan freezes before untouched holdouts open. No
candidate gets a lock unless declared quality gates pass.

A successful build writes:

- `.caveman/agent.lock.json` — immutable Cave Build proof envelope;
- `.caveman/workload-profile.json` — content-blind profile and provenance;
- `.caveman/build-report.json` — search cost, holdout evidence, claims, and
  break-even point estimate only when required evidence is complete.

Native Pi tool-free agents can search priced model, reasoning effort,
reversible Context IR routes with exact recovery, and output budgets. Generic
framework adapters remain baseline-equivalent unless their capability manifest
proves otherwise. Existing Caveman, OpenTelemetry, or OpenInference trace
envelopes can seed profiling; raw prompt and result attributes are refused.

Build hashes bind canonical bytes for integrity. They are not signatures,
runtime attestation, SBOM provenance, or proof that registered bytes served
production traffic.

## Receipts, budgets, and durable runs

Every successful run returns model calls, tool calls, provider usage basis,
catalog cost basis, stop reason, compactions, retries, subagents, and resume
state. Failure after spend throws `CavemanRunError` with same partial receipt.

USD budgets reserve each priced root or descendant call before provider
traffic, then settle measured public-catalog cost afterward. Unknown model or
price cannot consume an imaginary `$0`; a USD-capped run fails closed. Token
budgets use same root ledger. These are local controls, not provider invoices,
platform quotas, or cross-process financial reservations.

Durable mode journals call intent before network work. Resume restores known
spend and execution boundary. A request in flight during crash remains unknown
because SDK cannot know whether provider billed it; receipt says unknown rather
than guessing.

`stream()` emits typed run, context, model, completion, and error events.
Returning iterator aborts in-flight provider, tool, and subagent work before
conversation ownership releases.

## Safety boundaries

- `sandbox: "required"` fails closed when verified OS containment is
  unavailable. Use WSL2 for required-sandbox production tools on Windows.
- `sandbox: "host"` means uncontained host execution. It is explicit, never a
  synonym for isolation, and cannot hide under a sandbox-required parent.
- Tool and subprocess environments use explicit allowlists, not ambient secret
  inheritance.
- Provider-visible stable prefixes remain byte-stable inside one cache epoch.
- Unknown model, pricing, usage, grader, runtime, or sandbox state fails closed.
- Observe-only mode never claims optimization.

Threat model: [packages/agent/SANDBOX_THREAT_MODEL.md](./packages/agent/SANDBOX_THREAT_MODEL.md).

## Framework adapters

Adapters install separately and pin exact upstream versions:

```bash
npm install @caveman-ai/agent @caveman-ai/adapter-vercel-ai-sdk ai@7.0.43
npm install @caveman-ai/agent @caveman-ai/adapter-mastra @mastra/core@1.55.0
npm install @caveman-ai/agent @caveman-ai/adapter-eve eve@0.29.2
```

Each one is an **observability adapter**: it records lifecycle and usage from a
native framework loop and does not run a Caveman agent. Repository includes
lanes for Pi, Claude Agent SDK, Vercel AI SDK, Eve, Mastra, LangGraph, OpenAI
Agents, Strands, and Cloudflare Agents. Shared manifest validates exact capability and lifecycle metadata;
registry performs discovery only. Candidate conformance never grants execution
or mints release certification. Adapter presence never implies behavioral
compiler support or live provider certification.

### Portable optimizations

Adapters carry lifecycle, usage observation, and a model boundary. The
economics — request ceiling, exact accounting, provider-native cache hints —
attach one layer lower, at the provider `fetch`, so they need no per-framework
code and work even where an adapter declares `modelInterception` unsupported:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCavemanTransport } from "@caveman-ai/agent/wire";

const caveman = createCavemanTransport({ budget: { maxTokens: 2_000_000 } });
const anthropic = createAnthropic({ fetch: caveman.fetch });
```

Compaction and routing stay on the adapter boundary because they rewrite what
the framework believes it sent. Cache hints stay on the same live-path gate the
native runtime uses. Boundary rationale, current scope, and limits:
[docs/PORTABILITY.md](./docs/PORTABILITY.md).

## Optional workspace compatibility

Core runtime accepts explicit instructions, contexts, tools, and definition
transforms. It never searches for repository files. Products that need coding-
agent interoperability can opt into `@caveman-ai/agent/plugins`:

```ts
import { agent } from "@caveman-ai/agent";
import {
  applyAgentEnvironment,
  loadAgentEnvironment,
} from "@caveman-ai/agent/plugins";

const environment = await loadAgentEnvironment({ cwd: process.cwd() });
const reviewer = applyAgentEnvironment(agent({
  id: "reviewer",
  instructions: "Review requested changes.",
  model: "openai/gpt-5.4",
  sandbox: "host",
}), environment);
```

Optional adapter supports Agent Skills, declarative
Agent Plugins v1, Vercel OpenPlugin, and compatible Claude/Cursor manifests.
MCP, hooks, custom agents, plugin subprocesses, and ambient-secret inheritance
remain disabled.

## Packages

- `packages/agent` — `@caveman-ai/agent` runtime, compiler, memory,
  compaction, programmatic-tool kernel, and optional workspace adapters.
- `packages/adapter-kit` — framework-neutral capability manifests, registry,
  lifecycle validation, and reproducible conformance metadata.
- `packages/adapters/*` — exact-pinned framework integrations.
- `packages/coding-agent` — `@caveman-ai/coding-agent` and `caveman-code` CLI.
- `packages/create-caveman-agent` — zero-runtime-dependency initializer.
- `packages/react` — `@caveman-ai/react`, the `useAgent` and `useSession` hooks
  over the server's event stream. Holds no token; talks to a route your app
  proxies.
- `packages/pebble-protocol` — frozen Apache-2.0 wire and session contract.
  Proprietary Pebble implementation lives outside this repository.
- `packages/shared` — pinned wire schemas and provider-catalog snapshot used to
  regenerate and verify Agent SDK artifacts.
Full documentation — guides, concepts, and a generated API reference for every
published entrypoint: [caveman-docs/](./caveman-docs/README.md).
Detailed SDK API: [packages/agent/README.md](./packages/agent/README.md).
Monorepo boundaries: [docs/MONOREPO.md](./docs/MONOREPO.md).

## Develop

```bash
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run license:check
npm run pack:check
```

`npm test` covers generated catalog drift, protocol and adapter contracts,
coding-agent boundaries, package types, runtime/compiler behavior,
programmatic dispatch, environment loading, memory, compaction, deterministic
replay, initializer, and example agent. Restricted macOS sandbox and loopback
tests need host permissions before failures count as product defects.

## Honesty boundary

Costs are public-catalog list-price subtotals, never invoices. Local execution,
replay, compiler output, memory, and compaction evidence stay `inferred`.
SDK publishes no savings percentage. `verifiedSavingsUsd` remains `0` until
real traffic passes separate rollout and ledger gates. Unknown state fails
closed or returns honest zero.

## License

Apache-2.0. See [LICENSING.md](./LICENSING.md).

Anthropic Claude Agent SDK dependency remains governed by Anthropic terms; see
adapter README and sandbox threat model for exact boundary.
