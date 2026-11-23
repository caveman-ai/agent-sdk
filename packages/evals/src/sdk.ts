import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ScoreResult = {
  name: string;
  value: number | null;
  label?: string | undefined;
  rationale?: string | undefined;
  error?: string | undefined;
  source?: "code" | "llm" | "human" | undefined;
  cost_usd?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type EvalSpan = {
  span_id: string;
  parent_id?: string | undefined;
  name: string;
  kind: "llm" | "tool" | "agent" | "custom";
  input?: unknown;
  output?: unknown;
  error?: string | undefined;
  started_at: string;
  ended_at: string;
  metrics?: Record<string, unknown> | undefined;
};

export type EvalCase<I = unknown, E = unknown> = {
  item_key?: string | undefined;
  id?: string | undefined;
  input: I;
  expected?: E | undefined;
  metadata?: Record<string, unknown> | undefined;
};

export type DatasetRef = {
  readonly __cavemanDataset: true;
  name: string;
  version?: number | undefined;
};

export type ScorerContext<I = unknown, O = unknown, E = unknown> = {
  input: I;
  output: O;
  expected?: E | undefined;
  spans: EvalSpan[];
  metadata?: Record<string, unknown> | undefined;
};

export type ScorerFn<I = unknown, O = unknown, E = unknown> = (
  ctx: ScorerContext<I, O, E>,
) => ScoreResult | ScoreResult[] | Promise<ScoreResult | ScoreResult[]>;

export type EvalOptions<I = unknown, O = unknown, E = unknown> = {
  data: Iterable<EvalCase<I, E>> | DatasetRef;
  task: (input: I, ctx: { spans: EvalSpan[] }) => O | Promise<O>;
  scorers?: ScorerFn<I, O, E>[] | undefined;
  trials?: number | undefined;
  concurrency?: number | undefined;
  baseline?: string | undefined;
  scorerIds?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  apiUrl?: string | undefined;
  apiKey?: string | undefined;
  projectId?: string | undefined;
  localCachePath?: string | undefined;
  /** Thresholds for CI exit gating (--ci). */
  ci?: {
    repo?: string | undefined;
    prNumber?: number | undefined;
    failUnder?: number | undefined;
    maxRegression?: number | undefined;
  } | undefined;
};

export type EvalSummaryScore = {
  mean: number;
  pass_at_k: number;
  pass_pow_k: number;
  count: number;
};

export type EvalRunResult = {
  experimentName: string;
  experimentId: string | null;
  consoleUrl: string | null;
  prComment: string | null;
  summary: {
    total_trials: number;
    scores: Record<string, EvalSummaryScore>;
  };
  results: Array<{
    item_key: string;
    trial: number;
    status: "completed" | "error";
    input: unknown;
    output: unknown;
    expected?: unknown;
    error?: string | undefined;
    spans: EvalSpan[];
    metrics: {
      duration_ms: number;
      input_tokens: number;
      output_tokens: number;
    };
    scores: ScoreResult[];
  }>;
  passedCI: boolean;
};

type TraceContext = {
  spans: EvalSpan[];
  parentId?: string | undefined;
};

const traceALS = new AsyncLocalStorage<TraceContext>();

/** Reference a named dataset stored in Caveman Cloud. */
export function dataset(name: string, opts?: { version?: number }): DatasetRef {
  return { __cavemanDataset: true, name, version: opts?.version };
}

function recordSpan(span: EvalSpan): void {
  const ctx = traceALS.getStore();
  if (ctx) ctx.spans.push(span);
}

/** Wrap any sync or async tool/step call to emit an inline span automatically. */
export async function traced<T>(
  name: string,
  fn: () => T | Promise<T>,
  opts?: { kind?: EvalSpan["kind"]; input?: unknown },
): Promise<T> {
  const parent = traceALS.getStore();
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const startedAt = new Date().toISOString();
  const kind = opts?.kind ?? "tool";
  const nextCtx: TraceContext = { spans: parent?.spans ?? [], parentId: spanId };

  return traceALS.run(nextCtx, async () => {
    try {
      const output = await fn();
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name,
        kind,
        input: opts?.input,
        output,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      });
      return output;
    } catch (err) {
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name,
        kind,
        input: opts?.input,
        error: err instanceof Error ? err.message : String(err),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      });
      throw err;
    }
  });
}

/** 1-line wrapper for OpenAI JS/TS clients to auto-capture chat.completions.create spans. */
export function wrapOpenAI<T extends { chat: { completions: { create: (...args: any[]) => Promise<any> } } }>(client: T): T {
  const orig = client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create = async (...args: any[]) => {
    const params = (args[0] ?? {}) as { model?: string; messages?: unknown };
    const parent = traceALS.getStore();
    const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
    const startedAt = new Date().toISOString();
    try {
      const resp = await orig(...args);
      const usage = resp?.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name: `openai:${params.model ?? "unknown"}`,
        kind: "llm",
        input: params.messages,
        output: resp?.choices?.[0]?.message?.content ?? null,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        metrics: {
          model: params.model,
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
        },
      });
      return resp;
    } catch (err) {
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name: `openai:${params.model ?? "unknown"}`,
        kind: "llm",
        input: params.messages,
        error: err instanceof Error ? err.message : String(err),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        metrics: { model: params.model },
      });
      throw err;
    }
  };
  return client;
}

/** 1-line wrapper for Anthropic JS/TS clients to auto-capture messages.create spans. */
export function wrapAnthropic<T extends { messages: { create: (...args: any[]) => Promise<any> } }>(client: T): T {
  const orig = client.messages.create.bind(client.messages);
  client.messages.create = async (...args: any[]) => {
    const params = (args[0] ?? {}) as { model?: string; messages?: unknown };
    const parent = traceALS.getStore();
    const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
    const startedAt = new Date().toISOString();
    try {
      const resp = await orig(...args);
      const usage = resp?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name: `anthropic:${params.model ?? "unknown"}`,
        kind: "llm",
        input: params.messages,
        output: resp?.content ?? null,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        metrics: {
          model: params.model,
          input_tokens: usage?.input_tokens ?? 0,
          output_tokens: usage?.output_tokens ?? 0,
        },
      });
      return resp;
    } catch (err) {
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name: `anthropic:${params.model ?? "unknown"}`,
        kind: "llm",
        input: params.messages,
        error: err instanceof Error ? err.message : String(err),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        metrics: { model: params.model },
      });
      throw err;
    }
  };
  return client;
}

/** 1-line wrapper for Vercel AI SDK functions (generateText / generateObject). */
export function wrapVercelAI<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  const wrapped = async (...args: any[]) => {
    const params = (args[0] ?? {}) as {
      model?: string | { modelId?: string };
      prompt?: unknown;
      messages?: unknown;
      system?: string;
    };
    const modelName =
      typeof params.model === "string"
        ? params.model
        : params.model?.modelId ?? "vercel-ai";
    const parent = traceALS.getStore();
    const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
    const startedAt = new Date().toISOString();
    const input = params.messages ?? params.prompt ?? null;
    try {
      const resp = await fn(...args);
      const usage = (resp?.usage ?? {}) as {
        promptTokens?: number;
        completionTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
      };
      const toolCalls = Array.isArray(resp?.toolCalls) ? resp.toolCalls : [];
      for (const tc of toolCalls) {
        const tcName = String((tc as { toolName?: string; name?: string })?.toolName ?? (tc as { name?: string })?.name ?? "tool");
        recordSpan({
          span_id: randomUUID().replace(/-/g, "").slice(0, 16),
          parent_id: spanId,
          name: tcName,
          kind: "tool",
          input: (tc as { args?: unknown; input?: unknown })?.args ?? (tc as { input?: unknown })?.input,
          started_at: startedAt,
          ended_at: new Date().toISOString(),
        });
      }
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name: `vercel-ai:${modelName}`,
        kind: "llm",
        input,
        output: resp?.text ?? resp?.object ?? null,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        metrics: {
          model: modelName,
          input_tokens: usage.inputTokens ?? usage.promptTokens ?? 0,
          output_tokens: usage.outputTokens ?? usage.completionTokens ?? 0,
        },
      });
      return resp;
    } catch (err) {
      recordSpan({
        span_id: spanId,
        parent_id: parent?.parentId,
        name: `vercel-ai:${modelName}`,
        kind: "llm",
        input,
        error: err instanceof Error ? err.message : String(err),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        metrics: { model: modelName },
      });
      throw err;
    }
  };
  return wrapped as T;
}

/** Wrap a custom agent loop (async function or async generator) to emit a nested agent span. */
export function wrapAgent<A extends unknown[], R>(
  name: string,
  runFn: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const parent = traceALS.getStore();
    const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
    const startedAt = new Date().toISOString();
    const nextCtx: TraceContext = { spans: parent?.spans ?? [], parentId: spanId };

    return traceALS.run(nextCtx, async () => {
      try {
        const result = await runFn(...args);
        const maybeIter = result as unknown as AsyncIterable<unknown> | null;
        if (maybeIter && typeof maybeIter[Symbol.asyncIterator] === "function") {
          const chunks: unknown[] = [];
          for await (const chunk of maybeIter) {
            chunks.push(chunk);
          }
          const combined = chunks.every((c) => typeof c === "string") ? chunks.join("") : chunks;
          recordSpan({
            span_id: spanId,
            parent_id: parent?.parentId,
            name,
            kind: "agent",
            input: args.length === 1 ? args[0] : args,
            output: combined,
            started_at: startedAt,
            ended_at: new Date().toISOString(),
            metrics: { chunks: chunks.length },
          });
          return combined as R;
        }
        recordSpan({
          span_id: spanId,
          parent_id: parent?.parentId,
          name,
          kind: "agent",
          input: args.length === 1 ? args[0] : args,
          output: result,
          started_at: startedAt,
          ended_at: new Date().toISOString(),
        });
        return result;
      } catch (err) {
        recordSpan({
          span_id: spanId,
          parent_id: parent?.parentId,
          name,
          kind: "agent",
          input: args.length === 1 ? args[0] : args,
          error: err instanceof Error ? err.message : String(err),
          started_at: startedAt,
          ended_at: new Date().toISOString(),
        });
        throw err;
      }
    });
  };
}

// ---- Lightweight Built-In Scorer Helpers -----------------------------------

export function exactMatch(opts?: { name?: string; ignoreCase?: boolean }): ScorerFn {
  const name = opts?.name ?? "exact_match";
  return ({ output, expected }) => {
    if (expected === undefined || expected === null) {
      return { name, value: null, label: "N/A", rationale: "no expected value" };
    }
    let a = String(output).trim();
    let b = String(expected).trim();
    if (opts?.ignoreCase) {
      a = a.toLowerCase();
      b = b.toLowerCase();
    }
    const ok = a === b;
    return { name, value: ok ? 1 : 0, label: ok ? "Pass" : "Fail" };
  };
}

export function contains(substrings: string[], opts?: { name?: string; ignoreCase?: boolean }): ScorerFn {
  const name = opts?.name ?? "contains";
  const ignoreCase = opts?.ignoreCase ?? true;
  return ({ output }) => {
    const raw = String(output);
    const hay = ignoreCase ? raw.toLowerCase() : raw;
    const missing = substrings.filter((s) => !hay.includes(ignoreCase ? s.toLowerCase() : s));
    const ok = missing.length === 0;
    return { name, value: ok ? 1 : 0, label: ok ? "Pass" : "Fail", rationale: ok ? undefined : `missing: ${missing.join(", ")}` };
  };
}

export function regexMatch(pattern: string | RegExp, opts?: { name?: string }): ScorerFn {
  const name = opts?.name ?? "regex_match";
  const re = typeof pattern === "string" ? new RegExp(pattern) : pattern;
  return ({ output }) => {
    const ok = re.test(String(output));
    return { name, value: ok ? 1 : 0, label: ok ? "Pass" : "Fail" };
  };
}

export function toolCalled(tools: string[], opts?: { name?: string }): ScorerFn {
  const name = opts?.name ?? "tool_called";
  return ({ spans, output }) => {
    const called = new Set<string>();
    for (const s of spans) {
      if (s.kind === "tool") called.add(s.name);
    }
    if (output && typeof output === "object" && Array.isArray((output as { tool_calls?: unknown[] }).tool_calls)) {
      for (const tc of (output as { tool_calls: Array<{ name?: string }> }).tool_calls) {
        if (tc?.name) called.add(tc.name);
      }
    }
    const missing = tools.filter((t) => !called.has(t));
    const ok = missing.length === 0;
    return { name, value: ok ? 1 : 0, label: ok ? "Pass" : "Fail", rationale: ok ? undefined : `tools not called: ${missing.join(", ")}` };
  };
}

export function llmJudge(opts: {
  name: string;
  model: string;
  prompt: string;
  choices?: Array<{ label: string; value: number; description?: string }>;
  useCoT?: boolean;
  gatewayUrl?: string;
  apiKey?: string;
}): ScorerFn {
  const choices = opts.choices ?? [
    { label: "Pass", value: 1.0 },
    { label: "Fail", value: 0.0 },
  ];
  const byLower = new Map(choices.map((c) => [c.label.trim().toLowerCase(), c]));
  const useCoT = opts.useCoT ?? true;

  return async ({ input, output, expected }) => {
    const base = (opts.gatewayUrl ?? process.env.CAVEMAN_GATEWAY_URL ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
    const key = opts.apiKey ?? process.env.CAVEMAN_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    if (!base) {
      return { name: opts.name, value: null, source: "llm", error: "CAVEMAN_GATEWAY_URL not set for llmJudge" };
    }
    try {
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          "x-cave-optimize": "off",
        },
        body: JSON.stringify({
          model: opts.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: useCoT
                ? 'Return strict JSON {"rationale":"<concise reason>","choice":"<label>"} with no markdown.'
                : 'Return strict JSON {"choice":"<label>","rationale":"<reason>"}.',
            },
            {
              role: "user",
              content: `Criteria: ${opts.prompt}\nChoices: ${JSON.stringify(choices)}\nInput: ${JSON.stringify(input)}\nOutput: ${JSON.stringify(output)}\nExpected: ${JSON.stringify(expected)}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "caveman_eval_judge",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  rationale: { type: "string" },
                  choice: { type: "string", enum: choices.map((c) => c.label) },
                },
                required: ["rationale", "choice"],
                additionalProperties: false,
              },
            },
          },
        }),
      });
      if (!res.ok) {
        return { name: opts.name, value: null, source: "llm", error: `judge HTTP ${res.status}` };
      }
      const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const costHdr = res.headers.get("x-cave-cost-usd");
      const cost = costHdr ? Number(costHdr) : undefined;
      const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "{}") as { choice?: string; rationale?: string };
      const matched = byLower.get(String(parsed.choice ?? "").trim().toLowerCase());
      if (!matched) {
        return { name: opts.name, value: null, source: "llm", error: `unknown judge choice ${String(parsed.choice)}` };
      }
      return {
        name: opts.name,
        value: matched.value,
        label: matched.label,
        rationale: parsed.rationale,
        source: "llm",
        cost_usd: Number.isFinite(cost) ? cost : undefined,
      };
    } catch (err) {
      return { name: opts.name, value: null, source: "llm", error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ---- Cloud Client & Git Metadata -------------------------------------------

async function cloudRequest<T>(apiUrl: string, apiKey: string, projectId: string | undefined, method: string, path: string, body?: unknown): Promise<T> {
  const prefix = projectId ? `/api/v1/projects/${encodeURIComponent(projectId)}/evals` : "/api/v1/evals";
  const res = await fetch(`${apiUrl.replace(/\/+$/, "")}${prefix}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Caveman API ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function readGitTarget(): Record<string, string> {
  const target: Record<string, string> = {};
  for (const [key, args] of [
    ["git_sha", ["rev-parse", "--short", "HEAD"]],
    ["git_branch", ["rev-parse", "--abbrev-ref", "HEAD"]],
  ] as const) {
    try {
      const out = execFileSync("git", [...args], { stdio: ["ignore", "pipe", "ignore"] }).toString("utf8").trim();
      if (out) target[key] = out;
    } catch {
      // ignore outside git repo
    }
  }
  return target;
}

function summarizeResults(results: EvalRunResult["results"]): EvalRunResult["summary"] {
  const allByScorer = new Map<string, number[]>();
  const itemByScorer = new Map<string, Map<string, number[]>>();
  for (const r of results) {
    for (const sc of r.scores) {
      if (sc.value === null || sc.value === undefined) continue;
      if (!allByScorer.has(sc.name)) allByScorer.set(sc.name, []);
      allByScorer.get(sc.name)!.push(sc.value);
      if (!itemByScorer.has(sc.name)) itemByScorer.set(sc.name, new Map());
      const byItem = itemByScorer.get(sc.name)!;
      if (!byItem.has(r.item_key)) byItem.set(r.item_key, []);
      byItem.get(r.item_key)!.push(sc.value);
    }
  }
  const scores: Record<string, EvalSummaryScore> = {};
  for (const [name, vals] of allByScorer) {
    const byItem = itemByScorer.get(name)!;
    let passAtK = 0;
    let passPowK = 0;
    for (const tv of byItem.values()) {
      if (tv.some((v) => v >= 0.5)) passAtK++;
      if (tv.every((v) => v >= 0.5)) passPowK++;
    }
    scores[name] = {
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      pass_at_k: passAtK / byItem.size,
      pass_pow_k: passPowK / byItem.size,
      count: vals.length,
    };
  }
  return { total_trials: results.length, scores };
}

/** Local-first, Cloud-synced evaluation runner. */
export async function Eval<I = unknown, O = unknown, E = unknown>(
  name: string,
  opts: EvalOptions<I, O, E>,
): Promise<EvalRunResult> {
  const apiKey = opts.apiKey ?? process.env.CAVEMAN_API_KEY ?? "";
  const apiUrl = opts.apiUrl ?? process.env.CAVEMAN_API_URL ?? "https://api.caveman.so";
  const projectId = opts.projectId ?? process.env.CAVEMAN_PROJECT_ID;
  const trials = Math.max(1, opts.trials ?? 1);
  const concurrency = Math.max(1, opts.concurrency ?? 5);

  let datasetId: string | undefined;
  let datasetVersion: number | undefined;
  let cases: EvalCase<I, E>[];

  if (typeof opts.data === "object" && opts.data !== null && "__cavemanDataset" in opts.data) {
    if (!apiKey) throw new Error("CAVEMAN_API_KEY is required to load a Cloud dataset.");
    const list = await cloudRequest<{ datasets: Array<{ id: string; name: string }> }>(apiUrl, apiKey, projectId, "GET", "/datasets");
    const ds = list.datasets.find((d) => d.name === (opts.data as DatasetRef).name);
    if (!ds) throw new Error(`Dataset "${(opts.data as DatasetRef).name}" not found.`);
    datasetId = ds.id;
    const q = (opts.data as DatasetRef).version ? `?version=${(opts.data as DatasetRef).version}` : "";
    const resp = await cloudRequest<{ version: number; items: EvalCase<I, E>[] }>(apiUrl, apiKey, projectId, "GET", `/datasets/${ds.id}/items${q}`);
    datasetVersion = resp.version;
    cases = resp.items;
  } else {
    cases = [...(opts.data as Iterable<EvalCase<I, E>>)];
  }

  let experimentId: string | null = null;
  if (apiKey) {
    const created = await cloudRequest<{ id: string }>(apiUrl, apiKey, projectId, "POST", "/experiments", {
      name,
      mode: "sdk",
      trials,
      concurrency,
      dataset_id: datasetId,
      dataset_version: datasetVersion,
      scorer_ids: opts.scorerIds ?? [],
      target: { ...readGitTarget(), ...(opts.ci?.prNumber ? { pr_number: opts.ci.prNumber } : {}), ...(opts.ci?.repo ? { repo: opts.ci.repo } : {}) },
      metadata: opts.metadata ?? {},
    });
    experimentId = created.id;
  }

  const queue: Array<{ itemKey: string; trial: number; row: EvalCase<I, E> }> = [];
  cases.forEach((row, idx) => {
    const itemKey = String(row.item_key ?? row.id ?? `case-${idx + 1}`);
    for (let t = 1; t <= trials; t++) {
      queue.push({ itemKey, trial: t, row });
    }
  });

  const results: EvalRunResult["results"] = new Array(queue.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < queue.length) {
      const idx = cursor++;
      const work = queue[idx]!;
      const spans: EvalSpan[] = [];
      const started = performance.now();
      let output: unknown = null;
      let errMsg: string | undefined;
      try {
        output = await traceALS.run({ spans }, () => opts.task(work.row.input, { spans }));
      } catch (err) {
        errMsg = err instanceof Error ? err.message : String(err);
      }
      const durationMs = Math.round(performance.now() - started);

      const scores: ScoreResult[] = [];
      if (!errMsg && opts.scorers) {
        for (const scorer of opts.scorers) {
          try {
            const raw = await scorer({
              input: work.row.input,
              output: output as O,
              expected: work.row.expected,
              spans,
              metadata: work.row.metadata,
            });
            const arr = Array.isArray(raw) ? raw : [raw];
            scores.push(...arr.map((s) => ({ ...s, source: s.source ?? "code" })));
          } catch (err) {
            scores.push({ name: scorer.name || "scorer", value: null, source: "code", error: err instanceof Error ? err.message : String(err) });
          }
        }
      }

      let inputTokens = 0;
      let outputTokens = 0;
      for (const s of spans) {
        inputTokens += Number(s.metrics?.input_tokens ?? 0);
        outputTokens += Number(s.metrics?.output_tokens ?? 0);
      }

      results[idx] = {
        item_key: work.itemKey,
        trial: work.trial,
        status: errMsg ? "error" : "completed",
        input: work.row.input,
        output,
        expected: work.row.expected,
        error: errMsg,
        spans,
        metrics: { duration_ms: durationMs, input_tokens: inputTokens, output_tokens: outputTokens },
        scores,
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => worker()));

  const summary = summarizeResults(results);
  let consoleUrl: string | null = null;
  let prComment: string | null = null;

  if (apiKey && experimentId) {
    for (let i = 0; i < results.length; i += 50) {
      await cloudRequest(apiUrl, apiKey, projectId, "POST", `/experiments/${experimentId}/results`, {
        results: results.slice(i, i + 50),
      });
    }
    const completed = await cloudRequest<{ pr_comment?: string }>(apiUrl, apiKey, projectId, "POST", `/experiments/${experimentId}/complete`, {
      ...(opts.baseline ? { baseline: opts.baseline } : {}),
      ...(opts.ci?.repo && opts.ci?.prNumber ? { github: { repo: opts.ci.repo, pr_number: opts.ci.prNumber } } : {}),
    });
    prComment = completed.pr_comment ?? null;
    consoleUrl = `${apiUrl.replace(/\/+$/, "").replace("api.", "app.")}/experiments/runs/${experimentId}`;
  }

  // Compare against local last-run cache for offline terminal diffs.
  const cachePath = opts.localCachePath ?? ".caveman/last-run.json";
  let prevScores: Record<string, EvalSummaryScore> | null = null;
  try {
    const prev = JSON.parse(readFileSync(cachePath, "utf8")) as { name?: string; summary?: { scores?: Record<string, EvalSummaryScore> } };
    if (prev.name === name && prev.summary?.scores) prevScores = prev.summary.scores;
  } catch {
    // first run
  }
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ name, summary, results }, null, 2));
  } catch {
    // read-only filesystem
  }

  let passedCI = true;
  if (opts.ci?.failUnder !== undefined) {
    for (const s of Object.values(summary.scores)) {
      if (s.mean < opts.ci.failUnder) passedCI = false;
    }
  }
  if (opts.ci?.maxRegression !== undefined && prevScores) {
    for (const [k, s] of Object.entries(summary.scores)) {
      const prev = prevScores[k];
      if (prev && prev.mean - s.mean > opts.ci.maxRegression) passedCI = false;
    }
  }

  return { experimentName: name, experimentId, consoleUrl, prComment, summary, results, passedCI };
}

/** Launch a hosted isolated-computer agent experiment on Caveman Cloud. */
export async function ComputerEval(
  name: string,
  opts: {
    datasetName: string;
    target: { agentId?: string; agentVersion?: number; engine?: string; model?: string; budgetUsd?: number; systemPromptOverride?: string };
    scorerIds?: string[];
    trials?: number;
    concurrency?: number;
    itemKeys?: string[];
    tags?: string[];
    baseline?: string;
    wait?: boolean;
    pollIntervalMs?: number;
    apiUrl?: string;
    apiKey?: string;
    projectId?: string;
  },
): Promise<Record<string, unknown>> {
  const apiKey = opts.apiKey ?? process.env.CAVEMAN_API_KEY ?? "";
  if (!apiKey) throw new Error("CAVEMAN_API_KEY is required for ComputerEval().");
  const apiUrl = opts.apiUrl ?? process.env.CAVEMAN_API_URL ?? "https://api.caveman.so";
  const projectId = opts.projectId ?? process.env.CAVEMAN_PROJECT_ID;

  const list = await cloudRequest<{ datasets: Array<{ id: string; name: string }> }>(apiUrl, apiKey, projectId, "GET", "/datasets");
  const ds = list.datasets.find((d) => d.name === opts.datasetName);
  if (!ds) throw new Error(`Dataset "${opts.datasetName}" not found.`);

  let exp = await cloudRequest<Record<string, unknown>>(apiUrl, apiKey, projectId, "POST", "/experiments", {
    name,
    mode: "computer",
    dataset_id: ds.id,
    trials: opts.trials ?? 1,
    concurrency: opts.concurrency ?? 5,
    scorer_ids: opts.scorerIds ?? [],
    ...(opts.itemKeys ? { item_keys: opts.itemKeys } : {}),
    ...(opts.tags ? { tags: opts.tags } : {}),
    ...(opts.baseline ? { baseline_experiment_id: opts.baseline } : {}),
    target: {
      ...readGitTarget(),
      agent_id: opts.target.agentId,
      agent_version: opts.target.agentVersion,
      engine: opts.target.engine,
      model: opts.target.model,
      budget_usd: opts.target.budgetUsd,
      system_prompt_override: opts.target.systemPromptOverride,
    },
  });

  if (opts.wait === false) return exp;
  const pollMs = opts.pollIntervalMs ?? 3000;
  while (exp.status === "queued" || exp.status === "running") {
    await new Promise((r) => setTimeout(r, pollMs));
    exp = await cloudRequest<Record<string, unknown>>(apiUrl, apiKey, projectId, "GET", `/experiments/${String(exp.id)}`);
  }
  return exp;
}

/** Re-score an existing experiment with new LLM judges without re-running agents. */
export async function rescoreExperiment(
  experimentId: string,
  opts: {
    scorerIds: string[];
    apiUrl?: string;
    apiKey?: string;
    projectId?: string;
  },
): Promise<Record<string, unknown>> {
  const apiKey = opts.apiKey ?? process.env.CAVEMAN_API_KEY ?? "";
  if (!apiKey) throw new Error("CAVEMAN_API_KEY is required for rescoreExperiment().");
  const apiUrl = opts.apiUrl ?? process.env.CAVEMAN_API_URL ?? "https://api.caveman.so";
  const projectId = opts.projectId ?? process.env.CAVEMAN_PROJECT_ID;
  return cloudRequest<Record<string, unknown>>(apiUrl, apiKey, projectId, "POST", `/experiments/${encodeURIComponent(experimentId)}/rescore`, {
    scorer_ids: opts.scorerIds,
  });
}
