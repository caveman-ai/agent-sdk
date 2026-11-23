export { Caveman, type Attempt, type CavemanOptions, type Check, type RunOptions, type RunResult, type SessionOptions } from "./caveman.ts";
export type { AutomationRunOptions, AutomationRunResult, AutomationStatus } from "./automations.ts";
export { agentFileText, type AgentDefinition, type Computer } from "./agent.ts";
export { tool, type JsonSchemaObject, type Tool } from "./tool.ts";
export { Session, type AskHandlers, type Decision, type SessionResult, type TurnResult } from "./session.ts";
export type { ModelEndpoint } from "./local.ts";
export { compileAgentDefinition, compileAgentFolder, type AgentBuildFile, type AgentBuildManifest, type AgentBuildResult } from "./build.ts";
export { runInProcess, type InProcessRunOptions, type InProcessRunResult } from "./inprocess.ts";
export {
  CavemanError,
  ZERO_USAGE,
  type ApprovalAsk,
  type Ask,
  type QuestionAsk,
  type SessionEvent,
  type SessionStatus,
  type StopReason,
  type ToolAsk,
  type Usage,
  type UserEvent,
} from "./types.ts";

/** Ergonomic helper to define an agent with strong TypeScript inference. */
export const defineAgent = <T extends import("./agent.ts").AgentDefinition>(def: T): T => def;
