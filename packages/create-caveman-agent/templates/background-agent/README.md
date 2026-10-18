# Background coding agent

A server-first coding agent: sessions live on the server, follow-up messages
queue onto the running turn, every session has its own durable journal, and the
tools can execute in a sandbox that is not this machine.

Use Node.js 22.19.0 or newer. The initializer installs dependencies unless you
pass `--no-install`; in that case, install them first. Export the API key for the
provider you selected; scripts do not load `.env` automatically.

```bash
export CAVE_SERVE_TOKEN="$(openssl rand -hex 24)"
export ANTHROPIC_API_KEY="<your-api-key>"  # or OPENAI_API_KEY / GEMINI_API_KEY
npm run doctor
npm run dev
```

`npm run doctor` checks the machine (Node version, sandbox containment,
provider selection) and makes no model call.
`npm run typecheck` checks the starter's TypeScript without calling a provider.

## Drive it with curl

```bash
BASE=http://127.0.0.1:8080
AUTH="Authorization: Bearer $CAVE_SERVE_TOKEN"

# 1. create a session (you choose the id; it is also the journal key)
SID=fix-parser-$(date +%s)
curl -sX POST "$BASE/sessions" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"sessionId\":\"$SID\"}"

# 2. send the task (202: the run starts, or queues behind the active one)
curl -sX POST "$BASE/sessions/$SID/messages" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"text":"Fix the failing test in src/parser.test.ts","author":"julia"}'

# 3. tail the events (Server-Sent Events, across every run in the session)
curl -N "$BASE/sessions/$SID/events" -H "$AUTH"

# state, and cancelling
curl -s "$BASE/sessions/$SID" -H "$AUTH"
curl -sX DELETE "$BASE/sessions/$SID" -H "$AUTH"
```

A message sent while a run is active is a follow-up: it joins the running turn
instead of starting a second one. `{"mode":"steer"}` injects it into the turn
at the next boundary instead of waiting for the turn to finish.
`WS /sessions/{id}/ws` carries the same frames bidirectionally for clients that
would rather not hold an SSE connection open.

## Environment

| Variable | Required | What it does |
| --- | --- | --- |
| `CAVE_SERVE_TOKEN` | yes | Bearer token for every route. At least 16 characters; this endpoint spends money |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | yes | The key for the provider selected in `agent.ts`; Google also accepts `GOOGLE_API_KEY`. Calls go direct to your provider |
| `CAVE_EXEC_URL` | no | Execution-backend base URL. Unset means the tools run on this host |
| `CAVE_EXEC_TOKEN` | with `CAVE_EXEC_URL` | Bearer token for the execution backend |
| `CAVE_WORKSPACE` | no | Workspace root. Defaults to the process working directory |
| `CAVE_SESSIONS_DB` | no | SQLite path for the session journals. Defaults to `.caveman/sessions.db`; `:memory:` for throwaway runs |
| `PORT` | no | Listen port. Defaults to 8080 |

## Where the tools run

Without `CAVE_EXEC_URL` the agent's `bash`, `read`, and `write` execute on this
machine, uncontained. That is host execution, and host execution is not
isolation.

`sandbox-shim/server.mjs` is the whole remote form: run it inside your
container, microVM, or sandbox provider, and point the agent at it.

```bash
# inside the container
CAVE_EXEC_TOKEN=$SHIM_TOKEN CAVE_EXEC_ROOT=/workspace node sandbox-shim/server.mjs

# beside the agent
export CAVE_EXEC_URL=https://sandbox.internal:8081
export CAVE_EXEC_TOKEN=$SHIM_TOKEN
npm run dev
```

Interactive command sessions stay local-only; with a remote backend the agent
uses bounded foreground `bash`. The environment handed to `/exec` is the
explicit allowlist the SDK built — the shim must use it as the complete child
environment and must not merge ambient secrets.

## Files

| File | What it owns |
| --- | --- |
| `instructions.md` | How the agent works a task. Prose only |
| `agent.ts` | Model, budget, breakers |
| `server.ts` | The session server: coding agent + execution backend + durable store |
| `tools/github.ts` | Caveman Connect as one `connected_data` tool, added by an explicit definition transform |
| `sandbox-shim/server.mjs` | Reference execution backend for any container |

## Cost honesty

`budget.maxUsd` in `agent.ts` is a local cap priced from the public catalog. It
is not an invoice, a platform quota, or a cross-process reservation, and a run
on a model the catalog cannot price fails closed rather than spending an
imaginary `$0`. Every run returns a receipt with the per-call breakdown; local
numbers stay inferred.
