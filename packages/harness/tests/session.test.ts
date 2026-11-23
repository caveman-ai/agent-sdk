/**
 * Sessions (--followups, --on-turn-end): follow-ups are sent one at a time after each turn's final answer, in one
 * conversation (the model sees every earlier turn); the turn-end hook runs after each turn, in order, with that turn's
 * final text, before the next follow-up goes out; result.turns has each turn's requests and cost; a stop ends the session.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { LocalEnv } from "../src/env/local.ts";
import { loadLoadout } from "../src/loadout.ts";
import { fauxStep } from "../src/models.ts";
import { runHarness } from "../src/run.ts";

const userTexts = (context: TranscriptContext) => context.messages.filter((message) => message.role === "user")
  .map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")));

test("a session sends each follow-up after the previous turn's answer and runs the hook between turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-session-"));
  const env = new LocalEnv({ cwd: root });
  const events: string[] = [];
  const seen: string[][] = [];
  try {
    const step = (answer: string) => (context: TranscriptContext) => {
      seen.push(userTexts(context));
      events.push(`model:${answer}`);
      return fauxStep({ text: answer });
    };
    const tool = (context: TranscriptContext) => {
      seen.push(userTexts(context));
      events.push("model:tool");
      return fauxStep({ toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] });
    };
    const trace = join(root, "trace.jsonl");
    const result = await runHarness({
      prompt: "first task", model: "faux/scripted", effort: "high", loadout: loadLoadout("compact-v0"), env, tracePath: trace,
      followups: ["second task", "third task"],
      onTurnEnd: async (turn, text) => { events.push(`hook:${turn}:${text}`); },
      fauxSteps: [step("answer one"), tool, step("answer two"), step("answer three")],
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    assert.deepEqual(events, ["model:answer one", "hook:1:answer one", "model:tool", "model:answer two", "hook:2:answer two", "model:answer three", "hook:3:answer three"]);
    assert.match(seen[1]!.at(-1)!, /second task/u);
    assert.match(seen[1]![0]!, /first task/u, "the follow-up joins the same conversation");
    assert.match(seen[3]!.at(-1)!, /third task/u);
    assert.equal(result.turns?.length, 3);
    assert.deepEqual(result.turns!.map((turn) => turn.requests), [1, 2, 1]);
    assert.equal(result.usage.requests, 4);
    const turnEvents = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.type === "session_turn");
    assert.deepEqual(turnEvents.map((event) => event.n), [1, 2, 3]);
  } finally {
    await env.close();
  }
});

test("without followups there are no turns in the result; a budget stop ends the session early", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-session-"));
  const env = new LocalEnv({ cwd: root });
  try {
    const single = await runHarness({ prompt: "only task", model: "faux/scripted", effort: "high", loadout: loadLoadout("compact-v0"), env, fauxSteps: [() => fauxStep({ text: "done" })] });
    assert.equal(single.turns, undefined);
    const hooks: number[] = [];
    const stopped = await runHarness({
      prompt: "first", model: "faux/scripted", effort: "high", loadout: loadLoadout("compact-v0"), env, budgets: { requests: 1 },
      followups: ["second", "third"], onTurnEnd: async (turn) => { hooks.push(turn); },
      fauxSteps: [() => fauxStep({ text: "one" }), () => fauxStep({ text: "two" }), () => fauxStep({ text: "three" })],
    });
    assert.equal(stopped.usage.requests, 1, JSON.stringify(stopped));
    assert.deepEqual(hooks, [1], "the hook runs for the turn that ran; no later turn starts");
  } finally {
    await env.close();
  }
});
