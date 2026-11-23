/**
 * The exec surface: the two model-visible tools Codex 0.166 gives GPT-6.x in
 * code_mode_only. `exec` is a freeform tool (raw JavaScript under Codex's lark
 * grammar) whose script calls nested tools on `tools.*`; `wait` resumes a cell
 * that was still running when it yielded.
 *
 * A cell yields at `yield_time_ms` (pragma, else the loadout default, Codex's
 * 30 s), or when the script calls `yield_control()`: the model gets
 * `Script running with cell ID N` and the output so far while the script
 * keeps running. `wait {cell_id}` returns only the new output, the completion,
 * or `Script terminated` after `terminate: true`. The climb branch ran every
 * cell to its end (r11 gap); here yields are real.
 *
 * Edit tracking: a cell whose nested apply_patch changed a file reports
 * `details.mutated`, so the policy resets its repeat counts as it does for
 * edit and write. A cell whose script failed, or whose nested command exited
 * non-zero or patch failed, reports `details.failed`: as for a bash call with
 * a non-zero exit, a new cell that fails is not progress.
 * `details.nested` counts nested calls by name for the trace.
 * `details.repeatKey` is the result without its run-to-run noise (wall times,
 * chunk ids, cell and session ids, spill paths), so the policy's loop
 * detection sees two identical failing runs as a repeat, as on compact.
 *
 * Process lifetimes: when a cell ends, pi-codemode cancels its pending calls,
 * and an exec_command still inside its yield window is killed (nested.ts).
 * `wait {terminate: true}` also stops the sessions the cell started and names
 * them in its output; a cell that ends any other way leaves its sessions
 * running for write_stdin. dispose() kills in-flight runs and every session.
 *
 * exec-v1 flags (all off by default; research/codemode/findings.md has the census behind each):
 * `describe: "v1"` (describe-v1.ts: truthful, shorter descriptions whose numbers come from these limits),
 * `error_hints` (a script error on its own line, with the fix for tools.wait, a syntax error's line and a missing
 * image), `cut_notice` (a cut result names the omitted output lines and the file with the whole output, nested
 * records included), and apply_patch's `nearest` (apply-patch.ts).
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";
import type { CodemodeOutputItem, CodemodeResult } from "@earendil-works/pi-codemode";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defDelta } from "../../interface-gate.ts";
import { LoadoutError } from "../../loadout.ts";
import { limitsOf, type AnyTool, type ToolBuildContext, type ToolDetails } from "../compact.ts";
import { CellSandbox, quickjsModule } from "./codemode.ts";
import { hookTools } from "../hooks.ts";
import type { ExecEnv, ExecResult } from "../../env/types.ts";
import { parseUntil, processTarget, UNTIL_DESCRIPTION, UNTIL_MAX_MS, untilLine, waitUntil, type WaitTarget } from "../wait-until.ts";
import { execToolDescription, WAIT_DESCRIPTION, WAIT_UNTIL_LINES, type NestedToolSpec } from "./describe.ts";
import { execToolDescriptionV1, nestedSpecsV1, waitDescriptionV1, waitFieldsV1, type V1Numbers } from "./describe-v1.ts";
import { cellResultText, cutNoticeRepeatKey, cutNoticeText, EXEC_LARK_GRAMMAR, execRepeatKey, formattedTruncateText, overBudget, parseExecSource, type CellStatus } from "./format.ts";
import {
  execCommandLimits, logTail, mcpNestedTools, NESTED_SPECS, NESTED_TOOL_NAMES, nestedTools, newLedger, shapeRun, writeStdinLimits,
  type CellLedger, type LedgerEntry, type NestedShared, type NestedToolName,
} from "./nested.ts";

export interface ExecDetails extends ToolDetails {
  cell_id?: number;
  nested?: Record<string, number>;
  /** Patches and commands since the last report, in order (the policy levers read it; never shown to the model). */
  log?: LedgerEntry[];
  /** The cell was still running at this report (it yielded, or a wait returned before it ended). */
  running?: true;
}

/**
 * Codex's timers on top of pi-codemode, which has none: `setTimeout` waits on
 * a host `__sleep` call, so a pending timeout does not keep the cell alive by
 * itself (pi-codemode cancels unawaited calls when the script ends), as in
 * Codex. On the first line, so script line numbers in errors stay right.
 */
const PRELUDE = "const { setTimeout, clearTimeout } = (() => { let next = 0; const live = new Set(); return { " +
  "setTimeout(callback, delayMs) { const id = ++next; live.add(id); __sleep(Math.max(0, Number(delayMs) || 0)).then(() => { " +
  "if (live.delete(id) && typeof callback === \"function\") callback(); }); return id; }, clearTimeout(id) { live.delete(id); } }; })(); " +
  "return await (async () => {";

/**
 * R3 exec.aliases: `sh` and `read` on the prelude's line (script line numbers stay right). `read` is a host
 * global over the env's batch read, so N files cost one round trip.
 */
const ALIASES = "const sh = async (cmd, opts) => { const r = await tools.exec_command(Object.assign({}, opts, { cmd })); " +
  "let out = String(r.output ?? \"\"); if (r.exit_code !== undefined && r.exit_code !== 0) out += (out === \"\" || out.endsWith(\"\\n\") ? \"\" : \"\\n\") + \"[exit \" + r.exit_code + \"]\"; " +
  "if (r.session_id !== undefined) out += (out === \"\" || out.endsWith(\"\\n\") ? \"\" : \"\\n\") + \"[still running: session_id \" + r.session_id + \"]\"; " +
  "text(out === \"\" || out.endsWith(\"\\n\") ? out : out + \"\\n\"); return r; }; " +
  "const read = async (path, opts) => { const r = await __read(Object.assign({}, opts, { path })); text(r.endsWith(\"\\n\") ? r : r + \"\\n\"); return r; }; ";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The `read` alias's host side: one file as text (lines `offset`.. `limit`), or several under `==> path <==` headers, from one batch. */
async function readForScript(env: ExecEnv, value: unknown): Promise<string> {
  const args = isRecord(value) ? value : {};
  const paths = typeof args.path === "string" ? [args.path] : Array.isArray(args.path) ? args.path.filter((item): item is string => typeof item === "string") : [];
  if (paths.length === 0) throw new Error("read: pass a path or an array of paths");
  if (paths.length > 50) throw new Error("read: at most 50 paths per call");
  const loaded = env.readFiles !== undefined ? await env.readFiles(paths) : await Promise.all(paths.map((path) => env.readFile(path).catch((error: Error) => error)));
  const offset = typeof args.offset === "number" && args.offset > 1 ? Math.floor(args.offset) : 1;
  const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;
  const texts = loaded.map((data, index) => {
    if (data instanceof Error) {
      const code = (data as { code?: unknown }).code;
      const why = code === "ENOENT" || code === "ENOTDIR" ? `no such file: ${paths[index]}` : code === "EISDIR" ? `${paths[index]} is a directory` : data.message;
      if (paths.length === 1) throw new Error(`read: ${why}`);
      return `[${why}]`;
    }
    if (data.subarray(0, 8192).includes(0)) return `[${paths[index]} is a binary file (${data.byteLength} bytes)]`;
    const text = Buffer.from(data).toString("utf8");
    if (offset === 1 && limit === undefined) return text;
    return text.split("\n").slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit).join("\n");
  });
  if (paths.length === 1) return texts[0]!;
  return texts.map((text, index) => `==> ${paths[index]} <==\n${text.endsWith("\n") ? text : `${text}\n`}`).join("\n");
}

class Cell {
  readonly started = performance.now();
  readonly items: CodemodeOutputItem[] = [];
  readonly abort = new AbortController();
  readonly ledger: CellLedger = newLedger();
  cursor = 0;
  result: CodemodeResult | undefined;
  terminated = false;
  done!: Promise<CodemodeResult>;
  private yieldRequested = false;
  private waiters = new Set<() => void>();

  readonly id: number;
  /** The cell's source as the model sent it (after the pragma line) and whether it had a pragma: error hints quote its lines. */
  readonly code: string;
  readonly pragma: boolean;

  constructor(id: number, code = "", pragma = false) {
    this.id = id;
    this.code = code;
    this.pragma = pragma;
  }

  /** yield_control(): the waiting call returns now; with none waiting, the next one does. */
  requestYield(): void {
    if (this.waiters.size === 0) this.yieldRequested = true;
    for (const wake of this.waiters) wake();
  }

  /** Until the script ends, `ms` pass, a yield is requested, or `signal` aborts; true when it was the `ms` that passed. */
  async settle(ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.result !== undefined) return false;
    if (this.yieldRequested) {
      this.yieldRequested = false;
      return false;
    }
    let wake!: () => void;
    let timedOut = false;
    const woken = new Promise<void>((resolve) => (wake = resolve));
    const timer = setTimeout(() => {
      timedOut = true;
      wake();
    }, ms);
    this.waiters.add(wake);
    signal?.addEventListener("abort", wake, { once: true });
    try {
      await Promise.race([this.done.then(() => undefined), woken]);
    } finally {
      clearTimeout(timer);
      this.waiters.delete(wake);
      signal?.removeEventListener("abort", wake);
    }
    return timedOut && this.result === undefined;
  }
}

/** With a yield floor on, how long a cell whose nested exec_command just returned gets to print the record before it reports. */
const FLOOR_GRACE_MS = 250;

/** A command as the terminate note names it: its first line, at most 60 characters. */
function commandLabel(cmd: string): string {
  const line = cmd.trim().split("\n")[0]!;
  return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

function errorText(result: CodemodeResult): string | undefined {
  if (result.ok) return undefined;
  const { error } = result;
  if (error.kind === "script") return error.stack ?? `${error.name ?? "Error"}: ${error.message}`;
  return error.message;
}

/**
 * exec.error_hints: a script error with what fixes it, where the census saw the same mistake recur: `tools.wait` (a
 * top-level tool called inside a cell) and a syntax error, which gets the line of the cell it points at.
 */
export function errorHint(error: string, code: string, pragma: boolean, until: boolean): string {
  if (/\btools\.wait\b[^\n]*does not exist/u.test(error)) {
    return "`wait` is a separate tool, not on `tools`: end this cell, then call wait with " +
      (until ? "`{session_id, until: \"exit\"}` for a running command or `{cell_id}` for a running cell." : "`{cell_id}` for a running cell; poll a running command here with `tools.write_stdin({session_id, yield_time_ms})`.");
  }
  const at = /^SyntaxError\b[^\n]*\n\s*at codemode\.js:(\d+):(\d+)/u.exec(error);
  if (at !== undefined && at !== null) {
    // Source line 1 is the prelude plus the cell's first line; with a pragma the cell starts on line 2, as in the input.
    const lines = code.split("\n");
    const line = Number(at[1]) - (pragma ? 2 : 1);
    if (line >= 0 && line < lines.length) {
      const shown = lines[line]!.length > 200 ? `${lines[line]!.slice(0, 200)}...` : lines[line]!;
      return `Cell line ${line + (pragma ? 2 : 1)}: ${shown}`;
    }
  }
  return "";
}

/** The exec surface's tools (`exec`, `wait`) and a dispose that stops every live cell. */
export function execSurface(context: ToolBuildContext): { tools: AnyTool[]; dispose(): Promise<void> } {
  const { env, loadout, images } = context;
  const configs = loadout.tools;
  for (const name of Object.keys(configs)) {
    if (name !== "exec" && name !== "wait" && !(NESTED_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new LoadoutError(`surface exec has no tool "${name}" (exec, wait, ${NESTED_TOOL_NAMES.join(", ")})`);
    }
  }
  const execConfig = configs.exec;
  if (execConfig === undefined || execConfig.exposure === "off") throw new LoadoutError("surface exec needs tools.exec");
  const limits = limitsOf("exec", execConfig, {
    default_yield_ms: 30_000, max_output_tokens: 10_000, max_output_tokens_cap: 60_000, cell_timeout_s: 3600, max_cells: 16, mcp_types: true,
    // R3: `text(await tools.exec_command({cmd: ...}))` is 25-35 output tokens of pure syntax per cell; sh()/read() say it in a few.
    aliases: false,
    // Yield floor: a cell that yields before its work ends buys a wait request that re-reads the context; hold a pragma's shorter yield to this (0: off).
    min_yield_ms: 0,
    // exec.batch: one request per search, read or session check (0 of 1,855 b5 cells awaited two calls together, Codex 1.77
    // an attempt); the description carries Codex's own batching rules and its Promise.allSettled cell. Placebo: equal-length neutral text.
    batch: false,
    batch_placebo: false,
    // exec-v1 (research/codemode/findings.md): "v1" rewrites the exec, nested and wait descriptions (describe-v1.ts).
    describe: "v0",
    // A script error on its own line, with the fix for the mistakes the census saw recur (tools.wait, syntax errors, a missing image).
    error_hints: false,
    // A cut result names the output lines it dropped and the file with the whole output; nested records cut to their own budget are saved too.
    cut_notice: false,
  });
  if (limits.batch_placebo && !limits.batch) throw new LoadoutError("tools.exec.limits.batch_placebo needs tools.exec.limits.batch to replace");
  if (limits.describe !== "v0" && limits.describe !== "v1") throw new LoadoutError(`tools.exec.limits.describe: want "v0" or "v1", got ${JSON.stringify(limits.describe)}`);
  const waitLimits = configs.wait === undefined ? undefined : limitsOf("wait", configs.wait, {
    default_yield_ms: 10_000, max_yield_ms: 300_000, default_max_tokens: 10_000,
    // R2: each poll of a running cell or session is a model request re-reading the context; until blocks in the harness instead.
    until: false,
    // Yield floor: a wait that returns while the job still runs buys another poll request; hold a shorter yield_time_ms (and until's bound) to this (0: off).
    min_yield_ms: 0,
  });
  const nestedConfigs: Partial<Record<NestedToolName, (typeof configs)[string]>> = {};
  for (const name of NESTED_TOOL_NAMES) if (configs[name] !== undefined) nestedConfigs[name] = configs[name];
  const tokens = loadout.limits.token_estimate ?? "bytes4";
  const shared: NestedShared = {
    env, sessions: new Map(), nextSession: 1000, chunks: 0, inflight: new Map(), ...(tokens === "bytes4" ? {} : { tokens }),
    ...(limits.cut_notice ? { cutNotice: true } : {}), ...(limits.error_hints ? { hints: true } : {}),
    ...(loadout.policy.interface_gate === undefined ? {} : { defs: defDelta }),
  };
  let logs = 0;
  let outs = 0;
  if (limits.cut_notice && loadout.limits.spill) {
    shared.spillRecord = async (text) => {
      try {
        const path = `${await env.scratchDir()}/out-${++outs}.log`;
        await env.writeFile(path, text);
        return path;
      } catch {
        return undefined;
      }
    };
  }
  if (loadout.results !== undefined && loadout.limits.spill) {
    shared.shaping = {
      config: loadout.results,
      async spill(text) {
        try {
          const path = `${await env.scratchDir()}/cmd-${++logs}.log`;
          await env.writeFile(path, text);
          return path;
        } catch {
          return undefined;
        }
      },
    };
  }
  // Compile QuickJS now (~0.6 s once per process), while the first model request is in flight.
  void quickjsModule().catch(() => undefined);
  const cells = new Map<number, Cell>();
  const store: Record<string, unknown> = {};
  let nextCell = 1;
  let spills = 0;
  const v1 = limits.describe === "v1";
  const until = Boolean(waitLimits?.until);
  const numbers: V1Numbers | undefined = v1 ? (() => {
    const cmd = execCommandLimits(nestedConfigs.exec_command ?? { exposure: "eager", limits: {} });
    const poll = writeStdinLimits(nestedConfigs.write_stdin ?? { exposure: "eager", limits: {} });
    return {
      cellYieldMs: limits.default_yield_ms, cellTokens: limits.max_output_tokens,
      cmdYield: { min: cmd.min_yield_ms, max: cmd.max_yield_ms, default: Math.min(Math.max(cmd.default_yield_ms, cmd.min_yield_ms), cmd.max_yield_ms) },
      poll: { min: poll.min_poll_ms, max: poll.max_poll_ms },
      until, wait: waitLimits !== undefined && configs.wait!.exposure !== "off",
    };
  })() : undefined;
  const nestedSpecs: Readonly<Record<NestedToolName, NestedToolSpec>> = numbers === undefined ? NESTED_SPECS : nestedSpecsV1(numbers);
  // Fail closed at load: every nested tool's limits are checked now, not at the first cell.
  nestedTools(shared, nestedConfigs, newLedger(), nestedSpecs);
  const specs = NESTED_TOOL_NAMES.filter((name) => nestedConfigs[name] !== undefined && nestedConfigs[name]!.exposure !== "off")
    .map((name) => ({ ...nestedSpecs[name], description: nestedConfigs[name]!.description ?? nestedSpecs[name].description }));

  const mcpByName = new Map((context.mcp ?? []).map((handle) => [`mcp__${handle.qualified}`, { server: handle.server, tool: handle.name }]));
  const start = (code: string, pragma: boolean, callId: string): Cell => {
    const live = [...cells.values()].filter((cell) => cell.result === undefined).length;
    if (live >= limits.max_cells) throw new Error(`exec: ${live} cells are still running; wait on one with terminate: true first`);
    const cell = new Cell(nextCell++, code, pragma);
    const sandbox = new CellSandbox({
      timeoutMs: limits.cell_timeout_s * 1000,
      tools: hookTools([...nestedTools(shared, nestedConfigs, cell.ledger, nestedSpecs), ...mcpNestedTools(context.mcp ?? [], cell.ledger)],
        context.nested, callId, (name) => mcpByName.get(name)),
      globals: [
        { name: "notify", execute: (value) => { cell.items.push({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) ?? String(value) }); return null; } },
        { name: "yield_control", execute: () => { cell.requestYield(); return null; } },
        ...(limits.aliases ? [{ name: "__read", execute: (value: unknown) => readForScript(env, value) }] : []),
        { name: "__sleep", execute: (ms, { signal }) => new Promise<null>((resolve) => {
          const timer = setTimeout(() => resolve(null), typeof ms === "number" && ms > 0 ? Math.min(ms, 3_600_000) : 0);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(null); }, { once: true });
        }) },
      ],
    }, (item) => cell.items.push(item));
    const prelude = limits.aliases ? PRELUDE.replace("return await (async () => {", `${ALIASES}return await (async () => {`) : PRELUDE;
    const source = `${prelude}${pragma ? "\n" : ""}${code}\n})();`;
    cell.done = sandbox.execute(source, { store: { ...store }, signal: cell.abort.signal }).then((result) => {
      if (result.ok) {
        for (const key of result.storeWrites.delete) delete store[key];
        Object.assign(store, result.storeWrites.set);
      }
      cell.result = result;
      return result;
    });
    cells.set(cell.id, cell);
    return cell;
  };

  /**
   * After a terminate: wait for the cell's cancelled exec_command runs to be killed, then stop the
   * sessions it started that are still running, and name them in the cell's output.
   */
  const stopCellProcesses = async (cell: Cell) => {
    await Promise.allSettled([...cell.ledger.inflight]);
    const stopped: string[] = [];
    for (const id of cell.ledger.sessions) {
      const session = shared.sessions.get(id);
      if (session === undefined) continue;
      shared.sessions.delete(id);
      const run = await env.kill(session.handle).catch(() => undefined);
      if (run !== undefined && (run.killed === true || run.running)) stopped.push(`${id} (\`${commandLabel(session.cmd)}\`)`);
    }
    cell.ledger.sessions.clear();
    if (stopped.length === 0) return;
    const last = cell.items.length > cell.cursor ? cell.items.at(-1) : undefined;
    const lead = last?.type === "text" && !last.text.endsWith("\n") ? "\n" : "";
    cell.items.push({ type: "text", text: `${lead}Stopped exec_command session${stopped.length === 1 ? "" : "s"} this cell started: ${stopped.join(", ")}\n` });
  };

  /** The model-facing result for everything the cell wrote since the last report. */
  const report = async (cell: Cell, wallMs: number, maxTokens: number, isWait: boolean, note?: string) => {
    const status: CellStatus = cell.result === undefined ? { running: cell.id } : cell.terminated ? "terminated" : cell.result.ok ? "completed" : "failed";
    const fresh = cell.items.slice(cell.cursor);
    cell.cursor = cell.items.length;
    const texts: string[] = note === undefined ? [] : [`${note}\n`];
    const attachments: ImageContent[] = [];
    for (const item of fresh) {
      if (item.type === "text") texts.push(item.text);
      else if (images) attachments.push({ type: "image", data: item.data, mimeType: item.mimeType });
      else texts.push(`[image ${item.mimeType} omitted: this model takes no image input]`);
    }
    const failure = cell.result === undefined || cell.terminated ? undefined : errorText(cell.result);
    if (failure !== undefined && limits.error_hints) {
      // On its own line: 102 of 162 failed cells in the census had it glued to the end of the last record.
      const last = texts.at(-1);
      if (last !== undefined && last !== "" && !last.endsWith("\n")) texts.push("\n");
      const hint = errorHint(failure, cell.code, cell.pragma, until);
      // pi-codemode's unknown-tool error offers a searchTools() this surface does not have.
      texts.push(`Script error:\n${failure.replace(" searchTools(query) finds tools by topic.", "")}${hint === "" ? "" : `\n${hint}`}`);
    } else if (failure !== undefined) {
      texts.push(`Script error:\n${failure}`);
    }
    let { text, truncated } = cellResultText(status, wallMs / 1000, texts, maxTokens, undefined, tokens, limits.cut_notice);
    let spill: string | undefined;
    if (truncated && loadout.limits.spill) {
      try {
        spill = `${await env.scratchDir()}/exec-${cell.id}-${++spills}.log`;
        await env.writeFile(spill, texts.join("\n"));
        text = cellResultText(status, wallMs / 1000, texts, maxTokens, spill, tokens, limits.cut_notice).text;
      } catch {
        spill = undefined;
      }
    }
    const details: ExecDetails = {
      truncated, cell_id: cell.id, nested: { ...cell.ledger.calls }, repeatKey: cutNoticeRepeatKey(execRepeatKey(text, attachments.length)),
      ...(spill === undefined ? {} : { spill }),
      ...(cell.ledger.mutated ? { mutated: true } : {}),
      ...(cell.ledger.failed || status === "failed" ? { failed: true } : {}),
      ...(isWait && cell.result === undefined ? { loopExempt: true } : {}),
      ...(cell.result === undefined ? { running: true as const } : {}),
      ...(cell.ledger.log.length === 0 ? {} : { log: cell.ledger.log }),
      ...(cell.ledger.shaped.length === 0 ? {} : { shaped: cell.ledger.shaped.join(",") }),
    };
    cell.ledger.mutated = false;
    cell.ledger.failed = false;
    cell.ledger.calls = {};
    cell.ledger.log = [];
    cell.ledger.shaped = [];
    if (cell.result !== undefined) cells.delete(cell.id);
    return { content: [{ type: "text", text } as TextContent, ...attachments], details };
  };

  /**
   * Yield floor on (`min_yield_ms` > 0 on exec or wait): when the cell's yield time passes while a nested exec_command is
   * still inside its own held window, let that call return (at its exit or its own floor, at most its max_yield_ms) and the
   * script print it, so a floored cell never reports an empty "running" result a moment before the record lands (one more
   * wait request). Off: exactly `settle`. A yield_control() or the end of the script returns at once either way.
   */
  const floorOn = limits.min_yield_ms > 0 || (waitLimits?.min_yield_ms ?? 0) > 0;
  const settleFloored = async (cell: Cell, ms: number, signal?: AbortSignal) => {
    const timedOut = await cell.settle(ms, signal);
    if (!timedOut || !floorOn || cell.ledger.inflight.size === 0 || signal?.aborted === true) return;
    await Promise.race([Promise.allSettled([...cell.ledger.inflight]), cell.done]);
    await cell.settle(FLOOR_GRACE_MS, signal);
  };

  const exec: AgentTool<TSchema, ExecDetails> = {
    name: "exec",
    label: "exec",
    description: execConfig.description ?? (numbers === undefined
      ? execToolDescription(specs, limits.mcp_types, limits.aliases, !limits.batch ? "off" : limits.batch_placebo ? "placebo" : "on")
      : execToolDescriptionV1(specs, numbers, limits.aliases, !limits.batch ? "off" : limits.batch_placebo ? "placebo" : "on", limits.mcp_types)),
    parameters: Type.Object({ input: Type.String() }),
    constrainedSampling: { type: "grammar", variants: { openai_lark: EXEC_LARK_GRAMMAR } },
    executionMode: "sequential",
    // A model without grammar tools sends JSON: accept {input}, {code}, {source} or a bare string.
    prepareArguments(args: unknown) {
      if (typeof args === "string") return { input: args };
      const raw = (args ?? {}) as Record<string, unknown>;
      const input = raw.input ?? raw.code ?? raw.source ?? raw.script;
      return { input: typeof input === "string" ? input : "" };
    },
    async execute(id, raw, signal) {
      const params = raw as { input: string };
      const parsed = parseExecSource(params.input);
      const began = performance.now();
      const cell = start(parsed.code, params.input.trimStart().startsWith("// @exec:"), id);
      const onAbort = () => cell.abort.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      void cell.done.finally(() => signal?.removeEventListener("abort", onAbort));
      await settleFloored(cell, Math.max(parsed.yieldTimeMs ?? limits.default_yield_ms, limits.min_yield_ms), signal);
      const budget = Math.min(parsed.maxOutputTokens ?? limits.max_output_tokens, limits.max_output_tokens_cap);
      return report(cell, performance.now() - began, budget, false);
    },
  };

  const tools: AnyTool[] = [exec as AnyTool];
  if (waitLimits !== undefined && configs.wait!.exposure !== "off") {
    const fieldsV1 = v1 ? waitFieldsV1({ yieldMs: waitLimits.default_yield_ms, maxTokens: waitLimits.default_max_tokens }) : undefined;
    const waitFields = {
      max_tokens: Type.Optional(Type.Number({ description: fieldsV1?.max_tokens ?? "Output token budget for this wait call. Defaults to 10000 tokens." })),
      terminate: Type.Optional(Type.Boolean({ description: fieldsV1?.terminate ?? "True stops the running exec cell; false or omitted waits for output." })),
      yield_time_ms: Type.Optional(Type.Number({ description: fieldsV1?.yield_time_ms ?? "Wait before yielding more output. Defaults to 10000 ms." })),
    };
    /** R2: an exec cell as a wait target; its new text items, without moving the cursor the report reads from. */
    const cellTarget = (cell: Cell): WaitTarget => {
      let seen = cell.cursor;
      return {
        async step(ms, signal) {
          await cell.settle(ms, signal);
          const fresh = cell.items.slice(seen).map((item) => (item.type === "text" ? item.text : "")).join("");
          seen = cell.items.length;
          return { text: fresh, ended: cell.result !== undefined };
        },
      };
    };
    /**
     * R2: an exec_command session as a wait target: its status, the condition's outcome and its new output (shaped
     * once it finished). Like a write_stdin poll, it logs a poll of the session with the raw output's tail, so the
     * policy levers see a check that yielded and then finished here (P1's last check, P2's first green, D2's red).
     */
    const waitSession = async (id: number, spec: string, maxMs: number, budget: number, signal: AbortSignal | undefined) => {
      const entry = shared.sessions.get(id);
      if (entry === undefined) throw new Error(`exec_command session ${id} not found`);
      const condition = parseUntil(spec);
      const target = processTarget(env, entry.handle);
      const outcome = await waitUntil(env, condition, maxMs, target, signal);
      const last = target.last ?? await env.poll(entry.handle);
      const raw: ExecResult = { ...last, output: target.output, truncated: target.truncated || last.truncated };
      const ledger = newLedger();
      let run = raw;
      if (!run.running) {
        shared.sessions.delete(id);
        run = await shapeRun(shared, entry.cmd, run, ledger);
      }
      const exitCode = run.exitCode ?? (run.timedOut === true ? 124 : run.killed === true ? 137 : -1);
      const status = run.running ? `Session ${id} still running` : `Session ${id} exited with code ${exitCode}`;
      const wall = (Math.round(outcome.elapsedMs / 100) / 10).toFixed(1);
      let shown: string;
      if (limits.cut_notice) {
        const spill = overBudget(run.output, budget, tokens) && shared.spillRecord !== undefined ? await shared.spillRecord(run.output) : undefined;
        shown = cutNoticeText(run.output, budget, spill, tokens);
      } else {
        shown = formattedTruncateText(run.output, budget, undefined, tokens);
      }
      const text = `${status}\n${untilLine(condition, outcome)}\nWall time ${wall} seconds\nOutput:\n${shown}`;
      const poll: LedgerEntry = { kind: "poll", session: id, output: logTail(raw.output), ...(run.running ? {} : { exitCode }) };
      const details: ExecDetails = {
        truncated: overBudget(run.output, budget, tokens) || run.truncated, repeatKey: cutNoticeRepeatKey(execRepeatKey(text)), log: [poll],
        ...(run.running ? { loopExempt: true } : {}), ...(!run.running && exitCode !== 0 ? { failed: true } : {}),
        ...(ledger.shaped.length === 0 ? {} : { shaped: ledger.shaped.join(",") }),
      };
      return { content: [{ type: "text", text } as TextContent], details };
    };
    const wait: AgentTool<TSchema, ExecDetails> = {
      name: "wait",
      label: "wait",
      description: configs.wait!.description ?? (v1
        ? waitDescriptionV1(until, WAIT_UNTIL_LINES, { yieldMs: waitLimits.default_yield_ms, maxTokens: waitLimits.default_max_tokens })
        : until ? `${WAIT_DESCRIPTION}\n${WAIT_UNTIL_LINES}` : WAIT_DESCRIPTION),
      parameters: until
        ? Type.Object({
          cell_id: Type.Optional(Type.String({ description: fieldsV1?.cell_id ?? "Identifier of the running exec cell." })),
          ...waitFields,
          session_id: Type.Optional(Type.Number({ description: fieldsV1?.session_id ?? "A running exec_command session to wait on instead of a cell (with until)." })),
          until: Type.Optional(Type.String({ description: UNTIL_DESCRIPTION })),
        }, { additionalProperties: false })
        : Type.Object({ cell_id: Type.String({ description: fieldsV1?.cell_id ?? "Identifier of the running exec cell." }), ...waitFields }, { additionalProperties: false }),
      prepareArguments(args: unknown) {
        const raw = { ...((args ?? {}) as Record<string, unknown>) };
        if (typeof raw.cell_id === "number") raw.cell_id = String(raw.cell_id);
        if (until && typeof raw.session_id === "string" && /^\d+$/u.test(raw.session_id)) raw.session_id = Number(raw.session_id);
        return raw as { cell_id: string };
      },
      async execute(_id, raw, signal) {
        const params = raw as { cell_id?: string; max_tokens?: number; terminate?: boolean; yield_time_ms?: number; session_id?: number; until?: string };
        const budget = Math.min(Math.max(0, params.max_tokens ?? waitLimits.default_max_tokens), limits.max_output_tokens_cap);
        // until still returns when its condition holds; the floor only lifts a bound the model set shorter.
        const untilMs = Math.min(UNTIL_MAX_MS, waitLimits.max_yield_ms, params.yield_time_ms !== undefined && params.yield_time_ms > 0 ? Math.max(params.yield_time_ms, waitLimits.min_yield_ms) : UNTIL_MAX_MS);
        if (until && params.until !== undefined && params.terminate !== true && params.cell_id === undefined) {
          if (params.session_id === undefined) throw new Error("wait: pass cell_id or session_id");
          return waitSession(params.session_id, params.until, untilMs, budget, signal);
        }
        if (params.cell_id === undefined) throw new Error("wait: cell_id is required");
        const cell = cells.get(Number(params.cell_id));
        if (cell === undefined) throw new Error(`exec cell ${params.cell_id} not found`);
        const began = performance.now();
        if (until && params.until !== undefined && params.terminate !== true) {
          const condition = parseUntil(params.until);
          const outcome = await waitUntil(env, condition, untilMs, cellTarget(cell), signal);
          return report(cell, performance.now() - began, budget, true, untilLine(condition, outcome));
        }
        if (params.terminate === true && cell.result === undefined) {
          cell.terminated = true;
          cell.abort.abort();
          await cell.done;
          await stopCellProcesses(cell);
        } else {
          const ms = Math.min(Math.max(waitLimits.min_yield_ms, params.yield_time_ms ?? waitLimits.default_yield_ms), waitLimits.max_yield_ms);
          await settleFloored(cell, ms, signal);
        }
        return report(cell, performance.now() - began, budget, true);
      },
    };
    tools.push(wait as AnyTool);
  }

  return {
    tools,
    async dispose() {
      for (const cell of cells.values()) cell.abort.abort();
      await Promise.allSettled([...cells.values()].map((cell) => cell.done));
      cells.clear();
      // Commands still inside their yield window: cancelled ones are killed by their call (nested.ts).
      for (const cancel of shared.inflight.keys()) cancel.abort();
      await Promise.allSettled([...shared.inflight.values()]);
      await Promise.allSettled([...shared.sessions.values()].map((session) => env.kill(session.handle)));
      shared.sessions.clear();
    },
  };
}
