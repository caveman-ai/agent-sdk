# Getting started

## Requirements

- Node.js `>=22.19.0`. The Eve adapter lane needs `>=24`.
- One provider credential in the environment:
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_API_KEY`.
- Nothing else. No Caveman account, no hosted service.

## Option A — scaffold a project

```bash
npm create @caveman-ai/agent@latest my-agent
cd my-agent
npm run doctor      # zero provider calls
npm run dev
```

The initializer writes one source file, a starter eval, a strict build config, a
provider choice, and installs dependencies. Exactly one detected credential is
selected silently; zero or several prompt once. Secrets are never printed or
written.

Two templates ship: `support-bot` (the default: tools, evals, a build config)
and `background-agent` (server-first sessions, a durable store per session, a
remote execution backend, no build).

Non-interactive:

```bash
npm create @caveman-ai/agent@latest my-agent -- --provider anthropic
npm create @caveman-ai/agent@latest my-agent -- --template background-agent
npm create @caveman-ai/agent@latest my-agent -- --provider openai --no-install
```

Supported providers: `anthropic`, `openai`, `google`.

> `@caveman-ai/agent` v0.2 is not published to npm yet. Registry installs may
> expose an older surface; use this checkout when testing anything described in
> these docs. The published `@caveman-ai/create-agent` 0.1.0 has no
> `--template` flag yet.

## Option B — run from this repository

```bash
git clone https://github.com/caveman-ai/agent-sdk.git
cd agent-sdk
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
```

## The smallest agent

```ts
import { agent, auto, run } from "@caveman-ai/agent";

const support = agent({
  id: "support",
  instructions: "Answer from policy. Never invent policy.",
  model: auto(),
});

const result = await run(support, "Can I get a refund?");
console.log(result.text);
console.log(result.receipt);
```

`auto()` resolves configuration in this order:

1. `CAVE_MODEL`
2. `.caveman/provider.json`
3. The baseline model for a supported provider credential present, in the fixed
   order anthropic → openai → google. With several credentials in the shell it
   picks the first of those and prints one warning naming `CAVE_MODEL`, rather
   than refusing to start. With none, it throws — an unknown model is not a
   default.

It never classifies a task and never routes between models on quality.

## Where tools run

The agent above declared no `sandbox`, so `run()` executes its tools on the
host and says so, once:

```text
cave: host execution — tools are not isolated
```

That is the honest label, not a mode: host execution is not isolation. When you
want containment, declare it and hand `run()` the entry module the sandbox
stages from:

```ts
const support = agent({ id: "support", instructions, model: auto(), sandbox: "required" });
await run(support, "Can I get a refund?", { entryPath: "./agent.ts" });
```

An explicit `sandbox: "required"` without `entryPath` fails closed with
`cave_tool_sandbox_entry_required` — declaring containment and not getting it is
never silent.

## What the first run tells you

Runs are **direct** by default: your key, your provider, no proxy. On a machine
with only Node and a provider key:

```text
cave: observe-only — engine/gateway unavailable; transforms and gateway
telemetry off (provider usage and local context estimates remain available)
```

`observe-only` is the receipt value for a direct run — `RunResult.mode` is
`"observe-only"`. The call went straight to your provider. Provider usage and
local context estimates are still there; no efficiency is claimed. See
[Execution modes](../concepts/execution-modes.md).

`optimized` is optional and requires the Caveman gateway:

```bash
npm i -g @caveman-ai/cli
caveman start
```

## Multi-turn

```ts
import { createConversation, run } from "@caveman-ai/agent";

const conversation = createConversation();
await run(support, "My order is late.", { conversation });
const followUp = await run(support, "What should I do next?", { conversation });
```

One conversation is single-owner: concurrent use of the same conversation fails
closed, and a failed turn rolls conversation and cache state back.

## Streaming

```ts
import { stream } from "@caveman-ai/agent";

for await (const event of stream(support, "Where is order A-123?")) {
  if (event.type === "model_delta") process.stdout.write(event.text);
}
```

Typed run, context, model, completion, and error events. Calling the iterator's
`return()` aborts in-flight provider, tool, and subagent work before
conversation ownership releases. Both terminal events (`run_end`, `run_error`)
carry the ledger, and the promise entry points throw `CavemanRunError` whose
`receipt` holds the partial spend.

## Readiness check

```bash
npx -p @caveman-ai/agent caveman-agent doctor        # add --json for a machine-readable report
```

`doctor` makes no model request. Missing engine, runtime CLI, or gateway is a
`WARN` and exits 0. Bad Node version, broken sandbox containment, invalid
config, or lock drift fails.

## Next steps

- [Agent definitions](02-agent-definitions.md) — everything `agent()` accepts.
- [The agent directory](03-agent-directory.md) — the filesystem-first layout.
- [Tools](04-tools.md) — schemas, effects, and result policies.
- [Budgets, receipts, and breakers](09-budgets-receipts-breakers.md) — spend control.
- [Serving and hosting](11-serving-and-hosting.md) — sessions, the fetch
  handler, and durable stores.
