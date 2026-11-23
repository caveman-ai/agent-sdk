/**
 * W1 through the bench rig: the harness's WebSocket transport against the TB4
 * metering proxy (proxy.mjs, with its Responses relay ws-relay.mjs) in front of
 * the loopback fake (tests/ws-loopback.ts). The rig files are imported
 * read-only from HARNESS_TB4_RIG (default: the v3 rig checkout); without them
 * the test is skipped. Checks that the relay carries the run 1:1 with the real
 * key, and meters one ledger row per response: the prewarm as generate:false,
 * every request after it as an incremental WebSocket create. Offline.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { LocalEnv } from "../src/env/local.ts";
import { readLoadout } from "../src/loadout.ts";
import { runHarness } from "../src/run.ts";
import { EXEC_SCENARIO } from "./openai-loopback.ts";
import { startFakeResponses } from "./ws-loopback.ts";

const RIG = process.env.HARNESS_TB4_RIG ?? "";
const present = Boolean(RIG) && ["proxy.mjs", "ws-relay.mjs", "prices.json"].every((file) => existsSync(join(RIG, file)));
const TOKEN = "tok_harness_ws_relay_0001";

test("exec-v0-ws through the rig's proxy and ws-relay: one relayed socket, the real key upstream, a ledger row per response", { skip: present ? false : `rig not found at ${RIG}` }, async () => {
  const { startProxy } = await import(pathToFileURL(join(RIG, "proxy.mjs")).href) as { startProxy: (options: Record<string, unknown>) => Promise<import("node:http").Server> };
  const prices = JSON.parse(readFileSync(join(RIG, "prices.json"), "utf8")) as unknown;
  const root = mkdtempSync(join(tmpdir(), "harness-ws-relay-"));
  mkdirSync(join(root, "bench", "registry"), { recursive: true });
  writeFileSync(join(root, "bench", "registry", `${TOKEN}.json`), JSON.stringify({
    key: "wsr/harness/t/0/a0", tag: "wsr", arm: "exec-v0-ws", task: "t", trial: 0, model: "gpt-6.1-sol", effort: "high",
  }));
  const upstream = await startFakeResponses(EXEC_SCENARIO);
  const proxy = await startProxy({ root, port: 0, cap: 100, key: "sk-real", prices, upstream: upstream.url.replace(/\/v1$/u, "") });
  const port = (proxy.address() as { port: number }).port;
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-ws-relay-cwd-")));
  const env = new LocalEnv({ cwd });
  const tracePath = join(root, "trace.jsonl");
  process.env.HARNESS_WS_RELAY_TOKEN = TOKEN;
  try {
    const result = await runHarness({
      prompt: "Make check.sh pass.", model: "openai/gpt-6.1-sol", effort: "high", loadout: readLoadout(join(import.meta.dirname, "..", "loadouts", "exec-v0-ws.json")).loadout,
      env, tracePath, modelOptions: { openaiBaseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "HARNESS_WS_RELAY_TOKEN" },
    });
    assert.equal(result.status, "finished", result.error ?? "");
    assert.deepEqual(upstream.transports, EXEC_SCENARIO.map(() => "ws"), "every request reached the provider over the relayed socket");
    assert.equal(upstream.connections, 1);
    assert.equal(upstream.handshakes[0]!.authorization, "Bearer sk-real", "the proxy swapped the trial token for the real key");
    assert.match(String(upstream.handshakes[0]!["openai-beta"]), /responses_websockets=2026-02-06/u);
    assert.equal(result.transport!.incremental, EXEC_SCENARIO.length);
    assert.equal(result.transport!.fallback, null);
    const rows = readFileSync(join(root, "spend.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(rows.length, EXEC_SCENARIO.length + 1, "the prewarm and each request");
    assert.ok(rows.every((row) => row.transport === "ws" && row.trial_key === "wsr/harness/t/0/a0" && row.req_effort === "high" && row.http_status === 200));
    assert.deepEqual(rows.map((row) => row.generate === false), [true, ...EXEC_SCENARIO.map(() => false)]);
    assert.deepEqual(rows.slice(1).map((row) => row.incremental), EXEC_SCENARIO.map(() => true));
    assert.deepEqual(rows.slice(1).map((row) => row.response_id), EXEC_SCENARIO.map((_, index) => `resp_${index + 1}`));
    assert.equal(new Set(rows.map((row) => row.conn_id)).size, 1, "one relayed connection");
    const traced = readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>).filter((event) => event.type === "request_end");
    assert.deepEqual(rows.slice(1).map((row) => [row.input_total, row.cached_input, row.output]), traced.map((event) => [event.usage.input + event.usage.cache_read, event.usage.cache_read, event.usage.output]),
      "the ledger and the trace agree per response");
  } finally {
    proxy.closeAllConnections?.();
    proxy.close();
    await upstream.close();
    await env.close();
  }
});
