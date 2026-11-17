# packages/create-caveman-agent

> **Repository routing:** this repository is the source of truth for
> `@caveman-ai/create-agent`. Initializer product work lands here first and is
> mirrored out deliberately; other checkouts carry integration copies only.

Zero-runtime-dependency npm initializer for `@caveman-ai/agent`. `src/index.ts`
parses provider/install flags, copies `templates/support-bot/` verbatim into a
temporary directory, fills per-project values (package name, provider.json,
.gitignore), installs dependencies by default, then atomically renames into
target.

`templates/support-bot/` is locked template content — the generator consumes it
verbatim; only the `name` field of its package.json is overwritten. Never print
or persist provider secrets. Ambiguous noninteractive provider selection fails
without partial target. `--no-install` supports callers that manage
dependencies.

First-run honesty (F8): the template's `run.ts` fails with a named next step,
never a stack trace — usage line, ticket-not-found with the real ticket list,
and a one-line message + doctor pointer for framework errors. Eval fixtures
name tickets with literal `new URL("…", import.meta.url)` — a computed
(template-string) path is rejected by the source graph and fails doctor/build
on the untouched scaffold (regression-tested). Known gap: split-role
evals route build to the tool-free profiled lane and
the tooled support bot ends at `capability_refused`, so the README's "locks
the cheapest plan" promise is not currently reachable.

Run `npm --prefix packages/create-caveman-agent test`.
