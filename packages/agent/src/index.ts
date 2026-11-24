export { Caveman, type Attempt, type CavemanOptions, type Check, type RunOptions, type RunResult, type SessionOptions } from "./caveman.ts";
export type { AutomationRunOptions, AutomationRunResult, AutomationStatus } from "./automations.ts";
export { agentFileText, type AgentDefinition, type Computer } from "./agent.ts";
export { tool, type JsonSchemaObject, type Tool, type ToolGatePolicy, type ToolOptions } from "./tool.ts";
export { Session, type AskHandlers, type Decision, type SessionResult, type TurnResult } from "./session.ts";
export type { ModelEndpoint } from "./local.ts";
export { compileAgentDefinition, compileAgentFolder, type AgentBuildFile, type AgentBuildManifest, type AgentBuildResult } from "./build.ts";
export { runInProcess, type InProcessRunOptions, type InProcessRunResult } from "./inprocess.ts";
export {
  appLoadoutFor,
  appLoadouts,
  createCloudGateProvider,
  createGateHook,
  createMemoryGateProvider,
  resolveHarnessModel,
  type CloudGateProviderOptions,
  type GateConfig,
  type GateDecision,
  type GateProvider,
  type GateRequest,
  type GateRule,
  type GateTerminalStatus,
  type ResolveHarnessModelOptions,
} from "@caveman-ai/harness";
export { toHarnessTool, type ToHarnessToolOptions } from "./harness.ts";
export {
  CavemanError,
  ZERO_USAGE,
  type ApprovalAsk,
  type Ask,
  type GateRisk,
  type GateStatus,
  type QuestionAsk,
  type SensorSourceKind,
  type SensorSpec,
  type SessionEvent,
  type SessionStatus,
  type StopReason,
  type ToolAsk,
  type Usage,
  type UserEvent,
} from "./types.ts";

/** Ergonomic helper to define an agent with strong TypeScript inference. */
export const defineAgent = <T extends import("./agent.ts").AgentDefinition>(def: T): T => def;

/** Ergonomic helper to declare a Caveman Sensor for durable zero-compute waking. */
export const defineSensor = <T extends import("./types.ts").SensorSpec>(spec: T): T => spec;
