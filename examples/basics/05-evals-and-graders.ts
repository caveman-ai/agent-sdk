import { pathToFileURL } from "node:url";
import { grade, type Grader } from "../../packages/evals/dist/index.js";

/**
 * Deterministic, fail-closed agent evaluation with `@caveman-ai/evals`.
 * Every grader returns `{ passed, score, reason }` and fails closed on missing
 * cost, missing tool calls, or invalid schemas.
 */
export async function gradeSupportRun(candidate: {
  text: string;
  tool_calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  cost_usd: number;
}) {
  const graders: Grader[] = [
    { type: "contains", fragments: ["4411", "42"] },
    { type: "tool_called", tools: ["lookup_invoice"] },
    { type: "tool_argument_assertion", tool: "lookup_invoice", path: "id", equals: "4411" },
    { type: "cost_threshold", max_usd: 0.05 },
  ];

  const results = await Promise.all(
    graders.map(async (g) => ({ type: g.type, ...(await grade(g, candidate)) })),
  );

  return {
    allPassed: results.every((r) => r.passed),
    results,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await gradeSupportRun({
    text: "Invoice 4411 is paid ($42).",
    tool_calls: [{ name: "lookup_invoice", arguments: { id: "4411" } }],
    cost_usd: 0.0012,
  });
  console.log(JSON.stringify(report, null, 2));
}
