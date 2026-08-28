// Admin identity: email + password accounts, two roles (admin = everything/all practices,
// manager = one practice/payouts only). Owns hashing, creation, authentication, token
// issue/load, and the public admin shape — auth.js and app.js stay thin callers of this.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { adminCreateSchema, adminPasswordSchema } from '@gm-referral/shared/schemas';
import { db, logEvent, withTransaction } from '../db.js';
import { tokenRevoked } from './userService.js';
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
// per-email-AND-IP limit (defends one account against a targeted guesser) and a coarse per-IP
// limit in front of it (defends the login route itself against one source hammering many
// emails). The strict key deliberately includes the IP: keyed on the email alone, anyone who
// knows an address could burn its five attempts and lock the real owner out from their own
// network — a one-request denial of service per account. A guesser rotating IPs to dodge the
// strict counter still runs into the 30-per-IP ceiling on every address they use.
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

const strictLimiter = makeLimiter(MAX_EMAIL_FAILURES);
const ipLimiter = makeLimiter(MAX_IP_FAILURES);

// One bucket per (email, source) pair. A request with no IP at all (a direct service call in
// a test, or a proxy that stripped it) falls back to a single shared 'no-ip' bucket.
const strictKey = (email, ip) => `${email}|${ip ?? 'no-ip'}`;

// Test-only: wipe both limiters' state. Needed alongside __setClockForTests whenever a test
// advances the clock into a simulated future — an entry recorded under that fake "now" reads
// as not-yet-expired once the real clock resumes (its firstFailureAt is ahead of real time),
// so it would otherwise linger until real wall-clock time actually caught up to it.
export function __resetLimitersForTests() {
  strictLimiter.reset();
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
    // Not practice_required: an admin isn't missing a practice, it can't have one at all.
    if (practiceIds.length) throw httpError('practice_not_allowed', 422);
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
    // createdBy is null when the bootstrap CLI (scripts/create-admin.js) runs it — there is no
    // acting account then, so the kind stays null rather than claiming one.
    actorId: createdBy, actorKind: createdBy ? 'admin' : null,
    entityType: 'admin_user', entityId: row.id, action: 'created', toValue: role,
  });
  return row;
}

// ---- authenticate ----
export async function authenticate(email, password, { ip = null } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const strict = strictKey(normalizedEmail, ip);
  strictLimiter.assertNotLimited(strict);
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
    strictLimiter.recordFailure(strict);
    if (ip) ipLimiter.recordFailure(ip);
    throw httpError('invalid_credentials', 401);
  }

  strictLimiter.clear(strict);
  // The IP counter is intentionally NOT cleared on success: one correct login shouldn't let
  // an attacker "launder" a shared IP's budget while still guessing at other accounts on it.
  await db.query(`update admin_users set last_login_at = now() where id = $1`, [row.id]);

  const admin = { id: row.id, email: row.email, role: row.role, practiceIds: normalizePracticeIds(row.practice_ids) };
  const token = issueAdminToken(admin);
  const practices = await practicesForAdmin(admin);
  return { token, admin: publicAdmin(admin, practices) };
}

// ---- tokens ----
// `iatMs` (milliseconds at issue) is what revocation compares against — jwt's own `iat` is
// whole seconds, too coarse to order a token against a revocation in the same second. The
// override is used by the password-change paths to mint a token pinned to the exact
// sessions_revoked_at they just wrote, so it is never born already dead.
export function issueAdminToken(admin, { iatMs = Date.now() } = {}) {
  return jwt.sign({ sub: admin.id, kind: 'admin', role: admin.role, iatMs }, config.jwtSecret, { expiresIn: '12h' });
}

/** Load the acting admin for a verified `kind: 'admin'` token payload; null if it shouldn't work. */
export async function loadAdminForToken(payload) {
  const { rows } = await db.query(`select * from admin_users where id = $1`, [payload.sub]);
  const row = rows[0];
  if (!row || !row.active) return null;
  // FR-03-equivalent for admins: tokens issued before a revocation are dead, judged to the
  // millisecond via the token's iatMs claim (see tokenRevoked in userService.js).
  if (tokenRevoked(payload, row.sessions_revoked_at)) return null;
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
  // Same normalization as setActive below, for the same reason (Postgres accepts more than one
  // spelling of the same uuid) and for audit-log consistency — the events row should record the
  // same canonical id regardless of how the caller cased the URL param.
  const normalizedId = String(id).toLowerCase();
  const isSelf = normalizedId === String(actorId).toLowerCase();

  const parsed = adminPasswordSchema.safeParse(password);
  if (!parsed.success) throw httpError('weak_password', 422);

  const { rows } = await db.query(`select id, role from admin_users where id = $1`, [normalizedId]);
  const row = rows[0];
  if (!row) throw httpError('not_found', 404);

  const passwordHash = await hashPassword(parsed.data);
  const { rows: updated } = await db.query(
    `update admin_users set password_hash = $1, sessions_revoked_at = now()
     where id = $2 returning sessions_revoked_at`,
    [passwordHash, normalizedId],
  );
  await logEvent(db, {
    actorId, actorKind: 'admin', entityType: 'admin_user', entityId: normalizedId, action: 'password_set',
  });

  // Targeting yourself is allowed but revokes YOUR sessions too — hand back a replacement token
  // pinned to the revocation instant, exactly as changeOwnPassword does, so the caller isn't
  // logged out by their own click. (The dashboard hides this control on your own row and points
  // at "Change password" instead; this keeps every other caller of the route honest.)
  if (isSelf) {
    const token = issueAdminToken(
      { id: row.id, role: row.role },
      { iatMs: new Date(updated[0].sessions_revoked_at).getTime() },
    );
    return { ok: true, token };
  }
  return { ok: true };
}

// Move a manager to a different practice. Admin-only (the manager fence in middleware/auth.js
// keeps managers off every /admin/team* route), and the practice must pass the same
// active-practice check createAdmin applies. Nothing else about the account moves: no password
// reset, no revocation — loadAdminForToken re-reads practice_ids on every request, so the new
// scope is live on the manager's very next call.
export async function setPractice({ id, practiceId, actorId }) {
  const normalizedId = String(id).toLowerCase();

  const parsed = z.string().uuid().safeParse(practiceId);
  if (!parsed.success) throw httpError('validation', 422); // same code createAdmin gives a bad uuid

  const { rows } = await db.query(`select id, role, practice_ids from admin_users where id = $1`, [normalizedId]);
  const row = rows[0];
  if (!row) throw httpError('not_found', 404);
  // An admin covers every practice by construction (createAdmin refuses to give one a practice
  // id at all), so there is no scope to move.
  if (row.role !== 'manager') throw httpError('validation', 422);

  const { rows: activeRows } = await db.query(`select id from practices where id = $1 and active`, [parsed.data]);
  if (!activeRows[0]) throw httpError('practice_required', 422);

  const from = normalizePracticeIds(row.practice_ids)[0] ?? null;
  await db.query(`update admin_users set practice_ids = $2::uuid[] where id = $1`, [normalizedId, `{${parsed.data}}`]);
  await logEvent(db, {
    actorId, actorKind: 'admin', entityType: 'admin_user', entityId: normalizedId,
    action: 'practice_changed', fromValue: from, toValue: parsed.data,
  });
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

  // Real atomicity, not just a same-statement EXISTS: under READ COMMITTED, an EXISTS subquery
  // reads its own snapshot at the moment IT runs — two admins deactivating EACH OTHER from two
  // separate connections can each see "yes, the other one is still active" and both pass, then
  // both write, leaving zero active admins. A single UPDATE...EXISTS is not a lock; it only helps
  // against a second statement on the SAME connection. The fix is a session-scoped Postgres
  // advisory lock (pg_advisory_xact_lock, auto-released at COMMIT/ROLLBACK) taken FIRST, inside
  // one transaction, on one client: every setActive call serializes behind this one lock, so by
  // the time a transaction's own existence-check and update run, no other setActive transaction
  // can be concurrently mutating admin_users — the EXISTS is then evaluating a true, temporarily-
  // exclusive view of the table, not a race-prone snapshot. (PGlite is single-connection, so this
  // can't be exercised as a true cross-connection race in this test suite the way it would
  // against pooled Postgres — the concurrent-dispatch probe used to validate this only proves the
  // SQL-level guard fires correctly under concurrent JS scheduling, not genuine MVCC contention.)
  await withTransaction(async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('admin_users'))`);

    const { rows } = await client.query(`select id from admin_users where id = $1`, [normalizedId]);
    if (!rows[0]) throw httpError('not_found', 404);

    if (active) {
      await client.query(`update admin_users set active = true where id = $1`, [normalizedId]);
    } else {
      // `returning id` + checking rows.length rather than a driver's `rowCount`: PGlite's driver
      // shim (db.js) derives rowCount from rows.length, which is only meaningful when the
      // statement actually returns rows — a bare UPDATE with no RETURNING reads as 0 affected
      // rows on PGlite regardless of how many rows really changed. `returning id` makes the
      // affected-row count accurate on both PGlite and node-postgres. Existence was already
      // confirmed above (same transaction, same lock held), so an empty result here can only mean
      // the last-admin invariant blocked it, not a missing row.
      const { rows: updated } = await client.query(
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
  });

  await logEvent(db, {
    actorId, actorKind: 'admin', entityType: 'admin_user', entityId: normalizedId,
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
  await logEvent(db, { actorId: admin.id, actorKind: 'admin', entityType: 'admin_user', entityId: admin.id, action: 'password_changed' });

  // Pin the replacement token's iatMs to the revocation instant this call just wrote, so it
  // reads as "not before" its own revocation however the clocks round.
  const token = issueAdminToken(admin, { iatMs: new Date(updated[0].sessions_revoked_at).getTime() });

  return { ok: true, token };
}
