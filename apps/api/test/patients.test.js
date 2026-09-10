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

// The pipeline card's own two fields (0018). Both are the practice's working memory about a
// patient, and both outlive every page load until someone removes them.
describe('the card: treatment name and notes', () => {
  it('opens the same detail from the pipeline door as from the patients door', async () => {
    const viaPipeline = await request(app).get(`/admin/referrals/${referralId}`).set(auth(adminToken));
    const viaPatients = await request(app).get(`/admin/patients/${referralId}`).set(auth(adminToken));
    expect(viaPipeline.status).toBe(200);
    expect(viaPipeline.body).toEqual(viaPatients.body);
  });

  it('keeps the typed treatment name without touching what the patient chose on the form', async () => {
    const saved = await request(app).put(`/admin/referrals/${referralId}/treatment`)
      .set(auth(adminToken)).send({ treatmentName: '  Upper arch implants  ', doctorName: 'Dr Patel', treatmentValuePennies: 480000 });
    expect(saved.status).toBe(200);
    expect(saved.body.treatmentName, 'trimmed').toBe('Upper arch implants');

    const detail = await request(app).get(`/admin/referrals/${referralId}`).set(auth(adminToken));
    expect(detail.body.patient.treatmentName).toBe('Upper arch implants');
    // The enum the referral form captured is what commission attribution reads — it must
    // survive the practice typing the real treatment over the top of nothing.
    expect(detail.body.patient.treatmentInterest).toBe('implants');
  });

  it('clears the treatment name with an empty string, rather than rejecting it', async () => {
    await request(app).put(`/admin/referrals/${referralId}/treatment`)
      .set(auth(adminToken)).send({ treatmentName: 'Typo', doctorName: 'Dr Patel', treatmentValuePennies: 480000 });
    const cleared = await request(app).put(`/admin/referrals/${referralId}/treatment`)
      .set(auth(adminToken)).send({ treatmentName: '', doctorName: '', treatmentValuePennies: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.treatmentName).toBeNull();
    // Put it back for the tests below.
    await request(app).put(`/admin/referrals/${referralId}/treatment`)
      .set(auth(adminToken)).send({ treatmentName: 'Upper arch implants', doctorName: 'Dr Patel', treatmentValuePennies: 480000 });
  });

  it('keeps notes until they are deleted, newest last, with who wrote them', async () => {
    const first = await request(app).post(`/admin/referrals/${referralId}/notes`)
      .set(auth(adminToken)).send({ body: 'Rang twice, no answer.' });
    expect(first.status).toBe(200);
    await request(app).post(`/admin/referrals/${referralId}/notes`)
      .set(auth(adminToken)).send({ body: 'Booked for the 14th.' });

    // A write answers with the whole list, so the card never needs a follow-up read.
    const detail = await request(app).get(`/admin/referrals/${referralId}`).set(auth(adminToken));
    expect(detail.body.notes.map((n) => n.body)).toEqual([
      'Rang twice, no answer.',
      'Booked for the 14th.',
    ]);
    expect(detail.body.notes[0].author).toBe('admin@test.gmdental.co.uk');

    // Still there after an unrelated change — a note is not scratch state on the page.
    await request(app).patch(`/admin/referrals/${referralId}/status`)
      .set(auth(adminToken)).send({ status: 'booked' });
    const later = await request(app).get(`/admin/referrals/${referralId}`).set(auth(adminToken));
    expect(later.body.notes).toHaveLength(2);

    const deleted = await request(app)
      .delete(`/admin/referrals/${referralId}/notes/${first.body.id}`)
      .set(auth(adminToken));
    expect(deleted.status).toBe(200);
    expect(deleted.body.notes.map((n) => n.body)).toEqual(['Booked for the 14th.']);
  });

  it('rejects an empty note rather than storing a blank row', async () => {
    const res = await request(app).post(`/admin/referrals/${referralId}/notes`)
      .set(auth(adminToken)).send({ body: '   ' });
    expect(res.status).toBe(422);
  });

  it('fences both fields to the manager’s own practice, answering 404 not 403', async () => {
    // A manager at a practice this referral does not belong to. 404, because a 403 would
    // confirm to them that a referral with this id exists somewhere else.
    const outsider = await adminSession(app, {
      email: 'card-outsider@gmdental.co.uk',
      role: 'manager',
      practiceIds: [practices[1].id],
    });

    expect((await request(app).get(`/admin/referrals/${referralId}`)
      .set(auth(outsider.token))).status).toBe(404);
    expect((await request(app).put(`/admin/referrals/${referralId}/treatment`)
      .set(auth(outsider.token)).send({ treatmentName: 'Nope', doctorName: 'Nope', treatmentValuePennies: 1 })).status).toBe(404);
    expect((await request(app).post(`/admin/referrals/${referralId}/notes`)
      .set(auth(outsider.token)).send({ body: 'Nope' })).status).toBe(404);

    // And the note that is really there is untouched by any of it.
    const detail = await request(app).get(`/admin/referrals/${referralId}`).set(auth(adminToken));
    expect(detail.body.patient.treatmentName).toBe('Upper arch implants');
  });

  it('will not delete a note by id alone from outside the referral it belongs to', async () => {
    // The note id is the only thing an attacker would have; scoping the delete by note id
    // without the referral would make guessing one enough.
    const note = await request(app).post(`/admin/referrals/${referralId}/notes`)
      .set(auth(adminToken)).send({ body: 'Belongs to Percy.' });

    // A second referral at the same practice, so the practice fence passes and the only thing
    // that can refuse this delete is the note-belongs-to-this-referral clause.
    const { rows } = await db.query(
      `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                              preferred_practice_id, consent_version)
       select referrer_id, '+447700905009', 'Other Person', 'aligners', preferred_practice_id,
              consent_version
         from referrals where id = $1
       returning id`,
      [referralId],
    );

    const res = await request(app)
      .delete(`/admin/referrals/${rows[0].id}/notes/${note.body.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);

    const still = await request(app).get(`/admin/referrals/${referralId}`).set(auth(adminToken));
    expect(still.body.notes.some((n) => n.body === 'Belongs to Percy.')).toBe(true);
  });
});

// The card face reads the list endpoint, not the detail one — so the typed treatment has to
// travel with the list, or it vanishes from the board on the next page load.
describe('GET /admin/referrals carries the typed treatment', () => {
  it('returns treatment_name alongside the form answer', async () => {
    await request(app).put(`/admin/referrals/${referralId}/treatment`)
      .set(auth(adminToken)).send({ treatmentName: 'Lower denture', doctorName: 'Dr Patel', treatmentValuePennies: 190000 });
    const res = await request(app).get('/admin/referrals').set(auth(adminToken));
    const row = res.body.referrals.find((r) => r.id === referralId);
    expect(row.treatment_name).toBe('Lower denture');
    expect(row.treatment_interest).toBe('implants');
  });
});

// The gate on the money. Treatment started is where this scheme pays out, and until now it
// could fire on a card carrying nothing but a name.
describe('commission needs the treatment on record first', () => {
  let gateReferral;
  let gateAdmin;

  beforeAll(async () => {
    gateAdmin = (await adminSession(app, { email: 'gate@gmdental.co.uk' })).token;
    const { rows } = await db.query(
      `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                              preferred_practice_id, consent_version, status)
       select referrer_id, '+447700905777', 'Gated Patient', 'implants', preferred_practice_id,
              consent_version, 'treatment_agreed'
         from referrals where id = $1
       returning id`,
      [referralId],
    );
    gateReferral = rows[0].id;
  });

  const move = (status) =>
    request(app).patch(`/admin/referrals/${gateReferral}/status`)
      .set(auth(gateAdmin)).send({ status });

  it('refuses treatment started while any of the three is missing, naming what is missing', async () => {
    const bare = await move('treatment_started');
    expect(bare.status).toBe(422);
    expect(bare.body.error).toBe('treatment_details_required');

    await request(app).put(`/admin/referrals/${gateReferral}/treatment`)
      .set(auth(gateAdmin)).send({ treatmentName: 'Full arch', doctorName: '', treatmentValuePennies: null });
    expect((await move('treatment_started')).status, 'a treatment alone is not enough').toBe(422);

    await request(app).put(`/admin/referrals/${gateReferral}/treatment`)
      .set(auth(gateAdmin)).send({ treatmentName: 'Full arch', doctorName: 'Dr Okafor', treatmentValuePennies: null });
    expect((await move('treatment_started')).status, 'the value is still missing').toBe(422);

    // The referral has not moved and nothing has been credited while the gate held.
    const held = await request(app).get(`/admin/referrals/${gateReferral}`).set(auth(gateAdmin));
    expect(held.body.patient.status).toBe('treatment_agreed');
    expect(held.body.commission.amountPennies).toBeNull();
  });

  it('lets the money move once all three are on record', async () => {
    await request(app).put(`/admin/referrals/${gateReferral}/treatment`)
      .set(auth(gateAdmin))
      .send({ treatmentName: 'Full arch', doctorName: 'Dr Okafor', treatmentValuePennies: 650000 });

    const moved = await move('treatment_started');
    expect(moved.status).toBe(200);
    const after = await request(app).get(`/admin/referrals/${gateReferral}`).set(auth(gateAdmin));
    expect(after.body.patient.status).toBe('treatment_started');
    expect(after.body.commission.amountPennies).toBe(10000);
  });

  it('gates the jump straight to Completed too — it releases the same money', async () => {
    // The dashboard sends privilegedComplete, so Completed is reachable from anywhere. A gate
    // on treatment_started alone would leave that jump as the way around it.
    const { rows } = await db.query(
      `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                              preferred_practice_id, consent_version, status)
       select referrer_id, '+447700905778', 'Jumped Patient', 'implants', preferred_practice_id,
              consent_version, 'attended'
         from referrals where id = $1
       returning id`,
      [referralId],
    );
    const jumper = rows[0].id;

    const jumped = await request(app).patch(`/admin/referrals/${jumper}/status`)
      .set(auth(gateAdmin)).send({ status: 'treatment_completed' });
    expect(jumped.status).toBe(422);
    expect(jumped.body.error).toBe('treatment_details_required');
  });

  it('never blocks a move that does not pay', async () => {
    const { rows } = await db.query(
      `insert into referrals (referrer_id, referred_phone, referred_name, treatment_interest,
                              preferred_practice_id, consent_version, status)
       select referrer_id, '+447700905779', 'Ordinary Patient', 'implants', preferred_practice_id,
              consent_version, 'new'
         from referrals where id = $1
       returning id`,
      [referralId],
    );
    const ordinary = rows[0].id;

    expect((await request(app).patch(`/admin/referrals/${ordinary}/status`)
      .set(auth(gateAdmin)).send({ status: 'contacted' })).status).toBe(200);
    expect((await request(app).patch(`/admin/referrals/${ordinary}/status`)
      .set(auth(gateAdmin)).send({ status: 'lost', lostReason: 'moved away' })).status).toBe(200);
  });
});
