/**
 * The library session (src/session.ts), as the app runs it: turns in one conversation (the env block in the first
 * message only), a host's refusal of a direct call and of a call a program makes, nested calls as events with their
 * MCP server, steering after a batch of tool calls, compaction between turns (the summary replaces the conversation and
 * is marked), the exec surface's nested calls under the same hooks, the app loadouts per model, and app-general (the
 * host's tools and instructions only, on any model).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { appLoadoutFor, appLoadouts, usesExecSurface } from "../src/app-loadouts.ts";
import { LocalEnv } from "../src/env/local.ts";
import { loadoutHash } from "../src/loadout.ts";
import type { McpToolHandle } from "../src/mcp.ts";
import { fauxStep, resolveModel } from "../src/models.ts";
import { buildTools } from "../src/run.ts";
import { HarnessSession, isCompactionSummary, type CallInfo, type SessionEvent } from "../src/session.ts";
import { eventsOf, type Body, type Step } from "./openai-loopback.ts";

const root = () => realpathSync(mkdtempSync(join(tmpdir(), "harness-lib-")));

function session(steps: FauxResponseStep[], options: Partial<ConstructorParameters<typeof HarnessSession>[0]> = {}) {
  const resolved = resolveModel("faux/scripted", {}, steps);
  const env = new LocalEnv({ cwd: root() });
  return new HarnessSession({
    model: resolved.model, stream: (model, context, streamOptions) => resolved.models.streamSimple(model, context, { ...streamOptions, apiKey: "faux" }),
    effort: "high", loadout: appLoadouts().claude, env, ...options,
  });
}

const userTexts = (context: TranscriptContext) => context.messages.filter((message) => message.role === "user")
  .map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")));

const handle = (calls: string[]): McpToolHandle => ({
  server: "items", name: "get_item", qualified: "items__get_item", description: "Get one item by id.",
  inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  async call(args) {
    calls.push(JSON.stringify(args));
    return { text: JSON.stringify({ id: args.id, title: `Item ${String(args.id)}` }), isError: false };
  },
  async callRaw(args) {
    return { content: [{ type: "text", text: JSON.stringify({ id: args.id }) }] };
  },
});

test("turns share one conversation; the env block rides in the first message only; usage counts each turn", async () => {
  const seen: string[][] = [];
  const s = session([
    (context) => { seen.push(userTexts(context)); return fauxStep({ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] }); },
    () => fauxStep({ text: "one" }),
    (context) => { seen.push(userTexts(context)); return fauxStep({ text: "two" }); },
  ]);
  try {
    const first = await s.runTurn("first task");
    assert.equal(first.status, "finished", JSON.stringify(first));
    assert.equal(first.finalText, "one");
    assert.equal(first.usage.requests, 2);
    const second = await s.runTurn("second task");
    assert.equal(second.finalText, "two");
    assert.equal(second.usage.requests, 1);
    assert.match(seen[0]![0]!, /^<env>\ncwd: /u);
    assert.match(seen[1]![0]!, /first task/u, "the second turn sees the first");
    assert.equal(seen[1]!.at(-1), "second task", "no env block after the first turn");
    assert.deepEqual(s.messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
    assert.deepEqual(s.toolNames, ["bash", "edit", "read", "wait", "write"], "no program tool without MCP tools");
  } finally {
    await s.close();
  }
});

test("a host's refusal stops a direct call and the model reads why; a restored conversation continues", async () => {
  const calls: CallInfo[] = [];
  let resultText = "";
  const s = session([
    () => fauxStep({ toolCalls: [{ name: "write", arguments: { path: "out.txt", content: "x" } }] }),
    (context) => {
      const last = context.messages.at(-1) as { content: { type: string; text?: string }[] };
      resultText = last.content.map((part) => part.text ?? "").join("");
      return fauxStep({ text: "could not write" });
    },
  ], { hooks: { beforeCall: async (call) => { calls.push(call); return call.name === "write" ? "The user declined this edit." : undefined; } } });
  try {
    const outcome = await s.runTurn("write a file");
    assert.equal(outcome.status, "finished");
    assert.equal(calls[0]!.name, "write");
    assert.match(resultText, /The user declined this edit\./u);
    assert.equal(existsSync(join(s.env.cwd, "out.txt")), false);
    const restored = session([(context) => fauxStep({ text: `seen ${userTexts(context).length}` })], { messages: s.messages });
    try {
      const next = await restored.runTurn("again");
      assert.equal(next.finalText, "seen 2");
    } finally {
      await restored.close();
    }
  } finally {
    await s.close();
  }
});

test("a program's MCP and sandbox calls are events with their parent and server, and a refusal throws inside the program", async () => {
  const mcpCalls: string[] = [];
  const events: SessionEvent[] = [];
  const seenBefore: CallInfo[] = [];
  let printed = "";
  const code = "const item = await tools.items__get_item({ id: 7 }); print(item.title);" +
    "try { await bash({ command: 'echo nope' }); } catch (error) { print('refused: ' + error.message); }";
  const s = session([
    () => fauxStep({ toolCalls: [{ name: "program", arguments: { code }, id: "call_p1" }] }),
    (context) => {
      const last = context.messages.at(-1) as { content: { type: string; text?: string }[] };
      printed = last.content.map((part) => part.text ?? "").join("");
      return fauxStep({ text: "done" });
    },
  ], {
    mcp: [handle(mcpCalls)],
    hooks: { beforeCall: async (call) => { seenBefore.push(call); return call.name === "bash" ? "Commands need approval." : undefined; } },
  });
  try {
    assert.ok(s.toolNames.includes("program"));
    const outcome = await s.runTurn("look up item 7", { onEvent: (event) => { if (event.type !== "pi") events.push(event); } });
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.match(printed, /Item 7/u);
    assert.match(printed, /refused: Commands need approval\./u);
    assert.deepEqual(mcpCalls, ['{"id":7}']);
    const mcp = seenBefore.find((call) => call.name === "items__get_item")!;
    assert.equal(mcp.parentId, "call_p1");
    assert.deepEqual(mcp.mcp, { server: "items", tool: "get_item" });
    const starts = events.filter((event) => event.type === "nested_start");
    assert.deepEqual(starts.map((event) => event.type === "nested_start" && event.call.name), ["items__get_item"], "a refused call never starts");
    const end = events.find((event) => event.type === "nested_end");
    assert.ok(end?.type === "nested_end" && !end.isError);
  } finally {
    await s.close();
  }
});

test("steering queued during a turn reaches the model after the tool batch", async () => {
  const seen: string[][] = [];
  let queued: string[] = [];
  const s = session([
    // Queued while the first request runs, as a person types during a turn.
    () => { queued = ["also check the README"]; return fauxStep({ toolCalls: [{ name: "bash", arguments: { command: "true" } }] }); },
    (context) => { seen.push(userTexts(context)); return fauxStep({ text: "ok" }); },
  ]);
  try {
    await s.runTurn("task", { steering: () => { const out = queued; queued = []; return out; } });
    assert.equal(seen[0]!.at(-1), "also check the README");
    assert.deepEqual(s.messages.map((message) => message.role), ["user", "assistant", "toolResult", "user", "assistant"]);
  } finally {
    await s.close();
  }
});

test("past the compaction line the conversation becomes a marked summary before the next message", async () => {
  const seen: string[][] = [];
  const events: SessionEvent[] = [];
  const s = session([
    () => fauxStep({ text: "first answer" }),
    (context) => { seen.push(userTexts(context)); return fauxStep({ text: "the summary" }); },
    (context) => { seen.push(userTexts(context)); return fauxStep({ text: "second answer" }); },
  ], { compactAt: 1e-6 });
  try {
    await s.runTurn("first task");
    const outcome = await s.runTurn("second task", { onEvent: (event) => { if (event.type !== "pi") events.push(event); } });
    assert.equal(outcome.finalText, "second answer");
    assert.match(seen[0]!.at(-1)!, /summary that you write now/u, "the summary is asked on the whole conversation");
    assert.ok(isCompactionSummary(seen[1]![0]!), "the next request starts from the summary");
    assert.match(seen[1]![0]!, /the summary/u);
    assert.equal(seen[1]!.at(-1), "second task");
    assert.ok(events.some((event) => event.type === "compacted"));
    assert.ok(events.some((event) => event.type === "side_usage" && event.kind === "compaction"));
    assert.equal(outcome.usage.requests, 2, "the summary call is billed to the turn");
    assert.deepEqual(s.messages.map((message) => message.role), ["user", "user", "assistant"]);
  } finally {
    await s.close();
  }
});

test("exec cells' nested calls go through the same hooks", async () => {
  const seenBefore: CallInfo[] = [];
  let report = "";
  const s = session([
    () => fauxStep({ toolCalls: [{ name: "exec", arguments: { input: "const r = await tools.exec_command({ cmd: 'echo cell' }); text(r.output);" }, id: "call_x1" }] }),
    (context) => {
      const last = context.messages.at(-1) as { content: { type: string; text?: string }[] };
      report = last.content.map((part) => part.text ?? "").join("");
      return fauxStep({ text: "ok" });
    },
  ], { loadout: appLoadouts().gpt, hooks: { beforeCall: async (call) => { seenBefore.push(call); return undefined; } } });
  try {
    const outcome = await s.runTurn("run it");
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.match(report, /cell/u);
    const nested = seenBefore.find((call) => call.name === "exec_command")!;
    assert.equal(nested.parentId, "call_x1");
  } finally {
    await s.close();
  }
});

test("app loadouts: Codex's exec surface for GPT on a Responses API, the compact surface for everything else", () => {
  assert.equal(usesExecSurface({ api: "openai-responses", id: "gpt-6.1-sol" }), true);
  assert.equal(usesExecSurface({ api: "openai-codex-responses", id: "gpt-6.1-sol" }), true);
  assert.equal(usesExecSurface({ api: "openai-completions", id: "openai/gpt-6.1-sol" }), false);
  assert.equal(usesExecSurface({ api: "anthropic-messages", id: "claude-opus-5-5" }), false);
  assert.equal(appLoadoutFor({ api: "google-generative-ai", id: "gemini-3-pro" }).name, "app-claude");
  const { claude, gpt } = appLoadouts();
  assert.equal(claude.policy.travel_jit, undefined);
  assert.equal(claude.policy.unmet_target, undefined);
  assert.equal(gpt.wire.transport, undefined, "HTTP: the app's egress scrub is an HTTP proxy");
  assert.equal(claude.prompt.sections[0]!.id, "app.identity");
});

test("inside a long turn, past the line the loop goes on from a summary, and the conversation keeps it", async () => {
  const seen: string[][] = [];
  const s = session([
    () => fauxStep({ toolCalls: [{ name: "bash", arguments: { command: "echo work" } }] }),
    (context) => { seen.push(userTexts(context)); return fauxStep({ text: "mid-turn summary" }); },
    (context) => { seen.push(userTexts(context)); return fauxStep({ text: "finished" }); },
  ], { compactAt: 1e-6 });
  try {
    const outcome = await s.runTurn("long task");
    assert.equal(outcome.finalText, "finished");
    assert.ok(isCompactionSummary(seen[1]![0]!), "the request after the summary starts from it");
    assert.equal(seen[1]!.length, 1, "nothing before the summary is sent again");
    assert.deepEqual(s.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(outcome.usage.requests, 3);
  } finally {
    await s.close();
  }
});

test("a conversation from another surface continues: calls of tools this session lacks become text", async () => {
  const sent: unknown[] = [];
  const s = session([(context) => { sent.push(...context.messages); return fauxStep({ text: "continued" }); }], {
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "caveman_code", arguments: { code: "x" } }], timestamp: 2 } as never,
      { role: "toolResult", toolCallId: "t1", toolName: "caveman_code", content: [{ type: "text", text: "42" }], isError: false, timestamp: 3 } as never,
      { role: "assistant", content: [{ type: "text", text: "it is 42" }], timestamp: 4 } as never,
    ],
  });
  try {
    const outcome = await s.runTurn("next");
    assert.equal(outcome.finalText, "continued");
    const roles = s.messages.map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant", "user", "assistant", "user", "assistant"]);
    assert.match(JSON.stringify(s.messages[1]), /\[called caveman_code/u);
    assert.match(JSON.stringify(s.messages[2]), /\[caveman_code returned\] 42/u);
  } finally {
    await s.close();
  }
});

/** A host tool, as the app's Chief declares one. */
function lookupTool(looked: string[]): AgentTool<any> {
  const parameters = Type.Object({ name: Type.String() });
  const tool: AgentTool<typeof parameters> = {
    name: "lookup_contact", label: "Look up a contact", description: "Find a contact's email address by name.",
    parameters,
    async execute(_id, params) {
      looked.push(params.name);
      return { content: [{ type: "text", text: `${params.name}: ada@example.com` }], details: {} };
    },
  };
  return tool as AgentTool<any>;
}

const CHIEF = "You are the Chief: you keep the user's board and answer about it.";
const systemOf = (context: TranscriptContext) => context.messages[0] as unknown as { role: string; content: string; toolsAdded?: { name: string }[] };

test("app-general: no built-in tool, section or program; the host's tools, MCP tools one each, the coding wire and policy", () => {
  const { general, claude } = appLoadouts();
  assert.equal(general.name, "app-general");
  assert.equal(general.surface, "compact");
  assert.deepEqual(general.tools, {});
  assert.deepEqual(general.prompt.sections, []);
  assert.equal(general.mcp, undefined, "MCP tools are direct: never through a program");
  assert.equal(general.context.env, "user");
  assert.equal(general.policy.tool_execution, "sequential", "a general agent's tools act on the world: in the order written");
  assert.deepEqual(general.policy.loop, claude.policy.loop);
  assert.deepEqual(general.wire, { ...claude.wire, mid_convo_effort: false }, "Anthropic keep-alive at 270 s, short retention, 3 retries; GPT effort sent plain, as app-gpt sends it");
  assert.equal(general.wire.anthropic?.keepalive_s, 270);
  assert.equal(appLoadoutFor({ api: "openai-responses", id: "gpt-6.1-sol" }).name, "app-gpt", "the model never picks app-general");
  assert.notEqual(loadoutHash(general), loadoutHash(claude));
  const env = new LocalEnv({ cwd: root() });
  const built = buildTools(general, env, true, [handle([])]);
  assert.deepEqual(built.tools.map((tool) => tool.name), ["items__get_item"], "an MCP handle is one declared tool, no program tool");
  assert.deepEqual(buildTools(general, env, true).tools, []);
  void env.close();
});

test("app-general: the request carries only the host's tool and instructions, and a turn calls the tool", async () => {
  const looked: string[] = [];
  const seen: TranscriptContext[] = [];
  const s = session([
    (context) => { seen.push(context); return fauxStep({ toolCalls: [{ name: "lookup_contact", arguments: { name: "Ada" } }] }); },
    (context) => { seen.push(context); return fauxStep({ text: "Ada is ada@example.com." }); },
  ], { loadout: appLoadouts().general, tools: [lookupTool(looked)], instructions: `  ${CHIEF}\n` });
  try {
    assert.deepEqual(s.toolNames, ["lookup_contact"]);
    const outcome = await s.runTurn("What is Ada's email?");
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.equal(outcome.finalText, "Ada is ada@example.com.");
    assert.deepEqual(looked, ["Ada"]);
    const system = systemOf(seen[0]!);
    assert.equal(system.role, "system");
    assert.equal(system.content, CHIEF, "the host's instructions are the whole system prompt");
    assert.deepEqual(system.toolsAdded?.map((tool) => tool.name), ["lookup_contact"]);
    assert.equal(userTexts(seen[0]!)[0], `<env>\ncwd: ${s.env.cwd}\nos: ${process.platform}\n</env>\n\nWhat is Ada's email?`);
    assert.match(JSON.stringify(seen[1]!.messages.at(-1)), /ada@example\.com/u);
    assert.deepEqual(s.messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  } finally {
    await s.close();
  }
});

test("app-general: a coding session's calls continue as text; with no host tools or text there is no system message, and compaction works", async () => {
  const restored = session([], {
    loadout: appLoadouts().general,
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }], timestamp: 2 } as never,
      { role: "toolResult", toolCallId: "b1", toolName: "bash", content: [{ type: "text", text: "a.txt" }], isError: false, timestamp: 3 } as never,
      { role: "assistant", content: [{ type: "text", text: "one file" }], timestamp: 4 } as never,
    ],
  });
  assert.deepEqual(restored.toolNames, []);
  assert.match(JSON.stringify(restored.messages[1]), /\[called bash/u, "the built-in's call is text: this session does not declare it");
  assert.match(JSON.stringify(restored.messages[2]), /\[bash returned\] a\.txt/u);
  await restored.close();
  const seen: TranscriptContext[] = [];
  const s = session([
    (context) => { seen.push(context); return fauxStep({ text: "first" }); },
    (context) => { seen.push(context); return fauxStep({ text: "the summary" }); },
    (context) => { seen.push(context); return fauxStep({ text: "second" }); },
  ], { loadout: appLoadouts().general, compactAt: 1e-6 });
  try {
    assert.equal((await s.runTurn("first task")).finalText, "first");
    assert.equal(seen[0]!.messages[0]!.role, "user", "no prompt and no tools: no system message");
    const outcome = await s.runTurn("second task");
    assert.equal(outcome.finalText, "second");
    assert.match(userTexts(seen[1]!).at(-1)!, /summary that you write now/u);
    assert.ok(isCompactionSummary(userTexts(seen[2]!)[0]!));
    assert.equal(outcome.usage.requests, 2, "the summary and the answer");
  } finally {
    await s.close();
  }
});

test("app-general on a GPT Responses model: still only the host's function tool and instructions (no exec surface)", async () => {
  const bodies: Body[] = [];
  const steps: Step[] = [{ tool: "lookup_contact", args: { name: "Ada" } }, { text: "Ada is ada@example.com." }];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(eventsOf(steps[bodies.length - 1] ?? { text: "Done." }, bodies.length).map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join(""));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env.LOOPBACK_KEY = "sk-test";
  const resolved = resolveModel("openai/gpt-6.1-sol", { openaiBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKeyEnv: "LOOPBACK_KEY" });
  assert.equal(usesExecSurface(resolved.model), true, "a model the coding loadouts give Codex's exec surface");
  const looked: string[] = [];
  const s = new HarnessSession({
    model: resolved.model, stream: (model, context, options) => resolved.models.streamSimple(model, context, { ...options, apiKey: resolved.apiKey() }),
    effort: "high", loadout: appLoadouts().general, env: new LocalEnv({ cwd: root() }), tools: [lookupTool(looked)], instructions: CHIEF,
  });
  try {
    const outcome = await s.runTurn("What is Ada's email?");
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.equal(outcome.finalText, "Ada is ada@example.com.");
    assert.deepEqual(looked, ["Ada"]);
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      const input = body.input as Body[];
      // Declared in the request's tools or, on this wire, as an additional_tools item: either way, only the host's.
      const tools = [...((body.tools ?? []) as Body[]), ...input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools as Body[])];
      assert.deepEqual(tools.map((tool) => [tool.type, tool.name]), [["function", "lookup_contact"]]);
      const instructions = input.filter((item) => (item.role === "developer" || item.role === "system") && item.type !== "additional_tools");
      assert.deepEqual(instructions.map((item) => item.content), [CHIEF]);
      assert.equal(body.instructions, undefined);
    }
    const first = (bodies[0]!.input as Body[]).find((item) => item.role === "user")!;
    assert.match(JSON.stringify(first.content), /^\[\{"type":"input_text","text":"<env>\\ncwd: /u);
    assert.ok((bodies[1]!.input as Body[]).some((item) => item.type === "function_call_output"));
  } finally {
    await s.close();
    server.closeAllConnections();
    server.close();
  }
});
