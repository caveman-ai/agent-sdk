# `@caveman-ai/agent/serve`

> Generated from the built type declarations by `node scripts/generate-docs-api.mjs`.
> Do not edit by hand. Version at generation time: `0.2.0`.

Declaration file: `packages/agent/dist/serve.d.ts`.

<details><summary>Symbol index</summary>

- **Interface**: `AgentServer`, `AgentServerOptions`, `RecoveryReport`
- **Function**: `createAgentServer`

</details>

## Interfaces

### `AgentServer`

```ts
export interface AgentServer {
    readonly server: Server;
    listen(port: number, host?: string): Promise<number>;
    recover(): Promise<RecoveryReport>;
    nextWakeAt(): Promise<Date | undefined>;
    close(graceMs?: number): Promise<void>;
}
```

Declared in `packages/agent/dist/serve.d.ts`.

### `AgentServerOptions`

```ts
export interface AgentServerOptions {
    definition: AgentDefinition;
    /** Single-principal shorthand. Optional when `authenticate` is supplied. */
    token?: string;
    /** See {@link AgentHandlerOptions.authenticate}. Namespaces sessions per principal. */
    authenticate?: AgentHandlerOptions["authenticate"];
    store?: DurableStore;
    rootDir?: string;
    build?: AnyCaveBuildLock;
    /** Existing object form, or factory producing isolated per-run options. */
    runOptions?: Omit<RunOptions, "durable"> | PerRunOptionsFactory;
    maxConcurrentRuns?: number;
    maxQueuedRuns?: number;
    maxBodyBytes?: number;
    /**
     * Refuse to start while another instance is live against the same store.
     * Default `true`.
     *
     * Sessions, their replay buffers, and their deletion tombstones are held in
     * this process, so two instances sharing one store do not share them: the
     * same session id can be driven from both with neither seeing the other's
     * messages. Run journals are individually leased and stay safe; session state
     * is what diverges. Until session ownership is itself durable, one active
     * instance is the supported deployment, and this makes that a loud refusal at
     * startup rather than a quiet split brain in production.
     *
     * The lease expires, so a crashed instance is taken over by the next one:
     * active/standby works, active/active does not. Set `false` only for a
     * deployment that never addresses one session from two instances.
     */
    singleInstance?: boolean;
}
```

Declared in `packages/agent/dist/serve.d.ts`.

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

## Functions

### `createAgentServer`

```ts
export declare function createAgentServer(options: AgentServerOptions): AgentServer;
```

Declared in `packages/agent/dist/serve.d.ts`.

