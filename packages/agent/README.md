# `@caveman-ai/agent`

TypeScript agents with typed tools, conversations, streaming, budgets, and run
receipts. Built on exact-pinned Pi **1.2.0**. Add persistence, sessions, memory,
and eval-gated builds as your application needs them.

> **Development preview:** this README describes v0.2 source in
> [JuliusBrussee/agent-sdk](https://github.com/JuliusBrussee/agent-sdk).
> Publication is gated. Follow the repository's
> [checkout setup](../../README.md#run-your-first-agent) to run this API;
> a registry install may contain a different version.

Requires Node.js **22.19+** and a provider API key. No Caveman account required.

## First run

After building the checkout, save `hello.mjs` in its root and run
`node hello.mjs`:

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

Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` in your shell
before running. `auto()` resolves `CAVE_MODEL`, then `.caveman/provider.json`,
then supported credentials in the order Anthropic → OpenAI → Google. With
several credentials it warns and uses the first; with none it fails. You can
also pass an explicit `"provider/model"` string.

`cave: "off"` sends requests directly to your provider. Results report
`mode: "observe-only"`; usage remains available, and no optimization is
claimed. The default `cave: "auto"` uses an available gateway or falls back
to direct requests. [Execution modes](../../caveman-docs/concepts/execution-modes.md).

## Tools

```js
import { agent, auto, run, schema, tool } from "@caveman-ai/agent";

const lookupPolicy = tool({
  name: "lookup_policy",
  description: "Read the refund policy for a region.",
  input: schema.object({ region: schema.string() }),
  effect: "read",
  async execute({ region }) {
    return { region, refundWindowDays: 14 };
  },
});

const support = agent({
  id: "support",
  instructions: "Use lookup_policy for policy questions. Never invent policy.",
  model: auto(),
  tools: [lookupPolicy],
  sandbox: "host",
});

console.log((await run(support, "What is the refund window in the EU?", {
  cave: "off",
})).text);
```

**Host execution is not isolation.** Tools in this sample run in your process.
For containment, declare `sandbox: "required"` and supply `entryPath` to the
module exporting your definition. Missing containment fails closed. If neither
sandbox nor entry module is declared, the public `run()` and `stream()` helpers
use host execution with a notice.

Inputs validate before execution. Optional output schemas validate results
before they enter model context. Effects are `read`, `write`, `idempotent`, or
`external`; every tool must declare one. `RunOptions.toolPolicy` can deny calls
outside the model's control; it decides within 10 s unless it carries its own
`timeoutMs` (up to a day, for a policy that asks a person). [Tool guide](../../caveman-docs/guides/04-tools.md)
and [sandbox contract](../../caveman-docs/guides/13-sandbox-and-security.md).

## Streaming and conversations

Using `support` from the example above:

```js
import { createConversation, stream } from "@caveman-ai/agent";

const conversation = createConversation();

for await (const event of stream(support, "My order is late.", {
  conversation,
  cave: "off",
})) {
  if (event.type === "pi" && event.event.type === "message_update") {
    const update = event.event.assistantMessageEvent;
    if (update.type === "text_delta") process.stdout.write(update.delta);
  }
}

const followUp = await run(support, "What can I do next?", {
  conversation,
  cave: "off",
});
```

Pi events are available unchanged under `event.type === "pi"`.
One conversation supports one active run. Concurrent reuse fails closed.
Breaking out of the iterator aborts outstanding work before releasing ownership.
`run_end` and `run_error` events carry receipts.

## Budgets and errors

```js
import { CavemanRunError } from "@caveman-ai/agent";

try {
  const result = await run(support, "Explain the refund policy.", {
    cave: "off",
    budget: { maxUsd: 1, onExhausted: "stop" },
  });
  console.log(result.text, result.receipt.stopReason);
} catch (error) {
  if (error instanceof CavemanRunError) {
    console.error(error.code, error.receipt);
  }
  throw error;
}
```

A USD budget reserves catalog cost before root and descendant calls, then
settles usage. Unknown pricing fails closed. Use a metered API key for USD
budgets, or `budget: { maxTokens: 12_000 }` for token limits. These are local
controls at public list prices, not provider invoices or platform quotas.

Receipts include model and tool calls, subagents, stop reason, accounting basis,
compactions, and resume state. A stopped run can return before producing final
text; inspect `receipt.stopReason`. Errors during execution carry partial spend
through `CavemanRunError.receipt`.
[Budgets and receipts](../../caveman-docs/guides/09-budgets-receipts-breakers.md).

## Add capabilities when needed

| Need | API or guide |
| --- | --- |
| Typed final answers | [`output({ schema })`](../../caveman-docs/guides/06-context-and-output.md) |
| Instructions, tools, and skills as files | [`loadAgentDir()`](../../caveman-docs/guides/03-agent-directory.md) |
| Bounded subagents | [`subagent()`](../../caveman-docs/guides/02-agent-definitions.md) |
| Crash recovery | [`durable: { runId }`](../../caveman-docs/guides/10-durable-runs.md) |
| HTTP sessions and event streams | [`createAgentServer()` / `createAgentHandler()`](../../caveman-docs/guides/11-serving-and-hosting.md) |
| SQL and object-store journals | [`@caveman-ai/agent/durable`](../../caveman-docs/guides/10-durable-runs.md) |
| Remote tool execution | [Execution backends](docs/execution-backend.md) |
| Long-running context | [Memory](docs/memory.md) · [Compaction](docs/compaction.md) |
| Tools called through one code cell | [Programmatic tools](../../caveman-docs/guides/05-programmatic-tools.md) |
| Connected data | [Connect](docs/connect.md) |
| Explicit skills and plugin loading | [`@caveman-ai/agent/plugins`](../../caveman-docs/guides/15-plugins-and-skills.md) |
| Existing agent framework | [Adapters and wire transport](../../caveman-docs/guides/16-adapters-and-wire.md) |
| Quality-gated execution plans | [Evals and Cave Build](../../caveman-docs/guides/12-evals-and-build.md) |

Durable recovery preserves known spend; an interrupted provider request can
remain uncertain. Session hosting requires authentication. A remote execution
backend only provides the containment its host implements. Each linked guide
states the relevant constraints.

## Evals and Cave Build

Builds evaluate candidates on development cases and freeze the selected plan
before opening holdouts. Native Pi behavioral search currently supports
tool-free agents. Other adapter lanes stay baseline-equivalent unless their
capability contract proves more. Live host agents are not lock-eligible.

`runLocked()` validates a Pi build before provider traffic and requires the
Caveman gateway. It does **not** fall back to observe-only execution. Run
`caveman-agent check` during deployment to verify source, config, and eval
freshness; parsing a lock alone does not establish it.

Local evidence remains **inferred** and verified savings remain zero. Build
hashes bind artifact integrity, not runtime attestation or production savings.

## Reference and diagnostics

- [API reference](../../caveman-docs/reference/api/agent/README.md) — exported
  symbols and subpaths, generated from built declarations.
- [CLI reference](../../caveman-docs/reference/cli.md) — `dev`, `serve`,
  `build`, `check`, `doctor`, and `register`.
- [Environment](../../caveman-docs/reference/environment.md) — credentials and
  runtime configuration.
- [Failure codes](../../caveman-docs/reference/identifiers.md) — `cave_*` errors.
- [Sandbox threat model](SANDBOX_THREAT_MODEL.md).

From the repository root, `node packages/agent/dist/cli.js doctor` checks
readiness without a model call. Missing gateway components produce warnings;
invalid config, lock drift, and failed containment checks produce failures.

Apache-2.0. Optional adapters retain their upstream terms, including the Claude
Agent SDK.
