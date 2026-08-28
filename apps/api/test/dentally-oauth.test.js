// Dentally OAuth connection flow: authorize URL, callback exchange, mode flip,
// token auto-refresh, disconnect. Dentally's endpoints are mocked at the fetch layer.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

process.env.PGLITE_MEMORY = '1';
process.env.DENTALLY_CLIENT_ID = 'test-client-id';
process.env.DENTALLY_CLIENT_SECRET = 'test-client-secret';

let app;
let db;
let conn;
const agents = {};
const fetchCalls = [];

const mkRes = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
  headers: { get: () => null },
});

beforeAll(async () => {
  vi.stubGlobal('fetch', async (url, options = {}) => {
    fetchCalls.push({ url: String(url), body: String(options.body ?? '') });
    if (String(url).includes('/oauth/token')) {
      const params = new URLSearchParams(String(options.body));
      if (params.get('client_secret') !== 'test-client-secret') return mkRes({ error: 'invalid_client' }, 401);
      const grant = params.get('grant_type');
      return mkRes({
        access_token: grant === 'refresh_token' ? 'access-2' : 'access-1',
        refresh_token: grant === 'refresh_token' ? 'refresh-2' : 'refresh-1',
        token_type: 'Bearer',
        scope: 'patient:read appointment:read financials:read practice:read user:read',
        expires_in: 7200,
      });
    }
    return mkRes({}); // any live API call the post-connect sync makes: empty pages
  });

  const { initDb, db: database } = await import('../src/db.js');
  await initDb();
  db = database;
  conn = await import('../src/services/dentally/connectionService.js');
  const { buildApp } = await import('../src/app.js');
  app = buildApp();

  // Dynamic import: a static one would pull in config.js (via adminService.js) before the
  // DENTALLY_CLIENT_ID/SECRET env vars above are set, since ES module imports are hoisted
  // ahead of them.
  const { adminSession } = await import('./helpers/admin.js');
  agents.admin = (await adminSession(app)).token;
});

const auth = () => ({ Authorization: `Bearer ${agents.admin}` });

describe('Dentally OAuth', () => {
  it('status: configured but not connected → stub mode', async () => {
    const res = await request(app).get('/admin/dentally/status').set(auth());
    expect(res.body).toMatchObject({ mode: 'stub', oauthConfigured: true, envToken: false, connection: null });
  });

  it('connect returns the Dentally authorize URL with a signed state', async () => {
    const res = await request(app).post('/admin/dentally/connect').set(auth()).send({});
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.href).toContain('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toContain('patient:read');
    agents.state = url.searchParams.get('state');
    expect(agents.state).toBeTruthy();
  });

  it('callback exchanges the code, stores tokens, flips mode to live', async () => {
    const res = await request(app).get(`/oauth/dentally/callback?code=auth-code-1&state=${agents.state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://localhost:5173/?dentally=connected');

    const exchange = fetchCalls.find((c) => c.body.includes('grant_type=authorization_code'));
    expect(exchange.body).toContain('code=auth-code-1');

    const status = await request(app).get('/admin/dentally/status').set(auth());
    expect(status.body.mode).toBe('live');
    expect(status.body.connection.scope).toContain('appointment:read');
  });

  it('rejects a forged state', async () => {
    const res = await request(app).get('/oauth/dentally/callback?code=x&state=forged');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('dentally=error');
    expect(res.headers.location).toContain('oauth_state_invalid');
  });

  it('auto-refreshes an expiring access token (rotated tokens persisted)', async () => {
    await db.query(`update dentally_oauth set expires_at = now() - interval '1 minute'`);
    conn.invalidateConnectionCache();
    const token = await conn.getAccessToken();
    expect(token).toBe('access-2');
    const { rows } = await db.query(`select access_token, refresh_token from dentally_oauth`);
    expect(rows[0]).toMatchObject({ access_token: 'access-2', refresh_token: 'refresh-2' });
  });

  it('disconnect drops back to stub mode', async () => {
    const res = await request(app).post('/admin/dentally/disconnect').set(auth()).send({});
    expect(res.status).toBe(200);
    const status = await request(app).get('/admin/dentally/status').set(auth());
    expect(status.body).toMatchObject({ mode: 'stub', connection: null });
  });
});
