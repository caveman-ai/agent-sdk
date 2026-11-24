import { pathToFileURL } from "node:url";
import { defineAgent, runInProcess, tool, type InProcessRunOptions } from "../../packages/agent/dist/index.js";

const lookupInvoice = tool(
  "lookup_invoice",
  "Look up an invoice by ID.",
  { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  async ({ id }: { id: string }) => ({ id, status: "paid", amountUsd: 42 }),
);

export const billingAgent = defineAgent({
  name: "billing",
  description: "Answers billing questions briefly using lookup_invoice.",
  instructions: "Answer billing questions concisely using lookup_invoice. Never invent amounts.",
  computer: "none",
  tools: [lookupInvoice],
});

export async function runHelloBilling(
  task = "What is the status and amount of invoice 4411?",
  overrides: Partial<InProcessRunOptions> = {},
) {
  const defaultModel = process.env.CAVE_MODEL
    ?? (process.env.OPENAI_API_KEY ? "openai/gpt-5.4" : "anthropic/claude-sonnet-4-6");
  return runInProcess({
    agent: billingAgent,
    task,
    model: defaultModel,
    ...overrides,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runHelloBilling();
  console.log(result.text);
  console.log("\nusage:", result.usage);
}
