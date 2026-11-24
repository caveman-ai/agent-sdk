import { pathToFileURL } from "node:url";
import { tool } from "../../packages/agent/dist/index.js";
import {
  HarnessSession,
  LocalEnv,
  appLoadoutFor,
  appLoadouts,
  resolveHarnessModel,
  toHarnessTool,
  type HarnessModel,
  type HarnessStreamFn,
} from "../../packages/agent/dist/harness.js";

/**
 * Direct Harness v4 session via `@caveman-ai/agent/harness`.
 *
 * - `appLoadoutFor(model)` picks the model-native surface automatically:
 *   `app-gpt` (Codex-style `exec` QuickJS cells) for GPT on Responses API, and
 *   `app-claude` (compact `read`/`bash`/`edit`/`write` + 270 s cache keepalive)
 *   for Claude and other models.
 * - `appLoadouts().general` strips coding tools so only your custom tools run.
 */
const recordFinding = tool(
  "record_finding",
  "Record a short finding discovered during workspace inspection.",
  { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  async ({ note }: { note: string }) => ({ recorded: true, note }),
);

export interface HarnessRecipeOptions {
  cwd?: string;
  model?: HarnessModel;
  stream?: HarnessStreamFn;
  mode?: "coding" | "general";
}

export async function runHarnessSession(
  prompt = "Inspect this directory and record one finding.",
  options: HarnessRecipeOptions = {},
) {
  const spec = process.env.CAVE_MODEL
    ?? (process.env.OPENAI_API_KEY ? "openai/gpt-5.4" : "anthropic/claude-sonnet-4-6");
  const resolved = options.model && options.stream
    ? { model: options.model, stream: options.stream }
    : resolveHarnessModel(spec);

  const loadout = options.mode === "general"
    ? appLoadouts().general
    : appLoadoutFor(resolved.model);
  const env = new LocalEnv({ cwd: options.cwd ?? process.cwd() });

  const session = new HarnessSession({
    model: resolved.model,
    stream: resolved.stream,
    loadout,
    env,
    instructions: "Be concise and cite only facts you observed.",
    tools: [toHarnessTool(recordFinding)],
    hooks: {
      async beforeCall(call) {
        const args = call.args as { command?: unknown; cmd?: unknown } | undefined;
        const shellCmd =
          call.name === "bash" && typeof args?.command === "string"
            ? args.command
            : call.name === "exec_command" && typeof args?.cmd === "string"
              ? args.cmd
              : undefined;
        if (shellCmd !== undefined && /\brm\s+-rf\b/.test(shellCmd)) {
          return "Refused destructive command.";
        }
        return undefined;
      },
    },
  });

  try {
    const outcome = await session.runTurn(prompt);
    return { loadout: loadout.name, surface: loadout.surface, outcome };
  } finally {
    await session.close();
    await env.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadout, surface, outcome } = await runHarnessSession();
  console.log(`[loadout=${loadout} surface=${surface} status=${outcome.status}]\n`);
  console.log(outcome.finalText);
  console.log("\nusage:", outcome.usage);
}
