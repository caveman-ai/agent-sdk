import { eval as defineEval } from "@caveman-ai/agent";
import { readFileSync } from "node:fs";

// Each ticket is named by a literal `new URL("…", import.meta.url)` so the
// build's source graph can lock the exact fixture bytes. A computed path
// (template string) is not lockable and fails doctor/build by design.
const ticket = (url: URL): string => readFileSync(url, "utf8");

export const refundRequest = defineEval({
  id: "refund-request",
  lineageId: "refund-family",
  split: "profile",
  input: ticket(new URL("../tickets/refund-request.md", import.meta.url)),
  quality: [
    { type: "tool_called", tools: ["lookup_order"] },
    { type: "contains", fragments: ["eligible"] },
    { type: "not_contains", fragments: ["refund issued", "refund completed"] },
  ],
});

export const orderStatus = defineEval({
  id: "order-status",
  lineageId: "status-family",
  split: "development",
  input: ticket(new URL("../tickets/order-status.md", import.meta.url)),
  quality: [
    { type: "tool_called", tools: ["lookup_order"] },
    { type: "contains", fragments: ["NB-1042"] },
  ],
});

export const angryEscalation = defineEval({
  id: "angry-escalation",
  lineageId: "escalation-family",
  split: "development",
  input: ticket(new URL("../tickets/angry-escalation.md", import.meta.url)),
  // Chargeback already exists, so reply escalates and claims no money action.
  quality: [
    { type: "contains", fragments: ["escalated to a Acme support lead"] },
    { type: "not_contains", fragments: ["refund issued", "refund completed"] },
  ],
});

export const shippingDelay = defineEval({
  id: "shipping-delay",
  lineageId: "shipping-family",
  split: "holdout",
  // Deliberately a different order than any development fixture: holdout
  // must test generalization, not content the development set tuned on.
  input:
    "Subject: NB-8214 late?\n\nMy order NB-8214 feels like it's taking forever. Is it late? When will it arrive?",
  quality: [
    { type: "tool_called", tools: ["lookup_order"] },
    // No invented dates: the reply quotes the carrier estimate as the
    // carrier's, per instructions.md.
    { type: "contains", fragments: ["carrier"] },
  ],
});

export const warrantyQuestion = defineEval({
  id: "warranty-question",
  lineageId: "warranty-family",
  split: "holdout",
  input:
    "Subject: Pack strap ripped\n\nThe strap on my Cascade 40L from order NB-2077 ripped on a trail last month. I've used it maybe five times. Can I get this fixed or replaced?",
  quality: [{ type: "contains", fragments: ["warranty"] }],
});
