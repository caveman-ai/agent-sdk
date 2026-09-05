import type { TurnEvent } from "@pebble-agent/protocol";

// ponytail: 2048 process-local frames bound replay memory; move replay to a
// durable indexed event store before widening this window.
const MAX_BUFFERED_EVENTS = 2048;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface WebSocketPeer {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message" | "close" | "error",
    fn: (event: { data?: unknown }) => void,
  ): void;
}

/** Process-local replay window. Durable authority remains run journals. */
export class EventBroadcast {
  private readonly buffered: TurnEvent[] = [];
  private readonly listeners = new Set<(event: TurnEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private floor = 0;
  settled = false;
  settledAt = 0;

  get subscriberCount(): number {
    return this.listeners.size;
  }

  push(event: TurnEvent): void {
    this.buffered.push(event);
    while (this.buffered.length > MAX_BUFFERED_EVENTS) {
      this.buffered.shift();
      this.floor += 1;
    }
    for (const listener of this.listeners) listener(event);
  }

  since(seq: number, gapAhead = false): {
    readonly events: readonly TurnEvent[];
    readonly gap: boolean;
    readonly earliest: number;
  } {
    const next = this.floor + this.buffered.length;
    const gap = seq < this.floor || (gapAhead && seq > next);
    return {
      events: gap ? [...this.buffered] : this.buffered.slice(seq - this.floor),
      gap,
      earliest: this.floor,
    };
  }

  subscribe(listener: (event: TurnEvent) => void, onClose?: () => void): () => void {
    this.listeners.add(listener);
    if (onClose !== undefined) this.closeListeners.add(onClose);
    return () => {
      this.listeners.delete(listener);
      if (onClose !== undefined) this.closeListeners.delete(onClose);
    };
  }

  settle(): void {
    this.settled = true;
    this.settledAt = Date.now();
  }

  close(): void {
    this.settle();
    for (const listener of this.closeListeners) listener();
    this.listeners.clear();
    this.closeListeners.clear();
  }
}

export function resumeSequence(request: Request): number {
  const parsed = Number.parseInt(
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("lastEventId") ?? "",
    10,
  );
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed + 1 : 0;
}

export function gapFrame(requestedSeq: number, earliestSeq: number): Record<string, unknown> {
  return { error: "cave_serve_events_gap", requestedSeq, earliestSeq };
}

/** Web-standard SSE response with existing replay/gap semantics. */
export function eventStreamResponse(
  broadcast: EventBroadcast,
  request: Request,
  endOnTurnEnd: boolean,
): Response {
  const requested = resumeSequence(request);
  let cleanup = (): void => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let lastWritten = requested - 1;
      let unsubscribe = (): void => {};
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already cancelled */ }
      };
      cleanup = close;
      const write = (text: string): void => {
        if (closed) return;
        if ((controller.desiredSize ?? 1) <= 0) { close(); return; }
        try { controller.enqueue(encoder.encode(text)); } catch { close(); }
      };
      const writeEvent = (event: TurnEvent): void => {
        if (event.seq <= lastWritten) return;
        lastWritten = event.seq;
        write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        if (endOnTurnEnd && event.kind === "turn.end") close();
      };
      const pending: TurnEvent[] = [];
      let replaying = true;
      unsubscribe = broadcast.subscribe((event) => {
        if (replaying) pending.push(event);
        else writeEvent(event);
      }, close);
      heartbeat = setInterval(() => { write(": keepalive\n\n"); }, SSE_HEARTBEAT_MS);
      heartbeat.unref?.();
      request.signal.addEventListener("abort", close, { once: true });
      const replay = broadcast.since(requested, !endOnTurnEnd);
      if (replay.gap) {
        write(`event: gap\ndata: ${JSON.stringify(gapFrame(requested, replay.earliest))}\n\n`);
        lastWritten = replay.earliest - 1;
      }
      for (const event of replay.events) writeEvent(event);
      replaying = false;
      for (const event of pending) writeEvent(event);
      if (endOnTurnEnd && broadcast.settled) close();
    },
    cancel() { cleanup(); },
  }, {
    highWaterMark: SSE_MAX_BUFFERED_BYTES,
    size: (chunk) => chunk.byteLength,
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
