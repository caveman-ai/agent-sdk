/**
 * W1 offline: per-request overhead of the transports against the loopback fake
 * (tests/ws-loopback.ts), through pi-ai's real Responses provider:
 * - http: pi-ai's own fetch (every request re-sends the whole input);
 * - ws-full: one socket, every request a full resend (wire.ws.incremental false);
 * - ws: one socket, prewarm, previous_response_id + new items (the exec-v0-ws arm).
 * A synthetic transcript grows by one tool-sized user turn per request
 * (--turn-bytes) on a system prompt about exec-v0's size (--system-bytes); the
 * modes run interleaved, --reps times each. Reported: client wall per request
 * (stream call to final message) by phase of the run, and bytes put on the
 * wire. Loopback with a fake that JSON-parses what it receives, in-process: it
 * measures the harness side and the cost of moving and parsing the body, not
 * the provider (no model calls).
 * Run: node --experimental-strip-types --no-warnings scripts/ws-overhead.ts [--turns 60] [--reps 5] [--turn-bytes 4096] [--system-bytes 11000]
 */
import { createInitialSystemMessage, type Message } from "@earendil-works/pi-ai";
import { resolveModel } from "../src/models.ts";
import { DEFAULT_WS } from "../src/wire.ts";
import { WsTransport } from "../src/ws.ts";
import { startFakeResponses } from "../tests/ws-loopback.ts";

const flag = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const turns = flag("turns", 60);
const reps = flag("reps", 5);
const turnBytes = flag("turn-bytes", 4096);
const systemBytes = flag("system-bytes", 11_000);
const MODES = ["http", "ws-full", "ws"] as const;
type Mode = (typeof MODES)[number];

const filler = (bytes: number, seed: number) => {
  const words = ["src/app.py", "def handle(self):", "PASSED", "tests/test_core.py::test_case", "return value", "import os", "line"];
  let text = "";
  for (let index = 0; text.length < bytes; index++) text += `${words[(index * 7 + seed) % words.length]} ${index}\n`;
  return text.slice(0, bytes);
};
const user = (text: string, timestamp: number): Message => ({ role: "user", content: [{ type: "text", text }], timestamp });

async function runOnce(mode: Mode): Promise<{ wall: number[]; bytes: number }> {
  const server = await startFakeResponses(Array.from({ length: turns }, (_, index) => ({ text: `ok ${index}` })));
  process.env.WS_OVERHEAD_KEY = "sk-local";
  const { models, model } = resolveModel("openai/gpt-6.1-sol", { openaiBaseUrl: server.url, apiKeyEnv: "WS_OVERHEAD_KEY" });
  let httpBytes = 0;
  const counting: typeof fetch = (input, init) => {
    if (typeof init?.body === "string") httpBytes += Buffer.byteLength(init.body);
    return fetch(input, init);
  };
  const transport = mode === "http" ? undefined : new WsTransport({ ...DEFAULT_WS, incremental: mode === "ws", prewarm: mode === "ws" }, {
    url: `${server.url}/responses`.replace(/^http/u, "ws"), headers: { authorization: "Bearer sk-local" },
  });
  transport?.connect();
  const messages: Message[] = [createInitialSystemMessage(filler(systemBytes, 1), [])!, user("Fix the failing test in tests/test_core.py.", 1)];
  const wall: number[] = [];
  try {
    for (let turn = 0; turn < turns; turn++) {
      const started = performance.now();
      const stream = models.streamSimple(model, { messages: [...messages] }, {
        apiKey: "sk-local", sessionId: `overhead-${mode}`, reasoning: "high", fetch: transport?.fetch ?? counting,
      });
      const message = await stream.result();
      wall.push(performance.now() - started);
      if (message.stopReason === "error") throw new Error(`${mode} turn ${turn}: ${message.errorMessage}`);
      messages.push(message, user(filler(turnBytes, turn), turn + 2));
    }
  } finally {
    transport?.close();
    await server.close();
  }
  return { wall, bytes: transport === undefined ? httpBytes : transport.summary().bytes_sent };
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const walls: Record<Mode, number[][]> = { http: [], "ws-full": [], ws: [] };
const bytes: Record<Mode, number[]> = { http: [], "ws-full": [], ws: [] };
await runOnce("http"); // warm-up: module loads and JIT, discarded
await runOnce("ws");
for (let rep = 0; rep < reps; rep++) {
  for (const mode of rep % 2 === 0 ? MODES : [...MODES].reverse()) {
    const { wall, bytes: sent } = await runOnce(mode);
    walls[mode].push(wall);
    bytes[mode].push(sent);
  }
}
const phases: [string, number, number][] = [["request 1", 0, 1], ["2-10", 1, 10], [`11-${Math.min(30, turns)}`, 10, 30], [`31-${turns}`, 30, turns]];
const rows = MODES.map((mode) => {
  const perRequest = (from: number, to: number) => median(walls[mode].flatMap((wall) => wall.slice(from, to)));
  const total = median(walls[mode].map((wall) => wall.reduce((sum, ms) => sum + ms, 0)));
  return { mode, ...Object.fromEntries(phases.map(([label, from, to]) => [`${label} ms`, Number(perRequest(from, to).toFixed(2))])), "run total ms": Number(total.toFixed(1)), "bytes sent": median(bytes[mode]) };
});
console.log(`turns=${turns} reps=${reps} turn_bytes=${turnBytes} system_bytes=${systemBytes} node=${process.version}`);
console.table(rows);
