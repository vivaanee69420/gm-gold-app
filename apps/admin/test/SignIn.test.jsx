import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SignIn from '../src/components/SignIn.jsx';
import { clearToken, getToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => clearToken());
afterEach(() => vi.unstubAllGlobals());

describe('SignIn', () => {
  it('posts email + password and signs in', async () => {
    stubFetchRoutes([
      {
        method: 'POST',
        path: '/auth/admin/login',
        body: { token: 'tok-1', admin: { id: 'a1', email: 'sam@gmdental.co.uk', role: 'admin', practices: [] } },
      },
    ]);
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} />);

    await userEvent.type(screen.getByLabelText(/email/i), 'sam@gmdental.co.uk');
    await userEvent.type(screen.getByLabelText(/password/i), 'correcthorsebattery');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(onSignedIn).toHaveBeenCalledWith({ id: 'a1', email: 'sam@gmdental.co.uk', role: 'admin', practices: [] });
    expect(getToken()).toBe('tok-1');
  });

  it('shows the invalid_credentials copy on a 401', async () => {
    stubFetchRoutes([
      { method: 'POST', path: '/auth/admin/login', body: { error: 'invalid_credentials' }, status: 401 },
    ]);
    render(<SignIn onSignedIn={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/email/i), 'sam@gmdental.co.uk');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrongpassword');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('Email or password is wrong.')).toBeInTheDocument();
  });

  it('has the right input types and autocomplete hints', () => {
    stubFetchRoutes([]);
    render(<SignIn onSignedIn={vi.fn()} />);

    const email = screen.getByLabelText(/email/i);
    const password = screen.getByLabelText(/password/i);
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autoComplete', 'username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autoComplete', 'current-password');
  });
});
