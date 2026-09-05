// SWE-bench batch runner. One container per instance, one durable run per
// instance, preds.json in the format SWE-bench's harness scores.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { run, type ExecutionBackend } from "@caveman-ai/agent";
import { DiskDurableStore } from "@caveman-ai/agent/durable";
import { miniSwe, submissionFromJournal } from "./agent.ts";
import { dockerBackend } from "./docker.ts";

const DATASETS: Record<string, string> = {
  verified: "princeton-nlp/SWE-bench_Verified",
  lite: "princeton-nlp/SWE-bench_Lite",
  full: "princeton-nlp/SWE-bench",
};
// mini-swe-agent's container env: non-login bash, so BASH_ENV activates the testbed conda env.
const CONTAINER_ENV = { PAGER: "cat", MANPAGER: "cat", LESS: "-R", PIP_PROGRESS_BAR: "off", TQDM_DISABLE: "1", BASH_ENV: "/root/.bashrc" };

const { values } = parseArgs({ options: {
  subset: { type: "string", default: "verified" },
  split: { type: "string", default: "test" },
  slice: { type: "string", default: "" },
  filter: { type: "string", default: "" },
  workers: { type: "string", default: "1" },
  output: { type: "string", default: "runs/swebench" },
  redo: { type: "boolean", default: false },
} });
const output = values.output;
const predsPath = `${output}/preds.json`;
mkdirSync(output, { recursive: true });

interface Instance { instance_id: string; problem_statement: string }
const preds: Record<string, { model_name_or_path: string; instance_id: string; model_patch: string }> =
  JSON.parse(readTextOr(predsPath, "{}"));
const store = new DiskDurableStore(join(output, ".caveman", "runs", "durable"));
// --redo gets a fresh journal per batch start; without it the finished journal would replay for free.
const redoTag = values.redo ? `-redo-${Date.now().toString(36)}` : "";
const queue = (await loadInstances(DATASETS[values.subset] ?? values.subset, values.split))
  .filter((instance) => new RegExp(values.filter).test(instance.instance_id))
  .slice(...values.slice.split(":").map((part) => part === "" ? undefined : Number(part)) as [number?, number?])
  .filter((instance) => values.redo || !(instance.instance_id in preds));
console.log(`${queue.length} instances → ${output}`);

const live = new Set<ExecutionBackend>();
process.once("SIGINT", async () => {
  console.error(`\nstopping: removing ${live.size} container(s)`);
  await Promise.all([...live].map((backend) => backend.close?.()));
  process.exit(130);
});

await Promise.all(Array.from({ length: Number(values.workers) }, async () => {
  for (let instance = queue.shift(); instance !== undefined; instance = queue.shift()) await solve(instance);
}));

async function solve(instance: Instance): Promise<void> {
  const id = instance.instance_id;
  const image = `docker.io/swebench/sweb.eval.x86_64.${id.replaceAll("__", "_1776_")}:latest`.toLowerCase();
  let backend: ExecutionBackend | undefined;
  try {
    backend = await dockerBackend(image);
    live.add(backend);
    const { definition, submission } = miniSwe({ backend, cwd: "/testbed", env: CONTAINER_ENV });
    // Same instance id → same journal: a crashed instance resumes with its known spend.
    const runId = `${id}${redoTag}`;
    const result = await run(definition, instance.problem_statement, {
      rootDir: output,
      durable: { runId, store },
      budget: { maxUsd: 3 },
      maxModelCalls: 250,
      deadlineMs: 60 * 60_000,
    });
    const patch = submission() ?? submissionFromJournal(await store.load(runId)) ?? "";
    preds[id] = { model_name_or_path: `${result.provider}/${result.model}`, instance_id: id, model_patch: patch };
    writeFileSync(`${predsPath}.tmp`, JSON.stringify(preds, null, 2));
    renameSync(`${predsPath}.tmp`, predsPath);
    writeFileSync(`${output}/${id}.traj.json`, JSON.stringify({
      instance_id: id, stopReason: result.stopReason, calls: result.receipt.calls.length,
      toolCalls: result.toolCalls.length, costUsd: result.costUsd, priceBasis: result.priceBasis,
      submitted: patch !== "", text: result.text, receipt: result.receipt,
    }, null, 2));
    const cost = result.priceBasis === "public_catalog" ? `$${result.costUsd.toFixed(3)} list price` : "cost unknown (unpriced model)";
    console.log(`${id}: ${result.stopReason}, ${result.receipt.calls.length} calls, ${cost}, ${patch === "" ? "NO PATCH" : "patch"}`);
  } catch (error) {
    console.error(`${id}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (backend !== undefined) {
      live.delete(backend);
      await backend.close?.();
    }
  }
}

/** Hugging Face datasets-server pages 100 rows at a time; no `datasets` dependency. */
async function loadInstances(dataset: string, split: string): Promise<Instance[]> {
  const rows: Instance[] = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=${split}&offset=${offset}&length=100`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`dataset fetch failed: ${response.status} ${url}`);
    const page = await response.json() as { rows: { row: Instance }[] };
    rows.push(...page.rows.map(({ row }) => ({ instance_id: row.instance_id, problem_statement: row.problem_statement })));
    if (page.rows.length < 100) return rows.sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  }
}

function readTextOr(path: string, fallback: string): string {
  try { return readFileSync(path, "utf8"); } catch { return fallback; }
}
