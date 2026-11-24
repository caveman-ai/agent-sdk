import { pathToFileURL } from "node:url";
import {
  createMemoryGateProvider,
  defineAgent,
  runInProcess,
  tool,
  type GateRequest,
  type InProcessRunOptions,
} from "../../packages/agent/dist/index.js";

/**
 * Fail-closed Caveman Gate: tools marked with `{ gate }` pause before execution
 * and run only when a GateProvider returns `status: "approved"`.
 */
export function createRefundAgent(executed: Array<{ id: string; amountUsd: number }> = []) {
  const issueRefund = tool(
    "issue_refund",
    "Issue a refund for an invoice.",
    {
      type: "object",
      properties: { id: { type: "string" }, amountUsd: { type: "number" } },
      required: ["id", "amountUsd"],
    },
    async (args: { id: string; amountUsd: number }) => {
      executed.push(args);
      return { refunded: true, ...args };
    },
    {
      gate: {
        risk: "high",
        summary: (input) => `Issue refund ${JSON.stringify(input)}`,
      },
    },
  );

  return defineAgent({
    name: "refund-operator",
    instructions: "Use issue_refund to refund duplicate charges.",
    computer: "none",
    tools: [issueRefund],
  });
}

export async function runGatedRefund(
  task: string,
  approve: (req: GateRequest) => boolean,
  overrides: Partial<InProcessRunOptions> = {},
) {
  const executed: Array<{ id: string; amountUsd: number }> = [];
  const defaultModel = process.env.CAVE_MODEL
    ?? (process.env.OPENAI_API_KEY ? "openai/gpt-5.4" : "anthropic/claude-sonnet-4-6");

  const result = await runInProcess({
    agent: createRefundAgent(executed),
    task,
    model: defaultModel,
    gateProvider: createMemoryGateProvider(async (req) => ({
      gateId: req.gateId,
      status: approve(req) ? "approved" : "denied",
      reason: approve(req) ? "Approved by policy" : "Refund exceeds automatic limit",
      decidedBy: "policy-gate",
    })),
    ...overrides,
  });

  return { result, executed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { result, executed } = await runGatedRefund(
    "Refund $42 for invoice 4411.",
    (req) => Number((req.input as { amountUsd?: number })?.amountUsd ?? 0) <= 50,
  );
  console.log(result.text);
  console.log("\nexecuted refunds:", executed);
}
