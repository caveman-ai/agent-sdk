import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Eval, exactMatch, contains, toolCalled, traced, wrapOpenAI, wrapVercelAI, wrapAgent } from "../dist/index.js";

test("Eval() runs locally with wrapOpenAI, traced(), multi-trial pass^k, and CI threshold", async () => {
  const fakeOpenAI = wrapOpenAI({
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: "refund $12 processed" } }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        }),
      },
    },
  });

  const dir = mkdtempSync(join(tmpdir(), "caveman-eval-"));
  const res = await Eval("support-ts", {
    data: [
      { item_key: "case-1", input: { orderId: "o1" }, expected: "refund $12 processed" },
      { item_key: "case-2", input: { orderId: "o2" }, expected: "refund $12 processed" },
    ],
    task: async (input) => {
      const order = await traced("lookup_order", async () => ({ id: input.orderId, total: 12 }), { input });
      const completion = await fakeOpenAI.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: `Refund $${order.total}` }],
      });
      return completion.choices[0].message.content;
    },
    scorers: [exactMatch(), contains(["$12"]), toolCalled(["lookup_order"])],
    trials: 2,
    concurrency: 2,
    localCachePath: join(dir, "last-run.json"),
    ci: { failUnder: 0.9 },
  });

  assert.equal(res.results.length, 4);
  assert.equal(res.passedCI, true);
  assert.equal(res.summary.scores.exact_match.mean, 1);
  assert.equal(res.summary.scores.tool_called.pass_pow_k, 1);
  assert.equal(res.results[0].metrics.input_tokens, 30);
  assert.deepEqual(res.results[0].spans.map((s) => s.kind).sort(), ["llm", "tool"]);
});

test("wrapVercelAI and wrapAgent capture nested llm, tool, and streamed agent spans", async () => {
  const generateText = wrapVercelAI(async (opts) => ({
    text: `answer for ${opts.prompt}`,
    usage: { inputTokens: 18, outputTokens: 9 },
    toolCalls: [{ toolName: "fetch_docs", args: { q: opts.prompt } }],
  }));

  const runAgent = wrapAgent("support_agent", async (prompt) => {
    const out = await generateText({ model: { modelId: "claude-sonnet-4-5" }, prompt });
    return out.text;
  });

  const dir = mkdtempSync(join(tmpdir(), "caveman-eval-agent-"));
  const res = await Eval("agent-ts", {
    data: [{ item_key: "a1", input: "refund", expected: "answer for refund" }],
    task: (input) => runAgent(input),
    scorers: [exactMatch(), toolCalled(["fetch_docs"])],
    localCachePath: join(dir, "last-run.json"),
  });

  assert.equal(res.summary.scores.exact_match.mean, 1);
  assert.equal(res.summary.scores.tool_called.mean, 1);
  assert.equal(res.results[0].metrics.input_tokens, 18);
  assert.deepEqual(res.results[0].spans.map((s) => s.kind).sort(), ["agent", "llm", "tool"]);
});
