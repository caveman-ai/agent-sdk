# Support desk

One customer-support agent that uses the whole runtime: read tools, lazily
loaded policy skills, a reviewer subagent on its own wallet, memory across
sessions, a USD budget with compaction, loop breakers, durable replay,
streaming, an HTTP session server, and a receipt for every run. Paste one
provider key and run it.

## Run it

From the repository root, once:

```bash
npm ci
npm --prefix packages/agent run build
```

Then in this directory:

```bash
cp .env.example .env        # paste ANTHROPIC_API_KEY (or OPENAI_API_KEY)
npm run ticket -- tickets/refund-request.md
```

The reply prints after the receipt. The receipt is the product: calls by
model, provider-reported cache reads and writes, the list-price cost, the
inferred cold estimate, and how much of the per-ticket budget remains. Run
the same command again and it returns in milliseconds: the run id is derived
from the agent definition and the ticket bytes, so an unchanged ticket
replays its journal and spends nothing. Edit either and it is a new run.

## The efficiency demo

```bash
npm run demo
```

Runs every ticket in `tickets/` through the same agent and prints one table:

```text
ticket                calls  warm read   cache write       cost  cold est.  tools
angry-escalation.md   2      0           4,412          $0.0212    $0.0175    lookup_order
order-status.md       2      4,412       0              $0.0081    $0.0176    lookup_order
refund-request.md     4      13,236      0              $0.0134    $0.0431    lookup_order load_skill refund_reviewer
shipping-late.md      3      8,824       0              $0.0097    $0.0299    lookup_order load_skill
```

Illustrative numbers. The first ticket pays to write the static prefix
(instructions, skills index, tool schemas) into the provider cache; every
later ticket reads it warm, and the difference between `cost` and
`cold est.` grows with every ticket that shares the prefix. `cost` is an
estimated public-catalog list-price subtotal, never an invoice. `cold est.`
is inferred: the same calls priced with no cache read or write. No savings
figure is claimed anywhere.

After the table the demo replays the first ticket by run id and shows the
journaled result returning without a provider call.

Caching needs a prefix above the provider's minimum, which is why
`.env.example` pins Sonnet (1,024 tokens) rather than Haiku 4.5 (4,096). If
the demo reports no cache activity it names the model's minimum.

## Chat

```bash
npm run chat
```

Streaming, multi-turn, memory on. Say something durable about yourself
("call me Mo, and email me, never phone") and the agent stores it with the
memory tool. Start a new chat session later and it comes back: passive
recall starts during a turn and enters the next one, so it never blocks the
one in progress. Recalled facts are marked possibly stale and never enter
the permanent conversation history. Memory refuses anything that looks like
a secret before it is stored.

## Serve

```bash
npm run serve
```

The same agent behind HTTP sessions, journaled to SQLite through
`node:sqlite`. A session owns one conversation and one run controller: a
message sent during a run queues onto it, and every client attached to the
session sees the same event stream. The banner prints the four `curl`
commands. `CAVE_SERVE_TOKEN` must be 16+ characters because the endpoint
spends money; there is no unauthenticated mode.

## Where each feature lives

| Feature | File |
| --- | --- |
| `agent()`, `tool()` with declared effects, `subagent()` with a USD wallet, `memory()` | `src/agent.ts` |
| Skills loaded on demand through `load_skill` | `.agents/skills/*/SKILL.md`, applied in `src/agent.ts` |
| Budget, breakers, deadline, memory engine | `src/options.ts` |
| Durable run with a derived idempotency key, receipt print | `src/ticket.ts` |
| Batch economics, cold estimate from the public catalog, durable replay | `src/demo.ts` |
| `stream()` events, `createConversation()` | `src/chat.ts` |
| `createAgentServer()` over `SqlDurableStore` | `src/serve.ts` |
| Deterministic proof of all of the above | `tests/support-desk.test.ts` |

## Tests

```bash
npm test
```

No network and no key. Provider calls are answered by `scriptedStream` from
`@caveman-ai/agent/testing`; everything else is real: the tools, the
subagent runner and its wallet, the budget meter, the breakers, the journal,
the memory engine, and the session server. The tests prove a refund ticket
runs lookup, skill, and reviewer on one receipt; a USD budget over an
unpriced model fails closed before any call; a repeated lookup trips the
loop breaker; a durable run replays without spending; a remembered fact
enters the next turn and never the permanent history; and the session server
requires a bearer, journals per session, and fans the turn out over SSE.

## Boundaries

- `sandbox: "host"` is declared on purpose. Tool closures run in this
  process with real host access. That is uncontained host execution, not
  isolation, and it is the documented posture for interactive agents. It is
  also why this example has no build lock: host mode anywhere in the graph is
  lock-ineligible. For the eval-gated `caveman-agent build` path, scaffold
  the `support-bot` template from `@caveman-ai/create-agent`.
- The agent reads. It cannot issue refunds, change orders, or contact
  anyone. The reviewer subagent is a second opinion, not an approval system.
- Journals and memory files under `.caveman/` contain customer text. They
  are written with private file modes; production needs its own retention
  and access controls.
- Every dollar figure is a public-catalog list-price estimate. The cold
  estimate is a counterfactual and is labelled inferred. Nothing here
  verifies savings.
