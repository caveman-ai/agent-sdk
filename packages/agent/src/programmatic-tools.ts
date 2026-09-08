import { Worker } from "node:worker_threads";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "./definition.js";
import { tool, type ToolDefinition, type ToolExecutionContext } from "./primitives.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Models,
} from "@earendil-works/pi-ai";

/** Provider-visible tool replacing an agent's ordinary tool surface in programmatic mode. */
export const PROGRAMMATIC_TOOL_NAME = "caveman_code";

const PROGRAM_MAX_SOURCE_BYTES = 64 * 1024;
const PROGRAM_MAX_OUTPUT_BYTES = 24 * 1024;
const PROGRAM_MAX_TOOL_CALLS = 8;
const PROGRAM_MAX_REPEAT_CALLS = 3;
const PROGRAM_TIMEOUT_MS = 120_000;
const PROGRAM_SYNC_TIMEOUT_MS = 2_000;
const SPECULATION_MAX_INFLIGHT = 4;
const SPECULATION_MAX_DISPATCHES = 8;

const PROGRAMMATIC_CORE_INSTRUCTIONS = [
  `Use ${PROGRAMMATIC_TOOL_NAME} for ordinary tool work. One async code cell can call several typed tools,`,
  "run independent calls with Promise.all, inspect or filter their results locally, and print or return only",
  "the evidence needed for the next model step. Intermediate tool results stay outside model context.",
  "Call each tool with one object argument. Prefer JSON-compatible object literals with double-quoted keys;",
  "Runtime can launch complete literal read calls while the code cell is still streaming.",
  "Writes and external tools are never speculated. Runtime validates every nested call and fails closed.",
  "Concurrent coding agents need separate worktrees; a shared mutable workspace can stale any early read.",
].join("\n");

const PROGRAMMATIC_RECOVERY_INSTRUCTIONS = [
  "Older turns and tool results may contain <cave-compressed> markers. Use cave_retrieve with their",
  "recovery_handle before guessing. cave_retrieve remains a framework tool when recovery is active.",
].join("\n");

function hasCompleteRecoveryGuidance(value: unknown): boolean {
  return typeof value === "string" &&
    value.includes("<cave-compressed>") &&
    value.includes("cave_retrieve") &&
    value.includes("recovery_handle") &&
    /before guessing/i.test(value);
}

const PROGRAMMATIC_WORKER_SOURCE = String.raw`
"use strict";
const { parentPort } = require("node:worker_threads");
const vm = require("node:vm");

let nextCallId = 1;
const pending = new Map();

function format(value) {
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function hostCall(name, args) {
  return new Promise((resolve) => {
    const id = nextCallId++;
    pending.set(id, { resolve });
    try {
      parentPort.postMessage({ type: "tool.call", id, name, args });
    } catch (error) {
      pending.delete(id);
      resolve(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  });
}

parentPort.on("message", async (message) => {
  if (message.type === "tool.result") {
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    request.resolve(JSON.stringify(message.ok
      ? { ok: true, value: message.value }
      : { ok: false, error: message.error }));
    return;
  }
  if (message.type !== "run") return;

  const output = [];
  // Only null-prototype bridges cross realms. User-visible wrappers are then
  // created inside the context, so constructor chains cannot reach Worker
  // globals or bypass tool dispatch.
  const callBridge = (name, argsJSON) => hostCall(name, JSON.parse(argsJSON));
  const printBridge = (value) => output.push(String(value));
  Object.setPrototypeOf(callBridge, null);
  Object.setPrototypeOf(printBridge, null);
  Object.freeze(callBridge);
  Object.freeze(printBridge);
  const sandbox = Object.assign(Object.create(null), {
    __cave_call: callBridge,
    __cave_print: printBridge,
  });
  const context = vm.createContext(sandbox, {
    name: "caveman-programmatic-tools",
    codeGeneration: { strings: false, wasm: false },
  });

  try {
    const bootstrapSource =
      '(() => {' +
      '  const bridge = globalThis.__cave_call;' +
      '  const emit = globalThis.__cave_print;' +
      '  Reflect.deleteProperty(globalThis, "__cave_call");' +
      '  Reflect.deleteProperty(globalThis, "__cave_print");' +
      '  const calls = [];' +
      '  const format = (value) => {' +
      '    if (typeof value === "string") return value;' +
      '    const encoded = JSON.stringify(value);' +
      '    return encoded === undefined ? String(value) : encoded;' +
      '  };' +
      '  const print = (...values) => emit(values.map(format).join(" "));' +
      '  const exposed = Object.create(null);' +
      '  for (const name of ' + JSON.stringify(message.tools) + ') {' +
      '    const fn = (args) => {' +
      '      const promise = (async () => {' +
      '        const envelope = JSON.parse(await bridge(name, JSON.stringify(args)));' +
      '        if (envelope === null || typeof envelope !== "object" || typeof envelope.ok !== "boolean") {' +
      '          throw new Error("cave_program_bridge_protocol_invalid");' +
      '        }' +
      '        if (!envelope.ok) {' +
      '          throw new Error(typeof envelope.error === "string" ? envelope.error : "cave_program_tool_failed");' +
      '        }' +
      '        return envelope.value;' +
      '      })();' +
      '      const record = { promise, observed: false };' +
      '      calls.push(record);' +
      '      void promise.catch(() => undefined);' +
      '      const thenable = Object.create(null);' +
      '      Object.defineProperty(thenable, "then", { value: (yes, no) => {' +
      '        if (typeof no === "function") record.observed = true;' +
      '        return promise.then(yes, no);' +
      '      } });' +
      '      Object.defineProperty(thenable, "catch", { value: (no) => {' +
      '        if (typeof no === "function") record.observed = true;' +
      '        return promise.catch(no);' +
      '      } });' +
      '      Object.defineProperty(thenable, "finally", { value: (done) => promise.finally(done) });' +
      '      Object.defineProperty(thenable, Symbol.toStringTag, { value: "Promise" });' +
      '      return Object.freeze(thenable);' +
      '    };' +
      '    Object.defineProperty(exposed, name, { value: fn, enumerable: true });' +
      '    Object.defineProperty(globalThis, name, { value: fn, enumerable: true });' +
      '  }' +
      '  Object.defineProperty(globalThis, "tools", { value: Object.freeze(exposed) });' +
      '  Object.defineProperty(globalThis, "print", { value: print });' +
      '  const consoleValue = Object.create(null);' +
      '  Object.defineProperty(consoleValue, "log", { value: print, enumerable: true });' +
      '  Object.defineProperty(globalThis, "console", { value: Object.freeze(consoleValue) });' +
      '  const drain = async () => {' +
      '    let cursor = 0;' +
      '    let firstUnobservedFailure;' +
      '    while (cursor < calls.length) {' +
      '      const batch = calls.slice(cursor);' +
      '      cursor = calls.length;' +
      '      const outcomes = await Promise.allSettled(batch.map((record) => record.promise));' +
      '      for (let index = 0; index < outcomes.length; index++) {' +
      '        const outcome = outcomes[index];' +
      '        if (outcome.status === "rejected" && !batch[index].observed && firstUnobservedFailure === undefined) {' +
      '          firstUnobservedFailure = outcome.reason;' +
      '        }' +
      '      }' +
      '    }' +
      '    if (firstUnobservedFailure !== undefined) throw firstUnobservedFailure;' +
      '  };' +
      '  return Object.freeze({ drain });' +
      '})()';
    const lifecycle = new vm.Script(bootstrapSource, { filename: "caveman-code-bootstrap.js" })
      .runInContext(context, { timeout: message.syncTimeoutMs });
    const script = new vm.Script(
      '(async () => { "use strict";\n' + message.code + '\n})()',
      { filename: "caveman-code-cell.js", displayErrors: false },
    );
    const returned = await script.runInContext(context, {
      timeout: message.syncTimeoutMs,
      displayErrors: false,
    });
    await lifecycle.drain();
    if (output.length === 0 && returned !== undefined) output.push(format(returned));
    parentPort.postMessage({ type: "done", output: output.join("\n") || "ok" });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      error: error !== null && typeof error === "object" && typeof error.message === "string"
        ? error.message
        : String(error),
    });
  }
});
`;

export interface ProgrammaticToolStats {
  readonly launched: number;
  readonly claimed: number;
  readonly missed: number;
  readonly abandoned: number;
}

export interface ProgrammaticToolRuntime {
  readonly definition: AgentDefinition;
  wrapModels(models: Models): Models;
  wrapStreamFn(streamFn: StreamFn): StreamFn;
  stats(): ProgrammaticToolStats;
  close(): void;
}

type MutableStats = {
  launched: number;
  claimed: number;
  missed: number;
  abandoned: number;
};

type ParsedInvocation = {
  readonly offset: number;
  readonly name: string;
  readonly args?: Record<string, unknown>;
};

type WorkerToolCall = {
  readonly type: "tool.call";
  readonly id: number;
  readonly name: string;
  readonly args: unknown;
};

type WorkerDone = {
  readonly type: "done";
  readonly output: string;
};

type WorkerError = {
  readonly type: "error";
  readonly error: string;
};

type WorkerMessage = WorkerToolCall | WorkerDone | WorkerError;

export interface ProgrammaticToolInstructionOptions {
  /** Provider-visible composite tool name. Defaults to `caveman_code`. */
  readonly toolName?: string;
}

export function programmaticToolInstructions(
  additional: string | undefined,
  options: ProgrammaticToolInstructionOptions = {},
): string {
  const toolName = options.toolName ?? PROGRAMMATIC_TOOL_NAME;
  validateProgrammaticToolName(toolName);
  return programmaticToolInstructionsFor(toolName, additional);
}

function programmaticToolInstructionsFor(toolName: string, additional: string | undefined): string {
  const standard = hasCompleteRecoveryGuidance(additional)
    ? PROGRAMMATIC_CORE_INSTRUCTIONS
    : `${PROGRAMMATIC_CORE_INSTRUCTIONS}\n\n${PROGRAMMATIC_RECOVERY_INSTRUCTIONS}`;
  const base = toolName === PROGRAMMATIC_TOOL_NAME
    ? standard
    : standard.replaceAll(PROGRAMMATIC_TOOL_NAME, toolName);
  return additional === undefined || additional.trim() === ""
    ? base
    : `${base}\n\n${additional}`;
}

export function createProgrammaticToolRuntime(
  directDefinition: AgentDefinition,
  options: {
    readonly instructions?: string;
    readonly speculate?: boolean;
    readonly toolName?: string;
  } = {},
): ProgrammaticToolRuntime {
  if (directDefinition.sandbox !== "host") {
    throw new Error("cave_programmatic_tools_require_host_sandbox");
  }
  const definitions = [...directDefinition.tools];
  if (definitions.length === 0) throw new Error("cave_programmatic_tools_required");
  if (definitions.some((definition) =>
    definition.runtime !== undefined && definition.runtime.kind !== "subagent"
  )) {
    throw new Error("cave_programmatic_tool_runtime_unsupported");
  }
  const toolName = options.toolName ?? PROGRAMMATIC_TOOL_NAME;
  const counters: MutableStats = { launched: 0, claimed: 0, missed: 0, abandoned: 0 };
  const enabled = options.speculate ?? true;
  const codeTool = createCodeTool(definitions, enabled, counters, toolName);
  const definition = Object.freeze({
    ...directDefinition,
    instructions: options.instructions ?? programmaticToolInstructions(
      typeof directDefinition.instructions === "string" ? directDefinition.instructions : undefined,
      { toolName },
    ),
    tools: Object.freeze([codeTool]),
  });

  return Object.freeze({
    definition,
    wrapModels(models: Models) {
      // Speculation is owned by run(), where provider identity, receipts,
      // deadlines, budgets, breakers and cancellation all exist.
      return models;
    },
    wrapStreamFn(streamFn: StreamFn) {
      return streamFn;
    },
    stats() {
      return Object.freeze({ ...counters });
    },
    close() {},
  });
}

function validateProgrammaticToolName(toolName: string): void {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(toolName)) {
    throw new Error(`caveman agent: invalid tool name ${JSON.stringify(toolName)}`);
  }
}

function createCodeTool(
  definitions: readonly ToolDefinition[],
  speculationEnabled: boolean,
  counters: MutableStats,
  toolName: string,
): ToolDefinition<{ code: string }, string> {
  const speculativeTools = speculationEnabled
    ? definitions.filter((definition) => definition.speculative === true)
      .map((definition) => definition.name)
    : [];
  const definition = tool({
    name: toolName,
    description: codeToolDescription(definitions),
    input: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
    // Nested effects are accounted by kernel dispatch. Composite itself must
    // not fake state change for read-only cells.
    effect: "idempotent",
    result: "inline",
    timeoutMs: PROGRAM_TIMEOUT_MS + 5_000,
    nestedTools: definitions,
    speculativeTools,
    async execute(input, signal, context) {
      if (typeof input.code !== "string" || input.code.trim() === "") {
        throw new Error("cave_program_source_required");
      }
      if (Buffer.byteLength(input.code, "utf8") > PROGRAM_MAX_SOURCE_BYTES) {
        throw new Error("cave_program_source_limit");
      }
      return capProgramOutput(await runProgram(input.code, definitions, signal, context));
    },
  });
  PROGRAMMATIC_METADATA.set(definition, Object.freeze({
    enabled: speculationEnabled && speculativeTools.length > 0,
    toolName,
    definitions: new Map(definitions.map((item) => [item.name, item])),
    speculativeNames: new Set(speculativeTools),
    counters,
  }));
  return definition;
}

function codeToolDescription(definitions: readonly ToolDefinition[]): string {
  const declarations = definitions.map((definition) =>
    `// ${definition.description.replace(/\r?\n/g, "\n// ")}\ndeclare function ${definition.name}(args: ${schemaType(definition.input)}): Promise<string>;`
  );
  return [
    "Bounded async JS cell. Tools are direct functions and under tools.",
    ...declarations,
  ].join("\n");
}

function schemaType(value: unknown, depth = 0): string {
  if (depth > 5 || !isRecord(value)) return "unknown";
  if (Array.isArray(value.anyOf)) {
    return value.anyOf.map((item) => schemaType(item, depth + 1)).join(" | ");
  }
  if (Array.isArray(value.enum)) return value.enum.map((item) => JSON.stringify(item)).join(" | ");
  if ("const" in value) return JSON.stringify(value.const);
  if (value.type === "string") return "string";
  if (value.type === "integer" || value.type === "number") return "number";
  if (value.type === "boolean") return "boolean";
  if (value.type === "null") return "null";
  if (value.type === "array") return `Array<${schemaType(value.items, depth + 1)}>`;
  if (value.type !== "object" || !isRecord(value.properties)) return "unknown";
  const required = new Set(Array.isArray(value.required)
    ? value.required.filter((item): item is string => typeof item === "string")
    : []);
  const fields = Object.entries(value.properties).map(([name, schema]) =>
    `${schemaPropertyName(name)}${required.has(name) ? "" : "?"}: ${schemaType(schema, depth + 1)}`
  );
  return `{ ${fields.join("; ")} }`;
}

function schemaPropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

type ProgrammaticMetadata = {
  readonly enabled: boolean;
  readonly toolName: string;
  readonly definitions: ReadonlyMap<string, ToolDefinition>;
  readonly speculativeNames: ReadonlySet<string>;
  readonly counters: MutableStats;
};

const PROGRAMMATIC_METADATA = new WeakMap<ToolDefinition, ProgrammaticMetadata>();

export interface ProgrammaticSpeculationLaunch {
  readonly parentToolCallId: string;
  readonly turnKey: object;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export interface ProgrammaticSpeculationActivation {
  readonly provisionalParentToolCallId: string;
  readonly turnKey: object;
}

export type ProgrammaticSpeculationDispatch = (
  launch: ProgrammaticSpeculationLaunch,
) => Promise<unknown>;

type KernelSpeculativeBet = {
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  claimed: boolean;
};

/** Internal runtime hook. Metadata identity cannot be forged through JSON. */
export function programmaticToolMetadata(
  definition: ToolDefinition,
): ProgrammaticMetadata | undefined {
  return PROGRAMMATIC_METADATA.get(definition);
}

/** @internal Create the only supported compatibility wrapper for a code tool. */
export function createProgrammaticToolErrorWrapper<TInput, TResult>(
  source: ToolDefinition<TInput, TResult>,
  mapError: (error: unknown) => Error,
): ToolDefinition<TInput, TResult> {
  const metadata = PROGRAMMATIC_METADATA.get(source);
  if (metadata === undefined) throw new Error("cave_program_metadata_source_invalid");
  if (typeof mapError !== "function") throw new Error("cave_program_error_mapper_invalid");
  const nestedTools = source.nestedTools;
  const speculativeTools = source.speculativeTools;
  if (metadata.toolName !== source.name || source.runtime !== undefined ||
      nestedTools === undefined || speculativeTools === undefined ||
      nestedTools.length !== metadata.definitions.size ||
      nestedTools.some((nested) => metadata.definitions.get(nested.name) !== nested) ||
      speculativeTools.length !== metadata.speculativeNames.size ||
      speculativeTools.some((name) => !metadata.speculativeNames.has(name))) {
    throw new Error("cave_program_metadata_source_invalid");
  }
  // Construct through the public primitive so graph validation sees the same
  // non-enumerable implementation provenance as every other trusted tool.
  // The helper itself owns every field: callers can only map the thrown error.
  const target = tool({
    name: source.name,
    description: source.description,
    input: source.input,
    effect: source.effect,
    result: source.artifact ?? source.result,
    ...(source.allowRepeat === undefined ? {} : { allowRepeat: source.allowRepeat }),
    ...(source.speculative === undefined ? {} : { speculative: source.speculative }),
    timeoutMs: source.timeoutMs,
    nestedTools,
    speculativeTools,
    async execute(input, signal, context) {
      try {
        return await source.execute(input as TInput, signal, context);
      } catch (error) {
        let mapped: unknown;
        try {
          mapped = mapError(error);
        } catch (mapperError) {
          throw new Error("cave_program_error_mapper_failed", { cause: mapperError });
        }
        if (!(mapped instanceof Error)) throw new Error("cave_program_error_mapper_invalid");
        throw mapped;
      }
    },
  }) as ToolDefinition<TInput, TResult>;
  PROGRAMMATIC_METADATA.set(target, metadata);
  return target;
}

/**
 * One run's speculation state. It never outlives run(), and claim identity is
 * the conjunction of run scope, provider stream turn, final message object,
 * final provider tool-call ID, and source bytes.
 */
export class ProgrammaticSpeculationScope {
  readonly runId: string;
  readonly parent: ToolDefinition;
  readonly metadata: ProgrammaticMetadata;
  readonly dispatch: ProgrammaticSpeculationDispatch;
  readonly onAbandoned: ((provisionalParentToolCallId: string) => void) | undefined;
  readonly turns = new Set<KernelSpeculationTurn>();
  readonly turnsByMessage = new WeakMap<object, KernelSpeculationTurn>();
  readonly activeByParent = new Map<string, KernelSpeculativeCell>();
  turnSequence = 0;
  closed = false;
  closePromise: Promise<void> | undefined;
  settlementError: Error | undefined;

  constructor(
    runId: string,
    parent: ToolDefinition,
    dispatch: ProgrammaticSpeculationDispatch,
    onAbandoned?: (provisionalParentToolCallId: string) => void,
  ) {
    const metadata = PROGRAMMATIC_METADATA.get(parent);
    if (metadata === undefined || !metadata.enabled) {
      throw new Error("cave_program_speculation_unavailable");
    }
    this.runId = runId;
    this.parent = parent;
    this.metadata = metadata;
    this.dispatch = dispatch;
    this.onAbandoned = onAbandoned;
  }

  wrapStream(source: AssistantMessageEventStream): AssistantMessageEventStream {
    if (this.closed) return source;
    const turn = new KernelSpeculationTurn(this, ++this.turnSequence);
    this.turns.add(turn);
    const iterator = async function* (): AsyncGenerator<AssistantMessageEvent> {
      try {
        for await (const event of source) {
          turn.observe(event);
          if (event.type === "done") {
            turn.bindMessage(event.message);
            if (event.reason !== "toolUse") await turn.close();
          }
          yield event;
        }
      } finally {
        if (turn.message === undefined) await turn.close();
      }
    };
    return new Proxy(source, {
      get(target, property) {
        if (property === Symbol.asyncIterator) return iterator;
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  activate(
    parentToolCallId: string,
    assistantMessage: AssistantMessage,
    code: unknown,
  ): ProgrammaticSpeculationActivation | undefined {
    if (this.closed || typeof code !== "string" || parentToolCallId.trim() === "") return undefined;
    const turn = this.turnsByMessage.get(assistantMessage);
    const cell = turn?.cellsByFinalId.get(parentToolCallId);
    if (turn === undefined || cell === undefined || cell.finalCode !== code ||
        !cell.speculationEligible || cell.closed || cell.activated ||
        turn.duplicateIds.has(parentToolCallId)) {
      return undefined;
    }
    cell.activated = true;
    this.activeByParent.set(parentToolCallId, cell);
    return Object.freeze({
      provisionalParentToolCallId: cell.provisionalParentToolCallId,
      turnKey: turn.turnKey,
    });
  }

  claim(
    parentToolCallId: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> | undefined {
    const cell = this.activeByParent.get(parentToolCallId);
    const bet = cell?.take(name, args);
    if (bet === undefined) {
      this.metadata.counters.missed++;
      return undefined;
    }
    bet.claimed = true;
    this.metadata.counters.claimed++;
    if (signal === undefined) return bet.promise;
    if (signal.aborted) {
      bet.controller.abort(signal.reason);
      return bet.promise;
    }
    const abort = () => bet.controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    return bet.promise.finally(() => signal.removeEventListener("abort", abort));
  }

  async finish(parentToolCallId: string): Promise<void> {
    const cell = this.activeByParent.get(parentToolCallId);
    if (cell === undefined) return;
    this.activeByParent.delete(parentToolCallId);
    await cell.close();
  }

  async settleBeforeNextStream(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const turn of this.turns) {
      if (turn.message === undefined) continue;
      for (const cell of turn.cells.values()) {
        if (!cell.activated) pending.push(cell.close());
      }
      turn.maybeForget();
    }
    await Promise.allSettled(pending);
    if (this.settlementError !== undefined) throw this.settlementError;
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.settleAndClose();
    return this.closePromise;
  }

  private async settleAndClose(): Promise<void> {
    const pending = [...this.turns].map((turn) => turn.close());
    await Promise.allSettled(pending);
    this.activeByParent.clear();
    if (this.settlementError !== undefined) throw this.settlementError;
  }

  forget(turn: KernelSpeculationTurn): void {
    this.turns.delete(turn);
  }

  recordSettlementError(error: unknown): void {
    this.settlementError ??= error instanceof Error ? error : new Error(String(error));
  }
}

class KernelSpeculationTurn {
  readonly scope: ProgrammaticSpeculationScope;
  readonly turnKey: Readonly<{ runId: string; providerStreamTurn: number }>;
  readonly cells = new Map<number, KernelSpeculativeCell>();
  readonly cellsByFinalId = new Map<string, KernelSpeculativeCell>();
  readonly duplicateIds = new Set<string>();
  message: AssistantMessage | undefined;

  constructor(scope: ProgrammaticSpeculationScope, sequence: number) {
    this.scope = scope;
    this.turnKey = Object.freeze({ runId: scope.runId, providerStreamTurn: sequence });
  }

  observe(event: AssistantMessageEvent): void {
    if (event.type !== "toolcall_delta" && event.type !== "toolcall_end") return;
    const call = event.type === "toolcall_end"
      ? event.toolCall
      : event.partial.content[event.contentIndex];
    if (call?.type !== "toolCall" || call.name !== this.scope.metadata.toolName) return;
    const code = call.arguments.code;
    if (typeof code !== "string") return;
    const firstProgrammaticIndex = this.firstProgrammaticContentIndex(
      event.partial.content,
      event.contentIndex,
    );
    let cell = this.cells.get(event.contentIndex);
    if (cell === undefined) {
      cell = new KernelSpeculativeCell(
        this,
        event.contentIndex,
        firstProgrammaticIndex === event.contentIndex,
      );
      this.cells.set(event.contentIndex, cell);
    } else if (firstProgrammaticIndex !== event.contentIndex) {
      cell.speculationEligible = false;
      void cell.close().catch((error) => this.scope.recordSettlementError(error));
    }
    cell.feed(code);
    if (event.type !== "toolcall_end") return;
    const finalId = event.toolCall.id;
    if (typeof finalId !== "string" || finalId.trim() === "") {
      void cell.close().catch((error) => this.scope.recordSettlementError(error));
      return;
    }
    const duplicate = this.cellsByFinalId.get(finalId);
    if (duplicate !== undefined && duplicate !== cell) {
      this.duplicateIds.add(finalId);
      this.cellsByFinalId.delete(finalId);
      void duplicate.close().catch((error) => this.scope.recordSettlementError(error));
      void cell.close().catch((error) => this.scope.recordSettlementError(error));
      return;
    }
    cell.finalCode = code;
    cell.finalId = finalId;
    this.cellsByFinalId.set(finalId, cell);
  }

  bindMessage(message: AssistantMessage): void {
    if (this.message !== undefined && this.message !== message) {
      void this.close().catch((error) => this.scope.recordSettlementError(error));
      return;
    }
    const firstProgrammaticIndex = this.firstProgrammaticContentIndex(message.content);
    for (const cell of this.cells.values()) {
      if (cell.contentIndex === firstProgrammaticIndex) continue;
      cell.speculationEligible = false;
      void cell.close().catch((error) => this.scope.recordSettlementError(error));
    }
    this.message = message;
    this.scope.turnsByMessage.set(message, this);
  }

  private firstProgrammaticContentIndex(
    content: readonly unknown[],
    throughIndex?: number,
  ): number | undefined {
    const last = throughIndex ?? content.length - 1;
    for (let index = 0; index <= last; index++) {
      // A partial stream with an unresolved earlier slot cannot prove which
      // programmatic call is first. Wait for a complete prefix or fail closed.
      if (!(index in content)) return undefined;
      const item = content[index];
      if (isRecord(item) && item.type === "toolCall" &&
          item.name === this.scope.metadata.toolName) {
        return index;
      }
    }
    return undefined;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.cells.values()].map((cell) => cell.close()));
    this.cells.clear();
    this.cellsByFinalId.clear();
    this.scope.forget(this);
    if (this.scope.settlementError !== undefined) throw this.scope.settlementError;
  }

  maybeForget(): void {
    if ([...this.cells.values()].every((cell) => cell.closed)) this.scope.forget(this);
  }
}

class KernelSpeculativeCell {
  readonly turn: KernelSpeculationTurn;
  readonly contentIndex: number;
  readonly provisionalParentToolCallId: string;
  readonly bets = new Map<string, KernelSpeculativeBet[]>();
  readonly dispatchedSites = new Set<string>();
  finalCode: string | undefined;
  finalId: string | undefined;
  speculationEligible: boolean;
  activated = false;
  closed = false;
  closePromise: Promise<void> | undefined;
  dispatches = 0;
  inflight = 0;

  constructor(
    turn: KernelSpeculationTurn,
    contentIndex: number,
    speculationEligible: boolean,
  ) {
    this.turn = turn;
    this.contentIndex = contentIndex;
    this.speculationEligible = speculationEligible;
    this.provisionalParentToolCallId =
      `${turn.scope.runId}:spec:${turn.turnKey.providerStreamTurn}:${contentIndex}`;
  }

  feed(code: string): void {
    if (!this.speculationEligible || this.closed ||
        Buffer.byteLength(code, "utf8") > PROGRAM_MAX_SOURCE_BYTES) return;
    const metadata = this.turn.scope.metadata;
    for (const invocation of parseInvocations(code, metadata.definitions)) {
      const definition = metadata.definitions.get(invocation.name);
      if (definition === undefined ||
          !metadata.speculativeNames.has(definition.name) ||
          definition.effect !== "read" ||
          definition.speculative !== true ||
          invocation.args === undefined ||
          hasEffectfulToolReference(code, invocation.offset, metadata.definitions)) {
        continue;
      }
      const site = `${invocation.offset}:${invocation.name}:${stableJSON(invocation.args)}`;
      if (this.dispatchedSites.has(site)) continue;
      this.dispatchedSites.add(site);
      if (this.dispatches >= SPECULATION_MAX_DISPATCHES ||
          this.inflight >= SPECULATION_MAX_INFLIGHT ||
          !validToolArguments(definition, invocation.args)) {
        continue;
      }
      this.launch(definition, invocation.args);
    }
  }

  launch(definition: ToolDefinition, args: Record<string, unknown>): void {
    const controller = new AbortController();
    this.dispatches++;
    this.inflight++;
    this.turn.scope.metadata.counters.launched++;
    const promise = this.turn.scope.dispatch({
      parentToolCallId: this.provisionalParentToolCallId,
      turnKey: this.turn.turnKey,
      name: definition.name,
      args,
      signal: controller.signal,
    }).finally(() => { this.inflight--; });
    void promise.catch(() => undefined);
    const queue = this.bets.get(speculationKey(definition.name, args)) ?? [];
    queue.push({ controller, promise, claimed: false });
    this.bets.set(speculationKey(definition.name, args), queue);
  }

  take(name: string, args: Record<string, unknown>): KernelSpeculativeBet | undefined {
    return this.bets.get(speculationKey(name, args))?.find((candidate) => !candidate.claimed);
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.settleAndClose();
    return this.closePromise;
  }

  private async settleAndClose(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const queue of this.bets.values()) {
      for (const bet of queue) {
        pending.push(bet.promise);
        if (bet.claimed) continue;
        this.turn.scope.metadata.counters.abandoned++;
        bet.controller.abort(new Error("cave_program_speculation_abandoned"));
      }
    }
    if (!await boundedProgramSettlement(pending)) {
      const error = new Error("cave_program_nested_calls_unquiesced");
      this.turn.scope.recordSettlementError(error);
      throw error;
    }
    if (!this.activated) {
      this.turn.scope.onAbandoned?.(this.provisionalParentToolCallId);
    }
    this.turn.maybeForget();
  }
}

async function boundedProgramSettlement(work: readonly Promise<unknown>[]): Promise<boolean> {
  if (work.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(work).then(() => true as const),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runProgram(
  code: string,
  definitions: readonly ToolDefinition[],
  signal: AbortSignal | undefined,
  context: ToolExecutionContext | undefined,
): Promise<string> {
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const programController = new AbortController();
  const programSignal = signal === undefined
    ? programController.signal
    : AbortSignal.any([signal, programController.signal]);
  const worker = new Worker(PROGRAMMATIC_WORKER_SOURCE, {
    eval: true,
    env: codeWorkerEnvironment(process.env),
    // Do not inherit parent loader, eval, test-runner, or debugging flags.
    // Eval Worker is self-contained and accepts no ambient runtime switches.
    execArgv: [],
    resourceLimits: {
      maxOldGenerationSizeMb: 64,
      maxYoungGenerationSizeMb: 16,
      stackSizeMb: 4,
    },
  });
  let finishRequested = false;
  let settled = false;
  let callCount = 0;
  let effectfulCallSeen = false;
  const repeats = new Map<string, number>();
  const activeCalls = new Set<Promise<void>>();

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("cave_program_timeout")), PROGRAM_TIMEOUT_MS);
    const abort = () => finish(signal?.reason instanceof Error
      ? signal.reason
      : new Error("cave_program_aborted"));
    const finish = (error?: Error, output?: string): void => {
      if (finishRequested) return;
      finishRequested = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // `done` arrives only after the worker drains admitted calls. A settled
      // call may return a runtime-owned handle, such as a yielded command
      // session, whose lifetime must outlive this cell. Only cell failure
      // triggers local cancellation; owner cancellation remains attached.
      if (error !== undefined) {
        programController.abort(error);
        void worker.terminate();
      }
      void (async () => {
        if (!await boundedProgramSettlement([...activeCalls])) {
          programController.abort(new Error("cave_program_nested_calls_unquiesced"));
          settled = true;
          void worker.terminate();
          reject(new Error("cave_program_nested_calls_unquiesced"));
          return;
        }
        settled = true;
        void worker.terminate();
        if (error !== undefined) reject(error);
        else resolve(output ?? "ok");
      })();
    };
    const reply = (id: number, result: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      if (settled) return;
      worker.postMessage({ type: "tool.result", id, ...result });
    };
    const executeCall = async (message: WorkerToolCall): Promise<void> => {
      try {
        callCount++;
        if (callCount > PROGRAM_MAX_TOOL_CALLS) throw new Error("cave_program_tool_call_budget_exceeded");
        const definition = definitionsByName.get(message.name);
        if (definition === undefined) throw new Error(`cave_program_unknown_tool:${message.name}`);
        if (!isRecord(message.args) || !validToolArguments(definition, message.args)) {
          throw new Error(`cave_program_tool_arguments_invalid:${message.name}`);
        }
        const canClaimSpeculation = definition.effect === "read" &&
          definition.speculative === true && !effectfulCallSeen;
        if (definition.effect !== "read") effectfulCallSeen = true;
        const repeatKey = speculationKey(message.name, message.args);
        const repeated = (repeats.get(repeatKey) ?? 0) + 1;
        repeats.set(repeatKey, repeated);
        if (repeated > PROGRAM_MAX_REPEAT_CALLS && definition.allowRepeat !== true) {
          throw new Error("cave_program_repeated_tool_call");
        }
        if (context === undefined) throw new Error("cave_program_nested_dispatch_unavailable");
        const pending = context.dispatch(message.name, message.args, {
          signal: programSignal,
          ...(canClaimSpeculation ? { claimSpeculation: true } : {}),
        });
        reply(message.id, { ok: true, value: serializableValue(await pending, definition.name) });
      } catch (error) {
        reply(message.id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    worker.on("message", (value: WorkerMessage) => {
      if (!isRecord(value) || typeof value.type !== "string") {
        finish(new Error("cave_program_worker_protocol_invalid"));
        return;
      }
      if (value.type === "tool.call") {
        if (finishRequested) {
          reply(value.id, { ok: false, error: "cave_program_cell_finishing" });
          return;
        }
        const pending = executeCall(value);
        activeCalls.add(pending);
        void pending.then(
          () => activeCalls.delete(pending),
          () => activeCalls.delete(pending),
        );
      } else if (value.type === "done") {
        finish(undefined, value.output);
      } else if (value.type === "error") {
        finish(new Error(`cave_program_execution_failed:${value.error}`));
      } else {
        finish(new Error("cave_program_worker_protocol_invalid"));
      }
    });
    worker.once("error", (error) => finish(new Error("cave_program_worker_failed", { cause: error })));
    worker.once("exit", (codeValue) => {
      if (!settled) finish(new Error(`cave_program_worker_exit:${codeValue}`));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({
      type: "run",
      code,
      tools: definitions.map((definition) => definition.name),
      syncTimeoutMs: PROGRAM_SYNC_TIMEOUT_MS,
    });
  });
}

function serializableValue(value: unknown, toolName: string): unknown {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("json_result_missing");
    return JSON.parse(encoded) as unknown;
  } catch (error) {
    throw new Error(`cave_program_tool_result_unserializable:${toolName}`, { cause: error });
  }
}

function codeWorkerEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ["LANG", "LC_ALL", "TZ", "NO_COLOR"] as const) {
    const value = source[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

function capProgramOutput(value: string): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= PROGRAM_MAX_OUTPUT_BYTES) return value;
  const head = Buffer.from(value, "utf8").subarray(0, PROGRAM_MAX_OUTPUT_BYTES / 2).toString("utf8");
  const tail = Buffer.from(value, "utf8").subarray(-PROGRAM_MAX_OUTPUT_BYTES / 2).toString("utf8");
  return `${head}\n... caveman_code output truncated (${bytes} bytes) ...\n${tail}`;
}

function parseInvocations(
  code: string,
  definitions: ReadonlyMap<string, ToolDefinition>,
): ParsedInvocation[] {
  const output: ParsedInvocation[] = [];
  let index = 0;
  while (index < code.length) {
    const skipped = skipTriviaOrLiteral(code, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (!isIdentifierStart(code[index] ?? "")) {
      index++;
      continue;
    }
    const start = index;
    index++;
    while (index < code.length && isIdentifierPart(code[index] ?? "")) index++;
    const name = code.slice(start, index);
    const definition = definitions.get(name);
    if (definition === undefined) continue;
    let cursor = skipWhitespace(code, index);
    if (code[cursor] !== "(") continue;
    const close = balancedCallEnd(code, cursor);
    if (close === undefined) continue;
    const raw = code.slice(cursor + 1, close).trim();
    let args: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) args = parsed;
    } catch {
      // Variable-dependent or JavaScript-only inputs execute normally, never speculatively.
    }
    output.push({ offset: start, name, ...(args === undefined ? {} : { args }) });
    index = close + 1;
  }
  return output;
}

function hasEffectfulToolReference(
  code: string,
  end: number,
  definitions: ReadonlyMap<string, ToolDefinition>,
): boolean {
  let index = 0;
  while (index < end) {
    const skipped = skipTriviaOrLiteral(code, index);
    if (skipped > index) {
      index = skipped;
      continue;
    }
    if (!isIdentifierStart(code[index] ?? "")) {
      index++;
      continue;
    }
    const start = index;
    index++;
    while (index < end && isIdentifierPart(code[index] ?? "")) index++;
    const name = code.slice(start, index);
    if (name === "tools" && code[skipWhitespace(code, index)] === "[") return true;
    const definition = definitions.get(name);
    if (definition !== undefined && definition.effect !== "read") return true;
  }
  return false;
}

function skipTriviaOrLiteral(code: string, index: number): number {
  const character = code[index];
  if (character === "\"" || character === "'" || character === "`") {
    return quotedEnd(code, index, character);
  }
  if (character === "/" && code[index + 1] === "/") {
    const newline = code.indexOf("\n", index + 2);
    return newline < 0 ? code.length : newline + 1;
  }
  if (character === "/" && code[index + 1] === "*") {
    const close = code.indexOf("*/", index + 2);
    return close < 0 ? code.length : close + 2;
  }
  return index;
}

function quotedEnd(code: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < code.length; index++) {
    const character = code[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return index + 1;
  }
  return code.length;
}

function balancedCallEnd(code: string, open: number): number | undefined {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    const skipped = skipTriviaOrLiteral(code, index);
    if (skipped > index) {
      index = skipped - 1;
      continue;
    }
    if (code[index] === "(") depth++;
    else if (code[index] === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}

function skipWhitespace(code: string, index: number): number {
  while (index < code.length && /\s/.test(code[index] ?? "")) index++;
  return index;
}

function isIdentifierStart(value: string): boolean {
  return /[A-Za-z_$]/.test(value);
}

function isIdentifierPart(value: string): boolean {
  return /[A-Za-z0-9_$]/.test(value);
}

function speculationKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableJSON(args)}`;
}

function stableJSON(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cave_program_non_json_value");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (!isRecord(value)) throw new Error("cave_program_non_json_value");
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJSON(value[key])}`
  ).join(",")}}`;
}

function validToolArguments(definition: ToolDefinition, args: Record<string, unknown>): boolean {
  return matchesJSONSchema(definition.input, args);
}

function matchesJSONSchema(schema: unknown, value: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => matchesJSONSchema(item, value))) {
    return false;
  }
  if (Array.isArray(schema.allOf) && !schema.allOf.every((item) => matchesJSONSchema(item, value))) {
    return false;
  }
  if ("const" in schema && !Object.is(schema.const, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) return false;
  if (schema.type === undefined) return true;
  if (schema.type === "null") return value === null;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
    return true;
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (schema.type === "integer" && !Number.isSafeInteger(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    return true;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    return schema.items === undefined || value.every((item) => matchesJSONSchema(schema.items, item));
  }
  if (schema.type !== "object" || !isRecord(value) || Array.isArray(value)) return false;
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  if (required.some((name) => !(name in value))) return false;
  for (const [name, field] of Object.entries(value)) {
    if (name === "__proto__" || name === "prototype" || name === "constructor") return false;
    const fieldSchema = properties[name];
    if (fieldSchema === undefined) {
      if (schema.additionalProperties === false) return false;
      continue;
    }
    if (!matchesJSONSchema(fieldSchema, field)) return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
