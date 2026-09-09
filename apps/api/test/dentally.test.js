// Dentally sync + proposals (REQUIREMENTS §6 rows 11, 12, 13, 24, 26 + FR-05/16/17 paths).
// Runs on in-memory PGlite with the stub Dentally client — same shapes the live client emits.
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { patientSession } from './helpers/patient.js';

process.env.PGLITE_MEMORY = '1';

let app;
let authStub;
let db;
let runSync;
let stub;
const agents = {};

// Strictly increasing timestamps so cursor semantics are deterministic.
const base = Date.now();
let tick = 0;
const ts = () => new Date(base + ++tick * 1000).toISOString();
const past = (days) => new Date(base - days * 86_400_000).toISOString();

async function signIn(phone, email) {
  // Identity is email now; the phone is attached at the profile step. helpers/patient.js
  // walks the same two HTTP calls the mobile app makes. Pass `email` when the test needs the
  // Dentally contact to carry the same address — that pairing is what verification checks.
  return patientSession(app, authStub, { phone, email });
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

const submitReferral = (token, fullName, extra = {}) =>
  request(app).post('/referrals').set(auth(token)).send({
    code: agents.code,
    fullName,
    treatmentInterest: 'implants',
    preferredPracticeId: agents.practiceId,
    consent: true,
    consentVersion: 'referred-v1-2026-08',
    ...extra,
  });

beforeAll(async () => {
  // DENTALLY_* env goes through bootTestApp rather than module scope: config.js reads it
  // once at import, and anything left in process.env leaks into whichever suite runs next
  // in this vitest worker.
  ({ app, db, stub: authStub } = await bootTestApp({
    dentallyMode: 'stub',
    dentallyWebhookSecret: 'test-webhook-secret',
  }));
  ({ runSync } = await import('../src/services/dentally/syncService.js'));
  stub = await import('../src/services/dentally/client.js');
  // Dynamic import: a static one would pull in config.js (via adminService.js) before the
  // DENTALLY_* env vars above are set, since ES module imports are hoisted ahead of them.
  const { adminSession } = await import('./helpers/admin.js');
  agents.admin = (await adminSession(app)).token;

  const practices = await db.query(`select id from practices order by name limit 1`);
  agents.practiceId = practices.rows[0].id;
});

describe('anyone can refer — no referrer verification (2026-09-09)', () => {
  // The old FR-05 rule was that a referrer had to be an existing GM Dental patient, proved by
  // matching their phone against Dentally, with an admin queue for anything that did not
  // match cleanly. That is not the product: you download the app, you sign up, you refer.
  //
  // Worth remembering why removing it cost nothing in enforcement: verification never gated
  // earning. An unverified referrer submitted referrals, earned credits and took payouts
  // exactly like a verified one. The only real control was an admin manually rejecting
  // someone, which deactivated their code.
  //
  // The Dentally check that matters is on the REFERRED person — asserted throughout FR-16
  // below, where their phone confirms the booking and the treatment.

  it('a referrer with NO Dentally record at all gets a working code immediately', async () => {
    // Nothing added to the stub for this phone: they are not a patient here, and it does not
    // matter. This is the case the old rule sent to a review queue.
    const { token, user } = await signIn('+447700910001', 'not.a.patient@example.com');
    const role = await request(app).post('/me/role').set(auth(token)).send({ role: 'referrer' });

    expect(role.status).toBe(200);
    expect(role.body.user.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(role.body.user.roles).toContain('referrer');
    // No verification state is exposed to the app at all any more.
    expect(role.body.user).not.toHaveProperty('verificationStatus');

    agents.referrer = token;
    agents.code = role.body.user.referralCode;
    agents.referrerId = user.id;
  });

  it('picking the referrer role twice keeps the same code', async () => {
    const again = await request(app).post('/me/role').set(auth(agents.referrer)).send({ role: 'referrer' });
    expect(again.body.user.referralCode).toBe(agents.code);
  });

  it('the admin verification queue is gone, not merely empty', async () => {
    // Deleted rather than left returning []: a queue nobody works is worse than no queue,
    // because it looks like a control that exists.
    const res = await request(app).get('/admin/verifications').set(auth(agents.admin));
    expect(res.status).toBe(404);
  });

  it('the sync no longer reports verification work', async () => {
    const out = await runSync('test');
    expect(out.verificationsResolved).toBeUndefined();
  });
});

describe('FR-16 sync worker: eligibility, idempotency, cursor', () => {
  it('referred friend submits; a treatment completed BEFORE submission is ineligible (row 12)', async () => {
    const { token } = await signIn('+447700910010');
    await request(app).post('/me/role').set(auth(token)).send({ role: 'referred' });
    const sub = await submitReferral(token, 'Jane Smith');
    expect(sub.status).toBe(200);
    agents.referralId = sub.body.referral.id;

    stub.stubAddCompletedTreatment({ phone: '+447700910010', completedAt: past(1), updatedAt: ts() });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(0);
    const { rows } = await db.query(`select count(*)::int as n from completion_proposals`);
    expect(rows[0].n).toBe(0);
  });

  it('a treatment completed after submission proposes exactly once (idempotent event id)', async () => {
    stub.stubAddCompletedTreatment({ phone: '+447700910010', completedAt: ts(), updatedAt: ts(), siteId: agents.practiceId });
    await db.query(`update practices set dentally_site_id=$1 where id=$1::uuid`, [agents.practiceId]);
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(1);

    // Re-running never duplicates (cursor skips it; even a full re-scan hits the unique event id).
    const again = await runSync('test');
    expect(again.proposalsCreated).toBe(0);
    const { rows } = await db.query(`select * from completion_proposals where referral_id=$1`, [agents.referralId]);
    expect(rows.length).toBe(1);
    expect(rows[0].treating_practice_id).toBe(agents.practiceId);
    agents.proposalId = rows[0].id;
  });

  it('a second Dentally event for the same still-open referral proposes too (both can propose)', async () => {
    stub.stubAddCompletedTreatment({ phone: '+447700910010', completedAt: ts(), updatedAt: ts() });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(1);
    const { rows } = await db.query(
      `select id from completion_proposals where referral_id=$1 and id<>$2`,
      [agents.referralId, agents.proposalId],
    );
    agents.secondProposalId = rows[0].id;
  });

  it('row 11: the cursor persists and appointments older than the watermark are not re-scanned', async () => {
    const { rows } = await db.query(`select watermark from sync_state where key='dentally_appointments'`);
    expect(rows[0]).toBeDefined();

    // updatedAt far in the past: a completed+paid treatment the cursor has already passed.
    stub.stubAddCompletedTreatment({ phone: '+447700910010', completedAt: ts(), updatedAt: past(2) });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(0);
  });

  it('completed but UNPAID does not propose', async () => {
    const { token } = await signIn('+447700910011');
    await request(app).post('/me/role').set(auth(token)).send({ role: 'referred' });
    const sub = await submitReferral(token, 'Una Paid');
    agents.unpaidReferralId = sub.body.referral.id;

    stub.stubAddCompletedTreatment({ phone: '+447700910011', completedAt: ts(), updatedAt: ts(), paid: false });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(0);
  });
});

describe('FR-17 proposal confirm/reject', () => {
  it('confirm is blocked while the referral is under existing-patient review (row 26)', async () => {
    await db.query(`update referrals set review_status='existing_patient_suspect' where id=$1`, [agents.referralId]);
    const res = await request(app).post(`/admin/proposals/${agents.proposalId}/confirm`).set(auth(agents.admin));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('review_pending');
    await db.query(`update referrals set review_status='cleared' where id=$1`, [agents.referralId]);
  });

  it('one click: proposal confirmed + referral completed + £20 credited, atomically', async () => {
    const queue = await request(app).get('/admin/proposals').set(auth(agents.admin));
    expect(queue.body.proposals.map((p) => p.id)).toContain(agents.proposalId);

    const res = await request(app).post(`/admin/proposals/${agents.proposalId}/confirm`).set(auth(agents.admin));
    expect(res.status).toBe(200);
    expect(res.body.credit.amountPennies).toBe(2000);

    const { rows: ref } = await db.query(`select status from referrals where id=$1`, [agents.referralId]);
    expect(ref[0].status).toBe('treatment_completed');
    const wallet = await request(app).get('/wallet').set(auth(agents.referrer));
    expect(wallet.body.wallet.balancePennies).toBe(2000);

    const again = await request(app).post(`/admin/proposals/${agents.proposalId}/confirm`).set(auth(agents.admin));
    expect(again.status).toBe(409); // double-click safe
  });

  it('row 26: the second proposal for the same referral can never double-credit', async () => {
    const res = await request(app).post(`/admin/proposals/${agents.secondProposalId}/confirm`).set(auth(agents.admin));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_credited');

    const noReason = await request(app).post(`/admin/proposals/${agents.secondProposalId}/reject`).set(auth(agents.admin)).send({});
    expect(noReason.status).toBe(422);
    const rejected = await request(app)
      .post(`/admin/proposals/${agents.secondProposalId}/reject`)
      .set(auth(agents.admin))
      .send({ reason: 'duplicate event — already credited' });
    expect(rejected.status).toBe(200);

    const wallet = await request(app).get('/wallet').set(auth(agents.referrer));
    expect(wallet.body.wallet.balancePennies).toBe(2000); // unchanged
  });
});

describe('FR-25 aging report (row 13)', () => {
  it('a referral stuck at booked with no proposal appears after N days, and clears once proposed', async () => {
    for (const status of ['contacted', 'booked']) {
      await request(app)
        .patch(`/admin/referrals/${agents.unpaidReferralId}/status`)
        .set(auth(agents.admin))
        .send({ status });
    }
    // Backdate the status-change trail 10 days.
    await db.query(
      `update events set created_at = now() - interval '10 days'
       where entity_type='referral' and entity_id=$1`,
      [agents.unpaidReferralId],
    );

    const aging = await request(app).get('/admin/aging?days=7').set(auth(agents.admin));
    const row = aging.body.aging.find((a) => a.id === agents.unpaidReferralId);
    expect(row).toBeDefined();
    expect(row.days_waiting).toBeGreaterThanOrEqual(10);

    // The friend finally pays; the sync proposes; the aging row disappears.
    stub.stubAddCompletedTreatment({ phone: '+447700910011', completedAt: ts(), updatedAt: ts() });
    await runSync('test');
    const after = await request(app).get('/admin/aging?days=7').set(auth(agents.admin));
    expect(after.body.aging.find((a) => a.id === agents.unpaidReferralId)).toBeUndefined();
  });
});

describe('POST /webhooks/dentally', () => {
  const body = JSON.stringify({ event: 'appointment.updated', object: 'appointment', data: { id: 1 } });

  it('accepts a correctly signed payload with 204', async () => {
    const signature = crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');
    const res = await request(app)
      .post('/webhooks/dentally')
      .set('Content-Type', 'application/json')
      .set('X-Dentally-Signature', signature)
      .send(body);
    expect(res.status).toBe(204);
  });

  it('rejects a bad signature with 401', async () => {
    const res = await request(app)
      .post('/webhooks/dentally')
      .set('Content-Type', 'application/json')
      .set('X-Dentally-Signature', 'deadbeef')
      .send(body);
    expect(res.status).toBe(401);
  });
});

describe('booking-first flow: the Dentally appointment confirms the referral', () => {
  it('a future appointment for the referred phone moves the referral to booked with its time', async () => {
    const referrer = await signIn('+447700930001');
    await request(app).post('/me/profile').set(auth(referrer.token)).send({ firstName: 'Rita', lastName: 'Referrer', notifyOptIn: true });
    const role = await request(app).post('/me/role').set(auth(referrer.token)).send({ role: 'referrer' });
    const code = role.body.user.referralCode;

    // The friend leaves contact details (email captured, no interest question).
    const friend = await signIn('+447700930002');
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code,
      fullName: 'Fred Friend',
      email: 'fred@example.com',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(sub.status).toBe(200);

    // They book on the practice's Dentally page → the appointment reaches the sync feed.
    const startsAt = new Date(base + 5 * 86_400_000).toISOString();
    stub.stubAddBookedAppointment({ phone: '+447700930002', startsAt, updatedAt: ts() });
    const summary = await runSync('test');
    expect(summary.bookingsDetected).toBe(1);

    const status = await request(app).get('/referrals/referred-status').set(auth(friend.token));
    expect(status.body.status).toBe('booked');
    expect(new Date(status.body.appointmentStartsAt).toISOString()).toBe(startsAt);

    const { rows } = await db.query(
      `select referred_email, appointment_dentally_id from referrals where referred_phone='+447700930002'`,
    );
    expect(rows[0].referred_email).toBe('fred@example.com');
    expect(rows[0].appointment_dentally_id).toMatch(/^appointment-/);
  });
});

describe('email fallback: Dentally records under a different phone still match the referral', () => {
  const makeReferral = async (referrerPhone, friendPhone, fullName, email) => {
    const referrer = await signIn(referrerPhone);
    await request(app).post('/me/profile').set(auth(referrer.token)).send({ firstName: 'Ravi', lastName: 'Referrer', notifyOptIn: true });
    const role = await request(app).post('/me/role').set(auth(referrer.token)).send({ role: 'referrer' });
    const friend = await signIn(friendPhone);
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code: role.body.user.referralCode,
      fullName,
      email,
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(sub.status).toBe(200);
    return friend;
  };

  it('a booking under a different phone but the referral email confirms the booking', async () => {
    const friend = await makeReferral('+447700940001', '+447700940002', 'Gita Friend', 'gita@example.com');

    // Dentally holds them under a non-UK number; only the email (case differs) lines up.
    const startsAt = new Date(base + 6 * 86_400_000).toISOString();
    stub.stubAddBookedAppointment({ phone: '+917204108703', email: 'Gita@Example.com', startsAt, updatedAt: ts() });
    const summary = await runSync('test');
    expect(summary.bookingsDetected).toBe(1);

    const status = await request(app).get('/referrals/referred-status').set(auth(friend.token));
    expect(status.body.status).toBe('booked');
    expect(new Date(status.body.appointmentStartsAt).toISOString()).toBe(startsAt);
  });

  it('a completed paid treatment under a different phone but the referral email proposes', async () => {
    await makeReferral('+447700940003', '+447700940004', 'Hema Friend', 'hema@example.com');

    stub.stubAddCompletedTreatment({ phone: '+919900112233', email: 'hema@example.com', completedAt: ts(), updatedAt: ts() });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(1);
    const { rows } = await db.query(
      `select cp.id from completion_proposals cp join referrals r on r.id = cp.referral_id
       where r.referred_phone = '+447700940004'`,
    );
    expect(rows.length).toBe(1);
  });

  it('a booking with neither phone nor email matching stays unmatched', async () => {
    await makeReferral('+447700940005', '+447700940006', 'Nina Friend', 'nina@example.com');

    stub.stubAddBookedAppointment({ phone: '+917204100000', email: 'someone.else@example.com', startsAt: new Date(base + 7 * 86_400_000).toISOString(), updatedAt: ts() });
    const summary = await runSync('test');
    expect(summary.bookingsDetected).toBe(0);

    const { rows } = await db.query(`select status from referrals where referred_phone='+447700940006'`);
    expect(rows[0].status).toBe('new');
  });
});

// Deliberately LAST in this file. These tests create referrals and completed treatments, and
// the FR-16 / FR-25 blocks above assert counts over completion_proposals and the aging report.
// Run earlier, this block leaves proposals behind and those assertions fail — which is a test
// isolation problem, not a product one, but it is easier to order the file than to scope every
// count above to its own referral.
describe('FR-11 the referred person must be NEW (2026-09-09)', () => {
  // The rule: the REFERRER can be anyone — no verification, that is the product. The REFERRED
  // person must be genuinely new, meaning no COMPLETED appointment in Dental OS before the
  // referral was submitted. Existing patient => no commission, ever.
  //
  // This mattered more than it looked. Nothing in the codebase ever SET
  // existing_patient_suspect — it was read in three places and written in none, so FR-11 was
  // never actually implemented. Measured against real Dental OS data: ~63% of people attending
  // in a quarter had been treated before, so most commission would have gone on patients who
  // were already the practice's.

  it('flags a referred person who was ALREADY a patient, which blocks the credit', async () => {
    // Treated here a year before anyone referred them.
    stub.stubAddCompletedTreatment({ phone: '+447700950001', completedAt: past(365), updatedAt: ts() });
    await runSync('test');

    const sub = await submitReferral(agents.referrer, 'Old Patient', { phone: '+447700950001' });
    expect(sub.status).toBe(200);

    const out = await runSync('test');
    expect(out.existingPatientsFlagged).toBeGreaterThanOrEqual(1);

    const { rows } = await db.query(`select review_status from referrals where id=$1`, [sub.body.referral.id]);
    expect(rows[0].review_status).toBe('existing_patient_suspect');
  });

  it('leaves a genuinely new person alone', async () => {
    const sub = await submitReferral(agents.referrer, 'Brand New', { phone: '+447700950002' });
    await runSync('test');
    const { rows } = await db.query(`select review_status from referrals where id=$1`, [sub.body.referral.id]);
    expect(rows[0].review_status).toBeNull();
  });

  it('a treatment AFTER the referral does not make them an existing patient', async () => {
    // The whole point: they were new when referred, then got treated. That is the happy path,
    // not a flag. Comparing against the wrong side of the referral date breaks every referral.
    const sub = await submitReferral(agents.referrer, 'New Then Treated', { phone: '+447700950003' });
    stub.stubAddCompletedTreatment({ phone: '+447700950003', completedAt: ts(), updatedAt: ts() });
    await runSync('test');
    const { rows } = await db.query(`select review_status from referrals where id=$1`, [sub.body.referral.id]);
    expect(rows[0].review_status).toBeNull();
  });

  it('matches on EMAIL too, not just phone', async () => {
    // The referred person self-declares their number; the practice may hold them under a
    // different one but the same address.
    stub.stubAddCompletedTreatment({
      phone: '+447700959999', email: 'known@example.com', completedAt: past(200), updatedAt: ts(),
    });
    await runSync('test');

    const sub = await submitReferral(agents.referrer, 'Email Match', {
      phone: '+447700950004', email: 'known@example.com',
    });
    expect(sub.status).toBe(200);

    await runSync('test');
    const { rows } = await db.query(`select review_status from referrals where id=$1`, [sub.body.referral.id]);
    expect(rows[0].review_status).toBe('existing_patient_suspect');
  });

  // No "and it still credits normally" test here: it would leave a proposal behind and the
  // FR-16 block below asserts an empty completion_proposals table. FR-16 proves the happy
  // path anyway, and it now runs WITH flagExistingPatients active — so if this check broke
  // crediting, those tests would fail.
});
