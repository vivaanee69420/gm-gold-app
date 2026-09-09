import jwt from 'jsonwebtoken';
import { generateCode } from '@gm-referral/shared/referral-code';
import { db, logEvent } from '../db.js';
import { config } from '../config.js';
import { matchPatientIndex } from './dentally/syncService.js';
import { resolveDentallyMode } from './dentally/connectionService.js';

/**
 * The patient profile row for a verified Supabase identity.
 *
 * `users.id` IS `auth.users.id` — the same uuid, deliberately not a join table and not a
 * mapping column, so there is nothing to keep in sync and no way for the two to diverge.
 * There is no foreign key to `auth.users` though: db.js runs migrations unconditionally,
 * including under PGlite in tests, and PGlite has no `auth` schema at all. The link is an
 * invariant this function maintains, not one the database enforces.
 *
 * Called on every authenticated request, so the common path is a single indexed SELECT.
 * Insert only happens on a patient's very first request after signing up.
 */
export async function getOrCreateUserByAuthId({ sub, email }) {
  const found = await db.query(`select * from users where id = $1`, [sub]);
  if (found.rows[0]) {
    // Supabase is the source of truth for the address. Backfill a row created before the
    // email was confirmed, and follow an address change made through Supabase.
    if (email && found.rows[0].email !== email) {
      const { rows } = await db.query(
        `update users set email = $2, email_verified_at = now() where id = $1 returning *`,
        [sub, email],
      );
      return rows[0];
    }
    return found.rows[0];
  }

  // Two concurrent first requests (the app firing /me and /practices at once) both miss the
  // select above. ON CONFLICT makes the loser a no-op rather than a 500, and the reselect
  // below gives it the winner's row. `phone` is null here by design — it is captured at the
  // profile step, and the referrer path gates on its presence.
  const created = await db.query(
    `insert into users (id, email, email_verified_at) values ($1, $2, now())
     on conflict (id) do nothing returning *`,
    [sub, email],
  );
  if (created.rows[0]) {
    // No actorKind: the row is created on the user's first authenticated request, and while
    // there is now a session, naming the actor as the row being created reads as circular.
    await logEvent(db, { entityType: 'user', entityId: created.rows[0].id, action: 'created' });
    return created.rows[0];
  }
  const raced = await db.query(`select * from users where id = $1`, [sub]);
  return raced.rows[0] ?? null;
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

/**
 * Was this token minted before `revokedAt` (FR-03 "sign out everywhere", and the admin
 * equivalent)? Tokens carry `iatMs` — milliseconds at issue — so the answer is exact. Tokens
 * minted before that claim existed fall back to comparing jwt's own second-granularity `iat`
 * against the revocation floored to the same granularity: coarse, but it errs towards keeping
 * a token alive rather than killing one minted in the very second of the revocation that
 * preceded it (a fresh login right after a password change is exactly that case).
 */
export function tokenRevoked(payload, revokedAt) {
  if (!revokedAt) return false;
  const revokedMs = new Date(revokedAt).getTime();
  if (typeof payload.iatMs === 'number') return payload.iatMs < revokedMs;
  return payload.iat < Math.floor(revokedMs / 1000);
}

export async function getUser(id) {
  const { rows } = await db.query(`select * from users where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function saveProfile(userId, { firstName, lastName, phone, notifyOptIn }) {
  try {
    const { rows } = await db.query(
      `update users set first_name=$2, last_name=$3, phone=$4, phone_verified_at=null,
         notify_opt_in=$5, notify_opt_in_version='notify-v1-2026-08', notify_opt_in_at=now()
       where id=$1 returning *`,
      [userId, firstName, lastName, phone, notifyOptIn],
    );
    return rows[0];
  } catch (err) {
    // users.phone is unique. Two accounts claiming one number is a real case now that
    // identity is email: a patient who signs up twice with different addresses, or someone
    // typing a number that is not theirs. 23505 is Postgres' unique_violation.
    //
    // phone_verified_at stays null above deliberately: the number is self-declared. What
    // makes it trustworthy is matching a Dentally contact that ALSO matches the verified
    // email (FR-05, two-key match), not the fact that someone typed it.
    if (err.code === '23505') {
      throw Object.assign(new Error('phone_taken'), { status: 409 });
    }
    throw err;
  }
}

export async function pickRole(userId, role) {
  if (role === 'referrer') {
    // Referrer verification (FR-05): exact phone match against the Dentally patient
    // index. One clean match → verified (linked to the Dentally record); none or
    // several (shared family number) → pending_review for the admin queue, with the
    // sync worker auto-resolving once a clean match appears. Mode 'off' keeps the
    // pre-Stage-5 dev-verify so the loop stays walkable without any Dentally at all.
    if ((await resolveDentallyMode()) === 'off') {
      await db.query(`update users set role_referrer=true, verification_status='verified' where id=$1`, [userId]);
    } else {
      const user = await getUser(userId);
      const match = await matchPatientIndex(user.phone);
      if (match.status === 'verified') {
        await db.query(
          `update users set role_referrer=true, verification_status='verified',
             dentally_patient_id=$2, practice_id=$3 where id=$1`,
          [userId, match.dentallyPatientId, match.practiceId],
        );
      } else {
        await db.query(`update users set role_referrer=true, verification_status='pending_review' where id=$1`, [userId]);
        await logEvent(db, {
          actorId: userId, actorKind: 'user', entityType: 'user', entityId: userId,
          action: 'verification_pending', reason: match.reason,
        });
      }
    }
    const existing = await db.query(`select code from referral_codes where user_id=$1 and active`, [userId]);
    if (!existing.rows[0]) {
      let attempts = 0;
      for (;;) {
        try {
          await db.query(`insert into referral_codes (user_id, code) values ($1,$2)`, [userId, generateCode()]);
          break;
        } catch (err) {
          if (++attempts > 5) throw err; // collision retry
        }
      }
    }
  } else {
    await db.query(`update users set role_referred=true where id=$1`, [userId]);
  }
  await logEvent(db, { actorId: userId, actorKind: 'user', entityType: 'user', entityId: userId, action: 'role_picked', toValue: role });
  return publicUser(await getUser(userId));
}

export async function publicUserWithCode(user) {
  if (!user) return null;
  const out = publicUser(user);
  if (user.role_referrer) {
    const { rows } = await db.query(`select code from referral_codes where user_id=$1 and active limit 1`, [user.id]);
    out.referralCode = rows[0]?.code ?? null;
  }
  return out;
}

export function publicUser(user) {
  if (!user) return null;
  const roles = [];
  if (user.role_referrer) roles.push('referrer');
  if (user.role_referred) roles.push('referred');
  return {
    id: user.id,
    phone: user.phone,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    roles,
    verificationStatus: user.verification_status,
    notifyOptIn: user.notify_opt_in,
    // The app gates the referrer role on having a phone on file (it is the Dentally
    // matching key), so it needs to know without inferring from a null.
    needsPhone: !user.phone,
  };
}
