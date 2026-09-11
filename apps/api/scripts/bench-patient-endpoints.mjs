// Throwaway load benchmark for the PATIENT-FACING endpoints.
//
// Runs against in-memory PGlite — real Postgres 17, so real query planning and real index use.
// Deliberately NOT the shared Supabase database: seeding 500k rows into the live project to
// answer a performance question would be vandalism.
//
// What this measures: query cost as data grows. Run at two sizes and compare — a flat curve
// means an index is doing its job, a linear one means a scan.
//
// What this does NOT measure: connection-level concurrency. PGlite is single-connection, so
// pool exhaustion (pg.Pool max: 10) and contention between different users cannot appear here.
// Those need a real multi-connection Postgres.
process.env.PGLITE_MEMORY = '1';

const SIZE = Number(process.argv[2] ?? 1000);
const EVENTS_PER_REFERRAL = 10;

const { bootTestApp } = await import('../test/helpers/app.js');
const { patientSession } = await import('../test/helpers/patient.js');
const request = (await import('supertest')).default;

const { app, db, stub: authStub } = await bootTestApp();
const auth = (t) => ({ Authorization: `Bearer ${t}` });

const referrer = await patientSession(app, authStub, { phone: '07700 800001' });
await request(app).post('/me/role').set(auth(referrer.token)).send({ role: 'referrer' });
const { rows: [{ id: referrerId }] } = await db.query(`select id from users where phone='+447700800001'`);
const { rows: [{ id: practiceId }] } = await db.query(`select id from practices limit 1`);

// The referred patient whose /referrals/referred-status we time — the endpoint that also runs
// expireUnbookedReferrals() on every call.
const friend = await patientSession(app, authStub, { phone: '07700 800002' });
const { rows: [{ id: friendId }] } = await db.query(`select id from users where phone='+447700800002'`);

console.log(`seeding ${SIZE} referrals + ~${SIZE * EVENTS_PER_REFERRAL} events...`);
const t0 = Date.now();

await db.query(
  `insert into users (phone, first_name, role_referrer)
   select '+4479' || lpad(g::text, 8, '0'), 'Seed', true from generate_series(1, $1) g`,
  [SIZE],
);
await db.query(
  `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                          preferred_practice_id, consent_version, status, created_at)
   select u.id, '+4478' || lpad((row_number() over ())::text, 8, '0'), 'Seed Friend', 'implants',
          $1, 'referred-v1-2026-08',
          (array['new','contacted','booked','attended','treatment_agreed','treatment_completed'])[1 + (random()*5)::int],
          now() - (random() * interval '365 days')
     from users u where u.first_name = 'Seed'`,
  [practiceId],
);
// This referrer's own 20 referrals — the realistic per-user payload for /referrals/mine.
await db.query(
  `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                          preferred_practice_id, consent_version, status)
   select $1, '+4477' || lpad(g::text, 8, '0'), 'My Friend', 'implants', $2,
          'referred-v1-2026-08', 'booked' from generate_series(1, 20) g`,
  [referrerId, practiceId],
);
await db.query(
  `insert into referrals (referrer_id, referred_user_id, referred_phone, referred_name,
                          treatment_interest, preferred_practice_id, consent_version, status)
   values ($1, $2, '+447700800002', 'Bench Friend', 'implants', $3, 'referred-v1-2026-08', 'booked')`,
  [referrerId, friendId, practiceId],
);
// The audit log: fastest-growing table, and the one with no index at all.
await db.query(
  `insert into events (entity_type, entity_id, action, actor_kind, created_at)
   select 'referral', r.id::text, 'status_changed', 'admin', now() - (random() * interval '365 days')
     from referrals r, generate_series(1, $1) g`,
  [EVENTS_PER_REFERRAL],
);
await db.query(
  `insert into wallet_ledger (user_id, kind, amount_pennies, referral_id, practice_id, created_by)
   select r.referrer_id, 'credit', 2000, r.id, $1, 'bench'
     from referrals r where r.status = 'treatment_completed'`,
  [practiceId],
);

const { rows: [counts] } = await db.query(`
  select (select count(*)::int from referrals) as referrals,
         (select count(*)::int from events) as events,
         (select count(*)::int from wallet_ledger) as ledger,
         (select count(*)::int from users) as users`);
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)}s:`, JSON.stringify(counts));

async function time(label, fn, runs = 25) {
  await fn();
  const ms = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const res = await fn();
    ms.push(performance.now() - start);
    if (res.status >= 400) throw new Error(`${label} -> ${res.status} ${JSON.stringify(res.body)}`);
  }
  ms.sort((a, b) => a - b);
  const p = (q) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))];
  console.log(`  ${label.padEnd(32)} p50 ${p(0.5).toFixed(1).padStart(8)}ms   p95 ${p(0.95).toFixed(1).padStart(8)}ms`);
}

console.log('\npatient-facing endpoints:');
await time('GET /me', () => request(app).get('/me').set(auth(referrer.token)));
await time('GET /referrals/mine', () => request(app).get('/referrals/mine').set(auth(referrer.token)));
await time('GET /wallet', () => request(app).get('/wallet').set(auth(referrer.token)));
await time('GET /referrals/referred-status', () => request(app).get('/referrals/referred-status').set(auth(friend.token)));
await time('GET /practices', () => request(app).get('/practices'));

process.exit(0);
