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

  it('shows an in-scope manager their own practice\'s patient', async () => {
    // practiceScope(req) is null for an admin — the previous two tests never exercise the
    // `= any($1::uuid[])` branch. This does: a manager genuinely scoped to the referral's
    // owning practice (practices[0], via preferred_practice_id) must still see it.
    const { token } = await adminSession(app, {
      email: 'patients-inscope@gmdental.co.uk', role: 'manager', practiceIds: [practices[0].id],
    });
    const res = await request(app).get('/admin/patients').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.patients.map((p) => p.id)).toContain(referralId);
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

  it('shows an in-scope manager the patient detail', async () => {
    // Proves $1/$2 are not transposed: a transposed bind would find nothing and 404 here,
    // not merely return the wrong rows.
    const { token } = await adminSession(app, {
      email: 'patients-detail-inscope@gmdental.co.uk', role: 'manager', practiceIds: [practices[0].id],
    });
    const res = await request(app).get(`/admin/patients/${referralId}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.patient.name).toBe('Percy Patient');
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
    expect(res.body.error).toBe('not_found');
  });

  // This test mutates referralId's booked_practice_id and must run last in the file: every
  // test above assumes it stays null (e.g. `practice: { ..., booked: null }` above).
  it('prefers the booked practice over the form practice when they diverge', async () => {
    // The form said practices[0]; Dental Os now says the appointment is at practices[2].
    await db.query('update referrals set booked_practice_id = $2 where id = $1', [referralId, practices[2].id]);

    const { token: bookedManager } = await adminSession(app, {
      email: 'patients-booked-practice@gmdental.co.uk', role: 'manager', practiceIds: [practices[2].id],
    });
    const seenList = await request(app).get('/admin/patients').set(auth(bookedManager));
    expect(seenList.body.patients.map((p) => p.id)).toContain(referralId);
    const seenDetail = await request(app).get(`/admin/patients/${referralId}`).set(auth(bookedManager));
    expect(seenDetail.status).toBe(200);
    expect(seenDetail.body.patient.name).toBe('Percy Patient');

    const { token: formManager } = await adminSession(app, {
      email: 'patients-form-practice@gmdental.co.uk', role: 'manager', practiceIds: [practices[0].id],
    });
    const notSeenList = await request(app).get('/admin/patients').set(auth(formManager));
    expect(notSeenList.body.patients.map((p) => p.id)).not.toContain(referralId);
    const notSeenDetail = await request(app).get(`/admin/patients/${referralId}`).set(auth(formManager));
    expect(notSeenDetail.status).toBe(404);
    expect(notSeenDetail.body.error).toBe('not_found');
  });
});
