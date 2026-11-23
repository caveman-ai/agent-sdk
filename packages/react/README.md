# @caveman-ai/react

A React hook for streaming a Caveman agent run.

```bash
npm install @caveman-ai/react
```

## The one thing to get right first

The agent server's `/runs` endpoint requires a bearer token, and `serve.ts`
describes that token accurately: it **spends money and returns model output**.
It belongs on your server.

So `useAgent` takes no token and no absolute origin. It calls a same-origin path
in your own app, and your route forwards the request with the credential
attached. If a client library ever offers to hold that token for you, it is
offering to put it in your bundle.

`useSession` works the same way: same-origin `api` path, no token, including on
the WebSocket transport. The server does accept the bearer as a `cave-bearer.`
subprotocol, but that exists for clients that can't set headers — in a browser a
subprotocol is as public as the bundle it ships in.

## Client

```tsx
"use client";
import { useAgent } from "@caveman-ai/react";

export function Chat() {
  const { text, tools, status, usage, error, submit } = useAgent({ api: "/api/agent" });

  return (
    <div>
      <button onClick={() => submit("how many items are queued?")} disabled={status === "streaming"}>
        Ask
      </button>
      {tools.map((tool) => (
        <div key={tool.id}>{tool.name} — {tool.status}</div>
      ))}
      {/* Streaming text arrives after the render a screen reader announced, so
          the region has to announce its own updates. `polite` waits for a pause
          instead of interrupting; `assertive` on a token stream is unusable. */}
      <p aria-live="polite" aria-busy={status === "streaming"}>{text}</p>
      {error && <p role="alert">{error.message}</p>}
      {usage && (
        <small>
          {usage.in + usage.out} tokens ·{" "}
          {usage.costUsd === null ? "cost unknown" : `$${usage.costUsd.toFixed(4)}`}
        </small>
      )}
    </div>
  );
}
```

## Server (Next.js App Router)

Two routes, both pure proxies. The token never leaves the server.

```ts
// app/api/agent/runs/route.ts
export async function POST(request: Request) {
  return fetch(`${process.env.AGENT_URL}/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.AGENT_TOKEN}`,
    },
    body: await request.text(),
  });
}
```

```ts
// app/api/agent/runs/[runId]/events/route.ts
export async function GET(request: Request, { params }: { params: { runId: string } }) {
  const upstream = await fetch(
    `${process.env.AGENT_URL}/runs/${encodeURIComponent(params.runId)}/events`,
    {
      headers: {
        authorization: `Bearer ${process.env.AGENT_TOKEN}`,
        // Pass the resume cursor through, or a reconnect replays from the start.
        ...(request.headers.get("last-event-id")
          ? { "last-event-id": request.headers.get("last-event-id")! }
          : {}),
      },
    },
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
```

Authorize the user in these routes. They are where your app decides who is
allowed to spend money.

## What the hook returns

| Field | Meaning |
| --- | --- |
| `status` | `idle`, `streaming`, `complete`, `error`, or `detached` |
| `text` | Assistant text so far |
| `thinking` | Reasoning deltas, when the model emits them |
| `tools` | `{ id, name, args, status, detail }` per tool call |
| `usage` | Running token totals, and `costUsd` — see below |
| `route` | The model actually chosen, and why |
| `stopReason` | `end_turn`, `budget_paused`, `interrupted`, or `error` |
| `error` | `{ message, retryable }` |
| `gap` | Set when the server could not replay a span this client missed |
| `runId` | The id this run was submitted under |
| `submit(input)` | Starts a run, resolves with its id |
| `watch(runId)` | Attaches to a run this hook did not submit — see below |
| `stopWatching()` | Stops watching — see below |

### `usage.costUsd` can be null

Null means **unknown**, never zero. If any message in the turn was unpriced, the
turn's cost is unknown, and the hook will not hand you a priced subtotal dressed
up as a total. Token counts stay exact either way. Render the null case.

### `stopWatching()` does not cancel the run

`DELETE /runs/:id` cancels. `stopWatching()` deliberately does not call it:
stopping closes only this view, while the agent keeps working. The run stays
journaled, and `watch(runId)` reattaches while events remain held.

### `gap` means the transcript has a hole

The server holds a bounded window of recent events per run. If you reconnect
after being away longer than that window, it says so instead of silently handing
you a transcript missing its middle. `gap` carries `requestedSeq` and
`earliestSeq`. The authoritative outcome is always `GET /runs/:id`.

Reconnects inside the window are seamless: events carry their protocol sequence
as the SSE event id, so `EventSource` resumes from `Last-Event-ID` with no
duplicates.

## Surviving a reload with `watch(runId)`

A run outlives the tab that started it. `submit` returns the run id before the
first token arrives, so persist it and hand it back to `watch` on mount:

```tsx
const { text, status, submit, watch } = useAgent({ api: "/api/agent" });

useEffect(() => {
  const resuming = sessionStorage.getItem("runId");
  if (resuming) watch(resuming);
}, [watch]);

async function ask(input: string) {
  sessionStorage.setItem("runId", await submit(input));
}
```

`watch` replays the run from its first event, so the state it rebuilds is the
state an uninterrupted stream would have produced — no partial transcript, no
duplicated text. Where you keep the id is yours to decide, which is why the hook
does not resume by itself: nothing in a hook knows whether a reload should
reattach to the last run or start clean.

The server's event window is in-memory and bounded. A run that settled long ago,
or one whose events died with the instance that produced them, has no stream
left to attach to and surfaces as a closed stream. `GET /runs/:id` is always the
authoritative outcome; this endpoint only reports events.

## Sessions

`useSession` retains Pebble frames across consecutive durable runs and sends
active-run messages through server-owned Pi queues:

```tsx
const { events, send, cancel, status, gap } = useSession({
  api: "/api/agent",
  sessionId: "case-42",
  transport: "ws", // or "sse"
});

await send("check again", { author: "Ada", mode: "followUp" });
```

Same rule as `useAgent`: `api` is a same-origin base path, and your routes proxy
`GET /sessions/:id/events` (or the `/ws` upgrade), `POST /sessions/:id/messages`
and `DELETE /sessions/:id` with the bearer attached. For WebSocket the proxy
either adds `Authorization` on the upgrade or terminates the socket itself.

On `sse`, `EventSource` reconnects and resumes from `Last-Event-ID`. On `ws` the
hook reconnects instead — a browser socket does neither on its own — reopening
after 250ms with `?lastEventId=<seq>`, which the server answers with exactly the
span that was missed. A `cancel()` or an unmount stops that for good.

`send` goes over the socket on `ws` and `POST /sessions/:id/messages` on `sse`.
`cancel()` calls `DELETE /sessions/:id`, so it cancels the active run and drops
the queue. `reduceSessionEvent` and `SESSION_INITIAL_STATE` are exported for
custom transports.

### A session `gap` is a hole, not a failure

Resume from a sequence the server's bounded window no longer holds and it says
so before it streams. `gap` becomes `true` and `lastGap` carries
`{ requestedSeq, earliestSeq }`. It means **history before this point was
evicted; the transcript is complete from here** — the server then sends the
whole retained window and keeps streaming, so `status` stays live rather than
going to `error`. Run journals remain the authority for what actually happened.

## `useAgent`: one run per `submit`, not a chat thread

There is no `messages` array here, because there is no thread on the server. The
agent server runs one agent over one input per run, and a run is not a reply to
the last one. A message list assembled in the browser would look like a
conversation the model never saw. Keep your own history if you want one; the
hook will not imply the agent has it.

## Renders are batched to the frame

A turn emits a text delta per token, and one render per token is what stalls a
streaming UI once the tree gets heavy. Events are applied once per animation
frame instead, in arrival order and losing nothing — rendering faster than the
display repaints produces no frame anyone sees. There is no throttle option: if
a single frame is still too expensive, the cost is in your tree, and `memo` on
the components that do not depend on `text` is the fix.

## Driving your own transport

`reduceAgentEvent` is pure and exported. Feed it Pebble v1 `TurnEvent`s from
wherever you like and get the same state the hook builds.

```ts
import { INITIAL_STATE, reduceAgentEvent } from "@caveman-ai/react";

const state = events.reduce(reduceAgentEvent, INITIAL_STATE);
```

## License

Apache-2.0
