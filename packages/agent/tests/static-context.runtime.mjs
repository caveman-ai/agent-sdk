import assert from "node:assert/strict";
import test from "node:test";
import {
  agent,
  agentStaticContextDiagnostics,
  context,
  schema,
  tool,
} from "../dist/index.js";

test("static context diagnostics use canonical prompt and active tool schemas", async () => {
  const definition = agent({
    id: "static-context-test",
    instructions: "Keep answer short.",
    model: "openai/gpt-5.4",
    contexts: [context({ id: "rules", kind: "instruction", source: "Read first.", stability: "build" })],
    tools: [tool({
      name: "lookup",
      description: "Look up one value.",
      input: schema.object({ key: schema.string() }),
      effect: "read",
      result: "inline",
      execute: async ({ key }) => key,
    })],
    sandbox: "fixture",
  });

  const diagnostics = await agentStaticContextDiagnostics(definition);
  assert.equal(diagnostics.availableToolCount, 1);
  assert.equal(diagnostics.basis, "system_prompt_plus_active_tool_definitions_json_utf8");
  assert.equal(diagnostics.staticContextBytes > 0, true);
});
