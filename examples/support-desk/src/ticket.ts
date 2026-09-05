import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { CavemanRunError, run, sha256 } from "@caveman-ai/agent";
import { agentDefinitionSHA256 } from "@caveman-ai/agent/build";
import { supportDesk } from "./agent.ts";
import { memoryEngine, runOptions } from "./options.ts";

const path = process.argv[2];
if (path === undefined) {
  console.error("usage: npm run ticket -- tickets/<name>.md");
  process.exit(1);
}
const ticket = readFileSync(path, "utf8");

// Durable runs key on a caller-assigned id. Deriving it from the agent
// definition and the ticket bytes gives idempotency for free: an unchanged
// ticket replays its journal and spends nothing; any edit is a new run.
const runId = `${basename(path, ".md")}-${
  sha256(agentDefinitionSHA256(supportDesk) + ticket).slice(0, 12)
}`;

try {
  // printReceipt writes the full receipt under .caveman/runs/ and prints the
  // summary: calls, warm reads, list-price cost, the inferred cold estimate.
  const result = await run(supportDesk, ticket, {
    ...runOptions(),
    durable: { runId },
    printReceipt: true,
  });
  console.log(`\n${result.text}\n`);
} catch (error) {
  // A failure after spend still carries its partial receipt.
  console.error(error instanceof Error ? error.message : String(error));
  if (error instanceof CavemanRunError && error.receipt.calls.length > 0) {
    console.error(`  spent before the failure: $${error.receipt.totalEstimatedUsd.toFixed(4)} (list price)`);
  }
  process.exitCode = 1;
} finally {
  await memoryEngine.flush();
}
