import { useCallback, useEffect, useState } from 'react';
import { api, onUnauthorized } from './api/client.js';
import { isSignedIn, signOut } from './api/auth.js';
import { errorMessage } from './copy.js';
import SignIn from './components/SignIn.jsx';
import OperationsPage from './pages/OperationsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';

const PAGES = [
  { path: '/', label: 'Operations' },
  { path: '/reports', label: 'Reports & Setup' },
];

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
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

  useEffect(() => {
    onUnauthorized(() => {
      setSignedIn(false);
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

  useEffect(() => {
    if (signedIn) loadAll();
  }, [signedIn, loadAll]);

  if (!signedIn) return <SignIn onSignedIn={() => setSignedIn(true)} />;

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
        <button
          className="ghost"
          onClick={() => {
            signOut();
            setSignedIn(false);
            setData(null);
          }}
        >
          Sign out
        </button>
      </header>
      {toast && (
        <div role="alert" className="toast">
          {toast}
          <button className="ghost" onClick={() => setToast(null)}>Dismiss</button>
        </div>
      )}
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
