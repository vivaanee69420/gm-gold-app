// Practice-scoped payouts + the manager role (2026-08-28 decision: 4 practices, 4 managers;
// a member picks where they collect, and only that practice's manager can pay it out).
// Runs on in-memory PGlite like the other suites; the interleaved race needs real Postgres.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { recordTreatment } from './helpers/treatment.js';
import { patientSession } from './helpers/patient.js';
import { adminSession } from './helpers/admin.js';
import { createAdmin, hashPassword } from '../src/services/adminService.js';

process.env.PGLITE_MEMORY = '1';

let app;
let authStub;
let db;
const t = {};

async function signIn(phone) {
  // Identity is email now; the phone is attached at the profile step. helpers/patient.js
  // walks the same two HTTP calls the mobile app makes.
  const session = await patientSession(app, authStub, { phone });
  return session;
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
  await recordTreatment(app, t.admin, sub.body.referral.id);
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
  ({ app, db, stub: authStub } = await bootTestApp());

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

// I4 (final review): a manager who moves branch is re-scoped, not deleted and re-created.
// What they can see must move with them the moment the row changes — no re-login, no revocation.
describe('re-scoping a manager (POST /admin/team/:id/practice)', () => {
  it("moves what they see: the new practice's payouts, and no longer the old practice's", async () => {
    const movedToken = await managerFor('07700 900940', t.a);
    const me = await request(app).get('/admin/me').set(auth(movedToken));
    expect(me.body.practices.map((p) => p.id)).toEqual([t.a]);
    expect((await request(app).get('/admin/payouts').set(auth(movedToken))).body.payouts.map((p) => p.id))
      .toContain(t.sarah.payoutId);

    const res = await request(app).post(`/admin/team/${me.body.id}/practice`).set(auth(t.admin))
      .send({ practiceId: t.b });
    expect(res.status).toBe(200);

    // Same token, no re-login: requireAdmin re-reads practice_ids on every request.
    const after = await request(app).get('/admin/payouts').set(auth(movedToken));
    const ids = after.body.payouts.map((p) => p.id);
    expect(ids).toContain(t.bob.payoutId);
    expect(ids).not.toContain(t.sarah.payoutId);
    expect((await request(app).get('/admin/me').set(auth(movedToken))).body.practices.map((p) => p.id)).toEqual([t.b]);
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

  // /admin/referrals and /admin/stats moved off this list in the 2026-09-10 manager-pipeline
  // decision (MANAGER_ROUTES in middleware/auth.js) — a manager now reaches both, scoped to
  // their own practice. manager-routes.test.js is what actually enforces the allowlist against
  // the live router; this just spot-checks a couple of admin-only surfaces that stayed closed.
  it('is locked out of admin surfaces outside the manager allowlist', async () => {
    for (const path of ['/admin/proposals', '/admin/settings']) {
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

// I6 (final review): actor_id alone can't say WHICH id space it points at — admin_users.id
// and users.id are separate tables with separate uuids, so an audit row saying "actor
// 9f3c…" was unreadable. actor_kind records that, and 'system' covers the sync worker.
describe('events.actor_kind', () => {
  it("logs a mark-paid as 'admin' and the member's own payout request as 'user'", async () => {
    const { rows: paid } = await db.query(
      `select actor_kind, actor_id from events where entity_type='payout' and action='paid' and entity_id=$1`,
      [t.sarah.payoutId],
    );
    expect(paid[0].actor_kind).toBe('admin');

    const { rows: requested } = await db.query(
      `select actor_kind, actor_id from events where entity_type='payout' and action='requested' and entity_id=$1`,
      [t.sarah.payoutId],
    );
    expect(requested[0]).toMatchObject({ actor_kind: 'user', actor_id: t.sarah.user.id });
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
      [email, await hashPassword(password)],
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
    await recordTreatment(app, t.admin, sub1.body.referral.id);
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
    await recordTreatment(app, t.admin, sub2.body.referral.id);
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

// Review round 2, item 5: requireUuidParam('id') is now applied to every route that forwards
// :id into a raw uuid-column query. Two representative routes here — a patient-facing DELETE
// and an admin-facing POST — cover both requireUser- and requireAdmin-gated call sites; the
// other newly-guarded admin routes share the exact same middleware, not separate logic.
describe('malformed :id -> 422 validation, never a raw Postgres error', () => {
  it('POST /admin/payouts/not-a-uuid/mark-paid and DELETE /payouts/not-a-uuid both 422, with no DB text leaked', async () => {
    const markPaid = await request(app).post('/admin/payouts/not-a-uuid/mark-paid').set(auth(t.admin)).send({ amountPennies: 100 });
    expect(markPaid.status).toBe(422);
    expect(markPaid.body.error).toBe('validation');
    expect(JSON.stringify(markPaid.body)).not.toMatch(/invalid input syntax|22P02/i);

    const patient = await signIn('07700 900950');
    const del = await request(app).delete('/payouts/not-a-uuid').set(auth(patient.token));
    expect(del.status).toBe(422);
    expect(del.body.error).toBe('validation');
    expect(JSON.stringify(del.body)).not.toMatch(/invalid input syntax|22P02/i);
  });
});

describe('status writes are practice-scoped', () => {
  let referralId;
  let otherPracticeManager;

  beforeAll(async () => {
    // A referral belonging to practice[0].
    const ref = await signIn('07700 902001');
    await request(app).post('/me/profile').set(auth(ref.token))
      .send({ firstName: 'Scope', lastName: 'Test', notifyOptIn: false });
    const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });

    const friend = await signIn('07700 902002');
    await request(app).post('/me/profile').set(auth(friend.token))
      .send({ firstName: 'Friend', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code: role.body.user.referralCode,
      fullName: 'Scoped Patient',
      treatmentInterest: 'implants',
      preferredPracticeId: t.practices[0].id,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    referralId = sub.body.referral.id;

    // A manager at a DIFFERENT practice.
    otherPracticeManager = await managerFor('07700 902003', t.practices[1].id);
  });

  it('404s a manager moving another practice\'s referral, and writes no credit', async () => {
    await recordTreatment(app, t.admin, referralId);
    const res = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(otherPracticeManager))
      .send({ status: 'treatment_started' });

    // 404, not 403: a 403 would confirm the referral exists to someone who must not know.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');

    const { rows } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1`,
      [referralId],
    );
    expect(rows[0].n).toBe(0);

    const { rows: still } = await db.query(`select status from referrals where id = $1`, [referralId]);
    expect(still[0].status).toBe('new');
  });

  it('lets the owning practice\'s manager move it', async () => {
    const owner = await managerFor('07700 902004', t.practices[0].id);
    const res = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(owner))
      .send({ status: 'contacted' });
    expect(res.status).toBe(200);
  });

  it('lets an admin move any practice\'s referral', async () => {
    const res = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(t.admin))
      .send({ status: 'booked' });
    expect(res.status).toBe(200);
  });

  it('lets the owning practice\'s manager credit the commission', async () => {
    const owner = await managerFor('07700 902005', t.practices[0].id);
    await recordTreatment(app, t.admin, referralId);
    const res = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(owner))
      .send({ status: 'treatment_started' });
    expect(res.status).toBe(200);
    expect(res.body.credit, 'the whole point of the feature: a manager releases the commission')
      .not.toBeNull();

    const { rows } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1 and kind = 'credit'`,
      [referralId],
    );
    expect(rows[0].n).toBe(1);
  });
});
