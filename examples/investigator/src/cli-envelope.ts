import type { ExecResult } from "@caveman-ai/agent";

/** stdout then stderr, the way the shell tools render a process. */
export function combinedProcessOutput(result: ExecResult): string {
  const separator = result.stdout !== "" && !result.stdout.endsWith("\n") && result.stderr !== "" ? "\n" : "";
  return `${result.stdout}${separator}${result.stderr}`;
}

/**
 * Find the CLI envelope inside a `bash` tool result. The shell tool returns
 * `exit <code>\n<output>`; the envelope is the JSON document on the first
 * line of that output. Anything else is shell text, not an operation result.
 */
export function envelopeFromBashResult(text: string): Record<string, unknown> | undefined {
  const body = text.replace(/^exit [^\n]*\n/u, "");
  const line = body.split("\n").find((candidate) => candidate.startsWith("{"));
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
      typeof (parsed as { operation?: unknown }).operation === "string"
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
