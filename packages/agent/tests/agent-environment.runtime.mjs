import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AGENT_PLUGINS_SCHEMA,
  applyAgentEnvironment,
  createAgentEnvironmentTransform,
  expandAgentEnvironmentSlashCommand,
  loadAgentEnvironment,
  loadAgentPlugin,
  readAgentSkillResource,
  renderAgentPluginCommandInvocation,
  renderAgentSkillInvocation,
  renderAgentSkillsIndex,
} from "../dist/agent-environment.js";
import { createCodingAgent } from "../dist/code.js";
import { agent } from "../dist/index.js";

const skill = (name, description, body = `# ${name}\n`) => [
  "---",
  `name: ${name}`,
  `description: ${description}`,
  "---",
  "",
  body,
].join("\n");

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "cave-agent-environment-"));
  const root = join(base, "repo");
  const cwd = join(root, "packages", "app");
  const home = join(base, "home");
  await Promise.all([
    mkdir(join(root, ".git"), { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(root, ".agents", "skills", "review"), { recursive: true }),
    mkdir(join(root, ".agents", "plugins", "standard", "skills", "audit"), { recursive: true }),
    mkdir(join(root, ".agents", "plugins", "vercel", ".plugin"), { recursive: true }),
    mkdir(join(root, ".agents", "plugins", "vercel", "skills", "nextjs"), { recursive: true }),
    mkdir(join(root, ".agents", "plugins", "vercel", "commands"), { recursive: true }),
    mkdir(join(root, ".agents", "plugins", "vercel", "hooks"), { recursive: true }),
    mkdir(join(root, ".agents", "plugins", "vercel", "agents"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, ".agents", "skills", "review", "SKILL.md"),
      [
        "---",
        "name: review",
        "description: \"Review code: use when asked for review.\"",
        "metadata:",
        "  owner: pebble",
        "---",
        "",
        "# Review",
        "Read before commenting.",
      ].join("\n"),
    ),
    writeFile(
      join(root, ".agents", "plugins", "standard", "plugin.json"),
      JSON.stringify({
        $schema: AGENT_PLUGINS_SCHEMA,
        name: "standard-plugin",
        version: "1.0.0",
        futureField: true,
      }),
    ),
    writeFile(
      join(root, ".agents", "plugins", "standard", "skills", "audit", "SKILL.md"),
      skill("audit", "Audit a standard plugin."),
    ),
    writeFile(
      join(root, ".agents", "plugins", "standard", "mcp.json"),
      JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} }),
    ),
    writeFile(
      join(root, ".agents", "plugins", "vercel", ".plugin", "plugin.json"),
      JSON.stringify({ name: "vercel-plugin", version: "0.48.1", description: "Vercel expertise." }),
    ),
    writeFile(
      join(root, ".agents", "plugins", "vercel", "skills", "nextjs", "SKILL.md"),
      skill("nextjs", "Build with current Next.js guidance."),
    ),
    writeFile(
      join(root, ".agents", "plugins", "vercel", "commands", "deploy.md"),
      [
        "---",
        "description: Deploy preview or production.",
        "---",
        "",
        "Deploy target from $ARGUMENTS. First argument: $1.",
      ].join("\n"),
    ),
    writeFile(
      join(root, ".agents", "plugins", "vercel", ".mcp.json"),
      JSON.stringify({ mcpServers: { vercel: { type: "http", url: "https://mcp.vercel.com" } } }),
    ),
  ]);
  return { base, root, cwd, home };
}

test("environment loads Agent Plugins v1 and OpenPlugin skills and commands", async () => {
  const { base, cwd, home } = await fixture();
  try {
    const environment = await loadAgentEnvironment({ cwd, homeDir: home });
    assert.deepEqual(environment.skills.map((entry) => entry.id), [
      "review",
      "standard-plugin:audit",
      "vercel-plugin:nextjs",
    ]);
    assert.deepEqual(environment.commands.map((entry) => entry.id), ["vercel-plugin:deploy"]);
    assert.deepEqual(environment.plugins.map((entry) => [entry.manifest.name, entry.format]), [
      ["standard-plugin", "agent-plugins-v1"],
      ["vercel-plugin", "open-plugin"],
    ]);
    assert.equal(environment.plugins.every((entry) => entry.hasMcp), true);
    // Plugin MCP is parsed for hosts to report; plugin loading never launches it.
    assert.deepEqual(environment.plugins.map((entry) => entry.mcpServers.map((server) => [server.name, server.config.url])), [
      [],
      [["vercel", "https://mcp.vercel.com"]],
    ]);
    assert.ok(environment.diagnostics.some((entry) =>
      entry.message === "plugin MCP servers parsed (1) but never launched by plugin loading"));
    assert.equal(
      environment.diagnostics.some((entry) => entry.code === "agent_environment_unsupported_plugin_field"),
      true,
    );
    assert.equal(
      environment.diagnostics.some((entry) => entry.code === "agent_environment_unsupported_plugin_mcp"),
      true,
    );
    assert.equal(
      environment.diagnostics.some((entry) => entry.code === "agent_environment_unsupported_plugin_hooks"),
      true,
    );
    assert.equal(
      environment.diagnostics.some((entry) => entry.code === "agent_environment_unsupported_plugin_agents"),
      true,
    );

    const invocation = renderAgentSkillInvocation(environment, "vercel-plugin:nextjs", "app router");
    assert.match(invocation, /Apply explicitly invoked Agent Skill "vercel-plugin:nextjs"/);
    assert.match(invocation, /User request:\n\napp router/);
    const command = renderAgentPluginCommandInvocation(environment, "vercel-plugin:deploy", "prod");
    assert.match(command, /Deploy target from prod\. First argument: prod\./);
    assert.doesNotMatch(command, /\$ARGUMENTS|\$1/);
    assert.match(
      expandAgentEnvironmentSlashCommand("/vercel-plugin:deploy prod", environment),
      /Execute explicitly invoked Agent Plugin command/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("coding-agent environment collapses load_skill under one programmatic tool", async () => {
  const { base, cwd, home } = await fixture();
  try {
    const environment = await loadAgentEnvironment({ cwd, homeDir: home });
    const coding = createCodingAgent({
      workspace: cwd,
      model: "openai/gpt-5.4",
      toolSet: "pebble-v1",
      toolMode: "programmatic",
      programmaticToolName: "pebble_code",
      definitionTransforms: [createAgentEnvironmentTransform(environment)],
    });
    assert.deepEqual(coding.definition.tools.map((entry) => entry.name), ["pebble_code"]);
    const nested = coding.definition.tools[0].nestedTools;
    assert.equal(nested.some((entry) => entry.name === "load_skill"), true);
    const loader = nested.find((entry) => entry.name === "load_skill");
    assert.match(await loader.execute({ name: "review" }), /Read before commenting/);
    assert.match(
      String(coding.definition.contexts.find((entry) => entry.id === "agent.skills")?.source),
      /vercel-plugin:nextjs/,
    );
    assert.match(
      String(coding.definition.contexts.find((entry) => entry.id === "agent.plugin-commands")?.source),
      /vercel-plugin:deploy/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("skill resources and plugin packages stay contained", async () => {
  const { base, root, cwd, home } = await fixture();
  try {
    const environment = await loadAgentEnvironment({ cwd, homeDir: home });
    const review = environment.skills.find((entry) => entry.id === "review");
    await writeFile(join(review.root, "reference.md"), "safe\n");
    assert.equal(await readAgentSkillResource(review, "reference.md"), "safe\n");
    await assert.rejects(readAgentSkillResource(review, "../secret"), /resource_path_invalid/);

    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "SKILL.md"), skill("escape", "Must not load."));
    await symlink(outside, join(root, ".agents", "skills", "escape"));
    const reloaded = await loadAgentEnvironment({ cwd, homeDir: home });
    assert.equal(reloaded.skills.some((entry) => entry.id === "escape"), false);

    const invalid = join(base, "invalid-plugin");
    await mkdir(invalid);
    await writeFile(join(invalid, "plugin.json"), JSON.stringify({
      $schema: AGENT_PLUGINS_SCHEMA,
      name: "Invalid Name",
    }));
    await assert.rejects(loadAgentPlugin(invalid), /plugin_name_invalid/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("generic definitions receive same environment contexts and lazy loader", async () => {
  const { base, cwd, home } = await fixture();
  try {
    const environment = await loadAgentEnvironment({ cwd, homeDir: home });
    const definition = applyAgentEnvironment(agent({
      id: "support",
      instructions: "support",
      model: "openai/gpt-5.4",
      sandbox: "host",
    }), environment);
    assert.equal(definition.tools.some((entry) => entry.name === "load_skill"), true);
    assert.deepEqual(definition.contexts.map((entry) => entry.id), [
      "agent.skills",
      "agent.plugin-commands",
    ]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("skill index caps its size by shortening descriptions, never by dropping skills", () => {
  const entry = (id, description) => ({ id, name: id, description, root: `/skills/${id}`, file: `/skills/${id}/SKILL.md`, body: "" });
  const few = [entry("review", "Review code."), entry("deploy", "Deploy services.")];
  assert.equal(renderAgentSkillsIndex(few).split("\n").slice(2).join("\n"), "- review: Review code.\n- deploy: Deploy services.");
  const long = entry("verbose", "x".repeat(1000));
  assert.match(renderAgentSkillsIndex([long]), /\n- verbose: x{319}…$/);

  const many = Array.from({ length: 64 }, (_, index) =>
    entry(`skill-${String(index).padStart(2, "0")}`, `Use for task family ${index}. ${"detail ".repeat(64)}`));
  const index = renderAgentSkillsIndex(many);
  assert.ok(index.length <= 8_192, `index is ${index.length} chars`);
  for (const skill of many) assert.match(index, new RegExp(`\\n- ${skill.id}: Use for task family`));
  assert.equal(index, renderAgentSkillsIndex(many), "cap is deterministic");

  const crowded = Array.from({ length: 400 }, (_, index) => entry(`s-${index}-${"n".repeat(20)}`, "Does a thing."));
  const names = renderAgentSkillsIndex(crowded);
  assert.equal(names.split("\n").length, 402, "names survive even past the cap");
  assert.doesNotMatch(names, /Does a thing/);
});
