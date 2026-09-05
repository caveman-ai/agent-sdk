// The same agent behind HTTP sessions. A session owns one conversation and one
// run controller: messages that arrive during a run queue onto it, and every
// attached client sees the same event stream. Every run is journaled.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SqlDurableStore } from "@caveman-ai/agent/durable";
import { createAgentServer } from "@caveman-ai/agent/serve";
import { rootDir, supportDesk } from "./agent.ts";
import { runOptions } from "./options.ts";

const token = process.env.CAVE_SERVE_TOKEN;
if (token === undefined || token.length < 16) {
  throw new Error("set CAVE_SERVE_TOKEN (16+ characters) in .env; this endpoint spends money");
}

// One journal per session in SQLite. The store's whole database dependency is
// one exec(query, params) method, so Postgres or a Durable Object's SQLite
// are the same three lines.
mkdirSync(join(rootDir, ".caveman"), { recursive: true });
const db = new DatabaseSync(join(rootDir, ".caveman", "sessions.db"));
db.exec(SqlDurableStore.schema("sqlite"));
const store = new SqlDurableStore({
  sql: { exec: (query, params) => db.prepare(query).all(...(params as SQLInputValue[])) },
  dialect: "sqlite",
});

const server = createAgentServer({
  definition: supportDesk,
  token,
  store,
  rootDir,
  runOptions: () => runOptions(),
});
const port = await server.listen(Number(process.env.PORT ?? 8787), "127.0.0.1");
const base = `http://127.0.0.1:${port}`;
const auth = `-H "authorization: Bearer $CAVE_SERVE_TOKEN" -H "content-type: application/json"`;
console.log(`support desk listening on ${base}

  # open a session; the id is also the journal key
  curl -s -X POST ${base}/sessions ${auth} -d '{"sessionId":"maya"}'

  # watch it (SSE). Open this in two terminals: both see the same frames.
  curl -N ${base}/sessions/maya/events -H "authorization: Bearer $CAVE_SERVE_TOKEN"

  # send a message; one sent while a run is active queues onto it
  curl -s -X POST ${base}/sessions/maya/messages ${auth} -d '{"text":"Where is order NB-1042?"}'

  # runs, active run, queue depth
  curl -s ${base}/sessions/maya -H "authorization: Bearer $CAVE_SERVE_TOKEN"
`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close(5_000).then(() => { db.close(); process.exit(0); });
  });
}
