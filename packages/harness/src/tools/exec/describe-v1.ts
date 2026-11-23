/**
 * exec.describe "v1" (`tools.exec.limits.describe`): the exec surface's descriptions rewritten from the code-mode
 * friction census (research/codemode/findings.md), keeping Codex's skeleton (bulleted exec rules, global helpers,
 * one `### name` section with a TypeScript declaration per nested tool) and changing what was false or missing:
 *
 * - Yields are caps, not delays. 6.8 commands an attempt yield a session, 89% of them launched with `yield_time_ms`
 *   <= 1 s, and get polled (2.2 poll-only requests an attempt, +1.35 over Codex on the same tasks); 76% of the commands
 *   whose exit we could time ended within 30 s of the launch. v0 says "Wait before yielding output", which
 *   reads as a sleep; v1 says the call returns as soon as the command exits, with the ranges the loadout enforces, and
 *   that a cell yields at its own yield_time_ms even while a nested call waits (a long poll inside a cell otherwise
 *   turns into a cell wait).
 * - A non-zero exit_code does not throw (12 failed cells per 100 attempts were a view_image of a file the cell's own
 *   failed command never wrote), `wait` is not on `tools` (8 cells called tools.wait), and there is no stdin.
 * - False for this surface and dropped: a PTY, deferred tools (55 cells per 100 attempts filtered ALL_TOOLS looking for
 *   them), MCP result types, approval and sandbox arguments (`justification`, `prefix_rule`, `sandbox_permissions`),
 *   `login`, `shell`, `tty`, and notify's "extra custom_tool_call_output". exec_command's ignored arguments are still
 *   accepted; they are only no longer advertised.
 * - Return shapes: apply_patch resolves to its "Success. Updated the following files:" text and throws (writing
 *   nothing) on a mismatch; `text(record)` prints the record as JSON and `text(record.output)` drops exit_code and
 *   session_id.
 *
 * Off (the default "v0"), nothing here is used and every description is byte-for-byte Codex's port (describe.ts).
 */
import { Type } from "typebox";
import { ALIAS_HELPERS, BATCH_LINES, BATCH_PLACEBO, execToolIdentifier, execToolSample, MCP_TYPES_BLOCK, type BatchMode, type NestedToolSpec } from "./describe.ts";

/** The numbers the v1 text states, taken from the loadout's limits so the description never disagrees with them. */
export interface V1Numbers {
  /** exec: the cell's default yield and output budget. */
  cellYieldMs: number;
  cellTokens: number;
  /** exec_command's yield: floor, cap, default. */
  cmdYield: { min: number; max: number; default: number };
  /** write_stdin's empty poll: floor (also its default) and cap. */
  poll: { min: number; max: number };
  /** wait.until is on: `wait {session_id, until}` exists. */
  until: boolean;
  /** wait is exposed at all. */
  wait: boolean;
}

const ms = (value: number) => `${value} ms`;

const MAX_OUTPUT_TOKENS_V1 = Type.Optional(Type.Number({
  description: "Token budget for this output (default: the exec result's budget); a longer output keeps its start and end.",
}));

/** The record exec_command and write_stdin resolve to, field by field as the code fills it. */
const RECORD_V1 = Type.Object({
  chunk_id: Type.Optional(Type.String({ description: "Output chunk ID." })),
  exit_code: Type.Optional(Type.Number({ description: "Set once the command has exited; non-zero does not throw." })),
  original_token_count: Type.Optional(Type.Number({ description: "Output size in tokens before truncation." })),
  output: Type.String({ description: "Output (stdout and stderr) during this call, possibly truncated." }),
  session_id: Type.Optional(Type.Number({ description: "Set while the command still runs: poll it with write_stdin." })),
  wall_time_seconds: Type.Number({ description: "Seconds this call waited." }),
});

const VIEW_IMAGE_INPUT_V1 = Type.Object({
  detail: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("original")], { description: "`high` (default) or `original` (exact resolution)." })),
  path: Type.String({ description: "Path of a PNG, JPEG, GIF or WebP file." }),
});

const VIEW_IMAGE_OUTPUT_V1 = Type.Object({
  detail: Type.Union([Type.Literal("high"), Type.Literal("original")], { description: "The detail level used." }),
  image_url: Type.String({ description: "The image as a data URL: pass it to image()." }),
});

/** The nested tools as v1 declares them (only the description and declaration change; calls run exactly as in v0). */
export function nestedSpecsV1(numbers: V1Numbers): Record<"apply_patch" | "exec_command" | "view_image" | "write_stdin", NestedToolSpec> {
  const { cmdYield, poll } = numbers;
  return {
    apply_patch: {
      name: "apply_patch",
      description: "Edits files with a patch in the apply_patch format (`*** Begin Patch`, `*** Add File: <path>` / `*** Update File: <path>` / `*** Delete File: <path>`, " +
        "`@@` chunks of ` context`, `-removed` and `+added` lines, `*** End Patch`), passed as one string. Resolves to \"Success. Updated the following files:\" and the " +
        "files; a chunk that does not match throws and nothing is written.",
      input: Type.Object({ input: Type.String() }),
      output: Type.String(),
      freeform: true,
    },
    exec_command: {
      name: "exec_command",
      description: "Runs a shell command (no TTY, no stdin) and resolves when it exits, or with a session_id if it is still running at yield_time_ms.",
      input: Type.Object({
        cmd: Type.String({ description: "Shell command to run." }),
        max_output_tokens: MAX_OUTPUT_TOKENS_V1,
        workdir: Type.Optional(Type.String({ description: "Working directory. Defaults to the task's working directory." })),
        yield_time_ms: Type.Optional(Type.Number({
          description: `Longest wait for the command to exit: ${ms(cmdYield.min)} to ${ms(cmdYield.max)}, default ${ms(cmdYield.default)}. It returns as soon as the command exits.`,
        })),
      }),
      output: RECORD_V1,
    },
    view_image: {
      name: "view_image",
      description: "Loads a local image file for image() to show you.",
      input: VIEW_IMAGE_INPUT_V1,
      output: VIEW_IMAGE_OUTPUT_V1,
    },
    write_stdin: {
      name: "write_stdin",
      description: "Polls a running exec_command session for its new output, or stops it; resolves to the same record as exec_command.",
      input: Type.Object({
        chars: Type.Optional(Type.String({ description: "\"\" (default) polls; \"\\u0003\" stops the process. There is no stdin, so any other text fails." })),
        max_output_tokens: MAX_OUTPUT_TOKENS_V1,
        session_id: Type.Number({ description: "The session_id an exec_command record returned." }),
        yield_time_ms: Type.Optional(Type.Number({
          description: `Longest wait for the process to exit: ${ms(poll.min)} to ${ms(poll.max)}, default ${ms(poll.min)}. It returns as soon as the process exits.`,
        })),
      }),
      output: RECORD_V1,
    },
  };
}

/** What v1 says about commands, results and edits: the facts the census found missing. */
export function commandLinesV1(numbers: V1Numbers): string {
  const { cmdYield, poll, cellYieldMs } = numbers;
  const longer = numbers.until
    ? "end the cell and call `wait` with `{session_id, until: \"exit\"}`, or raise the cell's yield with the pragma"
    : "raise the cell's yield with the pragma";
  return [
    `- \`yield_time_ms\` on \`exec_command\` (${ms(cmdYield.min)} to ${ms(cmdYield.max)}) and on a \`write_stdin\` poll (${ms(poll.min)} to ${ms(poll.max)}) is the longest the call waits, not a delay: ` +
      "it returns as soon as the command exits, so a cap that covers the expected run time costs nothing when the command is quick and saves polling it again.",
    `- A command still running at its cap resolves with a \`session_id\` and keeps running. The cell itself yields at its own \`yield_time_ms\` (default ${ms(cellYieldMs)}) even while a call waits: ` +
      `to block longer on a session, ${longer}.`,
    "- A non-zero `exit_code` does not throw: check it before a call that needs the command's result (a file it writes, an image to view).",
    "- `text(record)` shows the whole record as JSON (`exit_code`, `output`, `session_id`); `text(record.output)` shows the output alone, without them.",
    "- `apply_patch` resolves to \"Success. Updated the following files: ...\"; a patch that does not match throws and changes nothing.",
    ...(numbers.wait ? ["- `wait` is a separate tool, not on `tools`: call it after the cell ends."] : []),
  ].join("\n");
}

export const EXEC_HEAD_V1 = [
  "Run JavaScript code to orchestrate/compose tool calls",
  "- Evaluates the provided JavaScript code in a fresh QuickJS isolate as an async module; top-level `await` works.",
  "- Nested tools are on the global `tools` object, for example `await tools.exec_command({cmd: \"ls\"})`. They are the script's only access to files, commands and the network: there is no Node, no `require` or `import`, no `fetch`.",
  "- Nested tool methods take an object, or one string (the command, the patch, the image path), and resolve to what their declaration shows.",
  "- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.",
  "- You may optionally start the tool input with a first-line pragma like `// @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}`.",
];

/** The cell-level rules whose numbers come from the loadout, then Codex's unawaited-promises line (the batch anchor). */
function cellLines(numbers: V1Numbers): string[] {
  return [
    `- \`yield_time_ms\` asks \`exec\` to yield early if the script is still running (default ${ms(numbers.cellYieldMs)}): you get the output so far and a cell ID${numbers.wait ? " for `wait`" : ""}.`,
    `- \`max_output_tokens\` sets the token budget for direct \`exec\` results (default ${numbers.cellTokens} tokens); a longer result keeps its start and end.`,
    "- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.",
  ];
}

export const HELPERS_V1 = [
  "- Global helpers:",
  "- `text(value)`: appends a text item; non-strings are stringified with `JSON.stringify(...)`.",
  "- `image(imageUrl: string | { image_url: string })`: appends an image, for example `image((await tools.view_image({path: \"plot.png\"})).image_url)`.",
  "- `store(key: string, value: any)` / `load(key: string)`: keep a serializable value across `exec` calls.",
  "- `exit()`: ends the script successfully (an early return from the top level).",
  "- `setTimeout(callback, delayMs)` / `clearTimeout(id)`: pending timeouts do not keep the script alive; await a promise to wait for one.",
  "- `yield_control()`: returns the output so far to you now while the script keeps running.",
  "- `ALL_TOOLS`: `{ name, description }` of the nested tools; every one of them is described below.",
].join("\n");

/** exec's v1 description: head, cell rules (+ batch lines), command facts, helpers (+ aliases), MCP types if asked, one section per tool. */
export function execToolDescriptionV1(specs: readonly NestedToolSpec[], numbers: V1Numbers, aliases = false, batch: BatchMode = "off", mcpTypes = false): string {
  const sections = specs.map((spec) => {
    const identifier = execToolIdentifier(spec.name);
    const heading = identifier === spec.name ? `### \`${identifier}\`` : `### \`${identifier}\` (\`${spec.name}\`)`;
    return `${heading}\n${execToolSample(spec).trim()}`;
  });
  const head = [...EXEC_HEAD_V1, ...cellLines(numbers), ...(batch === "off" ? [] : [batch === "on" ? BATCH_LINES : BATCH_PLACEBO])].join("\n");
  return [
    head,
    commandLinesV1(numbers),
    aliases ? `${HELPERS_V1}\n${ALIAS_HELPERS}` : HELPERS_V1,
    ...(mcpTypes ? [MCP_TYPES_BLOCK] : []),
    ...(sections.length === 0 ? [] : [sections.join("\n\n")]),
  ].join("\n\n");
}

/** wait's v1 description: no "only after a cell yields" when it also takes a session; caps, not delays. */
export function waitDescriptionV1(until: boolean, untilLines: string, defaults: { yieldMs: number; maxTokens: number }): string {
  return [
    until
      ? "Waits on a running `exec` cell, or with `until` on a running `exec_command` session, and returns its new output or its completion."
      : "Waits on a running `exec` cell and returns its new output or its completion.",
    "- `cell_id` is the ID an `exec` result named in `Script running with cell ID N`.",
    `- \`yield_time_ms\` is the longest this call waits (default ${ms(defaults.yieldMs)}); it returns as soon as the cell ends.`,
    `- \`max_tokens\` limits how much new output this wait call returns (default ${defaults.maxTokens} tokens).`,
    "- `terminate: true` stops the running cell and the commands it started; false or omitted waits for output.",
    "- If the cell is still running, `wait` may yield again with the same `cell_id`; once it has finished, `wait` returns the completed result and closes the cell.",
    ...(until ? [untilLines] : []),
  ].join("\n");
}

/** wait's parameter descriptions in v1 (the schema's shape is v0's; only the texts change). */
export function waitFieldsV1(defaults: { yieldMs: number; maxTokens: number }) {
  return {
    cell_id: "ID of the running exec cell.",
    max_tokens: `Output token budget for this wait call (default ${defaults.maxTokens} tokens).`,
    session_id: "A running exec_command session to wait on instead of a cell (with until).",
    terminate: "True stops the running exec cell; false or omitted waits for output.",
    yield_time_ms: `Longest wait for more output (default ${ms(defaults.yieldMs)}); returns as soon as the cell ends.`,
  };
}
