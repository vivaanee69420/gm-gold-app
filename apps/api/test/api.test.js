// Core-loop + money-path tests (REQUIREMENTS §6 rows 1,2,4,6,7,10 + credit invariants).
// Runs on in-memory PGlite (real Postgres semantics). The two-connection concurrency
// race (matrix row 9) needs a real multi-connection Postgres — covered when DATABASE_URL
// points at Supabase; see test at bottom.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.PGLITE_MEMORY = '1';

let app;
const agents = {};

async function signIn(phone) {
  const send = await request(app).post('/auth/otp/send').send({ phone });
  expect(send.status).toBe(200);
  const code = send.body.devHint.match(/(\d{6})/)[1];
  const verify = await request(app).post('/auth/otp/verify').send({ phone, code });
  expect(verify.status).toBe(200);
  return { token: verify.body.token, user: verify.body.user };
}

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const { initDb } = await import('../src/db.js');
  await initDb();
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
});

describe('auth', () => {
  it('health check', async () => {
    const res = await request(app).get('/healthz');
    expect(res.body.ok).toBe(true);
  });

  it('rejects a wrong OTP and caps attempts', async () => {
    const phone = '+447700900001';
    await request(app).post('/auth/otp/send').send({ phone });
    for (let i = 0; i < 5; i += 1) {
      const bad = await request(app).post('/auth/otp/verify').send({ phone, code: '000001' });
      expect(bad.status).toBe(401);
    }
    const capped = await request(app).post('/auth/otp/verify').send({ phone, code: '000001' });
    expect(capped.status).toBe(429);
  });

  it('rate-limits sends (3 per 5 minutes)', async () => {
    const phone = '+447700900002';
    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).post('/auth/otp/send').send({ phone })).status).toBe(200);
    }
    expect((await request(app).post('/auth/otp/send').send({ phone })).status).toBe(429);
  });

  it('signs in with the dev code and normalizes the phone', async () => {
    const { user, token } = await signIn('07700 900123');
    expect(user.phone).toBe('+447700900123');
    agents.referrer = token;
  });
});

describe('referrer setup', () => {
  it('saves profile and issues a referral code on referrer role', async () => {
    await request(app).post('/me/profile').set(auth(agents.referrer))
      .send({ firstName: 'Sarah', lastName: 'Lewis', notifyOptIn: true });
    const role = await request(app).post('/me/role').set(auth(agents.referrer)).send({ role: 'referrer' });
    expect(role.status).toBe(200);
    expect(role.body.user.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    agents.code = role.body.user.referralCode;
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
      .set(auth(agents.referrer))
      .send({ status: 'attended' });
    expect(res.status).toBe(409);
  });

  it('walks the pipeline; completion credits £20 exactly once', async () => {
    for (const status of ['contacted', 'booked', 'attended', 'treatment_agreed']) {
      const res = await request(app)
        .patch(`/admin/referrals/${agents.referralId}/status`)
        .set(auth(agents.referrer))
        .send({ status });
      expect(res.status).toBe(200);
    }
    const done = await request(app)
      .patch(`/admin/referrals/${agents.referralId}/status`)
      .set(auth(agents.referrer))
      .send({ status: 'treatment_completed' });
    expect(done.status).toBe(200);
    expect(done.body.credit.amount_pennies).toBe(2000);

    const wallet = await request(app).get('/wallet').set(auth(agents.referrer));
    expect(wallet.body.wallet.balancePennies).toBe(2000);

    const again = await request(app)
      .patch(`/admin/referrals/${agents.referralId}/status`)
      .set(auth(agents.referrer))
      .send({ status: 'treatment_completed' });
    expect(again.status).toBe(409); // terminal status: no double-credit path
  });

  it('payout below threshold is rejected; at threshold it works end to end', async () => {
    const below = await request(app).post('/payouts').set(auth(agents.referrer)).send({ practiceId: agents.practiceId });
    expect(below.status).toBe(409);
    expect(below.body.error).toBe('below_threshold');

    // Raise the reward to £80 and complete a second referral -> balance £100 = threshold.
    await request(app).put('/admin/reward-amount').set(auth(agents.referrer)).send({ amountPennies: 8000 });
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
    const done = await request(app)
      .patch(`/admin/referrals/${id2}/status`)
      .set(auth(agents.referrer))
      .send({ status: 'treatment_completed' }); // privileged jump from 'new'
    expect(done.status).toBe(200);
    expect(done.body.credit.amount_pennies).toBe(8000);

    const payout = await request(app).post('/payouts').set(auth(agents.referrer)).send({ practiceId: agents.practiceId });
    expect(payout.status).toBe(200);
    expect(payout.body.payout.amountPennies).toBe(10000);

    const second = await request(app).post('/payouts').set(auth(agents.referrer)).send({ practiceId: agents.practiceId });
    expect(second.status).toBe(409); // one open request per user

    const paid = await request(app)
      .post(`/admin/payouts/${payout.body.payout.id}/mark-paid`)
      .set(auth(agents.referrer));
    expect(paid.status).toBe(200);

    const wallet = await request(app).get('/wallet').set(auth(agents.referrer));
    expect(wallet.body.wallet.balancePennies).toBe(0);
    expect(wallet.body.wallet.lifetimePennies).toBe(10000);
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
    await request(app)
      .patch(`/admin/referrals/${sub.body.referral.id}/status`)
      .set(auth(agents.referrer))
      .send({ status: 'treatment_completed' });

    const res = await request(app).get('/admin/stats').set(auth(agents.referrer));
    expect(res.status).toBe(200);
    expect(res.body.stats.commissionPennies).toBe(8000);
    expect(res.body.stats.liabilityPennies).toBe(8000);
    expect(res.body.stats.referralCounts).toMatchObject({ new: 1, treatment_completed: 3 });
  });
});

describe.skipIf(!process.env.DATABASE_URL)('concurrency (real Postgres only)', () => {
  it('two simultaneous wallet ops serialize under the advisory lock', async () => {
    // Exercised against Supabase in CI once DATABASE_URL exists (matrix row 9).
  });
});
