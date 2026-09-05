# Investigator

One production-agent investigator built the way Lucy and Bugbot are: a bash
toolset that operates a CLI, a skill that teaches the CLI, a typed output
schema, a tool policy that turns a grant into per-call authorization outside
the model, and durable sessions whose messages carry the page the user was
looking at. Paste one provider key and ask it a question.

The `caveman cloud` CLI here is a stand-in (`bin/caveman`) answering from
`data/traces.json` with the real CLI's envelope and exit codes. Nothing in this
example talks to Caveman Cloud.

## Run it

From the repository root, once:

```bash
npm ci
npm --prefix packages/agent run build
```

Then in this directory:

```bash
cp .env.example .env            # paste ANTHROPIC_API_KEY (or OPENAI_API_KEY)
npm run investigate -- "Did support-desk get worse between 2026-09-01 and 2026-09-05? Catch it next time."
```

The agent searches failing and succeeding traces for the window, attributes
the change to a deployment, confirms the mechanism from a transcript, drafts an
evaluator, and returns one JSON finding. With `INVESTIGATOR_GRANT=read` (the
default) the activation step is **denied before it runs**: the model reads
`cave_tool_denied:grant_scope`, the receipt counts it, and the finding still
comes back. Set `INVESTIGATOR_GRANT=read,write_resource` to let it activate.

## Serve

```bash
npm run serve
```

The same agent behind durable HTTP sessions. `authenticate` maps a request to
a principal, and the per-run options factory maps that principal to a grant,
so `x-tenant: acme` may activate evaluators and `x-tenant: globex` may only
read. The banner prints the curl commands, including a message with
`context`: the agent, window, and resource ids a page was showing.

## Where each piece lives

| Piece | File |
| --- | --- |
| `shellTools({ tools: ["bash", "read_file"] })` over an `ExecutionBackend`, the typed `activate_evaluator` tool, `output({ schema })` | `src/agent.ts` |
| Grant → `ToolCallPolicy`: shell allowlist, compound-command refusal, `write` needs `write_resource` | `src/policy.ts` |
| Budget, breakers, deadline, tool-call ceiling | `src/options.ts` |
| Session server with `authenticate` and a principal-aware `runOptions` factory | `src/serve.ts` |
| The skill that teaches the CLI | `.agents/skills/caveman-cloud/SKILL.md` |
| The stand-in CLI and its envelope | `bin/caveman` |
| Deterministic proof of all of the above | `tests/investigator.test.ts` |

## Tests

```bash
npm test
```

No network and no key. Provider turns are scripted; the bash tool, the CLI,
the policy, the output schema, the journal, and the session server are real.
The tests prove the envelope comes back through bash and parses, a shell
command outside the allowlist never runs, activation is denied without the
grant and validated with it, a durable run replays its typed output without
spending, and a session message's context reaches the model while a read-only
tenant's denial is visible on the event stream.

## Boundaries

- `sandbox: "host"`: tool closures run in this process. That is uncontained
  host execution, not isolation. Pass `investigator({ backend })` an
  `httpExecutionBackend` to run bash somewhere else.
- The policy is the authorization boundary for what the model asks; it is not
  a sandbox for what an allowed command does.
- Every dollar figure is a public-catalog list-price estimate. Nothing here
  verifies savings, and `activate_evaluator` reports `awaiting_traffic` because
  nothing has scored.
