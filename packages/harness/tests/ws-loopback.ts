/**
 * A scripted OpenAI Responses server on loopback that speaks both transports:
 * POST /v1/responses answers SSE (as tests/openai-loopback.ts), and a
 * WebSocket upgrade on the same path answers each `response.create` frame with
 * the same events as JSON messages. The WebSocket side keeps a
 * connection-local cache of the latest response (its input and output items),
 * resolves `previous_response_id` against it as the real server does, and
 * logs every request as the full body HTTP would have carried (`bodies`), so a
 * test can compare the two transports body for body. Faults on demand: a
 * refused upgrade, a socket dropped before or after the first event, a
 * forgotten `previous_response_id`, the 60-minute connection limit.
 * Minimal RFC 6455 server side (no extensions; permessage-deflate is declined).
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Socket } from "node:net";
import { eventsOf, type Body, type Step } from "./openai-loopback.ts";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** One unmasked server frame. */
function frame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.allocUnsafe(head + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = len;
  else if (len < 65536) {
    out[1] = 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  payload.copy(out, head);
  return out;
}

/** Reads masked client frames off `socket`; whole text messages go to `onText`. Pings are answered, a close is echoed. */
function readFrames(socket: Socket, head: Buffer, onText: (text: string) => void, onClose: () => void): void {
  let buffer = head;
  let fragments: Buffer[] = [];
  const feed = (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const fin = (buffer[0]! & 0x80) !== 0;
      const op = buffer[0]! & 0x0f;
      let len = buffer[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const masked = (buffer[1]! & 0x80) !== 0;
      const total = offset + (masked ? 4 : 0) + len;
      if (buffer.length < total) return;
      const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index & 3]!;
      }
      buffer = buffer.subarray(total);
      if (op === 0x9) socket.write(frame(0xa, payload));
      else if (op === 0x8) {
        if (!socket.destroyed) socket.end(frame(0x8, payload.subarray(0, 2)));
        onClose();
        return;
      } else if (op === 0x1 || op === 0x0) {
        fragments.push(payload);
        if (fin) {
          onText(Buffer.concat(fragments).toString("utf8"));
          fragments = [];
        }
      }
    }
  };
  socket.on("data", feed);
  socket.on("close", onClose);
  socket.on("error", () => {});
  if (head.length > 0) feed(Buffer.alloc(0));
}

export interface Faults {
  /** Answer every upgrade with this HTTP status (no WebSocket at all). */
  refuse?: number;
  /** Destroy the socket on the WebSocket request with this logical number (1-based): before any event, or after response.created. */
  drop?: { at: number; when: "before" | "after_created" };
  /** Answer the first chained create with previous_response_not_found (the cache lost it). */
  forget_once?: boolean;
  /** Answer the create with this logical number with websocket_connection_limit_reached, then close. */
  limit_at?: number;
  /** Answer the create with this logical number with an error event before any response (status, code). */
  error_at?: { at: number; status: number; code: string };
  /** A stalled upstream on `generate:false` frames: never answer (silent), or answer response.created and nothing after. The socket stays open. */
  stall_prewarm?: "silent" | "after_created";
  /** response.completed lists the output with each reasoning item encrypted again (OpenAI does: same length, other bytes), unlike output_item.done. */
  reencrypt_completed?: boolean;
}

export interface FakeServer {
  url: string;
  /** Every model request as the full body HTTP carries (WS: rebuilt from the chain), in order; prewarms excluded. */
  bodies: Body[];
  /** Which transport each body came over. */
  transports: ("http" | "ws")[];
  /** Every WebSocket frame as received (JSON), prewarms included. */
  frames: Body[];
  handshakes: IncomingHttpHeaders[];
  connections: number;
  close(): Promise<void>;
}

const respond = (n: number, step: Step): Body[] => eventsOf(step, n).map(([type, data]) => ({ type, ...data }));

/** Output items of a scripted response, as the server holds them for the chain. */
function outputOf(events: Body[]): unknown[] {
  return events.filter((event) => event.type === "response.output_item.done").map((event) => event.item);
}

export async function startFakeResponses(steps: Step[], faults: Faults = {}): Promise<FakeServer> {
  const state: FakeServer = { url: "", bodies: [], transports: [], frames: [], handshakes: [], connections: 0, close: async () => {} };
  let forgot = false;
  const stepOf = (n: number): Step => steps[n - 1] ?? { text: "Done." };
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      state.bodies.push(JSON.parse(raw) as Body);
      state.transports.push("http");
      const n = state.bodies.length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(respond(n, stepOf(n)).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  const sockets = new Set<Socket>();
  server.on("upgrade", (req, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    state.handshakes.push(req.headers);
    if (faults.refuse !== undefined) {
      socket.end(`HTTP/1.1 ${faults.refuse} Refused\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}`);
      return;
    }
    const key = String(req.headers["sec-websocket-key"]);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${createHash("sha1").update(key + GUID).digest("base64")}\r\n\r\n`);
    socket.setNoDelay(true);
    state.connections++;
    /** The connection-local cache: the latest response only. */
    let cached: { id: string; input: unknown[]; output: unknown[] } | undefined;
    let warm = 0;
    const send = (event: Body) => socket.write(frame(0x1, Buffer.from(JSON.stringify(event))));
    readFrames(socket, head, (text) => {
      const event = JSON.parse(text) as Body;
      state.frames.push(event);
      if (event.type !== "response.create") return send({ type: "error", status: 400, error: { type: "invalid_request_error", code: "unknown_event", message: String(event.type) } });
      const { type: _type, previous_response_id: previous, generate, ...body } = event;
      if (previous !== undefined && previous !== null) {
        if (faults.forget_once === true && !forgot) {
          forgot = true;
          cached = undefined;
        }
        if (cached === undefined || cached.id !== previous) {
          return send({ type: "error", status: 400, error: { type: "invalid_request_error", code: "previous_response_not_found", message: `Previous response with id '${String(previous)}' not found.` } });
        }
      }
      const input = previous === undefined || previous === null ? body.input as unknown[] : [...cached!.input, ...cached!.output, ...(body.input as unknown[])];
      if (generate === false) {
        const id = `warm_${++warm}`;
        if (faults.stall_prewarm === "silent") return;
        if (faults.stall_prewarm === "after_created") return send({ type: "response.created", response: { id, status: "in_progress" } });
        cached = { id, input, output: [] };
        send({ type: "response.created", response: { id, status: "in_progress" } });
        send({ type: "response.completed", response: { id, status: "completed", output: [], usage: { input_tokens: 100, output_tokens: 0, total_tokens: 100 } } });
        return;
      }
      const n = state.bodies.length + 1;
      if (faults.limit_at === n) {
        delete faults.limit_at;
        send({ type: "error", status: 400, error: { type: "invalid_request_error", code: "websocket_connection_limit_reached", message: "Responses websocket connection limit reached (60 minutes)." } });
        socket.end(frame(0x8, Buffer.from([0x03, 0xe8])));
        return;
      }
      if (faults.error_at?.at === n) {
        const { status, code } = faults.error_at;
        delete faults.error_at;
        cached = undefined;
        return send({ type: "error", status, error: { type: "invalid_request_error", code, message: `scripted ${code}` } });
      }
      if (faults.drop?.at === n && faults.drop.when === "before") {
        delete faults.drop;
        socket.destroy();
        return;
      }
      const events = respond(n, stepOf(n));
      if (faults.drop?.at === n && faults.drop.when === "after_created") {
        // Dropped mid-response: never answered, so not logged; the retry gets the same step.
        delete faults.drop;
        send(events[0]!);
        setTimeout(() => socket.destroy(), 5);
        return;
      }
      state.bodies.push({ ...body, stream: true, input });
      state.transports.push("ws");
      for (const out of events) {
        if (faults.reencrypt_completed && out.type === "response.completed") {
          const again = outputOf(events).map((item) => ((item as Body).type === "reasoning" ? { ...(item as Body), encrypted_content: `${(item as Body).encrypted_content}~again` } : item));
          send({ ...out, response: { ...out.response, output: again } });
        } else send(out);
      }
      cached = { id: `resp_${n}`, input, output: outputOf(events) };
    }, () => sockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return state;
}
