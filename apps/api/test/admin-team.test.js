// FR-24 team management: GET/POST /admin/team, POST /admin/team/:id/password,
// POST /admin/team/:id/active, POST /admin/me/password. All admin-only except
// /admin/me/password (both roles) — the manager fence in middleware/auth.js already keeps
// managers off every other /admin/team* route; these tests assert that, not re-implement it.
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminSession } from './helpers/admin.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let practiceId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const dbModule = await import('../src/db.js');
  await dbModule.initDb();
  db = dbModule.db;
  const { buildApp } = await import('../src/app.js');
  app = buildApp();

  const practices = await db.query(`select id from practices where active order by name limit 1`);
  practiceId = practices.rows[0].id;
});

describe('GET /admin/team', () => {
  it('lists created accounts, ordered by role then email, and never leaks a password hash', async () => {
    const { token } = await adminSession(app, { email: 'lister@gmdental.co.uk' });
    await adminSession(app, { email: 'lister-manager@gmdental.co.uk', role: 'manager', practiceIds: [practiceId] });

    const res = await request(app).get('/admin/team').set(auth(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.team)).toBe(true);
    expect(res.body.team.length).toBeGreaterThanOrEqual(2);

    for (const member of res.body.team) {
      expect(member).not.toHaveProperty('password');
      expect(member).not.toHaveProperty('passwordHash');
      expect(member).not.toHaveProperty('password_hash');
      expect(JSON.stringify(member)).not.toMatch(/scrypt\$/); // no hash string leaked under any key name
      expect(member).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          email: expect.any(String),
          role: expect.stringMatching(/^(admin|manager)$/),
          practices: expect.any(Array),
          active: expect.any(Boolean),
        }),
      );
      expect('lastLoginAt' in member).toBe(true);
      expect('createdAt' in member).toBe(true);
    }

    const lister = res.body.team.find((m) => m.email === 'lister@gmdental.co.uk');
    const listerManager = res.body.team.find((m) => m.email === 'lister-manager@gmdental.co.uk');
    expect(lister.role).toBe('admin');
    expect(listerManager.role).toBe('manager');
    expect(listerManager.practices).toEqual([{ id: practiceId, name: expect.any(String) }]);

    // ordered by role then email: every 'admin' row sorts before every 'manager' row
    const roles = res.body.team.map((m) => m.role);
    const lastAdminIdx = roles.lastIndexOf('admin');
    const firstManagerIdx = roles.indexOf('manager');
    if (lastAdminIdx !== -1 && firstManagerIdx !== -1) {
      expect(lastAdminIdx).toBeLessThan(firstManagerIdx);
    }
  });

  it('a manager -> 403 forbidden', async () => {
    const { token } = await adminSession(app, { email: 'team-fence-get@gmdental.co.uk', role: 'manager', practiceIds: [practiceId] });
    const res = await request(app).get('/admin/team').set(auth(token));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('POST /admin/team', () => {
  it('creates an admin, logs a "created" event, and returns it with no hash', async () => {
    const { token, admin: creator } = await adminSession(app, { email: 'creator@gmdental.co.uk' });
    const res = await request(app).post('/admin/team').set(auth(token)).send({
      email: 'new-admin@gmdental.co.uk',
      password: 'correct-horse-battery',
      role: 'admin',
    });
    expect(res.status).toBe(200);
    expect(res.body.admin.email).toBe('new-admin@gmdental.co.uk');
    expect(res.body.admin.role).toBe('admin');
    expect(res.body.admin).not.toHaveProperty('password');
    expect(res.body.admin).not.toHaveProperty('passwordHash');

    const ev = await db.query(
      `select action, actor_id from events where entity_type='admin_user' and entity_id=$1 order by created_at desc limit 1`,
      [res.body.admin.id],
    );
    expect(ev.rows[0]).toMatchObject({ action: 'created', actor_id: creator.id });
  });

  it('a manager needs a practice -> 422 practice_required', async () => {
    const { token } = await adminSession(app, { email: 'creator-2@gmdental.co.uk' });
    const res = await request(app).post('/admin/team').set(auth(token)).send({
      email: 'manager-no-practice@gmdental.co.uk',
      password: 'correct-horse-battery',
      role: 'manager',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('practice_required');
  });

  it('a manager -> 403 forbidden', async () => {
    const { token } = await adminSession(app, { email: 'team-fence-post@gmdental.co.uk', role: 'manager', practiceIds: [practiceId] });
    const res = await request(app).post('/admin/team').set(auth(token)).send({
      email: 'sneaky-create@gmdental.co.uk', password: 'correct-horse-battery', role: 'admin',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('POST /admin/team/:id/password', () => {
  it('sets a new password: the old token dies (logged out) and the new password logs in', async () => {
    const { token: adminToken, admin: adminAdmin } = await adminSession(app, { email: 'pw-setter@gmdental.co.uk' });
    const { token: managerToken, admin: managerAdmin } = await adminSession(app, {
      email: 'pw-target-manager@gmdental.co.uk', role: 'manager', practiceIds: [practiceId],
    });

    expect((await request(app).get('/admin/me').set(auth(managerToken))).status).toBe(200);

    const res = await request(app).post(`/admin/team/${managerAdmin.id}/password`).set(auth(adminToken))
      .send({ password: 'brand-new-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const dead = await request(app).get('/admin/me').set(auth(managerToken));
    expect(dead.status).toBe(401);
    expect(dead.body.error).toBe('unauthorized');

    const login = await request(app).post('/auth/admin/login')
      .send({ email: 'pw-target-manager@gmdental.co.uk', password: 'brand-new-strong-password' });
    expect(login.status).toBe(200);

    const ev = await db.query(
      `select action, actor_id from events where entity_type='admin_user' and entity_id=$1 order by created_at desc limit 1`,
      [managerAdmin.id],
    );
    expect(ev.rows[0]).toMatchObject({ action: 'password_set', actor_id: adminAdmin.id });
  });

  it('a weak password -> 422 weak_password', async () => {
    const { token: adminToken } = await adminSession(app, { email: 'pw-setter-weak@gmdental.co.uk' });
    const { admin: target } = await adminSession(app, { email: 'pw-weak-target@gmdental.co.uk' });
    const res = await request(app).post(`/admin/team/${target.id}/password`).set(auth(adminToken)).send({ password: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('weak_password');
  });

  it('an unknown id -> 404 not_found', async () => {
    const { token: adminToken } = await adminSession(app, { email: 'pw-setter-404@gmdental.co.uk' });
    const res = await request(app).post(`/admin/team/${crypto.randomUUID()}/password`).set(auth(adminToken))
      .send({ password: 'correct-horse-battery' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('a manager -> 403 forbidden', async () => {
    const { token: managerToken } = await adminSession(app, { email: 'team-fence-setpw@gmdental.co.uk', role: 'manager', practiceIds: [practiceId] });
    const { admin: target } = await adminSession(app, { email: 'pw-fence-target@gmdental.co.uk' });
    const res = await request(app).post(`/admin/team/${target.id}/password`).set(auth(managerToken)).send({ password: 'correct-horse-battery' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('POST /admin/team/:id/active', () => {
  it('deactivating self -> 409 cannot_deactivate_self', async () => {
    const { token, admin } = await adminSession(app, { email: 'self-deactivate@gmdental.co.uk' });
    const res = await request(app).post(`/admin/team/${admin.id}/active`).set(auth(token)).send({ active: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('cannot_deactivate_self');
  });

  it('a deactivated manager cannot log in; reactivating restores access (with events logged)', async () => {
    const { token: adminToken, admin: adminAdmin } = await adminSession(app, { email: 'active-setter@gmdental.co.uk' });
    const { admin: manager } = await adminSession(app, {
      email: 'toggle-manager@gmdental.co.uk', password: 'correct-horse-battery', role: 'manager', practiceIds: [practiceId],
    });

    const off = await request(app).post(`/admin/team/${manager.id}/active`).set(auth(adminToken)).send({ active: false });
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ ok: true });

    const loginWhileOff = await request(app).post('/auth/admin/login')
      .send({ email: 'toggle-manager@gmdental.co.uk', password: 'correct-horse-battery' });
    expect(loginWhileOff.status).toBe(401);
    expect(loginWhileOff.body.error).toBe('invalid_credentials');

    const evOff = await db.query(
      `select action, actor_id from events where entity_type='admin_user' and entity_id=$1 order by created_at desc limit 1`,
      [manager.id],
    );
    expect(evOff.rows[0]).toMatchObject({ action: 'deactivated', actor_id: adminAdmin.id });

    const on = await request(app).post(`/admin/team/${manager.id}/active`).set(auth(adminToken)).send({ active: true });
    expect(on.status).toBe(200);

    const loginAfterOn = await request(app).post('/auth/admin/login')
      .send({ email: 'toggle-manager@gmdental.co.uk', password: 'correct-horse-battery' });
    expect(loginAfterOn.status).toBe(200);

    const evOn = await db.query(
      `select action from events where entity_type='admin_user' and entity_id=$1 order by created_at desc limit 1`,
      [manager.id],
    );
    expect(evOn.rows[0]).toMatchObject({ action: 'activated' });
  });

  it('an unknown id -> 404 not_found', async () => {
    const { token } = await adminSession(app, { email: 'active-setter-404@gmdental.co.uk' });
    const res = await request(app).post(`/admin/team/${crypto.randomUUID()}/active`).set(auth(token)).send({ active: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('a manager -> 403 forbidden', async () => {
    const { token: managerToken } = await adminSession(app, { email: 'team-fence-active@gmdental.co.uk', role: 'manager', practiceIds: [practiceId] });
    const { admin: target } = await adminSession(app, { email: 'active-fence-target@gmdental.co.uk' });
    const res = await request(app).post(`/admin/team/${target.id}/active`).set(auth(managerToken)).send({ active: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
  });
});

describe('POST /admin/me/password (both roles)', () => {
  it('wrong current password -> 401 wrong_password', async () => {
    const { token } = await adminSession(app, { email: 'selfpw-wrong@gmdental.co.uk', password: 'correct-horse-battery' });
    const res = await request(app).post('/admin/me/password').set(auth(token))
      .send({ currentPassword: 'not-the-right-one', newPassword: 'another-strong-password-2' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('wrong_password');
  });

  it('a weak new password -> 422 weak_password', async () => {
    const { token } = await adminSession(app, { email: 'selfpw-weak@gmdental.co.uk', password: 'correct-horse-battery' });
    const res = await request(app).post('/admin/me/password').set(auth(token))
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'short' });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('weak_password');
  });

  it('right current password: old token dies, the returned token works immediately (no sleep needed)', async () => {
    const { token, admin } = await adminSession(app, { email: 'selfpw-right@gmdental.co.uk', password: 'correct-horse-battery' });
    expect((await request(app).get('/admin/me').set(auth(token))).status).toBe(200);

    const res = await request(app).post('/admin/me/password').set(auth(token))
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'another-strong-password-2' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.token).not.toBe(token);

    const oldDead = await request(app).get('/admin/me').set(auth(token));
    expect(oldDead.status).toBe(401);
    expect(oldDead.body.error).toBe('unauthorized');

    const newWorks = await request(app).get('/admin/me').set(auth(res.body.token));
    expect(newWorks.status).toBe(200);

    const ev = await db.query(
      `select action, actor_id from events where entity_type='admin_user' and entity_id=$1 order by created_at desc limit 1`,
      [admin.id],
    );
    expect(ev.rows[0]).toMatchObject({ action: 'password_changed', actor_id: admin.id });
  });

  it('works for a manager too', async () => {
    const { token } = await adminSession(app, {
      email: 'selfpw-manager@gmdental.co.uk', password: 'correct-horse-battery', role: 'manager', practiceIds: [practiceId],
    });
    const res = await request(app).post('/admin/me/password').set(auth(token))
      .send({ currentPassword: 'correct-horse-battery', newPassword: 'another-strong-password-2' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect((await request(app).get('/admin/me').set(auth(res.body.token))).status).toBe(200);
  });
});

// Kept as the LAST describe block: it forces every other 'admin'-role row inactive to isolate
// the scenario, which would otherwise pollute state for tests declared after it.
describe('last_admin protection', () => {
  it('deactivating the sole remaining active admin -> 409 last_admin', async () => {
    // Unreachable over HTTP with a well-formed request: the caller must itself be a live,
    // active admin distinct from the target (requireAdmin + the manager fence guarantee
    // that), so the caller always counts as one remaining active admin and this path can
    // never trip through a legitimate request. Exercise setActive() directly instead, after
    // forcing every OTHER admin row inactive so the target really is the last one standing.
    const { setActive } = await import('../src/services/adminService.js');
    const { admin: lonely } = await adminSession(app, { email: 'lonely-admin@gmdental.co.uk' });
    await db.query(`update admin_users set active=false where role='admin' and id <> $1`, [lonely.id]);

    await expect(setActive({ id: lonely.id, active: false, actorId: crypto.randomUUID() }))
      .rejects.toMatchObject({ message: 'last_admin', status: 409 });

    const check = await db.query(`select active from admin_users where id=$1`, [lonely.id]);
    expect(check.rows[0].active).toBe(true); // refused: still active
  });
});
