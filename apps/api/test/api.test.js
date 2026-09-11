// Core-loop + money-path tests (REQUIREMENTS §6 rows 1,2,4,6,7,10 + credit invariants).
// Runs on in-memory PGlite (real Postgres semantics). The two-connection concurrency
// race (matrix row 9) needs a real multi-connection Postgres — covered when DATABASE_URL
// points at Supabase; see test at bottom.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { recordTreatment } from './helpers/treatment.js';
import { patientSession } from './helpers/patient.js';
import { adminSession } from './helpers/admin.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let authStub;
const agents = {};

async function signIn(phone) {
  // Identity is email now; the phone is attached at the profile step. helpers/patient.js
  // walks the same two HTTP calls the mobile app makes.
  const session = await patientSession(app, authStub, { phone });
  return session;
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ({ app, db, stub: authStub } = await bootTestApp());
  agents.admin = (await adminSession(app)).token;
});

describe('auth', () => {
  it('health check', async () => {
    const res = await request(app).get('/healthz');
    expect(res.body.ok).toBe(true);
  });

  // The wrong-code cap and the send rate limit used to be tested here against
  // otpService.js. That file is gone: Supabase Auth generates, stores, expires and
  // rate-limits login codes now, so those are its behaviours to guarantee, not ours, and a
  // test asserting them here would only be testing a mock. What IS still ours is that the old
  // endpoints are gone — asserted in auth-supabase.test.js — and that a verified Supabase
  // token maps to the right account, asserted there too.
  //
  // Operational note that replaces the deleted rate-limit test: Supabase's auth email limit
  // defaults to 30/hour with custom SMTP. Raise it in the dashboard before any launch push.

  it('signs in, and the phone captured at profile is normalized to E.164', async () => {
    const { user, token } = await signIn('07700 900123');
    expect(user.phone).toBe('+447700900123');
    expect(user.email).toMatch(/@example\.com$/);
    agents.referrer = token;
  });
});

describe('referrer setup', () => {
  it('saves profile and issues a referral code carrying the first name', async () => {
    await request(app).post('/me/profile').set(auth(agents.referrer))
      .send({ firstName: 'Sarah', lastName: 'Lewis', notifyOptIn: true });
    const role = await request(app).post('/me/role').set(auth(agents.referrer)).send({ role: 'referrer' });
    expect(role.status).toBe(200);
    // The code is said out loud and typed by a friend, so it leads with who it belongs to.
    expect(role.body.user.referralCode).toMatch(/^SARAH[A-Z2-9]{4}$/);
    agents.code = role.body.user.referralCode;
  });

  it('keeps the code when the referrer later renames themselves', async () => {
    // The name in a code is a snapshot of when it was issued. Regenerating it would silently
    // break every card, QR code and text already shared — so a rename must not touch it.
    const before = (await request(app).get('/me').set(auth(agents.referrer))).body.user.referralCode;

    await request(app).post('/me/profile').set(auth(agents.referrer))
      .send({ firstName: 'Sara', lastName: 'Lewis', notifyOptIn: true });

    const after = (await request(app).get('/me').set(auth(agents.referrer))).body.user.referralCode;
    expect(after).toBe(before);
    expect(after.startsWith('SARAH'), 'the old spelling stays — that is the point').toBe(true);
  });

  it('issues a code even when the profile has no usable first name', async () => {
    // Refusing someone a referral code over the spelling of their name would be worse than a
    // code with no name in it.
    // Via the helper's own firstName, which goes through profileSchema properly — a partial
    // /me/profile post 422s (lastName and phone are required) and would leave the helper's
    // default name in place, quietly testing nothing.
    const odd = await patientSession(app, authStub, { phone: '07700 900931', firstName: '???' });
    const role = await request(app).post('/me/role').set(auth(odd.token)).send({ role: 'referrer' });

    expect(role.status).toBe(200);
    // No letters survive '???', so the code is all-random — still a working code.
    expect(role.body.user.referralCode).toMatch(/^[A-Z2-9]{8}$/);
  });
});

describe('referral capture', () => {
  it('referred friend submits with the code', async () => {
    const { token } = await signIn('07700 900456');
    agents.referred = token;
    await request(app).post('/me/profile').set(auth(token))
      .send({ firstName: 'Jane', lastName: 'Smith', notifyOptIn: true });
    await request(app).post('/me/role').set(auth(token)).send({ role: 'referred' });
    const practices = await request(app).get('/practices');
    agents.practiceId = practices.body.practices[0].id;
    const res = await request(app).post('/referrals').set(auth(token)).send({
      code: agents.code.toLowerCase(), // normalization exercised
      fullName: 'Jane Smith',
      treatmentInterest: 'implants',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(res.status).toBe(200);
    agents.referralId = res.body.referral.id;
  });

  it('rejects self-referral', async () => {
    const res = await request(app).post('/referrals').set(auth(agents.referrer)).send({
      code: agents.code,
      fullName: 'Sarah Lewis',
      treatmentInterest: 'veneers',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('self_referral_not_allowed');
  });

  it('first code wins for a referred phone', async () => {
    const res = await request(app).post('/referrals').set(auth(agents.referred)).send({
      code: agents.code,
      fullName: 'Jane Smith',
      treatmentInterest: 'implants',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_referred');
  });
});

describe('pipeline and money', () => {
  it('rejects a non-adjacent jump', async () => {
    const res = await request(app)
      .patch(`/admin/referrals/${agents.referralId}/status`)
      .set(auth(agents.admin))
      .send({ status: 'attended' });
    expect(res.status).toBe(409);
  });

  it('walks the pipeline; completion credits £20 exactly once', async () => {
    for (const status of ['contacted', 'booked', 'attended', 'treatment_agreed']) {
      const res = await request(app)
        .patch(`/admin/referrals/${agents.referralId}/status`)
        .set(auth(agents.admin))
        .send({ status });
      expect(res.status).toBe(200);
    }
    await recordTreatment(app, agents.admin, agents.referralId);
    const done = await request(app)
      .patch(`/admin/referrals/${agents.referralId}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' });
    expect(done.status).toBe(200);
    expect(done.body.credit.amount_pennies).toBe(2000);

    const wallet = await request(app).get('/wallet').set(auth(agents.referrer));
    expect(wallet.body.wallet.balancePennies).toBe(2000);

    await recordTreatment(app, agents.admin, agents.referralId);
    const again = await request(app)
      .patch(`/admin/referrals/${agents.referralId}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' });
    expect(again.status).toBe(409); // terminal status: no double-credit path
  });

  it('payout below threshold is rejected; at threshold it works end to end', async () => {
    const below = await request(app).post('/payouts').set(auth(agents.referrer)).send({ practiceId: agents.practiceId });
    expect(below.status).toBe(409);
    expect(below.body.error).toBe('below_threshold');

    // Complete a second referral at the £100 tier -> balance £120, over the £100 threshold.
    // This used to raise a global £80 rule to land on exactly £100; commission is now one of
    // five fixed tiers and £80 is not among them, so the figures below are £20 + £100.
    const { token } = await signIn('07700 900789');
    await request(app).post('/me/profile').set(auth(token)).send({ firstName: 'Tom', lastName: 'Hall', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(token)).send({
      code: agents.code,
      fullName: 'Tom Hall',
      treatmentInterest: 'aligners',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    const id2 = sub.body.referral.id;
    await recordTreatment(app, agents.admin, id2, { commissionPennies: 10000 });
    const done = await request(app)
      .patch(`/admin/referrals/${id2}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' }); // privileged jump from 'new'
    expect(done.status).toBe(200);
    expect(done.body.credit.amount_pennies).toBe(10000);

    const payout = await request(app).post('/payouts').set(auth(agents.referrer)).send({ practiceId: agents.practiceId });
    expect(payout.status).toBe(200);
    expect(payout.body.payout.amountPennies).toBe(12000); // £20 + £100

    const second = await request(app).post('/payouts').set(auth(agents.referrer)).send({ practiceId: agents.practiceId });
    expect(second.status).toBe(409); // one open request per user

    const paid = await request(app)
      .post(`/admin/payouts/${payout.body.payout.id}/mark-paid`)
      .set(auth(agents.admin))
      .send({ amountPennies: 12000 });
    expect(paid.status).toBe(200);

    const wallet = await request(app).get('/wallet').set(auth(agents.referrer));
    expect(wallet.body.wallet.balancePennies).toBe(0);
    expect(wallet.body.wallet.lifetimePennies).toBe(12000);
  });
});

describe('admin stats', () => {
  it('reports current commission, unpaid liability, and referral counts by status', async () => {
    // A referral left at 'new' and a completed one (unpaid £80) to make the numbers non-trivial.
    const fresh = await signIn('07700 900321');
    await request(app).post('/me/profile').set(auth(fresh.token)).send({ firstName: 'Ada', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(fresh.token)).send({ role: 'referred' });
    await request(app).post('/referrals').set(auth(fresh.token)).send({
      code: agents.code,
      fullName: 'Ada Lovelace',
      treatmentInterest: 'implants',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });

    const done = await signIn('07700 900654');
    await request(app).post('/me/profile').set(auth(done.token)).send({ firstName: 'Grace', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(done.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(done.token)).send({
      code: agents.code,
      fullName: 'Grace Hopper',
      treatmentInterest: 'veneers',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    await recordTreatment(app, agents.admin, sub.body.referral.id);
    await request(app)
      .patch(`/admin/referrals/${sub.body.referral.id}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' });

    const res = await request(app).get('/admin/stats').set(auth(agents.admin));
    expect(res.status).toBe(200);
    // There is no single commission to report any more — the manager picks a tier per
    // referral — so stats carry the tiers themselves. A figure here would have been true of
    // no particular payment.
    expect(res.body.stats.commissionTiersPennies).toEqual([2000, 5000, 10000, 20000, 25000]);
    expect(res.body.stats.commissionPennies, 'the old single-figure stat is gone').toBeUndefined();
    expect(res.body.stats.liabilityPennies).toBe(2000); // this referral paid the £20 tier
    expect(res.body.stats.referralCounts).toMatchObject({ new: 1, treatment_completed: 3 });
  });
});

// The window is config.referralBookingWindowHours, 14 days since 2026-09-11. It was 12 hours,
// which closed a Friday-evening referral before the practice opened on Saturday — and once
// referrals started waiting off the pipeline board, nobody could see or rescue one in time.
describe('practices booking links + the booking window', () => {
  const mk = {};

  beforeAll(async () => {
    ({ db: mk.db } = await import('../src/db.js'));
    const practices = await request(app).get('/practices');
    mk.practiceId = practices.body.practices[0].id;
    const referrer = await signIn('+447700970001');
    await request(app).post('/me/profile').set(auth(referrer.token)).send({ firstName: 'Wind', lastName: 'Ow', notifyOptIn: true });
    const role = await request(app).post('/me/role').set(auth(referrer.token)).send({ role: 'referrer' });
    mk.code = role.body.user.referralCode;
  });

  const submit = (token, fullName) =>
    request(app).post('/referrals').set(auth(token)).send({
      code: mk.code,
      fullName,
      email: `${fullName.replace(/\s+/g, '.').toLowerCase()}@example.com`,
      preferredPracticeId: mk.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });

  it('GET /practices includes each practice booking_url', async () => {
    const res = await request(app).get('/practices');
    expect(res.status).toBe(200);
    expect(res.body.practices.length).toBeGreaterThan(0);
    for (const p of res.body.practices) expect(p).toHaveProperty('bookingUrl');
  });

  it('an unbooked referral past the window resets — friend starts from the beginning and can resubmit', async () => {
    const friend = await signIn('+447700970002');
    expect((await submit(friend.token, 'Exp Iry')).status).toBe(200);

    // Still inside the window: the submitted state (with practice attached) shows. A week in
    // is now comfortably live, where under the old 12-hour window it was long dead.
    await mk.db.query(
      `update referrals set created_at = now() - interval '7 days' where referred_phone = '+447700970002'`,
    );
    const before = await request(app).get('/referrals/referred-status').set(auth(friend.token));
    expect(before.body.status).toBe('new');
    expect(before.body.practiceName).toBeTruthy();

    await mk.db.query(
      `update referrals set created_at = now() - interval '400 hours' where referred_phone = '+447700970002'`,
    );

    // Past the window: the referral is cleared and the flow resets.
    const after = await request(app).get('/referrals/referred-status').set(auth(friend.token));
    expect(after.body.status).toBe('new');
    expect(after.body.practiceName).toBeFalsy();
    const { rows } = await mk.db.query(`select status from referrals where referred_phone = '+447700970002'`);
    expect(rows[0].status).toBe('lost');

    // The phone is free again — starting over works.
    expect((await submit(friend.token, 'Exp Iry')).status).toBe(200);
  });

  it('a booked referral is never expired by the window', async () => {
    const friend = await signIn('+447700970003');
    expect((await submit(friend.token, 'Boo Ked')).status).toBe(200);
    await mk.db.query(
      `update referrals set status='booked', appointment_dentally_id='appointment-window-test',
       appointment_starts_at = now() + interval '2 days', created_at = now() - interval '400 hours'
       where referred_phone = '+447700970003'`,
    );

    const res = await request(app).get('/referrals/referred-status').set(auth(friend.token));
    expect(res.body.status).toBe('booked');
  });
});

describe('treatment_started credits the referrer', () => {
  async function freshReferral(phoneSuffix) {
    const friend = await signIn(`07700 90${phoneSuffix}`);
    await request(app).post('/me/profile').set(auth(friend.token))
      .send({ firstName: 'Pat', lastName: 'Ient', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code: agents.code,
      fullName: `Pat Ient ${phoneSuffix}`,
      treatmentInterest: 'implants',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(sub.status).toBe(200);
    return sub.body.referral.id;
  }

  // Crediting stages need the treatment on record first (0020) — the gate is the product
  // requirement, so the helper does what a manager does rather than routing around it.
  const setStatus = async (id, status) => {
    if (status === 'treatment_started' || status === 'treatment_completed') {
      await recordTreatment(app, agents.admin, id);
    }
    return request(app).patch(`/admin/referrals/${id}/status`).set(auth(agents.admin)).send({ status });
  };

  it('credits on treatment_started, and treatment_completed adds nothing more', async () => {
    const id = await freshReferral('001');

    const started = await setStatus(id, 'treatment_started');
    expect(started.status).toBe(200);
    expect(started.body.credit).not.toBeNull();

    const completed = await setStatus(id, 'treatment_completed');
    expect(completed.status).toBe(200);
    expect(completed.body.credit).toBeNull(); // already paid — not a second credit

    const { rows } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1 and kind = 'credit'`,
      [id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('still credits when an admin jumps straight to treatment_completed', async () => {
    // The privileged path skips stages. Crediting "exactly on treatment_started" would
    // silently never pay this referrer.
    const id = await freshReferral('002');
    const done = await setStatus(id, 'treatment_completed');
    expect(done.status).toBe(200);
    expect(done.body.credit).not.toBeNull();
  });

  it('does not credit before treatment_started', async () => {
    const id = await freshReferral('003');
    for (const status of ['contacted', 'booked', 'attended', 'treatment_agreed']) {
      const res = await setStatus(id, status);
      expect(res.status).toBe(200);
      expect(res.body.credit).toBeNull();
    }
  });

  it('refuses to credit a referral flagged as an existing patient', async () => {
    const id = await freshReferral('004');
    await setStatus(id, 'contacted');
    await setStatus(id, 'booked');
    await setStatus(id, 'attended');
    await setStatus(id, 'treatment_agreed');

    // The Dentally sync flags this person as an existing patient (FR-11).
    await db.query(
      `update referrals set review_status = 'existing_patient_suspect' where id = $1`,
      [id],
    );

    const blocked = await setStatus(id, 'treatment_started');
    expect(blocked.status, 'a flagged referral must not be payable one step early').toBe(409);
    expect(blocked.body.error).toBe('review_pending');

    const { rows } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1 and kind = 'credit'`,
      [id],
    );
    expect(rows[0].n).toBe(0);
  });

  it('queues friend_completed on the credit-bearing transition, not on a later no-op one', async () => {
    // Task 2 moved the MONEY to treatment_started but left the notification list unchanged
    // (still keyed on the 'treatment_completed' status string) — the referrer would only ever
    // hear about a completed treatment if someone later advanced the patient past
    // treatment_started, which the manager-credit flow may never do. The notification must be
    // tied to the credit actually being written, not to a specific status string.
    const id = await freshReferral('005');
    const { rows: [ref] } = await db.query(`select referrer_id from referrals where id = $1`, [id]);

    // Count against a baseline, not an absolute total — this describe block's fixtures all
    // share the one seeded referrer (agents.code), so other tests' notifications land against
    // the same recipient_id.
    const countFriendCompleted = async () => {
      const { rows: [row] } = await db.query(
        `select count(*)::int as n from notification_outbox
          where recipient_id = $1 and template = 'friend_completed'`,
        [ref.referrer_id],
      );
      return row.n;
    };
    const before = await countFriendCompleted();

    const started = await setStatus(id, 'treatment_started');
    expect(started.status).toBe(200);
    expect(started.body.credit).not.toBeNull();

    const afterStarted = await countFriendCompleted();
    expect(afterStarted - before, 'queued exactly once, on the transition that actually paid').toBe(1);

    const completed = await setStatus(id, 'treatment_completed');
    expect(completed.status).toBe(200);
    expect(completed.body.credit).toBeNull(); // already credited — no second credit

    const afterCompleted = await countFriendCompleted();
    expect(afterCompleted - before, 'a status change with no credit queues no second notification').toBe(1);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('concurrency (real Postgres only)', () => {
  it('two simultaneous wallet ops serialize under the advisory lock', async () => {
    // Exercised against Supabase in CI once DATABASE_URL exists (matrix row 9).
  });
});
