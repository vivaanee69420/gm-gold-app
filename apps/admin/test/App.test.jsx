import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import { clearToken, getToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

beforeEach(() => clearToken());
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});

function dashboardRoutes() {
  return [
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
  ];
}

const stubDashboardRoutes = () => stubFetchRoutes(dashboardRoutes());

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
    expect(screen.queryByRole('heading', { name: /payout requests/i })).not.toBeInTheDocument();
    // Team and the Dentally connection are configuration, and live on Settings now.
    expect(screen.queryByRole('heading', { name: /^dentally$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^team$/i })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/reports');
  });

  it('makes Settings its own place, with its own sidebar and sections', async () => {
    setToken('tok');
    stubDashboardRoutes();
    render(<App />);
    await screen.findByText('£460.00');

    await userEvent.click(screen.getByRole('link', { name: /^settings$/i }));

    // The dashboard nav is gone while you are in here — Settings has its own sidebar.
    expect(screen.queryByRole('link', { name: /^pipeline$/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      '/settings', '/settings/integrations', '/settings/account',
    ]);

    // Team is where Settings opens.
    expect(await screen.findByRole('heading', { name: /^team$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /integrations/i }));
    expect(screen.getByRole('heading', { name: /^dentally$/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/integrations');

    await userEvent.click(screen.getByRole('link', { name: /your account/i }));
    expect(screen.getByRole('heading', { name: /change password/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/account');
  });

  it('opens one team member on their own screen, not inside a table row', async () => {
    setToken('tok');
    // First match wins in the stub, so this override has to precede the default team route.
    stubFetchRoutes([
      {
        method: 'GET',
        path: '/admin/team',
        body: {
          team: [
            { id: 'a1', email: 'owner@x.co', name: 'Ada Owner', phone: null, role: 'admin', practices: [], pages: ['pipeline', 'patients', 'payouts'], active: true, lastLoginAt: null },
            { id: 'm1', email: 'mo@x.co', name: 'Mo Manager', phone: '07700900123', role: 'manager', practices: [{ id: 'p1', name: 'Ashford' }], pages: ['pipeline'], active: true, lastLoginAt: null },
          ],
        },
      },
      ...dashboardRoutes(),
    ]);
    render(<App />);
    await screen.findByText('£460.00');
    await userEvent.click(screen.getByRole('link', { name: /^settings$/i }));

    expect(await screen.findByText('Mo Manager')).toBeInTheDocument();
    expect(screen.getByText('07700900123')).toBeInTheDocument();

    const row = screen.getByText('Mo Manager').closest('tr');
    await userEvent.click(within(row).getByRole('button', { name: /^edit$/i }));

    expect(window.location.pathname).toBe('/settings/team/m1');
    expect(screen.getByRole('heading', { name: /edit or manage your team/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/full name/i)).toHaveValue('Mo Manager');
    // Email is identity, not a label — it is shown but not editable here.
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('readonly');

    await userEvent.click(screen.getByRole('button', { name: /roles & permissions/i }));
    // Each screen's checkbox is labelled with what it grants, not just its name.
    expect(screen.getByLabelText(/pipeline.*move patients through the stages/i)).toBeChecked();
    expect(screen.getByLabelText(/patients.*register of everyone referred/i)).not.toBeChecked();
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

  it('starts on the settings page when returning from Dentally OAuth', async () => {
    // This landing has to follow the Dentally card. Sending someone who just approved the
    // connection to a page that says nothing about it is the whole failure mode.
    setToken('tok');
    window.history.replaceState({}, '', '/?dentally=connected');
    stubDashboardRoutes();
    render(<App />);

    expect(await screen.findByText(/dentally connected/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^dentally$/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/settings/integrations');
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

  it('shows a manager only the tabs the owner granted, and asks for nothing behind the rest', async () => {
    // 0017: the owner hands out screens per account. A revoked tab must not appear AND must
    // not be fetched — the API 403s it, which would raise an error toast on every poll.
    const calls = stubFetchRoutes([
      {
        method: 'GET',
        path: '/admin/me',
        body: { id: 'm3', email: 'm3@x.co', role: 'manager', pages: ['payouts'], practices: [{ id: 'p1', name: 'Ashford' }] },
      },
      { method: 'GET', path: '/admin/stats', body: { stats: { commissionPennies: 0, liabilityPennies: null, creditedPennies: 0, referralCounts: {} } } },
      { method: 'GET', path: '/admin/payouts', body: { payouts: [] } },
    ]);
    setToken('tok');
    render(<App />);

    expect(await screen.findByRole('link', { name: /payouts/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pipeline/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /patients/i })).not.toBeInTheDocument();

    await vi.waitFor(() => {
      expect([...new Set(calls.map((c) => c.path))].sort()).toEqual(
        ['/admin/me', '/admin/payouts', '/admin/stats'].sort(),
      );
    });
  });

  it('lands a manager granted nothing on Settings, with an explanation and no other nav', async () => {
    // An empty grant is a real answer. Falling back to '/' here would render the pipeline to
    // someone the API will 403 — the nav and the page must fail closed together. Settings is
    // the exception no grant removes: they can still change their own password.
    stubFetchRoutes([
      {
        method: 'GET',
        path: '/admin/me',
        body: { id: 'm4', email: 'm4@x.co', role: 'manager', pages: [], practices: [{ id: 'p1', name: 'Ashford' }] },
      },
      { method: 'GET', path: '/admin/stats', body: { stats: { commissionPennies: 0, liabilityPennies: null, creditedPennies: 0, referralCounts: {} } } },
    ]);
    setToken('tok');
    render(<App />);

    expect(await screen.findByText(/no other screens have been shared with this account yet/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /change password/i })).toBeInTheDocument();
    // A manager's Settings is their own account: one section, and none of the owner's.
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/settings']);
    expect(screen.queryByRole('heading', { name: /^team$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^dentally$/i })).not.toBeInTheDocument();
  });

  it('shows the manager their practice name', async () => {
    stubFetchRoutes(managerRoutes);
    setToken('tok');
    render(<App />);
    expect(await screen.findByText(/ashford/i)).toBeInTheDocument();
  });
});
