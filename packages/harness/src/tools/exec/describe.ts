/**
 * The `exec` and `wait` tool descriptions as Codex CLI renders them for
 * GPT-6.x (rust-v0.166 `code-mode-protocol/src/description.rs`, Apache-2.0;
 * ported from the climb branch's exec-tools.ts, which matched our 10-25 wire
 * capture): the template, the deferred-tools guidance, the shared MCP types
 * and one `### name` section per nested tool with its TypeScript declaration.
 */

import { placeboFor } from "../../prompts.ts";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const EXEC_DESCRIPTION = [
  "Run JavaScript code to orchestrate/compose tool calls",
  "- Evaluates the provided JavaScript code in a fresh V8 isolate as an async module.",
  "- All nested tools are available on the global `tools` object, for example `await tools.exec_command(...)`. Tool names are exposed as normalized JavaScript identifiers, for example `await tools.mcp__ologs__get_profile(...)`.",
  "- Nested tool methods take either a string or an object as their input argument.",
  "- Nested tools return either an object or a string, based on the description.",
  "- Runs raw JavaScript -- no Node, no file system, no network access, no console.",
  "- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.",
  "- You may optionally start the tool input with a first-line pragma like `// @exec: {\"yield_time_ms\": 10000, \"max_output_tokens\": 1000}`.",
  "- `yield_time_ms` asks `exec` to yield early if the script is still running. Defaults to 30000 ms.",
  "- `max_output_tokens` sets the token budget for direct `exec` results. Defaults to 10000 tokens.",
  "- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.",
  "",
  "- Global helpers:",
  "- `exit()`: Immediately ends the current script successfully (like an early return from the top level).",
  "- `text(value: string | number | boolean | undefined | null)`: Appends a text item. Non-string values are stringified with `JSON.stringify(...)` when possible.",
  "- `image(imageUrlOrItem: string | { image_url: string; detail?: \"auto\" | \"low\" | \"high\" | \"original\" | null } | ImageContent, detail?: \"auto\" | \"low\" | \"high\" | \"original\" | null)`: Appends an image item. `image_url` should be a base64-encoded `data:` URL. To forward an MCP tool image, pass an individual `ImageContent` block from `result.content`, for example `image(result.content[0])`. MCP image blocks may request detail with `_meta: { \"codex/imageDetail\": \"original\" }`. When provided, the second `detail` argument overrides any detail embedded in the first argument.",
  "- `store(key: string, value: any)`: stores a serializable value under a string key for later `exec` calls in the same session.",
  "- `load(key: string)`: returns the stored value for a string key, or `undefined` if it is missing.",
  "- `notify(value: string | number | boolean | undefined | null)`: immediately injects an extra `custom_tool_call_output` for the current `exec` call. Values are stringified like `text(...)`.",
  "- `setTimeout(callback: () => void, delayMs?: number)`: schedules a callback to run later and returns a timeout id. Pending timeouts do not keep `exec` alive by themselves; await an explicit promise if you need to wait for one.",
  "- `clearTimeout(timeoutId?: number)`: cancels a timeout created by `setTimeout`.",
  "- `ALL_TOOLS`: metadata for the enabled nested tools as `{ name, description }` entries.",
  "- `yield_control()`: yields the accumulated output to the model immediately while the script keeps running.",
].join("\n");

const DEFERRED_NESTED_TOOLS_GUIDANCE = [
  "Some deferred nested tools may be omitted from this description. They are still available on the global `tools` object and listed in `ALL_TOOLS`.",
  "To find one, filter `ALL_TOOLS` by `name` and `description`.",
  "",
  "Tool availability can change between calls.",
].join("\n");

// Codex's shared MCP result types (after modelcontextprotocol.io's CallToolResult), shown before the tool sections.
const MCP_TYPESCRIPT_PREAMBLE = `type Role = "user" | "assistant";
type MetaObject = Record<string, unknown>;
type Annotations = {
  audience?: Role[];
  priority?: number;
  lastModified?: string;
};
type Icon = {
  src: string;
  mimeType?: string;
  sizes?: string[];
  theme?: "light" | "dark";
};
type TextResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  text: string;
};
type BlobResourceContents = {
  uri: string;
  mimeType?: string;
  _meta?: MetaObject;
  blob: string;
};
type TextContent = {
  type: "text";
  text: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ImageContent = {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type AudioContent = {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ResourceLink = {
  icons?: Icon[];
  name: string;
  title?: string;
  uri: string;
  description?: string;
  mimeType?: string;
  annotations?: Annotations;
  size?: number;
  _meta?: MetaObject;
  type: "resource_link";
};
type EmbeddedResource = {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: Annotations;
  _meta?: MetaObject;
};
type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLink
  | EmbeddedResource;
type CallToolResult<TStructured = { [key: string]: unknown }> = {
  _meta?: MetaObject;
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: TStructured;
  [key: string]: unknown;
};`;

/** The shared MCP types section as the exec description shows it (`mcp_types`). */
export const MCP_TYPES_BLOCK = `Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``;

export const WAIT_DESCRIPTION = [
  "Waits on a yielded `exec` cell and returns new output or completion.",
  "- Use `wait` only after `exec` returns `Script running with cell ID ...`.",
  "- `cell_id` identifies the running `exec` cell to resume.",
  "- `yield_time_ms` controls how long to wait for more output before yielding again. Defaults to 10000 ms.",
  "- `max_tokens` limits how much new output this wait call returns. Defaults to 10000 tokens.",
  "- `terminate: true` stops the running cell; false or omitted waits for output.",
  "- `wait` returns only the new output since the last yield, or the final completion or termination result for that cell.",
  "- If the cell is still running, `wait` may yield again with the same `cell_id`.",
  "- If the cell has already finished, `wait` returns the completed result and closes the cell.",
].join("\n");

/** A nested tool as the description renders it. `freeform` tools take one raw string (apply_patch takes the patch). */
export interface NestedToolSpec {
  name: string;
  description: string;
  input: unknown;
  output?: unknown;
  /** A named output type instead of a schema (MCP tools: `CallToolResult`, from the shared MCP types). */
  outputType?: string;
  freeform?: boolean;
}

/** Codex's `normalize_code_mode_identifier`: a tool name as a JavaScript identifier. */
export function execToolIdentifier(name: string): string {
  let identifier = "";
  for (const [index, character] of [...name].entries()) {
    identifier += (index === 0 ? /^[A-Za-z_$]$/u : /^[A-Za-z0-9_$]$/u).test(character) ? character : "_";
  }
  return identifier === "" ? "_" : identifier;
}

/** A nested tool as its description section shows it: description, then its declaration. */
export function execToolSample(spec: NestedToolSpec): string {
  const input = spec.freeform === true ? "string" : renderSchemaTypeScript(spec.input);
  const output = spec.outputType ?? (spec.output === undefined ? "unknown" : renderSchemaTypeScript(spec.output));
  const declaration = `declare const tools: { ${execToolIdentifier(spec.name)}(${spec.freeform === true ? "input" : "args"}: ${input}): Promise<${output}>; };`;
  return `${spec.description}\n\nexec tool declaration:\n\`\`\`ts\n${declaration}\n\`\`\``;
}

/**
 * exec.batch: Codex 0.163's own batching rules (its base instructions, "Rules for getting work done", src/codex-base.ts;
 * "functions.exec" read as one `exec` cell, "approvals" and "Avoid unnecessary output" dropped as not about batching),
 * with the batched cell Codex writes as the example. Our b5 cells never awaited two nested calls together (0 of 1,855
 * cells in r7/r8; 82% ran one command), so a check of a running session, a search and a read each cost a request.
 */
export const BATCH_LINES = [
  "- Batch independent searches and reads in one `exec` cell using `await Promise.allSettled([...])`; inspect every result. Keep dependencies, edits, waits, and adaptive follow-ups sequential.",
  "- Parallelize independent nested tool calls by awaiting their promises together, for example " +
    "`const results = await Promise.allSettled([tools.exec_command({cmd: \"rg -n 'def parse' src\"}), tools.exec_command({cmd: \"sed -n '1,80p' setup.py\"})]); results.forEach((r, i) => text({i, ...r}));`. " +
    "Dependent operations, mutations, or operations that may not parallelize cleanly, can be sequential.",
].join("\n");

/** exec.batch's control: neutral text of BATCH_LINES' estimated token length, in the same place. */
export const BATCH_PLACEBO = placeboFor("exec.batch", BATCH_LINES);

/** The line BATCH_LINES (or its placebo) follows: awaiting promises together is what keeps them from being discarded. */
const BATCH_ANCHOR = "- When the JS code is fully evaluated, the isolate's lifetime ends and unawaited promises are silently discarded.";

/** exec.batch: how the description says it, if at all. */
export type BatchMode = "off" | "on" | "placebo";

/** R3 exec.aliases: the prelude's shorthands, listed with the global helpers only when the loadout turns them on. */
export const ALIAS_HELPERS = [
  "- `sh(cmd: string, opts?: { workdir?: string; yield_time_ms?: number; max_output_tokens?: number })`: shorthand for `text((await tools.exec_command({ cmd, ...opts })).output)`. Appends the output, then `[exit N]` after a non-zero exit or `[still running: session_id N]`, and returns the exec_command record.",
  "- `read(path: string | string[], opts?: { offset?: number; limit?: number })`: appends a file's text (several files under `==> path <==` headers, all fetched in one round trip; `offset`/`limit` pick 1-indexed lines) and returns it.",
].join("\n");

export const WAIT_UNTIL_LINES = [
  "- `until` blocks until a condition holds instead of yielding after `yield_time_ms` (at most 300 s, no output budget spent while waiting): `exit`, `regex:<pattern>` (new output matches), `port:<n>` (localhost:<n> accepts connections) or `file:<path>` (the path exists). The cell or process ending always returns.",
  "- `session_id` instead of `cell_id` waits on a running `exec_command` session (with `until`).",
].join("\n");

/**
 * The `exec` tool's description for its nested tools; `mcpTypes: false` drops the shared MCP types block, `aliases` adds
 * the prelude's shorthands, `batch` puts BATCH_LINES (or, as `placebo`, BATCH_PLACEBO) after the unawaited-promises line.
 */
export function execToolDescription(specs: readonly NestedToolSpec[], mcpTypes = true, aliases = false, batch: BatchMode = "off"): string {
  const sections = specs.map((spec) => {
    const identifier = execToolIdentifier(spec.name);
    const heading = identifier === spec.name ? `### \`${identifier}\`` : `### \`${identifier}\` (\`${spec.name}\`)`;
    return `${heading}\n${execToolSample(spec).trim()}`;
  });
  const base = batch === "off" ? EXEC_DESCRIPTION : EXEC_DESCRIPTION.replace(BATCH_ANCHOR, `${BATCH_ANCHOR}\n${batch === "on" ? BATCH_LINES : BATCH_PLACEBO}`);
  return [
    aliases ? `${base}\n${ALIAS_HELPERS}` : base,
    DEFERRED_NESTED_TOOLS_GUIDANCE,
    ...(mcpTypes ? [MCP_TYPES_BLOCK] : []),
    ...(sections.length === 0 ? [] : [sections.join("\n\n")]),
  ].join("\n\n");
}

const SCHEMA_RENDER_MAX_BYTES = 16_000;

/**
 * Codex's JSON Schema to TypeScript rendering for declarations: properties sorted by name, each description line
 * as a `//` comment above its property (objects with none stay on one line), unions, enums and arrays inline.
 * Local `$ref`s are not followed (they render as `unknown`); an oversized declaration renders as `unknown`.
 */
export function renderSchemaTypeScript(schema: unknown): string {
  const rendered = renderSchema(schema, 0);
  return Buffer.byteLength(rendered, "utf8") > SCHEMA_RENDER_MAX_BYTES ? "unknown" : rendered;
}

function renderSchema(schema: unknown, depth: number): string {
  if (schema === true) return "unknown";
  if (schema === false) return "never";
  if (!isRecord(schema) || depth > 32) return "unknown";
  if ("$ref" in schema) return "unknown";
  if ("const" in schema) return JSON.stringify(schema.const) ?? "unknown";
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map((value) => JSON.stringify(value) ?? "unknown").join(" | ");
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (Array.isArray(variants) && variants.length > 0) return variants.map((variant) => renderSchema(variant, depth + 1)).join(" | ");
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.map((variant) => {
      const rendered = renderSchema(variant, depth + 1);
      return rendered.includes(" | ") ? `(${rendered})` : rendered;
    }).join(" & ");
  }
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type): type is string => typeof type === "string");
    if (types.length > 0) return types.map((type) => renderTypeKeyword(schema, type, depth)).join(" | ");
  }
  if (typeof schema.type === "string") return renderTypeKeyword(schema, schema.type, depth);
  if ("properties" in schema || "additionalProperties" in schema || "required" in schema) return renderObject(schema, depth);
  if ("items" in schema || "prefixItems" in schema) return renderArray(schema, depth);
  return "unknown";
}

function renderTypeKeyword(schema: Record<string, unknown>, type: string, depth: number): string {
  if (type === "string" || type === "boolean" || type === "null") return type;
  if (type === "number" || type === "integer") return "number";
  if (type === "array") return renderArray(schema, depth);
  if (type === "object") return renderObject(schema, depth);
  return "unknown";
}

function renderArray(schema: Record<string, unknown>, depth: number): string {
  if ("items" in schema) return `Array<${renderSchema(schema.items, depth + 1)}>`;
  if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
    return `[${schema.prefixItems.map((item) => renderSchema(item, depth + 1)).join(", ")}]`;
  }
  return "unknown[]";
}

function renderObject(schema: Record<string, unknown>, depth: number): string {
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const names = Object.keys(properties).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const property = (name: string) =>
    `${/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${renderSchema(properties[name], depth + 1)};`;
  const additional = (): string | undefined => {
    if ("additionalProperties" in schema) {
      const value = schema.additionalProperties;
      if (value === false) return undefined;
      return `[key: string]: ${value === true ? "unknown" : renderSchema(value, depth + 1)};`;
    }
    return names.length === 0 ? "[key: string]: unknown;" : undefined;
  };
  const described = names.some((name) => {
    const value = properties[name];
    return isRecord(value) && typeof value.description === "string" && value.description.trim() !== "";
  });
  if (described) {
    const lines = ["{"];
    for (const name of names) {
      const value = properties[name];
      const description = isRecord(value) && typeof value.description === "string" ? value.description : "";
      for (const line of description.split(/\r?\n/).map((part) => part.trim()).filter((part) => part !== "")) lines.push(`  // ${line}`);
      lines.push(`  ${property(name)}`);
    }
    const extra = additional();
    if (extra !== undefined) lines.push(`  ${extra}`);
    lines.push("}");
    return lines.join("\n");
  }
  const lines = names.map(property);
  const extra = additional();
  if (extra !== undefined) lines.push(extra);
  return lines.length === 0 ? "{}" : `{ ${lines.join(" ")} }`;
}

