import { verifyToken, getOrCreateUserByAuthId } from '../services/userService.js';
import { verifyAccessToken, AuthError } from '../services/supabaseAuth.js';
import { loadAdminForToken } from '../services/adminService.js';

/**
 * Patient sessions: a Supabase Auth access token, verified against the project's public keys.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *   1. A token we cannot CHECK is not a token we rejected. verifyAccessToken raises 503 when
 *      Supabase's JWKS endpoint is unreachable, and we pass that through rather than
 *      flattening it to 401 — a 401 would sign every patient out at once during a blip, and
 *      the mobile client clears its session on 401 by design.
 *
 *   2. `sessions_revoked_at` is still checked, even though Supabase now owns sessions. Supabase's
 *      global sign-out only stops future refreshes; an access token already issued stays valid
 *      until it expires. Checking the column here is what keeps FR-03 revocation immediate
 *      instead of "sometime within the hour". The user row is already loaded, so it is free.
 */
export async function requireUser(req, res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });

  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch (err) {
    if (err instanceof AuthError && err.status === 503) {
      return res.status(503).json({ error: 'auth_unavailable' });
    }
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // First request after signing up: Supabase has the identity, we have no profile row yet.
    // users.id IS auth.users.id — same uuid, no join table, no mapping to keep in sync.
    const user = await getOrCreateUserByAuthId(claims);
    if (!user) return res.status(401).json({ error: 'unauthorized' });

    // FR-03. Compare the TOKEN's issue time against the revocation, not the revocation
    // against now, so a patient who signs in again after being signed out gets a working
    // session instead of being locked out permanently.
    //
    // This deliberately does NOT reuse tokenRevoked(). That helper's coarse branch is
    // `iat < floor(revokedAt/1000)`, which rounds in favour of KEEPING a token alive when
    // both land in the same second — the right call for the old self-issued tokens, which
    // carried millisecond `iatMs` and only fell back to seconds for legacy ones. Supabase
    // issues seconds and nothing finer, so that rounding would make it a coin flip whether
    // revoking an account actually revoked anything. A security control has to fail closed,
    // so the whole second containing the revocation is treated as revoked: worst case a
    // patient signing in during that exact second retries once.
    if (user.sessions_revoked_at) {
      const revokedSec = Math.floor(new Date(user.sessions_revoked_at).getTime() / 1000);
      if (claims.iat <= revokedSec) {
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    req.user = user;
    return next();
  } catch {
    return res.status(500).json({ error: 'internal' });
  }
}

// A manager gets a practice-scoped subset of the dashboard (2026-09-10 decision, superseding
// the 2026-08-28 payouts-only rule): their practice's pipeline, patients, payouts and stats.
//
// This is an explicit list rather than a path regex so that the answer to "can a manager reach
// this?" is a line you can read, and so manager-routes.test.js can enforce that every
// registered /admin route has an answer. Fail closed: anything absent from this list is 403.
//
// Keys are "<METHOD> <express route path>" — the route PATTERN (with :id), not the request url.
export const MANAGER_ROUTES = new Set([
  'GET /admin/me',
  'POST /admin/me/password',
  'GET /admin/payouts',
  'POST /admin/payouts/:id/mark-paid',
  'POST /admin/payouts/:id/cancel',
  'GET /admin/referrals',
  'GET /admin/referrals/:id',
  'PATCH /admin/referrals/:id/status',
  'PUT /admin/referrals/:id/treatment',
  'POST /admin/referrals/:id/notes',
  'DELETE /admin/referrals/:id/notes/:noteId',
  'GET /admin/patients',
  'GET /admin/patients/:id',
  'GET /admin/stats',
]);

// Which dashboard page each manager route sits behind (0017). A route mapped to a page is
// reachable only by a manager the owner granted that page — revoking a tab closes the data
// behind it, not just the link to it. Routes absent from this map are reachable by any
// manager who passes MANAGER_ROUTES above: identity, their own password, and the practice
// figures the shell itself renders.
export const ROUTE_PAGE = new Map([
  ['GET /admin/referrals', 'pipeline'],
  ['GET /admin/referrals/:id', 'pipeline'],
  ['PATCH /admin/referrals/:id/status', 'pipeline'],
  ['PUT /admin/referrals/:id/treatment', 'pipeline'],
  ['POST /admin/referrals/:id/notes', 'pipeline'],
  ['DELETE /admin/referrals/:id/notes/:noteId', 'pipeline'],
  ['GET /admin/patients', 'patients'],
  ['GET /admin/patients/:id', 'patients'],
  ['GET /admin/payouts', 'payouts'],
  ['POST /admin/payouts/:id/mark-paid', 'payouts'],
  ['POST /admin/payouts/:id/cancel', 'payouts'],
]);

// Standalone (no requireUser first): admin identity lives entirely in admin_users, keyed
// by its own uuid — never by a patient's users.id. Patient tokens are rejected outright.
export async function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const payload = verifyToken(token);
    if (payload.kind !== 'admin') return res.status(401).json({ error: 'unauthorized' });
    const admin = await loadAdminForToken(payload);
    if (!admin) return res.status(401).json({ error: 'unauthorized' });
    req.admin = admin;
    // Match on the route PATTERN (`/admin/payouts/:id/cancel`), which express sets before
    // route-level middleware runs. If there is no matched route we have been mounted somewhere
    // unexpected — treat that as no match rather than falling back to req.path, which for the
    // param-free entries is character-identical to the pattern and would grant access.
    const routeKey = req.route?.path ? `${req.method} ${req.route.path}` : null;
    if (admin.role === 'manager') {
      if (routeKey === null || !MANAGER_ROUTES.has(routeKey)) {
        return res.status(403).json({ error: 'forbidden' });
      }
      // Second fence, same fail-closed shape: a route behind a page needs that page granted.
      const page = ROUTE_PAGE.get(routeKey);
      if (page && !admin.pages.includes(page)) {
        return res.status(403).json({ error: 'forbidden' });
      }
    }
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}
