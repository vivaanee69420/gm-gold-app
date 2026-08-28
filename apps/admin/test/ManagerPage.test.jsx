import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ManagerPage from '../src/pages/ManagerPage.jsx';
import { clearToken, setToken } from '../src/api/client.js';
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
});
