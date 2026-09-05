# `@caveman-ai/agent/plugins`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/agent-environment.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AgentEnvironment`, `AgentEnvironmentDiagnostic`, `AgentPlugin`, `AgentPluginCommand`, `AgentPluginManifest`, `AgentSkill`, `ApplyAgentEnvironmentOptions`, `LoadAgentEnvironmentOptions`
- **Type alias**: `AgentEnvironmentDiagnosticCode`, `AgentPluginFormat`
- **Function**: `applyAgentEnvironment`, `createAgentEnvironmentTransform`, `expandAgentEnvironmentSlashCommand`, `findAgentWorkspaceRoot`, `loadAgentEnvironment`, `loadAgentPlugin`, `loadAgentSkillDirectory`, `parseAgentSkill`, `readAgentSkillResource`, `renderAgentPluginCommandInvocation`, `renderAgentPluginCommandsIndex`, `renderAgentSkillInvocation`, `renderAgentSkillsIndex`
- **Variable**: `AGENT_PLUGIN_COMMANDS_CONTEXT_ID`, `AGENT_PLUGINS_SCHEMA`, `AGENT_SKILLS_CONTEXT_ID`

</details>

## Interfaces

### `AgentEnvironment`

```ts
export interface AgentEnvironment {
    readonly cwd: string;
    readonly workspaceRoot: string;
    readonly skills: readonly AgentSkill[];
    readonly commands: readonly AgentPluginCommand[];
    readonly plugins: readonly AgentPlugin[];
    readonly diagnostics: readonly AgentEnvironmentDiagnostic[];
}
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AgentEnvironmentDiagnostic`

```ts
export interface AgentEnvironmentDiagnostic {
    readonly code: AgentEnvironmentDiagnosticCode;
    readonly path: string;
    readonly message: string;
}
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AgentPlugin`

```ts
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
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AgentPluginCommand`

```ts
export interface AgentPluginCommand {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly root: string;
    readonly file: string;
    readonly body: string;
    readonly plugin: string;
}
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AgentPluginManifest`

```ts
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
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AgentSkill`

```ts
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
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `ApplyAgentEnvironmentOptions`

```ts
export interface ApplyAgentEnvironmentOptions {
    /** Ordinary tool name, so programmatic coding mode can collapse it. */
    readonly skillToolName?: string;
}
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `LoadAgentEnvironmentOptions`

```ts
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
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

## Type aliases

### `AgentEnvironmentDiagnosticCode`

```ts
export type AgentEnvironmentDiagnosticCode = "agent_environment_duplicate_command" | "agent_environment_duplicate_plugin" | "agent_environment_duplicate_skill" | "agent_environment_invalid_command" | "agent_environment_invalid_plugin" | "agent_environment_invalid_skill" | "agent_environment_unsupported_plugin_agents" | "agent_environment_unsupported_plugin_field" | "agent_environment_unsupported_plugin_hooks" | "agent_environment_unsupported_plugin_mcp";
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AgentPluginFormat`

```ts
export type AgentPluginFormat = "agent-plugins-v1" | "open-plugin" | "claude-code" | "cursor";
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

## Functions

### `applyAgentEnvironment`

```ts
export declare function applyAgentEnvironment<D extends AgentDefinition>(definition: D, environment: AgentEnvironment, options?: ApplyAgentEnvironmentOptions): D;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `createAgentEnvironmentTransform`

Optional compatibility adapter for products that choose workspace discovery.

```ts
export declare function createAgentEnvironmentTransform(environment: AgentEnvironment, options?: ApplyAgentEnvironmentOptions): AgentDefinitionTransform;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `expandAgentEnvironmentSlashCommand`

Portable prompt expansion; product UIs may add discovery and completion.

```ts
export declare function expandAgentEnvironmentSlashCommand(prompt: string, environment: AgentEnvironment): string;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `findAgentWorkspaceRoot`

```ts
export declare function findAgentWorkspaceRoot(cwd: string): Promise<string>;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `loadAgentEnvironment`

```ts
export declare function loadAgentEnvironment(options?: LoadAgentEnvironmentOptions): Promise<AgentEnvironment>;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `loadAgentPlugin`

```ts
export declare function loadAgentPlugin(root: string): Promise<{
    readonly plugin: AgentPlugin;
    readonly diagnostics: readonly AgentEnvironmentDiagnostic[];
}>;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `loadAgentSkillDirectory`

```ts
export declare function loadAgentSkillDirectory(root: string, options?: {
    readonly plugin?: string;
}): Promise<{
    readonly skills: readonly AgentSkill[];
    readonly diagnostics: readonly AgentEnvironmentDiagnostic[];
}>;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `parseAgentSkill`

```ts
export declare function parseAgentSkill(raw: string, options: {
    readonly file: string;
    readonly root: string;
    readonly id?: string;
    readonly plugin?: string;
}): AgentSkill;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `readAgentSkillResource`

```ts
export declare function readAgentSkillResource(skill: AgentSkill, resource?: string): Promise<string>;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `renderAgentPluginCommandInvocation`

```ts
export declare function renderAgentPluginCommandInvocation(environment: AgentEnvironment, id: string, request?: string): string;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `renderAgentPluginCommandsIndex`

```ts
export declare function renderAgentPluginCommandsIndex(commands: readonly AgentPluginCommand[]): string;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `renderAgentSkillInvocation`

```ts
export declare function renderAgentSkillInvocation(environment: AgentEnvironment, id: string, request?: string): string;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `renderAgentSkillsIndex`

```ts
export declare function renderAgentSkillsIndex(skills: readonly AgentSkill[]): string;
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

## Variables & constants

### `AGENT_PLUGIN_COMMANDS_CONTEXT_ID`

```ts
export declare const AGENT_PLUGIN_COMMANDS_CONTEXT_ID = "agent.plugin-commands";
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AGENT_PLUGINS_SCHEMA`

```ts
export declare const AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

### `AGENT_SKILLS_CONTEXT_ID`

```ts
export declare const AGENT_SKILLS_CONTEXT_ID = "agent.skills";
```

Declared in `packages/agent/dist/agent-environment.d.ts`.

