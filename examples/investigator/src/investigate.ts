import { run } from "@caveman-ai/agent";
import { investigator } from "./agent.ts";
import { runOptions } from "./options.ts";
import { grantFromEnv } from "./policy.ts";

const question = process.argv.slice(2).join(" ") ||
  "Did support-desk get worse between 2026-09-01 and 2026-09-05? Catch it next time.";
const grant = grantFromEnv();
const definition = await investigator();

// Host execution: bash runs `caveman cloud …` on this machine against the
// stand-in CLI in bin/. The receipt prints after the run.
const result = await run(definition, question, { ...runOptions(grant), printReceipt: true });
console.log(`\nstop: ${result.stopReason}`);
console.log(JSON.stringify(result.output ?? { text: result.text }, null, 2));
const denied = result.receipt.tools.filter((entry) => (entry.denied ?? 0) > 0);
if (denied.length > 0) {
  console.log(`\ndenied by policy: ${denied.map((entry) => `${entry.name}×${entry.denied}`).join(", ")}` +
    ` (grant: ${[...grant.scopes].join(",") || "none"})`);
}
