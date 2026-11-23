import { agent, createConnect, type AgentDefinitionTransform } from "@caveman-ai/agent";

// One stable `connected_data` tool schema enters the model's prefix. The
// provider catalog, sync schemas, and records stay out of the prompt until the
// agent asks for them, and a capped read returns `complete: false` plus
// `must_refuse: true` rather than silently dropping records.
//
// Authorize once, outside this process:  caveman-agent connect github
export const github = createConnect({
  sources: [{
    id: "work-github",
    provider: "github",
    collect: ["issues"],
    models: ["Issue"],
  }],
});

// The coding agent owns its own tool set, so extra tools arrive as an explicit
// definition transform. `sandbox: "host"` is restated here because it is the
// posture this whole template runs under: uncontained host execution unless
// CAVE_EXEC_URL moves process and filesystem effects to a remote sandbox.
export const withGitHub: AgentDefinitionTransform = {
  id: "background-agent.github",
  apply: (definition) => agent({
    id: definition.id,
    instructions: definition.instructions,
    model: definition.model,
    reasoning: definition.reasoning,
    tools: [...definition.tools, github.tool],
    contexts: [...definition.contexts],
    sandbox: "host",
  }),
};
