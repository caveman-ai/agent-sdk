import type { AgentDirConfig } from "@caveman-ai/agent";

// Behavior lives here; prose lives in instructions.md and .agents/skills/.
// Everything in this file is static by construction — run-varying values
// (dates, ticket ids, customer names) enter through the ticket input or a
// tool result, never through config.
export default {
  // Pinned rather than auto(): the frozen prefix must clear the provider's
  // minimum cacheable length (1,024 tokens for this model; the OpenAI and
  // Google models the scaffolder offers need 2,048 — this template's
  // instructions clear both with margin), and auto() may select a model
  // with a higher minimum than this agent's prefix. The build measures the
  // prefix and fails below the floor for explicit-cache models — see
  // goldens/failures/prefix-below-minimum.
  // create-caveman-agent sets this line to a cataloged provider/model for
  // the provider you chose at scaffold time; pinned models always use the
  // provider/model form.
  model: "anthropic/claude-sonnet-5",
  budget: {
    // Cost per ticket, as a hard local guard at public-catalog list prices.
    maxUsd: 0.05,
    onExhausted: "compact",
  },
  breakers: {
    // Tighter than the default (3): a support bot re-calling the same
    // lookup twice is already stuck.
    repeatedToolCalls: 2,
  },
} satisfies AgentDirConfig;
