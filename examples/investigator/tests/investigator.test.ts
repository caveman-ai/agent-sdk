// Deterministic, no network, no account. Every provider call is answered by a
// scripted stream; the bash tool, the stand-in `caveman cloud` CLI, the tool
// policy, the output schema, the journal, and the session server are real.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run, stream, type AgentOutput, type RunOptions, type RunResult } from "@caveman-ai/agent";
import { DiskDurableStore } from "@caveman-ai/agent/durable";
import { createAgentServer } from "@caveman-ai/agent/serve";
import { fauxModel, scriptedStream, type ScriptedTurn } from "@caveman-ai/agent/testing";
import { investigator, rootDir } from "../src/agent.ts";
import { envelopeFromBashResult } from "../src/cli-envelope.ts";
import { runOptions } from "../src/options.ts";
import { grantFromEnv, policyFor, type Grant } from "../src/policy.ts";

const scratch = mkdtempSync(join(tmpdir(), "investigator-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const definition = await investigator();

const READ: Grant = { tenant: "t", scopes: new Set(["read"]) };
const WRITE: Grant = { tenant: "t", scopes: new Set(["read", "write_resource"]) };
const WINDOW = ["--from", "2026-09-01T00:00:00Z", "--to", "2026-09-05T00:00:00Z"].join(" ");
const bash = (command: string): ScriptedTurn => ({ toolCalls: [{ name: "bash", args: { command } }] });
const finding = (extra: Record<string, unknown> = {}) => JSON.stringify({
  status: "supported",
  mechanism: "lookup_order loop on deployment v42",
  deployment: "v42",
  evidence_queries: ["placeholder"],
  limitations: ["transcripts are redacted"],
  ...extra,
});

function options(grant: Grant, turns: ScriptedTurn[], extra: RunOptions = {}): RunOptions {
  return {
    ...runOptions(grant),
    rootDir: scratch,
    ensureRuntime: false,
    model: fauxModel({ priced: true }),
    streamFn: scriptedStream(turns),
    ...extra,
  };
}

async function toolResults(grant: Grant, turns: ScriptedTurn[]) {
  const results: Array<{ name: string; isError: boolean; text: string }> = [];
  // `stream()` yields the untyped `RunResult`; the definition's schema types it.
  let result: RunResult<AgentOutput<typeof definition>> | undefined;
  for await (const event of stream(definition, "Did support-desk get worse this week?", options(grant, turns))) {
    if (event.type === "pi" && event.event.type === "tool_execution_end") {
      const content = (event.event.result as { content?: Array<{ text?: string }> }).content ?? [];
      results.push({ name: event.event.toolName, isError: event.event.isError, text: content.map((p) => p.text ?? "").join("") });
    }
    if (event.type === "run_end") result = event.result as RunResult<AgentOutput<typeof definition>>;
  }
  return { results, result: result! };
}

test("bash operates the CLI: envelopes come back typed, and the finding is typed output", async () => {
  const { results, result } = await toolResults(READ, [
    bash(`caveman cloud traces search ${WINDOW} --status error --format json`),
    bash(`caveman cloud traces search ${WINDOW} --status ok --format json`),
    bash("caveman cloud traces transcript tr_0903a --format json"),
    { text: finding({ evidence_queries: ["set-below"] }) },
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.isError), [false, false, false]);
  const errors = envelopeFromBashResult(results[0]!.text)!;
  const ok = envelopeFromBashResult(results[1]!.text)!;
  assert.equal(errors.operation, "traces.search");
  assert.equal((errors.data as { count: number }).count, 3, "three failing traces in the window");
  assert.equal((ok.data as { count: number }).count, 4);
  assert.ok(Array.isArray(errors.resources) && (errors.resources as unknown[]).length === 3, "resource references for cards");
  assert.equal(envelopeFromBashResult(results[2]!.text)!.operation, "traces.transcript");
  assert.equal(result.stopReason, "complete");
  assert.equal(result.output!.status, "supported");
  assert.equal(result.output!.deployment, "v42");
  assert.deepEqual(result.receipt.tools.map((t) => [t.name, t.calls, t.errors]), [["bash", 3, 0]]);
  assert.equal(result.receipt.denomination, "usd");
});

test("the policy refuses shell outside the allowlist before it runs", async () => {
  const canary = join(scratch, "canary.txt");
  writeFileSync(canary, "still here");
  const { results, result } = await toolResults(READ, [
    bash(`rm -f ${canary}`),
    bash(`caveman cloud tools list; rm -f ${canary}`),
    bash(`cat ${canary}\nrm -f ${canary}`),
    bash(`cat ${canary} > ${canary}`),
    { text: finding({ status: "insufficient_evidence", evidence_queries: [] }) },
  ]);
  assert.deepEqual(results.map((r) => [r.isError, r.text]), [
    [true, "cave_tool_denied:shell_scope"],
    [true, "cave_tool_denied:shell_compound"],
    [true, "cave_tool_denied:shell_compound"],
    [true, "cave_tool_denied:shell_compound"],
  ]);
  assert.equal(readFileSync(canary, "utf8"), "still here");
  assert.deepEqual(result.receipt.tools, [{ name: "bash", calls: 4, errors: 4, denied: 4 }]);
  assert.equal(result.output!.status, "insufficient_evidence");
});

test("activating an evaluator needs the write_resource grant; with it, the envelope is validated", async () => {
  const draft = join(scratch, "evaluator.json");
  writeFileSync(draft, JSON.stringify({ name: "no-lookup-loops", rule: "lookup_order called at most twice per conversation" }));
  const turns = (): ScriptedTurn[] => [
    bash(`caveman cloud evaluators create --file ${draft} --format json`),
    { toolCalls: [{ name: "activate_evaluator", args: { evaluatorId: "__set_below__" } }] },
    { text: finding() },
  ];
  // Read-only grant: the draft is created (a bash read of the CLI), activation is denied.
  const denied = await toolResults(READ, turns());
  const created = envelopeFromBashResult(denied.results[0]!.text)!;
  const evaluatorId = (created.data as { evaluator_id: string }).evaluator_id;
  assert.match(evaluatorId, /^ev_/);
  assert.equal(denied.results[1]!.text, "cave_tool_denied:grant_scope");
  assert.equal(JSON.parse(readFileSync(join(rootDir, ".caveman", `${evaluatorId}.json`), "utf8")).active, false);
  assert.deepEqual(denied.result.receipt.tools.find((t) => t.name === "activate_evaluator"),
    { name: "activate_evaluator", calls: 1, errors: 1, denied: 1 });

  // Write grant: the typed tool runs the CLI and its envelope passes the output schema.
  const scripted = turns();
  (scripted[1]!.toolCalls![0]!.args as { evaluatorId: string }).evaluatorId = evaluatorId;
  const allowed = await toolResults(WRITE, scripted);
  assert.equal(allowed.results[1]!.isError, false);
  const envelope = JSON.parse(allowed.results[1]!.text) as { ok: boolean; data: { active: boolean; scoring: string } };
  assert.equal(envelope.ok, true);
  assert.deepEqual([envelope.data.active, envelope.data.scoring], [true, "awaiting_traffic"]);
  assert.equal(JSON.parse(readFileSync(join(rootDir, ".caveman", `${evaluatorId}.json`), "utf8")).active, true);
  rmSync(join(rootDir, ".caveman", `${evaluatorId}.json`), { force: true });
});

test("a durable investigation replays without spending, and a lost turn re-evaluates the policy", async () => {
  const store = new DiskDurableStore(join(scratch, "durable"));
  const runId = "regression-2026-09-05";
  const first = await run(definition, "Did it get worse?", options(READ, [
    bash(`caveman cloud traces search ${WINDOW} --status error --format json`),
    { text: finding() },
  ], { durable: { runId, store } }));
  assert.equal(first.stopReason, "complete");
  assert.equal(first.output!.status, "supported");
  let calls = 0;
  const replayed = await run(definition, "Did it get worse?", options(READ, [], {
    durable: { runId, store },
    streamFn: () => { calls++; throw new Error("must not be called"); },
  }));
  assert.equal(calls, 0);
  assert.deepEqual(replayed.output, first.output, "the journaled result carries the typed output");
  assert.equal(replayed.receipt.calls.length, first.receipt.calls.length);
});

test("session server: the principal picks the grant, and page context reaches the model", async (t) => {
  const inputs: string[] = [];
  const grants: Record<string, Grant> = { acme: WRITE, globex: READ };
  const server = createAgentServer({
    definition,
    store: new DiskDurableStore(join(scratch, "sessions")),
    rootDir: scratch,
    authenticate: (request) => {
      const tenant = request.headers.get("x-tenant") ?? "";
      return tenant in grants ? { id: `${tenant}:analyst`, tenant } : undefined;
    },
    runOptions: ({ principal }) => ({
      ...runOptions(grants[principal?.tenant ?? ""] ?? READ),
      rootDir: scratch,
      ensureRuntime: false,
      model: fauxModel({ priced: true }),
      streamFn: (selected, context) => {
        const user = context.messages.findLast((m) => m.role === "user") as { content: Array<{ text?: string }> };
        inputs.push(user.content.map((p) => p.text ?? "").join(""));
        return scriptedStream([
          { toolCalls: [{ name: "activate_evaluator", args: { evaluatorId: "ev_missing" } }] },
          { text: finding({ status: "unsupported", evidence_queries: [] }) },
        ])(selected, context);
      },
    }),
  });
  const port = await server.listen(0, "127.0.0.1");
  t.after(() => server.close(1_000));
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-tenant": "globex", "content-type": "application/json" };
  assert.equal((await fetch(`${base}/sessions`, { method: "POST", headers, body: JSON.stringify({ sessionId: "s1" }) })).status, 201);
  const sent = await fetch(`${base}/sessions/s1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: "Did my agent get worse this week? Catch it next time.",
      context: { agent: "support-desk", window: { from: "2026-09-01T00:00:00Z", to: "2026-09-05T00:00:00Z" } },
    }),
  });
  assert.equal(sent.status, 202);
  const events = await fetch(`${base}/sessions/s1/events`, { headers: { "x-tenant": "globex" } });
  const reader = events.body!.getReader();
  let frames = "";
  const deadline = Date.now() + 10_000;
  while (!frames.includes('"turn.end"') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    frames += new TextDecoder().decode(value);
  }
  await reader.cancel().catch(() => undefined);
  assert.match(inputs[0]!, /<cave-message-context>\n\{"agent":"support-desk"/);
  assert.match(frames, /"kind":"tool.end","id":"[^"]+","status":"failed","detail":"cave_tool_denied:grant_scope"/,
    "a read-only tenant's activation is denied and the SSE stream says why");
  assert.equal((await fetch(`${base}/sessions/s1`, { headers: { "x-tenant": "acme" } })).status, 404, "another tenant cannot see the session");
});

test("grants parse from the environment and unknown scopes are refused", () => {
  assert.deepEqual([...grantFromEnv("read,write_resource").scopes], ["read", "write_resource"]);
  assert.throws(() => grantFromEnv("deploy"), /unknown grant scope: deploy/);
  const policy = policyFor(READ);
  assert.deepEqual(policy({ runId: "r", agentId: "a", agentPath: [], toolCallId: "t", name: "bash", effect: "external", args: { command: "curl http://x" } }), { deny: "shell_scope" });
  assert.equal(policy({ runId: "r", agentId: "a", agentPath: [], toolCallId: "t", name: "read_file", effect: "read", args: { path: "data/traces.json" } }), undefined);
});

test("bin/caveman is on PATH for bash and is executable", () => {
  assert.ok(existsSync(join(rootDir, "bin", "caveman")));
  assert.ok((process.env.PATH ?? "").split(":").includes(join(rootDir, "bin")));
});
