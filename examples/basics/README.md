# Basics — 5 single-file agent recipes

Start here. Each file is 30–65 lines of idiomatic TypeScript showing one core capability of `@caveman-ai/agent`, `@caveman-ai/agent/harness`, and `@caveman-ai/evals`.

| # | File | What you learn | Run |
| --- | --- | --- | --- |
| 01 | [`01-hello-agent.ts`](01-hello-agent.ts) | `defineAgent()`, `tool()`, and `runInProcess()` | `node --experimental-strip-types examples/basics/01-hello-agent.ts` |
| 02 | [`02-tools-and-gates.ts`](02-tools-and-gates.ts) | Fail-closed **Caveman Gate** approvals (`approve` / `deny`) | `node --experimental-strip-types examples/basics/02-tools-and-gates.ts` |
| 03 | [`03-harness-v4-session.ts`](03-harness-v4-session.ts) | Direct **Caveman Harness** `HarnessSession`, `appLoadoutFor`, `LocalEnv`, `toHarnessTool`, and `beforeCall` hooks | `node --experimental-strip-types examples/basics/03-harness-v4-session.ts` |
| 04 | [`04-deterministic-build.ts`](04-deterministic-build.ts) | Byte-stable `AGENT.md` + SHA-256 manifest compilation | `node --experimental-strip-types examples/basics/04-deterministic-build.ts` |
| 05 | [`05-evals-and-graders.ts`](05-evals-and-graders.ts) | Deterministic grading with `@caveman-ai/evals` | `node --experimental-strip-types examples/basics/05-evals-and-graders.ts` |

## Setup

From the repository root:

```bash
pnpm install
pnpm build
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY + CAVE_MODEL=openai/gpt-5.4
node --experimental-strip-types examples/basics/01-hello-agent.ts
```

## Offline tests (no API key)

```bash
pnpm test:examples
```

Runs all 5 recipes end to end against a scripted stream — real tools, real Caveman Gates, real Caveman Harness `LocalEnv` commands, real SHA-256 builds, and real `@caveman-ai/evals` graders with zero network.
