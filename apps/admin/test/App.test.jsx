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
      { method: 'GET', path: '/admin/proposals', body: { proposals: [] } },
      { method: 'GET', path: '/admin/verifications', body: { verifications: [] } },
      { method: 'GET', path: '/admin/aging', body: { aging: [], days: 7 } },
      { method: 'GET', path: '/admin/dentally/status', body: { mode: 'stub', connected: false } },
      { method: 'GET', path: '/admin/referral-review', body: { reviews: [] } },
      {
        method: 'GET',
        path: '/admin/reports/funnel',
        body: {
          funnel: {
            inviteSent: 0, appActivated: 4, shareTapped: 9, codeEntered: 2, referralSubmitted: 1,
            consultBooked: 1, treatmentCompleted: 0, commissionsCredited: 0, payoutsPaid: 0,
            tripwireRate: 0.5,
          },
        },
      },
      { method: 'GET', path: '/admin/reports/top-referrers', body: { topReferrers: [] } },
    ]);
    render(<App />);

    expect(await screen.findByText('£460.00')).toBeInTheDocument(); // liability
    expect(screen.getByRole('heading', { name: /reward levers/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /payout requests/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^pipeline$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /existing-patient review/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^funnel$/i })).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument(); // tripwire
    expect(screen.getByRole('heading', { name: /top referrers/i })).toBeInTheDocument();
  });
});
