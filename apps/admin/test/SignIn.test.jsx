import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SignIn from '../src/components/SignIn.jsx';
import { clearToken, getToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => clearToken());
afterEach(() => vi.unstubAllGlobals());

describe('SignIn', () => {
  it('walks phone → dev-hinted code → signed in', async () => {
    stubFetchRoutes([
      { method: 'POST', path: '/auth/otp/send', body: { ok: true, devHint: 'dev code: 111222' } },
      { method: 'POST', path: '/auth/otp/verify', body: { token: 'tok-1', user: { firstName: 'Sam' } } },
    ]);
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText(/mobile number/i), '07700 900123');
    await userEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(await screen.findByText(/111222/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/6-digit code/i), '111222');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(onSignedIn).toHaveBeenCalledWith({ firstName: 'Sam' });
    expect(getToken()).toBe('tok-1');
  });

  it('surfaces a failed code check', async () => {
    stubFetchRoutes([
      { method: 'POST', path: '/auth/otp/send', body: { ok: true, devHint: 'dev code: 111222' } },
      { method: 'POST', path: '/auth/otp/verify', body: { error: 'invalid_code' }, status: 401 },
    ]);
    render(<SignIn onSignedIn={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/mobile number/i), '07700 900123');
    await userEvent.click(screen.getByRole('button', { name: /send code/i }));
    await userEvent.type(await screen.findByLabelText(/6-digit code/i), '000000');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/invalid_code/)).toBeInTheDocument();
  });
});
