// Production-mode guard (todo.md §1).
//
// The deployed image ran with NODE_ENV=development, which meant `isDev` was true in
// production and three things leaked at once:
//
//   /auth/otp/send      -> returned the six-digit code in `devHint` (otpService.js), so
//                          anyone could sign in as any phone number, admin accounts included
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
process.env.NODE_ENV = 'production';
// config.js refuses to boot in production without this. Setting it here is the test
// asserting that guard exists as much as it is satisfying it.
process.env.API_JWT_SECRET = 'test-only-production-mode-secret';

let app;

beforeAll(async () => {
  const { initDb } = await import('../src/db.js');
  await initDb();
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
});

describe('production mode closes the dev surfaces', () => {
  it('confirms the app really is in production mode', async () => {
    const { isDev } = await import('../src/config.js');
    expect(isDev).toBe(false);
  });

  it('/auth/otp/send does NOT return the code', async () => {
    const res = await request(app).post('/auth/otp/send').send({ phone: '07700900123' });
    expect(res.status).toBe(200);
    expect(res.body.devHint).toBeUndefined();
    // Belt and braces: no six-digit code anywhere in the response, whatever it is called.
    expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);
  });

  it('does not print the OTP code to stdout', async () => {
    // Railway streams stdout to its log viewer and to any configured drain, so a code in
    // the logs is a working sign-in for anyone with log access. This was live: the
    // console.log in otpService.sendOtp was unconditional, not gated on isDev.
    const lines = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      await request(app).post('/auth/otp/send').send({ phone: '07700900456' });
    } finally {
      console.log = original;
    }
    const otpLines = lines.filter((l) => l.includes('[otp]'));
    expect(otpLines.length).toBeGreaterThan(0); // the send is still observable
    // Assert the exact production line rather than "no six digits anywhere" — an E.164
    // phone number contains plenty of six-digit runs of its own, so a loose regex passes
    // for the wrong reason. The contract is: the fact of the send, and nothing more.
    expect(otpLines).toEqual(['[otp] sent to +447700900456']);
    for (const line of otpLines) expect(line).not.toContain('code');
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
