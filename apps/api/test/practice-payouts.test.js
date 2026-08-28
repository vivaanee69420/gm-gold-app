// Practice-scoped payouts + the manager role (2026-08-28 decision: 4 practices, 4 managers;
// a member picks where they collect, and only that practice's manager can pay it out).
// Runs on in-memory PGlite like the other suites; the interleaved race needs real Postgres.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { adminSession } from './helpers/admin.js';
import { createAdmin, hashPassword } from '../src/services/adminService.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
const t = {};

async function signIn(phone) {
  const send = await request(app).post('/auth/otp/send').send({ phone });
  expect(send.status).toBe(200);
  const code = send.body.devHint.match(/(\d{6})/)[1];
  const verify = await request(app).post('/auth/otp/verify').send({ phone, code });
  expect(verify.status).toBe(200);
  return { token: verify.body.token, user: verify.body.user };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** A referrer with one credited £100 referral at `practiceId` and an open payout there. */
async function referrerWithOpenPayout({ phone, friendPhone, name, practiceId }) {
  const ref = await signIn(phone);
  await request(app).post('/me/profile').set(auth(ref.token)).send({ firstName: name, lastName: 'Member', notifyOptIn: false });
  const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });
  const code = role.body.user.referralCode;

  const friend = await signIn(friendPhone);
  await request(app).post('/me/profile').set(auth(friend.token)).send({ firstName: 'Friend', notifyOptIn: false });
  await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
  const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
    code,
    fullName: `Friend Of ${name}`,
    treatmentInterest: 'implants',
    preferredPracticeId: practiceId,
    consent: true,
    consentVersion: 'referred-v1-2026-08',
  });
  expect(sub.status).toBe(200);
  const done = await request(app)
    .patch(`/admin/referrals/${sub.body.referral.id}/status`)
    .set(auth(t.admin))
    .send({ status: 'treatment_completed' });
  expect(done.status).toBe(200);

  const payout = await request(app).post('/payouts').set(auth(ref.token)).send({ practiceId });
  expect(payout.status).toBe(200);
  return { token: ref.token, user: ref.user, code, payoutId: payout.body.payout.id };
}

async function managerFor(phone, practiceId) {
  const email = `${phone.replace(/\s/g, '')}@gmdental.co.uk`;
  const { token } = await adminSession(app, { email, role: 'manager', practiceIds: [practiceId] });
  return token;
}

beforeAll(async () => {
  const dbModule = await import('../src/db.js');
  await dbModule.initDb();
  db = dbModule.db;
  const { buildApp } = await import('../src/app.js');
  app = buildApp();

  t.admin = (await adminSession(app)).token;
  await request(app).put('/admin/reward-amount').set(auth(t.admin)).send({ amountPennies: 10000 });

  const practices = (await request(app).get('/practices')).body.practices;
  t.practices = practices;
  t.a = practices[0].id;
  t.b = practices[1].id;

  t.sarah = await referrerWithOpenPayout({ phone: '07700 900901', friendPhone: '07700 900902', name: 'Sarah', practiceId: t.a });
  t.bob = await referrerWithOpenPayout({ phone: '07700 900903', friendPhone: '07700 900904', name: 'Bob', practiceId: t.b });

  t.managerA = await managerFor('07700 900905', t.a);
});

describe('practices', () => {
  it('lists exactly the four live GM Dental sites', async () => {
    expect(t.practices.map((p) => p.name).sort()).toEqual(['Ashford', 'Barnet', 'Bexleyheath', 'Rochester']);
  });
});

describe('GET /admin/me', () => {
  it('tells a manager their role and single practice', async () => {
    const res = await request(app).get('/admin/me').set(auth(t.managerA));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('manager');
    expect(res.body.practices).toEqual([{ id: t.a, name: t.practices[0].name }]);
  });

  it('tells an admin they see every practice', async () => {
    const res = await request(app).get('/admin/me').set(auth(t.admin));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(res.body.practices.map((p) => p.id).sort()).toEqual(t.practices.map((p) => p.id).sort());
  });
});

describe('manager payout list', () => {
  it('shows only requests where the member chose this practice', async () => {
    const res = await request(app).get('/admin/payouts').set(auth(t.managerA));
    expect(res.status).toBe(200);
    const ids = res.body.payouts.map((p) => p.id);
    expect(ids).toContain(t.sarah.payoutId);
    expect(ids).not.toContain(t.bob.payoutId);
  });

  it('carries what reception needs to verify identity and the credits behind the balance', async () => {
    const res = await request(app).get('/admin/payouts').set(auth(t.managerA));
    const row = res.body.payouts.find((p) => p.id === t.sarah.payoutId);
    expect(row.phone).toBe('+447700900901');
    expect(row.referral_code).toBe(t.sarah.code);
    expect(row.credits).toHaveLength(1);
    expect(row.credits[0].amountPennies).toBe(10000);
    expect(row.credits[0].friend).toMatch(/^Friend/);
  });
});

describe('manager is fenced to their practice', () => {
  it("cannot mark another practice's payout paid", async () => {
    const res = await request(app)
      .post(`/admin/payouts/${t.bob.payoutId}/mark-paid`).set(auth(t.managerA)).send({ amountPennies: 10000 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    const { rows } = await db.query(`select status from payout_requests where id=$1`, [t.bob.payoutId]);
    expect(rows[0].status).toBe('open');
  });

  it("cannot cancel another practice's payout", async () => {
    const res = await request(app)
      .post(`/admin/payouts/${t.bob.payoutId}/cancel`).set(auth(t.managerA)).send({ reason: 'not ours' });
    expect(res.status).toBe(403);
  });

  it('is locked out of every other admin surface', async () => {
    for (const path of ['/admin/referrals', '/admin/stats', '/admin/proposals', '/admin/settings']) {
      const res = await request(app).get(path).set(auth(t.managerA));
      expect(res.status, path).toBe(403);
      expect(res.body.error, path).toBe('forbidden');
    }
    const lever = await request(app).put('/admin/reward-amount').set(auth(t.managerA)).send({ amountPennies: 1 });
    expect(lever.status).toBe(403);
  });
});

describe('mark paid = type the cash handed over', () => {
  it('requires the amount', async () => {
    const res = await request(app).post(`/admin/payouts/${t.sarah.payoutId}/mark-paid`).set(auth(t.managerA)).send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('amount_required');
  });

  it('rejects an amount that does not match the request', async () => {
    const res = await request(app)
      .post(`/admin/payouts/${t.sarah.payoutId}/mark-paid`).set(auth(t.managerA)).send({ amountPennies: 9000 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('amount_mismatch');
    const { rows } = await db.query(`select status from payout_requests where id=$1`, [t.sarah.payoutId]);
    expect(rows[0].status).toBe('open');
  });

  it('pays out when the amount matches, debiting the wallet once', async () => {
    const res = await request(app)
      .post(`/admin/payouts/${t.sarah.payoutId}/mark-paid`).set(auth(t.managerA)).send({ amountPennies: 10000 });
    expect(res.status).toBe(200);
    const wallet = await request(app).get('/wallet').set(auth(t.sarah.token));
    expect(wallet.body.wallet.balancePennies).toBe(0);

    const again = await request(app)
      .post(`/admin/payouts/${t.sarah.payoutId}/mark-paid`).set(auth(t.managerA)).send({ amountPennies: 10000 });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('payout_not_open');
  });
});

describe('member cancel', () => {
  it("cannot cancel another member's request", async () => {
    const res = await request(app).delete(`/payouts/${t.bob.payoutId}`).set(auth(t.sarah.token));
    expect(res.status).toBe(409);
    const { rows } = await db.query(`select status from payout_requests where id=$1`, [t.bob.payoutId]);
    expect(rows[0].status).toBe('open');
  });

  it('cancelling then marking paid is refused — no debit for cash never collected', async () => {
    const cancel = await request(app).delete(`/payouts/${t.bob.payoutId}`).set(auth(t.bob.token));
    expect(cancel.status).toBe(200);
    const paid = await request(app)
      .post(`/admin/payouts/${t.bob.payoutId}/mark-paid`).set(auth(t.admin)).send({ amountPennies: 10000 });
    expect(paid.status).toBe(409);
    const { rows } = await db.query(`select count(*)::int as n from wallet_ledger where payout_id=$1`, [t.bob.payoutId]);
    expect(rows[0].n).toBe(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('mark-paid vs cancel race (real Postgres only)', () => {
  it('exactly one of a simultaneous mark-paid and cancel wins', async () => {
    const carol = await referrerWithOpenPayout({ phone: '07700 900906', friendPhone: '07700 900907', name: 'Carol', practiceId: t.a });
    const [paid, cancelled] = await Promise.all([
      request(app).post(`/admin/payouts/${carol.payoutId}/mark-paid`).set(auth(t.admin)).send({ amountPennies: 10000 }),
      request(app).delete(`/payouts/${carol.payoutId}`).set(auth(carol.token)),
    ]);
    expect([paid.status, cancelled.status].sort()).toEqual([200, 409]);
    const { rows } = await db.query(`select status from payout_requests where id=$1`, [carol.payoutId]);
    const { rows: debits } = await db.query(`select count(*)::int as n from wallet_ledger where payout_id=$1`, [carol.payoutId]);
    expect(debits[0].n).toBe(rows[0].status === 'paid' ? 1 : 0);
  });
});

// Controller ruling (final review, 2026-08-28): an empty practice_ids means opposite things
// for the two practice-scoped roles. `admin` with `{}` is the documented all-practice
// default (grant-admin.js) — it must see and be able to act on every practice, same as an
// owner. `manager` with `{}` has not been assigned a practice yet — it must see and act on
// NOTHING, not fall through to "all" the way a naive `practiceIds.length ? … : null` would.
describe('controller ruling: empty practice_ids means "all" for admin, "none" for manager', () => {
  it('an unscoped admin (practice_ids={}) sees every payout and can mark one paid', async () => {
    const eve = await referrerWithOpenPayout({ phone: '07700 900930', friendPhone: '07700 900931', name: 'Eve', practiceId: t.b });
    const { token: adminToken } = await adminSession(app, { email: 'admin.unscoped@gmdental.co.uk', role: 'admin', practiceIds: [] });

    const list = await request(app).get('/admin/payouts').set(auth(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.payouts.map((p) => p.id)).toContain(eve.payoutId);

    const mark = await request(app)
      .post(`/admin/payouts/${eve.payoutId}/mark-paid`).set(auth(adminToken)).send({ amountPennies: 10000 });
    expect(mark.status).toBe(200);
  });

  // createAdmin now enforces the invariant at creation time (FR-24 rework, admin-accounts task):
  // a manager MUST carry exactly one active practice id, so "unscoped manager" can no longer
  // arise through the public API at all.
  it('creating a manager with no practice is rejected (practice_required)', async () => {
    await expect(createAdmin({ email: 'manager.unscoped@gmdental.co.uk', password: 'correct-horse-battery', role: 'manager', practiceIds: [] }))
      .rejects.toMatchObject({ message: 'practice_required', status: 422 });
  });

  // Defense in depth: if an unscoped manager row ever existed anyway (bypassing createAdmin —
  // this insert goes straight to the DB, which the invariant above no longer allows via the
  // service), the practiceScope/actionScope fence in app.js must still degrade to "sees/acts
  // on nothing", not fall through to "all".
  it('an unscoped manager row (bypassing createAdmin) sees nothing, and 403s on mark-paid', async () => {
    const finn = await referrerWithOpenPayout({ phone: '07700 900933', friendPhone: '07700 900934', name: 'Finn', practiceId: t.a });
    const email = 'manager.unscoped.bypass@gmdental.co.uk';
    const password = 'correct-horse-battery';
    await db.query(
      `insert into admin_users (email, password_hash, role, practice_ids) values ($1,$2,'manager','{}')`,
      [email, hashPassword(password)],
    );
    const login = await request(app).post('/auth/admin/login').send({ email, password });
    expect(login.status).toBe(200);
    const managerToken = login.body.token;

    const me = await request(app).get('/admin/me').set(auth(managerToken));
    expect(me.status).toBe(200);
    expect(me.body.practices).toEqual([]);

    const list = await request(app).get('/admin/payouts').set(auth(managerToken));
    expect(list.status).toBe(200);
    expect(list.body.payouts).toEqual([]);

    const mark = await request(app)
      .post(`/admin/payouts/${finn.payoutId}/mark-paid`).set(auth(managerToken)).send({ amountPennies: 10000 });
    expect(mark.status).toBe(403);
    expect(mark.body.error).toBe('forbidden');
    const { rows } = await db.query(`select status from payout_requests where id=$1`, [finn.payoutId]);
    expect(rows[0].status).toBe('open');
  });
});

// A settled payout's balance has already moved; only the OPEN request reception is about
// to pay out should carry the member's unpaid credits.
describe('credits behind an open payout exclude anything already paid out', () => {
  it('a paid payout shows no credits; the next open one shows only the later credit', async () => {
    const gwen = await signIn('07700 900940');
    await request(app).post('/me/profile').set(auth(gwen.token)).send({ firstName: 'Gwen', lastName: 'Member', notifyOptIn: false });
    const role = await request(app).post('/me/role').set(auth(gwen.token)).send({ role: 'referrer' });
    const code = role.body.user.referralCode;

    // First friend -> first credit -> first payout, paid in full.
    const friend1 = await signIn('07700 900941');
    await request(app).post('/me/profile').set(auth(friend1.token)).send({ firstName: 'FriendOne', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend1.token)).send({ role: 'referred' });
    const sub1 = await request(app).post('/referrals').set(auth(friend1.token)).send({
      code, fullName: 'Friend One', treatmentInterest: 'implants', preferredPracticeId: t.a,
      consent: true, consentVersion: 'referred-v1-2026-08',
    });
    expect(sub1.status).toBe(200);
    const done1 = await request(app)
      .patch(`/admin/referrals/${sub1.body.referral.id}/status`).set(auth(t.admin)).send({ status: 'treatment_completed' });
    expect(done1.status).toBe(200);

    const payout1 = await request(app).post('/payouts').set(auth(gwen.token)).send({ practiceId: t.a });
    expect(payout1.status).toBe(200);
    const paid1 = await request(app)
      .post(`/admin/payouts/${payout1.body.payout.id}/mark-paid`).set(auth(t.admin)).send({ amountPennies: 10000 });
    expect(paid1.status).toBe(200);

    // Second friend -> second credit -> second (open) payout.
    const friend2 = await signIn('07700 900942');
    await request(app).post('/me/profile').set(auth(friend2.token)).send({ firstName: 'FriendTwo', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend2.token)).send({ role: 'referred' });
    const sub2 = await request(app).post('/referrals').set(auth(friend2.token)).send({
      code, fullName: 'Friend Two', treatmentInterest: 'implants', preferredPracticeId: t.a,
      consent: true, consentVersion: 'referred-v1-2026-08',
    });
    expect(sub2.status).toBe(200);
    const done2 = await request(app)
      .patch(`/admin/referrals/${sub2.body.referral.id}/status`).set(auth(t.admin)).send({ status: 'treatment_completed' });
    expect(done2.status).toBe(200);

    const payout2 = await request(app).post('/payouts').set(auth(gwen.token)).send({ practiceId: t.a });
    expect(payout2.status).toBe(200);

    const list = await request(app).get('/admin/payouts').set(auth(t.admin));
    const settledRow = list.body.payouts.find((p) => p.id === payout1.body.payout.id);
    expect(settledRow.credits).toEqual([]);

    const openRow = list.body.payouts.find((p) => p.id === payout2.body.payout.id);
    expect(openRow.credits).toHaveLength(1);
    expect(openRow.credits[0].amountPennies).toBe(10000);
    expect(openRow.credits[0].friend).toMatch(/^Friend/);
  });
});
