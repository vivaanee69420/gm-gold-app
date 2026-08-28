// Test-only harness for getting a working admin session without going through the
// dashboard UI: creates the account (idempotently) via adminService, then logs in
// through the real HTTP route so every suite exercises the same code path a browser would.
import request from 'supertest';
import { createAdmin } from '../../src/services/adminService.js';

export async function adminSession(app, {
  email = 'admin@test.gmdental.co.uk',
  password = 'correct-horse-battery',
  role = 'admin',
  practiceIds = [],
} = {}) {
  try {
    await createAdmin({ email, password, role, practiceIds });
  } catch (err) {
    if (err.status !== 409) throw err; // 409 email_taken: account already seeded, reuse it
  }
  const res = await request(app).post('/auth/admin/login').send({ email, password });
  if (res.status !== 200) {
    throw new Error(`adminSession: login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token, admin: res.body.admin };
}
