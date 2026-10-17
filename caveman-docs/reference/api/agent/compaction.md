# `@caveman-ai/agent/compaction`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/compaction-api.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `CompactionModelOverride`, `CompactionOptions`, `ContextAnchor`, `ContextCompactionFixture`, `ContextCompactionFixtureRound`, `ContextCompactionHarnessOptions`, `ContextCompactionHarnessResult`, `ContextCompactionHarnessRoundResult`, `ContextCompactionSummarizerRequest`, `ContextSummary`, `ContextSummaryEvaluation`, `ContextSummaryEvaluationInput`, `ContextSummaryRound`, `ContextSummarySource`, `ContextSummaryStability`, `ContextSummaryValidation`, `ExpectedContextAnchor`, `MessagePlan`, `NormalizedCompaction`
- **Type alias**: `ContextAnchorKind`, `ContextCompactionSummarizer`, `ContextSummarySourceRole`
- **Function**: `compactionForModel`, `contextSummarySources`, `contextWindowFull`, `elidedDigest`, `evaluateContextSummary`, `evaluateContextSummaryStability`, `evictionCitation`, `evictMessage`, `latestContextSummary`, `messagesTokens`, `messageText`, `messageTokens`, `newContextMessages`, `normalizeCompaction`, `parseContextSummary`, `pinnedContentSurvives`, `planCompaction`, `renderSummary`, `runContextCompactionHarness`, `summarizationInstruction`, `validateContextSummaryTransition`
- **Variable**: `CONTEXT_SEED_MAX_CHARS`, `SUMMARY_SCHEMA_VERSION`

</details>

## Interfaces

### `CompactionModelOverride`

```ts
export interface CompactionModelOverride {
    readonly reserveTokens?: number;
    readonly keepRecentTokens?: number;
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `CompactionOptions`

Budget-triggered compaction: while four full cold next-call ceilings remain,
compress instead of waiting for exhaustion to make the rewrite unaffordable.

This file is the only place in

```ts
export interface CompactionOptions {
    /**
     * How many times one run may compact. Defaults to 1: repeated-compaction
     * degradation is real and unmeasured, a budget-bound run is short by
     * construction, and one compaction is the case the affordability model can
     * actually predict.
     */
    readonly maxCompactions?: number;
    /** Token budget for the verbatim recent tail. Defaults to 8,000. */
    readonly keepRecentTokens?: number;
    /**
     * Hard cap on the summary's own output. Output length is the dominant cost
     * term of a compaction event. Defaults to 2,048.
     */
    readonly summaryMaxTokens?: number;
    /**
     * Minimum context reduction that makes a compaction worth its call. A rewrite
     * that frees a few thousand tokens has paid a summarizer call and a full
     * cache rewrite for nothing. Defaults to 20,000.
     */
    readonly minYieldTokens?: number;
    /**
     * Working calls the post-compaction budget must still cover. Break-even is
     * several calls, so a compaction that buys exactly one is guaranteed to lose.
     * Defaults to 3.
     */
    readonly headroomCalls?: number;
    /**
     * Cap on pinned user-intent text carried verbatim through a compaction,
     * newest-first. Defaults to 20,000.
     */
    readonly pinnedUserTokens?: number;
    /**
     * Preserve the first real user message verbatim even when it exceeds the
     * normal pin budget. Defaults to true. A compaction may decline for poor
     * yield, but it may not silently replace the task that created the run.
     */
    readonly preserveFirstUserMessage?: boolean;
    /**
     * Opt in to a different, usually cheaper summarizer.
     *
     * The default is deliberately the run's **own working model**, with the
     * compaction request built by the same request builder as a working call —
     * same system prompt, same tool definitions, same history, the compaction
     * instruction appended as the final user message. A summarizer with its own
     * prompt shape diverges at the first token and forfeits the entire cached
     * prefix, which costs more than the cheaper rate saves on every mid-tier
     * model. Opting in is gated on the summarizer's context window covering the
     * history it has to read; below that it fails closed to the working model.
     */
    readonly summarizerModel?: Model<Api>;
    /**
     * What the compaction rung does once free eviction is not enough.
     *
     * `"summarize"` (default) pays one summarizer call and keeps a lossy capsule
     * plus the recent tail. `"new-context"` skips the provider call entirely and
     * installs a fresh context window: pinned user intent, then whatever
     * `newContext` hands back as the seed. It is free, so it is strictly cheaper
     * than a summary — but it only stays honest when the caller persists the
     * outgoing window somewhere the model can search afterwards. `newContext` is
     * the moment to do that, and the mode fails closed to the ordinary ladder
     * when no `newContext` is supplied.
     */
    readonly mode?: "summarize" | "new-context";
    /**
     * Called once per `"new-context"` rollover, with the window about to be
     * dropped. Returns the seed text for the fresh window — the small hint that
     * carries plan, decisions, and unresolved work across the boundary.
     *
     * Persist `messages` here if they need to be recoverable: past this call the
     * runtime no longer holds them. Throwing declines the rollover and falls back
     * to the eviction/clamp rungs, so an unwritable archive never silently costs
     * the run its history.
     */
    readonly newContext?: (input: {
        readonly messages: readonly AgentMessage[];
        /** 1-based rollover number within this run. */
        readonly generation: number;
    }) => string | Promise<string>;
    /**
     * Pi's `compaction.reserveTokens`: context-window tokens kept free for the
     * response. The ladder also runs when the provider-reported prompt plus what
     * the turn appended would leave less than this. Omitted: wallet trigger only.
     */
    readonly reserveTokens?: number;
    /**
     * Pi's `compaction.modelOverrides`, keyed by exact `provider/modelId`. Each
     * value falls back independently to the run-wide setting.
     */
    readonly modelOverrides?: Readonly<Record<string, CompactionModelOverride>>;
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextAnchor`

```ts
export interface ContextAnchor {
    /** Stable across generations. A changed commitment gets a new key. */
    readonly key: string;
    readonly kind: ContextAnchorKind;
    readonly text: string;
    /** Critical anchors cannot be retired or paraphrased by a summarizer. */
    readonly critical: boolean;
    readonly sourceSegmentId: string;
    readonly sourceDigest: string;
    /** Prior critical keys this later user-sourced anchor explicitly replaces. */
    readonly supersedes: readonly string[];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextCompactionFixture`

```ts
export interface ContextCompactionFixture {
    readonly id: string;
    readonly rounds: readonly ContextCompactionFixtureRound[];
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionFixtureRound`

```ts
export interface ContextCompactionFixtureRound {
    readonly messages: readonly AgentMessage[];
    /** Defaults to every message in `messages`. */
    readonly summarizable?: readonly number[];
    /** Cumulative active anchors expected after this round. */
    readonly expected: readonly ExpectedContextAnchor[];
    readonly expectedRecoveryDigests?: readonly string[];
    /** Verbatim tail/pins outside capsule, in estimated tokens. */
    readonly retainedTokens?: number;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionHarnessOptions`

```ts
export interface ContextCompactionHarnessOptions {
    readonly repetitions?: number;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionHarnessResult`

```ts
export interface ContextCompactionHarnessResult {
    readonly fixtureId: string;
    readonly repetitions: number;
    readonly rounds: number;
    readonly validRounds: number;
    readonly criticalAnchorRecall: number;
    readonly weightedAnchorRecall: number;
    readonly exactRecoveryCoverage: number;
    readonly meanCompressionRatio: number;
    readonly stable: boolean;
    readonly failures: readonly string[];
    readonly results: readonly ContextCompactionHarnessRoundResult[];
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionHarnessRoundResult`

```ts
export interface ContextCompactionHarnessRoundResult {
    readonly repetition: number;
    readonly round: number;
    readonly parsed: boolean;
    readonly transitionValid: boolean;
    readonly transitionFailures: readonly string[];
    readonly evaluation: ContextSummaryEvaluation | undefined;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextCompactionSummarizerRequest`

```ts
export interface ContextCompactionSummarizerRequest {
    readonly fixtureId: string;
    readonly repetition: number;
    readonly round: number;
    readonly messages: readonly AgentMessage[];
    readonly previous: ContextSummary | undefined;
    readonly sources: readonly ContextSummarySource[];
    readonly instruction: string;
}
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextSummary`

```ts
export interface ContextSummary {
    readonly schemaVersion: number;
    readonly generation: number;
    readonly objective: string;
    readonly anchors: readonly ContextAnchor[];
    readonly constraintsRestated: readonly string[];
    readonly decisions: readonly {
        readonly decision: string;
        readonly why: string;
    }[];
    readonly artifacts: readonly {
        readonly path: string;
        readonly change: string;
    }[];
    readonly facts: readonly string[];
    readonly state: {
        readonly completed: readonly string[];
        readonly active: readonly string[];
        readonly blocked: readonly string[];
    };
    readonly next: readonly string[];
    readonly citations: readonly {
        readonly segmentId: string;
        readonly digest: string;
        readonly what: string;
    }[];
    readonly lookupHints: readonly string[];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextSummaryEvaluation`

```ts
export interface ContextSummaryEvaluation {
    readonly criticalAnchorRecall: number;
    readonly weightedAnchorRecall: number;
    readonly exactRecoveryCoverage: number;
    readonly compressionRatio: number;
    readonly commitmentDensity: number;
    readonly stable: boolean;
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummaryEvaluationInput`

```ts
export interface ContextSummaryEvaluationInput {
    readonly expected: readonly ExpectedContextAnchor[];
    readonly sourceTokens: number;
    readonly compactedTokens: number;
    readonly expectedRecoveryDigests?: readonly string[];
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummaryRound`

```ts
export interface ContextSummaryRound {
    readonly summary: ContextSummary;
    readonly sources: readonly ContextSummarySource[];
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummarySource`

Digest-addressed input the capsule is allowed to make claims about.

```ts
export interface ContextSummarySource {
    readonly segmentId: string;
    readonly digest: string;
    readonly role: ContextSummarySourceRole;
    /** Every required source needs at least one anchor in the new capsule. */
    readonly required: boolean;
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextSummaryStability`

```ts
export interface ContextSummaryStability {
    readonly rounds: number;
    readonly validTransitions: number;
    readonly criticalAnchorRetention: number;
    readonly stable: boolean;
    readonly failures: readonly string[];
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `ContextSummaryValidation`

```ts
export interface ContextSummaryValidation {
    readonly ok: boolean;
    readonly failures: readonly string[];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ExpectedContextAnchor`

```ts
export interface ExpectedContextAnchor {
    readonly key?: string;
    readonly kind: ContextAnchorKind;
    readonly text: string;
    readonly critical?: boolean;
    readonly weight?: number;
}
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `MessagePlan`

A message's identity in the compaction plan, derived from IR-shaped fields.

```ts
export interface MessagePlan {
    /** Carried verbatim through every compaction and asserted present afterwards. */
    readonly pinned: readonly number[];
    /** Kept verbatim because it is inside the recent-token budget or an open tool pair. */
    readonly recent: readonly number[];
    /**
     * Stale tool output that can be elided to a citation for free. Selected by
     * role and freshness; the class is reversible because every runtime tool
     * result the IR lowers carries `recovery: "exact_ccr"`.
     */
    readonly evictable: readonly number[];
    /** Everything else, which only a summarizer can compress. */
    readonly summarizable: readonly number[];
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `NormalizedCompaction`

```ts
export interface NormalizedCompaction {
    readonly maxCompactions: number;
    readonly keepRecentTokens: number;
    readonly summaryMaxTokens: number;
    readonly minYieldTokens: number;
    readonly headroomCalls: number;
    readonly pinnedUserTokens: number;
    readonly preserveFirstUserMessage: boolean;
    readonly summarizerModel: Model<Api> | undefined;
    readonly mode: "summarize" | "new-context";
    readonly newContext: CompactionOptions["newContext"];
    readonly reserveTokens: number | undefined;
    readonly modelOverrides: Readonly<Record<string, CompactionModelOverride>>;
}
```

Declared in `packages/agent/dist/compaction.d.ts`.

## Type aliases

### `ContextAnchorKind`

The sectioned summary the summarizer must produce.

Structure rather than prose keeps required fields explicit. `constraintsRestated`
is a restatement only — the pinned buffer is the carrier, and a summary that
becomes the only carrier reproduces the failure this design exists to avoid.

```ts
export type ContextAnchorKind = "objective" | "constraint" | "decision" | "artifact" | "fact" | "blocker" | "next";
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `ContextCompactionSummarizer`

Adapter seam for provider, local model, replay, or deterministic oracle.

```ts
export type ContextCompactionSummarizer = (request: ContextCompactionSummarizerRequest) => Promise<string> | string;
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `ContextSummarySourceRole`

```ts
export type ContextSummarySourceRole = "user" | "assistant" | "tool" | "capsule";
```

Declared in `packages/agent/dist/compaction.d.ts`.

## Functions

### `compactionForModel`

Run-wide settings with the active model's override applied, value by value.

```ts
export declare function compactionForModel(config: NormalizedCompaction, model: string): NormalizedCompaction;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `contextSummarySources`

Build the digest-addressed manifest for messages a rewrite may remove.

```ts
export declare function contextSummarySources(messages: readonly AgentMessage[], indexes: readonly number[]): readonly ContextSummarySource[];
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `contextWindowFull`

Pi's `reserveTokens` trigger: the provider-reported prompt plus what the turn
appended leaves less than the model's reserve free. The reserve is clamped
so the trigger never fires below `minYieldTokens`, where no rung frees enough.

```ts
export declare function contextWindowFull(config: NormalizedCompaction, model: Model<Api>, previous: {
    readonly inputTokens?: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
} | undefined, appended: readonly AgentMessage[]): boolean;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `elidedDigest`

```ts
export declare function elidedDigest(message: AgentMessage): string;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `evaluateContextSummary`

Exact-match evaluator. Paraphrase is drift for paths, commands, and contracts.

```ts
export declare function evaluateContextSummary(summary: ContextSummary, input: ContextSummaryEvaluationInput): ContextSummaryEvaluation;
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `evaluateContextSummaryStability`

Validate a repeated-compaction series, including generation and anchor drift.

```ts
export declare function evaluateContextSummaryStability(rounds: readonly ContextSummaryRound[]): ContextSummaryStability;
```

Declared in `packages/agent/dist/compaction-eval.d.ts`.

### `evictionCitation`

The citation a free eviction leaves behind, carrying enough to identify what left.

```ts
export declare function evictionCitation(message: AgentMessage, index: number): string;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `evictMessage`

Replace a tool result's text content with its citation, leaving the pair intact.

```ts
export declare function evictMessage(message: AgentMessage, index: number): AgentMessage;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `latestContextSummary`

Recover the newest trusted capsule from model-visible conversation history.

```ts
export declare function latestContextSummary(messages: readonly AgentMessage[]): ContextSummary | undefined;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `messagesTokens`

```ts
export declare function messagesTokens(messages: readonly AgentMessage[]): number;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `messageText`

```ts
export declare function messageText(message: AgentMessage): string;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `messageTokens`

Rough token size of one message: UTF-16 code units divided by four.

NOTE: this is NOT the basis the budget meter reserves in. The
meter's `inputTokenCeiling` bounds a call by its UTF-8 BYTE count (a loose
~4x-of-tokens ceiling that never under-reserves), while this is a ~1x token
ESTIMATE from character count. The two are not commensurable, so a compaction
yield gate expressed in these tokens does not translate one-to-one to the
bytes the reserve counts. The two remain separate provider-counting bases.

```ts
export declare function messageTokens(message: AgentMessage): number;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `newContextMessages`

Everything a `"new-context"` rollover carries into the fresh window: pinned
user intent verbatim, then one seed capsule.

Nothing else survives, which is what makes the window clean — and why the
result is self-contained by construction: no assistant tool call and no tool
result crosses the boundary, so no orphaned tool result can.

The seed is marked as a context capsule so the next rollover supersedes it
instead of stacking a second hint on top of the first.

```ts
export declare function newContextMessages(messages: readonly AgentMessage[], plan: MessagePlan, seed: string): AgentMessage[];
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `normalizeCompaction`

```ts
export declare function normalizeCompaction(options?: CompactionOptions): NormalizedCompaction;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `parseContextSummary`

Parse and validate a summarizer response. Fails closed: an unparseable or
structurally wrong summary is discarded and the caller falls through to the
clamp rung. A malformed summary is never accepted.

```ts
export declare function parseContextSummary(text: string): ContextSummary | undefined;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `pinnedContentSurvives`

Whether every pinned message's content survives verbatim in a rewrite.

Compares TEXT, not object identity. An identity check against the very
objects a compaction just placed into its output can only succeed, which is
no assertion at all — this is the check that can actually fail, and failing
it sends the run to the clamp rung with the original context intact.

```ts
export declare function pinnedContentSurvives(original: readonly AgentMessage[], pinned: readonly number[], rewritten: readonly AgentMessage[]): boolean;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `planCompaction`

Decide what survives a compaction, in IR terms rather than message positions.

- `user` messages are user intent: pinned, newest-first, under a token cap.
- The recent tail is a token budget, not a turn count, extended until the
  retained window is self-contained — no surviving tool result may reference
  a dropped tool call.
- A stale tool result becomes a citation instead of prose, and the most
  recent result per tool name is never stale.

On that last rule, precisely: the selection is by message role and freshness,
not by reading a `recovery` field. It relies on the fact that every runtime
tool result the IR lowers carries `recovery: "exact_ccr"` — see
`appendRuntimeContextSegment` in context-ir.ts — so the whole class is
reversible and eliding one to a citation loses nothing that cannot be
recomputed. Driving the choice from each segment's own `recovery` would be
strictly better, because it would extend to declared contexts whose recovery
varies; it is not what this code does today.

```ts
export declare function planCompaction(messages: readonly AgentMessage[], config: NormalizedCompaction): MessagePlan;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `renderSummary`

Render a validated summary back to the wire shape used in a follow-up request.

```ts
export declare function renderSummary(summary: ContextSummary): Record<string, unknown>;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `runContextCompactionHarness`

Run repeated, generational compaction against any injected summarizer.
Provider credentials and transport remain adapter-owned and explicit.

```ts
export declare function runContextCompactionHarness(fixture: ContextCompactionFixture, summarize: ContextCompactionSummarizer, options?: ContextCompactionHarnessOptions): Promise<ContextCompactionHarnessResult>;
```

Declared in `packages/agent/dist/compaction-harness.d.ts`.

### `summarizationInstruction`

The instruction appended as the final user message of the summarization request.

```ts
export declare function summarizationInstruction(previous: ContextSummary | undefined, sources?: readonly ContextSummarySource[]): string;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `validateContextSummaryTransition`

Validate one capsule transition against its source manifest. This check is
deterministic and model-independent. A caller commits only when `ok`.

```ts
export declare function validateContextSummaryTransition(summary: ContextSummary, previous: ContextSummary | undefined, sources: readonly ContextSummarySource[]): ContextSummaryValidation;
```

Declared in `packages/agent/dist/compaction.d.ts`.

## Variables & constants

### `CONTEXT_SEED_MAX_CHARS`

Hard ceiling on the seed a rollover injects. The point of a fresh window is
that it is small; an unbounded hint would rebuild the context it replaced.

```ts
export declare const CONTEXT_SEED_MAX_CHARS = 4096;
```

Declared in `packages/agent/dist/compaction.d.ts`.

### `SUMMARY_SCHEMA_VERSION`

Version of the summary contract the summarizer is asked to emit.

```ts
export declare const SUMMARY_SCHEMA_VERSION = 2;
```

Declared in `packages/agent/dist/compaction.d.ts`.

