// The existing-patient decision writes TWO things that must land together: the referral goes
// to 'lost', and the commission it already released is clawed back.
//
// Its own guard is what makes a half-applied pair unrecoverable. Once status is 'lost', the
// decision endpoint answers 409 not_in_review to every retry — so a version that committed the
// status first and then clawed back had no way to reverse the credit if the clawback failed.
// The money stayed with the referrer for a patient the owner had just confirmed was already
// theirs, and no amount of clicking could fix it.
//
// Proving that needs a clawback that fails on demand, which is the whole reason this lives in
// its own file: the module mock below is file-wide, and no other suite should run under it.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.PGLITE_MEMORY = '1';

// Hoisted so the vi.mock factory (which is itself hoisted above the imports) can close over it.
const fault = vi.hoisted(() => ({ failNextClawback: false }));

// A pass-through wrapper, not a stub: every call runs the real implementation, so the success
// path under test is the genuine one. Only a test that arms `failNextClawback` sees a failure,
// and it disarms itself after firing so the retry exercises the real write.
vi.mock('../src/services/walletService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    clawbackReferralCredit: async (...args) => {
      if (fault.failNextClawback) {
        fault.failNextClawback = false;
        throw new Error('simulated clawback failure');
      }
      return actual.clawbackReferralCredit(...args);
    },
  };
});

const { bootTestApp } = await import('./helpers/app.js');
const { recordTreatment } = await import('./helpers/treatment.js');
const { patientSession } = await import('./helpers/patient.js');
const { adminSession } = await import('./helpers/admin.js');

let app;
let authStub;
let db;
let adminToken;
let practiceId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ({ app, db, stub: authStub } = await bootTestApp());
  adminToken = (await adminSession(app)).token;
  practiceId = (await request(app).get('/practices')).body.practices[0].id;
});

/** A referral credited at treatment_started and then flagged as an existing-patient suspect. */
async function creditedSuspect(referrerPhone, friendPhone, friendName) {
  const referrer = await patientSession(app, authStub, { phone: referrerPhone });
  await request(app).post('/me/role').set(auth(referrer.token)).send({ role: 'referrer' });
  const code = (await request(app).get('/me').set(auth(referrer.token))).body.user.referralCode;

  const friend = await patientSession(app, authStub, { phone: friendPhone });
  await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
  const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
    code,
    fullName: friendName,
    treatmentInterest: 'implants',
    preferredPracticeId: practiceId,
    consent: true,
    consentVersion: 'referred-v1-2026-08',
  });
  expect(sub.status).toBe(200);
  const referralId = sub.body.referral.id;

  await recordTreatment(app, adminToken, referralId);
  const started = await request(app).patch(`/admin/referrals/${referralId}/status`)
    .set(auth(adminToken)).send({ status: 'treatment_started' });
  expect(started.status).toBe(200);
  expect(started.body.credit, 'setup: the referral must actually be credited').toBeTruthy();

  // The evidence arrives after the money, which is the case FR-11 has to survive.
  await db.query(`update referrals set review_status='existing_patient_suspect' where id=$1`, [referralId]);

  const balance = async () => (await request(app).get('/wallet').set(auth(referrer.token))).body.wallet.balancePennies;
  return { referralId, balance };
}

const decide = (referralId, decision) => request(app)
  .post(`/admin/referral-review/${referralId}/decide`)
  .set(auth(adminToken))
  .send({ decision });

describe('existing-patient decision: status and clawback are one transaction', () => {
  it('rolls the status back when the clawback fails, and the retry then succeeds', async () => {
    const { referralId, balance } = await creditedSuspect('07700 950001', '07700 950002', 'Ana Rollback');
    const paid = await balance();
    expect(paid).toBeGreaterThan(0);

    fault.failNextClawback = true;
    const failed = await decide(referralId, 'existing_patient');
    expect(failed.status, 'a failed clawback must not be reported as success').toBe(500);

    // The critical property: the status did NOT stick. If it had, the guard in the endpoint
    // (`status === 'lost'` -> 409 not_in_review) would lock the referral out of every retry
    // and the credit below could never be reversed.
    const { rows: [afterFailure] } = await db.query(
      `select status, lost_reason, review_status from referrals where id=$1`, [referralId],
    );
    expect(afterFailure.status).not.toBe('lost');
    expect(afterFailure.lost_reason).toBeNull();
    expect(afterFailure.review_status, 'it must still be in the review queue').toBe('existing_patient_suspect');
    expect(await balance(), 'nothing was reversed, so the balance is untouched').toBe(paid);

    // Same request again, this time with a working clawback.
    const retry = await decide(referralId, 'existing_patient');
    expect(retry.status).toBe(200);

    const { rows: [afterRetry] } = await db.query(
      `select status, lost_reason from referrals where id=$1`, [referralId],
    );
    expect(afterRetry.status).toBe('lost');
    expect(afterRetry.lost_reason).toBe('existing_patient');
    expect(await balance(), 'the retry is what finally takes the money back').toBe(0);

    const { rows: ledger } = await db.query(
      `select kind, amount_pennies from wallet_ledger where referral_id=$1 order by created_at`, [referralId],
    );
    expect(ledger.map((l) => l.kind)).toEqual(['credit', 'adjustment']);
    expect(ledger[1].amount_pennies).toBe(-ledger[0].amount_pennies);
  });

  it('leaves no audit trail for a decision that rolled back', async () => {
    // The complement of the case above, on the other side of the write. A rolled-back attempt
    // must not narrate itself: an events row saying the referral went to 'lost', or that the
    // commission was clawed back, would describe something that did not happen and would send
    // whoever reads the audit log later looking for money that was never moved.
    const { referralId } = await creditedSuspect('07700 950003', '07700 950004', 'Bo Orphan');

    fault.failNextClawback = true;
    expect((await decide(referralId, 'existing_patient')).status).toBe(500);

    const { rows: events } = await db.query(
      `select action, to_value from events where entity_id = $1::text`, [referralId],
    );
    expect(
      events.filter((e) => e.action === 'status_changed' && e.to_value === 'lost'),
      'no status_changed to lost for a transition that rolled back',
    ).toEqual([]);

    const { rows: clawbackEvents } = await db.query(
      `select action from events where action = 'credit_clawed_back' and entity_id = (
         select referrer_id::text from referrals where id = $1
       )`,
      [referralId],
    );
    expect(clawbackEvents, 'no clawback event for a reversal that rolled back').toEqual([]);
  });

  it('still clears a suspect without touching the money', async () => {
    // The other branch is unchanged by the transaction work: clearing a suspect must not
    // reverse anything, and must leave the referral creditable.
    const { referralId, balance } = await creditedSuspect('07700 950005', '07700 950006', 'Cy Cleared');
    const paid = await balance();

    const cleared = await decide(referralId, 'clear');
    expect(cleared.status).toBe(200);

    const { rows: [row] } = await db.query(
      `select status, review_status from referrals where id=$1`, [referralId],
    );
    expect(row.review_status).toBe('cleared');
    expect(row.status).toBe('treatment_started');
    expect(await balance()).toBe(paid);
  });
});
