import { readFileSync } from "node:fs";
import { tool, schema } from "@caveman-ai/agent";

type Order = {
  id: string;
  status: string;
  items: string[];
  totalUsd: number;
  carrier: string | null;
  carrierEstimate: string | null;
  deliveredOn: string | null;
};

// Filename = tool name. Read-effect only: the agent looks things up and
// recommends; nothing here can move money or mutate an order.
export default tool({
  name: "lookup_order",
  description:
    "Look up a Acme order by id (format NB-0000). Returns status, items, total, and carrier info, or a not-found marker.",
  effect: "read",
  input: schema.object({
    orderId: schema.string(),
  }),
  execute: async ({ orderId }: { orderId: string }) => {
    if (!/^NB-\d{1,6}$/.test(orderId)) {
      return { found: false, orderId, reason: "order ids look like NB-1042" };
    }
    const orders: Order[] = JSON.parse(
      readFileSync(new URL("../data/orders.json", import.meta.url), "utf8"),
    );
    const order = orders.find((entry) => entry.id === orderId);
    if (!order) {
      return { found: false, orderId };
    }
    return { found: true, order };
  },
});
