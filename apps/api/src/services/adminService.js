// Admin identity: email + password accounts, two roles (admin = everything/all practices,
// manager = one practice/payouts only). Owns hashing, creation, authentication, token
// issue/load, and the public admin shape — auth.js and app.js stay thin callers of this.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { db, logEvent } from '../db.js';
import { config } from '../config.js';

const httpError = (message, status) => Object.assign(new Error(message), { status });

// ---- password hashing (node:crypto scrypt) ----
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, SCRYPT_OPTS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT_OPTS);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A fixed hash compared against on an unknown email, so a login attempt against a
// nonexistent account takes the same time as one against a real (wrong-password) one.
let dummyHashCache = null;
function dummyHash() {
  if (!dummyHashCache) dummyHashCache = hashPassword('dummy-password-for-timing-uniformity-only');
  return dummyHashCache;
}

const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

// uuid[] comes back as a JS array from pg, a '{...}' literal from some drivers.
function normalizePracticeIds(raw) {
  if (Array.isArray(raw)) return raw;
  return String(raw ?? '{}').replace(/[{}"]/g, '').split(',').filter(Boolean);
}

async function practicesForAdmin({ role, practiceIds }) {
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

// ---- login rate limit: 5 failures / 15 min per email, in-memory (mirrors otpService's pattern) ----
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const failuresByEmail = new Map();

function assertNotRateLimited(email) {
  const entry = failuresByEmail.get(email);
  if (entry && entry.count >= MAX_FAILURES && Date.now() - entry.firstFailureAt < FAILURE_WINDOW_MS) {
    throw httpError('rate_limited', 429);
  }
}

function recordFailure(email) {
  const entry = failuresByEmail.get(email);
  if (!entry || Date.now() - entry.firstFailureAt >= FAILURE_WINDOW_MS) {
    failuresByEmail.set(email, { count: 1, firstFailureAt: Date.now() });
  } else {
    entry.count += 1;
  }
}

function clearFailures(email) {
  failuresByEmail.delete(email);
}

// ---- create ----
export async function createAdmin({ email, password, role, practiceIds = [], createdBy = null }) {
  const normalizedEmail = normalizeEmail(email);
  if (!password || String(password).length < 10) throw httpError('weak_password', 422);

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
    throw httpError('validation', 422);
  }

  const passwordHash = hashPassword(password);
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
export async function authenticate(email, password) {
  const normalizedEmail = normalizeEmail(email);
  assertNotRateLimited(normalizedEmail);

  const { rows } = await db.query(`select * from admin_users where email = $1`, [normalizedEmail]);
  const row = rows[0];
  // Always run a real scrypt compare, even for an unknown email, so timing doesn't leak
  // whether the account exists.
  const passwordOk = row ? verifyPassword(password, row.password_hash) : (verifyPassword(password, dummyHash()), false);

  if (!row || !passwordOk || !row.active) {
    recordFailure(normalizedEmail);
    throw httpError('invalid_credentials', 401);
  }

  clearFailures(normalizedEmail);
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
