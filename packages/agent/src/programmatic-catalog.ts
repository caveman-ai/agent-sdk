/**
 * Nested-tool catalog for programmatic cells: TypeScript-style declarations,
 * path-level argument errors, and discovery over a registry that can grow
 * after the code tool's description is frozen. Nothing here reaches the
 * provider-visible prefix except `codeToolDescription`, which is computed once
 * from the construction-time tools.
 */
import type { ToolDefinition } from "./primitives.js";
import { toolSchemaSemanticsVerified } from "./tool-internal.js";

/** Groups late-registered tools for `describeNamespace()` and search filters. */
export interface ProgrammaticToolNamespace {
  readonly name: string;
  readonly description?: string;
  /** Longer guidance (for example tool-server instructions), returned only by `describeNamespace()`. */
  readonly instructions?: string;
}

export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly namespace?: ProgrammaticToolNamespace;
}

const TOOL_IMPLEMENTATION_SOURCE = Symbol.for("@caveman-ai/agent:tool-implementation-source");
/** Declarations beyond this many UTF-8 bytes stay callable but are found only through discovery. */
const PROGRAM_INLINE_DECLARATION_BYTES = 12 * 1024;
const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MAX_QUERY_CHARS = 256;
const SEARCH_MAX_TERMS = 16;
const MAX_ARGUMENT_ERRORS = 6;

/**
 * Every tool one code tool can dispatch. Construction-time tools come from the
 * agent definition; `register` adds more (for example a late-connecting tool
 * server) that later cells can call. The description never changes.
 */
export class NestedToolRegistry {
  readonly #entries = new Map<string, RegisteredTool>();
  readonly #codeToolName: string;

  constructor(codeToolName: string, definitions: readonly ToolDefinition[]) {
    this.#codeToolName = codeToolName;
    for (const definition of definitions) {
      this.#entries.set(definition.name, Object.freeze({ definition }));
    }
  }

  register(definitions: readonly ToolDefinition[], namespace?: ProgrammaticToolNamespace): void {
    if (namespace !== undefined && (typeof namespace.name !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(namespace.name) ||
        (namespace.description !== undefined && typeof namespace.description !== "string") ||
        (namespace.instructions !== undefined && typeof namespace.instructions !== "string"))) {
      throw new Error("cave_program_namespace_invalid");
    }
    const frozenNamespace = namespace === undefined ? undefined : Object.freeze({ ...namespace });
    const additions = new Map<string, RegisteredTool>();
    for (const definition of definitions) {
      // Same trust bar as agent graph validation: SDK-constructed, flat, and
      // dispatched through the kernel, never through a delegated runtime.
      if (definition?.kind !== "tool" || typeof definition.name !== "string" ||
          typeof Reflect.get(definition, TOOL_IMPLEMENTATION_SOURCE) !== "string") {
        throw new Error("cave_program_registered_tool_untrusted");
      }
      if (definition.name.startsWith("cave_") || definition.name === this.#codeToolName ||
          this.#entries.has(definition.name) || additions.has(definition.name)) {
        throw new Error(`cave_program_registered_tool_duplicate:${definition.name}`);
      }
      // Locked and durable runs refuse unverified schema semantics up front;
      // a late tool must not slip past that gate.
      if (definition.runtime !== undefined || definition.nestedTools !== undefined ||
          !toolSchemaSemanticsVerified(definition)) {
        throw new Error(`cave_program_registered_tool_unsupported:${definition.name}`);
      }
      additions.set(definition.name, Object.freeze({
        definition,
        ...(frozenNamespace === undefined ? {} : { namespace: frozenNamespace }),
      }));
    }
    for (const [name, entry] of additions) this.#entries.set(name, entry);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#entries.get(name)?.definition;
  }

  list(): readonly RegisteredTool[] {
    return [...this.#entries.values()];
  }
}

export function toolDeclaration(definition: ToolDefinition): string {
  return `// ${definition.description.replace(/\r?\n/g, "\n// ")}\n${toolSignature(definition)}`;
}

function toolSignature(definition: ToolDefinition): string {
  const result = definition.output === undefined ? "string" : schemaType(definition.output);
  return `declare function ${definition.name}(args: ${schemaType(definition.input)}): Promise<${result}>;`;
}

/**
 * Stable provider-visible description, built only from construction-time tools.
 * `declared` tools are already in the provider's tool list (hybrid mode): their
 * description is not repeated, but the cell signature is, since a cell result
 * can differ from the declared tool's text.
 */
export function codeToolDescription(
  definitions: readonly ToolDefinition[],
  declared: ReadonlySet<string> = new Set(),
): string {
  let remaining = PROGRAM_INLINE_DECLARATION_BYTES;
  let hidden = 0;
  const declarations: string[] = [];
  for (const definition of definitions) {
    const declaration = declared.has(definition.name) ? toolSignature(definition) : toolDeclaration(definition);
    const bytes = Buffer.byteLength(declaration, "utf8") + 1;
    if (bytes > remaining) {
      hidden++;
      continue;
    }
    remaining -= bytes;
    declarations.push(declaration);
  }
  return [
    "Bounded async JS cell. Tools are direct functions and under tools.",
    "Discovery: ALL_TOOLS; await searchTools(query, {limit?, namespace?}), describeTool(name), describeNamespace(name).",
    ...declarations,
    ...(hidden === 0 ? [] : [`${hidden} more tools are callable; describeTool(name) shows one.`]),
  ].join("\n");
}

export function schemaType(value: unknown, depth = 0): string {
  if (depth > 5 || !isRecord(value)) return "unknown";
  if (Array.isArray(value.anyOf)) {
    return value.anyOf.map((item) => schemaType(item, depth + 1)).join(" | ");
  }
  if (Array.isArray(value.enum)) return value.enum.map((item) => JSON.stringify(item)).join(" | ");
  if ("const" in value) return JSON.stringify(value.const);
  if (value.type === "string") return "string";
  if (value.type === "integer" || value.type === "number") return "number";
  if (value.type === "boolean") return "boolean";
  if (value.type === "null") return "null";
  if (value.type === "array") return `Array<${schemaType(value.items, depth + 1)}>`;
  if (value.type !== "object" || !isRecord(value.properties)) return "unknown";
  const required = new Set(Array.isArray(value.required)
    ? value.required.filter((item): item is string => typeof item === "string")
    : []);
  const fields = Object.entries(value.properties).map(([name, schema]) =>
    `${schemaPropertyName(name)}${required.has(name) ? "" : "?"}: ${schemaType(schema, depth + 1)}`
  );
  return `{ ${fields.join("; ")} }`;
}

function schemaPropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Model-facing rejection: each offending path, then the expected call shape. */
export function invalidArgumentsMessage(definition: ToolDefinition, errors: readonly string[]): string {
  return [
    `cave_program_tool_arguments_invalid:${definition.name}`,
    ...errors.slice(0, MAX_ARGUMENT_ERRORS).map((error) => `  - ${error}`),
    `Expected ${definition.name}(args: ${schemaType(definition.input)})`,
  ].join("\n");
}

/** Path-level JSON Schema check; an empty list means the value is valid. */
export function argumentErrors(schema: unknown, value: unknown, path = ""): string[] {
  const at = path === "" ? "args" : path;
  if (!isRecord(schema)) return [`${at}: schema cannot be checked`];
  // JSON Schema allows a list of types, for example ["string", "null"]. Only
  // the member matching the value's kind is checked, so a nested list stays
  // linear instead of re-checking the subtree once per member.
  // Resolved before anyOf/allOf so those run once per node, not twice.
  if (Array.isArray(schema.type)) {
    const kind = valueKind(value);
    const types = schema.type.filter((type): type is string => typeof type === "string");
    const type = kind === "number"
      ? types.find((candidate) => candidate === "number") ?? types.find((candidate) => candidate === "integer")
      : types.find((candidate) => candidate === kind);
    if (type === undefined) return [`${at}: expected ${types.join(" | ")}, got ${kind}`];
    return argumentErrors({ ...schema, type }, value, path);
  }
  if (Array.isArray(schema.anyOf)) {
    // The first matching member settles it; otherwise the closest member
    // explains the mistake better than "no match".
    let closest: string[] | undefined;
    for (const item of schema.anyOf) {
      const errors = argumentErrors(item, value, path);
      if (errors.length === 0) {
        closest = undefined;
        break;
      }
      if (closest === undefined || errors.length < closest.length) closest = errors;
    }
    if (closest !== undefined) return closest;
  }
  if (Array.isArray(schema.allOf)) {
    const errors: string[] = [];
    for (const item of schema.allOf) {
      if (errors.length >= MAX_ARGUMENT_ERRORS) break;
      errors.push(...argumentErrors(item, value, path));
    }
    if (errors.length > 0) return errors;
  }
  if ("const" in schema && !Object.is(schema.const, value)) {
    return [`${at}: expected ${JSON.stringify(schema.const)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return [`${at}: expected one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`];
  }
  if (schema.type === undefined) return [];
  const mismatch = () => [`${at}: expected ${String(schema.type)}, got ${valueKind(value)}`];
  if (schema.type === "null") return value === null ? [] : mismatch();
  if (schema.type === "boolean") return typeof value === "boolean" ? [] : mismatch();
  if (schema.type === "string") {
    if (typeof value !== "string") return mismatch();
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      return [`${at}: needs at least ${schema.minLength} characters`];
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      return [`${at}: allows at most ${schema.maxLength} characters`];
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      return [`${at}: must match ${schema.pattern}`];
    }
    return [];
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) ||
        (schema.type === "integer" && !Number.isSafeInteger(value))) {
      return mismatch();
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return [`${at}: must be >= ${schema.minimum}`];
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return [`${at}: must be <= ${schema.maximum}`];
    }
    return [];
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return mismatch();
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return [`${at}: needs at least ${schema.minItems} items`];
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return [`${at}: allows at most ${schema.maxItems} items`];
    }
    const errors: string[] = [];
    if (schema.items === undefined) return errors;
    // Only the first few errors are shown, so stop checking once they are found.
    for (const [index, item] of value.entries()) {
      if (errors.length >= MAX_ARGUMENT_ERRORS) break;
      errors.push(...argumentErrors(schema.items, item, `${at}[${index}]`));
    }
    return errors;
  }
  if (schema.type !== "object" || !isRecord(value)) return mismatch();
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const child = (name: string) => path === "" ? name : `${path}.${name}`;
  const errors = (Array.isArray(schema.required) ? schema.required : [])
    .filter((name): name is string => typeof name === "string" && !(name in value))
    .map((name) => `${child(name)}: required`);
  for (const [name, field] of Object.entries(value)) {
    if (errors.length >= MAX_ARGUMENT_ERRORS) break;
    if (name === "__proto__" || name === "prototype" || name === "constructor") {
      errors.push(`${child(name)}: forbidden key`);
      continue;
    }
    const fieldSchema = properties[name];
    if (fieldSchema === undefined) {
      if (schema.additionalProperties === false) errors.push(`${child(name)}: unknown property`);
      continue;
    }
    errors.push(...argumentErrors(fieldSchema, field, child(name)));
  }
  return errors;
}

function valueKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Answer one discovery global from inside a cell. Results return as tool data, never as prefix. */
export function discoverTools(entries: readonly RegisteredTool[], name: string, args: unknown): unknown {
  if (!Array.isArray(args)) throw new Error(`${name}() arguments are invalid`);
  const [first, options] = args as unknown[];
  if (name === "searchTools") {
    if (typeof first !== "string" || first.length > SEARCH_MAX_QUERY_CHARS) {
      throw new Error(`searchTools(query) expects a query string of at most ${SEARCH_MAX_QUERY_CHARS} characters`);
    }
    const limit = isRecord(options) && options.limit !== undefined ? options.limit : SEARCH_DEFAULT_LIMIT;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
      throw new Error(`searchTools() limit must be an integer from 1 to ${SEARCH_MAX_LIMIT}`);
    }
    const namespace = isRecord(options) ? options.namespace : undefined;
    if (namespace !== undefined && namespace !== null && typeof namespace !== "string") {
      throw new Error("searchTools() namespace must be a string");
    }
    const candidates = typeof namespace === "string"
      ? entries.filter((entry) => entry.namespace?.name === namespace)
      : entries;
    return rankTools(first, candidates).slice(0, limit).map(({ definition, namespace: group }) => ({
      name: definition.name,
      ...(group === undefined ? {} : { namespace: group.name }),
      description: definition.description,
    }));
  }
  if (typeof first !== "string") throw new Error(`${name}(name) expects a name string`);
  if (name === "describeTool") {
    const entry = entries.find((candidate) => candidate.definition.name === first);
    return entry === undefined ? null : toolDeclaration(entry.definition);
  }
  if (name === "describeNamespace") {
    const members = entries.filter((entry) => entry.namespace?.name === first);
    const namespace = members[0]?.namespace;
    if (namespace === undefined) return null;
    return {
      name: namespace.name,
      ...(namespace.description === undefined ? {} : { description: namespace.description }),
      ...(namespace.instructions === undefined ? {} : { instructions: namespace.instructions }),
      tools: members.map((entry) => entry.definition.name),
    };
  }
  throw new Error(`cave_program_discovery_unknown:${name}`);
}

// Okapi BM25 over tool metadata. Ties keep registry order.
function rankTools(query: string, entries: readonly RegisteredTool[]): RegisteredTool[] {
  const terms = [...new Set(searchTerms(query))].slice(0, SEARCH_MAX_TERMS);
  if (terms.length === 0 || entries.length === 0) return [];
  const counts = entries.map((entry) => {
    const frequency = new Map<string, number>();
    for (const term of searchTerms(searchText(entry))) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return frequency;
  });
  const lengths = counts.map((frequency) => [...frequency.values()].reduce((sum, count) => sum + count, 0));
  const average = lengths.reduce((sum, length) => sum + length, 0) / entries.length || 1;
  const idf = new Map(terms.map((term) => {
    const documents = counts.filter((frequency) => frequency.has(term)).length;
    return [term, Math.log(1 + (entries.length - documents + 0.5) / (documents + 0.5))] as const;
  }));
  const scored = entries.map((entry, index) => {
    let score = 0;
    for (const term of terms) {
      const count = counts[index]!.get(term) ?? 0;
      if (count === 0) continue;
      score += idf.get(term)! * (count * 2.2) / (count + 1.2 * (0.25 + 0.75 * lengths[index]! / average));
    }
    return { entry, score };
  });
  return scored.filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.entry);
}

function searchText({ definition, namespace }: RegisteredTool): string {
  const parts = [definition.name, definition.description];
  const collect = (schema: unknown): void => {
    if (!isRecord(schema)) return;
    if (typeof schema.description === "string") parts.push(schema.description);
    if (isRecord(schema.properties)) {
      for (const [name, property] of Object.entries(schema.properties)) {
        parts.push(name);
        collect(property);
      }
    }
    collect(schema.items);
    if (Array.isArray(schema.anyOf)) schema.anyOf.forEach(collect);
  };
  collect(definition.input);
  if (namespace !== undefined) parts.push(namespace.name, namespace.description ?? "");
  return parts.join(" ");
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "with",
]);

/** Lowercase terms split at camelCase and punctuation, naively singularized. */
function searchTerms(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .filter((term) => term !== "" && !STOP_WORDS.has(term))
    .map((term) => term.length > 4 && term.endsWith("ies")
      ? `${term.slice(0, -3)}y`
      : term.length > 3 && term.endsWith("s") && !term.endsWith("ss")
      ? term.slice(0, -1)
      : term);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
