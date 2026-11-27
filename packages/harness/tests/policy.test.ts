import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { FauxResponseStep, TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, DEFAULT_NUDGES, normalizeLoadout } from "../src/loadout.ts";
import { fauxStep, type FauxStep } from "../src/models.ts";
import { mergeBudgets, type Budgets } from "../src/policy.ts";
import { retryDelayMs, runHarness } from "../src/run.ts";

interface Run {
  result: Awaited<ReturnType<typeof runHarness>>;
  events: Record<string, any>[];
  contexts: TranscriptContext[];
}

async function run(steps: (FauxStep | ((context: TranscriptContext) => FauxStep))[], options: { budgets?: Budgets; patch?: (loadout: Record<string, any>) => void } = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "harness-policy-"));
  const env = new LocalEnv({ cwd: dir });
  const raw = structuredClone(BUILTIN_LOADOUTS["compact-v0"]) as Record<string, any>;
  options.patch?.(raw);
  const contexts: TranscriptContext[] = [];
  const scripted: FauxResponseStep[] = steps.map((step) => (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxStep(typeof step === "function" ? step(context) : step);
  });
  const tracePath = join(dir, "trace.jsonl");
  try {
    const result = await runHarness({
      prompt: "do the task", model: "faux/policy", effort: "high", loadout: normalizeLoadout(raw), env, tracePath, fauxSteps: scripted,
      ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    });
    const events = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { result, events, contexts };
  } finally {
    await env.close();
  }
}

const bash = (command: string): FauxStep => ({ toolCalls: [{ name: "bash", arguments: { command } }] });
const lastToolText = (context: TranscriptContext) => {
  const message = [...context.messages].reverse().find((item) => item.role === "toolResult");
  return message === undefined ? "" : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
};

describe("policy", { concurrency: 4 }, () => {
test("the same call with the same result is nudged at 3 and stopped at 6", async () => {
  const seen: string[] = [];
  const steps = Array.from({ length: 8 }, () => (context: TranscriptContext) => {
    seen.push(lastToolText(context));
    return bash("echo same");
  });
  const { result, events } = await run(steps);
  assert.equal(result.status, "stopped");
  assert.equal(result.stop_reason, "loop_repeat");
  assert.equal(result.tools.calls, 6);
  assert.equal(result.usage.requests, 6);
  const policy = events.filter((event) => event.type === "policy");
  assert.deepEqual(policy.map((event) => `${event.action}:${event.count}`), ["nudge:3", "nudge:4", "nudge:5", "stop:6"]);
  assert.equal(seen[3], `same\n[harness] ${DEFAULT_NUDGES.loop.replace("{count}", "3")}`, "the nudge is appended to the tool result");
  assert.equal(seen[2], "same");
});

test("repeats that return something new are progress, and an edit resets the counts", async () => {
  const counter = Array.from({ length: 7 }, () => bash("echo x >> n.txt; wc -l < n.txt | tr -d ' '"));
  const fresh = await run([...counter, { text: "done" }]);
  assert.equal(fresh.result.status, "finished");
  assert.equal(fresh.result.tools.calls, 7);
  assert.equal(fresh.events.filter((event) => event.type === "policy").length, 0);

  const write = { toolCalls: [{ name: "write", arguments: { path: "f.txt", content: "v" } }] };
  const steps = [bash("echo a"), bash("echo a"), write, bash("echo a"), bash("echo a"), { text: "done" }];
  const reset = await run(steps);
  assert.equal(reset.result.status, "finished");
  assert.equal(reset.events.filter((event) => event.type === "policy").length, 0);
});

test("progress made only through bash resets the counts: checks between bash edits never stop the run", async () => {
  // A new successful command (a heredoc writing the next file) is progress; the same status check in between is not a loop.
  const steps: FauxStep[] = [];
  for (let index = 0; index < 10; index++) {
    steps.push(bash(`cat > step${index}.py <<'EOF'\nprint(${index})\nEOF`), bash("ls nothing-here 2>/dev/null; echo check"));
  }
  const progress = await run([...steps, { text: "done" }]);
  assert.equal(progress.result.status, "finished");
  assert.equal(progress.result.tools.calls, 20);
  assert.equal(progress.events.filter((event) => event.type === "policy").length, 0);
});

test("a cycle of calls that all return the same thing is still a loop: A, B, A, B is nudged and stopped", async () => {
  const cycle = Array.from({ length: 16 }, (_, index) => bash(index % 2 === 0 ? "echo a" : "echo b"));
  const { result, events } = await run(cycle);
  assert.equal(result.stop_reason, "loop_repeat");
  assert.equal(result.tools.calls, 12);
  assert.deepEqual(events.filter((event) => event.type === "policy").map((event) => `${event.action}:${event.count}`),
    ["nudge:3", "nudge:3", "nudge:4", "nudge:4", "nudge:5", "nudge:5", "stop:6"]);

  // A new command that fails is not progress: the same check in between still counts.
  const flailing = Array.from({ length: 16 }, (_, index) => bash(index % 2 === 0 ? `ls missing-${index}` : "echo same"));
  const stuck = await run(flailing);
  assert.equal(stuck.result.stop_reason, "loop_repeat");
  assert.equal(stuck.result.tools.calls, 12);
});

test("request, token and USD budgets stop the run after the turn that crosses them", async () => {
  const many = () => Array.from({ length: 10 }, (_, index) => bash(`echo ${index}`));
  const requests = await run(many(), { budgets: { requests: 2 } });
  assert.equal(requests.result.stop_reason, "budget_requests");
  assert.equal(requests.result.usage.requests, 2);
  assert.equal(requests.result.status, "stopped");

  const tokens = await run(many(), { budgets: { tokens: 1500 } });
  assert.equal(tokens.result.stop_reason, "budget_tokens");
  assert.ok(tokens.result.usage.requests < 10);

  const usd = await run(many(), { budgets: { usd: 0.003 } });
  assert.equal(usd.result.stop_reason, "budget_usd");
  assert.ok(usd.result.cost_usd! >= 0.003);
  const stop = usd.events.find((event) => event.type === "policy" && event.action === "stop");
  assert.equal(stop!.reason, "budget_usd");

  const fromLoadout = await run(many(), { patch: (loadout) => { loadout.policy.budgets = { requests: 3 }; }, budgets: { requests: 5 } });
  assert.equal(fromLoadout.result.usage.requests, 3, "the tighter budget wins");
  assert.deepEqual(mergeBudgets({ usd: 2, requests: 9 }, { usd: 1, wall_s: 5 }), { usd: 1, requests: 9, wall_s: 5 });
});

test("the wall budget is a hard deadline: it aborts a long command", async () => {
  const started = Date.now();
  const { result, events } = await run([bash("sleep 20"), { text: "never" }], { budgets: { wall_s: 0.5 } });
  assert.ok(Date.now() - started < 5000, "stopped near the deadline, not at the command's end");
  assert.equal(result.status, "stopped");
  assert.equal(result.stop_reason, "budget_wall");
  assert.equal(events.at(-1)!.type, "stop");
});

test("empty turns are continued, then stopped after empty_turns_stop in a row", async () => {
  const empty: FauxStep = { text: "" };
  const stopped = await run([empty, empty, empty, { text: "never" }]);
  assert.equal(stopped.result.stop_reason, "empty_turns");
  assert.equal(stopped.result.usage.requests, 3);

  const recovered = await run([empty, (context) => {
    const last = context.messages.at(-1)!;
    assert.equal(last.role, "user");
    return { text: "all done" };
  }]);
  assert.equal(recovered.result.status, "finished");
  assert.equal(recovered.result.usage.requests, 2);
});

test("a response cut at max output tokens is continued, up to length_continuations", async () => {
  const cut: FauxStep = { text: "part one", stopReason: "length" };
  const continued = await run([cut, (context) => {
    const last = context.messages.at(-1)!;
    assert.equal(last.role, "user");
    const content = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    assert.equal(content.map((part) => (part.type === "text" ? part.text : "")).join(""), DEFAULT_NUDGES.length);
    return { text: "part two" };
  }]);
  assert.equal(continued.result.status, "finished");
  assert.deepEqual(continued.events.filter((event) => event.type === "policy").map((event) => event.reason), ["output_cap"]);

  const capped = await run([cut, cut, cut], { patch: (loadout) => { loadout.policy.length_continuations = 2; } });
  assert.equal(capped.result.stop_reason, "output_cap");
  assert.equal(capped.result.usage.requests, 3);
});

test("a provider error the provider will not take back ends the run at once with status error", async () => {
  const { result, events } = await run([{ text: "", stopReason: "error", errorMessage: "400 invalid_request_error: bad tool schema" }, { text: "never" }]);
  assert.equal(result.status, "error");
  assert.equal(result.stop_reason, "provider_error");
  assert.equal(result.error, "400 invalid_request_error: bad tool schema");
  assert.equal(result.usage.requests, 1);
  assert.equal(result.provider_retries, 0);
  assert.equal(events.filter((event) => event.type === "policy").length, 0);
});

const fast = (loadout: Record<string, any>) => { loadout.policy.retry = { attempts: 3, base_ms: 1, max_ms: 50 }; };

test("a transient provider failure re-runs the turn from the same transcript, logged as a retry", async () => {
  const failure: FauxStep = { text: "", stopReason: "error", errorMessage: "server_error: The server had an error while processing your request" };
  const { result, events, contexts } = await run([bash("echo one"), failure, failure, bash("echo two"), { text: "done" }], { patch: fast });
  assert.equal(result.status, "finished");
  assert.equal(result.stop_reason, "done");
  assert.equal(result.provider_retries, 2);
  assert.equal(result.tools.calls, 2);
  assert.equal(result.usage.requests, 5, "failed requests are requests");
  // The retried requests are the failed one again: the failed responses never enter the transcript.
  assert.deepEqual(contexts[2]!.messages, contexts[1]!.messages);
  assert.deepEqual(contexts[3]!.messages, contexts[1]!.messages);
  assert.equal(contexts[4]!.messages.filter((message) => message.role === "assistant").length, 2);
  const retries = events.filter((event) => event.type === "policy" && event.action === "retry");
  assert.deepEqual(retries.map((event) => [event.attempt, event.reason]), [[1, "provider_transient"], [2, "provider_transient"]]);
  assert.match(retries[0]!.error, /server_error/u);
});

test("transient failures past the retry budget end with provider_unavailable, a reason the rig can tell from a refusal", async () => {
  const failure: FauxStep = { text: "", stopReason: "error", errorMessage: "503 overloaded" };
  const { result } = await run([failure, failure, failure, failure, failure], { patch: fast });
  assert.equal(result.status, "error");
  assert.equal(result.stop_reason, "provider_unavailable");
  assert.equal(result.provider_retries, 3);
  assert.equal(result.usage.requests, 4);
  assert.match(result.error!, /503 overloaded \(after 3 retries\)/u);
  // A success in between starts a new streak.
  const mixed = await run([failure, failure, failure, bash("echo ok"), failure, failure, failure, { text: "done" }], { patch: fast });
  assert.equal(mixed.result.status, "finished");
  assert.equal(mixed.result.provider_retries, 6);
});

test("retry delays back off, honor a server-requested delay, and stay under the cap", () => {
  const retry = { attempts: 6, base_ms: 2_000, max_ms: 180_000 };
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((attempt) => retryDelayMs(retry, attempt, "503")), [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 180_000]);
  assert.equal(retryDelayMs(retry, 1, "Server requested 90s retry delay (max: 60s). 429 rate limit"), 90_000);
  assert.equal(retryDelayMs(retry, 1, "Server requested 900s retry delay (max: 60s)."), 180_000);
  assert.equal(retryDelayMs(retry, 2, "rate_limit_exceeded: Please try again in 250ms."), 4_000);
  assert.equal(retryDelayMs(retry, 1, "rate_limit_exceeded: Please try again in 7.5s."), 7_500);
});

test("the wall budget cuts a retry backoff short", async () => {
  const started = Date.now();
  const failure: FauxStep = { text: "", stopReason: "error", errorMessage: "502 bad gateway" };
  const { result } = await run([failure, { text: "never" }], { budgets: { wall_s: 0.3 }, patch: (loadout) => { loadout.policy.retry = { base_ms: 60_000 }; } });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(result.status, "stopped");
  assert.equal(result.stop_reason, "budget_wall");
});
});
