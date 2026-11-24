/**
 * Caveman Gate: fail-closed human approval enforcement wired into Harness v4's
 * direct (`beforeToolCall`) and nested (`program` / `exec` / MCP) tool calls.
 *
 * Security invariants:
 * - Fail-closed: any missing provider, thrown error, timeout, abort, or
 *   non-"approved" decision refuses the call before execution.
 * - Deterministic idempotency: each (session, tool, canonical args) derives a
 *   stable SHA-256 idempotency key so retries never duplicate approval cards.
 * - No credential leakage on Cloud transport: refuses non-HTTPS remote URLs
 *   (loopback allowed for local dev/tests) and uses `redirect: "error"`.
 */
import { canonicalJson, sha256 } from "./loadout.ts";
import type { CallInfo } from "./session.ts";

export type GateRisk = "low" | "medium" | "high" | "critical";
export type GateStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type GateTerminalStatus = Exclude<GateStatus, "pending">;

export interface GateRequest {
  readonly gateId: string;
  readonly tool: string;
  readonly action: string;
  readonly summary: string;
  readonly risk: GateRisk;
  readonly input: unknown;
  readonly callId: string;
  readonly parentId?: string;
  readonly mcp?: { readonly server: string; readonly tool: string };
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface GateDecision {
  readonly gateId: string;
  readonly status: GateTerminalStatus;
  readonly reason?: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

export interface GateProvider {
  requestApproval(request: GateRequest, signal?: AbortSignal): Promise<GateDecision>;
}

export interface GateRule {
  /** Exact tool name, MCP qualified name (`server__tool`), or regex. */
  readonly tool: string | RegExp;
  readonly action?: string;
  readonly risk?: GateRisk;
  readonly summary?: string | ((call: CallInfo) => string);
  /** Optional predicate; when false, this rule does not trigger a gate. */
  readonly when?: (call: CallInfo) => boolean;
}

export interface GateConfig {
  /** Provider that obtains human/policy approval. Required when any rule triggers (fail-closed if omitted). */
  readonly provider?: GateProvider;
  /** Rules matching tools that require approval before execution. */
  readonly rules?: ReadonlyArray<GateRule>;
  /** When true, every direct and nested tool call requires approval. */
  readonly requireAll?: boolean;
  /** Default risk level when a rule omits `risk`. Default: `"high"`. */
  readonly defaultRisk?: GateRisk;
  /** Maximum time to wait for a gate decision before failing closed. Default: 300_000 ms (5 minutes). */
  readonly timeoutMs?: number;
  /** Optional session identifier folded into deterministic idempotency keys. */
  readonly sessionId?: string;
  readonly onRequest?: (request: GateRequest) => void;
  readonly onDecision?: (request: GateRequest, decision: GateDecision) => void;
}

export interface CloudGateProviderOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly pollIntervalMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

const VALID_TERMINAL_STATUSES = new Set<string>(["approved", "denied", "expired", "cancelled"]);
const MAX_RETRY_AFTER_S = 60;
const DEFAULT_GATE_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;

function matchesRule(rule: GateRule, call: CallInfo): boolean {
  const candidates = [call.name];
  if (call.mcp) candidates.push(`${call.mcp.server}__${call.mcp.tool}`);
  const nameMatches = typeof rule.tool === "string"
    ? candidates.includes(rule.tool)
    : candidates.some((c) => {
      rule.tool instanceof RegExp && (rule.tool.lastIndex = 0);
      return (rule.tool as RegExp).test(c);
    });
  if (!nameMatches) return false;
  if (rule.when !== undefined) {
    return Boolean(rule.when(call));
  }
  return true;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

function assertSafeGateBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid Caveman Gate baseUrl: ${raw}`);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new Error(`Refusing insecure Caveman Gate baseUrl "${raw}": HTTPS is required for non-loopback hosts.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Caveman Gate baseUrl must not include credentials, query string, or fragment.`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const ctrl = new AbortController();
  let didTimeout = false;
  const onExternal = () => ctrl.abort(external?.reason ?? new Error("Aborted"));
  if (external?.aborted) ctrl.abort(external.reason ?? new Error("Aborted"));
  else external?.addEventListener("abort", onExternal, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    ctrl.abort(new Error(`Gate approval timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: ctrl.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternal);
    },
  };
}

/**
 * Creates a `SessionHooks["beforeCall"]` function that enforces fail-closed
 * Caveman Gate approvals on every matching direct or nested tool call.
 */
export function createGateHook(
  config: GateConfig,
  emitEvent?: (event:
    | { type: "gate_requested"; request: GateRequest }
    | { type: "gate_decided"; request: GateRequest; decision: GateDecision }) => void,
): (call: CallInfo, signal: AbortSignal | undefined) => Promise<string | undefined> {
  const rules = config.rules ?? [];
  const defaultRisk: GateRisk = config.defaultRisk ?? "high";
  const timeoutMs = config.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

  return async (call: CallInfo, signal: AbortSignal | undefined): Promise<string | undefined> => {
    let matched: GateRule | undefined;
    try {
      matched = rules.find((rule) => matchesRule(rule, call));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Blocked by Caveman Gate (rule evaluation error, fail-closed): ${msg}`;
    }
    if (matched === undefined && !config.requireAll) {
      return undefined;
    }

    const action = matched?.action ?? `tool.${call.name}`;
    const risk: GateRisk = matched?.risk ?? defaultRisk;
    let summary: string;
    try {
      summary = typeof matched?.summary === "function"
        ? matched.summary(call)
        : matched?.summary ?? `Approve tool "${call.name}"`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Blocked by Caveman Gate (summary error, fail-closed): ${msg}`;
    }

    const digest = sha256(canonicalJson({
      sessionId: config.sessionId ?? "",
      tool: call.name,
      action,
      args: call.args ?? null,
    }));
    const idempotencyKey = `gate_${digest.slice(0, 32)}`;
    const gateId = `gate_${digest.slice(0, 16)}`;

    const request: GateRequest = {
      gateId,
      tool: call.name,
      action,
      summary,
      risk,
      input: call.args ?? {},
      callId: call.id,
      ...(call.parentId === undefined ? {} : { parentId: call.parentId }),
      ...(call.mcp === undefined ? {} : { mcp: call.mcp }),
      idempotencyKey,
    };

    emitEvent?.({ type: "gate_requested", request });
    config.onRequest?.(request);

    if (config.provider === undefined) {
      const decision: GateDecision = {
        gateId,
        status: "denied",
        reason: `gate_provider_missing: tool "${call.name}" requires Caveman Gate approval, but no gate provider is configured.`,
      };
      emitEvent?.({ type: "gate_decided", request, decision });
      config.onDecision?.(request, decision);
      return decision.reason;
    }

    const guard = combineSignals(timeoutMs, signal);
    try {
      const raw = await config.provider.requestApproval(request, guard.signal);
      if (!raw || typeof raw !== "object" || !VALID_TERMINAL_STATUSES.has(raw.status)) {
        const decision: GateDecision = {
          gateId: raw?.gateId ?? gateId,
          status: "denied",
          reason: `Blocked by Caveman Gate (invalid provider status "${String((raw as { status?: unknown })?.status)}", fail-closed).`,
        };
        emitEvent?.({ type: "gate_decided", request, decision });
        config.onDecision?.(request, decision);
        return decision.reason;
      }
      const decision: GateDecision = {
        gateId: raw.gateId || gateId,
        status: raw.status,
        ...(raw.reason === undefined ? {} : { reason: raw.reason }),
        ...(raw.decidedBy === undefined ? {} : { decidedBy: raw.decidedBy }),
        ...(raw.decidedAt === undefined ? {} : { decidedAt: raw.decidedAt }),
      };
      emitEvent?.({ type: "gate_decided", request, decision });
      config.onDecision?.(request, decision);
      if (decision.status === "approved") {
        return undefined;
      }
      return decision.reason
        ? `Blocked by Caveman Gate (${decision.status}): ${decision.reason}`
        : `Blocked by Caveman Gate (${decision.status}): human approval required for "${call.name}".`;
    } catch (err) {
      const status: GateTerminalStatus = guard.timedOut() ? "expired" : signal?.aborted ? "cancelled" : "denied";
      const msg = err instanceof Error ? err.message : String(err);
      const decision: GateDecision = {
        gateId,
        status,
        reason: `Blocked by Caveman Gate (${status}, fail-closed): ${msg}`,
      };
      emitEvent?.({ type: "gate_decided", request, decision });
      config.onDecision?.(request, decision);
      return decision.reason;
    } finally {
      guard.cleanup();
    }
  };
}

/**
 * Built-in HTTP provider speaking Caveman Cloud's `/api/v1/code/gates` wire
 * contract with fail-closed status handling, HTTPS enforcement, `redirect: "error"`,
 * and `Idempotency-Key` deduplication.
 */
export function createCloudGateProvider(options: CloudGateProviderOptions): GateProvider {
  const baseUrl = assertSafeGateBaseUrl(options.baseUrl);
  if (!options.apiKey || options.apiKey.trim() === "") {
    throw new Error("Caveman Cloud Gate provider requires a non-empty apiKey.");
  }
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

  const authHeaders = (): Record<string, string> => ({
    Authorization: `Bearer ${options.apiKey}`,
    Accept: "application/json",
    ...(options.extraHeaders ?? {}),
  });

  return {
    async requestApproval(request: GateRequest, signal?: AbortSignal): Promise<GateDecision> {
      const createRes = await fetchFn(`${baseUrl}/api/v1/code/gates`, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          ...authHeaders(),
          "Content-Type": "application/json",
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          action: request.action,
          summary: request.summary,
          risk: request.risk,
          payload: { tool: request.tool, call_id: request.callId, input: request.input },
          idempotency_key: request.idempotencyKey,
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        }),
      });
      if (!createRes.ok) {
        const body = await createRes.text().catch(() => "");
        throw new Error(`POST /api/v1/code/gates failed (${createRes.status}): ${body.slice(0, 240)}`);
      }
      const created = (await createRes.json()) as {
        id?: string;
        gate_id?: string;
        status?: string;
        reason?: string;
        decision_reason?: string;
        decided_by?: string;
        decided_at?: string;
      };
      const serverGateId = created.id ?? created.gate_id ?? request.gateId;
      if (created.status && VALID_TERMINAL_STATUSES.has(created.status)) {
        return {
          gateId: serverGateId,
          status: created.status as GateTerminalStatus,
          reason: created.decision_reason ?? created.reason,
          decidedBy: created.decided_by,
          decidedAt: created.decided_at,
        };
      }

      while (true) {
        if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
        await sleepAbortable(pollIntervalMs, signal);
        const pollRes = await fetchFn(`${baseUrl}/api/v1/code/gates/${encodeURIComponent(serverGateId)}`, {
          method: "GET",
          redirect: "error",
          signal,
          headers: authHeaders(),
        });
        if (pollRes.status === 429 || pollRes.status >= 500) {
          const retryAfterRaw = pollRes.headers.get("retry-after");
          const retryAfterS = retryAfterRaw ? Number(retryAfterRaw) : NaN;
          if (Number.isFinite(retryAfterS) && retryAfterS > 0) {
            await sleepAbortable(Math.min(retryAfterS, MAX_RETRY_AFTER_S) * 1000, signal);
          }
          continue;
        }
        if (!pollRes.ok) {
          const body = await pollRes.text().catch(() => "");
          throw new Error(`GET /api/v1/code/gates/${serverGateId} failed (${pollRes.status}): ${body.slice(0, 240)}`);
        }
        const current = (await pollRes.json()) as {
          id?: string;
          status?: string;
          reason?: string;
          decision_reason?: string;
          decided_by?: string;
          decided_at?: string;
        };
        if (current.status && VALID_TERMINAL_STATUSES.has(current.status)) {
          return {
            gateId: current.id ?? serverGateId,
            status: current.status as GateTerminalStatus,
            reason: current.decision_reason ?? current.reason,
            decidedBy: current.decided_by,
            decidedAt: current.decided_at,
          };
        }
      }
    },
  };
}

/**
 * In-memory / local interactive GateProvider with idempotency deduplication.
 * Useful for interactive apps, CLI prompts, and deterministic tests.
 */
export function createMemoryGateProvider(
  decide: (request: GateRequest, signal?: AbortSignal) => Promise<Omit<GateDecision, "gateId"> | GateTerminalStatus> | Omit<GateDecision, "gateId"> | GateTerminalStatus,
): GateProvider {
  const seen = new Map<string, Promise<GateDecision>>();
  return {
    requestApproval(request: GateRequest, signal?: AbortSignal): Promise<GateDecision> {
      const existing = seen.get(request.idempotencyKey);
      if (existing !== undefined) return existing;
      const pending = (async (): Promise<GateDecision> => {
        const res = await decide(request, signal);
        if (typeof res === "string") {
          return { gateId: request.gateId, status: res };
        }
        return { gateId: request.gateId, ...res };
      })();
      seen.set(request.idempotencyKey, pending);
      pending.catch(() => {
        // Evict failed decisions so retries can re-evaluate instead of caching transient faults.
        seen.delete(request.idempotencyKey);
      });
      return pending;
    },
  };
}
