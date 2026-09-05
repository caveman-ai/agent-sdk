import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agent,
  auto,
  localExecutionBackend,
  output,
  schema,
  shellTools,
  tool,
  type ExecutionBackend,
} from "@caveman-ai/agent";
import { applyAgentEnvironment, loadAgentEnvironment } from "@caveman-ai/agent/plugins";
import { combinedProcessOutput } from "./cli-envelope.ts";

/** The example directory: instructions, skill, data, the stand-in CLI, and run artifacts. */
export const rootDir = fileURLToPath(new URL("..", import.meta.url));

/** What the investigator must return. `run()` types `result.output` from it. */
export const findingSchema = schema.object({
  status: schema.union([
    schema.literal("supported"),
    schema.literal("unsupported"),
    schema.literal("insufficient_evidence"),
  ]),
  mechanism: schema.string(),
  deployment: schema.optional(schema.string()),
  evidence_queries: schema.array(schema.string()),
  evaluator_id: schema.optional(schema.string()),
  limitations: schema.array(schema.string()),
});

/** The CLI's envelope, validated by the runtime before the model or a UI card sees it. */
export const envelopeSchema = schema.object({
  operation: schema.string(),
  ok: schema.boolean(),
  status: schema.string(),
  request_id: schema.string(),
  data: schema.optional(schema.any()),
  resources: schema.optional(schema.array(schema.object({
    type: schema.string(),
    id: schema.string(),
    version: schema.optional(schema.number()),
    link: schema.optional(schema.string()),
  }))),
  error: schema.optional(schema.object({ code: schema.string(), message: schema.string() })),
});

/** The envelope as TypeScript, for the tool's return type; `envelopeSchema` is what the runtime validates. */
export interface Envelope {
  operation: string;
  ok: boolean;
  status: string;
  request_id: string;
  data?: unknown;
  resources?: Array<{ type: string; id: string; version?: number; link?: string }>;
  error?: { code: string; message: string };
}

export interface InvestigatorOptions {
  /** Where `bash` runs. Default: this host, with `bin/` on PATH. Host execution is not isolation. */
  backend?: ExecutionBackend;
  /** Workspace the file tools are contained to. Default: the example directory. */
  workspace?: string;
}

/**
 * The investigator. Bash operates the `caveman cloud` CLI (taught by the
 * skill); one typed tool wraps the single action that changes a live
 * resource, so its result is validated against the CLI envelope and reaches
 * a UI as data rather than as shell text.
 */
export async function investigator(options: InvestigatorOptions = {}) {
  const workspace = options.workspace ?? rootDir;
  const backend = options.backend ?? localExecutionBackend();
  if (options.backend === undefined) {
    const bin = join(rootDir, "bin");
    if (!(process.env.PATH ?? "").split(delimiter).includes(bin)) {
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    }
  }

  const activateEvaluator = tool({
    name: "activate_evaluator",
    description:
      "Activate an evaluator draft (from `caveman cloud evaluators create`) for observation-only " +
      "scoring. Returns the CLI envelope; `scoring` is `awaiting_traffic` until real traffic arrives.",
    input: schema.object({ evaluatorId: schema.string() }),
    output: envelopeSchema,
    effect: "write",
    result: "inline",
    async execute({ evaluatorId }, signal) {
      const result = await backend.exec({
        command: "caveman",
        args: ["cloud", "evaluators", "activate", "--id", evaluatorId, "--format", "json"],
        cwd: workspace,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        maxOutputBytes: 1 << 20,
        ...(signal === undefined ? {} : { signal }),
      });
      const text = combinedProcessOutput(result);
      try {
        return JSON.parse(text) as Envelope;
      } catch {
        throw new Error(`activate_evaluator: the CLI did not return an envelope (exit ${result.code}): ${text.slice(0, 200)}`);
      }
    },
  });

  const base = agent({
    id: "investigator",
    instructions: readFileSync(join(rootDir, "instructions.md"), "utf8"),
    model: auto(),
    tools: [
      ...shellTools({ workspace, executionBackend: backend, tools: ["bash", "read_file"] }),
      activateEvaluator,
    ],
    output: output({ maxTokens: 1_200, schema: findingSchema }),
    // Tool closures run in this process with real host access. That is
    // uncontained host execution, not isolation; the execution backend is the
    // seam that moves it into a container.
    sandbox: "host",
  });

  const environment = await loadAgentEnvironment({
    cwd: rootDir,
    skillRoots: [join(rootDir, ".agents", "skills")],
    includeDefaultRoots: false,
    includeWorkspacePlugin: false,
  });
  if (environment.diagnostics.length > 0) {
    throw new Error(`invalid skills: ${environment.diagnostics.map((d) => `${d.path}: ${d.message}`).join("; ")}`);
  }
  return applyAgentEnvironment(base, environment);
}
