import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  fauxAssistantMessage as upstreamFauxAssistantMessage,
  fauxProvider as upstreamFauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAssistantMessageEventStream,
  createModels,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  CODING_RUN_BREAKERS,
  CODING_TOOL_OUTPUT_CAPS,
  OBSERVE_ONLY_BANNER,
  RECOVERABLE_CODING_TRANSFORMS,
  classifyTurnFailure,
  codingModelsAtProviderBaseURL,
  createCommandSessionRuntime,
  createCodingAgent,
  defaultCodingPlan,
  formatRecoveryProof,
  formatSessionBill,
  formatTurnBill,
  proveRecovery,
  runCodingSession,
  runCodingTurn,
  sessionBill,
  startCodingSession,
  summarizeCodingTaskAttempts,
} from "../dist/code.js";

// `ensureRuntime: false` no longer means "assume the loopback runtime is up":
// the route is only claimed after something answers /healthz.
const healthzOnly = async (url) => String(url).endsWith("/healthz")
  ? new Response("ok")
  : new Response(null, { status: 404 });

test("explicit provider base URL rewrites every model in one provider only", () => {
  const models = codingModelsAtProviderBaseURL(
    "openai/gpt-5.6-terra",
    "http://127.0.0.1:9417/openai/v1/",
  );
  assert.equal(models.getModel("openai", "gpt-5.6-terra").baseUrl, "http://127.0.0.1:9417/openai/v1");
  assert.equal(models.getModel("openai", "gpt-5.6-sol").baseUrl, "http://127.0.0.1:9417/openai/v1");
  assert.notEqual(models.getModel("anthropic", "claude-haiku-4-5").baseUrl, "http://127.0.0.1:9417/openai/v1");
  assert.throws(
    () => codingModelsAtProviderBaseURL("openai/gpt-5.6-terra", "file:///tmp/provider"),
    /coding_provider_base_url_invalid/,
  );
});

const FAKE_ENGINE = resolve(import.meta.dirname, "fixtures/fake-engine.mjs");

function fauxAnthropic() {
  return fauxNamedProvider("anthropic");
}

function fauxNamedProvider(provider) {
  const handle = upstreamFauxProvider({ provider });
  const streamSimple = handle.provider.streamSimple.bind(handle.provider);
  return {
    ...handle,
    provider: {
      ...handle.provider,
      streamSimple: (...args) => withReportedReasoning(streamSimple(...args)),
    },
  };
}

function withReportedReasoning(source) {
  const output = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    for await (const event of source) {
      const partial = event.partial === undefined
        ? {}
        : { partial: zeroReasoning(event.partial) };
      if (event.type === "done") {
        output.push({ ...event, ...partial, message: zeroReasoning(event.message) });
      } else if (event.type === "error") {
        output.push({ ...event, ...partial, error: zeroReasoning(event.error) });
      } else {
        output.push({ ...event, ...partial });
      }
    }
  });
  return output;
}

function zeroReasoning(message) {
  return { ...message, usage: { ...message.usage, reasoning: 0 } };
}

function fauxAssistantMessage(...args) {
  const message = upstreamFauxAssistantMessage(...args);
  return { ...message, usage: { ...message.usage, reasoning: message.usage.reasoning ?? 0 } };
}

function payloadStreamFn(faux, seen = []) {
  return (selected, context, options) => {
    seen.push(structuredClone(context.messages));
    options.onPayload({
      system: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map((item) => ({
        name: item.name,
        description: item.description,
        input_schema: item.parameters,
      })),
      messages: context.messages.filter((message) => message.role !== "system"),
    }, selected);
    return faux.provider.streamSimple(selected, context, { ...options, onPayload: undefined });
  };
}

function payloadModels(faux, seen = []) {
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    streamSimple(selected, context, options) {
      seen.push(structuredClone(context.messages));
      options.onPayload({
        system: getCurrentSystemPrompt(context.messages),
        tools: getCurrentTools(context.messages).map((item) => ({
          name: item.name,
          description: item.description,
          input_schema: item.parameters,
        })),
        messages: context.messages.filter((message) => message.role !== "system"),
      }, selected);
      return faux.provider.streamSimple(selected, context, { ...options, onPayload: undefined });
    },
  });
  return models;
}

async function withWorkspace(body) {
  const workspace = await mkdtemp(resolve(tmpdir(), "caveman-code-ws-"));
  const store = await mkdtemp(resolve(tmpdir(), "caveman-code-engine-"));
  const previous = process.env.CAVE_FAKE_ENGINE_STORE;
  process.env.CAVE_FAKE_ENGINE_STORE = store;
  try {
    return await body(workspace);
  } finally {
    if (previous === undefined) delete process.env.CAVE_FAKE_ENGINE_STORE;
    else process.env.CAVE_FAKE_ENGINE_STORE = previous;
    await rm(workspace, { recursive: true, force: true });
    await rm(store, { recursive: true, force: true });
  }
}

test("default coding plan routes only recoverable transforms over the live zone", () => {
  const plan = defaultCodingPlan("anthropic/claude-sonnet-4-6", "caveman-code");
  const kinds = plan.segment_routes.map((route) => route.segment_kind).sort();
  assert.deepEqual(kinds, ["history", "tool_result"]);
  for (const route of plan.segment_routes) {
    assert.equal(
      RECOVERABLE_CODING_TRANSFORMS.includes(route.transform_id),
      true,
      `${route.transform_id} is not a recoverable coding transform`,
    );
    assert.equal(route.fallback, "original");
    assert.equal(route.transform_id.includes("toon"), false);
    assert.equal(route.transform_id.includes("pixel"), false);
    assert.equal(route.segment_id, undefined, "an unqualified route per kind avoids ambiguity");
  }
  // One route per dynamic kind: two routes matching one runtime segment collapse
  // into dynamic_route_ambiguous and the segment silently passes through.
  assert.equal(new Set(kinds).size, kinds.length);
  assert.deepEqual(plan.recovery.tools, ["cave_retrieve"]);
  assert.equal(plan.reasoning, "none");
  // 1 + ceil(reserve / 256) model calls per turn.
  assert.equal(1 + Math.ceil(plan.budgets.retry_cascade_reserve / 256), 64);
  assert.equal(plan.budgets.history >= 1_000_000, true);
  assert.equal(plan.budgets.results_artifacts >= 1_000_000, true);
});

test("created coding agent is host sandboxed, unlocked, and capped before compression", () => {
  const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
  assert.equal(codingAgent.definition.sandbox, "host");
  assert.equal(codingAgent.definition.reasoning, "off");
  assert.deepEqual(
    codingAgent.definition.tools.map((item) => item.name).sort(),
    ["bash", "edit_file", "grep", "read_file", "read_tool_output", "write_file"],
  );
  assert.deepEqual(
    codingAgent.definition.tools.map((item) => [item.name, item.effect]).sort(),
    [
      ["bash", "external"],
      ["edit_file", "write"],
      ["grep", "read"],
      ["read_file", "read"],
      ["read_tool_output", "read"],
      ["write_file", "write"],
    ],
  );
  // Every cap sits under the runtime's 32 KiB inline tool-result ceiling so an
  // observe-only session with no engine present still works.
  for (const [name, cap] of Object.entries(CODING_TOOL_OUTPUT_CAPS)) {
    assert.equal(cap < 32_768, true, `${name} cap must stay under the inline ceiling`);
  }
  assert.equal(codingAgent.plan.model, "anthropic/faux-1");
  assert.deepEqual(CODING_RUN_BREAKERS, {
    repeatedToolCalls: 3,
    repeatedToolCallWindowTurns: 8,
    noProgressTurns: 3,
    maxToolCallsPerTurn: 8,
  });
});

test("coding sessions request long provider cache retention by default", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const session = await startCodingSession(codingAgent, { cave: "off" });
    const faux = fauxAnthropic();
    const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
    const seen = [];
    faux.setResponses([fauxAssistantMessage("done")]);
    await runCodingTurn(session, "inspect repository", {
      model,
      streamFn(selected, context, options) {
        seen.push(options.cacheRetention);
        return faux.provider.streamSimple(selected, context, options);
      },
    });
    assert.deepEqual(seen, ["long"]);
  });
});

test("Pebble v1 coding surface exposes only read, shell, write, and edit", async () => {
  const codingAgent = createCodingAgent({
    workspace: tmpdir(),
    model: "anthropic/faux-1",
    toolSet: "pebble-v1",
    outputCaps: { bash: 128 },
  });
  assert.deepEqual(
    codingAgent.definition.tools.map((item) => item.name),
    ["read_file", "bash", "write_file", "edit_file"],
  );
  assert.doesNotMatch(codingAgent.definition.instructions, /read_tool_output|grep searches/);
  const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
  const output = await bash.execute({ command: "printf '%0400d' 0" });
  assert.match(output, /resume retained output with bash/);
  assert.doesNotMatch(output, /use read_tool_output/);
  assert.throws(
    () => createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1", toolSet: "unknown" }),
    /coding_tool_set_invalid:unknown/,
  );
});

test("Pebble v1 recovers capped foreground shell output without rerunning", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({
      workspace,
      model: "anthropic/faux-1",
      toolSet: "pebble-v1",
      outputCaps: { bash: 1_200 },
    });
    const expected = "0123456789".repeat(300);
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const output = await bash.execute({
        command:
          "node -e 'const fs=require(\"node:fs\");" +
          "fs.appendFileSync(\"runs.txt\",\"x\");" +
          "process.stdout.write(\"0123456789\".repeat(300))'",
      });
      const recovery = output.match(
        /bash\(\{"sessionId":"(cmd_[a-f0-9]{32})","action":"read","cursor":(\d+)\}\)/,
      );
      assert.equal(recovery !== null, true);
      const sessionId = recovery?.[1];
      let cursor = Number(recovery?.[2]);
      let recovered = "";
      while (cursor < Buffer.byteLength(expected)) {
        const page = await bash.execute({ sessionId, action: "read", cursor });
        assert.doesNotMatch(page, /output capped/);
        const range = page.match(/bytes (\d+)-(\d+) of (\d+)/);
        assert.equal(range !== null, true);
        assert.equal(Number(range?.[1]), cursor);
        recovered += page.split("\n")[2] ?? "";
        cursor = Number(range?.[2]);
      }
      assert.equal(recovered, expected);
      assert.equal(await readFile(resolve(workspace, "runs.txt"), "utf8"), "x");
    } finally {
      await codingAgent.close();
    }
  });
});

test("cold machine starts observe-only and says so loudly", async () => {
  const previous = process.env.CAVEMAN_CLI_BIN;
  process.env.CAVEMAN_CLI_BIN = resolve(tmpdir(), "caveman-absent-cli-binary");
  try {
    const codingAgent = createCodingAgent({ workspace: tmpdir(), model: "anthropic/faux-1" });
    const notices = [];
    const session = await startCodingSession(codingAgent, {
      fetch: async () => { throw new Error("gateway unreachable"); },
      onNotice: (line) => notices.push(line),
    });
    assert.equal(session.mode, "observe-only");
    assert.deepEqual(notices, [OBSERVE_ONLY_BANNER]);
    assert.deepEqual(session.notices, [OBSERVE_ONLY_BANNER]);
    assert.match(OBSERVE_ONLY_BANNER, /caveman start/);
    assert.match(OBSERVE_ONLY_BANNER, /OBSERVE-ONLY/);
  } finally {
    if (previous === undefined) delete process.env.CAVEMAN_CLI_BIN;
    else process.env.CAVEMAN_CLI_BIN = previous;
  }
});

test("only a gateway-required plan failure earns the observe-only retry", () => {
  assert.equal(
    classifyTurnFailure(new Error("cave_gateway_required_for_locked_plan: no runtime")),
    "degrade_to_observe_only",
  );
  assert.equal(classifyTurnFailure(new Error("cave_output_schema_mismatch")), "fatal");
  assert.equal(classifyTurnFailure("cave_tool_call_budget_exceeded"), "fatal");
});

test("a provider the gateway does not proxy is third-party traffic, not optimized", async () => {
  const previousKey = process.env.CAVE_API_KEY;
  process.env.CAVE_API_KEY = "cave_live_testkey_must_never_leave_the_gateway";
  try {
    await withWorkspace(async (workspace) => {
      // The session is told the caller manages the runtime, so routing is "on".
      // The model's provider is not one of the three the gateway proxies, so
      // this request goes straight to xAI — with none of Caveman's headers.
      const codingAgent = createCodingAgent({ workspace, model: "xai/faux-1" });
      const session = await startCodingSession(codingAgent, {
        ensureRuntime: false,
        engineBin: FAKE_ENGINE,
        fetch: healthzOnly,
      });
      assert.equal(session.mode, "optimized");
      const faux = fauxNamedProvider("xai");
      faux.setResponses([fauxAssistantMessage("answered by the provider itself")]);
      const native = faux.getModel().baseUrl;
      const sent = [];
      const turn = await runCodingTurn(session, "who answers this?", {
        model: faux.getModel(),
        streamFn: (selected, context, options) => {
          sent.push({ baseUrl: selected.baseUrl, headers: { ...options.headers } });
          return faux.provider.streamSimple(selected, context, options);
        },
      });
      assert.equal(turn.text, "answered by the provider itself");
      assert.equal(sent.length, 1);
      // The account key is a credential and the rest are account-linked
      // identifiers; a third party receives neither.
      assert.equal(sent[0].headers["x-cave-api-key"], undefined);
      assert.deepEqual(Object.keys(sent[0].headers).filter((name) => name.startsWith("x-cave-")), []);
      assert.equal(sent[0].baseUrl, native);
      // Nothing the gateway did not see may be called optimized.
      assert.equal(turn.bill.mode, "observe-only");
      assert.deepEqual(turn.bill.transformIDs, []);
      assert.equal(turn.degraded, false);
      assert.equal(session.mode, "optimized");
      assert.deepEqual(session.notices, []);
    });
  } finally {
    if (previousKey === undefined) delete process.env.CAVE_API_KEY;
    else process.env.CAVE_API_KEY = previousKey;
  }
});

test("a routed provider still reaches the gateway with its telemetry", async () => {
  const previousKey = process.env.CAVE_API_KEY;
  process.env.CAVE_API_KEY = "cave_live_testkey_for_the_gateway";
  try {
    await withWorkspace(async (workspace) => {
      const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
      const session = await startCodingSession(codingAgent, {
        ensureRuntime: false,
        engineBin: FAKE_ENGINE,
        fetch: healthzOnly,
        gatewayURL: "http://127.0.0.1:8787",
      });
      const faux = fauxAnthropic();
      faux.setResponses([fauxAssistantMessage("answered through the gateway")]);
      const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
      const sent = [];
      const turn = await runCodingTurn(session, "who answers this?", {
        model,
        streamFn: (selected, context, options) => {
          sent.push({ baseUrl: selected.baseUrl, headers: { ...options.headers } });
          return faux.provider.streamSimple(selected, context, options);
        },
      });
      assert.equal(sent[0].baseUrl, "http://127.0.0.1:8787/anthropic");
      assert.equal(sent[0].headers["x-cave-api-key"], "cave_live_testkey_for_the_gateway");
      assert.equal(sent[0].headers["x-cave-agent"], "caveman-code");
      // Routed and metered by the gateway, but the turn itself came from the
      // caller's streamFn, so the receipt does not claim it was optimized.
      assert.equal(turn.bill.mode, "observe-only");
      assert.deepEqual(turn.bill.transformIDs, []);
      assert.equal(session.mode, "optimized");
    });
  } finally {
    if (previousKey === undefined) delete process.env.CAVE_API_KEY;
    else process.env.CAVE_API_KEY = previousKey;
  }
});

test("a session tries to start the runtime once, however many turns it runs", async () => {
  const previousCLI = process.env.CAVEMAN_CLI_BIN;
  const directory = await mkdtemp(resolve(tmpdir(), "caveman-code-cli-"));
  const log = resolve(directory, "spawns.log");
  const cli = resolve(directory, "caveman");
  // Logs the attempt and fails, which is what a machine without a working
  // runtime does. Before the session pinned its route, every turn paid this
  // again — and paid the full ten-second readiness wait when the spawn hung.
  await writeFile(
    cli,
    `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
process.exit(1);
`,
    { mode: 0o755 },
  );
  process.env.CAVEMAN_CLI_BIN = cli;
  try {
    await withWorkspace(async (workspace) => {
      const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
      const session = await startCodingSession(codingAgent, {
        engineBin: FAKE_ENGINE,
        fetch: async () => { throw new Error("gateway unreachable"); },
      });
      assert.equal(session.mode, "observe-only");
      const faux = fauxAnthropic();
      const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
      const startedAt = performance.now();
      for (const line of ["first turn", "second turn", "third turn"]) {
        faux.setResponses([fauxAssistantMessage(`answered ${line}`)]);
        const turn = await runCodingTurn(session, line, {
          model,
          streamFn: payloadStreamFn(faux),
          providerPayloadContract: "pi-on-payload-v1",
        });
        assert.equal(turn.bill.mode, "observe-only");
      }
      assert.equal(performance.now() - startedAt < 1_000, true, "turns must not re-probe the runtime");
      const attempts = (await readFile(log, "utf8")).trim().split("\n");
      assert.deepEqual(attempts, ["start"]);
      // The banner is the session's, not one per turn.
      assert.deepEqual(session.notices, [OBSERVE_ONLY_BANNER]);
    });
  } finally {
    if (previousCLI === undefined) delete process.env.CAVEMAN_CLI_BIN;
    else process.env.CAVEMAN_CLI_BIN = previousCLI;
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller run overrides cannot forge build identity, plan, or route", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const session = await startCodingSession(codingAgent, {
      ensureRuntime: false,
      engineBin: FAKE_ENGINE,
    });
    const forged = [
      { lockedBuild: { build_sha256: "0".repeat(64), plan_sha256: "0".repeat(64) } },
      { candidatePlan: defaultCodingPlan("anthropic/faux-1", "forged") },
      { caveRoute: { useGateway: true } },
    ];
    for (const overrides of forged) {
      await assert.rejects(
        () => runCodingTurn(session, "forge it", overrides),
        /cave_internal_run_option/,
        `${Object.keys(overrides)[0]} reached the internal run path`,
      );
      await assert.rejects(
        () => runCodingSession({ agent: codingAgent, runOverrides: overrides }),
        /cave_internal_run_option/,
      );
    }
    assert.equal(session.turns.length, 0);
  });
});

test("host sandbox runs bash and edit_file against a real temp workspace", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(resolve(workspace, "target.txt"), "hello original world\n", "utf8");
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const session = await startCodingSession(codingAgent, {
      ensureRuntime: false,
      engineBin: FAKE_ENGINE,
    });
    const faux = fauxAnthropic();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "ls target.txt" }, { id: "bash-1" })),
      fauxAssistantMessage(fauxToolCall("edit_file", {
        path: "target.txt",
        old_string: "original",
        new_string: "edited",
      }, { id: "edit-1" })),
      fauxAssistantMessage("renamed the word"),
    ]);
    const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
    const turn = await runCodingTurn(session, "swap original for edited in target.txt", {
      model,
      streamFn: payloadStreamFn(faux),
      providerPayloadContract: "pi-on-payload-v1",
    });
    assert.deepEqual(turn.toolCalls, ["bash", "edit_file"]);
    assert.equal(await readFile(resolve(workspace, "target.txt"), "utf8"), "hello edited world\n");
    const bashSample = codingAgent.samples.find((item) => item.label.startsWith("bash:"));
    assert.equal(bashSample !== undefined, true);
    assert.match(bashSample.text, /target\.txt/);
  });
});

test("write_file creates explicitly, refuses accidental overwrite, and stays contained", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const write = codingAgent.definition.tools.find((item) => item.name === "write_file");
    await write.execute({ path: "created.txt", content: "first\n" });
    assert.equal(await readFile(resolve(workspace, "created.txt"), "utf8"), "first\n");
    await assert.rejects(
      () => write.execute({ path: "created.txt", content: "lost\n" }),
      /EEXIST/,
    );
    assert.equal(await readFile(resolve(workspace, "created.txt"), "utf8"), "first\n");
    await write.execute({ path: "created.txt", content: "second\n", overwrite: true });
    assert.equal(await readFile(resolve(workspace, "created.txt"), "utf8"), "second\n");
    await assert.rejects(
      () => write.execute({ path: "../escape.txt", content: "no\n" }),
      /path escapes the workspace/,
    );
  });
});

test("bash truncation keeps failure tail and exposes captured head without rerunning", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({
      workspace,
      model: "anthropic/faux-1",
      outputCaps: { bash: 512, read_tool_output: 1_024 },
    });
    const tools = Object.fromEntries(
      codingAgent.definition.tools.map((item) => [item.name, item]),
    );
    const output = await tools.bash.execute({
      command: `node -e 'process.stdout.write("HEAD_SENTINEL\\n" + "x".repeat(3000) + "\\nTAIL_SENTINEL\\n")'`,
    });
    assert.doesNotMatch(output, /HEAD_SENTINEL/);
    assert.match(output, /TAIL_SENTINEL/);
    const handle = output.match(/handle (tool_[a-f0-9]+)/)?.[1];
    assert.equal(typeof handle, "string");
    const recovered = await tools.read_tool_output.execute({
      handle,
      query: "HEAD_SENTINEL",
      limit: 64,
    });
    assert.match(recovered, /HEAD_SENTINEL/);
    assert.match(recovered, /complete capture/);
  });
});

test("grep returns no more than 200 matches across a workspace result", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(
      resolve(workspace, "many.txt"),
      Array.from({ length: 250 }, (_, index) => `match ${index}`).join("\n"),
      "utf8",
    );
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const grep = codingAgent.definition.tools.find((item) => item.name === "grep");
    const output = await grep.execute({ pattern: "match", path: "many.txt" });
    assert.equal(output.split("\n").filter((line) => /match \d+$/.test(line)).length, 200);
    assert.match(output, /matches limited to first 200/);
  });
});

test("bash cannot read the framework's account/provider credentials", async () => {
  await withWorkspace(async (workspace) => {
    const priorCave = process.env.CAVE_API_KEY;
    const priorAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.CAVE_API_KEY = "cave-account-secret-xyz";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret-xyz";
    try {
      const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const leak = await bash.execute({ command: "echo cave=$CAVE_API_KEY anthropic=$ANTHROPIC_API_KEY" });
      const leakText = typeof leak === "string" ? leak : JSON.stringify(leak);
      assert.doesNotMatch(leakText, /cave-account-secret-xyz/);
      assert.doesNotMatch(leakText, /sk-ant-secret-xyz/);
      // The shell baseline still passes through, so bash stays usable.
      const path = await bash.execute({ command: "echo path=$PATH" });
      const pathText = typeof path === "string" ? path : JSON.stringify(path);
      assert.match(pathText, /path=\//);
    } finally {
      if (priorCave === undefined) delete process.env.CAVE_API_KEY;
      else process.env.CAVE_API_KEY = priorCave;
      if (priorAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = priorAnthropic;
    }
  });
});

test("tools refuse to leave the workspace", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const readTool = codingAgent.definition.tools.find((item) => item.name === "read_file");
    await assert.rejects(
      () => readTool.execute({ path: "../escape.txt" }),
      /path escapes the workspace/,
    );
  });
});

test("optimized turn bills token counts from run telemetry and proves recovery", async () => {
  await withWorkspace(async (workspace) => {
    const body = Array.from(
      { length: 240 },
      (_, index) => `line ${index}: the quick brown fox jumps over the lazy dog repeatedly`,
    ).join("\n");
    await writeFile(resolve(workspace, "big.txt"), body, "utf8");
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const session = await startCodingSession(codingAgent, {
      ensureRuntime: false,
      engineBin: FAKE_ENGINE,
      fetch: healthzOnly,
    });
    assert.equal(session.mode, "optimized");
    const faux = fauxAnthropic();
    const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };

    faux.setResponses([fauxAssistantMessage("ready when you are")]);
    const warmup = await runCodingTurn(session, "hello, this is the first turn of the session", {
      model,
      streamFn: payloadStreamFn(faux),
      providerPayloadContract: "pi-on-payload-v1",
    });
    assert.equal(warmup.bill.mode, "observe-only");
    assert.deepEqual(warmup.bill.transformIDs, []);
    assert.equal(session.mode, "optimized");

    const seen = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read_file", { path: "big.txt" }, { id: "read-1" })),
      fauxAssistantMessage("big.txt is a repeated pangram"),
    ]);
    const turn = await runCodingTurn(session, "read big.txt and summarize it", {
      model,
      models: payloadModels(faux, seen),
      providerPayloadContract: "pi-on-payload-v1",
    });

    assert.equal(turn.bill.mode, "optimized");
    assert.deepEqual(turn.bill.transformFailures, []);
    assert.equal(turn.bill.recoveryResolved, true);
    assert.deepEqual(turn.bill.transformIDs, [
      "caveman.engine.terminal.v1",
      "caveman.engine.text.v1",
    ]);
    // Numbers come from RunResult.transformTrace, not from anything invented here.
    assert.equal(turn.bill.transformedTokensBefore > turn.bill.transformedTokensAfter, true);
    assert.equal(
      turn.bill.tokensSavedInferred,
      turn.bill.transformedTokensBefore - turn.bill.transformedTokensAfter,
    );
    assert.equal(turn.bill.usageBasis, "provider_reported");
    assert.equal(turn.bill.contextBill.tool_result > 0, true);
    // The provider actually saw the compressed tool result on the second call.
    assert.match(JSON.stringify(seen[1]), /cave-compressed/);

    const total = sessionBill(session);
    assert.equal(total.turns, 2);
    assert.equal(total.tokensSavedInferred, turn.bill.tokensSavedInferred);
    assert.equal(total.cacheHitTarget, 0.98);
    assert.equal(typeof total.cacheInputTokenHitRatio, "number");
    assert.equal(total.cacheHitTargetMet, false);

    const printed = [
      ...formatTurnBill(turn.bill, total.tokensSavedInferred),
      ...formatSessionBill(total),
    ];
    const savings = printed.filter((line) => line.includes("tokens saved"));
    assert.equal(savings.length, 2);
    for (const line of savings) {
      assert.match(line, /tokens/);
      assert.match(line, /local estimate/);
      assert.doesNotMatch(line, /\$/);
    }
    // No dollar figure anywhere in the bill; spend is labelled in USD with its basis.
    assert.doesNotMatch(printed.join("\n"), /\$/);
    assert.match(printed.join("\n"), /USD measured at public catalog list prices \((public_catalog|unpriced)\)/);
    assert.match(printed.join("\n"), /cache input-token hit ratio: .*target 98\.00%/);

    const proof = await proveRecovery(session);
    assert.equal(proof.outcome, "recovered");
    assert.equal(proof.originalSHA256, proof.recoveredSHA256);
    assert.match(proof.segment, /^read_file:big\.txt$/);
    assert.match(formatRecoveryProof(proof), /round-trip OK \(sha256 match/);
  });
});

test("recovery proof reports a mismatch instead of claiming a round trip", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    codingAgent.samples.push({ label: "tool_result:seeded", text: "x".repeat(4_096) });
    const session = await startCodingSession(codingAgent, {
      ensureRuntime: false,
      engineBin: resolve(import.meta.dirname, "fixtures/lying-engine.mjs"),
    });
    const proof = await proveRecovery(session);
    assert.equal(proof.outcome, "mismatch");
    assert.notEqual(proof.originalSHA256, proof.recoveredSHA256);
    assert.match(formatRecoveryProof(proof), /FAILED \(sha256 mismatch\)/);
  });
});

test("a symlink out of the workspace is not inside the workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(resolve(tmpdir(), "caveman-code-outside-"));
    try {
      await writeFile(resolve(outside, "secret.txt"), "not yours to read\n", "utf8");
      await mkdir(resolve(workspace, "nested"), { recursive: true });
      await symlink(outside, resolve(workspace, "nested/escape"), "dir");
      const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
      const tools = Object.fromEntries(
        codingAgent.definition.tools.map((item) => [item.name, item]),
      );
      // A lexical prefix check passes all three of these: the string starts with
      // the workspace path, the file it names does not live there.
      await assert.rejects(
        () => tools.read_file.execute({ path: "nested/escape/secret.txt" }),
        /path escapes the workspace/,
      );
      await assert.rejects(
        () => tools.edit_file.execute({
          path: "nested/escape/secret.txt",
          old_string: "not yours",
          new_string: "mine now",
        }),
        /path escapes the workspace/,
      );
      // Not-yet-existing leaf: the deepest existing ancestor is canonicalized,
      // so a file the agent would create outside is refused before the write.
      await assert.rejects(
        () => tools.edit_file.execute({
          path: "nested/escape/new-file.txt",
          old_string: "a",
          new_string: "b",
        }),
        /path escapes the workspace/,
      );
      assert.equal(
        await readFile(resolve(outside, "secret.txt"), "utf8"),
        "not yours to read\n",
      );
      // A real file inside the workspace still reads.
      await writeFile(resolve(workspace, "nested/inside.txt"), "yours\n", "utf8");
      assert.match(await tools.read_file.execute({ path: "nested/inside.txt" }), /yours/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("edit_file writes new_string verbatim even with $-substitution sequences", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(resolve(workspace, "code.js"), "const price = PLACEHOLDER;\n", "utf8");
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const tools = Object.fromEntries(
      codingAgent.definition.tools.map((item) => [item.name, item]),
    );
    // Every $-sequence String.replace would have interpreted, in one payload:
    // $& (whole match), $` (pre-match), $' (post-match), $$ (literal $), $1.
    const literal = "$& $` $' $$ $1 cost($100)";
    await tools.edit_file.execute({
      path: "code.js",
      old_string: "PLACEHOLDER",
      new_string: literal,
    });
    const after = await readFile(resolve(workspace, "code.js"), "utf8");
    assert.equal(after, `const price = ${literal};\n`);
  });
});

test("a backgrounded child does not hold the bash tool past its timeout", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
    const startedAt = performance.now();
    // The backgrounded sleep inherits stdout, so waiting for stdio EOF waits for
    // the sleep. The timeout kills the process group and the run settles on the
    // shell's own exit with the output that did arrive.
    const text = await bash.execute({ command: "sleep 20 & echo hi", timeoutMs: 2_000 });
    const elapsed = performance.now() - startedAt;
    assert.equal(elapsed < 10_000, true, `bash took ${Math.round(elapsed)} ms to settle`);
    assert.match(text, /hi/);
  });
});

test("bash without yieldTimeMs keeps foreground behavior", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const text = await bash.execute({ command: "printf foreground-ok" });
      assert.match(text, /^exit 0\nforeground-ok$/);
      assert.doesNotMatch(text, /session cmd_/);
    } finally {
      await codingAgent.close();
    }
  });
});

test("foreground bash closes stdin so readers observe EOF instead of timing out", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const text = await bash.execute({
        command:
          "node -e 'process.stdin.on(\"end\",()=>process.stdout.write(\"stdin-eof\"));" +
          "process.stdin.resume()'",
        timeoutMs: 1_000,
      });
      assert.match(text, /^exit 0\nstdin-eof$/);
    } finally {
      await codingAgent.close();
    }
  });
});

test("bash yields one live session and absolute cursor reads never rerun its command", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const started = await bash.execute({
        command: [
          "node -e '",
          'const fs=require("fs");',
          'fs.appendFileSync("runs.txt","x");',
          'process.stdout.write("first\\n");',
          'setTimeout(()=>process.stdout.write("second\\n"),200)',
          "'",
        ].join(""),
        yieldTimeMs: 25,
      });
      const sessionId = started.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      let cursor = Number(started.match(/next cursor (\d+)/)?.[1]);
      assert.equal(typeof sessionId, "string");
      assert.equal(Number.isSafeInteger(cursor), true);
      assert.match(started, /running/);
      let transcript = started;
      for (let reads = 0; reads < 3 && !transcript.includes("second"); reads++) {
        const resumed = await bash.execute({
          sessionId,
          action: "read",
          cursor,
          waitMs: 2_000,
        });
        transcript += `\n${resumed}`;
        const nextCursor = Number(resumed.match(/next cursor (\d+)/)?.[1]);
        assert.equal(nextCursor >= cursor, true);
        cursor = nextCursor;
      }
      assert.match(transcript, /first/);
      assert.match(transcript, /second/);
      assert.equal(await readFile(resolve(workspace, "runs.txt"), "utf8"), "x");
    } finally {
      await codingAgent.close();
    }
  });
});

test("caveman_code drives command sessions through canonical nested dispatch", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({
      workspace,
      model: "anthropic/faux-1",
      toolSet: "pebble-v1",
      toolMode: "programmatic",
    });
    try {
      const session = await startCodingSession(codingAgent, { cave: "off" });
      const faux = fauxAnthropic();
      const command = [
        "node -e '",
        'const fs=require("fs");',
        'fs.appendFileSync("programmatic-runs.txt","x");',
        'process.stdout.write("nested-first\\n");',
        'setTimeout(()=>process.stdout.write("nested-second\\n"),150)',
        "'",
      ].join("");
      const code = [
        `const started=await bash(${JSON.stringify({ command, yieldTimeMs: 10 })});`,
        "const sessionId=started.sessionId;",
        "let cursor=started.cursor;",
        'if(!sessionId)throw new Error("missing command session");',
        "let transcript=started.output;",
        "for(let reads=0;reads<3&&!transcript.includes('nested-second');reads++){",
        "const page=await bash({sessionId,action:'read',cursor,waitMs:1000});",
        "transcript+='\\n'+page.output;",
        "cursor=page.cursor;",
        "}",
        "if(!transcript.includes('nested-second'))throw new Error('missing resumed output');",
        "print(transcript);",
      ].join("");
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("caveman_code", { code }, { id: "code-session" })),
        fauxAssistantMessage("done"),
      ]);
      const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
      const turn = await runCodingTurn(session, "run and resume one command", {
        model,
        streamFn: payloadStreamFn(faux),
        providerPayloadContract: "pi-on-payload-v1",
      });
      assert.equal(turn.text, "done");
      assert.equal(turn.toolCalls.filter((name) => name === "bash").length >= 2, true);
      assert.equal(turn.toolCalls.includes("caveman_code"), true);
      assert.equal(
        await readFile(resolve(workspace, "programmatic-runs.txt"), "utf8"),
        "x",
      );
    } finally {
      await codingAgent.close();
    }
  });
});

test("programmatic bash returns literal search pages without exposing its query", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({
      workspace,
      model: "anthropic/faux-1",
      toolSet: "pebble-v1",
      toolMode: "programmatic",
    });
    try {
      const codeTool = codingAgent.definition.tools[0];
      const nested = new Map(codeTool.nestedTools.map((item) => [item.name, item]));
      const context = {
        toolCallId: "literal-search-parent",
        parentToolCallId: "literal-search-parent",
        dispatch(name, input, options) {
          const definition = nested.get(name);
          if (definition === undefined) return Promise.reject(new Error(`test_unknown_tool:${name}`));
          return definition.execute(input, options?.signal);
        },
      };
      const command = "node -e 'process.stdout.write(\"prefix-TARGET-tail\");" +
        "setInterval(()=>{},1000)'";
      const result = await codeTool.execute({
        code: [
          `const started=await bash(${JSON.stringify({ command, yieldTimeMs: 10 })});`,
          "const sessionId=started.sessionId;",
          'if(!/^cmd_[a-f0-9]{32}$/.test(sessionId))throw new Error("missing session");',
          'const missed=await bash({sessionId,action:"read",cursor:0,query:"must-not-echo"});',
          'const found=await bash({sessionId,action:"read",cursor:0,query:"TARGET",waitMs:5000});',
          "return {missed,found};",
        ].join(""),
      }, undefined, context);
      assert.doesNotMatch(result, /must-not-echo/);
      const { missed, found } = JSON.parse(result);
      assert.deepEqual(
        { output: missed.output, state: missed.state, exitCode: missed.exitCode },
        { output: "", state: "running", exitCode: null },
      );
      assert.equal(found.output, "TARGET-tail");
      assert.equal(found.cursor, 18);
    } finally {
      await codingAgent.close();
    }
  });
});

test("successful code cells retain yielded commands until owner cancellation", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({
      workspace,
      model: "anthropic/faux-1",
      toolSet: "pebble-v1",
      toolMode: "programmatic",
    });
    try {
      const codeTool = codingAgent.definition.tools[0];
      const nested = new Map(codeTool.nestedTools.map((item) => [item.name, item]));
      const context = {
        toolCallId: "cross-cell-parent",
        parentToolCallId: "cross-cell-parent",
        dispatch(name, input, options) {
          const definition = nested.get(name);
          if (definition === undefined) return Promise.reject(new Error(`test_unknown_tool:${name}`));
          return definition.execute(input, options?.signal);
        },
      };
      const command = [
        "node -e '",
        'const fs=require("fs");',
        'fs.appendFileSync("cross-cell-runs.txt","x");',
        'setTimeout(()=>process.stdout.write("cross-cell-late\\n"),120);',
        "setInterval(()=>{},1000)",
        "'",
      ].join("");
      const owner = new AbortController();
      const first = await codeTool.execute({
        code: `return await bash(${JSON.stringify({ command, yieldTimeMs: 0, timeoutMs: 2_000 })})`,
      }, owner.signal, context);
      const started = JSON.parse(first);
      const { sessionId, cursor } = started;
      assert.equal(started.state, "running");
      assert.match(sessionId, /^cmd_[a-f0-9]{32}$/);
      assert.equal(Number.isSafeInteger(cursor), true);

      const second = await codeTool.execute({
        code: [
          'const sessions=await bash({"action":"list"});',
          'const sessionId=/cmd_[a-f0-9]{32}/.exec(sessions.output)?.[0];',
          'if(!sessionId)throw new Error("missing retained session");',
          `const page=await bash({sessionId,action:"read",cursor:${cursor},waitMs:1000});`,
          'return sessions.output+"\\n"+page.output+"\\nstate="+page.state;',
        ].join(""),
      }, undefined, context);
      assert.match(second, /command sessions: 1 retained · oldest first/);
      assert.match(second, new RegExp(`${sessionId} · running · stdin open`));
      assert.match(second, /cross-cell-late/);
      assert.match(second, /state=running$/);
      assert.equal(await readFile(resolve(workspace, "cross-cell-runs.txt"), "utf8"), "x");

      owner.abort(new Error("test_owner_cancelled"));
      const bash = nested.get("bash");
      let stopped = await bash.execute({ sessionId, action: "read" });
      for (let reads = 0; reads < 20 && stopped.state === "running"; reads++) {
        await new Promise((accept) => setTimeout(accept, 20));
        stopped = await bash.execute({ sessionId, action: "read" });
      }
      assert.equal(stopped.state, "killed");
    } finally {
      await codingAgent.close();
    }
  });
});

test("bash writes stdin into its existing command session", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const started = await bash.execute({
        command:
          "node -e 'process.stdin.once(\"data\",d=>{" +
          "process.stdout.write(\"stdin:\"+d);process.exit(0)});setTimeout(()=>{},10000)'",
        yieldTimeMs: 20,
      });
      const sessionId = started.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      const cursor = Number(started.match(/next cursor (\d+)/)?.[1]);
      const written = await bash.execute({
        sessionId,
        action: "write",
        input: "hello-session\n",
        cursor,
        waitMs: 2_000,
      });
      assert.match(written, /stdin accepted 14 bytes/);
      assert.match(written, /stdin:hello-session/);
    } finally {
      await codingAgent.close();
    }
  });
});

test("bash write without a cursor returns only output produced after the write", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const started = await bash.execute({
        command:
          "node -e 'process.stdout.write(\"READY\");" +
          "process.stdin.once(\"data\",()=>setTimeout(()=>process.stdout.write(\"RESPONSE\"),50));" +
          "process.stdin.resume();setInterval(()=>{},1000)'",
        yieldTimeMs: 500,
      });
      assert.match(started, /READY/);
      const sessionId = started.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      const written = await bash.execute({
        sessionId,
        action: "write",
        input: "go",
        waitMs: 2_000,
      });
      assert.match(written, /stdin accepted 2 bytes/);
      assert.match(written, /RESPONSE/);
      assert.doesNotMatch(written, /READY/);
      assert.match(written, /· running/);
    } finally {
      await codingAgent.close();
    }
  });
});

test("bash writes stdin and closes it so the same process can finish on EOF", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const started = await bash.execute({
        command:
          "node -e 'let body=\"\";process.stdin.on(\"data\",d=>body+=d);" +
          "process.stdin.on(\"end\",()=>process.stdout.write(\"stdin:\"+body))'",
        yieldTimeMs: 20,
      });
      const sessionId = started.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      const cursor = Number(started.match(/next cursor (\d+)/)?.[1]);
      const finished = await bash.execute({
        sessionId,
        action: "write",
        input: "hello-eof",
        closeStdin: true,
        cursor,
        waitMs: 2_000,
      });
      assert.match(finished, /stdin accepted 9 bytes · stdin closed/);
      assert.match(finished, /· exited · exit 0/);
      assert.match(finished, /stdin:hello-eof/);

      const rejected = await bash.execute({
        sessionId,
        action: "write",
        input: "must-not-run",
      });
      assert.match(rejected, /stdin not accepted · exited/);
      assert.match(rejected, /· exited · exit 0/);
    } finally {
      await codingAgent.close();
    }
  });
});

test("bash session kill, timeout, and unknown-after-restart states fail closed", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const live = await bash.execute({
        command: "node -e 'setInterval(()=>{},1000)'",
        yieldTimeMs: 10,
      });
      const liveId = live.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      const killed = await bash.execute({ sessionId: liveId, action: "kill" });
      assert.match(killed, /· killed · killed/);

      const expiring = await bash.execute({
        command: "node -e 'setInterval(()=>{},1000)'",
        timeoutMs: 80,
        yieldTimeMs: 10,
      });
      const expiringId = expiring.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      const expiringCursor = Number(expiring.match(/next cursor (\d+)/)?.[1]);
      const timedOut = await bash.execute({
        sessionId: expiringId,
        action: "read",
        cursor: expiringCursor,
        waitMs: 1_000,
      });
      assert.match(timedOut, /timed_out · hard timeout/);

      const unknown = await bash.execute({
        sessionId: "cmd_00000000000000000000000000000000",
        action: "read",
      });
      assert.match(unknown, /unknown_after_restart/);
      assert.match(unknown, /process adoption is disabled/);
    } finally {
      await codingAgent.close();
    }
  });
});

test("resumed bash read and write abort promptly without killing session", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const started = await bash.execute({
        command: "node -e 'process.stdin.resume();setInterval(()=>{},1000)'",
        yieldTimeMs: 10,
      });
      const sessionId = started.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      const cursor = Number(started.match(/next cursor (\d+)/)?.[1]);
      const readAbort = new AbortController();
      setTimeout(() => readAbort.abort(), 25);
      const began = performance.now();
      await assert.rejects(
        () => bash.execute({
          sessionId,
          action: "read",
          cursor,
          waitMs: 1_000,
        }, readAbort.signal),
        /command_session_operation_aborted/,
      );
      assert.equal(performance.now() - began < 500, true);

      const stillRunning = await bash.execute({ sessionId, action: "read", cursor });
      assert.match(stillRunning, /· running/);
      const writeAbort = new AbortController();
      writeAbort.abort();
      await assert.rejects(
        () => bash.execute({
          sessionId,
          action: "write",
          input: "must-not-block",
          cursor,
        }, writeAbort.signal),
        /command_session_operation_aborted/,
      );
      const afterWriteAbort = await bash.execute({ sessionId, action: "read", cursor });
      assert.match(afterWriteAbort, /· running/);
      await bash.execute({ sessionId, action: "kill" });
    } finally {
      await codingAgent.close();
    }
  });
});

test("CodingAgent.close kills live command groups before delayed side effects", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
    const started = await bash.execute({
      command:
        "node -e 'const fs=require(\"fs\");" +
        "setTimeout(()=>fs.writeFileSync(\"late.txt\",\"escaped\"),400);" +
        "setInterval(()=>{},1000)'",
      yieldTimeMs: 20,
    });
    assert.match(started, /session cmd_[a-f0-9]{32} · running/);
    const sessionId = started.match(/session (cmd_[a-f0-9]{32})/)?.[1];
    await Promise.all([codingAgent.close(), codingAgent.close()]);
    const afterClose = await bash.execute({ sessionId, action: "read" });
    assert.match(afterClose, /unknown_after_restart/);
    await new Promise((accept) => setTimeout(accept, 550));
    await assert.rejects(() => readFile(resolve(workspace, "late.txt"), "utf8"), /ENOENT/);
  });
});

test("command session runtime retains bounded output with absolute byte cursors", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 64,
      maxReadBytes: 32,
      maxInputBytes: 16,
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          [
            "let index=0;",
            "const emit=()=>{",
            "if(index===200)return;",
            "process.stdout.write(String(index%10).repeat(7));",
            "index++;setImmediate(emit)",
            "};emit()",
          ].join(""),
        ],
        cwd: workspace,
        env: {},
        timeoutMs: 2_000,
      });
      let state = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 1,
        waitMs: 1_000,
      });
      while (state.state === "running") {
        state = await runtime.read({
          sessionId: started.sessionId,
          cursor: state.availableTo,
          limit: 1,
          waitMs: 1_000,
        });
      }
      const first = await runtime.read({ sessionId: started.sessionId, cursor: 0, limit: 32 });
      const expected = Array.from(
        { length: 200 },
        (_, index) => String(index % 10).repeat(7),
      ).join("").slice(-64);
      assert.equal(first.state, "exited");
      assert.equal(first.availableFrom, 1_336);
      assert.equal(first.availableTo, 1_400);
      assert.equal(first.outputStart, 1_336);
      assert.equal(first.nextCursor, 1_368);
      assert.equal(first.output, expected.slice(0, 32));
      assert.equal(first.outputEncoding, "utf8");
      assert.equal(first.truncatedBeforeCursor, true);
      const second = await runtime.read({
        sessionId: started.sessionId,
        cursor: first.nextCursor,
        limit: 32,
      });
      assert.equal(second.nextCursor, 1_400);
      assert.equal(second.output, expected.slice(32));
      await assert.rejects(
        () => runtime.read({ sessionId: started.sessionId, limit: 33 }),
        /command_session_limit_invalid/,
      );
    } finally {
      await runtime.close();
    }
  });
});

test("command session spill stays lazy below the in-memory limit", async () => {
  await withWorkspace(async (workspace) => {
    const spillDirectory = resolve(workspace, "spill");
    await mkdir(spillDirectory);
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 16,
      spill: { directory: spillDirectory, maxBytes: 32 },
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("fits")'],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      await settleCommandSession(runtime, started.sessionId);
      const captured = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 16,
      });
      assert.equal(captured.output, "fits");
      assert.equal(captured.availableFrom, 0);
      assert.deepEqual(await readdir(spillDirectory), []);
    } finally {
      await runtime.close();
    }
  });
});

test("command session spill recovers exact UTF-8 and binary bytes from cursor zero", async () => {
  await withWorkspace(async (workspace) => {
    const spillDirectory = resolve(workspace, "spill");
    await mkdir(spillDirectory);
    const payload = Buffer.concat([
      Buffer.from("prefix-🙂-middle-", "utf8"),
      Buffer.from([0xff, 0x00, 0x80, 0x7f]),
      Buffer.from("-suffix-αβγ", "utf8"),
    ]);
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 7,
      spill: { directory: spillDirectory, maxBytes: 128 },
      maxReadBytes: 5,
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(Buffer.from(${JSON.stringify(payload.toString("base64"))},"base64"))`,
        ],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      await settleCommandSession(runtime, started.sessionId);
      const captured = await readCommandSessionBytes(runtime, started.sessionId, 5);
      assert.equal(captured.availableFrom, 0);
      assert.equal(captured.availableTo, payload.byteLength);
      assert.deepEqual(captured.output, payload);

      const files = await readdir(spillDirectory);
      if (process.platform === "win32") {
        assert.equal(files.length, 1);
        const spillFile = await stat(resolve(spillDirectory, files[0]));
        assert.equal(spillFile.isFile(), true);
        assert.equal(spillFile.size <= 128, true);
      } else {
        assert.deepEqual(files, []);
      }
    } finally {
      await runtime.close();
    }
  });
});

test("command session literal search crosses scan, spill, and binary byte boundaries", async () => {
  await withWorkspace(async (workspace) => {
    const spillDirectory = resolve(workspace, "spill");
    await mkdir(spillDirectory);
    const totalBytes = 80 * 1024;
    const memoryBytes = 8 * 1024;
    const spillMemoryBoundary = totalBytes - memoryBytes;
    const placements = [
      { offset: 100, bytes: Buffer.from("spill-target") },
      { offset: 1_024, bytes: Buffer.from("🙂needle") },
      { offset: 2_048, bytes: Buffer.concat([
        Buffer.from("binary-target"),
        Buffer.from([0xff]),
        Buffer.from("abcd"),
      ]) },
      { offset: 64 * 1024 - 4, bytes: Buffer.from("chunk-target") },
      { offset: spillMemoryBoundary - 4, bytes: Buffer.from("bridge-target") },
    ];
    const encodedPlacements = placements.map(({ offset, bytes }) => [
      offset,
      bytes.toString("base64"),
    ]);
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: memoryBytes,
      spill: { directory: spillDirectory, maxBytes: totalBytes },
      maxReadBytes: 128,
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          [
            `const output=Buffer.alloc(${totalBytes},46);`,
            `for(const [offset,body] of ${JSON.stringify(encodedPlacements)})`,
            "Buffer.from(body,'base64').copy(output,offset);",
            "process.stdout.write(output)",
          ].join(""),
        ],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      await settleCommandSession(runtime, started.sessionId);

      for (const [query, expectedOffset] of [
        ["spill-target", 100],
        ["🙂needle", 1_024],
        ["chunk-target", 64 * 1024 - 4],
        ["bridge-target", spillMemoryBoundary - 4],
      ]) {
        const found = await runtime.read({
          sessionId: started.sessionId,
          cursor: 0,
          query,
          limit: 64,
        });
        assert.equal(found.matchStart, expectedOffset);
        assert.equal(found.outputStart, expectedOffset);
        assert.deepEqual(
          Buffer.from(found.output, found.outputEncoding).subarray(0, Buffer.byteLength(query)),
          Buffer.from(query),
        );
      }

      const binary = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        query: "binary-target",
        limit: Buffer.byteLength("binary-target") + 5,
      });
      assert.equal(binary.matchStart, 2_048);
      assert.equal(binary.outputStart, 2_048);
      assert.equal(binary.outputEncoding, "base64");
      assert.deepEqual(
        Buffer.from(binary.output, "base64"),
        Buffer.concat([Buffer.from("binary-target"), Buffer.from([0xff]), Buffer.from("abcd")]),
      );
      const pastMatch = await runtime.read({
        sessionId: started.sessionId,
        cursor: 200,
        query: "spill-target",
        limit: 64,
      });
      assert.equal(pastMatch.matchStart, null);
    } finally {
      await runtime.close();
    }
  });
});

test("command session literal search caps one scan at 16 MiB", async () => {
  await withWorkspace(async (workspace) => {
    const spillDirectory = resolve(workspace, "spill");
    await mkdir(spillDirectory);
    const totalBytes = 17 * 1024 * 1024;
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 1024 * 1024,
      spill: { directory: spillDirectory, maxBytes: 16 * 1024 * 1024 },
      maxReadBytes: 64,
      maxTimeoutMs: 5_000,
      maxWaitMs: 1_000,
    });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: ["-e", `process.stdout.write(Buffer.alloc(${totalBytes},97))`],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 5_000,
      });
      await settleCommandSession(runtime, started.sessionId);
      const first = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        query: "z",
        limit: 64,
      });
      assert.equal(first.matchStart, null);
      assert.equal(first.output, "");
      assert.equal(first.nextCursor, 16 * 1024 * 1024);
      assert.equal(first.hasMore, true);
      const second = await runtime.read({
        sessionId: started.sessionId,
        cursor: first.nextCursor,
        query: "z",
        limit: 64,
      });
      assert.equal(second.matchStart, null);
      assert.equal(second.nextCursor, totalBytes);
      assert.equal(second.hasMore, false);
    } finally {
      await runtime.close();
    }
  });
});

test("running literal search resumes across its prior cursor", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 64,
      maxReadBytes: 32,
      maxTimeoutMs: 10_000,
      maxWaitMs: 5_000,
    });
    try {
      const prefix = "prefix-NEED";
      const started = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          `process.stdout.write(${JSON.stringify(prefix)});` +
            'process.stdin.once("data",()=>process.stdout.write("LE-tail"));' +
            "process.stdin.resume()",
        ],
        cwd: workspace,
        env: {},
        timeoutMs: 10_000,
      });
      await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 1,
        waitMs: 5_000,
      });
      const first = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        query: "NEEDLE",
        limit: 32,
      });
      assert.equal(first.state, "running");
      assert.equal(first.matchStart, null);
      assert.equal(first.nextCursor, Buffer.byteLength(prefix));

      const released = await runtime.write({
        sessionId: started.sessionId,
        input: "go",
        closeStdin: true,
      });
      assert.equal(released.accepted, true);
      assert.equal(released.outputCursor, Buffer.byteLength(prefix));

      const resumed = await runtime.read({
        sessionId: started.sessionId,
        cursor: first.nextCursor,
        query: "NEEDLE",
        limit: 32,
        waitMs: 5_000,
      });
      assert.equal(resumed.matchStart, Buffer.byteLength("prefix-"));
      assert.equal(resumed.outputStart, Buffer.byteLength("prefix-"));
      assert.match(resumed.output, /^NEEDLE-tail/);
    } finally {
      await runtime.close();
    }
  });
});

test("literal search validation, unknown sessions, and aborts fail closed", async () => {
  const runtime = createCommandSessionRuntime();
  const unknownId = "cmd_00000000000000000000000000000000";
  try {
    await assert.rejects(
      () => runtime.read({ sessionId: unknownId, query: "" }),
      /command_session_query_invalid/,
    );
    await assert.rejects(
      () => runtime.read({ sessionId: unknownId, query: "🙂".repeat(1_025) }),
      /command_session_query_limit_exceeded/,
    );
    const unknown = await runtime.read({
      sessionId: unknownId,
      query: "x".repeat(4 * 1024),
    });
    assert.equal(unknown.state, "unknown_after_restart");
    assert.equal(unknown.matchStart, null);
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      () => runtime.read({ sessionId: unknownId, query: "needle", signal: abort.signal }),
      /command_session_operation_aborted/,
    );
  } finally {
    await runtime.close();
  }
});

test("command session spill cap falls back to a truthful retained suffix", async () => {
  await withWorkspace(async (workspace) => {
    const spillDirectory = resolve(workspace, "spill");
    await mkdir(spillDirectory);
    const payload = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const chunks = payload.match(/.{1,4}/g);
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 8,
      spill: { directory: spillDirectory, maxBytes: 10 },
      maxReadBytes: 64,
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          [
            `const chunks=${JSON.stringify(chunks)};let index=0;`,
            "const emit=()=>{",
            "if(index===chunks.length)return;",
            "process.stdout.write(chunks[index++]);",
            "setTimeout(emit,12)",
            "};emit()",
          ].join(""),
        ],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      await settleCommandSession(runtime, started.sessionId);
      const captured = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 64,
      });
      assert.equal(captured.availableFrom, payload.length - 18);
      assert.equal(captured.availableTo, payload.length);
      assert.equal(captured.outputStart, payload.length - 18);
      assert.equal(captured.output, payload.slice(-18));
      assert.equal(captured.truncatedBeforeCursor, true);
      const evicted = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        query: "0123",
        limit: 64,
      });
      assert.equal(evicted.matchStart, null);
      assert.equal(evicted.output, "");
      assert.equal(evicted.nextCursor, payload.length);
      assert.equal(evicted.truncatedBeforeCursor, true);
      const files = await readdir(spillDirectory);
      if (process.platform === "win32") {
        assert.equal(files.length, 1);
        assert.equal((await stat(resolve(spillDirectory, files[0]))).size <= 10, true);
      } else {
        assert.deepEqual(files, []);
      }
    } finally {
      await runtime.close();
    }
  });
});

test("command session spill open failure degrades to truthful ring-only output", async () => {
  await withWorkspace(async (workspace) => {
    const missingDirectory = resolve(workspace, "missing-spill-directory");
    const payload = "spill-unavailable";
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 5,
      spill: { directory: missingDirectory, maxBytes: 32 },
      maxReadBytes: 32,
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(payload)})`],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      await settleCommandSession(runtime, started.sessionId);
      const captured = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 32,
      });
      assert.equal(captured.availableFrom, payload.length - 5);
      assert.equal(captured.outputStart, payload.length - 5);
      assert.equal(captured.output, payload.slice(-5));
      assert.equal(captured.truncatedBeforeCursor, true);
    } finally {
      await runtime.close();
    }
  });
});

test("command session spill files clean up on completed eviction and runtime close", async () => {
  await withWorkspace(async (workspace) => {
    const spillDirectory = resolve(workspace, "spill");
    await mkdir(spillDirectory);
    const runtime = createCommandSessionRuntime({
      maxSessions: 1,
      maxOutputBytes: 4,
      spill: { directory: spillDirectory, maxBytes: 32 },
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const first = await runtime.start({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("first-overflow")'],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      await settleCommandSession(runtime, first.sessionId);
      const firstFiles = await readdir(spillDirectory);
      if (process.platform === "win32") assert.equal(firstFiles.length, 1);
      else assert.deepEqual(firstFiles, []);

      const second = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          'process.stdout.write("second-overflow");setInterval(()=>{},1000)',
        ],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      let observed = await runtime.read({
        sessionId: second.sessionId,
        cursor: 0,
        limit: 1,
        waitMs: 1_000,
      });
      while (observed.availableTo < "second-overflow".length) {
        observed = await runtime.read({
          sessionId: second.sessionId,
          cursor: observed.availableTo,
          limit: 1,
          waitMs: 1_000,
        });
      }
      assert.equal(observed.state, "running");
      const secondFiles = await readdir(spillDirectory);
      if (process.platform === "win32") {
        assert.equal(secondFiles.length, 1);
        assert.notEqual(secondFiles[0], firstFiles[0]);
      } else {
        assert.deepEqual(secondFiles, []);
      }
    } finally {
      await runtime.close();
      assert.deepEqual(await readdir(spillDirectory), []);
    }
  });
});

async function settleCommandSession(runtime, sessionId) {
  let state = await runtime.read({ sessionId, cursor: 0, limit: 1, waitMs: 1_000 });
  while (state.state === "running") {
    state = await runtime.read({
      sessionId,
      cursor: state.availableTo,
      limit: 1,
      waitMs: 1_000,
    });
  }
  return state;
}

async function readCommandSessionBytes(runtime, sessionId, limit) {
  const chunks = [];
  let cursor = 0;
  let first;
  while (true) {
    const page = await runtime.read({ sessionId, cursor, limit });
    first ??= page;
    assert.equal(page.outputStart, cursor);
    assert.equal(page.nextCursor > cursor || !page.hasMore, true);
    chunks.push(Buffer.from(page.output, page.outputEncoding));
    cursor = page.nextCursor;
    if (!page.hasMore) break;
  }
  return {
    availableFrom: first.availableFrom,
    availableTo: first.availableTo,
    output: Buffer.concat(chunks),
  };
}

test("command session runtime lists immutable retained-state snapshots", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = createCommandSessionRuntime({
      maxSessions: 2,
      maxOutputBytes: 64,
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const live = await runtime.start({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("live");setInterval(()=>{},1000)'],
        cwd: workspace,
        env: {},
        timeoutMs: 2_000,
      });
      await runtime.read({ sessionId: live.sessionId, cursor: 0, limit: 4, waitMs: 1_000 });
      const finished = await runtime.start({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("done")'],
        cwd: workspace,
        env: {},
        stdin: "closed",
        timeoutMs: 2_000,
      });
      let settled = await runtime.read({
        sessionId: finished.sessionId,
        cursor: 0,
        limit: 4,
        waitMs: 1_000,
      });
      while (settled.state === "running") {
        settled = await runtime.read({
          sessionId: finished.sessionId,
          cursor: settled.availableTo,
          limit: 1,
          waitMs: 1_000,
        });
      }

      const listed = runtime.list();
      assert.equal(Object.isFrozen(listed), true);
      assert.equal(listed.every(Object.isFrozen), true);
      assert.deepEqual(listed.map((session) => session.sessionId), [live.sessionId, finished.sessionId]);
      assert.deepEqual(listed.map((session) => session.state), ["running", "exited"]);
      assert.deepEqual(listed.map((session) => session.stdinOpen), [true, false]);
      assert.deepEqual(listed.map((session) => session.availableTo), [4, 4]);

      await runtime.kill(live.sessionId);
      assert.equal(listed[0].state, "running");
      assert.equal(runtime.list()[0].state, "killed");
    } finally {
      await runtime.close();
      assert.deepEqual(runtime.list(), []);
    }
  });
});

test("command session runtime can send empty input and EOF atomically", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = createCommandSessionRuntime({ maxTimeoutMs: 2_000, maxWaitMs: 1_000 });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          'process.stdin.on("end",()=>{process.stdout.write("empty-eof");setInterval(()=>{},1000)});' +
            "process.stdin.resume()",
        ],
        cwd: workspace,
        env: {},
        timeoutMs: 2_000,
      });
      const written = await runtime.write({
        sessionId: started.sessionId,
        input: "",
        closeStdin: true,
      });
      assert.deepEqual(written, {
        sessionId: started.sessionId,
        state: "running",
        accepted: true,
        bytes: 0,
        outputCursor: 0,
      });
      const captured = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 64,
        waitMs: 1_000,
      });
      assert.equal(captured.state, "running");
      assert.equal(captured.output, "empty-eof");
      const rejected = await runtime.write({
        sessionId: started.sessionId,
        input: "late",
        closeStdin: true,
      });
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.state, "running");
      assert.equal(rejected.outputCursor, Buffer.byteLength("empty-eof"));

      const unknown = await runtime.write({
        sessionId: "cmd_00000000000000000000000000000000",
        input: "ignored",
      });
      assert.deepEqual(unknown, {
        sessionId: "cmd_00000000000000000000000000000000",
        state: "unknown_after_restart",
        accepted: false,
        bytes: 0,
        outputCursor: 0,
      });
    } finally {
      await runtime.close();
    }
  });
});

test("command session stdin pipe failure returns rejected instead of crashing host", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = createCommandSessionRuntime({ maxTimeoutMs: 2_000, maxWaitMs: 1_000 });
    try {
      const started = await runtime.start({
        command: process.execPath,
        args: [
          "-e",
          'require("node:fs").closeSync(0);process.stdout.write("ready");setInterval(()=>{},1000)',
        ],
        cwd: workspace,
        env: {},
        timeoutMs: 2_000,
      });
      const ready = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 64,
        waitMs: 1_000,
      });
      assert.equal(ready.output, "ready");
      const rejected = await runtime.write({
        sessionId: started.sessionId,
        input: "x".repeat(64 * 1024),
        closeStdin: true,
      });
      assert.equal(rejected.accepted, false);
      assert.equal(rejected.bytes, 0);
      assert.equal(rejected.state, "running");
      assert.equal(rejected.outputCursor, Buffer.byteLength("ready"));
    } finally {
      await runtime.close();
    }
  });
});

test("command session emoji paging and eviction preserve absolute UTF-8 bytes", async () => {
  await withWorkspace(async (workspace) => {
    const runtime = createCommandSessionRuntime({
      maxOutputBytes: 8,
      maxReadBytes: 5,
      maxTimeoutMs: 2_000,
      maxWaitMs: 1_000,
    });
    try {
      const text = "A😀B😀C";
      const bytes = Buffer.from(text);
      const started = await runtime.start({
        command: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
        cwd: workspace,
        env: {},
        timeoutMs: 2_000,
      });
      let settled = await runtime.read({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 1,
        waitMs: 1_000,
      });
      while (settled.state === "running") {
        settled = await runtime.read({
          sessionId: started.sessionId,
          cursor: settled.availableTo,
          limit: 1,
          waitMs: 1_000,
        });
      }
      // Eight-byte cap cuts inside first emoji at byte 3. Runtime drops its two
      // remaining continuation bytes, making retained text begin at byte 5.
      const first = await runtime.read({ sessionId: started.sessionId, cursor: 0, limit: 2 });
      assert.equal(first.availableFrom, 5);
      assert.equal(first.availableTo, bytes.byteLength);
      assert.equal(first.outputStart, 5);
      assert.equal(first.nextCursor, 6);
      assert.equal(first.outputEncoding, "utf8");
      assert.equal(first.output, "B");
      assert.doesNotMatch(first.output, /�/);
      const second = await runtime.read({
        sessionId: started.sessionId,
        cursor: first.nextCursor,
        limit: 5,
      });
      assert.equal(second.nextCursor, bytes.byteLength);
      assert.equal(second.outputEncoding, "utf8");
      assert.equal(second.output, "😀C");
      assert.equal(first.output + second.output, "B😀C");

      // Explicit mid-codepoint cursor uses byte-safe representation instead of
      // replacement characters or cursor drift.
      const split = await runtime.read({
        sessionId: started.sessionId,
        cursor: 7,
        limit: 1,
      });
      assert.equal(split.outputEncoding, "base64");
      assert.deepEqual(Buffer.from(split.output, "base64"), bytes.subarray(7, 8));
      assert.equal(split.nextCursor, 8);
    } finally {
      await runtime.close();
    }
  });
});

test("bash base64 fallback never advances past recoverable displayed bytes", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({
      workspace,
      model: "anthropic/faux-1",
      outputCaps: { bash: 600 },
    });
    try {
      const bash = codingAgent.definition.tools.find((item) => item.name === "bash");
      const started = await bash.execute({
        command: "node -e 'process.stdout.write(Buffer.alloc(100,255));setInterval(()=>{},1000)'",
        yieldTimeMs: 10,
      });
      const sessionId = started.match(/session (cmd_[a-f0-9]{32})/)?.[1];
      const page = await bash.execute({
        sessionId,
        action: "read",
        cursor: 0,
        waitMs: 1_000,
      });
      assert.doesNotMatch(page, /output capped/);
      const range = page.match(/\[base64 bytes (\d+)-(\d+)\]\n([A-Za-z0-9+/=]+)/);
      assert.equal(range !== null, true);
      const start = Number(range?.[1]);
      const end = Number(range?.[2]);
      const displayed = Buffer.from(range?.[3] ?? "", "base64");
      assert.equal(displayed.byteLength, end - start);
      assert.equal(Number(page.match(/next cursor (\d+)/)?.[1]), end);
      assert.deepEqual(displayed, Buffer.alloc(displayed.byteLength, 255));
      await bash.execute({ sessionId, action: "kill" });
    } finally {
      await codingAgent.close();
    }
  });
});

test("a session with no turns claims no price or usage basis", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const session = await startCodingSession(codingAgent, {
      ensureRuntime: false,
      engineBin: FAKE_ENGINE,
    });
    const bill = sessionBill(session);
    assert.equal(bill.turns, 0);
    assert.equal(bill.priceBasis, "unpriced");
    assert.equal(bill.usageBasis, "unavailable");
    assert.equal(bill.cacheInputTokenHitRatio, null);
    assert.equal(bill.cacheHitTargetMet, null);
    const printed = formatSessionBill(bill).join("\n");
    assert.doesNotMatch(printed, /public_catalog/);
    assert.doesNotMatch(printed, /provider_reported/);
    assert.match(printed, /no provider calls this session/);
  });
});

test("task economics charges failed attempts to externally verified completions", () => {
  const report = summarizeCodingTaskAttempts([
    {
      taskId: "task-a",
      attemptId: "1",
      provider: "zai",
      model: "glm-5.2-fp8",
      completed: false,
      completionBasis: "external_verifier",
      costUsd: 0.2,
      priceBasis: "provider_invoice",
      tokens: 200,
      usageBasis: "provider_reported",
    },
    {
      taskId: "task-a",
      attemptId: "2",
      provider: "zai",
      model: "glm-5.2-fp8",
      completed: true,
      completionBasis: "external_verifier",
      costUsd: 0.3,
      priceBasis: "provider_invoice",
      tokens: 300,
      usageBasis: "provider_reported",
    },
  ]);
  assert.equal(report.status, "complete");
  assert.equal(report.attempted, 2);
  assert.equal(report.completed, 1);
  assert.equal(report.completionRate, 0.5);
  assert.equal(report.totalCostUsd, 0.5);
  assert.equal(report.costPerCompletedTaskUsd, 0.5);
  assert.equal(report.totalTokens, 500);
  assert.equal(report.tokensPerCompletedTask, 500);
  assert.equal(report.priceBasis, "provider_invoice");
});

test("task economics fails an interrupted attempt schedule closed", () => {
  const report = summarizeCodingTaskAttempts([{
    taskId: "task-a",
    attemptId: "1",
    provider: "zai",
    model: "glm-5.2-fp8",
    completed: true,
    completionBasis: "external_verifier",
    costUsd: 0.3,
    priceBasis: "provider_invoice",
    tokens: 300,
    usageBasis: "provider_reported",
  }], { expectedAttempts: 2 });
  assert.equal(report.status, "incomplete_evidence");
  assert.equal(report.completionRate, null);
  assert.equal(report.costPerCompletedTaskUsd, null);
  assert.equal(report.tokensPerCompletedTask, null);
  assert.deepEqual(report.issues, ["attempt_cardinality_mismatch"]);
});

test("task economics never reports favorable zero totals for no attempts", () => {
  const report = summarizeCodingTaskAttempts([], { expectedAttempts: 1 });

  assert.equal(report.status, "incomplete_evidence");
  assert.equal(report.attempted, 0);
  assert.equal(report.completed, 0);
  assert.equal(report.completionRate, null);
  assert.equal(report.totalCostUsd, null);
  assert.equal(report.costPerCompletedTaskUsd, null);
  assert.equal(report.priceBasis, null);
  assert.equal(report.totalTokens, null);
  assert.equal(report.tokensPerCompletedTask, null);
  assert.equal(report.usageBasis, null);
  assert.deepEqual(report.issues, ["attempt_cardinality_mismatch", "no_attempts"]);
});

test("task economics refuses favorable numbers from missing or mixed evidence", () => {
  const missing = summarizeCodingTaskAttempts([{
    taskId: "task-a",
    attemptId: "1",
    provider: "zai",
    model: "glm-5.2-fp8",
    completed: true,
    completionBasis: "missing",
    costUsd: null,
    priceBasis: "unpriced",
    tokens: null,
    usageBasis: "unavailable",
  }]);
  assert.equal(missing.status, "incomplete_evidence");
  assert.equal(missing.completionRate, null);
  assert.equal(missing.totalCostUsd, null);
  assert.equal(missing.costPerCompletedTaskUsd, null);
  assert.equal(missing.tokensPerCompletedTask, null);

  const noCompleted = summarizeCodingTaskAttempts([{
    taskId: "task-b",
    attemptId: "1",
    provider: "zai",
    model: "glm-5.2-fp8",
    completed: false,
    completionBasis: "external_verifier",
    costUsd: 0.4,
    priceBasis: "public_catalog",
    tokens: 400,
    usageBasis: "provider_reported",
  }]);
  assert.equal(noCompleted.status, "no_completed_tasks");
  assert.equal(noCompleted.totalCostUsd, 0.4);
  assert.equal(noCompleted.costPerCompletedTaskUsd, null);
  assert.equal(noCompleted.tokensPerCompletedTask, null);

  const mixed = summarizeCodingTaskAttempts([
    {
      taskId: "task-c",
      attemptId: "1",
      provider: "zai",
      model: "glm-5.2-fp8",
      completed: true,
      completionBasis: "external_verifier",
      costUsd: 0.1,
      priceBasis: "provider_invoice",
      tokens: 100,
      usageBasis: "provider_reported",
    },
    {
      taskId: "task-c",
      attemptId: "2",
      provider: "zai",
      model: "glm-5.2-fp8",
      completed: true,
      completionBasis: "external_verifier",
      costUsd: 0.1,
      priceBasis: "public_catalog",
      tokens: 100,
      usageBasis: "provider_reported",
    },
  ]);
  assert.equal(mixed.status, "incomplete_evidence");
  assert.equal(mixed.costPerCompletedTaskUsd, null);
  assert.deepEqual(mixed.issues, ["price_basis_mixed"]);
});

test("a coding turn keeps working past the 64-call run default", async () => {
  await withWorkspace(async (workspace) => {
    const codingAgent = createCodingAgent({ workspace, model: "anthropic/faux-1" });
    const session = await startCodingSession(codingAgent, { cave: "off" });
    const faux = fauxAnthropic();
    const model = { ...faux.getModel(), api: "anthropic-messages", provider: "anthropic" };
    const steps = 70;
    faux.setResponses([
      ...Array.from({ length: steps }, (_, n) =>
        fauxAssistantMessage(fauxToolCall("bash", { command: `echo ${n}` }, { id: `bash-${n}` }))),
      fauxAssistantMessage("done"),
    ]);
    let calls = 0;
    const turn = await runCodingTurn(session, "count", {
      model,
      streamFn(selected, context, options) {
        calls++;
        return faux.provider.streamSimple(selected, context, options);
      },
    });
    assert.equal(calls, steps + 1);
    assert.equal(turn.toolCalls.length, steps);
    assert.equal(turn.text, "done");
  });
});
