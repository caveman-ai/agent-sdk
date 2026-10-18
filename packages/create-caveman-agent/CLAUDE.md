# packages/create-caveman-agent

> **Repository routing:** this repository is the source of truth for
> `@caveman-ai/create-agent`. Initializer product work lands here first and is
> mirrored out deliberately; other checkouts carry integration copies only.

Zero-runtime-dependency npm initializer for `@caveman-ai/agent`. `src/index.ts`
parses provider/template/install flags, copies the selected template into a
temporary directory, fills per-project values (package name, model,
provider.json, .gitignore), installs dependencies by default, then renames into
the absent target.

Both templates are copied verbatim except the `name` field of package.json and
the selected model line in agent.ts. Never print or persist provider secrets.
Ambiguous noninteractive provider selection fails without a partial target.
`--no-install` supports callers that manage dependencies. Generated projects
declare their own TypeScript and Node type dependencies.

First-run honesty (F8): the template's `run.ts` fails with a named next step,
never a stack trace — usage line, ticket-not-found with the real ticket list,
and a one-line message + doctor pointer for framework errors. Eval fixtures
name tickets with literal `new URL("…", import.meta.url)` — a computed
(template-string) path is rejected by the source graph and fails doctor/build
on the untouched scaffold (regression-tested). Build can refuse unsupported
capability combinations. Documentation must not promise an optimized plan,
guaranteed cache hits, or verified savings from an untouched scaffold.

Run `npm --workspace @caveman-ai/create-agent test`. Build the agent package
first to exercise both generated template typechecks.
