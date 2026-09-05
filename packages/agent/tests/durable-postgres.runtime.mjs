import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { SqlDurableStore } from "../dist/durable.js";
import {
  assertDurableResume,
  assertExclusiveAcquire,
  assertJournalRoundTrip,
} from "./durable-store-contract.mjs";

// The sqlite-backed suite proves this store emits `$1…$n`; it cannot prove
// Postgres accepts the result. This one runs the same contract against a real
// server, so the DDL types, ON CONFLICT, LENGTH(), and the lease compare-and-set
// are exercised by the engine that will actually run them in production.
//
// Skipped unless CAVEMAN_TEST_POSTGRES_URL points at a throwaway database. CI
// sets it from a service container; locally:
//   docker run -d -e POSTGRES_PASSWORD=caveman -e POSTGRES_DB=caveman \
//     -p 55432:5432 postgres:16-alpine
//   CAVEMAN_TEST_POSTGRES_URL=postgres://postgres:caveman@127.0.0.1:55432/caveman \
//     node --test packages/agent/tests/durable-postgres.runtime.mjs
const url = process.env.CAVEMAN_TEST_POSTGRES_URL;
const options = url === undefined || url === ""
  ? { skip: "set CAVEMAN_TEST_POSTGRES_URL to run the real-Postgres durability suite" }
  : {};

let pool;

before(async () => {
  if (options.skip !== undefined) return;
  const { default: pg } = await import("pg");
  pool = new pg.Pool({ connectionString: url, max: 8 });
  // Fail loudly on an unreachable server rather than skipping: the whole point
  // of this file is that "postgres is covered" cannot be silently untrue.
  await pool.query("SELECT 1");
});

after(async () => { await pool?.end(); });

// One table per test keeps the suite order-independent and lets it run against a
// database someone else is also using.
let tableSeq = 0;
async function freshStore(storeOptions = {}) {
  const table = `cave_pg_test_${process.pid}_${tableSeq++}`;
  const executor = {
    async exec(sql, params) {
      const result = await pool.query(sql, [...params]);
      return result.rows;
    },
  };
  await pool.query(SqlDurableStore.schema("postgres", table));
  return {
    table,
    executor,
    make: (extra = {}) =>
      new SqlDurableStore({ sql: executor, dialect: "postgres", table, ...storeOptions, ...extra }),
  };
}

test("postgres: schema DDL applies to a real server", options, async () => {
  const { table } = await freshStore();
  const { rows } = await pool.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)",
    [[table, `${table}_leases`]],
  );
  assert.equal(rows.length, 2, "both journal and lease tables should exist");
});

test("postgres: appends load back in order and every run is listable", options, async () => {
  const { make } = await freshStore();
  await assertJournalRoundTrip(make());
});

test("postgres: one driver at a time, across two store instances", options, async () => {
  const { make } = await freshStore();
  await assertExclusiveAcquire(make(), make());
});

test("postgres: a crashed run resumes from its last completed turn", options, async () => {
  const { make } = await freshStore();
  await assertDurableResume(make(), "sql-postgres-resume");
});

test("postgres: an expired lease is reaped by the next acquirer", options, async () => {
  const { table, make } = await freshStore({ leaseTtlMs: 3_000 });
  const holder = make();
  const other = make();
  await holder.acquire("expiring");
  await assert.rejects(other.acquire("expiring"), /cave_durable_run_locked/);
  await pool.query(
    `UPDATE ${table}_leases SET expires_at = $1 WHERE run_id = $2`,
    [Date.now() - 1, "expiring"],
  );
  const release = await other.acquire("expiring");
  assert.equal(typeof release, "function");
  const { rows } = await pool.query(`SELECT run_id FROM ${table}_leases`);
  assert.equal(rows.length, 1, "a takeover must not leave a second lease row");
  await release();
  await holder.close("expiring");
  await other.close("expiring");
});

test("postgres: concurrent appends all survive instead of racing for one sequence",
  options, async () => {
    const { table, make } = await freshStore();
    const store = make();
    // The real reason this file exists. Under a real server these INSERTs run on
    // separate connections at READ COMMITTED, which the sqlite harness cannot
    // reproduce: `COALESCE(MAX(seq), 0) + 1` is not atomic there, and this lost
    // 9 of 12 writers to a duplicate primary key before insertLine retried.
    // Two writers was not enough contention to catch it — 24 is.
    const lines = Array.from({ length: 24 }, (_, i) => `line-${i}`);
    await Promise.all(lines.map((line) => store.append("concurrent", `${line}\n`)));
    assert.deepEqual([...await store.load("concurrent")].sort(), [...lines].sort());
    // Sequences stay unique and dense, which is what ORDER BY seq relies on.
    const { rows } = await pool.query(
      `SELECT seq FROM ${table} WHERE run_id = $1 ORDER BY seq`,
      ["concurrent"],
    );
    assert.deepEqual(rows.map((row) => Number(row.seq)), lines.map((_, i) => i + 1));
    await store.close("concurrent");
  });

test("postgres: an append after a takeover fails closed", options, async () => {
  const { table, make } = await freshStore({ leaseTtlMs: 3_000 });
  const holder = make();
  const other = make();
  await holder.acquire("taken-over");
  await holder.append("taken-over", "before\n");
  await pool.query(
    `UPDATE ${table}_leases SET expires_at = $1 WHERE run_id = $2`,
    [Date.now() - 1, "taken-over"],
  );
  const release = await other.acquire("taken-over");
  await assert.rejects(holder.append("taken-over", "after\n"), /cave_durable_run_lock_lost/);
  assert.deepEqual(await other.load("taken-over"), ["before"]);
  await release();
  await holder.close("taken-over");
  await other.close("taken-over");
});

test("postgres: close releases the lease this store still holds", options, async () => {
  const { table, make } = await freshStore();
  const first = make();
  const second = make();
  await first.acquire("closed-without-release");
  await first.close("closed-without-release");
  const { rows } = await pool.query(`SELECT run_id FROM ${table}_leases`);
  assert.equal(rows.length, 0);
  const release = await second.acquire("closed-without-release");
  await release();
  await second.close("closed-without-release");
});
