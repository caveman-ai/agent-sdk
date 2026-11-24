// Custom tools: the agent calls them, the caller's process runs them. The runtime exposes each one to the engine
// (one `client` MCP server per session) and pauses on `requires_action {kind: "tool"}` until the caller answers with
// `user.tool_result` (CONTRACT §3.5). A handler's errors go back to the agent as an error result, so it can recover.

import { CavemanError, type GateRisk } from "./types.ts";

export type JsonSchemaObject = Readonly<Record<string, unknown>>;

/** Caveman Gate approval policy attached directly to a tool declaration. */
export interface ToolGatePolicy {
  readonly action?: string;
  readonly risk?: GateRisk;
  readonly summary?: string | ((input: unknown) => string);
  /** Optional predicate; when false, this call runs without a gate. */
  readonly when?: (input: unknown) => boolean;
}

export interface ToolOptions {
  /** Require Caveman Gate human approval before executing this tool (fail-closed). */
  readonly gate?: boolean | ToolGatePolicy;
}

/**
 * A schema library's object that can render itself as JSON Schema (Standard JSON Schema) and validate input
 * (Standard Schema). zod, valibot and arktype ship both.
 */
interface StandardSchema<I> {
  readonly "~standard": {
    readonly validate: (value: unknown) => StandardResult<I> | Promise<StandardResult<I>>;
    readonly jsonSchema?: { readonly input: (options: { readonly target: string }) => Record<string, unknown> };
  };
}
type StandardResult<I> = { readonly value: I; readonly issues?: undefined } | { readonly issues: ReadonlyArray<{ readonly message: string; readonly path?: ReadonlyArray<unknown> }> };

export interface Tool<I = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  /** Optional Caveman Gate policy enforced before the tool handler runs. */
  readonly gate?: ToolGatePolicy;
  /** Validates and runs a call; what it returns is the text the agent reads. */
  readonly call: (input: unknown) => Promise<{ readonly content: string; readonly isError: boolean }>;
  /** The handler's own input type, for inference only. */
  readonly __input?: I;
}

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const isStandard = (schema: unknown): schema is StandardSchema<unknown> =>
  typeof schema === "object" && schema !== null && "~standard" in schema;

/**
 * Declares a tool the agent may call, run in this process.
 *
 * ```ts
 * const lookupInvoice = tool("lookup_invoice", "Find an invoice by id",
 *   { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
 *   async ({ id }: { id: string }) => db.invoices.get(id))
 * ```
 *
 * `schema` is a JSON Schema object, or a zod/valibot/arktype schema (validated before the handler runs). The
 * handler returns text, or any value (sent as JSON). Throwing sends the message back to the agent as an error.
 */
export function tool<I>(
  name: string,
  description: string,
  schema: JsonSchemaObject | StandardSchema<I>,
  handler: (input: I) => unknown | Promise<unknown>,
  options?: ToolOptions,
): Tool<I> {
  if (!TOOL_NAME.test(name) || name.startsWith("mcp__")) {
    throw new CavemanError("tool_name_invalid", `Tool name "${name}" must be letters, digits, _ and - (at most 64), start with a letter, and not start with mcp__.`);
  }
  let inputSchema: JsonSchemaObject;
  let validate: ((value: unknown) => Promise<StandardResult<I>>) | undefined;
  if (isStandard(schema)) {
    const render = schema["~standard"].jsonSchema?.input;
    if (render === undefined) {
      throw new CavemanError("tool_schema_unsupported", `Tool "${name}": this schema library cannot render JSON Schema; pass a JSON Schema object instead.`);
    }
    const { $schema: _drop, ...rendered } = render({ target: "draft-07" });
    inputSchema = rendered;
    validate = async (value) => (await schema["~standard"].validate(value)) as StandardResult<I>;
  } else {
    inputSchema = schema;
  }
  if ((inputSchema.type ?? "object") !== "object") {
    throw new CavemanError("tool_schema_invalid", `Tool "${name}" needs an object schema (type: object, with properties).`);
  }
  const gate: ToolGatePolicy | undefined =
    options?.gate === true
      ? { action: `tool.${name}`, risk: "high" }
      : options?.gate && typeof options.gate === "object"
        ? options.gate
        : undefined;
  return {
    name,
    description,
    inputSchema,
    ...(gate === undefined ? {} : { gate }),
    call: async (input) => {
      try {
        let value = input as I;
        if (validate !== undefined) {
          const checked = await validate(input);
          if (checked.issues !== undefined) {
            const why = checked.issues.map((issue) => (issue.path?.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message)).join("; ");
            return { content: `Invalid input for ${name}: ${why}`, isError: true };
          }
          value = checked.value;
        }
        const out = await handler(value);
        return { content: typeof out === "string" ? out : out === undefined ? "" : JSON.stringify(out), isError: false };
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true };
      }
    },
  };
}
