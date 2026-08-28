// Admin identity: email + password accounts, POST /auth/admin/login, requireAdmin
// (no dev fallback, no patient token accepted), createAdmin validation (FR-24 rework).
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminSession } from './helpers/admin.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let practiceId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

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
