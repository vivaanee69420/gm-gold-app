// Admin identity: email + password accounts, two roles (admin = everything/all practices,
// manager = one practice/payouts only). Owns hashing, creation, authentication, token
// issue/load, and the public admin shape — auth.js and app.js stay thin callers of this.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { adminCreateSchema, adminPasswordSchema } from '@gm-referral/shared/schemas';
import { db, logEvent } from '../db.js';
import { config } from '../config.js';

const httpError = (message, status) => Object.assign(new Error(message), { status });
const scryptAsync = promisify(crypto.scrypt);

// ---- password hashing (node:crypto scrypt, async so a login request never blocks the
// event loop for other in-flight requests) ----
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const SALT_BYTES = 16;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scryptAsync(String(password), salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(String(password), salt, expected.length, SCRYPT_OPTS);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A fixed hash compared against whenever there's nothing real to compare against (unknown
// email, or a legacy/migrated row with no password_hash yet), so none of those cases is
// distinguishable by timing from a real wrong-password attempt.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('dummy-password-for-timing-uniformity-only');
  return dummyHashPromise;
}

const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

// uuid[] comes back as a JS array from pg, a '{...}' literal from some drivers.
export function normalizePracticeIds(raw) {
  if (Array.isArray(raw)) return raw;
  return String(raw ?? '{}').replace(/[{}"]/g, '').split(',').filter(Boolean);
}

export async function practicesForAdmin({ role, practiceIds }) {
  if (role === 'manager') {
    if (!practiceIds.length) return [];
    const { rows } = await db.query(
      `select id, name from practices where active and id = any($1::uuid[]) order by name`,
      [`{${practiceIds.join(',')}}`],
    );
    return rows;
  }
  const { rows } = await db.query(`select id, name from practices where active order by name`);
  return rows;
}

// ---- login rate limit ----
// In-memory, single-replica: counters live in this process only and reset on deploy/restart
// (no shared store — good enough for the current single-instance API; a DB/Redis-backed
// limiter is a Phase-2 concern if we ever run more than one replica). Two layers: a tight
// per-email limit (defends one account against a targeted guesser) and a coarse per-IP limit
// in front of it (defends the login route itself against one source hammering many emails).
const MAX_EMAIL_FAILURES = 5;
const MAX_IP_FAILURES = 30;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// Test-only clock seam: swapping Date.now() for a mock lets tests jump the rate-limit window
// forward without faking timers around real DB/network I/O (which risks hanging on PGlite's
// or supertest's own timer/microtask use). Never touched outside tests.
let clockNow = () => Date.now();
export function __setClockForTests(fn) {
  clockNow = fn ?? (() => Date.now());
}

function makeLimiter(max) {
  const byKey = new Map();
  function prune(now) {
    for (const [key, entry] of byKey) {
      if (now - entry.firstFailureAt >= FAILURE_WINDOW_MS) byKey.delete(key);
    }
  }
  return {
    assertNotLimited(key) {
      const now = clockNow();
      prune(now);
      const entry = byKey.get(key);
      if (entry && entry.count >= max && now - entry.firstFailureAt < FAILURE_WINDOW_MS) {
        throw httpError('rate_limited', 429);
      }
    },
    recordFailure(key) {
      const now = clockNow();
      prune(now); // sweep expired entries on every write; cheap at this size
      const entry = byKey.get(key);
      if (!entry || now - entry.firstFailureAt >= FAILURE_WINDOW_MS) {
        byKey.set(key, { count: 1, firstFailureAt: now });
      } else {
        entry.count += 1;
      }
    },
    clear(key) {
      byKey.delete(key);
    },
    reset() {
      byKey.clear();
    },
  };
}

const emailLimiter = makeLimiter(MAX_EMAIL_FAILURES);
const ipLimiter = makeLimiter(MAX_IP_FAILURES);

// Test-only: wipe both limiters' state. Needed alongside __setClockForTests whenever a test
// advances the clock into a simulated future — an entry recorded under that fake "now" reads
// as not-yet-expired once the real clock resumes (its firstFailureAt is ahead of real time),
// so it would otherwise linger until real wall-clock time actually caught up to it.
export function __resetLimitersForTests() {
  emailLimiter.reset();
  ipLimiter.reset();
}

// ---- create ----
export async function createAdmin({ email, password, role, practiceIds = [], createdBy = null }) {
  if (!password || String(password).length < 10) throw httpError('weak_password', 422);

  // Shape validation (email format, role enum, practiceId a real uuid) — catches a malformed
  // CLI arg before it reaches a raw DB query (e.g. a garbage practiceId would otherwise crash
  // with an "invalid input syntax for type uuid" instead of a clean 422).
  const parsed = adminCreateSchema.safeParse({ email, password, role, practiceId: practiceIds[0] });
  if (!parsed.success) throw httpError('validation', 422);
  const normalizedEmail = parsed.data.email;

  if (role === 'admin') {
    if (practiceIds.length) throw httpError('practice_required', 422);
  } else if (role === 'manager') {
    if (practiceIds.length !== 1) throw httpError('practice_required', 422);
    const { rows: activeRows } = await db.query(
      `select id from practices where id = $1 and active`,
      [practiceIds[0]],
    );
    if (!activeRows[0]) throw httpError('practice_required', 422);
  } else {
    throw httpError('validation', 422); // unreachable: adminCreateSchema already rejects this
  }

  const passwordHash = await hashPassword(password);
  const practiceIdsLiteral = `{${practiceIds.join(',')}}`;
  let row;
  try {
    // Projected columns, not `returning *`: password_hash must never leave this function in
    // the returned row, even internally — a future caller (script, route, test) that forwards
    // this object without going through publicAdmin() shouldn't be able to leak it by accident.
    const { rows } = await db.query(
      `insert into admin_users (email, password_hash, role, practice_ids)
       values ($1,$2,$3,$4::uuid[])
       returning id, email, role, practice_ids, active, created_at, last_login_at, sessions_revoked_at`,
      [normalizedEmail, passwordHash, role, practiceIdsLiteral],
    );
    row = rows[0];
  } catch (err) {
    if (err.code === '23505') throw httpError('email_taken', 409); // unique_violation on email
    throw err;
  }

  await logEvent(db, {
    actorId: createdBy, entityType: 'admin_user', entityId: row.id,
    action: 'created', toValue: role,
  });
  return row;
}

// ---- authenticate ----
export async function authenticate(email, password, { ip = null } = {}) {
  const normalizedEmail = normalizeEmail(email);
  emailLimiter.assertNotLimited(normalizedEmail);
  if (ip) ipLimiter.assertNotLimited(ip);

  const { rows } = await db.query(`select * from admin_users where email = $1`, [normalizedEmail]);
  const row = rows[0];
  // Always run a real scrypt compare against SOME hash — the row's own, or the fixed dummy
  // one when there's no row, or (a migrated legacy row) no password_hash yet — so unknown
  // email, null hash, wrong password, and inactive all cost exactly one scrypt and land on
  // the same 401. Never short-circuit on `!row` or `!row.password_hash` before comparing.
  const compareHash = row?.password_hash || (await dummyHash());
  const passwordOk = await verifyPassword(password, compareHash);

  if (!row || !passwordOk || !row.active) {
    emailLimiter.recordFailure(normalizedEmail);
    if (ip) ipLimiter.recordFailure(ip);
    throw httpError('invalid_credentials', 401);
  }

  emailLimiter.clear(normalizedEmail);
  // The IP counter is intentionally NOT cleared on success: one correct login shouldn't let
  // an attacker "launder" a shared IP's budget while still guessing at other accounts on it.
  await db.query(`update admin_users set last_login_at = now() where id = $1`, [row.id]);

  const admin = { id: row.id, email: row.email, role: row.role, practiceIds: normalizePracticeIds(row.practice_ids) };
  const token = issueAdminToken(admin);
  const practices = await practicesForAdmin(admin);
  return { token, admin: publicAdmin(admin, practices) };
}

// ---- tokens ----
// `iat` override: used by changeOwnPassword to hand back a token that's guaranteed valid
// against the sessions_revoked_at it just wrote (see the comment there — jsonwebtoken keeps
// a caller-supplied iat instead of overwriting it, per its own sign.js).
export function issueAdminToken(admin, { iat } = {}) {
  const payload = { sub: admin.id, kind: 'admin', role: admin.role };
  if (iat) payload.iat = iat;
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '12h' });
}

/** Load the acting admin for a verified `kind: 'admin'` token payload; null if it shouldn't work. */
export async function loadAdminForToken(payload) {
  const { rows } = await db.query(`select * from admin_users where id = $1`, [payload.sub]);
  const row = rows[0];
  if (!row || !row.active) return null;
  // FR-03-equivalent for admins: tokens issued before a revocation are dead. Compare at SECOND
  // granularity (iat is seconds, floored) rather than iat*1000 against a sub-second timestamp —
  // the latter falsely kills a token minted in the SAME wall-clock second as the revocation
  // (e.g. a fresh login right after someone else's password is reset via setPassword), because
  // the revocation's own sub-second component almost always sorts after iat's floored-to-:00
  // value even though the token was actually minted after the revoking write committed.
  if (row.sessions_revoked_at && payload.iat < Math.floor(new Date(row.sessions_revoked_at).getTime() / 1000)) {
    return null;
  }
  return { id: row.id, email: row.email, role: row.role, practiceIds: normalizePracticeIds(row.practice_ids) };
}

// ---- shape ----
export function publicAdmin(row, practices) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    practices: practices.map((p) => ({ id: p.id, name: p.name })),
  };
}

// ---- team management (admin-only; the manager fence in middleware/auth.js keeps managers
// off every /admin/team* route before any of this runs) ----
export async function listAdmins() {
  const { rows } = await db.query(
    `select id, email, role, practice_ids, active, last_login_at, created_at
     from admin_users
     order by role, email`,
  );
  const team = [];
  for (const row of rows) {
    const practices = await practicesForAdmin({ role: row.role, practiceIds: normalizePracticeIds(row.practice_ids) });
    team.push({
      id: row.id,
      email: row.email,
      role: row.role,
      practices: practices.map((p) => ({ id: p.id, name: p.name })),
      active: row.active,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,
    });
  }
  return team;
}

export async function setPassword({ id, password, actorId }) {
  const parsed = adminPasswordSchema.safeParse(password);
  if (!parsed.success) throw httpError('weak_password', 422);

  const { rows } = await db.query(`select id from admin_users where id = $1`, [id]);
  if (!rows[0]) throw httpError('not_found', 404);

  const passwordHash = await hashPassword(parsed.data);
  await db.query(
    `update admin_users set password_hash = $1, sessions_revoked_at = now() where id = $2`,
    [passwordHash, id],
  );
  await logEvent(db, { actorId, entityType: 'admin_user', entityId: id, action: 'password_set' });
  return { ok: true };
}

export async function setActive({ id, active, actorId }) {
  // Postgres accepts more than one spelling of the same uuid (case, braces); a raw JS `===`
  // against a differently-cased-but-identical id would miss that it's really you and let the
  // self-guard be bypassed by uppercasing your own id in the URL. Normalize once, up front, and
  // use the normalized form for every comparison/query/log below.
  const normalizedId = String(id).toLowerCase();
  const normalizedActorId = String(actorId).toLowerCase();

  // Unconditional on the requested value: a self-targeting call never makes sense either way
  // (you can't be the one flipping your own switch, whichever direction).
  if (normalizedId === normalizedActorId) throw httpError('cannot_deactivate_self', 409);

  const { rows } = await db.query(`select id from admin_users where id = $1`, [normalizedId]);
  if (!rows[0]) throw httpError('not_found', 404);

  if (active) {
    await db.query(`update admin_users set active = true where id = $1`, [normalizedId]);
  } else {
    // Atomic: the last-admin invariant (at least one OTHER active admin must remain) is folded
    // into this single UPDATE's WHERE clause instead of being read (a separate SELECT COUNT)
    // and then written as two statements — two admins deactivating each other at the exact same
    // instant can't both succeed and leave zero active admins, because Postgres evaluates the
    // EXISTS subquery against the row lock this statement itself takes, not a count read moments
    // earlier that could already be stale by the time the write actually happens. A manager
    // target never carries this constraint — `role <> 'admin'` short-circuits the exists check.
    // `returning id` + checking `rows.length` rather than `rowCount`: PGlite's driver shim
    // (db.js) derives rowCount from rows.length, which is only meaningful when the statement
    // actually returns rows — a bare UPDATE with no RETURNING reads as 0 affected rows on PGlite
    // regardless of how many rows really changed, which would make this ALWAYS look like the
    // invariant blocked it. `returning id` makes the affected-row count accurate on both PGlite
    // and node-postgres. Existence was already confirmed above, so an empty result here can only
    // mean the invariant blocked it, not a missing row.
    const { rows: updated } = await db.query(
      `update admin_users
       set active = false, sessions_revoked_at = now()
       where id = $1
         and (role <> 'admin' or exists (
           select 1 from admin_users a where a.role = 'admin' and a.active and a.id <> $1
         ))
       returning id`,
      [normalizedId],
    );
    if (!updated[0]) throw httpError('last_admin', 409);
  }

  await logEvent(db, {
    actorId, entityType: 'admin_user', entityId: normalizedId,
    action: active ? 'activated' : 'deactivated',
  });
  return { ok: true };
}

// ---- self password change (both roles) ----
export async function changeOwnPassword({ admin, currentPassword, newPassword }) {
  const { rows } = await db.query(`select password_hash from admin_users where id = $1`, [admin.id]);
  const row = rows[0];
  const currentOk = await verifyPassword(currentPassword, row?.password_hash);
  if (!row || !currentOk) throw httpError('wrong_password', 401);

  const parsed = adminPasswordSchema.safeParse(newPassword);
  if (!parsed.success) throw httpError('weak_password', 422);

  const passwordHash = await hashPassword(parsed.data);
  const { rows: updated } = await db.query(
    `update admin_users set password_hash = $1, sessions_revoked_at = now()
     where id = $2 returning sessions_revoked_at`,
    [passwordHash, admin.id],
  );
  await logEvent(db, { actorId: admin.id, entityType: 'admin_user', entityId: admin.id, action: 'password_changed' });

  // A token minted "now" floors its `iat` to the START of the current second; that can read
  // as strictly BEFORE the sessions_revoked_at just written (sub-second precision) if both
  // land in the same wall-clock second — the same race admin-auth.test.js's sleep(1100)
  // calls dodge for a *separate* re-login there. Ceil this token's iat to the next whole
  // second at/after the DB's own revocation instant so the token handed back here is never
  // immediately dead.
  const revokedAtMs = new Date(updated[0].sessions_revoked_at).getTime();
  const iat = Math.ceil(revokedAtMs / 1000);
  const token = issueAdminToken(admin, { iat });

  return { ok: true, token };
}
