# Execution modes

The runtime defaults to `cave: "auto"`: use an available Caveman gateway for
supported providers, otherwise call the provider directly. Set `cave: "off"`
to guarantee a direct run without contacting or starting the gateway.
`RunResult.mode` reports the path the run actually used.

| Mode | Receipt value | What happens | What is claimed |
| --- | --- | --- | --- |
| direct | `observe-only` | The provider's own base URL, no transform, no gateway telemetry | No optimization claim. Provider usage and local context estimates remain available |
| gateway | `optimized` | Traffic routes through the Caveman gateway; eligible context transforms and context telemetry apply | Any local reduction stays `inferred`; the mode alone proves no savings |

## How a run picks its mode

`RunOptions.cave` controls it:

- `"auto"` (default) — routes through the gateway, and degrades to
  `observe-only` when the local gateway cannot be reached.
- `"off"` — never contacts or starts the gateway.

The gateway proxies `anthropic`, `openai`, and `google`. Other providers go
direct and report `observe-only`.

## The degradation is never silent

A run that carries a Cave Build lock or a candidate plan refuses to degrade.
It fails with `cave_gateway_required_for_locked_plan`. Public `runLocked()`
does not retry as an unlocked run. The interactive coding wrapper may handle
this specific failure by retrying its default candidate without a plan and
reporting the change.

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
$ npx caveman-agent doctor
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
