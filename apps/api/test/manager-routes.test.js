// Fail-closed enforcement for the manager role.
//
// Managers reach a strict subset of /admin. That subset used to be one regex; it is now an
// explicit list, and this file is what stops the list from drifting. Adding an /admin route
// without deciding whether a manager may reach it fails here rather than silently opening it.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';
import { adminSession } from './helpers/admin.js';
import { MANAGER_ROUTES } from '../src/middleware/auth.js';

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
});
