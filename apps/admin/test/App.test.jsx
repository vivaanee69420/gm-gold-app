import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => clearToken());
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function stubDashboardRoutes() {
  return stubFetchRoutes([
    { method: 'GET', path: '/admin/me', body: { role: 'owner', practices: [] } },
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
}

describe('App', () => {
  it('shows the sign-in screen when signed out', () => {
    stubFetchRoutes([]);
    render(<App />);
    expect(screen.getByLabelText(/mobile number/i)).toBeInTheDocument();
  });

  it('shows the operations page by default when signed in', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);

    expect(await screen.findByText('£460.00')).toBeInTheDocument(); // liability
    expect(screen.getByRole('heading', { name: /payout requests/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^pipeline$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /existing-patient review/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /referral record/i })).toBeInTheDocument();
    // Reports & Setup content lives on the other page.
    expect(screen.queryByRole('heading', { name: /^funnel$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /reward levers/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /top referrers/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^dentally$/i })).not.toBeInTheDocument();
  });

  it('switches to the reports & setup page via the topbar nav', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);
    await screen.findByText('£460.00');

    await userEvent.click(screen.getByRole('link', { name: /reports & setup/i }));

    expect(screen.getByRole('heading', { name: /^funnel$/i })).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument(); // tripwire
    expect(screen.getByRole('heading', { name: /reward levers/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /top referrers/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^dentally$/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /payout requests/i })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/reports');
  });

  it('returns to the operations page when the browser goes back', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);
    await screen.findByText('£460.00');
    await userEvent.click(screen.getByRole('link', { name: /reports & setup/i }));

    // Simulate the Back button: the browser restores the URL, then fires popstate.
    window.history.replaceState({}, '', '/');
    fireEvent.popState(window);

    expect(screen.getByRole('heading', { name: /payout requests/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^funnel$/i })).not.toBeInTheDocument();
  });

  it('renders the reports & setup page when loading /reports directly', async () => {
    setToken('tok');
    window.history.replaceState({}, '', '/reports');
    stubDashboardRoutes();
    render(<App />);

    expect(await screen.findByRole('heading', { name: /^funnel$/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /payout requests/i })).not.toBeInTheDocument();
  });

  it('starts on the reports & setup page when returning from Dentally OAuth', async () => {
    setToken('tok');
    window.history.replaceState({}, '', '/?dentally=connected');
    stubDashboardRoutes();
    render(<App />);

    expect(await screen.findByText(/dentally connected/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^dentally$/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/reports');
    expect(window.location.search).toBe('');
  });

  it('renders the manager payout screen for a practice-scoped manager, with no top nav', async () => {
    setToken('tok');
    stubFetchRoutes([
      { method: 'GET', path: '/admin/me', body: { role: 'manager', practices: [{ id: 'pr-sidcup', name: 'Sidcup' }] } },
      { method: 'GET', path: '/admin/payouts', body: { payouts: [] } },
    ]);
    render(<App />);

    expect(await screen.findByRole('heading', { name: /sidcup · payouts/i })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /reports & setup/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
