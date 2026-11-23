/**
 * The program tool (compact surface; ARCHITECTURE.md 3.4): the model writes one JavaScript program that calls the
 * sandbox and the run's MCP tools as async functions, in the QuickJS isolate the exec surface uses (codemode.ts).
 * Only what the program prints, and its return value, reach the model; raw tool results stay in the program.
 *
 * Inside a program:
 * - `await bash({command, timeout_s})` -> `{output, exit_code}` (runs in the task sandbox until exit or timeout_s);
 * - `await read({path, offset, limit})` -> the text (lines offset.. offset+limit-1 when given);
 * - `await write({path, content})` -> `{bytes}`; `await edit({path, old_string, new_string})` -> `{replaced}`;
 * - `await tools.<server>__<tool>(args)` for each MCP tool (loadout.mcp.exposure "program"): the result parsed as JSON
 *   when it is JSON, else the text; an MCP error throws. `ALL_TOOLS` lists them with descriptions; `describe(name)`
 *   returns a tool's input schema;
 * - `print(...values)` adds output (objects as JSON).
 *
 * Budgets instead of small caps (the product's caveman_code stops at 8 calls a cell, which makes bulk work impossible):
 * at most `max_calls` tool calls a program, at most `concurrency` running at once (more wait their turn), and
 * `timeout_s` of wall time; a program that runs out reports the output so far and why it stopped. Printed output past
 * `max_output_bytes` keeps its head and tail, and the whole output goes to a file named in the result. Every result
 * ends with one status line: tool calls made and wall time.
 */
import { Type } from "typebox";
import type { CodemodeJsonSchema, CodemodeOutputItem, CodemodeTool } from "@earendil-works/pi-codemode";
import type { ExecEnv } from "../env/types.ts";
import type { McpToolHandle } from "../mcp.ts";
import { scriptProblem, type SavedScript, type ScriptStore } from "../scripts.ts";
import { applyEdits } from "./edit-apply.ts";
import { CellSandbox, quickjsModule } from "./exec/codemode.ts";
import type { AnyTool, ToolDetails } from "./compact.ts";
import { hookTools, type NestedHooks } from "./hooks.ts";

export interface ProgramLimits {
  timeout_s: number;
  max_calls: number;
  concurrency: number;
  max_output_bytes: number;
  bash_timeout_s: number;
  /** Saved scripts (src/scripts.ts): list them, save_script and run_script. Needs a store (--scripts-dir). */
  scripts: boolean;
  /** Fan-out: ask(prompt) makes one call to the run's own model and effort with nothing but the prompt (run.ts programAskOf). */
  ask: boolean;
  /** The output cap of one ask call (its reasoning included). */
  ask_max_tokens: number;
  /**
   * Whether the run has a sandbox for programs to touch: bash, read, write and edit exist only when it does. Off where
   * the env is the host itself (a pooled agent with no computer): a program then calls its tools and prints, and long
   * output is cut without a spill file.
   */
  sandbox: boolean;
}

/** One side call of the program's ask(): the model's text answer (run.ts gives the run's model at the run's effort). */
export type ProgramAsk = (prompt: string, options: { json: boolean; maxTokens: number; signal: AbortSignal }) => Promise<string>;

/** The system prompt of an ask() call: one question, answered from the prompt alone. */
export const ASK_SYSTEM = (json: boolean) => [
  "You answer one question from the text you are given, and nothing else: no tools, no follow-up questions.",
  "Read all of it carefully; the answer feeds a program, so be exact and brief.",
  json ? "Reply with one JSON value only, no prose and no code fence." : "Reply with the answer only.",
].join(" ");

export const DEFAULT_PROGRAM_LIMITS: Readonly<ProgramLimits> = Object.freeze({
  timeout_s: 300, max_calls: 2000, concurrency: 16, max_output_bytes: 30_000, bash_timeout_s: 120, scripts: false,
  ask: false, ask_max_tokens: 8_000, sandbox: true,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A counting semaphore: at most `limit` holders; the rest wait in order. */
class Gate {
  #free: number;
  readonly #queue: (() => void)[] = [];
  constructor(limit: number) {
    this.#free = limit;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.#queue.shift();
      if (next !== undefined) next();
      else this.#free++;
    }
  }
}

const show = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 1) ?? String(value));

function parsed(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "" || !"[{\"0123456789-tfn".includes(trimmed[0]!)) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

const typeOf = (schema: unknown, depth = 0): string => {
  if (!isRecord(schema)) return "any";
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= 6) return schema.enum.map((value) => JSON.stringify(value)).join("|");
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "array") return `${typeOf(schema.items, depth + 1)}[]`;
  if (type === "object" && depth < 1 && isRecord(schema.properties)) return `{${fields(schema, depth + 1)}}`;
  return typeof type === "string" ? type : "any";
};

const fields = (schema: Record<string, unknown>, depth: number): string => {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(isRecord(schema.properties) ? schema.properties : {})
    .map(([name, property]) => `${name}${required.has(name) ? "" : "?"}: ${typeOf(property, depth)}`).join(", ");
};

const firstSentence = (text: string): string => {
  const line = text.trim().split("\n")[0] ?? "";
  const end = line.search(/\.(\s|$)/u);
  const sentence = end === -1 ? line : line.slice(0, end + 1);
  return sentence.length > 110 ? `${sentence.slice(0, 107)}...` : sentence;
};

/** One line a tool: `name({arg: type, optional?: type}): first sentence of its description`. */
export const programSignature = (tool: McpToolHandle): string =>
  `${tool.qualified}({${fields(tool.inputSchema, 0)}})${tool.description.trim() === "" ? "" : `: ${firstSentence(tool.description)}`}`;

/** Signatures past this many characters in all are listed by name only (describe() still returns each schema). */
const SIGNATURE_BUDGET = 8_000;

/**
 * The tool's description: what a program can call. Connector tools are listed one signature a line (arguments, their
 * types, and the first sentence of the tool's description), so a program can be written without a describe() round
 * trip; a server whose signatures would pass SIGNATURE_BUDGET is listed by name only.
 */
export function programDescription(mcp: readonly McpToolHandle[], limits: ProgramLimits, saved?: readonly SavedScript[]): string {
  const lines = [
    "Run a JavaScript program (async; top-level await) that calls tools as functions. Use it when a step needs several",
    "tool calls: independent calls in Promise.all, loops over items, filtering or counting results before you see them.",
    "Only what the program prints reaches you; raw tool results stay in the program. Use direct tools for single steps.",
    ...(limits.sandbox ? [
      "Functions: bash({command, timeout_s}) -> {output, exit_code}; read({path, offset, limit}) -> text;",
      "write({path, content}) -> {bytes}; edit({path, old_string, new_string}) -> {replaced}; print(...values).",
    ] : ["Functions: print(...values). There is no shell and no filesystem: a program reaches the world only through its tools."]),
  ];
  if (mcp.length > 0) {
    const signatures = mcp.map(programSignature);
    const listed = signatures.join("\n").length <= SIGNATURE_BUDGET;
    lines.push(
      "Connector tools: await tools.<name>(args) returns the result parsed as JSON (an MCP error throws); describe(name) returns",
      `a tool's full description and input schema.${listed ? "" : ` Names: ${mcp.map((tool) => tool.qualified).join(", ")}.`}`,
      ...(listed ? signatures : []),
    );
  }
  if (limits.ask) {
    lines.push(
      "ask(prompt, {json}) -> one call to the same model with nothing but the prompt (parsed JSON with json: true). For",
      "many long items to judge or extract from, map ask over them (Promise.all) so their text never enters this conversation;",
      "put everything the answer needs in the prompt, and print only the results.",
    );
  }
  if (saved !== undefined) {
    lines.push(
      "Saved scripts: run_script(name, params) runs one and returns what its code returns. When the user says a task recurs,",
      "save the program that did it: save_script({name, description, params: {name: meaning}, code}), where code is the",
      "body of an async function of `params` that uses these same functions; it checks its own results and prints a summary.",
      ...(saved.length === 0 ? ["(none saved yet)"] : saved.map((script) =>
        `${script.name}({${Object.keys(script.params).join(", ")}}): ${firstSentence(script.description)}${Object.keys(script.params).length === 0 ? "" : ` Params: ${Object.entries(script.params).map(([name, meaning]) => `${name}: ${meaning}`).join("; ")}.`}`)),
    );
  }
  lines.push(`Limits: ${limits.max_calls} tool calls, ${limits.concurrency} at once, ${limits.timeout_s} s per program; long printed output is cut to its head and tail.`);
  return lines.join("\n");
}

/** A function body that does not compile, as the isolate reports it; undefined when it compiles. */
async function compileError(code: string): Promise<string | undefined> {
  const sandbox = new CellSandbox({ timeoutMs: 5_000, tools: [], globals: [] }, () => undefined);
  const result = await sandbox.execute(`return typeof (async (params) => {\n${code}\n});`, { store: {} });
  return result.ok ? undefined : result.error.message;
}

/** Saved scripts as functions in scope of every program: `run_script(name, params)`. */
function scriptPrelude(saved: readonly SavedScript[]): string {
  const entries = saved.map((script) => `${JSON.stringify(script.name)}: async (params) => {\n${script.code}\n}`);
  return `const __saved_scripts = {${entries.join(",\n")}};
const run_script = async (name, params = {}) => {
  const script = __saved_scripts[name];
  if (script === undefined) throw new Error(\`run_script: no saved script \${JSON.stringify(name)}; saved: \${Object.keys(__saved_scripts).join(", ") || "none"}\`);
  return await script(params ?? {});
};
`;
}

/** One tool call of a program and how far it got. */
interface CallState {
  name: string;
  state: "queued" | "running" | "done" | "failed";
}

/**
 * The calls of a program that failed or stopped, by tool: how many finished, failed, and started without finishing.
 * Empty when it made none. A call that did not finish may still have changed something, so it is named, not dropped.
 */
export function callLedger(log: readonly CallState[]): string {
  if (log.length === 0) return "";
  const by = new Map<string, { done: number; failed: number; unfinished: number }>();
  for (const call of log) {
    const row = by.get(call.name) ?? { done: 0, failed: 0, unfinished: 0 };
    if (call.state === "done") row.done++;
    else if (call.state === "failed") row.failed++;
    else row.unfinished++;
    by.set(call.name, row);
  }
  const lines = [...by].map(([name, row]) => `- ${name}: ${[
    row.done > 0 ? `${row.done} finished` : "", row.failed > 0 ? `${row.failed} failed` : "", row.unfinished > 0 ? `${row.unfinished} did not finish` : "",
  ].filter(Boolean).join(", ")}`);
  const unfinished = log.some((call) => call.state === "queued" || call.state === "running");
  return `Tool calls before it stopped:\n${lines.join("\n")}\n${unfinished ? "A call that did not finish may still have changed something: check before you repeat it.\n" : ""}`;
}

/** Program globals a host's hooks see (and may refuse): the ones that touch the sandbox. */
const HOOKED_GLOBALS: ReadonlySet<string> = new Set(["bash", "read", "write", "edit"]);

export function programTool(
  env: ExecEnv, mcp: readonly McpToolHandle[], limits: ProgramLimits, description?: string, store?: ScriptStore, ask?: ProgramAsk, nested?: NestedHooks,
): AnyTool {
  void quickjsModule().catch(() => undefined);
  let spills = 0;
  const scripts = limits.scripts ? store : undefined;
  return {
    name: "program",
    label: "program",
    description: description ?? programDescription(mcp, limits, scripts?.list()),
    parameters: Type.Object({ code: Type.String({ description: "The program: JavaScript with top-level await." }) }),
    executionMode: "sequential",
    async execute(id: string, params: { code: string }, signal?: AbortSignal) {
      const started = performance.now();
      const gate = new Gate(limits.concurrency);
      const output: string[] = [];
      let calls = 0;
      let stopped: string | undefined;
      let mutated = false;
      // Every call the program made, in order, and how it ended: a program that fails or stops says which calls
      // finished, failed or never finished, since a call can change something before the program stops.
      const log: CallState[] = [];
      const counted = <T>(name: string, work: () => Promise<T>): Promise<T> => {
        calls++;
        if (calls > limits.max_calls) {
          stopped ??= `the program reached its ${limits.max_calls} tool-call budget`;
          return Promise.reject(new Error(`program budget: ${limits.max_calls} tool calls used; print what you have and continue in a new program`));
        }
        const entry: CallState = { name, state: "queued" };
        log.push(entry);
        return gate.run(async () => {
          entry.state = "running";
          const value = await work();
          entry.state = "done";
          return value;
        }).catch((error: unknown) => {
          entry.state = "failed";
          throw error instanceof Error ? error : new Error(`${name}: ${String(error)}`);
        });
      };
      const sandboxGlobals: CodemodeTool[] = [
        { name: "bash", async execute(raw) {
          const args = isRecord(raw) ? raw : {};
          if (typeof args.command !== "string" || args.command.trim() === "") throw new Error("bash: `command` must be a non-empty string");
          const seconds = typeof args.timeout_s === "number" && args.timeout_s > 0 ? Math.min(args.timeout_s, 3600) : limits.bash_timeout_s;
          return counted("bash", async () => {
            const run = await env.exec(args.command as string, { timeoutMs: seconds * 1000 });
            return { output: run.output, exit_code: run.exitCode, ...(run.timedOut === true ? { timed_out: true } : {}) };
          });
        } },
        { name: "read", async execute(raw) {
          const args = isRecord(raw) ? raw : {};
          if (typeof args.path !== "string") throw new Error("read: `path` must be a string");
          return counted("read", async () => {
            const text = Buffer.from(await env.readFile(args.path as string)).toString("utf8");
            const offset = typeof args.offset === "number" && args.offset > 1 ? Math.floor(args.offset) : 1;
            const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined;
            return offset === 1 && limit === undefined ? text : text.split("\n").slice(offset - 1, limit === undefined ? undefined : offset - 1 + limit).join("\n");
          });
        } },
        { name: "write", async execute(raw) {
          const args = isRecord(raw) ? raw : {};
          if (typeof args.path !== "string" || typeof args.content !== "string") throw new Error("write: `path` and `content` must be strings");
          return counted("write", async () => {
            await env.writeFile(args.path as string, args.content as string);
            mutated = true;
            return { bytes: Buffer.byteLength(args.content as string, "utf8") };
          });
        } },
        { name: "edit", async execute(raw) {
          const args = isRecord(raw) ? raw : {};
          if (typeof args.path !== "string" || typeof args.old_string !== "string" || typeof args.new_string !== "string") {
            throw new Error("edit: `path`, `old_string` and `new_string` must be strings");
          }
          return counted("edit", async () => {
            const original = Buffer.from(await env.readFile(args.path as string)).toString("utf8");
            const applied = applyEdits(original, [{ oldText: args.old_string as string, newText: args.new_string as string }], args.path as string, { fuzzy: true });
            await env.writeFile(args.path as string, applied.text);
            mutated = true;
            return { replaced: applied.replaced };
          });
        } },
        { name: "print", spread: true, execute(raw) {
          const values = Array.isArray(raw) ? raw : [raw];
          output.push(`${values.map(show).join(" ")}\n`);
          return null;
        } },
        ...(scripts === undefined ? [] : [{ name: "save_script", async execute(raw: unknown) {
          const problem = scriptProblem(raw);
          if (problem !== undefined) throw new Error(`save_script: ${problem}`);
          const script = raw as Omit<SavedScript, "saved_at">;
          const error = await compileError(script.code);
          if (error !== undefined) throw new Error(`save_script: the code does not compile: ${error}`);
          const saved = scripts.save(script);
          return { saved: saved.name, params: Object.keys(saved.params) };
        } } as CodemodeTool]),
        ...(!limits.ask || ask === undefined ? [] : [{ name: "ask", spread: true, async execute(raw: unknown, { signal: callSignal }: { signal: AbortSignal }) {
          const [prompt, opts] = Array.isArray(raw) ? raw : [raw];
          if (typeof prompt !== "string" || prompt.trim() === "") throw new Error("ask: the prompt must be a non-empty string");
          const json = isRecord(opts) && opts.json === true;
          return counted("ask", async () => {
            const text = await ask(prompt, { json, maxTokens: limits.ask_max_tokens, signal: callSignal });
            if (!json) return text;
            const body = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
            try {
              return JSON.parse(body);
            } catch {
              throw new Error(`ask: the answer is not JSON: ${text.slice(0, 200)}`);
            }
          });
        } } as CodemodeTool]),
        { name: "describe", execute(raw) {
          const name = typeof raw === "string" ? raw : isRecord(raw) && typeof raw.name === "string" ? raw.name : "";
          const tool = mcp.find((handle) => handle.qualified === name || handle.name === name);
          if (tool === undefined) throw new Error(`describe: no tool ${JSON.stringify(name)}`);
          return { name: tool.qualified, description: tool.description, input_schema: tool.inputSchema };
        } },
      ];
      const connectorTools: CodemodeTool[] = mcp.map((handle) => ({
        name: handle.qualified,
        description: handle.description,
        inputSchema: handle.inputSchema as CodemodeJsonSchema,
        execute: (raw, { signal: callSignal }) => counted(handle.qualified, async () => {
          const { text, isError } = await handle.call(isRecord(raw) ? raw : {}, callSignal);
          if (isError) throw new Error(`${handle.qualified}: ${text}`);
          return parsed(text);
        }),
      }));
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const byName = new Map(mcp.map((handle) => [handle.qualified, { server: handle.server, tool: handle.name }]));
      // With no sandbox the env is the host itself: bash, read, write and edit do not exist (HOOKED_GLOBALS are those four).
      const touching = limits.sandbox ? sandboxGlobals.filter((tool) => HOOKED_GLOBALS.has(tool.name)) : [];
      const globals = [...hookTools(touching, nested, id), ...sandboxGlobals.filter((tool) => !HOOKED_GLOBALS.has(tool.name))];
      const sandbox = new CellSandbox({ timeoutMs: limits.timeout_s * 1000, tools: hookTools(connectorTools, nested, id, (name) => byName.get(name)), globals },
        (item: CodemodeOutputItem) => { if (item.type === "text") output.push(item.text.endsWith("\n") ? item.text : `${item.text}\n`); });
      let result;
      try {
        const prelude = scripts === undefined ? "" : scriptPrelude(scripts.list());
        result = await sandbox.execute(`${prelude}return await (async () => {\n${params.code}\n})();`, { store: {}, signal: abort.signal });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (result.ok && result.value !== undefined && result.value !== null) output.push(`${show(result.value)}\n`);
      let failure: string | undefined;
      if (!result.ok) {
        const { error } = result;
        failure = error.kind === "script" ? (error.stack ?? `${error.name ?? "Error"}: ${error.message}`) : error.message;
      }
      const full = output.join("");
      let text = full;
      let spill: string | undefined;
      if (Buffer.byteLength(full, "utf8") > limits.max_output_bytes) {
        const half = Math.floor(limits.max_output_bytes / 2);
        if (limits.sandbox) {
          try {
            spill = `${await env.scratchDir()}/program-${++spills}.log`;
            await env.writeFile(spill, full);
          } catch {
            spill = undefined;
          }
        }
        const cut = Buffer.byteLength(full, "utf8") - 2 * half;
        text = `${full.slice(0, half)}\n[... ${cut} bytes cut${spill === undefined ? "" : `; the whole output is in ${spill}`} ...]\n${full.slice(-half)}`;
      }
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const status = `[program ${failure === undefined ? "finished" : "failed"}: ${Math.min(calls, limits.max_calls)} tool calls, ${seconds} s${stopped === undefined ? "" : `; ${stopped}`}]`;
      const ledger = failure === undefined && stopped === undefined ? "" : callLedger(log);
      const body = `${text}${failure === undefined ? "" : `Error: ${failure}\n`}${ledger}${status}`;
      const details: ToolDetails = { truncated: spill !== undefined, ...(spill === undefined ? {} : { spill }), ...(mutated ? { mutated: true } : {}), ...(failure === undefined ? {} : { failed: true }) };
      return { content: [{ type: "text" as const, text: body }], details };
    },
  } as unknown as AnyTool;
}
