// The patients register: every referred person, who referred them, and what has happened since.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { patientSession } from './helpers/patient.js';
import { adminSession } from './helpers/admin.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let authStub;
let adminToken;
let practices;
let referralId;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  ({ app, db, stub: authStub } = await bootTestApp());
  adminToken = (await adminSession(app)).token;
  await request(app).put('/admin/reward-amount').set(auth(adminToken)).send({ amountPennies: 10000 });
  practices = (await request(app).get('/practices')).body.practices;

  const ref = await patientSession(app, authStub, { phone: '07700 905001' });
  // profileSchema requires phone on every save (not just the first); re-send the same
  // number here or this silently 422s and the name update never lands.
  await request(app).post('/me/profile').set(auth(ref.token))
    .send({ firstName: 'Rita', lastName: 'Referrer', phone: '07700 905001', notifyOptIn: false });
  const role = await request(app).post('/me/role').set(auth(ref.token)).send({ role: 'referrer' });

  const friend = await patientSession(app, authStub, { phone: '07700 905002' });
  await request(app).post('/me/profile').set(auth(friend.token))
    .send({ firstName: 'Percy', lastName: 'Patient', notifyOptIn: false });
  await request(app).post('/me/role').set(auth(friend.token)).send({ role: 'referred' });
  const sub = await request(app).post('/referrals').set(auth(friend.token)).send({
    code: role.body.user.referralCode,
    fullName: 'Percy Patient',
    email: 'percy@example.com',
    treatmentInterest: 'implants',
    preferredPracticeId: practices[0].id,
    consent: true,
    consentVersion: 'referred-v1-2026-08',
  });
  referralId = sub.body.referral.id;

  await request(app).patch(`/admin/referrals/${referralId}/status`)
    .set(auth(adminToken)).send({ status: 'contacted' });
});

describe('GET /admin/patients', () => {
  it('lists referred patients with their referrer and stage', async () => {
    const res = await request(app).get('/admin/patients').set(auth(adminToken));
    expect(res.status).toBe(200);
    const percy = res.body.patients.find((p) => p.id === referralId);
    expect(percy).toMatchObject({
      referred_name: 'Percy Patient',
      referred_email: 'percy@example.com',
      status: 'contacted',
      referrer: expect.stringContaining('Rita'),
    });
  });

  it('shows a manager only their own practice', async () => {
    const { token } = await adminSession(app, {
      email: 'patients-scope@gmdental.co.uk', role: 'manager', practiceIds: [practices[1].id],
    });
    const res = await request(app).get('/admin/patients').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.patients.map((p) => p.id)).not.toContain(referralId);
  });
});

describe('GET /admin/patients/:id', () => {
  it('returns the referrer, the practice, and the stage timeline', async () => {
    const res = await request(app).get(`/admin/patients/${referralId}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ name: 'Percy Patient', email: 'percy@example.com' });
    expect(res.body.referrer).toMatchObject({ name: expect.stringContaining('Rita') });
    expect(res.body.referrer.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(res.body.practice).toMatchObject({ chosen: practices[0].name, booked: null });
    expect(res.body.commission).toMatchObject({ amountPennies: null, creditedAt: null });

    const changes = res.body.timeline.filter((e) => e.action === 'status_changed');
    expect(changes.at(-1)).toMatchObject({ to: 'contacted', actorKind: 'admin' });
  });

  it('404s a manager asking for another practice\'s patient', async () => {
    const { token } = await adminSession(app, {
      email: 'patients-detail-scope@gmdental.co.uk', role: 'manager', practiceIds: [practices[1].id],
    });
    const res = await request(app).get(`/admin/patients/${referralId}`).set(auth(token));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

  it('404s an unknown id', async () => {
    const res = await request(app)
      .get('/admin/patients/00000000-0000-4000-8000-000000000000').set(auth(adminToken));
    expect(res.status).toBe(404);
  });
});
