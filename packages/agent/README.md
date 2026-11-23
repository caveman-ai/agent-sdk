# @caveman-ai/agent-sdk

Spawn Caveman agents from code. They run on this machine through the Caveman runtime, or on Caveman Cloud with
the same calls. Design record: `docs/`.

Private until publishing is switched on. MIT; the harness is not in this package, it is the closed runtime the
SDK starts (`caveman-runtime agent exec`).

```ts
import { Caveman, tool } from "@caveman-ai/agent-sdk"

const cave = new Caveman()                                    // this machine
// const cave = new Caveman({ apiKey: process.env.CAVEMAN_API_KEY })   // Caveman Cloud (a code:run key)

const lookupInvoice = tool("lookup_invoice", "Find an invoice by id",
  { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async ({ id }: { id: string }) => db.invoices.get(id))      // runs in this process

const { text, usage } = await cave.run({
  agent: { name: "billing", instructions: "You answer billing questions.", tools: [lookupInvoice] },
  task: "Customer 4411 says they were charged twice",
  model: "fast",
})
```

## Efficient by construction

- **Every lever on.** Sessions run the engine the benchmark measures, with nothing to tune.
- **Lean agents.** An agent defined in code gets only the tools you give it (`computer: "none"`): its instructions
  are the system prompt, with no coding prompt and no shell or file tools in every request. Give it
  `computer: "full"` (or `"readonly"`) for the coding engine on `cwd`.
- **One prefix per agent.** The same definition writes the same agent file bytes, so every session after the
  first reads its prefix from the cache.
- **Cheap first, then up only when needed.**
  ```ts
  await cave.run({ agent: "builder", task: "Fix the flaky test", model: "fast",
                   check: "pnpm test", escalate: ["base", "frontier"], budget: { usd: 2 } })
  ```
  A failed check tries again on the next model, told what the check said. `check` may be a function:
  `true` passes, text fails and says why.
- **Budgets stop the work**, and every result says what it cost (`usage`, summed over attempts).

## Sessions

```ts
const session = await cave.sessions.create({ agent: "builder", task: "Start on #412", cwd: "." })
const following = (async () => {
  for await (const event of session.events()) console.log(event.type, event.data)   // replays, then follows
})()
const first = await session.next()            // the task's turn
const reply = await session.send("Also update the changelog")
await session.interrupt()
const result = await session.close()
await following
```

`events()` returns only when the session has ended, so follow it alongside the calls that drive the session: a
loop awaited before them waits for a `close()` that never comes.

Asks are answered for you: custom tools by their handlers, approvals by `canUseTool` (denied without it),
questions by `onQuestion` (without it the agent is told to decide and say what it assumed). On this machine,
`access` says which calls stop for `canUseTool`: `full` none (the default without `canUseTool`), `auto` commands
and outside tools (the default with it), `ask` file edits too.

## Systems of agents

```ts
const run = await cave.automations.run("issue-to-pr", { inputs: { issue: "412" } })
run.passed; run.steps; run.pull_requests; run.cost_usd
```

An automation file (`.caveman/automations/<name>.yaml`) runs its steps, checks and escalation ladder to the
end. On this machine the running Caveman Code runs it from the files as they are (the repository must be one of
its projects); on Cloud, pass `repo` and it runs the revision `caveman-runtime apply` sent.

## Where it runs

| | This machine | Caveman Cloud |
|---|---|---|
| Start | `new Caveman()` | `new Caveman({ apiKey })` |
| Model | `model: { baseUrl, apiKey }`, else `CAVEMAN_MODEL_BASE_URL` + `CAVEMAN_MODEL_API_KEY`, else `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` | the organization's |
| Where | `cwd` (default the current directory) | `repo: "owner/name"` on its own computer |
| Agents | `.caveman/agents/<name>.md` in `cwd`, or defined in code | published agents by name or id, or defined in code (published as a new version only when changed) |
| Checks | a command or a function | a function |
| Runtime | `runtime`, else `CAVEMAN_RUNTIME`, else `caveman-runtime` on PATH | none needed |

The model key reaches the runtime in an owner-only file it reads once and deletes (`CAVEMAN_MODEL_API_KEY_FILE`),
never in an environment, where any process of the same user could read it back; the variable the SDK read it from
is not passed on.
