#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [command, handle, contentType] = process.argv.slice(2);
const store = process.env.CAVE_FAKE_ENGINE_STORE;
if (!store) throw new Error("CAVE_FAKE_ENGINE_STORE missing");
await writeFile(resolve(store, "argv.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`, { flag: "a" });

const queryFile = process.argv.indexOf("--query-file");
if (command === "compress" && queryFile > 0) {
  // An engine from before --query-file rejects it, as the real CLI does (a marker file in the store asks for that).
  if (await access(resolve(store, "no-query-file")).then(() => true, () => false)) {
    process.stderr.write("caveman-engine: unknown compress flag: --query-file\n");
    process.exit(2);
  }
  const path = process.argv[queryFile + 1];
  await writeFile(resolve(store, "queries.jsonl"), `${JSON.stringify({
    path, query: await readFile(path, "utf8"), mode: (await stat(path)).mode & 0o777,
  })}\n`, { flag: "a" });
}

if (command === "compress") {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  // Like the real engine, a tiny input is declined: unchanged, no recovery handle.
  if (input.length < 16) {
    process.stdout.write(input);
    process.stderr.write(`${JSON.stringify({ method: "none", ratio: 0 })}\n`);
    process.exit(0);
  }
  const digest = createHash("sha256").update(input).digest("hex");
  const recoveryHandle = `ccr_${digest}`;
  await writeFile(resolve(store, recoveryHandle), input);
  if (handle === "--type" && contentType === "toolschema") {
    const parsed = JSON.parse(input.toString("utf8"));
    parsed.description = String(parsed.description).split(".")[0] + ".";
    if (parsed.input && typeof parsed.input === "object") {
      delete parsed.input.title;
      delete parsed.input.default;
    }
    process.stdout.write(JSON.stringify(parsed));
  } else if (input.includes("FAKE_ENGINE_HALF")) {
    // A weak compression: what comes back is still over a tool's cap.
    process.stdout.write(input.subarray(0, input.length >> 1));
  } else {
    process.stdout.write("compressed summary");
  }
  process.stderr.write(`${JSON.stringify({
    recovery_handle: recoveryHandle,
    method: "text",
    ratio: 0.8,
  })}\n`);
} else if (command === "retrieve" && handle) {
  process.stdout.write(await readFile(resolve(store, handle)));
} else {
  process.exitCode = 2;
}
