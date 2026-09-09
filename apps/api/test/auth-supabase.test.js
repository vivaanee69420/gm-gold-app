// requireUser against Supabase Auth (decision 2026-09-09).
//
// The single most important assertion in this file is the 503 one. Everything else here is
// "reject a bad token", which is the easy half. The hard half is NOT rejecting a token we
// merely failed to check: if requireUser answers 401 when Supabase's JWKS endpoint is
// briefly unreachable, every patient is signed out at once and the mobile client clears its
// stored session on the way out. A blip becomes a mass logout.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { generateKeyPair } from 'jose';
import { bootTestApp } from './helpers/app.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let stub;
let supabaseAuth;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  // Goes through bootTestApp like every other suite rather than setting env itself. An
  // earlier version did the latter and passed in the normal pool but failed under a single
  // worker: config.js is evaluated once per worker, so when this file runs AFTER another,
  // env changes are ignored and config.supabase still points at the previous file's stub —
  // which that file has since stopped. bootTestApp assigns onto the loaded config, so it
  // works regardless of which file got there first.
  ({ app, db, stub } = await bootTestApp());
  supabaseAuth = await import('../src/services/supabaseAuth.js');
});

afterAll(async () => {
  await stub?.stop();
});

describe('requireUser: tokens it must accept', () => {
  it('accepts a valid token and creates the profile row on first contact', async () => {
    const sub = crypto.randomUUID();
    const token = await stub.signToken({ sub, email: 'sarah@example.com' });

    const res = await request(app).get('/me').set(auth(token));

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(sub);
    expect(res.body.user.email).toBe('sarah@example.com');
    // No phone yet: an email-first signup captures it at the profile step, and the app
    // needs to know to ask before the referrer role is available.
    expect(res.body.user.phone).toBeNull();
    expect(res.body.user.needsPhone).toBe(true);
  });

  it('reuses the same profile row on later requests rather than duplicating', async () => {
    const sub = crypto.randomUUID();
    const token = await stub.signToken({ sub, email: 'repeat@example.com' });

    await request(app).get('/me').set(auth(token));
    await request(app).get('/me').set(auth(token));

    const { rows } = await db.query(`select count(*)::int as n from users where id = $1`, [sub]);
    expect(rows[0].n).toBe(1);
  });

  it('follows an email change made in Supabase', async () => {
    const sub = crypto.randomUUID();
    await request(app).get('/me').set(auth(await stub.signToken({ sub, email: 'old@example.com' })));

    const res = await request(app)
      .get('/me')
      .set(auth(await stub.signToken({ sub, email: 'new@example.com' })));

    expect(res.body.user.email).toBe('new@example.com');
  });
});

describe('requireUser: tokens it must reject with 401', () => {
  it('rejects a missing Authorization header', async () => {
    expect((await request(app).get('/me')).status).toBe(401);
  });

  it('rejects garbage', async () => {
    expect((await request(app).get('/me').set(auth('not-a-jwt'))).status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await stub.signToken({ expiresIn: '-1h' });
    expect((await request(app).get('/me').set(auth(token))).status).toBe(401);
  });

  it('rejects a token from a DIFFERENT Supabase project (wrong issuer)', async () => {
    const token = await stub.signToken({ issuer: 'https://someone-elses-project.supabase.co/auth/v1' });
    expect((await request(app).get('/me').set(auth(token))).status).toBe(401);
  });

  it('rejects the project anon key, which is a valid JWT shipped publicly in the app', async () => {
    // aud 'anon' rather than 'authenticated'. Same project, same signing key, not a user.
    // Without the audience check this would sail through and mint a profile row for it.
    const token = await stub.signToken({ audience: 'anon' });
    expect((await request(app).get('/me').set(auth(token))).status).toBe(401);
  });

  it('rejects a token signed by a key the JWKS does not publish', async () => {
    const attacker = await generateKeyPair('ES256', { extractable: true });
    const token = await stub.signToken({ key: attacker.privateKey });
    expect((await request(app).get('/me').set(auth(token))).status).toBe(401);
  });

  it('rejects a token minted before an admin revoked the account', async () => {
    const sub = crypto.randomUUID();
    const before = await stub.signToken({ sub, email: 'revoked@example.com' });
    await request(app).get('/me').set(auth(before)); // creates the row

    await db.query(`update users set sessions_revoked_at = now() where id = $1`, [sub]);

    expect((await request(app).get('/me').set(auth(before))).status).toBe(401);
  });

  it('accepts a token minted AFTER the revocation — signing in again must work', async () => {
    const sub = crypto.randomUUID();
    await request(app).get('/me').set(auth(await stub.signToken({ sub, email: 'again@example.com' })));
    await db.query(`update users set sessions_revoked_at = now() where id = $1`, [sub]);

    // A fresh login a few seconds later. Revocation must not lock the patient out forever.
    const after = await stub.signToken({ sub, issuedAt: Math.floor(Date.now() / 1000) + 5 });
    expect((await request(app).get('/me').set(auth(after))).status).toBe(200);
  });
});

describe('requireUser: when Supabase itself is unreachable', () => {
  // Point the LOADED config at a dead port rather than re-importing the app with different
  // env. Vitest caches modules per file, so a second `import('../src/app.js')` hands back the
  // same instance still holding the original config — an earlier version of this test did
  // exactly that, reached the live stub, got its 200, and would have passed against a
  // requireUser that answered 401 here. supabaseAuth reads config.supabase.jwksUrl at call
  // time, so mutating it is the seam that actually bites.
  it('answers 503, NOT 401, so a blip does not sign every patient out', async () => {
    // A token that is perfectly valid — we simply cannot reach the keys to prove it.
    const token = await stub.signToken({ sub: crypto.randomUUID(), email: 'blip@example.com' });
    const { config } = await import('../src/config.js');
    const live = config.supabase.jwksUrl;

    // Port 1 is reserved and never listening, so this fails at connect, not at parse.
    config.supabase.jwksUrl = 'http://127.0.0.1:1/auth/v1/.well-known/jwks.json';
    supabaseAuth.__resetKeySetForTests();
    try {
      const res = await request(app).get('/me').set(auth(token));
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'auth_unavailable' });
    } finally {
      config.supabase.jwksUrl = live;
      supabaseAuth.__resetKeySetForTests();
    }
  });

  it('recovers once Supabase is reachable again — the 503 is not sticky', async () => {
    const token = await stub.signToken({ sub: crypto.randomUUID(), email: 'recovered@example.com' });
    expect((await request(app).get('/me').set(auth(token))).status).toBe(200);
  });
});

describe('the old OTP endpoints are gone, not merely disabled', () => {
  it('POST /auth/otp/send is 404', async () => {
    expect((await request(app).post('/auth/otp/send').send({ phone: '07700900123' })).status).toBe(404);
  });

  it('POST /auth/otp/verify is 404', async () => {
    expect((await request(app).post('/auth/otp/verify').send({ phone: '07700900123', code: '123456' })).status)
      .toBe(404);
  });
});
