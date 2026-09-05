/**
 * A {@link DurableStore} over any SQL engine, expressed as one method.
 *
 * The whole database dependency is {@link SqlExecutor}: `exec(sql, params)`,
 * sync or async, returning rows. That is deliberately the shape every driver
 * already has, so this file needs no dependency and no driver-specific code:
 *
 * ```ts
 * // Cloudflare Durable Object (synchronous SqlStorage)
 * new SqlDurableStore({
 *   sql: { exec: (query, params) => [...this.ctx.storage.sql.exec(query, ...params)] },
 *   dialect: "sqlite",
 * });
 * // better-sqlite3
 * new SqlDurableStore({
 *   sql: { exec: (query, params) => db.prepare(query).all(...params) },
 *   dialect: "sqlite",
 * });
 * // node-postgres
 * new SqlDurableStore({
 *   sql: { exec: async (query, params) => (await pool.query(query, [...params])).rows },
 *   dialect: "postgres",
 * });
 * ```
 *
 * Run {@link SqlDurableStore.schema} once against the database first; this
 * store never issues DDL, because a journal store that can create tables can
 * also drop them.
 *
 * The exclusive-driver guarantee is a lease row with an expiry, renewed at a
 * third of its TTL. It fails the same way {@link HttpDurableStore} does: a
 * renewal this process cannot complete means it can no longer prove it is the
 * only driver, so every later append throws rather than writing into a journal
 * another process may now own.
 */

import { MAX_JOURNAL_BYTES, RUN_ID_PATTERN, utf8Bytes, validateDurableRunId } from "./durable-limits.js";
import type { DurableStore } from "./durable.js";

/** One method, because that is all every SQL driver already agrees on. */
export interface SqlExecutor {
  exec(
    sql: string,
    params: readonly unknown[],
  ): Promise<ReadonlyArray<Record<string, unknown>>> | ReadonlyArray<Record<string, unknown>>;
}

export interface SqlDurableStoreOptions {
  readonly sql: SqlExecutor;
  /** Placeholder grammar: `?` for sqlite, `$1…$n` for postgres. */
  readonly dialect: "sqlite" | "postgres";
  /** Journal table. The lease table is `<table>_leases`. */
  readonly table?: string;
  /** Lease length; the holder renews at a third of it. Default 30s. */
  readonly leaseTtlMs?: number;
}

const DEFAULT_TABLE = "caveman_durable_journal";
// Identifiers cannot be parameterized, so the table name is validated instead
// of escaped: anything outside this alphabet never reaches a query string.
const TABLE_PATTERN = /^[a-z_][a-z0-9_]{0,54}$/;

/** Sequence collisions are contention, not failure, until they stop resolving. */
const MAX_SEQ_ATTEMPTS = 12;
const BASE_RETRY_MS = 4;

/**
 * Drivers report a unique violation differently: Postgres carries SQLSTATE
 * 23505, `node:sqlite` and better-sqlite3 spell it in the message. Matching on
 * both keeps this file driver-free, which is the point of {@link SqlExecutor}.
 */
function isDuplicateKey(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "23505" || code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
      code === "SQLITE_CONSTRAINT_UNIQUE") {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("duplicate key") || message.includes("unique constraint");
}

export class SqlDurableStore implements DurableStore {
  private readonly sql: SqlExecutor;
  private readonly dialect: "sqlite" | "postgres";
  private readonly table: string;
  private readonly leaseTable: string;
  private readonly leaseTtlMs: number;
  private readonly leases = new Map<string, { owner: string; timer: ReturnType<typeof setInterval> }>();
  private readonly lost = new Map<string, Error>();

  constructor(options: SqlDurableStoreOptions) {
    if (options.dialect !== "sqlite" && options.dialect !== "postgres") {
      throw new Error("cave_durable_sql_dialect_unsupported: dialect must be sqlite or postgres");
    }
    const table = options.table ?? DEFAULT_TABLE;
    if (!TABLE_PATTERN.test(table)) {
      throw new Error(`cave_durable_sql_table_invalid: ${JSON.stringify(table)}`);
    }
    this.sql = options.sql;
    this.dialect = options.dialect;
    this.table = table;
    this.leaseTable = `${table}_leases`;
    this.leaseTtlMs = options.leaseTtlMs ?? 30_000;
    if (!Number.isSafeInteger(this.leaseTtlMs) || this.leaseTtlMs < 3_000) {
      throw new Error("cave_durable_sql_lease_ttl_invalid: lease must be at least 3000ms");
    }
  }

  /** DDL for the two tables this store reads and writes. Run it once. */
  static schema(dialect: "sqlite" | "postgres", table: string = DEFAULT_TABLE): string {
    if (!TABLE_PATTERN.test(table)) {
      throw new Error(`cave_durable_sql_table_invalid: ${JSON.stringify(table)}`);
    }
    // BIGINT carries integer affinity in SQLite and is a real 64-bit integer in
    // Postgres, so one DDL serves both; `dialect` is still taken so a future
    // divergence does not change the signature.
    void dialect;
    return [
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      "  run_id TEXT NOT NULL,",
      "  seq BIGINT NOT NULL,",
      "  line TEXT NOT NULL,",
      "  PRIMARY KEY (run_id, seq)",
      ");",
      `CREATE TABLE IF NOT EXISTS ${table}_leases (`,
      "  run_id TEXT PRIMARY KEY,",
      "  owner TEXT NOT NULL,",
      "  expires_at BIGINT NOT NULL",
      ");",
    ].join("\n");
  }

  /** `?` is the written grammar; postgres gets `$1…$n` on the way out. */
  private async query(
    sql: string,
    params: readonly unknown[],
  ): Promise<ReadonlyArray<Record<string, unknown>>> {
    let index = 0;
    const text = this.dialect === "postgres" ? sql.replace(/\?/g, () => `$${++index}`) : sql;
    return await this.sql.exec(text, params) ?? [];
  }

  async load(runId: string): Promise<readonly string[]> {
    validateDurableRunId(runId);
    const rows = await this.query(
      `SELECT line FROM ${this.table} WHERE run_id = ? ORDER BY seq`,
      [runId],
    );
    const lines: string[] = [];
    let bytes = 0;
    for (const row of rows) {
      const line = String(row.line);
      bytes += utf8Bytes(line) + 1;
      if (bytes > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
      lines.push(line);
    }
    return lines;
  }

  /**
   * One row per journal line. A row is the atomic unit here, which is the SQL
   * equivalent of the disk store's torn-tail rule: a crash mid-append leaves
   * whole lines, never half of one.
   */
  async append(runId: string, data: string): Promise<void> {
    validateDurableRunId(runId);
    const lostLease = this.lost.get(runId);
    if (lostLease !== undefined) throw lostLease;
    if (utf8Bytes(data) > MAX_JOURNAL_BYTES) throw new Error("cave_durable_journal_limit");
    const lines = data.split("\n").filter((line) => line !== "");
    if (lines.length === 0) return;
    const [totals] = await this.query(
      `SELECT COALESCE(SUM(LENGTH(line)), 0) AS size FROM ${this.table} WHERE run_id = ?`,
      [runId],
    );
    // LENGTH() counts characters in both dialects, so this is a lower bound on
    // the stored bytes — a cap that can only be conservative, never generous.
    if (Number(totals?.size ?? 0) + utf8Bytes(data) > MAX_JOURNAL_BYTES) {
      throw new Error("cave_durable_journal_limit");
    }
    await this.assertStillHeld(runId);
    for (const line of lines) {
      await this.insertLine(runId, line);
    }
  }

  /**
   * `SELECT COALESCE(MAX(seq), 0) + 1` inside the INSERT is only atomic on an
   * engine that serializes the statement. SQLite does; Postgres at READ
   * COMMITTED does not, and concurrent appends to one run collided on the
   * primary key (9 of 12 writers lost, against a real server). Losing an append
   * silently is not an option for a journal, so a collision is retried: the
   * PRIMARY KEY is the arbiter, and the loser re-reads MAX and tries the next
   * sequence. Retries are bounded, and exhausting them throws rather than
   * dropping the line.
   */
  private async insertLine(runId: string, line: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
      try {
        await this.query(
          `INSERT INTO ${this.table} (run_id, seq, line) ` +
          `SELECT ?, COALESCE(MAX(seq), 0) + 1, ? FROM ${this.table} WHERE run_id = ?`,
          [runId, line, runId],
        );
        return;
      } catch (error) {
        if (!isDuplicateKey(error) || attempt === MAX_SEQ_ATTEMPTS - 1) throw error;
        // Full jitter: contending writers that back off by the same amount just
        // collide again on the next attempt.
        await new Promise((wake) => {
          const timer = setTimeout(wake, Math.random() * BASE_RETRY_MS * (attempt + 1));
          (timer as { unref?: () => void }).unref?.();
        });
      }
    }
  }

  /**
   * An append by a process that holds this run's lease must still be able to
   * prove it holds it, at append time rather than only on the renewal tick. A
   * store with no lease for this run is a deliberately lock-free writer
   * (`requestDurableCancel`) and is not asked to prove anything.
   */
  private async assertStillHeld(runId: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held === undefined) return;
    const rows = await this.query(
      `SELECT run_id FROM ${this.leaseTable} WHERE run_id = ? AND owner = ? AND expires_at > ?`,
      [runId, held.owner, Date.now()],
    );
    if (rows.length > 0) return;
    const failure = new Error(
      `cave_durable_run_lock_lost: run "${runId}" is no longer held by this process`,
    );
    clearInterval(held.timer);
    this.leases.delete(runId);
    this.lost.set(runId, failure);
    throw failure;
  }

  async acquire(runId: string): Promise<() => Promise<void>> {
    validateDurableRunId(runId);
    const now = Date.now();
    const owner = `${runId}:${globalThis.crypto.randomUUID()}`;
    // Reaping first is what makes the expiry mean anything: a lease whose owner
    // died is gone, and the PRIMARY KEY below still admits exactly one winner
    // among however many processes reaped it at the same moment.
    await this.query(`DELETE FROM ${this.leaseTable} WHERE run_id = ? AND expires_at <= ?`, [runId, now]);
    const taken = await this.query(
      `INSERT INTO ${this.leaseTable} (run_id, owner, expires_at) VALUES (?, ?, ?) ` +
      "ON CONFLICT (run_id) DO NOTHING RETURNING run_id",
      [runId, owner, now + this.leaseTtlMs],
    );
    if (taken.length === 0) {
      throw new Error(
        `cave_durable_run_locked: run "${runId}" is already being driven by another process`,
      );
    }
    const timer = setInterval(() => {
      void this.renew(runId, owner);
    }, Math.floor(this.leaseTtlMs / 3));
    timer.unref?.();
    this.leases.set(runId, { owner, timer });
    this.lost.delete(runId);
    return async () => {
      const held = this.leases.get(runId);
      if (held === undefined || held.owner !== owner) return;
      clearInterval(held.timer);
      this.leases.delete(runId);
      await this.query(
        `DELETE FROM ${this.leaseTable} WHERE run_id = ? AND owner = ?`,
        [runId, owner],
      ).catch(() => undefined);
    };
  }

  /** Losing the lease poisons the run rather than risking two drivers. */
  private async renew(runId: string, owner: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held === undefined || held.owner !== owner) return;
    let failure: Error | undefined;
    try {
      const renewed = await this.query(
        `UPDATE ${this.leaseTable} SET expires_at = ? WHERE run_id = ? AND owner = ? RETURNING run_id`,
        [Date.now() + this.leaseTtlMs, runId, owner],
      );
      if (renewed.length === 0) failure = new Error("cave_durable_sql_lock_lost");
    } catch (error) {
      failure = new Error("cave_durable_sql_lock_lost", { cause: error });
    }
    if (failure === undefined) return;
    clearInterval(held.timer);
    this.leases.delete(runId);
    this.lost.set(runId, failure);
  }

  async close(runId: string): Promise<void> {
    const held = this.leases.get(runId);
    if (held !== undefined) clearInterval(held.timer);
    this.leases.delete(runId);
    this.lost.delete(runId);
    if (held === undefined) return;
    // Closing without releasing would leave the row behind and lock the run out
    // for the rest of its TTL, so the lease this store still holds is dropped.
    await this.query(
      `DELETE FROM ${this.leaseTable} WHERE run_id = ? AND owner = ?`,
      [runId, held.owner],
    ).catch(() => undefined);
  }

  async list(): Promise<readonly string[]> {
    const rows = await this.query(`SELECT DISTINCT run_id FROM ${this.table} ORDER BY run_id`, []);
    return rows
      .map((row) => String(row.run_id))
      .filter((runId) => RUN_ID_PATTERN.test(runId));
  }
}
