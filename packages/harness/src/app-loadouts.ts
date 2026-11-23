/**
 * The loadouts the Caveman Code app runs (the library session, src/session.ts): v4's measured surfaces with what only
 * a benchmark needs taken out.
 *
 * - `app-claude` is v4-opus (loadouts/v4): the compact surface (read, bash, wait, edit, write) plus the program tool
 *   when the session has MCP tools, MCP reached from programs only, the cache keep-alive at 270 s. Also the shape for
 *   every model with no native surface of its own (Gemini, Grok, open models): ARCHITECTURE.md 3.2, "unmeasured models".
 * - `app-gpt` is v4-sol: Codex's exec surface word for word, MCP tools as Codex's deferred `mcp__` nested tools.
 *   Over HTTP, not v4-sol's WebSocket: the app's model calls go through its egress scrub, an HTTP proxy.
 * - `app-general` is for agents that do not code (the app's Chief, `agent exec`'s general shape), on any model: no
 *   built-in tool and no prompt section, so the host's tools (HarnessSessionOptions.tools; its MCP tools through
 *   `mcpDirectTools`, or `mcp` handles, which this loadout declares one tool each) are the whole surface and its
 *   instructions the whole system prompt. Its tool calls run in the order written (they act on the world); the
 *   rest is app-claude's: the policy, the wire (the Anthropic keep-alive at 270 s; GPT effort sent plain, as
 *   app-gpt) and the env block (cwd, os) in the first message.
 * - `app-code` is app-general plus the program tool with no sandbox (below).
 *
 * Out, in both: the turn-1 environment probe (discovery: it lists a benchmark task's checks, and pings the internet),
 * the separate-environment notes (travel_jit: an app's work is checked where it was made, not in a fresh copy) and the
 * unmet-target push (unmet_target: it reads a wall budget the app does not set). `app.identity` replaces
 * `core.identity`, whose "nobody will answer questions" is false in an app: a person is there.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeLoadout, type Loadout } from "./loadout.ts";

const POLICY = {
  loop: { nudge_at: 3, stop_at: 6 },
  empty_turns_stop: 3,
  length_continuations: 3,
} as const;

export const APP_CLAUDE_LOADOUT = {
  name: "app-claude",
  surface: "compact",
  prompt: { sections: ["app.identity", "compact.tools", "core.verify", "core.finish"] },
  tools: {
    read: { exposure: "eager", limits: { line_numbers: false } },
    bash: { exposure: "eager", limits: { default_yield_s: 120, max_yield_s: 600, hard_timeout_s: 3600 } },
    wait: { exposure: "eager", limits: { default_s: 120, max_s: 600 } },
    edit: { exposure: "eager", limits: { fuzzy: true } },
    write: { exposure: "eager" },
    program: { exposure: "with_mcp" },
  },
  limits: { output_cap_bytes: 51200, output_cap_lines: 2000, spill: true },
  policy: { ...POLICY, tool_execution: "parallel" },
  wire: { cache_retention: "short", max_retries: 3, anthropic: { keepalive_s: 270 } },
  context: { env: "user" },
  mcp: { exposure: "program" },
} as const;

export const APP_GPT_LOADOUT = {
  name: "app-gpt",
  surface: "exec",
  prompt: { sections: ["app.identity", "exec.tools", "core.verify", "core.finish"] },
  tools: {
    apply_patch: { exposure: "eager" },
    exec: { exposure: "eager", limits: { default_yield_ms: 30000, max_output_tokens: 10000, cell_timeout_s: 3600, mcp_types: true, aliases: true, min_yield_ms: 30000 } },
    exec_command: { exposure: "eager", limits: { default_yield_ms: 10000, max_yield_ms: 30000, hard_timeout_s: 3600, min_yield_ms: 30000 } },
    view_image: { exposure: "eager" },
    wait: { exposure: "eager", limits: { default_yield_ms: 10000, default_max_tokens: 10000, until: true, min_yield_ms: 30000 } },
    write_stdin: { exposure: "eager", limits: { min_poll_ms: 30000, max_poll_ms: 300000 } },
  },
  limits: { output_cap_bytes: 51200, output_cap_lines: 2000, spill: true },
  policy: { ...POLICY, tool_execution: "sequential" },
  wire: { cache_retention: "short", max_retries: 3, mid_convo_effort: false, reasoning_context: "all_turns" },
  context: { env: "user" },
  mcp: { exposure: "program" },
} as const;

export const APP_GENERAL_LOADOUT = {
  name: "app-general",
  // Nothing of the surface's is declared (no tools): "compact" only names the loop's tool handling, whatever the model.
  surface: "compact",
  prompt: { sections: [] },
  tools: {},
  // Sequential: a general agent's tools act on the world (the Chief starts chats, queues work), so they run in the
  // order the model wrote them, as the classic engine ran the Chief's and as app-gpt runs every call.
  policy: { ...POLICY, tool_execution: "sequential" },
  // mid_convo_effort false: on a GPT Responses model the effort is plain reasoning.effort per request, as app-gpt sends it.
  wire: { cache_retention: "short", max_retries: 3, mid_convo_effort: false, anthropic: { keepalive_s: 270 } },
  context: { env: "user" },
} as const;

/**
 * `app-code` is app-general with the program tool: an agent with no computer that may write a program over its tools
 * (Cloud's code tier, `computer: code`). The program has no sandbox (no bash, read, write or edit: the env is the host),
 * and each tool stays callable directly too ("both"), since a single step is cheaper as one call than as a program.
 */
export const APP_CODE_LOADOUT = {
  ...APP_GENERAL_LOADOUT,
  name: "app-code",
  tools: { program: { exposure: "eager", limits: { sandbox: false } } },
  mcp: { exposure: "both" },
} as const;

let normalized: { claude: Loadout; gpt: Loadout; general: Loadout; code: Loadout } | undefined;

/** The app loadouts, validated once. */
export function appLoadouts(): { claude: Loadout; gpt: Loadout; general: Loadout; code: Loadout } {
  normalized ??= {
    claude: normalizeLoadout(APP_CLAUDE_LOADOUT, "app-claude"), gpt: normalizeLoadout(APP_GPT_LOADOUT, "app-gpt"),
    general: normalizeLoadout(APP_GENERAL_LOADOUT, "app-general"), code: normalizeLoadout(APP_CODE_LOADOUT, "app-code"),
  };
  return normalized;
}

/**
 * Whether a model gets Codex's exec surface: a GPT model on a Responses API (OpenAI's, or compact through a Codex
 * sign-in), the surface it was trained on. The same GPT through a Chat Completions endpoint (external tools, Copilot) has
 * no freeform tools, so it gets the compact surface.
 */
export function usesExecSurface(model: Pick<Model<Api>, "api" | "id">): boolean {
  return (model.api === "openai-responses" || model.api === "openai-codex-responses" || model.api === "azure-openai-responses") && /^gpt-/iu.test(model.id.split("/").at(-1) ?? "");
}

/** The coding app loadout for a model: `app-gpt` where the exec surface is native, `app-claude` everywhere else (`app-general` is chosen by the host, not the model). */
export function appLoadoutFor(model: Pick<Model<Api>, "api" | "id">): Loadout {
  const { claude, gpt } = appLoadouts();
  return usesExecSurface(model) ? gpt : claude;
}
