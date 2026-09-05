import { readFileSync } from "node:fs";
import { agent, auto, schema, tool, type ExecutionBackend } from "@caveman-ai/agent";

export const SUBMIT_MARKER = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";
const OUTPUT_LIMIT = 10_000;
const COMMAND_TIMEOUT_MS = 60_000;

export interface MiniSweOptions {
  /** Where `bash` runs: the host, a container, or a remote executor. */
  backend: ExecutionBackend;
  /** Working directory for every command. */
  cwd: string;
  /** Explicit subprocess environment. Nothing is inherited. */
  env: Record<string, string>;
}

/**
 * mini-swe-agent's design on the Caveman kernel: one `bash` tool, a fresh
 * subshell per command, linear history. The kernel adds the receipt, the USD
 * budget, breakers, the deadline, and durable resume for free.
 */
export function miniSwe(options: MiniSweOptions) {
  let submission: string | undefined;
  const bash = tool({
    name: "bash",
    description: "Run a bash command in a fresh non-interactive subshell. cd and env changes do not persist between calls.",
    effect: "write",
    allowRepeat: true,
    input: schema.object({ command: schema.string() }),
    execute: async ({ command }: { command: string }, signal?: AbortSignal) => {
      if (submission !== undefined) return "Already submitted. Stop calling bash and reply with one sentence.";
      const result = await options.backend.exec({
        command: "bash",
        args: ["-c", command],
        cwd: options.cwd,
        env: options.env,
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxOutputBytes: 1 << 20,
        ...(signal === undefined ? {} : { signal }),
      });
      const output = result.stdout + result.stderr;
      const lines = output.trimStart().split("\n");
      if (result.code === 0 && !result.truncated && lines[0]?.trim() === SUBMIT_MARKER) {
        submission = lines.slice(1).join("\n");
        // The patch rides in the journaled tool result so a resumed run can recover it.
        return `Submission received. Stop calling bash and reply with one sentence.\n<submission>\n${submission}\n</submission>`;
      }
      return observation(result.timedOut ? `timeout after ${COMMAND_TIMEOUT_MS}ms` : String(result.code), output);
    },
  });
  const definition = agent({
    id: "mini-swe",
    instructions: readFileSync(new URL("../instructions.md", import.meta.url), "utf8").replaceAll("{{cwd}}", options.cwd),
    model: auto(),
    sandbox: "host",
    tools: [bash],
  });
  return { definition, submission: () => submission };
}

/**
 * The submission a durable journal holds. A resumed run replays settled tool
 * results instead of re-executing `bash`, so the closure above stays empty.
 */
export function submissionFromJournal(lines: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const line of lines) {
    const event = JSON.parse(line) as { type?: string; name?: string; value?: { json?: string } };
    if (event.type !== "tool_settled" || event.name !== "bash" || event.value?.json === undefined) continue;
    // The kernel journals the tool result as {content:[{text}]}.
    const value = JSON.parse(event.value.json) as { content?: { text?: string }[] };
    const text = (value.content ?? []).map((part) => part.text ?? "").join("");
    const match = /<submission>\n([\s\S]*)\n<\/submission>$/.exec(text);
    if (match) found = match[1];
  }
  return found;
}

/** mini-swe-agent's observation shape, including the head/tail elision of long output. */
export function observation(returncode: string, output: string): string {
  if (output.length <= OUTPUT_LIMIT) return `<returncode>${returncode}</returncode>\n<output>\n${output}</output>`;
  const half = OUTPUT_LIMIT / 2;
  return `<returncode>${returncode}</returncode>\n<warning>\nThe output of your last command was too long. Use head, tail, sed, or a narrower grep/find; redirect to a file and search that if you need all of it.\n</warning>\n<output_head>\n${output.slice(0, half)}\n</output_head>\n<elided_chars>\n${output.length - OUTPUT_LIMIT} characters elided\n</elided_chars>\n<output_tail>\n${output.slice(-half)}\n</output_tail>`;
}
