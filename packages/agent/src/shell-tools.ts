/**
 * `@caveman-ai/agent/shell-tools` — the workspace shell/file tools, composable
 * by any agent.
 *
 * These are the tools the Caveman coding agent runs: bounded `bash`,
 * `read_file`, `grep`, `write_file`, `edit_file`, and `read_tool_output` paging
 * over captured output. They run wherever the execution backend points, and the
 * local backend is host execution, not isolation: containment is a realpath
 * check against the workspace root, nothing more.
 */
import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import {
  schema,
  tool,
  type ToolDefinition,
} from "./primitives.js";
import type {
  CommandSessionReadResult,
  CommandSessionRuntime,
  CommandSessionSummary,
} from "./command-session.js";
import {
  localExecutionBackend,
  type ExecutionBackend,
} from "./execution-backend.js";
import {
  backendContainedPath,
  backendIsFile,
  backendWorkspaceRoot,
  backendWriteFile,
  buildCodingProcessEnv,
  combinedProcessOutput,
  localBackendInternals,
  runBackendProcess,
} from "./coding-backend.js";
import { hostShellInvocation } from "./portable-process.js";

/**
 * Raw output caps, applied by each tool **before** any transform runs, so a
 * runaway `cat` cannot blow the context even with the engine absent. They also
 * sit under the runtime's 32 KiB inline tool-result ceiling, which is what keeps
 * observe-only sessions working on a machine with no engine at all.
 */
export const CODING_TOOL_OUTPUT_CAPS = Object.freeze({
  read_file: 24_000,
  grep: 16_000,
  bash: 24_000,
  write_file: 2_000,
  edit_file: 2_000,
  read_tool_output: 24_000,
});

const GREP_MAX_MATCHES = 200;
export const BASH_TIMEOUT_MS = 120_000;
export const BASH_SESSION_MAX_SESSIONS = 8;
export const BASH_SESSION_MAX_WAIT_MS = 30_000;
export const BASH_SESSION_MAX_INPUT_BYTES = 64 * 1024;
export const BASH_SESSION_READ_CHUNK_BYTES = 64 * 1024;
const BASH_SESSION_QUERY_MAX_BYTES = 4 * 1024;
const READ_TIMEOUT_MS = 30_000;
export const PROCESS_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
const STORED_TOOL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const STORED_TOOL_OUTPUT_TOTAL_BYTES = 16 * 1024 * 1024;

type StoredToolOutput = {
  readonly label: string;
  readonly bytes: Buffer;
  readonly complete: boolean;
};

/**
 * Active-agent, in-memory result store. Handles never cross agent instances or
 * process restarts. Oldest entries are evicted before the store crosses its
 * fixed memory ceiling.
 */
class ToolOutputStore {
  private readonly entries = new Map<string, StoredToolOutput>();
  private bytes = 0;

  put(label: string, text: string, complete: boolean): string | undefined {
    const encoded = Buffer.from(text, "utf8");
    if (encoded.byteLength > STORED_TOOL_OUTPUT_MAX_BYTES) return undefined;
    while (this.bytes + encoded.byteLength > STORED_TOOL_OUTPUT_TOTAL_BYTES) {
      const oldest = this.entries.entries().next().value as
        | [string, StoredToolOutput]
        | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest[0]);
      this.bytes -= oldest[1].bytes.byteLength;
    }
    const handle = `tool_${randomUUID().replaceAll("-", "")}`;
    this.entries.set(handle, { label, bytes: encoded, complete });
    this.bytes += encoded.byteLength;
    return handle;
  }

  get(handle: string): StoredToolOutput | undefined {
    return this.entries.get(handle);
  }
}

export type ShellToolName =
  | "bash"
  | "read_file"
  | "grep"
  | "write_file"
  | "edit_file"
  | "read_tool_output";

/** Every tool, in the order `shellTools` builds them by default. */
const ALL_SHELL_TOOLS: readonly ShellToolName[] = Object.freeze([
  "read_file",
  "grep",
  "bash",
  "write_file",
  "edit_file",
  "read_tool_output",
] as const);

export interface ShellToolsOptions {
  /** Workspace root; tools refuse paths outside it (realpath-based on the local backend). */
  workspace: string;
  /** Where processes run and files live. Default `localExecutionBackend()` — host execution, not isolation. */
  executionBackend?: ExecutionBackend;
  /** Which tools to build, in this order. Default: all six. */
  tools?: readonly ShellToolName[];
  /** Per-tool raw output caps in bytes, applied before any transform. */
  outputCaps?: Partial<Record<ShellToolName, number>>;
  /** Interactive bash sessions (local backend only). Omit for one-shot bounded bash. */
  commandSessions?: CommandSessionRuntime;
  /** Observes every capped tool output. */
  onOutput?: (label: string, text: string) => void;
}

// ---------------------------------------------------------------------------
// Tools — host-sandbox closures. Effects are declared honestly: host mode
// changes enforcement, not declaration.
// ---------------------------------------------------------------------------

/**
 * Build the workspace shell/file tools for any agent definition.
 *
 * `read_tool_output` is what makes a capped result recoverable: select it and
 * over-long output is stored behind an opaque handle, leave it out and a capped
 * result says so and stops there.
 */
export function shellTools(options: ShellToolsOptions): ToolDefinition[] {
  const workspace = options.workspace;
  const executionBackend = options.executionBackend ?? localExecutionBackend();
  const names = options.tools ?? ALL_SHELL_TOOLS;
  const selected = new Set<ShellToolName>();
  for (const name of names) {
    if (!ALL_SHELL_TOOLS.includes(name)) throw new Error(`cave_shell_tool_unknown:${name}`);
    if (selected.has(name)) throw new Error(`cave_shell_tool_duplicate:${name}`);
    selected.add(name);
  }
  const commandSessions = options.commandSessions;
  if (commandSessions !== undefined && localBackendInternals(executionBackend) === undefined) {
    throw new Error("cave_execution_backend_command_sessions_local_only");
  }
  const caps = { ...CODING_TOOL_OUTPUT_CAPS, ...options.outputCaps };
  const record = options.onOutput ?? (() => {});
  /** A capped result is recoverable only when the tool that pages it exists. */
  const recoverable = selected.has("read_tool_output");
  const storedOutputs = new ToolOutputStore();
  // The workspace is canonicalized once, then every candidate path is
  // canonicalized against it, so containment compares real locations rather
  // than strings. Resolved lazily because the directory need not exist yet when
  // the agent is built.
  let canonicalWorkspace: Promise<string> | undefined;
  const workspaceRoot = () => (canonicalWorkspace ??= backendWorkspaceRoot(
    executionBackend,
    workspace,
  ));
  const contained = async (candidate: string) =>
    backendContainedPath(executionBackend, await workspaceRoot(), candidate);

  const readFileTool = tool({
    name: "read_file",
    description:
      "Read a UTF-8 file from the workspace. Optional offset/limit read a line range. " +
      `Output is capped at ${caps.read_file} bytes.`,
    input: schema.object({
      path: schema.string(),
      offset: schema.optional(schema.integer()),
      limit: schema.optional(schema.integer()),
    }),
    effect: "read",
    // Safe to overlap with generation only when each concurrent coding agent
    // owns an isolated worktree. A shared mutable workspace can make any
    // filesystem read stale between launch and claim.
    speculative: true,
    result: "inline",
    timeoutMs: READ_TIMEOUT_MS,
    async execute(input) {
      const target = await contained(input.path);
      if (!await backendIsFile(executionBackend, target)) {
        throw new Error(`caveman-code: not a file: ${input.path}`);
      }
      const data = await executionBackend.readFile(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EISDIR") throw new Error(`caveman-code: not a file: ${input.path}`);
        throw error;
      });
      const content = Buffer.from(data).toString("utf8");
      const lines = content.split("\n");
      const offset = Math.max(1, input.offset ?? 1);
      const limit = input.limit === undefined ? lines.length : Math.max(1, input.limit);
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = selected
        .map((line, index) => `${offset + index}\t${line}`)
        .join("\n");
      const text = capToolOutput({
        text: numbered,
        maxBytes: caps.read_file,
        direction: "head",
        ...(recoverable ? { store: storedOutputs } : {}),
        label: `read_file:${input.path}`,
        complete: true,
      });
      record(`read_file:${input.path}`, text);
      return text;
    },
  });

  const grepTool = tool({
    name: "grep",
    description:
      "Search the workspace for a regular expression with ripgrep (grep fallback). " +
      `Returns at most ${GREP_MAX_MATCHES} matches, capped at ${caps.grep} bytes.`,
    input: schema.object({
      pattern: schema.string(),
      path: schema.optional(schema.string()),
      glob: schema.optional(schema.string()),
    }),
    effect: "read",
    speculative: true,
    result: "inline",
    timeoutMs: READ_TIMEOUT_MS,
    async execute(input, signal) {
      const root = await workspaceRoot();
      const scope = input.path === undefined ? root : await contained(input.path);
      const relativeScope = scope === root ? "." : relative(root, scope);
      const ripgrep = [
        "--line-number", "--no-heading", "--color", "never",
        "--max-count", String(GREP_MAX_MATCHES),
        ...(input.glob === undefined ? [] : ["--glob", input.glob]),
        "--regexp", input.pattern, "--", relativeScope,
      ];
      let run = await runBackendProcess(
        executionBackend, "rg", ripgrep, root, READ_TIMEOUT_MS, signal,
      );
      if (run.spawnFailed) {
        run = await runBackendProcess(executionBackend, "grep", [
          "-rnI", "-m", String(GREP_MAX_MATCHES), "-E", "-e", input.pattern, "--", relativeScope,
        ], root, READ_TIMEOUT_MS, signal);
      }
      if (run.spawnFailed) throw new Error("caveman-code: neither rg nor grep is available");
      const body = run.output.trim() === "" ? "no matches" : firstLines(run.output, GREP_MAX_MATCHES);
      const text = capToolOutput({
        text: body,
        maxBytes: caps.grep,
        direction: "head",
        ...(recoverable ? { store: storedOutputs } : {}),
        label: `grep:${input.pattern}`,
        complete: run.captureComplete,
      });
      record(`grep:${input.pattern}`, text);
      return text;
    },
  });

  const bashInput = commandSessions === undefined
    ? schema.object({
      command: schema.string(),
      timeoutMs: schema.optional(schema.integer()),
    })
    : schema.union([
      schema.object({
        command: schema.string(),
        timeoutMs: schema.optional(schema.integer()),
        yieldTimeMs: schema.optional(schema.integer()),
      }),
      schema.object({
        action: schema.literal("list"),
      }),
      schema.object({
        sessionId: schema.string(),
        action: schema.literal("read"),
        cursor: schema.optional(schema.integer()),
        query: schema.optional(schema.string()),
        limit: schema.optional(schema.integer()),
        waitMs: schema.optional(schema.integer()),
      }),
      schema.object({
        sessionId: schema.string(),
        action: schema.literal("write"),
        input: schema.string(),
        closeStdin: schema.optional(schema.boolean()),
        cursor: schema.optional(schema.integer()),
        limit: schema.optional(schema.integer()),
        waitMs: schema.optional(schema.integer()),
      }),
      schema.object({
        sessionId: schema.string(),
        action: schema.literal("kill"),
        cursor: schema.optional(schema.integer()),
        limit: schema.optional(schema.integer()),
      }),
    ]);
  const bashTool = tool({
    name: "bash",
    description: commandSessions === undefined
      ? `Run one shell command in the workspace; hard timeout ${BASH_TIMEOUT_MS} ms; ` +
        `output capped at ${caps.bash} bytes. Interactive sessions are unavailable.`
      : "Run shell command in the workspace and return combined stdout/stderr. " +
      "Set yieldTimeMs to keep a still-running command as an inspectable session. " +
      "List sessions; read pages or use query + waitMs for literal output, write resumes " +
      "stdin or closes it for EOF, and kill stops one. Cursors never rerun commands. " +
      `Hard timeout is ${BASH_TIMEOUT_MS} ms; output is capped at ${caps.bash} bytes.`,
    input: bashInput,
    effect: "external",
    result: "inline",
    timeoutMs: BASH_TIMEOUT_MS,
    async execute(input, signal) {
      if ("command" in input) {
        const timeoutMs = Math.min(input.timeoutMs ?? BASH_TIMEOUT_MS, BASH_TIMEOUT_MS);
        const yieldTimeMs = "yieldTimeMs" in input ? input.yieldTimeMs : undefined;
        validateBashWait(yieldTimeMs, "yieldTimeMs");
        const local = localBackendInternals(executionBackend) !== undefined;
        const env = buildCodingProcessEnv(local);
        const shell = local
          ? hostShellInvocation(input.command, process.platform, env)
          : { command: "sh", args: ["-c", input.command] as readonly string[] };
        if (commandSessions === undefined) {
          if (yieldTimeMs !== undefined) {
            throw new Error(local ? "cave_execution_backend_command_sessions_disabled" : "cave_execution_backend_command_sessions_local_only");
          }
          const run = await executionBackend.exec({
            command: shell.command,
            args: shell.args,
            cwd: await workspaceRoot(),
            env,
            timeoutMs,
            maxOutputBytes: PROCESS_CAPTURE_MAX_BYTES,
            ...(signal === undefined ? {} : { signal }),
          });
          if (run.code === 127 || run.startFailed === true) {
            throw new Error("caveman-code: host command shell is not available");
          }
          const status = run.timedOut ? `exit timeout after ${timeoutMs}ms` : `exit ${run.code}`;
          const combined = combinedProcessOutput(run);
          const output = combined.trim() === ""
            ? "(no output)"
            : combined;
          const text = `${status}\n${capToolOutput({
            text: output,
            maxBytes: Math.max(1, caps.bash - Buffer.byteLength(`${status}\n`, "utf8")),
            direction: "tail",
            ...(recoverable ? { store: storedOutputs } : {}),
            label: `bash:${input.command.slice(0, 60)}`,
            complete: !run.truncated,
          })}`;
          record(`bash:${input.command.slice(0, 60)}`, text);
          return text;
        }
        let started;
        try {
          started = await commandSessions.start({
            command: shell.command,
            args: shell.args,
            cwd: await workspaceRoot(),
            env,
            stdin: yieldTimeMs === undefined ? "closed" : "pipe",
            timeoutMs,
            ...(signal === undefined ? {} : { signal }),
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          // Only a launch/spawn failure means the shell is unavailable. A
          // rejected argument or an exhausted session pool must say so, or the
          // model retries forever against a healthy host.
          throw new Error(
            reason.startsWith("command_session_launch_invalid") ||
              reason.startsWith("command_session_spawn_failed")
              ? `caveman-code: host command shell is not available: ${reason}`
              : reason === "command_session_limit_reached"
                ? `caveman-code: all ${BASH_SESSION_MAX_SESSIONS} command sessions are still live; ` +
                  "kill one with bash({action:\"kill\",sessionId}) before starting another"
                : `caveman-code: bash could not start: ${reason}`,
          );
        }
        const waited = await waitForCommandSession(
          commandSessions,
          started.sessionId,
          yieldTimeMs ?? timeoutMs + 1_000,
          signal,
        );
        if (waited.state === "running") {
          const page = await commandSessions.read({
            sessionId: started.sessionId,
            cursor: 0,
            limit: bashSessionPageLimit(caps.bash),
            ...(signal === undefined ? {} : { signal }),
          });
          const text = formatCommandSessionPage(page, caps.bash);
          record(`bash:${input.command.slice(0, 60)}`, text);
          return text;
        }
        const capture = await captureCommandSession(commandSessions, started.sessionId, signal);
        if (capture.spawnError !== undefined) {
          throw new Error("caveman-code: host command shell is not available");
        }
        const status = capture.state === "timed_out"
          ? `exit timeout after ${timeoutMs}ms`
          : capture.state === "killed"
            ? "exit killed"
            : `exit ${capture.exitCode}`;
        const output = capture.output.trim() === ""
          ? "(no output)"
          : capture.outputEncoding === "base64"
            ? `[base64 command output]\n${capture.output}`
            : capture.output;
        const text = `${status}\n${capToolOutput({
          text: output,
          maxBytes: Math.max(1, caps.bash - Buffer.byteLength(`${status}\n`, "utf8")),
          direction: "tail",
          ...(recoverable ? { store: storedOutputs } : {}),
          label: `bash:${input.command.slice(0, 60)}`,
          complete: capture.availableFrom === 0,
          ...(recoverable
            ? {}
            : capture.availableFrom === 0
              ? {
                  recovery:
                    `resume retained output with bash(${JSON.stringify({
                      sessionId: started.sessionId,
                      action: "read",
                      cursor: 0,
                    })})`,
                }
              : {
                  source:
                    `retained bytes ${capture.availableFrom}-${capture.availableTo}; ` +
                    `older output discarded before absolute byte ${capture.availableFrom}`,
                  recovery:
                    `resume retained output with bash(${JSON.stringify({
                      sessionId: started.sessionId,
                      action: "read",
                      cursor: capture.availableFrom,
                    })})`,
                }),
        })}`;
        record(`bash:${input.command.slice(0, 60)}`, text);
        return text;
      }

      if (commandSessions === undefined) {
        throw new Error("cave_execution_backend_command_sessions_local_only");
      }
      if (input.action === "list") {
        const text = formatCommandSessionList(commandSessions.list(), caps.bash);
        record("bash:list", text);
        return text;
      }
      validateBashSessionReadInput(input, caps.bash);
      let prefix: string | undefined;
      let writeOutputCursor: number | undefined;
      let waitedForClose = false;
      if (input.action === "write") {
        const write = await commandSessions.write({
          sessionId: input.sessionId,
          input: input.input,
          ...(input.closeStdin === undefined ? {} : { closeStdin: input.closeStdin }),
          ...(signal === undefined ? {} : { signal }),
        });
        writeOutputCursor = write.outputCursor;
        prefix = write.accepted
          ? `stdin accepted ${write.bytes} bytes${input.closeStdin === true ? " · stdin closed" : ""}`
          : `stdin not accepted · ${write.state}`;
        if (write.accepted && input.closeStdin === true && input.waitMs !== undefined) {
          await waitForCommandSession(commandSessions, input.sessionId, input.waitMs, signal);
          waitedForClose = true;
        }
      } else if (input.action === "kill") {
        await commandSessions.kill(input.sessionId);
      }
      const readCursor = input.cursor ?? writeOutputCursor;
      const page = await commandSessions.read({
        sessionId: input.sessionId,
        ...(readCursor === undefined ? {} : { cursor: readCursor }),
        ...(input.action === "read" && input.query !== undefined ? { query: input.query } : {}),
        limit: input.limit ?? bashSessionPageLimit(caps.bash),
        ...(input.action === "kill" || input.waitMs === undefined || waitedForClose
          ? {}
          : { waitMs: input.waitMs }),
        ...(signal === undefined ? {} : { signal }),
      });
      const text = formatCommandSessionPage(page, caps.bash, prefix);
      record(`bash:${input.action}:${input.sessionId}`, text);
      return text;
    },
  });

  const writeTool = tool({
    name: "write_file",
    description:
      "Create a UTF-8 file in the workspace. Refuses an existing path unless overwrite is true. " +
      "Parent directory must already exist.",
    input: schema.object({
      path: schema.string(),
      content: schema.string(),
      overwrite: schema.optional(schema.boolean()),
    }),
    effect: "write",
    result: "inline",
    timeoutMs: READ_TIMEOUT_MS,
    async execute(input) {
      const target = await contained(input.path);
      await backendWriteFile(
        executionBackend,
        target,
        Buffer.from(input.content, "utf8"),
        input.overwrite !== true,
      );
      return capOutput(
        `wrote ${input.path}: ${Buffer.byteLength(input.content, "utf8")} bytes`,
        caps.write_file,
      );
    },
  });

  const editTool = tool({
    name: "edit_file",
    description:
      "Replace an exact string in a workspace file. The old string must appear exactly " +
      "once unless replace_all is set. Writes to disk.",
    input: schema.object({
      path: schema.string(),
      old_string: schema.string(),
      new_string: schema.string(),
      replace_all: schema.optional(schema.boolean()),
    }),
    effect: "write",
    result: "inline",
    timeoutMs: READ_TIMEOUT_MS,
    async execute(input) {
      if (input.old_string === input.new_string) {
        throw new Error("caveman-code: old_string and new_string are identical");
      }
      const target = await contained(input.path);
      const content = Buffer.from(await executionBackend.readFile(target)).toString("utf8");
      const occurrences = content.split(input.old_string).length - 1;
      if (occurrences === 0) {
        throw new Error(`caveman-code: old_string not found in ${input.path}`);
      }
      if (occurrences > 1 && input.replace_all !== true) {
        throw new Error(
          `caveman-code: old_string appears ${occurrences} times in ${input.path}; ` +
          "add surrounding context or pass replace_all",
        );
      }
      // split/join UNCONDITIONALLY. String.prototype.replace
      // interprets `$&`, `$\``, `$'`, `$$`, `$1`… in the REPLACEMENT even for a
      // string pattern, so a new_string containing any of them would silently
      // corrupt the file. The non-replace_all branch is guaranteed exactly one
      // occurrence above, so joining replaces precisely that one.
      const updated = content.split(input.old_string).join(input.new_string);
      await executionBackend.writeFile(target, Buffer.from(updated, "utf8"));
      const replaced = input.replace_all === true ? occurrences : 1;
      return capOutput(
        `edited ${input.path}: ${replaced} replacement${replaced === 1 ? "" : "s"}`,
        caps.edit_file,
      );
    },
  });

  const readToolOutput = tool({
    name: "read_tool_output",
    description:
      "Read captured output from this active agent by opaque handle. Uses zero-based byte offset " +
      "and bounded byte limit, or finds a literal query without rerunning the original tool.",
    input: schema.object({
      handle: schema.string(),
      offset: schema.optional(schema.integer()),
      limit: schema.optional(schema.integer()),
      query: schema.optional(schema.string()),
    }),
    effect: "read",
    result: "inline",
    timeoutMs: READ_TIMEOUT_MS,
    async execute(input) {
      const stored = storedOutputs.get(input.handle);
      if (stored === undefined) {
        throw new Error("caveman-code: tool output handle is unknown or evicted");
      }
      const offset = input.offset ?? 0;
      const requestedLimit = input.limit ?? Math.min(8_000, caps.read_tool_output - 512);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("caveman-code: read_tool_output offset must be a non-negative integer");
      }
      if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
        throw new Error("caveman-code: read_tool_output limit must be a positive integer");
      }
      const limit = Math.min(requestedLimit, Math.max(1, caps.read_tool_output - 512));
      let start = Math.min(offset, stored.bytes.byteLength);
      if (input.query !== undefined) {
        if (input.query.length === 0) {
          throw new Error("caveman-code: read_tool_output query must not be empty");
        }
        const found = stored.bytes.indexOf(Buffer.from(input.query, "utf8"), start);
        if (found < 0) {
          return `no literal match in ${stored.label} at or after byte ${start}`;
        }
        start = found;
      }
      const end = Math.min(stored.bytes.byteLength, start + limit);
      const page = stored.bytes.subarray(start, end).toString("utf8");
      const status = stored.complete ? "complete capture" : "partial capture; later process output was unavailable";
      return capOutput(
        [
          `${stored.label} · bytes ${start}-${end} of ${stored.bytes.byteLength} · ${status}`,
          page,
          ...(end < stored.bytes.byteLength ? [`[next offset: ${end}]`] : []),
        ].join("\n"),
        caps.read_tool_output,
      );
    },
  });

  const built: Record<ShellToolName, ToolDefinition> = {
    read_file: readFileTool,
    grep: grepTool,
    bash: bashTool,
    write_file: writeTool,
    edit_file: editTool,
    read_tool_output: readToolOutput,
  };
  return names.map((name) => built[name]);
}

type BashSessionReadInput = {
  readonly cursor?: number;
  readonly query?: string;
  readonly limit?: number;
  readonly waitMs?: number;
};

function validateBashWait(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0 || value > BASH_SESSION_MAX_WAIT_MS) {
    throw new Error(`caveman-code: ${name} must be an integer from 0 to ${BASH_SESSION_MAX_WAIT_MS}`);
  }
}

function validateBashSessionReadInput(input: BashSessionReadInput, outputCap: number): void {
  if (input.cursor !== undefined && (!Number.isSafeInteger(input.cursor) || input.cursor < 0)) {
    throw new Error("caveman-code: bash session cursor must be a non-negative integer");
  }
  const maxLimit = bashSessionPageLimit(outputCap);
  if (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit <= 0 || input.limit > maxLimit)) {
    throw new Error(`caveman-code: bash session limit must be an integer from 1 to ${maxLimit}`);
  }
  if (input.query !== undefined) {
    const queryBytes = Buffer.byteLength(input.query, "utf8");
    if (queryBytes === 0 || queryBytes > BASH_SESSION_QUERY_MAX_BYTES) {
      throw new Error(
        `caveman-code: bash session query must be 1 to ${BASH_SESSION_QUERY_MAX_BYTES} UTF-8 bytes`,
      );
    }
  }
  validateBashWait(input.waitMs, "waitMs");
}

function bashSessionPageLimit(outputCap: number): number {
  // Base64 is worst-case 4/3 expansion. Reserve metadata first so a byte-safe
  // fallback never advances cursor past bytes omitted by final output capping.
  const encodedBudget = Math.max(1, outputCap - 512);
  const rawBudget = Math.max(1, Math.floor(encodedBudget * 3 / 4));
  return Math.min(BASH_SESSION_READ_CHUNK_BYTES, rawBudget);
}

async function waitForCommandSession(
  runtime: CommandSessionRuntime,
  sessionId: string,
  maximumWaitMs: number,
  signal?: AbortSignal,
): Promise<CommandSessionReadResult> {
  const deadline = Date.now() + maximumWaitMs;
  let cursor = 0;
  for (;;) {
    const remaining = Math.max(0, deadline - Date.now());
    const result = await runtime.read({
      sessionId,
      cursor,
      limit: 1,
      waitMs: Math.min(remaining, BASH_SESSION_MAX_WAIT_MS),
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.state !== "running" || remaining === 0) return result;
    cursor = result.availableTo;
  }
}

async function captureCommandSession(
  runtime: CommandSessionRuntime,
  sessionId: string,
  signal?: AbortSignal,
): Promise<CommandSessionReadResult> {
  const snapshot = await runtime.read({
    sessionId,
    cursor: 0,
    limit: 1,
    ...(signal === undefined ? {} : { signal }),
  });
  let cursor = snapshot.availableFrom;
  const chunks: Buffer[] = [];
  while (cursor < snapshot.availableTo) {
    const page = await runtime.read({
      sessionId,
      cursor,
      limit: BASH_SESSION_READ_CHUNK_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    chunks.push(Buffer.from(page.output, page.outputEncoding));
    if (page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  const captured = Buffer.concat(chunks);
  const outputEncoding = isUtf8(captured) ? "utf8" : "base64";
  return Object.freeze({
    ...snapshot,
    outputEncoding,
    output: captured.toString(outputEncoding),
  });
}

function formatCommandSessionPage(
  page: CommandSessionReadResult,
  outputCap: number,
  prefix?: string,
): string {
  if (page.state === "unknown_after_restart") {
    return capOutput(
      [
        `session ${page.sessionId} · unknown_after_restart`,
        "session belongs to another or closed runtime; process adoption is disabled",
      ].join("\n"),
      outputCap,
    );
  }
  const exit = page.state === "exited"
    ? ` · exit ${page.exitCode}`
    : page.state === "timed_out"
      ? " · hard timeout"
      : page.state === "killed"
        ? " · killed"
        : "";
  if (page.matchStart === null) {
    const searchedFrom = Math.max(page.cursor, page.availableFrom);
    const continuation = page.hasMore
      ? `[continue search at cursor ${page.nextCursor}]`
      : page.state === "running"
        ? `[still running; search again at cursor ${page.nextCursor}]`
        : undefined;
    return capOutput(
      [
        `session ${page.sessionId} · ${page.state}${exit}`,
        ...(prefix === undefined ? [] : [prefix]),
        `searched retained bytes ${searchedFrom}-${page.nextCursor} of ${page.availableTo}`,
        ...(page.truncatedBeforeCursor
          ? [`older output discarded before absolute byte ${page.availableFrom}`]
          : []),
        "(no literal match)",
        ...(continuation === undefined ? [] : [continuation]),
      ].join("\n"),
      outputCap,
    );
  }
  const position = [
    ...(page.matchStart === undefined ? [] : [`literal match at byte ${page.matchStart}`]),
    `bytes ${page.outputStart}-${page.nextCursor} of ${page.availableTo}`,
    `next cursor ${page.nextCursor}`,
    ...(page.truncatedBeforeCursor
      ? [`older output discarded before absolute byte ${page.availableFrom}`]
      : []),
  ].join(" · ");
  const continuation = page.hasMore
    ? `[continue at cursor ${page.nextCursor}]`
    : page.state === "running"
      ? `[still running; read again at cursor ${page.nextCursor}]`
      : undefined;
  return capOutput(
    [
      `session ${page.sessionId} · ${page.state}${exit}`,
      ...(prefix === undefined ? [] : [prefix]),
      position,
      page.output === ""
        ? "(no new output)"
        : page.outputEncoding === "base64"
          ? `[base64 bytes ${page.outputStart}-${page.nextCursor}]\n${page.output}`
          : page.output,
      ...(continuation === undefined ? [] : [continuation]),
    ].join("\n"),
    outputCap,
  );
}

function formatCommandSessionList(
  sessions: readonly CommandSessionSummary[],
  outputCap: number,
): string {
  if (sessions.length === 0) return "command sessions: none";
  return capOutput([
    `command sessions: ${sessions.length} retained · oldest first`,
    ...sessions.map((session) => {
      const exit = session.state === "exited"
        ? ` · exit ${session.exitCode}`
        : session.state === "timed_out"
          ? " · hard timeout"
          : session.state === "killed"
            ? " · killed"
            : "";
      return `${session.sessionId} · ${session.state}${exit} · ` +
        `${session.stdinOpen ? "stdin open" : "stdin closed"} · ` +
        `retained bytes ${session.availableFrom}-${session.availableTo}`;
    }),
  ].join("\n"), outputCap);
}

export function capOutput(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  const kept = new TextDecoder().decode(encoded.slice(0, maxBytes));
  return `${kept}\n[caveman-code: output capped at ${maxBytes} of ${encoded.byteLength} bytes; narrow the request]`;
}

function capToolOutput(input: {
  text: string;
  maxBytes: number;
  direction: "head" | "tail";
  store?: ToolOutputStore;
  label: string;
  complete: boolean;
  source?: string;
  recovery?: string;
}): string {
  const encoded = Buffer.from(input.text, "utf8");
  if (encoded.byteLength <= input.maxBytes && input.complete) return input.text;
  const handle = input.store?.put(input.label, input.text, input.complete);
  const source = input.source ?? (
    input.complete ? "captured bytes" : "captured bytes; later process output unavailable"
  );
  const recovery = input.recovery ?? (
    input.store === undefined
      ? "recovery paging is not exposed; narrow original request"
      : handle === undefined
        ? "result too large for recovery store; narrow original request"
        : `use read_tool_output with handle ${handle}`
  );
  const marker = `\n[caveman-code: output capped from ${encoded.byteLength} ${source}; ${recovery}]`;
  const previewBytes = Math.max(0, input.maxBytes - Buffer.byteLength(marker, "utf8"));
  const preview = input.direction === "head"
    ? encoded.subarray(0, previewBytes)
    : encoded.subarray(Math.max(0, encoded.byteLength - previewBytes));
  return `${preview.toString("utf8")}${marker}`;
}

function firstLines(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.length <= limit) return text;
  return `${lines.slice(0, limit).join("\n")}\n[caveman-code: matches limited to first ${limit}; narrow pattern or path]`;
}
