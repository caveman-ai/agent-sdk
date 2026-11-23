/**
 * A session WebSocket that comes back after a drop.
 *
 * `EventSource` reconnects and resumes from `Last-Event-ID` on its own; a
 * browser `WebSocket` does neither, so without this a session over `ws` ends
 * permanently at the first dropped connection. Reopening carries
 * `?lastEventId=<seq>`, which the server answers with exactly the span this
 * client missed — the same cursor the SSE transport resumes from.
 *
 * `open` and `schedule` are injected so the reconnect loop is testable without
 * a browser, the way `createBatcher` injects its frame scheduler. A `close()`
 * — a deliberate `cancel()`, or an unmount — stops it for good: a retry that
 * fires after it is a no-op rather than a resurrected socket.
 */
export function connectResuming({ url, open, schedule, receive, fail, retrying }) {
  let socket = null;
  let stopped = false;
  let lastEventId;

  const start = () => {
    if (stopped) return;
    socket = open(lastEventId === undefined ? url : `${url}?lastEventId=${lastEventId}`);
    socket.onmessage = (message) => {
      let event;
      try {
        event = JSON.parse(message.data);
      } catch {
        // A frame this client cannot parse is a hole in the transcript, and the
        // transcript is what the UI renders. Reported, not skipped past.
        fail("cave_react_event_unparsable");
        return;
      }
      if (Number.isSafeInteger(event.seq)) lastEventId = event.seq;
      receive(event);
    };
    // `onerror` is followed by `onclose` in every browser, so the reconnect is
    // driven from close alone and an error is not separately terminal.
    socket.onclose = () => {
      if (stopped) return;
      socket = null;
      retrying();
      schedule(start);
    };
  };
  start();

  return {
    send(payload) {
      if (socket === null || socket.readyState !== 1) {
        throw new Error("cave_react_session_socket_not_open");
      }
      socket.send(JSON.stringify(payload));
    },
    close() {
      stopped = true;
      socket?.close();
      socket = null;
    },
  };
}
