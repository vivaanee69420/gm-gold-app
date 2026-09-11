// "Email it again" on the Verify screen used to call sendCode(pendingEmail) bare. Two things
// fell out of that, and the reducer guard only covers one of them:
//
//   1. no `profile`  -> the half-finished sign-up was wiped (now also guarded in the reducer)
//   2. no createUser -> shouldCreateUser quietly went false, so the resend was a SIGN-IN
//                       request for an address that may not have an account yet
//
// This asserts the call itself, which is the only place intent (2) can be checked.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const RESEND_COOLDOWN_SECONDS = 60;

const appState = {
  verifyCode: vi.fn(),
  sendCode: vi.fn().mockResolvedValue(undefined),
  pendingEmail: 'nina@example.com',
  pendingProfile: null,
};

vi.mock('../src/state/AppState', () => ({
  useAppState: () => appState,
  AppStateProvider: ({ children }) => children,
}));

const { VerifyScreen } = await import('../src/screens/auth');

// The countdown is a chain, not a single timer: each tick sets state, and the effect that
// reacts to the new value schedules the next timeout. So the clock has to be advanced one
// second at a time with a render in between — advancing 60s in one jump only ever fires the
// one timeout that existed when the jump started.
async function tick(seconds) {
  for (let i = 0; i < seconds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

/** The resend button is disabled for the first minute; run the cooldown down to zero. */
const clearCooldown = () => tick(RESEND_COOLDOWN_SECONDS);

beforeEach(() => {
  vi.useFakeTimers();
  appState.sendCode.mockClear();
  appState.pendingProfile = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VerifyScreen resend', () => {
  it('carries the pending profile and createUser on a sign-up resend', async () => {
    appState.pendingProfile = { firstName: 'Nina', phone: '+447700900830' };
    render(<VerifyScreen navigation={{ navigate: vi.fn(), replace: vi.fn() }} />);

    await clearCooldown();
    fireEvent.click(screen.getByText('Email it again'));
    await act(async () => {});

    expect(appState.sendCode).toHaveBeenCalledTimes(1);
    const [email, options] = appState.sendCode.mock.calls[0];
    expect(email).toBe('nina@example.com');
    expect(options.profile, 'the name and phone must survive a resend')
      .toEqual({ firstName: 'Nina', phone: '+447700900830' });
    expect(options.createUser, 'a sign-up resend is still a sign-up').toBe(true);
  });

  it('does not claim to create a user on a sign-in resend', async () => {
    // No pendingProfile means this screen was reached from the sign-in door, where an unknown
    // address must be REJECTED rather than turned into an empty new account.
    appState.pendingProfile = null;
    render(<VerifyScreen navigation={{ navigate: vi.fn(), replace: vi.fn() }} />);

    await clearCooldown();
    fireEvent.click(screen.getByText('Email it again'));
    await act(async () => {});

    expect(appState.sendCode).toHaveBeenCalledTimes(1);
    const [, options] = appState.sendCode.mock.calls[0];
    expect(options.createUser).toBe(false);
    expect(options.profile).toBeNull();
  });

  it('will not resend while the cooldown is still running', async () => {
    render(<VerifyScreen navigation={{ navigate: vi.fn(), replace: vi.fn() }} />);

    // The button is labelled with the countdown and disabled for the first minute.
    expect(screen.getByText(`Email it again in ${RESEND_COOLDOWN_SECONDS}s`)).toBeInTheDocument();
    await tick(5);
    fireEvent.click(screen.getByText(`Email it again in ${RESEND_COOLDOWN_SECONDS - 5}s`));
    await act(async () => {});

    expect(appState.sendCode).not.toHaveBeenCalled();
  });
});
