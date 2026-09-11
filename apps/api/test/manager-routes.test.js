// Fail-closed enforcement for the manager role.
//
// Managers reach a strict subset of /admin. That subset used to be one regex; it is now an
// explicit list, and this file is what stops the list from drifting. Adding an /admin route
// without deciding whether a manager may reach it fails here rather than silently opening it.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { adminSession } from './helpers/admin.js';
import { MANAGER_PAGES } from '@gm-referral/shared/schemas';
import { MANAGER_ROUTES, ROUTE_PAGE } from '../src/middleware/auth.js';

process.env.PGLITE_MEMORY = '1';

let app;
let managerToken;

const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Every "<METHOD> <path>" registered under /admin, read off the Express 4 router stack. */
function registeredAdminRoutes(expressApp) {
  const out = [];
  for (const layer of expressApp._router.stack) {
    if (!layer.route?.path || !String(layer.route.path).startsWith('/admin')) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) out.push(`${method.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out.sort();
}

// The full admin route surface as of this commit, captured by running registeredAdminRoutes()
// against the live app. Changing this array is a deliberate act: it means the admin surface
// itself changed, and every new entry needs an explicit answer — either added to
// MANAGER_ROUTES, or left out of it (and out of this snapshot's need to change at all is not
// an option, since a new /admin route always shows up here).
const ADMIN_ROUTE_SNAPSHOT = [
  'DELETE /admin/referrals/:id/notes/:noteId',
  'GET /admin/aging',
  'GET /admin/dentally/status',
  'GET /admin/me',
  'GET /admin/patients',
  'GET /admin/patients/:id',
  'GET /admin/payouts',
  'GET /admin/proposals',
  'GET /admin/referral-review',
  'GET /admin/referrals',
  'GET /admin/referrals/:id',
  'GET /admin/reports/funnel',
  'GET /admin/reports/top-referrers',
  'GET /admin/settings',
  'GET /admin/stats',
  'GET /admin/team',
  'PATCH /admin/referrals/:id/status',
  'POST /admin/dentally/connect',
  'POST /admin/dentally/disconnect',
  'POST /admin/me/password',
  'POST /admin/payouts/:id/cancel',
  'POST /admin/payouts/:id/mark-paid',
  'POST /admin/proposals/:id/confirm',
  'POST /admin/proposals/:id/reject',
  'POST /admin/referral-review/:id/decide',
  'POST /admin/referrals/:id/notes',
  'POST /admin/sync/run',
  'POST /admin/team',
  'POST /admin/team/:id/active',
  'POST /admin/team/:id/pages',
  'POST /admin/team/:id/password',
  'POST /admin/team/:id/practice',
  'POST /admin/team/:id/profile',
  'POST /admin/users/:id/revoke-sessions',
  'PUT /admin/referrals/:id/treatment',
  // 'PUT /admin/reward-amount' was here until 2026-09-11. It wrote a global reward_rules row,
  // and rules no longer decide any payment — commission is chosen per referral via
  // PUT /admin/referrals/:id/treatment, which is already in this snapshot below.
  'PUT /admin/settings',
];

beforeAll(async () => {
  ({ app } = await bootTestApp());
  const practices = (await request(app).get('/practices')).body.practices;
  ({ token: managerToken } = await adminSession(app, {
    email: 'route-coverage@gmdental.co.uk',
    role: 'manager',
    practiceIds: [practices[0].id],
  }));
});

describe('manager route allowlist', () => {
  it('lists only routes that actually exist', async () => {
    const registered = new Set(registeredAdminRoutes(app));
    const phantom = [...MANAGER_ROUTES].filter((r) => !registered.has(r));
    expect(phantom, 'MANAGER_ROUTES names routes that are not registered — a typo here silently '
      + 'closes a route the manager dashboard needs').toEqual([]);
  });

  it('403s a manager on every /admin route outside the allowlist', async () => {
    const closed = registeredAdminRoutes(app).filter((r) => !MANAGER_ROUTES.has(r));
    expect(closed.length, 'expected some admin-only routes').toBeGreaterThan(0);

    for (const entry of closed) {
      const [method, routePath] = entry.split(' ');
      // Any syntactically valid uuid: the 403 must land before the handler ever looks it up.
      const url = routePath.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(app)[method.toLowerCase()](url)
        .set(auth(managerToken))
        .send({});
      expect(res.status, `${entry} should be closed to managers but answered ${res.status}`).toBe(403);
      expect(res.body.error).toBe('forbidden');
    }
  });

  it('does not 403 a manager on the allowlisted routes', async () => {
    for (const entry of MANAGER_ROUTES) {
      const [method, routePath] = entry.split(' ');
      const url = routePath.replace(/:[^/]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await request(app)[method.toLowerCase()](url)
        .set(auth(managerToken))
        .send({});
      // 200/404/409/422 are all fine — the point is the role gate did not reject it.
      expect(res.status, `${entry} should be open to managers`).not.toBe(403);
    }
  });

  // The actual drift alarm. The 403-by-default test above proves the fence HOLDS; it cannot
  // notice a new route being added, because a new route simply 403s and stays green. This one
  // fails the moment the admin surface changes, forcing a deliberate decision: add the route
  // to MANAGER_ROUTES, or add it here to record that managers must not reach it.
  it('the admin route surface matches the committed snapshot', () => {
    expect(registeredAdminRoutes(app)).toEqual(ADMIN_ROUTE_SNAPSHOT);
  });
});

// The second fence (0017): the allowlist above says which routes a manager MAY reach; this
// says which of those THIS manager reaches, from the pages the owner granted them. Revoking a
// tab has to close the data behind it — otherwise the tab is a hidden link, not a permission.
describe('per-manager page grants', () => {
  let ownerToken;
  let scopedToken;
  let scopedId;

  beforeAll(async () => {
    ({ token: ownerToken } = await adminSession(app, { email: 'pages-owner@gmdental.co.uk' }));
    const practices = (await request(app).get('/practices')).body.practices;
    const session = await adminSession(app, {
      email: 'pages-manager@gmdental.co.uk',
      role: 'manager',
      practiceIds: [practices[0].id],
    });
    scopedToken = session.token;
    scopedId = session.admin.id;
  });

  it('starts a new manager with every page, so 0017 changes nobody', async () => {
    expect((await request(app).get('/admin/me').set(auth(scopedToken))).body.pages)
      .toEqual(['pipeline', 'patients', 'payouts']);
    expect((await request(app).get('/admin/payouts').set(auth(scopedToken))).status).toBe(200);
    expect((await request(app).get('/admin/patients').set(auth(scopedToken))).status).toBe(200);
  });

  it('403s the routes behind a page the owner revoked, and keeps the rest open', async () => {
    const granted = await request(app)
      .post(`/admin/team/${scopedId}/pages`)
      .set(auth(ownerToken))
      .send({ pages: ['pipeline'] });
    expect(granted.status).toBe(200);

    // Revoked: both the list and the row behind it, not just the nav link.
    expect((await request(app).get('/admin/payouts').set(auth(scopedToken))).status).toBe(403);
    expect((await request(app).get('/admin/patients').set(auth(scopedToken))).status).toBe(403);
    expect((await request(app).get('/admin/patients/00000000-0000-4000-8000-000000000000')
      .set(auth(scopedToken))).status).toBe(403);
    // A write is a route too — the one that moves money must be closed with its page.
    expect((await request(app).post('/admin/payouts/00000000-0000-4000-8000-000000000000/mark-paid')
      .set(auth(scopedToken)).send({ amountPennies: 100 })).status).toBe(403);

    // Kept: the granted page, and the routes no page gates at all.
    expect((await request(app).get('/admin/referrals').set(auth(scopedToken))).status).toBe(200);
    expect((await request(app).get('/admin/me').set(auth(scopedToken))).status).toBe(200);
    expect((await request(app).get('/admin/stats').set(auth(scopedToken))).status).toBe(200);
  });

  it('accepts an empty grant as a real answer, not a missing one', async () => {
    expect((await request(app).post(`/admin/team/${scopedId}/pages`)
      .set(auth(ownerToken)).send({ pages: [] })).status).toBe(200);
    expect((await request(app).get('/admin/me').set(auth(scopedToken))).body.pages).toEqual([]);
    expect((await request(app).get('/admin/referrals').set(auth(scopedToken))).status).toBe(403);
    // Still their own account: sign in, see who they are, change their password.
    expect((await request(app).get('/admin/me').set(auth(scopedToken))).status).toBe(200);

    // A missing field is a 422 — never read as "revoke everything".
    expect((await request(app).post(`/admin/team/${scopedId}/pages`)
      .set(auth(ownerToken)).send({})).status).toBe(422);
    // An unknown page name is rejected outright rather than silently dropped.
    expect((await request(app).post(`/admin/team/${scopedId}/pages`)
      .set(auth(ownerToken)).send({ pages: ['operations'] })).status).toBe(422);
  });

  it('refuses to narrow an admin — they own every screen by construction', async () => {
    const me = await request(app).get('/admin/me').set(auth(ownerToken));
    expect(me.body.pages).toEqual(['pipeline', 'patients', 'payouts']);
    expect((await request(app).post(`/admin/team/${me.body.id}/pages`)
      .set(auth(ownerToken)).send({ pages: ['pipeline'] })).status).toBe(422);
  });

  it('closes a manager route the moment its page grant is gone, without a new login', async () => {
    // The grant is read from admin_users on every request (loadAdminForToken), not baked into
    // the token — so revoking a page takes effect now, not when the manager next signs in.
    await request(app).post(`/admin/team/${scopedId}/pages`)
      .set(auth(ownerToken)).send({ pages: ['payouts'] });
    expect((await request(app).get('/admin/payouts').set(auth(scopedToken))).status).toBe(200);
    await request(app).post(`/admin/team/${scopedId}/pages`)
      .set(auth(ownerToken)).send({ pages: [] });
    expect((await request(app).get('/admin/payouts').set(auth(scopedToken))).status).toBe(403);
  });

  // The page fence is fail-OPEN by design: middleware/auth.js does
  // `const page = ROUTE_PAGE.get(routeKey); if (page && !admin.pages.includes(page)) -> 403`,
  // so a route absent from ROUTE_PAGE is reachable by any manager regardless of their grants.
  // That is correct for the three routes below and wrong for everything else.
  //
  // Nothing protected that distinction. ADMIN_ROUTE_SNAPSHOT forces a decision whenever an
  // /admin route is added, but it is satisfied by editing MANAGER_ROUTES alone — so adding a
  // manager route and forgetting ROUTE_PAGE silently opened it to every manager with the whole
  // suite still green. This turns "forgot to decide" into a failure without changing the
  // fail-open behaviour the three below rely on.
  const INTENTIONALLY_UNGATED = new Set([
    'GET /admin/me',            // identity: every account must be able to see who it is
    'POST /admin/me/password',  // every account must be able to change its own password
    'GET /admin/stats',         // the practice figures the dashboard shell itself renders
  ]);

  it('gates every manager route behind a page, or names it as deliberately ungated', () => {
    const undecided = [...MANAGER_ROUTES].filter(
      (route) => !ROUTE_PAGE.has(route) && !INTENTIONALLY_UNGATED.has(route),
    );
    expect(
      undecided,
      'these manager routes are behind no page grant. Add each to ROUTE_PAGE, or to '
      + 'INTENTIONALLY_UNGATED above if every manager really should reach it',
    ).toEqual([]);
  });

  it('keeps the ungated list honest', () => {
    // The other direction: an entry that has since been gated, or that is no longer a manager
    // route at all, is a stale exemption waiting to excuse the next real mistake.
    const stale = [...INTENTIONALLY_UNGATED].filter(
      (route) => !MANAGER_ROUTES.has(route) || ROUTE_PAGE.has(route),
    );
    expect(stale, 'remove these from INTENTIONALLY_UNGATED — they no longer need exempting').toEqual([]);
  });

  it('maps every gated route to a page a manager can actually be granted', () => {
    // A typo'd page name ('payout' for 'payouts') would gate a route behind something no
    // grant can ever satisfy, locking it for every manager with no error anywhere.
    const unknown = [...ROUTE_PAGE.entries()]
      .filter(([, page]) => !MANAGER_PAGES.includes(page))
      .map(([route, page]) => `${route} -> ${page}`);
    expect(unknown, 'ROUTE_PAGE names a page that is not in MANAGER_PAGES').toEqual([]);
  });

  it('answers the login with the same pages as /admin/me, not with everything', async () => {
    // The dashboard builds its nav from the LOGIN response. authenticate() used to hand
    // publicAdmin an object with no `pages` key at all, and normalizePages reads undefined as
    // "unset" — which for a manager means "grant everything" — so a one-page manager was told
    // at login that they had all three, then 403'd on every nav item but one.
    await request(app).post(`/admin/team/${scopedId}/pages`)
      .set(auth(ownerToken)).send({ pages: ['payouts'] });

    const login = await request(app).post('/auth/admin/login')
      .send({ email: 'pages-manager@gmdental.co.uk', password: 'correct-horse-battery' });
    expect(login.status).toBe(200);
    expect(login.body.admin.pages).toEqual(['payouts']);

    const me = await request(app).get('/admin/me').set(auth(login.body.token));
    expect(login.body.admin.pages, 'login and /admin/me must never disagree').toEqual(me.body.pages);
    expect(login.body.admin.name, 'name was dropped on the same line').toBe(me.body.name);
  });
});
