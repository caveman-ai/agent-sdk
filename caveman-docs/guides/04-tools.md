# Tools

A tool declares its input, its output, its side effect, its timeout, and what
happens to its result. None of those are optional conventions — the compiler,
the sandbox, the budget ladder, and the receipt all read them.

```ts
import { schema, tool } from "@caveman-ai/agent";

const lookupPolicy = tool({
  name: "lookup_policy",
  description: "Read current refund policy.",
  input: schema.object({ region: schema.string() }),
  output: schema.object({
    region: schema.string(),
    refundWindowDays: schema.number(),
  }),
  effect: "read",
  result: "auto",
  async execute({ region }) {
    return { region, refundWindowDays: 14 };
  },
});
```

## Options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `name` | `string` | required | In an agent directory this must equal the filename minus `.ts`. `cave_*` is reserved |
| `description` | `string` | required | Enters the provider-visible tool schema |
| `input` | TypeBox schema or Standard Schema v1 | required | Validated before your code runs |
| `inputJSONSchema` | `TSchema` | — | Required when a Standard input schema cannot emit draft-07 |
| `output` | TypeBox/JSON Schema or Standard Schema v1 | — | Validated after your code, before the result can reach context |
| `outputJSONSchema` | `TSchema` | — | Required when a Standard output schema cannot emit draft-07 |
| `schemaSemanticsSHA256` | `string` | — | Required to lock or durably replay mutable custom validator semantics |
| `effect` | `"read" \| "write" \| "idempotent" \| "external"` | required | Never inferred |
| `result` | `ToolResultPolicy \| ArtifactDefinition` | `"auto"` | See below |
| `allowRepeat` | `boolean` | `false` | Opts out of the repeated-call breaker, for pollers and watchers |
| `speculative` | `boolean` | `false` | Explicit opt-in to kernel-owned streaming speculation. Read tools only |
| `timeoutMs` | `number` | `30000` | Enforced by the kernel, not by your code |
| `nestedTools` | `ToolDefinition[]` | — | Flat, kernel-dispatched tools available only inside a composite tool |
| `speculativeTools` | `string[]` | — | Nested read tools whose already-started result may be consumed |
| `runtime` | `ToolRuntimeDefinition` | — | Set by `subagent()` and `createConnect()`; not hand-written |
| `execute` | `(input, signal?, context?) => …` | required | Receives validated input |

## Effects

| Effect | Meaning | Consequences |
| --- | --- | --- |
| `read` | Observes state, no side effect | Eligible for speculation; blocked-by-default nowhere |
| `write` | Mutates state | Blocked (not executed) under `sandbox: "fixture"`; never speculated |
| `idempotent` | Repeat-safe mutation | Never speculated |
| `external` | Leaves the process boundary | Never speculated; rejected in the Claude lane |

Effect declarations are mandatory in every sandbox mode. `host` changes
enforcement, not declaration.

## Result policies

| Policy | Behavior |
| --- | --- |
| `auto` | A locked plan chooses inline, paging, compression, or exact CCR |
| `inline` | Result stays in the current context |
| `page` | Result is exposed as bounded pages |
| `compress` | Uses an eligible locked transform |
| `exact_ccr` | Replaces the body only after byte-exact recovery is stored |

`result` may also be an `ArtifactDefinition` from `artifact()`, which routes the
value to an artifact instead of the transcript.

## Validation contract

- **Input**: the schema validator runs before your code, including async
  validation and transforms. A mismatch is `cave_tool_input_schema_mismatch`.
- **Output**: validation runs after your code but before any result can enter
  model context or durable settlement. A mismatch becomes a tool error
  (`cave_tool_output_schema_mismatch`) and the raw invalid value stays hidden.
- Declared results serialize from the same immutable validated snapshot and
  ignore prototype `toJSON` hooks.
- Schema-less tools keep native JSON serialization for backward compatibility.
- A result that is not JSON-safe fails with `cave_tool_result_not_json_safe`;
  an oversized one with `cave_tool_result_limit`.

### Mutable validator semantics

Standard Schema validators and TypeBox `format` checks can close over mutable
runtime state. Ordinary runs allow them, but Cave Build locks and durable runs
refuse opaque validator identity (`cave_tool_schema_semantics_unverified`).
Supply `schemaSemanticsSHA256` as the lowercase SHA-256 of the validator code,
its dependencies, and its captured state, and change the digest whenever any
semantic input changes. Receiver-state drift detected after `tool()`
construction fails validation.

## Execution context

```ts
execute(input, signal, context) {
  context.toolCallId;         // provider identity for this exact invocation
  context.parentToolCallId;   // composite parent; equals toolCallId at top level
  context.durable?.idempotencyKey;
  context.durable?.resumed;   // true when safely re-driving an unmatched prior intent
  await context.dispatch("nested_tool", { … });
}
```

`signal` aborts with the run. `context.durable` is present only on durable runs.

## Ceilings and breakers

- `RunOptions.maxToolCalls` (default 64). A call beyond it is blocked — the
  model sees a blocked result rather than the run throwing.
- `timeoutMs` per tool; expiry is `cave_tool_timeout`.
- The repeated-call breaker stops a loop calling the same tool with the same
  arguments; `allowRepeat: true` opts a polling tool out.
- No-progress and fan-out breakers apply on coding turns by default. See
  [Budgets, receipts, and breakers](09-budgets-receipts-breakers.md).

## Shell and file tools

The coding agent's `bash`, `read_file`, `grep`, `write_file`, `edit_file`, and
`read_tool_output` are one builder any agent can compose with its own tools:

```ts
import { agent, auto, httpExecutionBackend, shellTools } from "@caveman-ai/agent";

const investigator = agent({
  id: "investigator",
  instructions,
  model: auto(),
  tools: [
    ...shellTools({
      workspace: "/srv/checkout",
      executionBackend: httpExecutionBackend({ url, token }),   // default: this host
      tools: ["bash", "read_file", "grep"],                        // default: all six
    }),
    searchTraces,
  ],
  sandbox: "host",
});
```

| Option | Default | Notes |
| --- | --- | --- |
| `workspace` | required | Paths are contained to it (realpath-based on the local backend) |
| `executionBackend` | `localExecutionBackend()` | Where processes run and files live. Host execution is not isolation |
| `tools` | all six | Which tools, in order. Selecting `read_tool_output` turns on the recovery store, so capped output gets a handle instead of a dead end |
| `outputCaps` | per tool | Raw byte caps applied before any transform |
| `commandSessions` | none | Interactive bash sessions; local backend only |
| `onOutput` | none | Observes every capped output (label, text) |

`bash` is `effect: "external"` and uncontained by design: its subprocess
environment is a fixed shell/locale allowlist rather than `process.env`, so a
model-driven command cannot read the framework's credentials, but it runs with
the user's privileges. The one-line move to a container is the execution
backend. Pair it with a `toolPolicy` (below) to decide *which* commands may
start; `examples/investigator` does both.

## Authorizing tool calls

Authorization is a decision the host makes outside model output. The kernel
already admits every call through Pi's `beforeToolCall` hook (deadline,
budget, call caps, breakers, sandbox posture, argument shape);
`RunOptions.toolPolicy` is your decision, run after those checks, for every
declared tool call in the run: root, subagent, and nested composite dispatch.
It is the `canUseTool` shape from the Claude Agent SDK on the kernel's own
admission path.

```ts
const result = await run(investigator, task, {
  toolPolicy: ({ name, effect, args, agentPath }) => {
    if (effect === "write" && !grant.allows("write_code")) return { deny: "grant_scope" };
    if (name === "bash" && /\brm\b/.test(String(args.command))) return { deny: "destructive" };
    return undefined;                                   // or { allow: true }
  },
});
```

| Decision | Effect |
| --- | --- |
| `undefined` / `{ allow: true }` | The call executes |
| `{ deny: code }` | The call never executes. The model reads `cave_tool_denied:<code>` as the tool result and the run continues; the receipt counts the call under `tools[].denied` (and `errors`) |
| throw, hang past 10s, malformed decision | The run ends with `cave_tool_policy_failed` (or `cave_tool_policy_decision_invalid` / `cave_tool_policy_reason_invalid`), carrying its receipt. Unknown authorization state never executes a tool |

The policy receives `runId`, `agentId`, `agentPath` (`[]` at the root, the
subagent tool names below it), `toolCallId`, `parentToolCallId` for nested
calls, `name`, `effect`, and the validated `args`. `code` must match
`[a-z][a-z0-9_]*`: it is an identifier that reaches the model, the receipt, and
the journal, never tenant text. A policy cannot rewrite arguments, because a
durable journal binds each call to its argument digest; it is re-evaluated on
every durable resume. Framework `cave_*` tools are not gated. Subagents
inherit the policy with the rest of the run options.

Which tools exist at all is still decided at definition time (`tools: […]`);
the policy narrows a fixed set per call, it does not widen one.

## Where tool code actually runs

Under `sandbox: "required"` the closure does **not** run in your process. Before
any provider traffic the framework copies the complete project source graph into
a per-run immutable staging directory, imports tools only from that snapshot, and
tears staging down when the stream settles. Running such tools in-process is
refused. Details and the real kernel boundary:
[Sandbox and security](13-sandbox-and-security.md).

## Reserved names

`cave_*` is reserved for framework recovery and memory tools
(`cave_retrieve`, `cave_memory_remember`, `cave_memory_search`,
`cave_memory_session_search`, …). The full list is in
[Reserved `cave_` identifiers](../reference/identifiers.md).
