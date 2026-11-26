<div align="center">

<a href="https://github.com/caveman-ai/agent-sdk"><img src="docs/assets/banner.png" alt="Caveman Agent SDK. Caveman Harness, built on Pi." width="880"></a>

# Caveman Agent SDK

**TypeScript agents built for small prompts.**<br>
An open-source SDK built on Caveman Harness. Run agents in your own process with a model key, or run the same agent definition on Caveman Cloud.

<a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-111?style=flat-square" alt="Apache-2.0"></a>
<a href="#quick-start"><img src="https://img.shields.io/badge/checkout-Node_24%2B-111?style=flat-square" alt="Node.js 24+ for the checkout"></a>
<a href="#built-to-spend-less"><img src="https://img.shields.io/badge/engine-Caveman_Harness-111?style=flat-square" alt="Caveman Harness"></a>

[Quick start](#quick-start) · [Built to spend less](#built-to-spend-less) · [Packages](#packages) · [Docs](#documentation)

</div>

## An agent is a folder

Put instructions in `AGENT.md`. Skills, subagents and evals sit beside it.

```text
triage/
├── AGENT.md                  # frontmatter + instructions
├── skills/
│   └── refunds/
│       └── SKILL.md
├── agents/
│   └── security/
│       └── AGENT.md          # a subagent
└── evals/
    └── basic.eval.json
```

```markdown
---
name: triage
description: Route billing and refund requests
model: fast
computer: none
---

Classify the ticket and check refund eligibility before replying.
```

`compileAgentFolder("./triage")` returns the `agent.json` manifest and its SHA-256 digest. The manifest lists file hashes in bytewise path order. The compiler includes `AGENT.md` and files under `skills/`, `agents/` and `evals/`. It rejects symlinks it encounters. Rebuilding the same folder gives you the same digest.

## Or a few lines of TypeScript

```ts
import { agentFileText, compileAgentDefinition, defineAgent, defineSensor, tool } from "@caveman-ai/agent";

const lookupOrder = tool(
  "lookup_order",
  "Return sample order status by ID.",
  { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  async ({ orderId }: { orderId: string }) => ({ orderId, status: "shipped" }),
);

const triage = defineAgent({
  name: "triage",
  instructions: "Check the order with lookup_order. Escalate damaged shipments.",
  model: "fast",
  computer: "none",
  tools: [lookupOrder],
  sensors: [defineSensor({ name: "ticket-opened", kind: "webhook" })],
});

console.log(agentFileText(triage));
console.log(compileAgentDefinition(triage).digest);
```

`agentFileText()` renders instructions and JSON frontmatter as agent file text. Review the file diff alongside the build digest. To identify the harness bundle and loadout behind a CLI run, record `bundle_sha256` and `loadout_hash`. The CLI reports the normalized loadout hash from `loadoutHash()` as `behavior_hash`.

## Built to spend less

Caveman Harness keeps the prompt prefix stable and gives each model the tools it needs. With a check and a model ladder, `cave.run()` can start cheap and move up after a failed attempt.

### Tool surfaces by model

| Model | Coding surface |
| --- | --- |
| GPT on the Responses API | QuickJS `exec` cells, plus shell and patch tools |
| Claude and other models | Five compact tools: `read`, `bash`, `wait`, `edit`, `write` |
| Any model, `computer: "none"` (default loadout) | Only the tools you supply, without a coding prompt |

### Filter MCP results inside a cell

Connect to a server over stdio or streamable HTTP with `connectMcp()`. In code mode, the model can call several MCP tools from a QuickJS cell and return only the fields it needs. `app-claude` adds the `program` tool to the prompt only when the session has MCP tools.

### Keep the prompt prefix stable

- `AGENT.md` renders to the same bytes for the same definition, and the build manifest records its hash.
- Tool declarations stay fixed for the whole session.
- App loadouts put environment details in the first user message, keeping them out of the system prefix.
- Compaction asks for its summary with the current conversation as the prefix.
- On Anthropic, `app-claude` and `app-general` ping the prompt cache every 270 seconds during a long tool call, up to 12 times per gap (54 minutes at that interval). Pings count toward usage.

The harness source notes that cache expiry accounted for 6% of spend across 196 Opus 5.5 trials on an earlier harness. A ping that hits the cache pays for a read and can spare the next turn a cache write.

### Start cheap and step up after a failed attempt

```ts
import { Caveman } from "@caveman-ai/agent";

const cave = new Caveman();
const fix = await cave.run({
  agent: "builder",
  task: "Make the parser accept trailing commas.",
  model: "fast",
  escalate: ["base", "frontier"],
  check: "pnpm test",
  budget: { usd: 2 },
});
console.log(fix.passed, fix.attempts, fix.usage);
```

A failing `pnpm test` gives the next model the original task and check output. The ladder stops on a pass, when the budget or model list runs out, or on certain errors such as a missing runtime. To run this locally, install `caveman-runtime`, set a model key and put `builder.md` in `.caveman/agents/`. On Cloud, use `new Caveman({ apiKey })`, pass `repo: "owner/name"` and use a function for `check` that returns `true` or failure text. Command checks run locally.

### Park sessions while they wait

The [session protocol](./docs/protocol.mdx) reserves exit code `5` for a session parked on an approval, tool or timer. Code `6` means it is idle between turns. A host that supports durable parking can release compute and resume the session later. The webhook sensor above is stored in the build's `AGENT.md` so a host can use it as a wake trigger.

### Require approval before a tool runs

Mark a tool with `tool(name, description, schema, handler, { gate: { risk: "high" } })` and pass a `gateProvider` to `runInProcess()`. Use `createMemoryGateProvider()` to turn a policy callback into a provider. The gated handler runs only after an `"approved"` decision. Matching harness rules also apply inside `exec` and `program` cells. Gate requests for nested MCP calls include the server and tool names.

To catch regressions before you swap models, `@caveman-ai/evals` implements 27 of the [registry's 30 grader types](./packages/protocol/schemas/grader-registry.json), including `tool_argument_assertion` and `cost_threshold`. `grade()` fails on an unknown grader, or on a cost check with no cost data.

## Quick start

You need Git, Node.js 24 or later and pnpm 10.14.0.

```bash
git clone https://github.com/caveman-ai/agent-sdk.git
cd agent-sdk
pnpm install --frozen-lockfile
pnpm build
pnpm test:examples
```

That runs all five [example recipes](./examples/basics) offline, using a scripted model where needed. For a live run, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and run `node examples/basics/01-hello-agent.ts`.

Save this as `packages/agent/quickstart.mts` and run `node packages/agent/quickstart.mts`:

```ts
import { defineAgent, runInProcess } from "@caveman-ai/agent";

const { text, usage } = await runInProcess({
  agent: defineAgent({ name: "explainer", instructions: "Answer in one short paragraph.", computer: "none" }),
  task: "What does a prompt cache save an agent?",
  model: "anthropic/claude-sonnet-4-6",
});
console.log(text, usage);
```

The in-process runner needs a provider key and runs without a daemon. With an OpenAI key, use `"openai/gpt-5.4"`. `tool()` takes a JSON Schema object or a schema that supports both Standard Schema and Standard JSON Schema, such as those from Zod, Valibot or ArkType.

`npm install @caveman-ai/agent@1.0.0` installs the published release, where `runInProcess()` takes a model object and a `stream` function. For model strings, Gates, Sensors and `@caveman-ai/agent/harness`, build from this checkout.

## Packages

| Package | License | For |
| --- | --- | --- |
| [`@caveman-ai/agent`](./packages/agent/README.md) | Apache-2.0 | Agent definitions, tools, in-process runs, the `Caveman` client |
| [`@caveman-ai/harness`](./packages/harness/README.md) | Apache-2.0 | Sessions, loadouts, execution environments, MCP, the harness CLI |
| [`@caveman-ai/protocol`](./packages/protocol) | MIT | Session events, exit codes, JSON schemas |
| [`@caveman-ai/evals`](./packages/evals) | MIT | TypeScript graders and the eval CLI |
| [`caveman-evals`](./python/caveman-evals) | MIT | Python eval runner |
| [`@caveman-ai/react`](./packages/react) | Apache-2.0 | React hooks for streaming runs and approvals |
| [`@caveman-ai/adapter-kit`](./packages/adapter-kit) | Apache-2.0 | Adapter manifests for other frameworks |
| [`@caveman-ai/create-agent`](./packages/create-agent) | Apache-2.0 | `npm create @caveman-ai/agent` scaffolding |

## Documentation

[Overview](./docs/index.mdx) · [Harness](./docs/harness.mdx) · [Agent builds](./docs/agent-md.mdx) · [Sessions](./docs/sessions.mdx) · [Execution environments](./docs/sandboxes.mdx) · [Evals](./docs/evals.mdx) · [Session protocol](./docs/protocol.mdx) · [Cloud SDK and `cvm`](https://github.com/caveman-ai/cloud-sdk)

## License

Apache-2.0 and MIT licenses are listed by package above. Caveman Harness builds on [Pi](https://github.com/earendil-works/pi). See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Report security issues through [SECURITY.md](./SECURITY.md); see [CONTRIBUTING.md](./CONTRIBUTING.md) for patches.
