/**
 * The library as a host loads it: dist/lib.mjs (scripts/bundle.mjs), not the sources. A turn on a reasoning model at
 * an effort runs pi-ai's level clamping and module constants from inside the bundle, which the source tests cannot see
 * (the bundle once shipped with pi-ai's models module never initialized).
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxStep, resolveModel } from "../src/models.ts";

test("the bundled library runs a turn with a tool call on a reasoning model at high effort", async () => {
  const lib = await import("../dist/lib.mjs") as typeof import("../src/lib.ts");
  const resolved = resolveModel("faux/bundle", {}, [
    () => fauxStep({ toolCalls: [{ name: "bash", arguments: { command: "echo bundled" } }] }),
    () => fauxStep({ text: "done" }),
  ]);
  assert.equal(resolved.model.reasoning, true);
  const env = new lib.LocalEnv({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "harness-bundle-"))) });
  const session = new lib.HarnessSession({
    model: resolved.model, stream: (model, context, options) => resolved.models.streamSimple(model, context, { ...options, apiKey: "faux" }),
    effort: "high", loadout: lib.appLoadoutFor({ api: "anthropic-messages", id: "claude-opus-5-5" }), env,
  });
  try {
    const outcome = await session.runTurn("run it");
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.equal(outcome.finalText, "done");
    assert.equal(outcome.usage.requests, 2);
  } finally {
    await session.close();
  }
});

test("the bundled library: app-general runs a turn on a host tool alone, and LocalEnv knows Windows", async () => {
  const lib = await import("../dist/lib.mjs") as typeof import("../src/lib.ts");
  assert.equal(lib.APP_GENERAL_LOADOUT.name, "app-general");
  const { general } = lib.appLoadouts();
  const looked: unknown[] = [];
  let toolNames: string[] = [];
  const resolved = resolveModel("faux/bundle-general", {}, [
    (context) => {
      toolNames = ((context.messages[0] as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map((tool) => tool.name);
      return fauxStep({ toolCalls: [{ name: "note", arguments: { text: "hi" } }] });
    },
    () => fauxStep({ text: "noted" }),
  ]);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-bundle-")));
  const session = new lib.HarnessSession({
    model: resolved.model, stream: (model, context, options) => resolved.models.streamSimple(model, context, { ...options, apiKey: "faux" }),
    effort: "high", loadout: general, env: new lib.LocalEnv({ cwd }), instructions: "You keep notes.",
    tools: [{
      name: "note", label: "Note", description: "Keep a note.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } as never,
      execute: async (_id: string, params: unknown) => (looked.push(params), { content: [{ type: "text" as const, text: "ok" }], details: {} }),
    }],
  });
  try {
    const outcome = await session.runTurn("note hi");
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.equal(outcome.finalText, "noted");
    assert.deepEqual(toolNames, ["note"]);
    assert.deepEqual(looked, [{ text: "hi" }]);
  } finally {
    await session.close();
  }
  if (process.platform !== "win32") {
    const windows = new lib.LocalEnv({ cwd, platform: "win32" });
    assert.match(windows.shellNote ?? "", /no bash was found/u);
    assert.equal((await windows.exec("true")).exitCode, 127);
    await windows.close();
    assert.equal(new lib.LocalEnv({ cwd }).shellNote, undefined);
  }
});
