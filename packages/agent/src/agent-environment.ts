import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  agent,
  type AgentDefinition,
  type AgentDefinitionTransform,
} from "./definition.js";
import { context, schema, tool, type ContextDefinition } from "./primitives.js";
import { parseDocument } from "yaml";

export const AGENT_PLUGINS_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_SKILLS_CONTEXT_ID = "agent.skills";
export const AGENT_PLUGIN_COMMANDS_CONTEXT_ID = "agent.plugin-commands";

const MAX_SKILL_BYTES = 1024 * 1024;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PLUGIN_NAME = /^(?!.*--)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export type AgentEnvironmentDiagnosticCode =
  | "agent_environment_duplicate_command"
  | "agent_environment_duplicate_plugin"
  | "agent_environment_duplicate_skill"
  | "agent_environment_invalid_command"
  | "agent_environment_invalid_plugin"
  | "agent_environment_invalid_skill"
  | "agent_environment_unsupported_plugin_agents"
  | "agent_environment_unsupported_plugin_field"
  | "agent_environment_unsupported_plugin_hooks"
  | "agent_environment_unsupported_plugin_mcp";

export interface AgentEnvironmentDiagnostic {
  readonly code: AgentEnvironmentDiagnosticCode;
  readonly path: string;
  readonly message: string;
}

export interface AgentSkill {
  /** Direct skills use their name. Plugin skills use `plugin:skill`. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly root: string;
  readonly file: string;
  readonly body: string;
  readonly plugin?: string;
}

export interface AgentPluginManifest {
  readonly $schema?: typeof AGENT_PLUGINS_SCHEMA;
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly author?: {
    readonly name?: string;
    readonly email?: string;
    readonly url?: string;
  };
  readonly homepage?: string;
  readonly repository?: string;
  readonly license?: string;
  readonly keywords?: readonly string[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type AgentPluginFormat =
  | "agent-plugins-v1"
  | "open-plugin"
  | "claude-code"
  | "cursor";

export interface AgentPluginCommand {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly root: string;
  readonly file: string;
  readonly body: string;
  readonly plugin: string;
}

export interface AgentPlugin {
  readonly root: string;
  readonly format: AgentPluginFormat;
  readonly manifest: AgentPluginManifest;
  readonly skills: readonly AgentSkill[];
  readonly commands: readonly AgentPluginCommand[];
  /** MCP declaration exists, but this SDK currently implements declarative content only. */
  readonly hasMcp: boolean;
  readonly hasHooks: boolean;
  readonly hasAgents: boolean;
}

export interface AgentEnvironment {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly skills: readonly AgentSkill[];
  readonly commands: readonly AgentPluginCommand[];
  readonly plugins: readonly AgentPlugin[];
  readonly diagnostics: readonly AgentEnvironmentDiagnostic[];
}

export interface LoadAgentEnvironmentOptions {
  readonly cwd?: string;
  readonly homeDir?: string;
  /** Highest precedence first. Missing roots are ignored. */
  readonly skillRoots?: readonly string[];
  /** Exact plugin package roots, highest precedence first. */
  readonly pluginRoots?: readonly string[];
  /** Directories whose immediate children may be plugin package roots. */
  readonly pluginCollections?: readonly string[];
  readonly includeDefaultRoots?: boolean;
  /** Auto-detect a plugin manifest at cwd. Defaults true. */
  readonly includeWorkspacePlugin?: boolean;
}

export interface ApplyAgentEnvironmentOptions {
  /** Ordinary tool name, so programmatic coding mode can collapse it. */
  readonly skillToolName?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function regularContainedFile(root: string, candidate: string): Promise<string> {
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(root), realpath(candidate)]);
  if (!contained(canonicalRoot, canonicalFile)) {
    throw new Error(`cave_agent_package_path_escape:${candidate}`);
  }
  const info = await stat(canonicalFile);
  if (!info.isFile()) throw new Error(`cave_agent_regular_file_required:${candidate}`);
  return canonicalFile;
}

async function optionalKind(
  path: string,
  kind: "file" | "directory",
): Promise<"missing" | "valid" | "invalid"> {
  try {
    const info = await stat(path);
    return (kind === "file" ? info.isFile() : info.isDirectory()) ? "valid" : "invalid";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

function frontmatter(raw: string, file: string): { metadata: Record<string, unknown>; body: string } {
  const normalized = raw.replaceAll("\r\n", "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (match === null) {
    throw new Error(`cave_agent_skill_frontmatter_required:${file}`);
  }
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(`cave_agent_skill_frontmatter_invalid:${file}:${document.errors[0]!.message}`);
  }
  const metadata: unknown = document.toJS({ maxAliasCount: 0 });
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`cave_agent_skill_frontmatter_object_required:${file}`);
  }
  return { metadata: metadata as Record<string, unknown>, body: match[2]! };
}

export function parseAgentSkill(
  raw: string,
  options: { readonly file: string; readonly root: string; readonly id?: string; readonly plugin?: string },
): AgentSkill {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes === 0 || bytes > MAX_SKILL_BYTES) {
    throw new Error(`cave_agent_skill_size_invalid:${options.file}:${bytes}`);
  }
  const parsed = frontmatter(raw, options.file);
  const name = parsed.metadata.name;
  const description = parsed.metadata.description;
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    throw new Error(`cave_agent_skill_name_invalid:${options.file}`);
  }
  if (name !== basename(options.root)) {
    throw new Error(`cave_agent_skill_directory_mismatch:${options.file}:${name}`);
  }
  if (typeof description !== "string" || description.length === 0 || description.length > 1024) {
    throw new Error(`cave_agent_skill_description_invalid:${options.file}`);
  }
  const compatibility = parsed.metadata.compatibility;
  if (compatibility !== undefined &&
      (typeof compatibility !== "string" || compatibility.length === 0 || compatibility.length > 500)) {
    throw new Error(`cave_agent_skill_compatibility_invalid:${options.file}`);
  }
  for (const field of ["license", "allowed-tools"] as const) {
    const value = parsed.metadata[field];
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`cave_agent_skill_${field}_invalid:${options.file}`);
    }
  }
  const metadata = parsed.metadata.metadata;
  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata) ||
        Object.values(metadata).some((value) => typeof value !== "string")) {
      throw new Error(`cave_agent_skill_metadata_invalid:${options.file}`);
    }
  }
  return Object.freeze({
    id: options.id ?? name,
    name,
    description,
    root: options.root,
    file: options.file,
    body: raw,
    ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
  });
}

export async function loadAgentSkillDirectory(
  root: string,
  options: { readonly plugin?: string } = {},
): Promise<{ readonly skills: readonly AgentSkill[]; readonly diagnostics: readonly AgentEnvironmentDiagnostic[] }> {
  const kind = await optionalKind(root, "directory");
  if (kind === "missing") return { skills: [], diagnostics: [] };
  if (kind === "invalid") throw new Error(`cave_agent_skills_directory_invalid:${root}`);
  const canonicalRoot = await realpath(root);
  const entries = (await readdir(canonicalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  const skills: AgentSkill[] = [];
  const diagnostics: AgentEnvironmentDiagnostic[] = [];
  for (const entry of entries) {
    const skillRoot = join(canonicalRoot, entry.name);
    const skillFile = join(skillRoot, "SKILL.md");
    if (await optionalKind(skillFile, "file") !== "valid") continue;
    try {
      const canonicalFile = await regularContainedFile(canonicalRoot, skillFile);
      const raw = await readFile(canonicalFile, "utf8");
      const id = options.plugin === undefined ? entry.name : `${options.plugin}:${entry.name}`;
      skills.push(parseAgentSkill(raw, {
        file: canonicalFile,
        root: await realpath(skillRoot),
        id,
        ...(options.plugin === undefined ? {} : { plugin: options.plugin }),
      }));
    } catch (error) {
      diagnostics.push({
        code: "agent_environment_invalid_skill",
        path: skillFile,
        message: errorText(error),
      });
    }
  }
  return { skills: Object.freeze(skills), diagnostics: Object.freeze(diagnostics) };
}

async function loadAgentPluginCommandDirectory(
  root: string,
  plugin: string,
): Promise<{
  readonly commands: readonly AgentPluginCommand[];
  readonly diagnostics: readonly AgentEnvironmentDiagnostic[];
}> {
  const kind = await optionalKind(root, "directory");
  if (kind === "missing") return { commands: [], diagnostics: [] };
  if (kind === "invalid") throw new Error(`cave_agent_plugin_commands_directory_invalid:${root}`);
  const canonicalRoot = await realpath(root);
  const entries = (await readdir(canonicalRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const commands: AgentPluginCommand[] = [];
  const diagnostics: AgentEnvironmentDiagnostic[] = [];
  for (const entry of entries) {
    const file = join(canonicalRoot, entry.name);
    try {
      const canonicalFile = await regularContainedFile(canonicalRoot, file);
      const raw = await readFile(canonicalFile, "utf8");
      const bytes = Buffer.byteLength(raw, "utf8");
      if (bytes === 0 || bytes > MAX_SKILL_BYTES) {
        throw new Error(`cave_agent_plugin_command_size_invalid:${canonicalFile}:${bytes}`);
      }
      const name = basename(entry.name, ".md");
      if (!SKILL_NAME.test(name)) {
        throw new Error(`cave_agent_plugin_command_name_invalid:${canonicalFile}`);
      }
      const parsed = frontmatter(raw, canonicalFile);
      const description = parsed.metadata.description;
      if (typeof description !== "string" || description.length === 0 || description.length > 1024) {
        throw new Error(`cave_agent_plugin_command_description_invalid:${canonicalFile}`);
      }
      commands.push(Object.freeze({
        id: `${plugin}:${name}`,
        name,
        description,
        root: canonicalRoot,
        file: canonicalFile,
        body: raw,
        plugin,
      }));
    } catch (error) {
      diagnostics.push({
        code: "agent_environment_invalid_command",
        path: file,
        message: errorText(error),
      });
    }
  }
  return { commands: Object.freeze(commands), diagnostics: Object.freeze(diagnostics) };
}

const PLUGIN_FIELDS = new Set([
  "$schema", "name", "version", "description", "author", "homepage",
  "repository", "license", "keywords", "extensions",
]);
const COMPAT_PLUGIN_FIELDS = new Set([
  ...PLUGIN_FIELDS,
  "agents", "commands", "hooks", "logo", "mcpServers", "skills",
]);
const PLUGIN_MANIFEST_LOCATIONS: readonly {
  readonly path: string;
  readonly format: AgentPluginFormat;
}[] = Object.freeze([
  { path: "plugin.json", format: "agent-plugins-v1" },
  { path: join(".plugin", "plugin.json"), format: "open-plugin" },
  { path: join(".claude-plugin", "plugin.json"), format: "claude-code" },
  { path: join(".cursor-plugin", "plugin.json"), format: "cursor" },
]);

async function resolveAgentPluginManifest(root: string): Promise<{
  readonly root: string;
  readonly path: string;
  readonly format: AgentPluginFormat;
} | undefined> {
  const canonicalRoot = await realpath(root);
  for (const location of PLUGIN_MANIFEST_LOCATIONS) {
    const candidate = join(canonicalRoot, location.path);
    if (await optionalKind(candidate, "file") !== "valid") continue;
    return {
      root: canonicalRoot,
      path: await regularContainedFile(canonicalRoot, candidate),
      format: location.format,
    };
  }
  return undefined;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`cave_agent_plugin_field_invalid:${field}`);
  return value;
}

function validatePluginManifest(
  value: unknown,
  path: string,
  format: AgentPluginFormat,
): { manifest: AgentPluginManifest; diagnostics: AgentEnvironmentDiagnostic[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`cave_agent_plugin_manifest_invalid:${path}`);
  }
  const input = value as Record<string, unknown>;
  if (format === "agent-plugins-v1" && input["$schema"] !== AGENT_PLUGINS_SCHEMA) {
    throw new Error(`cave_agent_plugin_schema_unsupported:${path}`);
  }
  if (typeof input.name !== "string" || !PLUGIN_NAME.test(input.name)) {
    throw new Error(`cave_agent_plugin_name_invalid:${path}`);
  }
  const diagnostics: AgentEnvironmentDiagnostic[] = [];
  for (const field of Object.keys(input)) {
    const fields = format === "agent-plugins-v1" ? PLUGIN_FIELDS : COMPAT_PLUGIN_FIELDS;
    if (!fields.has(field)) {
      diagnostics.push({
        code: "agent_environment_unsupported_plugin_field",
        path,
        message: `ignored unknown plugin.json field ${JSON.stringify(field)}`,
      });
    }
  }
  let author: AgentPluginManifest["author"];
  if (input.author !== undefined) {
    if (input.author === null || typeof input.author !== "object" || Array.isArray(input.author)) {
      throw new Error(`cave_agent_plugin_field_invalid:author`);
    }
    const candidate = input.author as Record<string, unknown>;
    for (const key of Object.keys(candidate)) {
      if (!new Set(["name", "email", "url"]).has(key)) {
        throw new Error(`cave_agent_plugin_field_invalid:author.${key}`);
      }
    }
    author = {
      ...(optionalString(candidate.name, "author.name") === undefined ? {} : { name: candidate.name as string }),
      ...(optionalString(candidate.email, "author.email") === undefined ? {} : { email: candidate.email as string }),
      ...(optionalString(candidate.url, "author.url") === undefined ? {} : { url: candidate.url as string }),
    };
  }
  let keywords: readonly string[] | undefined;
  if (input.keywords !== undefined) {
    if (!Array.isArray(input.keywords) || input.keywords.some((item) => typeof item !== "string")) {
      throw new Error("cave_agent_plugin_field_invalid:keywords");
    }
    keywords = Object.freeze([...(input.keywords as string[])]);
  }
  const extensions = input.extensions !== null && typeof input.extensions === "object" &&
      !Array.isArray(input.extensions)
    ? Object.freeze({ ...(input.extensions as Record<string, unknown>) })
    : undefined;
  if (input.extensions !== undefined && extensions === undefined) {
    diagnostics.push({
      code: "agent_environment_unsupported_plugin_field",
      path,
      message: "ignored non-object plugin.json extensions field",
    });
  }
  const manifest: AgentPluginManifest = Object.freeze({
    ...(format === "agent-plugins-v1" ? { $schema: AGENT_PLUGINS_SCHEMA } : {}),
    name: input.name,
    ...(optionalString(input.version, "version") === undefined ? {} : { version: input.version as string }),
    ...(optionalString(input.description, "description") === undefined ? {} : { description: input.description as string }),
    ...(author === undefined ? {} : { author }),
    ...(optionalString(input.homepage, "homepage") === undefined ? {} : { homepage: input.homepage as string }),
    ...(optionalString(input.repository, "repository") === undefined ? {} : { repository: input.repository as string }),
    ...(optionalString(input.license, "license") === undefined ? {} : { license: input.license as string }),
    ...(keywords === undefined ? {} : { keywords }),
    ...(extensions === undefined ? {} : { extensions }),
  });
  return { manifest, diagnostics };
}

export async function loadAgentPlugin(
  root: string,
): Promise<{ readonly plugin: AgentPlugin; readonly diagnostics: readonly AgentEnvironmentDiagnostic[] }> {
  const resolvedManifest = await resolveAgentPluginManifest(root);
  if (resolvedManifest === undefined) {
    throw new Error(`cave_agent_plugin_manifest_required:${root}`);
  }
  const canonicalRoot = resolvedManifest.root;
  const manifestPath = resolvedManifest.path;
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cave_agent_plugin_json_invalid:${manifestPath}:${errorText(error)}`);
  }
  const validated = validatePluginManifest(decoded, manifestPath, resolvedManifest.format);
  const skillsPath = join(canonicalRoot, "skills");
  const skillsKind = await optionalKind(skillsPath, "directory");
  let loaded: Awaited<ReturnType<typeof loadAgentSkillDirectory>> = {
    skills: [],
    diagnostics: [],
  };
  if (skillsKind === "valid") {
    const canonicalSkills = await realpath(skillsPath);
    if (!contained(canonicalRoot, canonicalSkills)) {
      loaded = {
        skills: [],
        diagnostics: [{
          code: "agent_environment_invalid_skill",
          path: skillsPath,
          message: `cave_agent_package_path_escape:${skillsPath}`,
        }],
      };
    } else {
      loaded = await loadAgentSkillDirectory(skillsPath, {
        plugin: validated.manifest.name,
      });
    }
  } else if (skillsKind === "invalid") {
    loaded = {
      skills: [],
      diagnostics: [{
        code: "agent_environment_invalid_skill",
        path: skillsPath,
        message: `cave_agent_skills_directory_invalid:${skillsPath}`,
      }],
    };
  }
  const commandsPath = join(canonicalRoot, "commands");
  const commandsKind = await optionalKind(commandsPath, "directory");
  let loadedCommands: Awaited<ReturnType<typeof loadAgentPluginCommandDirectory>> = {
    commands: [],
    diagnostics: [],
  };
  if (commandsKind === "valid") {
    const canonicalCommands = await realpath(commandsPath);
    if (!contained(canonicalRoot, canonicalCommands)) {
      loadedCommands = {
        commands: [],
        diagnostics: [{
          code: "agent_environment_invalid_command",
          path: commandsPath,
          message: `cave_agent_package_path_escape:${commandsPath}`,
        }],
      };
    } else {
      loadedCommands = await loadAgentPluginCommandDirectory(
        commandsPath,
        validated.manifest.name,
      );
    }
  } else if (commandsKind === "invalid") {
    loadedCommands = {
      commands: [],
      diagnostics: [{
        code: "agent_environment_invalid_command",
        path: commandsPath,
        message: `cave_agent_plugin_commands_directory_invalid:${commandsPath}`,
      }],
    };
  }
  let mcpPath: string | undefined;
  for (const candidate of [join(canonicalRoot, "mcp.json"), join(canonicalRoot, ".mcp.json")]) {
    if (await optionalKind(candidate, "file") !== "valid") continue;
    mcpPath = await regularContainedFile(canonicalRoot, candidate);
    break;
  }
  const hasMcp = mcpPath !== undefined;
  const hooksPath = join(canonicalRoot, "hooks");
  const agentsPath = join(canonicalRoot, "agents");
  const hasHooks = await optionalKind(hooksPath, "directory") === "valid";
  const hasAgents = await optionalKind(agentsPath, "directory") === "valid";
  if (hasHooks && !contained(canonicalRoot, await realpath(hooksPath))) {
    throw new Error(`cave_agent_package_path_escape:${hooksPath}`);
  }
  if (hasAgents && !contained(canonicalRoot, await realpath(agentsPath))) {
    throw new Error(`cave_agent_package_path_escape:${agentsPath}`);
  }
  const diagnostics = [
    ...validated.diagnostics,
    ...loaded.diagnostics,
    ...loadedCommands.diagnostics,
    ...(hasMcp ? [{
      code: "agent_environment_unsupported_plugin_mcp" as const,
      path: mcpPath!,
      message: "plugin MCP component recognized but not loaded by declarative-only client",
    }] : []),
    ...(hasHooks ? [{
      code: "agent_environment_unsupported_plugin_hooks" as const,
      path: hooksPath,
      message: "plugin hooks recognized but not executed by declarative-only client",
    }] : []),
    ...(hasAgents ? [{
      code: "agent_environment_unsupported_plugin_agents" as const,
      path: agentsPath,
      message: "plugin agents recognized but not loaded by declarative-only client",
    }] : []),
  ];
  return {
    plugin: Object.freeze({
      root: canonicalRoot,
      format: resolvedManifest.format,
      manifest: validated.manifest,
      skills: loaded.skills,
      commands: loadedCommands.commands,
      hasMcp,
      hasHooks,
      hasAgents,
    }),
    diagnostics: Object.freeze(diagnostics),
  };
}

export async function findAgentWorkspaceRoot(cwd: string): Promise<string> {
  let cursor = await realpath(cwd);
  for (;;) {
    if (await optionalKind(join(cursor, ".git"), "directory") !== "missing") return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return await realpath(cwd);
    cursor = parent;
  }
}

async function immediateDirectories(collection: string): Promise<string[]> {
  const kind = await optionalKind(collection, "directory");
  if (kind === "missing") return [];
  if (kind === "invalid") throw new Error(`cave_agent_plugin_collection_invalid:${collection}`);
  return (await readdir(collection, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => join(collection, entry.name));
}

export async function loadAgentEnvironment(
  options: LoadAgentEnvironmentOptions = {},
): Promise<AgentEnvironment> {
  const cwd = await realpath(resolve(options.cwd ?? process.cwd()));
  const root = await findAgentWorkspaceRoot(cwd);
  const home = resolve(options.homeDir ?? homedir());
  const includeDefaults = options.includeDefaultRoots ?? true;
  const skillRoots = [
    ...(options.skillRoots ?? []),
    ...(includeDefaults ? [join(root, ".agents", "skills"), join(home, ".agents", "skills")] : []),
  ].map((item) => resolve(item));
  const explicitPluginRoots = [...(options.pluginRoots ?? [])].map((item) => resolve(item));
  const collections = [
    ...(options.pluginCollections ?? []),
    ...(includeDefaults ? [join(root, ".agents", "plugins"), join(home, ".agents", "plugins")] : []),
  ].map((item) => resolve(item));
  const diagnostics: AgentEnvironmentDiagnostic[] = [];
  const skills = new Map<string, AgentSkill>();
  for (const skillRoot of skillRoots) {
    try {
      const loaded = await loadAgentSkillDirectory(skillRoot);
      diagnostics.push(...loaded.diagnostics);
      for (const skill of loaded.skills) {
        if (skills.has(skill.id)) {
          diagnostics.push({
            code: "agent_environment_duplicate_skill",
            path: skill.file,
            message: `ignored lower-precedence duplicate skill ${JSON.stringify(skill.id)}`,
          });
        } else {
          skills.set(skill.id, skill);
        }
      }
    } catch (error) {
      diagnostics.push({
        code: "agent_environment_invalid_skill",
        path: skillRoot,
        message: errorText(error),
      });
    }
  }
  const pluginRoots: string[] = [...explicitPluginRoots];
  if ((options.includeWorkspacePlugin ?? true) &&
      await resolveAgentPluginManifest(cwd) !== undefined) pluginRoots.push(cwd);
  for (const collection of collections) {
    try {
      pluginRoots.push(...await immediateDirectories(collection));
    } catch (error) {
      diagnostics.push({
        code: "agent_environment_invalid_plugin",
        path: collection,
        message: errorText(error),
      });
    }
  }
  const plugins = new Map<string, AgentPlugin>();
  const commands = new Map<string, AgentPluginCommand>();
  for (const pluginRoot of pluginRoots) {
    try {
      if (await resolveAgentPluginManifest(pluginRoot) === undefined) continue;
      const loaded = await loadAgentPlugin(pluginRoot);
      diagnostics.push(...loaded.diagnostics);
      if (plugins.has(loaded.plugin.manifest.name)) {
        diagnostics.push({
          code: "agent_environment_duplicate_plugin",
          path: loaded.plugin.root,
          message: `ignored lower-precedence duplicate plugin ${JSON.stringify(loaded.plugin.manifest.name)}`,
        });
        continue;
      }
      plugins.set(loaded.plugin.manifest.name, loaded.plugin);
      for (const skill of loaded.plugin.skills) {
        if (skills.has(skill.id)) {
          diagnostics.push({
            code: "agent_environment_duplicate_skill",
            path: skill.file,
            message: `ignored lower-precedence duplicate skill ${JSON.stringify(skill.id)}`,
          });
        } else {
          skills.set(skill.id, skill);
        }
      }
      for (const command of loaded.plugin.commands) {
        if (commands.has(command.id)) {
          diagnostics.push({
            code: "agent_environment_duplicate_command",
            path: command.file,
            message: `ignored lower-precedence duplicate command ${JSON.stringify(command.id)}`,
          });
        } else {
          commands.set(command.id, command);
        }
      }
    } catch (error) {
      diagnostics.push({
        code: "agent_environment_invalid_plugin",
        path: pluginRoot,
        message: errorText(error),
      });
    }
  }
  return Object.freeze({
    cwd,
    workspaceRoot: root,
    skills: Object.freeze([...skills.values()].sort((left, right) => left.id.localeCompare(right.id))),
    commands: Object.freeze([...commands.values()].sort((left, right) => left.id.localeCompare(right.id))),
    plugins: Object.freeze([...plugins.values()].sort((left, right) =>
      left.manifest.name.localeCompare(right.manifest.name))),
    diagnostics: Object.freeze(diagnostics),
  });
}

export function renderAgentSkillsIndex(skills: readonly AgentSkill[]): string {
  return [
    "Skills available to this agent. Load one only when its description matches the task.",
    'Call load_skill({"name":"<skill>"}) for instructions. Use its resource argument for referenced files.',
    ...skills.map((skill) => `- ${skill.id}: ${skill.description}`),
  ].join("\n");
}

export function renderAgentPluginCommandsIndex(
  commands: readonly AgentPluginCommand[],
): string {
  return [
    "Plugin slash commands available to this agent. Commands activate only when explicitly invoked.",
    ...commands.map((command) => `- /${command.id}: ${command.description}`),
  ].join("\n");
}

export async function readAgentSkillResource(
  skill: AgentSkill,
  resource = "SKILL.md",
): Promise<string> {
  if (resource === "" || isAbsolute(resource) || resource.split(/[\\/]/).includes("..")) {
    throw new Error(`cave_agent_skill_resource_path_invalid:${skill.id}`);
  }
  const target = await regularContainedFile(skill.root, resolve(skill.root, resource));
  const info = await stat(target);
  if (info.size > MAX_RESOURCE_BYTES) {
    throw new Error(`cave_agent_skill_resource_size_invalid:${skill.id}:${resource}`);
  }
  return readFile(target, "utf8");
}

function environmentContexts(environment: AgentEnvironment): ContextDefinition[] {
  const contexts: ContextDefinition[] = [];
  if (environment.skills.length > 0) {
    contexts.push(context({
      id: AGENT_SKILLS_CONTEXT_ID,
      kind: "skill",
      source: renderAgentSkillsIndex(environment.skills),
      stability: "build",
    }));
  }
  if (environment.commands.length > 0) {
    contexts.push(context({
      id: AGENT_PLUGIN_COMMANDS_CONTEXT_ID,
      kind: "skill",
      source: renderAgentPluginCommandsIndex(environment.commands),
      stability: "build",
    }));
  }
  return contexts;
}

export function applyAgentEnvironment<D extends AgentDefinition>(
  definition: D,
  environment: AgentEnvironment,
  options: ApplyAgentEnvironmentOptions = {},
): D {
  const additions = environmentContexts(environment);
  for (const addition of additions) {
    if (definition.contexts.some((entry) => entry.id === addition.id)) {
      throw new Error(`cave_agent_environment_context_collision:${addition.id}`);
    }
  }
  const skillByID = new Map(environment.skills.map((skill) => [skill.id, skill]));
  const skillToolName = options.skillToolName ?? "load_skill";
  if (skillByID.size > 0 && definition.tools.some((entry) => entry.name === skillToolName)) {
    throw new Error(`cave_agent_environment_tool_collision:${skillToolName}`);
  }
  const skillTool = skillByID.size === 0 ? undefined : tool({
    name: skillToolName,
    description: "Load instructions or a contained resource from an available Agent Skill.",
    input: schema.object({
      name: schema.string(),
      resource: schema.optional(schema.string()),
    }),
    effect: "read",
    result: "inline",
    async execute(input) {
      const skill = skillByID.get(input.name);
      if (skill === undefined) {
        return `Unknown skill ${JSON.stringify(input.name)}. Available skills: ${[...skillByID.keys()].join(", ")}`;
      }
      return readAgentSkillResource(skill, input.resource ?? "SKILL.md");
    },
  });
  return agent({
    id: definition.id,
    instructions: definition.instructions,
    model: definition.model,
    reasoning: definition.reasoning,
    tools: [...definition.tools, ...(skillTool === undefined ? [] : [skillTool])],
    contexts: [...definition.contexts, ...additions],
    ...(definition.memory === undefined ? {} : { memory: definition.memory }),
    ...(definition.output === undefined ? {} : { output: definition.output }),
    // Passing `sandbox` unconditionally would turn an undeclared posture into a
    // declared one and cost the definition its host-by-default downgrade.
    ...(definition.sandboxDeclared ? { sandbox: definition.sandbox } : {}),
  }) as D;
}

/** Optional compatibility adapter for products that choose workspace discovery. */
export function createAgentEnvironmentTransform(
  environment: AgentEnvironment,
  options: ApplyAgentEnvironmentOptions = {},
): AgentDefinitionTransform {
  return Object.freeze({
    id: "agent-environment",
    apply(definition: AgentDefinition) {
      return applyAgentEnvironment(definition, environment, options);
    },
  });
}

export function renderAgentSkillInvocation(
  environment: AgentEnvironment,
  id: string,
  request = "",
): string {
  const skill = environment.skills.find((entry) => entry.id === id);
  if (skill === undefined) throw new Error(`cave_agent_skill_unknown:${id}`);
  return [
    `Apply explicitly invoked Agent Skill ${JSON.stringify(id)}. Follow it for this turn.`,
    `<agent-skill id=${JSON.stringify(id)}>`,
    skill.body,
    "</agent-skill>",
    ...(request.trim() === "" ? [] : ["User request:", request.trim()]),
  ].join("\n\n");
}

function expandPluginCommandArguments(body: string, request: string): string {
  const argumentsText = request.trim();
  const positional = argumentsText === "" ? [] : argumentsText.split(/\s+/);
  return body
    .replaceAll("$ARGUMENTS", argumentsText)
    .replace(/\$([1-9])/g, (_match, index: string) => positional[Number(index) - 1] ?? "");
}

export function renderAgentPluginCommandInvocation(
  environment: AgentEnvironment,
  id: string,
  request = "",
): string {
  const command = environment.commands.find((entry) => entry.id === id);
  if (command === undefined) throw new Error(`cave_agent_plugin_command_unknown:${id}`);
  return [
    `Execute explicitly invoked Agent Plugin command ${JSON.stringify(id)}. Follow it for this turn.`,
    `<agent-plugin-command id=${JSON.stringify(id)}>`,
    expandPluginCommandArguments(command.body, request),
    "</agent-plugin-command>",
    ...(request.trim() === "" ? [] : ["User arguments:", request.trim()]),
  ].join("\n\n");
}

/** Portable prompt expansion; product UIs may add discovery and completion. */
export function expandAgentEnvironmentSlashCommand(
  prompt: string,
  environment: AgentEnvironment,
): string {
  const trimmed = prompt.trim();
  const explicitSkill = /^\/skill(?:\s+([^\s]+))?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (explicitSkill !== null) {
    const id = explicitSkill[1];
    if (id === undefined) throw new Error("cave_agent_skill_name_required");
    const request = explicitSkill[2] ?? "";
    if (environment.skills.some((skill) => skill.id === id)) {
      return renderAgentSkillInvocation(environment, id, request);
    }
    if (environment.commands.some((command) => command.id === id)) {
      return renderAgentPluginCommandInvocation(environment, id, request);
    }
    throw new Error(`cave_agent_skill_unknown:${id}`);
  }
  const direct = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (direct === null) return prompt;
  const id = direct[1]!;
  const request = direct[2] ?? "";
  if (environment.commands.some((command) => command.id === id)) {
    return renderAgentPluginCommandInvocation(environment, id, request);
  }
  if (environment.skills.some((skill) => skill.id === id)) {
    return renderAgentSkillInvocation(environment, id, request);
  }
  return prompt;
}
