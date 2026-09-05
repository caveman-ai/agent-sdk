---
name: caveman-cloud
description: How to operate Caveman Cloud from bash with the `caveman cloud` CLI — discovery, trace search, transcripts, evaluator drafts — and how to read its JSON envelope and exit codes.
---

# Operating Caveman Cloud from bash

Every operation is `caveman cloud <resource> <verb> [flags]`. Discover before
you guess: `caveman cloud tools list` names every operation and
`caveman cloud tools describe <operation>` prints its flags and an example.
Never invent a flag.

Output is always one JSON document on stdout:

```json
{"schema_version":1,"operation":"traces.search","ok":true,"status":"completed",
 "request_id":"req_…","data":{…},"resources":[{"type":"trace","id":"tr_…","link":"…"}],
 "warnings":[]}
```

Exit codes: `0` completed, `1` operational failure, `2` usage or schema error,
`3` unauthorized. On failure `ok` is false and `error.code` says why; fix the
call, do not retry the same command.

## Investigating a regression

1. `caveman cloud traces search --from <UTC> --to <UTC> --status error --format json`
   for the window the user named, then the same window with `--status ok` so
   you compare against a denominator, not a headline.
2. Group what you see by `deployment` and `tool_calls` before you name a
   mechanism. Repeated identical tool calls with a tiny output are a loop,
   not a slow model.
3. `caveman cloud traces transcript <trace_id>` on one or two representative
   traces to confirm the mechanism. Transcripts are redacted; say so if
   redaction hides what you need.
4. Cite `data.query_digest` of every search you relied on in `evidence_queries`.
   A digest you did not receive is not evidence.

## Preventing it next time

`caveman cloud evaluators create --file <draft.json>` registers a draft
(`{"name":…, "rule":…}`) and returns an `evaluator_id`. It is **not** active.
Activation (`evaluators activate --id …`) is a separate, authorized step: use
the `activate_evaluator` tool, and expect it to be refused without the grant.
Report `scoring: awaiting_traffic` honestly; nothing has scored yet.
