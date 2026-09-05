# Runnable examples

Examples are acceptance products for SDK contracts. Each owns setup, tests,
runtime entrypoint, threat boundary, and honest live-provider gate.

- `coding-agent`: interactive host coding agent. Existing compatibility sample;
  host execution is not isolation.
- `support-desk`: the runtime end to end on one support agent — read tools,
  on-demand skills, a subagent wallet, memory, USD budget, breakers, durable
  replay, streaming, and the session server. Paste one key; `npm run demo`
  prints the batch economics from provider-reported cache reads.
- `mini-swe`: mini-swe-agent's one-bash-tool design on the kernel, a Docker
  backend, and a SWE-bench batch runner that emits `preds.json` for the official
  harness. No score is claimed here.
- `investigator`: the Lucy/Bugbot shape — `shellTools` bash operating a CLI
  taught by a skill, a grant-driven `toolPolicy`, typed `output`, and sessions
  whose messages carry page `context`; the CLI is a stand-in.
- `support-operations`: implemented enterprise support proposal handoff with
  deterministic HTTP proof.
- `security-incident-triage`: implemented evidence-only incident containment handoff.
- `vendor-risk-review`: implemented evidence-only vendor risk handoff.
- `adapters/*`: exact-pinned runnable lanes for the observability adapters —
  they record lifecycle and usage from a native framework loop and do not run a
  Caveman agent. Pi, Claude Agent SDK, Vercel AI SDK, Eve, and Mastra. Planned.

README presence is not proof; root `npm run test:example` executes every sample
package.
