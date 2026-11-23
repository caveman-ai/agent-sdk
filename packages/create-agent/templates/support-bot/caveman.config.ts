import { defineBuild } from "@caveman-ai/agent/build";

export default defineBuild({
  // "." = this directory follows the agent-directory convention:
  // instructions.md + agent.ts + tools/ + skills/ + evals/.
  entry: ".",
  evals: "evals/*.eval.ts",
  maxSearchCostUsd: 2,
});
