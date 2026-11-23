/**
 * MCP servers (src/mcp.ts) and the program tool (src/tools/program.ts): tools listed once and named <server>__<tool>;
 * direct tools pass results and errors through; a program loops over connector calls with Promise.all and only its
 * printed output returns; budgets (calls, concurrency, time), the output cap with its spill file, script errors, and
 * the sandbox functions; the loadout rules for mcp.exposure.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalEnv } from "../src/env/local.ts";
import { normalizeLoadout } from "../src/loadout.ts";
import { connectMcp, mcpDirectTools, type McpSession } from "../src/mcp.ts";
import { buildTools } from "../src/run.ts";
import { DEFAULT_PROGRAM_LIMITS, callLedger, programDescription, programTool } from "../src/tools/program.ts";
import { appLoadouts } from "../src/app-loadouts.ts";

const SERVER = fileURLToPath(new URL("./fixtures/mcp-items.mjs", import.meta.url));
const sessions: McpSession[] = [];
after(async () => {
  await Promise.all(sessions.map((session) => session.close()));
});

async function connect(): Promise<McpSession> {
  const session = await connectMcp({ items: { command: process.execPath, args: [SERVER] } });
  sessions.push(session);
  return session;
}

const env = () => new LocalEnv({ cwd: realpathSync(mkdtempSync(join(tmpdir(), "harness-program-"))) });
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((item) => item.text ?? "").join("");

test("MCP tools are listed once in name order as <server>__<tool>; direct tools return text and throw on MCP errors", async () => {
  const session = await connect();
  assert.deepEqual(session.tools.map((tool) => tool.qualified), ["items__boom", "items__get_item", "items__list_items", "items__update_item"]);
  const direct = mcpDirectTools(session.tools);
  const get = direct.find((tool) => tool.name === "items__get_item")!;
  const got = await get.execute("c1", { id: 3 } as never);
  assert.match(textOf(got as never), /"title":"Item 3"/u);
  const boom = direct.find((tool) => tool.name === "items__boom")!;
  await assert.rejects(boom.execute("c2", {} as never), /boom failed/u);
});

test("a program pages through a connector, updates in parallel, retries a transient failure, and returns only what it prints", async () => {
  const session = await connect();
  const tool = programTool(env(), session.tools, DEFAULT_PROGRAM_LIMITS);
  const code = `
    let cursor = 0, approved = [];
    while (cursor !== null) {
      const page = await tools.items__list_items({ cursor });
      approved.push(...page.items.filter((item) => item.status === "approved"));
      cursor = page.next_cursor;
    }
    const results = await Promise.allSettled(approved.map((item) => tools.items__update_item({ id: item.id, status: "backlog" })));
    const failed = approved.filter((_, i) => results[i].status === "rejected");
    for (const item of failed) await tools.items__update_item({ id: item.id, status: "backlog" });
    const check = await Promise.all(approved.map((item) => tools.items__get_item({ id: item.id })));
    print({ moved: approved.length, retried: failed.map((item) => item.id), all_backlog: check.every((item) => item.status === "backlog") });
  `;
  const result = await tool.execute("p1", { code } as never);
  const text = textOf(result as never);
  assert.match(text, /"moved": 20/u);
  assert.match(text, /"retried": \[\s*7\s*\]/u);
  assert.match(text, /"all_backlog": true/u);
  assert.match(text, /\[program finished: 44 tool calls, [\d.]+ s\]$/u, "3 pages + 20 updates + 1 retry + 20 checks");
  assert.doesNotMatch(text, /x{50}/u, "item bodies never reach the model unless printed");
});

test("budgets: the call budget stops a runaway loop, concurrency caps parallel calls, the timeout ends the program", async () => {
  const session = await connect();
  const limited = programTool(env(), session.tools, { ...DEFAULT_PROGRAM_LIMITS, max_calls: 5 });
  const runaway = textOf(await limited.execute("p2", { code: "for (let i = 1; i <= 10; i++) await tools.items__get_item({ id: i }); print('unreached');" } as never) as never);
  assert.match(runaway, /program budget: 5 tool calls used/u);
  assert.match(runaway, /\[program failed: 5 tool calls, [\d.]+ s; the program reached its 5 tool-call budget\]/u);
  assert.doesNotMatch(runaway, /unreached/u);

  const workEnv = env();
  const gated = programTool(workEnv, [], { ...DEFAULT_PROGRAM_LIMITS, concurrency: 2 });
  const code = `
    const started = Date.now();
    const runs = await Promise.all([1, 2, 3, 4].map((i) => bash({ command: "sleep 0.4; echo " + i })));
    print(runs.map((run) => run.output.trim()).join(","), Date.now() - started >= 750 ? "serialized-in-pairs" : "too-parallel");
  `;
  assert.match(textOf(await gated.execute("p3", { code } as never) as never), /1,2,3,4 serialized-in-pairs/u);

  const slow = programTool(env(), [], { ...DEFAULT_PROGRAM_LIMITS, timeout_s: 1 });
  const timedOut = textOf(await slow.execute("p4", { code: "print('before'); await bash({ command: 'sleep 5' }); print('after');" } as never) as never);
  assert.match(timedOut, /^before\n/u, "output printed before the timeout is kept");
  assert.doesNotMatch(timedOut, /^after$/mu);
  assert.match(timedOut, /Execution timed out after 1000 ms\nTool calls before it stopped:\n- bash: 1 did not finish\nA call that did not finish may still have changed something: check before you repeat it\.\n\[program failed:/u);
});

test("sandbox functions; a script error is reported with the output so far; long output keeps head and tail and spills to a file", async () => {
  const workEnv = env();
  const tool = programTool(workEnv, [], { ...DEFAULT_PROGRAM_LIMITS, max_output_bytes: 2000 });
  const files = `
    await write({ path: "a.txt", content: "hello world\\nline 2\\n" });
    const edited = await edit({ path: "a.txt", old_string: "world", new_string: "there" });
    const text = await read({ path: "a.txt" });
    const run = await bash({ command: "wc -l < a.txt" });
    print(edited.replaced, JSON.stringify(text), run.exit_code, run.output.trim());
  `;
  const out = await tool.execute("p5", { code: files } as never);
  assert.match(textOf(out as never), /^1 "hello there\\nline 2\\n" 0 2\n/u);
  assert.equal((out as { details: { mutated?: boolean } }).details.mutated, true);

  const broken = textOf(await tool.execute("p6", { code: "print('so far'); null.boom;" } as never) as never);
  assert.match(broken, /so far\nError: .*TypeError/su);

  const long = await tool.execute("p7", { code: "for (let i = 0; i < 400; i++) print('row ' + i);" } as never);
  const longText = textOf(long as never);
  assert.match(longText, /^row 0\n/u);
  assert.match(longText, /row 399\n\[program finished/u);
  const spill = /the whole output is in (\S+) \.\.\./u.exec(longText)?.[1];
  assert.ok(spill !== undefined, longText.slice(0, 300));
  assert.equal(readFileSync(spill!, "utf8").split("\n").filter(Boolean).length, 400);
  assert.equal((long as { details: { truncated: boolean } }).details.truncated, true);
});

test("the description gives each connector tool a one-line signature; past the budget, names only; describe() returns a schema", async () => {
  const session = await connect();
  const description = programDescription(session.tools, DEFAULT_PROGRAM_LIMITS);
  assert.match(description, /^items__list_items\(\{cursor\?: integer\}\): List items, 25 a page\.$/mu);
  assert.match(description, /^items__update_item\(\{id: integer, status: string\}\): Set an item's status\.$/mu);
  assert.match(description, /^items__boom\(\{\}\): Always fails\.$/mu);
  assert.ok(description.length < 1800, `description is ${description.length} chars`);
  const many = Array.from({ length: 120 }, (_, i) => ({ ...session.tools[2]!, qualified: `big__tool_${i}`, description: "x".repeat(100) }));
  const namesOnly = programDescription(many, DEFAULT_PROGRAM_LIMITS);
  assert.match(namesOnly, /Names: big__tool_0, big__tool_1,/u);
  assert.doesNotMatch(namesOnly, /cursor/u);
  const tool = programTool(env(), session.tools, DEFAULT_PROGRAM_LIMITS);
  const out = textOf(await tool.execute("p8", { code: "const d = await describe('items__list_items'); print(Object.keys(d.input_schema.properties));" } as never) as never);
  assert.match(out, /\[\s*"cursor"\s*\]/u);
});

test("loadouts: mcp.exposure direct normalizes away; program/both need the compact program tool", async () => {
  const base = { name: "t", surface: "compact", prompt: { sections: ["core.identity"] }, tools: { bash: { exposure: "eager" }, read: { exposure: "eager" } } };
  assert.equal(normalizeLoadout({ ...base, mcp: { exposure: "direct" } } as never).mcp, undefined);
  assert.deepEqual(normalizeLoadout({ ...base, mcp: { exposure: "program" } } as never).mcp, { exposure: "program" });
  const session = await connect();
  const noProgram = normalizeLoadout({ ...base, mcp: { exposure: "program" } } as never);
  assert.throws(() => buildTools(noProgram, env(), false, session.tools), /needs the program tool/u);
  const withProgram = normalizeLoadout({ ...base, tools: { ...base.tools, program: { exposure: "eager" } }, mcp: { exposure: "program" } } as never);
  const built = buildTools(withProgram, env(), false, session.tools);
  assert.deepEqual(built.tools.map((tool) => tool.name), ["bash", "program", "read"], "connector tools only inside the program");
  const both = normalizeLoadout({ ...base, tools: { ...base.tools, program: { exposure: "eager" } }, mcp: { exposure: "both" } } as never);
  assert.equal(buildTools(both, env(), false, session.tools).tools.length, 7);
  const withMcp = normalizeLoadout({ ...base, tools: { ...base.tools, program: { exposure: "with_mcp" } }, mcp: { exposure: "program" } } as never);
  assert.deepEqual(buildTools(withMcp, env(), false, []).tools.map((tool) => tool.name), ["bash", "read"], "no MCP servers: the coding tool set, unchanged");
  assert.deepEqual(buildTools(withMcp, env(), false, session.tools).tools.map((tool) => tool.name), ["bash", "program", "read"]);
  assert.throws(() => normalizeLoadout({ ...base, tools: { bash: { exposure: "with_mcp" } } } as never), /for the program tool only/u);
  const direct = normalizeLoadout(base as never);
  assert.deepEqual(buildTools(direct, env(), false, session.tools).tools.map((tool) => tool.name).slice(2), ["items__boom", "items__get_item", "items__list_items", "items__update_item"]);
});

test("with no sandbox a program reaches the world only through its tools: no bash, read, write or edit, no spill file", async () => {
  const session = await connect();
  const limits = { ...DEFAULT_PROGRAM_LIMITS, sandbox: false, max_output_bytes: 2000 };
  const description = programDescription(session.tools, limits);
  assert.match(description, /no shell and no filesystem/u);
  assert.doesNotMatch(description, /bash\(|read\(|write\(|edit\(/u);
  const workEnv = env();
  const tool = programTool(workEnv, session.tools, limits);
  for (const name of ["bash", "read", "write", "edit"]) {
    const out = textOf(await tool.execute(`ns-${name}`, { code: `print(typeof ${name});` } as never) as never);
    assert.match(out, /^undefined\n/u, `${name} must not exist in a program with no sandbox`);
  }
  const called = textOf(await tool.execute("ns-tool", { code: "const item = await tools.items__get_item({ id: 2 }); print(item.title);" } as never) as never);
  assert.match(called, /^Item 2\n\[program finished: 1 tool calls/u);
  const long = await tool.execute("ns-long", { code: "for (let i = 0; i < 400; i++) print('row ' + i);" } as never);
  const longText = textOf(long as never);
  assert.match(longText, /bytes cut \.\.\./u);
  assert.doesNotMatch(longText, /the whole output is in/u, "no spill file on the host");
  assert.deepEqual(readdirSync(await workEnv.scratchDir()).filter((name) => name.startsWith("program-")), []);
});

test("a program that fails or stops lists its calls by tool: finished, failed, and those that did not finish", async () => {
  const session = await connect();
  const tool = programTool(env(), session.tools, DEFAULT_PROGRAM_LIMITS);
  const failed = textOf(await tool.execute("l1", { code: "await tools.items__get_item({ id: 1 }); await tools.items__get_item({ id: 2 }); await tools.items__boom({});" } as never) as never);
  assert.match(failed, /Tool calls before it stopped:\n- items__get_item: 2 finished\n- items__boom: 1 failed\n\[program failed: 3 tool calls/u);
  const budget = programTool(env(), session.tools, { ...DEFAULT_PROGRAM_LIMITS, max_calls: 3 });
  const stopped = textOf(await budget.execute("l2", { code: "for (let i = 1; i <= 10; i++) await tools.items__get_item({ id: i });" } as never) as never);
  assert.match(stopped, /- items__get_item: 3 finished\n\[program failed: 3 tool calls/u);
  const fine = textOf(await tool.execute("l3", { code: "await tools.items__get_item({ id: 1 }); print('ok');" } as never) as never);
  assert.doesNotMatch(fine, /Tool calls before it stopped/u, "a program that finished lists nothing");
  assert.equal(callLedger([]), "");
  assert.equal(
    callLedger([{ name: "a__write", state: "done" }, { name: "a__write", state: "running" }, { name: "a__read", state: "queued" }]),
    "Tool calls before it stopped:\n- a__write: 1 finished, 1 did not finish\n- a__read: 1 did not finish\nA call that did not finish may still have changed something: check before you repeat it.\n",
  );
});

test("app-code: app-general plus a program with no sandbox, and every tool both direct and inside programs", async () => {
  const { code, general } = appLoadouts();
  assert.equal(code.name, "app-code");
  assert.deepEqual(code.mcp, { exposure: "both" });
  assert.deepEqual(code.policy, general.policy);
  assert.deepEqual(code.prompt, general.prompt);
  const session = await connect();
  const built = buildTools(code, env(), false, session.tools);
  assert.deepEqual(built.tools.map((tool) => tool.name), ["program", "items__boom", "items__get_item", "items__list_items", "items__update_item"]);
  const program = built.tools[0]!;
  assert.match(program.description, /no shell and no filesystem/u);
  const out = textOf(await program.execute("c1", { code: "print(typeof bash, (await tools.items__list_items({})).items.length);" } as never) as never);
  assert.match(out, /^undefined 25\n/u);
  assert.deepEqual(buildTools(general, env(), false, session.tools).tools.map((tool) => tool.name), ["items__boom", "items__get_item", "items__list_items", "items__update_item"], "app-general is unchanged");
});

test("exec surface: MCP tools are Codex's deferred mcp__ nested tools (in ALL_TOOLS, not the description) and return raw MCP results", async () => {
  const session = await connect();
  const { execSurface } = await import("../src/tools/exec/surface.ts");
  const { loadLoadout } = await import("../src/loadout.ts");
  const workEnv = env();
  const surface = execSurface({ env: workEnv, loadout: loadLoadout("exec-v0"), images: false, mcp: session.tools });
  try {
    const exec = surface.tools.find((tool) => tool.name === "exec")!;
    assert.doesNotMatch(exec.description, /mcp__items__/u, "deferred: not in the exec description");
    const run = async (code: string) => {
      const result = await exec.execute("e", (exec.prepareArguments?.(code) ?? code) as never);
      return textOf(result as never);
    };
    const listed = await run(`const t = ALL_TOOLS.find((x) => x.name === "mcp__items__list_items"); text(t.description);`);
    assert.match(listed, /List items, 25 a page\.\n\nexec tool declaration:\n```ts\ndeclare const tools: \{ mcp__items__list_items\(args: \{/u);
    assert.match(listed, /\): Promise<CallToolResult>; \};\n```/u);
    const got = await run(`const r = await tools.mcp__items__get_item({ id: 3 }); text(JSON.parse(r.content[0].text).title); text(r.isError === undefined);`);
    assert.match(got, /Item 3/u);
    assert.match(got, /true/u);
    const failed = await run(`const r = await tools.mcp__items__boom({}); text(JSON.stringify(r));`);
    assert.match(failed, /\{"content":\[\{"type":"text","text":"boom failed"\}\],"isError":true\}/u, "an MCP error is a result, not a throw");
  } finally {
    await surface.dispose();
  }
});

test("saved scripts: save_script compiles and stores a program; the next run lists it and run_script runs it with params", async () => {
  const { ScriptStore } = await import("../src/scripts.ts");
  const session = await connect();
  const store = new ScriptStore(realpathSync(mkdtempSync(join(tmpdir(), "harness-scripts-"))));
  const limits = { ...DEFAULT_PROGRAM_LIMITS, scripts: true };
  const first = programTool(env(), session.tools, limits, undefined, store);
  assert.match(first.description, /\(none saved yet\)/u);
  const bad = textOf(await first.execute("s0", { code: "await save_script({ name: 'x', description: 'd', code: 'let = ;' });" } as never) as never);
  assert.match(bad, /does not compile/u);
  const badName = textOf(await first.execute("s1", { code: "await save_script({ name: 'Bad Name', description: 'd', code: 'return 1;' });" } as never) as never);
  assert.match(badName, /`name` must match/u);
  const save = `
    print(await save_script({ name: "count_status", description: "Count items with a status. Pages through every item.",
      params: { status: "the status to count" },
      code: "let cursor = 0, n = 0; while (cursor !== null) { const p = await tools.items__list_items({ cursor }); n += p.items.filter((i) => i.status === params.status).length; cursor = p.next_cursor; } return n;" }));
  `;
  assert.match(textOf(await first.execute("s2", { code: save } as never) as never), /"saved": "count_status"/u);
  const second = programTool(env(), session.tools, limits, undefined, store);
  assert.match(second.description, /^count_status\(\{status\}\): Count items with a status\. Params: status: the status to count\.$/mu);
  const ran = textOf(await second.execute("s3", { code: "print(await run_script('count_status', { status: 'approved' }));" } as never) as never);
  assert.match(ran, /^20\n\[program finished: 3 tool calls/u);
  const missing = textOf(await second.execute("s4", { code: "await run_script('nope');" } as never) as never);
  assert.match(missing, /no saved script "nope"; saved: count_status/u);
  const off = programTool(env(), session.tools, DEFAULT_PROGRAM_LIMITS, undefined, store);
  assert.doesNotMatch(off.description, /Saved scripts/u, "limits.scripts false: no scripts");
});

test("ask(): one side call per prompt, in parallel under the concurrency gate, JSON parsed on request; off unless limits.ask", async () => {
  const prompts: string[] = [];
  let live = 0, peak = 0;
  const ask = async (prompt: string, { json }: { json: boolean }) => {
    prompts.push(prompt);
    live++;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setTimeout(resolve, 30));
    live--;
    return json ? "```json\n{\"android_only\": " + String(prompt.includes("Pixel")) + "}\n```" : `len ${prompt.length}`;
  };
  const tool = programTool(env(), [], { ...DEFAULT_PROGRAM_LIMITS, ask: true, concurrency: 3 }, undefined, undefined, ask);
  assert.match(tool.description, /ask\(prompt, \{json\}\)/u);
  const code = `
    const items = ["crash on Pixel 8", "crash on iPhone", "Pixel only", "both", "Pixel 9", "iPad"];
    const answers = await Promise.all(items.map((text) => ask("Does this only affect Android? " + text, { json: true })));
    print(answers.filter((a) => a.android_only).length, await ask("plain"));
  `;
  const out = textOf(await tool.execute("a1", { code } as never) as never);
  assert.match(out, /^3 len 5\n\[program finished: 7 tool calls/u);
  assert.equal(prompts.length, 7);
  assert.ok(peak <= 3, `peak ${peak} parallel asks`);
  const bad = programTool(env(), [], { ...DEFAULT_PROGRAM_LIMITS, ask: true }, undefined, undefined, async () => "not json");
  assert.match(textOf(await bad.execute("a2", { code: "await ask('x', { json: true });" } as never) as never), /the answer is not JSON: not json/u);
  const off = programTool(env(), [], DEFAULT_PROGRAM_LIMITS, undefined, undefined, ask);
  assert.doesNotMatch(off.description, /ask\(prompt/u);
  assert.match(textOf(await off.execute("a3", { code: "await ask('x');" } as never) as never), /ask is not defined/u);
});

test("ask() in a run: the run's model and effort answer it, and its usage joins the run's totals as program_ask", async () => {
  const { runHarness } = await import("../src/run.ts");
  const { fauxStep } = await import("../src/models.ts");
  const workEnv = env();
  const loadout = normalizeLoadout({ name: "t", surface: "compact", prompt: { sections: ["core.identity"] },
    tools: { program: { exposure: "eager", limits: { ask: true } } } } as never);
  const systems: string[] = [];
  const result = await runHarness({
    prompt: "classify", model: "faux/scripted", effort: "high", loadout, env: workEnv,
    fauxSteps: [() => fauxStep({ toolCalls: [{ name: "program", arguments: { code: "print(await Promise.all([ask('a'), ask('b')]));" } }] }), () => fauxStep({ text: "done" })],
    askFauxSteps: [(context) => { systems.push(JSON.stringify(context.messages[0])); return fauxStep({ text: "yes" }); }, () => fauxStep({ text: "no" })],
  });
  assert.equal(result.status, "finished", JSON.stringify(result));
  assert.equal(result.side_requests?.program_ask?.requests, 2);
  assert.match(systems[0]!, /You answer one question/u);
  assert.equal(result.usage.requests, 2, "side calls are not agent-loop requests");
});
