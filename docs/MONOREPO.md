# Monorepo boundaries

Caveman Agent SDK is one release-coordinated monorepo with independently
publishable product and adapter packages.

```text
packages/
├── agent/                         @caveman-ai/agent
├── adapter-kit/                   @caveman-ai/adapter-kit
├── adapters/
│   ├── pi/                        @caveman-ai/adapter-pi
│   ├── claude-agent-sdk/          @caveman-ai/adapter-claude-agent-sdk
│   ├── vercel-ai-sdk/             @caveman-ai/adapter-vercel-ai-sdk
│   ├── eve/                       @caveman-ai/adapter-eve
│   └── mastra/                    @caveman-ai/adapter-mastra
├── coding-agent/                  @caveman-ai/coding-agent
├── create-caveman-agent/          @caveman-ai/create-agent
├── react/                         @caveman-ai/react
└── pebble-protocol/               @pebble-agent/protocol (Apache-2.0)
```

## Ownership

`agent` owns framework-neutral execution, tools, budgets, breakers, receipts,
durability, Context IR, profile/eval/compiler, fail-closed accounting, and
optional Caveman Connect protocol client/policy. External `cave-connectd` owns
OAuth, credentials, encrypted storage, sync execution, and provider transport;
its proprietary implementation is not copied or bundled here.

`adapter-kit` owns adapter manifest schema, capability states, registry,
lifecycle validation, and reproducible conformance metadata. It imports no
framework and no Caveman runtime.

Each `adapters/*` package owns one upstream pin, binding entrypoint, capability
manifest, framework-specific documentation, and eventually its conformance
fixtures. Installing core must not install Vercel, Eve, or Mastra.

`coding-agent` owns coding UX, CLI, tools, session presentation, and coding
benchmarks. Core currently keeps `@caveman-ai/agent/code` as compatibility
implementation while this boundary stabilizes; no new consumer should use that
path.

`create-caveman-agent` owns project generation only.

`react` owns one browser client for the event stream `@caveman-ai/agent/serve`
emits, and nothing else: it holds no credential, opens no provider connection,
and interprets the frozen Pebble event shapes rather than defining them. Both
`useAgent` and `useSession` are token-free by construction — neither accepts a
token or an absolute origin, so both can only reach a same-origin path the host
app proxies with the bearer attached. It depends on `react` as a peer and on no
Caveman package at runtime, so installing core never installs React.

`pebble-protocol` owns only frozen public wire, event, and session contracts.
Pebble runtime, policy, sessions, TUI, distribution, and conformance code live
in a separate proprietary repository.

## Dependency direction

```text
adapter-kit <── adapter-* ──peer──> agent
                                  
coding-agent ──peer───────────────> agent
create-agent ──generated project──> agent
react ────────HTTP/SSE only───────> agent/serve
```

Core never imports adapter packages. Adapter packages may use documented core
contracts. Shared registry stays framework-neutral, preventing a circular
dependency and keeping optional upstream frameworks out of core installs.

Root npm installs may hoist dependencies. Required-sandbox workers enumerate
core's exact installed dependency closure and grant those package roots
individually; repository-root `node_modules` itself is never readable. This
keeps workspace installs compatible without exposing unrelated hoisted files.

## Capability truth

Every adapter declares all capabilities: `run`, `stream`, `tools`, `usage`,
`abort`, `durable`, and `compile`.

- `unsupported`: adapter does not provide capability.
- `experimental`: code path exists, but package conformance has not certified it.
- `certified`: matching conformance suite report digest exists in manifest.

Registry lookup returns metadata only. It never decides whether an adapter may
run. No manifest state changes savings basis: local results stay `inferred`,
and `verifiedSavingsUsd` remains zero.

## Adding an adapter

1. Add `packages/adapters/<id>` with one exact upstream peer pin.
2. Export `manifest`, `createAdapter`, and default adapter package definition.
3. Declare every capability; unknown support is `unsupported`, never guessed.
4. Add framework tests and conformance evidence before marking anything
   `certified`.
5. Run `npm test` and `npm run pack:check`. Pack discovery is automatic for
   every adapter directory containing `package.json`.

Compatibility exports under `@caveman-ai/agent/adapters`, `/claude`, and `/code`
exist only for migration. Framework-specific behavior moves outward; new
behavior must not deepen those compatibility paths.
