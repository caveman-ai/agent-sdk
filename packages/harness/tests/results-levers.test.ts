/**
 * The R1-R3 lever flags on real tools over LocalEnv, each against its
 * default-off behavior:
 * - results.shaping (R1): bash, a wait that sees a command finish, and nested
 *   exec_command / write_stdin return the shaped view and spill the raw log;
 * - tools.wait.limits.until (R2): compact wait and exec's wait block until
 *   exit, a regex, a port or a file, with no model request while waiting;
 * - tools.read.limits.many and tools.exec.limits.aliases (R3): one read call
 *   (one env batch) for several files; sh() and read() in exec cells.
 * Off, every tool keeps its schema and description (the request bodies are
 * pinned in builtin-bodies.test.ts).
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalEnv } from "../src/env/local.ts";
import { BUILTIN_LOADOUTS, loadoutHash, normalizeLoadout, LoadoutError } from "../src/loadout.ts";
import { fauxStep } from "../src/models.ts";
import { runHarness } from "../src/run.ts";
import { compactTools } from "../src/tools/compact.ts";
import { execSurface } from "../src/tools/exec/surface.ts";
import { LineMatcher, parseUntil } from "../src/tools/wait-until.ts";

type Raw = Record<string, any>;
const builtin = (name: string, patch: (raw: Raw) => void = () => {}) => {
  const raw = structuredClone(BUILTIN_LOADOUTS[name]) as Raw;
  patch(raw);
  return normalizeLoadout(raw);
};
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("");

/** A pytest-looking run, as a script in the workdir (`sh ci.sh`): 120 passing lines, one failure with its assertion, the summary. */
const CI_SCRIPT = "for i in $(seq 1 120); do echo \"tests/test_m$i.py ........................................ [ $i%]\"; done\n" +
  "echo '=== FAILURES ==='; echo '___ test_add ___'; echo '>       assert add(1, 2) == 4'; echo 'E       assert 3 == 4'\n" +
  "echo 'tests/test_calc.py:12: AssertionError'; echo 'FAILED tests/test_calc.py::test_add - assert 3 == 4'; echo '=== 1 failed, 120 passed in 0.50s ==='; exit 1\n";
const PYTEST_SCRIPT = "sh ci.sh";

function compact(patch: (raw: Raw) => void = () => {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-levers-"));
  writeFileSync(join(dir, "ci.sh"), CI_SCRIPT);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const env = new LocalEnv({ cwd: dir });
  const counts = { readFiles: 0, readFile: 0 };
  const readFiles = env.readFiles.bind(env);
  const readFile = env.readFile.bind(env);
  env.readFiles = async (paths) => (counts.readFiles++, readFiles(paths));
  env.readFile = async (path, range) => (counts.readFile++, readFile(path, range));
  const loadout = builtin("compact-v0", patch);
  const tools = Object.fromEntries(compactTools({ env, loadout, images: true }).map((tool) => [tool.name, tool]));
  const call = async (name: string, args: Raw) => {
    const result = await tools[name]!.execute("t", args as never);
    return { text: textOf(result), details: result.details as Raw };
  };
  return { dir, env, tools, call, counts };
}

function exec(patch: (raw: Raw) => void = () => {}, files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-levers-exec-"));
  writeFileSync(join(dir, "ci.sh"), CI_SCRIPT);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const env = new LocalEnv({ cwd: dir });
  const surface = execSurface({ env, loadout: builtin("exec-v0", patch), images: true });
  const tools = Object.fromEntries(surface.tools.map((tool) => [tool.name, tool]));
  const call = async (name: string, args: unknown) => {
    const result = await tools[name]!.execute("t", (tools[name]!.prepareArguments?.(args) ?? args) as never);
    return { text: textOf(result), details: result.details as Raw };
  };
  return { dir, env, tools, call, async close() { await surface.dispose(); await env.close(); } };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

test("results: off normalizes away (same behavior_hash as omitting it); on fills defaults; bad values are refused", () => {
  const base = builtin("compact-v0");
  assert.equal(base.results, undefined);
  assert.equal(loadoutHash(builtin("compact-v0", (raw) => { raw.results = { shaping: "off", min_bytes: 999 }; })), loadoutHash(base));
  assert.deepEqual(builtin("compact-v0", (raw) => { raw.results = { shaping: "tests" }; }).results, { shaping: "tests", min_bytes: 2048, max_failures: 5, tail_lines: 20 });
  assert.deepEqual(builtin("exec-v0", (raw) => { raw.results = { shaping: "all", max_failures: 2 }; }).results, { shaping: "all", min_bytes: 2048, max_failures: 2, tail_lines: 20 });
  assert.throws(() => builtin("compact-v0", (raw) => { raw.results = { shaping: "some" }; }), LoadoutError);
  assert.throws(() => builtin("compact-v0", (raw) => { raw.results = { shaping: "tests", head_lines: 3 }; }), LoadoutError);
  assert.throws(() => builtin("compact-v0", (raw) => { raw.results = { min_bytes: 10 }; }), LoadoutError, "min_bytes >= 256");
  for (const [tool, key, name] of [["read", "many", "compact-v0"], ["wait", "until", "compact-v0"], ["exec", "aliases", "exec-v0"], ["wait", "until", "exec-v0"]] as const) {
    const loadout = builtin(name, (raw) => { raw.tools[tool].limits = { ...(raw.tools[tool].limits ?? {}), [key]: "yes" }; });
    const env = new LocalEnv({ cwd: mkdtempSync(join(tmpdir(), "harness-levers-bad-")) });
    assert.throws(() => (name === "exec-v0" ? execSurface({ env, loadout, images: false }) : compactTools({ env, loadout, images: false })), new RegExp(`tools\\.${tool}\\.limits\\.${key}: want boolean`, "u"));
  }
});

test("R1 off: bash returns a long test run as the head+tail cap shows it, unshaped", async () => {
  const { env, call } = compact();
  try {
    const out = await call("bash", { command: PYTEST_SCRIPT });
    assert.ok(out.text.includes("tests/test_m60.py"), "every progress line is there");
    assert.equal(out.details.shaped, undefined);
  } finally {
    await env.close();
  }
});

test("R1 on: bash shapes a test run, spills the raw log, and the trace detail names it", async () => {
  const { env, call } = compact((raw) => { raw.results = { shaping: "tests" }; });
  try {
    const out = await call("bash", { command: `cd . && ${PYTEST_SCRIPT}` });
    assert.equal((await call("bash", { command: `ls; ${PYTEST_SCRIPT}` })).details.shaped, undefined, "a listing in sequence: not shaped");
    assert.equal(out.details.shaped, "test:output", out.text);
    assert.equal(out.details.truncated, true);
    assert.equal(out.details.exitCode, 1);
    assert.match(out.text, /^\[harness: test output shaped \(output\): 1 failed, 120 passed; 1 failure with trace heads\. Raw: 127 lines, \d+ bytes; full log: (\S+)\]/u);
    for (const kept of ["E       assert 3 == 4", "FAILED tests/test_calc.py::test_add - assert 3 == 4", "Command exited with code 1"]) assert.ok(out.text.includes(kept), kept);
    assert.ok(!out.text.includes("tests/test_m60.py"));
    const log = readFileSync(out.details.spill, "utf8");
    assert.ok(log.includes("tests/test_m60.py") && log.includes("E       assert 3 == 4"), "the full log holds the raw output");
    assert.ok(out.text.includes(out.details.spill));
    const small = await call("bash", { command: "pytest --version 2>/dev/null || echo 'pytest 8.1'" });
    assert.equal(small.details.shaped, undefined, "under min_bytes stays raw");
  } finally {
    await env.close();
  }
});

test("R1 on: a test run that outlives bash's timeout is shaped when wait sees it finish", async () => {
  const { env, call } = compact((raw) => { raw.results = { shaping: "tests" }; });
  try {
    const started = await call("bash", { command: `sleep 1; ${PYTEST_SCRIPT}`, timeout: 0.2 });
    assert.ok(started.details.handle !== undefined);
    const done = await call("wait", { handle: started.details.handle, timeout: 20 });
    assert.equal(done.details.shaped, "test:output", done.text);
    assert.ok(done.text.includes("E       assert 3 == 4"));
  } finally {
    await env.close();
  }
});

test("R2 off: compact wait keeps its schema and description; until is not a parameter", () => {
  const { tools } = compact();
  const schema = tools.wait!.parameters as Raw;
  assert.deepEqual(Object.keys(schema.properties), ["handle", "timeout", "kill"]);
  assert.deepEqual(schema.required, ["handle"]);
  assert.ok(!tools.wait!.description.includes("until"));
});

test("R2: until conditions parse strictly; the line matcher sees a match split across chunks", () => {
  assert.deepEqual(parseUntil("exit"), { kind: "exit" });
  assert.equal(parseUntil("port:8080").kind, "port");
  assert.deepEqual(parseUntil("file: out/ready.txt"), { kind: "file", path: "out/ready.txt" });
  assert.equal((parseUntil("regex:Listening on \\d+") as { re: RegExp }).re.source, "Listening on \\d+");
  for (const bad of ["", "port:0", "port:70000", "port:http", "file:", "regex:", "regex:(", "soon"]) assert.throws(() => parseUntil(bad), /until/u, bad);
  const matcher = new LineMatcher(/server ready/u);
  assert.equal(matcher.feed("booting\nserver re"), false);
  assert.equal(matcher.feed("ady on 3000\n"), true);
});

test("R2 on: compact wait blocks until a regex, a file, a port or exit, and says how it went", async () => {
  const port = await freePort();
  const { dir, env, tools, call } = compact((raw) => { raw.tools.wait.limits.until = true; });
  try {
    assert.ok((tools.wait!.parameters as Raw).properties.until !== undefined);
    assert.equal((tools.wait!.parameters as Raw).required, undefined, "handle is optional for port:/file:");
    const server = await call("bash", { command: `echo booting; sleep 0.5; echo "server ready"; sleep 30`, timeout: 0.1 });
    let began = performance.now();
    const ready = await call("wait", { handle: server.details.handle, until: "regex:server ready" });
    assert.ok(performance.now() - began < 5_000);
    assert.match(ready.text, /^\[wait until regex \/server ready\/: met after \d+\.\ds\]\n/u);
    assert.ok(ready.text.includes("server ready") && ready.text.includes("Still running"), ready.text);
    assert.equal(ready.details.loopExempt, true);
    await call("wait", { handle: server.details.handle, kill: true });

    const writer = await call("bash", { command: "sleep 0.6; mkdir -p out; echo done > out/flag; sleep 30", timeout: 0.1 });
    const file = await call("wait", { handle: writer.details.handle, until: "file:out/flag" });
    assert.match(file.text, /^\[wait until file out\/flag: met after/u);
    await call("wait", { handle: writer.details.handle, kill: true });
    writeFileSync(join(dir, "later.sh"), "sleep 0.5; touch made.txt\n");
    await call("bash", { command: "sh later.sh", timeout: 0.05 });
    assert.match((await call("wait", { until: "file:made.txt" })).text, /^\[wait until file made\.txt: met after \d+\.\ds\]$/u, "no handle: the condition alone");

    const listener = `node -e "setTimeout(() => require('net').createServer().listen(${port}, '127.0.0.1'), 600); setTimeout(() => {}, 30000)"`;
    const listen = await call("bash", { command: listener, timeout: 0.1 });
    began = performance.now();
    const open = await call("wait", { handle: listen.details.handle, until: `port:${port}` });
    assert.match(open.text, new RegExp(`^\\[wait until port ${port}: met after`, "u"), open.text);
    assert.ok(performance.now() - began < 10_000);
    await call("wait", { handle: listen.details.handle, kill: true });

    const quick = await call("bash", { command: "sleep 0.3; echo finished; exit 3", timeout: 0.05 });
    const exited = await call("wait", { handle: quick.details.handle, until: "regex:never printed" });
    assert.match(exited.text, /^\[wait until regex \/never printed\/: not met; the process ended after/u);
    assert.ok(exited.text.includes("finished") && exited.text.includes("Command exited with code 3"));
    const slow = await call("bash", { command: "sleep 30", timeout: 0.05 });
    const timedOut = await call("wait", { handle: slow.details.handle, until: "exit", timeout: 0.5 });
    assert.match(timedOut.text, /^\[wait until exit: not met after 0\.\ds\]/u);
    await call("wait", { handle: slow.details.handle, kill: true });
    await assert.rejects(call("wait", { handle: slow.details.handle, until: "port:abc" }), /until must be/u);
    await assert.rejects(call("wait", { until: "regex:x" }), /a handle is needed/u);
  } finally {
    await env.close();
  }
});

test("R2 on: a run waits on a server with no model request while it waits (faux model, request count)", async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-levers-run-"));
  const env = new LocalEnv({ cwd: root });
  const trace = join(root, "trace.jsonl");
  const loadout = builtin("compact-v0", (raw) => { raw.tools.wait.limits.until = true; });
  try {
    const result = await runHarness({
      prompt: "Start the server and wait for it.", model: "faux/until", effort: "high", loadout, env, tracePath: trace,
      fauxSteps: [
        fauxStep({ toolCalls: [{ name: "bash", arguments: { command: "sleep 1.5; echo listening; sleep 30", timeout: 0.1 } }] }),
        fauxStep({ toolCalls: [{ name: "wait", arguments: { handle: "p1", until: "regex:listening" } }] }),
        fauxStep({ text: "Server is up." }),
      ],
    });
    assert.equal(result.status, "finished", JSON.stringify(result));
    const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "request_start").length, 3, "three requests: start, one wait, answer");
    const waitEnd = events.find((event) => event.type === "tool_end" && event.name === "wait");
    assert.ok(waitEnd.duration_ms >= 1_000, `the wait blocked in the harness (${waitEnd.duration_ms} ms)`);
  } finally {
    await env.close();
  }
});

test("R2 on: exec's wait blocks on a cell or an exec_command session until its condition", async () => {
  const off = exec();
  try {
    assert.deepEqual(Object.keys((off.tools.wait!.parameters as Raw).properties), ["cell_id", "max_tokens", "terminate", "yield_time_ms"]);
  } finally {
    await off.close();
  }
  const { tools, call, close } = exec((raw) => { raw.tools.wait.limits.until = true; });
  try {
    assert.ok(tools.wait!.description.includes("`until`"));
    const started = await call("exec", "// @exec: {\"yield_time_ms\": 2000}\nconst r = await tools.exec_command({ cmd: \"sleep 0.4; echo ready; sleep 30\", yield_time_ms: 250 });\ntext(JSON.stringify({ session: r.session_id }));");
    const session = JSON.parse(/\{"session":\d+\}/u.exec(started.text)![0]).session;
    const ready = await call("wait", { session_id: String(session), until: "regex:^ready$" });
    assert.match(ready.text, new RegExp(`^Session ${session} still running\\n\\[wait until regex /\\^ready\\$/: met after \\d+\\.\\ds\\]\\nWall time`, "u"), ready.text);
    assert.ok(ready.text.includes("ready"));
    assert.equal(ready.details.loopExempt, true);
    const capped = await call("wait", { session_id: session, until: "exit", yield_time_ms: 300 });
    assert.match(capped.text, /not met after 0\.\ds/u);
    await assert.rejects(call("wait", { session_id: 99, until: "exit" }), /session 99 not found/u);

    const cell = await call("exec", "// @exec: {\"yield_time_ms\": 100}\nawait tools.exec_command({ cmd: \"sleep 0.8\", yield_time_ms: 30000 });\ntext(\"cell finished\");");
    assert.match(cell.text, /^Script running with cell ID (\d+)/u);
    const id = /cell ID (\d+)/u.exec(cell.text)![1]!;
    const finished = await call("wait", { cell_id: id, until: "exit" });
    assert.match(finished.text, /^Script completed\nWall time [\d.]+ seconds\nOutput:\n\[wait until exit: met after \d+\.\ds\]\ncell finished/u, finished.text);
  } finally {
    await close();
  }
});

test("R3 off: read keeps its schema; paths is not a parameter", () => {
  const { tools } = compact();
  const schema = tools.read!.parameters as Raw;
  assert.deepEqual(Object.keys(schema.properties), ["path", "offset", "limit"]);
  assert.deepEqual(schema.required, ["path"]);
});

test("R3 on: read takes paths and ranges in one call and one env batch, errors inline, caps shared", async () => {
  const files = { "a.txt": "alpha\n", "b.txt": "one\ntwo\nthree\nfour\n", "big.txt": Array.from({ length: 3000 }, (_, index) => `line ${String(index).padStart(14, "0")}`).join("\n") };
  const { dir, env, tools, call, counts } = compact((raw) => { raw.tools.read.limits.many = true; }, files);
  try {
    mkdirSync(join(dir, "sub"));
    assert.ok(tools.read!.description.includes("pass paths instead of path"));
    const out = await call("read", { paths: ["a.txt", { path: "b.txt", offset: 2, limit: 2 }, "missing.txt", "sub", "big.txt", "a.txt"] });
    assert.equal(counts.readFiles, 1, "one batch (LocalEnv's batch reads each file itself)");
    assert.ok(out.text.startsWith("==> a.txt <==\nalpha\n"), out.text.slice(0, 200));
    assert.ok(out.text.includes("==> b.txt <==\ntwo\nthree\n\n[2 more lines in file. Use offset=4 to continue.]"));
    assert.ok(out.text.includes("==> missing.txt <==\n[File not found: missing.txt]"));
    assert.ok(out.text.includes("==> sub <==\n[sub is a directory. Use bash (ls) to list it.]"));
    assert.ok(out.text.includes("==> big.txt <==\n"));
    assert.match(out.text, /==> a\.txt <==\n\[Not shown: the call reached the 50KB output cap\. Read it in another call\.\]$/u);
    assert.equal(out.details.truncated, true);
    assert.ok(Buffer.byteLength(out.text) < 52 * 1024);
    const single = await call("read", { path: "a.txt" });
    assert.equal(single.text, "alpha\n", "a single path reads as before");
    await assert.rejects(call("read", {}), /pass path/u);
    await assert.rejects(call("read", { paths: Array.from({ length: 51 }, () => "a.txt") }), /at most 50/u);
  } finally {
    await env.close();
  }
});

test("R3 exec.aliases: off, sh and read are not defined and not described; on, they run, append and return", async () => {
  const off = exec();
  try {
    assert.ok(!off.tools.exec!.description.includes("`sh(cmd"));
    assert.match((await off.call("exec", "await sh(\"echo hi\");")).text, /sh is not defined/u);
  } finally {
    await off.close();
  }
  const { tools, call, close } = exec((raw) => { raw.tools.exec.limits.aliases = true; }, { "a.txt": "alpha\n", "b.txt": "1\n2\n3\n4" });
  try {
    assert.ok(tools.exec!.description.includes("- `sh(cmd: string"));
    assert.ok(tools.exec!.description.includes("- `read(path: string | string[]"));
    const out = await call("exec", [
      "await sh(\"echo hi\");",
      "const r = await sh(\"echo oops; exit 3\");",
      "await read([\"a.txt\", \"b.txt\"]);",
      "const mid = await read(\"b.txt\", { offset: 2, limit: 2 });",
      "text(`code=${r.exit_code} mid=${JSON.stringify(mid)}`);",
    ].join("\n"));
    assert.match(out.text, /^Script completed\n/u, out.text);
    assert.ok(out.text.includes("hi\noops\n[exit 3]\n==> a.txt <==\nalpha\n\n==> b.txt <==\n1\n2\n3\n4\n2\n3\ncode=3 mid=\"2\\n3\""), out.text);
    assert.match((await call("exec", "await read(\"nope.txt\");")).text, /read: no such file: nope\.txt/u);
    const line = await call("exec", "\n\nthrow new Error(\"line three\");");
    assert.match(line.text, /line three/u);
  } finally {
    await close();
  }
});

test("R1 on: nested exec_command shapes a finished test run; the cell's details name it", async () => {
  const { call, close } = exec((raw) => { raw.results = { shaping: "tests" }; });
  try {
    const out = await call("exec", `const r = await tools.exec_command({ cmd: ${JSON.stringify(PYTEST_SCRIPT)} });\ntext(r.output);\ntext("\\noriginal=" + r.original_token_count);`);
    assert.equal(out.details.shaped, "test:output", out.text);
    assert.match(out.text, /\[harness: test output shaped \(output\): 1 failed, 120 passed/u);
    assert.ok(out.text.includes("E       assert 3 == 4"));
    assert.ok(!out.text.includes("tests/test_m60.py"));
    const log = /full log: (\S+)\]/u.exec(out.text)![1]!;
    assert.ok(readFileSync(log, "utf8").includes("tests/test_m60.py"));
    assert.ok(Number(/original=(\d+)/u.exec(out.text)![1]) > 1000, "original_token_count is the raw size");
  } finally {
    await close();
  }
});
