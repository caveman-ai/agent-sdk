# Changelog

One changelog for the whole monorepo. Seventeen per-package files would be a
treadmill nobody walks; entries name the package they affect instead.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning policy and what counts as breaking: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Changed

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
