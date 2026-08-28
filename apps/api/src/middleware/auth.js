import { verifyToken, getUser } from '../services/userService.js';
import { loadAdminForToken } from '../services/adminService.js';

export async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const payload = verifyToken(token);
    const user = await getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    // FR-03: tokens issued before an admin revocation are dead (iat is in seconds).
    if (user.sessions_revoked_at && payload.iat * 1000 < new Date(user.sessions_revoked_at).getTime()) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
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
