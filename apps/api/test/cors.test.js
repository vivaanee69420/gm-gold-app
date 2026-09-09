// CORS origin allowlist (todo.md §1: `app.use(cors())` was wide open).
//
// The contract has exactly two shapes, and the mobile case is the one that makes a naive
// allowlist wrong:
//
//   no Origin header  -> React Native fetch / curl / Dental Os trigger / health check
//                        ALLOWED. Not a browser; CORS was never protecting it.
//   Origin present    -> a browser. Allowed only if it is in config.adminOrigins.
//
// A refused origin gets no `access-control-allow-origin` header at all and the BROWSER
// blocks the response. The request still reaches the handler and still returns 200 — that
// is how CORS works, and asserting a 403 here would be asserting a mechanism Express does
// not have. The assertion that matters is the absence of the header.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';

process.env.PGLITE_MEMORY = '1';
// Set before importing config.js — the allowlist is read once at module evaluation.
process.env.ADMIN_ORIGINS = 'https://admin.gmdental.co.uk, https://staging-admin.gmdental.co.uk';

let app;

beforeAll(async () => {
  const { initDb } = await import('../src/db.js');
  await initDb();
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
});

describe('CORS origin allowlist', () => {
  it('allows a request with no Origin header (the mobile app)', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    // cors() reflects `*` when it allows an origin-less request; either way the mobile
    // fetch is never blocked, because nothing is enforcing CORS on it.
    expect(res.body).toEqual({ ok: true });
  });

  it('reflects an allowed origin', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://admin.gmdental.co.uk');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.gmdental.co.uk');
  });

  it('reflects the second allowed origin (comma-separated list is parsed)', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://staging-admin.gmdental.co.uk');
    expect(res.headers['access-control-allow-origin']).toBe('https://staging-admin.gmdental.co.uk');
  });

  it('sends no allow-origin header for an unknown origin', async () => {
    const res = await request(app).get('/healthz').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not match on prefix — a lookalike origin is refused', async () => {
    const res = await request(app)
      .get('/healthz')
      .set('Origin', 'https://admin.gmdental.co.uk.evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight from an allowed origin', async () => {
    const res = await request(app)
      .options('/auth/admin/login')
      .set('Origin', 'https://admin.gmdental.co.uk')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBe('https://admin.gmdental.co.uk');
  });

  it('refuses a preflight from an unknown origin', async () => {
    const res = await request(app)
      .options('/auth/admin/login')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'POST');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
