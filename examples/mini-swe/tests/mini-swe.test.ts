// Deterministic, no network, no Docker: scripted provider turns, a fake backend.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run, type ExecRequest, type ExecutionBackend } from "@caveman-ai/agent";
import { DiskDurableStore } from "@caveman-ai/agent/durable";
import { fauxModel, scriptedStream } from "@caveman-ai/agent/testing";
import { miniSwe, observation, SUBMIT_MARKER, submissionFromJournal } from "../src/agent.ts";
import { dockerExecArgs } from "../src/docker.ts";

const scratch = mkdtempSync(join(tmpdir(), "mini-swe-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function fakeBackend(reply: (command: string) => { stdout: string; code: number }) {
  const requests: ExecRequest[] = [];
  const backend: ExecutionBackend = {
    id: "fake",
    async exec(request) {
      requests.push(request);
      const { stdout, code } = reply(request.args[1] ?? "");
      return { stdout, stderr: "", code, timedOut: false, truncated: false };
    },
    readFile: () => Promise.reject(new Error("unused")),
    writeFile: () => Promise.reject(new Error("unused")),
  };
  return { backend, requests };
}

test("bash runs through the backend, submission is captured, later bash calls are refused", async () => {
  const patch = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n";
  const { backend, requests } = fakeBackend((command) =>
    command.startsWith(`echo ${SUBMIT_MARKER}`) ? { stdout: `${SUBMIT_MARKER}\n${patch}`, code: 0 } : { stdout: "x.py\n", code: 0 });
  const { definition, submission } = miniSwe({ backend, cwd: "/testbed", env: { PAGER: "cat" } });
  const store = new DiskDurableStore(join(scratch, "durable"));
  const result = await run(definition, "fix x.py", {
    rootDir: scratch,
    durable: { runId: "x-1", store },
    ensureRuntime: false,
    budget: { maxUsd: 1 },
    model: fauxModel({ priced: true }),
    streamFn: scriptedStream([
      { toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { toolCalls: [{ name: "bash", args: { command: `echo ${SUBMIT_MARKER} && cat patch.txt` } }] },
      { toolCalls: [{ name: "bash", args: { command: "ls" } }] },
      { text: "Submitted." },
    ]),
  });
  assert.equal(result.stopReason, "complete");
  assert.equal(submission(), patch);
  assert.deepEqual(result.toolCalls, ["bash", "bash", "bash"]);
  assert.equal(requests.length, 2, "the call after submission never reaches the backend");
  const { signal: _signal, ...first } = requests[0]!;
  assert.deepEqual(first, {
    command: "bash", args: ["-c", "ls"], cwd: "/testbed", env: { PAGER: "cat" }, timeoutMs: 60_000, maxOutputBytes: 1 << 20,
  });
  assert.deepEqual(result.receipt.tools.map((entry) => [entry.name, entry.calls, entry.errors]), [["bash", 3, 0]]);
  assert.ok(result.receipt.totalEstimatedUsd > 0);
  assert.equal(submissionFromJournal(await store.load("x-1")), patch, "the real journal carries the patch");
});

test("a resumed run recovers the submission from the journaled tool result", () => {
  const patch = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n";
  const settled = (name: string, text: string) =>
    JSON.stringify({ type: "tool_settled", name, outcome: "returned", value: { encoding: "json", json: JSON.stringify({ content: [{ text }] }) } });
  assert.equal(submissionFromJournal([
    JSON.stringify({ type: "run_started" }),
    settled("bash", observation("0", "x.py\n")),
    settled("bash", `Submission received. Stop calling bash and reply with one sentence.\n<submission>\n${patch}\n</submission>`),
    settled("bash", "Already submitted. Stop calling bash and reply with one sentence."),
  ]), patch);
  assert.equal(submissionFromJournal([settled("bash", observation("0", "nothing"))]), undefined);
});

test("observation elides long output head/tail like mini-swe-agent", () => {
  assert.equal(observation("0", "hi\n"), "<returncode>0</returncode>\n<output>\nhi\n</output>");
  const long = "a".repeat(6_000) + "b".repeat(6_000);
  const elided = observation("1", long);
  assert.match(elided, /<elided_chars>\n2000 characters elided/);
  assert.ok(elided.includes("a".repeat(5_000)) && elided.includes("b".repeat(5_000)));
  assert.ok(!elided.includes("a".repeat(5_001)));
});

test("docker exec argv carries cwd, explicit env, and the command", () => {
  assert.deepEqual(
    dockerExecArgs("abc", { command: "bash", args: ["-c", "ls"], cwd: "/testbed", env: { PAGER: "cat", BASH_ENV: "/root/.bashrc" }, timeoutMs: 1, maxOutputBytes: 1 }),
    ["exec", "-w", "/testbed", "-e", "PAGER=cat", "-e", "BASH_ENV=/root/.bashrc", "abc", "bash", "-c", "ls"],
  );
});
