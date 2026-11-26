# Caveman Agents (`caveman-ai/agent-sdk`)

Public open-source repository for the Caveman Agent SDK (`@caveman-ai/agent`),
Harness v4 (`@caveman-ai/harness`), Session Protocol (`@caveman-ai/protocol`),
Eval graders (`@caveman-ai/evals`, `python/caveman-evals`), React hooks
(`@caveman-ai/react`), adapter kit (`@caveman-ai/adapter-kit`), and project
scaffolder (`@caveman-ai/create-agent`).

`CLAUDE.md` is a symlink to this file.

## Ecosystem ownership (where each piece of work lives)

- **This repo (`caveman-ai/agent-sdk`):** Optional TypeScript agent authoring framework, Harness v4 engine (`@caveman-ai/agent`, `@caveman-ai/harness`), Session Protocol (`@caveman-ai/protocol`), and local graders (`@caveman-ai/evals`). Compiles to the open `AGENT.md` / `agent.json` Cloud build format. Never duplicate Cloud platform clients here.
- **`caveman-ai/cloud-sdk`:** Unified Cloud Platform SDK (`@caveman-ai/sdk` + `./app-bridge`, `caveman-sdk`, `sdk-go`), `cvm` CLI, `caveman-drive-mount`, sanitized OpenAPI contracts, and public Cloud skills.
- **`JuliusBrussee/caveman-docs`:** Public documentation site (`docs.caveman.so`).
- **`JuliusBrussee/caveman`:** Accountless local CLI, Go engine/proxy, `cavemem`, and `caveman-shrink`.
- **`caveman-ai/caveman-code`:** Desktop, web, mobile, and terminal coding agent.

## Layout

| Path | Package | License | Role |
|---|---|---|---|
| `packages/agent/` | `@caveman-ai/agent` | Apache-2.0 | High-level SDK: `defineAgent`, `tool`, `runInProcess`, `Caveman`, `Session`, deterministic `AGENT.md` -> `agent.json` compiler |
| `packages/harness/` | `@caveman-ai/harness` | Apache-2.0 | Harness v4 loadout-driven loop (`HarnessSession`, `LocalEnv`, `DockerEnv`, `SandboxEnv`, MCP allowlist, `compact`/`exec`/`program`) |
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
