# Context, output, and Context IR

## The primitives

```ts
import { context, file, memory, output, schema } from "@caveman-ai/agent";

const playbook = context({
  id: "support.playbook",
  kind: "skill",
  source: file("./support.md"),
  stability: "build",
  safety: "S0",
  priority: "required",
});

const answer = output({
  maxTokens: 500,
  schema: schema.object({ answer: schema.string() }),
});
```

## `context()` options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `string` | required | Segment identity; appears in build diagnostics |
| `kind` | `ContextKind` | required | `instruction`, `user_intent`, `tool_schema`, `skill`, `memory`, `history`, `tool_result`, `artifact`, `error`, `output_contract` |
| `source` | `string \| FileSource` | required | Literal text or `file("./x.md")` |
| `stability` | `"build" \| "session" \| "turn"` | required | See below |
| `safety` | `"S0" \| "S1" \| "S2" \| "S3" \| "S4"` | `"S0"` | Safety class of the content |
| `priority` | `"required" \| "high" \| "normal" \| "low"` | `"required"` | Eviction order under pressure; `required` never evicts |
| `recovery` | `"none" \| "exact_ccr" \| "source_ref" \| "recompute"` | `"none"` | How original bytes come back after a transform |
| `cacheRegion` | `"frozen_prefix" \| "live_zone" \| "uncached"` | `frozen_prefix` when `stability` is `"build"`, else `live_zone` | Explicit override |
| `privacy` | `"content_blind" \| "local_sensitive" \| "connected_allowed"` | `"local_sensitive"` | Gates what may leave the process |
| `opaque` | `boolean` | `false` | Segment body is never inspected or transformed |
| `ttlTurns` | `number` | — | Live-zone segments expire after N turns |

## Stability zones

| `stability` | Where it lands | Rule |
| --- | --- | --- |
| `build` | The frozen, provider-visible prefix | Must be byte-stable inside one cache epoch |
| `session` | Live zone, stable for the session | — |
| `turn` | Live zone, current turn | — |

The runtime **rejects volatile data in the stable cache zone**
(`cave_frozen_prefix_volatile_segment`). This is the check behind the classic
build failure: a context value like `` () => `Today is ${new Date()}` `` in the
frozen prefix fails the build with a named location and a fix, before any
model-backed eval spends anything.

On transform failure or drift the runtime fails **open to the original
provider-visible bytes** rather than shipping a rewritten prefix it cannot
prove.

A prefix below the provider's explicit-cache minimum reports
`cave_frozen_prefix_below_provider_minimum`; a prefix that shrank against the
recorded baseline reports `cave_prefix_shrink_regression` (reset it deliberately
with `caveman-agent build --accept-prefix-shrink`).

## Cache epochs

Provider-visible stable prefixes stay byte-stable inside one cache epoch. A
definition, model, or plan change **rotates** the epoch rather than replaying
stale prefix bytes. `RunOptions.cacheRetention` selects provider-native prompt
cache retention; generic runs inherit Pi's short default.

## Output

```ts
output({ maxTokens: 500, schema: … })
```

`maxTokens` is both the model's output allowance and, in the Claude lane, the
SDK task token budget and a terminal provider-usage ceiling.

With a `schema`, the JSON Schema itself is rendered into the system prompt
(`<cave-output>`), the final message is parsed and validated against it, and
the parsed value is returned as `result.output`, typed from the schema:

```ts
const finding = schema.object({
  severity: schema.union([schema.literal("low"), schema.literal("high")]),
  evidence: schema.array(schema.string()),
});
const investigator = agent({ id: "inv", instructions, model: auto(), output: output({ maxTokens: 800, schema: finding }) });

const result = await run(investigator, question);
result.output;            // { severity: "low" | "high"; evidence: string[] } | undefined
```

A final message that is not JSON fails the run with
`cave_output_schema_invalid_json`; one that does not match fails with
`cave_output_schema_mismatch`. `output` is absent when no schema is declared or
the run stopped before a final message (`stopReason` says why). The journaled
result of a durable run carries `output`, so a replay returns it too.

The budget ladder can clamp a call's output down to what the remaining budget
affords, and refuses below `OUTPUT_CLAMP_FLOOR_TOKENS`. See
[Budgets](09-budgets-receipts-breakers.md).

## Context IR

Context IR is the lowered, content-blind representation of context the compiler
reasons about and a lock binds. Types and lowering helpers are exported from the
package root (`@caveman-ai/agent`, re-exporting `src/context-ir.ts`).

Key properties:

- A Cave Build binds **static** Context IR only. Eval inputs, user turns,
  conversation history, and tool results stay runtime evidence, so a lock never
  depends on one fixture prompt.
- Routes are reversible: a route is eligible only when exact recovery (CCR) is
  available, so the original bytes can be restored through `cave_retrieve`.
- Two routes matching one runtime segment collapse into
  `dynamic_route_ambiguous`, and the segment passes through untouched. One route
  per segment kind is deliberate.

Reference:
[`@caveman-ai/agent` index — Context IR types](../reference/api/agent/index.md).

## Artifacts

`artifact()` declares a destination for a tool result that should not sit in the
transcript. Pass it as a tool's `result`:

```ts
tool({ …, result: artifact({ strategy: "page", maxInlineTokens: 512, recovery: "exact_ccr" }) })
```

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `strategy` | `"verbatim" \| "json-index" \| "page"` | runtime default | How the artifact is surfaced to the model |
| `maxInlineTokens` | `number` | runtime default | Ceiling on what stays inline |
| `recovery` | `"exact_ccr" \| "source_ref"` | runtime default | Recovery is never `none` for an artifact |

## Files

`file("./path.md")` produces a `FileSource`. Declared root and child file
sources are read from the same immutable staged source graph the sandbox uses,
so a locked run and a live run see identical bytes. A source read outside the
allowed roots fails with `cave_sandbox_source_read_root_refused`; a missing body
is `cave_context_body_missing`.
