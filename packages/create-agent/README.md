# `@caveman-ai/create-agent`

Create a TypeScript agent with a working example, tools, and a readiness check.
Requires Node.js 22.19.0 or newer.

This repository is in development. Registry installation depends on the release
being published; use the checkout instructions below until then.

## From a checkout

Build the SDK and initializer from the repository root:

```bash
npm ci
npm run build
sdk_checkout="$PWD"
node packages/create-caveman-agent/dist/index.js ../my-agent --provider anthropic --no-install
cd ../my-agent
npm install "$sdk_checkout/packages/agent"
export ANTHROPIC_API_KEY="<your-api-key>"
npm run doctor
npm run ticket -- tickets/refund-request.md
```

The local install uses the built SDK; it does not require a published version.

## From npm after release

```bash
npm create @caveman-ai/agent@latest my-agent -- --provider anthropic
cd my-agent
export ANTHROPIC_API_KEY="<your-api-key>"
npm run doctor
npm run ticket -- tickets/refund-request.md
```

The initializer installs dependencies by default. It creates the project only
after installation succeeds, and cleans up its temporary files on failure.
Existing directories and symlinks are refused. Credentials are never saved by
the initializer or passed to dependency installation.

## Choose a starter

| Template | First task | Command |
| --- | --- | --- |
| `support-bot` (default) | Answer a sample ticket with a read-only order lookup | `npm run ticket -- tickets/refund-request.md` |
| `background-agent` | Serve coding sessions with durable journals | `npm run dev` |

```bash
npm create @caveman-ai/agent@latest my-agent -- --template background-agent --provider openai
```

The background template needs `CAVE_SERVE_TOKEN` as well as a provider key.
Its coding tools execute on the host unless you configure a remote execution
backend. Host execution is uncontained. Follow the generated README before
sending a coding task.

## Options and credentials

| Option | Meaning |
| --- | --- |
| `--provider anthropic\|openai\|google` | Select a provider explicitly |
| `--template support-bot\|background-agent` | Select a starter |
| `--no-install` | Generate files; manage dependencies yourself |
| `--help` | Show usage and examples |

`--provider=openai` and `--template=background-agent` also work. A single detected
provider key selects its provider automatically. With zero or multiple providers,
interactive terminals prompt; noninteractive callers must pass `--provider`.

| Provider | Environment variable |
| --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |

Export the key in the shell that runs the agent. Generated scripts do not load
`.env` automatically. `npm run doctor` checks readiness without a provider call;
follow any reported setup action before running the agent.

## After the first run

For `support-bot`, edit `instructions.md`, `.agents/skills/`, and `tools/` to
change behavior. Review `evals/support.eval.ts`, then run `npm run build` to
evaluate the declared fixtures within the search budget. Build may make paid
provider calls and may refuse unsupported capability combinations. A generated
project is not an optimized or validated deployment.

Use `npm run typecheck` to check either starter without provider calls. Local
cost estimates and savings remain `inferred`; cache reads do not prove savings.
