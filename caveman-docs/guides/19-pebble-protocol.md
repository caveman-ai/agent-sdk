# The Pebble protocol

`@pebble-agent/protocol` is the **frozen** Apache-2.0 wire and storage contract
for Pebble. Only the protocol lives in this repository; the Pebble runtime,
sessions, policy, TUI, and distribution live in a separate proprietary repository.

> **Frozen at 0.1.0.** Any change to shape, field names, field types, enum
> membership, ordering constraints, or meaning is **breaking** and requires a new
> major version. Be careful: this package is byte-sensitive and fixture-driven.

Zero runtime dependencies, hand-rolled validators, strict TypeScript with
erasable syntax only. Engines: `node >=22.19`, authored for `bun >=1.4.0`.

## Two modes, one event stream

| Mode | Framing |
| --- | --- |
| **print** | Each turn event is one JSONL frame on stdout, bare |
| **RPC** | JSON-RPC 2.0; turn events ride as notifications on method `pebble/event` whose `params` **is** the event object |

## The envelope

Every event carries exactly these fields, before `kind` and payload:

| Field | Type | Rule |
| --- | --- | --- |
| `v` | `1` | Protocol version, literally `1` inside this major line |
| `seq` | number | Producer-assigned, monotonically increasing, gap-free per session stream, starting at 0 |
| `ts` | string | RFC 3339 / ISO 8601 at emission; UTC recommended |
| `sessionId` | string | Non-empty |

Canonical serialization is compact JSON with keys in schema order
(`v, seq, ts, sessionId, kind, …payload`) followed by `\n`. Golden fixtures fix
that order; byte-stable round-trips depend on it. Validators tolerate unknown
extra properties (additive-minor policy) but reject every documented-field
violation. Key order matters for producers that hash or diff frames; it is not
semantically enforced on decode.

## Event catalog — 19 kinds

| kind | payload | producer contract |
| --- | --- | --- |
| `turn.start` | — | Exactly one per producer turn |
| `turn.end` | `stopReason` | Authoritative turn outcome |
| `delta.text` | `text` | Streaming assistant text; consumers concatenate, never rewrite |
| `delta.thinking` | `text` | Streaming reasoning, rendered distinctly |
| `tool.start` | `id`, `name`, `argsSummary` | `id` unique per session; `argsSummary` may be empty |
| `tool.update` | `id`, `delta` | Progress text from a running tool |
| `tool.end` | `id`, `status`, `detail?` | `status ∈ completed \| failed \| cancelled` |
| `usage` | `usage` | Accounting for calls that already settled |
| `stage.open` | `id`, `label` | Sliding-window narration, 2–5 stages per turn |
| `stage.rewrite` | `id`, `label` | Retitles the open stage in place |
| `stage.close` | `id` | Stage closes (completed, not failed) |
| `error` | `message`, `retryable: false` | **Post-retry only** — one transient 429 must never paint N red blocks downstream |
| `permission.request` | `id`, `tool`, `plainLanguage`, `detail?` | **Legacy schema-only compatibility data.** Opaque; never opens a lifecycle |
| `permission.resolve` | `id`, `decision` | Legacy schema-only; no operational effect |
| `queue.changed` | `queued`, `heldAfterInterrupt` | Kernel-owned queue state |
| `checkpoint.created` | `ref`, `n` | `ref` opaque, `n` a running count |
| `route.decided` | `model`, `reason`, `signals[]` | Surfaces render **reasons**, never savings deltas |
| `budget.stopped` | `estimateUsd`, `leftUsd`, `message` | Stopped instead of spending past the cap |
| `session.compacting` | `firstKeptEntryId?` | Oldest surviving original entry id when present |

### `stop_reason`, exactly

```text
end_turn | awaiting_input | awaiting_approval | budget_paused | interrupted | error
```

Producers must not invent synonyms; consumers treat unknown values as protocol
violations. `awaiting_approval` is frozen legacy vocabulary — Caveman-owned
runtimes implement no approval or permission mechanism.

## Usage honesty rules (part of the contract)

- `usage.costUsd` is a measured USD amount, or **`null` when no public-catalog
  price exists**. `null` means unknown; consumers **must** render "unknown",
  never "$0 spent".
- Unknown model ids stay verbatim; limits for unknown models display "unknown",
  never a guessed value.
- Route decisions surface reasons and signals. Nothing in this protocol may claim
  verified savings; savings stay *inferred* until measured against a holdout, and
  per-day numbers stay per-day verbatim.

## Framing

**The rule: frames split strictly on the newline byte `0x0A`.**

- The decoder accumulates raw bytes and splits only on `0x0A`. UTF-8 guarantees
  multi-byte sequences never contain `0x0A`, so chunk boundaries anywhere —
  including mid-codepoint — are safe.
- **The Node `readline` trap:** `readline` also splits on U+2028 and U+2029,
  which `JSON.stringify` emits **raw** inside string values. A readline-based
  JSONL pipe therefore corrupts any frame containing them. This decoder survives
  such frames; the golden fixture `fixtures/delta.text.json` contains both
  characters raw as standing proof. **Never replace this decoder with readline.**
- Blank lines between frames are skipped silently; anything else unparseable
  throws `ProtocolError`.
- Incomplete trailing data is held until its newline arrives; `end()` throws
  `trailing-bytes` if bytes remain.
- Invalid UTF-8 fails closed (`bad-utf8`). Frames larger than `maxFrameBytes`
  (default 16 MiB) fail closed without buffering forever.
- `\r` is not a terminator: CRLF frames parse because a trailing `\r` is legal
  JSON whitespace, but re-encoding drops it — byte-stable hops need bare LF. A
  raw CR **inside** a string value fails loudly.

```ts
import { JsonlDecoder, encodeFrame, isTurnEvent } from "@pebble-agent/protocol";

const decoder = new JsonlDecoder();
for await (const chunk of process.stdin) {
  for (const frame of decoder.push(chunk)) {
    if (isTurnEvent(frame)) handle(frame);
    else logViolation(frame);   // fail closed, loudly
  }
}
decoder.end();
```

API: `JsonlDecoder` (`push`/`end`/`buffered`/`streamOffset`), `encodeFrame`,
`encodeFrameText`, `decodeFrames`, `ProtocolError` with codes `bad-json`,
`bad-utf8`, `frame-too-large`, `trailing-bytes`.

## RPC envelopes

A JSON-RPC 2.0 subset: `RpcRequest` (requires `id`), `RpcNotification` (no `id`),
`RpcResponse` (`result` XOR `error`; `id: null` only when unknowable), guards
(`isRpcMessage`…), constructors (`rpcRequest`…), and `RPC_ERROR_CODES`
(-32700/-32600/-32601/-32602/-32603).

Turn events ride RPC mode as notifications on `pebble/event`
(`eventNotification` / `unwrapEvent`). A `pebble/event` notification whose params
fail validation is a protocol violation: `unwrapEvent` returns `null` and callers
should log loudly.

## Stateful sequence validation

`TurnEventSequenceValidator` validates one complete turn from a caller-selected
`firstSeq`. `SessionEventSequenceCoordinator` validates a complete session from
sequence zero, composes one turn validator at a time, and enforces tool-call-id
uniqueness across turns.

Both return detached frozen evidence and stay **poisoned** after any error.
Memory is bounded by explicit open-lifecycle, seen-identity, and UTF-8
identity-byte caps; completed turn bodies are not retained. Legacy `permission.*`
frames get only normal shape validation and create no state.

## Session entries

```jsonc
{
  "id": "ent_0001",        // non-empty, unique in store
  "parentId": null,         // null (root) or an earlier entry id — tree-JSONL branching
  "role": "user",           // user | assistant | system | summary
  "content": "list files",  // full text; deltas already concatenated
  "usage": { … },           // optional; a valid Usage object when present
  "ts": "2026-08-25T09:30:00.000Z",
  "v": 1
}
```

Branching appends an entry pointing at any earlier `parentId` — in place, no file
fork. Compaction writes synthetic `role: "summary"` entries pointing at the
oldest surviving original via `firstKeptEntryId` (mirrored by
`session.compacting`). Loaders migrate on read; lines are never rewritten.

## ACP mapping

How Pebble renders under the Agent Client Protocol (`pebble acp`).

| pebble kind | acpMethod | session/update variant | notes |
| --- | --- | --- | --- |
| `turn.start` | — | — | Maps to the `session/prompt` request itself |
| `turn.end` | `session/prompt` response | — | Becomes the prompt StopReason via `STOP_REASON_TO_ACP` |
| `delta.text` | `session/update` | `agent_message_chunk` | One ContentBlock::Text per chunk |
| `delta.thinking` | `session/update` | `agent_thought_chunk` | One ContentBlock::Text per chunk |
| `tool.start` | `session/update` | `tool_call` | `id→toolCallId`; rawInput omitted |
| `tool.update` | `session/update` | `tool_call_update` | Delta text rides ToolCallContent blocks |
| `tool.end` | `session/update` | `tool_call_update` | Status via `TOOL_OUTCOME_TO_ACP_STATUS` |
| `usage` | `session/update` | `usage_update` | `costUsd≠null → cost.amount` + `"USD"`; `costUsd=null` omits cost, never sends 0 |
| `stage.open` / `stage.rewrite` / `stage.close` | `session/update` | `plan` | Open adds an in-progress entry; rewrite retitles; close completes |
| `error` | — | — | No standard ACP error notification; surfaces via prompt StopReason (`error→refusal`) |
| `permission.*` | — | — | Frozen legacy; never mapped or interpreted |
| `queue.changed` | — | — | TUI-native |
| `checkpoint.created` | — | — | Optionally `_meta.pebble.checkpoint` |
| `route.decided` | — | — | Pebble-native reason display; never savings deltas |
| `budget.stopped` | — | — | Manifests as `turn.end` with `budget_paused` (→ `refusal`) |
| `session.compacting` | — | — | Renderer-side distinct state |

| Pebble stop_reason | ACP StopReason |
| --- | --- |
| `end_turn` | `end_turn` |
| `awaiting_input` | `end_turn` |
| `awaiting_approval` | `end_turn` (frozen legacy mapping only) |
| `budget_paused` | `refusal` |
| `interrupted` | `cancelled` |
| `error` | `refusal` |

| Pebble decision | ACP PermissionOption kind |
| --- | --- |
| `allow-once` | `allow_once` |
| `allow-session` | `allow_always` |
| `deny` | `reject_once` |

Tool outcomes: `completed→completed`, `failed→failed`, `cancelled→null` (ACP
reserves cancellation for clients).

## Validators

Hand-rolled and dependency-free: `isTurnEvent`, `isUsage`, `isStopReason`,
`isSessionEntry`. Strict about every documented field — types, closed enums,
literal `retryable: false`, RFC 3339 timestamps, integer counts, finite money —
and deliberately tolerant **only** of unknown extra properties.

## Versioning policy

1. Frozen at 0.1.0.
2. Any breaking change ⇒ a new major version. Frozen v1 artifacts stay importable
   alongside.
3. Additive optional fields ⇒ minor version.
4. Every change regenerates the golden fixtures
   (`scripts/regenerate-fixtures.mjs`) and passes the round-trip suite: fixture
   bytes → decode → validate → re-encode → **byte equality**.
5. Proposals land through a spine/integration review before any code changes.
6. Bun pinned `>=1.4.0`; a local bun below that degrades loudly.

Full API: [`@pebble-agent/protocol`](../reference/api/pebble-protocol.md),
[`packages/pebble-protocol/README.md`](../../packages/pebble-protocol/README.md).
