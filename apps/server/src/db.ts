import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AnalysisResult, CacheStore, OfacKv, RunStatus } from "@fot/core";

export const MEMORY_DB = ":memory:";
const CACHE_ROW_CAP = 200_000;

const MIGRATIONS: string[] = [
  `CREATE TABLE investigations (
     id TEXT PRIMARY KEY,
     chain TEXT NOT NULL,
     direction TEXT NOT NULL,
     seeds_json TEXT NOT NULL,
     params_json TEXT NOT NULL,
     status TEXT NOT NULL,
     risk_level TEXT,
     title TEXT,
     notes TEXT,
     demo TEXT,
     created_at TEXT NOT NULL,
     finished_at TEXT,
     result_json TEXT,
     error TEXT
   );
   CREATE INDEX investigations_created_at ON investigations (created_at DESC);
   CREATE TABLE api_cache (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX api_cache_expires_at ON api_cache (expires_at);
   CREATE TABLE kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
];

function migrate(sqlite: Database): void {
  const row = sqlite.query("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    sqlite.transaction(() => {
      sqlite.exec(MIGRATIONS[v] as string);
      sqlite.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

/** HTTP response cache backed by SQLite; TTLs are enforced on read and by `prune()`. */
export class SqliteCacheStore implements CacheStore {
  constructor(
    private readonly sqlite: Database,
    private readonly now: () => number = Date.now,
    private readonly rowCap: number = CACHE_ROW_CAP,
  ) {}

  async get(key: string): Promise<string | null> {
    const row = this.sqlite
      .query("SELECT value FROM api_cache WHERE key = ?1 AND expires_at > ?2")
      .get(key, this.now()) as { value: string } | null;
    return row?.value ?? null;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.sqlite
      .query("INSERT OR REPLACE INTO api_cache (key, value, expires_at) VALUES (?1, ?2, ?3)")
      .run(key, value, this.now() + ttlSec * 1000);
  }

  /** Drops expired rows; past the row cap, also drops the 10% with the oldest expiry. */
  prune(): { expired: number; evicted: number } {
    const expired = this.sqlite
      .query("DELETE FROM api_cache WHERE expires_at <= ?1")
      .run(this.now()).changes;
    const { n } = this.sqlite.query("SELECT COUNT(*) AS n FROM api_cache").get() as { n: number };
    let evicted = 0;
    if (n > this.rowCap) {
      evicted = this.sqlite
        .query(
          "DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache ORDER BY expires_at ASC LIMIT ?1)",
        )
        .run(Math.ceil(n * 0.1)).changes;
    }
    return { expired, evicted };
  }
}

export class SqliteKv implements OfacKv {
  constructor(private readonly sqlite: Database) {}

  async get(key: string): Promise<string | null> {
    const row = this.sqlite.query("SELECT value FROM kv WHERE key = ?1").get(key) as {
      value: string;
    } | null;
    return row?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.sqlite.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?1, ?2)").run(key, value);
  }
}

/** `paused` is a live-only overlay and is never persisted. */
export type InvestigationStatus = RunStatus | "running" | "paused" | "interrupted";

interface InvestigationDbRow {
  id: string;
  chain: string;
  direction: string;
  seeds_json: string;
  params_json: string;
  status: string;
  risk_level: string | null;
  title: string | null;
  notes: string | null;
  demo: string | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
}

/** Row metadata as served by the API (no result payload). */
export interface InvestigationSummary {
  id: string;
  chain: AnalysisResult["chain"];
  direction: AnalysisResult["direction"];
  seeds: AnalysisResult["seeds"];
  params: AnalysisResult["params"];
  status: InvestigationStatus;
  riskLevel: AnalysisResult["riskLevel"] | null;
  title: string | null;
  notes: string | null;
  demo: string | null;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface InvestigationInsert {
  id: string;
  chain: InvestigationSummary["chain"];
  direction: InvestigationSummary["direction"];
  seeds: InvestigationSummary["seeds"];
  params: InvestigationSummary["params"];
  status: InvestigationStatus;
  title: string | null;
  demo: string | null;
  createdAt: string;
}

export interface InvestigationUpdate {
  status?: InvestigationStatus;
  riskLevel?: AnalysisResult["riskLevel"] | null;
  title?: string | null;
  notes?: string | null;
  finishedAt?: string | null;
  result?: AnalysisResult | null;
  error?: string | null;
}

export interface InvestigationListQuery {
  limit?: number;
  offset?: number;
  q?: string | undefined;
  chain?: string | undefined;
  status?: string | undefined;
}

const UPDATE_COLUMNS: Record<keyof InvestigationUpdate, string> = {
  status: "status",
  riskLevel: "risk_level",
  title: "title",
  notes: "notes",
  finishedAt: "finished_at",
  result: "result_json",
  error: "error",
};

function toSummary(r: InvestigationDbRow): InvestigationSummary {
  return {
    id: r.id,
    chain: r.chain as InvestigationSummary["chain"],
    direction: r.direction as InvestigationSummary["direction"],
    seeds: JSON.parse(r.seeds_json),
    params: JSON.parse(r.params_json),
    status: r.status as InvestigationStatus,
    riskLevel: r.risk_level as InvestigationSummary["riskLevel"],
    title: r.title,
    notes: r.notes,
    demo: r.demo,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    error: r.error,
  };
}

const SUMMARY_COLUMNS =
  "id, chain, direction, seeds_json, params_json, status, risk_level, title, notes, demo, created_at, finished_at, error";

export class Investigations {
  constructor(private readonly sqlite: Database) {}

  insert(row: InvestigationInsert): void {
    this.sqlite
      .query(
        `INSERT INTO investigations (id, chain, direction, seeds_json, params_json, status, title, demo, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .run(
        row.id,
        row.chain,
        row.direction,
        JSON.stringify(row.seeds),
        JSON.stringify(row.params),
        row.status,
        row.title,
        row.demo,
        row.createdAt,
      );
  }

  update(id: string, patch: InvestigationUpdate): boolean {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    for (const key of Object.keys(UPDATE_COLUMNS) as (keyof InvestigationUpdate)[]) {
      const v = patch[key];
      if (v === undefined) continue;
      sets.push(`${UPDATE_COLUMNS[key]} = ?${values.length + 1}`);
      values.push(
        key === "result" ? (v === null ? null : JSON.stringify(v)) : (v as string | null),
      );
    }
    if (sets.length === 0) return this.get(id) !== null;
    values.push(id);
    const res = this.sqlite
      .query(`UPDATE investigations SET ${sets.join(", ")} WHERE id = ?${values.length}`)
      .run(...values);
    return res.changes > 0;
  }

  get(id: string): InvestigationSummary | null {
    const row = this.sqlite
      .query(`SELECT ${SUMMARY_COLUMNS} FROM investigations WHERE id = ?1`)
      .get(id) as InvestigationDbRow | null;
    return row ? toSummary(row) : null;
  }

  getResult(id: string): AnalysisResult | null {
    const row = this.sqlite
      .query("SELECT result_json FROM investigations WHERE id = ?1")
      .get(id) as { result_json: string | null } | null;
    return row?.result_json ? (JSON.parse(row.result_json) as AnalysisResult) : null;
  }

  list(query: InvestigationListQuery = {}): {
    items: InvestigationSummary[];
    total: number;
    totalAll: number;
  } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const arg = (v: string | number): string => {
      args.push(v);
      return `?${args.length}`;
    };
    if (query.chain) where.push(`chain = ${arg(query.chain)}`);
    if (query.status) where.push(`status = ${arg(query.status)}`);
    if (query.q) {
      const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const p = arg(like);
      where.push(
        `(title LIKE ${p} ESCAPE '\\' OR notes LIKE ${p} ESCAPE '\\' OR seeds_json LIKE ${p} ESCAPE '\\' OR id LIKE ${p} ESCAPE '\\')`,
      );
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const { total } = this.sqlite
      .query(`SELECT COUNT(*) AS total FROM investigations ${clause}`)
      .get(...args) as { total: number };
    const { totalAll } = this.sqlite
      .query("SELECT COUNT(*) AS totalAll FROM investigations")
      .get() as { totalAll: number };
    const limit = arg(Math.min(100, Math.max(1, query.limit ?? 50)));
    const offset = arg(Math.max(0, query.offset ?? 0));
    const rows = this.sqlite
      .query(
        `SELECT ${SUMMARY_COLUMNS} FROM investigations ${clause} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      )
      .all(...args) as InvestigationDbRow[];
    return { items: rows.map(toSummary), total, totalAll };
  }

  delete(id: string): boolean {
    return this.sqlite.query("DELETE FROM investigations WHERE id = ?1").run(id).changes > 0;
  }

  /** Boot recovery: runs that were live when the process died can never finish. */
  markInterrupted(): number {
    return this.sqlite
      .query("UPDATE investigations SET status = 'interrupted' WHERE status = 'running'")
      .run().changes;
  }
}

export interface Db {
  readonly sqlite: Database;
  readonly investigations: Investigations;
  readonly cache: SqliteCacheStore;
  readonly kv: SqliteKv;
  close(): void;
}

export interface OpenDbOptions {
  now?: () => number;
  cacheRowCap?: number;
}

/** Opens `<dataDir>/fot.sqlite` (created on demand) or an in-memory database for `":memory:"`. */
export function openDb(dataDir: string, options: OpenDbOptions = {}): Db {
  let sqlite: Database;
  if (dataDir === MEMORY_DB) {
    sqlite = new Database(MEMORY_DB);
  } else {
    mkdirSync(dataDir, { recursive: true });
    sqlite = new Database(join(dataDir, "fot.sqlite"), { create: true });
    sqlite.exec("PRAGMA journal_mode = WAL");
  }
  sqlite.exec("PRAGMA synchronous = NORMAL");
  migrate(sqlite);
  const cache = new SqliteCacheStore(sqlite, options.now ?? Date.now, options.cacheRowCap);
  cache.prune();
  return {
    sqlite,
    investigations: new Investigations(sqlite),
    cache,
    kv: new SqliteKv(sqlite),
    close: () => sqlite.close(),
  };
}
