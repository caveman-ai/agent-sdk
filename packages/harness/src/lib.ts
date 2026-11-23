/**
 * `@caveman-ai/harness` as a library (dist/lib.mjs): what a host needs to run the harness inside its own app. The CLI
 * (src/cli.ts) is the benchmark's entry; this is the product's. One bundle, its Pi packages inside: a host on another
 * pi-ai passes its own `streamSimple`, which only has to speak pi-ai's event stream.
 */
export { HarnessSession, isCompactionSummary, portableMessages } from "./session.ts";
export type { CallInfo, HarnessSessionOptions, NestedCall, SessionEvent, SessionHooks, TurnOptions, TurnOutcome, TurnUsage } from "./session.ts";
export { APP_CLAUDE_LOADOUT, APP_GENERAL_LOADOUT, APP_GPT_LOADOUT, appLoadoutFor, appLoadouts, usesExecSurface } from "./app-loadouts.ts";
export { normalizeLoadout, loadoutHash, type Loadout } from "./loadout.ts";
export { LocalEnv, type LocalEnvOptions } from "./env/local.ts";
/** A running container through `docker exec` (benchmarks: the connector suite's no-network task containers). */
export { DockerEnv, type DockerEnvOptions } from "./env/docker.ts";
/** A Caveman sandbox through the public sandbox API (`@caveman-ai/sdk/sandboxes`): Cloud's tier linux. */
export { SandboxEnv, type SandboxEnvOptions, type SandboxEvent } from "./env/sandbox.ts";
export type { DirEntry, ExecEnv, ExecOptions, ExecResult, FileStat, ReadRange } from "./env/types.ts";
export { connectMcp, mcpContent, mcpDirectTools, type ConnectMcpOptions, type McpServerConfig, type McpSession, type McpToolHandle } from "./mcp.ts";
export { EFFORTS, type Effort } from "./models.ts";
