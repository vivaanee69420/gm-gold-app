import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setToken, getToken, clearToken, onUnauthorized } from '../src/api/client.js';
import { signIn, signOut, isSignedIn } from '../src/api/auth.js';

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  clearToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client', () => {
  it('sends the bearer token and parses JSON', async () => {
    setToken('tok-123');
    fetch.mockResolvedValueOnce(jsonResponse({ ok: true }));

    const out = await api('/admin/settings');

    expect(out).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:4000/admin/settings');
    expect(init.headers.Authorization).toBe('Bearer tok-123');
  });

  it('throws the server error code on non-2xx', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'below_threshold' }, 409));

    await expect(api('/payouts', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 409,
      code: 'below_threshold',
    });
  });

  it('clears the token and notifies on a session-loss 401 (error: unauthorized)', async () => {
    setToken('stale');
    const handler = vi.fn();
    onUnauthorized(handler);
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(api('/admin/payouts')).rejects.toMatchObject({ status: 401 });
    expect(getToken()).toBe(null);
    expect(handler).toHaveBeenCalled();
  });

  it('keeps the session on a non-session 401 (e.g. wrong_password) — just throws', async () => {
    setToken('still-good');
    const handler = vi.fn();
    onUnauthorized(handler);
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'wrong_password' }, 401));

    await expect(api('/admin/me/password', { method: 'POST', body: {} })).rejects.toMatchObject({
      status: 401,
      code: 'wrong_password',
    });
    expect(getToken()).toBe('still-good');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('auth', () => {
  it('signIn posts email + password, stores the token, and returns the admin', async () => {
    fetch.mockResolvedValueOnce(
      jsonResponse({
        token: 'fresh-tok',
        admin: { id: 'a1', email: 'sam@gmdental.co.uk', role: 'admin', practices: [] },
      }),
    );

    const admin = await signIn('sam@gmdental.co.uk', 'correcthorsebattery');

    expect(admin).toEqual({ id: 'a1', email: 'sam@gmdental.co.uk', role: 'admin', practices: [] });
    expect(isSignedIn()).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:4000/auth/admin/login');
    expect(JSON.parse(init.body)).toEqual({ email: 'sam@gmdental.co.uk', password: 'correcthorsebattery' });

    fetch.mockResolvedValueOnce(jsonResponse({ settings: {} }));
    await api('/admin/settings');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-tok');
  });

  it('signOut clears the stored token', async () => {
    setToken('tok');
    signOut();
    expect(isSignedIn()).toBe(false);
    expect(getToken()).toBe(null);
  });
});
