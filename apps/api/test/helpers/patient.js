// Patient sessions for tests, the way test/helpers/admin.js does it for the dashboard:
// go through the real HTTP routes so every suite exercises the code path a real client would.
//
// Replaces the old per-file signIn(phone) helper, which posted to /auth/otp/send, read the
// six-digit code out of the response's devHint field, and posted it back. That endpoint is
// gone — it was the sign-in-as-anyone hole — so sessions now come from a Supabase-shaped
// access token signed by the local key stub (test/helpers/supabase-auth.js).
//
// Note the shape change this forces on the tests, which is a genuine product change and not
// a test detail: identity is EMAIL now. A phone number is something the account acquires at
// the profile step, not something it is. So `patientSession` mints an identity first and
// attaches the phone second, in that order, exactly as the app does.
import request from 'supertest';

/**
 * A signed-in patient with a phone on file.
 *
 * @param {object} app                 supertest target
 * @param {object} stub                from startSupabaseAuthStub()
 * @param {object} [opts]
 * @param {string} [opts.phone]        free-typed; normalized to E.164 by profileSchema
 * @param {string} [opts.email]        defaults to a unique address
 * @param {boolean} [opts.profile]     set false to stop before the profile step, leaving an
 *                                     account with an email and NO phone — the state a
 *                                     brand-new signup is actually in
 * @param {boolean} [opts.notifyOptIn]
 * @returns {Promise<{token: string, user: object, sub: string}>}
 */
let seq = 0;
export async function patientSession(app, stub, {
  phone,
  email,
  sub: existingSub,
  firstName = 'Sarah',
  lastName = 'Lewis',
  profile = true,
  notifyOptIn = true,
} = {}) {
  seq += 1;
  // Pass `sub` to sign in AGAIN as the same person — that is what a second login is now, and
  // it is not the same as passing the same phone. Under email identity a fresh `sub` is a
  // different human who happens to have typed the same number, and `users.phone` is unique,
  // so reusing a phone without the sub is a 409 rather than a re-login.
  const sub = existingSub ?? crypto.randomUUID();
  const address = email ?? `patient+${seq}@example.com`;
  const token = await stub.signToken({ sub, email: address });
  const auth = { Authorization: `Bearer ${token}` };

  // First authenticated request creates the profile row from the verified identity.
  const me = await request(app).get('/me').set(auth);
  if (me.status !== 200) {
    throw new Error(`patientSession: /me failed (${me.status}): ${JSON.stringify(me.body)}`);
  }
  if (!profile) return { token, user: me.body.user, sub };

  if (!phone) throw new Error('patientSession: phone is required unless profile:false');
  const saved = await request(app)
    .post('/me/profile')
    .set(auth)
    .send({ firstName, lastName, phone, notifyOptIn });
  if (saved.status !== 200) {
    throw new Error(`patientSession: /me/profile failed (${saved.status}): ${JSON.stringify(saved.body)}`);
  }
  return { token, user: saved.body.user, sub };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });
