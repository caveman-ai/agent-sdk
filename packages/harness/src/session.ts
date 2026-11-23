/**
 * The harness as a library: one conversation over many user turns, for a host that runs the agent inside its own app
 * (the Caveman Code app's Caveman engine). The host brings the model and how to stream it (its credentials, routing and
 * egress), where tools run (an ExecEnv), its MCP tools, the tools it declares itself, and its instructions. The session
 * brings what the CLI run measured, unchanged: the loadout's surface and prompt, the policy (bounded autonomy,
 * transient retries with the same request), the wire knobs and the Anthropic cache keep-alive.
 *
 * What a host needs that a benchmark run does not:
 * - Turns: `runTurn(content)` runs the loop to the model's final answer on the conversation so far, and `messages` is
 *   the conversation after it (what a host saves to resume, roll back or fork). The policy's counts start fresh each
 *   turn; the tools, their background processes and exec cells live as long as the session.
 * - Steering: text the host queues while a turn runs reaches the model after the current tool calls.
 * - Approvals and hooks: `beforeCall` sees every call, direct or made from a program or an exec cell, and may refuse it;
 *   the model reads the reason as the call's result. Nested calls are events, so a transcript can show them.
 * - The keep-alive outlives a turn: while the person reads and types, the cache stays warm up to the loadout's ping
 *   limit (12 pings at 270 s: 54 minutes), and the next turn finds its prefix cached. Pings between turns are billed to
 *   the next turn.
 * - Compaction: when a request would carry more than `compactAt` of the model's context window, the conversation so far
 *   becomes one summary (asked of the same model on the same prefix, so it reads from the cache), and the work goes on
 *   from it.
 */
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  runAgentLoop, runAgentLoopContinue, type AgentEvent, type AgentLoopConfig, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage, isRetryableAssistantError, toToolDeclaration, type Api, type AssistantMessage, type ImageContent, type Model, type TextContent,
} from "@earendil-works/pi-ai";
import type { ExecEnv } from "./env/types.ts";
import { CacheKeepAlive, type KeepAliveUsage } from "./keepalive.ts";
import { LeverState } from "./levers.ts";
import { shellSettingsOf, type Loadout } from "./loadout.ts";
import type { McpToolHandle } from "./mcp.ts";
import { costOf, thinkingLevelFor, type Effort } from "./models.ts";
import { Policy } from "./policy.ts";
import { buildTools, envBlock, retryDelayMs, systemPromptOf } from "./run.ts";
import type { NestedCall, NestedHooks } from "./tools/hooks.ts";
import { Recorder } from "./trace.ts";
import { wireSetup } from "./wire.ts";

export type { NestedCall } from "./tools/hooks.ts";

/** A call the model is about to make: a direct tool call (no parentId) or one a program or exec cell makes. */
export interface CallInfo {
  id: string;
  name: string;
  args: unknown;
  parentId?: string;
  mcp?: { server: string; tool: string };
}

export interface SessionHooks {
  /** A reason refuses the call: it does not run, and the model reads the reason. Undefined lets it run. */
  beforeCall?(call: CallInfo, signal: AbortSignal | undefined): Promise<string | undefined>;
  /** A note appended to a direct call's text result (a PostToolUse hook); undefined adds nothing. */
  afterCall?(call: CallInfo, result: { text: string; isError: boolean }): Promise<string | undefined>;
}

export type SessionEvent =
  /** Pi's agent events, as the CLI's trace sees them: messages (streamed), tool executions, turns. */
  | { type: "pi"; event: AgentEvent }
  | { type: "nested_start"; call: NestedCall }
  | { type: "nested_end"; call: NestedCall; result: unknown; isError: boolean }
  /** A request outside the conversation: a cache keep-alive ping, or the summary call of a compaction. */
  | { type: "side_usage"; kind: "cache_keepalive" | "compaction"; usage: TurnUsage }
  | { type: "compacted"; summaryTokens: number; before: number }
  | { type: "retry"; attempt: number; of: number; delayMs: number; error: string | undefined };

export interface TurnUsage {
  requests: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** List-price dollars, or null when the model has no price. */
  costUsd: number | null;
}

export interface TurnOutcome {
  status: "finished" | "stopped" | "error";
  /** done, aborted, loop_repeat, empty_turns, output_cap, provider_error, provider_unavailable, harness_error. */
  stopReason: string;
  error?: string;
  /** The model's last answer in the turn. */
  finalText: string;
  /** Every request of the turn, side requests and pings since the last turn included. */
  usage: TurnUsage;
}

export interface TurnOptions {
  signal?: AbortSignal;
  onEvent?: (event: SessionEvent) => void;
  /** Steering the host queued since the last call: drained after each batch of tool calls. */
  steering?: () => string[];
}

export interface HarnessSessionOptions {
  model: Model<Api>;
  /** Streams one request: pi-ai's streamSimple on the host's models (their credentials, routing and egress). */
  stream: StreamFn;
  /** Undefined: the model's own default (no reasoning level sent). */
  effort?: Effort | undefined;
  loadout: Loadout;
  env: ExecEnv;
  /** MCP tools reached from programs (compact) or exec cells (exec), or one declared tool each, per loadout.mcp.exposure (app-general: one tool each). */
  mcp?: readonly McpToolHandle[];
  /** Tools the host declares itself, after the surface's (tools that wait on a person, answer with an image, load a skill). */
  tools?: AgentTool<any>[];
  /** Host text after the loadout's prompt (repository instructions, the runtime's); the whole system prompt on a loadout with no sections (app-general). Fixed for the session. */
  instructions?: string;
  /** A restored conversation (as `messages` gave it), without the system message. */
  messages?: AgentMessage[];
  hooks?: SessionHooks;
  /** The fetch the cache keep-alive re-sends through (default the global one). */
  fetch?: typeof fetch;
  /** Share of the context window past which the conversation is compacted (default 0.8; 0 turns it off). */
  compactAt?: number;
}

const ZERO: TurnUsage = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, costUsd: 0 };

const SUMMARY_INSTRUCTION = [
  "Your context is nearly full, so this conversation is about to be replaced by a summary that you write now.",
  "Write everything you need to continue the work without it: the user's requests and constraints (in their words where it matters),",
  "what has been done (files changed, commands run and what they showed), decisions and why, what is still open, and the next steps.",
  "Keep exact paths, names, numbers and error messages. Reply with the summary only, no tool calls.",
].join(" ");

const SUMMARY_PREFIX = "[harness] The conversation before this point was compacted. Summary:";

/** Whether a user message is the harness's compaction summary (a host's transcript leaves it out). */
export function isCompactionSummary(text: string): boolean {
  return text.startsWith(SUMMARY_PREFIX);
}

const textOf = (message: AgentMessage | undefined): string =>
  message?.role === "assistant" ? message.content.map((part) => (part.type === "text" ? part.text : "")).join("") : "";

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((done) => {
    if (signal.aborted) return done(false);
    const onAbort = () => {
      clearTimeout(timer);
      done(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Tokens a response's request and answer held; a message restored without usage (another engine's) counts none. */
const tokensOf = (usage: { input: number; cacheRead: number; cacheWrite: number; output: number } | undefined) =>
  usage === undefined ? 0 : (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);

/** Rough tokens of messages that have no usage yet (since the last response): 4 characters a token. */
function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += JSON.stringify((message as { content?: unknown }).content ?? "").length;
  return Math.ceil(chars / 4);
}

export class HarnessSession {
  readonly env: ExecEnv;
  #model: Model<Api>;
  #loadout: Loadout;
  #effort: Effort | undefined;
  readonly #options: HarnessSessionOptions;
  readonly #tools: AgentTool<any>[];
  readonly #disposeTools: () => Promise<void>;
  readonly #system: AgentMessage | undefined;
  #history: AgentMessage[];
  #turns = 0;
  #running = false;
  #closed = false;
  readonly #sessionId = randomUUID();
  readonly #keepalive: CacheKeepAlive | undefined;
  /** Where keep-alive pings are billed: the running turn's recorder, else the next turn. */
  #pingSink: ((usage: KeepAliveUsage | undefined, latencyMs: number, error: string | undefined) => void) | undefined;
  #idle: TurnUsage = { ...ZERO };
  /** The running turn's side-request counter (pings, compaction summaries). */
  #sideSink: ((kind: string, message: AssistantMessage, latencyMs: number) => void) | undefined;
  /** The running turn's event sink (nested calls reach the host through it). */
  #emit: ((event: SessionEvent) => void) | undefined;

  constructor(options: HarnessSessionOptions) {
    this.#options = options;
    this.env = options.env;
    this.#model = options.model;
    this.#loadout = options.loadout;
    this.#effort = options.effort;
    const shell = shellSettingsOf(options.loadout);
    if (Object.keys(shell).length > 0) {
      if (options.env.configureShell === undefined) throw new Error(`env ${options.env.id}: this env does not apply the loadout's shell flags`);
      options.env.configureShell(shell);
    }
    const nested: NestedHooks = {
      before: async (call, signal) => options.hooks?.beforeCall?.({ id: call.id, name: call.name, args: call.args, parentId: call.parentId, ...(call.mcp === undefined ? {} : { mcp: call.mcp }) }, signal),
      start: (call) => this.#emit?.({ type: "nested_start", call }),
      end: (call, outcome) => this.#emit?.({ type: "nested_end", call, result: outcome.result, isError: outcome.isError }),
    };
    const built = buildTools(options.loadout, options.env, options.model.input.includes("image"), options.mcp ?? [], undefined, undefined, nested);
    this.#tools = [...built.tools, ...(options.tools ?? [])];
    this.#disposeTools = built.dispose;
    const prompt = [systemPromptOf(options.loadout, options.env), options.instructions?.trim()].filter((part) => part !== undefined && part !== "").join("\n\n");
    this.#system = createInitialSystemMessage(prompt, this.#tools.map(toToolDeclaration)) as AgentMessage | undefined;
    this.#history = portableMessages(options.messages ?? [], new Set(this.#tools.map((tool) => tool.name)));
    this.#turns = this.#history.some((message) => message.role === "user") ? 1 : 0;
    const keepaliveS = options.loadout.wire.anthropic?.keepalive_s;
    if (keepaliveS !== undefined && options.model.api === "anthropic-messages") {
      this.#keepalive = new CacheKeepAlive({
        intervalMs: keepaliveS * 1000, maxPerGap: options.loadout.wire.anthropic?.keepalive_max ?? 12,
        base: options.fetch ?? globalThis.fetch.bind(globalThis),
        onPing: (usage, latencyMs, error) => this.#pingSink === undefined ? this.#billIdle(usage) : this.#pingSink(usage, latencyMs, error),
      });
    }
  }

  get model(): Model<Api> {
    return this.#model;
  }

  get loadout(): Loadout {
    return this.#loadout;
  }

  /** The conversation so far, without the system message: what a host saves. */
  get messages(): AgentMessage[] {
    return [...this.#history];
  }

  /** The declared tools' names (the surface's, then the host's). */
  get toolNames(): string[] {
    return this.#tools.map((tool) => tool.name);
  }

  /**
   * Another model of the same surface for the next turns (a route, a fallback): the tools and prompt stay, so the
   * conversation goes on as it is. A model that needs another surface needs another session.
   */
  setModel(model: Model<Api>, effort?: Effort | undefined): void {
    if (this.#running) throw new Error("setModel: a turn is running");
    this.#model = model;
    this.#effort = effort;
  }

  #billIdle(usage: KeepAliveUsage | undefined): void {
    if (usage === undefined) return;
    const cost = costOf(this.#model, { ...usage, totalTokens: tokensOf(usage), reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } as never, this.#loadout.prices);
    this.#idle = {
      requests: this.#idle.requests + 1, input: this.#idle.input + usage.input, cacheRead: this.#idle.cacheRead + usage.cacheRead,
      cacheWrite: this.#idle.cacheWrite + usage.cacheWrite, output: this.#idle.output + usage.output, reasoning: this.#idle.reasoning,
      costUsd: cost === undefined || this.#idle.costUsd === null ? null : this.#idle.costUsd + cost,
    };
  }

  /** One user turn: the loop until the model's final answer (or a stop), on the conversation so far. */
  async runTurn(content: string | (TextContent | ImageContent)[], options: TurnOptions = {}): Promise<TurnOutcome> {
    if (this.#closed) throw new Error("runTurn: the session is closed");
    if (this.#running) throw new Error("runTurn: a turn is already running");
    this.#running = true;
    const model = this.#model;
    const loadout = this.#loadout;
    const thinking: ThinkingLevel = this.#effort === undefined ? "off" : thinkingLevelFor(model, this.#effort);
    const reasoning = this.#effort === undefined || thinking === "off" ? undefined : thinking;
    const abort = new AbortController();
    const onExternalAbort = () => abort.abort(options.signal?.reason);
    if (options.signal?.aborted === true) abort.abort(options.signal.reason);
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const emit = (event: SessionEvent) => {
      try {
        options.onEvent?.(event);
      } catch {
        /* a host's handler never breaks the loop */
      }
    };
    this.#emit = emit;
    const recorder = new Recorder(undefined, model, loadout.prices);
    // Pings since the last turn are this turn's.
    const idle = this.#idle;
    this.#idle = { ...ZERO };
    if (idle.requests > 0) emit({ type: "side_usage", kind: "cache_keepalive", usage: idle });
    let sideRequests = 0;
    const side = (kind: string, message: AssistantMessage, latencyMs: number) => {
      sideRequests++;
      recorder.sideRequest(kind, message, latencyMs);
    };
    this.#sideSink = side;
    this.#pingSink = (usage, latencyMs, error) => {
      const message = pingMessage(model, usage, error);
      side("cache_keepalive", message, latencyMs);
      emit({ type: "side_usage", kind: "cache_keepalive", usage: usageOf([message], model, loadout) });
    };
    const first = this.#turns === 0;
    this.#turns++;
    let retries = 0;
    let levers: LeverState | undefined;
    let policy: Policy | undefined;
    const finish = (status: TurnOutcome["status"], stopReason: string, error?: string): TurnOutcome => ({
      status, stopReason, ...(error === undefined ? {} : { error }), finalText: textOf([...this.#history].reverse().find((message) => message.role === "assistant")),
      usage: addUsage(idle, {
        requests: recorder.usage.requests + sideRequests, input: recorder.usage.input_tokens, cacheRead: recorder.usage.cached_input_tokens,
        cacheWrite: recorder.usage.cache_write_tokens, output: recorder.usage.output_tokens, reasoning: recorder.usage.reasoning_tokens, costUsd: recorder.costUsd,
      }),
    });
    try {
      const text = typeof content === "string" ? content : content.filter((part): part is TextContent => part.type === "text").map((part) => part.text).join("\n\n");
      levers = new LeverState({ loadout, budgets: {}, recorder, env: this.env, model, thinking, task: text, signal: abort.signal, images: model.input.includes("image") });
      policy = new Policy(loadout, {}, recorder, abort, levers.active ? levers : undefined);
      const orientation = first ? await levers.start() : undefined;
      const lead = first && loadout.context.env === "user" ? envBlock(this.env) : undefined;
      const parts: (TextContent | ImageContent)[] = typeof content === "string" ? [{ type: "text", text: content }] : [...content];
      if (lead !== undefined) parts.unshift({ type: "text", text: lead });
      if (orientation !== undefined) parts.push({ type: "text", text: orientation });
      const merged = mergeText(parts);
      const prompt: AgentMessage = { role: "user", content: merged, timestamp: Date.now() };
      let requestEffort: Effort | undefined = reasoning === undefined ? undefined : this.#effort;
      const wire = wireSetup(loadout.wire, model, this.#sessionId, () => requestEffort);
      const keepalive = this.#keepalive;
      const streamFn: StreamFn = (requestModel, context, streamOptions) =>
        this.#options.stream(requestModel, context, { ...streamOptions, ...wire.streamOptions, ...(keepalive === undefined ? {} : { fetch: keepalive.fetch }) });
      const hooks = this.#options.hooks;
      const config: AgentLoopConfig = {
        model: wire.model,
        ...(reasoning === undefined ? {} : { reasoning }),
        sessionId: this.#sessionId,
        cacheRetention: loadout.wire.cache_retention,
        maxRetries: loadout.wire.max_retries,
        ...(loadout.wire.max_output_tokens === undefined ? {} : { maxTokens: loadout.wire.max_output_tokens }),
        ...(wire.onPayload === undefined ? {} : { onPayload: wire.onPayload }),
        toolExecution: loadout.policy.tool_execution,
        convertToLlm: (messages) => messages.filter((message) =>
          message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
        transformContext: (messages, signal) => this.#inLoop(messages, signal ?? abort.signal, streamFn, config, recorder, emit),
        prepareRequest: (request) => {
          const next = levers!.requestLevel();
          recorder.requestStart(request.context.messages.length, next?.level, next?.reason);
          if (next === undefined) return undefined;
          requestEffort = next.level === "off" ? undefined : next.level;
          return { thinkingLevel: next.level };
        },
        beforeToolCall: async (context, signal) => {
          const stopped = await policy!.beforeToolCall(context);
          if (stopped !== undefined) return stopped;
          const refused = await hooks?.beforeCall?.({ id: context.toolCall.id, name: context.toolCall.name, args: context.args }, signal);
          return refused === undefined ? undefined : { block: true, reason: refused };
        },
        afterToolCall: async (context, signal) => {
          const decided = await policy!.afterToolCall(context);
          if (hooks?.afterCall === undefined) return decided;
          const content = decided?.content ?? context.result.content;
          const textPart = content.map((part) => (part.type === "text" ? part.text : "")).join("");
          const note = await hooks.afterCall({ id: context.toolCall.id, name: context.toolCall.name, args: context.args }, { text: textPart, isError: context.isError });
          void signal;
          return note === undefined ? decided : { ...(decided ?? {}), content: [...content, { type: "text", text: `\n\n[hook] ${note}` }] };
        },
        finishTurn: policy.finishTurn,
        getFollowUpMessages: policy.getFollowUpMessages,
        getSteeringMessages: async () => (options.steering?.() ?? []).filter((item) => item.trim() !== "")
          .map((item) => ({ role: "user", content: [{ type: "text", text: item }], timestamp: Date.now() }) as AgentMessage),
      };
      const onEvent = (event: AgentEvent) => {
        recorder.onEvent(event);
        emit({ type: "pi", event });
      };
      // Before the turn: a conversation already past the line is compacted now, so the new message goes after the summary.
      if (!first) await this.#compactHistory(abort.signal, streamFn, config, recorder, emit);
      const context = () => ({ messages: this.#withSystem(this.#history), tools: this.#tools });
      const added = await runAgentLoop([prompt], context(), config, onEvent, abort.signal, streamFn);
      this.#commit(added);
      const { attempts } = loadout.policy.retry;
      for (let streak = 0; ;) {
        const failed = this.#history.at(-1);
        if (failed?.role !== "assistant" || failed.stopReason !== "error" || !isRetryableAssistantError(failed)) break;
        if (streak >= attempts || policy.stopReason !== undefined || abort.signal.aborted) break;
        streak++;
        retries++;
        const delayMs = retryDelayMs(loadout.policy.retry, streak, failed.errorMessage);
        emit({ type: "retry", attempt: streak, of: attempts, delayMs, error: failed.errorMessage });
        if (!(await sleep(delayMs, abort.signal))) break;
        this.#history.pop(); // the failed response never reaches the model: the retry sends the failed request again
        const more = await runAgentLoopContinue(context(), config, onEvent, abort.signal, streamFn);
        if (more.some((message) => message.role === "assistant" && message.stopReason !== "error")) streak = 0;
        this.#commit(more);
      }
      await levers.close();
      const last = [...this.#history].reverse().find((message): message is AssistantMessage => message.role === "assistant");
      if (policy.stopReason !== undefined) return finish("stopped", policy.stopReason);
      if (last?.stopReason === "aborted" || abort.signal.aborted) return finish("stopped", "aborted");
      if (last?.stopReason === "error") {
        const transient = isRetryableAssistantError(last);
        return finish("error", transient ? "provider_unavailable" : "provider_error", `${last.errorMessage ?? "provider error"}${transient ? ` (after ${retries} retries)` : ""}`);
      }
      return finish("finished", "done");
    } catch (error) {
      return finish(abort.signal.aborted ? "stopped" : "error", abort.signal.aborted ? "aborted" : "harness_error", error instanceof Error ? error.message : String(error));
    } finally {
      policy?.dispose();
      await levers?.close().catch(() => undefined);
      options.signal?.removeEventListener("abort", onExternalAbort);
      this.#pingSink = undefined;
      this.#sideSink = undefined;
      this.#emit = undefined;
      this.#running = false;
    }
  }

  /** Stops background work: cells, processes, the keep-alive. MCP connections are the host's. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#keepalive?.close();
    await this.#disposeTools().catch(() => undefined);
    await this.env.close().catch(() => undefined);
  }

  /** Stops keeping the cache warm until the next turn (the conversation moved: a rollback, a fork, another model). */
  pauseKeepAlive(): void {
    this.#keepalive?.pause();
  }

  #withSystem(messages: AgentMessage[]): AgentMessage[] {
    return this.#system === undefined ? [...messages] : [this.#system, ...messages];
  }

  #withoutSystem(messages: AgentMessage[]): AgentMessage[] {
    return this.#system !== undefined && messages[0] === this.#system ? messages.slice(1) : messages.filter((message) => message.role !== "system");
  }

  /** Adds a loop's new messages, applying a compaction made inside the loop (the loop's own context never sees it). */
  #commit(added: AgentMessage[]): void {
    const pending = this.#pendingCompaction;
    this.#pendingCompaction = undefined;
    if (pending === undefined) {
      this.#history.push(...added);
      return;
    }
    // The loop's context was [system?, ...history, ...added]; the compaction replaced its first `upTo` messages.
    const full = [...this.#withSystem(this.#history), ...added];
    this.#history = this.#withoutSystem([...(this.#system === undefined ? [] : [this.#system]), pending.summary, ...full.slice(pending.upTo)]);
  }

  /** A compaction made inside the running loop: its summary replaces the loop context's first `upTo` messages. */
  #pendingCompaction: { upTo: number; summary: AgentMessage } | undefined;

  /** Size of a context as the next request would send it: the last response's usage, plus an estimate of what followed. */
  #sizeOf(messages: AgentMessage[]): number {
    const lastIndex = messages.findLastIndex((message) => message.role === "assistant");
    const last = messages[lastIndex] as AssistantMessage | undefined;
    return (last === undefined ? 0 : tokensOf(last.usage)) + estimateTokens(messages.slice(lastIndex + 1));
  }

  #overLine(messages: AgentMessage[]): boolean {
    const share = this.#options.compactAt ?? 0.8;
    const window = this.#model.contextWindow;
    if (!(share > 0) || !(window > 0) || !messages.some((message) => message.role === "assistant")) return false;
    const reserve = Math.min(this.#model.maxTokens || 32_000, 32_000);
    return this.#sizeOf(messages) + reserve >= share * window;
  }

  /**
   * The summary of a context (system included), asked on the same prefix (system, tools, every message, the request's
   * reasoning and wire rewrites) so it reads the cache, plus one instruction. Undefined when the call failed: the
   * conversation then goes on uncompacted (and fails at the window, as without compaction).
   */
  async #summarize(
    messages: AgentMessage[], signal: AbortSignal, streamFn: StreamFn, config: AgentLoopConfig, recorder: Recorder, emit: (event: SessionEvent) => void,
  ): Promise<AgentMessage | undefined> {
    const ask: AgentMessage = { role: "user", content: [{ type: "text", text: SUMMARY_INSTRUCTION }], timestamp: Date.now() };
    const llm = await config.convertToLlm([...messages, ask]);
    const started = performance.now();
    const before = this.#sizeOf(messages);
    let reply: AssistantMessage;
    try {
      const stream = await streamFn(this.#model, { messages: llm, tools: this.#tools.map(toToolDeclaration) } as never, {
        ...(config.reasoning === undefined ? {} : { reasoning: config.reasoning }), sessionId: this.#sessionId, cacheRetention: config.cacheRetention,
        maxRetries: config.maxRetries, maxTokens: Math.min(this.#model.maxTokens || 16_000, 16_000), signal,
        ...(config.onPayload === undefined ? {} : { onPayload: config.onPayload }),
      } as never);
      reply = await (stream as unknown as { result(): Promise<AssistantMessage> }).result();
    } catch {
      return undefined;
    }
    (this.#sideSink ?? ((kind, message, latency) => recorder.sideRequest(kind, message, latency)))("compaction", reply, performance.now() - started);
    emit({ type: "side_usage", kind: "compaction", usage: usageOf([reply], this.#model, this.#loadout) });
    const text = textOf(reply).trim();
    if (reply.stopReason === "error" || reply.stopReason === "aborted" || text === "") return undefined;
    emit({ type: "compacted", summaryTokens: reply.usage.output, before });
    return { role: "user", content: [{ type: "text", text: `${SUMMARY_PREFIX}\n\n${text}\n\nContinue from here.` }], timestamp: Date.now() };
  }

  /** Between turns: a conversation past the line becomes its summary before the next message. */
  async #compactHistory(signal: AbortSignal, streamFn: StreamFn, config: AgentLoopConfig, recorder: Recorder, emit: (event: SessionEvent) => void): Promise<void> {
    const context = this.#withSystem(this.#history);
    if (!this.#overLine(context)) return;
    const summary = await this.#summarize(context, signal, streamFn, config, recorder, emit);
    if (summary !== undefined) this.#history = [summary];
  }

  /**
   * transformContext: the context each request of the loop is sent with. Once compacted, it is the summary plus what
   * came after it; past the line, the context so far becomes a summary now.
   */
  async #inLoop(
    messages: AgentMessage[], signal: AbortSignal, streamFn: StreamFn, config: AgentLoopConfig, recorder: Recorder, emit: (event: SessionEvent) => void,
  ): Promise<AgentMessage[]> {
    const pending = this.#pendingCompaction;
    const head = this.#system === undefined ? [] : [this.#system];
    const current = pending === undefined ? messages : [...head, pending.summary, ...messages.slice(pending.upTo)];
    if (!this.#overLine(current)) return current;
    const summary = await this.#summarize(current, signal, streamFn, config, recorder, emit);
    if (summary === undefined) return current;
    // The loop keeps sending its full context; from now on its first messages.length entries are this summary.
    this.#pendingCompaction = { upTo: messages.length, summary };
    return [...head, summary];
  }
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`);

/**
 * A conversation another surface (or another engine) left, as one this session can continue: the model's own roles
 * only, and every call of a tool this session does not declare (with its result) as text, since a provider refuses a
 * call to a tool it was not given. What the model said and saw stays; only the form of those calls changes.
 */
export function portableMessages(messages: readonly unknown[], declared: ReadonlySet<string>): AgentMessage[] {
  const foreign = new Map<string, string>();
  const out: AgentMessage[] = [];
  for (const raw of messages) {
    const message = raw as AgentMessage & { content?: unknown; toolCallId?: unknown; isError?: unknown };
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const content = (message.content as unknown as Record<string, unknown>[]).map((part) => {
        if (part.type !== "toolCall" || declared.has(String(part.name))) return part;
        foreign.set(String(part.id), String(part.name));
        return { type: "text", text: `[called ${String(part.name)} ${clip(JSON.stringify(part.arguments ?? {}), 2_000)}]` };
      });
      out.push({ ...message, content } as AgentMessage);
      continue;
    }
    if (message.role === "toolResult") {
      const name = foreign.get(String(message.toolCallId));
      if (name === undefined) {
        out.push(message);
        continue;
      }
      const text = Array.isArray(message.content)
        ? (message.content as unknown as Record<string, unknown>[]).map((part) => (part.type === "text" ? String(part.text) : `[${String(part.type)}]`)).join("")
        : "";
      out.push({ role: "user", content: [{ type: "text", text: `[${name} ${message.isError === true ? "failed" : "returned"}] ${clip(text, 4_000)}` }], timestamp: message.timestamp ?? Date.now() } as AgentMessage);
      continue;
    }
    if (message.role === "user" || message.role === "assistant") out.push(message);
  }
  return out;
}

/** Adjacent text parts as one (the env block, the message, the orientation), images in place. */
function mergeText(parts: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
  const out: (TextContent | ImageContent)[] = [];
  for (const part of parts) {
    const previous = out.at(-1);
    if (part.type === "text" && previous?.type === "text") out[out.length - 1] = { type: "text", text: `${previous.text}\n\n${part.text}` };
    else out.push(part);
  }
  return out;
}

function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    requests: a.requests + b.requests, input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output, reasoning: a.reasoning + b.reasoning, costUsd: a.costUsd === null || b.costUsd === null ? null : a.costUsd + b.costUsd,
  };
}

function usageOf(messages: AssistantMessage[], model: Model<Api>, loadout: Loadout): TurnUsage {
  let total: TurnUsage = { ...ZERO };
  for (const message of messages) {
    const cost = costOf(model, message.usage, loadout.prices);
    total = addUsage(total, {
      requests: 1, input: message.usage.input, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite, output: message.usage.output,
      reasoning: message.usage.reasoning ?? 0, costUsd: cost ?? null,
    });
  }
  return total;
}

/** A keep-alive ping as an assistant message with only usage (the recorder's side request). */
function pingMessage(model: Model<Api>, usage: KeepAliveUsage | undefined, error: string | undefined): AssistantMessage {
  const counted = usage ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { ...counted, totalTokens: tokensOf(counted), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: error === undefined ? "length" : "error", ...(error === undefined ? {} : { errorMessage: error }), timestamp: Date.now(),
  };
}
