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

  it('notifies wrong_password on a 401 and does not store a new token', async () => {
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
    // A 401 (any 401) clears the stored token via the shared api client — it does not
    // leave the stale token or the (never-issued) new one behind.
    expect(getToken()).toBe(null);
    expect(onDone).not.toHaveBeenCalled();
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
