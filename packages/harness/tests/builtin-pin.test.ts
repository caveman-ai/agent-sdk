/**
 * The built-in loadouts are frozen: every lever is a loadout flag that is off
 * by default, so compact-v0, compact-v0-plain and exec-v0 must hash and send
 * exactly what they did before the flags existed. The fixture was captured
 * from v3 a0ebd78 (before any lever landed): the loadout_hash and
 * behavior_hash of each built-in, and the request bodies of one two-request
 * run (a tool call, then an answer) against a loopback Responses server, with
 * the per-run prompt_cache_key, the per-run cwd, the host OS and timings
 * masked (the env block names the host platform, so a pin captured on one OS
 * must still hold on another).
 * Regenerate only on purpose: PIN_WRITE=1.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { readLoadout } from "../src/loadout.ts";
import { runHarness } from "../src/run.ts";

const FIXTURE = new URL("./fixtures/builtin-pin.json", import.meta.url);
const NAMES = ["compact-v0", "compact-v0-plain", "exec-v0"] as const;
const sse = (events: [string, object][]) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");

/** The request bodies of one run of a built-in: a tool call (bash or an exec cell running `echo hi`), then "Done.". */
export async function capturedBodies(name: string): Promise<string[]> {
  const surface = readLoadout(name).loadout.surface;
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(raw);
      const n = bodies.length;
      const events: [string, object][] = [["response.created", { response: { id: `resp_${n}`, status: "in_progress" } }]];
      if (n === 1) {
        const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" };
        events.push(["response.output_item.added", { output_index: 0, item: reasoning }], ["response.output_item.done", { output_index: 0, item: reasoning }]);
        if (surface === "exec") {
          const script = 'const r = await tools.exec_command({ cmd: "echo hi" }); text(r.output);';
          const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "" };
          events.push(
            ["response.output_item.added", { output_index: 1, item: call }],
            ["response.custom_tool_call_input.done", { output_index: 1, item_id: "ctc_1", input: script }],
            ["response.output_item.done", { output_index: 1, item: { ...call, input: script, status: "completed" } }],
          );
        } else {
          const args = JSON.stringify({ command: "echo hi" });
          const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" };
          events.push(
            ["response.output_item.added", { output_index: 1, item: call }],
            ["response.function_call_arguments.done", { output_index: 1, item_id: "fc_1", arguments: args }],
            ["response.output_item.done", { output_index: 1, item: { ...call, arguments: args, status: "completed" } }],
          );
        }
      } else {
        const message = { type: "message", id: `msg_${n}`, role: "assistant", status: "in_progress", content: [] };
        events.push(
          ["response.output_item.added", { output_index: 0, item: message }],
          ["response.output_text.delta", { output_index: 0, item_id: message.id, content_index: 0, delta: "Done." }],
          ["response.output_item.done", { output_index: 0, item: { ...message, status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] } }],
        );
      }
      events.push(["response.completed", { response: { id: `resp_${n}`, status: "completed", usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(events));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-pin-")));
  writeFileSync(join(cwd, "a.txt"), "x\n");
  const env = new LocalEnv({ cwd });
  process.env.PIN_WIRE_KEY = "sk-test";
  try {
    const result = await runHarness({
      prompt: "Say hi.", model: "openai/gpt-6.1-sol", effort: "high", loadout: readLoadout(name).loadout, env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "PIN_WIRE_KEY" },
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.equal(bodies.length, 2);
    return bodies.map((raw) => maskBody(raw, cwd));
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
}

/** The per-run parts of a body masked: the session cache key, the run's temp cwd, wall times. */
function maskBody(raw: string, cwd: string): string {
  const body = JSON.parse(raw) as Record<string, unknown>;
  assert.match(String(body.prompt_cache_key), /^[0-9a-f-]{36}$/u);
  body.prompt_cache_key = "<session>";
  return JSON.stringify(body)
    .replaceAll(cwd, "<cwd>")
    .replaceAll(`\\nos: ${process.platform}\\n`, "\\nos: <os>\\n")
    .replace(/(Wall time:? )[0-9.]+( seconds?)/gu, "$1<t>$2")
    .replace(/(wall_time_seconds\\?":)[0-9.]+/gu, "$1<t>");
}

async function snapshot(): Promise<Record<string, { loadout_hash: string; behavior_hash: string; bodies: string[] }>> {
  const out: Record<string, { loadout_hash: string; behavior_hash: string; bodies: string[] }> = {};
  for (const name of NAMES) {
    const loaded = readLoadout(name);
    out[name] = { loadout_hash: loaded.loadoutHash, behavior_hash: loaded.behaviorHash, bodies: await capturedBodies(name) };
  }
  return out;
}

test("the built-in loadouts hash and send exactly what they did before the lever flags", async () => {
  const now = await snapshot();
  if (process.env.PIN_WRITE === "1") writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`);
  const pinned = JSON.parse(readFileSync(FIXTURE, "utf8")) as typeof now;
  for (const name of NAMES) {
    assert.equal(now[name]!.loadout_hash, pinned[name]!.loadout_hash, `${name} loadout_hash`);
    assert.equal(now[name]!.behavior_hash, pinned[name]!.behavior_hash, `${name} behavior_hash`);
    assert.equal(now[name]!.bodies.length, pinned[name]!.bodies.length);
    now[name]!.bodies.forEach((body, index) => assert.equal(body, pinned[name]!.bodies[index], `${name} request ${index + 1}`));
  }
});
