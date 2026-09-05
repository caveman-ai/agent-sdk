// The investigator behind durable sessions. `authenticate` maps a request to
// a principal; the per-run options factory turns that principal into a grant
// and a tool policy, so authority is decided per caller, outside the model.
// Messages may attach `context` (the trace/eval/deployment a page was
// showing), which reaches the model inside the user message.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SqlDurableStore } from "@caveman-ai/agent/durable";
import { createAgentServer } from "@caveman-ai/agent/serve";
import { investigator, rootDir } from "./agent.ts";
import { runOptions } from "./options.ts";
import type { Grant } from "./policy.ts";

const token = process.env.CAVE_SERVE_TOKEN;
if (token === undefined || token.length < 16) {
  throw new Error("set CAVE_SERVE_TOKEN (16+ characters) in .env; this endpoint spends money");
}

/** Stand-in for a real grant store: the tenant header names the grant. */
const grants: Record<string, Grant> = {
  acme: { tenant: "acme", scopes: new Set(["read", "write_resource"]) },
  globex: { tenant: "globex", scopes: new Set(["read"]) },
};

mkdirSync(join(rootDir, ".caveman"), { recursive: true });
const db = new DatabaseSync(join(rootDir, ".caveman", "sessions.db"));
db.exec(SqlDurableStore.schema("sqlite"));
const store = new SqlDurableStore({
  sql: { exec: (query, params) => db.prepare(query).all(...(params as SQLInputValue[])) },
  dialect: "sqlite",
});

const server = createAgentServer({
  definition: await investigator(),
  store,
  rootDir,
  // Bearer proves the caller may reach the server at all; the tenant header
  // says who they are. A real deployment verifies a JWT here instead.
  authenticate: (request) => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return undefined;
    const tenant = request.headers.get("x-tenant") ?? "";
    return tenant in grants ? { id: `${tenant}:analyst`, tenant } : undefined;
  },
  runOptions: ({ principal }) => runOptions(
    // Boot recovery re-drives runs without a principal: fall back to read-only.
    grants[principal?.tenant ?? ""] ?? { tenant: "recovered", scopes: new Set(["read"]) },
  ),
});
const port = await server.listen(Number(process.env.PORT ?? 8788), "127.0.0.1");
const base = `http://127.0.0.1:${port}`;
const auth = `-H "authorization: Bearer $CAVE_SERVE_TOKEN" -H "x-tenant: acme" -H "content-type: application/json"`;
console.log(`investigator listening on ${base}

  curl -s -X POST ${base}/sessions ${auth} -d '{"sessionId":"regression-1"}'
  curl -N ${base}/sessions/regression-1/events -H "authorization: Bearer $CAVE_SERVE_TOKEN" -H "x-tenant: acme"
  curl -s -X POST ${base}/sessions/regression-1/messages ${auth} \\
    -d '{"text":"Did my agent get worse this week? Catch it next time.","context":{"agent":"support-desk","window":{"from":"2026-09-01T00:00:00Z","to":"2026-09-05T00:00:00Z"}}}'

  x-tenant: globex holds a read-only grant; its activate_evaluator calls are denied before they run.
`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void server.close(5_000).then(() => { db.close(); process.exit(0); });
  });
}
