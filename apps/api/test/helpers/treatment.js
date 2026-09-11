import request from 'supertest';

/**
 * The four facts updateStatus requires before either crediting stage: what is being done, who
 * is doing it, what it is worth (0020) and what it pays (0021). Every test that walks a
 * referral into treatment_started or treatment_completed has to put them on record first —
 * that is the point of the gate, so the tests exercise the same path a manager does.
 *
 * commissionPennies defaults to £20, which is what the retired global reward rule used to pay,
 * so suites that previously set it with PUT /admin/reward-amount keep their expected figures.
 * Pass `{ commissionPennies: 25000 }` to test another tier, or `null` to test the gate.
 */
export async function recordTreatment(app, token, referralId, over = {}) {
  return request(app)
    .put(`/admin/referrals/${referralId}/treatment`)
    .set({ Authorization: `Bearer ${token}` })
    .send({
      treatmentName: 'Test treatment',
      doctorName: 'Dr Test',
      treatmentValuePennies: 100000,
      commissionPennies: 2000,
      ...over,
    });
}
