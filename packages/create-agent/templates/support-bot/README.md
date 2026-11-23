# Support bot

Answer support tickets using a read-only order lookup, refund and shipping
playbooks, and a local budget per ticket.

## Run your first ticket

Use Node.js 22.19.0 or newer. The initializer installs dependencies unless you
pass `--no-install`; in that case, install them before continuing.

Export the key for the provider you selected:

```bash
export ANTHROPIC_API_KEY="<your-api-key>"  # anthropic
# export OPENAI_API_KEY="<your-api-key>"  # openai
# export GEMINI_API_KEY="<your-api-key>"  # google; GOOGLE_API_KEY also works
npm run doctor
npm run ticket -- tickets/refund-request.md
```

Export only the key you need. The generated `.caveman/provider.json` and
`agent.ts` record your provider and model; neither contains credentials. Scripts
do not load `.env` automatically. Doctor makes no provider call. Follow any
reported readiness fix before running a ticket.

The run prints its response and a receipt. The first run may include a cache
write charge on providers with explicit caching. Try another ticket:

```bash
npm run ticket -- tickets/order-status.md
```

The provider may reuse the static prefix. Inspect provider-reported cache reads
in the receipt: a warm result depends on model support, prefix size, timing, and
provider behavior. Repeating a request does not guarantee a cache hit or a lower
total cost. All figures use estimated public-catalog list prices, not invoices;
the cold estimate and local savings remain `inferred`.

## Change behavior

| File | Purpose |
| --- | --- |
| `instructions.md` | Standing support policy; keep the static prefix stable |
| `agent.ts` | Provider/model, ticket budget, and loop breakers |
| `.agents/skills/` | Refund and shipping playbooks loaded when needed |
| `tools/lookup_order.ts` | Read-only order lookup; no refund or other write action |
| `data/orders.json` | Sample order data |
| `tickets/` | Three sample tickets |
| `evals/support.eval.ts` | Expected behavior for build evaluations |
| `caveman.config.ts` | Build entry, fixture selection, and search budget |

Edit the sample data and policy for your use case, then run
`npm run typecheck`. Read `AGENTS.md` for tool, skill, and eval conventions.

## Evaluate changes

Review the fixtures and the search budget in `caveman.config.ts` before running:

```bash
npm run build
```

Build can make paid provider calls. It validates static inputs and runs the
declared fixtures when the selected execution lane supports the agent. A
`capability_refused` result is a refusal, not an optimized build; follow the
reported reason. After a successful locked build, `npm run check` checks its
recorded inputs before deployment.

Keep dates, ticket ids, and customer names in inputs or tool results. Putting
run-varying values in static config changes prefix bytes and can make static
validation fail before provider spend.
