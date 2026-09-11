// The 'code-sent' rule: a resend must not throw away a sign-up that is halfway through.
//
// pendingProfile holds the name and phone typed on the sign-up screen, waiting for a verified
// session to attach them to. Defaulting it to null on every 'code-sent' meant that asking for
// a new code — the thing you do when the first email has not arrived — silently emptied it and
// dumped the user back on the Profile screen to type it all again.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// AppState pulls in the Supabase client (expo-secure-store, the URL polyfill) and the API
// client at import time. None of that is under test here and none of it works in jsdom.
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithOtp: vi.fn(),
      verifyOtp: vi.fn(),
      getSession: vi.fn(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  },
  clearLegacySession: vi.fn(),
  isAuthConfigured: true,
  currentAccessToken: vi.fn(),
}));
vi.mock('../src/api/client', () => ({ api: { me: vi.fn(), saveProfile: vi.fn() } }));

const { reducer } = await import('../src/state/AppState');

const signingUp = {
  booted: true,
  user: null,
  pendingEmail: 'nina@example.com',
  pendingProfile: { firstName: 'Nina', phone: '+447700900830' },
  authError: null,
};

describe("reducer 'code-sent'", () => {
  it('keeps the pending profile when the code is resent to the same address', () => {
    const next = reducer(signingUp, { type: 'code-sent', email: 'nina@example.com' });
    expect(next.pendingProfile, 'a resend is the same sign-up, still in progress')
      .toEqual(signingUp.pendingProfile);
    expect(next.pendingEmail).toBe('nina@example.com');
  });

  it('clears the pending profile when a code goes to a different address', () => {
    // Backing out and starting again with another email is a different sign-up, and carrying
    // the old name and phone into it would attach one person's details to another's account.
    const next = reducer(signingUp, { type: 'code-sent', email: 'someone.else@example.com' });
    expect(next.pendingProfile).toBeNull();
    expect(next.pendingEmail).toBe('someone.else@example.com');
  });

  it('takes an explicitly supplied profile over the one it is holding', () => {
    const fresh = { firstName: 'Omar', phone: '+447700900831' };
    const next = reducer(signingUp, { type: 'code-sent', email: 'nina@example.com', profile: fresh });
    expect(next.pendingProfile).toEqual(fresh);
  });

  it('holds nothing for a sign-in, which has no profile to keep', () => {
    const signingIn = { ...signingUp, pendingProfile: null };
    const next = reducer(signingIn, { type: 'code-sent', email: 'nina@example.com' });
    expect(next.pendingProfile).toBeNull();
  });

  it('clears any previous auth error', () => {
    const next = reducer({ ...signingUp, authError: 'otp_expired' }, { type: 'code-sent', email: 'nina@example.com' });
    expect(next.authError).toBeNull();
  });
});

describe("reducer 'signed-in'", () => {
  it('drops the pending profile once it has been attached to a real user', () => {
    // The counterpart to the rule above: pendingProfile must NOT survive a successful
    // sign-in, or a later resend on a different screen could re-apply stale details.
    const next = reducer(signingUp, { type: 'signed-in', user: { email: 'nina@example.com' } });
    expect(next.pendingProfile).toBeNull();
    expect(next.pendingEmail).toBeNull();
    expect(next.user).toEqual({ email: 'nina@example.com' });
  });
});
