import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ManagerPage from '../src/pages/ManagerPage.jsx';
import { clearToken, getToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('ManagerPage', () => {
  // Controller ruling (2026-08-28 final review): a manager granted no practice yet must
  // not white-screen on `me.practices[0].name`, and must not be shown a payout queue —
  // the API's own empty-scope rule would always return it empty anyway.
  it('shows an explicit empty state instead of the queue when no practice is assigned', () => {
    const calls = stubFetchRoutes([{ method: 'GET', path: '/admin/payouts', body: { payouts: [] } }]);
    render(<ManagerPage me={{ role: 'manager', practices: [] }} notify={vi.fn()} onSignOut={vi.fn()} />);

    expect(screen.getByRole('heading', { name: /payouts/i })).toBeInTheDocument();
    expect(
      screen.getByText(/no practice is assigned to this account — ask the owner to fix it/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    // No queue to populate, so /admin/payouts should never have been called.
    expect(calls).toHaveLength(0);
  });

  it('renders the practice name and loads the queue when a practice is assigned', async () => {
    stubFetchRoutes([{ method: 'GET', path: '/admin/payouts', body: { payouts: [] } }]);
    render(<ManagerPage me={{ role: 'manager', practices: [{ id: 'pr-1', name: 'Sidcup' }] }} notify={vi.fn()} onSignOut={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: /sidcup · payouts/i })).toBeInTheDocument();
    expect(screen.queryByText(/no practice is assigned/i)).not.toBeInTheDocument();
  });

  it('toggles the change password form from the header ghost button and stores the new token', async () => {
    stubFetchRoutes([
      { method: 'GET', path: '/admin/payouts', body: { payouts: [] } },
      { method: 'POST', path: '/admin/me/password', body: { ok: true, token: 'new-tok' } },
    ]);
    render(<ManagerPage me={{ role: 'manager', practices: [{ id: 'pr-1', name: 'Sidcup' }] }} notify={vi.fn()} onSignOut={vi.fn()} />);
    await screen.findByRole('heading', { name: /sidcup · payouts/i });

    expect(screen.queryByRole('heading', { name: /change password/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));
    expect(screen.getByRole('heading', { name: /change password/i })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/current password/i), 'oldpassword1');
    await userEvent.type(screen.getByLabelText(/new password/i), 'brandnewpassword1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));

    await vi.waitFor(() => expect(getToken()).toBe('new-tok'));
    expect(screen.queryByRole('heading', { name: /change password/i })).not.toBeInTheDocument();
  });
});
