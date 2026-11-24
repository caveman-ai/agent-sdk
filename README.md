# Caveman Agents (`caveman-ai/agent-sdk`)

Build, evaluate, and run AI agents locally in-process on the open-source Caveman Harness (v4), or run the same definition on Caveman Cloud.

Looking for something else in Caveman?

| If you want to... | Use |
|---|---|
| Run the desktop app or terminal coding agent | [caveman-ai/caveman-code](https://github.com/caveman-ai/caveman-code) |
| Manage Caveman Cloud, Sandboxes, or call the API from TS/Python/Go | [caveman-ai/cloud-sdk](https://github.com/caveman-ai/cloud-sdk) |
| Compress prompts and tool outputs for an existing coding agent | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) |

## Quickstart

```bash
npm install @caveman-ai/agent @caveman-ai/harness
```

Define an agent and a local tool, then run it in-process with zero daemon and no Caveman account:

```ts
import { defineAgent, tool, runInProcess } from "@caveman-ai/agent";

const lookupInvoice = tool(
  "lookup_invoice",
  "Find an invoice by id",
  { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async ({ id }: { id: string }) => ({ id, status: "paid", amountUsd: 42 }),
);

const billing = defineAgent({
  name: "billing",
  instructions: "Answer billing questions briefly using lookup_invoice.",
  computer: "none",
  tools: [lookupInvoice],
});

const result = await runInProcess({
  agent: billing,
  task: "Check invoice 4411",
  model,
  stream,
});

console.log(result.text);
console.log(result.usage);
```

Run the exact same agent definition on Caveman Cloud by passing your API key to `new Caveman({ apiKey })` instead of running in-process.

## What is in this repository

| Package | License | What it does |
|---|---|---|
| `@caveman-ai/agent` | Apache-2.0 | High-level Agent SDK: `defineAgent`, `tool`, `runInProcess`, `Caveman`, `Session`, and deterministic `AGENT.md` to `agent.json` build compiler. |
| `@caveman-ai/harness` | Apache-2.0 | Harness v4: the loadout-driven coding and general agent loop (`HarnessSession`, `LocalEnv`, `DockerEnv`, `SandboxEnv`, MCP allowlist, `compact` / `exec` / `program` tools). |
| `@caveman-ai/protocol` | MIT | Canonical `SessionEvent`, `UserEvent`, exit codes `0..6`, and JSON schemas (`agent-build.schema.json`, `eval-file.schema.json`, `grader-registry.json`). |
| `@caveman-ai/evals` | MIT | 30 fail-closed TypeScript graders: deterministic assertions, tool-call checks, BLEU/ROUGE, localization F1, SSRF-pinned webhooks, and bias-guarded LLM judges. |
| `caveman-evals` (`python/`) | MIT | Python eval runner and grader parity package. |
| `@caveman-ai/react` | Apache-2.0 | React hooks for streaming agent sessions and approvals. |
| `@caveman-ai/adapter-kit` | Apache-2.0 | Adapter interfaces for bringing existing frameworks onto the Caveman protocol. |
| `@caveman-ai/create-agent` | Apache-2.0 | Project scaffolder (`npm create @caveman-ai/agent`). |

## Efficiency by construction

- **Byte-stable cache prefixes.** An agent definition compiles to identical prompt and tool bytes across turns. Skill bodies load only when activated, and MCP server failures never mutate the cached prefix.
- **Lean tool declarations.** Setting `computer: "none"` sends only the tools you declare, with no shell or file tools attached.
- **Cheap-first escalation.** `cave.run({ model: "fast", check: "pnpm test", escalate: ["base", "frontier"], budget: { usd: 2 } })` tries the fast model first and escalates only when the check fails.
- **Secret isolation.** Subprocesses and stdio MCP servers run with an explicit environment allowlist (`inheritEnv: false`) so workspace commands cannot read ambient host credentials.
- **Zero-compute durable parking.** Headless harness runs exit cleanly with code `5` (waiting on approval, tool, or sleep) or `6` (idle between turns) so hosts can release compute and resume later from the event log.

## Documentation

Every doc page lives in [`docs/`](./docs/) and aggregates into `docs.caveman.so/agent`:

- [Overview](./docs/index.mdx)
- [Quickstart](./docs/quickstart.mdx)
- [Harness v4 Reference](./docs/harness.mdx)
- [AGENT.md & Deterministic Builds](./docs/agent-md.mdx)
- [Sessions, Events & Parking](./docs/sessions.mdx)
- [Sandboxes: Local, Docker, and Cloud](./docs/sandboxes.mdx)
- [Evals & Graders](./docs/evals.mdx)
- [Session Protocol v1](./docs/protocol.mdx)

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## Contributing, Security & License

- Contributor guide & agent map: [`CONTRIBUTING.md`](./CONTRIBUTING.md), [`AGENTS.md`](./AGENTS.md) (`CLAUDE.md` symlinks to `AGENTS.md`).
- Security reporting: [`SECURITY.md`](./SECURITY.md).
- Apache-2.0 for `@caveman-ai/agent`, `@caveman-ai/harness`, `@caveman-ai/react`, `@caveman-ai/adapter-kit`, and `@caveman-ai/create-agent`. MIT for `@caveman-ai/protocol`, `@caveman-ai/evals`, and `caveman-evals`. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
