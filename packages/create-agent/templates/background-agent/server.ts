import { mkdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { httpExecutionBackend, localExecutionBackend } from "@caveman-ai/agent";
import { createCodingAgent } from "@caveman-ai/agent/code";
import { SqlDurableStore } from "@caveman-ai/agent/durable";
import { createAgentServer } from "@caveman-ai/agent/serve";
import config from "./agent.ts";
import { withGitHub } from "./tools/github.ts";

const token = process.env.CAVE_SERVE_TOKEN;
if (token === undefined || token.length < 16) {
  throw new Error("set CAVE_SERVE_TOKEN to a secret of at least 16 characters; this endpoint spends money");
}

// Where the tools run. No CAVE_EXEC_URL means the agent's bash, read, and
// write hit this machine directly — that is host execution, not isolation.
const execUrl = process.env.CAVE_EXEC_URL;
const execToken = process.env.CAVE_EXEC_TOKEN;
if (execUrl !== undefined && (execToken === undefined || execToken === "")) {
  throw new Error("CAVE_EXEC_URL requires CAVE_EXEC_TOKEN");
}
const executionBackend = execUrl === undefined
  ? localExecutionBackend()
  : httpExecutionBackend({ url: execUrl, token: execToken! });

// One session store. In dev it is a file under .caveman/ so a restart resumes
// the sessions this process was driving; `:memory:` is the throwaway form.
mkdirSync(".caveman", { recursive: true });
const db = new DatabaseSync(process.env.CAVE_SESSIONS_DB ?? ".caveman/sessions.db");
db.exec(SqlDurableStore.schema("sqlite"));
const store = new SqlDurableStore({
  // The journal only ever binds strings, numbers, and null; the cast is the
  // seam between the store's driver-neutral `unknown[]` and node:sqlite.
  sql: { exec: (query, params) => db.prepare(query).all(...params as SQLInputValue[]) },
  dialect: "sqlite",
});
// On Cloudflare the same store wraps the Durable Object's synchronous SQLite,
// which is what gives you one journal per session with no database to run:
//
//   const store = new SqlDurableStore({
//     sql: { exec: (query, params) => [...this.ctx.storage.sql.exec(query, ...params)] },
//     dialect: "sqlite",
//   });

const coding = createCodingAgent({
  workspace: process.env.CAVE_WORKSPACE ?? process.cwd(),
  model: config.model,
  executionBackend,
  definitionTransforms: [withGitHub],
});

const server = createAgentServer({
  definition: coding.definition,
  token,
  store,
  // Run defaults for every session run. `runOptions` also accepts a per-run
  // factory — `({ sessionId, runId }) => ({ … })` — when each run needs its
  // own values.
  runOptions: { budget: config.budget, breakers: config.breakers },
});

const port = await server.listen(Number(process.env.PORT ?? 8080));
process.stdout.write(`background agent listening on http://127.0.0.1:${port}\n`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close(5_000).then(() => coding.close()).then(() => process.exit(0));
  });
}
