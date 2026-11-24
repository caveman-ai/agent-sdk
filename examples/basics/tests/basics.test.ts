import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HarnessModel, HarnessStreamFn } from "../../../packages/agent/dist/harness.js";
import { runHelloBilling } from "../01-hello-agent.ts";
import { runGatedRefund } from "../02-tools-and-gates.ts";
import { runHarnessSession } from "../03-harness-v4-session.ts";
import { buildTriageArtifact } from "../04-deterministic-build.ts";
import { gradeSupportRun } from "../05-evals-and-graders.ts";

const FAKE_MODEL: HarnessModel = {
  id: "claude-sonnet-4-6",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

interface ScriptTurn {
  text?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
}

function scriptedStream(turns: ScriptTurn[]): HarnessStreamFn {
  let index = 0;
  return () => {
    const turn = turns[index++];
    assert.ok(turn, `unexpected provider call #${index}`);
    const content = turn.toolCall
      ? [{ type: "toolCall" as const, id: `tc_${index}`, name: turn.toolCall.name, arguments: turn.toolCall.arguments }]
      : [{ type: "text" as const, text: turn.text ?? "" }];
    const stopReason = turn.toolCall ? "toolUse" : "stop";
    const msg = {
      role: "assistant",
      api: FAKE_MODEL.api,
      provider: FAKE_MODEL.provider,
      model: FAKE_MODEL.id,
      content,
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.0003, output: 0.0003, cacheRead: 0, cacheWrite: 0, total: 0.0006 } },
      stopReason,
      timestamp: Date.now(),
    };
    const events = [
      { type: "start", partial: msg },
      ...(turn.toolCall
        ? [{ type: "toolcall_start", contentIndex: 0, partial: msg }, { type: "toolcall_end", contentIndex: 0, toolCall: content[0], partial: msg }]
        : [{ type: "text_delta", contentIndex: 0, delta: turn.text ?? "", partial: msg }]),
      { type: "done", reason: stopReason, message: msg },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev;
      },
      result: async () => msg,
    };
  };
}

test("01-hello-agent runs defineAgent + tool() in-process on Harness v4", async () => {
  const res = await runHelloBilling("Check invoice 4411", {
    model: FAKE_MODEL,
    stream: scriptedStream([
      { toolCall: { name: "lookup_invoice", arguments: { id: "4411" } } },
      { text: "Invoice 4411 is paid ($42)." },
    ]),
  });
  assert.equal(res.stop_reason, "end_turn");
  assert.equal(res.loadout, "app-general");
  assert.match(res.text, /4411/);
});

test("02-tools-and-gates enforces Caveman Gate approve and deny fail-closed", async () => {
  const approved = await runGatedRefund(
    "Refund $42 on 4411",
    () => true,
    {
      model: FAKE_MODEL,
      stream: scriptedStream([
        { toolCall: { name: "issue_refund", arguments: { id: "4411", amountUsd: 42 } } },
        { text: "Refunded $42 on invoice 4411." },
      ]),
    },
  );
  assert.deepEqual(approved.executed, [{ id: "4411", amountUsd: 42 }]);

  const denied = await runGatedRefund(
    "Refund $500 on 4411",
    () => false,
    {
      model: FAKE_MODEL,
      stream: scriptedStream([
        { toolCall: { name: "issue_refund", arguments: { id: "4411", amountUsd: 500 } } },
        { text: "Refund was denied by policy." },
      ]),
    },
  );
  assert.deepEqual(denied.executed, []);
});

test("03-harness-v4-session runs HarnessSession with appLoadoutFor, LocalEnv, and toHarnessTool", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "caveman-basics-harness-")));
  try {
    const { loadout, surface, outcome } = await runHarnessSession("Inspect directory", {
      cwd,
      model: FAKE_MODEL,
      stream: scriptedStream([
        { toolCall: { name: "bash", arguments: { command: "echo harness-v4-ok" } } },
        { toolCall: { name: "record_finding", arguments: { note: "harness-v4-ok observed" } } },
        { text: "Workspace inspected and finding recorded." },
      ]),
    });
    assert.equal(loadout, "app-claude");
    assert.equal(surface, "compact");
    assert.equal(outcome.status, "finished");
    assert.equal(outcome.usage.requests, 3);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("04-deterministic-build compiles byte-stable AGENT.md and SHA-256 digest", () => {
  const first = buildTriageArtifact();
  const second = buildTriageArtifact();
  assert.equal(first.compiled.digest, second.compiled.digest);
  assert.equal(first.markdown, second.markdown);
  assert.match(first.markdown, /name: "order-triage"/);
  assert.match(first.markdown, /support-ticket-opened/);
});

test("05-evals-and-graders grades text, tool calls, arguments, and cost threshold", async () => {
  const pass = await gradeSupportRun({
    text: "Invoice 4411 is paid ($42).",
    tool_calls: [{ name: "lookup_invoice", arguments: { id: "4411" } }],
    cost_usd: 0.0012,
  });
  assert.equal(pass.allPassed, true);

  const fail = await gradeSupportRun({
    text: "Invoice 4411 is paid ($42).",
    tool_calls: [{ name: "lookup_invoice", arguments: { id: "4411" } }],
    cost_usd: 0.50,
  });
  assert.equal(fail.allPassed, false);
});
