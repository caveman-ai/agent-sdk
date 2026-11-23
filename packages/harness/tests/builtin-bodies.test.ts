/**
 * The built-in loadouts are frozen: every lever is a loadout flag that is off
 * by default, so compact-v0, compact-v0-plain and exec-v0 must send the same
 * request bodies and report the same hashes as before any lever existed. Each
 * runs a two-request turn (one tool call with a command, then an answer)
 * against a loopback Responses server; the captured bodies, with the per-run
 * prompt_cache_key dropped and the temp workdir masked, hash to pinned values
 * taken at v3 a0ebd78. A change here means a default moved.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, canonicalJson, readLoadout, sha256 } from "../src/loadout.ts";
import { runHarness } from "../src/run.ts";

const PINNED: Record<string, { loadout_hash: string; behavior_hash: string; bodies: string }> = {
  "compact-v0": {
    loadout_hash: "742b0fb4250a8fcb3b295920ae1ce05cf256693f7ae5f43f2e25280dbacf3f83",
    behavior_hash: "490f09b0cfbc1c288432b1a4454c50fc46802c0c797a39b2f88aa90eb153f1e8",
    bodies: "d66d0e6cf90be90e114c45cf3f281d43a1c74647bc9e78b6a5d14a078212d4fc",
  },
  "compact-v0-plain": {
    loadout_hash: "0d66e1dfe22e455d05290d5f62d01badf2f4bd682e1a0b467b107a09ef9557fc",
    behavior_hash: "7dd130b7d0a82dff128102c88bff15ca5dd65e4da4f6c770a56b602c701dc692",
    bodies: "3273c246d5032b7b4b2e2c1dc0192938f05731c60855721985f114367e099a42",
  },
  "exec-v0": {
    loadout_hash: "6e1aa5b36f1b3d15d725394276415eaa946635d8ddc0b093ceb3dacb91708baa",
    behavior_hash: "22a50493036fb9faf9d706b05b146f86ba60820995310d6a30d2ed11864a8c02",
    bodies: "8f2dbf5ebc5c05c23f2425ac826a2570fbcb41946b1e688d9991f8db6e0f291f",
  },
};

const sse = (events: [string, object][]) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");

/** A long test-runner-looking output, so a shaper that is wrongly on would change the second body. */
const COMMAND = "for i in $(seq 1 200); do echo \"tests/test_mod.py::test_case_$i PASSED\"; done; echo '==== 200 passed in 1.00s ===='";

async function bodiesOf(name: string): Promise<Record<string, any>[]> {
  const { loadout } = readLoadout(name);
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const n = bodies.length;
      const events: [string, object][] = [["response.created", { response: { id: `resp_${n}`, status: "in_progress" } }]];
      if (n === 1) {
        const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" };
        events.push(["response.output_item.added", { output_index: 0, item: reasoning }], ["response.output_item.done", { output_index: 0, item: reasoning }]);
        if (loadout.surface === "exec") {
          const script = `const r = await tools.exec_command({ cmd: ${JSON.stringify(COMMAND)} }); text(r.output);`;
          const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "" };
          events.push(
            ["response.output_item.added", { output_index: 1, item: call }],
            ["response.custom_tool_call_input.done", { output_index: 1, item_id: "ctc_1", input: script }],
            ["response.output_item.done", { output_index: 1, item: { ...call, input: script, status: "completed" } }],
          );
        } else {
          const args = JSON.stringify({ command: COMMAND });
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), "harness-builtin-bodies-")));
  writeFileSync(join(root, "a.txt"), "x\n");
  const env = new LocalEnv({ cwd: root });
  process.env.BUILTIN_BODIES_KEY = "sk-test";
  try {
    const result = await runHarness({
      prompt: "Run the tests.", model: "openai/gpt-6.1-sol", effort: "high", loadout, env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "BUILTIN_BODIES_KEY" },
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.equal(bodies.length, 2);
    // The exec cell's result carries its wall time; mask it with the workdir and the per-run cache key.
    return JSON.parse(JSON.stringify(bodies).replaceAll(root, "<cwd>").replace(/Wall time [\d.]+ seconds/gu, "Wall time <s> seconds"))
      .map(({ prompt_cache_key: _key, ...body }: Record<string, any>) => body);
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
}

for (const name of Object.keys(BUILTIN_LOADOUTS)) {
  test(`${name} hashes and sends exactly what it did before any lever flag existed`, async () => {
    const pinned = PINNED[name];
    assert.ok(pinned !== undefined, `pin ${name}`);
    const loaded = readLoadout(name);
    const bodies = await bodiesOf(name);
    const actual = { loadout_hash: loaded.loadoutHash, behavior_hash: loaded.behaviorHash, bodies: sha256(canonicalJson(bodies)) };
    assert.deepEqual(actual, pinned, `${name}: ${JSON.stringify(actual)}\n${JSON.stringify(bodies[1]).slice(0, 4000)}`);
  });
}
