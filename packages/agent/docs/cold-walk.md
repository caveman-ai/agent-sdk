# The cold walk — release-gate script

The release gate from `docs/strategy/AGENT_SDK_V2_SHAPE.md` ("The walk"):
before the standalone repo's first public release, perform the two magic
moments cold — fresh machine, scaffold, two tickets, one sabotaged build —
consuming only terminal output and docs. Every gap between the walk and the
golden artifacts is a blocking issue.

Status legend:

- **VERIFIED-DRY** — mechanically executed inside the monorepo on
  2026-08-15 (scaffold via `create-caveman-agent --no-install` + a
  `node_modules/@caveman-ai/agent` symlink to the built package; the
  cold-machine states simulated with `CAVEMAN_CLI_BIN=/nonexistent`,
  `CAVEMAN_ENGINE_BIN=/nonexistent`, `CAVE_GATEWAY_URL=http://127.0.0.1:9`,
  and no provider keys in env). Behavior observed, not assumed.
- **NEEDS-LIVE** — requires a real provider key (or npm publish); listed
  with exactly what must be observed. These are the release-gate steps a
  human walks before publishing.

## The script

| # | Step | Expected | Status |
|---|---|---|---|
| 1 | `npm create @caveman-ai/agent@latest support-agent` on a machine that has never seen Caveman | scaffold lands atomically; with the SDK unpublished, install fails with the honest ETARGET message suggesting `--no-install` | NEEDS-LIVE (npm publish gate); the `--no-install` path and the ETARGET message are VERIFIED-DRY (initializer tests) |
| 2 | `npm run doctor`, no API key, no engine, no runtime CLI, no gateway | exit 0; engine/runtime/gateway degrade as WARN naming observe-only + the upgrade (`npm i -g @caveman-ai/cli && caveman start`); project + eval graph load PASS; provider warns `ANTHROPIC_API_KEY missing` with the one-line fix | VERIFIED-DRY |
| 3a | `npm run ticket` with no argument | one usage line, exit 1, no stack | VERIFIED-DRY |
| 3b | `npm run ticket -- tickets/wrong.md` | `ticket file not found` + the three real ticket paths, exit 1, no stack | VERIFIED-DRY |
| 3c | `npm run ticket -- tickets/refund-request.md` with **no API key** | one-line refusal naming the exact env var: `no ANTHROPIC_API_KEY in this shell — set it, then re-run`, plus the doctor pointer; no stack trace | VERIFIED-DRY |
| 4 | same ticket **with** a key — magic moment B, run one | model reply, then the receipt: cold input, cache-write premium explained in place (`receipt-cold.txt` shape), cost = list-price subtotal, cold estimate labeled `inferred` | NEEDS-LIVE: verify the printed receipt against `goldens/receipt-cold.txt` shape and that warm reads are provider-reported |
| 5 | `npm run ticket -- tickets/order-status.md` — run two | same receipt shape, `input` line shows prefix read warm from provider aggregate, cost lands below the cold estimate (`receipt-warm.txt` shape) | NEEDS-LIVE: THE compounding moment; warm delta must appear by run 2 with zero config (F4) |
| 6 | `npm run build` on untouched scaffold | static checks run first, then declared evals enter bounded compilation; current tool-bearing scaffold fails closed with `capability_refused: cave_compiler_tool_effect_coverage_unavailable` before provider calls | VERIFIED-DRY |
| 6b | prefix-below-minimum advisory behavior | scaffold prefix measures 2,631 est. tokens vs the model's 1,024 explicit-cache minimum — clears with margin, so no advisory prints (correct) | VERIFIED-DRY |
| 7 | magic moment A, the save: add the README's exact volatile snippet (`today: () => \`Today is ${new Date().toDateString()}\``) to `agent.ts`, `npm run build` | build FAILS with the golden voice (`goldens/failures/volatile-prefix.txt`): plain-words sentence, mechanism, fix, closing line; fires before model-backed evals; wire code appears only under `--verbose` | VERIFIED-DRY — fired byte-shape-identical to the golden (live fills location `agent.ts` and fix path `tools/get_today.ts`; the golden pins the fixture's `agent.ts:8` / `get_date.ts`) |
| 8 | remove the snippet, `npm run build` | back to fail-closed tool-effect capability refusal — static save leaves no residue | VERIFIED-DRY |
| 9 | review declared fixtures, `npm run build` | **BLOCKED — see finding below.** No separate admission state exists; build still refuses tool-effect coverage before provider call | VERIFIED-DRY (refusal); intended lock remains unreachable |
| 10 | `caveman-agent check`, then a locked run | lock validated; locked run refuses off-gateway (`cave_gateway_required_for_locked_plan`) | NEEDS-LIVE, blocked behind step 9 |
| 11 | eve migration walk (F7): run `caveman-agent doctor` inside a `vercel/eve` agent directory | doctor recognizes the layout (nested `agent/` or eve-only `channels/`/`schedules/`/`connections/`/`hooks/`), prints the mapping (what moves, what needs rewriting, what has no equivalent), and points to `docs/eve-migration.md` | VERIFIED-DRY (`tests/doctor-eve.runtime.mjs`); walking a REAL eve agent to a first receipt is NEEDS-LIVE (needs step 4's key) |

## Blocking finding from the 2026-08-15 dry walk

**Step 9 cannot produce a lock, even with live keys.** The scaffold's evals
declare split roles (`profile`/`development`/`holdout`), which routes `build`
to the profile-guided v3 path — and that lane is tool-free by design (v0.2:
any root tool refuses before runner spend, `cave_compiler_tool_effect_coverage_unavailable`).
The support bot ships `tools/lookup_order.ts`, so the flagship scaffold's own
build gate ends at `capability_refused`, while its README promises "`npm run
build` locks the cheapest plan that passes all of them." One of the two has
to move (evals without split metadata would take the legacy v2 lane, or the
README stops promising a lock until the compiler's tool-effect coverage
lands). The walk stays red until the promise and the machine agree. The other
release gates are a clean history export and the npm publish gate, which
carries this walk's NEEDS-LIVE checklist.

Also fixed during this walk (was blocking step 2): template's eval file
used a computed `new URL(\`../tickets/${name}.md\`)` helper, which the source
graph rejects as unlockable — doctor/build failed on the untouched scaffold.
Now literal per-fixture URLs; guarded by a create-caveman-agent test.

## What this walk deliberately does not claim

No savings figures, no timing claims, no "verified" anything: a dry walk
proves message shapes and gate ordering, not economics. The warm/cold delta
(steps 4–5) is provider-reported evidence and can only be observed live.
