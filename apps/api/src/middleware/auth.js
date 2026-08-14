import { verifyToken, getUser } from '../services/userService.js';
import { isDev } from '../config.js';

export async function requireUser(req, res, next) {
  try {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const payload = verifyToken(token);
    const user = await getUser(payload.sub);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    req.user = user;
    req.isAdmin = payload.admin === true;
    return next();
  } catch {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// Dev-only admin gate. Real admin auth (admin_users + Supabase email) lands with the admin web app.
export function requireAdmin(req, res, next) {
  if (req.isAdmin || isDev) return next();
  return res.status(403).json({ error: 'forbidden' });
}
