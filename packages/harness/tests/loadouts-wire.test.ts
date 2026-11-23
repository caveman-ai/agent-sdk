/**
 * The built-in loadouts on the wire: each one runs a two-request turn (a tool
 * call carrying encrypted reasoning, then an answer) through runHarness and
 * pi-ai's real Responses provider against a loopback server, at
 * openai/gpt-6.1-sol effort high, and the captured request bodies are checked:
 * - compact-v0 (Pi's default wire): `reasoning.effort` pinned to medium plus a
 *   `configuration_update` item carrying high on every request;
 * - compact-v0-plain and exec-v0 (the plain wire): `reasoning.effort` high,
 *   no `configuration_update` item, `reasoning.context` all_turns, no
 *   `reasoning.summary`; the encrypted reasoning is still carried.
 * And the prompt prefix is the same on every trial: two runs of one task in
 * envs with different ids (a container per trial) send byte-identical
 * first requests apart from the per-run prompt_cache_key.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, loadLoadout } from "../src/loadout.ts";
import { runHarness } from "../src/run.ts";

const sse = (events: [string, object][]) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");
const items = (body: Record<string, any>, type: string) => (body.input as { type?: string }[]).filter((item) => item.type === type);

/**
 * The request bodies of one run of `name` (compact: a bash call; exec: an exec cell), then a final answer. `envId`
 * stands in for a remote env's per-trial id; `cwd` is the task's workdir (the same on every trial).
 */
async function bodiesOf(name: string, trial: { envId?: string; cwd?: string } = {}): Promise<Record<string, any>[]> {
  const loadout = loadLoadout(name);
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
          const script = 'const r = await tools.exec_command({ cmd: "echo hi" }); text(r.output);';
          const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "" };
          events.push(
            ["response.output_item.added", { output_index: 1, item: call }],
            ["response.custom_tool_call_input.delta", { output_index: 1, item_id: "ctc_1", delta: script }],
            ["response.custom_tool_call_input.done", { output_index: 1, item_id: "ctc_1", input: script }],
            ["response.output_item.done", { output_index: 1, item: { ...call, input: script, status: "completed" } }],
          );
        } else {
          const args = JSON.stringify({ command: "echo hi" });
          const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" };
          events.push(
            ["response.output_item.added", { output_index: 1, item: call }],
            ["response.function_call_arguments.delta", { output_index: 1, item_id: "fc_1", delta: args }],
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
  const root = trial.cwd ?? mkdtempSync(join(tmpdir(), "harness-loadout-wire-"));
  writeFileSync(join(root, "a.txt"), "x\n");
  const env = new LocalEnv({ cwd: root });
  if (trial.envId !== undefined) Object.defineProperty(env, "id", { value: trial.envId });
  process.env.LOADOUT_WIRE_KEY = "sk-test";
  try {
    const result = await runHarness({
      prompt: "Say hi.", model: "openai/gpt-6.1-sol", effort: "high", loadout, env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LOADOUT_WIRE_KEY" },
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.equal(result.tools.calls, 1, JSON.stringify(result.tools));
    assert.equal(bodies.length, 2);
    return bodies;
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
}

test("compact-v0 keeps Pi's wire: reasoning.effort medium plus a configuration_update item at high on every request", async () => {
  for (const body of await bodiesOf("compact-v0")) {
    assert.equal(body.reasoning.effort, "medium");
    const updates = items(body, "configuration_update").map((item: any) => item.reasoning?.effort);
    assert.ok(updates.length >= 1 && updates.every((effort) => effort === "high"), JSON.stringify(updates));
    assert.equal(body.reasoning.context, undefined);
    assert.equal(body.reasoning.summary, "auto", "Pi's default summary");
  }
});

for (const name of ["compact-v0-plain", "exec-v0"]) {
  test(`${name} sends the plain wire: reasoning.effort high, no configuration_update item, all_turns, no summary`, async () => {
    const bodies = await bodiesOf(name);
    for (const body of bodies) {
      assert.deepEqual(body.reasoning, { effort: "high", context: "all_turns" });
      assert.equal(items(body, "configuration_update").length, 0, JSON.stringify(body.input.map((item: any) => item.type ?? item.role)));
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      assert.equal(body.store, false);
    }
    assert.deepEqual(items(bodies[1]!, "reasoning").map((item: any) => item.encrypted_content), ["enc-1"], "encrypted reasoning is carried to the next request");
  });
}

test("the plain loadouts share one wire; compact-v0-plain is compact-v0 with only the wire changed", () => {
  const compact = BUILTIN_LOADOUTS["compact-v0"] as Record<string, any>;
  const plain = BUILTIN_LOADOUTS["compact-v0-plain"] as Record<string, any>;
  const exec = BUILTIN_LOADOUTS["exec-v0"] as Record<string, any>;
  const plainWire = { cache_retention: "short", max_retries: 3, mid_convo_effort: false, reasoning_context: "all_turns", reasoning_summary: "none" };
  assert.deepEqual(plain.wire, plainWire);
  assert.deepEqual(exec.wire, plainWire);
  assert.deepEqual({ ...plain, name: compact.name, wire: compact.wire }, compact);
  assert.equal(exec.surface, "exec");
});

test("the prompt prefix is the same on every trial: the env id never reaches the model", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-prefix-")));
  for (const name of ["compact-v0", "compact-v0-plain", "exec-v0"]) {
    const first = async (envId: string) => {
      const body = (await bodiesOf(name, { envId, cwd }))[0]!;
      assert.match(body.prompt_cache_key, /^[0-9a-f-]{36}$/u, "the cache key is the run's session id");
      delete body.prompt_cache_key;
      return JSON.stringify(body);
    };
    const one = await first("docker:trial-one");
    const two = await first("docker:trial-two");
    assert.equal(one, two, `${name}: the first request differs between trials`);
    assert.doesNotMatch(one, /trial-one|trial-two|docker:/u);
    assert.match(one, new RegExp(`<env>\\\\ncwd: ${cwd}\\\\nos: ${process.platform}\\\\n</env>`, "u"), "the env block names only the workdir and the OS");
  }
});

/**
 * The built-in loadouts' request bodies, pinned: sha256 of each request of the two-request run above, in a fixed
 * workdir, with what varies by run or host taken out (the per-run prompt_cache_key, the host OS in the env block,
 * the exec surface's wall time). A loadout flag that defaults off must leave all three loadouts' bodies byte for
 * byte as they were; a deliberate change to a built-in loadout updates these and says why.
 */
const PINNED_BODIES: Record<string, string[]> = {
  "compact-v0": ["62d89188f328477d708943f1d7053bd22a15b00707814c5fe5335d2271e203fc", "9d6cc6d7ab970b03c644ca29f3d6d091e5865cca2a2654fe36bb812f2e84a6ca"],
  "compact-v0-plain": ["ab9c0df64149058ca89299255450cf48a87e60dbe01d4d02cc14ae275ee5818e", "f9cc96afc06351df224b6bb5b453c926c0f15e32f7b96db26bcad9b2911629a4"],
  "exec-v0": ["f10b10f7ff1c3512e095e4acd07d16486163453d98e70458015e5f37f44b5873", "f246b65c70d388a0ec7474f56e734264c3fad486c39191df34136f30915b9026"],
};

test("the three built-in loadouts' request bodies are unchanged (pinned sha256 per request)", async () => {
  const cwd = join(tmpdir(), "harness-pinned-wire");
  mkdirSync(cwd, { recursive: true });
  const got: Record<string, string[]> = {};
  for (const name of Object.keys(PINNED_BODIES)) {
    // A docker env id stands in for the trial's: it never reaches the model either.
    got[name] = (await bodiesOf(name, { envId: "docker:harness-trial-main-1", cwd })).map((body) => {
      delete body.prompt_cache_key;
      const text = JSON.stringify(body)
        .replaceAll(`\\nos: ${process.platform}\\n`, "\\nos: linux\\n")
        .replaceAll(cwd, "/work")
        .replace(/Wall time \d+(\.\d+)? seconds/gu, "Wall time 0 seconds");
      assert.doesNotMatch(text, /harness-trial|docker:/u);
      return createHash("sha256").update(text).digest("hex");
    });
  }
  assert.deepEqual(got, PINNED_BODIES);
});
