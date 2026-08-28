import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChangePassword from '../src/components/ChangePassword.jsx';
import { clearToken, getToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => {
  clearToken();
  setToken('old-tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('ChangePassword', () => {
  it('posts current + new password and stores the returned token', async () => {
    const calls = stubFetchRoutes([
      { method: 'POST', path: '/admin/me/password', body: { ok: true, token: 'new-tok' } },
    ]);
    const onDone = vi.fn();
    render(<ChangePassword notify={vi.fn()} onDone={onDone} />);

    await userEvent.type(screen.getByLabelText(/current password/i), 'oldpassword1');
    await userEvent.type(screen.getByLabelText(/new password/i), 'brandnewpassword1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));

    await vi.waitFor(() => expect(getToken()).toBe('new-tok'));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/me/password',
      body: { currentPassword: 'oldpassword1', newPassword: 'brandnewpassword1' },
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('notifies wrong_password on a 401, keeps the session, and leaves the form up', async () => {
    stubFetchRoutes([
      { method: 'POST', path: '/admin/me/password', body: { error: 'wrong_password' }, status: 401 },
    ]);
    const notify = vi.fn();
    const onDone = vi.fn();
    render(<ChangePassword notify={notify} onDone={onDone} />);

    await userEvent.type(screen.getByLabelText(/current password/i), 'wrongoldpassword');
    await userEvent.type(screen.getByLabelText(/new password/i), 'brandnewpassword1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('wrong_password'));
    // wrong_password is not a session-loss 401 — the client only treats
    // error: 'unauthorized' that way — so the existing token is untouched
    // and the form stays mounted for another attempt.
    expect(getToken()).toBe('old-tok');
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /save password/i })).toBeInTheDocument();
  });

  it('notifies weak_password on a 422', async () => {
    stubFetchRoutes([
      { method: 'POST', path: '/admin/me/password', body: { error: 'weak_password' }, status: 422 },
    ]);
    const notify = vi.fn();
    render(<ChangePassword notify={notify} onDone={vi.fn()} />);

    await userEvent.type(screen.getByLabelText(/current password/i), 'oldpassword1');
    await userEvent.type(screen.getByLabelText(/new password/i), 'short');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('weak_password'));
  });
});
