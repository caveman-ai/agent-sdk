# Changelog

One changelog for the whole monorepo. Seventeen per-package files would be a
treadmill nobody walks; entries name the package they affect instead.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning policy and what counts as breaking: [docs/RELEASING.md](docs/RELEASING.md).

## [Unreleased]

### Changed

- `@caveman-ai/agent`: split `src/runtime.ts` — gateway discovery/startup moved
  to `src/gateway.ts`, the sandbox credential allowlist to
  `src/sandbox-credentials.ts`. Both are re-exported from `runtime.js`, so no
  import path or published export changed.

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

[Unreleased]: https://github.com/caveman-ai/agent-sdk/compare/main...HEAD
