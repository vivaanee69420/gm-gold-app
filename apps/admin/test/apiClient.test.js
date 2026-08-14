import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setToken, getToken, clearToken, onUnauthorized } from '../src/api/client.js';
import { sendOtp, verifyOtp, signOut, isSignedIn } from '../src/api/auth.js';

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

  it('clears the token and notifies on 401', async () => {
    setToken('stale');
    const handler = vi.fn();
    onUnauthorized(handler);
    fetch.mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));

    await expect(api('/admin/payouts')).rejects.toMatchObject({ status: 401 });
    expect(getToken()).toBe(null);
    expect(handler).toHaveBeenCalled();
  });
});

describe('auth', () => {
  it('verifyOtp stores the token so later calls carry it', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ token: 'fresh-tok', user: { firstName: 'Sam' } }));

    const user = await verifyOtp('07700 900123', '123456');

    expect(user.firstName).toBe('Sam');
    expect(isSignedIn()).toBe(true);

    fetch.mockResolvedValueOnce(jsonResponse({ settings: {} }));
    await api('/admin/settings');
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-tok');
  });

  it('sendOtp posts the phone and returns the dev hint', async () => {
    fetch.mockResolvedValueOnce(jsonResponse({ ok: true, devHint: 'code is 111222' }));

    const out = await sendOtp('07700 900123');

    expect(out.devHint).toBe('code is 111222');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:4000/auth/otp/send');
    expect(JSON.parse(init.body)).toEqual({ phone: '07700 900123' });
  });

  it('signOut clears the stored token', async () => {
    setToken('tok');
    signOut();
    expect(isSignedIn()).toBe(false);
    expect(getToken()).toBe(null);
  });
});
