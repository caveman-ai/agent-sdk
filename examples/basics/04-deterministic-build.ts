import { pathToFileURL } from "node:url";
import {
  agentFileText,
  compileAgentDefinition,
  defineAgent,
  defineSensor,
  tool,
} from "../../packages/agent/dist/index.js";

/**
 * Deterministic `AGENT.md` builds: the same definition always compiles to
 * byte-identical frontmatter and the same SHA-256 digest so prompt-cache
 * prefixes never drift across deployments.
 */
export function buildTriageArtifact() {
  const lookupOrder = tool(
    "lookup_order",
    "Fetch order status by ID.",
    { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
    async ({ orderId }: { orderId: string }) => ({ orderId, status: "shipped" }),
  );

  const triageAgent = defineAgent({
    name: "order-triage",
    description: "Triages customer order status inquiries.",
    instructions: "Use lookup_order to check delivery status. Escalate damaged shipments.",
    model: "fast",
    computer: "none",
    tools: [lookupOrder],
    sensors: [
      defineSensor({
        name: "support-ticket-opened",
        source: "webhook",
        event: "ticket.opened",
      }),
    ],
  });

  const markdown = agentFileText(triageAgent);
  const compiled = compileAgentDefinition(triageAgent);
  return { markdown, compiled };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { markdown, compiled } = buildTriageArtifact();
  console.log(`digest: ${compiled.digest}\n`);
  console.log(markdown);
}
