# Examples

Runnable, self-contained TypeScript recipes verified offline in CI (`pnpm test`).

## Starter recipes (`examples/basics/`)

| # | Recipe | What it teaches |
| --- | --- | --- |
| 01 | [`basics/01-hello-agent.ts`](basics/01-hello-agent.ts) | `defineAgent()`, `tool()`, and `runInProcess()` |
| 02 | [`basics/02-tools-and-gates.ts`](basics/02-tools-and-gates.ts) | Fail-closed **Caveman Gate** approvals (`approve` vs `deny`) on sensitive tools |
| 03 | [`basics/03-harness-v4-session.ts`](basics/03-harness-v4-session.ts) | Open-source **Harness v4** (`@caveman-ai/agent/harness`): `HarnessSession`, `appLoadoutFor`, `LocalEnv`, `toHarnessTool`, and `beforeCall` hooks |
| 04 | [`basics/04-deterministic-build.ts`](basics/04-deterministic-build.ts) | Byte-stable `AGENT.md` + SHA-256 build compilation via `compileAgentDefinition()` |
| 05 | [`basics/05-evals-and-graders.ts`](basics/05-evals-and-graders.ts) | Deterministic agent grading with `@caveman-ai/evals` |

## Run tests offline (no API key)

From the repository root:

```bash
pnpm install
pnpm build
pnpm test:examples
```
