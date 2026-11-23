/**
 * The tools a script reaches as `tools.*` inside an `exec` cell, on an
 * ExecEnv, with Codex 0.166's names, arguments and result records:
 * exec_command (yields with a session_id while the command keeps running),
 * write_stdin (poll, or "\u0003" to stop), apply_patch (the patch as a
 * string) and view_image. Ported from the climb branch's exec-tools.ts.
 *
 * Differences from Codex, all from ExecEnv: there is no PTY and no stdin
 * (`tty` is accepted; write_stdin with characters other than "\u0003" fails
 * with a message saying so), `login`, `justification`, `prefix_rule` and
 * `sandbox_permissions` are accepted and ignored (there is no sandbox to
 * escalate), and session ids and chunk ids are deterministic counters so an
 * offline replay of a run sees the same records.
 *
 * Lifetimes: a command that yields gets a session and outlives its cell
 * (write_stdin, a terminate of the cell that started it, or the run's dispose
 * ends it). A command still inside its yield window has no session id yet, so
 * when its call is cancelled (the cell ended, was terminated or timed out, or
 * the run is disposed) it is killed: nobody could ever reach it again.
 */
import { createHash } from "node:crypto";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import type { ExecEnv, ExecResult } from "../../env/types.ts";
import type { DefDelta } from "../../interface-gate.ts";
import type { ToolConfig } from "../../loadout.ts";
import { IMAGE_MAX_BYTES, limitsOf, readExisting, sniffImage } from "../compact.ts";
import { shapeOutput, type ShapeConfig } from "../shape.ts";
import { estimateTokens, type TokenEstimate } from "../tokens.ts";
import { applyPatch, formatPatchSummary, PatchError, type PatchIO } from "./apply-patch.ts";
import type { McpToolHandle } from "../../mcp.ts";
import { execToolSample, type NestedToolSpec } from "./describe.ts";
import { cutNoticeText, formattedTruncateText, overBudget } from "./format.ts";

/**
 * What a cell learns from its nested calls: files changed (edit tracking), a
 * command that exited non-zero or a patch that failed (not progress), calls by
 * name, the sessions it started, and its exec_command runs still inside their
 * yield window.
 */
export interface CellLedger {
  mutated: boolean;
  failed: boolean;
  calls: Record<string, number>;
  sessions: Set<number>;
  inflight: Set<Promise<void>>;
  /** File changes and commands in the order they happened, for the policy levers (what ran after the last edit). */
  log: LedgerEntry[];
  /** R1: nested outputs shaped since the last report, as `kind:tool`. */
  shaped: string[];
}

/**
 * One step of a cell, as the policy levers read it: a patch that changed
 * files (`files`: each file it wrote, absolute, with the lines it added, i.e.
 * the new text's lines the file did not have before, and when
 * policy.interface_gate is on what the write did to its functions), a command
 * (finished with its exit code and output tail, or yielded with a session;
 * `workdir` when the call named one), or a poll of a session (finished or not).
 */
export type LedgerEntry =
  | { kind: "mutate"; files?: { path: string; added: string; defs?: DefDelta }[] }
  | { kind: "command"; cmd: string; exitCode?: number; session?: number; output: string; workdir?: string }
  | { kind: "poll"; session: number; exitCode?: number; output: string };

/** The output kept per log entry: the tail, where runners print their summaries. */
const LOG_TAIL_BYTES = 4096;
/** The added lines kept per patched file (travel_jit reads imports and path literals from them). */
const ADDED_MAX_CHARS = 256 * 1024;

/** The lines of `after` that `before` does not have (all of them for a new file), at most ADDED_MAX_CHARS. */
export function addedLines(before: string | undefined, after: string): string {
  const old = new Set((before ?? "").split("\n"));
  return after.split("\n").filter((line) => !old.has(line)).join("\n").slice(0, ADDED_MAX_CHARS);
}
export const logTail = (text: string) => (text.length > LOG_TAIL_BYTES ? text.slice(-LOG_TAIL_BYTES) : text);
const tail = logTail;

export const newLedger = (): CellLedger => ({ mutated: false, failed: false, calls: {}, sessions: new Set(), inflight: new Set(), log: [], shaped: [] });

/** Session state shared by every cell of a run. */
export interface NestedShared {
  env: ExecEnv;
  sessions: Map<number, { handle: string; cmd: string }>;
  nextSession: number;
  chunks: number;
  /** exec_command runs not yet yielded or finished, by their cancel switch; settled once the run is registered or killed. */
  inflight: Map<AbortController, Promise<void>>;
  /** R1 (results.shaping): how finished outputs are shaped and where their full logs go. Absent: never shaped. */
  shaping?: { config: ShapeConfig; spill(text: string): Promise<string | undefined> };
  /** limits.token_estimate: how max_output_tokens counts (absent: bytes/4, Codex's). */
  tokens?: TokenEstimate;
  /**
   * exec.cut_notice: a record cut to its max_output_tokens names the output lines it dropped and, when `spillRecord`
   * saved it, the file holding the whole output (off: Codex's warning, and the cut part is gone).
   */
  cutNotice?: boolean;
  spillRecord?(text: string): Promise<string | undefined>;
  /** exec.error_hints: nested errors say how to fix the call. */
  hints?: boolean;
  /** policy.interface_gate: what a patch did to a written file's functions (interface-gate.ts defDelta), read while both texts are at hand. */
  defs?(path: string, before: string | undefined, after: string): DefDelta | undefined;
}

/** The text a record's `output` is cut from: the env's dropped-bytes notice, then the output. */
function recordSource(run: ExecResult): string {
  const dropped = run.truncated ? `... ${Math.max(0, run.totalBytes - Buffer.byteLength(run.output, "utf8"))} bytes omitted ...\n` : "";
  return dropped + run.output;
}

/** unifiedRecord, first saving the whole output when exec.cut_notice is on and the record's own budget cuts it. */
export async function recordOf(shared: NestedShared, run: ExecResult, startedMs: number, sessionId: number | undefined, maxOutputTokens: number | undefined): Promise<Record<string, unknown>> {
  let spill: string | undefined;
  if (shared.cutNotice === true && shared.spillRecord !== undefined && maxOutputTokens !== undefined) {
    const text = recordSource(run);
    if (overBudget(text, maxOutputTokens, shared.tokens ?? "bytes4")) spill = await shared.spillRecord(text);
  }
  return unifiedRecord(shared, run, startedMs, sessionId, maxOutputTokens, spill);
}

/**
 * A finished command's output as the record carries it: its shaped view (counts, first failures, tail, the
 * full log's path) when results.shaping recognizes it and the log could be written, else as it came.
 */
export async function shapeRun(shared: NestedShared, cmd: string, run: ExecResult, ledger?: CellLedger): Promise<ExecResult> {
  if (shared.shaping === undefined || run.running) return run;
  const plan = shapeOutput(cmd, run.output, run.exitCode, shared.shaping.config);
  if (plan === undefined) return run;
  const path = await shared.shaping.spill(run.output);
  if (path === undefined) return run;
  ledger?.shaped.push(`${plan.kind}:${plan.tool}`);
  // Not `truncated`: the shaped header already names the raw size, so no "bytes omitted" prefix.
  return { ...run, output: plan.render(path), truncated: false };
}

export const NESTED_TOOL_NAMES = ["apply_patch", "exec_command", "view_image", "write_stdin"] as const;
export type NestedToolName = (typeof NESTED_TOOL_NAMES)[number];

const INTERRUPT = "\u0003";

const MAX_OUTPUT_TOKENS = Type.Optional(Type.Number({ description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." }));

/** exec_command's and write_stdin's result, as Codex declares it. */
const UNIFIED_EXEC_OUTPUT = Type.Object({
  chunk_id: Type.Optional(Type.String({ description: "Chunk identifier included when the response reports one." })),
  exit_code: Type.Optional(Type.Number({ description: "Process exit code when the command finished during this call." })),
  original_token_count: Type.Optional(Type.Number({ description: "Approximate token count before output truncation." })),
  output: Type.String({ description: "Command output text, possibly truncated." }),
  session_id: Type.Optional(Type.Number({ description: "Session identifier to pass to write_stdin when the process is still running." })),
  wall_time_seconds: Type.Number({ description: "Elapsed wall time spent waiting for output in seconds." }),
});

const EXEC_COMMAND_INPUT = Type.Object({
  cmd: Type.String({ description: "Shell command to execute." }),
  justification: Type.Optional(Type.String({ description: "User-facing approval question for `require_escalated`; omit otherwise." })),
  login: Type.Optional(Type.Boolean({ description: "True runs the shell with -l/-i semantics; false disables them. Defaults to true." })),
  max_output_tokens: MAX_OUTPUT_TOKENS,
  prefix_rule: Type.Optional(Type.Array(Type.String(), {
    description: "Reusable approval prefix for `cmd`, only with `sandbox_permissions: \"require_escalated\"`; for example [\"git\", \"pull\"].",
  })),
  sandbox_permissions: Type.Optional(Type.Union([Type.Literal("use_default"), Type.Literal("require_escalated")], {
    description: "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.",
  })),
  shell: Type.Optional(Type.String({ description: "Shell binary to launch. Defaults to the user's default shell." })),
  tty: Type.Optional(Type.Boolean({ description: "True allocates a PTY for the command; false or omitted uses plain pipes." })),
  workdir: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the turn cwd." })),
  yield_time_ms: Type.Optional(Type.Number({ description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." })),
});

const WRITE_STDIN_INPUT = Type.Object({
  chars: Type.Optional(Type.String({ description: "Bytes to write to stdin. Defaults to empty, which polls without writing." })),
  max_output_tokens: MAX_OUTPUT_TOKENS,
  session_id: Type.Number({ description: "Identifier of the running unified exec session." }),
  yield_time_ms: Type.Optional(Type.Number({
    description: "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
  })),
});

const IMAGE_DETAIL = (description: string) => Type.Union([Type.Literal("high"), Type.Literal("original")], { description });

const VIEW_IMAGE_INPUT = Type.Object({
  detail: Type.Optional(IMAGE_DETAIL("Image detail level. Defaults to `high`; use `original` to preserve exact resolution.")),
  path: Type.String({ description: "Local filesystem path to an image file." }),
});

const VIEW_IMAGE_OUTPUT = Type.Object({
  detail: IMAGE_DETAIL("Image detail hint returned by view_image. Returns `high` for default resized behavior or `original` when original resolution is preserved."),
  image_url: Type.String({ description: "Data URL for the loaded image." }),
});

export const NESTED_SPECS: Readonly<Record<NestedToolName, NestedToolSpec>> = Object.freeze({
  apply_patch: { name: "apply_patch", description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.", input: Type.Object({ input: Type.String() }), freeform: true },
  exec_command: { name: "exec_command", description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.", input: EXEC_COMMAND_INPUT, output: UNIFIED_EXEC_OUTPUT },
  view_image: { name: "view_image", description: "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.", input: VIEW_IMAGE_INPUT, output: VIEW_IMAGE_OUTPUT },
  write_stdin: { name: "write_stdin", description: "Writes characters to an existing unified exec session and returns recent output.", input: WRITE_STDIN_INPUT, output: UNIFIED_EXEC_OUTPUT },
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

/** A nested tool's arguments: an object, or a bare string for its one string field (`tools.exec_command("ls")`). */
function argsOf(raw: unknown, stringField: string): Record<string, unknown> {
  if (typeof raw === "string") return { [stringField]: raw };
  return isRecord(raw) ? raw : {};
}

/**
 * Codex's unified exec record, in Codex's key order: chunk_id,
 * wall_time_seconds, exit_code (finished), original_token_count, output,
 * session_id (still running). The model reads these as JSON; the order is
 * part of what it was trained on.
 */
export function unifiedRecord(shared: NestedShared, run: ExecResult, startedMs: number, sessionId: number | undefined, maxOutputTokens: number | undefined, spill?: string): Record<string, unknown> {
  const chunk = createHash("sha256").update(`chunk:${++shared.chunks}`).digest("hex").slice(0, 6);
  const text = recordSource(run);
  const mode = shared.tokens ?? "bytes4";
  const output = maxOutputTokens === undefined ? text
    : shared.cutNotice === true ? cutNoticeText(text, maxOutputTokens, spill, mode) : formattedTruncateText(text, maxOutputTokens, undefined, mode);
  const exitCode = run.exitCode ?? (run.timedOut === true ? 124 : run.killed === true ? 137 : -1);
  const size = Buffer.byteLength(text, "utf8");
  return {
    chunk_id: chunk,
    wall_time_seconds: Math.round(performance.now() - startedMs) / 1000,
    ...(run.running ? {} : { exit_code: exitCode }),
    // dense: the kept text's estimate, scaled up by the bytes the env dropped before it reached us
    original_token_count: mode === "bytes4" ? Math.ceil(Math.max(run.totalBytes, size) / 4) : Math.ceil(estimateTokens(text, mode) * Math.max(1, run.totalBytes / Math.max(1, size))),
    output,
    ...(run.running && sessionId !== undefined ? { session_id: sessionId } : {}),
  };
}

/** exec_command's limits with their defaults (the v1 description states the same numbers). */
export function execCommandLimits(config: ToolConfig) {
  return limitsOf("exec_command", config, {
    default_yield_ms: 10_000, max_yield_ms: 30_000, hard_timeout_s: 3600,
    // Yield floor (Codex: 250): the model asks <= 1 s on 89% of explicit yields, so a command still running at 1 s costs a poll request that
    // re-reads the context; the call holds to this instead and a command that exits sooner still returns at once.
    min_yield_ms: 250,
  });
}

/** write_stdin's limits with their defaults. */
export function writeStdinLimits(config: ToolConfig) {
  return limitsOf("write_stdin", config, {
    // The poll floor (Codex: 5 s): a poll that returns while the job still runs buys another request; it returns at the job's end if sooner.
    min_poll_ms: 5_000, max_poll_ms: 300_000,
  });
}

/** The enabled nested tools for one cell, in Codex's order (by name), recording into the cell's ledger. */
export function nestedTools(shared: NestedShared, configs: Partial<Record<NestedToolName, ToolConfig>>, ledger: CellLedger, specs: Readonly<Record<NestedToolName, NestedToolSpec>> = NESTED_SPECS): CodemodeTool[] {
  const { env } = shared;
  const count = (name: string) => (ledger.calls[name] = (ledger.calls[name] ?? 0) + 1);
  const tools: CodemodeTool[] = [];
  for (const name of NESTED_TOOL_NAMES) {
    const config = configs[name];
    if (config === undefined || config.exposure === "off") continue;
    const spec = specs[name];
    const base = {
      name, description: config.description ?? spec.description, inputSchema: spec.input as CodemodeJsonSchema,
      ...(spec.output === undefined ? {} : { outputSchema: spec.output as CodemodeJsonSchema }),
    };
    if (name === "exec_command") {
      const limits = execCommandLimits(config);
      tools.push({ ...base, async execute(raw, { signal }) {
        count(name);
        const args = argsOf(raw, "cmd");
        if (typeof args.cmd !== "string" || args.cmd.trim() === "") throw new Error("exec_command failed: `cmd` must be a non-empty string");
        const cmd = args.cmd;
        const yieldMs = clamp(num(args.yield_time_ms) ?? limits.default_yield_ms, limits.min_yield_ms, limits.max_yield_ms);
        const command = typeof args.shell === "string" && args.shell !== "" ? `${args.shell} -c ${quote(cmd)}` : cmd;
        const cwd = typeof args.workdir === "string" && args.workdir !== "" ? args.workdir : undefined;
        const started = performance.now();
        // Our own switch, not the call's signal: the env keeps listening to it for the process's whole life, and a
        // command that yields must outlive its cell. It fires only while the command is inside its yield window.
        const cancel = new AbortController();
        const onCancel = () => cancel.abort();
        signal.addEventListener("abort", onCancel, { once: true });
        if (signal.aborted) onCancel();
        const work = (async () => {
          try {
            const run = await env.exec(command, { yieldMs, timeoutMs: limits.hard_timeout_s * 1000, signal: cancel.signal, ...(cwd === undefined ? {} : { cwd }) });
            if (cancel.signal.aborted) {
              if (run.running && run.handle !== undefined) await env.kill(run.handle).catch(() => undefined);
              throw new Error("exec_command cancelled: the cell ended before the command yielded, so the command was stopped");
            }
            let sessionId: number | undefined;
            if (run.running && run.handle !== undefined) {
              sessionId = shared.nextSession++;
              shared.sessions.set(sessionId, { handle: run.handle, cmd });
              ledger.sessions.add(sessionId);
            }
            return { run, sessionId };
          } finally {
            signal.removeEventListener("abort", onCancel);
          }
        })();
        const settled = work.then(() => undefined, () => undefined);
        shared.inflight.set(cancel, settled);
        ledger.inflight.add(settled);
        void settled.then(() => {
          shared.inflight.delete(cancel);
          ledger.inflight.delete(settled);
        });
        const { run, sessionId } = await work;
        if (!run.running && run.exitCode !== 0) ledger.failed = true;
        // The model sees the shaped output (R1); the levers read the raw tail, where runners print their verdicts.
        const record = await recordOf(shared, await shapeRun(shared, cmd, run, ledger), started, sessionId, num(args.max_output_tokens));
        ledger.log.push({
          kind: "command", cmd, output: tail(run.output),
          ...(typeof record.exit_code === "number" ? { exitCode: record.exit_code } : {}), ...(sessionId === undefined ? {} : { session: sessionId }),
          ...(cwd === undefined ? {} : { workdir: cwd }),
        });
        return record;
      } });
    } else if (name === "write_stdin") {
      const limits = writeStdinLimits(config);
      tools.push({ ...base, async execute(raw, { signal }) {
        count(name);
        const args = argsOf(raw, "chars");
        const id = num(args.session_id);
        const entry = id === undefined ? undefined : shared.sessions.get(id);
        if (entry === undefined || id === undefined) throw new Error(`write_stdin failed: Unknown process id ${String(args.session_id)}`);
        const chars = typeof args.chars === "string" ? args.chars : "";
        if (chars !== "" && chars !== INTERRUPT) {
          throw new Error("write_stdin failed: this environment has no PTY or stdin; only polling (empty chars) and \"\\u0003\" (stop) work. " +
            "Rerun the command non-interactively, with its input piped or in a here-doc.");
        }
        const started = performance.now();
        const waitMs = clamp(num(args.yield_time_ms) ?? limits.min_poll_ms, limits.min_poll_ms, limits.max_poll_ms);
        const run = chars === INTERRUPT ? await env.kill(entry.handle) : await env.wait(entry.handle, waitMs, signal);
        if (!run.running) shared.sessions.delete(id);
        if (!run.running && run.exitCode !== 0 && chars !== INTERRUPT) ledger.failed = true;
        const record = await recordOf(shared, chars === INTERRUPT ? run : await shapeRun(shared, entry.cmd, run, ledger), started, id, num(args.max_output_tokens));
        // A session stopped with \u0003 has no outcome to report: it was interrupted, not checked.
        if (chars !== INTERRUPT) ledger.log.push({ kind: "poll", session: id, output: tail(run.output), ...(typeof record.exit_code === "number" ? { exitCode: record.exit_code } : {}) });
        return record;
      } });
    } else if (name === "apply_patch") {
      const { nearest } = limitsOf(name, config, { nearest: false });
      tools.push({ ...base, async execute(raw) {
        count(name);
        const args = argsOf(raw, "input");
        const patch = typeof args.input === "string" ? args.input : typeof args.patch === "string" ? args.patch : undefined;
        if (patch === undefined) throw new Error("apply_patch failed: pass the patch text as a string");
        const originals = new Map<string, string | undefined>();
        const files: { path: string; added: string }[] = [];
        const io: PatchIO = {
          resolve: (path) => env.resolvePath(path),
          async read(path) {
            const data = await readExisting(env, path);
            const text = typeof data === "string" ? undefined : Buffer.from(data).toString("utf8");
            originals.set(path, text);
            return text;
          },
          async write(path, text) {
            await env.writeFile(path, text);
            let defs: DefDelta | undefined;
            try {
              defs = shared.defs?.(path, originals.get(path), text);
            } catch {
              // the scan never fails a patch that already landed; the gate reads the file as unknown
            }
            files.push({ path, added: addedLines(originals.get(path), text), ...(defs === undefined ? {} : { defs }) });
          },
          async remove(path) {
            const run = await env.exec(`rm -f -- ${quote(path)}`, { timeoutMs: 30_000 });
            if (run.exitCode !== 0) throw new Error(`cannot delete ${path}: ${run.output.trim()}`);
          },
        };
        try {
          const summary = await applyPatch(patch, io, { nearest });
          // A patch that leaves every file as it was (an Add File with the same content) is not progress.
          if (summary.changed) {
            ledger.mutated = true;
            ledger.log.push({ kind: "mutate", files });
          }
          return formatPatchSummary(summary);
        } catch (error) {
          ledger.failed = true;
          const text = error instanceof Error ? error.message : String(error);
          throw new Error(error instanceof PatchError ? `apply_patch verification failed: ${text}` : `apply_patch failed: ${text}`);
        }
      } });
    } else {
      limitsOf(name, config, {});
      tools.push({ ...base, async execute(raw) {
        count(name);
        const args = argsOf(raw, "path");
        const path = typeof args.path === "string" ? args.path : "";
        const info = path === "" ? undefined : await env.stat(path);
        if (info === undefined || info.kind !== "file") {
          // error_hints: 107 of 162 failed cells in the census were this, after the cell's own command that was to write the image failed.
          const hint = shared.hints === true ? "; if a command in this cell was to write it, check that command's exit_code before viewing" : "";
          throw new Error(`unable to locate image at \`${path}\`: No such file or directory (os error 2)${hint}`);
        }
        if (info.size > IMAGE_MAX_BYTES) throw new Error(`unable to process image at \`${path}\`: ${info.size} bytes is over the ${IMAGE_MAX_BYTES} byte limit; write a smaller copy and view that`);
        const data = await env.readFile(path);
        const mime = sniffImage(data);
        if (mime === undefined) throw new Error(`unable to process image at \`${path}\`: not a PNG, JPEG, GIF or WebP image`);
        return { detail: args.detail === "original" ? "original" : "high", image_url: `data:${mime};base64,${Buffer.from(data).toString("base64")}` };
      } });
    }
  }
  return tools;
}

/**
 * The run's MCP tools as Codex's code mode gives them to a cell (Codex 0.165, captured 2026-11-06): deferred nested
 * tools, so the exec description doesn't list them; each is `tools.mcp__<server>__<tool>(args)`, listed in
 * `ALL_TOOLS` with its description and its declaration, and returns the MCP result as is (`{content, isError?,
 * structuredContent?}`: an MCP error is a result with isError, not a throw).
 */
export function mcpNestedTools(handles: readonly McpToolHandle[], ledger: CellLedger): CodemodeTool[] {
  return handles.map((handle) => {
    const name = `mcp__${handle.qualified}`;
    return {
      name,
      description: execToolSample({ name, description: handle.description, input: handle.inputSchema, outputType: "CallToolResult" }),
      inputSchema: handle.inputSchema as CodemodeJsonSchema,
      async execute(raw: unknown, { signal }: { signal: AbortSignal }) {
        ledger.calls[name] = (ledger.calls[name] ?? 0) + 1;
        return handle.callRaw(typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {}, signal);
      },
    } as CodemodeTool;
  });
}
