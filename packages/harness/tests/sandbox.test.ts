/**
 * SandboxEnv: the ExecEnv conformance suite, the tool suite and the exec surface suite, on the real SDK client
 * (`@caveman-ai/sdk/sandboxes`) against a fake Caveman Cloud that answers as the API, the relay and the fleet's guest
 * agent do (tests/sandbox-fake.ts), plus what only a sandbox does: the computer made on the first call that needs it,
 * once, with its create's body and Idempotency-Key; a named computer attached; streams refused for a rate opened again;
 * a computer put to sleep woken, and one that lost its memory said so; a lost computer; the key in no command.
 * The same suites on a fleet computer are the sandbox lab's (Caveman Cloud), not this file's.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { SandboxEnv, type SandboxEnvOptions, type SandboxEvent } from "../src/env/sandbox.ts";
import { execEnvConformance } from "./env-conformance.ts";
import { execSurfaceSuite } from "./exec-suite.ts";
import { startGitLane, startSandboxFake } from "./sandbox-fake.ts";
import { toolSuite } from "./tool-suite.ts";

const lane = await startGitLane();
const fake = await startSandboxFake(undefined, { host: lane.url });
after(() => Promise.all([fake.close(), lane.close()]));

const workspace = () => realpathSync(mkdtempSync(join(tmpdir(), "harness-sandbox-")));
const makeSandbox = async (options: Partial<SandboxEnvOptions> = {}) =>
  new SandboxEnv({ controlURL: fake.url, apiKey: fake.key, cwd: workspace(), retryDelayMs: 0, ...options });

execEnvConformance("SandboxEnv", makeSandbox);
toolSuite("SandboxEnv", makeSandbox);
execSurfaceSuite("SandboxEnv", makeSandbox);

const since = (from: number) => fake.state.requests.slice(from);

test("SandboxEnv: nothing is made before a call needs a computer; the first makes one, once, with no shape, and writes the host's files first", async () => {
  const events: SandboxEvent[] = [];
  const before = fake.state.requests.length;
  let read = 0;
  const env = await makeSandbox({
    idempotencyKey: "session-ses_made_once", onEvent: (event) => events.push(event),
    files: async () => {
      read++;
      return [{ path: "AGENT.md", data: "---\nname: builder\n---\n" }, { path: "scripts/run.sh", data: new Uint8Array([0x65, 0x63, 0x68, 0x6f, 0x00, 0xff]) }];
    },
  });
  try {
    assert.equal(env.id, "sandbox");
    assert.equal(env.user, "tools");
    assert.equal(env.os, "linux");
    assert.equal(env.resolvePath("a/b"), `${env.cwd}/a/b`);
    assert.deepEqual(since(before), [], "the env block's facts ask nothing");
    assert.equal(read, 0, "the files are read only when a computer is made");
    const creates = fake.state.creates.length;
    const [one, two, file] = await Promise.all([env.exec("echo one"), env.exec("echo two"), env.writeFile("f.txt", "x").then(() => env.readFile("f.txt"))]);
    assert.equal(one.output, "one\n");
    assert.equal(two.output, "two\n");
    assert.equal(Buffer.from(file).toString(), "x");
    assert.equal(fake.state.creates.length, creates + 1, "one computer for every call");
    const create = fake.state.creates.at(-1)!;
    assert.deepEqual(create.body, {}, "the API decides a session computer's shape");
    assert.equal(create.idempotencyKey, "session-ses_made_once");
    assert.equal(read, 1);
    assert.equal((await env.exec("cat AGENT.md")).output, "---\nname: builder\n---\n");
    assert.deepEqual([...await env.readFile("scripts/run.sh")], [0x65, 0x63, 0x68, 0x6f, 0x00, 0xff]);
    assert.match(env.id, /^sandbox:cc_fake\d+$/u);
    assert.equal(env.computerId, env.id.slice("sandbox:".length));
    assert.deepEqual(events.map((event) => event.action), ["made"]);
    assert.equal(events[0]!.computer_id, env.computerId);
    assert.equal(events[0]!.size, "small", "as the computer's answer says it");
    assert.equal(events[0]!.image, "bare");
    assert.ok(typeof events[0]!.ready_ms === "number" && events[0]!.ready_ms >= 0);
    assert.notEqual(env.user, "tools", "the probe's answer replaces the default (on this host, this host's user)");
  } finally {
    await env.close();
  }
  assert.deepEqual(events.map((event) => event.action), ["made", "released"]);
  assert.deepEqual(fake.state.errors, []);
});

test("SandboxEnv: an env that never needed a computer makes none and closes without a request", async () => {
  const events: SandboxEvent[] = [];
  const before = fake.state.requests.length;
  const env = await makeSandbox({ onEvent: (event) => events.push(event) });
  await env.close();
  assert.deepEqual(since(before), []);
  assert.deepEqual(events, []);
});

test("SandboxEnv: a named computer is attached, none made, and gets no files", async () => {
  const events: SandboxEvent[] = [];
  const computer = fake.makeComputer({ size: "medium" });
  const creates = fake.state.creates.length;
  const env = await makeSandbox({ computerId: computer.id, onEvent: (event) => events.push(event), files: async () => [{ path: "AGENT.md", data: "x" }] });
  try {
    assert.equal(env.id, `sandbox:${computer.id}`);
    assert.equal((await env.exec("echo here; ls")).output, "here\n");
    assert.equal(fake.state.creates.length, creates);
    assert.deepEqual(events.map((event) => [event.action, event.computer_id, event.size]), [["attached", computer.id, "medium"]]);
  } finally {
    await env.close();
  }
});

test("SandboxEnv: a create refused because the session has its computer attaches that one, and writes no files", async () => {
  const events: SandboxEvent[] = [];
  const existing = fake.makeComputer({ size: "large" });
  const env = await makeSandbox({ idempotencyKey: "session-ses_reclaimed", onEvent: (event) => events.push(event), files: async () => [{ path: "AGENT.md", data: "x" }] });
  try {
    fake.state.createRefusal = { status: 409, code: "cave_code_session_computer_exists", message: "This session has its computer.", details: { computer_id: existing.id } };
    assert.equal((await env.exec("echo there; ls")).output, "there\n");
    assert.equal(env.computerId, existing.id);
    assert.equal(fake.state.creates.at(-1)!.idempotencyKey, "session-ses_reclaimed");
    assert.deepEqual(events.map((event) => [event.action, event.computer_id, event.size]), [["attached", existing.id, "large"]]);
    // The same refusal without details is the API's error, said in the output.
    const other = await makeSandbox({ idempotencyKey: "session-ses_other" });
    fake.state.createRefusal = { status: 409, code: "cave_code_session_computer_exists", message: "This session has its computer." };
    const refused = await other.exec("true");
    assert.equal(refused.exitCode, 127);
    assert.match(refused.output, /cave_code_session_computer_exists: This session has its computer\./u);
    await other.close();
  } finally {
    await env.close();
  }
});

test("SandboxEnv: the key reaches no command; it rides only as the API's bearer", async () => {
  const env = await makeSandbox();
  try {
    const run = await env.exec("env");
    assert.equal(run.exitCode, 0);
    assert.ok(!run.output.includes(fake.key), "the key is in a command's environment");
    assert.match(run.output, /^HARNESS_PROC=/mu);
    assert.match(run.output, /^PAGER=cat$/mu);
  } finally {
    await env.close();
  }
});

/** Every file under dir (links not followed) whose bytes hold `text`. */
function filesHolding(dir: string, text: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesHolding(path, text));
    else if (entry.isFile() && readFileSync(path).includes(text)) found.push(path);
  }
  return found;
}

test("SandboxEnv: env (the pool's build secrets) is in each command's environment and nowhere else: no file in the computer, no event, no command started without it", async () => {
  // Caveman Cloud's public/shared/contracts/examples/secrets-file.json's values.
  const secrets = { STRIPE_API_KEY: "sk_test_example_value_0001", WAREHOUSE_TOKEN: "wh-example-token-0002" };
  const events: SandboxEvent[] = [];
  const cwd = workspace();
  const env = await makeSandbox({ cwd, env: secrets, onEvent: (event) => events.push(event), files: async () => [{ path: "AGENT.md", data: "---\nname: builder\n---\n" }] });
  let scratch = "";
  let computerId = "";
  try {
    assert.equal((await env.exec('printf "%s %s" "$STRIPE_API_KEY" "$WAREHOUSE_TOKEN"')).output, `${secrets.STRIPE_API_KEY} ${secrets.WAREHOUSE_TOKEN}`);
    // A command past its yield, and the files it writes on its own: still only its environment's.
    const later = await env.exec('sleep 0.3; printf %s "$WAREHOUSE_TOKEN" | wc -c; echo made > made.txt', { background: true });
    assert.equal(later.running, true);
    assert.equal((await env.wait(later.handle!, 10_000)).output.trim(), String(secrets.WAREHOUSE_TOKEN.length));
    scratch = await env.scratchDir();
    computerId = env.computerId!;
    // The same computer without them (the next session of a kept one): nothing of them there.
    const other = await makeSandbox({ cwd, computerId });
    try {
      assert.equal((await other.exec('printf "%s|%s" "${STRIPE_API_KEY-unset}" "${WAREHOUSE_TOKEN-unset}"')).output, "unset|unset");
      assert.ok(!(await other.exec("env; cat ~/.profile ~/.bashrc /etc/environment 2>/dev/null; true")).output.includes(secrets.STRIPE_API_KEY));
    } finally {
      await other.close();
    }
  } finally {
    await env.close();
  }
  for (const value of Object.values(secrets)) {
    assert.deepEqual([cwd, fake.home, scratch].filter((dir) => dir !== "").flatMap((dir) => existsSync(dir) ? filesHolding(dir, value) : []), [], "a file in the computer holds a secret");
    assert.ok(!JSON.stringify(events).includes(value), "an event holds a secret");
  }
  assert.ok(existsSync(join(cwd, "made.txt")) && existsSync(join(cwd, "AGENT.md")), "the commands and the build's files ran there");
  assert.deepEqual(events.map((event) => [event.action, event.computer_id]), [["made", computerId], ["released", computerId]]);
});

test("SandboxEnv: a stream refused for its rate or the computer's stream count opens again after the wait; the command runs once", async () => {
  const env = await makeSandbox();
  try {
    await env.exec("true");
    fake.state.refuse.push({ status: 429, code: "cave_rate_limit_exceeded", retryAfter: 0 }, { status: 429, code: "cave_code_computer_streams_limit", retryAfter: 0 });
    const run = await env.exec("echo once >> ran.txt; cat ran.txt");
    assert.equal(run.output, "once\n");
    fake.state.refuse.push({ status: 429, code: "cave_rate_limit_exceeded", retryAfter: 0 });
    assert.equal(Buffer.from(await env.readFile("ran.txt")).toString(), "once\n");
    // A refusal that does not ask to wait fails the call, saying why.
    fake.state.refuse.push({ status: 403, code: "cave_forbidden", retryAfter: 0 });
    const refused = await env.exec("echo never");
    assert.equal(refused.exitCode, 127);
    assert.match(refused.output, /failed to start in sandbox:\S+: cave_forbidden: refused by the test/u);
  } finally {
    await env.close();
  }
});

test("SandboxEnv: a computer put to sleep is woken; one that came back without its memory says so once", async () => {
  const events: SandboxEvent[] = [];
  const boot = join(workspace(), "boot_id");
  writeFileSync(boot, "boot-first\n");
  const env = await makeSandbox({ bootIdFile: boot, onEvent: (event) => events.push(event) });
  try {
    assert.equal((await env.exec("echo before")).output, "before\n");
    const computer = fake.state.computers.get(env.computerId!)!;
    computer.bootFile = boot;
    computer.desired_state = "suspended";
    computer.observed_state = "suspended";
    const woken = await env.exec("echo after");
    assert.equal(woken.exitCode, 0);
    assert.equal(woken.output, "[harness: the computer slept without its memory since the last command: the processes it ran were stopped (files are kept)]\nafter\n");
    assert.equal((await env.exec("echo again")).output, "again\n", "said once");
    const woke = events.find((event) => event.action === "woke");
    assert.equal(woke?.slept_without_memory, true);
    assert.ok(typeof woke?.ready_ms === "number");
    // Asleep again, with its memory this time (the boot id kept): woken, nothing said.
    delete computer.bootFile;
    computer.desired_state = "suspended";
    assert.equal((await env.readFile("missing.txt").catch((error: { code?: string }) => error.code)), "ENOENT");
    assert.equal((await env.exec("echo third")).output, "third\n");
    assert.deepEqual(events.map((event) => [event.action, event.slept_without_memory ?? false]), [["made", false], ["woke", true], ["woke", false]]);
  } finally {
    await env.close();
  }
});

test("SandboxEnv: a computer that is gone is lost: said once, and every later call fails saying so without a request", async () => {
  const events: SandboxEvent[] = [];
  const env = await makeSandbox({ onEvent: (event) => events.push(event) });
  try {
    await env.exec("true");
    const computer = fake.state.computers.get(env.computerId!)!;
    computer.desired_state = "deleted";
    computer.observed_state = "deleted";
    const first = await env.exec("echo never");
    assert.equal(first.exitCode, 127);
    assert.match(first.output, /is lost: it is not found \(cave_not_found\); its files and processes are gone, and this session gets no other/u);
    const before = fake.state.requests.length;
    const later = await env.exec("echo never");
    assert.equal(later.exitCode, 127);
    assert.match(later.output, /no computer to run this on: .*is lost/u);
    await assert.rejects(env.readFile("x"), /is lost/u);
    assert.deepEqual(since(before), []);
    assert.deepEqual(events.map((event) => event.action), ["made", "lost"]);
  } finally {
    await env.close();
  }
  assert.deepEqual(events.map((event) => event.action), ["made", "lost"], "a lost computer is not released");
});

test("SandboxEnv: a refused create says why in the command's output; the next call asks again", async () => {
  const env = await makeSandbox({ idempotencyKey: "ses_refused_first" });
  try {
    fake.state.createRefusal = { status: 409, code: "cave_code_computer_limit_running", message: "This organization runs as many computers as its plan allows." };
    const refused = await env.exec("echo never");
    assert.equal(refused.exitCode, 127);
    assert.match(refused.output, /no computer to run this on: cave_code_computer_limit_running: This organization runs as many computers as its plan allows\./u);
    assert.equal(env.computerId, undefined);
    assert.equal((await env.exec("echo now")).output, "now\n");
  } finally {
    await env.close();
  }
});

test("SandboxEnv from the bundled library: a turn with no tool call makes no computer; a turn's first bash makes one and runs there", async () => {
  const lib = await import(new URL("../dist/lib.mjs", import.meta.url).href) as typeof import("../src/lib.ts");
  const { fauxStep, resolveModel } = await import("../src/models.ts");
  const events: SandboxEvent[] = [];
  const creates = fake.state.creates.length;
  const env = new lib.SandboxEnv({ controlURL: fake.url, apiKey: fake.key, cwd: workspace(), retryDelayMs: 0, idempotencyKey: "ses_bundle", onEvent: (event) => events.push(event) });
  const resolved = resolveModel("faux/sandbox", {}, [
    () => fauxStep({ text: "nothing to run" }),
    () => fauxStep({ toolCalls: [{ name: "bash", arguments: { command: "echo from-the-sandbox; pwd" } }] }),
    () => fauxStep({ text: "done" }),
  ]);
  const session = new lib.HarnessSession({
    model: resolved.model, stream: (model, context, options) => resolved.models.streamSimple(model, context, { ...options, apiKey: "faux" }),
    loadout: lib.appLoadoutFor({ api: "anthropic-messages", id: "claude-opus-5-5" }), env,
  });
  try {
    assert.equal((await session.runTurn("say hi")).status, "finished");
    assert.equal(fake.state.creates.length, creates, "no tool call, no computer");
    assert.equal(events.length, 0);
    const outcome = await session.runTurn("run it");
    assert.equal(outcome.status, "finished", JSON.stringify(outcome));
    assert.equal(fake.state.creates.length, creates + 1);
    const result = session.messages.find((message) => message.role === "toolResult");
    assert.match(JSON.stringify(result), new RegExp(`from-the-sandbox\\\\n${env.cwd.replace(/[/.]/gu, "\\$&")}`, "u"));
    assert.deepEqual(events.map((event) => event.action), ["made"]);
  } finally {
    await session.close();
  }
  assert.deepEqual(events.map((event) => event.action), ["made", "released"], "the session's close releases the computer");
});

describe("SandboxEnv repos and streams", { concurrency: 4 }, () => {
test("SandboxEnv: a background command holds its stream as its handle; a backgrounded child keeps one open until close", async () => {
  const env = await makeSandbox();
  const settle = () => new Promise((done) => setTimeout(done, 150));
  const streams = () => fake.state.computers.get(env.computerId!)!.streams;
  try {
    await env.exec("true");
    await settle();
    assert.equal(streams(), 0, "a finished command leaves no stream open");
    const bg = await env.exec("sleep 30", { background: true });
    assert.equal(bg.running, true);
    assert.equal(streams(), 1, "the handle is its stream");
    await env.kill(bg.handle!);
    await settle();
    assert.equal(streams(), 0, "kill ends the stream");
    const run = await env.exec("sleep 30 & echo started");
    assert.equal(run.output, "started\n");
    await settle();
    assert.equal(streams(), 1, "the child holds the stream");
  } finally {
    await env.close();
  }
  await settle();
  assert.equal(streams(), 0, "close ends every stream");
});

test("SandboxEnv: a session's repository is cloned from its git URL (the host's git lane) on its base branch; fetch and push by the GitHub URL go there", async () => {
  await lane.makeRepository("acme", "shop", { "README.md": "# shop\n", "AGENT.md": "the repository's own\n" }, "develop");
  const events: SandboxEvent[] = [];
  const env = await makeSandbox({
    idempotencyKey: "session-ses_repo", repository: { owner: "acme", name: "shop", baseBranch: "develop", gitURL: "http://172.16.0.1:47483/git/v1/acme/shop.git" }, onEvent: (event) => events.push(event),
    files: async () => [{ path: "AGENT.md", data: "the build's\n" }, { path: ".caveman/skills/deploy.md", data: "deploy\n" }],
  });
  try {
    const look = await env.exec("git rev-parse --abbrev-ref HEAD; cat BRANCH README.md AGENT.md; git config --get remote.origin.url; git config --get-regexp '^url\\.' ; git config --global --list 2>/dev/null | wc -l");
    assert.equal(look.exitCode, 0, look.output);
    assert.equal(look.output, [
      "develop", "develop", "# shop", "the repository's own",
      "https://github.com/acme/shop.git",
      // The host's lane (the fake's origin stands for http://172.16.0.1:47483 in what a command is given).
      `url.${lane.url}/git/v1/acme/shop.git.insteadof https://github.com/acme/shop.git`,
      "0", "",
    ].join("\n").replace(/^0$/mu, (zero) => zero.padStart(8)), "the base branch, the repository's own AGENT.md, origin the GitHub URL, the clone's own config and no global one");
    // The build's file that is not the repository's is there, and git ignores every file of the build.
    assert.equal(Buffer.from(await env.readFile(".caveman/skills/deploy.md")).toString(), "deploy\n");
    assert.equal((await env.exec("git status --porcelain")).output, "");
    // A push by the GitHub URL reaches the lane: caveman/* is taken, main is refused by the lane's rules.
    const push = await env.exec("git checkout -q -b caveman/fix && echo fixed > fix.txt && git add fix.txt && git -c user.name=agent -c user.email=agent@example.com commit -q -m fix && git push -q origin caveman/fix 2>&1");
    assert.equal(push.exitCode, 0, push.output);
    assert.equal((await lane.branches("acme", "shop"))["caveman/fix"], "fix");
    const refused = await env.exec("git push -q https://github.com/acme/shop.git HEAD:main 2>&1");
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.output, /caveman\/\* branches only/u);
    assert.equal((await env.exec("git fetch -q origin && git rev-parse --abbrev-ref origin/develop")).output, "origin/develop\n");
    assert.deepEqual(events.map((event) => event.action), ["made"]);
  } finally {
    await env.close();
  }
});

test("SandboxEnv: an attached computer that has the clone is left alone; one without it gets it", async () => {
  await lane.makeRepository("acme", "tools", { "README.md": "# tools\n" });
  const first = await makeSandbox({ repository: { owner: "acme", name: "tools", gitURL: "http://172.16.0.1:47483/git/v1/acme/tools.git" } });
  const cwd = first.cwd;
  await first.exec("echo local > work.txt; git -c user.name=a -c user.email=a@example.com commit -q --allow-empty -m mine");
  const computer = first.computerId!;
  await first.close();
  const again = await makeSandbox({ computerId: computer, cwd, repository: { owner: "acme", name: "tools", gitURL: "http://172.16.0.1:47483/git/v1/acme/tools.git" } });
  try {
    assert.equal((await again.exec("cat work.txt; git log -1 --format=%s")).output, "local\nmine\n", "the clone and its work are as they were");
  } finally {
    await again.close();
  }
  const bare = await makeSandbox({ computerId: fake.makeComputer().id, repository: { owner: "acme", name: "tools", gitURL: "http://172.16.0.1:47483/git/v1/acme/tools.git" } });
  try {
    assert.equal((await bare.exec("cat README.md; git config --get remote.origin.url")).output, "# tools\nhttps://github.com/acme/tools.git\n");
  } finally {
    await bare.close();
  }
});

test("SandboxEnv: a repository the lane does not serve fails the call that needed the computer, saying why; a bad branch or a git URL that is not http(s) asks nothing", async () => {
  const env = await makeSandbox({ repository: { owner: "acme", name: "nowhere", gitURL: "http://172.16.0.1:47483/git/v1/acme/nowhere.git" } });
  try {
    const run = await env.exec("true");
    assert.equal(run.exitCode, 127);
    assert.match(run.output, /the repository acme\/nowhere could not be cloned from http:\/\/172\.16\.0\.1:47483\/git\/v1\/acme\/nowhere\.git \(exit 128\)/u);
  } finally {
    await env.close();
  }
  for (const [repository, why] of [
    [{ owner: "acme", name: "shop", baseBranch: "--upload-pack=evil", gitURL: "http://172.16.0.1:47483/git/v1/acme/shop.git" }, /is not a branch name/u],
    [{ owner: "acme", name: "shop", gitURL: "file:///srv/shop.git" }, /is not an http\(s\) URL without credentials/u],
    [{ owner: "acme", name: "shop", gitURL: "https://user:token@github.com/acme/shop.git" }, /is not an http\(s\) URL without credentials/u],
  ] as const) {
    const bad = await makeSandbox({ repository });
    try {
      assert.match((await bad.exec("true")).output, why);
    } finally {
      await bad.close();
    }
  }
});
});
