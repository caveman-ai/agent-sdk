# Moving an eve agent directory to Caveman

Ten minutes from a `vercel/eve` agent directory to a first Caveman receipt.
There is no import command and nothing here rewrites your files — the two
conventions overlap on purpose, so the migration is mostly a move. Eve is a
good framework; this page is for when you want the receipt, the budget, and
the build gate, not an argument for leaving.

For the general case, including the one-line `fetch` option that needs no
move at all, see [`migrate.md`](./migrate.md). This page is the eve-specific
directory map.

`caveman-agent doctor`, run inside an eve directory, recognizes the layout
and prints the short version of this table.

## What maps

Eve's layout (its README and `docs/reference/project-layout.md`): an `agent/`
directory — or the project root, in eve's flat layout — holding
`instructions.md` (required), optional `agent.ts`, `tools/`, `skills/`,
`subagents/`, `sandbox/`, plus eve-only `channels/`, `schedules/`,
`connections/`, and `hooks/`.

The Caveman convention is the flat shape of the same idea: everything lives
at the project root, next to `caveman.config.ts`.

| In your eve directory | Here | The move |
|---|---|---|
| `agent/instructions.md` | `instructions.md` | move as-is — a raw markdown system prompt on both sides |
| `agent/tools/*.ts` | `tools/*.ts` | move; filename = tool name on both sides. Rewrite each file's export to this package's `tool()` (name, description, `effect`, `schema` input, `execute`) |
| `agent/skills/*.md` | `.agents/skills/<name>/SKILL.md` | move each file into matching directory; canonical Agent Skills loader validates YAML frontmatter and serves bodies/resources through `load_skill` |
| `agent/skills/*.ts` | — | no TypeScript skills here; a procedural skill becomes a tool in `tools/` |
| `agent/subagents/<name>/` | `subagents/<name>/` | move; same nested-directory idea, each with its own `instructions.md` |
| `agent/agent.ts` | `agent.ts` | rewrite, not move — both conventions have this file but the shapes differ. Here it exports an `AgentDirConfig`: `model` (`"provider/model"`), optional `budget` (`maxUsd` or `maxTokens`), optional `breakers`, optional `context` |
| `agent/sandbox/` | `sandbox/sandbox.ts` | rewrite against this package's three sandbox modes; eve's sandbox rides Vercel Sandbox |
| `agent/channels/` | none | **no v1 equivalent.** Channels (HTTP/Slack/Discord) are v2 scope here. Until then the entry point is your own code calling `run()` — see `run.ts` in the scaffold |
| `agent/schedules/` | none | **no v1 equivalent.** Schedules are v2 scope; use your own cron in the meantime |
| `agent/connections/` | none | **not supported.** Connections ride Vercel Connect credentials, which this runtime does not use; tools read provider keys from an explicit env allow-list instead |
| `agent/hooks/` | none | no equivalent; lifecycle behavior belongs in your calling code |
| eve durable execution | none in v1 | runs here are plain by default; durable execution is an open design question, not a shipped toggle |

## The move

1. Move the mapped files (table above) into a fresh directory — flat, no
   `agent/` nesting. Add a `package.json` depending on `@caveman-ai/agent`,
   a `caveman.config.ts` (`defineBuild({ entry: ".", evals: "evals/*.eval.ts" })`),
   and rewrite `agent.ts` as an `AgentDirConfig`. The fastest reference for
   all three is a scaffold sitting next to your real agent:
   `npm create @caveman-ai/agent@latest reference-bot`.
2. Then the two commands:

```bash
caveman-agent doctor   # names anything still missing, spends nothing
caveman-agent dev      # first turn ends with the receipt
```

## What you gain, what you lose

Gain: the end-of-run receipt (cost as a public-catalog list-price subtotal,
warm reads provider-reported, the cold counterfactual labeled `inferred`),
enforced run budgets and breakers, and `caveman-agent build` — the eval-gated
build that fails when a change would break provider-cache economics.

Lose, today: channels, schedules, connections, hooks, and durable execution.
If your agent's value lives in its Slack channel or its cron schedule, keep
it on eve — wire Caveman in where a run's cost matters, and revisit when v2
lands those surfaces.

No savings figures appear on this page on purpose: local evidence is
`inferred` at best, and nothing is claimed that has not been measured on your
own traffic.
