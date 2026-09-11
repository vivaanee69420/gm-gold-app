// How many requests/second can we actually serve? Measured against the REAL Supabase database.
//
// READ-ONLY and bounded: SELECTs only, a few seconds per concurrency level. Nothing is
// written, no rows are created.
//
// Why this exists: bench-patient-endpoints.mjs measures query COST as data grows, but it runs
// on PGlite, which is single-connection and in-process — so it cannot see the two things that
// decide throughput. Those are network round-trip time to Supabase, and contention for the
// pg.Pool's connections. This measures both.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL not set — run with: node --env-file=.env scripts/bench-supabase-concurrency.mjs');
  process.exit(1);
}

// Host and port only. Never the credentials.
const { hostname, port } = new URL(url);
const pooler = port === '6543' ? 'transaction pooler' : port === '5432' ? 'session pooler / direct' : `port ${port}`;
console.log(`target: ${hostname}:${port}  (${pooler})\n`);

const POOL_MAX = 10; // matches apps/api/src/db.js
const pool = new pg.Pool({ connectionString: url, max: POOL_MAX });

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

// ---- 1. One round trip, to isolate network latency -----------------------------
{
  const ms = [];
  for (let i = 0; i < 30; i += 1) {
    const t = performance.now();
    await pool.query('select 1');
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`single round trip        p50 ${pct(ms, 0.5).toFixed(1)}ms   p95 ${pct(ms, 0.95).toFixed(1)}ms`);
}

// ---- 2. The /wallet shape: 8 sequential round trips holding one connection ------
// getSetting, BEGIN, advisory lock, balance, ledger, lifetime, open payout, COMMIT.
// A distinct lock key per call, because different users do not contend with each other.
async function walletShaped(key) {
  const client = await pool.connect();
  try {
    await client.query(`select value from app_settings where key='payout_threshold_pennies'`);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(key)]);
    await client.query(`select coalesce(sum(amount_pennies),0)::int from wallet_ledger where user_id is null`);
    await client.query(`select id from wallet_ledger order by created_at desc limit 50`);
    await client.query(`select coalesce(sum(amount_pennies),0)::int from wallet_ledger where kind='credit'`);
    await client.query(`select id from payout_requests where status='open' limit 1`);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

{
  const ms = [];
  for (let i = 0; i < 15; i += 1) {
    const t = performance.now();
    await walletShaped(`bench-${i}`);
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  console.log(`/wallet shape (8 trips) p50 ${pct(ms, 0.5).toFixed(1)}ms   p95 ${pct(ms, 0.95).toFixed(1)}ms`);
}

// ---- 3. Achieved throughput as concurrency rises past the pool -----------------
console.log(`\nthroughput through a pool of ${POOL_MAX}, /wallet-shaped requests:`);
for (const concurrency of [1, 5, 10, 20, 40]) {
  const DURATION_MS = 3000;
  const started = Date.now();
  let done = 0;
  const latencies = [];

  await Promise.all(
    Array.from({ length: concurrency }, async (_, worker) => {
      while (Date.now() - started < DURATION_MS) {
        const t = performance.now();
        // eslint-disable-next-line no-await-in-loop
        await walletShaped(`bench-${worker}-${done}`);
        latencies.push(performance.now() - t);
        done += 1;
      }
    }),
  );

  const elapsed = (Date.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  console.log(
    `  concurrency ${String(concurrency).padStart(2)}   ${(done / elapsed).toFixed(1).padStart(6)} req/s` +
    `   p50 ${pct(latencies, 0.5).toFixed(0).padStart(4)}ms   p95 ${pct(latencies, 0.95).toFixed(0).padStart(5)}ms`,
  );
}

await pool.end();
