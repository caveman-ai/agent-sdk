import { Value } from "typebox/value";
import type { TSchema } from "@earendil-works/pi-ai";
import type { ToolDefinition, ToolExecutionContext } from "./primitives.js";

export const TOOL_RAW_EXECUTE = Symbol.for("@caveman-ai/agent:tool-raw-execute");
export const TOOL_STANDARD_OUTPUT = Symbol.for("@caveman-ai/agent:tool-standard-output");
export const TOOL_STANDARD_SCHEMA = Symbol.for("@caveman-ai/agent:tool-standard-schema");
export const TOOL_SCHEMA_IMPLEMENTATION_SOURCE = Symbol.for(
  "@caveman-ai/agent:tool-schema-implementation-source",
);

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_DEPTH = 64;
const MAX_OUTPUT_NODES = 65_536;
const INTRINSIC_JSON_STRINGIFY = JSON.stringify;

type RawExecute = (
  input: unknown,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
) => unknown | Promise<unknown>;

export interface SettledToolOutput {
  readonly value: unknown;
  readonly text: string;
  readonly bytes: Uint8Array;
}

/**
 * Detach one JSON Schema from caller mutation without invoking accessors.
 * Tool identity, provider exposure, and runtime validation then share the same
 * deeply frozen contract.
 */
export function snapshotToolSchema(value: unknown, direction: "input" | "output"): TSchema {
  const clones = new Map<object, object>();
  const active = new Set<object>();
  const pending: object[] = [];
  let nodes = 0;
  const fail = () => new Error(
    `caveman agent: tool ${direction} JSON Schema must be detached plain data`,
  );
  const clone = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 65_536 || depth > 64) throw fail();
    if (candidate === null || candidate === undefined ||
        typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw fail();
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    // TypeBox Refine/Codec semantics are executable function leaves. Capture
    // exact function identity while detaching every containing schema object;
    // locked/durable use additionally requires schemaSemanticsSHA256 below.
    if (typeof candidate === "function") return candidate;
    if (typeof candidate !== "object") throw fail();
    if (active.has(candidate)) throw fail();
    const existing = clones.get(candidate);
    if (existing !== undefined) return existing;
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null &&
        !(Array.isArray(candidate) && prototype === Array.prototype)) {
      throw fail();
    }
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) throw fail();
    const output: object = Array.isArray(candidate) ? [] : Object.create(prototype);
    clones.set(candidate, output);
    active.add(candidate);
    pending.push(output);
    try {
      for (const key of Object.keys(descriptors)) {
        if (Array.isArray(candidate) && key === "length") continue;
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) throw fail();
        Object.defineProperty(output, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: descriptor.enumerable === true,
          configurable: false,
          writable: false,
        });
      }
    } finally {
      active.delete(candidate);
    }
    return output;
  };
  const captured = clone(value, 0);
  if (captured === null || typeof captured !== "object" || Array.isArray(captured)) throw fail();
  for (let index = pending.length - 1; index >= 0; index--) Object.freeze(pending[index]);
  return captured as TSchema;
}

/**
 * Rebuild worker-settled output without invoking its schema a second time.
 * Worker owns raw validation; parent only re-snapshots transport JSON and
 * proves declared output text still matches that immutable value.
 */
export function settledToolOutputFromTransport(
  value: unknown,
  text: unknown,
  name: string,
  declaredOutput: boolean,
): SettledToolOutput {
  const mismatch = () => new Error(
    declaredOutput
      ? `cave_tool_output_schema_mismatch:${name}`
      : `cave_tool_result_not_json_safe:${name}`,
  );
  if (typeof text !== "string") throw mismatch();
  if (!declaredOutput && value === undefined && text === "null") {
    const bytes = new TextEncoder().encode(text);
    return Object.freeze({ value, text, bytes });
  }
  let snapshot: unknown;
  try {
    snapshot = snapshotJSON(value);
    if (declaredOutput) {
      const expected = typeof snapshot === "string"
        ? snapshot
        : stringifyJSONSnapshot(snapshot);
      if (text !== expected) throw mismatch();
    }
  } catch {
    throw mismatch();
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error(`cave_tool_result_limit:${name}`);
  }
  return Object.freeze({ value: snapshot, text, bytes });
}

/** Standard Schema methods captured once when `tool()` constructs its boundary. */
export interface CapturedStandardSchema {
  readonly version: 1;
  readonly vendor: string;
  readonly receiver: object;
  /** Captured plain receiver state; drift fails validation before invocation. */
  readonly receiverState: string | null;
  readonly validate: (...args: never[]) => unknown;
  readonly converterReceiver?: object;
  readonly converter?: (...args: never[]) => unknown;
}

/**
 * Context key, present only when a run compresses tool results: a tool that
 * capped its output hands the whole text here, so compression and Keep read
 * all of it and the cap applies to what compression returns.
 */
export const TOOL_FULL_OUTPUT = Symbol.for("@caveman-ai/agent:tool-full-output");
/** The runtime holds at most this much of one tool's whole output. */
export const FULL_TOOL_OUTPUT_MAX_BYTES = 1024 * 1024;

export interface FullToolOutput {
  /** Kept verbatim ahead of the compressed text, e.g. bash's exit line. */
  readonly prefix: string;
  readonly text: string;
  /** The tool's cap for `text`, applied after compression. */
  readonly maxBytes: number;
  readonly direction: "head" | "tail";
  /** What the tool returns instead; the runtime substitutes only a result that is exactly this. */
  readonly capped: string;
}

/** The agent asked for this exact result (a file read, a short output): transforms leave it as it is. */
export interface VerbatimToolResult {
  readonly verbatim: true;
  readonly capped: string;
}

type ToolResultSink = (report: FullToolOutput | VerbatimToolResult) => void;

export function reportFullToolOutput(context: ToolExecutionContext | undefined, output: FullToolOutput): void {
  (context as { [TOOL_FULL_OUTPUT]?: ToolResultSink } | undefined)?.[TOOL_FULL_OUTPUT]?.(output);
}

export function reportVerbatimToolResult(context: ToolExecutionContext | undefined, capped: string): void {
  (context as { [TOOL_FULL_OUTPUT]?: ToolResultSink } | undefined)?.[TOOL_FULL_OUTPUT]?.({ verbatim: true, capped });
}

/** At most `maxBytes` of `text` from its head or tail, then `marker`, which counts toward it. */
export function capUtf8(text: string, maxBytes: number, direction: "head" | "tail", marker: string): string {
  const encoded = new TextEncoder().encode(text);
  const keep = Math.max(0, maxBytes - new TextEncoder().encode(marker).byteLength);
  const preview = direction === "head"
    ? encoded.subarray(0, keep)
    : encoded.subarray(Math.max(0, encoded.byteLength - keep));
  return `${new TextDecoder().decode(preview)}${marker}`;
}

/** Invoke one SDK-created tool without its public result validator. */
export function executeRawTool(
  definition: ToolDefinition,
  input: unknown,
  signal?: AbortSignal,
  context?: ToolExecutionContext,
): Promise<unknown> {
  const candidate = Reflect.get(definition, TOOL_RAW_EXECUTE) as unknown;
  const execute = typeof candidate === "function"
    ? candidate as RawExecute
    : definition.execute as RawExecute;
  return Promise.resolve(Reflect.apply(execute, undefined, [input, signal, context]));
}

/**
 * Snapshot, validate, and serialize one raw tool result. Returned bytes and
 * value derive from the same immutable JSON value; `toJSON`, getters, custom
 * prototypes, and mutation after validation cannot change model-visible data.
 */
export async function settleToolOutput(
  definition: ToolDefinition,
  rawValue: unknown,
): Promise<SettledToolOutput> {
  const mismatch = () => new Error(`cave_tool_output_schema_mismatch:${definition.name}`);
  const standard = Reflect.get(definition, TOOL_STANDARD_OUTPUT) as unknown;
  if (definition.output === undefined && standard === undefined) {
    let text: string;
    try {
      text = typeof rawValue === "string"
        ? rawValue
        : Reflect.apply(INTRINSIC_JSON_STRINGIFY, JSON, [rawValue]) ?? "null";
    } catch {
      throw new Error(`cave_tool_result_not_json_safe:${definition.name}`);
    }
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > MAX_OUTPUT_BYTES) {
      throw new Error(`cave_tool_result_limit:${definition.name}`);
    }
    return Object.freeze({ value: rawValue, text, bytes });
  }

  let value: unknown;
  if (standard !== undefined) {
    try {
      const transformed = await validateCapturedStandardSchema(
        standard,
        rawValue,
        `cave_tool_output_schema_mismatch:${definition.name}`,
      );
      value = snapshotJSON(transformed);
    } catch {
      throw mismatch();
    }
  } else {
    try {
      value = snapshotJSON(rawValue);
      if (!Value.Check(definition.output!, value)) throw mismatch();
    } catch {
      throw mismatch();
    }
  }

  let text: string;
  try {
    text = typeof value === "string" ? value : stringifyJSONSnapshot(value);
  } catch {
    throw mismatch();
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error(`cave_tool_result_limit:${definition.name}`);
  }
  return Object.freeze({ value, text, bytes });
}

/** Serialize a validated snapshot without consulting prototype `toJSON` hooks. */
function stringifyJSONSnapshot(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    return Reflect.apply(INTRINSIC_JSON_STRINGIFY, JSON, [value]) as string;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyJSONSnapshot(item)).join(",")}]`;
  }
  if (value === null || typeof value !== "object") throw new Error("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return `{${Object.keys(descriptors).map((key) => {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !("value" in descriptor)) throw new Error("invalid");
    const encodedKey = Reflect.apply(INTRINSIC_JSON_STRINGIFY, JSON, [key]) as string;
    return `${encodedKey}:${stringifyJSONSnapshot(descriptor.value)}`;
  }).join(",")}}`;
}

/** Schema-neutral worker transport snapshot. Parent performs validation once. */
export function snapshotToolOutputForTransport(
  value: unknown,
  name: string,
  declaredOutput: boolean,
): unknown {
  try {
    return snapshotJSON(value);
  } catch {
    if (declaredOutput) throw new Error(`cave_tool_output_schema_mismatch:${name}`);
    throw new Error(`cave_tool_result_not_json_safe:${name}`);
  }
}

/** Stable source projection for Standard Schema behavior folded into tool hash. */
export function standardSchemaImplementationSource(
  standard: CapturedStandardSchema,
): string {
  return [
    `standard-schema-v${standard.version}`,
    standard.vendor,
    Function.prototype.toString.call(standard.validate),
    standard.receiverState ?? "receiver-state:opaque",
    standard.converter === undefined
      ? ""
      : Function.prototype.toString.call(standard.converter),
  ].join("\n");
}

/** Canonical path/source projection for executable TypeBox schema leaves. */
export function executableSchemaImplementationSource(value: unknown): string {
  const seen = new Set<object>();
  const entries: string[] = [];
  let nodes = 0;
  const visit = (candidate: unknown, path: string, depth: number): void => {
    nodes += 1;
    if (nodes > 65_536 || depth > 64) {
      throw new Error("caveman agent: executable tool schema exceeds identity limits");
    }
    if (typeof candidate === "function") {
      entries.push(`${path}:${Function.prototype.toString.call(candidate)}`);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    if (seen.has(candidate)) {
      throw new Error("caveman agent: executable tool schema cannot be cyclic");
    }
    seen.add(candidate);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(descriptors)
        .filter((key): key is string => typeof key === "string")
        .sort();
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) continue;
        visit(descriptor.value, `${path}/${JSON.stringify(key)}`, depth + 1);
      }
    } finally {
      seen.delete(candidate);
    }
  };
  visit(value, "$", 0);
  return entries.join("\n");
}

/**
 * Locked and durable execution may only trust mutable/custom validator
 * semantics when caller supplied a stable content digest for those semantics.
 */
export function toolSchemaSemanticsVerified(definition: ToolDefinition): boolean {
  const dynamic = Reflect.get(definition, TOOL_STANDARD_SCHEMA) === true ||
    schemaContainsDynamicFormat(definition.input) ||
    (definition.output !== undefined && schemaContainsDynamicFormat(definition.output));
  return !dynamic || /^[0-9a-f]{64}$/.test(definition.schemaSemanticsSHA256 ?? "");
}

/** Validate through captured methods without exposing validator failures or accessors. */
export async function validateCapturedStandardSchema(
  candidate: unknown,
  value: unknown,
  failureCode: string,
): Promise<unknown> {
  const fail = () => new Error(failureCode);
  try {
    if (candidate === null || typeof candidate !== "object") throw fail();
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const receiverDescriptor = descriptors.receiver;
    const receiverStateDescriptor = descriptors.receiverState;
    const validateDescriptor = descriptors.validate;
    if (receiverDescriptor === undefined || !("value" in receiverDescriptor) ||
        receiverDescriptor.value === null || typeof receiverDescriptor.value !== "object" ||
        receiverStateDescriptor === undefined || !("value" in receiverStateDescriptor) ||
        (receiverStateDescriptor.value !== null && typeof receiverStateDescriptor.value !== "string") ||
        validateDescriptor === undefined || !("value" in validateDescriptor) ||
        typeof validateDescriptor.value !== "function") {
      throw fail();
    }
    if (typeof receiverStateDescriptor.value === "string" &&
        standardReceiverState(receiverDescriptor.value) !== receiverStateDescriptor.value) {
      throw fail();
    }
    if (capturedDataMethod(receiverDescriptor.value, "validate") !== validateDescriptor.value) {
      throw fail();
    }
    const result = await Reflect.apply(validateDescriptor.value, receiverDescriptor.value, [value]) as unknown;
    const resultDescriptors = result !== null && typeof result === "object"
      ? Object.getOwnPropertyDescriptors(result)
      : undefined;
    if (resultDescriptors === undefined) throw fail();
    const issues = resultDescriptors.issues;
    if (issues !== undefined && (!("value" in issues) || issues.value !== undefined)) {
      throw fail();
    }
    const transformed = resultDescriptors.value;
    if (transformed === undefined || !("value" in transformed)) throw fail();
    return transformed.value;
  } catch {
    throw fail();
  }
}

/** Capture plain data/function receiver state without invoking accessors. */
export function standardReceiverState(receiver: object): string | null {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > 4_096 || depth > 16) return null;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "string") {
      return Reflect.apply(INTRINSIC_JSON_STRINGIFY, JSON, [value]) as string;
    }
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number") {
      return Number.isFinite(value) ? `number:${Object.is(value, -0) ? "-0" : String(value)}` : null;
    }
    if (typeof value === "bigint") return `bigint:${value.toString()}`;
    if (typeof value === "function") return `function:${Function.prototype.toString.call(value)}`;
    if (typeof value !== "object" || seen.has(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) {
      return null;
    }
    seen.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Reflect.ownKeys(descriptors)
        .filter((key): key is string => typeof key === "string")
        .sort();
      if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) return null;
      const entries: string[] = [];
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor)) return null;
        const encoded = visit(descriptor.value, depth + 1);
        if (encoded === null) return null;
        const encodedKey = Reflect.apply(INTRINSIC_JSON_STRINGIFY, JSON, [key]) as string;
        entries.push(`${encodedKey}:${encoded}`);
      }
      return `${Array.isArray(value) ? "array" : "object"}{${entries.join(",")}}`;
    } finally {
      seen.delete(value);
    }
  };
  try {
    return visit(receiver, 0);
  } catch {
    return null;
  }
}

function capturedDataMethod(receiver: object, name: string): unknown {
  let current: object | null = receiver;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

function snapshotJSON(value: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  let bytes = 0;

  const visit = (candidate: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_OUTPUT_NODES || depth > MAX_OUTPUT_DEPTH) throw new Error("invalid");
    if (candidate === null || typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      bytes += Buffer.byteLength(candidate, "utf8");
      if (bytes > MAX_OUTPUT_BYTES) throw new Error("invalid");
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new Error("invalid");
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (typeof candidate !== "object") throw new Error("invalid");
    if (active.has(candidate)) throw new Error("invalid");
    active.add(candidate);
    try {
      const prototype = Object.getPrototypeOf(candidate);
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) throw new Error("invalid");

      if (Array.isArray(candidate)) {
        if (prototype !== Array.prototype && prototype !== null) throw new Error("invalid");
        const lengthDescriptor = descriptors.length;
        const length = lengthDescriptor?.value;
        if (lengthDescriptor === undefined || lengthDescriptor.enumerable ||
            !("value" in lengthDescriptor) || !Number.isSafeInteger(length) || length < 0 ||
            keys.length !== length + 1) {
          throw new Error("invalid");
        }
        const output: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            throw new Error("invalid");
          }
          output.push(visit(descriptor.value, depth + 1));
        }
        return Object.freeze(output);
      }

      if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid");
      const output: Record<string, unknown> = {};
      for (const key of keys as string[]) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw new Error("invalid");
        }
        bytes += Buffer.byteLength(key, "utf8");
        if (bytes > MAX_OUTPUT_BYTES) throw new Error("invalid");
        Object.defineProperty(output, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(output);
    } finally {
      active.delete(candidate);
    }
  };

  return visit(value, 0);
}

function schemaContainsDynamicFormat(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "function") return true;
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") continue;
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) continue;
      if (key === "format" && typeof descriptor.value === "string") return true;
      if (schemaContainsDynamicFormat(descriptor.value, seen)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

/**
 * Script-facing companions of one trusted tool. Programmatic cells call
 * `script` instead (same name and input, structured result), and spill
 * oversized cell output through `retain` into the store that `reader` pages.
 */
export interface ToolScriptCompanions {
  readonly script?: ToolDefinition;
  readonly retain?: (label: string, text: string, complete: boolean) => string | undefined;
  readonly reader?: ToolDefinition;
}

const TOOL_SCRIPT_COMPANIONS = new WeakMap<ToolDefinition, ToolScriptCompanions>();

export function setToolScriptCompanions(
  definition: ToolDefinition,
  companions: ToolScriptCompanions,
): void {
  const script = companions.script;
  if (script !== undefined && (script.name !== definition.name || script.effect !== definition.effect ||
      script.speculative !== definition.speculative ||
      JSON.stringify(script.input) !== JSON.stringify(definition.input))) {
    throw new Error(`cave_tool_script_companion_invalid:${definition.name}`);
  }
  TOOL_SCRIPT_COMPANIONS.set(definition, Object.freeze({ ...companions }));
}

export function toolScriptCompanions(definition: ToolDefinition): ToolScriptCompanions | undefined {
  return TOOL_SCRIPT_COMPANIONS.get(definition);
}
