import { useCallback, useEffect, useState } from 'react';
import { api, onUnauthorized } from './api/client.js';
import { isSignedIn, signOut } from './api/auth.js';
import { errorMessage } from './copy.js';
import SignIn from './components/SignIn.jsx';
import ManagerPage from './pages/ManagerPage.jsx';
import OperationsPage from './pages/OperationsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';

const PAGES = [
  { path: '/', label: 'Operations' },
  { path: '/reports', label: 'Reports & Setup' },
];

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [me, setMe] = useState(null);
  const [data, setData] = useState(null);
  const [toast, setToast] = useState(null);
  const [route, setRoute] = useState(window.location.pathname);

  const notify = useCallback((message) => setToast(errorMessage(message)), []);

  const navigate = useCallback((path) => {
    window.history.pushState({}, '', path);
    setRoute(path);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [settings, stats, payouts, referrals, proposals, verifications, aging, dentally, reviews, funnel, top] = await Promise.all([
        api('/admin/settings'),
        api('/admin/stats'),
        api('/admin/payouts'),
        api('/admin/referrals'),
        api('/admin/proposals'),
        api('/admin/verifications'),
        api('/admin/aging'),
        api('/admin/dentally/status'),
        api('/admin/referral-review'),
        api('/admin/reports/funnel'),
        api('/admin/reports/top-referrers'),
      ]);
      setData({
        settings: settings.settings,
        stats: stats.stats,
        payouts: payouts.payouts,
        referrals: referrals.referrals,
        proposals: proposals.proposals,
        verifications: verifications.verifications,
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
  }, [notify]);

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

  // FR-24: fetch role + practice scope first — a manager gets a stripped-down
  // payouts-only screen; everyone else gets the full dashboard's loadAll.
  useEffect(() => {
    if (!signedIn) return;
    api('/admin/me').then(setMe).catch((err) => notify(err.code ?? 'load_failed'));
  }, [signedIn, notify]);

  useEffect(() => {
    if (signedIn && me && me.role !== 'manager') loadAll();
  }, [signedIn, me, loadAll]);

  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;

  const toastEl = toast && (
    <div role="alert" className="toast">
      {toast}
      <button className="ghost" onClick={() => setToast(null)}>Dismiss</button>
    </div>
  );

  if (me?.role === 'manager') {
    return (
      <>
        {toastEl}
        <ManagerPage me={me} notify={notify} onSignOut={signOutNow} />
      </>
    );
  }

  // Unknown paths fall back to Operations.
  const activePath = route === '/reports' ? '/reports' : '/';
  const Page = activePath === '/reports' ? ReportsPage : OperationsPage;

  return (
    <div className="dashboard">
      <header className="topbar">
        <p className="wordmark">GM Dental</p>
        <h1>Referral Admin</h1>
        <nav className="topnav">
          {PAGES.map(({ path, label }) => (
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
        <button className="ghost" onClick={signOutNow}>
          Sign out
        </button>
      </header>
      {toastEl}
      {!data ? (
        <p className="loading">Loading…</p>
      ) : (
        <main>
          <Page data={data} loadAll={loadAll} notify={notify} />
        </main>
      )}
    </div>
  );
}
