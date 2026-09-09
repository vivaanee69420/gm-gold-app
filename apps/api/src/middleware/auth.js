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

// A manager gets a payouts-only dashboard (2026-08-28 decision): everything else 403s.
// /admin/me/password is listed explicitly even though the prefix match already covers it,
// so the allowed set stays legible as intent, not an accident of regex precedence.
const MANAGER_ALLOWED = /^\/admin\/(me\/password|me|payouts)(\/|$)/;

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
    if (admin.role === 'manager' && !MANAGER_ALLOWED.test(req.path)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}
