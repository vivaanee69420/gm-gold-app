import request from 'supertest';

/**
 * The three facts updateStatus requires before either crediting stage (0020): what is being
 * done, who is doing it, and what it is worth. Every test that walks a referral into
 * treatment_started or treatment_completed has to put them on record first — that is the
 * point of the gate, so the tests exercise the same path a manager does.
 */
export async function recordTreatment(app, token, referralId, over = {}) {
  return request(app)
    .put(`/admin/referrals/${referralId}/treatment`)
    .set({ Authorization: `Bearer ${token}` })
    .send({
      treatmentName: 'Test treatment',
      doctorName: 'Dr Test',
      treatmentValuePennies: 100000,
      ...over,
    });
}
