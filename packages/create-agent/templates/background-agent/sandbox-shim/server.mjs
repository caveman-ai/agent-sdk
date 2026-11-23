// Execution-backend shim. Run this INSIDE the container/microVM/sandbox that
// should own the agent's processes and files, then point CAVE_EXEC_URL at it.
// The contract is in @caveman-ai/agent/docs/execution-backend.md; any container,
// microVM, or sandbox runtime can satisfy it with this much code.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const TOKEN = process.env.CAVE_EXEC_TOKEN;
const ROOT = process.env.CAVE_EXEC_ROOT ?? "/workspace";
if (!TOKEN || TOKEN.length < 16) throw new Error("set CAVE_EXEC_TOKEN (>=16 chars)");

// Containment is this server's job, not the caller's: refuse anything outside
// the workspace root, symlinks included (resolve before you open, in prod).
const contained = (path) => (path + "/").startsWith(ROOT.replace(/\/$/, "") + "/");

const handlers = {
  // `env` is the complete child environment. Never merge ambient secrets in.
  "/exec": (body) => new Promise((done) => {
    execFile(body.command, body.args, {
      cwd: body.cwd, env: body.env, timeout: body.timeoutMs,
      maxBuffer: body.maxOutputBytes, encoding: "utf8",
    }, (error, stdout, stderr) => done({
      stdout, stderr,
      code: error?.code ?? 0,
      timedOut: error?.killed === true && error?.signal === "SIGTERM",
      truncated: error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    }));
  }),
  "/read": async (body) => {
    if (!contained(body.path)) throw Object.assign(new Error("outside root"), { status: 403 });
    const data = await readFile(body.path).catch(() => { throw Object.assign(new Error("no such file"), { status: 404 }); });
    return { data: data.subarray(0, body.maxBytes ?? data.length).toString("base64") };
  },
  "/write": async (body) => {
    if (!contained(body.path)) throw Object.assign(new Error("outside root"), { status: 403 });
    await writeFile(body.path, Buffer.from(body.data, "base64"));
    return {};
  },
  "/prepare": async () => ({}),
};

createServer((request, response) => {
  const send = (status, payload) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  const handler = handlers[request.url];
  if (request.method !== "POST" || !handler) return send(404, { error: "not found" });
  if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    try {
      send(200, await handler(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    } catch (error) {
      send(error.status ?? 500, { error: String(error.message ?? error) });
    }
  });
}).listen(Number(process.env.PORT ?? 8081));
