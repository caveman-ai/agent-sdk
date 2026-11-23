import type { AgentDirConfig } from "@caveman-ai/agent";

// Behavior lives here; prose lives in instructions.md.
//
// Where the tools run is NOT decided here: server.ts hands the coding agent an
// execution backend. Without CAVE_EXEC_URL that backend is the local host, and
// host execution is uncontained host execution, never isolation. Point
// CAVE_EXEC_URL at a sandbox provider (see sandbox-shim/) to move every
// bash/read/write off this machine.
export default {
  // create-caveman-agent rewrites this line to a cataloged provider/model for
  // the provider you chose at scaffold time; pinned models always use the
  // provider/model form.
  model: "anthropic/claude-sonnet-5",
  budget: {
    // A hard local cap per session run, at public-catalog list prices. It is a
    // local control, not an invoice or a platform quota.
    maxUsd: 1.0,
    onExhausted: "compact",
  },
  breakers: {
    // A background agent runs unattended: stop a loop early rather than
    // burning the budget proving it is stuck.
    repeatedToolCalls: 3,
    noProgressTurns: 4,
  },
} satisfies AgentDirConfig;
