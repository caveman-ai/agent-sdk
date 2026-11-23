/**
 * A fake Caveman Cloud for SandboxEnv, spoken to by the real SDK client (`@caveman-ai/sdk/sandboxes`): the sandbox
 * API's REST calls (create with its Idempotency-Key, get with wait_for, resume, sleep, delete) and the relay's streams
 * (exec, files, subprotocol caveman.computer.v1), answered as the fleet's guest agent answers them, by running real
 * processes and touching real files on this host. What it keeps of the guest agent (Caveman Cloud
 * Caveman Cloud Sandboxes server.go runCommand, files.go):
 * - a command runs in a process group of its own (Setpgid), its environment built from nothing (HOME, USER, PATH,
 *   LANG) plus the start's env, in the start's cwd; a name that is not there is `command not found`, exit 127;
 * - its exit is said once both output pipes reached EOF and it was waited for, so a child it backgrounded that holds
 *   stdout holds the exit; a signalled command exits 128 + the signal;
 * - a signal message goes to the command's process group until it was waited for;
 * - a stream that ends before the command was waited for kills its process group, again until none is left;
 * - files: read and write of regular files only, list, stat (lstat, a link with where it points), mkdir (parents),
 *   remove, rename; a refusal is the wire's code (computerstream FileError) with the system's words, then its close.
 * And of the streams server (Caveman Cloud Sandboxes): a stream to a computer asleep is refused 409 not_running before
 * the upgrade, one to a computer that is gone 404. `state.refuse` refuses the next opens with what it names (a rate).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, mkdtempSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface FakeComputer {
  id: string;
  size: string;
  desired_state: "running" | "suspended" | "deleted";
  observed_state: string;
  sleep_after_seconds: number;
  idle: { pause_after_seconds: number };
  network?: string;
  /** Tests: on resume, this file gets a new boot id (a sleep that kept the disk alone). */
  bootFile?: string;
  /** Streams open to it now. */
  streams: number;
}

export interface FakeState {
  computers: Map<string, FakeComputer>;
  creates: { body: Record<string, unknown>; idempotencyKey: string | undefined }[];
  /** Every request: `METHOD path`, streams as `WS path`. */
  requests: string[];
  /** The next stream opens are refused with these, in order. */
  refuse: { status: number; code: string; retryAfter?: number }[];
  /** The next create is refused with this. */
  createRefusal?: { status: number; code: string; message: string; details?: Record<string, unknown> } | undefined;
  /** Streams open now, and the most at once. */
  open: number;
  maxOpen: number;
  errors: string[];
}

const SERVER_FRAME_MAX = 32 * 1024;
const FILE_CLOSES: Record<string, number> = {
  cave_code_computer_file_not_found: 4601, cave_code_computer_file_permission: 4602, cave_code_computer_file_exists: 4603,
  cave_code_computer_file_refused: 4604, cave_code_computer_file_too_large: 4605,
};
const STRERROR: Record<string, string> = {
  ENOENT: "no such file or directory", EISDIR: "is a directory", ENOTDIR: "not a directory", EACCES: "permission denied",
  EPERM: "operation not permitted", EEXIST: "file exists", ENOTEMPTY: "directory not empty", EINVAL: "invalid argument",
};

function serverFrame(op: number, payload: Buffer): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, n]) : n <= 0xffff ? Buffer.from([0x80 | op, 126, n >> 8, n & 0xff])
    : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  return Buffer.concat([head, payload]);
}

/** A client's frames (masked, RFC 6455), unmasked; a close ends them. */
async function* clientFrames(socket: Socket, head: Buffer): AsyncGenerator<{ op: number; payload: Buffer }> {
  const chunks = socket[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let buffer = Buffer.from(head);
  const need = async (n: number) => {
    while (buffer.length < n) {
      const next = await chunks.next().catch(() => ({ done: true as const, value: undefined }));
      if (next.done === true) return false;
      buffer = Buffer.concat([buffer, next.value]);
    }
    return true;
  };
  for (;;) {
    if (!await need(2)) return;
    let n = buffer[1]! & 0x7f;
    let at = 2;
    if (n === 126) { if (!await need(4)) return; n = buffer.readUInt16BE(2); at = 4; }
    else if (n === 127) { if (!await need(10)) return; n = Number(buffer.readBigUInt64BE(2)); at = 10; }
    if (!await need(at + 4 + n)) return;
    const mask = buffer.subarray(at, at + 4);
    const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + n));
    for (let i = 0; i < n; i++) payload[i]! ^= mask[i % 4]!;
    const op = buffer[0]! & 0x0f;
    buffer = buffer.subarray(at + 4 + n);
    yield { op, payload };
    if (op === 0x8) return;
  }
}

class Wire {
  readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
  }
  text(value: unknown): void {
    if (!this.socket.destroyed) this.socket.write(serverFrame(0x1, Buffer.from(JSON.stringify(value))));
  }
  binary(bytes: Buffer, channel?: number): void {
    for (let at = 0; at < bytes.length || at === 0; at += SERVER_FRAME_MAX) {
      const piece = bytes.subarray(at, at + SERVER_FRAME_MAX);
      if (!this.socket.destroyed) this.socket.write(serverFrame(0x2, channel === undefined ? piece : Buffer.concat([Buffer.from([channel]), piece])));
      if (bytes.length === 0) break;
    }
  }
  close(code: number, reason = ""): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    if (!this.socket.destroyed) this.socket.write(serverFrame(0x8, Buffer.concat([payload, Buffer.from(reason)])));
    // The client's answer, or its own close after an exit, ends it; past a moment the socket goes anyway.
    setTimeout(() => this.socket.destroy(), 2000).unref();
  }
}

/** A file system error as the files wire says it: its code and Go's words (`op path: reason`). */
function fileRefusal(error: NodeJS.ErrnoException, op: string, path: string): { code: string; message: string } {
  const errno = error.code ?? "EIO";
  const code = errno === "ENOENT" ? "cave_code_computer_file_not_found"
    : errno === "EACCES" || errno === "EPERM" ? "cave_code_computer_file_permission"
      : errno === "EEXIST" ? "cave_code_computer_file_exists"
        : errno === "ENOSPC" || errno === "EDQUOT" || errno === "EFBIG" ? "cave_code_computer_file_too_large" : "cave_code_computer_file_refused";
  return { code, message: `${op} ${path}: ${STRERROR[errno] ?? errno.toLowerCase()}` };
}

const pathError = (code: string) => Object.assign(new Error(code), { code });

function infoOf(path: string, stats: Stats, link?: string) {
  return {
    name: basename(path) || "/", type: stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "dir" : stats.isFile() ? "file" : "other",
    size: stats.size, mode: stats.mode & 0o777, mtime: stats.mtime.toISOString(), ...(link === undefined ? {} : { link }),
  };
}

/** The host's local address as a computer reaches it (Caveman Cloud drivehost.GuestHost), for its git lane. */
const HOST_ADDRESS = "http://172.16.0.1:47483";

/** How a computer's command sees this host: its paths, its arguments, its home. */
interface Guest {
  path: (path: string) => string;
  arg: (arg: string) => string;
  home: string;
}

/**
 * `options.workspace`: a folder on this host that stands for every computer's /workspace (the image's fixed one): a
 * path under /workspace in a command's cwd or arguments, or in a file operation, is that folder's.
 * `options.host`: the origin that stands for the host's local address (http://172.16.0.1:47483) in a command's
 * arguments, as `startGitLane` serves its git lane. Commands get a home of their own (as the guest's /home/tools), so
 * this host's user configuration (~/.gitconfig) never reaches them.
 */
export async function startSandboxFake(key = "cave_live_sandbox_fake", options: { workspace?: string; host?: string } = {}) {
  const at = (path: string) => options.workspace === undefined || (path !== "/workspace" && !path.startsWith("/workspace/")) ? path
    : `${options.workspace}${path.slice("/workspace".length)}`;
  const guest: Guest = {
    path: at,
    arg: (arg) => at(options.host === undefined ? arg : arg.split(HOST_ADDRESS).join(options.host)),
    home: mkdtempSync(join(tmpdir(), "sandbox-fake-home-")),
  };
  const state: FakeState = { computers: new Map(), creates: [], requests: [], refuse: [], open: 0, maxOpen: 0, errors: [] };
  const byKey = new Map<string, FakeComputer>();
  let made = 0;

  const makeComputer = (body: Record<string, unknown> = {}): FakeComputer => {
    const idle = (body.idle ?? {}) as { pause_after_seconds?: number };
    const computer: FakeComputer = {
      id: `cc_fake${++made}`, size: typeof body.size === "string" ? body.size : "small", desired_state: "running", observed_state: "starting",
      sleep_after_seconds: typeof body.sleep_after_seconds === "number" ? body.sleep_after_seconds : 600, idle: { pause_after_seconds: idle.pause_after_seconds ?? 0 },
      streams: 0,
      ...(typeof body.network === "string" ? { network: body.network } : {}),
    };
    state.computers.set(computer.id, computer);
    return computer;
  };
  const answer = (c: FakeComputer) => ({
    id: c.id, organization_id: "org_fake", name: c.id, driver: "firecracker", size: c.size, desired_state: c.desired_state, observed_state: c.observed_state,
    created_at: "2026-11-20T00:00:00Z", bare: true, image: "bare", sleep_after_seconds: c.sleep_after_seconds, idle: c.idle, ...(c.network === undefined ? {} : { network: c.network }),
  });
  const refuse = (res: import("node:http").ServerResponse, status: number, code: string, message: string, details?: Record<string, unknown>) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { code, message, request_id: "req_fake", ...(details === undefined ? {} : { details }) } }));

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? "/", "http://fake");
    state.requests.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${key}`) return refuse(res, 401, "cave_unauthorized", "The key was refused.");
    const route = /^\/api\/v1\/code\/computers(?:\/([^/]+)(?:\/(resume|sleep))?)?$/u.exec(url.pathname);
    if (route === null) return refuse(res, 404, "cave_not_found", "No such route.");
    const [, id, verb] = route;
    if (id === undefined) {
      if (req.method !== "POST") return refuse(res, 405, "cave_method_not_allowed", "POST makes a computer.");
      const body = raw === "" ? {} : JSON.parse(raw) as Record<string, unknown>;
      const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"] : undefined;
      state.creates.push({ body, idempotencyKey });
      if (state.createRefusal !== undefined) {
        const r = state.createRefusal;
        state.createRefusal = undefined;
        return refuse(res, r.status, r.code, r.message, r.details);
      }
      const replay = idempotencyKey === undefined ? undefined : byKey.get(idempotencyKey);
      const computer = replay ?? makeComputer(body);
      if (idempotencyKey !== undefined) byKey.set(idempotencyKey, computer);
      return res.writeHead(replay === undefined ? 201 : 200, { "content-type": "application/json" }).end(JSON.stringify(answer(computer)));
    }
    const computer = state.computers.get(id);
    if (computer === undefined) return refuse(res, 404, "cave_not_found", "No such computer.");
    if (req.method === "GET") {
      // Booting ends at the first read; a held read (wait_for) says how it ended (Cave-Wait).
      if (computer.desired_state === "running" && computer.observed_state === "starting") computer.observed_state = "running";
      const asked = url.searchParams.get("wait_for");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (asked !== null) headers["cave-wait"] = asked.split(",").includes(computer.observed_state) ? "satisfied" : computer.desired_state === "deleted" ? "unreachable" : "timeout";
      return res.writeHead(200, headers).end(JSON.stringify(answer(computer)));
    }
    if (req.method === "DELETE") {
      computer.desired_state = "deleted";
      computer.observed_state = "deleted";
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer(computer)));
    }
    if (verb === "sleep") {
      computer.desired_state = "suspended";
      computer.observed_state = "suspended";
    } else if (verb === "resume" && computer.desired_state !== "deleted") {
      if (computer.desired_state !== "running" && computer.bootFile !== undefined) await writeFile(computer.bootFile, `boot-${Date.now()}\n`);
      computer.desired_state = "running";
      computer.observed_state = "starting";
    }
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer(computer)));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://fake");
    state.requests.push(`WS ${url.pathname}`);
    const reject = (status: number, code: string, message: string, retryAfter?: number) => {
      const body = JSON.stringify({ error: { code, message } });
      socket.end(`HTTP/1.1 ${status} Refused\r\nContent-Type: application/json\r\n${retryAfter === undefined ? "" : `Retry-After: ${retryAfter}\r\n`}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    if (req.headers.authorization !== `Bearer ${key}`) return reject(401, "cave_unauthorized", "The key was refused.");
    const route = /^\/relay\/v1\/computers\/([^/]+)\/(exec|files)$/u.exec(url.pathname);
    const computer = route === null ? undefined : state.computers.get(route[1]!);
    const refusal = state.refuse.shift();
    if (refusal !== undefined) return reject(refusal.status, refusal.code, "refused by the test", refusal.retryAfter);
    if (computer === undefined || computer.desired_state === "deleted") return reject(404, "cave_not_found", "No such sandbox for this key.");
    if (computer.desired_state !== "running") return reject(409, "cave_code_computer_not_running", "the computer is not running; resume it first");
    if (req.headers["sec-websocket-protocol"] !== "caveman.computer.v1") state.errors.push(`upgrade without the subprotocol: ${JSON.stringify(req.headers)}`);
    const accept = createHash("sha1").update(`${String(req.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: caveman.computer.v1\r\n\r\n`);
    state.open++;
    state.maxOpen = Math.max(state.maxOpen, state.open);
    computer.streams++;
    // The client's end (its answer to our close, or its own after an exit) ends the stream here too.
    socket.once("end", () => socket.destroy());
    socket.once("close", () => {
      state.open--;
      computer.streams--;
    });
    const serve = route![2] === "files" ? serveFiles : serveExec;
    serve(new Wire(socket), clientFrames(socket, head), guest).catch((error: unknown) => state.errors.push(String(error)));
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    key,
    state,
    /** The folder on this host every command gets as its home (the guest's /home/tools). */
    home: guest.home,
    makeComputer,
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

async function serveExec(wire: Wire, frames: AsyncGenerator<{ op: number; payload: Buffer }>, guest: Guest): Promise<void> {
  const first = (await frames.next()).value;
  if (first === undefined || first.op !== 0x1) return wire.close(4400, "cave_bad_request");
  const start = JSON.parse(first.payload.toString()) as { type: string; argv: string[]; env?: Record<string, string>; cwd?: string };
  if (start.type !== "start" || !Array.isArray(start.argv) || start.argv.length === 0) return wire.close(4400, "cave_bad_request");
  // Nothing of the agent's own environment: the guest's fixed one, then the start's.
  const env = { HOME: guest.home, USER: "tools", PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", ...(start.env ?? {}) };
  let child: ChildProcess;
  try {
    child = spawn(start.argv[0]!, start.argv.slice(1).map(guest.arg), { cwd: guest.path(start.cwd ?? "/"), env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    wire.text({ type: "error", code: "cave_internal", message: String(error) });
    return wire.close(4500, "cave_internal");
  }
  let waited = false;
  const group = () => child.pid;
  const signalGroup = (name: NodeJS.Signals) => {
    const pid = group();
    if (waited || pid === undefined) return false;
    try {
      process.kill(-pid, name);
      return true;
    } catch {
      return false;
    }
  };
  let hungUp = false;
  const hangup = async () => {
    if (hungUp) return;
    hungUp = true;
    for (let i = 0; i < 50 && signalGroup("SIGKILL"); i++) await new Promise((done) => setTimeout(done, 100));
  };
  const ended = new Promise<{ code: number }>((done) => {
    child.once("error", (error: NodeJS.ErrnoException) => {
      waited = true;
      if (error.code === "ENOENT" && !start.argv[0]!.includes("/")) wire.binary(Buffer.from(`${start.argv[0]}: command not found\n`), 2);
      done({ code: 127 });
    });
    // close: the process was waited for and both pipes reached EOF, as the guest says its exit.
    child.once("close", (code, signal) => {
      waited = true;
      done({ code: signal !== null ? 128 + (osConstants.signals[signal] ?? 0) : code ?? -1 });
    });
  });
  child.stdout!.on("data", (chunk: Buffer) => wire.binary(chunk, 1));
  child.stderr!.on("data", (chunk: Buffer) => wire.binary(chunk, 2));
  child.stdin!.on("error", () => undefined);
  void (async () => {
    try {
      for await (const frame of frames) {
        if (frame.op === 0x8) break;
        if (frame.op === 0x2) { child.stdin!.write(frame.payload); continue; }
        if (frame.op !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString()) as { type: string; signal?: string };
        if (message.type === "close_stdin") child.stdin!.end();
        else if (message.type === "signal") signalGroup(`SIG${message.signal}` as NodeJS.Signals);
        else if (message.type === "resize") wire.text({ type: "refused", of: "resize", code: "cave_code_computer_unsupported", message: "the command has no terminal" });
      }
    } catch {
      // the socket broke: a hangup
    }
    if (!waited) await hangup();
  })();
  wire.socket.once("close", () => { if (!waited) void hangup(); });
  const { code } = await ended;
  wire.text({ type: "exit", code });
  wire.close(1000);
}

async function serveFiles(wire: Wire, frames: AsyncGenerator<{ op: number; payload: Buffer }>, guest: Guest): Promise<void> {
  const at = guest.path;
  const first = (await frames.next()).value;
  if (first === undefined || first.op !== 0x1) return wire.close(4400, "cave_bad_request");
  const op = JSON.parse(first.payload.toString()) as { type: string; op: string; path: string; to?: string; mode?: number; parents?: boolean; all?: boolean; root?: boolean };
  const fail = (refusal: { code: string; message: string }) => {
    wire.text({ type: "error", ...refusal });
    wire.close(FILE_CLOSES[refusal.code] ?? 4500, refusal.code);
  };
  if (op.root === true) return fail({ code: "cave_code_computer_file_permission", message: `${op.op} ${op.path} as root: this computer's files are reached as its tools user alone` });
  const path = at(op.path);
  try {
    switch (op.op) {
      case "read": {
        const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        try {
          const stats = await file.stat();
          if (!stats.isFile()) throw pathError(stats.isDirectory() ? "EISDIR" : "EINVAL");
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            wire.binary(Buffer.from(buffer.subarray(0, bytesRead)));
          }
          wire.text({ type: "file", file: infoOf(path, stats) });
        } finally {
          await file.close();
        }
        break;
      }
      case "write": {
        const file = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NONBLOCK, op.mode || 0o644);
        try {
          if (!(await file.stat()).isFile()) throw pathError("EINVAL");
          for await (const frame of frames) {
            if (frame.op === 0x2) { await file.write(frame.payload); continue; }
            if (frame.op === 0x1 && (JSON.parse(frame.payload.toString()) as { type: string }).type === "close_stdin") break;
            if (frame.op === 0x8) throw new Error("the write's stream ended before its end");
          }
        } finally {
          await file.close();
        }
        wire.text({ type: "file", file: infoOf(path, await lstat(path)) });
        break;
      }
      case "list": {
        const stats = await lstat(path);
        if (!stats.isDirectory()) throw pathError("ENOTDIR");
        const entries = [];
        for (const name of await readdir(path)) {
          const at = `${path.replace(/\/+$/u, "")}/${name}`;
          const info = await lstat(at).catch(() => undefined);
          if (info !== undefined) entries.push(infoOf(at, info, info.isSymbolicLink() ? await readlink(at) : undefined));
        }
        for (let at = 0; at < entries.length; at += 100) wire.text({ type: "entries", entries: entries.slice(at, at + 100) });
        wire.text({ type: "done" });
        break;
      }
      case "stat": {
        const stats = await lstat(path);
        wire.text({ type: "file", file: infoOf(path, stats, stats.isSymbolicLink() ? await readlink(path) : undefined) });
        break;
      }
      case "mkdir":
        await mkdir(path, { recursive: op.parents === true, mode: op.mode || 0o755 });
        wire.text({ type: "done" });
        break;
      case "remove":
        await lstat(path);
        await rm(path, { recursive: op.all === true });
        wire.text({ type: "done" });
        break;
      case "rename":
        await rename(path, at(op.to!));
        wire.text({ type: "done" });
        break;
      default:
        return wire.close(4400, "cave_bad_request");
    }
  } catch (error) {
    return fail(fileRefusal(error as NodeJS.ErrnoException, op.op === "write" || op.op === "read" ? "open" : op.op, path));
  }
  wire.close(1000);
}

/**
 * A fake of the host's git lane (Caveman Cloud Caveman Cloud Sandboxes): git's smart HTTP at
 * /git/v1/<owner>/<name>.git for the repositories made here (any other is 404), served by this host's
 * `git http-backend` from bare repositories under its own folder, with no credential asked. A push takes caveman/*
 * branches only and no deletes, as the relay's git proxy's pre-receive rules do. `makeRepository` makes one with a
 * first commit of `files` on main and, for another `branch`, that branch one commit past it (its BRANCH file).
 */
export async function startGitLane() {
  const root = mkdtempSync(join(tmpdir(), "git-lane-"));
  const home = mkdtempSync(join(tmpdir(), "git-lane-home-"));
  const repos = new Set<string>();
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (args: string[], cwd: string) => new Promise<void>((done, fail) => {
    const child = spawn("git", ["-c", "user.name=lane", "-c", "user.email=lane@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.once("error", fail);
    child.once("close", (code) => (code === 0 ? done() : fail(new Error(`git ${args.join(" ")}: ${err}`))));
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://lane");
    const match = /^\/git\/v1\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(\/.*)$/u.exec(url.pathname);
    if (match === null || !repos.has(`${match[1]}/${match[2]}`)) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not the session's repository\n");
      return;
    }
    const cgi = spawn("git", ["http-backend"], {
      env: {
        ...env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "computer", PATH_INFO: `/${match[1]}/${match[2]}.git${match[3]}`,
        REQUEST_METHOD: req.method ?? "GET", QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-encoding"] === undefined ? {} : { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) }),
        ...(req.headers["git-protocol"] === undefined ? {} : { GIT_PROTOCOL: String(req.headers["git-protocol"]) }),
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    req.pipe(cgi.stdin!);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout!.on("data", (chunk: Buffer) => {
      if (sent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString("latin1").split("\r\n")) {
        const colon = line.indexOf(":");
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (/^status$/iu.test(name)) status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      sent = true;
      res.write(head.subarray(end + 4));
    });
    cgi.once("close", () => res.end());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    /** The origin that stands for http://172.16.0.1:47483 (startSandboxFake's `host`). */
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    root,
    async makeRepository(owner: string, name: string, files: Record<string, string>, branch = "main"): Promise<string> {
      const bare = join(root, owner, `${name}.git`);
      await mkdir(bare, { recursive: true });
      await git(["init", "--quiet", "--bare", "--initial-branch=main"], bare);
      const work = mkdtempSync(join(tmpdir(), "git-lane-work-"));
      await git(["init", "--quiet", "--initial-branch=main"], work);
      for (const [path, text] of Object.entries(files)) {
        await mkdir(join(work, path, ".."), { recursive: true });
        await writeFile(join(work, path), text);
      }
      await git(["add", "-A"], work);
      await git(["commit", "--quiet", "-m", "first"], work);
      if (branch !== "main") {
        // The branch one commit past main: BRANCH names it.
        await git(["checkout", "--quiet", "-b", branch], work);
        await writeFile(join(work, "BRANCH"), `${branch}\n`);
        await git(["add", "BRANCH"], work);
        await git(["commit", "--quiet", "-m", `on ${branch}`], work);
        await git(["push", "--quiet", bare, branch], work);
        await git(["checkout", "--quiet", "main"], work);
      }
      await git(["push", "--quiet", bare, "main"], work);
      // The lane's rules from here on: the repository's own history came before them.
      await writeFile(join(bare, "hooks", "pre-receive"), `#!/bin/sh
while read old new ref; do
  case "$ref" in refs/heads/caveman/*) ;; *) echo "push to $ref refused: caveman/* branches only" >&2; exit 1;; esac
  [ "$new" = 0000000000000000000000000000000000000000 ] && { echo "deleting $ref refused" >&2; exit 1; }
done
exit 0
`, { mode: 0o755 });
      repos.add(`${owner}/${name}`);
      return bare;
    },
    /** The bare repository's branches: name -> commit subject. */
    async branches(owner: string, name: string): Promise<Record<string, string>> {
      const bare = join(root, owner, `${name}.git`);
      const out = await new Promise<string>((done, fail) => {
        const child = spawn("git", ["for-each-ref", "--format=%(refname:short)\t%(subject)", "refs/heads"], { cwd: bare, env, stdio: ["ignore", "pipe", "ignore"] });
        let text = "";
        child.stdout!.on("data", (chunk: Buffer) => (text += chunk.toString()));
        child.once("error", fail);
        child.once("close", () => done(text));
      });
      return Object.fromEntries(out.split("\n").filter((line) => line !== "").map((line) => line.split("\t") as [string, string]));
    },
    close: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}
