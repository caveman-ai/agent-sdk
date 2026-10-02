export const FRAMEWORK_VERSION = "0.2.0";
export const PI_ADAPTER_VERSION = FRAMEWORK_VERSION;
export const PI_UPSTREAM_VERSION = "1.0.0";
/**
 * Exact contract for profile-guided builds executed by Caveman's owned Pi
 * runner. A digest of this value distinguishes real runtime evidence from a
 * caller-supplied generic Pi adapter.
 */
export const PI_NATIVE_COMPILER_CONTRACT = Object.freeze({
  schema_version: 1 as const,
  semantic_version: "tool-free-v1" as const,
  target: "pi-native" as const,
  adapter_version: PI_ADAPTER_VERSION,
  upstream_version: PI_UPSTREAM_VERSION,
  request: "CaveBuildLock.v3+ContextIR.v1+CavePlan.v1" as const,
  execution: "runAgentInternal.lockedBuild" as const,
});
export const CLAUDE_ADAPTER_VERSION = FRAMEWORK_VERSION;
export const CLAUDE_AGENT_SDK_VERSION = "0.3.220";
export const CLAUDE_CODE_VERSION = "2.1.220";
export const CLAUDE_UPSTREAM_VERSION =
  `agent-sdk-${CLAUDE_AGENT_SDK_VERSION}+claude-code-${CLAUDE_CODE_VERSION}`;
