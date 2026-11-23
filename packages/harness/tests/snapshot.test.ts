/**
 * trace.finish_snapshot (src/snapshot.ts): the workspace at the first finish
 * attempt, taken before any harness continuation is sent, at most once, off by
 * default, with a size guard, never failing the run, and never changing a
 * request body. Loopback runs on LocalEnv; the remote (Docker) path is the
 * same ExecEnv calls, exercised here on a fake env with ranged reads.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LocalEnv } from "../src/env/local.ts";
import type { ExecEnv, ExecOptions, ExecResult, ReadRange } from "../src/env/types.ts";
import { BUILTIN_LOADOUTS, LoadoutError, loadoutHash, normalizeLoadout, readLoadout, type Loadout } from "../src/loadout.ts";
import {
  FinishSnapshot, insideOf, parseSnapshotOutput, snapshotScript, SNAPSHOT_FILE, type FirstFinish,
} from "../src/snapshot.ts";
import { EXEC_SCENARIO, runScripted, stableBody, type Step } from "./openai-loopback.ts";

const here = dirname(fileURLToPath(import.meta.url));
const loadoutDir = join(here, "..", "loadouts");
const BUNDLE = join(here, "..", "dist", "harness.mjs");
const P1 = readLoadout(join(loadoutDir, "compact-v0-plain-p1.json")).loadout;
const CONTROL = readLoadout(join(loadoutDir, "compact-v0-plain.json")).loadout;

const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
const events = (tracePath: string) => readFileSync(tracePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);

/** The tarball's files as {relative path: content}. */
function untar(tgz: string): Record<string, string> {
  const out = tempDir("harness-snap-x-");
  execFileSync("tar", ["-xzf", tgz, "-C", out]);
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n").filter(Boolean)) {
      const path = join(dir, name);
      if (execFileSync("sh", ["-c", `[ -d '${path}' ] && echo d || echo f`], { encoding: "utf8" }).trim() === "d") walk(path, `${prefix}${name}/`);
      else files[`${prefix}${name}`] = readFileSync(path, "utf8");
    }
  };
  walk(out, "");
  return files;
}

const write = (path: string, content: string): Step => ({ tool: "write", args: { path, content } });
/** Change a file, try to finish (P1 fires: no check after the change), change it again, finish. */
const GATED: Step[] = [write("a.txt", "first\n"), { text: "Done." }, write("a.txt", "second\n"), { text: "Done, checked." }];

function withResult() {
  const dir = tempDir("harness-snap-res-");
  return { dir, resultPath: join(dir, "result.json") };
}

test("fired: the snapshot is the workspace at the first finish attempt, taken before the evidence gate's continuation is sent", async () => {
  const { dir, resultPath } = withResult();
  const run = await runScripted(P1, GATED, { finishSnapshot: { mode: "fired" }, resultPath });
  assert.equal(run.result.status, "finished");
  assert.equal(run.bodies.length, 4);
  assert.equal(readFileSync(join(run.cwd, "a.txt"), "utf8"), "second\n", "the run went on after the continuation");
  const ff = run.result.first_finish!;
  assert.equal(ff.mode, "fired");
  assert.equal(ff.request_index, 2);
  assert.deepEqual(ff.levers_pending, ["evidence_gate"]);
  assert.equal(ff.cwd, run.cwd);
  assert.equal(ff.skipped, undefined);
  assert.equal(ff.path, join(dir, SNAPSHOT_FILE), "copied next to result.json");
  assert.equal(ff.env_path, undefined, "the env's copy is removed once the host copy is verified");
  const bytes = readFileSync(ff.path!);
  assert.equal(ff.bytes, bytes.length);
  assert.equal(ff.sha256, sha(bytes));
  assert.deepEqual(untar(ff.path!), { "a.txt": "first\n" }, "the state the model tried to finish with, not the final one");
  const written = JSON.parse(readFileSync(resultPath, "utf8"));
  assert.deepEqual(written.first_finish, ff);
  // Order in the trace: the snapshot, then the continuation's request (the third).
  const trace = events(run.tracePath);
  const tar = trace.findIndex((event) => event.type === "snapshot" && event.stage === "tar");
  const gate = trace.findIndex((event) => event.type === "policy" && event.reason === "evidence_gate");
  const third = trace.filter((event) => event.type === "request_start")[2];
  assert.ok(gate >= 0 && tar > gate && tar < trace.indexOf(third!), "after the gate decided, before the next request");
  assert.equal(trace.filter((event) => event.type === "snapshot").length, 1, "at most once");
  assert.equal(trace.find((event) => event.type === "run_start")!.finish_snapshot, "fired");
  assert.deepEqual(trace.find((event) => event.type === "first_finish")!.levers_pending, ["evidence_gate"]);
});

test("request bodies are byte-identical with the snapshot on and off (fired, always, failed)", async () => {
  const off = await runScripted(P1, GATED);
  assert.equal(off.result.first_finish, undefined, "off by default");
  assert.equal(events(off.tracePath).some((event) => event.type === "snapshot" || event.type === "first_finish"), false);
  const norm = (run: { bodies: Record<string, any>[]; cwd: string }) => run.bodies.map((body) => stableBody(body, run.cwd));
  for (const mode of ["fired", "always"] as const) {
    const on = await runScripted(P1, GATED, { finishSnapshot: { mode, dir: tempDir("harness-snap-dir-") } });
    assert.equal(on.result.first_finish?.skipped, undefined, mode);
    assert.deepEqual(norm(on), norm(off), mode);
  }
  const failing = await runScripted(P1, GATED, { finishSnapshot: { mode: "fired", dir: tempDir("harness-snap-dir-") }, makeEnv: (cwd) => new FailingEnv({ cwd }) });
  assert.equal(failing.result.status, "finished", "a failed snapshot never fails the run");
  assert.equal(failing.result.first_finish?.skipped, "failed");
  assert.match(failing.result.first_finish?.error ?? "", /internal exec refused/u);
  assert.deepEqual(norm(failing), norm(off));
  // The exec surface, P4: the audit continues the hedged final answer.
  const p4 = readLoadout(join(loadoutDir, "exec-v0-p4.json")).loadout;
  const execOff = await runScripted(p4, EXEC_SCENARIO, { setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n") });
  const execOn = await runScripted(p4, EXEC_SCENARIO, { setup: (cwd) => writeFileSync(join(cwd, "a.txt"), "x\n"), finishSnapshot: { mode: "fired", dir: tempDir("harness-snap-dir-") } });
  assert.equal(execOn.bodies.length, EXEC_SCENARIO.length + 1);
  assert.deepEqual(execOn.result.first_finish?.levers_pending, ["finish_audit"]);
  assert.equal(execOn.result.first_finish?.request_index, EXEC_SCENARIO.length);
  assert.deepEqual(norm(execOn), norm(execOff));
});

class FailingEnv extends LocalEnv {
  override async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    if (options?.internal === true) throw new Error("internal exec refused");
    return await super.exec(command, options);
  }
}

test("fired: a first finish attempt nothing continues ends the run and is recorded not_fired, with no tarball", async () => {
  const { dir, resultPath } = withResult();
  const run = await runScripted(P1, [{ text: "Nothing to change." }], { finishSnapshot: { mode: "fired" }, resultPath });
  assert.equal(run.bodies.length, 1);
  assert.deepEqual(run.result.first_finish, { mode: "fired", request_index: 1, levers_pending: [], cwd: run.cwd, skipped: "not_fired" });
  assert.equal(existsSync(join(dir, SNAPSHOT_FILE)), false);
});

test("always: a control arm (no finish levers) snapshots its first finish attempt, which is its final state", async () => {
  const { dir, resultPath } = withResult();
  const run = await runScripted(CONTROL, [write("sub/b.txt", "x\n"), { text: "Done." }], { finishSnapshot: { mode: "always" }, resultPath });
  assert.equal(run.bodies.length, 2);
  const ff = run.result.first_finish!;
  assert.deepEqual([ff.mode, ff.request_index, ff.levers_pending, ff.skipped], ["always", 2, [], undefined]);
  assert.equal(ff.path, join(dir, SNAPSHOT_FILE));
  assert.deepEqual(untar(ff.path!), { "sub/b.txt": "x\n" });
});

test("always on a run that never tries to finish: no_finish_attempt", async () => {
  const run = await runScripted(CONTROL, [write("a.txt", "1"), write("a.txt", "2"), write("a.txt", "3")], {
    finishSnapshot: { mode: "always", dir: tempDir("harness-snap-dir-") }, budgets: { requests: 2 },
  });
  assert.equal(run.result.stop_reason, "budget_requests");
  assert.deepEqual(run.result.first_finish, { mode: "always", cwd: run.cwd, skipped: "no_finish_attempt" });
});

test("size guard: a cwd over the limit is skipped and traced, the run goes on", async () => {
  const { dir, resultPath } = withResult();
  const run = await runScripted(CONTROL, [{ text: "Done." }], {
    finishSnapshot: { mode: "always", maxMb: 1 }, resultPath, setup: (cwd) => writeFileSync(join(cwd, "big.bin"), randomBytes(2 * 1024 * 1024)),
  });
  assert.equal(run.result.status, "finished");
  const ff = run.result.first_finish!;
  assert.equal(ff.skipped, "too_large");
  assert.ok((ff.cwd_bytes ?? 0) > 1024 * 1024, `cwd_bytes ${ff.cwd_bytes}`);
  assert.equal(ff.path, undefined);
  assert.equal(existsSync(join(dir, SNAPSHOT_FILE)), false);
  const skip = events(run.tracePath).find((event) => event.type === "snapshot")!;
  assert.deepEqual([skip.stage, skip.reason, skip.max_bytes], ["skip", "too_large", 1024 * 1024]);
});

test("the loadout's trace.finish_snapshot turns it on without a flag; the flag's mode wins over the loadout's", async () => {
  const always = normalizeLoadout({ ...(structuredClone(BUILTIN_LOADOUTS["compact-v0-plain"]) as Record<string, unknown>), name: "snap", trace: { finish_snapshot: "always", snapshot_max_mb: 50 } });
  assert.deepEqual(always.trace, { finish_snapshot: "always", snapshot_max_mb: 50 });
  const run = await runScripted(always, [{ text: "Done." }], { finishSnapshot: { dir: tempDir("harness-snap-dir-") } });
  assert.equal(run.result.first_finish?.mode, "always");
  assert.equal(run.result.first_finish?.skipped, undefined);
  const flagged = await runScripted(always, [{ text: "Done." }], { finishSnapshot: { mode: "fired", dir: tempDir("harness-snap-dir-") } });
  assert.equal(flagged.result.first_finish?.skipped, "not_fired");
});

test("loadout: trace.finish_snapshot is fired|always, snapshot_max_mb a positive integer; a loadout without them hashes as before", () => {
  const base = structuredClone(BUILTIN_LOADOUTS["exec-v0"]) as Record<string, any>;
  assert.throws(() => normalizeLoadout({ ...base, trace: { finish_snapshot: "sometimes" } }), LoadoutError);
  assert.throws(() => normalizeLoadout({ ...base, trace: { snapshot_max_mb: 0 } }), LoadoutError);
  assert.equal(loadoutHash(normalizeLoadout({ ...base, trace: {} })), loadoutHash(normalizeLoadout(base)));
  assert.deepEqual(normalizeLoadout({ ...base, trace: { cache_monitor: true, finish_snapshot: "fired" } }).trace, { cache_monitor: true, finish_snapshot: "fired" });
});

test("LocalEnv: an internal command's handle comes from its own sequence, so the model's handles number the same", async () => {
  const env = new LocalEnv({ cwd: tempDir("harness-snap-ids-") });
  try {
    await env.exec("true", { internal: true });
    const internal = await env.exec("sleep 5", { internal: true, background: true });
    assert.equal(internal.handle, "h2");
    const visible = await env.exec("sleep 5", { background: true });
    assert.equal(visible.handle, "p1");
  } finally {
    await env.close();
  }
});

test("snapshotScript on a real shell: measures, tars the cwd (excluding a scratch dir inside it), prints size and sha256", async () => {
  const cwd = tempDir("harness-snap-sh-");
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, ".scratch"));
  writeFileSync(join(cwd, "src", "x.py"), "print(1)\n");
  writeFileSync(join(cwd, ".scratch", "spill.log"), "noise\n");
  const out = join(cwd, ".scratch", "snap.tgz");
  assert.equal(insideOf(cwd, join(cwd, ".scratch")), "./.scratch");
  assert.equal(insideOf(cwd, "/tmp/elsewhere"), undefined);
  assert.equal(insideOf(cwd, cwd), undefined);
  const output = execFileSync("sh", ["-c", snapshotScript(cwd, out, 1024, "./.scratch")], { encoding: "utf8" });
  const facts = parseSnapshotOutput(output);
  assert.equal(facts.tar_exit, "0");
  assert.equal(Number(facts.bytes), readFileSync(out).length);
  assert.equal(facts.sha256, sha(readFileSync(out)));
  assert.ok(Number(facts.cwd_kb) > 0);
  assert.deepEqual(untar(out), { "src/x.py": "print(1)\n" });
  const tiny = parseSnapshotOutput(execFileSync("sh", ["-c", snapshotScript(cwd, join(tmpdir(), "never.tgz"), 0)], { encoding: "utf8" }));
  assert.equal(tiny.skip, "too_large");
});

/** A remote env like Docker as the snapshot sees it: one exec, then ranged reads of a file it holds in memory. */
class FakeRemoteEnv implements ExecEnv {
  readonly id = "docker:fake";
  readonly cwd = "/app";
  readonly execs: { command: string; options: ExecOptions | undefined }[] = [];
  readonly reads: ReadRange[] = [];
  private readonly file: Uint8Array;
  private readonly facts: string;
  private readonly readHook: ((range: ReadRange) => Uint8Array | undefined) | undefined;
  constructor(file: Uint8Array, facts: string, readHook?: (range: ReadRange) => Uint8Array | undefined) {
    this.file = file;
    this.facts = facts;
    this.readHook = readHook;
  }
  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ command, options });
    const output = command.startsWith("rm -f") ? "" : this.facts;
    return { exitCode: 0, output, truncated: false, durationMs: 1, totalBytes: output.length, running: false };
  }
  async readFile(_path: string, range?: ReadRange): Promise<Uint8Array> {
    this.reads.push(range ?? {});
    const hooked = range === undefined ? undefined : this.readHook?.(range);
    if (hooked !== undefined) return hooked;
    const offset = range?.offset ?? 0;
    return this.file.subarray(offset, range?.length === undefined ? undefined : offset + range.length);
  }
  async scratchDir() { return "/tmp/harness-fake"; }
  resolvePath(path: string) { return path.startsWith("/") ? path : `${this.cwd}/${path}`; }
  async poll(): Promise<ExecResult> { throw new Error("unused"); }
  async wait(): Promise<ExecResult> { throw new Error("unused"); }
  async kill(): Promise<ExecResult> { throw new Error("unused"); }
  async writeFile() {}
  async stat() { return undefined; }
  async listDir() { return []; }
  async close() {}
}

const recorder = () => {
  const seen: { type: string; fields: Record<string, unknown> }[] = [];
  return { seen, event: (type: string, fields: Record<string, unknown> = {}) => void seen.push({ type, fields }) };
};

async function fakeSnapshot(file: Uint8Array, facts: string, options: { hook?: (range: ReadRange) => Uint8Array | undefined; levers?: string[] } = {}) {
  const env = new FakeRemoteEnv(file, facts, options.hook);
  const rec = recorder();
  const hostDir = tempDir("harness-snap-fake-");
  const snapshot = new FinishSnapshot({ env, recorder: rec, mode: "fired", hostDir, chunkBytes: 1000 });
  await snapshot.atFinishAttempt(7, options.levers ?? ["finish_audit"]);
  await snapshot.atFinishAttempt(9, ["finish_audit"]); // a later attempt: ignored
  const record: FirstFinish = await snapshot.settle();
  return { env, rec, hostDir, record };
}

test("remote env (fake Docker): one internal exec, the copy in ranged chunks, the sha256 checked, the env's tarball removed", async () => {
  const file = randomBytes(4500);
  const facts = `ffsnap_cwd_kb=12\nffsnap_tar_exit=0\nffsnap_bytes=4500\nffsnap_sha256=${sha(file)}\nffsnap_err=\n`;
  const { env, rec, hostDir, record } = await fakeSnapshot(file, facts);
  assert.deepEqual(env.reads, [0, 1000, 2000, 3000, 4000].map((offset) => ({ offset, length: offset === 4000 ? 500 : 1000 })));
  assert.ok(env.execs.every((call) => call.options?.internal === true), "every env call is internal");
  assert.equal(env.execs.length, 2, "the snapshot command, then rm of the env's copy");
  assert.match(env.execs[0]!.command, /cd '\/app'/u);
  assert.match(env.execs[0]!.command, /tar -czf '\/tmp\/harness-fake\/first-finish\.tgz' \./u);
  assert.match(env.execs[1]!.command, /^rm -f '\/tmp\/harness-fake\/first-finish\.tgz'$/u);
  assert.deepEqual(readFileSync(join(hostDir, SNAPSHOT_FILE)), Buffer.from(file));
  assert.deepEqual(record, {
    mode: "fired", request_index: 7, levers_pending: ["finish_audit"], cwd: "/app", path: join(hostDir, SNAPSHOT_FILE), bytes: 4500,
    cwd_bytes: 12 * 1024, sha256: sha(file), tar_ms: record.tar_ms, copy_ms: record.copy_ms,
  });
  assert.deepEqual(rec.seen.map((event) => event.type), ["snapshot", "first_finish"]);
});

test("remote env failures: a sha256 mismatch, a short read, tar exit 2, a missing tarball; tar exit 1 is a warning", async () => {
  const file = randomBytes(2500);
  const ok = (extra: string) => `ffsnap_cwd_kb=3\n${extra}`;
  const mismatch = await fakeSnapshot(file, ok(`ffsnap_tar_exit=0\nffsnap_bytes=2500\nffsnap_sha256=${"0".repeat(64)}\n`));
  assert.equal(mismatch.record.skipped, "failed");
  assert.match(mismatch.record.error ?? "", /copy sha256/u);
  assert.equal(existsSync(join(mismatch.hostDir, SNAPSHOT_FILE)), false);
  assert.equal(mismatch.record.path, undefined);
  const short = await fakeSnapshot(file, ok("ffsnap_tar_exit=0\nffsnap_bytes=2500\n"), { hook: (range) => (range.offset === 2000 ? new Uint8Array(0) : undefined) });
  assert.match(short.record.error ?? "", /short read: 2000 of 2500/u);
  assert.equal(existsSync(join(short.hostDir, `${SNAPSHOT_FILE}.part`)), false);
  const tar2 = await fakeSnapshot(file, ok("ffsnap_tar_exit=2\nffsnap_bytes=10\nffsnap_err=tar: ./db: Cannot open: Permission denied\n"));
  assert.deepEqual([tar2.record.skipped, tar2.record.error], ["failed", "tar exit 2: tar: ./db: Cannot open: Permission denied"]);
  assert.deepEqual(tar2.env.reads, []);
  const none = await fakeSnapshot(file, ok("ffsnap_tar_exit=0\nffsnap_err=tar: not found\n"));
  assert.match(none.record.error ?? "", /no tarball/u);
  const warned = await fakeSnapshot(file, ok(`ffsnap_tar_exit=1\nffsnap_bytes=2500\nffsnap_sha256=${sha(file)}\nffsnap_err=tar: ./log: file changed as we read it\n`));
  assert.equal(warned.record.skipped, undefined);
  assert.equal(warned.record.tar_warning, "tar: ./log: file changed as we read it");
  const big = await fakeSnapshot(file, "ffsnap_cwd_kb=999999999\nffsnap_skip=too_large\n");
  assert.deepEqual([big.record.skipped, big.env.reads.length], ["too_large", 0]);
  const noSha = await fakeSnapshot(file, ok("ffsnap_tar_exit=0\nffsnap_bytes=2500\nffsnap_sha256=\n"));
  assert.equal(noSha.record.sha256, sha(file), "no sha256 tool in the env: the host computes it");
});

function harness(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BUNDLE, ...args], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stderr }));
  });
}

test("CLI (bundle): --finish-snapshot always --snapshot-dir writes the tarball there and first_finish in result.json; a bad mode is exit 2", async () => {
  const root = tempDir("harness-snap-cli-");
  const ws = join(root, "ws");
  mkdirSync(ws);
  writeFileSync(join(ws, "notes.txt"), "hello\n");
  writeFileSync(join(root, "prompt.txt"), "Say done.");
  writeFileSync(join(root, "faux.json"), JSON.stringify({ steps: [{ text: "Done." }] }));
  const common = ["run", "--prompt-file", join(root, "prompt.txt"), "--model", "faux/scripted", "--effort", "high", "--loadout", "compact-v0",
    "--env", `local:${ws}`, "--trace", join(root, "trace.jsonl"), "--result", join(root, "result.json"), "--faux-script", join(root, "faux.json")];
  const out = await harness([...common, "--finish-snapshot", "always", "--snapshot-dir", join(root, "snap")]);
  assert.equal(out.code, 0, out.stderr);
  const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  assert.equal(result.first_finish.path, join(root, "snap", SNAPSHOT_FILE));
  assert.deepEqual(untar(result.first_finish.path), { "notes.txt": "hello\n" });
  const bad = await harness([...common, "--finish-snapshot", "sometimes"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /--finish-snapshot wants one of fired, always/u);
});
