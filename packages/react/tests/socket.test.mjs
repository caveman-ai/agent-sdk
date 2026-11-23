import { test } from "node:test";
import assert from "node:assert/strict";
import { connectResuming } from "../src/socket.js";

/** Stands in for `WebSocket`: opens on demand, closes when the test says so. */
function sockets() {
  const opened = [];
  return {
    opened,
    open(url) {
      const socket = {
        url,
        readyState: 1,
        sent: [],
        send(data) { socket.sent.push(data); },
        close() {
          socket.readyState = 3;
          socket.onclose?.();
        },
        /** The server dropping the connection, as opposed to us closing it. */
        drop() { socket.close(); },
      };
      opened.push(socket);
      return socket;
    },
    get last() { return opened.at(-1); },
  };
}

/** Collects reconnect callbacks so a test controls when the retry fires. */
function retries() {
  const queued = [];
  return {
    schedule: (retry) => queued.push(retry),
    run: () => queued.splice(0).forEach((retry) => retry()),
    get pending() { return queued.length; },
  };
}

function connect(fake, retry, sink = {}) {
  const received = [];
  const failed = [];
  let retrying = 0;
  const connection = connectResuming({
    url: "wss://app.example/api/agent/sessions/s1/ws",
    open: fake.open,
    schedule: retry.schedule,
    receive: (event) => received.push(event),
    fail: (message) => failed.push(message),
    retrying: () => { retrying += 1; },
  });
  Object.assign(sink, { received, failed, get retrying() { return retrying; } });
  return connection;
}

test("a dropped socket reopens and resumes from the last sequence it saw", () => {
  const fake = sockets();
  const retry = retries();
  const sink = {};
  connect(fake, retry, sink);

  fake.last.onmessage({ data: JSON.stringify({ kind: "delta.text", text: "hi", seq: 7 }) });
  assert.equal(sink.received.length, 1);

  fake.last.drop();
  assert.equal(fake.opened.length, 1, "the retry waits for the scheduler, it does not spin");
  retry.run();

  assert.equal(fake.opened.length, 2);
  assert.equal(
    fake.last.url,
    "wss://app.example/api/agent/sessions/s1/ws?lastEventId=7",
    "the reopened socket asks for exactly the span it missed",
  );
  assert.deepEqual(sink.failed, [], "a drop the client recovers from is not an error");
});

test("the first connection carries no cursor", () => {
  const fake = sockets();
  connect(fake, retries());
  assert.equal(fake.last.url, "wss://app.example/api/agent/sessions/s1/ws");
});

test("close() stops reconnecting, and a retry that fires afterwards is a no-op", () => {
  const fake = sockets();
  const retry = retries();
  const connection = connect(fake, retry);

  connection.close();
  retry.run();
  assert.equal(fake.opened.length, 1, "a deliberate cancel or unmount stays closed");
});

test("an unparsable frame is reported rather than skipped past", () => {
  const fake = sockets();
  const sink = {};
  connect(fake, retries(), sink);
  fake.last.onmessage({ data: "{not json" });
  assert.deepEqual(sink.failed, ["cave_react_event_unparsable"]);
  assert.deepEqual(sink.received, []);
});

test("send refuses a socket that is not open instead of dropping the message", () => {
  const fake = sockets();
  const retry = retries();
  const connection = connect(fake, retry);
  connection.send({ type: "message", text: "one" });
  assert.deepEqual(fake.last.sent, [JSON.stringify({ type: "message", text: "one" })]);

  fake.last.drop();
  assert.throws(
    () => connection.send({ type: "message", text: "two" }),
    /cave_react_session_socket_not_open/u,
  );
});
