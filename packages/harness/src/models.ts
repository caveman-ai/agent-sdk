/**
 * Provider wiring through pi-ai: the catalog model for `provider/id`, base
 * URL overrides, the API key from a named env var, effort clamped to what the
 * model supports, and a scripted faux provider for offline tests. Unknown
 * models and a missing key fail closed.
 *
 * The key is read once, here, and handed to Pi as an explicit key on every
 * request. Pi falls back to its own ambient auth (OPENAI_API_KEY,
 * ANTHROPIC_AUTH_TOKEN/OAUTH_TOKEN/API_KEY, stored credentials) whenever the
 * key it gets is empty, which would send a key other than the per-trial token
 * to the base URL; so an unset or empty key variable is an invocation error.
 */
import { readFileSync } from "node:fs";
import {
  calculateCost, clampThinkingLevel, createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall,
  type Api, type AssistantMessage, type FauxContentBlock, type FauxResponseStep, type Model, type MutableModels, type Usage,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelOptions {
  openaiBaseUrl?: string;
  anthropicBaseUrl?: string;
  /** Env var holding the key; default OPENAI_API_KEY / ANTHROPIC_API_KEY by provider. */
  apiKeyEnv?: string;
  /** Scripted responses for `faux/<id>` models (tests). */
  fauxScript?: string;
}

export interface ResolvedModel {
  models: MutableModels;
  model: Model<Api>;
  apiKey: () => string;
}

export interface FauxStep {
  text?: string;
  thinking?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown>; id?: string }[];
  stopReason?: AssistantMessage["stopReason"];
  errorMessage?: string;
}

/** A scripted faux step as a pi-ai faux message. */
export function fauxStep(step: FauxStep): AssistantMessage {
  const content: FauxContentBlock[] = [];
  if (step.thinking !== undefined) content.push(fauxThinking(step.thinking));
  if (step.text !== undefined) content.push(fauxText(step.text));
  for (const call of step.toolCalls ?? []) content.push(fauxToolCall(call.name, call.arguments as never, call.id === undefined ? {} : { id: call.id }));
  const stopReason = step.stopReason ?? ((step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
  return fauxAssistantMessage(content, { stopReason, ...(step.errorMessage === undefined ? {} : { errorMessage: step.errorMessage }) });
}

/** Faux prices, so budget and cost paths run offline: USD per million tokens. */
const FAUX_COST = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 };

export function resolveModel(spec: string, options: ModelOptions = {}, steps?: FauxResponseStep[]): ResolvedModel {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`model: want provider/id, got ${JSON.stringify(spec)}`);
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  const models = createModels();
  if (provider === "faux") {
    const faux = fauxProvider({ provider: "faux", models: [{ id, reasoning: true, cost: FAUX_COST, contextWindow: 200_000, maxTokens: 32_000 }], tokensPerSecond: 1e9 });
    models.setProvider(faux.provider);
    let script = steps;
    if (script === undefined) {
      if (options.fauxScript === undefined) throw new Error("model: faux models need --faux-script <file.json>");
      const parsed = JSON.parse(readFileSync(options.fauxScript, "utf8")) as { steps: FauxStep[] };
      script = parsed.steps.map(fauxStep);
    }
    faux.setResponses(script);
    return { models, model: faux.getModel(), apiKey: () => "faux" };
  }
  if (provider === "openai") models.setProvider(openaiProvider());
  else if (provider === "anthropic") models.setProvider(anthropicProvider());
  else throw new Error(`model: provider ${JSON.stringify(provider)} is not wired (openai, anthropic, faux)`);
  const found = models.getModel(provider, id);
  if (found === undefined) throw new Error(`model: ${spec} is not in the pi-ai catalog`);
  const baseUrl = provider === "openai" ? options.openaiBaseUrl : options.anthropicBaseUrl;
  const model = baseUrl === undefined ? found : { ...found, baseUrl };
  const keyEnv = options.apiKeyEnv ?? (provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  const key = process.env[keyEnv]?.trim() ?? "";
  if (key === "") throw new Error(`model: ${keyEnv} is unset or empty; ${spec} needs its key there${options.apiKeyEnv === undefined ? " (or name another variable with --api-key-env)" : ""}`);
  return { models, model, apiKey: () => key };
}

/**
 * The client of a harness side call (policy.validator's generation, policy.critic's review loop, policy.clause_check's call): the
 * run's own provider, model, base URL and key, so the call is metered where the run's requests are. A faux model gets a faux provider
 * of its own, scripted by `steps` (else the faux script's `validator_steps`, `critic_steps` or `clause_steps`, by `key`; else nothing:
 * the call fails and the lever records it), so the agent loop's script is untouched.
 */
export function resolveSideModel(
  spec: string, options: ModelOptions, run: ResolvedModel, steps?: FauxResponseStep[], key: "validator_steps" | "critic_steps" | "clause_steps" | "ask_steps" = "validator_steps",
): ResolvedModel {
  if (run.model.provider !== "faux") return run;
  let script = steps;
  if (script === undefined) {
    const parsed = options.fauxScript === undefined ? {} : JSON.parse(readFileSync(options.fauxScript, "utf8")) as Partial<Record<typeof key, FauxStep[]>>;
    script = (parsed[key] ?? []).map(fauxStep);
  }
  return resolveModel(spec, {}, script);
}

/** The thinking level a model runs at for an effort: Pi's clamp to the model's supported levels. */
export function thinkingLevelFor(model: Model<Api>, effort: Effort): ThinkingLevel {
  if (!model.reasoning) return "off";
  return clampThinkingLevel(model, effort) as ThinkingLevel;
}

export type Prices = Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;

/**
 * USD of one response: the loadout's price for `provider/id` when it has one,
 * else the catalog's. Undefined when neither knows the model (fail closed:
 * the caller must not report a cost or enforce a USD budget on a guess).
 */
export function costOf(model: Model<Api>, usage: Usage, prices: Prices): number | undefined {
  const override = prices[`${model.provider}/${model.id}`];
  const priced = override === undefined ? model : { ...model, cost: { ...override } };
  const rates = priced.cost as { input?: number; output?: number } | undefined;
  if (rates === undefined || ((rates.input ?? 0) === 0 && (rates.output ?? 0) === 0)) return undefined;
  return calculateCost(priced, { ...usage, cost: { ...usage.cost } }).total;
}
