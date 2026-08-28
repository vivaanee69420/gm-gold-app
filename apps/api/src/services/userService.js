import jwt from 'jsonwebtoken';
import { generateCode } from '@gm-referral/shared/referral-code';
import { db, logEvent } from '../db.js';
import { config } from '../config.js';
import { matchPatientIndex } from './dentally/syncService.js';
import { resolveDentallyMode } from './dentally/connectionService.js';

export async function getOrCreateUserByPhone(phone) {
  const found = await db.query(`select * from users where phone = $1`, [phone]);
  if (found.rows[0]) return found.rows[0];
  const created = await db.query(`insert into users (phone) values ($1) returning *`, [phone]);
  // No actorKind: this row is created mid-OTP-verify, before any session exists — there is no
  // acting id to name, and 'user' would imply one. Null is the honest answer.
  await logEvent(db, { entityType: 'user', entityId: created.rows[0].id, action: 'created' });
  return created.rows[0];
}

export function issueToken(user) {
  // Dev sessions: long-lived signed token. Supabase Auth sessions replace this in Stage 2-proper.
  // iatMs: see tokenRevoked() — jwt's own `iat` is whole seconds, too coarse to say whether this
  // token was minted before or after a revocation that happened in the same second.
  return jwt.sign({ sub: user.id, phone: user.phone, iatMs: Date.now() }, config.jwtSecret, { expiresIn: '90d' });
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

export async function saveProfile(userId, { firstName, lastName, notifyOptIn }) {
  const { rows } = await db.query(
    `update users set first_name=$2, last_name=$3, notify_opt_in=$4,
       notify_opt_in_version='notify-v1-2026-08', notify_opt_in_at=now()
     where id=$1 returning *`,
    [userId, firstName, lastName, notifyOptIn],
  );
  return rows[0];
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
    firstName: user.first_name,
    lastName: user.last_name,
    roles,
    verificationStatus: user.verification_status,
    notifyOptIn: user.notify_opt_in,
  };
}
