# CLAUDE.md

## Repo overview

- Monorepo for the open-source Caveman Agent SDK.
- Main products:
  - `@caveman-ai/agent`: core runtime/compiler/build system for portable, eval-gated agents.
  - `@caveman-ai/adapter-kit`: fail-closed adapter manifest + registry contract.
  - `@caveman-ai/coding-agent`: interactive coding agent and `caveman-code` CLI.
  - `@caveman-ai/create-agent`: zero-runtime-dependency project scaffold.
  - `@caveman-ai/react`: `useAgent` hook over the agent server's SSE stream.
  - `@pebble-agent/protocol`: frozen Apache-2.0 Pebble wire/session protocol.
- Also contains framework adapters under `packages/adapters/*` and an example coding agent under `examples/coding-agent`.
- This repo must not absorb proprietary Pebble runtime/session/TUI implementation; only the public protocol belongs here.

## Stack

- Language: TypeScript / ESM-first Node packages, plus a few plain JS files.
- Package manager: `npm` workspaces.
- Required Node: `>=22.19.0` for most packages; Eve adapter requires Node `>=24`.
- Testing: `node --test` plus TypeScript compile checks.

## Workspace layout

- `packages/agent`: core runtime, compiler, budgeting, receipts, durability, compaction/memory APIs, plugin/skill discovery, CLI.
- `packages/adapter-kit`: framework-neutral adapter manifest schema and registry.
- `packages/adapters/*`: exact-pinned adapters for Pi, Claude Agent SDK, Vercel AI SDK, Eve, Mastra.
- `packages/coding-agent`: coding-agent package + CLI.
- `packages/create-caveman-agent`: initializer templates and CLI.
- `packages/react`: browser client for `@caveman-ai/agent/serve`; peer-depends on React, never holds the server token.
- `packages/pebble-protocol`: frozen JSONL framing, turn events, ACP mapping, session entry contract.
- `packages/shared`: shared contracts/provider catalog snapshot used by generation/verification.
- `examples/coding-agent`: runnable example built on `@caveman-ai/coding-agent`.
- `scripts/`: repo checks like catalog generation, licensing lint, pack verification, package type checks.
- `docs/MONOREPO.md`: canonical package boundary and dependency-direction rules.
- `AGENTS.md`: repo-specific invariants and release/honesty constraints.

## Non-negotiable repo rules

Follow these even if a local change seems harmless:

- Savings stay **inferred** locally; never claim verified savings or invent savings percentages.
- Unknown model/pricing/usage/grader/runtime/sandbox state must fail closed or remain explicitly unknown.
- Observe-only paths must never claim optimization.
- Host sandbox means host execution, not real isolation.
- Tool/subprocess environments must use explicit allowlists, never ambient secret inheritance.
- Generated `packages/agent/src/catalog.ts` changes only via:
  - `node scripts/generate-agent-catalog.mjs`
- Optional Agent Skills / plugin compatibility lives in one place:
  - `packages/agent/src/agent-environment.ts`
  - core runtime never discovers workspace files automatically
  - wrappers may add roots, but must not fork validation/precedence/invocation behavior.
- Never rebuild what exact-pinned Pi already provides (tool loop, `beforeToolCall`/`afterToolCall`/`finishTurn`/`prepareRequest`/`transformContext`, steering and follow-up queues, event stream). Check `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` before adding a runtime capability. Consuming a Pi hook to enforce an invariant Pi lacks (budget, breakers, deadlines, durability) is the product; re-exposing Pi's surface under a Caveman name is duplication and is refused.
- Agent Plugins v1 / OpenPlugin support is declarative-only; do not add execution for MCP/hooks/custom agents. Executable integrations stay host-owned and require separate environment-allowlist and lifecycle contracts.
- `@pebble-agent/protocol` is frozen and byte-sensitive. Be careful with event shapes, framing, ordering, enums, and fixtures.

## Common commands

Run from repo root unless noted.

### Install

```bash
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
```

### Main verification

```bash
npm test
npm run license:check
npm run pack:check
```

`npm test` includes two ratchets that fail until you shrink or deliberately
re-baseline: `check:api` (published export surface of `@caveman-ai/agent`, golden
file `packages/agent/api-surface.txt`, re-baseline with `npm run api:update`) and
`check:size` (source line-count caps in `size-budget.json`, re-baseline with
`node scripts/size-budget.mjs --update`). Re-baselining is a reviewed diff, not a
routine step. `npm run check:drift` reports moved upstream pins; it needs network
and runs weekly in CI, not in `npm test`.

### Build

```bash
npm run build
```

Root build currently builds:

- `packages/pebble-protocol`
- `packages/agent`
- `packages/create-caveman-agent`

### Useful package-level commands

```bash
npm --prefix packages/agent run build
npm --prefix packages/agent test
npm --prefix packages/pebble-protocol test
npm --prefix packages/create-caveman-agent test
node --test packages/adapter-kit/tests/*.test.mjs
npm run test:adapters
npm run test:conformance-candidates
node --test packages/coding-agent/tests/*.test.mjs
node scripts/typecheck-packages.mjs
```

## How to work safely here

- Read package boundaries before cross-package refactors: `docs/MONOREPO.md`.
- Prefer the smallest change that respects the fail-closed and honesty contracts.
- Verify changes with the narrowest relevant command first; run broader root tests when the change spans boundaries.
- Do not edit generated artifacts casually; regenerate them with the owning script.
- Be careful around golden/fixture-driven packages, especially protocol and receipt/output formatting.
- When touching coding-agent behavior, remember the example in `examples/coding-agent` is part of the public story and has tests.
- When touching package exports/types, check packability and type tests because this repo publishes multiple packages.

## High-signal files to read first

- Root `README.md`: product story, build/receipt/budget model, package map.
- `AGENTS.md`: hard constraints and required checks.
- `docs/MONOREPO.md`: ownership and dependency direction.
- `packages/agent/README.md`: core package semantics and cave/observe-only/build behavior.
- `packages/agent/SANDBOX_THREAT_MODEL.md`: sandbox/security boundary for agent tooling.
- `packages/pebble-protocol/README.md`: frozen protocol guarantees and framing hazards.
- `examples/coding-agent/README.md`: expected coding-agent UX and honesty language.

## Notes for future agents

- There are extra directories under `packages/` not listed in root workspaces (for example `pebble`, `pebble-sessions`, `pebble-tui`, `libpebble`, `shared`). Treat them as supporting/internal material unless the task clearly requires them.
- macOS restricted-tool tests may depend on `sandbox-exec` and loopback permissions.
- Root `npm test` includes license, catalog, protocol, evals, adapter-kit,
  adapter-conformance, coding-agent, package-type, agent, adapters,
  conformance-candidate reproduction, create-agent, and example coverage.

<!-- caveman-blocks:start -->
@.blocks/INDEX.md
<!-- caveman-blocks:end -->
