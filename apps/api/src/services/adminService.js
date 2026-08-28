// Admin identity: email + password accounts, two roles (admin = everything/all practices,
// manager = one practice/payouts only). Owns hashing, creation, authentication, token
// issue/load, and the public admin shape — auth.js and app.js stay thin callers of this.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { adminCreateSchema } from '@gm-referral/shared/schemas';
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
function normalizePracticeIds(raw) {
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
  };
}

const emailLimiter = makeLimiter(MAX_EMAIL_FAILURES);
const ipLimiter = makeLimiter(MAX_IP_FAILURES);

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
    const { rows } = await db.query(
      `insert into admin_users (email, password_hash, role, practice_ids)
       values ($1,$2,$3,$4::uuid[]) returning *`,
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
export function issueAdminToken(admin) {
  return jwt.sign({ sub: admin.id, kind: 'admin', role: admin.role }, config.jwtSecret, { expiresIn: '12h' });
}

/** Load the acting admin for a verified `kind: 'admin'` token payload; null if it shouldn't work. */
export async function loadAdminForToken(payload) {
  const { rows } = await db.query(`select * from admin_users where id = $1`, [payload.sub]);
  const row = rows[0];
  if (!row || !row.active) return null;
  // FR-03-equivalent for admins: tokens issued before a revocation are dead (iat is in seconds).
  if (row.sessions_revoked_at && payload.iat * 1000 < new Date(row.sessions_revoked_at).getTime()) return null;
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
