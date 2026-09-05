import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agent, auto, memory, schema, subagent, tool } from "@caveman-ai/agent";
import { applyAgentEnvironment, loadAgentEnvironment } from "@caveman-ai/agent/plugins";

/** The example directory. Instructions, skills, data, and run artifacts live under it. */
export const rootDir = fileURLToPath(new URL("..", import.meta.url));

interface Order {
  id: string;
  customerEmail: string;
  status: "processing" | "dispatched" | "in_transit" | "delivered";
  items: string[];
  totalUsd: number;
  carrier: string | null;
  carrierEstimate: string | null;
  deliveredOn: string | null;
}

const orders: Order[] = JSON.parse(
  readFileSync(new URL("../data/orders.json", import.meta.url), "utf8"),
);

// Read-effect tools over a local JSON file. Effects are declared truthfully:
// nothing here can move money or mutate an order.
const lookupOrder = tool({
  name: "lookup_order",
  description:
    "Look up a Northbeam order by id (format NB-0000). Returns status, items, total, carrier, and delivery date, or found: false.",
  effect: "read",
  input: schema.object({ orderId: schema.string() }),
  execute: async ({ orderId }: { orderId: string }) => {
    const order = orders.find((entry) => entry.id === orderId.trim().toUpperCase());
    return order === undefined
      ? { found: false, orderId, hint: "order ids look like NB-1042" }
      : { found: true, order };
  },
});

const ordersForCustomer = tool({
  name: "orders_for_customer",
  description:
    "List the order ids and statuses on a customer email address. Use when the customer has no order id to hand.",
  effect: "read",
  input: schema.object({ email: schema.string() }),
  execute: async ({ email }: { email: string }) => {
    const mine = orders.filter((entry) => entry.customerEmail === email.trim().toLowerCase());
    return { email, orders: mine.map(({ id, status }) => ({ id, status })) };
  },
});

// A second model with its own wallet. Under the run's USD budget the wallet is
// carved out of the parent's remaining budget at spawn, the unspent remainder
// returns when the child finishes, and the child's calls land on the parent's
// receipt under `subagents`.
const refundReviewer = agent({
  id: "refund-reviewer",
  instructions: readFileSync(new URL("../refund-reviewer.md", import.meta.url), "utf8"),
  model: auto(),
  reasoning: "off",
  sandbox: "host",
});

const desk = agent({
  id: "support-desk",
  instructions: readFileSync(new URL("../instructions.md", import.meta.url), "utf8"),
  model: auto(),
  tools: [
    lookupOrder,
    ordersForCustomer,
    subagent({
      name: "refund_reviewer",
      description:
        "Independent second opinion on a refund or credit amount. Pass the order record, the policy rule applied, and the intended amount.",
      agent: refundReviewer,
      maxCalls: 1,
      maxCostUsd: 0.02,
      maxContextTokens: 16_000,
    }),
  ],
  // Durable customer facts across sessions, scoped by (tenant, agent, namespace).
  memory: memory({ namespace: "customers" }),
  // Explicit host mode: tool closures run in this process with real host
  // access. That is uncontained host execution, not isolation. It is the
  // documented posture for interactive agents, and it is why this example has
  // no build lock: host mode anywhere in the graph is lock-ineligible.
  sandbox: "host",
});

// Skills: each one-line description joins the cached prefix; the body stays on
// disk until the model calls load_skill, so a large playbook costs nothing on
// the tickets that never touch it.
const environment = await loadAgentEnvironment({
  cwd: rootDir,
  skillRoots: [join(rootDir, ".agents", "skills")],
  includeDefaultRoots: false,
  includeWorkspacePlugin: false,
});
if (environment.diagnostics.length > 0) {
  throw new Error(`invalid skills: ${
    environment.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")
  }`);
}

export const supportDesk = applyAgentEnvironment(desk, environment);
export default supportDesk;
