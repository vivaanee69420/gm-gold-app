import { useCallback, useEffect, useState } from 'react';
import { MANAGER_PAGES } from '@gm-referral/shared/schemas';
import { api, onUnauthorized } from './api/client.js';
import { isSignedIn, signOut } from './api/auth.js';
import { errorMessage } from './copy.js';
import SignIn from './components/SignIn.jsx';
import Sidebar from './components/Sidebar.jsx';
import { MenuIcon, RefreshIcon } from './components/icons.jsx';
import PipelinePage from './pages/PipelinePage.jsx';
import PatientsPage from './pages/PatientsPage.jsx';
import PayoutsPage from './pages/PayoutsPage.jsx';
import OperationsPage from './pages/OperationsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';

// Managers get a strict subset of the owner's dashboard, scoped by the API to their own
// practice (see MANAGER_ROUTES in the API's middleware/auth.js — these two lists must agree).
// `blurb` is the one line under the page title that says what this screen is for; `count`
// reads the loaded dashboard data so the header can carry the same figure the nav does.
const PAGES = [
  {
    path: '/',
    key: 'pipeline',
    label: 'Pipeline',
    icon: 'pipeline',
    roles: ['admin', 'manager'],
    blurb: 'Move each referred patient along as their treatment progresses. Treatment started credits the referrer.',
    count: (d) => d.referrals?.length,
  },
  {
    path: '/patients',
    key: 'patients',
    label: 'Patients',
    icon: 'patients',
    roles: ['admin', 'manager'],
    blurb: 'Everyone who booked through a referral link — who referred them, where, and when.',
    count: (d) => d.patients?.length,
  },
  {
    path: '/payouts',
    key: 'payouts',
    label: 'Payouts',
    icon: 'payouts',
    roles: ['admin', 'manager'],
    blurb: 'Cash waiting to be collected at the practice, and everything already settled.',
    count: (d) => d.payouts?.filter((p) => p.status === 'open').length,
  },
  {
    path: '/operations',
    key: 'operations',
    label: 'Operations',
    icon: 'operations',
    roles: ['admin'],
    blurb: 'The queues that need a decision, and the full referral record behind them.',
    count: (d) => (d.proposals?.length ?? 0) + (d.reviews?.length ?? 0),
  },
  {
    path: '/reports',
    key: 'reports',
    label: 'Reports & Setup',
    icon: 'reports',
    roles: ['admin'],
    blurb: 'How the scheme is performing, and the reward levers that change it.',
  },
  {
    path: '/settings',
    key: 'settings',
    label: 'Settings',
    icon: 'settings',
    roles: ['admin', 'manager'],
    // Never gated by a page grant: every account must be able to change its own password,
    // including a manager the owner has granted no screens at all.
    always: true,
    foot: true,
    // Settings is a place, not a page: it has its own sections underneath (/settings/team/:id
    // and the rest), and its own sidebar while you are in it.
    nested: true,
  },
];

// `/settings/team/<id>` is still the settings page. Without this a nested url falls through to
// the fallback and bounces the owner back to the pipeline mid-edit.
const onPage = (page, route) =>
  route === page.path || (page.nested && route.startsWith(`${page.path}/`));

// A nav badge means work waiting, not simply "rows exist" — a count beside Patients would be
// noise, one beside Payouts is a queue someone has to clear.
const BADGE_PATHS = new Set(['/payouts', '/operations']);

// What this account may reach. An admin owns every screen; a manager gets what the owner
// granted. An older API that doesn't send `pages` yet means "all of them" — the same default
// the API itself applies to a manager whose grant was never set.
function grantedPages(me) {
  if (!me) return [];
  if (me.role === 'admin') return MANAGER_PAGES;
  return me.pages ?? MANAGER_PAGES;
}

const PAGE_COMPONENTS = {
  '/': PipelinePage,
  '/patients': PatientsPage,
  '/payouts': PayoutsPage,
  '/operations': OperationsPage,
  '/reports': ReportsPage,
  '/settings': SettingsPage,
};

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn());
  const [me, setMe] = useState(null);
  const [data, setData] = useState(null);
  const [toast, setToast] = useState(null);
  const [route, setRoute] = useState(window.location.pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const notify = useCallback((message) => setToast(errorMessage(message)), []);

  const navigate = useCallback((path) => {
    window.history.pushState({}, '', path);
    setRoute(path);
    setMenuOpen(false);
  }, []);

  const loadAll = useCallback(async () => {
    if (!me) return;
    const isManager = me.role === 'manager';
    // Controller ruling (2026-08-28, carried over from the old ManagerPage): a manager
    // granted no practice yet would only ever get back empty, practice-scoped results —
    // don't hit the API just to render nothing; show the explicit state below instead.
    if (isManager && me.practices.length === 0) return;
    try {
      // Only what this account is allowed to ask for. A manager's granted pages (0017) decide
      // which lists load: requesting a revoked one would 403 and raise an error toast on every
      // poll, so the dashboard must not ask in the first place.
      const granted = grantedPages(me);
      const wanted = isManager
        ? MANAGER_PAGES.filter((page) => granted.includes(page))
        : MANAGER_PAGES;
      const [stats, payouts, referrals, patients] = await Promise.all([
        api('/admin/stats'),
        wanted.includes('payouts') ? api('/admin/payouts') : { payouts: [] },
        wanted.includes('pipeline') ? api('/admin/referrals') : { referrals: [] },
        wanted.includes('patients') ? api('/admin/patients') : { patients: [] },
      ]);
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

  // One referral moved, so patch that one row rather than reloading the whole dashboard.
  // Reloading cost eleven requests against a remote database for a change we already know the
  // shape of, and the board sat behind the slowest of them; the poll below still reconciles
  // with the server on its own schedule.
  const patchReferral = useCallback((id, fields) => {
    setData((d) => (d ? { ...d, referrals: d.referrals.map((r) => (r.id === id ? { ...r, ...fields } : r)) } : d));
  }, []);

  // The header's Refresh is the same load the tab already runs every 30s, just asked for by
  // hand — the spinning glyph is the only thing that differs, so the click has a visible answer.
  const refreshNow = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadAll();
    } finally {
      setRefreshing(false);
    }
  }, [loadAll]);

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
  // The Dentally card lives on Settings → Integrations, so land there — this has to move
  // with the card, or the person who just approved the connection arrives on a page that
  // says nothing about it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('dentally');
    if (!outcome) return;
    setToast(
      outcome === 'connected'
        ? 'Dentally connected — completed treatments will now be proposed automatically.'
        : `Dentally connection failed: ${params.get('reason') ?? 'unknown error'}. Try again or check the API log.`,
    );
    window.history.replaceState({}, '', '/settings/integrations');
    setRoute('/settings/integrations');
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

  // On a phone the sidebar is a drawer over the page; Escape closes it, the way every
  // other dismissible layer on the web does.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

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
  const granted = grantedPages(me);
  const visiblePages = role
    ? PAGES.filter(
        (p) => p.roles.includes(role) && (role === 'admin' || p.always || granted.includes(p.key)),
      )
    : [];
  const navPages = visiblePages.filter((p) => !p.foot);
  const footerPage = visiblePages.find((p) => p.foot) ?? null;
  // A page we removed from the nav is not a page we may render, so this must not fall back to
  // '/' — for a manager granted nothing, the first page they have is Settings, which is where
  // they land and where they can still change their own password.
  const fallbackPath = (navPages[0] ?? footerPage)?.path ?? null;
  const activePath = visiblePages.some((p) => onPage(p, route)) ? route : fallbackPath;
  const page = visiblePages.find((p) => onPage(p, activePath)) ?? null;
  const Page = page ? PAGE_COMPONENTS[page.path] : null;
  const managerHasNoPractice = role === 'manager' && (me?.practices?.length ?? 0) === 0;
  const managerHasNoPages = role === 'manager' && navPages.length === 0;

  const badges = {};
  if (data) {
    for (const p of visiblePages) {
      if (!BADGE_PATHS.has(p.path)) continue;
      const n = p.count?.(data) ?? 0;
      if (n > 0) badges[p.path] = n;
    }
  }
  // Each count is shown once. A queue's figure belongs on the nav row, where it reads as work
  // waiting from any page; a register's total belongs beside its title, where it reads as size.
  const headerCount = data && page && !BADGE_PATHS.has(page.path) ? page.count?.(data) : undefined;

  return (
    <div className={menuOpen ? 'shell shell-menu-open' : 'shell'}>
      <aside className="shell-side">
        <Sidebar
          me={me}
          pages={navPages}
          footerPage={footerPage}
          activePath={activePath}
          navigate={navigate}
          badges={badges}
          settingsPage={page?.nested ? page : null}
          route={route}
          onDismiss={() => setMenuOpen(false)}
        />
      </aside>
      <div className="shell-scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />

      <div className="shell-main">
        <header className="topbar">
          <button
            type="button"
            className="icon-button topbar-menu"
            aria-label="Open menu"
            onClick={() => setMenuOpen(true)}
          >
            <MenuIcon />
          </button>
          <div className="topbar-title">
            <h1>{page?.label ?? 'Referrals'}</h1>
            {headerCount != null && (
              <span className={headerCount === 0 ? 'count-badge count-badge-zero' : 'count-badge'}>
                {headerCount}
              </span>
            )}
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className={refreshing ? 'ghost ghost-icon is-refreshing' : 'ghost ghost-icon'}
              onClick={refreshNow}
              disabled={refreshing || !me}
            >
              <RefreshIcon />
              <span>Refresh</span>
            </button>
            <button className="ghost" onClick={signOutNow}>Sign out</button>
          </div>
        </header>

        {page?.blurb && <p className="page-blurb">{page.blurb}</p>}

        {toastEl}

        {managerHasNoPractice ? (
          <main>
            <p className="empty">No practice is assigned to this account — ask the owner to fix it.</p>
          </main>
        ) : !data || !Page ? (
          <p className="loading">Loading…</p>
        ) : (
          <main>
            <Page
              data={data}
              loadAll={loadAll}
              patchReferral={patchReferral}
              notify={notify}
              me={me}
              route={route}
              navigate={navigate}
              noGrantedPages={managerHasNoPages}
            />
          </main>
        )}
      </div>
    </div>
  );
}
