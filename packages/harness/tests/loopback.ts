/**
 * A two-request run through runHarness and pi-ai's real Responses provider
 * against a loopback server: request 1 answers with encrypted reasoning and one
 * tool call (bash `echo hi` on the compact surface, an exec cell running it on
 * the exec surface), request 2 with "Done.". Returns the raw request bodies.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnv } from "../src/env/local.ts";
import type { Loadout } from "../src/loadout.ts";
import { runHarness, type RunOptions } from "../src/run.ts";
import type { RunResult } from "../src/trace.ts";

const sse = (events: [string, object][]) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");

export interface LoopbackRun {
  bodies: string[];
  result: RunResult;
  cwd: string;
}

export async function loopbackRun(loadout: Loadout, options: { prompt?: string; cwd?: string; command?: string; extra?: Partial<RunOptions> } = {}): Promise<LoopbackRun> {
  const command = options.command ?? "echo hi";
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
        if (loadout.surface === "exec") {
          const script = `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)} }); text(r.output);`;
          const call = { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "" };
          events.push(
            ["response.output_item.added", { output_index: 1, item: call }],
            ["response.custom_tool_call_input.done", { output_index: 1, item_id: "ctc_1", input: script }],
            ["response.output_item.done", { output_index: 1, item: { ...call, input: script, status: "completed" } }],
          );
        } else {
          const args = JSON.stringify({ command });
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
      const usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: n === 1 ? 0 : 80 }, output_tokens_details: { reasoning_tokens: 7 } };
      events.push(["response.completed", { response: { id: `resp_${n}`, status: "completed", usage } }]);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(events));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "harness-loopback-")));
  writeFileSync(join(cwd, "a.txt"), "x\n");
  const env = new LocalEnv({ cwd });
  process.env.LOOPBACK_WIRE_KEY = "sk-test";
  try {
    const result = await runHarness({
      prompt: options.prompt ?? "Say hi.", model: "openai/gpt-6.1-sol", effort: "high", loadout, env,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LOOPBACK_WIRE_KEY" },
      ...options.extra,
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.equal(bodies.length, 2);
    return { bodies, result, cwd };
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
}
