# Serving and hosting

`caveman-agent serve` is the deployable target: one agent directory behind a
small HTTP surface, with every run journaled.

```bash
CAVE_SERVE_TOKEN=$(openssl rand -hex 24) caveman-agent serve
```

```bash
caveman-agent serve [dir] [--port N] [--host H] [--locked]
```

| Argument | Default | Notes |
| --- | --- | --- |
| `dir` | `.` | Agent directory (`instructions.md` present) or a project with `src/agent.ts` |
| `--port` | `PORT`, else `8080` | Must be a valid port number |
| `--host` | `HOST`, else `0.0.0.0` | |
| `--locked` | off | Every run executes through `.caveman/agent.lock.json` instead of `run()` |

## HTTP contract

```text
POST /runs          {"runId":"…","input":"…","context"?:{…}}   → 202 accepted, 200 if already settled
GET  /runs/{runId}                              → the run's journaled status
GET  /runs/{runId}/events                       → Pebble v1 frames over SSE
DELETE /runs/{runId}                            → request durable cancellation
GET  /healthz                                   → liveness, no credential
GET  /readyz                                    → 503 until the recovery sweep finishes
```

`/runs` requires `Authorization: Bearer $CAVE_SERVE_TOKEN`. There is **no**
unauthenticated mode: the endpoint spends money and returns model output. A
token shorter than 16 characters is refused at construction, and comparison is
length-independent.

### More than one tenant

One token is one tenant. For a deployment that serves several, pass
`authenticate` instead and let the SDK isolate what follows:

```ts
createAgentServer({
  definition,
  authenticate: async (request) => {
    const claims = await verifyJwt(request.headers.get("authorization"));
    return claims === undefined ? undefined : { id: claims.sub, tenant: claims.org };
  },
});
```

The SDK does not own identity. Verify a JWT, an mTLS peer, or a session cookie
however the deployment already does, and return who the request belongs to;
returning `undefined` is a `401`. So is **throwing** — a verifier that cannot
reach its JWKS must not fall open.

The principal is handed to the per-run options factory, which is where
per-tenant budgets and tool authorization live:

```ts
createAgentServer({
  definition,
  authenticate,
  runOptions: ({ sessionId, principal }) => ({
    budget: { maxUsd: plans.for(principal?.tenant).perRunUsd },
    toolPolicy: (call) => grants.decide(principal, call),
  }),
});
```

`principal` is present for runs an authenticated request started. It is absent
for runs re-driven by boot recovery, because the journal deliberately carries
no caller identity; a factory that needs one should fall back to its most
conservative defaults rather than assume.

What the SDK does own is isolation. A session's storage key is the id the caller
asked for, prefixed with a hash of `principal.id`, so two principals can both
hold `"inbox"` without either seeing the other's, and a principal asking for a
session it does not own gets `404` rather than `403` — whether another tenant
holds that id is not this caller's to learn. Because the prefix is part of the
stored id rather than a separate owner record, isolation survives a restart:
sessions are rebuilt from run ids, and a run id already carries its namespace.

`/runs` is **not** principal-scoped. It addresses journals by raw run id with
nothing binding a run to a caller, so with `authenticate` configured it returns
`403 cave_serve_runs_require_single_principal` instead of quietly handing one
principal another's runs. Multi-tenant deployments use `/sessions`.

### One instance at a time

Sessions, their replay buffers, and their deletion tombstones live in the
serving process. Two instances against one store therefore do not share them:
the same session could be driven from both, with neither seeing the other's
messages. Run journals are individually leased and stay safe; session state is
what diverges.

So the server takes an instance lease at `listen()` and refuses to start with
`cave_serve_instance_already_active` while another instance holds it. The lease
expires, so a crashed instance is taken over by the next one — **active/standby
works, active/active does not**. Set `singleInstance: false` only for a
deployment where no session is ever addressed from two instances.

Making active/active safe means moving session ownership into the store, which
is not done yet. Until it is, this is a startup refusal rather than a split
brain discovered in production.

### Status codes

| Code | When |
| --- | --- |
| `200` | The run is already settled (its journaled outcome is returned), or a `GET` found a run |
| `202` | Accepted — `{"runId","status":"running"}` or `"resuming"` |
| `400` | `cave_durable_run_id_invalid`, `cave_serve_run_id_reserved`, `cave_serve_body_invalid_json`, `cave_serve_body_invalid`, `cave_serve_run_id_required`, `cave_serve_input_must_be_text` |
| `401` | `cave_serve_unauthorized` |
| `404` | `cave_serve_not_found`, or a `GET` for a run with no journal |
| `413` | Body over the ceiling (default 1 MiB) |
| `503` | `cave_serve_draining` (SIGTERM in progress), `cave_serve_queue_full`, or `/readyz` before recovery finishes |

Input is **text only**. A multimodal input would journal a digest, which no
unattended resume could reconstruct.

Caller-chosen `/runs` ids must not end in `.<digits>`. That namespace is
reserved for session journals (`${sessionId}.${n}`).

## What the server adds to the journal

Durability belongs to the journal, not the server. The server adds exactly three
things, and no scheduler, queue, or orchestration beyond them:

1. **An idempotent submit.** `runId` is already the durable idempotency key, so
   resubmitting a settled run replays its journaled outcome and spends nothing.
2. **Recovery.** On boot **and every 60 seconds** after. The periodic pass is
   what reclaims a run stranded by a *peer* instance's death — a boot-only sweep
   would leave it forever.
3. **A SIGTERM drain.** Best effort by design: unfinished runs stay journaled
   and the next instance resumes them, so the drain is never the correctness
   boundary.

The guarantee remains at-least-once at the step boundary, and the uncertainty
window is on the receipt as `resume.possibleDoubleCountCalls`.

A run whose input was multimodal is not auto-resumed; that is reported in the
recovery report, not swallowed.

## Programmatic use

```ts
import { createAgentServer } from "@caveman-ai/agent/serve";

const server = createAgentServer({
  definition,
  token: process.env.CAVE_SERVE_TOKEN!,
  rootDir: process.cwd(),
  store,                    // optional; defaults to DiskDurableStore
  build,                    // optional AnyCaveBuildLock → runLocked for every run
  // Factory form prevents controllers, signals, and other per-run state from sharing.
  runOptions: ({ runId }) => ({ budget, workflow: runId }),
  maxConcurrentRuns: 2,     // model calls are the bottleneck, not CPU
  maxQueuedRuns: 64,        // accepted-but-not-started ceiling before shedding load
  maxBodyBytes: 1024 * 1024,
});

const port = await server.listen(8080, "0.0.0.0");
```

The existing `runOptions: { ... }` object remains accepted for compatibility,
but it cannot contain `durable`, `controller`, `signal`, or `conversation`.
Those values are per-run and server-owned. New servers should use the factory.
Its `sessionId` context value is informational: the server supplies the runtime
`sessionId` and overrides any value returned by the factory.

## Sessions

A session owns one durable conversation and one Pi-backed
`AgentRunController`. Messages arriving during a run use Pi's existing
follow-up queue by default; `mode: "steer"` uses Pi's steering queue. Idle
messages start `${sessionId}.${n}` with the same conversation.

```text
POST   /sessions                       {"sessionId":"…"} → 201 {sessionId}
POST   /sessions/{id}/messages         {"text":"…","author"?:"…","mode"?:"followUp"|"steer","context"?:{…}}
GET    /sessions/{id}                  → {sessionId,runs,active?,queued,messages}
GET    /sessions/{id}/events           → Pebble v1 frames over one multi-run SSE stream
DELETE /sessions/{id}                  → cancel active run, drop Pi queues, delete process-local state
WS     /sessions/{id}/ws               → bidirectional session transport
```

All session routes use the same bearer authentication as `/runs`. WebSocket
clients that can set headers send `Authorization: Bearer …`. Non-browser
clients that cannot set headers may offer subprotocols `caveman-agent` and
`cave-bearer.<base64url-token>`; the server selects only `caveman-agent`, so
the token is never echoed. Browsers never hold the server token: `useSession`
from `@caveman-ai/react` speaks to a same-origin proxy that adds the bearer
(on the upgrade too), the same way `useAgent` does.

A message may attach structured `context`: the resource ids, filters, windows,
or versions a UI page was showing when the user asked ("Ask about this trace").
It must be a JSON object or array under 64 KiB serialized, and it rides inside
the user message as one fenced `<cave-message-context>` block, so it is exactly
as trusted as the message text, replays byte-for-byte from the journal, and
never enters the cached prefix. Nothing is escaped, so do not put
server-derived facts the agent should trust in `context`; those belong in a
`context()` segment on the definition or in the run options. Invalid context is `400
cave_session_message_context_invalid` (or `_too_large`). `POST /runs` accepts
the same field. The `text` recorded in `GET /sessions/{id}` `messages` is what
the caller sent, without the context.

Client WebSocket messages are either
`{"type":"message","text":"…","author"?:"…","mode"?:"followUp"|"steer","context"?:{…}}`
or `{"type":"cancel"}`. Server messages are unchanged Pebble frames. SSE and
WebSocket replay use the same bounded process-local buffer and gap reporting.
Run journals remain authority.

Session deletion is process-local. It suppresses that session for the lifetime
of the current handler; its journals remain durable, so the session reappears
after process restart.

Route one session id to one server instance. A Durable Object provides this
ownership by construction. Per-run journal locks are a fail-closed backstop:
another instance returns `409 cave_session_busy_elsewhere` while the owner holds
the pending session run; the lock is not a replacement for session-affine
routing.

Pebble v1 has no author metadata field and its frozen `turn.start` has no
payload extension field. Author therefore appears in `GET /sessions/{id}`
`messages`, not in Pebble frames. It is process-local metadata; durable
conversation checkpoints preserve message content, not author.

## Fetch handler

Use the web-standard handler when the host owns HTTP and WebSocket upgrades:

```ts
import { createAgentHandler } from "@caveman-ai/agent/serve-handler";

const handler = createAgentHandler({
  definition,
  token: env.CAVE_SERVE_TOKEN,
  store,
  runOptions: ({ runId }) => ({
    workflow: runId,
  }),
  upgrade(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    return {
      response: new Response(null, {
        status: 101,
        webSocket: client,
        headers: { "sec-websocket-protocol": "caveman-agent" },
      } as ResponseInit),
      socket: server,
    };
  },
});

export class AgentSession extends DurableObject {
  fetch(req: Request) { return handler.fetch(req); }
}
```

Cloudflare code must supply a Durable Object-backed `DurableStore`; local disk
is not durable there. `createAgentHandler` never imports `node:http`. Node's
`createAgentServer` wrapper lazily loads optional peer `ws`; an upgrade fails
closed with `cave_serve_websocket_unavailable` when it is absent.

`executionBackend` configures `createCodingAgent`; it is not a `RunOptions`
field and does not belong in `runOptions`.

`AgentServer` exposes the underlying `server` for callers that own their own
listen/upgrade wiring, plus the recovery entry point whose `RecoveryReport`
carries `listable`, `resumed[]`, and `skipped[{ runId, reason }]`.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `CAVE_SERVE_TOKEN` | yes | Bearer token for `/runs` |
| `CAVE_JOURNAL_URL` | no | Switches the journal to `HttpDurableStore` |
| `CAVE_JOURNAL_TOKEN` | with `CAVE_JOURNAL_URL` | Bearer token for that journal |
| `PORT` / `HOST` | no | Defaults `8080` / `0.0.0.0` |

Setting `CAVE_JOURNAL_URL` without `CAVE_JOURNAL_TOKEN` refuses at startup.

## Containers

The deployable unit is a container, because the runtime shells out for
host-sandbox tools.

```bash
docker build -f node_modules/@caveman-ai/agent/hosting/Dockerfile -t my-agent .
```

Two things decide whether a deployment is actually durable:

- **The journal must outlive the instance.** Mount a volume at `/app/.caveman`,
  or set `CAVE_JOURNAL_URL` at an `HttpDurableStore` endpoint. Without one, an
  instance restart loses the journal, and a lost journal is a lost resume.
- **Health checks must distinguish `/healthz` from `/readyz`.** Routing traffic
  to an instance that has not finished its recovery sweep re-drives runs under a
  second driver.

Allow at least 30s for the SIGTERM drain. Runs that do not finish are journaled
and picked up by the next instance, so a short grace period costs latency, never
correctness.

## Cloudflare

Workers has no `node:child_process` and container disk does not survive the
instance, so the recipe is: the agent in a Container, the journal in a Durable
Object — a single writer with ordered appends whose response is delivered only
once the write is durable.

```bash
npm install @cloudflare/containers
npm install -D wrangler

cp node_modules/@caveman-ai/agent/hosting/cloudflare/* .
# set PUBLIC_URL in wrangler.jsonc to your deployed Worker origin
wrangler secret put CAVE_SERVE_TOKEN
wrangler secret put CAVE_JOURNAL_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler deploy
```

The same image runs on Fly, Railway, Render, ECS, or Kubernetes.

Full hosting notes:
[`packages/agent/hosting/README.md`](../../packages/agent/hosting/README.md).
API: [`@caveman-ai/agent/serve`](../reference/api/agent/serve.md).
