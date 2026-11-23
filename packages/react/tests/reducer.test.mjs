import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_STATE,
  SESSION_INITIAL_STATE,
  reduceAgentEvent,
  reduceSessionEvent,
} from "../src/events.js";

/** Folds a whole transcript, the way the hook does one event at a time. */
function fold(events) {
  return events.reduce(reduceAgentEvent, INITIAL_STATE);
}

function usage(fields = {}) {
  return {
    kind: "usage",
    usage: { in: 100, out: 10, cacheRead: 0, cacheWrite: 0, costUsd: 0.25, ...fields },
  };
}

test("a transcript folds into text, tools, and a terminal status", () => {
  const state = fold([
    { kind: "turn.start" },
    { kind: "delta.thinking", text: "weighing it" },
    { kind: "tool.start", id: "t1", name: "poll", argsSummary: "{}" },
    { kind: "tool.update", id: "t1", delta: "1 item" },
    { kind: "tool.update", id: "t1", delta: ", 2 items" },
    { kind: "tool.end", id: "t1", status: "completed", detail: "3 items" },
    { kind: "delta.text", text: "there are " },
    { kind: "delta.text", text: "3 items" },
    { kind: "turn.end", stopReason: "end_turn" },
  ]);

  assert.equal(state.text, "there are 3 items");
  assert.equal(state.thinking, "weighing it");
  assert.equal(state.status, "complete");
  assert.equal(state.stopReason, "end_turn");
  assert.deepEqual(state.tools, [
    { id: "t1", name: "poll", args: "{}", status: "completed", detail: "3 items" },
  ]);
});

test("a tool.end without detail keeps what the updates already streamed", () => {
  const state = fold([
    { kind: "turn.start" },
    { kind: "tool.start", id: "t1", name: "poll", argsSummary: "{}" },
    { kind: "tool.update", id: "t1", delta: "partial" },
    { kind: "tool.end", id: "t1", status: "failed" },
  ]);
  assert.equal(state.tools[0].detail, "partial");
  assert.equal(state.tools[0].status, "failed");
});

test("usage accumulates across messages", () => {
  const state = fold([{ kind: "turn.start" }, usage(), usage({ in: 50, out: 5, costUsd: 0.1 })]);
  assert.deepEqual(state.usage, {
    in: 150, out: 15, cacheRead: 0, cacheWrite: 0, costUsd: 0.35,
  });
});

test("one unpriced message makes the whole turn's cost unknown, not zero", () => {
  const state = fold([
    { kind: "turn.start" },
    usage({ costUsd: 0.25 }),
    usage({ costUsd: null }),
    usage({ costUsd: 0.25 }),
  ]);
  assert.equal(state.usage.costUsd, null, "an unknown cost must not collapse to a priced subtotal");
  assert.equal(state.usage.in, 300, "token counts stay exact even when pricing does not");
});

test("an error event is held until turn.end decides the status", () => {
  const mid = fold([
    { kind: "turn.start" },
    { kind: "error", message: "provider refused", retryable: false },
  ]);
  assert.equal(mid.status, "streaming", "an error alone does not end the turn");
  assert.equal(mid.error.message, "provider refused");

  const ended = reduceAgentEvent(mid, { kind: "turn.end", stopReason: "error" });
  assert.equal(ended.status, "error");
  assert.equal(ended.error.message, "provider refused");
});

test("a budget-paused turn ends complete, carrying its stop reason", () => {
  const state = fold([{ kind: "turn.start" }, { kind: "turn.end", stopReason: "budget_paused" }]);
  assert.equal(state.status, "complete");
  assert.equal(state.stopReason, "budget_paused");
});

test("turn.start clears whatever the previous run left behind", () => {
  const previous = fold([
    { kind: "turn.start" },
    { kind: "delta.text", text: "old answer" },
    { kind: "turn.end", stopReason: "end_turn" },
  ]);
  const next = reduceAgentEvent(previous, { kind: "turn.start" });
  assert.deepEqual(next, { ...INITIAL_STATE, status: "streaming" });
});

test("an unmodelled event kind is ignored rather than guessed at", () => {
  const before = fold([{ kind: "turn.start" }, { kind: "delta.text", text: "hi" }]);
  assert.equal(reduceAgentEvent(before, { kind: "some.future.kind", data: 1 }), before);
});

test("route.decided is reported as the server described it", () => {
  const state = fold([
    { kind: "turn.start" },
    { kind: "route.decided", model: "claude-opus-5", reason: "hard_task", signals: [] },
  ]);
  assert.deepEqual(state.route, { model: "claude-opus-5", reason: "hard_task" });
});

test("session reducer retains frames across consecutive runs", () => {
  const frames = [
    { kind: "turn.start", seq: 0 },
    { kind: "delta.text", text: "one", seq: 1 },
    { kind: "turn.end", stopReason: "end_turn", seq: 2 },
    { kind: "turn.start", seq: 3 },
    { kind: "delta.text", text: "two", seq: 4 },
    { kind: "turn.end", stopReason: "end_turn", seq: 5 },
  ];
  const state = frames.reduce(reduceSessionEvent, SESSION_INITIAL_STATE);
  assert.deepEqual(state.events, frames);
  assert.equal(state.status, "complete");
});

test("session reducer reports terminal protocol errors without dropping evidence", () => {
  const frames = [
    { kind: "turn.start", seq: 0 },
    { kind: "error", message: "provider refused", retryable: false, seq: 1 },
    { kind: "turn.end", stopReason: "error", seq: 2 },
  ];
  const state = frames.reduce(reduceSessionEvent, SESSION_INITIAL_STATE);
  assert.equal(state.status, "error");
  assert.deepEqual(state.events, frames);
});

test("a gap marks the hole and keeps the session streaming", () => {
  const opened = reduceSessionEvent(SESSION_INITIAL_STATE, { kind: "turn.start", seq: 40 });
  const gapped = reduceSessionEvent(opened, {
    error: "cave_serve_events_gap",
    requestedSeq: 12,
    earliestSeq: 40,
  });

  assert.equal(gapped.status, "streaming", "a gap is a hole above, not a dead session");
  assert.equal(gapped.gap, true);
  assert.deepEqual(gapped.lastGap, { requestedSeq: 12, earliestSeq: 40 });
  assert.deepEqual(gapped.events, opened.events, "the notice is not a Pebble frame");

  const after = reduceSessionEvent(gapped, { kind: "delta.text", text: "still here", seq: 41 });
  assert.equal(after.events.length, 2, "the retained window keeps arriving");
  assert.equal(after.gap, true, "the hole stays reported once it happened");
  assert.equal(
    reduceSessionEvent(after, { kind: "turn.end", stopReason: "end_turn", seq: 42 }).gap,
    true,
    "a terminal frame does not erase the hole above it",
  );
});
