import { localExecutionBackend, run } from "@caveman-ai/agent";
import { miniSwe } from "./agent.ts";

const task = process.argv.slice(2).join(" ");
if (task === "") {
  console.error('usage: npm run mini -- "task description"');
  process.exit(1);
}

const cwd = process.cwd();
const { definition, submission } = miniSwe({
  backend: localExecutionBackend(),
  cwd,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", PAGER: "cat", GIT_PAGER: "cat" },
});

// Host execution is not isolation: this runs commands on your machine, in this directory.
const result = await run(definition, task, {
  rootDir: cwd,
  budget: { maxUsd: 3 },
  maxModelCalls: 250,
  deadlineMs: 30 * 60_000,
  printReceipt: true,
});
console.log(`\n${result.text}\n`);
const patch = submission();
if (patch !== undefined) console.log(`--- submitted patch ---\n${patch}`);
