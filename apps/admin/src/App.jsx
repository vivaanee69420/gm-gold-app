import { useCallback, useEffect, useState } from 'react';
import { api, onUnauthorized } from './api/client.js';
import { isSignedIn, signOut } from './api/auth.js';
import { errorMessage } from './copy.js';
import SignIn from './components/SignIn.jsx';
import ChangePassword from './components/ChangePassword.jsx';
import PipelinePage from './pages/PipelinePage.jsx';
import PatientsPage from './pages/PatientsPage.jsx';
import PayoutsPage from './pages/PayoutsPage.jsx';
import OperationsPage from './pages/OperationsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';

// Managers get a strict subset of the owner's dashboard, scoped by the API to their own
// practice (see MANAGER_ROUTES in the API's middleware/auth.js — these two lists must agree).
const PAGES = [
  { path: '/', label: 'Pipeline', roles: ['admin', 'manager'] },
  { path: '/patients', label: 'Patients', roles: ['admin', 'manager'] },
  { path: '/payouts', label: 'Payouts', roles: ['admin', 'manager'] },
  { path: '/operations', label: 'Operations', roles: ['admin'] },
  { path: '/reports', label: 'Reports & Setup', roles: ['admin'] },
];

const PAGE_COMPONENTS = {
  '/': PipelinePage,
  '/patients': PatientsPage,
  '/payouts': PayoutsPage,
  '/operations': OperationsPage,
  '/reports': ReportsPage,
};

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [me, setMe] = useState(null);
  const [data, setData] = useState(null);
  const [toast, setToast] = useState(null);
  const [route, setRoute] = useState(window.location.pathname);
  const [showChangePassword, setShowChangePassword] = useState(false);

  const notify = useCallback((message) => setToast(errorMessage(message)), []);

  const navigate = useCallback((path) => {
    window.history.pushState({}, '', path);
    setRoute(path);
  }, []);

  const loadAll = useCallback(async () => {
    if (!me) return;
    const isManager = me.role === 'manager';
    // Controller ruling (2026-08-28, carried over from the old ManagerPage): a manager
    // granted no practice yet would only ever get back empty, practice-scoped results —
    // don't hit the API just to render nothing; show the explicit state below instead.
    if (isManager && me.practices.length === 0) return;
    try {
      // Every manager-reachable endpoint, and for an admin the rest of the dashboard too.
      const shared = await Promise.all([
        api('/admin/stats'),
        api('/admin/payouts'),
        api('/admin/referrals'),
        api('/admin/patients'),
      ]);
      const [stats, payouts, referrals, patients] = shared;
      const base = {
        stats: stats.stats,
        payouts: payouts.payouts,
        referrals: referrals.referrals,
        patients: patients.patients,
      };
      if (isManager) return setData(base);

      const [settings, proposals, aging, dentally, reviews, funnel, top] = await Promise.all([
        api('/admin/settings'),
        api('/admin/proposals'),
        api('/admin/aging'),
        api('/admin/dentally/status'),
        api('/admin/referral-review'),
        api('/admin/reports/funnel'),
        api('/admin/reports/top-referrers'),
      ]);
      setData({
        ...base,
        settings: settings.settings,
        proposals: proposals.proposals,
        aging: aging.aging,
        agingDays: aging.days,
        dentally,
        reviews: reviews.reviews,
        funnel: funnel.funnel,
        topReferrers: top.topReferrers,
      });
    } catch (err) {
      notify(err.code ?? 'load_failed');
    }
  }, [notify, me]);

  const signOutNow = useCallback(() => {
    signOut();
    setSignedIn(false);
    setMe(null);
    setData(null);
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      setSignedIn(false);
      setMe(null);
      setData(null);
    });
  }, []);

  useEffect(() => {
    const onPop = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Landing back from Dentally's OAuth approval screen (?dentally=connected|error).
  // The Dentally card lives on the Reports & Setup page, so land there.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('dentally');
    if (!outcome) return;
    setToast(
      outcome === 'connected'
        ? 'Dentally connected — completed treatments will now be proposed automatically.'
        : `Dentally connection failed: ${params.get('reason') ?? 'unknown error'}. Try again or check the API log.`,
    );
    window.history.replaceState({}, '', '/reports');
    setRoute('/reports');
  }, []);

  // FR-24: fetch role + practice scope first — a manager's `loadAll` scopes itself to
  // only the endpoints the API lets a manager call.
  useEffect(() => {
    if (!signedIn) return;
    api('/admin/me').then(setMe).catch((err) => notify(err.code ?? 'load_failed'));
  }, [signedIn, notify]);

  useEffect(() => {
    if (signedIn && me) loadAll();
  }, [signedIn, me, loadAll]);

  // The front desk leaves this open all day; a colleague's change should appear without a
  // manual reload. Only while the tab is actually in front of someone.
  useEffect(() => {
    if (!signedIn || !me) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') loadAll();
    }, 30_000);
    return () => clearInterval(timer);
  }, [signedIn, me, loadAll]);

  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;

  const toastEl = toast && (
    <div role="alert" className="toast">
      {toast}
      <button className="ghost" onClick={() => setToast(null)}>Dismiss</button>
    </div>
  );

  // Fail closed: until /admin/me tells us the role, show no navigation at all. Defaulting to
  // 'admin' here would flash Operations and Reports & Setup at a manager on every sign-in.
  const role = me?.role ?? null;
  const visiblePages = role ? PAGES.filter((p) => p.roles.includes(role)) : [];
  const activePath = visiblePages.some((p) => p.path === route) ? route : '/';
  const Page = PAGE_COMPONENTS[activePath];
  const managerHasNoPractice = role === 'manager' && (me?.practices?.length ?? 0) === 0;

  return (
    <div className="dashboard">
      <header className="topbar">
        <p className="wordmark">GM Dental</p>
        <h1>{me?.practices?.length === 1 ? `${me.practices[0].name} · Referrals` : 'Referral Admin'}</h1>
        <nav className="topnav">
          {visiblePages.map(({ path, label }) => (
            <a
              key={path}
              href={path}
              className={path === activePath ? 'active' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(path);
              }}
            >
              {label}
            </a>
          ))}
        </nav>
        <button className="ghost" onClick={() => setShowChangePassword((v) => !v)}>
          Change password
        </button>
        <button className="ghost" onClick={signOutNow}>
          Sign out
        </button>
      </header>
      {toastEl}
      {showChangePassword && (
        <div className="inline-panel">
          <ChangePassword notify={notify} onDone={() => setShowChangePassword(false)} />
        </div>
      )}
      {managerHasNoPractice ? (
        <main>
          <p className="empty">No practice is assigned to this account — ask the owner to fix it.</p>
        </main>
      ) : !data ? (
        <p className="loading">Loading…</p>
      ) : (
        <main>
          <Page data={data} loadAll={loadAll} notify={notify} me={me} />
        </main>
      )}
    </div>
  );
}
