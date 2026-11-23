/**
 * Coalesce a burst of state updates into one render.
 *
 * A streaming turn emits a text delta per token, and one `setState` per delta
 * is one render per token. Past a few hundred, a heavy tree spends longer
 * rendering than the model spends generating and the stream visibly stalls —
 * the failure every streaming UI eventually hits, and the reason frameworks
 * ship a throttle knob for it. Updates queue here and apply once per animation
 * frame instead, because rendering faster than the display repaints produces no
 * frame anybody sees.
 *
 * `schedule` is injected so the ordering is testable without a browser. Nothing
 * is dropped: the queue holds every update and applies them in arrival order.
 */
export function createBatcher(apply, schedule) {
  let queued = [];
  let scheduled = false;
  return {
    /** Queue one `(state) => state` update for the next flush. */
    push(update) {
      queued.push(update);
      if (scheduled) return;
      scheduled = true;
      schedule(() => {
        scheduled = false;
        const batch = queued;
        queued = [];
        // Reducing an empty batch returns the same state, so a flush left with
        // nothing to do is a no-op React bails out of rather than a render.
        apply((state) => batch.reduce((next, step) => step(next), state));
      });
    },
    /** Drop what is queued but not yet applied: a new run supersedes it. */
    cancel() {
      queued = [];
    },
  };
}
