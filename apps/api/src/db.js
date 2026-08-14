// Postgres access with one adapter, two drivers:
//   DATABASE_URL set   -> node-postgres Pool (Supabase / any Postgres)
//   DATABASE_URL unset -> PGlite, an embedded real Postgres 17 (dev fallback, zero accounts)
// Both speak identical SQL; migrations are plain .sql files applied in order.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { config } from './config.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(here, '../../../supabase/migrations');

let driver; // { query(sql, params), withClient(fn) }

async function initPg() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  return {
    kind: 'pg',
    query: (text, params) => pool.query(text, params),
    withClient: async (fn) => {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
  };
}

async function initPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  let lite;
  if (process.env.PGLITE_MEMORY === '1') {
    lite = new PGlite(); // in-memory, for tests
  } else {
    const dataDir = path.resolve(here, '../data/pglite');
    fs.mkdirSync(dataDir, { recursive: true });
    lite = new PGlite(dataDir);
  }
  const shim = {
    query: (text, params) => lite.query(text, params).then((r) => ({ rows: r.rows, rowCount: r.rows.length })),
  };
  return {
    kind: 'pglite',
    query: shim.query,
    // PGlite's query() is single-statement (extended protocol); exec() runs multi-statement SQL.
    exec: (sql) => lite.exec(sql),
    // PGlite is single-connection; a "client" is the same handle. Transactions still work.
    withClient: async (fn) => fn(shim),
  };
}

export async function initDb() {
  driver = config.databaseUrl ? await initPg() : await initPglite();
  await migrate();
  return driver.kind;
}

export const db = {
  query: (text, params) => driver.query(text, params),
  withClient: (fn) => driver.withClient(fn),
};

/** Run fn inside BEGIN/COMMIT with a per-user advisory lock (NFR-09). */
export async function withWalletLock(userId, fn) {
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(userId)]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/** Plain transaction without the wallet lock. */
export async function withTransaction(fn) {
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function migrate() {
  await driver.query(`create table if not exists _migrations (name text primary key, applied_at timestamptz default now())`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { rows } = await driver.query('select 1 from _migrations where name = $1', [file]);
    if (rows.length) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    if (driver.exec) await driver.exec(sql);
    else await driver.query(sql);
    await driver.query('insert into _migrations (name) values ($1)', [file]);
    console.log(`[db] applied migration ${file}`);
  }
}

/** Append-only audit event (NFR-03). Callable with a tx client or the pool. */
export async function logEvent(clientOrDb, { actorId = null, entityType, entityId, action, fromValue = null, toValue = null, reason = null }) {
  await (clientOrDb ?? db).query(
    `insert into events (actor_id, entity_type, entity_id, action, from_value, to_value, reason)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [actorId, entityType, String(entityId), action, fromValue, toValue, reason],
  );
}
