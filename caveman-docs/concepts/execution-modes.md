# Execution modes

The default is **direct**: your key, your provider, no proxy. The receipt value
for a direct run is `observe-only`, which is what `RunResult.mode` carries.
`optimized` is the optional second mode and requires the local Caveman gateway.
The difference is visible in every receipt.

| Mode | Receipt value | What happens | What is claimed |
| --- | --- | --- | --- |
| direct (default) | `observe-only` | The provider's own base URL, no transform, no gateway telemetry | Nothing. Provider usage and local context estimates remain available |
| optimized (opt-in) | `optimized` | Traffic routes through the local Caveman gateway; eligible context transforms and context telemetry apply | Local reductions, basis `inferred` |

## How a run picks its mode

`RunOptions.cave` controls it:

- `"auto"` (default) — routes through the gateway, and degrades to
  `observe-only` when the local gateway cannot be reached.
- `"off"` — never contacts or starts the gateway.

The gateway proxies `anthropic`, `openai`, and `google`. Other providers go
direct and report `observe-only`.

## The degradation is never silent

A run that carries a Cave Build lock or a candidate plan refuses to degrade on
its own. It fails with `cave_gateway_required_for_locked_plan`, and only that
failure earns one retry without the plan.

Interactive surfaces print the banner rather than quietly downgrading:

```text
cave: observe-only — engine/gateway unavailable; transforms and gateway
telemetry off (provider usage and local context estimates remain available)
```

The coding agent records this on `session.notices`, shows the mode on the
prompt, and repeats it in every turn's bill. The runtime is probed once per
session, not once per turn: a machine with no runtime pays one failed start
attempt for the whole session, and a session that has degraded stays degraded.

## Runtime acceptance

The framework accepts a loopback runtime only when health identity, run state,
PID, and executable ownership all validate. An unrelated local listener never
receives provider traffic; the run goes direct in `observe-only` instead.

## Enabling optimized mode

```bash
npm i -g @caveman-ai/cli
caveman start
```

`npm run dev` auto-starts the local Cave Runtime when it is installed.

## Locked execution

`runLocked(definition, input, build, options)` accepts only Pi locks. Before any
provider traffic it validates:

- lock integrity;
- the exact agent definition;
- runtime identity;
- adapter and upstream versions;
- the catalog snapshot;
- Context IR;
- the selected plan;
- the live Engine registry when transforms exist.

Durable journal identity includes the build and plan digests, so the same run ID
cannot replay under another build.

Parsing a lock does not establish freshness. Source, config, and eval freshness
is project-level state, checked by `caveman-agent check` at deployment or
startup.

## Lock eligibility

A live host-sandbox run is never lock-eligible. `compile` refuses a host-mode
agent with `cave_host_sandbox_lock_ineligible` before any search run, which is
why interactive coding sessions can never mint a Cave Build. Locked builds for
coding agents compile against fixture corpora with a contained sandbox mode
instead.

## Readiness check

`caveman-agent doctor` makes no model request and prints what a run on this
machine would do today:

```console
$ npx -p @caveman-ai/agent caveman-agent doctor
PASS node         Node 22.19.0
PASS sandbox      tool sandbox containment probe passed
WARN engine       Caveman engine not found — transforms disabled (observe-only)
WARN runtime_cli  Caveman runtime CLI unavailable — runs stay observe-only
WARN gateway      gateway not reachable at 127.0.0.1:8787 — telemetry off
...
run mode: observe-only (no transforms or gateway telemetry)
next: npm i -g @caveman-ai/cli && caveman start
```

Missing engine, runtime CLI, or gateway is a `WARN` and exits 0, because
observe-only runs still work. A bad Node version, broken sandbox containment,
invalid config, or lock drift fails the check.
