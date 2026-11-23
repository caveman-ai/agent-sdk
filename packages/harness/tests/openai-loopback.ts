/**
 * A scripted OpenAI Responses server on loopback: each request gets the next
 * scripted step (a function call, an exec custom tool call, or a text answer),
 * every response carries an encrypted reasoning item, and every request body
 * is captured. runScripted drives runHarness through pi-ai's real Responses
 * provider against it, so tests see exactly what the provider would receive.
 */
import { createServer } from "node:http";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalEnv } from "../src/env/local.ts";
import type { Loadout } from "../src/loadout.ts";
import type { Effort } from "../src/models.ts";
import type { Budgets } from "../src/policy.ts";
import { runHarness, type RunOptions } from "../src/run.ts";

export type Step = { tool: string; args: Record<string, unknown> } | { exec: string } | { text: string };
export type Body = Record<string, any>;

const sse = (events: [string, object][]) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");

export function eventsOf(step: Step, n: number): [string, object][] {
  const events: [string, object][] = [["response.created", { response: { id: `resp_${n}`, status: "in_progress" } }]];
  const reasoning = { type: "reasoning", id: `rs_${n}`, summary: [], encrypted_content: `enc-${n}` };
  events.push(["response.output_item.added", { output_index: 0, item: reasoning }], ["response.output_item.done", { output_index: 0, item: reasoning }]);
  if ("exec" in step) {
    const call = { type: "custom_tool_call", id: `ctc_${n}`, call_id: `call_${n}`, name: "exec", input: "" };
    events.push(
      ["response.output_item.added", { output_index: 1, item: call }],
      ["response.custom_tool_call_input.delta", { output_index: 1, item_id: call.id, delta: step.exec }],
      ["response.custom_tool_call_input.done", { output_index: 1, item_id: call.id, input: step.exec }],
      ["response.output_item.done", { output_index: 1, item: { ...call, input: step.exec, status: "completed" } }],
    );
  } else if ("tool" in step) {
    const args = JSON.stringify(step.args);
    const call = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: step.tool, arguments: "" };
    events.push(
      ["response.output_item.added", { output_index: 1, item: call }],
      ["response.function_call_arguments.delta", { output_index: 1, item_id: call.id, delta: args }],
      ["response.function_call_arguments.done", { output_index: 1, item_id: call.id, arguments: args }],
      ["response.output_item.done", { output_index: 1, item: { ...call, arguments: args, status: "completed" } }],
    );
  } else {
    const message = { type: "message", id: `msg_${n}`, role: "assistant", status: "in_progress", content: [] };
    events.push(
      ["response.output_item.added", { output_index: 1, item: message }],
      ["response.output_text.delta", { output_index: 1, item_id: message.id, content_index: 0, delta: step.text }],
      ["response.output_item.done", { output_index: 1, item: { ...message, status: "completed", content: [{ type: "output_text", text: step.text, annotations: [] }] } }],
    );
  }
  events.push(["response.completed", { response: { id: `resp_${n}`, status: "completed", usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } }]);
  return events;
}

export interface ScriptedRun {
  bodies: Body[];
  result: Awaited<ReturnType<typeof runHarness>>;
  cwd: string;
  tracePath: string;
}

/** Runs `loadout` against the scripted steps (past the last step the server answers "Done."). */
export async function runScripted(loadout: Loadout, steps: Step[], options: {
  cwd?: string; effort?: Effort; prompt?: string; budgets?: Budgets; setup?: (cwd: string) => void;
  /** trace.finish_snapshot options and the result path (snapshot tests), and the env to run in (default LocalEnv). */
  finishSnapshot?: RunOptions["finishSnapshot"]; resultPath?: string; makeEnv?: (cwd: string) => LocalEnv;
} = {}): Promise<ScriptedRun> {
  const bodies: Body[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const n = bodies.length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(eventsOf(steps[n - 1] ?? { text: "Done." }, n)));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const cwd = options.cwd ?? realpathSync(mkdtempSync(join(tmpdir(), "harness-loopback-")));
  options.setup?.(cwd);
  const env = options.makeEnv?.(cwd) ?? new LocalEnv({ cwd });
  const tracePath = join(mkdtempSync(join(tmpdir(), "harness-loopback-trace-")), "trace.jsonl");
  process.env.LOOPBACK_KEY = "sk-test";
  try {
    const result = await runHarness({
      prompt: options.prompt ?? "Make check.sh pass.", model: "openai/gpt-6.1-sol", effort: options.effort ?? "high", loadout, env, tracePath,
      modelOptions: { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LOOPBACK_KEY" },
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      ...(options.finishSnapshot === undefined ? {} : { finishSnapshot: options.finishSnapshot }),
      ...(options.resultPath === undefined ? {} : { resultPath: options.resultPath }),
    });
    return { bodies, result, cwd, tracePath };
  } finally {
    server.closeAllConnections();
    server.close();
    await env.close();
  }
}

/** A request body with its per-run noise replaced: the cache key, the workdir, scratch paths and exec wall times. */
export function stableBody(body: Body, cwd: string): Body {
  const text = JSON.stringify({ ...body, prompt_cache_key: body.prompt_cache_key === undefined ? undefined : "<key>" })
    .replaceAll(cwd, "<cwd>")
    .replace(/harness-run-[A-Za-z0-9]+/gu, "harness-run-<id>")
    .replace(/Wall time \d+(?:\.\d+)? seconds/gu, "Wall time <s> seconds")
    .replace(/(\\*"wall_time_seconds\\*":\s*)-?\d+(?:\.\d+)?/gu, "$1<s>");
  return JSON.parse(text) as Body;
}

/** The input items of a request as compact labels (type or role), for prefix checks. */
export const inputOf = (body: Body): unknown[] => body.input as unknown[];

/** True when every input item of `earlier` appears unchanged, in order, at the start of `later`'s input. */
export function isPrefix(earlier: Body, later: Body): boolean {
  const a = inputOf(earlier);
  const b = inputOf(later);
  if (b.length < a.length) return false;
  return a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]));
}

/** The compact surface's check scenario: write a failing check, see it fail, fix, see it pass, finish with a hedge. */
export const COMPACT_SCENARIO: Step[] = [
  { tool: "write", args: { path: "check.sh", content: "grep -q ok a.txt && echo 'all passed' || { echo '1 failed'; exit 1; }\n" } },
  { tool: "bash", args: { command: "sh check.sh" } },
  { tool: "write", args: { path: "a.txt", content: "ok\n" } },
  { tool: "bash", args: { command: "sh check.sh" } },
  { text: "Done. I could not verify the edge cases; TODO: add more tests." },
];

const patch = (path: string, line: string) => `*** Begin Patch\n*** Add File: ${path}\n+${line}\n*** End Patch\n`;

/** The same scenario on the exec surface: nested apply_patch and exec_command. */
export const EXEC_SCENARIO: Step[] = [
  { exec: `await tools.apply_patch(${JSON.stringify(patch("check.sh", "grep -q ok a.txt && echo 'all passed' || { echo '1 failed'; exit 1; }"))}); text("written");` },
  { exec: 'const r = await tools.exec_command({ cmd: "sh check.sh" }); text(JSON.stringify(r));' },
  { exec: `await tools.apply_patch(${JSON.stringify("*** Begin Patch\n*** Update File: a.txt\n@@\n-x\n+ok\n*** End Patch\n")}); text("fixed");` },
  { exec: 'const r = await tools.exec_command({ cmd: "sh check.sh" }); text(JSON.stringify(r));' },
  { text: "Done. I could not verify the edge cases; TODO: add more tests." },
];
