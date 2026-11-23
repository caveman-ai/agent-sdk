# @caveman/evals

Fail-closed graders for LLM outputs. One function, `grade(grader, value)`,
answers `{ passed, reason }` for every grader type. A grader that cannot reach a
verdict (bad options, an unreachable judge, a blocked URL) fails; it never
passes by default.

```ts
import { grade, SUPPORTED_GRADER_TYPES } from "@caveman/evals";

await grade({ type: "contains", fragments: ["tracking link"] }, "Here is your tracking link.");
// { passed: true, reason: "..." }

await grade({ type: "json_schema", schema: { type: "object", required: ["id"] } }, { id: 1 });
await grade({ type: "tool_called", tools: ["search"] }, { tool_calls: [{ name: "search" }] });

SUPPORTED_GRADER_TYPES.has("rouge_score"); // true
```

`Grader` is a discriminated union on `type`; your editor lists every type and
its options. The families: exact and fragment matching, regex and blocklists,
JSON schema and JSON path assertions, tool-call assertions, HTTP status,
latency, cost and token thresholds, BLEU and ROUGE, retrieval metrics, PII
checks, and LLM judges.

## Graders that call out

Judge and HTTP graders make network calls, guarded against server-side request
forgery. Pass capabilities through the third argument:

```ts
await grade(grader, value, {
  resolutionPinnedFetch, // required for hostname targets: a fetch that pins the approved DNS result
  networkTimeoutMs: 10_000,
  subjectModel: "gpt-4o", // an llm_judge of the same model family then fails closed
});
```

`modelFamily(model)` is the family mapping that check uses.

## Scope

These are the open grader types. Calibration, trust and gating of verdicts
across a team's traffic are Caveman Cloud's and are not in this package.

Node 22.13 or later. MIT.
