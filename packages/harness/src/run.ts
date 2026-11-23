/**
 * One run: a loadout, a model and an env, driven by Pi's agent loop
 * (`runAgentLoop` from pi-agent-core 1.4). The harness only supplies the
 * transcript seed, the tools, and the policy and trace hooks; Pi owns turn
 * scheduling, tool execution, argument validation, follow-ups and events.
 *
 * Pi retries a request only before its stream starts. A turn that still ends
 * in a transient provider error (a failed or dropped stream, a 5xx or 429 Pi
 * gave up on) is re-run here with `runAgentLoopContinue` from the transcript
 * before it, so the retried request is byte-identical to the failed one (same
 * cache prefix); each retry is a trace `policy` event. A non-transient error,
 * or retries exhausted, ends the run with status error.
 */
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  runAgentLoop, runAgentLoopContinue, type AgentEvent, type AgentLoopConfig, type AgentMessage, type AgentTool, type StreamFn, type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage, isRetryableAssistantError, toToolDeclaration, type Api, type AssistantMessage, type FauxResponseStep, type Model, type Usage,
} from "@earendil-works/pi-ai";
import type { ExecEnv } from "./env/types.ts";
import { LeverState, timeBudgetLine } from "./levers.ts";
import { loadoutHash, shellSettingsOf, type Loadout } from "./loadout.ts";
import { costOf, resolveModel, resolveSideModel, thinkingLevelFor, type Effort, type ModelOptions, type ResolvedModel } from "./models.ts";
import { mergeBudgets, Policy, type Budgets } from "./policy.ts";
import { placeboFor } from "./prompts.ts";
import { requirementsBlock } from "./requirements.ts";
import { FinishSnapshot, type SnapshotMode } from "./snapshot.ts";
import { compactTools } from "./tools/compact.ts";
import { ASK_SYSTEM, type ProgramAsk } from "./tools/program.ts";
import { execSurface } from "./tools/exec/surface.ts";
import { Recorder, type RunResult } from "./trace.ts";
import { Transcript } from "./transcript.ts";
import type { SideCall } from "./validator.ts";
import { wireSetup } from "./wire.ts";
import { WsTransport } from "./ws.ts";
import { CacheKeepAlive, type KeepAliveUsage } from "./keepalive.ts";
import { connectMcp, mcpDirectTools, type McpServerConfig, type McpToolHandle } from "./mcp.ts";
import { ScriptStore } from "./scripts.ts";
import type { NestedHooks } from "./tools/hooks.ts";
import { AnthropicThreads } from "./threads.ts";

export interface RunOptions {
  prompt: string;
  model: string;
  effort: Effort;
  loadout: Loadout;
  env: ExecEnv;
  tracePath?: string;
  /** Every model-visible message as JSONL (observation only: never changes a request). */
  transcriptPath?: string;
  resultPath?: string;
  modelOptions?: ModelOptions;
  /** Caps from the command line; the tighter of these and the loadout's apply. */
  budgets?: Budgets;
  bundleSha256?: string;
  /**
   * version.loadout_hash: sha256 of the canonical JSON of the loadout as given
   * (readLoadout's `loadoutHash`, the rig's pin). Defaults to the normalized
   * loadout's hash, for loadouts built in code.
   */
  loadoutHash?: string;
  /** Scripted responses for a `faux/<id>` model (tests). */
  fauxSteps?: FauxResponseStep[];
  /** Scripted responses for policy.validator's side call on a `faux/<id>` model (tests; a faux script's `validator_steps` otherwise). */
  validatorFauxSteps?: FauxResponseStep[];
  /** Scripted responses for policy.critic's review loop on a `faux/<id>` model, one per review request (tests; a faux script's `critic_steps` otherwise). */
  criticFauxSteps?: FauxResponseStep[];
  /** Scripted responses for policy.clause_check's side call on a `faux/<id>` model (tests; a faux script's `clause_steps` otherwise). */
  clauseFauxSteps?: FauxResponseStep[];
  /** Scripted replies for the program tool's ask() on a `faux/<id>` model (tests; a faux script's `ask_steps` otherwise). */
  askFauxSteps?: FauxResponseStep[];
  /** External abort (signals). */
  signal?: AbortSignal;
  /** MCP servers for this run (--mcp-config): connected before the first request, closed at the end (src/mcp.ts). */
  mcpServers?: Record<string, McpServerConfig>;
  /** The saved-script store (--scripts-dir, src/scripts.ts) for a program tool with limits.scripts. */
  scriptsDir?: string;
  /**
   * A session (--followups): user messages sent one at a time after the prompt, each after the previous turn ended
   * (the model's final answer to it), in one conversation. Budgets cover the whole session; a stop ends it.
   */
  followups?: string[];
  /** Runs after each turn ends, before the next follow-up (--on-turn-end): the turn (1-based) and its final text. */
  onTurnEnd?: (turn: number, finalText: string) => Promise<void>;
  /**
   * trace.finish_snapshot from the command line (observation only: never changes a request). `mode` wins over the
   * loadout's; `dir` is where the tarball is copied (default: result.json's directory); `maxMb` the cwd size limit.
   */
  finishSnapshot?: { mode?: SnapshotMode; dir?: string; maxMb?: number };
}

const ZERO_USAGE: Usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * What the model is told about its env: only facts that are the same on every
 * trial of a task (the workdir and the OS), never the env id (`docker:<container>`
 * differs per trial), so the prompt prefix (system, tools, first message)
 * is byte-identical across trials and their prompt caches line up. A `shell:`
 * line follows only where the env has a shell note (LocalEnv on Windows: Git
 * Bash, so POSIX syntax and forward slashes); everywhere else the block is as
 * it always was.
 */
export function envBlock(env: ExecEnv): string {
  return `<env>\ncwd: ${env.cwd}\n${env.os === undefined ? "" : `os: ${env.os}\n`}${env.shellNote === undefined ? "" : `shell: ${env.shellNote}\n`}</env>`;
}

/**
 * The system prompt a loadout compiles to: its sections, then its addenda (or,
 * in a placebo arm, neutral text of the same estimated token length in their
 * place), then prompt.clean_env (or its placebo), then the env block when the
 * loadout puts it there. Every part is loadout text: byte-stable across trials.
 */
export function systemPromptOf(loadout: Loadout, env: ExecEnv): string {
  const sections = loadout.prompt.sections.map((section) => section.text);
  for (const addendum of loadout.prompt.addenda ?? []) sections.push(loadout.prompt.placebo === true ? placeboFor(addendum.id, addendum.text) : addendum.text);
  const clean = loadout.prompt.clean_env;
  if (clean !== undefined) sections.push(loadout.prompt.clean_env_placebo === true ? placeboFor("clean_env", clean.text) : clean.text);
  if (loadout.context.env === "system") sections.push(envBlock(env));
  return sections.join("\n\n");
}

/** The delay before retry `attempt` (1-based): a server-requested delay when the error names one, else exponential; capped at max_ms. */
export function retryDelayMs(retry: Loadout["policy"]["retry"], attempt: number, errorMessage: string | undefined): number {
  const text = errorMessage ?? "";
  const requested = /Server requested (\d+(?:\.\d+)?)s retry delay/iu.exec(text) ?? /try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/iu.exec(text);
  const server = requested === null ? undefined : Number(requested[1]) * (requested[2]?.toLowerCase() === "ms" ? 1 : 1000);
  const backoff = retry.base_ms * 2 ** Math.max(0, attempt - 1);
  return Math.round(Math.min(retry.max_ms, Math.max(backoff, server ?? 0)));
}

/** Resolves true after `ms`, false at once if the signal aborts. */
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

/**
 * policy.validator's side call: one completion on the run's provider, model, base URL and key (a faux model: its own
 * script), at the lever's effort, with the loadout's wire knobs (own session id, so it never shares the agent loop's
 * cache key or task key), over HTTP, never on the run's WebSocket; Pi's pre-stream retries as the loop's.
 */
export function sideCallOf(loadout: Loadout, spec: string, modelOptions: ModelOptions, resolved: ReturnType<typeof resolveModel>, steps?: FauxResponseStep[]): SideCall | undefined {
  const lever = loadout.policy.validator;
  if (lever === undefined) return undefined;
  return sideClient(loadout, resolveSideModel(spec, modelOptions, resolved, steps), lever.effort);
}

/**
 * policy.clause_check's side call: the validator's client (the run's provider, model, base URL and key, a faux model its own script;
 * own session id; the loadout's wire knobs; HTTP, never the run's WebSocket) at the RUN's effort, the only one the metering proxy
 * takes. `effort` is the run's (undefined when its thinking is off).
 */
export function clauseCallOf(
  loadout: Loadout, spec: string, modelOptions: ModelOptions, resolved: ReturnType<typeof resolveModel>, effort: Effort | undefined, steps?: FauxResponseStep[],
): SideCall | undefined {
  if (loadout.policy.clause_check === undefined) return undefined;
  return sideClient(loadout, resolveSideModel(spec, modelOptions, resolved, steps, "clause_steps"), effort);
}

/**
 * The program tool's ask() (tools.program.limits.ask): one completion on the run's own client, model and effort (the
 * validator's client: metered where the run's requests are), with ASK_SYSTEM and the prompt only; its usage joins the
 * run's totals and budgets as the side request "program_ask". A faux run's script supplies its `ask_steps`.
 */
function programAskOf(loadout: Loadout, options: RunOptions, resolved: ReturnType<typeof resolveModel>, thinking: ThinkingLevel, recorder: Recorder): ProgramAsk | undefined {
  if (loadout.tools.program?.limits.ask !== true) return undefined;
  const effort = thinking === "off" ? undefined : options.effort;
  const call = sideClient(loadout, resolveSideModel(options.model, options.modelOptions ?? {}, resolved, options.askFauxSteps, "ask_steps"), effort);
  return async (prompt, { json, maxTokens, signal }) => {
    const started = performance.now();
    const reply = await call({ systemPrompt: ASK_SYSTEM(json), messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
      { ...(thinking === "off" ? {} : { reasoning: thinking }), maxTokens, signal });
    recorder.sideRequest("program_ask", reply, performance.now() - started);
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`ask: ${reply.errorMessage ?? reply.stopReason}`);
    return reply.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  };
}

/** One completion on a side model's client with the loadout's wire knobs and a session id (cache key) of its own. */
function sideClient(loadout: Loadout, side: ResolvedModel, effort: Effort | undefined): SideCall {
  const sessionId = randomUUID();
  const wire = wireSetup(loadout.wire, side.model, sessionId, effort);
  return (context, options) => side.models.completeSimple(wire.model, context, {
    apiKey: side.apiKey(), sessionId, cacheRetention: loadout.wire.cache_retention, maxRetries: loadout.wire.max_retries, ...wire.streamOptions,
    ...(wire.onPayload === undefined ? {} : { onPayload: wire.onPayload }), ...options,
  });
}

/**
 * The loadout's tools, and a dispose that stops what they left running (exec cells). MCP tools (`mcp`) join as one
 * tool each after the surface's own when loadout.mcp.exposure is "direct" (the default) or "both", and reach the
 * program tool (compact) or the exec cells (exec, as Codex's deferred `mcp__` nested tools) when it is "program" or "both".
 */
export function buildTools(
  loadout: Loadout, env: ExecEnv, images: boolean, mcp: readonly McpToolHandle[] = [], scripts?: ScriptStore, ask?: ProgramAsk, nested?: NestedHooks,
): { tools: AgentTool<any>[]; dispose(): Promise<void> } {
  const exposure = loadout.mcp?.exposure ?? "direct";
  const inProgram = exposure === "program" || exposure === "both" ? mcp : [];
  const direct = exposure === "direct" || exposure === "both" ? mcpDirectTools(mcp) : [];
  if (exposure !== "direct" && mcp.length > 0 && loadout.surface === "compact" && (loadout.tools.program === undefined || loadout.tools.program.exposure === "off")) {
    throw new Error(`mcp.exposure "${exposure}" needs the program tool on surface compact (tools.program)`);
  }
  if (loadout.surface === "compact") {
    return {
      tools: [...compactTools({ env, loadout, images, mcp: inProgram, ...(scripts === undefined ? {} : { scripts }), ...(ask === undefined ? {} : { ask }), ...(nested === undefined ? {} : { nested }) }), ...direct],
      dispose: async () => {},
    };
  }
  // The exec surface is code mode already: "program" puts MCP tools in its cells as Codex does (deferred mcp__ tools).
  const surface = execSurface({ env, loadout, images, mcp: inProgram, ...(nested === undefined ? {} : { nested }) });
  return { tools: [...surface.tools, ...direct], dispose: surface.dispose };
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export async function runHarness(options: RunOptions): Promise<RunResult> {
  const { loadout, env } = options;
  // Invocation errors (unknown model, unpriced USD budget, unbuilt surface) throw before the run starts.
  const resolved = resolveModel(options.model, options.modelOptions ?? {}, options.fauxSteps);
  const model = resolved.model;
  const thinking = thinkingLevelFor(model, options.effort);
  const budgets = mergeBudgets(loadout.policy.budgets, options.budgets ?? {});
  if (budgets.usd !== undefined && costOf(model, ZERO_USAGE, loadout.prices) === undefined) {
    throw new Error(`budget: a USD budget needs a price for ${model.provider}/${model.id}; add it to the loadout's prices`);
  }
  // The loadout's shell flags reach the env before any tool can run a command (all off: commands run as before).
  // An env that cannot apply them (DockerEnv) fails the run up front: an arm labeled B3 must not run without B3.
  const shell = shellSettingsOf(loadout);
  if (Object.keys(shell).length > 0) {
    if (env.configureShell === undefined) throw new Error(`env ${env.id}: this env does not apply the loadout's shell flags (${Object.keys(shell).join(", ")}); turn them off for it`);
    env.configureShell(shell);
  } else {
    env.configureShell?.(shell);
  }
  // D2/D4 on Anthropic with effort as a top-level field (the plain wire, budget thinking): each change of effort or budget
  // invalidates the messages cache (Anthropic's caching docs), so the arm would pay a full cache write per flip. Pi's
  // default wire sends it as per-message effort, which keeps the cache.
  const perRequest = [loadout.depth?.escalate === undefined ? undefined : "depth.escalate", loadout.depth?.deescalate === undefined ? undefined : "depth.deescalate"]
    .filter((name) => name !== undefined).join(" and ");
  const midConvo = loadout.wire.mid_convo_effort !== false && (model.compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort === true;
  if (perRequest !== "" && thinking !== "off" && model.api === "anthropic-messages" && !midConvo) {
    throw new Error(`${perRequest}: ${model.provider}/${model.id} would get its effort as a top-level field, and each change invalidates its messages cache; ` +
      `use a wire with mid_convo_effort on (per-message effort) or turn ${perRequest} off`);
  }
  // D4 on any other API's per-turn effort items (OpenAI on Pi's default wire): every flip appends a configuration_update item, the
  // per-turn item that cuts reasoning (DESIGN fact 2), so the arm would measure the items, not the lever. Plain wire only.
  if (loadout.depth?.deescalate !== undefined && thinking !== "off" && model.api !== "anthropic-messages" && midConvo) {
    throw new Error(`depth.deescalate: ${model.provider}/${model.id} would get each effort change as an appended configuration_update item; ` +
      "set wire.mid_convo_effort false (plain reasoning.effort per request) or turn depth.deescalate off");
  }
  // P6 states the wall budget; without one the arm would silently run as its control.
  if (loadout.prompt.time_budget !== undefined && budgets.wall_s === undefined) {
    throw new Error("prompt.time_budget: there is no wall budget to state; pass --max-wall-s (or set policy.budgets.wall_s) or turn it off");
  }
  // W1 moves OpenAI Responses requests only; an arm labeled ws must not silently run over HTTP on another API.
  if (loadout.wire.transport === "ws" && model.api !== "openai-responses") {
    throw new Error(`wire.transport "ws": ${model.provider}/${model.id} speaks ${model.api}; the WebSocket transport is OpenAI Responses only`);
  }
  // MCP servers start before the tools are built: their tool list is part of the frozen prefix.
  const mcp = options.mcpServers === undefined ? undefined : await connectMcp(options.mcpServers);
  const recorder = new Recorder(options.tracePath, model, loadout.prices, { cacheMonitor: loadout.trace?.cache_monitor === true });
  const ask = programAskOf(loadout, options, resolved, thinking, recorder);
  const built = buildTools(loadout, env, model.input.includes("image"), mcp?.tools ?? [], options.scriptsDir === undefined ? undefined : new ScriptStore(options.scriptsDir), ask);
  const tools = built.tools;
  const transcript = options.transcriptPath === undefined ? undefined : new Transcript(options.transcriptPath);
  const abort = new AbortController();
  const onExternalAbort = () => abort.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  const sideCall = sideCallOf(loadout, options.model, options.modelOptions ?? {}, resolved, options.validatorFauxSteps);
  // policy.critic's review loop: the run's provider, model, base URL and key (a faux model: its own script).
  const criticModel = loadout.policy.critic === undefined ? undefined : resolveSideModel(options.model, options.modelOptions ?? {}, resolved, options.criticFauxSteps, "critic_steps");
  // policy.clause_check's side call: the run's client at the run's own effort.
  const clauseCall = clauseCallOf(loadout, options.model, options.modelOptions ?? {}, resolved, thinking === "off" ? undefined : options.effort, options.clauseFauxSteps);
  const levers = new LeverState({
    loadout, budgets, recorder, env, model, thinking, task: options.prompt, signal: abort.signal, images: model.input.includes("image"),
    ...(sideCall === undefined ? {} : { sideCall }), ...(criticModel === undefined ? {} : { criticModel }), ...(clauseCall === undefined ? {} : { clauseCall }),
  });
  const snapshotMode = options.finishSnapshot?.mode ?? loadout.trace?.finish_snapshot;
  const snapshotDir = options.finishSnapshot?.dir ?? (options.resultPath === undefined ? undefined : dirname(options.resultPath));
  const snapshotMaxMb = options.finishSnapshot?.maxMb ?? loadout.trace?.snapshot_max_mb;
  const snapshot = snapshotMode === undefined ? undefined : new FinishSnapshot({
    env, recorder, mode: snapshotMode, ...(snapshotMaxMb === undefined ? {} : { maxMb: snapshotMaxMb }), ...(snapshotDir === undefined ? {} : { hostDir: snapshotDir }),
  });
  const policy = new Policy(loadout, budgets, recorder, abort, levers.active ? levers : undefined, snapshot);
  const behaviorHash = loadoutHash(loadout);
  const version = { bundle_sha256: options.bundleSha256 ?? "source", loadout_hash: options.loadoutHash ?? behaviorHash, loadout_name: loadout.name, behavior_hash: behaviorHash };
  let retries = 0;
  const base = () => ({ version, model: `${model.provider}/${model.id}`, effort: options.effort, thinking_level: thinking, provider_retries: retries });
  let result: RunResult;
  let ws: WsTransport | undefined;
  let keepalive: CacheKeepAlive | undefined;
  try {
    const system = createInitialSystemMessage(systemPromptOf(loadout, env), tools.map(toToolDeclaration));
    const promptIds = [...loadout.prompt.sections.map((section) => section.id),
      ...(loadout.prompt.addenda ?? []).map((addendum) => (loadout.prompt.placebo === true ? `placebo:${addendum.id}` : addendum.id)),
      ...(loadout.prompt.clean_env === undefined ? [] : [loadout.prompt.clean_env_placebo === true ? "placebo:clean_env" : "clean_env"])];
    transcript?.system(systemPromptOf(loadout, env), promptIds, tools.map(toToolDeclaration));
    recorder.event("run_start", {
      model: base().model, effort: options.effort, thinking_level: thinking, loadout: loadout.name, loadout_hash: version.loadout_hash,
      behavior_hash: behaviorHash, bundle_sha256: version.bundle_sha256, env: env.id, ...(env.user === undefined ? {} : { user: env.user }),
      tools: tools.map((tool) => tool.name), budgets, ...(snapshot === undefined ? {} : { finish_snapshot: snapshot.mode }),
    });
    const sessionId = randomUUID();
    // W1: one socket per run, opened now so its handshake overlaps discovery and the first request's build. Its
    // headers are the ones pi-ai sends on every HTTP request to OpenAI: the key, the session affinity ids.
    if (loadout.wire.ws !== undefined) {
      const affinity = (model.compat as { sessionAffinityFormat?: string } | undefined)?.sessionAffinityFormat;
      const session = loadout.wire.cache_retention === "none" ? {} : { "x-client-request-id": sessionId, ...(affinity === "openai" ? { session_id: sessionId } : {}) };
      ws = new WsTransport(loadout.wire.ws, {
        url: `${model.baseUrl.replace(/\/+$/u, "")}/responses`.replace(/^http/u, "ws"),
        headers: { authorization: `Bearer ${resolved.apiKey()}`, ...session, ...(model.headers ?? {}) },
        event: (type, fields) => recorder.event(type, { n: recorder.usage.requests + 1, ...fields }),
      });
      ws.connect();
    }
    // P3 discovery (and the evidence gate's start marker) run before the first request; the orientation joins the task.
    const orientation = await levers.start();
    // P6: one line after the task, in the first message only, so every later request extends it.
    const timeBudget = timeBudgetLine(loadout, budgets.wall_s);
    if (timeBudget !== undefined) {
      recorder.policy("orient", "time_budget", { minutes: timeBudget.minutes, placebo: loadout.prompt.time_budget_placebo === true });
    }
    // prompt.requirements: the task's own requirement sentences, numbered, right after it (before the orientation), once.
    const requirements = requirementsBlock(loadout, options.prompt);
    if (requirements !== undefined) {
      recorder.policy("orient", "requirements", { items: requirements.items, more: requirements.more, tokens: requirements.tokens, placebo: requirements.placebo });
      if (!requirements.placebo && requirements.items > 0) levers.listedRequirements(requirements.items);
    }
    const task = [loadout.context.env === "user" ? envBlock(env) : undefined, options.prompt, requirements?.text, timeBudget?.text, orientation]
      .filter((part) => part !== undefined).join("\n\n");
    const prompt: AgentMessage = { role: "user", content: [{ type: "text", text: task }], timestamp: Date.now() };
    // D2/D4 set the effort per request; the anthropic budget rewrite reads the effort of the request it is rewriting.
    let requestEffort: Effort | undefined = thinking === "off" ? undefined : options.effort;
    const wire = wireSetup(loadout.wire, model, sessionId, () => requestEffort);
    const config: AgentLoopConfig = {
      model: wire.model,
      ...(thinking === "off" ? {} : { reasoning: thinking }),
      sessionId,
      cacheRetention: loadout.wire.cache_retention,
      maxRetries: loadout.wire.max_retries,
      ...(loadout.wire.max_output_tokens === undefined ? {} : { maxTokens: loadout.wire.max_output_tokens }),
      ...(loadout.wire.transport === undefined || loadout.wire.transport === "ws" ? {} : { transport: loadout.wire.transport }),
      ...(wire.onPayload === undefined && loadout.trace?.cache_monitor !== true ? {} : {
        onPayload: async (payload: unknown, payloadModel: Parameters<NonNullable<typeof wire.onPayload>>[1]) => {
          const body = wire.onPayload === undefined ? payload : await wire.onPayload(payload, payloadModel);
          recorder.observeRequest(body ?? payload);
          return body;
        },
      }),
      toolExecution: loadout.policy.tool_execution,
      convertToLlm: (messages) => messages.filter((message) =>
        message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "toolResult"),
      getApiKey: () => resolved.apiKey(),
      prepareRequest: (request) => {
        const next = levers.requestLevel();
        recorder.requestStart(request.context.messages.length, next?.level, next?.reason);
        if (next === undefined) return undefined;
        requestEffort = next.level === "off" ? undefined : next.level;
        return { thinkingLevel: next.level };
      },
      beforeToolCall: policy.beforeToolCall,
      afterToolCall: policy.afterToolCall,
      finishTurn: policy.finishTurn,
      getFollowUpMessages: policy.getFollowUpMessages,
    };
    const transport = ws;
    // wire.anthropic.keepalive_s: pings ride the same fetch as the agent loop's requests (same URL, headers, metering).
    const keepaliveS = loadout.wire.anthropic?.keepalive_s;
    // wire.anthropic.thread: under the keep-alive, so pings (max_tokens 0) see full requests and pass the thread layer untouched.
    const threads = loadout.wire.anthropic?.thread === true && model.api === "anthropic-messages" && transport === undefined
      ? new AnthropicThreads({ base: globalThis.fetch.bind(globalThis), onEvent: (event) => recorder.event("thread", { n: recorder.usage.requests + 1, ...event }) })
      : undefined;
    if (keepaliveS !== undefined && model.api === "anthropic-messages" && transport === undefined) {
      keepalive = new CacheKeepAlive({
        intervalMs: keepaliveS * 1000, maxPerGap: loadout.wire.anthropic?.keepalive_max ?? 12, base: threads?.fetch ?? globalThis.fetch.bind(globalThis),
        onPing: (usage, latencyMs, error) => recorder.sideRequest("cache_keepalive", keepaliveMessage(model, usage, error), latencyMs),
      });
    }
    const requestFetch = transport?.fetch ?? keepalive?.fetch ?? threads?.fetch;
    const streamFn: StreamFn = (requestModel, context, streamOptions) =>
      resolved.models.streamSimple(requestModel, context, { ...streamOptions, ...wire.streamOptions, ...(requestFetch === undefined ? {} : { fetch: requestFetch }) });
    const emit = (event: AgentEvent) => {
      recorder.onEvent(event);
      transcript?.onEvent(event);
    };
    const history: AgentMessage[] = system === undefined ? [] : [system];
    const { attempts } = loadout.policy.retry;
    // One user turn: the loop until the model's final answer, with transient provider errors retried.
    const runTurn = async (message: AgentMessage) => {
      history.push(...await runAgentLoop([message], { messages: [...history], tools }, config, emit, abort.signal, streamFn));
      for (let streak = 0; ;) {
        const failed = history.at(-1);
        if (failed?.role !== "assistant" || failed.stopReason !== "error" || !isRetryableAssistantError(failed)) break;
        if (streak >= attempts || policy.stopReason !== undefined || abort.signal.aborted || policy.budgetExceeded()) break;
        streak++;
        retries++;
        const delayMs = retryDelayMs(loadout.policy.retry, streak, failed.errorMessage);
        recorder.policy("retry", "provider_transient", { attempt: streak, of: attempts, delay_ms: delayMs, error: failed.errorMessage });
        if (!(await sleep(delayMs, abort.signal))) break;
        history.pop(); // the failed response never reaches the model: the retry sends the failed request again
        const more = await runAgentLoopContinue({ messages: [...history], tools }, config, emit, abort.signal, streamFn);
        if (more.some((message) => message.role === "assistant" && message.stopReason !== "error")) streak = 0;
        history.push(...more);
      }
    };
    // A session (--followups): each follow-up goes after the previous turn's final answer and the turn-end hook.
    const session = options.followups !== undefined;
    if (session) recorder.sessionTurns = [];
    const endTurn = async (n: number, from: { requests: number; cost: number | null; at: number }) => {
      if (!session) return;
      const last = [...history].reverse().find((message): message is AssistantMessage => message.role === "assistant");
      const text = (last?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
      const turn = { n, requests: recorder.usage.requests - from.requests,
        cost_usd: recorder.costUsd === null || from.cost === null ? null : round6(recorder.costUsd - from.cost), wall_s: round6((performance.now() - from.at) / 1000) };
      recorder.sessionTurns!.push(turn);
      recorder.event("session_turn", { ...turn });
      await options.onTurnEnd?.(n, text);
    };
    const mark = () => ({ requests: recorder.usage.requests, cost: recorder.costUsd, at: performance.now() });
    let from = mark();
    await runTurn(prompt);
    await endTurn(1, from);
    for (const [index, text] of (options.followups ?? []).entries()) {
      const last = history.at(-1);
      if (policy.stopReason !== undefined || abort.signal.aborted || policy.budgetExceeded() || (last?.role === "assistant" && last.stopReason === "error")) break;
      from = mark();
      await runTurn({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
      await endTurn(index + 2, from);
    }
    // The validator's and clause_check's side calls, if still running, end with the run; their usage joins the totals before the
    // result is taken. (The critic's review runs inside a finish attempt, so it is over by now.)
    await levers.close();
    const last = [...history].reverse().find((message): message is AssistantMessage => message.role === "assistant");
    if (policy.stopReason !== undefined) {
      result = recorder.result({ ...base(), status: "stopped", stop_reason: policy.stopReason });
    } else if (last?.stopReason === "aborted" || abort.signal.aborted) {
      result = recorder.result({ ...base(), status: "stopped", stop_reason: "aborted" });
    } else if (last?.stopReason === "error") {
      // provider_unavailable: transient (outage, overload, rate limit) after every retry; provider_error: the provider refused the request.
      const transient = isRetryableAssistantError(last);
      result = recorder.result({
        ...base(), status: "error", stop_reason: transient ? "provider_unavailable" : "provider_error",
        error: `${last.errorMessage ?? "provider error"}${transient ? ` (after ${retries} retries)` : ""}`,
      });
    } else {
      result = recorder.result({ ...base(), status: "finished", stop_reason: "done" });
    }
  } catch (error) {
    result = recorder.result({ ...base(), status: "error", stop_reason: "harness_error", error: error instanceof Error ? error.message : String(error) });
  } finally {
    ws?.close();
    keepalive?.close();
    await mcp?.close();
    policy.dispose();
    await levers.close().catch(() => undefined);
    transcript?.close();
    await built.dispose().catch(() => undefined);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
  if (ws !== undefined) result.transport = ws.summary();
  if (snapshot !== undefined) result.first_finish = await snapshot.settle(abort.signal.aborted).catch((error: unknown) => ({
    mode: snapshot.mode, cwd: env.cwd, skipped: "failed" as const, error: error instanceof Error ? error.message : String(error),
  }));
  recorder.finish(result, options.resultPath);
  return result;
}

/** A keep-alive ping as the recorder's side request: no content, the ping's cache read (and any write) as usage. */
function keepaliveMessage(model: Model<Api>, usage: KeepAliveUsage | undefined, error: string | undefined): AssistantMessage {
  const counted = usage ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  return {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: {
      ...counted, totalTokens: counted.input + counted.cacheRead + counted.cacheWrite + counted.output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: error === undefined ? "length" : "error", ...(error === undefined ? {} : { errorMessage: error }), timestamp: Date.now(),
  };
}
