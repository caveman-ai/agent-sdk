# Licensing

The entire repository is Apache-2.0. Root `LICENSE` governs every path, and
every shipped npm package carries its own copy of the license text.
`npm run license:check` enforces this map and rejects proprietary package
classifications.

## Per-Directory License

| Path | License | Notes |
|---|---|---|
| `packages/pebble-protocol/` | Apache-2.0 | Open protocol: events, ACP wire, and session schema. |
| `packages/adapter-kit/` | Apache-2.0 | Contract only — public interfaces/types for framework adapters. |
| `packages/adapter-conformance/` | Apache-2.0 | Deterministic adapter conformance runner and report contract. |
| `packages/agent/` | Apache-2.0 | Agent runtime, compiler, and compatibility exports. |
| `packages/coding-agent/` | Apache-2.0 | Coding-agent API and CLI. |
| `packages/create-caveman-agent/` | Apache-2.0 | Project initializer. |
| `packages/evals/` | Apache-2.0 | Canonical fail-closed grader taxonomy and implementations. |
| `packages/react/` | Apache-2.0 | React client for the agent server's event stream. |
| `packages/adapters/` | Apache-2.0 | Framework adapters and all subdirectories. |

Unlisted paths inherit the root Apache-2.0 license. Third-party dependencies
remain under their own terms.

## Third-party runtime notices

`@caveman-ai/agent` depends on `@earendil-works/pi-mcp` 1.0.0 (MIT,
Copyright (c) 2025 Mario Zechner), which ships MIT-licensed code adapted from
the Model Context Protocol TypeScript SDK (Copyright (c) 2024 Anthropic, PBC;
see its `LICENSES/` directory), and on its one dependency `cross-spawn` 7.0.6
(MIT, Copyright (c) 2018 Made With MOXY Lda) with `which` and `isexe` (ISC),
`path-key`, `shebang-command`, and `shebang-regex` (MIT). Proprietary Pebble product implementation lives
only in private sibling repository `caveman-coding-agent` under commercial
terms and must not be copied here.
