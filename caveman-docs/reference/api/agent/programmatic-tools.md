# `@caveman-ai/agent/programmatic-tools`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/programmatic-tools.d.ts`.

<details><summary>Symbol index</summary>

- **Class**: `ProgrammaticSpeculationScope`
- **Interface**: `ProgrammaticSpeculationActivation`, `ProgrammaticSpeculationLaunch`, `ProgrammaticToolInstructionOptions`, `ProgrammaticToolNamespace`, `ProgrammaticToolRuntime`, `ProgrammaticToolStats`
- **Type alias**: `ProgrammaticCellGate`, `ProgrammaticSpeculationDispatch`
- **Function**: `createProgrammaticToolErrorWrapper`, `createProgrammaticToolRuntime`, `programmaticToolInstructions`, `programmaticToolMetadata`
- **Variable**: `PROGRAMMATIC_TOOL_NAME`

</details>

## Classes

### `ProgrammaticSpeculationScope`

One run's speculation state. It never outlives run(), and claim identity is
the conjunction of run scope, provider stream turn, final message object,
final provider tool-call ID, and source bytes.

```ts
export declare class ProgrammaticSpeculationScope {
    readonly runId: string;
    readonly parent: ToolDefinition;
    readonly metadata: ProgrammaticMetadata;
    readonly dispatch: ProgrammaticSpeculationDispatch;
    readonly onAbandoned: ((provisionalParentToolCallId: string) => void) | undefined;
    readonly turns: Set<KernelSpeculationTurn>;
    readonly turnsByMessage: WeakMap<object, KernelSpeculationTurn>;
    readonly activeByParent: Map<string, KernelSpeculativeCell>;
    turnSequence: number;
    closed: boolean;
    closePromise: Promise<void> | undefined;
    settlementError: Error | undefined;
    constructor(runId: string, parent: ToolDefinition, dispatch: ProgrammaticSpeculationDispatch, onAbandoned?: (provisionalParentToolCallId: string) => void);
    wrapStream(source: AssistantMessageEventStream): AssistantMessageEventStream;
    activate(parentToolCallId: string, assistantMessage: AssistantMessage, code: unknown): ProgrammaticSpeculationActivation | undefined;
    claim(parentToolCallId: string, name: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<unknown> | undefined;
    finish(parentToolCallId: string): Promise<void>;
    settleBeforeNextStream(): Promise<void>;
    close(): Promise<void>;
    private settleAndClose;
    forget(turn: KernelSpeculationTurn): void;
    recordSettlementError(error: unknown): void;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

## Interfaces

### `ProgrammaticSpeculationActivation`

```ts
export interface ProgrammaticSpeculationActivation {
    readonly provisionalParentToolCallId: string;
    readonly turnKey: object;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticSpeculationLaunch`

```ts
export interface ProgrammaticSpeculationLaunch {
    readonly parentToolCallId: string;
    readonly turnKey: object;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly signal: AbortSignal;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticToolInstructionOptions`

```ts
export interface ProgrammaticToolInstructionOptions {
    /** Provider-visible composite tool name. Defaults to `caveman_code`. */
    readonly toolName?: string;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticToolNamespace`

Groups late-registered tools for `describeNamespace()` and search filters.

```ts
export interface ProgrammaticToolNamespace {
    readonly name: string;
    readonly description?: string;
    /** Longer guidance (for example tool-server instructions), returned only by `describeNamespace()`. */
    readonly instructions?: string;
}
```

Declared in `packages/agent/dist/programmatic-catalog.d.ts`.

### `ProgrammaticToolRuntime`

```ts
export interface ProgrammaticToolRuntime {
    readonly definition: AgentDefinition;
    wrapModels(models: Models): Models;
    wrapStreamFn(streamFn: StreamFn): StreamFn;
    stats(): ProgrammaticToolStats;
    /**
     * Make more trusted tools callable from the next cell as `tools.<name>`,
     * found through `searchTools`/`describeTool`/`describeNamespace`. The code
     * tool's provider-visible description never changes, so the cache prefix
     * stays byte-stable while tool servers connect.
     */
    registerNestedTools(tools: readonly ToolDefinition[], namespace?: ProgrammaticToolNamespace): void;
    /** Await `gate(code)` before each cell, e.g. so servers a cell names can finish connecting. */
    setCellGate(gate: ProgrammaticCellGate | undefined): void;
    close(): void;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticToolStats`

```ts
export interface ProgrammaticToolStats {
    readonly launched: number;
    readonly claimed: number;
    readonly missed: number;
    readonly abandoned: number;
}
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

## Type aliases

### `ProgrammaticCellGate`

Runs before each cell; must bound its own wait and honor `signal`.

```ts
export type ProgrammaticCellGate = (code: string, signal: AbortSignal | undefined) => Promise<void>;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `ProgrammaticSpeculationDispatch`

```ts
export type ProgrammaticSpeculationDispatch = (launch: ProgrammaticSpeculationLaunch) => Promise<unknown>;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

## Functions

### `createProgrammaticToolErrorWrapper`

```ts
export declare function createProgrammaticToolErrorWrapper<TInput, TResult>(source: ToolDefinition<TInput, TResult>, mapError: (error: unknown) => Error): ToolDefinition<TInput, TResult>;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `createProgrammaticToolRuntime`

```ts
export declare function createProgrammaticToolRuntime(directDefinition: AgentDefinition, options?: {
    readonly instructions?: string;
    readonly speculate?: boolean;
    readonly toolName?: string;
    /**
     * Hybrid mode: these tools stay declared to the provider beside the code
     * tool, and instructions stay as given. Cells can still call every tool.
     */
    readonly direct?: readonly string[];
}): ProgrammaticToolRuntime;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `programmaticToolInstructions`

```ts
export declare function programmaticToolInstructions(additional: string | undefined, options?: ProgrammaticToolInstructionOptions): string;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

### `programmaticToolMetadata`

Internal runtime hook. Metadata identity cannot be forged through JSON.

```ts
export declare function programmaticToolMetadata(definition: ToolDefinition): ProgrammaticMetadata | undefined;
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

## Variables & constants

### `PROGRAMMATIC_TOOL_NAME`

Provider-visible tool replacing an agent's ordinary tool surface in programmatic mode.

```ts
export declare const PROGRAMMATIC_TOOL_NAME = "caveman_code";
```

Declared in `packages/agent/dist/programmatic-tools.d.ts`.

