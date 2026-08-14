import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '../src/App.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => clearToken());
afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('shows the sign-in screen when signed out', () => {
    stubFetchRoutes([]);
    render(<App />);
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
  });

  it('loads and lays out the dashboard when signed in', async () => {
    setToken('tok');
    stubFetchRoutes([
      { method: 'GET', path: '/admin/settings', body: { settings: { payout_threshold_pennies: '10000', payout_expiry_days: '90' } } },
      { method: 'GET', path: '/admin/stats', body: { stats: { commissionPennies: 2000, liabilityPennies: 46000, referralCounts: { new: 2, booked: 1 } } } },
      { method: 'GET', path: '/admin/payouts', body: { payouts: [] } },
      { method: 'GET', path: '/admin/referrals', body: { referrals: [] } },
    ]);
    render(<App />);

    expect(await screen.findByText('£460.00')).toBeInTheDocument(); // liability
    expect(screen.getByRole('heading', { name: /reward levers/i })).toBeInTheDocument();
    expect(screen.getByText(/dentally/i)).toBeInTheDocument(); // confirm-queue empty state
    expect(screen.getByRole('heading', { name: /payout requests/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^pipeline$/i })).toBeInTheDocument();
  });
});
