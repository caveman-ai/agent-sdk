# The coding agent

`@caveman-ai/coding-agent` is the interactive coding product built on the
framework, shipped separately so core stays small and coding UX evolves on its
own release cycle. `caveman-code` is its CLI. It is not yet published to npm;
until it is, run it from this checkout.

```bash
npm install @caveman-ai/agent @caveman-ai/coding-agent
npx -p @caveman-ai/coding-agent caveman-code --workspace .
```

```ts
import { createCodingAgent, runCodingSession } from "@caveman-ai/coding-agent";

const agent = createCodingAgent({ workspace: process.cwd() });
await runCodingSession({ agent });
```

> `@caveman-ai/agent/code` is a compatibility export during package extraction.
> New applications import `@caveman-ai/coding-agent`.

## CLI

```text
Usage: caveman-code [options]

  --workspace <path>    workspace root (default: current directory)
  --model <id>          provider/model override
  --observe-only        disable Cave runtime transforms
  --max-cost-usd <usd>  best-effort per-turn public-catalog spend cap
  --no-start-runtime    probe runtime without trying to start it
  -h, --help            show help
```

In-session commands: `/help`, `/mode`, `/tokens`, `/prove-recovery`, `/exit`,
`/quit`.

## Tools

Host-sandbox tools over one workspace:

| Tool | Output cap | Notes |
| --- | --- | --- |
| `read_file` | 24,000 chars | |
| `grep` | 16,000 | |
| `bash` | 24,000 | Keeps the **tail**, where compiler and test failures land |
| `write_file` | 2,000 | |
| `edit_file` | 2,000 | |
| `read_tool_output` | 24,000 | Pages or literal-searches a large captured result without repeating the original command |

Caps apply **before** compression, all under the runtime's inline tool-result
ceiling, so a runaway command cannot blow the context even with no engine
installed.

Large captured results receive opaque handles. Captured results are bounded to
**8 MiB each** and **16 MiB total** in memory; handles expire with the process or
by oldest-entry eviction.

### Containment

Host sandbox means uncontained host execution. What is real:

- Tool containment is **realpath-based** — a symlink out of the workspace is out.
- `bash` subprocess environments use a fixed shell/locale allow-list, **not** a
  spread of `process.env`, so a model-driven command cannot read `CAVE_API_KEY`,
  `ANTHROPIC_API_KEY`, or any other framework credential and exfiltrate it.
- `bash` runs in its own process group, so a timeout kills the tree instead of
  waiting on a backgrounded child's inherited stdout.

Nothing beyond that is claimed. See [Sandbox and security](13-sandbox-and-security.md).

## Optimized by default, observe-only loudly

With the Caveman engine present, the session starts the local Cave runtime and
runs `defaultCodingPlan`: exactly **one** recoverable route per live-zone segment
kind — `tool_result` through `caveman.engine.terminal.v1`, `history` through
`caveman.engine.text.v1` — with `cave_retrieve` registered so the model can pull
exact original bytes back.

Only CCR-recoverable transforms are eligible. `toon` is forced-only and never
routed by default; no lossy-without-recovery class enters a default plan. One
route per kind is deliberate: two routes matching one runtime segment collapse
into `dynamic_route_ambiguous` and the segment passes through untouched.

When the runtime cannot be reached the session degrades to observe-only — never
silently. It prints the banner, records it on `session.notices`, and shows the
mode on the prompt and in every turn's bill. A turn carrying a plan refuses to
degrade on its own: it throws `cave_gateway_required_for_locked_plan`, and only
that failure earns one retry without the plan.

**The route is resolved once**, at `startCodingSession`, and pinned on
`session.route`. A machine with no runtime pays one failed start attempt for the
whole session, degradation is sticky, and a per-turn override can never re-open
routing.

## The token bill is a token count

After every turn the session prints:

- context tokens before and after transforms (from `RunResult.transformTrace`);
- tokens saved, labelled `inferred (local estimate)`;
- provider usage with its `usageBasis`;
- spend in USD with its `priceBasis`.

Savings are never expressed in currency, and a local session mints nothing. A
zero-turn session prints an honest absence rather than basis-labelled zeros.

## Recovery is proved, not asserted

`/prove-recovery` — and one automatic line after the first compression — takes a
recorded tool output, runs it through the same engine compress/retrieve pair the
plan and `cave_retrieve` use, and reports the SHA-256 comparison:

```text
recovery proof: read_file:big.txt round-trip OK (sha256 match efac7be09c1a)
```

A mismatch prints `FAILED (sha256 mismatch)` and the plan falls back to the
original body.

## Defaults

```ts
CODING_RUN_BREAKERS = {
  repeatedToolCalls: 3,
  repeatedToolCallWindowTurns: 8,
  noProgressTurns: 3,
  maxToolCallsPerTurn: 8,
};
```

No retry policy: retries require a declared budget. `CodingSessionOptions.budget`
exposes the runtime's hard pre-call token/USD budget; USD and `maxCostUsd` remain
mutually exclusive, and an unpriced model still fails closed.

## Programmatic mode

```ts
createCodingAgent({ workspace, toolMode: "programmatic" });
```

One `caveman_code` cell instead of a JSON tool wall. See
[Programmatic tools](05-programmatic-tools.md).

## Session API

| Export | Purpose |
| --- | --- |
| `createCodingAgent(options)` | Build the agent (workspace, model, `toolMode`, `memory`, `outputCaps`, `definitionTransforms`) |
| `startCodingSession(agent)` | Resolve the route once, return a `CodingSession` |
| `runCodingTurn(session, input)` | One turn |
| `streamCodingTurn(session, input, options)` | Streaming turn |
| `runCodingSession({ agent, … })` | The full interactive loop |
| `sessionBill` / `formatSessionBill` / `formatTurnBill` | Bill rendering |
| `proveRecovery` / `formatRecoveryProof` | The round-trip proof |
| `summarizeCodingTaskAttempts` | Harness economics (below) |
| `createCommandSessionRuntime` | Persistent shell session runtime |
| `defaultCodingPlan`, `RECOVERABLE_CODING_TRANSFORMS`, `OBSERVE_ONLY_BANNER` | Plan and presentation constants |

Caller `overrides` / `runOverrides` face `rejectInternalRunOptions` before any
session-internal field is merged.

## Harness economics

`summarizeCodingTaskAttempts()` reports `costPerCompletedTaskUsd` as total spend
across **every** attempt — failures included — divided by externally verified
completions. Missing completion, price, or stable runtime identity makes that
metric `null`; missing usage makes token metrics `null`. Unknown evidence never
becomes a favorable zero, and provider-invoice and public-catalog price bases
cannot be mixed.

## Locks

Live coding sessions are **never** lock-eligible: host mode anywhere in the graph
makes `compile` refuse with `cave_host_sandbox_lock_ineligible`. Locked builds
for coding agents compile against fixture corpora under a contained mode.

Runnable example:
[`examples/coding-agent`](../../examples/coding-agent).
API: [`@caveman-ai/coding-agent`](../reference/api/coding-agent.md),
[`@caveman-ai/agent/code`](../reference/api/agent/code.md).
