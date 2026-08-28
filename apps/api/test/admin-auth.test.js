// Admin identity: email + password accounts, POST /auth/admin/login, requireAdmin
// (no dev fallback, no patient token accepted), createAdmin validation (FR-24 rework).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminSession } from './helpers/admin.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let practiceId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signInPatient(phone) {
  const send = await request(app).post('/auth/otp/send').send({ phone });
  const code = send.body.devHint.match(/(\d{6})/)[1];
  const verify = await request(app).post('/auth/otp/verify').send({ phone, code });
  return verify.body.token;
}

beforeAll(async () => {
  const dbModule = await import('../src/db.js');
  await dbModule.initDb();
  db = dbModule.db;
  const { buildApp } = await import('../src/app.js');
  app = buildApp();

  const practices = await db.query(`select id from practices where active order by name limit 1`);
  practiceId = practices.rows[0].id;
});

describe('POST /auth/admin/login', () => {
  it('succeeds and returns the role + practices', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await createAdmin({ email: 'owner@gmdental.co.uk', password: 'correct-horse-battery', role: 'admin' });

    const res = await request(app).post('/auth/admin/login').send({ email: 'owner@gmdental.co.uk', password: 'correct-horse-battery' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.admin.role).toBe('admin');
    expect(res.body.admin.email).toBe('owner@gmdental.co.uk');
    expect(Array.isArray(res.body.admin.practices)).toBe(true);
    expect(res.body.admin.practices.length).toBeGreaterThan(0);
  });

  it('wrong password -> 401 invalid_credentials', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await createAdmin({ email: 'wrongpw@gmdental.co.uk', password: 'correct-horse-battery', role: 'admin' });

    const res = await request(app).post('/auth/admin/login').send({ email: 'wrongpw@gmdental.co.uk', password: 'nope-not-it' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('unknown email -> 401 with the same body as a wrong password', async () => {
    const res = await request(app).post('/auth/admin/login').send({ email: 'nobody-here@gmdental.co.uk', password: 'anything-at-all' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('inactive account -> 401 invalid_credentials', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    const row = await createAdmin({ email: 'inactive@gmdental.co.uk', password: 'correct-horse-battery', role: 'admin' });
    await db.query(`update admin_users set active=false where id=$1`, [row.id]);

    const res = await request(app).post('/auth/admin/login').send({ email: 'inactive@gmdental.co.uk', password: 'correct-horse-battery' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('5 wrong attempts then a 6th with the RIGHT password is still 429', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await createAdmin({ email: 'ratelimited@gmdental.co.uk', password: 'correct-horse-battery', role: 'admin' });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app).post('/auth/admin/login').send({ email: 'ratelimited@gmdental.co.uk', password: 'wrong' });
      expect(res.status).toBe(401);
    }
    const capped = await request(app).post('/auth/admin/login').send({ email: 'ratelimited@gmdental.co.uk', password: 'correct-horse-battery' });
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe('rate_limited');
  });

  // 0011's migration deactivates every legacy (pre-password) row, but this inserts one
  // directly to prove authenticate() itself is safe even if an active+null-hash row ever
  // exists: it must run a real scrypt compare (not short-circuit on the missing hash) and
  // land on the exact same 401 as every other failure mode.
  it('a raw-inserted ACTIVE row with a null password_hash -> 401 invalid_credentials', async () => {
    await db.query(
      `insert into admin_users (email, password_hash, role, practice_ids, active) values ($1, null, 'admin', '{}', true)`,
      ['null-hash@gmdental.co.uk'],
    );
    const res = await request(app).post('/auth/admin/login').send({ email: 'null-hash@gmdental.co.uk', password: 'whatever-they-guess' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });
});

describe('login rate limit: per-IP + window expiry', () => {
  // Exercised directly against adminService (not over HTTP): every test in this file shares
  // one process, and HTTP requests from supertest all share one real loopback IP, so a
  // dedicated fake IP keeps this deterministic regardless of how many other tests in this
  // file also fail a login first. app.js's route wiring (`authenticate(email, password, {
  // ip: req.ip })`) is exercised implicitly by every other test in this file going through
  // supertest without ever tripping this 30/15min ceiling.
  it('30 failures across distinct emails from one IP -> the 31st is 429 rate_limited', async () => {
    const { authenticate } = await import('../src/services/adminService.js');
    const ip = 'test-only-203.0.113.5';
    for (let i = 0; i < 30; i += 1) {
      await expect(authenticate(`ip-flood-${i}@gmdental.co.uk`, 'wrong', { ip })).rejects.toMatchObject({ status: 401 });
    }
    await expect(authenticate('ip-flood-overflow@gmdental.co.uk', 'wrong', { ip })).rejects.toMatchObject({ status: 429 });
  });

  it('failures older than the 15-minute window are pruned and stop counting', async () => {
    const { authenticate, __setClockForTests, __resetLimitersForTests } = await import('../src/services/adminService.js');
    let now = Date.now();
    __setClockForTests(() => now);
    try {
      const email = 'window-expiry@gmdental.co.uk';
      for (let i = 0; i < 5; i += 1) {
        await expect(authenticate(email, 'wrong')).rejects.toMatchObject({ status: 401 });
      }
      await expect(authenticate(email, 'wrong')).rejects.toMatchObject({ status: 429 }); // 6th: still within the window

      now += 15 * 60 * 1000 + 1000; // advance past the 15-minute window

      await expect(authenticate(email, 'wrong')).rejects.toMatchObject({ status: 401 }); // pruned, not 429
    } finally {
      __setClockForTests(); // back to the real clock for every other test in this file
      // A future-dated entry (this test's failures were recorded under the advanced fake
      // clock) reads as "not yet expired" once the real clock resumes, since its
      // firstFailureAt is ahead of real Date.now() — clear it explicitly rather than let it
      // linger until real wall-clock time actually catches up.
      __resetLimitersForTests();
    }
  });
});

describe('per-IP rate limit uses the forwarded client IP (trust proxy)', () => {
  // app.js sets `trust proxy: 1` (one hop — Railway's edge), so req.ip reads the client IP
  // out of X-Forwarded-For instead of collapsing every request behind the proxy into one
  // shared bucket. Two different forwarded IPs must get two independent 30/15min buckets.
  it('30 failed logins behind one X-Forwarded-For -> the 31st is 429; a different forwarded IP is unaffected', async () => {
    const floodedIp = '203.0.113.9';
    for (let i = 0; i < 30; i += 1) {
      const res = await request(app)
        .post('/auth/admin/login')
        .set('X-Forwarded-For', floodedIp)
        .send({ email: `xff-flood-${i}@gmdental.co.uk`, password: 'wrong' });
      expect(res.status).toBe(401);
    }
    const capped = await request(app)
      .post('/auth/admin/login')
      .set('X-Forwarded-For', floodedIp)
      .send({ email: 'xff-flood-overflow@gmdental.co.uk', password: 'wrong' });
    expect(capped.status).toBe(429);
    expect(capped.body.error).toBe('rate_limited');

    const otherIp = '203.0.113.10';
    const unaffected = await request(app)
      .post('/auth/admin/login')
      .set('X-Forwarded-For', otherIp)
      .send({ email: 'xff-flood-other-ip@gmdental.co.uk', password: 'wrong' }); // fresh email: isolates the IP bucket, not the email one
    expect(unaffected.status).toBe(401);
    expect(unaffected.body.error).toBe('invalid_credentials');
  });
});

describe('requireAdmin', () => {
  it('rejects a patient token on /admin/me with 401 unauthorized', async () => {
    const patientToken = await signInPatient('07700 900199');
    const res = await request(app).get('/admin/me').set(auth(patientToken));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('rejects a token for an admin who was deactivated after issuing it', async () => {
    const { token, admin } = await adminSession(app, { email: 'deactivate-me@gmdental.co.uk' });
    expect((await request(app).get('/admin/me').set(auth(token))).status).toBe(200);

    await db.query(`update admin_users set active=false where id=$1`, [admin.id]);

    const res = await request(app).get('/admin/me').set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('rejects a token issued before a session revocation; a fresh login works', async () => {
    const { token, admin } = await adminSession(app, { email: 'revoke-me@gmdental.co.uk' });
    expect((await request(app).get('/admin/me').set(auth(token))).status).toBe(200);

    await sleep(1100); // iat has second precision; make "issued before" unambiguous
    await db.query(`update admin_users set sessions_revoked_at = now() where id = $1`, [admin.id]);

    const res = await request(app).get('/admin/me').set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');

    await sleep(1100);
    const fresh = await adminSession(app, { email: 'revoke-me@gmdental.co.uk' }); // 409 email_taken -> reuse, fresh login
    expect((await request(app).get('/admin/me').set(auth(fresh.token))).status).toBe(200);
  });
});

describe('createAdmin validation', () => {
  it('manager without a practice -> 422 practice_required', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await expect(createAdmin({ email: 'manager-no-practice@gmdental.co.uk', password: 'correct-horse-battery', role: 'manager', practiceIds: [] }))
      .rejects.toMatchObject({ message: 'practice_required', status: 422 });
  });

  it('duplicate email -> 409 email_taken', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await createAdmin({ email: 'dupe@gmdental.co.uk', password: 'correct-horse-battery', role: 'admin' });
    await expect(createAdmin({ email: 'dupe@gmdental.co.uk', password: 'another-strong-pw', role: 'admin' }))
      .rejects.toMatchObject({ message: 'email_taken', status: 409 });
  });

  it('9-character password -> 422', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await expect(createAdmin({ email: 'short-pw@gmdental.co.uk', password: '123456789', role: 'admin' }))
      .rejects.toMatchObject({ status: 422 });
  });

  it('a valid manager creation resolves the practice', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    const row = await createAdmin({ email: 'valid-manager@gmdental.co.uk', password: 'correct-horse-battery', role: 'manager', practiceIds: [practiceId] });
    expect(row.role).toBe('manager');
  });

  it('a malformed email -> 422 validation', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await expect(createAdmin({ email: 'not-an-email', password: 'correct-horse-battery', role: 'admin' }))
      .rejects.toMatchObject({ message: 'validation', status: 422 });
  });

  it('a malformed practiceId (not a uuid) -> 422 validation, not a raw DB error', async () => {
    const { createAdmin } = await import('../src/services/adminService.js');
    await expect(createAdmin({ email: 'bad-practice-id@gmdental.co.uk', password: 'correct-horse-battery', role: 'manager', practiceIds: ['not-a-uuid'] }))
      .rejects.toMatchObject({ message: 'validation', status: 422 });
  });
});

describe('admin_users.role check constraint', () => {
  it("rejects 'owner' at the database layer (raw insert fails)", async () => {
    await expect(
      db.query(
        `insert into admin_users (email, password_hash, role, practice_ids) values ($1,$2,'owner','{}')`,
        ['legacy-owner@gmdental.co.uk', 'scrypt$00$00'],
      ),
    ).rejects.toBeTruthy();
  });
});

describe('config boot guard', () => {
  // The default jwtSecret in config.js is public (it ships in this repo) — a production
  // boot must refuse to start on it rather than silently signing sessions with a known key.
  // Spawned as a real subprocess: config.js throws at MODULE LOAD time, which only a fresh
  // process (not a re-import in this already-running test process) will actually exercise.
  const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const importConfig = "import('./src/config.js').then(()=>process.exit(0),()=>process.exit(2))";

  it('throws when NODE_ENV=production and API_JWT_SECRET is unset', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', `process.env.NODE_ENV='production'; delete process.env.API_JWT_SECRET; ${importConfig}`],
      { cwd: apiRoot, timeout: 10000 },
    );
    expect(result.status).toBe(2);
  });

  it('boots fine in production when API_JWT_SECRET is set', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', `process.env.NODE_ENV='production'; ${importConfig}`],
      { cwd: apiRoot, env: { ...process.env, API_JWT_SECRET: 'a-real-production-secret' }, timeout: 10000 },
    );
    expect(result.status).toBe(0);
  });

  it('does not throw outside production even without API_JWT_SECRET (dev/test unaffected)', () => {
    const result = spawnSync(
      process.execPath,
      ['-e', `delete process.env.API_JWT_SECRET; ${importConfig}`],
      { cwd: apiRoot, env: { ...process.env, NODE_ENV: 'test' }, timeout: 10000 },
    );
    expect(result.status).toBe(0);
  });
});
