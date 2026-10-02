import { Worker } from "node:worker_threads";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "./definition.js";
import { tool, type ToolDefinition, type ToolExecutionContext } from "./primitives.js";
import {
  argumentErrors,
  codeToolDescription,
  discoverTools,
  invalidArgumentsMessage,
  NestedToolRegistry,
  type ProgrammaticToolNamespace,
} from "./programmatic-catalog.js";
import { PROGRAMMATIC_WORKER_SOURCE } from "./programmatic-worker.js";
import { withoutCodingToolGuidance } from "./coding-guidance.js";
import { toolScriptCompanions, type ToolScriptCompanions } from "./tool-internal.js";
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
/** Cell output kept for failure reports and spill; below the 8 MiB store entry limit. */
const PROGRAM_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
/** Discovery runs on the host thread, so each cell gets a bounded number of lookups. */
const PROGRAM_MAX_DISCOVERY_CALLS = 32;
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

export interface ProgrammaticToolStats {
  readonly launched: number;
  readonly claimed: number;
  readonly missed: number;
  readonly abandoned: number;
}

export type { ProgrammaticToolNamespace };

export interface ProgrammaticToolRuntime {
  readonly definition: AgentDefinition;
  wrapModels(models: Models): Models;
  wrapStreamFn(streamFn: StreamFn): StreamFn;
  stats(): ProgrammaticToolStats;
  /**
   * Make more trusted tools callable from the next cell as `tools.<name>`,
   * found through `searchTools`/`describeTool`/`describeNamespace`. The code
   * tool's provider-visible description never changes, so the cache prefix
   * stays byte-stable while tool servers connect.
   */
  registerNestedTools(tools: readonly ToolDefinition[], namespace?: ProgrammaticToolNamespace): void;
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

type WorkerDiscover = {
  readonly type: "discover";
  readonly id: number;
  readonly name: string;
  readonly args: unknown;
};

type WorkerOutput = {
  readonly type: "output";
  readonly text: string;
};

type WorkerDone = {
  readonly type: "done";
  readonly droppedBytes: number;
};

type WorkerError = {
  readonly type: "error";
  readonly kind?: "stalled";
  readonly error?: string;
  readonly stack?: string;
  readonly droppedBytes: number;
};

type WorkerMessage = WorkerToolCall | WorkerDiscover | WorkerOutput | WorkerDone | WorkerError;

type ProgramCall = { readonly name: string; status: "running" | "ok" | "error" };

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
  const base = toolName === PROGRAMMATIC_TOOL_NAME
    ? PROGRAMMATIC_CORE_INSTRUCTIONS
    : PROGRAMMATIC_CORE_INSTRUCTIONS.replaceAll(PROGRAMMATIC_TOOL_NAME, toolName);
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
  // Cells call a tool's script companion when it has one: same name and
  // input, structured result. Direct mode keeps the compact text form.
  const definitions = directDefinition.tools.map((item) => toolScriptCompanions(item)?.script ?? item);
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
  const registry = PROGRAMMATIC_METADATA.get(codeTool)!.registry;
  const definition = Object.freeze({
    ...directDefinition,
    // Declarations carry each tool's description, so the coding prompt's
    // direct-mode Tools block would only repeat them in the prefix.
    instructions: options.instructions ?? programmaticToolInstructions(
      typeof directDefinition.instructions === "string"
        ? withoutCodingToolGuidance(directDefinition.instructions)
        : undefined,
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
    registerNestedTools(tools: readonly ToolDefinition[], namespace?: ProgrammaticToolNamespace) {
      registry.register(tools, namespace);
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
  const registry = new NestedToolRegistry(toolName, definitions);
  // Oversized cell output spills into the agent's retained-output store. Its
  // reader stays callable from cells even when the direct surface omits it.
  const spill = definitions.map(toolScriptCompanions)
    .find((companions) => companions?.retain !== undefined && companions.reader !== undefined);
  if (spill?.reader !== undefined && registry.get(spill.reader.name) === undefined) {
    registry.register([spill.reader]);
  }
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
        throw new Error("cave_program_source_required: code must be a non-empty JavaScript string.");
      }
      const sourceBytes = Buffer.byteLength(input.code, "utf8");
      if (sourceBytes > PROGRAM_MAX_SOURCE_BYTES) {
        throw new Error(
          `cave_program_source_limit: this cell is ${sourceBytes} bytes; the limit is ` +
          `${PROGRAM_MAX_SOURCE_BYTES}. Split the work across several smaller cells.`,
        );
      }
      return capProgramOutput(
        await runProgram(input.code, registry, definitions, new Set(speculativeTools), signal, context, spill),
        spill,
      );
    },
  });
  PROGRAMMATIC_METADATA.set(definition, Object.freeze({
    enabled: speculationEnabled && speculativeTools.length > 0,
    toolName,
    definitions: new Map(definitions.map((item) => [item.name, item])),
    registry,
    speculativeNames: new Set(speculativeTools),
    counters,
  }));
  return definition;
}

type ProgrammaticMetadata = {
  readonly enabled: boolean;
  readonly toolName: string;
  readonly definitions: ReadonlyMap<string, ToolDefinition>;
  /** Every tool cells may call, including tools registered after construction. */
  readonly registry: NestedToolRegistry;
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
  registry: NestedToolRegistry,
  staticDefinitions: readonly ToolDefinition[],
  speculativeNames: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  context: ToolExecutionContext | undefined,
  spill: ToolScriptCompanions | undefined,
): Promise<string> {
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
  let discoveryCount = 0;
  let effectfulCallSeen = false;
  let droppedBytes = 0;
  const repeats = new Map<string, number>();
  const activeCalls = new Set<Promise<void>>();
  const calls: ProgramCall[] = [];
  const output: string[] = [];
  // Failure reports keep what the cell printed and every call that already
  // ran. They are formatted after settlement so call statuses are final.
  const failure = (head: string) => () => {
    const printed = output.join("\n") + (droppedBytes > 0 ? `\n[${droppedBytes} more output bytes dropped]` : "");
    return new Error(capProgramOutput([
      head,
      ...(printed === "" ? [] : [`Output before the failure:\n${printed}`]),
      calls.length === 0
        ? "No tool calls ran."
        : `These calls ran and are not undone: ${calls.map((call) => `${call.name} (${call.status})`).join(", ")}.`,
    ].join("\n"), spill));
  };

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => finish(failure(
      `cave_program_timeout: this cell ran past its ${PROGRAM_TIMEOUT_MS} ms limit and was stopped. ` +
      "Split the work into smaller cells.",
    )), PROGRAM_TIMEOUT_MS);
    const abort = () => finish(signal?.reason instanceof Error
      ? signal.reason
      : new Error("cave_program_aborted"));
    const finish = (error?: Error | (() => Error), result?: string): void => {
      if (finishRequested) return;
      finishRequested = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // `done` arrives only after the worker drains admitted calls. A settled
      // call may return a runtime-owned handle, such as a yielded command
      // session, whose lifetime must outlive this cell. Only cell failure
      // triggers local cancellation; owner cancellation remains attached.
      if (error !== undefined) {
        programController.abort(error instanceof Error ? error : new Error("cave_program_cell_failed"));
        void worker.terminate();
      }
      void (async () => {
        if (!await boundedProgramSettlement([...activeCalls])) {
          programController.abort(new Error("cave_program_nested_calls_unquiesced"));
          settled = true;
          void worker.terminate();
          reject(failure(
            "cave_program_nested_calls_unquiesced: a nested call kept running after the cell stopped; " +
            "its effects may still land. Check state before retrying.",
          )());
          return;
        }
        settled = true;
        void worker.terminate();
        if (error !== undefined) reject(error instanceof Error ? error : error());
        else resolve(result ?? "ok");
      })();
    };
    const reply = (id: number, result: { ok: true; value: unknown } | { ok: false; error: string }): void => {
      if (settled) return;
      worker.postMessage({ type: "tool.result", id, ...result });
    };
    const executeCall = async (message: WorkerToolCall): Promise<void> => {
      try {
        callCount++;
        if (callCount > PROGRAM_MAX_TOOL_CALLS) {
          throw new Error(
            `cave_program_tool_call_budget_exceeded: this cell already made ${PROGRAM_MAX_TOOL_CALLS} tool calls, ` +
            "the per-cell limit. Print or return what you have, then continue in a new cell.",
          );
        }
        const definition = registry.get(message.name);
        if (definition === undefined) throw new Error(`cave_program_unknown_tool:${message.name}`);
        const errors = isRecord(message.args)
          ? argumentErrors(definition.input, message.args)
          : [`args: expected object, got ${message.args === null ? "null" : typeof message.args}`];
        if (errors.length > 0) throw new Error(invalidArgumentsMessage(definition, errors));
        const args = message.args as Record<string, unknown>;
        // Only names this code tool declared speculative may claim; the kernel
        // rejects any other claim, including late tools and speculate:false.
        const canClaimSpeculation = speculativeNames.has(definition.name) && !effectfulCallSeen;
        if (definition.effect !== "read") effectfulCallSeen = true;
        const repeatKey = speculationKey(message.name, args);
        const repeated = (repeats.get(repeatKey) ?? 0) + 1;
        repeats.set(repeatKey, repeated);
        if (repeated > PROGRAM_MAX_REPEAT_CALLS && definition.allowRepeat !== true) {
          throw new Error(
            `cave_program_repeated_tool_call: ${message.name} already ran ${PROGRAM_MAX_REPEAT_CALLS} times ` +
            "with these exact arguments in this cell. Reuse the earlier result instead of calling again.",
          );
        }
        if (context === undefined) throw new Error("cave_program_nested_dispatch_unavailable");
        const call: ProgramCall = { name: definition.name, status: "running" };
        calls.push(call);
        let value: unknown;
        try {
          value = await context.dispatch(message.name, args, {
            signal: programSignal,
            ...(canClaimSpeculation ? { claimSpeculation: true } : {}),
          });
          call.status = "ok";
        } catch (error) {
          call.status = "error";
          throw error;
        }
        reply(message.id, { ok: true, value: serializableValue(value, definition.name) });
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
      } else if (value.type === "discover") {
        try {
          if (++discoveryCount > PROGRAM_MAX_DISCOVERY_CALLS) {
            throw new Error(
              `cave_program_discovery_budget_exceeded: this cell already made ${PROGRAM_MAX_DISCOVERY_CALLS} ` +
              "discovery calls. Use what you found, or continue in a new cell.",
            );
          }
          reply(value.id, { ok: true, value: discoverTools(registry.list(), value.name, value.args) });
        } catch (error) {
          reply(value.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      } else if (value.type === "output") {
        output.push(value.text);
      } else if (value.type === "done") {
        droppedBytes = value.droppedBytes;
        const printed = output.join("\n");
        finish(undefined, droppedBytes > 0 ? `${printed}\n[${droppedBytes} more output bytes dropped]` : printed || "ok");
      } else if (value.type === "error") {
        droppedBytes = value.droppedBytes;
        finish(failure(value.kind === "stalled"
          ? "cave_program_stalled: this cell awaits a promise that can never settle: no tool call is " +
            "pending, and cells have no timers. Await tool calls directly instead of a hand-built promise."
          : `cave_program_execution_failed:${value.error ?? "unknown error"}` +
            (/^Script execution timed out/.test(value.error ?? "")
              ? ` Synchronous code before the first await may run ${PROGRAM_SYNC_TIMEOUT_MS} ms; avoid busy loops.`
              : "") +
            (value.stack ? `\n${value.stack}` : "")));
      } else {
        finish(new Error("cave_program_worker_protocol_invalid"));
      }
    });
    worker.once("error", (error: Error & { code?: unknown }) => finish(error.code === "ERR_WORKER_OUT_OF_MEMORY"
      ? failure("cave_program_memory_limit: this cell ran out of its 64 MiB heap. Keep less data in memory at once.")
      : new Error("cave_program_worker_failed", { cause: error })));
    worker.once("exit", (codeValue) => {
      if (!settled) finish(failure(`cave_program_worker_exit:${codeValue}`));
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    worker.postMessage({
      type: "run",
      code,
      tools: registry.list().map(({ definition }) => ({
        name: definition.name,
        description: definition.description,
      })),
      globals: staticDefinitions.map((definition) => definition.name),
      syncTimeoutMs: PROGRAM_SYNC_TIMEOUT_MS,
      maxOutputBytes: PROGRAM_CAPTURE_MAX_BYTES,
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

/**
 * Keep head and tail of oversized cell output. The full text spills into the
 * agent's retained-output store when one exists, so a later cell can page the
 * omitted middle instead of rerunning tools.
 */
function capProgramOutput(value: string, spill: ToolScriptCompanions | undefined): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= PROGRAM_MAX_OUTPUT_BYTES) return value;
  const half = PROGRAM_MAX_OUTPUT_BYTES / 2 - 256;
  const omitted = encoded.byteLength - 2 * half;
  const handle = spill?.retain?.("code cell output", value, true);
  const recovery = handle === undefined || spill?.reader === undefined
    ? "print less, or filter inside the cell"
    : `read them with tools.${spill.reader.name}(${JSON.stringify({ handle, offset: half })})`;
  return `${encoded.subarray(0, half).toString("utf8")}\n` +
    `[... ${omitted} of ${encoded.byteLength} output bytes omitted; ${recovery} ...]\n` +
    encoded.subarray(-half).toString("utf8");
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
  return argumentErrors(definition.input, args).length === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
