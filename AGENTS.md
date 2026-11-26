# Caveman Agents (`caveman-ai/agent-sdk`)

Public open-source repository for the Caveman Agent SDK (`@caveman-ai/agent`),
Caveman Harness (`@caveman-ai/harness`), Session Protocol (`@caveman-ai/protocol`),
Eval graders (`@caveman-ai/evals`, `python/caveman-evals`), React hooks
(`@caveman-ai/react`), adapter kit (`@caveman-ai/adapter-kit`), and project
scaffolder (`@caveman-ai/create-agent`).

`CLAUDE.md` is a symlink to this file.

## Layout

| Path | Package | License | Role |
|---|---|---|---|
| `packages/agent/` | `@caveman-ai/agent` | Apache-2.0 | High-level SDK: `defineAgent`, `tool`, `runInProcess`, `Caveman`, `Session`, deterministic `AGENT.md` -> `agent.json` compiler |
| `packages/harness/` | `@caveman-ai/harness` | Apache-2.0 | Caveman Harness loadout-driven loop (`HarnessSession`, `LocalEnv`, `DockerEnv`, `SandboxEnv`, MCP allowlist, `compact`/`exec`/`program`) |
| `packages/protocol/` | `@caveman-ai/protocol` | MIT | Canonical `SessionEvent`, `UserEvent`, exit codes `0..6`, JSON schemas (`agent-build`, `eval-file`, `grader-registry`) |
| `packages/evals/` | `@caveman-ai/evals` | MIT | 30 fail-closed TypeScript graders (deterministic, BLEU/ROUGE, localization F1, SSRF-pinned webhooks, bias-guarded LLM judges) |
| `packages/react/` | `@caveman-ai/react` | Apache-2.0 | React hooks for streaming agent sessions and approvals |
| `packages/adapter-kit/` | `@caveman-ai/adapter-kit` | Apache-2.0 | Interfaces for adapting external agent frameworks onto `@caveman-ai/protocol` |
| `packages/create-agent/` | `@caveman-ai/create-agent` | Apache-2.0 | Project scaffolder (`npm create @caveman-ai/agent`) |
| `python/caveman-evals/` | `caveman-evals` | MIT | Python eval runner and grader parity package |
| `docs/` | Docs | MIT | Public product docs aggregated into `docs.caveman.so/agent` |

## Checks

```bash
pnpm install
pnpm build
pnpm test
```

## Invariants

- **Public repository.** Never reference private backend paths, internal strategy memos, or credentials.
- **Byte-stable cache prefixes.** Agent builds compile deterministically; skill bodies load lazily on activation; MCP failures must never mutate the cached prefix.
- **Secret isolation.** Subprocesses and stdio MCP servers use an explicit env allowlist (`inheritEnv: false`).
- **Fail-closed graders & pricing.** Unknown grader types fail closed; local/framework counts stay `inferred` and never emit Cloud-verified savings.
- **Durable parking exit codes.** Preserve exit codes `0..6` (`5` waiting, `6` idle) across `@caveman-ai/protocol` and `@caveman-ai/harness`.
- **Scoped conventional commits** (`feat(harness): ...`, `fix(agent): ...`, `docs(repo): ...`).

## Workflow

- Work in a clean branch or worktree off `origin/main`; never commit or push directly to `main`.
- Stage explicit paths (`git commit --only -- <paths>`), never `git add -A`.
- Run `node scripts/check-public-hygiene.mjs`, `pnpm build`, and `pnpm test` before pushing.
- Open a pull request against `main` and squash-merge once `Build & Test` is green.
- Releases run through `.github/workflows/release.yml` on `v*` tags (or manual dispatch on a green `main` commit).
