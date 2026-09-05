import type { ToolCallPolicy } from "@caveman-ai/agent";

/**
 * What a caller is allowed to do. Configured once (env, a tenant record, a
 * project grant), never by the model. `read` may inspect; `write_resource` may
 * also activate an evaluator. Nothing here can merge or deploy.
 */
export interface Grant {
  readonly tenant: string;
  readonly scopes: ReadonlySet<"read" | "write_resource">;
}

export function grantFromEnv(value = process.env.INVESTIGATOR_GRANT ?? "read"): Grant {
  const scopes = new Set<"read" | "write_resource">();
  for (const scope of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (scope !== "read" && scope !== "write_resource") throw new Error(`unknown grant scope: ${scope}`);
    scopes.add(scope);
  }
  return { tenant: "local", scopes };
}

/** The only shell commands this agent may start. Refused before execution, not after. */
export const SHELL_ALLOWLIST = new Set(["caveman", "cat", "head", "jq", "wc"]);

/**
 * The host's authorization decision for every tool call in the run,
 * subagents included. It decides; it never rewrites arguments. A denial
 * reaches the model as `cave_tool_denied:<code>` and lands on the receipt.
 */
export function policyFor(grant: Grant): ToolCallPolicy {
  return ({ name, effect, args }) => {
    if (name === "bash") {
      const command = String((args as { command?: unknown }).command ?? "").trim();
      const first = command.split(/\s+/)[0] ?? "";
      if (!SHELL_ALLOWLIST.has(first)) return { deny: "shell_scope" };
      // The shell is `sh -c`: chaining, substitution, redirection, and a second
      // line would all start something the first token did not name.
      if (/[;&|`$()<>\n\r\\]/.test(command)) return { deny: "shell_compound" };
      return undefined;
    }
    if (effect === "write" || effect === "external") {
      return grant.scopes.has("write_resource") ? undefined : { deny: "grant_scope" };
    }
    return undefined;
  };
}
