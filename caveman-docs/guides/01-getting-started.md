# Getting started

Start with one file and one provider key. Add tools, a conversation, and a
budget only when you need them.

These instructions use the **v0.2 source checkout**. The repository is private
during development and publication is gated; registry packages may not expose
the API documented here.

## 1. Build the checkout

Requires Node.js **22.19+**, npm, and access to the repository. The optional Eve
adapter requires Node.js 24+.

```bash
git clone https://github.com/JuliusBrussee/agent-sdk.git
cd agent-sdk
npm ci
npm run build
```

Run the remaining commands from this repository root. The workspace install
makes `@caveman-ai/agent` available to files you create here.

## 2. Set one provider key

Choose your provider and set its key in the shell running your agent:

| Provider | Environment variable |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |

For example, replace the placeholder with your API key:

```bash
export ANTHROPIC_API_KEY="your-api-key"
```

A `.env` file is not loaded automatically by the plain Node command below.
If you prefer one, keep it out of Git and use `node --env-file=.env hello.mjs`.
No Caveman account or gateway is needed.

## 3. Run an agent

Save this complete file as `hello.mjs` in the repository root:

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

You should see a model answer followed by the run receipt. This command makes
a provider request and incurs any charges from your provider.

`auto()` resolves a model in this order:

1. `CAVE_MODEL`.
2. `.caveman/provider.json`.
3. A baseline model for the first supported credential found, in the order
   Anthropic → OpenAI → Google.

If several provider credentials exist, it warns and selects the first. If none
exist, it fails. It does not classify your task or route on quality. Use an
explicit `model: "provider/model"` to pin a model instead.

`cave: "off"` keeps this example direct to your provider and skips gateway
startup and probes. The result reports `mode: "observe-only"`; that is an
expected execution mode, not an error. Usage and receipts remain available,
but no efficiency is claimed. The runtime default, `cave: "auto"`, uses a
compatible gateway when available and otherwise goes direct.
[Execution modes](../concepts/execution-modes.md) explains both paths.

## 4. Give it a tool

Replace `hello.mjs` with this complete example:

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

const result = await run(support, "What is the refund window in the EU?", {
  cave: "off",
});

console.log(result.text);
console.log(result.receipt.tools);
```

Run `node hello.mjs` again. The policy is fixture data in this example; replace
the function body with your application's lookup. Input schemas validate before
your function runs. Each tool declares its effect; optional output schemas
validate its result. See [Tools](04-tools.md).

**Host execution is not isolation.** The example explicitly runs your tool
function in your Node process. The earlier example also uses host execution
because no sandbox or entry module was specified; the runtime prints a notice.
For contained tools, export your definition from an entry module, declare
`sandbox: "required"`, and pass its `entryPath` to `run()`. A required sandbox
without an entry module fails closed.
[Sandbox and security](13-sandbox-and-security.md) covers the full setup.

The next examples use `support` from this file. Replace the final `run()` and
logging statements with the sample you want to try.

## Stream the answer

Add `stream` to the imports:

```js
for await (const event of stream(support, "Explain the refund policy.", {
  cave: "off",
})) {
  if (event.type === "pi" && event.event.type === "message_update") {
    const update = event.event.assistantMessageEvent;
    if (update.type === "text_delta") process.stdout.write(update.delta);
  }
  if (event.type === "run_end") console.log(event.result.receipt);
  if (event.type === "run_error") console.error(event.code, event.receipt);
}
```

Pi owns the streaming event contract; Caveman passes those events through
under `event.type === "pi"`. Breaking out of the iterator aborts outstanding
provider, tool, and subagent work before releasing conversation ownership.
Both terminal events carry a receipt.

## Keep a conversation

Add `createConversation` to the imports:

```js
const conversation = createConversation();

await run(support, "What is the refund window in the EU?", {
  conversation,
  cave: "off",
});

const followUp = await run(support, "How many weeks is that?", {
  conversation,
  cave: "off",
});
console.log(followUp.text);
```

A conversation is in memory and supports one active run. Concurrent reuse fails
closed. For crash recovery, see [Durable runs](10-durable-runs.md); for clients
sharing a session, see [Serving and hosting](11-serving-and-hosting.md).

## Set a budget and handle failures

Add `CavemanRunError` to the imports:

```js
try {
  const result = await run(support, "Explain the refund policy.", {
    cave: "off",
    budget: { maxUsd: 1, onExhausted: "stop" },
  });
  console.log(result.text);
  console.log(result.receipt.stopReason);
} catch (error) {
  if (error instanceof CavemanRunError) {
    console.error(error.code);
    console.error(error.receipt);
  }
  throw error;
}
```

USD budgets require a metered API credential and known catalog prices. Use
`budget: { maxTokens: 12_000 }` when you want a token budget instead. Local
catalog costs are not invoices; savings remain inferred.

Always inspect `receipt.stopReason`: a budget or breaker may stop a run before
a final answer. Execution errors preserve partial spend in
`CavemanRunError.receipt`. See [Budgets, receipts, and breakers](09-budgets-receipts-breakers.md).

## Troubleshooting

Run a readiness check without making a model request:

```bash
node packages/agent/dist/cli.js doctor
```

| Symptom | Action |
| --- | --- |
| Cannot resolve `@caveman-ai/agent` | Run `npm ci` and `npm run build`; keep `hello.mjs` in the checkout root |
| No credential or unknown model | Set one provider key; check stale `CAVE_MODEL` or `.caveman/provider.json` overrides |
| Gateway or engine warnings | Direct runs still work; use `cave: "off"` for an explicit direct path |
| `cave_tool_sandbox_entry_required` | Supply an entry module for your required sandbox; see [sandbox setup](13-sandbox-and-security.md) |
| Budget stops before an answer | Inspect the receipt and choose a suitable model, budget, or output limit |

`doctor` reports missing gateway components as warnings. Invalid config,
unsupported Node versions, lock drift, and containment failures fail the check.

## Start a larger project

The [initializer](../../packages/create-caveman-agent/README.md) generates
either a support bot with tools and evals or a background agent with sessions.
Use its source-checkout instructions while this version is unpublished.

After a compatible release is published, the registry entry point is:

```bash
npm create @caveman-ai/agent@latest my-agent
```

For application examples today, browse [examples](../../examples/README.md).
For the next design step, choose [agent definitions](02-agent-definitions.md),
[files and skills](03-agent-directory.md), or [structured output](06-context-and-output.md).
