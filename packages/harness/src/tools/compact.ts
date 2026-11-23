/**
 * The compact surface on an ExecEnv: Pi's read, bash, edit and write
 * contracts (Pi is MIT, pi.dev), plus `wait` for commands that outlive their
 * timeout. Ported from the climb branch's compact-tools.ts with two changes:
 * bash caps head and tail (not tail only), and bash's timeout yields instead
 * of killing: the command keeps running and the model gets a handle.
 */
import type { McpToolHandle } from "../mcp.ts";
import type { ScriptStore } from "../scripts.ts";
import type { NestedHooks } from "./hooks.ts";
import { DEFAULT_PROGRAM_LIMITS, programTool, type ProgramAsk } from "./program.ts";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import type { ExecEnv, ExecResult } from "../env/types.ts";
import type { Loadout, ToolConfig } from "../loadout.ts";
import { LoadoutError } from "../loadout.ts";
import { capHead, capHeadTail } from "./cap.ts";
import { applyEdits, type TextEdit } from "./edit-apply.ts";
import { shapeOutput } from "./shape.ts";
import { parseUntil, processTarget, UNTIL_DESCRIPTION, UNTIL_MAX_MS, untilLine, waitUntil, withoutUntilTimes } from "./wait-until.ts";

/** What every tool result carries in `details`, for the trace and the policy. */
export interface ToolDetails {
  truncated: boolean;
  spill?: string;
  /** A wait on a live process: time passing is progress, so a repeat is not a loop. */
  loopExempt?: boolean;
  /** The call changed files (edit, write): repeat counters reset. */
  mutated?: boolean;
  /**
   * The call ran but did not succeed, where exitCode cannot say so (an exec
   * cell whose script failed or whose nested command exited non-zero): a new
   * call that fails is not progress.
   */
  failed?: boolean;
  /** What repeat detection compares instead of the result text, when that text carries run-to-run noise (exec's wall times, chunk ids). */
  repeatKey?: string;
  exitCode?: number | null;
  handle?: string;
  /** R1: the output was shaped (`kind:tool`, e.g. `test:pytest`); the full log is `spill`. */
  shaped?: string;
}

type Limits = Record<string, number | boolean | string>;
type Result = AgentToolResult<ToolDetails>;

const text = (value: string): TextContent => ({ type: "text", text: value });
const result = (value: string, details: ToolDetails, extra: (TextContent | ImageContent)[] = []): Result =>
  ({ content: [text(value), ...extra], details });

export function limitsOf<T extends Limits>(name: string, config: ToolConfig, defaults: T): T {
  const merged: Limits = { ...defaults };
  for (const [key, value] of Object.entries(config.limits)) {
    if (!(key in defaults)) throw new LoadoutError(`tools.${name}.limits: unknown key "${key}"`);
    if (typeof value !== typeof defaults[key]) throw new LoadoutError(`tools.${name}.limits.${key}: want ${typeof defaults[key]}`);
    merged[key] = value;
  }
  return merged as T;
}

export const IMAGE_MAX_BYTES = 4.5 * 1024 * 1024;

/**
 * A whole file in one env call (on a remote env each call is a round trip), or
 * why there is none: "missing" (no such file) or "directory". The read's own
 * error says which (ENOENT/ENOTDIR, EISDIR); only an error it does not name is
 * followed by a stat, and an error that is neither is rethrown.
 */
export async function readExisting(env: ExecEnv, path: string): Promise<Uint8Array | "missing" | "directory"> {
  try {
    return await env.readFile(path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing";
    if (code === "EISDIR") return "directory";
    const info = await env.stat(path).catch(() => {
      throw error;
    });
    if (info === undefined) return "missing";
    if (info.kind === "directory") return "directory";
    throw error;
  }
}

export function sniffImage(data: Uint8Array): string | undefined {
  const at = (index: number) => data[index];
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  return undefined;
}

export interface ToolBuildContext {
  env: ExecEnv;
  loadout: Loadout;
  /** Whether the model accepts image input (read returns images as attachments). */
  images: boolean;
  /** The run's MCP tools the program tool may call (loadout.mcp.exposure "program" or "both"). */
  mcp?: readonly McpToolHandle[];
  /** The saved-script store (--scripts-dir), for a program tool with limits.scripts. */
  scripts?: ScriptStore;
  /** The program tool's ask() side call (limits.ask). */
  ask?: ProgramAsk;
  /** A host's hooks on the calls programs and exec cells make (the library session); none in the CLI. */
  nested?: NestedHooks;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each builder's params are its own schema's Static
export type AnyTool = AgentTool<any, ToolDetails>;
type Builder = (config: ToolConfig, context: ToolBuildContext, shared: Shared) => AnyTool;
/** Type-check a tool against its own schema, then widen it for the tool list. */
const define = <S extends TSchema>(tool: AgentTool<S, ToolDetails>): AnyTool => tool as unknown as AnyTool;

interface Shared {
  /** Full output seen so far per background handle, for spill files. */
  seen: Map<string, string>;
  /** The command behind each background handle, for result shaping when a wait sees it finish. */
  commands: Map<string, string>;
  spillCount: number;
  spill(label: string, full: string): Promise<string | undefined>;
  /** A command result as the model sees it: shaped (results.shaping) or head and tail capped, the whole thing spilled. */
  commandText(run: ExecResult, key: string, waitedS: number, command?: string): Promise<{ text: string; details: ToolDetails }>;
}

function sharedState(context: ToolBuildContext): Shared {
  const { env, loadout } = context;
  const shared: Shared = {
    seen: new Map(),
    commands: new Map(),
    spillCount: 0,
    async spill(label, full) {
      if (!loadout.limits.spill) return undefined;
      try {
        const path = `${await env.scratchDir()}/${label}.log`;
        await env.writeFile(path, full);
        return path;
      } catch {
        return undefined;
      }
    },
    async commandText(run, key, waitedS, command) {
      const full = (shared.seen.get(key) ?? "") + run.output;
      if (run.running) shared.seen.set(key, full);
      else shared.seen.delete(key);
      let spillPath: string | undefined;
      let output = run.output;
      let shaped: string | undefined;
      // R1: a finished test, build or search output becomes its shaped view, only when its full log can be named.
      const plan = run.running || command === undefined || loadout.results === undefined ? undefined : shapeOutput(command, run.output, run.exitCode, loadout.results);
      if (plan !== undefined) {
        spillPath = await shared.spill(key.startsWith("p") ? key : `out-${++shared.spillCount}`, full);
        if (spillPath !== undefined) {
          output = plan.render(spillPath);
          shaped = `${plan.kind}:${plan.tool}`;
        }
      }
      const capped = capHeadTail(output, loadout.limits.output_cap_lines, loadout.limits.output_cap_bytes, (lines, bytes) =>
        `[... ${lines > 0 ? `${lines} lines, ` : ""}${bytes} bytes omitted${spillPath === undefined ? "" : `; full output: ${spillPath}`} ...]`);
      let body = capped.text;
      if ((capped.truncated || run.truncated) && shaped === undefined) {
        spillPath = await shared.spill(key.startsWith("p") ? key : `out-${++shared.spillCount}`, full);
        if (spillPath !== undefined) {
          body = capHeadTail(run.output, loadout.limits.output_cap_lines, loadout.limits.output_cap_bytes, (lines, bytes) =>
            `[... ${lines > 0 ? `${lines} lines, ` : ""}${bytes} bytes omitted; full output: ${spillPath} ...]`).text;
        }
      }
      const parts = [body.trim() === "" ? "(no output)" : body.replace(/\n$/u, "")];
      if (run.truncated) parts.push("[Output beyond the capture limit was dropped.]");
      if (run.running) {
        parts.push(`[Still running after ${waitedS}s as process ${run.handle}. Call wait with handle "${run.handle}" for more output, or with kill: true to stop it.]`);
      } else if (run.timedOut === true) {
        parts.push("Command killed: it reached the hard timeout.");
      } else if (run.killed === true) {
        parts.push("Command killed.");
      } else if (run.exitCode !== 0) {
        parts.push(`Command exited with code ${run.exitCode}`);
      }
      const shown = parts.join("\n\n");
      return {
        text: shown,
        details: {
          truncated: capped.truncated || run.truncated || shaped !== undefined,
          ...(spillPath === undefined ? {} : { spill: spillPath }),
          // Each call spills to its own file (out-N.log, the handle's log): two identical runs differ only in that path.
          ...(spillPath === undefined ? {} : { repeatKey: shown.replaceAll(spillPath, "<log>") }),
          exitCode: run.exitCode,
          ...(run.running ? { handle: run.handle! } : {}),
          ...(shaped === undefined ? {} : { shaped }),
        },
      };
    },
  };
  return shared;
}

/** One file's bytes as read shows them: text paged within the caps, an image attachment, or a note why not. Throws on an offset past the end. */
function fileView(path: string, data: Uint8Array, range: { offset?: number | undefined; limit?: number | undefined }, caps: { lines: number; bytes: number; numbers: boolean; images: boolean }): Result {
  const { lines: maxLines, bytes: maxBytes } = caps;
  const mime = sniffImage(data);
  if (mime !== undefined) {
    if (!caps.images) return result(`${path} is an image (${mime}, ${data.byteLength} bytes); this model does not take image input.`, { truncated: false });
    if (data.byteLength > IMAGE_MAX_BYTES) return result(`${path} is an image of ${data.byteLength} bytes, over the ${IMAGE_MAX_BYTES} byte limit.`, { truncated: false });
    return result(`Read image file [${mime}]`, { truncated: false }, [{ type: "image", data: Buffer.from(data).toString("base64"), mimeType: mime }]);
  }
  if (data.subarray(0, 8192).includes(0)) {
    return result(`${path} is a binary file (${data.byteLength} bytes). Inspect it with bash (file, xxd, strings).`, { truncated: false });
  }
  const lines = Buffer.from(data).toString("utf8").split("\n");
  const total = lines.length;
  const start = Math.max(1, Math.floor(range.offset ?? 1));
  if (start > total) throw new Error(`Offset ${start} is beyond end of file (${total} lines total)`);
  const wanted = lines.slice(start - 1, range.limit === undefined ? undefined : start - 1 + Math.max(1, Math.floor(range.limit)));
  const numbered = caps.numbers ? wanted.map((line, index) => `${start + index}\t${line}`) : wanted;
  const head = capHead(numbered.join("\n"), maxLines, maxBytes);
  const end = start + head.keptLines - 1;
  let body = head.text;
  if (head.cutLine) {
    body += `\n\n[Line ${start} is over ${maxBytes / 1024}KB; shown cut. Read it with bash: sed -n '${start}p' ${path} | head -c ${maxBytes}]`;
  } else if (head.keptLines < wanted.length) {
    body += `\n\n[Showing lines ${start}-${end} of ${total}. Use offset=${end + 1} to continue.]`;
  } else if (range.limit !== undefined && end < total) {
    body += `\n\n[${total - end} more lines in file. Use offset=${end + 1} to continue.]`;
  }
  return result(body, { truncated: head.truncated });
}

const READ_MANY_MAX = 50;
type ReadEntry = { path: string; offset?: number; limit?: number };

const readTool: Builder = (config, { env, loadout, images }) => {
  const limits = limitsOf("read", config, {
    line_numbers: false,
    // R3: back-to-back read-only requests each re-send the whole context; N files in one call is one request and one env batch.
    many: false,
  });
  const maxLines = loadout.limits.output_cap_lines;
  const maxBytes = loadout.limits.output_cap_bytes;
  const caps = { lines: maxLines, bytes: maxBytes, numbers: limits.line_numbers, images };
  const description = "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. " +
    `For text files, output is truncated to ${maxLines} lines or ${maxBytes / 1024}KB (whichever is hit first). ` +
    "Use offset/limit for large files. When you need the full file, continue with offset until complete.";
  const path = Type.String({ description: "Path to the file to read (relative or absolute)" });
  const offset = Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" }));
  const limit = Type.Optional(Type.Number({ description: "Maximum number of lines to read" }));
  /** R3: every file of the call from one env batch (readFiles), each under a `==> path <==` header, the caps shared across them. */
  const readMany = async (entries: ReadEntry[]): Promise<Result> => {
    if (entries.length === 0) throw new Error("read: paths is empty");
    if (entries.length > READ_MANY_MAX) throw new Error(`read: at most ${READ_MANY_MAX} paths per call`);
    const unique = [...new Set(entries.map((entry) => entry.path))];
    const loaded = env.readFiles !== undefined ? await env.readFiles(unique) : await Promise.all(unique.map((item) => env.readFile(item).catch((error: Error) => error)));
    const byPath = new Map(unique.map((item, index) => [item, loaded[index]!]));
    const parts: string[] = [];
    const attachments: ImageContent[] = [];
    let bytesLeft = maxBytes;
    let linesLeft = maxLines;
    let truncated = false;
    for (const entry of entries) {
      const header = `==> ${entry.path} <==`;
      if (bytesLeft < 256 || linesLeft < 2) {
        parts.push(`${header}\n[Not shown: the call reached the ${maxBytes / 1024}KB output cap. Read it in another call.]`);
        truncated = true;
        continue;
      }
      const data = byPath.get(entry.path)!;
      let text: string;
      if (data instanceof Error) {
        const code = (data as { code?: unknown }).code;
        const info = code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR" ? undefined : await env.stat(entry.path).catch(() => undefined);
        text = code === "ENOENT" || code === "ENOTDIR" || (code !== "EISDIR" && info === undefined) ? `[File not found: ${entry.path}]`
          : code === "EISDIR" || info?.kind === "directory" ? `[${entry.path} is a directory. Use bash (ls) to list it.]` : `[${data.message}]`;
      } else {
        try {
          const view = fileView(entry.path, data, entry, { ...caps, lines: linesLeft, bytes: bytesLeft });
          text = view.content.map((part) => (part.type === "text" ? part.text : "")).join("");
          for (const part of view.content) if (part.type === "image") attachments.push(part);
          truncated ||= view.details.truncated;
        } catch (error) {
          text = `[${(error as Error).message}]`;
        }
      }
      parts.push(`${header}\n${text.replace(/\n$/u, "")}`);
      bytesLeft -= Buffer.byteLength(text, "utf8") + header.length + 2;
      linesLeft -= text.split("\n").length + 2;
    }
    return result(parts.join("\n\n"), { truncated }, attachments);
  };
  return define({
    name: "read",
    label: "read",
    description: config.description ?? (limits.many ? `${description} To read several files (or ranges) at once, pass paths instead of path.` : description),
    parameters: limits.many
      ? Type.Object({
        path: Type.Optional(path), offset, limit,
        paths: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Object({ path: Type.String(), offset, limit })]), {
          description: `Up to ${READ_MANY_MAX} files read in one call, each under a ==> path <== header: paths, or {path, offset, limit} for a range`,
        })),
      })
      : Type.Object({ path, offset, limit }),
    executionMode: "parallel",
    async execute(_id, params: { path?: string; offset?: number; limit?: number; paths?: (string | ReadEntry)[] }) {
      if (limits.many && params.paths !== undefined) {
        const entries = params.paths.map((entry) => (typeof entry === "string" ? { path: entry } : entry));
        if (params.path !== undefined) entries.unshift({ path: params.path, ...(params.offset === undefined ? {} : { offset: params.offset }), ...(params.limit === undefined ? {} : { limit: params.limit }) });
        return readMany(entries);
      }
      if (params.path === undefined) throw new Error("read: pass path (or paths)");
      const data = await readExisting(env, params.path);
      if (data === "missing") throw new Error(`File not found: ${params.path}`);
      if (data === "directory") throw new Error(`${params.path} is a directory. Use bash (ls) to list it.`);
      return fileView(params.path, data, params, caps);
    },
  });
};

const bashTool: Builder = (config, { env }, shared) => {
  const limits = limitsOf("bash", config, {
    default_yield_s: 120, max_yield_s: 600, hard_timeout_s: 3600,
    // Yield floor: a command still running at a short model-chosen timeout costs a wait request that re-reads the context; hold a shorter timeout to this (0: off).
    min_yield_s: 0,
  });
  return define({
    name: "bash",
    label: "bash",
    description: config.description ?? "Execute a bash command in the current working directory. Returns combined stdout and stderr. " +
      "Long output keeps its first and last lines; the full output is saved to a file. " +
      `If the command is still running after timeout seconds (default ${limits.default_yield_s}), it keeps running in the background ` +
      "and you get its output so far plus a handle for wait.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: `Seconds to wait before returning while the command keeps running (default ${limits.default_yield_s}, max ${limits.max_yield_s})` })),
    }),
    async execute(_id, params: { command: string; timeout?: number }, signal) {
      const yieldS = Math.min(limits.max_yield_s, Math.max(limits.min_yield_s, params.timeout !== undefined && params.timeout > 0 ? params.timeout : limits.default_yield_s));
      const run = await env.exec(params.command, {
        yieldMs: Math.round(yieldS * 1000), timeoutMs: limits.hard_timeout_s * 1000, ...(signal === undefined ? {} : { signal }),
      });
      const key = run.running ? run.handle! : "out";
      if (run.running) shared.commands.set(run.handle!, params.command);
      const shown = await shared.commandText(run, key, Math.round(yieldS), params.command);
      return result(shown.text, shown.details);
    },
  });
};

const waitTool: Builder = (config, { env }, shared) => {
  const limits = limitsOf("wait", config, {
    default_s: 120, max_s: 600,
    // R2: every poll re-sends the whole cached context for one bit of news; a wait that blocks until a condition costs no request while it waits.
    until: false,
    // Yield floor: a wait that returns while the command still runs buys another poll request; hold a shorter timeout (and until's bound) to this (0: off).
    min_s: 0,
  });
  const description = "Wait for a background command started by bash and return its new output. " +
    "Returns when the command exits or after timeout seconds, whichever is first. Pass kill: true to stop the command.";
  const handle = Type.String({ description: "Process handle from bash, e.g. p3" });
  const timeout = Type.Optional(Type.Number({ description: `Seconds to wait (default ${limits.default_s}, max ${limits.max_s})` }));
  const kill = Type.Optional(Type.Boolean({ description: "Stop the command instead of waiting" }));
  type Params = { handle?: string; timeout?: number; kill?: boolean; until?: string };
  /** R2: block until the condition holds (or the command ends, or 300 s), with no handle for port/file conditions. */
  const waitFor = async (params: Params & { until: string }, signal: AbortSignal | undefined) => {
    const condition = parseUntil(params.until);
    const maxMs = Math.min(UNTIL_MAX_MS, limits.max_s * 1000, params.timeout !== undefined && params.timeout > 0 ? Math.round(Math.max(params.timeout, limits.min_s) * 1000) : UNTIL_MAX_MS);
    if (params.handle === undefined) {
      const outcome = await waitUntil(env, condition, maxMs, undefined, signal);
      const line = untilLine(condition, outcome);
      return result(line, { truncated: false, repeatKey: withoutUntilTimes(line) });
    }
    const target = processTarget(env, params.handle);
    const outcome = await waitUntil(env, condition, maxMs, target, signal);
    const last = target.last ?? await env.poll(params.handle);
    const run: ExecResult = { ...last, output: target.output, truncated: target.truncated || last.truncated };
    const command = shared.commands.get(params.handle);
    if (!run.running) shared.commands.delete(params.handle);
    const shown = await shared.commandText(run, params.handle, Math.round(outcome.elapsedMs / 1000), command);
    const line = untilLine(condition, outcome);
    return result(`${line}\n${shown.text}`, {
      ...shown.details, repeatKey: `${withoutUntilTimes(line)}\n${shown.details.repeatKey ?? shown.text}`, ...(run.running ? { loopExempt: true } : {}),
    });
  };
  return define({
    name: "wait",
    label: "wait",
    description: config.description ?? (limits.until ? `${description} Pass until to block until a condition holds instead of polling.` : description),
    parameters: limits.until
      ? Type.Object({
        handle: Type.Optional(Type.String({ description: "Process handle from bash, e.g. p3 (not needed for until port:/file:)" })),
        timeout, kill, until: Type.Optional(Type.String({ description: UNTIL_DESCRIPTION })),
      })
      : Type.Object({ handle, timeout, kill }),
    async execute(_id, params: Params, signal) {
      if (limits.until && params.until !== undefined && params.kill !== true) return waitFor({ ...params, until: params.until }, signal);
      if (params.handle === undefined) throw new Error("wait: handle is required");
      const waitS = Math.min(limits.max_s, params.timeout !== undefined && params.timeout >= 0 ? Math.max(params.timeout, limits.min_s) : limits.default_s);
      const run = params.kill === true ? await env.kill(params.handle) : await env.wait(params.handle, Math.round(waitS * 1000), signal);
      const command = shared.commands.get(params.handle);
      if (!run.running) shared.commands.delete(params.handle);
      const shown = await shared.commandText(run, params.handle, Math.round(waitS), command);
      return result(shown.text, { ...shown.details, ...(run.running ? { loopExempt: true } : {}) });
    },
  });
};

const editTool: Builder = (config, { env }) => {
  const limits = limitsOf("edit", config, { fuzzy: true });
  return define({
    name: "edit",
    label: "edit",
    description: config.description ?? "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region " +
      "of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting " +
      "overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
      edits: Type.Array(Type.Object({
        oldText: Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." }),
        newText: Type.String({ description: "Replacement text for this targeted edit." }),
      }), { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. " +
        "Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead." }),
    }),
    executionMode: "sequential",
    // Older Pi and Claude-style shapes: a single oldText/newText or old_string/new_string at the top level.
    prepareArguments(args: unknown) {
      const raw = (args ?? {}) as Record<string, unknown>;
      if (Array.isArray(raw.edits)) return raw as { path: string; edits: TextEdit[] };
      const oldText = raw.oldText ?? raw.old_string;
      const newText = raw.newText ?? raw.new_string;
      if (typeof oldText === "string" && typeof newText === "string") return { path: String(raw.path ?? raw.file_path ?? ""), edits: [{ oldText, newText }] };
      return raw as { path: string; edits: TextEdit[] };
    },
    async execute(_id, params: { path: string; edits: TextEdit[] }) {
      const data = await readExisting(env, params.path);
      if (typeof data === "string") throw new Error(`File not found: ${params.path}`);
      const original = Buffer.from(data).toString("utf8");
      const applied = applyEdits(original, params.edits, params.path, { fuzzy: limits.fuzzy });
      await env.writeFile(params.path, applied.text);
      const note = applied.fuzzy > 0 ? ` (${applied.fuzzy} matched after whitespace/quote normalization)` : "";
      return result(`Successfully replaced ${applied.replaced} block(s) in ${params.path}.${note}`, { truncated: false, mutated: true });
    },
  });
};

const writeTool: Builder = (config, { env }) => {
  limitsOf("write", config, {});
  return define({
    name: "write",
    label: "write",
    description: config.description ?? "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    executionMode: "sequential",
    async execute(_id, params: { path: string; content: string }) {
      await env.writeFile(params.path, params.content);
      return result(`Successfully wrote ${Buffer.byteLength(params.content, "utf8")} bytes to ${params.path}`, { truncated: false, mutated: true });
    },
  });
};

/** The program tool (src/tools/program.ts): a JavaScript program calling the sandbox and the run's MCP tools as functions. */
const programToolBuilder: Builder = (config, { env, mcp, scripts, ask, nested }) => {
  const limits = limitsOf("program", config, { ...DEFAULT_PROGRAM_LIMITS });
  return programTool(env, mcp ?? [], limits, config.description, scripts, ask, nested);
};

export const COMPACT_BUILDERS: Readonly<Record<string, Builder>> = Object.freeze({
  read: readTool, bash: bashTool, wait: waitTool, edit: editTool, write: writeTool, program: programToolBuilder,
});

/**
 * The loadout's eager tools in a fixed order (name order), so the tool block is byte-stable; a "with_mcp" tool joins
 * only when the run has MCP tools (then the tool set is still fixed for the whole run).
 */
export function compactTools(context: ToolBuildContext): AnyTool[] {
  const shared = sharedState(context);
  const tools: AnyTool[] = [];
  for (const [name, config] of Object.entries(context.loadout.tools).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const build = COMPACT_BUILDERS[name];
    if (build === undefined) throw new LoadoutError(`surface compact has no tool "${name}"`);
    const tool = build(config, context, shared);
    if (config.exposure === "eager" || (config.exposure === "with_mcp" && (context.mcp?.length ?? 0) > 0)) tools.push(tool);
  }
  return tools;
}
