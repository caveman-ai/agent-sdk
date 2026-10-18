/** The code tool's transport on a coding run's options: it wraps the stream function, else the models. */
import type { RunOptions } from "./runtime.js";
import type { CodingAgent } from "./code.js";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export function withProgrammaticTransport(
  codingAgent: CodingAgent,
  options: RunOptions,
): RunOptions {
  const runtime = codingAgent.programmaticTools;
  if (runtime === undefined) return options;
  if (options.streamFn !== undefined) {
    return { ...options, streamFn: runtime.wrapStreamFn(options.streamFn) };
  }
  return {
    ...options,
    models: runtime.wrapModels(options.models ?? builtinModels()),
  };
}
