// A stdio MCP server's environment: the host's allowlisted variables and its own config's env, never the harness
// process's whole environment (a provider key, a Cloud credential: plugins get no ambient secrets).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { connectMcp } from "../src/mcp.ts";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-env.mjs", import.meta.url));

test("a stdio MCP server gets PATH and its own env, never the harness's secrets", async () => {
  process.env.HARNESS_TEST_SECRET = "sk-ambient-secret-not-for-plugins";
  try {
    const session = await connectMcp({ env: { command: process.execPath, args: [SERVER], env: { SERVER_OWN: "configured" } } });
    try {
      const envOf = session.tools.find((tool) => tool.name === "env_of")!;
      const value = async (name: string) => (await envOf.call({ name })).text;
      assert.equal(await value("HARNESS_TEST_SECRET"), "(unset)");
      assert.equal(await value("SERVER_OWN"), "configured");
      assert.equal(await value("PATH"), process.env.PATH);
      assert.equal(await value("HOME"), process.env.HOME);
    } finally {
      await session.close();
    }
  } finally {
    delete process.env.HARNESS_TEST_SECRET;
  }
});
