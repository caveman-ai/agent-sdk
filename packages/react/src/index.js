"use client";

/**
 * A React client for a Caveman agent server.
 *
 * The server this talks to is `createAgentServer` from `@caveman-ai/agent`,
 * whose `/runs` endpoint requires a bearer token it describes as spending money
 * and returning model output. That token belongs on your server, never in a
 * bundle, so neither hook has a token or absolute-origin option: both call a
 * same-origin path in YOUR app, and your route attaches the credential.
 *
 * Everything on the wire is a frozen Pebble v1 `TurnEvent`, so this file only
 * folds events into render state. It invents no fields and reports what it does
 * not know as unknown rather than as zero.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createBatcher } from "./batch.js";
import { connectResuming } from "./socket.js";
import {
  INITIAL_STATE,
  SESSION_INITIAL_STATE,
  reduceAgentEvent,
  reduceSessionEvent,
} from "./events.js";

export {
  INITIAL_STATE,
  SESSION_INITIAL_STATE,
  reduceAgentEvent,
  reduceSessionEvent,
} from "./events.js";

/**
 * Dereferenced on call, never at import: this module renders on the server in
 * every framework that server-renders client components, and `requestAnimationFrame`
 * is not defined there. Nothing schedules until an event actually arrives, which
 * only happens in a browser.
 */
const scheduleFrame = (flush) => globalThis.requestAnimationFrame(flush);

/**
 * Submit one run and stream its events.
 *
 * @param {{ api: string }} options `api` is a same-origin base path your app
 *   serves, e.g. `/api/agent`. It must proxy `POST /runs` and
 *   `GET /runs/:id/events` to the agent server with the bearer token attached.
 */
export function useAgent({ api }) {
  if (typeof api !== "string" || api === "") {
    throw new Error("cave_react_api_required: pass the same-origin base path your app proxies");
  }
  const [state, setState] = useState(INITIAL_STATE);
  const [runId, setRunId] = useState(null);
  const sourceRef = useRef(null);
  /**
   * Which attach the hook is currently on. `submit` awaits a network round trip
   * before it can open a stream, and anything the caller does in the meantime —
   * a second submit, a `watch`, a `stopWatching` — supersedes it. The bump is
   * what stops that stale submit from resurrecting its own state or leaving a
   * second EventSource open behind the current one.
   */
  const attach = useRef(0);
  const batchRef = useRef(null);
  batchRef.current ??= createBatcher(setState, scheduleFrame);
  const batch = batchRef.current;

  const disconnect = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  /** Abandon the current attach: close its stream and drop its unapplied events. */
  const detach = useCallback(() => {
    attach.current += 1;
    disconnect();
    batch.cancel();
    return attach.current;
  }, [disconnect, batch]);

  // A hook unmounted mid-run must not leave an open connection behind. The run
  // itself keeps going and stays journaled; only this view of it stops.
  useEffect(() => detach, [detach]);

  /**
   * Open the event stream for a run already known to the server.
   *
   * `EventSource` reconnects transport failures on its own and resumes from
   * `Last-Event-ID`, which the server answers with the exact span this client
   * missed — so the retry path is the platform's, not ours.
   */
  const connect = useCallback((id, generation) => {
    const source = new EventSource(`${api}/runs/${encodeURIComponent(id)}/events`, {
      withCredentials: true,
    });
    sourceRef.current = source;

    /**
     * Read one frame, or fail the turn.
     *
     * Returns null once it has reported the failure. A frame this client cannot
     * parse is a hole in the transcript, and the transcript is what the UI
     * renders — so the stream stops rather than rendering the rest as if
     * nothing were missing. It arrives over a proxy route the app writes, which
     * makes it a trust boundary and not an impossible case.
     */
    const frame = (message) => {
      if (attach.current !== generation) return null;
      try {
        return JSON.parse(message.data);
      } catch {
        disconnect();
        batch.push((previous) => ({
          ...previous,
          status: "error",
          error: { message: "cave_react_event_unparsable", retryable: false },
        }));
        return null;
      }
    };

    source.onmessage = (message) => {
      const event = frame(message);
      if (event === null) return;
      batch.push((previous) => reduceAgentEvent(previous, event));
      // The server ends the response after turn.end. Closing here is what stops
      // EventSource from reading that as a drop and reconnecting to a finished
      // run; without it the client would reopen the stream forever. It runs now
      // rather than at the next flush so no reconnect races the batch.
      if (event.kind === "turn.end") disconnect();
    };
    // The server could not replay a span this client missed. Surfaced rather
    // than smoothed over: the transcript below has a hole in it.
    source.addEventListener("gap", (message) => {
      const detail = frame(message);
      if (detail === null) return;
      batch.push((previous) => ({ ...previous, gap: detail }));
    });
    // Only a closed source is terminal; everything else EventSource retries.
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || attach.current !== generation) return;
      sourceRef.current = null;
      batch.push((previous) => previous.status === "streaming"
        ? {
            ...previous,
            status: "error",
            error: { message: "cave_react_stream_closed", retryable: true },
          }
        : previous);
    };
  }, [api, disconnect, batch]);

  /** Start showing `id` from the beginning, discarding whatever preceded it. */
  const begin = useCallback((id) => {
    const generation = detach();
    setRunId(id);
    setState({ ...INITIAL_STATE, status: "streaming" });
    return generation;
  }, [detach]);

  const submit = useCallback(async (input) => {
    if (typeof input !== "string" || input === "") {
      throw new Error("cave_react_input_required");
    }
    const id = crypto.randomUUID();
    const generation = begin(id);

    let accepted;
    try {
      accepted = await fetch(`${api}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ runId: id, input }),
      });
    } catch (error) {
      // Offline, or the proxy route is unreachable. Left unhandled this would
      // reject out of an onClick and strand the UI on "streaming" forever.
      if (attach.current === generation) {
        batch.push((previous) => ({
          ...previous,
          status: "error",
          error: { message: `submit failed: ${String(error)}`, retryable: true },
        }));
      }
      return id;
    }
    // Superseded while the request was in flight: this run was still admitted,
    // and `watch(id)` can pick it up, but it is no longer what the caller shows.
    if (attach.current !== generation) return id;
    if (!accepted.ok) {
      const detail = await accepted.text();
      // Reading the body is another await, and another chance to be superseded.
      if (attach.current !== generation) return id;
      batch.push((previous) => ({
        ...previous,
        status: "error",
        error: { message: `submit failed: ${accepted.status} ${detail}`, retryable: false },
      }));
      return id;
    }
    connect(id, generation);
    return id;
  }, [api, begin, connect, batch]);

  /**
   * Attach to a run this hook did not submit — after a reload, or from another
   * tab. The server replays the run's events from the beginning, so the state
   * this rebuilds is the same one an uninterrupted stream would have produced.
   *
   * Its event window is bounded and in-memory: a run that settled long ago, or
   * one whose events an instance restart discarded, has no stream left to
   * attach to and surfaces as a closed stream. `GET /runs/:id` is the record.
   */
  const watch = useCallback((id) => {
    if (typeof id !== "string" || id === "") {
      throw new Error("cave_react_run_id_required");
    }
    connect(id, begin(id));
  }, [begin, connect]);

  /**
   * Stop watching without cancelling. `DELETE /runs/:id` exists, but this
   * view-only method deliberately does not call it. Reattach with `watch(runId)`.
   */
  const stopWatching = useCallback(() => {
    detach();
    setState((previous) => previous.status === "streaming"
      ? { ...previous, status: "detached" }
      : previous);
  }, [detach]);

  return { ...state, runId, submit, watch, stopWatching };
}

function sessionPath(api, sessionId, suffix = "") {
  return `${api.replace(/\/$/u, "")}/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

/** How long a dropped session socket waits before reopening. */
const SOCKET_RETRY_MS = 250;

/**
 * Attach to a durable multi-run session over SSE or WebSocket.
 *
 * Like `useAgent`, `api` is a same-origin base path your app serves: it must
 * proxy `GET /sessions/:id/events` (or the `/ws` upgrade), `POST
 * /sessions/:id/messages`, and `DELETE /sessions/:id` to the agent server with
 * the bearer attached. There is deliberately no token option. The server also
 * accepts the bearer as a `cave-bearer.` WebSocket subprotocol, which exists
 * for clients that cannot set headers — not for a browser, where a subprotocol
 * is as public as the bundle it ships in.
 */
export function useSession({ api, sessionId, transport = "sse" }) {
  if (typeof api !== "string" || api === "") {
    throw new Error("cave_react_api_required: pass the same-origin base path your app proxies");
  }
  if (typeof sessionId !== "string" || sessionId === "") {
    throw new Error("cave_react_session_id_required");
  }
  if (transport !== "sse" && transport !== "ws") {
    throw new Error("cave_react_session_transport_invalid");
  }
  const [state, setState] = useState(SESSION_INITIAL_STATE);
  const transportRef = useRef(null);
  const stopped = useRef(false);
  const batchRef = useRef(null);
  batchRef.current ??= createBatcher(setState, scheduleFrame);
  const batch = batchRef.current;

  const fail = useCallback((message) => {
    batch.push((previous) => ({ ...previous, status: "error", error: message }));
  }, [batch]);
  const receive = useCallback((event) => {
    batch.push((previous) => reduceSessionEvent(previous, event));
  }, [batch]);

  useEffect(() => {
    stopped.current = false;
    batch.cancel();
    setState(SESSION_INITIAL_STATE);
    if (transport === "ws") {
      if (typeof WebSocket === "undefined") {
        fail("cave_react_session_websocket_unavailable");
        return undefined;
      }
      const endpoint = new URL(sessionPath(api, sessionId, "/ws"), globalThis.location?.href);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      transportRef.current = connectResuming({
        url: endpoint.toString(),
        open: (target) => new WebSocket(target, "caveman-agent"),
        schedule: (retry) => setTimeout(retry, SOCKET_RETRY_MS),
        receive,
        fail,
        // Between sockets the session is not being watched, and saying so is
        // honest: the server keeps running the run either way.
        retrying: () => batch.push((previous) => ({ ...previous, status: "connecting" })),
      });
      return () => {
        stopped.current = true;
        transportRef.current?.close();
        transportRef.current = null;
        batch.cancel();
      };
    }

    // `EventSource` retries transport failures itself and resumes from
    // `Last-Event-ID`, which the server answers with the exact span this client
    // missed. Your proxy route has to forward that header for the resume to work.
    const source = new EventSource(sessionPath(api, sessionId, "/events"), {
      withCredentials: true,
    });
    transportRef.current = source;
    // A frame this client cannot parse is a hole in the transcript it renders,
    // and it arrives over a proxy route the app writes: a trust boundary, not an
    // impossible case. The `gap` frame goes through the same reducer, which
    // records it as a marked hole rather than a dead stream.
    const frame = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        fail("cave_react_event_unparsable");
        return;
      }
      receive(event);
    };
    source.onmessage = frame;
    source.addEventListener("gap", frame);
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || stopped.current) return;
      fail("cave_react_stream_closed");
    };
    return () => {
      stopped.current = true;
      source.close();
      transportRef.current = null;
      batch.cancel();
    };
  }, [api, sessionId, transport, receive, fail, batch]);

  const send = useCallback(async (text, options = {}) => {
    if (typeof text !== "string" || text === "") throw new Error("cave_react_input_required");
    if (transport === "ws") {
      const connection = transportRef.current;
      if (connection === null) throw new Error("cave_react_session_socket_not_open");
      connection.send({ type: "message", text, ...options });
      return undefined;
    }
    const response = await fetch(sessionPath(api, sessionId, "/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ text, ...options }),
    });
    if (!response.ok) throw new Error(`cave_react_session_send_failed:${response.status}`);
    return response.json();
  }, [api, sessionId, transport]);

  /** Cancel the active run, drop the queue, and stop reconnecting. */
  const cancel = useCallback(async () => {
    const response = await fetch(sessionPath(api, sessionId), {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error(`cave_react_session_cancel_failed:${response.status}`);
    stopped.current = true;
    transportRef.current?.close();
    transportRef.current = null;
    batch.push((previous) => ({ ...previous, status: "cancelled" }));
  }, [api, sessionId, batch]);

  return {
    events: state.events,
    status: state.status,
    gap: state.gap,
    lastGap: state.lastGap,
    send,
    cancel,
  };
}
