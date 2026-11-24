# Contributing to Caveman Agents

Thank you for contributing to `caveman-ai/agent-sdk`. Read [`AGENTS.md`](AGENTS.md)
for package boundaries and core invariants before opening a pull request.

## Prerequisites

- Node.js 24+
- pnpm 10.14+
- Python 3.13+ (for `python/caveman-evals`)

## Development & checks

```bash
pnpm install
pnpm build
pnpm test
```

## Guidelines

- Preserve deterministic `AGENT.md` -> `agent.json` builds, byte-stable cache prefixes, and exit codes `0..6`.
- Keep unknown eval grader types fail-closed and preserve TypeScript/Python parity.
- Include unit tests for behavioral changes and update `docs/` when changing public APIs.
- Use scoped conventional commits (`feat(harness): ...`, `fix(evals): ...`).
- Report security vulnerabilities privately per [`SECURITY.md`](SECURITY.md).
