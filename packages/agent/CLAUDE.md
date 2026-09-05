# packages/agent

> **Repository routing:** this repository is the source of truth for
> `@caveman-ai/agent`. Agent SDK product work lands here first and is mirrored
> out deliberately; other checkouts carry integration copies only.

> **Monorepo boundary:** `packages/agent` owns framework-neutral runtime and
> compiler behavior. `packages/adapter-kit` owns registry/conformance contracts,
> `packages/adapters/*` own upstream framework pins and bindings, and
> `packages/coding-agent` owns coding product UX. `src/adapters.ts`,
> `src/claude.ts`, and `src/code.ts` are compatibility implementation seams;
> do not add new framework/product surface there when it can live in its package.

`@caveman-ai/agent`: opinionated TypeScript efficiency framework over exact-pinned
Pi. Pi is a complete agent core and this package never rebuilds it: Pi owns
the tool loop, its lifecycle hooks (`beforeToolCall`, `afterToolCall`,
`shouldStopAfterTurn`, post-turn injection, `transformContext`), the steering
and follow-up queues, and the event stream — read
`node_modules/@earendil-works/pi-agent-core/dist/types.d.ts` before adding any
runtime capability. `runtime.ts` CONSUMES those hooks to enforce what Pi has no
opinion about (budget reserve/settle, breakers, deadlines, durable journaling);
that enforcement is the product. A parallel Caveman-named re-export of a Pi
surface is not, and is refused. The seams this package does own point OUTWARD at
frameworks it does not control (`src/wire.ts`, `src/model-boundary.ts`), never
inward at Pi. `src/runtime.ts` owns agent execution, cache safety, tool isolation, runtime
supervision, and content-blind evidence. Loopback runtime readiness requires
health identity plus proxy-validated run-state/PID/executable ownership.
`src/build.ts` owns finite candidate search, eval-complete selection, immutable
lock, and drift checks.

2026-08-11 compiler boundary: v0.2 is reference/non-release with one narrow
executable target, not complete whole-agent optimization.
`src/trajectory-ir.ts`, `src/profile.ts`, and `src/compiler.ts` own the additive
profile-guided v3 path: profile/development/untouched-holdout separation, strict
catalog repricing, baseline pointer, and target-specific proof artifact.
Exact first-party Pi 0.2.0 / upstream 0.83.0 / `tool-free-v1` owns candidate
generation and development/holdout execution through `runAgentInternal`. It may
select model, lower reasoning, add reversible Context IR routes/recovery, and
lower output budget. Any root tool (including subagent) refuses before runner
spend. Generic/custom Pi and Vercel/Eve/Mastra selected plans equal baseline,
capability arrays are empty, and only `profile_guided_selection` is present.
Every error aborts.

Existing `build` CLI selects v3 when evals declare split roles: strict
content-blind traces under `.caveman/traces/` supply optional profile evidence;
otherwise profile evals bootstrap it. Generic OpenTelemetry/OpenInference spans
always stay unpriced. It writes profile/report before atomic lock commit.
The CLI uses the exact native lane and can emit its closed behavioral plan.
Generic/custom Pi, Vercel AI SDK, Eve, and Mastra v3 selected plans equal
baseline, advertise empty capabilities, and abort on every error. Claude Cave
Build compile/Cloud register refuse. Baseline pointer is manual for every lane.
Local compile/execution/compression is accountless per ADR 0031; evidence stays
`inferred`, Cloud registration is client-declared inspection, and verified
savings stay zero. Build/compiler/contract hashes are unsigned integrity
bindings, not binary provenance, signature, SBOM, or runtime attestation.
Binding architecture and
completion gates:
`docs/strategy/agent-compiler/`. v2 locks stay readable.
Build lock Context IR contains static definition segments only. Eval/user input,
history, and tool results are runtime segments and never enter lock digest.
Conversation handles are opaque, process-local, transactional, single-owner,
and bind cache epoch to agent/model/full-plan/prefix fingerprint. Stream close
aborts and settles provider/tool/subagent execution before releasing ownership.
Dev reuses one immutable staged project-relative source graph until watched
project inputs change. Definition, sandboxed tools, nested file sources, and
lock identity use same snapshot. Reload preserves parent-owned conversation.
Programmatic required-sandbox runs create per-run immutable copy of complete
source graph before provider traffic and import tool workers only from copy.
Keep module top level side-effect-free: Node ESM cannot tear down old graph
timers/listeners after hot reload; restart when editing resource-owning modules.
Nested normal tools use private root-relative agent paths, root/leaf definition
digests, recursive graph validation, ancestor-shared pre-spend ledgers, and
process-group sandbox teardown. Required sandbox policy propagates down graph;
each reserved turn needs complete usage and exact provider/model identity.
Third sandbox mode `host` is explicit opt-in for interactive/coding agents whose
tools need real host access: closures run in-process with no worker and no
`entryPath`, and `effect: "write"` executes instead of being blocked, while
effect declaration stays mandatory. Host mode under a required ancestor fails
closed (`cave_host_sandbox_nested_under_required`) so a subagent cannot escape
root containment. Live host runs are lock-ineligible (EAB-101): `compile` throws
`cave_host_sandbox_lock_ineligible` before any search run for host mode ANYWHERE
in the definition graph — root or subagent, since a host subagent runs closures
in this process just as a host root does — and locked builds for coding agents
compile against fixture corpora (EAB-112) under a contained mode.
Optional `RunOptions.maxCostUsd` seeds one root ledger into that same ancestor
chain, so root turns reserve against it too. It is a best-effort public-catalog
cap (EAB-102), not financial enforcement; exhaustion ends the run with
`cave_run_cost_budget_exceeded` before the next model call, and a model the
catalog cannot price fails closed instead of consuming $0 of budget.
Cold machines degrade instead of failing: when the loopback gateway cannot be
reached (or `RunOptions.cave: "off"` is set), the run keeps the provider's own
base URL, applies no transform, sends no Caveman account key, and reports
`RunResult.mode: "observe-only"`. `ensureRuntime: false` skips loopback startup
and probing because the caller manages that runtime; it never bypasses HTTPS and
gateway-identity verification for a non-loopback URL.
Concurrent cold runs coalesce by gateway URL onto one readiness/start attempt;
the completed positive or negative result is then cached for five seconds.
Caller-supplied fetch transports bypass both shared states.
Route resolution is not routing: the gateway proxies only `anthropic`, `openai`,
and `google`, so every other Pi provider (xai, groq, bedrock, openrouter…) keeps
its own base URL even on a reachable gateway. Actual routing is the source of
truth for both honesty questions — a request that does not go through the
gateway carries NO `x-cave-*` header at all (the account key is a credential;
agent/workflow/session/cache-epoch/prefix-digest/context-bill/build+plan digests
are account-linked identifiers), and `mode` is `observe-only`. Mixed graphs
under-claim: one subagent call off the gateway makes the whole run
`observe-only`.
Gateway-routed Pi runs carry one framework-owned 32-hex trace id. Every root or
child agent invocation gets a distinct 16-hex span id; provider requests name
the current invocation through `x-cave-parent-span-id`, and child invocation
spans share their parent invocation. With a route-time `CAVE_API_KEY`, children
append only identity, timing, depth, and status metadata to one bounded
root-owned batch; after descendants settle, the root defers exactly one
best-effort OTLP/JSON request. Prompt, message, tool, result, and error content
never enter that payload. Each child `invoke_agent` span also carries a bounded
`cave.guard.*` manifest describing the controls effective at admission: only
fixed categorical states for child call/spend/context, depth, root budget,
per-turn fan-out, and total model/tool calls. It contains no thresholds, tool
names, prompt/content, or spend. Its basis is `client_runtime_declared`: useful
for advisory coverage and avoiding redundant proposals, never platform
attestation, verified enforcement, or a reason to suppress a finding. Missing
or ambiguous state is `unknown`, never inferred as unprotected. The immutable
route-time key and root agent/workflow/session labels propagate through children;
account-less local routing keeps request correlation headers but sends no
unauthenticated OTLP request. The batch labels its delivery basis
`attempted_unconfirmed`: HTTP
acceptance is deliberately not awaited or surfaced, and export failure never
changes paid execution, so Cloud detector coverage is measured and may
honestly be zero.
After every descendant settles, the root `invoke_agent` span emits four closed
integer outcome attributes outside the guard manifest:
`cave.agent.tree.admitted_descendants`,
`cave.agent.tree.peak_active_descendants`,
`cave.agent.tree.invocation_limit_rejections`, and
`cave.agent.tree.concurrency_limit_rejections`. They are exact root-ledger
outcomes, including admitted children whose individual span was dropped by the
1,024-span batch ceiling. They appear only on the root span and are zero when
no child was admitted. They never contain configured cap magnitudes, content,
task text, tool names, or error text, and do not change guard-manifest v2.
Per-tool child-call counters, per-run model/tool counters, and breaker state
still restart in every child; `maxCalls`, `maxSubagentDepth`, and the per-turn
breaker are not tree-width contracts. Callers that need a root-tree bound may
opt into `RunOptions.maxSubagentInvocations` (monotonic admissions across all
tools and depths) and/or `maxConcurrentSubagents` (simultaneously active
descendants). Descendants inherit one mutable root ledger; reservation is
synchronous, and active capacity is released after success, error, or abort.
Depth and wallet rejections happen before admission and consume no tree slot.
Leaving both options unset preserves the prior behavior. New child spans emit
strict guard-manifest v2: `tree_invocations` and `tree_concurrency` are each
only `active` or `absent`, derived from whether the root option was supplied.
The manifest never exports either numeric value and remains client-declared,
not enforcement attestation. Historical v1 stays valid only when both v2-only
keys are absent and cannot describe either tree control; malformed, missing, or
unknown v2 states are invalid rather than inferred.
A run carrying a locked build or candidate plan never degrades silently and
throws `cave_gateway_required_for_locked_plan`. Nested runs inherit the parent's
resolved route instead of re-probing. `doctor` treats a missing engine, missing
runtime CLI, or unreachable gateway as WARN with exit 0 and reports
`execution_mode`; locked-execution readiness stays false in that state.
Child-process permission fails closed without portable descendant containment.
`cave_` tool names are framework-reserved.
Public `RunOptions` excludes nested routing/recursion and compiled plan/build
identity. Only package-internal compiler/CLI path may execute validated plans.

Public entry points:

- `src/index.ts` and `src/primitives.ts` — builder API;
- `src/build.ts` — compiler API;
- `src/compiler.ts` — generic baseline-only `compileProfiled` plus owned
  `compileProfiledNativePi`, development selection, untouched holdout, exact
  diff-derived semantics/passes, and Cave Build v3 assembly. Native callers
  cannot inject candidates, runners, or target identity;
- `src/compile-runner.ts` — native Pi behavioral eval execution through
  `runAgentInternal`, provider/catalog evidence, graders, sandbox profiles, and
  content-blind privacy proof;
- `src/execution-kernel.ts` — locked harness/plan/Context-IR preparation,
  shared agent-to-Context-IR lowering, selected model/reasoning enforcement,
  provider usage validation, and public catalog cost finalization shared by Pi
  runtime, compiler, checker, and adapter boundary. Reasoning-breakdown
  availability stays separate from aggregate usage; locked/nested evidence
  rejects a missing split from reasoning-capable models;
- `src/runtime-identity.ts` — single source for framework, Pi adapter, and
  exact-pinned upstream versions used by compiler, checker, and runtime,
  including the digest-bound `tool-free-v1` native compiler contract;
- `src/catalog.ts` — GENERATED from
  `public/shared/provider-catalog/catalog/current.yaml` by
  `scripts/generate-agent-catalog.mjs`; never hand-edit it and never hand-type a
  price. It carries every USD row the catalog prices region-agnostically
  (`region: global`) and omits regional-only rows rather than borrowing one
  region's rate. `CATALOG_SHA256` is the sha256 of those exact catalog bytes and
  is stamped into lock evidence; `tests/catalog.drift.runtime.mjs` fails until
  the generator is re-run after a catalog edit. `RunResult.priceBasis` labels
  whether `costUsd` came from that catalog or is an honest zero;
- `src/source-graph.ts` — strict project/workspace dependency graph plus opaque
  installed-package artifact closure. It uses `es-module-lexer` for ESM and
  narrow comment-aware scanners for TypeScript type edges, `require`, and
  `new URL(..., import.meta.url)`. It resolves ESM import-only exports,
  follows dependency edges from physical package roots so pnpm symlink layouts
  lock the same reachable artifacts as npm installs,
  rejects computed project loaders, hashes every file in reachable installed
  packages and their declared dependency closure, and never regex-parses vendor
  comments as project source;
- `src/code.ts` — compatibility implementation behind
  `@caveman-ai/coding-agent`: `createCodingAgent` (host-sandbox
  read_file/grep/bash/edit_file over one workspace, output capped BEFORE any
  transform and under the 32 KiB inline tool-result ceiling so observe-only
  works with no engine) plus the session surface `startCodingSession`,
  `runCodingTurn`, `runCodingSession`. Optimized is the default:
  `defaultCodingPlan` routes exactly one CCR-recoverable transform per live-zone
  kind (`tool_result`→terminal, `history`→text; two routes on one kind collapse
  into `dynamic_route_ambiguous`), never `toon`, with `cave_retrieve` on.
  Degrading to observe-only is loud and recorded on `session.notices`; only
  `cave_gateway_required_for_locked_plan` earns the one retry without the plan.
  The route is resolved ONCE at `startCodingSession` and pinned on
  `session.route`; every turn is handed it via the internal `caveRoute` option,
  so a session makes exactly one runtime-ensure attempt however many turns it
  runs, and session mode governs (degradation is sticky, and a turn override can
  never re-open routing). Caller `overrides`/`runOverrides` face
  `rejectInternalRunOptions` before any session-internal field is merged.
  Tool containment is realpath-based (a symlink out of the workspace is out),
  and `bash` runs its command in its own process group so a timeout kills the
  tree instead of waiting on a backgrounded child's inherited stdout. `bash` is
  **uncontained by design** — it runs arbitrary host commands with the user's
  privileges — but its subprocess env is a fixed shell/locale allow-list, not a
  spread of `process.env`, so a model-driven command cannot read the framework's
  own account/provider credentials (`CAVE_API_KEY`, `ANTHROPIC_API_KEY`, …) and
  exfiltrate them (issue #143).
  Bills print token counts labelled `inferred (local estimate)` and spend in USD
  with its `priceBasis` — no dollar figure is ever attached to a saving; a
  zero-turn session prints an honest absence instead of basis-labelled zeros.
  `proveRecovery` runs the real engine compress/retrieve pair and reports the
  sha256 comparison. Live sessions are lock-ineligible by construction (host
  mode anywhere in the graph, root or subagent, is refused by `compile`).
  Example wrapper: `examples/coding-agent/`;
- `src/shell-tools.ts` — `shellTools({ workspace, executionBackend, tools,
  outputCaps, commandSessions, onOutput })`, the coding agent's six
  workspace tools as one builder any definition composes (moved out of
  `code.ts`, which now consumes it; `CODING_TOOL_OUTPUT_CAPS`/`capOutput` stay
  re-exported from `./code`). Selecting `read_tool_output` enables the
  recovery store; the rest of the behavior, effects, and descriptions are
  byte-identical to before. Example: `examples/investigator/`;
- `src/cache-planner/` — in-SDK TS port of `public/cacheengine`'s deterministic
  planner core plus three provider wire bridges (Anthropic native, OpenAI
  chat + responses, Bedrock converse + invoke). The Go engine is the source of
  truth: `tests/cache-planner-parity.runtime.mjs` asserts all 41 Go-exported
  cases in `planner-fixtures/` byte-for-byte (Anthropic/OpenAI splice bytes,
  Bedrock sorted-key reserialize, escape-heavy unicode bodies) and fails
  loudly on catalog drift. Profile facts come from `src/catalog.ts`
  `catalogCacheProfile` (generated, all regions). Deliberately NOT publicly
  re-exported from `src/index.ts` — internal imports only. Live scope:
  Anthropic caching is provider-native via Pi's own markers; the SDK planner
  adds openai affinity routing keys and takes over other wires only when
  proven live (#225). Off the gateway, `runtime.ts` applies exactly that
  through Pi's `onPayload` seam — provider-native hints on the upstream
  request only, pass-through on any uncertainty, caller-managed markers
  respected (no double-apply; a routed gateway keeps precedence and disables
  it). Mints nothing; results are at most `inferred` and `verifiedSavingsUsd`
  stays zero. `cache-planner/static-checks.ts` owns the three static plan
  checks + F2 failure voice: volatile frozen prefix (two composition passes,
  the second under a +26h perturbed clock so day-stable values trip too —
  #224 first half; composition side effects therefore run twice per build),
  prefix-shrink regression (vs `.caveman/frozen-prefix.json`, written beside
  the lock with its estimate `basis`; `--accept-prefix-shrink` resets the
  baseline), and frozen prefix below the provider's catalog minimum —
  build-failing for explicit-cache models only, a loud advisory for
  affinity/implicit ones (goldens/README severity scoping). They run in
  `build` BEFORE the eval gate; renderers are snapshot-tested byte-exact
  against `goldens/failures/`, and wire codes appear only under
  `caveman-agent build --verbose`;
- `src/wire.ts` — the portable provider-wire transport (`@caveman-ai/agent/wire`).
  `createCavemanTransport({ budget, cache })` returns a `fetch` for any provider
  client that accepts one, so the request ceiling, exact provider-reported usage,
  and native cache hints reach EVERY framework adapter without per-framework
  code — this layer scales by provider, not by framework. Anthropic
  `/v1/messages` and OpenAI `/v1/chat/completions` + `/v1/responses` only, matched
  on host AND path; every other target, non-POST, or unparseable body passes
  through unmetered and unedited. Cache release carries the SAME #225 live-path
  gate as `runtime.ts` (OpenAI affinity routing key only); `cache: "all"` is an
  explicit opt-in to unproven-live grammars and is never a default. The cache
  epoch digests the stable slice (`system`/`tools`/`instructions`/`toolConfig`) so
  changed instructions open a new epoch instead of permanently tripping prefix
  drift. Usage merges across Anthropic's split `message_start`/`message_delta`
  and OpenAI's final chunk; a response whose usage cannot be measured settles at
  the FULL reserve, never zero, and a transport error cancels the reservation.
  `ModelUsage.cost` follows the model-usage contract (priced only when every
  count including reasoning is known, so Anthropic records are honestly
  `unknown`), while the METER settles on a separately derived exact figure when
  both extremes of an unknown reasoning split price identically. OpenAI's absent
  cache-write count is the one field defaulted to zero, because OpenAI has no
  cache-write class (`cacheWritePerMillion: null`). Compaction and routing
  deliberately do NOT live here: they rewrite what the framework believes it
  sent, so they stay on the adapter `modelBoundary` seam. Positioning and limits:
  `docs/PORTABILITY.md`;
- `src/claude.ts` — public unlocked Claude Agent SDK facade;
- `src/claude-runtime.ts` — exact-pinned public Claude executor. Public calls
  cannot inject build identity. Every locked/candidate call rejects before SDK
  or MCP launch pending current source/runtime provenance, per-turn semantic
  bills, byte-exact CCR proof, cached-substitution evidence, and parity replay.
  Memory and framework subagents also remain fail-closed. Public tools are
  read+inline only, inherited `x-cave-*` headers are stripped, model-specific
  thinking capability is resolved before spend, and provider output usage is a
  hard terminal ceiling. SDK aggregate output stays provider-reported, while its
  unavailable authoritative thinking split is explicitly marked unavailable;
- `src/adapters.ts` — generic locked-build harness plus tiny Pi/Claude and
  legacy Eve compatibility bindings. Vercel and Mastra host integration lives
  only in `packages/adapters/*`; never recreate it here. Generic harness checks matching harness lock,
  unchanged baseline plan, Context IR identity, upstream identity, response
  model, complete usage, caller-supplied transform/recovery evidence, and catalog
  cost. These are identity/result checks; no generic v3 adapter constructs or
  binds changed model, reasoning, context, transform, recovery, retry, or
  output-budget behavior from compiler output. Eve supports reasoning-off locks
  because its durable event contract omits reasoning usage. Eve's client `send`
  API exposes no server execution limit. Claude facade already forwards
  operator-supplied `maxTurns` and
  `maxBudgetUsd`; its task-budget field does not qualify because upstream documents
  task budgets as advisory and unsupported on Claude Code/Cowork, while its
  provider-output check is post-execution. Neither is described as an adapter hard
  cap. None of these
  adapter controls proves dollar savings, a reserve-guaranteed cost cap, or fanout;
  these existing bridges are not profiled-v3 behavioral lowerers;
- `src/dir-loader.ts` — the agent-directory convention (Phase 1, issue #216):
  `loadAgentDir(rootDir)` lowers `instructions.md` + `agent.ts`
  (`AgentDirConfig`: model, budget/breakers run defaults, and a context map
  whose bare entries default to build stability — load-bearing for the
  volatile-prefix check; values are evaluated once at composition, per-turn
  re-evaluation is issue #224) + `tools/*.ts` (filename = tool name, default
  export must be `tool()`) + `subagents/<name>/` (recursed; sibling slug
  collisions fail closed) into one ordinary `agent()` call. Optional project
  skills live at `.agents/skills/<name>/SKILL.md` and route through canonical
  `agent-environment.ts` parsing, containment, stable index, and `load_skill`
  invocation. Directory loading adds only this explicit project root; user-home
  skills and plugins remain disabled. It also writes a generated static-import module
  entry at `.caveman/agent-dir-entry.mjs` so required-sandbox staging reaches
  every convention file and the tool worker recomposes the identical
  definition digest. The CLI dev watch path regenerates that entry by pure
  directory scan (`generateAgentDirEntry`) — user modules are only ever
  imported inside the staged snapshot, never live on the watch path;
- `src/receipt-print.ts` — `renderReceipt`, the end-of-run receipt print
  (F1), snapshot-tested byte-exact against `goldens/receipt-*.txt`. Cost and
  cold estimate share one scope (root plus subagent calls), the cold
  counterfactual stays `inferred` (recurring-priced models print an explicit
  `unavailable`), unpriced never prints $0, a stopped run says it stopped,
  and a breached cap prints the overage instead of a negative percent.
  `writeRunReceipt` files the unmodified wire receipt under
  `.caveman/runs/<stamp>/`; `run()` and each dev turn print it when
  `RunOptions.printReceipt` opts in — directory-loaded agents default it on.
  A resumed durable run adds one `resumed` line naming prior attempts and any
  possible-double-count call, golden `receipt-resumed`;
- `src/durable.ts` — opt-in durable execution (Phase 4, issue #218: own
  substrate after the Workflow SDK proved non-embeddable; DBOS
  checkpoint-resume + Inngest named events + Temporal in-journal versioning).
  `RunOptions.durable = { runId, store? }` — runId is a caller-assigned
  idempotency key; append-only JSONL journal (disk store default under
  `.caveman/runs/durable/<runId>/`, 0700/0600 because it necessarily holds
  message content, pluggable `DurableStore` for anything else). Ledger is
  event-sourced fine-grained: `call_started` intent fsynced BEFORE every
  provider call (root, subagents via the inherited execution-context journal,
  compaction summarizers via onReserved/accrue), `call_settled` after —
  resume preloads the meter with journaled settles so settled money is never
  re-reserved and never lost, and an intent with no settle surfaces as
  `receipt.resume.possibleDoubleCountCalls` (the documented at-least-once
  ceiling), never silently. Conversation state checkpoints per turn (an async
  pi subscriber pi awaits — the turn is durable before the next call). Pi's
  state.messages is APPEND-ONLY: a compaction's replacement context lives
  only in the loop's local view, so the journal keeps following pi.state and
  a resume rebuilds the UNCOMPACTED transcript — compaction counters are
  deliberately not restored so the resumed run may pay (metered, journaled)
  to compact it again; the budget is the real bound. Resume rebuilds to the last boundary
  ending in a user/tool-result message and re-enters via `pi.continue()`, so
  the prompt is never asked twice; a lost partial turn re-drives with its
  spend kept. Terminal journals replay without spending (same runId → same
  result or same error); an ABORT is the deliberate twin of a crash and stays
  resumable. Fail-closed identity: definition digest, input, and budget
  contract must match the journal (`cave_durable_definition_changed` /
  `_input_mismatch` / `_budget_changed`); unknown journal events and version
  mismatches refuse; a per-run pid lockfile stops two processes double-driving
  one run. v1 scope gates (each fails closed): no `conversation`, no
  `maxCostUsd` (use `budget`), root runs only; breaker windows and
  `previousSummary` restart on resume. Synthesized refusal and error/aborted
  turns are never journaled as state, and an error turn without a live
  reservation journals no settle — a phantom zero settle would hide the
  double-count.
  Out-of-band control lives in `src/durable-control.ts`, as journal events
  rather than process state, so it survives a restart and reaches a run this
  process is not driving. `cancel_requested` is Temporal's CANCEL not its
  TERMINATE: cooperative, idempotent, and it never rewrites a settled run — a
  cancelled run settles as `run_failed` with `cave_durable_run_cancelled` (not a
  fourth terminal shape, which would read as "pending" to every reader not
  taught about it), and a sweep settles it with NO provider call.
  `sleep_scheduled` is the cost primitive: an absolute, last-write-wins wake
  time after which the run is eligible again, so a wait costs a date instead of
  a process (no `sleep_settled` — once `wakeAt` passes the sleep is over by
  definition). `nextDurableWake` / `server.nextWakeAt()` expose the earliest due
  instant so a host can scale to zero; an overdue sleeper means "work now", and
  a store that cannot enumerate means "unknown", never "nothing pending".
  Storage is split into `src/durable-stores.ts` (bytes) and
  `src/durable-limits.ts` (the shapes both halves must agree on).
  `tests/durable.runtime.mjs` covers crash-mid-call resume,
  lost-turn restart, idempotent replay, identity refusals, the lock, and
  subagent settles landing path-tagged in the root journal. Tool replay on
  resume matches by position, name, effect, and `argsSha256`, never by the
  provider-minted `toolCallId`, because a re-driven turn gets fresh ids from a
  real provider; a settled call adopts its recorded identity so the settlement
  pairs with its own intent (`tests/durable-replay-ids.runtime.mjs`);
- `src/serve.ts` — the deployable target (`@caveman-ai/agent/serve`).
  `createAgentServer({ definition, token, store })` puts ONE agent behind
  `POST /runs` + `GET /runs/{runId}` + `/healthz` + `/readyz`, with every run
  journaled through `src/durable.ts`. It adds exactly three things to the
  journal and no scheduler, queue, or orchestration beyond them: an idempotent
  submit (`runId` IS the durable idempotency key, so a settled run replays its
  journaled outcome and spends nothing), recovery (boot plus a 60s sweep
  re-drives every journal with no terminal event — the periodic pass is what
  reclaims a run stranded by a PEER instance's death, which a boot-only sweep
  would leave forever), and a SIGTERM drain (best effort; unfinished runs are
  journaled and resumed by the next instance, so the drain is never the
  correctness boundary). Fail-closed at the trust boundary: no unauthenticated
  mode (a bearer token under 16 chars refuses at construction, compared
  length-independently), text input only (multimodal journals a digest, which
  no unattended resume could reconstruct), 1 MiB body cap, and `durable` in
  caller `runOptions` is refused because the server owns it. A store that
  cannot enumerate reports `listable: false` rather than an empty sweep.

  Multi-principal deployments pass `authenticate(request) => Principal` instead
  of `token`. The SDK does not own identity — the host verifies a JWT, mTLS peer
  or cookie however it already does — and owns only what follows: a session's
  storage key is its caller-supplied id prefixed with a hash of `principal.id`,
  so one principal cannot read, steer or delete another's, and that isolation is
  structural rather than a side record, so it survives a restart (`run_started`
  is frozen protocol and cannot carry an owner). A hook that returns undefined
  OR THROWS is a 401: a verifier that cannot reach its JWKS must not fall open.
  `/runs` addresses journals by raw run id with nothing binding a run to a
  principal, so it returns 403 `cave_serve_runs_require_single_principal`
  whenever `authenticate` is configured rather than spanning the boundary.
  Sessions, replay buffers and deletion tombstones remain PROCESS-LOCAL, so two
  instances against one store would drive a session blind to each other: the
  server takes an instance lease (`caveman.instance.lock`, filtered from every
  sweep) and refuses to start with `cave_serve_instance_already_active` unless
  `singleInstance: false`. The lease expires, so active/standby fails over;
  active/active is not supported until session ownership is itself durable.
  Session messages and `POST /runs` accept `context` (JSON object/array,
  64 KiB cap) which `withMessageContext` folds into the user message as one
  `<cave-message-context>` block: untrusted like the text, journal-replayable,
  outside the cached prefix. The `runOptions` factory receives `principal` for
  runs an authenticated request started (absent on boot recovery, since the
  journal carries no caller identity). `src/serve-events.ts` holds the SSE
  replay buffer and response (moved out of `serve-session.ts` for size
  headroom, re-exported from it).
  `caveman-agent serve [dir] [--port] [--host] [--locked]` is the CLI lane;
  `hosting/` ships the Dockerfile plus a complete Cloudflare Container +
  Durable-Object-journal recipe, because Workers has no `node:child_process`
  and container disk does not survive the instance. `tests/serve.runtime.mjs`
  covers idempotent replay, boot recovery of a crashed run, auth refusal, and
  submission validation;
- `src/cli.ts` — `dev`, `build`, `check`, zero-spend `doctor`, `register`;
  bare `dev` and `defineBuild({ entry: "." })` resolve to the directory
  convention when `instructions.md` exists at the root, and markdown joins
  the watched project inputs (`projectSourceFiles` in `src/source-graph.ts`);
  existing `build` command, not new verb, selects the exact native profiled v3
  path and preserves explicit profile/development/holdout roles. Locked
  production integration asserts selected output `64` becomes provider
  `max_output_tokens=64` with exact `x-cave-agent-build`;
- `src/budget.ts` — the run budget contract. `RunOptions.budget` declares
  exactly one denomination (`maxUsd` at public catalog list prices, or
  `maxTokens`), runtime-gated on two independent grounds: the catalog must
  price the model, AND the run must be billed in dollars — a Claude Pro/Max
  subscription reached through Pi's credential store fails closed as
  `cave_budget_denomination_unavailable`, read from `checkAuth` and never
  inferred from the model. The regime is judged on the credential that
  actually pays, so the check runs AFTER routing and does not apply to a
  caller-supplied `streamFn` (that transport never asks Pi to authenticate
  anything) or to a gateway-routed run (the account key pays, not the local
  login). That last exemption holds only where the gateway supplies the
  provider credential. Gateway readiness makes that boundary explicit:
  managed returns `billing: "managed"`, standalone returns `billing: "byok"`,
  and missing/unknown billing provenance falls through to the local credential
  gate rather than authorizing dollars. The Claude lane reads the selected
  `apiKeySource` from the SDK's first init message: OAuth/unknown auth reports
  token counts but `costUsd: 0`, `priceBasis: "unpriced"`, and unpriced receipt
  calls; `maxBudgetUsd` requires a positively identified API-key source.
  Subscription dollars are fiction (ADR 0023). Enforcement is reserve-and-clamp, one mode, no soft
  option: each call reserves its worst case (byte-derived input ceiling capped
  at the context window, times the catalog's worst rate, plus the configured
  output allowance), and a remainder that cannot cover the full allowance
  clamps the call's output down to what it affords, to
  `OUTPUT_CLAMP_FLOOR_TOKENS`. The input ceiling includes whatever the request
  could still GROW by if `onPayload` restores uncompressed originals on cache
  drift, so the hold bounds the payload that actually leaves. Below the floor
  the run stops **between** calls and returns a normal result carrying
  `RunResult.stopReason` — never a throw, never mid-tool, and an in-flight call
  always finishes and is counted. The runtime never *chooses* to spend past
  max; when a provider nonetheless reports more than could be bounded, the
  ledger records the REAL amount (never clamped — a rewritten ledger is fake
  accounting), sets `capBreached` with a signed `overspent` on both
  `RunResult` and its receipt, and funds nothing further — reserve, carve and
  tranche release all refuse. `spent > max` never appears without that flag.
  The FLAG rolls up from any subagent wallet that breached beneath the run
  (the ordinary shape, since wallets are small carves); the AMOUNT does not —
  `overspent` is always this level's own `max(0, spent − max)`, because
  settling a carve books the child's real spend against the parent too, and
  summing would count the same money twice and could print a figure larger
  than the whole tree spent. Each subagent's amount is on its own receipt.
  `capBreached` sits beside `stopReason` because both a clean stop at the cap
  and a breached one report `budget_exhausted`.
  `RunOptions.deadlineMs` stops at the same points. `maxCostUsd` is the older
  error-terminating cap and cannot be combined with `budget`. `budget.ts` also
  owns `RunResult.receipt`: every run — budgeted or not — returns the per-call,
  per-tool, per-subagent breakdown plus tranche history. Its money figures are
  **estimated list-price subtotals** from the public catalog, never invoices;
  an unpriced call is flagged, never counted as free. Serialized receipts carry
  `schema: caveman.agent.run-receipt.v1` and must validate against
  `public/shared/contracts/schemas/agent-run-receipt.schema.json`. That shared
  shape is not sent through ADR 0032's anonymous CLI lane; future hub upload
  requires separate authenticated, tenant-scoped consent. Under a budget,
  `subagent()` caps become **wallets**: the child's `maxCostUsd` (USD runs) or
  `maxTokens` (token runs) is carved out of the parent's *remaining* budget
  synchronously at spawn, so parallel spawns cannot double-spend, and the
  unspent remainder returns to the parent when the child finishes. A revoked
  parent revokes every wallet under it. `RunOptions.maxSubagentDepth` defaults
  to 2 and is capped at `ABSOLUTE_SUBAGENT_DEPTH_LIMIT`. Budget can be **staged**:
  `budget.initialUsd`/`initialTokens` meters the run against a first tranche and
  `createBudgetController()` + `RunOptions.budgetController` lets the developer's
  own deterministic checkpoints release more, up to `max` — releasing past `max`
  throws at the release site. No model can reach the controller (detection law 1:
  never a model in the money path), and a controller is inert outside its run.
  `RunOptions.onBudgetExhausted` is `"stop"` by default; a handler instead gets
  the read-only exhaustion context between calls (never mid-tool) and answers
  `"stop"` or `{ release, reason }`, which tops up a tranche through the same
  `max`-bounded mechanism. Exactly one escalation per exhaustion. Pausing and
  resuming a run from a serializable handle is deliberately not built;
- `src/tool-policy.ts` — `RunOptions.toolPolicy`, the host's per-call
  authorization decision (Claude Agent SDK `canUseTool` shape) consumed on the
  kernel's `beforeToolCall` admission path after every kernel check, and again
  in `dispatchNestedTool`; subagents inherit it through the run options and
  report `agentPath`. Deny-only with identifier codes (`cave_tool_denied:<code>`
  reaches the model; receipts count `tools[].denied`); no argument rewriting,
  because the journal binds calls to `argsSha256`. A throw, a hang past 10s, or
  a malformed decision is `cave_tool_policy_failed`, run-fatal with receipt.
  `RunResult.output` is the final message parsed against `output({ schema })`
  (the schema is rendered into the system prompt); `run()` types it from the
  definition. `src/run-controller.ts` holds `AgentRunController` (moved out of
  `runtime.ts` for size headroom, re-exported from it);
- `src/breakers.ts` — opt-in deterministic circuit breakers
  (`RunOptions.breakers`): repeated-tool-call loop detection (exact
  tool+normalized-args hash within a configurable assistant-turn window,
  default 8, with `tool({ allowRepeat: true })` for legitimately repetitive
  tools), a no-progress window over turn outcome signatures, a
  per-turn fan-out cap, and retry budgeted in the run's denomination rather than
  by attempt count. Each retry takes a real BudgetMeter hold; pre-stream
  failures cancel at measured zero, successful attempts settle provider usage,
  and receipt events expose reserved + measured spend with basis. Old exact
  repeats decay out of the turn window instead of poisoning a long run. Local
  enforcement shares worker F16's H6 edge rule — including exclusion of a
  repeat following a failed attempt — but does not claim parity with worker-side
  session SCC + population Isolation-Forest finding arithmetic. No model runs
  anywhere in this path.
  No-progress signatures include tool identity/result; successful declared
  writes reset that window because identical text cannot prove host state stayed
  unchanged. Breaking stops between calls with
  `stopReason: "loop_detected"` / `"no_progress"`; the fan-out cap only blocks
  the extra calls. Every decision lands on `receipt.breakers`;
- `src/routine.ts` — `routine(original, impl, { guard })`, the determinism
  dividend's productized guard + deopt (`docs/DETERMINISM_DIVIDEND_SPEC.md`
  §4.3). It returns an ORDINARY tool with the original's name, description, and
  input schema, so sandbox, breaker, budget, and receipt behavior are unchanged.
  Input is checked with typebox `Value.Check` against the tool's own JSON
  schema — a check the routine adds, since the runtime never validates tool
  input — then the optional guard runs; a schema failure, a guard rejection, a
  throwing guard, or a throwing `impl` all **deopt** to the original tool and
  return its result — no error escapes the fallback, though the ORIGINAL's own
  error still propagates (auto's 48.9% silent-failure lesson: the guard is
  load-bearing). `impl` output is not validated: the framework validates no
  tool's output anywhere, and the output gate lives in customer CI (spec
  §4.1.3). Refused at construction: a `cave_`-reserved name; a subagent tool
  (framework-run execute, so a deopt could not reach the original); a
  Standard Schema input (v1 could only re-check the converted draft-07 schema,
  losing the vendor's refinements and transforms — JSON-schema tools only,
  Standard Schema is a follow-up); another routine (double-counted outcomes);
  and an `async` guard (a thenable is truthy, so it would admit everything — a
  manually returned Promise still deopts safely at runtime). The composed tool
  declares its own implementation source (`impl` + `guard` text under a routine
  marker), so wrapping original→routine CHANGES the definition digest and
  therefore invalidates the cache epoch, the build lock, and durable run
  identity (`cave_durable_definition_changed`) across the swap — deliberate,
  since the step's behavior changed. Outcomes are a closed runtime-declared vocabulary — `routine_hit`,
  `routine_deopt_guard`, `routine_deopt_error` — read through
  `routineOutcomes()`, and they are **observability only**: they feed `observed`
  before/after measurement and mint no receipt line, metering change, or cost
  math of any basis. Scope caveat: counters live in the process that runs the
  closure, so a `sandbox: "required"` run records them in the tool worker and
  the host list stays empty — an honest absence, not a zero. Carrying them
  across that boundary (and into `caveman.tool_events`, whose `outcome` column
  is a gateway-assigned closed `ok`/`error`/`unknown` vocabulary) is issue #248;
- `src/compaction.ts` — budget-triggered compaction, and **the only place in this package
  that rewrites model-visible context**. That is why it lives here: compaction
  is a model-visible rewrite, so it can exist only where the builder owns the
  context — no wrap or gateway path ever performs it. The exhaustion ladder is
  **evict → summarize → clamp → stop**. Default-on compaction triggers when
  remaining budget falls below four full cold next-call ceilings; `"stop"`
  skips that pre-emptive rung and only clamps/stops once a call stops fitting.
  Eviction is free and deterministic: stale tool output becomes a
  citation carrying its digest, selected by role and freshness — the class is
  safe to elide because every runtime tool result the IR lowers carries
  `recovery: "exact_ccr"`, but the choice is not driven off each segment's own
  `recovery` field.
  Summarization is a real provider call metered from the same budget and from
  every ancestor subagent wallet, built by the same request shape as a working
  call — same system prompt, same tool definitions, same history, same gateway
  headers, instruction appended last. Its usage joins `RunResult`'s own totals,
  not just the receipt. The rung is closed once the run has decided to stop: a
  turn that asked for no tools, a tripped breaker, or an expired deadline all
  skip it, because no working call would follow. Its reserve is priced **cold,
  always** — the rewrite diverges from the working call's prefix at its first
  changed message, so a warm read there is not evidence for a warm read here.
  Earlier timing makes the own-model default reachable without discounting its
  cold reserve; a cheap-class summarizer remains an opt-in gated on its context
  window covering the history. Cold pricing is not the whole story: the input ceiling is a UTF-8 BYTE
  count (~3-4x the real token count), so both the working call and the
  summarizer are priced ~4x high, which pushes the affordability trigger earlier
  than a true-token ceiling would. Tightening it needs a provider count-tokens
  endpoint (issue #165); until then the byte bound is kept because it never
  under-reserves. A subagent with a carved wallet uses that child meter as its
  sole economic boundary, so its compaction can run and rolls usage into the
  parent receipt; an unfunded child cannot borrow around the parent. Other
  preconditions: a yield floor and headroom for several working
  calls. `maxCompactions` counts attempts that actually reserved — a free
  decline does not burn it. Safeguards after: schema-validated
  sectioned summary (invalid ⇒ discard and clamp), a constraint-integrity
  assertion comparing the accepted rewrite's CONTENT against every pinned
  segment (identity comparison cannot fail), an inflation guard, and a
  self-contained tail so no tool result outlives its call. `receipt.compactions`
  keeps the REAL metered cost and the MODELED effect in separate fields with
  separate bases; the word "saved" appears nowhere.

`doctor` is framework readiness truth surface: Node, sandbox, optional peers,
engine registry, runtime CLI, project/Context IR, lock drift, provider
selection, and per-harness locked-execution state. Optional peers
(`src/optional-peers.ts`) are read off this package's own
`peerDependenciesMeta`, never hardcoded: each backs a subpath export only, so a
default install never downloads it, and doctor names the lane plus the exact
install command rather than letting it surface as `ERR_MODULE_NOT_FOUND`. It also recognizes a vercel/eve agent directory (F7:
nested `agent/` layout, or flat with eve-only `channels/`/`schedules/`/
`connections/`/`hooks/`; suppressed whenever `caveman.config.ts` exists) and
prints what maps, what needs a rewrite, and what has no v1 equivalent —
detection only, no import command, no file rewriting; the walk is
`docs/eve-migration.md` (shipped in the npm tarball via `files`).
`docs/cold-walk.md` is the Phase-5 release-gate script: each step marked
VERIFIED-DRY or NEEDS-LIVE, blocking findings filed (#226 #227 #228).
F8 first-run states: `cave_budget_denomination_unavailable` refusals keep the
same fail-closed behavior but the message names the state's one-line fix
(missing env var by provider / subscription / unprovable credential / unpriced
model), tested in `tests/budget-regressions.runtime.mjs` F8 block. Caveman public CLI version probe is `caveman version`
(not `--version`). Optional project/provider warnings do not hide foundation
failures; Claude detail distinguishes public execution from fail-closed Cave
Build execution; third-party adapter readiness remains separate per harness.

Claude Agent SDK dependency is governed by Anthropic Commercial Terms linked
from its README, not package Apache-2.0 license. Keep disclosure in public README.

Run `pnpm --dir public/agent test`. Unknown state fails closed. Transform failure
passes original bytes. Missing usage/pricing/eval/recovery writes no optimized
legacy v2 lock. Exact tool-free native Pi may emit only its closed behavioral
diff; generic/custom Pi and Vercel/Eve/Mastra v3 remain baseline-only. Claude
Cave Build remains refused. Local evidence is always `inferred`; this package
never mints verified savings or supports a public savings percentage.

Authority: `docs/strategy/EFFICIENT_AGENT_BUILDER_SPEC.md`.
