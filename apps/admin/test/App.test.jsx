import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import { clearToken, getToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => clearToken());
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function stubDashboardRoutes() {
  return stubFetchRoutes([
    { method: 'GET', path: '/admin/me', body: { role: 'admin', practices: [] } },
    { method: 'GET', path: '/admin/team', body: { team: [] } },
    { method: 'GET', path: '/admin/settings', body: { settings: { payout_threshold_pennies: '10000', payout_expiry_days: '90' } } },
    { method: 'GET', path: '/admin/stats', body: { stats: { commissionPennies: 2000, liabilityPennies: 46000, referralCounts: { new: 2, booked: 1 } } } },
    { method: 'GET', path: '/admin/payouts', body: { payouts: [] } },
    { method: 'GET', path: '/admin/referrals', body: { referrals: [] } },
    { method: 'GET', path: '/admin/patients', body: { patients: [] } },
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
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  });

  it('shows no nav links before /admin/me resolves — fails closed, not open to every page', () => {
    // A permission gate must fail closed: before we know the role, show nothing rather than
    // defaulting to the admin's full page set (which would flash Operations and Reports &
    // Setup at a manager on every sign-in). Asserted synchronously, right after render and
    // before any `await`, so the /admin/me fetch's promise has had no chance to resolve yet.
    stubDashboardRoutes();
    setToken('tok');
    render(<App />);

    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: /^operations$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /reports & setup/i })).not.toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows the pipeline page by default when signed in', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);

    expect(await screen.findByText('£460.00')).toBeInTheDocument(); // liability
    expect(screen.getByRole('heading', { name: /^pipeline$/i })).toBeInTheDocument();
    // Operations content — the queues and the referral record — now lives on its own page.
    expect(screen.queryByRole('heading', { name: /payout requests/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /existing-patient review/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /referral record/i })).not.toBeInTheDocument();
    // Reports & Setup content lives on the other page.
    expect(screen.queryByRole('heading', { name: /^funnel$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /reward levers/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /top referrers/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^dentally$/i })).not.toBeInTheDocument();
  });

  it('switches to the operations page via the topbar nav', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);
    await screen.findByText('£460.00');

    await userEvent.click(screen.getByRole('link', { name: /^operations$/i }));

    expect(screen.getByRole('heading', { name: /existing-patient review/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /referral record/i })).toBeInTheDocument();
    // Pipeline and payouts are their own pages now — not rendered twice inside Operations.
    expect(screen.queryByRole('heading', { name: /^pipeline$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /payout requests/i })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/operations');
  });

  it('switches to the payouts page via the topbar nav', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);
    await screen.findByText('£460.00');

    await userEvent.click(screen.getByRole('link', { name: /^payouts$/i }));

    expect(screen.getByRole('heading', { name: /payout requests/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/payouts');
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
    expect(screen.getByRole('heading', { name: /^team$/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /payout requests/i })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/reports');
  });

  it('toggles the change password form from the header ghost button and stores the new token', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);
    await screen.findByText('£460.00');

    expect(screen.queryByRole('heading', { name: /change password/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /change password/i }));
    expect(screen.getByRole('heading', { name: /change password/i })).toBeInTheDocument();

    stubFetchRoutes([
      { method: 'POST', path: '/admin/me/password', body: { ok: true, token: 'new-tok' } },
    ]);
    await userEvent.type(screen.getByLabelText(/current password/i), 'oldpassword1');
    await userEvent.type(screen.getByLabelText(/new password/i), 'brandnewpassword1');
    await userEvent.click(screen.getByRole('button', { name: /save password/i }));

    await vi.waitFor(() => expect(getToken()).toBe('new-tok'));
    expect(screen.queryByRole('heading', { name: /change password/i })).not.toBeInTheDocument();
  });

  it('returns to the pipeline page when the browser goes back', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);
    await screen.findByText('£460.00');
    await userEvent.click(screen.getByRole('link', { name: /reports & setup/i }));

    // Simulate the Back button: the browser restores the URL, then fires popstate.
    window.history.replaceState({}, '', '/');
    fireEvent.popState(window);

    expect(screen.getByRole('heading', { name: /^pipeline$/i })).toBeInTheDocument();
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

  it('shows a clear message instead of crashing for a manager with no practice assigned', async () => {
    setToken('tok');
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/me', body: { id: 'm2', email: 'm2@x.co', role: 'manager', practices: [] } },
    ]);
    render(<App />);

    expect(
      await screen.findByText(/no practice is assigned to this account — ask the owner to fix it/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
    // Nothing to scope a query to — don't hit the API just to render nothing.
    expect(calls.map((c) => c.path)).toEqual(['/admin/me']);
  });
});

describe('role-driven navigation', () => {
  const managerRoutes = [
    { method: 'GET', path: '/admin/me', body: { id: 'm1', email: 'm@x.co', role: 'manager', practices: [{ id: 'p1', name: 'Ashford' }] } },
    { method: 'GET', path: '/admin/stats', body: { stats: { commissionPennies: 10000, liabilityPennies: null, creditedPennies: 5000, referralCounts: {} } } },
    { method: 'GET', path: '/admin/payouts', body: { payouts: [] } },
    { method: 'GET', path: '/admin/referrals', body: { referrals: [] } },
    { method: 'GET', path: '/admin/patients', body: { patients: [] } },
  ];

  it('gives a manager pipeline, patients and payouts — and no setup nav', async () => {
    const calls = stubFetchRoutes(managerRoutes);
    setToken('tok');
    render(<App />);

    expect(await screen.findByRole('link', { name: /pipeline/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /patients/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /payouts/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /reports & setup/i })).not.toBeInTheDocument();

    // A manager must never trigger a request they are not allowed to make. Asserted as an
    // exact set (not a denylist of the known-forbidden ones) so any call to an endpoint not on
    // this list — a typo, a future addition to the admin-only Promise.all, `/admin/aging`,
    // `/admin/reports/funnel`, anything — fails this test regardless of which endpoint it is.
    await vi.waitFor(() => {
      expect([...new Set(calls.map((c) => c.path))].sort()).toEqual(
        ['/admin/me', '/admin/patients', '/admin/payouts', '/admin/referrals', '/admin/stats'].sort(),
      );
    });
  });

  it('shows the manager their practice name', async () => {
    stubFetchRoutes(managerRoutes);
    setToken('tok');
    render(<App />);
    expect(await screen.findByText(/ashford/i)).toBeInTheDocument();
  });
});
