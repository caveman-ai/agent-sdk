/** Node HTTP/WebSocket wrapper around web-standard createAgentHandler. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import type { AnyCaveBuildLock } from "./build.js";
import { DiskDurableStore, type DurableStore } from "./durable.js";
import type { AgentDefinition } from "./definition.js";
import {
  createAgentHandler,
  INSTANCE_LOCK_RUN_ID,
  type AgentHandlerOptions,
  type Principal,
  type RecoveryReport,
  type WebSocketLike,
} from "./serve-handler.js";
import type { RunOptions } from "./runtime.js";

type PerRunOptions = Omit<RunOptions, "durable" | "controller" | "signal" | "conversation">;
type PerRunOptionsFactory = (context: { sessionId: string; runId: string; principal?: Principal }) => PerRunOptions;

export interface AgentServerOptions {
  definition: AgentDefinition;
  /** Single-principal shorthand. Optional when `authenticate` is supplied. */
  token?: string;
  /** See {@link AgentHandlerOptions.authenticate}. Namespaces sessions per principal. */
  authenticate?: AgentHandlerOptions["authenticate"];
  store?: DurableStore;
  rootDir?: string;
  build?: AnyCaveBuildLock;
  /** Existing object form, or factory producing isolated per-run options. */
  runOptions?: Omit<RunOptions, "durable"> | PerRunOptionsFactory;
  maxConcurrentRuns?: number;
  maxQueuedRuns?: number;
  maxBodyBytes?: number;
  /**
   * Refuse to start while another instance is live against the same store.
   * Default `true`.
   *
   * Sessions, their replay buffers, and their deletion tombstones are held in
   * this process, so two instances sharing one store do not share them: the
   * same session id can be driven from both with neither seeing the other's
   * messages. Run journals are individually leased and stay safe; session state
   * is what diverges. Until session ownership is itself durable, one active
   * instance is the supported deployment, and this makes that a loud refusal at
   * startup rather than a quiet split brain in production.
   *
   * The lease expires, so a crashed instance is taken over by the next one:
   * active/standby works, active/active does not. Set `false` only for a
   * deployment that never addresses one session from two instances.
   */
  singleInstance?: boolean;
}

export interface AgentServer {
  readonly server: Server;
  listen(port: number, host?: string): Promise<number>;
  recover(): Promise<RecoveryReport>;
  nextWakeAt(): Promise<Date | undefined>;
  close(graceMs?: number): Promise<void>;
}

export type { RecoveryReport } from "./serve-handler.js";

const RECOVERY_SWEEP_INTERVAL_MS = 60_000;

interface WebSocketServerLike {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: WebSocketLike) => void,
  ): void;
  close(): void;
}

function forwardedBearer(headers: Headers): void {
  if (headers.has("authorization")) return;
  const encoded = (headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("cave-bearer."))
    ?.slice("cave-bearer.".length);
  if (encoded === undefined || encoded === "") return;
  try {
    const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    headers.set("authorization", `Bearer ${Buffer.from(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="),
      "base64",
    ).toString("utf8")}`);
  } catch {
    // Handler rejects missing/invalid bearer below.
  }
}

function webRequest(
  request: IncomingMessage,
  signal?: AbortSignal,
  includeBody = true,
): Request {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw === undefined) continue;
    if (Array.isArray(raw)) for (const value of raw) headers.append(name, value);
    else headers.set(name, raw);
  }
  forwardedBearer(headers);
  const method = request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    ...(signal === undefined ? {} : { signal }),
  };
  if (includeBody && method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(`http://${headers.get("host") ?? "localhost"}${request.url ?? "/"}`, init);
}

async function writeResponse(
  response: ServerResponse,
  result: Response,
  abort: AbortController,
): Promise<void> {
  const headers: Record<string, string> = {};
  result.headers.forEach((value, name) => { headers[name] = value; });
  response.writeHead(result.status, headers);
  if (result.body === null) {
    response.end();
    return;
  }
  // Node buffers the head until the first body write. An SSE client that
  // attaches before any event would otherwise wait for the first keepalive
  // (15s) just to see the response headers.
  response.flushHeaders();
  const reader = result.body.getReader();
  const stop = (): void => { abort.abort(); void reader.cancel().catch(() => undefined); };
  response.once("close", stop);
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!response.write(Buffer.from(next.value))) {
        await new Promise<void>((resolve) => response.once("drain", resolve));
      }
    }
    response.end();
  } finally {
    response.removeListener("close", stop);
  }
}

function internalError(error: unknown): Response {
  return new Response(JSON.stringify({
    error: "cave_serve_internal",
    message: error instanceof Error ? error.message : String(error),
  }), { status: 500, headers: { "content-type": "application/json" } });
}

async function rawUpgradeResponse(socket: Duplex, response: Response): Promise<void> {
  const body = response.body === null ? "" : await response.text();
  const headers = [...response.headers.entries()]
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(
    `HTTP/1.1 ${response.status} ${response.statusText || "Rejected"}\r\n${headers}` +
    `Connection: close\r\n\r\n${body}`,
  );
}

async function loadWebSocketServer(): Promise<WebSocketServerLike | undefined> {
  try {
    const loaded = await import("ws");
    if (typeof loaded.WebSocketServer !== "function") return undefined;
    return new loaded.WebSocketServer({
      noServer: true,
      handleProtocols(protocols) {
        return protocols.has("caveman-agent") ? "caveman-agent" : false;
      },
    }) as unknown as WebSocketServerLike;
  } catch {
    return undefined;
  }
}

export function createAgentServer(options: AgentServerOptions): AgentServer {
  if (typeof options.runOptions !== "function" &&
      options.runOptions !== undefined && (options.runOptions as RunOptions).durable !== undefined) {
    throw new Error("cave_serve_durable_owned: the server assigns durable options per request");
  }
  if (typeof options.runOptions !== "function" && options.runOptions !== undefined &&
      ["controller", "conversation", "signal"].some((key) =>
        Object.prototype.hasOwnProperty.call(options.runOptions, key))) {
    throw new Error(
      "cave_serve_run_option_owned: controller, conversation, and signal are server-owned",
    );
  }
  const upgradeSockets = new WeakMap<Request, WebSocketLike>();
  let runOptions: PerRunOptionsFactory | undefined;
  if (typeof options.runOptions === "function") runOptions = options.runOptions;
  else if (options.runOptions !== undefined) {
    const fixed = options.runOptions as PerRunOptions;
    runOptions = () => fixed;
    if (fixed.entryPath !== undefined) {
      Object.defineProperty(runOptions, Symbol.for("caveman.agent.serve.entryPathKnown"), {
        value: true,
      });
    }
  }
  const rootDir = options.rootDir === undefined ? undefined : resolve(options.rootDir);
  // Resolved here rather than left to the handler's default, so the instance
  // lease below and the handler's journals are the same store.
  const store = options.store ??
    new DiskDurableStore(`${(rootDir ?? process.cwd()).replace(/[\\/]$/u, "")}/.caveman/runs/durable`);
  const handler = createAgentHandler({
    definition: options.definition,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.authenticate === undefined ? {} : { authenticate: options.authenticate }),
    store,
    ...(rootDir === undefined ? {} : { rootDir }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(runOptions === undefined ? {} : { runOptions }),
    ...(options.maxConcurrentRuns === undefined ? {} : { maxConcurrentRuns: options.maxConcurrentRuns }),
    ...(options.maxQueuedRuns === undefined ? {} : { maxQueuedRuns: options.maxQueuedRuns }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    upgrade(request) {
      const socket = upgradeSockets.get(request);
      return socket === undefined ? undefined : { response: new Response(null), socket };
    },
  } satisfies AgentHandlerOptions);
  let sweepTimer: NodeJS.Timeout | undefined;
  let socketServer: WebSocketServerLike | undefined;
  let releaseInstance: (() => Promise<void>) | undefined;

  const server = createServer((request, response) => {
    const abort = new AbortController();
    const converted = webRequest(request, abort.signal);
    void handler.fetch(converted)
      .catch(internalError)
      .then((result) => writeResponse(response, result, abort))
      .catch(() => { if (!response.destroyed) response.destroy(); });
  });

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (!/^\/sessions\/[^/]+\/ws$/u.test(path)) {
        socket.once("finish", () => socket.destroy());
        await rawUpgradeResponse(socket, new Response(JSON.stringify({
          error: "cave_serve_upgrade_required",
        }), {
          status: 426,
          statusText: "Upgrade Required",
          headers: { "content-type": "application/json" },
        }));
        return;
      }
      const abort = new AbortController();
      socket.once?.("close", () => abort.abort());
      const preflight = await handler.fetch(webRequest(request, abort.signal, false)).catch(internalError);
      if (preflight.status !== 501 ||
          (await preflight.clone().json().catch(() => ({})) as { error?: string }).error !==
            "cave_serve_websocket_unavailable") {
        await rawUpgradeResponse(socket, preflight);
        return;
      }
      socketServer ??= await loadWebSocketServer();
      if (socketServer === undefined) {
        await rawUpgradeResponse(socket, preflight);
        return;
      }
      socketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const converted = webRequest(request, abort.signal, false);
        upgradeSockets.set(converted, webSocket);
        void handler.fetch(converted).catch((error: unknown) => {
          webSocket.close(1011, error instanceof Error ? error.message : "cave_serve_internal");
        });
      });
    })().catch(() => socket.destroy());
  });

  return {
    server,
    async listen(port: number, host = "0.0.0.0"): Promise<number> {
      // Claimed before the socket opens: a refused instance must never have
      // taken a request it would then drive against another instance's sessions.
      if (options.singleInstance !== false) {
        try {
          releaseInstance = await store.acquire(INSTANCE_LOCK_RUN_ID);
        } catch (error) {
          throw new Error(
            "cave_serve_instance_already_active: another instance holds this store's " +
            "instance lease. Session state is per-process, so two live instances can " +
            "drive one session blind to each other. Run one instance (a crashed one's " +
            "lease expires and the next takes over), or set singleInstance: false if " +
            "no session is ever addressed from two instances.",
            { cause: error },
          );
        }
      }
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(port, host, () => {
          server.removeListener("error", rejectListen);
          resolveListen();
        });
      });
      await handler.recover();
      sweepTimer = setInterval(() => { void handler.recover(); }, RECOVERY_SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    },
    recover: () => handler.recover(),
    nextWakeAt: () => handler.nextWakeAt(),
    async close(graceMs = 30_000): Promise<void> {
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      const closed = new Promise<void>((resolveClose) => {
        if (!server.listening) { resolveClose(); return; }
        server.close(() => { resolveClose(); });
      });
      await handler.close(graceMs);
      socketServer?.close();
      await closed;
      // Released last: the next instance should not adopt this store until this
      // one has finished draining into it.
      await releaseInstance?.().catch(() => undefined);
      releaseInstance = undefined;
      await store.close(INSTANCE_LOCK_RUN_ID).catch(() => undefined);
    },
  };
}
