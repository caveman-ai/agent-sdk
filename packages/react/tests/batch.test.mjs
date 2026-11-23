import { test } from "node:test";
import assert from "node:assert/strict";
import { createBatcher } from "../src/batch.js";

/** Stands in for `requestAnimationFrame`: flushes only when the test says so. */
function frames() {
  const scheduled = [];
  return {
    schedule: (flush) => scheduled.push(flush),
    /** Run every frame currently queued. */
    tick: () => scheduled.splice(0).forEach((flush) => flush()),
    get pending() {
      return scheduled.length;
    },
  };
}

/** Applies updates against a state cell, counting how many renders it took. */
function cell(initial) {
  const applied = [];
  let state = initial;
  return {
    apply: (update) => {
      state = update(state);
      applied.push(state);
    },
    get state() {
      return state;
    },
    get renders() {
      return applied.length;
    },
  };
}

test("a burst of updates costs one render, in arrival order", () => {
  const clock = frames();
  const store = cell("");
  const batcher = createBatcher(store.apply, clock.schedule);

  for (const token of ["a", "b", "c", "d"]) batcher.push((text) => text + token);
  assert.equal(store.renders, 0, "nothing applies before the frame runs");
  assert.equal(clock.pending, 1, "a burst schedules exactly one frame, not one per update");

  clock.tick();
  assert.equal(store.state, "abcd", "order is arrival order, not reversed or coalesced away");
  assert.equal(store.renders, 1);
});

test("each frame schedules the next one, so a long stream keeps flowing", () => {
  const clock = frames();
  const store = cell("");
  const batcher = createBatcher(store.apply, clock.schedule);

  batcher.push((text) => text + "1");
  clock.tick();
  batcher.push((text) => text + "2");
  clock.tick();

  assert.equal(store.state, "12");
  assert.equal(store.renders, 2, "one render per frame that had work");
});

test("cancel drops what has not been applied yet", () => {
  const clock = frames();
  const store = cell("kept");
  const batcher = createBatcher(store.apply, clock.schedule);

  batcher.push(() => "superseded");
  batcher.cancel();
  clock.tick();

  assert.equal(store.state, "kept", "a cancelled update must not reach state later");
  assert.equal(store.renders, 1, "the already-scheduled frame still fires");
});

test("a cancelled frame applies identity, so React bails out instead of rendering", () => {
  const clock = frames();
  const store = cell({ marker: 1 });
  const batcher = createBatcher(store.apply, clock.schedule);

  const before = store.state;
  batcher.push(() => ({ marker: 2 }));
  batcher.cancel();
  clock.tick();

  assert.equal(store.state, before, "same reference in means same reference out");
});

test("pushing after a flush works, and does not replay the previous batch", () => {
  const clock = frames();
  const store = cell("");
  const batcher = createBatcher(store.apply, clock.schedule);

  batcher.push((text) => text + "x");
  clock.tick();
  batcher.push((text) => text + "y");
  clock.tick();

  assert.equal(store.state, "xy", "a flushed batch must not be applied twice");
});
