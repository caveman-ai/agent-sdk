import { test } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const templateRoot = resolve(packageRoot, "templates/support-bot");

async function walkFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

async function invoke(args, env = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], {
      cwd: packageRoot,
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (code) => done({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("package lifecycle builds executable initializer and ships the template", async () => {
  const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts.prepack, "npm run build");
  assert.deepEqual(pkg.repository, {
    type: "git",
    url: "git+https://github.com/JuliusBrussee/agent-sdk.git",
    directory: "packages/create-caveman-agent",
  });
  assert.equal(pkg.homepage, "https://caveman.so/products/caveman-agent");
  assert.equal(pkg.bugs.url, "https://github.com/JuliusBrussee/agent-sdk/issues");
  assert.equal(pkg.files.includes("templates"), true, "template must ship in the npm tarball");
  assert.equal(
    (await readFile(resolve(packageRoot, pkg.bin["create-caveman-agent"]), "utf8")).split("\n", 1)[0],
    "#!/usr/bin/env node",
  );
});

test("initializer exposes help without credentials or filesystem writes", async () => {
  for (const args of [["--help"], ["-h"], ["my-agent", "--help"]]) {
    const result = await invoke(args);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^usage: npm create @caveman-ai\/agent@latest/);
    assert.match(result.stdout, /--template <name>/);
    assert.match(result.stdout, /--no-install/);
    assert.equal(result.stderr, "");
  }
});

test("initializer copies the full template tree byte-for-byte with deterministic provider choice", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "support-agent");
  try {
    // anthropic is the provider the template's model line already carries, so
    // its rewrite is the identity and every non-mutated file must be
    // byte-equal. The file SET is the recursive template walk, not a
    // hand-list, so a new template file cannot silently skip coverage.
    const result = await invoke([target, "--provider", "anthropic", "--no-install"], {
      OPENAI_API_KEY: "secret-never-print",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /secret-never-print/);
    const templateFiles = await walkFiles(templateRoot);
    assert.deepEqual(
      await walkFiles(target),
      [...templateFiles, ".caveman/provider.json", ".gitignore"].sort(),
      "target must be exactly the template walk plus the two generated files",
    );
    for (const path of templateFiles) {
      if (path === "package.json") continue; // name field mutated, compared below
      assert.equal(
        await readFile(resolve(target, path), "utf8"),
        await readFile(resolve(templateRoot, path), "utf8"),
        `${path} must match the template byte-for-byte`,
      );
    }
    const packageJSON = JSON.parse(await readFile(resolve(target, "package.json"), "utf8"));
    assert.equal(packageJSON.name, "support-agent");
    const templateJSON = JSON.parse(await readFile(resolve(templateRoot, "package.json"), "utf8"));
    assert.deepEqual(packageJSON, { ...templateJSON, name: "support-agent" });
    assert.equal(packageJSON.scripts.doctor, "caveman-agent doctor");
    assert.equal(packageJSON.scripts.ticket, "node --experimental-strip-types run.ts");
    assert.deepEqual(
      JSON.parse(await readFile(resolve(target, ".caveman/provider.json"), "utf8")),
      { provider: "anthropic", model: "anthropic/claude-sonnet-5" },
    );
    assert.equal(
      await readFile(resolve(target, ".gitignore"), "utf8"),
      "node_modules/\n.caveman/traces/\n.caveman/agent-dir-entry.mjs\n.caveman/workload-profile.json\n.env*\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the generator rewrites the template model line per selected provider", async () => {
  const expected = {
    anthropic: "anthropic/claude-sonnet-5",
    openai: "openai/gpt-5.4-mini",
    google: "google/gemini-2.5-flash",
  };
  for (const [provider, model] of Object.entries(expected)) {
    const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
    const target = resolve(root, `agent-${provider}`);
    try {
      const result = await invoke([target, "--provider", provider, "--no-install"]);
      assert.equal(result.code, 0, result.stderr);
      const agentTs = await readFile(resolve(target, "agent.ts"), "utf8");
      assert.equal(agentTs.includes(`  model: "${model}",`), true, `${provider} model line`);
      // Exactly one model line, and no stale provider's model left behind.
      assert.equal(agentTs.match(/^\s*model: "/gm).length, 1);
      assert.deepEqual(
        JSON.parse(await readFile(resolve(target, ".caveman/provider.json"), "utf8")),
        { provider, model },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("a missing SDK version is named, rolled back, and suggests --no-install without guessing release status", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "etarget-agent");
  const fakeNpm = resolve(root, "fake-npm-etarget.mjs");
  await writeFile(fakeNpm, [
    'process.stderr.write("npm error code ETARGET\\n");',
    'process.stderr.write("npm error notarget No matching version found for @caveman-ai/agent@^0.2.0.\\n");',
    "process.exit(1);",
    "",
  ].join("\n"));
  try {
    const result = await invoke(["--provider", "anthropic", target], { npm_execpath: fakeNpm });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requested @caveman-ai\/agent version in the configured registry/);
    assert.doesNotMatch(result.stderr, /has not been published/);
    assert.match(result.stderr, /--no-install/);
    await assert.rejects(stat(target), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), ["fake-npm-etarget.mjs"], "temporary scaffold must be removed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exactly one credential selects provider without question", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "auto-agent");
  try {
    const result = await invoke([target, "--no-install"], { ANTHROPIC_API_KEY: "not-printed" });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(await readFile(resolve(target, ".caveman/provider.json"), "utf8")).provider, "anthropic");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("noninteractive ambiguous provider fails without partial directory", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "ambiguous-agent");
  try {
    const result = await invoke([target, "--no-install"], {
      ANTHROPIC_API_KEY: "one",
      OPENAI_API_KEY: "two",
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /multiple provider credentials/);
    await assert.rejects(stat(target), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializer installs dependencies with an allowlisted environment and prints complete first-run steps", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "installed-agent");
  const fakeNpm = resolve(root, "fake-npm.mjs");
  await writeFile(fakeNpm, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("install-ran.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env }));',
    "",
  ].join("\n"));
  try {
    const result = await invoke(["--provider", "google", target], {
      npm_execpath: fakeNpm,
      OPENAI_API_KEY: "secret-openai",
      CAVE_API_KEY: "secret-cave",
      AWS_SECRET_ACCESS_KEY: "secret-aws",
    });
    assert.equal(result.code, 0);
    const install = JSON.parse(await readFile(resolve(target, "install-ran.json"), "utf8"));
    assert.deepEqual(install.argv, ["install", "--no-audit", "--no-fund", "--ignore-scripts"]);
    for (const key of ["OPENAI_API_KEY", "CAVE_API_KEY", "AWS_SECRET_ACCESS_KEY"]) {
      assert.equal(key in install.env, false, `${key} reached dependency installer`);
    }
    assert.equal(typeof install.env.PATH, "string");
    assert.doesNotMatch(result.stdout, /^npm install$/m);
    assert.match(result.stdout, /^export GEMINI_API_KEY="<your-api-key>"$/m);
    assert.match(result.stdout, /^npm run doctor$/m);
    assert.match(result.stdout, /^npm run ticket -- tickets\/refund-request\.md$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// F8 first-run states: the scaffold's run.ts fails with a named next step,
// never a stack trace. A stub @caveman-ai/agent package stands in for the
// unpublished SDK so the states before and after the framework boundary are
// both exercised without an install or a provider key.
async function scaffoldWithStubSDK(root) {
  const target = resolve(root, "first-run-agent");
  const created = await invoke([target, "--provider", "anthropic", "--no-install"]);
  assert.equal(created.code, 0, created.stderr);
  const stub = resolve(target, "node_modules/@caveman-ai/agent");
  await (await import("node:fs/promises")).mkdir(stub, { recursive: true });
  await writeFile(resolve(stub, "package.json"), JSON.stringify({
    name: "@caveman-ai/agent",
    type: "module",
    exports: { ".": "./index.js" },
  }));
  await writeFile(resolve(stub, "index.js"), [
    "export const loadAgentDir = async () => {",
    "  throw new Error(\"cave_stub_framework_error: stub reached\");",
    "};",
    "export const run = async () => { throw new Error(\"unreachable\"); };",
    "",
  ].join("\n"));
  return target;
}

async function runTicket(target, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "run.ts", ...args], {
      cwd: target,
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("close", (code) => done({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

test("run.ts first-run failures name a next step instead of a stack trace", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  try {
    const target = await scaffoldWithStubSDK(root);

    const noArgs = await runTicket(target, []);
    assert.equal(noArgs.code, 1);
    assert.match(noArgs.stderr, /usage: npm run ticket -- tickets\/<name>\.md/);

    const help = await runTicket(target, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /example: npm run ticket -- tickets\/refund-request\.md/);

    const extraArgs = await runTicket(target, ["tickets/refund-request.md", "ignored"]);
    assert.equal(extraArgs.code, 1);
    assert.match(extraArgs.stderr, /usage:/);
    assert.doesNotMatch(extraArgs.stderr, /stub reached/);

    const missing = await runTicket(target, ["tickets/nope.md"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /ticket file not found: tickets\/nope\.md/);
    assert.match(missing.stderr, /tickets\/refund-request\.md/);
    assert.doesNotMatch(missing.stderr, /at readFileSync/);

    // A framework error surfaces as its own message plus the doctor pointer —
    // one line each, no stack frames.
    const framework = await runTicket(target, ["tickets/refund-request.md"]);
    assert.equal(framework.code, 1);
    assert.match(framework.stderr, /cave_stub_framework_error: stub reached/);
    assert.match(framework.stderr, /npm run doctor/);
    assert.doesNotMatch(framework.stderr, /^\s+at /m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the template's eval fixtures are lockable: literal URLs, no computed source dependency", async () => {
  const evalSource = await readFile(resolve(templateRoot, "evals/support.eval.ts"), "utf8");
  // The source graph rejects `new URL(`…${…}…`, import.meta.url)` as a
  // computed dependency, which would fail doctor/build on the scaffold's own
  // golden path (found by the Phase-5 dry cold walk).
  assert.doesNotMatch(evalSource, /new URL\(`/);
  for (const name of ["refund-request", "order-status", "angry-escalation"]) {
    assert.match(evalSource, new RegExp(`new URL\\("\\.\\./tickets/${name}\\.md", import\\.meta\\.url\\)`));
  }
});

test("initializer rejects unknown options without writing target", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "unknown-option");
  try {
    const result = await invoke([target, "--wat"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown option --wat/);
    await assert.rejects(stat(target), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("common option forms work and generated commands handle spaces and apostrophes", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "Jane's agent");
  try {
    const result = await invoke([target, "--provider=openai", "--template=support-bot", "--no-install"], {
      OPENAI_API_KEY: "never-print-this-key",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^created jane-s-agent \(support-bot\)$/m);
    assert.doesNotMatch(result.stdout, /export OPENAI_API_KEY|never-print-this-key/);
    const cd = result.stdout.split("\n").find((line) => line.startsWith("cd "));
    const entered = await new Promise((done) => {
      const child = spawn("sh", ["-c", `${cd} && pwd -P`], { stdio: ["ignore", "pipe", "pipe"] });
      const out = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.once("close", (code) => done({ code, stdout: Buffer.concat(out).toString("utf8").trim() }));
    });
    assert.equal(entered.code, 0);
    assert.equal(entered.stdout, await (await import("node:fs/promises")).realpath(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid flags fail before creating files", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "invalid-agent");
  try {
    for (const [args, message] of [
      [["-x"], /unknown option -x/],
      [["--provider"], /--provider requires/],
      [["--provider="], /--provider requires/],
      [["--provider=unknown"], /choose anthropic, openai, or google/],
      [["--template="], /--template requires/],
      [["--provider=openai", "--provider=google"], /--provider may only be specified once/],
    ]) {
      const result = await invoke([target, "--no-install", ...args]);
      assert.equal(result.code, 1, JSON.stringify(args));
      assert.match(result.stderr, message);
      assert.deepEqual(await readdir(root), []);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing directories and dangling symlinks remain untouched", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  try {
    const directory = resolve(root, "existing");
    const dangling = resolve(root, "dangling");
    await mkdir(directory);
    await writeFile(resolve(directory, "keep.txt"), "keep");
    await symlink(resolve(root, "missing"), dangling);
    for (const target of [directory, dangling]) {
      const result = await invoke([target, "--provider", "anthropic", "--no-install"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /target already exists/);
    }
    assert.equal(await readFile(resolve(directory, "keep.txt"), "utf8"), "keep");
    assert.equal((await lstat(dangling)).isSymbolicLink(), true);
    assert.deepEqual((await readdir(root)).sort(), ["dangling", "existing"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("target created during installation is preserved and temporary scaffold removed", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "race-agent");
  const fakeNpm = resolve(root, "fake-npm.mjs");
  await writeFile(fakeNpm, 'import { mkdirSync } from "node:fs"; mkdirSync("../race-agent");\n');
  try {
    const result = await invoke([target, "--provider=anthropic"], { npm_execpath: fakeNpm });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /target already exists/);
    assert.deepEqual(await readdir(target), []);
    assert.deepEqual((await readdir(root)).sort(), ["fake-npm.mjs", "race-agent"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("other dependency failures keep the npm diagnosis and never invent SDK publication status", async () => {
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, "failed-install");
  const fakeNpm = resolve(root, "fake-npm.mjs");
  await writeFile(fakeNpm, 'process.stderr.write("npm error ETARGET: No matching version found for typescript@99.0.0\\n"); process.exit(1);\n');
  try {
    const result = await invoke([target, "--provider=anthropic"], { npm_execpath: fakeNpm });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /No matching version found for typescript/);
    assert.match(result.stderr, /npm install failed \(1\).*--no-install/);
    assert.doesNotMatch(result.stderr, /requested @caveman-ai\/agent version|not been published/);
    assert.deepEqual(await readdir(root), ["fake-npm.mjs"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Each template is scaffolded non-interactively and then
// typechecked against the repository's built @caveman-ai/agent declarations,
// so a drifted export in server.ts/tools/ fails here instead of on a user's
// first `npm run dev`.
for (const template of ["support-bot", "background-agent"]) test(`the ${template} template scaffolds and typechecks`, async (t) => {
  const repoRoot = resolve(packageRoot, "../..");
  const agentPackage = resolve(repoRoot, "packages/agent");
  const tsc = resolve(repoRoot, "node_modules/.bin/tsc");
  if (!(await stat(resolve(agentPackage, "dist/index.d.ts")).catch(() => null))) {
    t.skip("build @caveman-ai/agent first to check generated template types");
    return;
  }
  const root = await mkdtemp(`${tmpdir()}/create-caveman-agent-`);
  const target = resolve(root, template);
  try {
    const result = await invoke(
      [target, "--template", template, "--provider", "anthropic", "--no-install"],
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(
      await walkFiles(target),
      [
        ...await walkFiles(resolve(packageRoot, `templates/${template}`)),
        ".caveman/provider.json",
        ".gitignore",
      ].sort(),
    );
    const manifest = JSON.parse(await readFile(resolve(target, "package.json"), "utf8"));
    assert.equal(manifest.scripts.typecheck, "tsc --noEmit");
    assert.equal(manifest.devDependencies["@types/node"], "24.10.1");

    await mkdir(resolve(target, "node_modules/@caveman-ai"), { recursive: true });
    await symlink(agentPackage, resolve(target, "node_modules/@caveman-ai/agent"), "dir");
    await symlink(
      resolve(repoRoot, "node_modules/@types"),
      resolve(target, "node_modules/@types"),
      "dir",
    );
    const typecheck = await new Promise((done) => {
      const child = spawn(tsc, ["--noEmit", "--project", "tsconfig.json"], {
        cwd: target,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const out = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => out.push(chunk));
      child.once("close", (code) => done({ code, out: Buffer.concat(out).toString("utf8") }));
    });
    assert.equal(typecheck.code, 0, typecheck.out);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
