<p align="center">
  <img src="docs/assets/caveman-logo-banner.png" alt="Caveman" width="720">
</p>

# Caveman Agent SDK

Build TypeScript agents with tools, conversations, streaming, budgets, and a
receipt for every run. Add durable execution and a session server when you need
them. No Caveman account required.

Pi **1.2.0** owns the model and tool loop. Caveman adds spend controls, context
management, durable journals, and eval-gated builds around that loop.

> **Development preview.** This private repository documents the v0.2 source
> under development. Publication is gated; a registry install is not proof that
> it contains this API. Use the checkout instructions below to try this version.

## Run your first agent

Requires Node.js **22.19+**, repository access, and one provider API key.

```bash
git clone https://github.com/JuliusBrussee/agent-sdk.git
cd agent-sdk
npm ci
npm run build
```

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` in your shell.
Then save this as `hello.mjs` in the repository root:

```js
import { agent, auto, run } from "@caveman-ai/agent";

const assistant = agent({
  id: "hello",
  instructions: "Give clear, concise answers.",
  model: auto(),
});

const result = await run(assistant, "Explain a cache hit in one sentence.", {
  cave: "off",
});

console.log(result.text);
console.log(result.receipt);
```

```bash
node hello.mjs
```

`auto()` selects a configured model from your provider credentials. `cave:
"off"` sends this first run directly to your provider, without starting or
contacting a Caveman gateway. The result reports `mode: "observe-only"`:
provider usage is available, but no optimization is claimed.

**Next:** [Getting started](caveman-docs/guides/01-getting-started.md) adds a
tool, streaming, a conversation, and error handling to this same agent.

## Add a tool

Tools are ordinary functions with a schema and an explicit effect. Add this
before the agent definition, then pass `tools: [lookupPolicy]` to `agent()`:

```js
import { schema, tool } from "@caveman-ai/agent";

const lookupPolicy = tool({
  name: "lookup_policy",
  description: "Read the refund policy for a region.",
  input: schema.object({ region: schema.string() }),
  effect: "read",
  async execute({ region }) {
    return { region, refundWindowDays: 14 };
  },
});
```

Without an explicit sandbox or entry module, `run()` executes tools on the
host and prints a notice. **Host execution is not isolation.** For containment,
declare `sandbox: "required"` and supply `entryPath`; see
[sandbox and security](caveman-docs/guides/13-sandbox-and-security.md).

## Control each run

```js
const result = await run(assistant, "Summarize the refund policy.", {
  cave: "off",
  budget: { maxUsd: 1, onExhausted: "stop" },
});
```

A USD budget reserves against public catalog prices before each root or
subagent call and settles after usage arrives. Unknown pricing fails closed.
These are local spending controls, not provider invoices or account quotas.
The receipt records model calls, tool calls, stop reason, and accounting basis;
failed runs expose partial spend through `CavemanRunError.receipt`.

Use a metered API key for USD budgets. For subscription credentials, use
`budget: { maxTokens: 12_000 }` instead.

## Choose your next step

| You want to… | Start here |
| --- | --- |
| Build a small agent | [Getting started](caveman-docs/guides/01-getting-started.md) |
| Generate a project with tools and evals | [Initializer](packages/create-caveman-agent/README.md) |
| Organize instructions, tools, and skills as files | [Agent directory](caveman-docs/guides/03-agent-directory.md) |
| Validate tool inputs and structured output | [Tools](caveman-docs/guides/04-tools.md) · [Output](caveman-docs/guides/06-context-and-output.md) |
| Add budgets, deadlines, or loop breakers | [Run controls](caveman-docs/guides/09-budgets-receipts-breakers.md) |
| Resume after a crash | [Durable runs](caveman-docs/guides/10-durable-runs.md) |
| Serve a chat UI or background worker | [Sessions and hosting](caveman-docs/guides/11-serving-and-hosting.md) |
| Run a coding agent | [Coding agent](caveman-docs/guides/18-coding-agent.md) |
| Keep an existing agent framework | [Adapters and transport](caveman-docs/guides/16-adapters-and-wire.md) |
| Evaluate and lock an execution plan | [Evals and Cave Build](caveman-docs/guides/12-evals-and-build.md) |

Browse [runnable examples](examples/README.md), [all guides](caveman-docs/README.md),
or the [API reference](caveman-docs/reference/api/README.md).

## What is optional

- **Gateway:** `cave: "auto"` is the runtime default. It uses an available
  Caveman gateway for supported providers and otherwise runs directly. Locked
  plans require the gateway and refuse to silently downgrade.
- **Persistence:** ordinary runs are in memory. Add `durable: { runId }` to
  journal execution. A provider request interrupted before settlement remains
  uncertain; durability cannot promise that it was not billed twice.
- **Memory and compaction:** opt into [memory](caveman-docs/guides/07-memory.md)
  and [compaction](caveman-docs/guides/08-compaction.md) for longer workflows.
- **Skills and plugins:** workspace discovery is explicit through
  [`@caveman-ai/agent/plugins`](caveman-docs/guides/15-plugins-and-skills.md).
  Plugin loading supports declarative skills and commands. It does not execute
  plugin hooks, custom agents, or MCP servers. Hosts may launch explicit MCP
  entries through the separate `McpHost` API.
- **Compiler:** eval-gated builds are an advanced path. Native Pi behavioral
  search currently supports tool-free agents; adapter presence does not imply
  compiler support or live-provider certification.

Local savings always remain **inferred**. `optimized` describes the execution
path, not verified savings. See the [honesty model](caveman-docs/concepts/honesty-model.md).

## Repository map

| Package | Purpose |
| --- | --- |
| [`@caveman-ai/agent`](packages/agent/README.md) | Agent runtime, tools, budgets, receipts, memory, compiler, and CLI |
| [`@caveman-ai/create-agent`](packages/create-caveman-agent/README.md) | Project initializer |
| [`@caveman-ai/coding-agent`](packages/coding-agent/README.md) | Coding tools and CLI |
| [`@caveman-ai/react`](packages/react/README.md) | Browser hooks for the session server |
| [`@caveman-ai/evals`](packages/evals/README.md) | Graders and evaluation contracts |
| [`adapter-kit`](packages/adapter-kit/README.md) and [`adapters/*`](caveman-docs/guides/16-adapters-and-wire.md) | Framework manifests and exact-pinned bindings |
| [`adapter-conformance`](packages/adapter-conformance/README.md) | Reproducible adapter evidence |
| [`@pebble-agent/protocol`](packages/pebble-protocol/README.md) | Apache-2.0 wire and session protocol |

Proprietary Pebble implementation lives in a separate repository. Package
ownership and dependency rules are in [MONOREPO.md](docs/MONOREPO.md).

## Develop

From the built checkout above:

```bash
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run license:check
npm run pack:check
```

`npm test` includes API and source-size ratchets. Resolve changes deliberately;
do not widen budgets to hide growth. On restricted macOS hosts, sandbox and
loopback checks need host permissions before failures count as product defects.
See [release gates](docs/RELEASING.md) and the
[sandbox threat model](packages/agent/SANDBOX_THREAT_MODEL.md).

## License

Apache-2.0. See [LICENSING.md](LICENSING.md). Optional third-party adapters
retain their upstream terms, including the Claude Agent SDK.
