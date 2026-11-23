/**
 * DockerEnv: the ExecEnv conformance suite, the tool suite and the exec surface
 * suite against one throwaway container this file starts (`docker run -d --rm`,
 * `sleep infinity`, removed in `after` whatever happens), plus the docker-only
 * cases and the bundle's `run` on it. Skipped unless HARNESS_DOCKER_TEST_IMAGE
 * names an image already pulled (no pull, no other container touched), so
 * `npm test` stays hermetic. The spec and user parsing tests always run.
 * Run: HARNESS_DOCKER_TEST_IMAGE=python:3.14-slim node --experimental-strip-types --no-warnings --test tests/docker.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DockerEnv } from "../src/env/docker.ts";
import { commandUser, createEnv } from "../src/env/index.ts";
import { parseEnvSpec } from "../src/env/types.ts";
import { execEnvConformance } from "./env-conformance.ts";
import { execSurfaceSuite } from "./exec-suite.ts";
import { toolSuite } from "./tool-suite.ts";

const IMAGE = process.env.HARNESS_DOCKER_TEST_IMAGE;
const skip = IMAGE === undefined || IMAGE === "" ? "HARNESS_DOCKER_TEST_IMAGE not set" : false;
const NAME = `harness-docker-test-${process.pid}`;
const NOINIT = `${NAME}-noinit`;
const HERE = dirname(fileURLToPath(import.meta.url));
let dirs = 0;

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (skip === false) {
  before(() => {
    // The image's own ENV plus a container-level one: both must reach commands with no --env-file.
    // --init: a killed process is reaped, so the suites' `kill -0` sees it gone (without an init it stays a zombie).
    docker("run", "-d", "--rm", "--init", "--name", NAME, "-e", "CONTAINER_VAR=from-run", "--entrypoint", "sleep", IMAGE!, "infinity");
    // Harbor's main service: `sh -c "sleep infinity"` as PID 1, which reaps nothing.
    docker("run", "-d", "--rm", "--name", NOINIT, "--entrypoint", "sh", IMAGE!, "-c", "sleep infinity");
  });
  after(() => {
    for (const name of [NAME, NOINIT]) {
      try {
        docker("rm", "-f", name);
      } catch {
        // already gone
      }
    }
  });
}

async function makeDocker(options: { noGroups?: boolean; user?: string; env?: Record<string, string> } = {}): Promise<DockerEnv> {
  const cwd = `/tmp/conf-${process.pid}-${++dirs}`;
  docker("exec", NAME, "sh", "-c", `mkdir -p ${cwd} && chmod 777 ${cwd}`);
  return await DockerEnv.connect({ container: NAME, cwd, ...options });
}

test("docker spec: docker:<container>:<absolute cwd>; names never hold a colon", () => {
  assert.deepEqual(parseEnvSpec("docker:abc123:/app"), { kind: "docker", container: "abc123", cwd: "/app" });
  assert.deepEqual(parseEnvSpec("docker:trial_1.main-1:/a:b"), { kind: "docker", container: "trial_1.main-1", cwd: "/a:b" });
  for (const bad of ["docker:", "docker:c", "docker:c:", "docker:c:rel", "docker::/app", "docker:-x:/app", "docker:a b:/app"]) {
    assert.throws(() => parseEnvSpec(bad), /docker spec is docker:<container>:<absolute cwd>/u, bad);
  }
});

test("docker user: --user, else HARNESS_DOCKER_USER for docker specs only", () => {
  const environ = { HARNESS_DOCKER_USER: "agent" };
  assert.equal(commandUser("docker:c:/app", undefined, environ), "agent");
  assert.equal(commandUser("docker:c:/app", "flag", environ), "flag");
  assert.equal(commandUser("docker:c:/app", undefined, {}), undefined);
  assert.equal(commandUser("local:/tmp", undefined, environ), undefined);
});

if (skip === false) {
  execEnvConformance("DockerEnv", () => makeDocker());
  toolSuite("DockerEnv", () => makeDocker());
  execSurfaceSuite("DockerEnv", () => makeDocker());
  execEnvConformance("DockerEnv without process groups", () => makeDocker({ noGroups: true }));
  execEnvConformance("DockerEnv as nobody", () => makeDocker({ user: "nobody" }));
}

test("DockerEnv: exec'd processes are group leaders here (no setsid needed); --env docker:<c>:<cwd> inherits the container's env", { skip }, async () => {
  const probe = await makeDocker();
  try {
    assert.equal(probe.processGroups(), "leader");
    assert.equal(probe.user, "root");
  } finally {
    await probe.close();
  }
  const imagePath = docker("inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", NAME).split("\n").find((line) => line.startsWith("PATH="))!.slice(5);
  const cwd = `/tmp/conf-${process.pid}-spec`;
  docker("exec", NAME, "mkdir", "-p", cwd);
  const env = await createEnv(`docker:${NAME}:${cwd}`, { vars: { EXTRA: "x" } });
  try {
    assert.equal(env.id, `docker:${NAME}`);
    assert.equal(env.os, "linux");
    assert.equal((await env.exec("echo $PATH $CONTAINER_VAR $EXTRA $(id -u) $(pwd)")).output, `${imagePath} from-run x 0 ${cwd}\n`);
    await assert.rejects(createEnv(`docker:${NAME}:/no/such/dir`), /is not a directory/u);
    await assert.rejects(createEnv(`docker:no-such-container-${process.pid}:/tmp`), /No such container/u);
    await assert.rejects(createEnv(`docker:${NAME}:/tmp`, { user: "no-such-user" }), /cannot run commands as user "no-such-user"/u);
  } finally {
    await env.close();
  }
});

test("DockerEnv: commands and files run as the requested user", { skip }, async () => {
  const env = await makeDocker({ user: "nobody" });
  try {
    assert.equal(env.user, "nobody");
    assert.equal((await env.exec("id -un")).output, "nobody\n");
    await env.writeFile("mine.txt", "x");
    assert.equal((await env.exec("stat -c %U mine.txt")).output, "nobody\n");
    await assert.rejects(env.writeFile("/root/denied.txt", "x"), (error: Error & { code?: string }) => error.code === "EACCES");
    await assert.rejects(env.readFile("/etc/shadow"), (error: Error & { code?: string }) => error.code === "EACCES");
  } finally {
    await env.close();
  }
});

test("DockerEnv: symlinks stat as their target, ranges past the end are empty, file errors carry codes, a missing cwd fails to start", { skip }, async () => {
  const env = await makeDocker();
  try {
    await env.writeFile("t.txt", "hello\n");
    await env.exec("ln -s t.txt link; ln -s nowhere dangling; mkdir d; ln -s d dlink; printf 'a\\nb' > 'sp ace.txt'");
    assert.deepEqual(await env.stat("link").then((info) => [info?.kind, info?.size]), ["file", 6]);
    assert.equal((await env.stat("dangling"))?.kind, "symlink");
    assert.ok(Math.abs((await env.stat("t.txt"))!.mtimeMs - Date.now()) < 120_000, "mtime in ms since the epoch");
    assert.equal((await env.readFile("t.txt", { offset: 100, length: 5 })).byteLength, 0);
    assert.equal(Buffer.from(await env.readFile("t.txt", { offset: 1, length: 3 })).toString(), "ell");
    assert.equal(Buffer.from(await env.readFile("sp ace.txt")).toString(), "a\nb");
    await assert.rejects(env.readFile("d"), (error: Error & { code?: string }) => error.code === "EISDIR");
    await assert.rejects(env.readFile("nope"), (error: Error & { code?: string }) => error.code === "ENOENT");
    await assert.rejects(env.listDir("nope"), (error: Error & { code?: string }) => error.code === "ENOENT");
    await assert.rejects(env.listDir("t.txt"), (error: Error & { code?: string }) => error.code === "ENOTDIR");
    const names = (await env.listDir(".")).map((entry) => `${entry.kind}:${entry.name}`).sort();
    assert.deepEqual(names, ["directory:d", "file:sp ace.txt", "file:t.txt", "symlink:dangling", "symlink:dlink", "symlink:link"]);
    const [dir, missing, ok] = await env.readFiles(["d", "nope", "t.txt"]);
    assert.equal((dir as Error & { code?: string }).code, "EISDIR");
    assert.equal((missing as Error & { code?: string }).code, "ENOENT");
    assert.equal(Buffer.from(ok as Uint8Array).toString(), "hello\n");
    const bad = await env.exec("true", { cwd: "missing-dir" });
    assert.equal(bad.exitCode, 127);
    assert.match(bad.output, /failed to start/u);
  } finally {
    await env.close();
  }
});

test("DockerEnv: output keeps its order across stdout and stderr; a binary-safe 3 MB round trip", { skip }, async () => {
  const env = await makeDocker();
  try {
    assert.equal((await env.exec("for i in 1 2 3 4 5; do echo o$i; echo e$i >&2; done")).output, "o1\ne1\no2\ne2\no3\ne3\no4\ne4\no5\ne5\n");
    const big = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 7919) & 0xff;
    await env.writeFile("big.bin", big);
    assert.ok(Buffer.from(await env.readFile("big.bin")).equals(big));
    const [again] = await env.readFiles(["big.bin"]);
    assert.ok(Buffer.from(again as Uint8Array).equals(big));
    // A file that looks like the wrapper's marks is plain output.
    assert.equal((await env.exec("printf '\\036harness-exit-x:0\\nafter\\n'")).output, "\x1eharness-exit-x:0\nafter\n");
  } finally {
    await env.close();
  }
});

test("DockerEnv: close kills a daemon that left its process group", { skip }, async () => {
  const env = await makeDocker();
  const run = await env.exec("setsid sleep 40 > /dev/null 2>&1 < /dev/null & echo $!");
  const pid = run.output.trim();
  assert.match(pid, /^\d+$/u);
  await env.close();
  const checker = await makeDocker();
  try {
    assert.equal((await checker.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).output, "gone\n");
  } finally {
    await checker.close();
  }
});

test("DockerEnv: a harness killed without close() leaves nothing running (the host-side reaper)", { skip }, async () => {
  const cwd = `/tmp/conf-${process.pid}-reaper`;
  docker("exec", NAME, "mkdir", "-p", cwd);
  const script = join(mkdtempSync(join(tmpdir(), "harness-docker-reaper-")), "victim.ts");
  writeFileSync(script, `import { DockerEnv } from ${JSON.stringify(join(HERE, "..", "src", "env", "docker.ts"))};
const env = await DockerEnv.connect({ container: ${JSON.stringify(NAME)}, cwd: ${JSON.stringify(cwd)} });
const run = await env.exec("sleep 60 & echo $!; sleep 60", { yieldMs: 500 });
process.stdout.write(run.output);
setInterval(() => {}, 1000);
`);
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], { stdio: ["ignore", "pipe", "inherit"] });
  const pid = await new Promise<string>((done) => child.stdout.on("data", (chunk) => done(String(chunk).trim())));
  assert.match(pid, /^\d+$/u);
  assert.equal(docker("exec", NAME, "sh", "-c", `kill -0 ${pid} && echo alive`), "alive\n");
  child.kill("SIGKILL");
  let state = "alive\n";
  for (let i = 0; i < 50 && state === "alive\n"; i++) {
    await new Promise((done) => setTimeout(done, 100));
    state = docker("exec", NAME, "sh", "-c", `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`);
  }
  assert.equal(state, "gone\n");
});

test("DockerEnv in a container whose PID 1 reaps nothing (Harbor's): close leaves the command's processes dead (zombies at most)", { skip }, async () => {
  const cwd = `/tmp/conf-${process.pid}-noinit`;
  docker("exec", NOINIT, "mkdir", "-p", cwd);
  const env = await DockerEnv.connect({ container: NOINIT, cwd });
  const run = await env.exec("sleep 40 & echo $!; setsid sleep 40 > /dev/null 2>&1 < /dev/null & echo $!");
  const pids = run.output.trim().split("\n");
  assert.equal(pids.length, 2);
  const bg = await env.exec("sleep 40", { background: true });
  await env.close();
  // Running means a /proc entry that is not a zombie (state Z): what kill -0 cannot tell apart.
  const state = docker("exec", NOINIT, "sh", "-c", `for p in ${pids.join(" ")}; do s=$(sed -n 's/^State:[[:space:]]*\\(.\\).*/\\1/p' /proc/$p/status 2>/dev/null); echo "$p \${s:-gone}"; done`);
  for (const line of state.trim().split("\n")) assert.match(line, /^\d+ (Z|gone)$/u, state);
  assert.equal(bg.running, true);
  assert.doesNotMatch(docker("exec", NOINIT, "sh", "-c", "grep -l '^State:.*[RS]' /proc/[0-9]*/status 2>/dev/null | while read f; do tr '\\000' ' ' < ${f%status}cmdline; echo; done"), /^sleep 40/mu);
});

const BUNDLE = join(HERE, "..", "dist", "harness.mjs");

test("CLI on docker: commands run as HARNESS_DOCKER_USER, else the container's user; run_start names the env, user and OS", { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), "harness-docker-cli-"));
  writeFileSync(join(root, "prompt.txt"), "Who am I?");
  writeFileSync(join(root, "faux.json"), JSON.stringify({ steps: [
    { toolCalls: [{ name: "bash", arguments: { command: "id -un > whoami.txt; uname -s >> whoami.txt" } }] },
    { toolCalls: [{ name: "read", arguments: { path: "whoami.txt" } }] },
    { text: "done" },
  ] }));
  for (const [rigUser, expected] of [["nobody", "nobody"], [undefined, "root"]] as const) {
    const cwd = `/tmp/cli-${process.pid}-${expected}`;
    docker("exec", NAME, "sh", "-c", `mkdir -p ${cwd} && chmod 777 ${cwd}`);
    const trace = join(root, `${expected}.trace.jsonl`);
    const result = join(root, `${expected}.result.json`);
    const out = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = spawn(process.execPath, [BUNDLE, "run",
        "--prompt-file", join(root, "prompt.txt"), "--model", "faux/scripted", "--faux-script", join(root, "faux.json"), "--effort", "high",
        "--loadout", "compact-v0-plain", "--env", `docker:${NAME}:${cwd}`, "--trace", trace, "--result", result,
      ], { env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...(rigUser === undefined ? {} : { HARNESS_DOCKER_USER: rigUser }) }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => done({ code, stderr }));
    });
    assert.equal(out.code, 0, out.stderr);
    const doc = JSON.parse(readFileSync(result, "utf8"));
    assert.equal(doc.status, "finished", JSON.stringify(doc));
    const start = JSON.parse(readFileSync(trace, "utf8").split("\n")[0]!);
    assert.equal(start.user, expected);
    assert.equal(start.env, `docker:${NAME}`, "the trace (not the model) records the container");
    assert.equal(docker("exec", NAME, "cat", `${cwd}/whoami.txt`), `${expected}\nLinux\n`);
  }
});
