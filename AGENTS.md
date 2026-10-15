# Caveman Agent SDK

## Scope

Standalone TypeScript repository for `@caveman-ai/agent` and
`@caveman-ai/create-agent`.

Repository is private during development. Planned destination is public release
after licensing, history, packaging, test, and publication gates pass.
Caveman-Cloud remains private commercial source.
Proprietary Pebble implementation lives in sibling `caveman-coding-agent` and
must never land here. Only Apache-2.0 protocol remains in this repository.

## Non-negotiable contracts

- Savings stay `inferred`; never mint or imply verified savings locally.
- Unknown model, pricing, usage, grader, runtime, or sandbox state fails closed.
- Observe-only paths never claim optimization.
- Provider-visible cache prefixes stay byte-stable inside one cache epoch.
- Tool and subprocess environments use explicit allowlists, never ambient secret
  inheritance.
- Host sandbox means uncontained host execution. Never describe it as isolation.
- Generated `packages/agent/src/catalog.ts` changes only through
  `node scripts/generate-agent-catalog.mjs`.
- Canonical GitHub repository is `JuliusBrussee/agent-sdk`.
- Optional Agent Skills and Agent Plugins compatibility lives once
  in `packages/agent/src/agent-environment.ts`. Core runtime never discovers
  workspace files automatically. Product wrappers may add search roots, but
  must not fork validation, containment, precedence, or invocation.
- Never rebuild what exact-pinned Pi already provides. Pi owns the tool loop
  and its lifecycle hooks (`beforeToolCall`, `afterToolCall`,
  `finishTurn`, `prepareRequest`, post-turn message injection, `transformContext`), the
  steering and follow-up queues, and the event stream. Before adding any runtime
  capability, read
  `node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` and state which
  Pi surface was checked. Consuming a Pi hook to enforce an invariant Pi does
  not have — budget holds, breakers, deadlines, durable journaling — is the
  product. Re-exposing a Pi surface under a Caveman name is duplication and is
  refused: it doubles the maintenance and pins us to a second contract that
  drifts from the one we exact-pin.
- Agent Plugins v1 and OpenPlugin support is declarative-only: skills and
  markdown slash commands. Plugin loading parses MCP and recognizes hooks and
  custom agents, but never executes them. MCP servers launch only when a host
  passes explicit entries to `McpHost` (`packages/agent/src/mcp.ts`): stdio with
  `inheritEnv: false` and the coding env allowlist plus the entry's own `env`,
  tools nested in the code tool (never declared), never retried or speculated.

## Checks

```bash
npm ci
npm --prefix packages/pebble-protocol run build
npm ci --prefix examples/coding-agent --ignore-scripts
npm test
npm run license:check
npm run pack:check
```

Two of the checks inside `npm test` are ratchets. They fail on purpose and are
resolved by shrinking, not by widening:

- `npm run check:api` — `packages/agent/api-surface.txt` is the published type
  surface of `@caveman-ai/agent`. Adding, removing, or renaming a reachable
  export fails until you run `npm run api:update` and justify the diff. See
  `docs/RELEASING.md` for what counts as breaking.
- `npm run check:size` — `size-budget.json` caps source-file line counts. Growing
  a file past its budget fails until you split it or run
  `node scripts/size-budget.mjs --update` and justify the diff.

`npm run check:drift` (weekly in CI, not in `npm test`) reports exact-pinned
upstreams that have moved. It needs network access.

On restricted hosts, rerun macOS `sandbox-exec` and loopback-dependent tests with
required permissions before classifying failures as product defects.

<!-- caveman-blocks:start -->
BLOCKS. Scripts in this repo are reusable blocks in .blocks/. Rules:
1. Check the block index below first. If a block fits, run it. If one almost fits, add a param to it.
2. A script you would run twice, or over ~10 lines, becomes a block, not a heredoc or a /tmp file.
3. Inputs are params. No hardcoded paths, ids, ports or dates.
4. Print one small JSON object: the answer, not the data. Filter, count and truncate in code.
5. Exit 0 on success, non-zero with {"error": ...} on failure.
6. Safe to re-run: idempotent, no prompts, cleans up after itself.
7. Header first: name, summary, params, effects, example. caveman-blocks lint checks it.
8. Compose: call existing blocks with caveman-blocks run instead of copying their code.

first-error   --path <path> [--context 5] [--patterns …] First error line in a log file: its line number,…
grep-defs     --path <path> [--kinds …]         Function, class, type and constant definitions in a file or…
json-peek     --path <path> [--depth 2]         Shape of a JSON or JSONL file: keys, row count, one sample.…
jsonl-stats   --path <path> --group-by <str> [--sum ""] [--top 10] Row count plus counts and sums grouped by…
replace-in-file --path <path> --old <str> --new <str> [--count 1] [--dry-run] Replace exact text in a file,…
test-summary  --cmd <str> [--timeout 300]       Run a test command; return pass/fail counts, the first…
wait-for      --path <path> [--pattern ""] [--timeout 60] [--interval 2] Wait until a file exists,…
<!-- caveman-blocks:end -->
