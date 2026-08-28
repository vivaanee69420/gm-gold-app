// Practice-scoped payouts + the manager role (2026-08-28 decision: 4 practices, 4 managers;
// a member picks where they collect, and only that practice's manager can pay it out).
// Runs on in-memory PGlite like the other suites; the interleaved race needs real Postgres.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

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
    .set(auth(t.owner))
    .send({ status: 'treatment_completed' });
  expect(done.status).toBe(200);

  const payout = await request(app).post('/payouts').set(auth(ref.token)).send({ practiceId });
  expect(payout.status).toBe(200);
  return { token: ref.token, user: ref.user, code, payoutId: payout.body.payout.id };
}

async function managerFor(phone, practiceId) {
  const m = await signIn(phone);
  await db.query(
    `insert into admin_users (user_id, email, role, practice_ids) values ($1, $2, 'manager', array[$3::uuid])`,
    [m.user.id, `${phone.replace(/\s/g, '')}@gmdental.co.uk`, practiceId],
  );
  return m.token;
}

beforeAll(async () => {
  const dbModule = await import('../src/db.js');
  await dbModule.initDb();
  db = dbModule.db;
  const { buildApp } = await import('../src/app.js');
  app = buildApp();

  // Dev fallback makes any signed-in user an owner until an admin_users row exists.
  t.owner = (await signIn('07700 900900')).token;
  await request(app).put('/admin/reward-amount').set(auth(t.owner)).send({ amountPennies: 10000 });

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

  it('tells an owner they see every practice', async () => {
    const res = await request(app).get('/admin/me').set(auth(t.owner));
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('owner');
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
      .post(`/admin/payouts/${t.bob.payoutId}/mark-paid`).set(auth(t.owner)).send({ amountPennies: 10000 });
    expect(paid.status).toBe(409);
    const { rows } = await db.query(`select count(*)::int as n from wallet_ledger where payout_id=$1`, [t.bob.payoutId]);
    expect(rows[0].n).toBe(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('mark-paid vs cancel race (real Postgres only)', () => {
  it('exactly one of a simultaneous mark-paid and cancel wins', async () => {
    const carol = await referrerWithOpenPayout({ phone: '07700 900906', friendPhone: '07700 900907', name: 'Carol', practiceId: t.a });
    const [paid, cancelled] = await Promise.all([
      request(app).post(`/admin/payouts/${carol.payoutId}/mark-paid`).set(auth(t.owner)).send({ amountPennies: 10000 }),
      request(app).delete(`/payouts/${carol.payoutId}`).set(auth(carol.token)),
    ]);
    expect([paid.status, cancelled.status].sort()).toEqual([200, 409]);
    const { rows } = await db.query(`select status from payout_requests where id=$1`, [carol.payoutId]);
    const { rows: debits } = await db.query(`select count(*)::int as n from wallet_ledger where payout_id=$1`, [carol.payoutId]);
    expect(debits[0].n).toBe(rows[0].status === 'paid' ? 1 : 0);
  });
});
