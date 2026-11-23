// Caveman Cloud: the same session over the Agents API (CONTRACT §3), through the generated client in
// @caveman-ai/sdk/agents. The session runs on its own Cloud computer; this file only starts it, follows its event
// stream (reconnecting from the last event, as the server ends a stream after 15 minutes) and posts the caller's
// input.

import { randomUUID } from "node:crypto";

import { Agents, CloudError, type CodeAgent } from "@caveman-ai/sdk/agents";

import type { Transport } from "./session.ts";
import { CavemanError, type SessionEvent, type UserEvent } from "./types.ts";

export interface CloudStart {
  /** A published agent's id or name, or an agent file's text to publish first (a new version only when it changed). */
  readonly agent: { readonly ref: string } | { readonly name: string; readonly file: string } | undefined;
  readonly repo: string;
  readonly baseBranch?: string;
  readonly task: string;
  readonly model?: string;
  readonly budgetUsd?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

const RECONNECT_DELAYS_MS = [250, 1000, 3000, 5000];
/**
 * Input Cloud gave no sure answer to is posted again after these (the last repeating while the stream follows the
 * session), under its first request_id: Cloud answers a request_id it has taken with that first answer, so it takes
 * the input once.
 */
const POST_RETRY_DELAYS_MS = [250, 1000, 3000];

/** Cloud gave no answer (the network, a timeout), or one that may not repeat: a 408, a 429 or a 5xx. */
const transient = (failure: unknown) => !(failure instanceof CloudError) || failure.status === 408 || failure.status === 429 || failure.status >= 500;

/** A published agent by id (`agt_…`) or by name. */
async function agentRef(client: Agents, ref: string): Promise<{ id: string; version?: number }> {
  if (ref.startsWith("agt_")) return { id: ref };
  const { agents } = await client.listAgents();
  const found = agents.find((agent) => agent.name === ref);
  if (found === undefined) throw new CavemanError("agent_not_found", `No agent named "${ref}" in this Cloud organization; publish it first.`);
  return { id: found.id, version: found.version };
}

/** Publishes `file` as the agent `name`: creates it, or adds a version when the text changed (Cloud keeps one per sha256). */
async function publish(client: Agents, name: string, file: string): Promise<{ id: string; version: number }> {
  const { agents } = await client.listAgents();
  const existing = agents.find((agent) => agent.name === name);
  const saved: CodeAgent = existing === undefined
    ? await client.createAgent({ name, file })
    : await client.updateAgent(existing.id, { file, version: existing.version });
  return { id: saved.id, version: saved.version };
}

export async function startCloud(client: Agents, start: CloudStart): Promise<Transport> {
  const agent = start.agent === undefined ? undefined : "ref" in start.agent ? await agentRef(client, start.agent.ref) : await publish(client, start.agent.name, start.agent.file);
  const session = await client.startSession({
    request_id: randomUUID(),
    repo: start.repo,
    task: start.task,
    ...(agent === undefined ? {} : { agent }),
    ...(start.baseBranch === undefined ? {} : { base_branch: start.baseBranch }),
    ...(start.model === undefined ? {} : { model: start.model }),
    ...(start.budgetUsd === undefined ? {} : { budget_usd: start.budgetUsd }),
    ...(start.metadata === undefined ? {} : { metadata: { ...start.metadata } }),
  });
  const stop = new AbortController();
  /** The stream ended on its own: the session's end, or reconnects that ran out. */
  let streamEnded = false;

  // Closing ends the read even when a fetch doesn't cancel its body on abort.
  const stopped = new Promise<{ done: true; value: undefined }>((resolve) => stop.signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true }));

  async function* events(): AsyncGenerator<SessionEvent> {
    let after = 0;
    let failures = 0;
    try {
      while (!stop.signal.aborted) {
        const stream = client.streamEvents(session.id, { after }, { signal: stop.signal });
        let got = 0;
        try {
          for (;;) {
            const next = await Promise.race([stream.next(), stopped]);
            if (next.done) break;
            const event = next.value;
            failures = 0;
            got++;
            after = event.seq;
            const full = { ...event, created_at: (event as { created_at?: string }).created_at ?? new Date().toISOString() } as SessionEvent;
            yield full;
            if (full.type === "session.status" && full.data.status === "terminated") return;
          }
          // The server ends a stream now and then; reconnect from the last event, pausing if it gave none.
          if (got === 0 && !stop.signal.aborted) await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAYS_MS[0]));
        } catch (failure) {
          if (stop.signal.aborted) return;
          const delay = RECONNECT_DELAYS_MS[failures++];
          if (delay === undefined) throw failure;
          await new Promise((resolve) => setTimeout(resolve, delay));
        } finally {
          void stream.return(undefined).catch(() => undefined);
        }
      }
    } finally {
      streamEnded = true;
    }
  }

  /**
   * Answers the mail Cloud made of the input (the same one for a post again: Cloud replays a request_id's mail), or
   * nothing for input Cloud took whose answer could not be read.
   */
  const post = async (event: UserEvent) => {
    const input = { request_id: randomUUID(), ...event };
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.sendEvent(session.id, input);
      } catch (failure) {
        if (failure instanceof CloudError && failure.code === "cave_code_session_closed") throw new CavemanError("session_ended", failure.message);
        // A 2xx whose body could not be read (cut short, a proxy's page) still says Cloud took the input. Only a
        // message needs the mail's id (its turn is found by it), so only a message asks again for it.
        const taken = failure instanceof CloudError && failure.status >= 200 && failure.status < 300;
        if (taken && event.type !== "user.message") return undefined;
        if (!taken && !transient(failure)) throw failure;
        // Cloud may have taken it, and a caller told it failed takes back a message Cloud runs, or stops a session
        // over an answer that landed. So ask again until Cloud says, while the stream follows the session. Once the
        // stream has stopped (close, kill, the session's end) nothing here waits on the session, but a late answer
        // and kill()'s Stop still get the retries they always had.
        if ((stop.signal.aborted || streamEnded) && attempt >= POST_RETRY_DELAYS_MS.length) {
          throw new CavemanError("session_ended", "Stopped following the session before Cloud said whether it took this input; it may have.");
        }
        await new Promise((resolve) => setTimeout(resolve, POST_RETRY_DELAYS_MS[Math.min(attempt, POST_RETRY_DELAYS_MS.length - 1)]));
      }
    }
  };

  return {
    id: session.id,
    events: events(),
    // The computer says the mail's id on the message's user.message, or on the session.error refusing it.
    // post reads a message's mail or throws.
    message: async (text) => (await post({ type: "user.message", text }))!.id,
    send: async (event) => {
      await post(event);
    },
    close: async () => stop.abort(),
    kill: () => {
      void post({ type: "user.interrupt" }).catch(() => undefined);
      stop.abort();
    },
  };
}
