/**
 * Host-owned tool authorization, decided outside model output.
 *
 * This is the `canUseTool` shape from the Claude Agent SDK on the kernel's own
 * admission path: the runtime consumes Pi's `beforeToolCall` hook to enforce
 * deadline, budget, caps, breakers, sandbox posture, and argument shape, and a
 * `ToolCallPolicy` is the caller's decision that runs after those checks for
 * every declared tool call (root, subagent, and nested composite dispatch).
 * Framework tools (`cave_*`) are not gated. A policy decides; it never rewrites
 * arguments, because the durable journal binds each call to its argument digest.
 */
import type { ToolEffect } from "./primitives.js";

export interface ToolCallPolicyInput {
  readonly runId: string;
  readonly agentId: string;
  /** `[]` for the root agent; the subagent tool names leading here otherwise. */
  readonly agentPath: readonly string[];
  readonly toolCallId: string;
  /** Present only for a nested call dispatched by a composite/programmatic tool. */
  readonly parentToolCallId?: string;
  readonly name: string;
  readonly effect: ToolEffect;
  /** Validated arguments, exactly what the tool would receive. Read-only. */
  readonly args: unknown;
}

/**
 * `undefined` or `{ allow: true }` admits the call. `{ deny: code }` blocks it:
 * the model reads `cave_tool_denied:<code>` as the tool result and the receipt
 * counts the call under `denied`. `code` is a short identifier, never tenant
 * text, so receipts and journals stay content-blind.
 */
export type ToolCallDecision =
  | undefined
  | void
  | { readonly allow: true }
  | { readonly deny: string };

export type ToolCallPolicy = (
  call: ToolCallPolicyInput,
) => ToolCallDecision | Promise<ToolCallDecision>;

const DENY_CODE = /^[a-z][a-z0-9_]{0,63}$/u;
/** A policy that cannot answer is an unknown authorization state: fail closed. */
export const TOOL_POLICY_TIMEOUT_MS = 10_000;

export interface ToolCallDenial {
  readonly block: true;
  readonly reason: string;
}

/**
 * Evaluate a policy for one call. Returns the block result for a denial,
 * `undefined` to admit. Throws `cave_tool_policy_failed` when the policy
 * throws or hangs past {@link TOOL_POLICY_TIMEOUT_MS},
 * `cave_tool_policy_decision_invalid` for a malformed decision, and
 * `cave_tool_policy_reason_invalid` for a deny code outside `[a-z][a-z0-9_]*`.
 * Every throw is run-fatal to the caller: unknown authorization never executes.
 */
export async function decideToolCall(
  policy: ToolCallPolicy,
  input: ToolCallPolicyInput,
): Promise<ToolCallDenial | undefined> {
  let decision: ToolCallDecision;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    decision = await Promise.race([
      Promise.resolve().then(() => policy(Object.freeze({ ...input }))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cave_tool_policy_timeout")), TOOL_POLICY_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch (error) {
    throw new Error("cave_tool_policy_failed", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (decision === undefined || decision === null) return undefined;
  if (typeof decision !== "object") throw new Error("cave_tool_policy_decision_invalid");
  if ("allow" in decision) {
    if (decision.allow !== true || "deny" in decision) {
      throw new Error("cave_tool_policy_decision_invalid");
    }
    return undefined;
  }
  if (typeof (decision as { deny?: unknown }).deny !== "string") {
    throw new Error("cave_tool_policy_decision_invalid");
  }
  if (!DENY_CODE.test(decision.deny)) throw new Error("cave_tool_policy_reason_invalid");
  return { block: true, reason: `cave_tool_denied:${decision.deny}` };
}
