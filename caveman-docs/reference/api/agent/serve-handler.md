# `@caveman-ai/agent/serve-handler`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/serve-handler.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AgentHandler`, `AgentHandlerOptions`, `Principal`, `RecoveryReport`, `WebSocketLike`
- **Function**: `createAgentHandler`
- **Variable**: `INSTANCE_LOCK_RUN_ID`

</details>

## Interfaces

### `AgentHandler`

```ts
export interface AgentHandler {
    fetch(request: Request): Promise<Response>;
    recover(): Promise<RecoveryReport>;
    nextWakeAt(): Promise<Date | undefined>;
    close(graceMs?: number): Promise<void>;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

### `AgentHandlerOptions`

```ts
export interface AgentHandlerOptions extends Omit<AgentServerOptions, "runOptions"> {
    /**
     * Resolve a request to the principal making it, or `undefined` to reject it.
     *
     * The SDK does not own identity: verify a JWT, an mTLS peer, or a session
     * cookie however the deployment already does, and return who it belongs to.
     * What the SDK does own is what follows — sessions are namespaced per
     * principal, so one principal cannot read, steer, or delete another's.
     *
     * Supplying this replaces `token`, which is the single-principal shorthand.
     */
    authenticate?: (request: Request) => Promise<Principal | undefined> | Principal | undefined;
    /** Per-run options; controllers, signals, conversations, and durability are handler-owned. */
    /**
     * Per-run options. `principal` is the authenticated caller that started the
     * run (only under `authenticate`); it is absent for runs re-driven by boot
     * recovery, whose caller identity the journal does not carry.
     */
    runOptions?: (context: {
        sessionId: string;
        runId: string;
        principal?: Principal;
    }) => Omit<RunOptions, "durable" | "controller" | "signal" | "conversation">;
    /** Host-owned WebSocket upgrade (Cloudflare WebSocketPair, Deno, Bun, or Node ws wrapper). */
    upgrade?: (request: Request) => {
        response: Response;
        socket: WebSocketLike;
    } | undefined;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

### `Principal`

Who a request belongs to. `id` is the isolation boundary.

```ts
export interface Principal {
    readonly id: string;
    /** Carried for host logging and policy; the SDK isolates on `id` alone. */
    readonly tenant?: string;
}
```

Declared in `packages/agent/dist/serve-session.d.ts`.

### `RecoveryReport`

```ts
export interface RecoveryReport {
    readonly listable: boolean;
    readonly resumed: readonly string[];
    readonly sleeping: ReadonlyArray<{
        readonly runId: string;
        readonly wakeAt: string;
    }>;
    readonly skipped: ReadonlyArray<{
        readonly runId: string;
        readonly reason: string;
    }>;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

### `WebSocketLike`

```ts
export interface WebSocketLike {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "message" | "close" | "error", fn: (event: {
        data?: unknown;
    }) => void): void;
}
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

## Functions

### `createAgentHandler`

```ts
export declare function createAgentHandler(options: AgentHandlerOptions): AgentHandler;
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

## Variables & constants

### `INSTANCE_LOCK_RUN_ID`

Run id reserved for the instance lease in `serve.ts`. It is a lock, not a
journal, so it is filtered out of every sweep rather than being reported as a
corrupt run.

```ts
export declare const INSTANCE_LOCK_RUN_ID = "caveman.instance.lock";
```

Declared in `packages/agent/dist/serve-handler.d.ts`.

