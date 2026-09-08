import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  schema,
  tool,
  agent,
  run,
  stream,
  type AgentDefinition,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../dist/index.js";
import { createCodingAgent, runCodingTurn, startCodingSession } from "../dist/code.js";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  PROGRAMMATIC_TOOL_NAME,
  createProgrammaticToolErrorWrapper,
  createProgrammaticToolRuntime,
  programmaticToolMetadata,
  programmaticToolInstructions,
} from "../dist/programmatic-tools.js";

const execFileAsync = promisify(execFile);

function directDefinitionWithTools(tools: AgentDefinition["tools"]): AgentDefinition {
  const base = createCodingAgent({
    workspace: process.cwd(),
    model: "openai/gpt-5.4",
    toolSet: "pebble-v1",
  });
  return Object.freeze({ ...base.definition, tools: Object.freeze([...tools]) });
}

function localKernelContext(
  definitions: readonly ToolDefinition[],
  parentToolCallId = "test-parent",
): ToolExecutionContext {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return {
    toolCallId: parentToolCallId,
    parentToolCallId,
    async dispatch(name, input, options) {
      const definition = byName.get(name);
      if (definition === undefined) throw new Error(`test_unknown_tool:${name}`);
      return definition.execute(input, options?.signal);
    },
  };
}

function assistant(code: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "code-1",
      name: PROGRAMMATIC_TOOL_NAME,
      arguments: { code },
    }],
    api: "faux",
    provider: "faux",
    model: "faux",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolCallStream(
  selected: Model<Api>,
  code: string,
  deltaDelayMs = 0,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const call = fauxToolCall(PROGRAMMATIC_TOOL_NAME, { code }, { id: "code-1" });
  const message = {
    ...fauxAssistantMessage(call),
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  void (async () => {
    if (deltaDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, deltaDelayMs));
    }
    const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
    output.push({ type: "start", partial });
    partial.content = [{ ...call, arguments: {} }];
    output.push({ type: "toolcall_start", contentIndex: 0, partial });
    output.push({ type: "toolcall_delta", contentIndex: 0, delta: code, partial: message });
    output.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
    output.push({ type: "done", reason: "toolUse", message });
    output.end(message);
  })();
  return output;
}

function textStream(selected: Model<Api>, text: string): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const message = {
    ...fauxAssistantMessage(text),
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    output.push({ type: "start", partial: message });
    output.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
    output.push({ type: "done", reason: "stop", message });
    output.end(message);
  });
  return output;
}

function abandonedCodeStream(
  selected: Model<Api>,
  code: string,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const partial = assistant(code);
  const final = {
    ...fauxAssistantMessage("abandoned"),
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    output.push({ type: "start", partial });
    output.push({ type: "toolcall_delta", contentIndex: 0, delta: code, partial });
    output.push({ type: "done", reason: "stop", message: final });
    output.end(final);
  });
  return output;
}

function missingSpeculationIdentityStream(
  selected: Model<Api>,
  code: string,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const finalCall = fauxToolCall(PROGRAMMATIC_TOOL_NAME, { code }, { id: "code-1" });
  const streamedCall = { ...finalCall, id: "" };
  const message = {
    ...fauxAssistantMessage(finalCall),
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    const partial = { ...message, content: [streamedCall], stopReason: "pending" as const };
    output.push({ type: "start", partial });
    output.push({ type: "toolcall_delta", contentIndex: 0, delta: code, partial });
    output.push({ type: "toolcall_end", contentIndex: 0, toolCall: streamedCall, partial });
    output.push({ type: "done", reason: "toolUse", message });
    output.end(message);
  });
  return output;
}

function duplicateSpeculationIdentityStream(
  selected: Model<Api>,
  code: string,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const call = fauxToolCall(PROGRAMMATIC_TOOL_NAME, { code }, { id: "duplicate-id" });
  const message = {
    ...fauxAssistantMessage(call),
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    const partial = { ...message, content: [call, call], stopReason: "pending" as const };
    output.push({ type: "start", partial });
    for (const contentIndex of [0, 1]) {
      output.push({ type: "toolcall_delta", contentIndex, delta: code, partial });
      output.push({ type: "toolcall_end", contentIndex, toolCall: call, partial });
    }
    output.push({ type: "done", reason: "toolUse", message });
    output.end(message);
  });
  return output;
}

function twoCodeCellStream(
  selected: Model<Api>,
  firstCode: string,
  secondCode: string,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const calls = [
    fauxToolCall(PROGRAMMATIC_TOOL_NAME, { code: firstCode }, { id: "code-write" }),
    fauxToolCall(PROGRAMMATIC_TOOL_NAME, { code: secondCode }, { id: "code-read" }),
  ];
  const content = [
    { type: "text" as const, text: "plan" },
    calls[0]!,
    { type: "text" as const, text: "then" },
    calls[1]!,
  ];
  const message = {
    ...fauxAssistantMessage(content),
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    usage: {
      input: 10,
      output: 8,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  queueMicrotask(() => {
    const partial = { ...message, content, stopReason: "pending" as const };
    output.push({ type: "start", partial });
    // Deliberately interleave the later code cell first. Full content ordering,
    // not event arrival order, decides speculation eligibility.
    for (const [contentIndex, code, toolCall] of [
      [3, secondCode, calls[1]!],
      [1, firstCode, calls[0]!],
    ] as const) {
      output.push({ type: "toolcall_delta", contentIndex, delta: code, partial });
      output.push({
        type: "toolcall_end",
        contentIndex,
        toolCall,
        partial,
      });
    }
    output.push({ type: "done", reason: "toolUse", message });
    output.end(message);
  });
  return output;
}

function wrappedStream(
  runtime: ReturnType<typeof createProgrammaticToolRuntime>,
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const models = {
    streamSimple() {
      return source;
    },
  } as unknown as Models;
  const context: Context = {
    messages: [],
    tools: runtime.definition.tools.map((definition) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.input,
    })),
  };
  return runtime.wrapModels(models).streamSimple({} as Model<Api>, context);
}

async function feedCodeStream(
  stream: AssistantMessageEventStream,
  source: AssistantMessageEventStream,
  code: string,
  onDelta?: () => void,
): Promise<void> {
  const message = assistant(code);
  const toolCall = message.content[0];
  if (toolCall?.type !== "toolCall") throw new Error("test_tool_call_missing");
  const iterator = stream[Symbol.asyncIterator]();
  source.push({ type: "start", partial: message });
  await iterator.next();
  source.push({ type: "toolcall_delta", contentIndex: 0, delta: code, partial: message });
  await iterator.next();
  onDelta?.();
  source.push({
    type: "toolcall_end",
    contentIndex: 0,
    toolCall,
    partial: message,
  });
  await iterator.next();
  source.push({ type: "done", reason: "toolUse", message });
  await iterator.next();
  await iterator.return?.();
}

test("coding agent exposes programmatic mode with speculation enabled by default", () => {
  const model = "openai/gpt-5.4";
  const direct = createCodingAgent({ model });
  assert.equal(direct.toolMode, "direct");
  const programmatic = createCodingAgent({ model, toolMode: "programmatic" });
  assert.equal(programmatic.toolMode, "programmatic");
  assert.deepEqual(programmatic.definition.tools.map((item) => item.name), [PROGRAMMATIC_TOOL_NAME]);
  const directInstructions = String(direct.definition.instructions);
  const programmaticInstructions = String(programmatic.definition.instructions);
  assert.equal(
    programmaticInstructions.match(/You are a coding agent working inside one workspace directory\./g)?.length,
    1,
  );
  assert.equal(
    programmaticInstructions.match(/Say what you changed and why\./g)?.length,
    1,
  );
  for (const instructions of [directInstructions, programmaticInstructions]) {
    assert.equal(instructions.match(/<cave-compressed>/g)?.length, 1);
    assert.equal(instructions.match(/\bcave_retrieve\b/g)?.length, 1);
    assert.equal(instructions.match(/\brecovery_handle\b/g)?.length, 1);
    assert.equal(instructions.match(/before guessing/gi)?.length, 1);
  }
  assert.ok(
    Buffer.byteLength(programmaticInstructions) - Buffer.byteLength(directInstructions) <= 700,
  );
  assert.throws(
    () => createCodingAgent({ model, toolMode: "other" as "programmatic" }),
    /coding_tool_mode_invalid:other/,
  );
});

test("programmatic recovery fallback deduplicates only complete appended guidance", () => {
  for (const instructions of [
    programmaticToolInstructions(undefined),
    programmaticToolInstructions("Use cave_retrieve when useful."),
  ]) {
    assert.match(instructions, /<cave-compressed>/);
    assert.match(instructions, /recovery_handle before guessing/i);
  }

  const complete = [
    "Older turns may contain <cave-compressed> markers.",
    "Call cave_retrieve with recovery_handle before guessing.",
  ].join("\n");
  const deduplicated = programmaticToolInstructions(complete);
  assert.equal(deduplicated.match(/<cave-compressed>/g)?.length, 1);
  assert.equal(deduplicated.match(/\bcave_retrieve\b/g)?.length, 1);
  assert.equal(deduplicated.match(/\brecovery_handle\b/g)?.length, 1);
  assert.equal(deduplicated.match(/before guessing/gi)?.length, 1);
});

test("programmatic instructions support one validated branded tool name", () => {
  const additional = "Keep the literal caveman_code compatibility note.";
  const canonical = programmaticToolInstructions(additional);
  const branded = programmaticToolInstructions(additional, { toolName: "pebble_code" });

  assert.equal(
    branded,
    canonical.slice(0, canonical.lastIndexOf("\n\n")).replaceAll(
      PROGRAMMATIC_TOOL_NAME,
      "pebble_code",
    ) + `\n\n${additional}`,
  );
  assert.match(branded, /^Use pebble_code /);
  assert.match(branded, /literal caveman_code compatibility note\.$/);
  assert.throws(
    () => programmaticToolInstructions(undefined, { toolName: "bad name" }),
    /invalid tool name "bad name"/,
  );
});

test("programmatic runtime collapses ordinary tools into one typed code surface", () => {
  const direct = createCodingAgent({
    workspace: process.cwd(),
    model: "openai/gpt-5.4",
    toolSet: "pebble-v1",
  });
  assert.equal(direct.definition.tools.length, 4);
  const runtime = createProgrammaticToolRuntime(direct.definition, {
    instructions: programmaticToolInstructions("project rule"),
  });

  assert.deepEqual(runtime.definition.tools.map((item) => item.name), [PROGRAMMATIC_TOOL_NAME]);
  const providerSchemaBytes = (definition: AgentDefinition) => Buffer.byteLength(JSON.stringify(
    definition.tools.map((item) => ({
      name: item.name,
      description: item.description,
      parameters: item.input,
    })),
  ));
  assert.ok(providerSchemaBytes(runtime.definition) < providerSchemaBytes(direct.definition));
  const description = runtime.definition.tools[0]!.description;
  assert.match(description, /declare function read_file\(args:/);
  assert.match(description, /line.number.*tab|number.*tab/i);
  assert.match(description, /declare function write_file\(args:/);
  assert.match(description, /declare function bash\(args:.*query\?: string/);
  assert.doesNotMatch(description, /"sessionId"|"query"/);
  assert.doesNotMatch(description, /Promise\.all|TypeScript-style/);
  const instructions = runtime.definition.instructions;
  assert.equal(typeof instructions, "string");
  if (typeof instructions !== "string") throw new Error("test_programmatic_instructions_invalid");
  assert.match(instructions, /Promise\.all/);
  assert.match(instructions, /Intermediate tool results stay outside model context/);
  assert.match(instructions, /project rule$/);
  runtime.close();
});

test("programmatic schema prints safe property names compactly and quotes unsafe names", () => {
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({
      safeName: schema.string(),
      "dash-key": schema.optional(schema.string()),
    }),
    effect: "read",
    result: "inline",
    execute: ({ safeName }) => safeName,
  });
  const runtime = createProgrammaticToolRuntime(agent({
    id: "schema-rendering",
    instructions: "test",
    model: "openai/gpt-5.4",
    sandbox: "host",
    tools: [lookup],
  }));
  try {
    assert.match(
      runtime.definition.tools[0]!.description,
      /declare function lookup\(args: \{ safeName: string; "dash-key"\?: string \}\)/,
    );
  } finally {
    runtime.close();
  }
});

test("programmatic runtime supports product-specific provider tool names", () => {
  const direct = createCodingAgent({
    workspace: process.cwd(),
    model: "openai/gpt-5.4",
    toolSet: "pebble-v1",
  });
  const runtime = createProgrammaticToolRuntime(direct.definition, { toolName: "pebble_code" });

  assert.deepEqual(runtime.definition.tools.map((item) => item.name), ["pebble_code"]);
  assert.match(String(runtime.definition.instructions), /Use pebble_code for ordinary tool work/);
  runtime.close();
});

test("trusted error wrapper preserves identity-bound programmatic metadata", async () => {
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    execute: ({ key }) => key,
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]));
  const source = runtime.definition.tools[0]!;
  const target = createProgrammaticToolErrorWrapper(source, (error) => {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`mapped:${message}`, { cause: error });
  });

  assert.equal(programmaticToolMetadata(target), programmaticToolMetadata(source));
  assert.equal(target.name, source.name);
  assert.equal(target.effect, source.effect);
  assert.deepEqual(target.nestedTools, source.nestedTools);
  assert.ok(target.nestedTools?.every((nested, index) => nested === source.nestedTools?.[index]));
  assert.deepEqual(target.speculativeTools, source.speculativeTools);
  assert.throws(
    () => createProgrammaticToolErrorWrapper(lookup, (error) => new Error(String(error))),
    /cave_program_metadata_source_invalid/,
  );
  const wrappedDefinition = Object.freeze({
    ...runtime.definition,
    tools: Object.freeze([target]),
  });
  const faux = fauxProvider();
  const code = 'const value = await lookup({"key":"wrapped"}); print(value);';
  let calls = 0;
  const result = await run(wrappedDefinition, "read through wrapper", {
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn(selected) {
      calls++;
      return calls === 1 ? toolCallStream(selected, code) : textStream(selected, "done");
    },
  });
  assert.equal(result.text, "done");
  assert.deepEqual(result.toolCalls, ["lookup", PROGRAMMATIC_TOOL_NAME]);
  assert.deepEqual(runtime.stats(), { launched: 1, claimed: 1, missed: 0, abandoned: 0 });
  await assert.rejects(
    Promise.resolve(target.execute(
      { code: 'throw new Error("boom")' },
      undefined,
      localKernelContext(target.nestedTools!),
    )),
    /mapped:cave_program_execution_failed:boom/,
  );
  runtime.close();
});

test("nested calls use kernel dispatch and composite does not fake write effect", async () => {
  let directCalls = 0;
  let dispatched = 0;
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    async execute() {
      directCalls++;
      return "raw";
    },
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]), {
    speculate: false,
  });
  const codeTool = runtime.definition.tools[0]!;
  assert.equal(codeTool.effect, "idempotent");
  assert.deepEqual(codeTool.nestedTools?.map((item) => item.name), ["lookup"]);
  const result = await codeTool.execute({
    code: 'const value = await lookup({"key":"x"}); print(value.toUpperCase());',
  }, undefined, {
    toolCallId: "parent-1",
    parentToolCallId: "parent-1",
    async dispatch(name, input, options) {
      dispatched++;
      assert.equal(name, "lookup");
      assert.deepEqual(input, { key: "x" });
      assert.equal(options?.signal?.aborted, false);
      assert.equal(options?.claimSpeculation, undefined);
      return "kernel";
    },
  });

  assert.equal(result, "KERNEL");
  assert.equal(dispatched, 1);
  assert.equal(directCalls, 0, "kernel context must prevent raw definition fallback");
  runtime.close();
});

test("coding session wires speculative programmatic tools without transport plumbing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "caveman-programmatic-session-"));
  try {
    await writeFile(join(workspace, "value.txt"), "session-value\n", "utf8");
    const codingAgent = createCodingAgent({
      workspace,
      model: "openai/gpt-5.4",
      toolSet: "pebble-v1",
      toolMode: "programmatic",
    });
    const session = await startCodingSession(codingAgent, { cave: "off" });
    const faux = fauxProvider();
    const code = 'const value = await read_file({"path":"value.txt"}); print(value);';
    let calls = 0;
    const turn = await runCodingTurn(session, "read value", {
      model: faux.getModel(),
      streamFn(selected) {
        calls++;
        return calls === 1 ? toolCallStream(selected, code) : textStream(selected, "done");
      },
    });

    assert.equal(turn.text, "done");
    assert.deepEqual(turn.toolCalls, ["read_file", PROGRAMMATIC_TOOL_NAME]);
    assert.equal(calls, 2);
    assert.deepEqual(codingAgent.programmaticTools?.stats(), {
      launched: 1,
      claimed: 1,
      missed: 0,
      abandoned: 0,
    });
    codingAgent.programmaticTools?.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("identical skewed streams on concurrent runs cannot cross-claim", async () => {
  let launches = 0;
  let startLeft!: () => void;
  let startRight!: () => void;
  let releaseLeft!: () => void;
  let releaseRight!: () => void;
  const leftStarted = new Promise<void>((resolve) => { startLeft = resolve; });
  const rightStarted = new Promise<void>((resolve) => { startRight = resolve; });
  const leftGate = new Promise<void>((resolve) => { releaseLeft = resolve; });
  const rightGate = new Promise<void>((resolve) => { releaseRight = resolve; });
  const lookup = tool({
    name: "lookup",
    description: "Read one run-local snapshot.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    async execute() {
      const launch = launches++;
      if (launch === 0) {
        startLeft();
        await leftGate;
        return "LEFT";
      }
      startRight();
      await rightGate;
      return "RIGHT";
    },
  });
  const programmatic = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]));
  const faux = fauxProvider();
  const code = 'const value = await lookup({"key":"same"}); print(value);';
  const runOne = (expected: string) => {
    let calls = 0;
    return run(programmatic.definition, expected, {
      ensureRuntime: false,
      model: faux.getModel(),
      streamFn(selected, context) {
        calls++;
        if (calls === 1) return toolCallStream(selected, code);
        const seen = JSON.stringify(context).includes(expected);
        return textStream(selected, seen ? expected : `wrong:${expected}`);
      },
    });
  };

  const left = runOne("LEFT");
  await leftStarted;
  const right = runOne("RIGHT");
  await rightStarted;
  releaseRight();
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseLeft();
  const [leftResult, rightResult] = await Promise.all([left, right]);

  assert.equal(leftResult.text, "LEFT");
  assert.equal(rightResult.text, "RIGHT");
  assert.equal(launches, 2, "each run launches and claims exactly its own read");
  assert.deepEqual(programmatic.stats(), { launched: 2, claimed: 2, missed: 0, abandoned: 0 });
});

test("later code cell in one provider turn cannot pre-read before earlier write", async () => {
  let state = "old";
  let reads = 0;
  const mutate = tool({
    name: "mutate",
    description: "Set state.",
    input: schema.object({ value: schema.string() }),
    effect: "write",
    result: "inline",
    execute({ value }) {
      state = value;
      return "written";
    },
  });
  const lookup = tool({
    name: "lookup",
    description: "Read state.",
    input: schema.object({}),
    effect: "read",
    speculative: true,
    result: "inline",
    execute() {
      reads++;
      return state;
    },
  });
  const programmatic = createProgrammaticToolRuntime(
    directDefinitionWithTools([mutate, lookup]),
  );
  const faux = fauxProvider();
  const writeCode = 'await mutate({"value":"new"}); print("wrote");';
  const readCode = 'const value = await lookup({}); print(value);';
  let providerCalls = 0;
  const result = await run(programmatic.definition, "write then read", {
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn(selected, context) {
      providerCalls++;
      if (providerCalls === 1) return twoCodeCellStream(selected, writeCode, readCode);
      return textStream(
        selected,
        JSON.stringify(context).includes("new") ? "fresh" : "stale",
      );
    },
  });

  assert.equal(result.text, "fresh");
  assert.equal(state, "new");
  assert.equal(reads, 1);
  assert.deepEqual(programmatic.stats(), { launched: 0, claimed: 0, missed: 1, abandoned: 0 });
  assert.deepEqual(result.toolCalls, [
    PROGRAMMATIC_TOOL_NAME,
    "mutate",
    PROGRAMMATIC_TOOL_NAME,
    "lookup",
  ]);
});

test("abandoned streamed read remains visible in receipt accounting", async () => {
  let executions = 0;
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    execute() {
      executions++;
      return "value";
    },
  });
  const programmatic = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]));
  const faux = fauxProvider();
  const code = 'const value = await lookup({"key":"x"}); print(value);';
  const result = await run(programmatic.definition, "abandon", {
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn: (selected) => abandonedCodeStream(selected, code),
  });

  assert.equal(result.text, "abandoned");
  assert.equal(executions, 1);
  assert.deepEqual(result.toolCalls, ["lookup"]);
  assert.deepEqual(result.receipt.tools, [{ name: "lookup", calls: 1, errors: 0 }]);
  assert.deepEqual(programmatic.stats(), { launched: 1, claimed: 0, missed: 0, abandoned: 1 });
});

test("missing streamed provider identity fails closed to a fresh kernel read", async () => {
  let executions = 0;
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    execute() {
      executions++;
      return `value-${executions}`;
    },
  });
  const programmatic = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]));
  const faux = fauxProvider();
  const code = 'const value = await lookup({"key":"x"}); print(value);';
  let providerCalls = 0;
  const result = await run(programmatic.definition, "missing identity", {
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn(selected, context) {
      providerCalls++;
      if (providerCalls === 1) return missingSpeculationIdentityStream(selected, code);
      return textStream(
        selected,
        JSON.stringify(context).includes("value-2") ? "fresh" : "stale",
      );
    },
  });

  assert.equal(result.text, "fresh");
  assert.equal(executions, 2);
  assert.deepEqual(programmatic.stats(), { launched: 1, claimed: 0, missed: 1, abandoned: 1 });
  assert.deepEqual(result.receipt.tools, [
    { name: "lookup", calls: 2, errors: 0 },
    { name: PROGRAMMATIC_TOOL_NAME, calls: 1, errors: 0 },
  ]);
});

test("duplicate streamed provider identity cannot be claimed", async () => {
  let executions = 0;
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    execute() {
      executions++;
      return `value-${executions}`;
    },
  });
  const programmatic = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]));
  const faux = fauxProvider();
  const code = 'const value = await lookup({"key":"x"}); print(value);';
  let providerCalls = 0;
  const result = await run(programmatic.definition, "duplicate identity", {
    ensureRuntime: false,
    model: faux.getModel(),
    streamFn(selected, context) {
      providerCalls++;
      if (providerCalls === 1) return duplicateSpeculationIdentityStream(selected, code);
      return textStream(
        selected,
        JSON.stringify(context).includes("value-2") ? "fresh" : "stale",
      );
    },
  });

  assert.equal(result.text, "fresh");
  assert.equal(executions, 2);
  assert.deepEqual(programmatic.stats(), { launched: 1, claimed: 0, missed: 1, abandoned: 1 });
});

test("speculative launch after run deadline is refused and receipt-visible", async () => {
  let executions = 0;
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    execute() {
      executions++;
      return "value";
    },
  });
  const programmatic = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]));
  const faux = fauxProvider();
  const code = 'const value = await lookup({"key":"x"}); print(value);';
  const events = [];
  for await (const event of stream(programmatic.definition, "deadline", {
    ensureRuntime: false,
    model: faux.getModel(),
    deadlineMs: 5,
    streamFn: (selected) => toolCallStream(selected, code, 20),
  })) {
    events.push(event);
  }

  const terminal = events.at(-1);
  assert.equal(terminal?.type, "run_end");
  if (terminal?.type !== "run_end") throw new Error("test_run_end_missing");
  assert.equal(executions, 0);
  assert.equal(terminal.result.stopReason, "deadline");
  assert.deepEqual(terminal.result.receipt.tools, [
    { name: "lookup", calls: 1, errors: 1 },
    { name: PROGRAMMATIC_TOOL_NAME, calls: 1, errors: 1 },
  ]);
  assert.deepEqual(programmatic.stats(), { launched: 1, claimed: 0, missed: 0, abandoned: 1 });
});

test("one code cell runs multiple tools but returns only selected output", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pebble-code-mode-"));
  try {
    await writeFile(join(workspace, "alpha.txt"), "hidden-alpha\n", "utf8");
    await writeFile(join(workspace, "beta.txt"), "hidden-beta\n", "utf8");
    const direct = createCodingAgent({
      workspace,
      model: "openai/gpt-5.4",
      toolSet: "pebble-v1",
    });
    const runtime = createProgrammaticToolRuntime(direct.definition, { speculate: false });
    const codeTool = runtime.definition.tools[0]!;
    const result = await codeTool.execute({
      code: [
        "const [alpha, beta] = await Promise.all([",
        "  read_file({\"path\":\"alpha.txt\"}),",
        "  read_file({\"path\":\"beta.txt\"})",
        "]);",
        "print(JSON.stringify({ files: 2, alpha: alpha.includes(\"hidden-alpha\"), beta: beta.includes(\"hidden-beta\") }));",
      ].join("\n"),
    }, undefined, localKernelContext(codeTool.nestedTools!));

    assert.equal(typeof result, "string");
    assert.equal(result, '{"files":2,"alpha":true,"beta":true}');
    if (typeof result !== "string") throw new Error("test_code_result_invalid");
    assert.doesNotMatch(result, /1\\thidden-/);
    runtime.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("code cell exposes tool capabilities without Worker globals", async () => {
  const direct = createCodingAgent({
    workspace: process.cwd(),
    model: "openai/gpt-5.4",
    toolSet: "pebble-v1",
  });
  const runtime = createProgrammaticToolRuntime(direct.definition, { speculate: false });
  const codeTool = runtime.definition.tools[0]!;
  const result = await codeTool.execute({
    code: [
      "let escaped = false;",
      "for (const attempt of [",
      "  () => globalThis.constructor.constructor(\"return process\")(),",
      "  () => read_file.constructor(\"return process\")()",
      "]) { try { attempt(); escaped = true; } catch {} }",
      "print(JSON.stringify({ process: typeof process, require: typeof require, fetch: typeof fetch, escaped }));",
    ].join("\n"),
  }, undefined, localKernelContext(codeTool.nestedTools!));

  assert.equal(result, '{"process":"undefined","require":"undefined","fetch":"undefined","escaped":false}');
  runtime.close();
});

test("tool errors are reconstructed in guest realm without Worker capability leakage", async () => {
  const fail = tool({
    name: "fail",
    description: "Always fail.",
    input: schema.object({ reason: schema.string() }),
    effect: "read",
    result: "inline",
    async execute(input) {
      throw new Error(input.reason);
    },
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([fail]), {
    speculate: false,
  });
  const codeTool = runtime.definition.tools[0]!;
  const result = await codeTool.execute({
    code: [
      "let caught;",
      "try { await fail({\"reason\":\"expected\"}); } catch (error) { caught = error; }",
      "let escaped = false;",
      "try { caught.constructor.constructor(\"return process\")(); escaped = true; } catch {}",
      "print(JSON.stringify({ message: caught.message, guestError: caught.constructor === Error, escaped }));",
    ].join("\n"),
  }, undefined, localKernelContext(codeTool.nestedTools!));

  assert.equal(result, '{"message":"expected","guestError":true,"escaped":false}');
  runtime.close();
});

test("cell drains unawaited mutations and surfaces unawaited failures", async () => {
  let releaseWrite!: () => void;
  let markStarted!: () => void;
  let mutated = false;
  const writeStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const slowWrite = tool({
    name: "slow_write",
    description: "Complete one delayed mutation.",
    input: schema.object({ value: schema.string() }),
    effect: "write",
    result: "inline",
    async execute() {
      markStarted();
      await writeGate;
      mutated = true;
      return "written";
    },
  });
  const fail = tool({
    name: "fail",
    description: "Always fail.",
    input: schema.object({ reason: schema.string() }),
    effect: "read",
    result: "inline",
    async execute(input) {
      throw new Error(input.reason);
    },
  });
  const runtime = createProgrammaticToolRuntime(
    directDefinitionWithTools([slowWrite, fail]),
    { speculate: false },
  );
  let settled = false;
  const codeTool = runtime.definition.tools[0]!;
  const kernel = localKernelContext(codeTool.nestedTools!);
  const execution = Promise.resolve(codeTool.execute({
    code: 'slow_write({"value":"next"}); print("cell done");',
  }, undefined, kernel));
  void execution.then(() => { settled = true; }, () => { settled = true; });
  await writeStarted;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "cell must remain open while fire-and-forget write is active");
  assert.equal(mutated, false);
  releaseWrite();
  assert.equal(await execution, "cell done");
  assert.equal(mutated, true, "mutation must finish before cell result settles");

  await assert.rejects(
    Promise.resolve(codeTool.execute({
      code: 'fail({"reason":"unobserved failure"}); print("not success");',
    }, undefined, kernel)),
    /cave_program_execution_failed:unobserved failure/,
  );
  for (const code of [
    'fail({"reason":"then is not recovery"}).then(() => {}); print("not success");',
    'fail({"reason":"finally is not recovery"}).finally(() => {}); print("not success");',
  ]) {
    await assert.rejects(
      Promise.resolve(codeTool.execute({ code }, undefined, kernel)),
      /cave_program_execution_failed:.*not recovery/,
    );
  }
  const recovered = await codeTool.execute({
    code: [
      'let recovered = false;',
      'try { await fail({"reason":"handled"}); } catch { recovered = true; }',
      'print(recovered);',
    ].join("\n"),
  }, undefined, kernel);
  assert.equal(recovered, "true", "observed tool errors remain recoverable inside cell");
  runtime.close();
});

test("cell abort waits for already-dispatched mutation to quiesce", async () => {
  let release!: () => void;
  let markStarted!: () => void;
  let mutated = false;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slowWrite = tool({
    name: "slow_write",
    description: "Ignore cancellation and finish one mutation.",
    input: schema.object({ value: schema.string() }),
    effect: "write",
    result: "inline",
    async execute() {
      markStarted();
      await gate;
      mutated = true;
      return "written";
    },
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([slowWrite]), {
    speculate: false,
  });
  const controller = new AbortController();
  let settled = false;
  const codeTool = runtime.definition.tools[0]!;
  const execution = Promise.resolve(codeTool.execute({
    code: 'await slow_write({"value":"next"}); print("done");',
  }, controller.signal, localKernelContext(codeTool.nestedTools!)));
  void execution.then(() => { settled = true; }, () => { settled = true; });
  await started;
  controller.abort(new Error("test abort"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "abort cannot settle while dispatched write remains active");
  assert.equal(mutated, false);
  release();
  await assert.rejects(execution, /test abort/);
  assert.equal(mutated, true, "caller observes abort only after active mutation settles");
  runtime.close();
});

test("never-settling nested call returns explicit unquiesced failure", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const hang = tool({
    name: "hang",
    description: "Ignore cancellation forever.",
    input: schema.object({}),
    effect: "read",
    result: "inline",
    execute() {
      markStarted();
      return new Promise(() => {});
    },
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([hang]), {
    speculate: false,
  });
  const codeTool = runtime.definition.tools[0]!;
  const controller = new AbortController();
  const execution = Promise.resolve(codeTool.execute(
    { code: "await hang({});" },
    controller.signal,
    localKernelContext(codeTool.nestedTools!),
  ));
  await started;
  controller.abort(new Error("stop"));
  await assert.rejects(execution, /cave_program_nested_calls_unquiesced/);
});

test("parallel agents each retain full eight-call fanout without cross-cell interference", async () => {
  let active = 0;
  let maxActive = 0;
  let started = 0;
  let release!: () => void;
  let allStarted!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedGate = new Promise<void>((resolve) => { allStarted = resolve; });
  const lookup = tool({
    name: "lookup",
    description: "Read one independently keyed value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    async execute(input) {
      active++;
      started++;
      maxActive = Math.max(maxActive, active);
      if (started === 32) allStarted();
      await gate;
      active--;
      return input.key;
    },
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]), {
    speculate: false,
  });
  const codeTool = runtime.definition.tools[0]!;
  const kernel = localKernelContext(codeTool.nestedTools!);
  const executions = Array.from({ length: 4 }, (_, agentIndex) => codeTool.execute({
    code: [
      "const values = await Promise.all([",
      ...Array.from({ length: 8 }, (_unused, callIndex) =>
        `  lookup({"key":"agent-${agentIndex}-call-${callIndex}"})${callIndex === 7 ? "" : ","}`),
      "]);",
      "print(values.length);",
    ].join("\n"),
  }, undefined, kernel));

  await startedGate;
  assert.equal(maxActive, 32, "four cells must run independent eight-call fanouts concurrently");
  release();
  assert.deepEqual(await Promise.all(executions), ["8", "8", "8", "8"]);
  assert.equal(active, 0);
  runtime.close();
});

test("transport wrappers do not speculate outside run kernel", async () => {
  let calls = 0;
  const lookup = tool({
    name: "lookup",
    description: "Read one value.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    speculative: true,
    result: "inline",
    async execute() {
      calls++;
      return "value";
    },
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]));
  const source = createAssistantMessageEventStream();
  const code = 'const value = await lookup({"key":"x"}); print(value);';
  await feedCodeStream(wrappedStream(runtime, source), source, code);
  assert.equal(calls, 0);
  assert.deepEqual(runtime.stats(), { launched: 0, claimed: 0, missed: 0, abandoned: 0 });
});

test("inline ESM parent flags do not break eval Worker startup", async () => {
  const script = [
    'import { createCodingAgent } from "./dist/code.js";',
    'import { createProgrammaticToolRuntime } from "./dist/programmatic-tools.js";',
    'const direct = createCodingAgent({ workspace: process.cwd(), model: "openai/gpt-5.4", toolSet: "pebble-v1" });',
    'const runtime = createProgrammaticToolRuntime(direct.definition, { speculate: false });',
    'const result = await runtime.definition.tools[0].execute({ code: `print("esm-ok")` });',
    'runtime.close();',
    'process.stdout.write(String(result));',
  ].join("\n");
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" },
  );

  assert.equal(stderr, "");
  assert.equal(stdout, "esm-ok");
});

test("tool-bearing direct execution fails closed without kernel context", async () => {
  const lookup = tool({
    name: "lookup",
    description: "Read state.",
    input: schema.object({ key: schema.string() }),
    effect: "read",
    result: "inline",
    async execute() {
      return "value";
    },
  });
  const runtime = createProgrammaticToolRuntime(directDefinitionWithTools([lookup]), {
    speculate: false,
  });
  await assert.rejects(
    Promise.resolve(runtime.definition.tools[0]!.execute({
      code: 'await lookup({"key":"state"});',
    })),
    /cave_program_execution_failed:cave_program_nested_dispatch_unavailable/,
  );
});
