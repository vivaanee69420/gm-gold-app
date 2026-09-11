// What does PRODUCTION actually pay per database round trip?
//
// Measuring from a developer laptop tells you laptop -> Supabase, which is not the path that
// matters: the API runs on Railway and talks to Supabase from there. This isolates the part
// that does matter, using only public read-only endpoints.
//
//   GET /healthz    touches no database  -> me -> Railway
//   GET /practices  is one SELECT        -> me -> Railway -> Supabase -> back
//
// The difference between them is Railway -> Supabase, which is the number that multiplies by
// however many round trips an endpoint makes (/wallet makes eight).
const BASE = process.argv[2] ?? 'https://api-production-9d24.up.railway.app';
const RUNS = 15;

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

async function time(path) {
  const ms = [];
  // One warm-up: Railway may cold-start, and that is not the steady state we are measuring.
  await fetch(`${BASE}${path}`).catch(() => {});
  for (let i = 0; i < RUNS; i += 1) {
    const t = performance.now();
    const res = await fetch(`${BASE}${path}`);
    await res.arrayBuffer();
    ms.push(performance.now() - t);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  }
  ms.sort((a, b) => a - b);
  return { p50: pct(ms, 0.5), p95: pct(ms, 0.95) };
}

console.log(`target: ${BASE}\n`);

const health = await time('/healthz');
console.log(`GET /healthz    (0 queries)  p50 ${health.p50.toFixed(0)}ms   p95 ${health.p95.toFixed(0)}ms   <- me to Railway`);

const practices = await time('/practices');
console.log(`GET /practices  (1 query)    p50 ${practices.p50.toFixed(0)}ms   p95 ${practices.p95.toFixed(0)}ms   <- and back to Supabase`);

const dbHop = practices.p50 - health.p50;
console.log(`\nRailway -> Supabase round trip: ~${dbHop.toFixed(0)}ms`);
console.log(`An endpoint making 8 sequential trips (/wallet) therefore costs ~${(dbHop * 8).toFixed(0)}ms of pure waiting.`);
