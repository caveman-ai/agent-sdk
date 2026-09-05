import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxProvider as upstreamFauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  createCodingAgent,
  runCodingTurn,
  startCodingSession,
} from "../dist/code.js";
import {
  httpExecutionBackend,
  localExecutionBackend,
} from "../dist/execution-backend.js";

const PRICED_MODEL = "claude-haiku-4-5";

function pricedFauxModel(overrides = {}) {
  const handle = upstreamFauxProvider({ provider: "anthropic" });
  return {
    ...handle.getModel(),
    id: PRICED_MODEL,
    contextWindow: 200_000,
    maxTokens: 4_000,
    ...overrides,
  };
}

function usage(fields = {}) {
  const input = fields.input ?? 10;
  const output = fields.output ?? 2;
  const cacheRead = fields.cacheRead ?? 0;
  const cacheWrite = fields.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: fields.reasoning ?? 0,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pushMessage(selected, content, stopReason, used = usage()) {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant",
    content,
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: used,
    stopReason,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
    stream.push({ type: "done", reason: stopReason, message });
    stream.end(message);
  });
  return stream;
}

function toolCall(id, name, args) {
  return { type: "toolCall", id, name, arguments: args };
}

function missing(path) {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`);
  error.code = "ENOENT";
  return error;
}

function recordingBackend(initial = {}) {
  const calls = [];
  const files = new Map(Object.entries(initial).map(([path, text]) => [
    path,
    Buffer.from(text, "utf8"),
  ]));
  return {
    calls,
    files,
    backend: {
      id: "fixture",
      async exec(request) {
        calls.push({ operation: "exec", request });
        return {
          stdout: request.command === "rg" ? "source.txt:1:needle\n" : "backend bash\n",
          stderr: "",
          code: 0,
          timedOut: false,
          truncated: false,
        };
      },
      async readFile(path) {
        calls.push({ operation: "readFile", path });
        const value = files.get(path);
        if (value === undefined) throw missing(path);
        return value;
      },
      async writeFile(path, data) {
        calls.push({ operation: "writeFile", path, data: Buffer.from(data) });
        files.set(path, Buffer.from(data));
      },
    },
  };
}

function inProcessServerFetch(server) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    const request = Readable.from(init.body === undefined ? [] : [Buffer.from(String(init.body))]);
    request.url = `${url.pathname}${url.search}`;
    request.headers = Object.fromEntries(new Headers(init.headers).entries());
    return await new Promise((accept, reject) => {
      const headers = new Headers();
      const response = {
        statusCode: 200,
        setHeader(name, value) {
          headers.set(name, String(value));
        },
        writeHead(status) {
          this.statusCode = status;
          return this;
        },
        end(body = "") {
          accept(new Response(body, { status: this.statusCode, headers }));
          return this;
        },
      };
      server.emit("request", request, response);
      request.once("error", reject);
    });
  };
}

test("non-local coding turn routes every workspace/process tool through backend only", async () => {
  const hostSentinel = resolve(tmpdir(), `cave-host-sentinel-${randomUUID()}`);
  const workspace = `/remote-workspace-${randomUUID()}`;
  const source = resolve(workspace, "source.txt");
  const created = resolve(workspace, "created.txt");
  const fixture = recordingBackend({ [source]: "needle old\n" });
  const coding = createCodingAgent({
    workspace,
    model: "anthropic/claude-haiku-4-5",
    executionBackend: fixture.backend,
  });
  const scripted = [
    [toolCall("read-1", "read_file", { path: "source.txt" })],
    [toolCall("write-1", "write_file", { path: "created.txt", content: "new\n" })],
    [toolCall("edit-1", "edit_file", {
      path: "source.txt",
      old_string: "old",
      new_string: "edited",
    })],
    [toolCall("grep-1", "grep", { pattern: "needle" })],
    [toolCall("bash-1", "bash", {
      command: `node -e 'require("fs").writeFileSync(${JSON.stringify(hostSentinel)},"bad")'`,
    })],
    [{ type: "text", text: "done" }],
  ];
  const session = await startCodingSession(coding, { cave: "off" });
  const result = await runCodingTurn(session, "exercise every effect", {
    model: pricedFauxModel(),
    streamFn(selected) {
      const content = scripted.shift();
      assert.notEqual(content, undefined);
      const stopReason = content.some((item) => item.type === "toolCall") ? "toolUse" : "stop";
      return pushMessage(selected, content, stopReason);
    },
  });
  assert.equal(result.text, "done");
  assert.deepEqual(result.toolCalls, ["read_file", "write_file", "edit_file", "grep", "bash"]);
  assert.equal(Buffer.from(fixture.files.get(source)).toString("utf8"), "needle edited\n");
  assert.equal(Buffer.from(fixture.files.get(created)).toString("utf8"), "new\n");
  assert.deepEqual(
    new Set(fixture.calls.map((call) => call.operation)),
    new Set(["exec", "readFile", "writeFile"]),
  );
  assert.deepEqual(
    fixture.calls.filter((call) => call.operation === "exec").map((call) => call.request.command),
    ["rg", "sh"],
  );
  const execRequests = fixture.calls.filter((call) => call.operation === "exec");
  assert.deepEqual(execRequests.at(-1).request.args.slice(0, 1), ["-c"]);
  for (const { request } of execRequests) {
    assert.equal(Object.hasOwn(request.env, "PATH"), false);
    assert.equal(Object.hasOwn(request.env, "HOME"), false);
    assert.equal(Object.hasOwn(request.env, "PWD"), false);
  }
  assert.equal(fixture.calls.filter((call) => call.operation === "readFile").length, 3);
  assert.equal(fixture.calls.filter((call) => call.operation === "writeFile").length, 2);
  await assert.rejects(() => access(workspace), /ENOENT/);
  await assert.rejects(() => access(hostSentinel), /ENOENT/);
  await coding.close();
});

test("remote rg start failure falls back to grep and process streams stay separated", async () => {
  const calls = [];
  const backend = {
    id: "fallback-fixture",
    async exec(request) {
      calls.push(request);
      if (request.command === "rg") {
        return { stdout: "", stderr: "missing", code: 127, timedOut: false, truncated: false };
      }
      if (request.command === "grep") {
        return { stdout: "match", stderr: "warning", code: 0, timedOut: false, truncated: false };
      }
      return { stdout: "out", stderr: "err", code: 0, timedOut: false, truncated: false };
    },
    async readFile() { throw missing("unused"); },
    async writeFile() {},
  };
  const coding = createCodingAgent({
    workspace: "/remote",
    model: "anthropic/claude-haiku-4-5",
    executionBackend: backend,
  });
  try {
    const tools = Object.fromEntries(coding.definition.tools.map((tool) => [tool.name, tool]));
    assert.match(await tools.grep.execute({ pattern: "match" }), /^match\nwarning$/);
    assert.match(await tools.bash.execute({ command: "ignored" }), /^exit 0\nout\nerr$/);
    assert.deepEqual(calls.map((request) => request.command), ["rg", "grep", "sh"]);
  } finally {
    await coding.close();
  }
});

test("non-local backend refuses explicitly configured command sessions at construction", () => {
  const fixture = recordingBackend();
  assert.throws(
    () => createCodingAgent({
      workspace: "/remote",
      model: "anthropic/claude-haiku-4-5",
      executionBackend: fixture.backend,
      commandSessions: true,
    }),
    /cave_execution_backend_command_sessions_local_only/,
  );
});

test("http backend round-trips exec/read/write, enforces bearer auth, and caps output", async () => {
  const files = new Map([["/workspace/input.txt", Buffer.from("hello")]]);
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const input = JSON.parse(Buffer.concat(body).toString("utf8") || "{}");
    requests.push({ url: request.url, authorization: request.headers.authorization, input });
    if (request.headers.authorization !== "Bearer correct-token") {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.setHeader("content-type", "application/json");
    if (request.url === "/exec") {
      response.end(JSON.stringify({
        stdout: "123456789",
        stderr: "stderr-must-be-cut",
        code: 0,
        timedOut: false,
        truncated: false,
      }));
      return;
    }
    if (request.url === "/read") {
      if (input.path === "/workspace/directory") {
        response.writeHead(422).end(JSON.stringify({ error: "not_a_file" }));
        return;
      }
      if (input.path === "/workspace/escape") {
        response.writeHead(403).end(JSON.stringify({ error: "path_escapes_workspace" }));
        return;
      }
      const data = files.get(input.path);
      if (data === undefined) {
        response.writeHead(404).end(JSON.stringify({ error: "missing" }));
        return;
      }
      response.end(JSON.stringify({ data: data.toString("base64") }));
      return;
    }
    if (request.url === "/write") {
      files.set(input.path, Buffer.from(input.data, "base64"));
      response.end("{}");
      return;
    }
    response.writeHead(404).end("{}");
  });
  const fetch = inProcessServerFetch(server);
  try {
    const url = "http://127.0.0.1";
    const backend = httpExecutionBackend({ url, token: "correct-token", fetch });
    const read = await backend.readFile("/workspace/input.txt");
    assert.equal(Buffer.from(read).toString("utf8"), "hello");
    await backend.writeFile("/workspace/output.txt", Buffer.from("written"));
    assert.equal(files.get("/workspace/output.txt").toString("utf8"), "written");
    const exec = await backend.exec({
      command: "printf",
      args: ["123456789"],
      cwd: "/workspace",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      maxOutputBytes: 4,
    });
    assert.deepEqual(exec, {
      stdout: "1234",
      stderr: "",
      code: 0,
      timedOut: false,
      truncated: true,
    });
    const { execId, ...execBody } = requests.at(-1).input;
    assert.equal(typeof execId, "string");
    assert.deepEqual(execBody, {
      command: "printf",
      args: ["123456789"],
      cwd: "/workspace",
      env: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      maxOutputBytes: 4,
    });
    const unauthorized = httpExecutionBackend({ url, token: "wrong-token", fetch });
    await assert.rejects(
      () => unauthorized.readFile("/workspace/input.txt"),
      /cave_execution_backend_http_read_failed:401/,
    );
    await assert.rejects(
      () => backend.readFile("/workspace/escape"),
      new Error("caveman-code: path escapes the workspace"),
    );
    await assert.rejects(
      () => backend.readFile("/workspace/directory"),
      (error) => error.code === "EISDIR",
    );
    const coding = createCodingAgent({
      workspace: "/workspace",
      model: "anthropic/claude-haiku-4-5",
      executionBackend: backend,
    });
    const readFileTool = coding.definition.tools.find((tool) => tool.name === "read_file");
    await assert.rejects(
      () => readFileTool.execute({ path: "directory" }),
      new Error("caveman-code: not a file: directory"),
    );
    await coding.close();
  } finally {
    server.close();
  }
});

test("http backend caps streamed responses, maps abort, and refuses insecure remote URLs", async () => {
  let cancelled = false;
  const streamed = httpExecutionBackend({
    url: "http://localhost",
    token: "token",
    fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(5_000)); },
      cancel() { cancelled = true; },
    })),
  });
  await assert.rejects(
    () => streamed.exec({
      command: "x", args: [], cwd: "/workspace", env: {}, timeoutMs: 1_000,
      maxOutputBytes: 1,
    }),
    /cave_execution_backend_http_response_too_large/,
  );
  assert.equal(cancelled, true);

  const aborted = httpExecutionBackend({
    url: "http://localhost",
    token: "token",
    fetch: async () => { throw new DOMException("aborted", "AbortError"); },
  });
  assert.deepEqual(await aborted.exec({
    command: "x", args: [], cwd: "/workspace", env: {}, timeoutMs: 1_000,
    maxOutputBytes: 1,
  }), {
    stdout: "", stderr: "cave_execution_backend_aborted", code: null,
    timedOut: false, truncated: false,
  });
  assert.throws(
    () => httpExecutionBackend({ url: "http://backend.example", token: "token" }),
    /cave_execution_backend_http_insecure_url/,
  );
});

test("http backend posts /cancel with the aborted exec's id", async () => {
  const calls = [];
  const backend = httpExecutionBackend({
    url: "http://localhost",
    token: "token",
    fetch: async (url, init) => {
      const endpoint = new URL(url).pathname.replace(/^\//u, "");
      const body = JSON.parse(init.body);
      calls.push({ endpoint, body });
      if (endpoint === "exec") throw new DOMException("aborted", "AbortError");
      return new Response("{}");
    },
  });
  const result = await backend.exec({
    command: "sleep", args: ["600"], cwd: "/workspace", env: {}, timeoutMs: 600_000,
    maxOutputBytes: 1_024,
  });
  assert.equal(result.stderr, "cave_execution_backend_aborted");
  assert.deepEqual(calls.map((call) => call.endpoint), ["exec", "cancel"]);
  assert.equal(typeof calls[0].body.execId, "string");
  assert.notEqual(calls[0].body.execId, "");
  assert.equal(calls[1].body.execId, calls[0].body.execId);
});

test("http backend swallows a provider that has no /cancel", async () => {
  const backend = httpExecutionBackend({
    url: "http://localhost",
    token: "token",
    fetch: async (url) => {
      if (new URL(url).pathname === "/exec") throw new DOMException("aborted", "AbortError");
      return new Response("not found", { status: 404 });
    },
  });
  assert.equal(
    (await backend.exec({
      command: "x", args: [], cwd: "/workspace", env: {}, timeoutMs: 1_000, maxOutputBytes: 1,
    })).stderr,
    "cave_execution_backend_aborted",
  );
});

test("local backend preserves streams, exit code, and combined output cap", async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), "cave-exec-local-"));
  try {
    const backend = localExecutionBackend();
    const result = await backend.exec({
      command: "sh",
      args: ["-c", "echo out; echo err >&2; exit 3"],
      cwd: workspace,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 1_000,
      maxOutputBytes: 4,
    });
    assert.equal(result.stdout, "out\n");
    assert.equal(result.stderr, "");
    assert.equal(result.code, 3);
    assert.equal(result.truncated, true);
    const failed = await backend.exec({
      command: resolve(workspace, "missing-command"),
      args: [], cwd: workspace, env: {}, timeoutMs: 1_000, maxOutputBytes: 100,
    });
    assert.equal(failed.stdout, "");
    assert.equal(failed.code, 127);
    assert.equal(failed.startFailed, true);
    assert.doesNotMatch(failed.stderr, /cave_execution_backend_spawn_failed/);

    const coding = createCodingAgent({
      workspace,
      model: "anthropic/claude-haiku-4-5",
      executionBackend: localExecutionBackend(),
      commandSessions: false,
    });
    const bash = coding.definition.tools.find((tool) => tool.name === "bash");
    assert.match(
      await bash.execute({ command: "printf out; printf err >&2" }),
      /^exit 0\nout\nerr$/,
    );
    await assert.rejects(
      () => bash.execute({ command: "true", yieldTimeMs: 1 }),
      /cave_execution_backend_command_sessions_disabled/,
    );
    await coding.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
