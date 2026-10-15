# Caveman Agent SDK documentation

Build an agent first, then add the capabilities your application needs.
These guides document the v0.2 source checkout, including features whose
publication is still gated. Start from a built checkout rather than assuming
the latest registry package has this API.

## Start here

| If you want to… | Read |
| --- | --- |
| Run an agent, add a tool, and read its receipt | [Getting started](guides/01-getting-started.md) |
| Choose a working application to modify | [Runnable examples](../examples/README.md) |
| Generate a project with tools and evals | [Initializer](../packages/create-caveman-agent/README.md) |
| Understand what the SDK actually owns | [Architecture](concepts/architecture.md) |
| Know what "inferred", "measured", and "verified" mean | [The honesty model](concepts/honesty-model.md) |
| Understand `optimized` vs `observe-only` | [Execution modes](concepts/execution-modes.md) |
| Attach Caveman to an existing framework | [Migrating](guides/17-migrating.md) |
| Look up a type, function, or option | [API reference](reference/api/README.md) |
| Look up a failure code | [Reserved `cave_` identifiers](reference/identifiers.md) |

## Guides

You do not need to read every guide. After getting started, choose tools and
output for a small application, durability and serving for a background worker,
or adapters if you already have an agent framework. Compiler and protocol
guides are advanced topics.

| # | Guide | Covers |
| --- | --- | --- |
| 01 | [Getting started](guides/01-getting-started.md) | Install, credentials, first agent, first receipt |
| 02 | [Agent definitions](guides/02-agent-definitions.md) | `agent()`, models, `auto()`, subagents, definition transforms |
| 03 | [The agent directory](guides/03-agent-directory.md) | Filesystem-first layout, `loadAgentDir`, run defaults |
| 04 | [Tools](guides/04-tools.md) | `tool()`, schemas, effects, result policies, timeouts, limits |
| 05 | [Programmatic tools](guides/05-programmatic-tools.md) | One `caveman_code` cell, nested dispatch, speculative reads |
| 06 | [Context, output, and Context IR](guides/06-context-and-output.md) | `context()`, `file()`, `output()`, stability zones, the frozen prefix |
| 07 | [Memory](guides/07-memory.md) | Engine, scope, passive recall, graph, embeddings, sidecars |
| 08 | [Compaction](guides/08-compaction.md) | The budget ladder, `cave.context-summary.v2`, the stability harness |
| 09 | [Budgets, receipts, and breakers](guides/09-budgets-receipts-breakers.md) | Reserve-and-clamp, denominations, `RunReceipt`, circuit breakers |
| 10 | [Durable runs](guides/10-durable-runs.md) | Journals, resume, idempotency, `DurableStore` implementations |
| 11 | [Serving and hosting](guides/11-serving-and-hosting.md) | `caveman-agent serve`, HTTP contract, containers, Cloudflare |
| 12 | [Evals and Cave Build](guides/12-evals-and-build.md) | `eval()`, splits, the compiler, lock artifacts, `check` |
| 13 | [Sandbox and security](guides/13-sandbox-and-security.md) | `required`/`host`/`fixture`, the kernel boundary, credentials |
| 14 | [Caveman Connect](guides/14-connect.md) | `createConnect()`, bounded reads, bound action arguments |
| 15 | [Plugins and skills](guides/15-plugins-and-skills.md) | Agent Skills, Agent Plugins v1, OpenPlugin, slash commands |
| 16 | [Adapters and the wire transport](guides/16-adapters-and-wire.md) | Nine lanes, the model boundary, `createCavemanTransport` |
| 17 | [Migrating to Caveman](guides/17-migrating.md) | The three depths, per-framework mapping, rollback |
| 18 | [The coding agent](guides/18-coding-agent.md) | `@caveman-ai/coding-agent`, `caveman-code`, the token bill |
| 19 | [The Pebble protocol](guides/19-pebble-protocol.md) | 19 turn events, JSONL framing, ACP mapping, session entries |

## Concepts

| Page | Covers |
| --- | --- |
| [Architecture](concepts/architecture.md) | What each package owns and why the boundaries are where they are |
| [The honesty model](concepts/honesty-model.md) | Claim bases, fail-closed rules, what the SDK refuses to assert |
| [Execution modes](concepts/execution-modes.md) | `optimized`, `observe-only`, locked runs, gateway degradation |

## Reference

| Page | Covers |
| --- | --- |
| [API reference](reference/api/README.md) | Exported symbols and package entrypoints, generated from built type declarations |
| [CLI](reference/cli.md) | `caveman-agent` and `caveman-code`, every command and flag |
| [Environment variables](reference/environment.md) | Every variable the runtime, CLI, and sandbox read |
| [Artifacts and files](reference/artifacts.md) | `.caveman/*`, lock envelopes, profiles, build reports, journals |
| [Reserved `cave_` identifiers](reference/identifiers.md) | Failure codes, tool names, and refusal reasons |
| [Packages](reference/packages.md) | Every workspace package, its purpose, exports, and install line |
| [Glossary](reference/glossary.md) | Terms such as session, durable store, execution backend, basis, and Cave Build |

## Regenerating the generated pages

```bash
npm run build                      # refresh the .d.ts surface first
node scripts/generate-docs-api.mjs # rewrites reference/api/** and reference/identifiers.md
```

Generated pages carry a banner and must not be hand-edited: the next run
overwrites them. Guides, concepts, and the non-generated reference pages are
hand-maintained.

## Requirements

- Node.js `>=22.19.0` for every package except the Eve adapter, which needs `>=24`.
- One provider credential (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
  `GEMINI_API_KEY`/`GOOGLE_API_KEY`).
- No Caveman account for direct runs. `cave: "off"` skips the gateway and
  reports `observe-only`. Locked execution has additional readiness requirements.

## License

Apache-2.0. The Claude Agent SDK lane depends on software governed by Anthropic
terms; see [`LICENSING.md`](../LICENSING.md) and that adapter's README.
