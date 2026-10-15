# Changelog

One changelog for the whole monorepo. Seventeen per-package files would be a
treadmill nobody walks; entries name the package they affect instead.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning policy and what counts as breaking: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Changed

- `@caveman-ai/agent` coding agent, for long autonomous runs: the output cap
  per call is 32,000 tokens (was 8,000, which cut off long reasoning or file
  writes and ended the run); bash's hard timeout is 600 s (was 120 s); the
  instructions name the workspace path and ask for terse progress instead of
  "say what you changed and why"; `write_file` creates parent directories; a
  `<cave-output>` line is sent only when an output schema exists. Coding
  sessions allow 1,000 model calls and 4,000 tool calls per run (the run
  default of 64 ended long tasks); bash exit 127 is returned as output, not
  reported as a missing shell.
- Coding breakers: a successful write or external call (an edit, a command)
  resets the repeat window of every other call, so re-running the same test
  after an edit is progress, not a loop. Identical calls with nothing in
  between still trip.
- `shellTools({ fileRoot })` / `createCodingAgent({ fileRoot })`: file tools
  may reach a directory wider than the workspace (for example `/` inside a
  disposable container); relative paths still resolve against the workspace.

- SDK onboarding now starts with a complete source-checkout example, then adds
  tools, streaming, conversations, and budgets. Advanced guides remain linked;
  installation, gateway behavior, and durability limits are explicit.
- `@caveman-ai/create-agent`: generated projects include Node types, credential
  setup and readiness checks. Help and install failures give actionable next
  steps without guessing publication status or promising cache savings.
- `pack:check` validates every published JavaScript/type entry point and CLI
  against the packed files and prints one summary per package.
- Adapter tests use npm workspace selection instead of a POSIX shell loop.
- `@caveman-ai/agent`: split `src/runtime.ts` — gateway discovery/startup moved
  to `src/gateway.ts`, the sandbox credential allowlist to
  `src/sandbox-credentials.ts`. Both are re-exported from `runtime.js`, so no
  import path or published export changed.

### Fixed

- `@caveman-ai/agent`: a `cave_retrieve` result is no longer compressed again
  by the plan, so the model gets the detail it asked for. The coding plan's
  reasoning budget is run-wide 4,000,000 tokens (was 64,000, which a long run
  passes and which then stopped the run).
- `@caveman-ai/agent` compaction (budgeted too) on a real provider payload: the
  request after a compaction opens a new cache epoch. The prefix guard used to
  "restore" it to the pre-compaction messages, so the summary never reached
  the provider. Evicted messages carry a fresh timestamp, so pi-ai stops sizing
  the summary call from the pre-eviction usage and clamping its output to 16
  tokens.
- `@caveman-ai/agent`: structured-output runs stopped by budgets or breakers
  return partial results and receipts without parsing tool-turn text as JSON.
- `@caveman-ai/agent`: queued steering and follow-up messages track actual Pi
  delivery instead of assuming every tool turn consumes a queued message.
- `caveman-agent serve`: flag values are no longer mistaken for agent
  directories. Invalid, duplicate, and missing options fail before loading
  user code; subcommands expose help without requiring project setup.
- `@caveman-ai/create-agent`: preserve existing and dangling-symlink targets,
  recheck targets after installation, and quote generated shell paths.

### Added

- `cave: "local"` (runs and coding sessions): apply the efficiency plan in
  process with the local `caveman-engine` and no gateway. Tool results and
  history are compressed with recovery through `cave_retrieve`; the run still
  reports `mode: "observe-only"` because no gateway measured it. A coding
  session in `local` mode stays optimized instead of degrading.
- Keep (trim-1): plan transforms pass the newest user message as the engine's
  `--query`, so query-aware line selection runs. Without a query it never did.
- `run({ turnRetry })`: Pi's turn retry. A transient provider error turn,
  mid-stream or before it, is dropped from the context and the loop continues
  after 2 s, 4 s, 8 s (3 retries, capped at 60 s); a success starts a fresh
  series. The failed attempt stays in the receipt as its own call (usage
  `unavailable` when the stream reported none, which marks the run's totals
  incomplete), so nothing is charged twice. Off by default; coding sessions
  turn it on.
- `run({ compaction })`: window compaction without a budget. When the
  provider-reported prompt plus the turn's new messages would leave less than
  `reserveTokens` of the window, older history is summarized; each summary is
  a provider call in the receipt. Requests only append between compactions,
  and a retried turn resends the compacted window. Coding sessions use Pi's
  settings: 16,384 reserved, 20,000 kept verbatim, summary capped at 13,107
  tokens.
- `npm run check:api` — golden file (`packages/agent/api-surface.txt`) over the
  published type surface of `@caveman-ai/agent`. Any added, removed, or renamed
  export is now a reviewed diff instead of a silent breaking change.
- `npm run check:size` — line-count ratchet over source files
  (`size-budget.json`). Growth past a file's recorded budget fails CI.
- `npm run check:drift` plus a weekly `upstream drift` workflow — reports which
  exact-pinned upstreams have moved on the registry.
- Dependabot config covering every workspace and the GitHub Actions used here.
- Release automation: tagging `v<version>` publishes every workspace whose
  version is not yet on the registry.

## [0.2.0] — @caveman-ai/agent

No changelog was kept before this file existed. `0.2.0` of `@caveman-ai/agent`
and `0.1.0` of every other package are the first releases; consult the git
history for what landed in them.

[Unreleased]: https://github.com/JuliusBrussee/agent-sdk/compare/main...HEAD
