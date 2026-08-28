// Admin dashboard surfaces (FR-25 review queue + reports, FR-28 funnel/tripwire,
// FR-21 admin payout cancel, FR-03 session revocation, FR-24 admin_users scoping).
// Runs on in-memory PGlite like api.test.js.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { adminSession } from './helpers/admin.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
const agents = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(phone) {
  const send = await request(app).post('/auth/otp/send').send({ phone });
  expect(send.status).toBe(200);
  const code = send.body.devHint.match(/(\d{6})/)[1];
  const verify = await request(app).post('/auth/otp/verify').send({ phone, code });
  expect(verify.status).toBe(200);
  return { token: verify.body.token, user: verify.body.user };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

async function submitReferralAs(phone, fullName, interest = 'implants') {
  const { token, user } = await signIn(phone);
  await request(app).post('/me/profile').set(auth(token)).send({ firstName: fullName.split(' ')[0], notifyOptIn: false });
  await request(app).post('/me/role').set(auth(token)).send({ role: 'referred' });
  const res = await request(app).post('/referrals').set(auth(token)).send({
    code: agents.code,
    fullName,
    treatmentInterest: interest,
    preferredPracticeId: agents.practiceId,
    consent: true,
    consentVersion: 'referred-v1-2026-08',
  });
  expect(res.status).toBe(200);
  return { referralId: res.body.referral.id, token, userId: user.id };
}

beforeAll(async () => {
  const dbModule = await import('../src/db.js');
  await dbModule.initDb();
  db = dbModule.db;
  const { buildApp } = await import('../src/app.js');
  app = buildApp();

  const referrer = await signIn('07700 900801');
  agents.referrer = referrer.token;
  agents.admin = (await adminSession(app)).token;
  await request(app).post('/me/profile').set(auth(agents.referrer))
    .send({ firstName: 'Sarah', lastName: 'Lewis', notifyOptIn: true });
  const role = await request(app).post('/me/role').set(auth(agents.referrer)).send({ role: 'referrer' });
  agents.code = role.body.user.referralCode;
  const practices = await request(app).get('/practices');
  agents.practiceId = practices.body.practices[0].id;
  agents.otherPracticeId = practices.body.practices[1]?.id;
  await request(app).put('/admin/reward-amount').set(auth(agents.admin)).send({ amountPennies: 2000 });
});

describe('client events and funnel (FR-28)', () => {
  it('rejects event names outside the whitelist', async () => {
    const res = await request(app).post('/events').set(auth(agents.referrer)).send({ name: 'made_up' });
    expect(res.status).toBe(422);
  });

  it('records client events and reports the tripwire completion rate', async () => {
    await request(app).post('/events').set(auth(agents.referrer)).send({ name: 'app_activated' });
    const { token } = await signIn('07700 900802');
    await request(app).post('/events').set(auth(token)).send({ name: 'code_entered' });
    await request(app).post('/events').set(auth(token)).send({ name: 'code_entered' });

    await request(app).post('/me/profile').set(auth(token)).send({ firstName: 'Jane', notifyOptIn: false });
    await request(app).post('/me/role').set(auth(token)).send({ role: 'referred' });
    const sub = await request(app).post('/referrals').set(auth(token)).send({
      code: agents.code,
      fullName: 'Jane Smith',
      treatmentInterest: 'implants',
      preferredPracticeId: agents.practiceId,
      consent: true,
      consentVersion: 'referred-v1-2026-08',
    });
    agents.referralId = sub.body.referral.id;

    const res = await request(app).get('/admin/reports/funnel').set(auth(agents.admin));
    expect(res.status).toBe(200);
    expect(res.body.funnel.appActivated).toBe(1);
    expect(res.body.funnel.codeEntered).toBe(2);
    expect(res.body.funnel.referralSubmitted).toBe(1);
    expect(res.body.funnel.tripwireRate).toBe(0.5); // 1 submitted / 2 code_entered
  });

  it('carries the hand-entered invite count (marked manual)', async () => {
    const put = await request(app).put('/admin/settings').set(auth(agents.admin))
      .send({ invite_sent_manual_count: 500 });
    expect(put.status).toBe(200);
    const res = await request(app).get('/admin/reports/funnel').set(auth(agents.admin));
    expect(res.body.funnel.inviteSent).toBe(500);
  });
});

describe('referral review queue (FR-25)', () => {
  it('lists suspects; clearing keeps the pipeline creditable', async () => {
    await db.query(`update referrals set review_status='existing_patient_suspect' where id=$1`, [agents.referralId]);

    const list = await request(app).get('/admin/referral-review').set(auth(agents.admin));
    expect(list.status).toBe(200);
    expect(list.body.reviews.map((r) => r.id)).toContain(agents.referralId);

    // Completion is blocked while flagged (FR-17 guard already in updateStatus).
    const blocked = await request(app)
      .patch(`/admin/referrals/${agents.referralId}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('review_pending');

    const decide = await request(app)
      .post(`/admin/referral-review/${agents.referralId}/decide`)
      .set(auth(agents.admin))
      .send({ decision: 'clear' });
    expect(decide.status).toBe(200);

    const after = await request(app).get('/admin/referral-review').set(auth(agents.admin));
    expect(after.body.reviews.map((r) => r.id)).not.toContain(agents.referralId);

    const done = await request(app)
      .patch(`/admin/referrals/${agents.referralId}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' });
    expect(done.status).toBe(200);
    expect(done.body.credit.amount_pennies).toBe(2000);
  });

  it('confirming an existing patient marks the referral lost — never creditable', async () => {
    const { referralId } = await submitReferralAs('07700 900803', 'Tom Hall', 'aligners');
    await db.query(`update referrals set review_status='existing_patient_suspect' where id=$1`, [referralId]);

    const decide = await request(app)
      .post(`/admin/referral-review/${referralId}/decide`)
      .set(auth(agents.admin))
      .send({ decision: 'existing_patient' });
    expect(decide.status).toBe(200);

    const { rows } = await db.query(`select status, lost_reason from referrals where id=$1`, [referralId]);
    expect(rows[0].status).toBe('lost');
    expect(rows[0].lost_reason).toBe('existing_patient');

    const credit = await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' });
    expect(credit.status).toBe(409); // lost is terminal

    const again = await request(app)
      .post(`/admin/referral-review/${referralId}/decide`)
      .set(auth(agents.admin))
      .send({ decision: 'clear' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('not_in_review');
  });

  it('rejects unknown decisions', async () => {
    const res = await request(app)
      .post(`/admin/referral-review/${agents.referralId}/decide`)
      .set(auth(agents.admin))
      .send({ decision: 'shrug' });
    expect(res.status).toBe(422);
  });
});

describe('top referrers (FR-25)', () => {
  it('ranks referrers by credited amount', async () => {
    const res = await request(app).get('/admin/reports/top-referrers').set(auth(agents.admin));
    expect(res.status).toBe(200);
    const sarah = res.body.topReferrers.find((r) => r.name.startsWith('Sarah'));
    expect(sarah).toBeDefined();
    expect(sarah.credited_pennies).toBe(2000);
    expect(sarah.completed).toBe(1);
  });
});

describe('admin payout cancel (FR-21)', () => {
  it('requires a reason, cancels, notifies the member, and keeps the balance', async () => {
    // Get Sarah to the £100 threshold: £80 rule + a second completed referral.
    await request(app).put('/admin/reward-amount').set(auth(agents.admin)).send({ amountPennies: 8000 });
    const { referralId } = await submitReferralAs('07700 900804', 'Ada Lovelace');
    await request(app)
      .patch(`/admin/referrals/${referralId}/status`)
      .set(auth(agents.admin))
      .send({ status: 'treatment_completed' });

    const payout = await request(app).post('/payouts').set(auth(agents.referrer)).send({ practiceId: agents.practiceId });
    expect(payout.status).toBe(200);
    const payoutId = payout.body.payout.id;

    const noReason = await request(app)
      .post(`/admin/payouts/${payoutId}/cancel`).set(auth(agents.admin)).send({});
    expect(noReason.status).toBe(422);
    expect(noReason.body.error).toBe('reason_required');

    const cancelled = await request(app)
      .post(`/admin/payouts/${payoutId}/cancel`).set(auth(agents.admin))
      .send({ reason: 'member could not attend' });
    expect(cancelled.status).toBe(200);

    const list = await request(app).get('/admin/payouts').set(auth(agents.admin));
    expect(list.body.payouts.find((p) => p.id === payoutId).status).toBe('cancelled');

    const wallet = await request(app).get('/wallet').set(auth(agents.referrer));
    expect(wallet.body.wallet.balancePennies).toBe(10000); // balance untouched

    const { rows } = await db.query(
      `select payload from notification_outbox where template='payout_cancelled'`,
    );
    expect(rows.length).toBe(1);

    const twice = await request(app)
      .post(`/admin/payouts/${payoutId}/cancel`).set(auth(agents.admin))
      .send({ reason: 'again' });
    expect(twice.status).toBe(409);
  });
});

describe('session revocation (FR-03)', () => {
  it('kills tokens issued before the revocation', async () => {
    const { token, user } = await signIn('07700 900805');
    expect((await request(app).get('/me').set(auth(token))).status).toBe(200);

    await sleep(1100); // iat has second precision; make "issued before" unambiguous
    const revoke = await request(app)
      .post(`/admin/users/${user.id}/revoke-sessions`).set(auth(agents.admin));
    expect(revoke.status).toBe(200);

    expect((await request(app).get('/me').set(auth(token))).status).toBe(401);

    await sleep(1100);
    const again = await signIn('07700 900805'); // fresh sign-in works after revocation
    expect((await request(app).get('/me').set(auth(again.token))).status).toBe(200);
  });

  // I5 (final review): requireUser used to compare `iat * 1000` against a sub-second
  // sessions_revoked_at, so a token minted in the very second of the revocation that preceded
  // it read as "issued before" and died. Tokens now carry iatMs (exact); tokens minted before
  // that claim existed fall back to a second-granularity compare.
  it('a legacy patient token with no iatMs is judged at second granularity', async () => {
    const { config } = await import('../src/config.js');
    const { default: jwt } = await import('jsonwebtoken');
    const { user } = await signIn('07700 900806');

    const legacy = jwt.sign({ sub: user.id, phone: user.phone }, config.jwtSecret, { expiresIn: '90d' });
    const { iat } = jwt.decode(legacy);

    // Revoked inside the same wall-clock second it was minted -> still alive.
    await db.query(
      `update users set sessions_revoked_at = to_timestamp($2::float8) + interval '400 milliseconds' where id=$1`,
      [user.id, iat],
    );
    expect((await request(app).get('/me').set(auth(legacy))).status).toBe(200);

    // Revoked in a strictly later second -> dead.
    await db.query(`update users set sessions_revoked_at = to_timestamp($2::float8) where id=$1`, [user.id, iat + 1]);
    expect((await request(app).get('/me').set(auth(legacy))).status).toBe(401);
  });

  it('404s for an unknown user', async () => {
    const res = await request(app)
      .post('/admin/users/00000000-0000-0000-0000-000000000000/revoke-sessions')
      .set(auth(agents.admin));
    expect(res.status).toBe(404);
  });
});

describe('admin_users practice scoping (FR-24)', () => {
  it('a practice-scoped manager sees only their practice; an admin sees all', async () => {
    if (!agents.otherPracticeId) return; // needs two seeded practices
    const { token: managerToken } = await adminSession(app, {
      email: 'frontdesk@gmdental.co.uk',
      role: 'manager',
      practiceIds: [agents.otherPracticeId],
    });

    const payouts = await request(app).get('/admin/payouts').set(auth(managerToken));
    expect(payouts.status).toBe(200);
    expect(payouts.body.payouts).toEqual([]); // Sarah's payout sits at the first practice

    // Managers are fenced to /admin/me + /admin/payouts*; referrals is off-limits entirely.
    const referrals = await request(app).get('/admin/referrals').set(auth(managerToken));
    expect(referrals.status).toBe(403);
    expect(referrals.body.error).toBe('forbidden');

    const all = await request(app).get('/admin/payouts').set(auth(agents.admin));
    expect(all.body.payouts.length).toBeGreaterThan(0); // an unscoped admin sees every practice
  });
});

// A 5xx is always OUR bug, never something a caller can act on — and a raw Postgres message
// carries table/column names and sometimes parameter values. The boundary must answer every
// 5xx with the same opaque code while still logging the real error for us (I1, final review).
describe('error boundary', () => {
  it('a server-side failure responds with exactly { error: "internal" } and still logs the real error', async () => {
    const dbModule = await import('../src/db.js');
    const realQuery = dbModule.db.query;
    const boom = new Error('relation "app_settings" does not exist at character 42');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const query = vi.spyOn(dbModule.db, 'query').mockImplementation((text, params) =>
      String(text).includes('app_settings') ? Promise.reject(boom) : realQuery(text, params));

    try {
      const res = await request(app).get('/admin/settings').set(auth(agents.admin));
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal' });
      expect(JSON.stringify(res.body)).not.toMatch(/relation|does not exist|character 42/i);
      expect(consoleError).toHaveBeenCalledWith('[api]', boom);
    } finally {
      query.mockRestore();
      consoleError.mockRestore();
    }
  });

  it('a 4xx thrown by a service still carries its own error code', async () => {
    const res = await request(app)
      .patch('/admin/referrals/00000000-0000-0000-0000-000000000000/status')
      .set(auth(agents.admin))
      .send({ status: 'contacted' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
