#!/usr/bin/env node
import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

type Provider = "anthropic" | "openai" | "google";

// The scaffolded default model per provider. Each is resolvable by the
// runtime's pinned Pi registry, priced by the public catalog, and caches with
// a minimum prefix the template's frozen prefix clears (1,024 tokens for the
// Anthropic pick; 2,048 for the OpenAI and Google picks):
// - anthropic/claude-sonnet-5 — explicit cache breakpoints.
// - openai/gpt-5.4-mini — catalog cacheMode "affinity" (OpenAI's automatic
//   prompt caching); no explicit-cache OpenAI model exists in the pinned
//   registry, and this one keeps the template's $0.05/ticket budget viable.
// - google/gemini-2.5-flash — implicit provider-managed caching; Google has
//   no explicit-cache model in the catalog.
// The generator rewrites the template agent.ts model line to this value.
const MODELS: Record<Provider, string> = {
  anthropic: "anthropic/claude-sonnet-5",
  openai: "openai/gpt-5.4-mini",
  google: "google/gemini-2.5-flash",
};

const CREDENTIALS: Record<Provider, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

// The exact model line every template's agent.ts ships with; the
// single-point mutation below (like the package.json name field) swaps it
// for the chosen provider's model. Rewriting fails closed if the template
// line ever drifts from this constant.
const TEMPLATE_MODEL_LINE = `  model: "${MODELS.anthropic}",`;

const USAGE = "usage: npm create @caveman-ai/agent@latest <project> -- [options]";
const HELP = `${USAGE}

Create a TypeScript agent in a new directory. Requires Node.js >=22.19.0.

Options:
  --provider <name>  anthropic, openai, or google
  --template <name>  support-bot (default) or background-agent
  --no-install       Create files without running npm install
  -h, --help         Show this help

One detected API key selects its provider. Otherwise interactive terminals
prompt; noninteractive callers must pass --provider. Keys are never saved.

Example:
  npm create @caveman-ai/agent@latest my-agent -- --provider anthropic
`;

type Template = "support-bot" | "background-agent";

// Each template's agent.ts carries TEMPLATE_MODEL_LINE, so the model rewrite
// below is one code path for both.
const TEMPLATES: Record<Template, { nextSteps: readonly string[]; ignore?: string }> = {
  "support-bot": {
    nextSteps: [
      "npm run ticket -- tickets/refund-request.md",
      "review evals/support.eval.ts, then npm run build (all declared evals run within budget)",
    ],
  },
  "background-agent": {
    // The session journal holds conversation content; it is never committed.
    ignore: ".caveman/sessions.db*\n",
    nextSteps: [
      "export CAVE_SERVE_TOKEN=$(openssl rand -hex 24)",
      "npm run dev",
      "read README.md for the session curl flow and the sandbox shim",
    ],
  },
};

const templateDir = (template: Template): string =>
  fileURLToPath(new URL(`../templates/${template}`, import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const optionArgs = args.slice(0, args.indexOf("--") < 0 ? undefined : args.indexOf("--"));
  if (optionArgs.includes("--help") || optionArgs.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const parsed = parseArgs(args);
  const targetArg = parsed.target;
  const target = resolve(targetArg);
  const name = safeName(basename(target));
  await assertAbsent(target);
  const provider = await chooseProvider(parsed.provider);
  const template = parsed.template;
  const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await cp(templateDir(template), temporary, { recursive: true });
    const manifestPath = resolve(temporary, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.name = name;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await rewriteAgentModel(resolve(temporary, "agent.ts"), provider);
    await mkdir(resolve(temporary, ".caveman"), { recursive: true });
    const generated: Record<string, string> = {
      ".caveman/provider.json": `${JSON.stringify({ provider, model: MODELS[provider] }, null, 2)}\n`,
      ".gitignore": `node_modules/\n.caveman/traces/\n.caveman/agent-dir-entry.mjs\n.caveman/workload-profile.json\n.env*\n${TEMPLATES[template].ignore ?? ""}`,
    };
    for (const [path, content] of Object.entries(generated)) {
      await writeFile(resolve(temporary, path), content, { flag: "wx", mode: 0o600 });
    }
    if (parsed.install) await installDependencies(temporary);
    // Installation can take minutes. Recheck before publishing the result so
    // a directory or symlink created in the meantime is not replaced.
    await assertAbsent(target);
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  process.stdout.write([
    `created ${name} (${template})`,
    `provider ${provider} (${MODELS[provider]})`,
    `cd -- ${shellQuote(targetArg)}`,
    ...(parsed.install ? [] : ["npm install"]),
    ...(CREDENTIALS[provider].some((key) => process.env[key]?.trim())
      ? [] : [`export ${CREDENTIALS[provider][0]}="<your-api-key>"`]),
    "npm run doctor",
    ...TEMPLATES[template].nextSteps,
    "",
  ].join("\n"));
}

function parseArgs(args: string[]): {
  target: string;
  provider?: string;
  template: Template;
  install: boolean;
} {
  let provider: string | undefined;
  let template: Template = "support-bot";
  let install = true;
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (value === "--provider" || value.startsWith("--provider=")) {
      const candidate = value === "--provider" ? args[++index] : value.slice("--provider=".length);
      if (!candidate || candidate.startsWith("-")) throw new Error("--provider requires anthropic, openai, or google");
      if (provider !== undefined) throw new Error("--provider may only be specified once");
      provider = candidate;
      continue;
    }
    if (value === "--template" || value.startsWith("--template=")) {
      const candidate = value === "--template" ? args[++index] : value.slice("--template=".length);
      if (candidate !== "support-bot" && candidate !== "background-agent") {
        throw new Error("--template requires support-bot or background-agent");
      }
      template = candidate;
      continue;
    }
    if (value === "--no-install") {
      install = false;
      continue;
    }
    if (value.startsWith("-")) throw new Error(`unknown option ${value}; use --help for usage`);
    positional.push(value);
  }
  if (positional.length !== 1) {
    throw new Error(
      USAGE,
    );
  }
  return {
    target: positional[0]!,
    ...(provider === undefined ? {} : { provider }),
    template,
    install,
  };
}

// Pinned string models must use the provider/model form, and a pinned model
// makes provider.json's fallback inert — so the template's model line itself
// is rewritten to the chosen provider's default.
async function rewriteAgentModel(agentTsPath: string, provider: Provider): Promise<void> {
  const source = await readFile(agentTsPath, "utf8");
  if (!source.includes(TEMPLATE_MODEL_LINE)) {
    throw new Error("template agent.ts model line drifted from the generator's expectation");
  }
  await writeFile(
    agentTsPath,
    source.replace(TEMPLATE_MODEL_LINE, `  model: "${MODELS[provider]}",`),
  );
}

async function installDependencies(directory: string): Promise<void> {
  const npmExecPath = process.env.npm_execpath;
  const windowsShell = !npmExecPath && process.platform === "win32";
  const command = npmExecPath
    ? process.execPath
    : windowsShell
      ? process.env.ComSpec ?? "cmd.exe"
      : "npm";
  const args = npmExecPath
    ? [npmExecPath, "install", "--no-audit", "--no-fund", "--ignore-scripts"]
    : windowsShell
      ? ["/d", "/s", "/c", "npm install --no-audit --no-fund --ignore-scripts"]
      : ["install", "--no-audit", "--no-fund", "--ignore-scripts"];
  await new Promise<void>((done, reject) => {
    const child = spawn(command, args, {
      cwd: directory,
      env: dependencyInstallEnv(),
      // stderr is captured (and echoed) so registry errors survive rollback.
      stdio: ["ignore", "inherit", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      process.stderr.write(chunk);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        done();
        return;
      }
      const captured = Buffer.concat(stderr).toString("utf8");
      // Only diagnose the SDK when npm identifies it. ETARGET from another
      // dependency, or a stale private registry, says nothing about release status.
      if (/No matching version found for @caveman-ai\/agent@/.test(captured)) {
        reject(new Error([
          "npm could not find the requested @caveman-ai/agent version in the configured registry.",
          "Check the registry and package version. For local development, re-run with",
          "--no-install and install the SDK from a built local checkout (see README.md).",
        ].join("\n")));
        return;
      }
      reject(new Error(`npm install failed (${signal ?? code}); target was not created. Fix the npm error above, or re-run with --no-install.`));
    });
  });
}

function dependencyInstallEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "ComSpec", "PATHEXT",
    "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "NO_COLOR", "FORCE_COLOR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "NPM_CONFIG_CACHE", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_USERCONFIG",
    "npm_config_cache", "npm_config_registry", "npm_config_userconfig",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function chooseProvider(flag: string | undefined): Promise<Provider> {
  if (flag !== undefined) return parseProvider(flag);
  const detected: Provider[] = [];
  for (const provider of Object.keys(CREDENTIALS) as Provider[]) {
    if (CREDENTIALS[provider].some((key) => process.env[key]?.trim())) detected.push(provider);
  }
  if (detected.length === 1) return detected[0]!;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      detected.length === 0
        ? "no provider credential detected; pass --provider anthropic, openai, or google"
        : "multiple provider credentials detected; pass --provider anthropic, openai, or google",
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Provider (anthropic/openai/google): ");
    return parseProvider(answer);
  } finally {
    rl.close();
  }
}

function parseProvider(value: string): Provider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "openai" || normalized === "google") return normalized;
  throw new Error(`unsupported provider ${JSON.stringify(value)}; choose anthropic, openai, or google`);
}

// Mirrors the SDK's slugifyAgentDirId: the project directory name becomes the
// agent id, so both must slug the same way (lowercase, invalid chars → "-",
// repeats collapsed, trimmed, [a-z0-9] first character, 96 max).
function safeName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(normalized)) {
    throw new Error("project name must slug to a valid agent id ([a-z0-9][a-z0-9_-]*)");
  }
  return normalized;
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error(`target already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`create-caveman-agent: ${message}\n`);
  process.exitCode = 1;
});
