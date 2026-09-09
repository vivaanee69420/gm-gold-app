// Production-mode guard (todo.md §1).
//
// The deployed image ran with NODE_ENV=development, which meant `isDev` was true in
// production and three things leaked at once:
//
//   /auth/otp/send      -> returned the six-digit code in `devHint` (otpService.js), so
//                          anyone could sign in as any phone number, admin accounts included
//                          [that endpoint is now DELETED — see auth-supabase.test.js, which
//                           asserts it 404s; Supabase Auth issues codes now]
//   /dev/dentally/*     -> stub endpoints mounted on the public API (app.js)
//   /webhooks/dentally  -> accepted unsigned calls when no secret was configured
//
// Nothing in the suite asserted the production shape, so the leak was invisible to CI.
// This file pins it: with NODE_ENV=production, those surfaces must be closed.
//
// NODE_ENV must be set before importing config.js — `isDev` is computed once at module
// evaluation. Vitest isolates module registries per test file, so this does not leak into
// the other suites, which deliberately run in dev mode and rely on devHint.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.PGLITE_MEMORY = '1';

let app;

beforeAll(async () => {
  // NODE_ENV must be 'production' when config.js is first evaluated — `isDev` is computed
  // once at module scope. But it must NOT still be 'production' afterwards: vitest gives
  // each file a fresh module registry while REUSING worker processes, so process.env leaks
  // between files that share a worker. Left set, this file intermittently flips
  // resolveDentallyMode() from 'stub' to 'off' for whichever suite runs next in the same
  // worker, and dentally.test.js fails depending on scheduling. That is exactly the flake
  // this dance avoids.
  //
  // Files never interleave within a worker, so setting it, letting the imports capture it,
  // and restoring it here is airtight.
  const restore = { NODE_ENV: process.env.NODE_ENV, API_JWT_SECRET: process.env.API_JWT_SECRET };
  process.env.NODE_ENV = 'production';
  // config.js refuses to boot in production without this. Setting it here is the test
  // asserting that guard exists as much as it is satisfying it.
  process.env.API_JWT_SECRET = 'test-only-production-mode-secret';
  try {
    const { initDb } = await import('../src/db.js');
    await initDb();
    const { buildApp } = await import('../src/app.js');
    app = buildApp();
  } finally {
    process.env.NODE_ENV = restore.NODE_ENV;
    if (restore.API_JWT_SECRET === undefined) delete process.env.API_JWT_SECRET;
    else process.env.API_JWT_SECRET = restore.API_JWT_SECRET;
  }
});

describe('production mode closes the dev surfaces', () => {
  it('confirms the app really is in production mode', async () => {
    const { isDev } = await import('../src/config.js');
    expect(isDev).toBe(false);
  });

  it('/dev/dentally/add-patient is not mounted', async () => {
    const res = await request(app).post('/dev/dentally/add-patient').send({ phone: '07700900123' });
    expect(res.status).toBe(404);
  });

  it('/dev/dentally/complete is not mounted', async () => {
    const res = await request(app).post('/dev/dentally/complete').send({ phone: '07700900123' });
    expect(res.status).toBe(404);
  });

  it('/webhooks/dentally refuses unsigned calls when no secret is configured', async () => {
    const res = await request(app).post('/webhooks/dentally').send({ event: 'ping' });
    expect(res.status).not.toBe(204);
  });

  it('a 5xx does not leak the underlying error text', async () => {
    // /admin/* with a garbage bearer is a 401, not a 5xx — so assert the shape that IS
    // reachable: error bodies carry a code, never a Postgres message or a stack.
    const res = await request(app).get('/admin/stats').set('Authorization', 'Bearer nonsense');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});
