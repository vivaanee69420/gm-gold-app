// API client with a self-healing mock fallback.
//
//   app screens ──▶ api.* ──▶ fetch EXPO_PUBLIC_API_URL ──▶ Express (apps/api)
//                      │
//                      └─(network error / no API yet)──▶ in-memory mock fixtures
//
// The mock keeps the UI fully browsable before/without the backend; every call
// reports `source: 'live' | 'mock'` so the shell can show a dev banner.

import Constants from 'expo-constants';
import { currentAccessToken } from '../lib/supabase';

// Resolve the API host: explicit env wins; otherwise reuse the Expo dev-server host
// (so a phone on the same Wi-Fi finds the API without configuration).
function resolveBaseUrl() {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost ?? '';
  const host = hostUri.split(':')[0];
  return host ? `http://${host}:4000` : 'http://localhost:4000';
}
const BASE_URL = resolveBaseUrl();

let mockMode = false;
let liveSeen = false; // once the real API has answered, never silently swap to mock
export const isMockMode = () => mockMode;

// ---------- mock fixtures (mirror the API's response shapes) ----------
const mock = {
  user: null,
  practices: [
    { id: '11111111-1111-4111-8111-111111111111', name: 'Ashford', bookingUrl: 'https://booking.dentally.co/mock/ashford' },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Barnet', bookingUrl: 'https://booking.dentally.co/mock/barnet' },
    { id: '33333333-3333-4333-8333-333333333333', name: 'Bexleyheath', bookingUrl: 'https://booking.dentally.co/mock/bexleyheath' },
    { id: '44444444-4444-4444-8444-444444444444', name: 'Rochester', bookingUrl: 'https://booking.dentally.co/mock/rochester' },
  ],
  referrals: [
    { id: 'r1', friendName: 'Priya M.', status: 'booked', createdAt: '2026-08-02' },
    { id: 'r2', friendName: 'Tom H.', status: 'treatment_completed', creditPennies: 2000, createdAt: '2026-07-11' },
    { id: 'r3', friendName: 'Aisha K.', status: 'new', createdAt: '2026-08-13' },
    { id: 'r4', friendName: 'Dan W.', status: 'attended', createdAt: '2026-07-28' },
  ],
  wallet: {
    balancePennies: 6000,
    thresholdPennies: 10000,
    lifetimePennies: 14000,
    openPayout: null,
    ledger: [
      { id: 'l1', kind: 'credit', amountPennies: 2000, note: 'Tom H. completed treatment', at: '2026-08-01' },
      { id: 'l2', kind: 'credit', amountPennies: 2000, note: 'Referral completed', at: '2026-07-02' },
      { id: 'l3', kind: 'credit', amountPennies: 2000, note: 'Referral completed', at: '2026-06-15' },
      { id: 'l4', kind: 'debit', amountPennies: -8000, note: 'Collected at Ashford', at: '2026-06-20' },
    ],
  },
};

function mockRespond(path, options = {}) {
  const body = options.body ? JSON.parse(options.body) : {};
  if (path === '/me') return { user: mock.user, source: 'mock' };
  if (path === '/me/profile') {
    mock.user = mock.user ?? { phone: null, firstName: null, roles: [] };
    Object.assign(mock.user, { firstName: body.firstName, lastName: body.lastName, notifyOptIn: body.notifyOptIn });
    return { ok: true, user: mock.user };
  }
  if (path === '/me/role') {
    mock.user = mock.user ?? { phone: null, firstName: null, roles: [] };
    mock.user.roles = [...new Set([...(mock.user.roles || []), body.role])];
    if (body.role === 'referrer') {
      mock.user.referralCode = 'GMRF7K2X';
    }
    return { ok: true, user: mock.user };
  }
  if (path === '/practices') return { practices: mock.practices };
  if (path === '/referrals/mine') return { referrals: mock.referrals };
  if (path === '/wallet') return { wallet: mock.wallet };
  if (path === '/referrals') {
    return {
      ok: true,
      referral: { id: 'r-new', status: 'new' },
      practiceName: mock.practices.find((p) => p.id === body.preferredPracticeId)?.name ?? 'the practice',
      bookingUrl: null,
    };
  }
  if (path === '/referrals/referred-status') {
    return { status: 'new', practiceName: 'Ashford', referrerName: 'Sarah', bookingUrl: null, appointmentStartsAt: null };
  }
  if (path === '/payouts') {
    mock.wallet.openPayout = { id: 'p1', amountPennies: mock.wallet.balancePennies, practiceName: 'Ashford', status: 'open' };
    return { ok: true, payout: mock.wallet.openPayout };
  }
  if (path.startsWith('/payouts/') && options.method === 'DELETE') {
    mock.wallet.openPayout = null;
    return { ok: true };
  }
  return { error: 'mock_not_implemented', path };
}

// ---------- transport ----------
async function request(path, { method = 'GET', body } = {}) {
  // supabase-js refreshes the access token in the background, so ask it every call rather
  // than caching one here — a cached token is exactly how you end up sending an expired one.
  const token = await currentAccessToken();
  const options = {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };
  try {
    const controller = new AbortController();
    // Generous: /me/role verifies against the Dental Os patient index and can
    // take several seconds; an abort mid-write must not masquerade as success.
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${BASE_URL}${path}`, { ...options, signal: controller.signal });
    clearTimeout(timer);
    mockMode = false;
    liveSeen = true;
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json.error || `http_${res.status}`), { api: true, payload: json });
    return json;
  } catch (err) {
    if (err.api) throw err; // real API said no — surface it
    if (liveSeen) {
      // The backend exists but this call failed (offline blip, timeout). Faking a
      // mock answer here would show stale or false state — surface it instead.
      throw Object.assign(new Error('network_unavailable'), { network: true });
    }
    mockMode = true; // backend never reachable — preview mode keeps the UI browsable
    return mockRespond(path, options);
  }
}

// saveToken/clearToken are gone: the session belongs to supabase-js, which persists it in
// the OS keychain (see lib/supabase.js). Signing out is supabase.auth.signOut().

// ---------- surface ----------
export const api = {
  // No sign-in call here any more. The app talks to Supabase Auth directly
  // (state/AppState.js) and this client just carries the resulting access token.
  me: () => request('/me'),
  saveProfile: (profile) => request('/me/profile', { method: 'POST', body: profile }),
  pickRole: (role) => request('/me/role', { method: 'POST', body: { role } }),
  practices: () => request('/practices'),
  myReferrals: () => request('/referrals/mine'),
  wallet: () => request('/wallet'),
  submitReferral: (payload) => request('/referrals', { method: 'POST', body: payload }),
  referredStatus: () => request('/referrals/referred-status'),
  requestPayout: (practiceId) => request('/payouts', { method: 'POST', body: { practiceId } }),
  cancelPayout: (id) => request(`/payouts/${id}`, { method: 'DELETE' }),
};
