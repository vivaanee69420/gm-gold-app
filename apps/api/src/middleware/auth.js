import { verifyToken, getUser } from '../services/userService.js';
import { db } from '../db.js';
import { isDev } from '../config.js';

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

// FR-24: the gate reads admin_users (role + practice scope). Dev without a matching row
// keeps the open gate so the local loop stays walkable without seeding admins.
export async function requireAdmin(req, res, next) {
  try {
    const { rows } = await db.query(
      `select role, practice_ids from admin_users where user_id = $1 and active`,
      [req.user.id],
    );
    if (rows[0]) {
      // uuid[] comes back as a JS array from pg, a '{...}' literal from some drivers.
      const raw = rows[0].practice_ids;
      const practiceIds = Array.isArray(raw)
        ? raw
        : String(raw ?? '{}').replace(/[{}"]/g, '').split(',').filter(Boolean);
      req.admin = { role: rows[0].role, practiceIds };
      return next();
    }
    if (isDev) {
      req.admin = { role: 'owner', practiceIds: [] };
      return next();
    }
    return res.status(403).json({ error: 'forbidden' });
  } catch (err) {
    return next(err);
  }
}

export function requireOwner(req, res, next) {
  if (req.admin?.role === 'owner') return next();
  return res.status(403).json({ error: 'forbidden' });
}
