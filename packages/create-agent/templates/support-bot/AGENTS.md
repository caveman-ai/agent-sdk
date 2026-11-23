# For coding agents working on this project

This is a Caveman agent directory. The layout IS the API — files in the
right place are picked up by the build; there is no registration step.

## The convention

| Path | What it is | Rules |
|---|---|---|
| `instructions.md` | The agent's standing prose | Static by construction. Never put dates, ids, counters, or anything run-varying here — a volatile frozen prefix is a build failure. |
| `agent.ts` | Behavior config | Default export `satisfies AgentDirConfig`: model, budget, breakers, and optional `context` — extra prefix segments as a name→value map. Context entries default to `stability: "build"` (frozen prefix, cached); the volatile-prefix check catches run-varying ones at build time. Declare `stability: "turn"` for values that belong in the live zone. The agent id is derived from the directory name, slugified to `[a-z0-9][a-z0-9_-]*` — rename the directory, rename the agent. |
| `tools/<name>.ts` | One tool per file | Filename = tool name. Default export must be `tool({...})` with an honest `effect` (`"read"`, `"write"`, `"idempotent"`, `"external"`). The default sandbox denies network to tool code but does NOT make write-effect tools inert — declare effects truthfully. This scaffold uses only a read tool and never claims to mutate orders. |
| `.agents/skills/<name>/SKILL.md` | Relevance-loaded playbooks | Agent Skills YAML frontmatter with matching `name` and concise `description`, then body. Metadata lives in cached prefix; `load_skill` reads full body or contained resources on demand. |
| `evals/*.eval.ts` | The build gate | `defineEval({...})` fixtures with `split: "profile"` / `"development"` / `"holdout"` and graders (`contains`, `not_contains`, `tool_called`, `exact_match`, `json_schema`). Invoking build runs every declared eval; holdout opens only after selection. |
| `subagents/<name>/` | Nested agent directory | Same convention, one level down. Budget wallets and depth caps apply. |

## How to add things

- **New tool:** create `tools/my_tool.ts`, default-export `tool()`. Prefer
  `effect: "read"`. Done — no imports to wire.
- **New skill:** create `.agents/skills/my-topic/SKILL.md` with frontmatter
  `name: my-topic` + concise `description`. Description is what model
  sees when deciding to load it — write it like a good tooltip.
- **New eval:** add a fixture to `evals/`. New behavior without an eval
  is unfinished; the eval is what lets the build defend the behavior.

## What breaks the build (on purpose)

Static checks run before model-backed evals, so these fail fast without spend:

- A build-stable context segment whose bytes change between build
  passes (a computed date, a counter) — volatile frozen prefix.
- A change that shrinks the cacheable prefix or regresses warm-read
  cost, even when raw token count went down.
- A frozen prefix below the provider's minimum cacheable length —
  a lock over a cache that will never exist.
- A dollar budget with a model the public catalog cannot price.
- Host-sandbox mode with a lock request.

Then eval execution: failing any declared eval fails the build.

Run `npm run build` to check all of this locally; failures explain
themselves in plain words first (add `--verbose` for wire codes).

## Money words (do not soften these)

Costs printed by this project are estimated public-catalog list-price
subtotals, never invoices. Cold-run comparisons are labeled `inferred`.
Never write the word "saved" into receipts, docs, or copy — the
framework does not claim savings it has not verified.
