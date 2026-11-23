import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAgentDir, run } from "@caveman-ai/agent";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const ticketPath = process.argv[2];
if (ticketPath === "--help" || ticketPath === "-h") {
  console.log("usage: npm run ticket -- tickets/<name>.md");
  console.log("example: npm run ticket -- tickets/refund-request.md");
  process.exit(0);
}
if (!ticketPath || process.argv.length !== 3) {
  console.error("usage: npm run ticket -- tickets/<name>.md");
  process.exit(1);
}

let ticket: string;
try {
  ticket = readFileSync(ticketPath, "utf8");
} catch {
  console.error(`ticket file not found: ${ticketPath}`);
  try {
    console.error(`try one of: ${readdirSync(new URL("./tickets", import.meta.url))
      .map((name) => `tickets/${name}`).join(" · ")}`);
  } catch {
    console.error("(the tickets/ directory is missing too)");
  }
  process.exit(1);
}

try {
  const definition = await loadAgentDir(rootDir);
  const result = await run(definition, ticket, {
    rootDir,
  });

  // The receipt prints by default at the end of every run — cost, warm
  // reads, and the inferred cold estimate need no extra code here.
  console.log(result.text);
} catch (error) {
  // One line, not a stack trace: framework errors already name their fix
  // (missing API key, unpriced model, missing instructions.md, …).
  console.error(error instanceof Error ? error.message : String(error));
  console.error("next: npm run doctor shows this machine's full readiness picture");
  process.exit(1);
}
