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

/**
 * A referral (attributed to the shared agents.referrer/agents.code, same as every other
 * fixture in this file) ready to be completed in Dentally. Submitted via agents.referrer's own
 * token with a phone override — the established pattern here (see "New Then Treated" /
 * "Domestic Format" above) since POST /referrals only requires an authenticated user, not a
 * "referred"-role account matching the phone.
 */
async function referredFriendReadyToComplete(friendPhone) {
  const sub = await submitReferral(agents.referrer, 'Safety Net', { phone: friendPhone });
  expect(sub.status, 'referral submission for the safety-net fixture').toBe(200);
  const { rows } = await db.query(`select referred_phone from referrals where id=$1`, [sub.body.referral.id]);
  return { referralId: sub.body.referral.id, friendPhone: rows[0].referred_phone };
}

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

  it('row 26: the second proposal for the same referral resolves cleanly and can never double-credit', async () => {
    // Task 7: confirming a proposal for an already-credited referral no longer 409s. It
    // resolves cleanly — the proposal is marked confirmed with no second ledger row — since
    // that IS the outcome a duplicate Dentally event's proposal exists to produce.
    const res = await request(app).post(`/admin/proposals/${agents.secondProposalId}/confirm`).set(auth(agents.admin));
    expect(res.status).toBe(200);
    expect(res.body.alreadyCredited).toBe(true);
    expect(res.body.credit).toBeNull();

    // Already resolved (confirmed), not left open for a reject.
    const rejected = await request(app)
      .post(`/admin/proposals/${agents.secondProposalId}/reject`)
      .set(auth(agents.admin))
      .send({ reason: 'duplicate event — already credited' });
    expect(rejected.status).toBe(409);
    expect(rejected.body.error).toBe('proposal_not_open');

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

describe('the aging report watches treatment_started, but not once paid', () => {
  // Backdate the last status-change trail (and the referral's own created_at) so a referral
  // reads as past the default 7-day aging window.
  async function backdate(referralId) {
    await db.query(
      `update events set created_at = now() - interval '30 days'
        where entity_type = 'referral' and entity_id = $1`,
      [String(referralId)],
    );
    await db.query(`update referrals set created_at = now() - interval '30 days' where id = $1`,
      [referralId]);
  }

  it('a referral credited at treatment_started does NOT appear — nothing is owed, so nothing to chase', async () => {
    // A dedicated referral, not `where status = 'treatment_started' limit 1`: agingReport
    // excludes any referral with a completion_proposals row, and other tests in this file
    // create exactly those, so an arbitrary pick risks landing on an excluded row and failing
    // for an unrelated reason.
    const { referralId } = await referredFriendReadyToComplete('07700 904004');

    // The admin route always sets privilegedComplete, so this jumps straight from 'new' to
    // 'treatment_started' — which also credits the referrer (regression guard for the bug this
    // block exists to catch: scanCompletions skips filing a proposal for an already-credited
    // referral, so `not exists (completion_proposals)` alone would keep this row forever).
    const started = await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin)).send({ status: 'treatment_started' });
    expect(started.status).toBe(200);
    expect(started.body.credit, 'sanity check — this referral must actually be credited').toBeTruthy();

    await backdate(referralId);

    const res = await request(app).get('/admin/aging').set(auth(agents.admin));
    expect(res.status).toBe(200);
    expect(res.body.aging.map((a) => a.id)).not.toContain(referralId);
  });

  it('an uncredited referral aging at booked still appears — the fix must not gut the report', async () => {
    const { token } = await signIn('+447700904006');
    await request(app).post('/me/role').set(auth(token)).send({ role: 'referred' });
    const sub = await submitReferral(token, 'Aging Booked');
    expect(sub.status).toBe(200);
    const referralId = sub.body.referral.id;

    const booked = await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin)).send({ status: 'contacted' });
    expect(booked.status).toBe(200);
    const toBooked = await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin)).send({ status: 'booked' });
    expect(toBooked.status).toBe(200);

    await backdate(referralId);

    const res = await request(app).get('/admin/aging').set(auth(agents.admin));
    expect(res.status).toBe(200);
    expect(res.body.aging.map((a) => a.id)).toContain(referralId);
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

  it('matches a contact stored in DOMESTIC phone format, not just E.164', async () => {
    // Dental OS stores contacts.phone inconsistently: measured 2026-09-09, 21,337 rows are
    // E.164 and 16,151 are UK domestic (0...). An earlier version of hasPriorTreatment
    // compared our E.164 value against the raw column and therefore missed 45% of contacts —
    // and a miss reads as "this person is new", so an existing patient would be credited.
    // Matching on the last 10 digits (Dental OS keeps a phone10 column for exactly this) is
    // what makes the formats irrelevant.
    stub.stubAddCompletedTreatment({ phone: '07700950010', completedAt: past(300), updatedAt: ts() });
    await runSync('test');

    // The referral carries the number in E.164, the way our app normalises it.
    const sub = await submitReferral(agents.referrer, 'Domestic Format', { phone: '+447700950010' });
    expect(sub.status).toBe(200);

    await runSync('test');
    const { rows } = await db.query(`select review_status from referrals where id=$1`, [sub.body.referral.id]);
    expect(rows[0].review_status).toBe('existing_patient_suspect');
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

describe('clawback: commission reversed when the payment is refunded', () => {
  // Dental OS emits no refund event — a reversed payment just becomes an invoice that is no
  // longer paid. So the sync re-asks the question that justified the credit and notices the
  // answer changed. This was the largest uncapped money hole: credit issued, treatment
  // refunded, £20 gone with nothing recording it.

  let referralId;
  let referrerId;

  it('credits normally first', async () => {
    const ref = await patientSession(app, authStub, { phone: '+447700960001' });
    await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });
    const code = (await request(app).get('/me').set(auth(ref.token))).body.user.referralCode;
    referrerId = ref.user.id;

    const friend = await patientSession(app, authStub, { phone: '+447700960002' });
    await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code, fullName: 'Refund Case', treatmentInterest: 'implants',
      preferredPracticeId: agents.practiceId, consent: true, consentVersion: 'referred-v1-2026-08',
      phone: '+447700960003',
    });
    expect(sub.status).toBe(200);
    referralId = sub.body.referral.id;

    stub.stubAddCompletedTreatment({ phone: '+447700960003', completedAt: ts(), updatedAt: ts() });
    await runSync('test');

    const proposals = await request(app).get('/admin/proposals').set(auth(agents.admin));
    const p = proposals.body.proposals.find((x) => x.referral_id === referralId);
    expect(p).toBeDefined();
    const confirmed = await request(app).post(`/admin/proposals/${p.id}/confirm`).set(auth(agents.admin));
    expect(confirmed.status).toBe(200);

    const { rows } = await db.query(
      `select coalesce(sum(amount_pennies),0)::int as bal from wallet_ledger where user_id=$1`, [referrerId]);
    expect(rows[0].bal).toBeGreaterThan(0);
  });

  it('reverses the credit once the payment is no longer paid', async () => {
    const { rows: before } = await db.query(
      `select coalesce(sum(amount_pennies),0)::int as bal from wallet_ledger where user_id=$1`, [referrerId]);

    stub.stubRefundInvoices({ phone: '+447700960003' });
    const out = await runSync('test');
    expect(out.clawedBack).toBe(1);

    const { rows: after } = await db.query(
      `select coalesce(sum(amount_pennies),0)::int as bal from wallet_ledger where user_id=$1`, [referrerId]);
    expect(after[0].bal).toBe(0);
    expect(before[0].bal).toBeGreaterThan(after[0].bal);
  });

  it('leaves the original credit intact — the ledger is append-only', async () => {
    const { rows } = await db.query(
      `select kind, amount_pennies from wallet_ledger where referral_id=$1 order by created_at`, [referralId]);
    expect(rows.map((r) => r.kind)).toEqual(['credit', 'adjustment']);
    expect(rows[0].amount_pennies).toBeGreaterThan(0);
    expect(rows[1].amount_pennies).toBe(-rows[0].amount_pennies);
  });

  it('never claws back twice, however many times the sync runs', async () => {
    await runSync('test');
    await runSync('test');
    const { rows } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id=$1 and kind='adjustment'`, [referralId]);
    expect(rows[0].n).toBe(1);
  });

  it('does NOT claw back when the check cannot run', async () => {
    // hasQualifyingPaidInvoice returns null on the live REST path. Treating that as a refund
    // would take money off referrers because Dentally was briefly unreachable.
    const { clawbackReferralCredit } = await import('../src/services/walletService.js');
    const alreadyDone = await clawbackReferralCredit(referralId, 'second attempt');
    expect(alreadyDone).toBeNull();
  });
});

describe('booking re-attributes the lead to the practice it happened at', () => {
  it('sets booked_practice_id and moves the lead into that practice scope', async () => {
    const practices = (await request(app).get('/practices')).body.practices;
    const formPractice = practices[0];
    const bookedPractice = practices[1];

    // A referral whose form said formPractice.
    const ref = await signIn('+447700903001');
    await request(app).post('/me/profile').set(auth(ref.token))
      .send({ firstName: 'Reattrib', lastName: 'Referrer', notifyOptIn: false });
    const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });

    const friendPhone = '+447700903002';
    const friend = await signIn(friendPhone);
    await request(app).post('/me/profile').set(auth(friend.token))
      .send({ firstName: 'Reattrib', lastName: 'Friend', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
      code: role.body.user.referralCode,
      fullName: 'Reattrib Friend',
      treatmentInterest: 'implants',
      preferredPracticeId: formPractice.id,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    expect(sub.status).toBe(200);
    const referralId = sub.body.referral.id;

    // In stub mode a practice's dentally_site_id is its own uuid, so booking "at" bookedPractice
    // means pointing the stub site id at that practice — the same write
    // /dev/dentally/book-appointment does for practiceId. updatedAt uses the file's synthetic
    // ts() clock, not wall time: by this point in the suite the cursor watermark has already
    // been advanced past real "now" by earlier tests' ts() calls, so a real-time timestamp here
    // would be seen as stale and silently skipped by drainPages.
    await db.query(`update practices set dentally_site_id=$1 where id=$1::uuid`, [bookedPractice.id]);
    stub.stubAddBookedAppointment({
      phone: friendPhone,
      siteId: bookedPractice.id,
      startsAt: new Date(base + 7 * 86_400_000).toISOString(),
      updatedAt: ts(),
    });
    const summary = await runSync('test');
    expect(summary.bookingsDetected).toBe(1);

    const { rows } = await db.query(
      `select status, booked_practice_id, preferred_practice_id from referrals where id = $1`,
      [referralId],
    );
    expect(rows[0].status).toBe('booked');
    expect(rows[0].booked_practice_id).toBe(bookedPractice.id);
    // The form's choice is retained, not overwritten — a commission dispute needs it.
    expect(rows[0].preferred_practice_id).toBe(formPractice.id);

    const { rows: events } = await db.query(
      `select action, from_value, to_value from events
        where entity_type = 'referral' and entity_id = $1 and action = 'practice_reassigned'`,
      [referralId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].from_value).toBe(formPractice.id);
    expect(events[0].to_value).toBe(bookedPractice.id);
  });
});

describe('confirmProposal resolves the reward-rule practice via booked_practice_id, not just the form choice', () => {
  it('a practice-scoped rule at the booked practice wins over the global rule when treating_practice_id is unset', async () => {
    const practices = (await request(app).get('/practices')).body.practices;
    const practiceA = practices[0]; // the form's original choice (preferred_practice_id)
    const practiceB = practices[1]; // where the patient actually booked (booked_practice_id)

    // A rule for B distinct from the £20 global rule (seeded in 0002_seed_dev.sql) — if
    // confirmProposal fell through to preferred_practice_id (A, which has no scoped rule) it
    // would resolve the global £20 rule instead, not this one.
    await db.query(
      `insert into reward_rules (practice_id, type, amount_pennies, created_by)
       values ($1,'fixed',3500,'test')`,
      [practiceB.id],
    );

    const sub = await submitReferral(agents.referrer, 'Precedence Check', {
      phone: '07700 904003', preferredPracticeId: practiceA.id,
    });
    expect(sub.status).toBe(200);
    const referralId = sub.body.referral.id;
    await db.query(`update referrals set booked_practice_id=$2 where id=$1`, [referralId, practiceB.id]);

    // No siteId — the resulting completion_proposals row gets treating_practice_id NULL
    // (practiceIdForSite(null) short-circuits to null), so the only way to reach B's rule is
    // via booked_practice_id.
    const { rows: [{ referred_phone: friendPhone }] } = await db.query(
      `select referred_phone from referrals where id=$1`, [referralId],
    );
    stub.stubAddCompletedTreatment({ phone: friendPhone, amountPennies: 52000, completedAt: ts(), updatedAt: ts() });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(1);

    const { rows: [proposal] } = await db.query(
      `select id, treating_practice_id from completion_proposals where referral_id = $1`,
      [referralId],
    );
    expect(proposal.treating_practice_id).toBeNull();

    const confirm = await request(app).post(`/admin/proposals/${proposal.id}/confirm`).set(auth(agents.admin));
    expect(confirm.status).toBe(200);
    expect(confirm.body.credit.amountPennies, 'booked_practice_id must be consulted before preferred_practice_id').toBe(3500);
  });
});

describe('the poller is a safety net, not a second payer', () => {
  // Managers can now credit directly (treatment_started, privileged). The poller must not
  // compete with that path: no proposal for work that is already settled, and confirming a
  // stale proposal for settled work must resolve cleanly rather than 409.
  //
  // Fixtures here call stub.stubAddCompletedTreatment directly (not the /dev/dentally/... dev
  // endpoint) with completedAt/updatedAt from this file's ts() clock, not the endpoint's
  // real-wall-clock default — by this point in the suite the APPTS_CURSOR watermark, advanced
  // entirely off ts() calls, sits ahead of real "now", so a real-time fixture would be
  // silently filtered out by drainPages' `updatedAt > watermark` check and never seen.

  it('files no proposal for a referral a manager already credited', async () => {
    const { referralId, friendPhone } = await referredFriendReadyToComplete('07700 904001');

    const started = await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin)).send({ status: 'treatment_started' });
    expect(started.status).toBe(200);

    stub.stubAddCompletedTreatment({
      phone: friendPhone, siteId: agents.practiceId, amountPennies: 52000, completedAt: ts(), updatedAt: ts(),
    });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(0);

    const { rows } = await db.query(
      `select count(*)::int as n from completion_proposals where referral_id = $1`,
      [referralId],
    );
    expect(rows[0].n, 'a credited referral is done — the owner needs no chore for it').toBe(0);
  });

  it('resolves an open proposal cleanly when a manager credits first', async () => {
    const { referralId, friendPhone } = await referredFriendReadyToComplete('07700 904002');

    // Proposal filed first...
    stub.stubAddCompletedTreatment({
      phone: friendPhone, siteId: agents.practiceId, amountPennies: 52000, completedAt: ts(), updatedAt: ts(),
    });
    const sync = await runSync('test');
    expect(sync.proposalsCreated).toBe(1);
    const { rows: [proposal] } = await db.query(
      `select id from completion_proposals where referral_id = $1 and status = 'open'`,
      [referralId],
    );
    expect(proposal).toBeDefined();

    // ...then a manager credits before anyone clicks it.
    const startedAgain = await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin)).send({ status: 'treatment_started' });
    expect(startedAgain.status).toBe(200);

    const confirm = await request(app)
      .post(`/admin/proposals/${proposal.id}/confirm`).set(auth(agents.admin));
    expect(confirm.status, 'must not 409 — the outcome the poller wanted already happened').toBe(200);
    expect(confirm.body.alreadyCredited).toBe(true);
    expect(confirm.body.credit).toBeNull();

    const { rows: credits } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id = $1 and kind = 'credit'`,
      [referralId],
    );
    expect(credits[0].n).toBe(1);

    const { rows: [ref] } = await db.query(`select status from referrals where id = $1`, [referralId]);
    expect(ref.status).toBe('treatment_completed');
  });
});

describe('FIX 1: clawback must not reverse a manager-issued credit (no confirmed proposal)', () => {
  // The bug: clawbackRefunded used to run over EVERY credited referral, on the invariant that a
  // credit could only exist after confirmProposal — which itself required a paid invoice to
  // exist. The manager path breaks that invariant: a manager credits at treatment_started with
  // NO invoice in Dentally at all yet, so "is there a paid invoice?" legitimately (and, in the
  // deployed dentalos/stub modes, non-null-ly) answers false — indistinguishable from a genuine
  // refund. Without the fix, this credit gets clawed back on the very next sync pass, and because
  // the credit row survives and wallet_ledger_one_credit_per_referral is unconditional, the
  // referral could then never be credited again.
  it('a manager credit with no paid invoice anywhere in Dentally survives a sync pass', async () => {
    const { referralId, friendPhone: _friendPhone } = await referredFriendReadyToComplete('07700 904005');

    // Credit at treatment_started — deliberately with NOTHING added to the stub for this phone,
    // so hasQualifyingPaidInvoice finds no matching patient/invoice at all and answers `false`,
    // not null. That `false` is exactly what a real refund would also produce; only the (missing)
    // confirmed completion_proposals row tells them apart.
    const started = await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin)).send({ status: 'treatment_started' });
    expect(started.status).toBe(200);
    expect(started.body.credit, 'sanity check — this referral must actually be credited').toBeTruthy();

    const { rows: referralRow } = await db.query(`select referrer_id from referrals where id=$1`, [referralId]);
    const referrerId = referralRow[0].referrer_id;

    const { rows: before } = await db.query(
      `select coalesce(sum(amount_pennies),0)::int as bal from wallet_ledger where user_id=$1`, [referrerId]);
    expect(before[0].bal).toBeGreaterThan(0);

    const sync = await runSync('test');
    expect(sync.clawedBack, 'this MUST be 0 — there was never an invoice to reverse').toBe(0);

    const { rows: after } = await db.query(
      `select coalesce(sum(amount_pennies),0)::int as bal from wallet_ledger where user_id=$1`, [referrerId]);
    expect(after[0].bal).toBe(before[0].bal);

    const { rows: adjustments } = await db.query(
      `select count(*)::int as n from wallet_ledger where referral_id=$1 and kind='adjustment'`, [referralId]);
    expect(adjustments[0].n).toBe(0);

    // Belt and braces: confirm there really is no confirmed proposal backing this credit — that
    // absence is the entire basis for the fix.
    const { rows: proposals } = await db.query(
      `select count(*)::int as n from completion_proposals where referral_id=$1 and status='confirmed'`,
      [referralId],
    );
    expect(proposals[0].n).toBe(0);
  });
});
