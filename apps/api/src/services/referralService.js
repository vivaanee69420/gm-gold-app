// Referral pipeline (FR-08..FR-14): capture, adjacent-only transitions,
// privileged completion (which credits in the same flow), fraud rules.
import { db, logEvent, withTransaction } from '../db.js';
import { creditReferral } from './walletService.js';

export const STATUS_ORDER = ['new', 'contacted', 'booked', 'attended', 'treatment_agreed', 'treatment_completed'];

export async function submitReferral({ code, fullName, treatmentInterest, preferredPracticeId, consentVersion, referredUser, source = 'code' }) {
  const { rows: codeRows } = await db.query(
    `select rc.code, rc.user_id, u.phone as referrer_phone
     from referral_codes rc join users u on u.id = rc.user_id
     where rc.code = $1 and rc.active`,
    [code],
  );
  const codeRow = codeRows[0];
  if (!codeRow) throw Object.assign(new Error('invalid_code'), { status: 404 });
  if (codeRow.referrer_phone === referredUser.phone) {
    throw Object.assign(new Error('self_referral_not_allowed'), { status: 422 });
  }

  return withTransaction(async (client) => {
    let referral;
    try {
      const { rows } = await client.query(
        `insert into referrals (referrer_id, referred_user_id, referred_phone, referred_name,
                                treatment_interest, preferred_practice_id, consent_version, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [codeRow.user_id, referredUser.id, referredUser.phone, fullName, treatmentInterest, preferredPracticeId, consentVersion, source],
      );
      referral = rows[0];
    } catch (err) {
      // Partial unique: first code wins while not lost (FR-11).
      if (String(err.message).includes('referrals_referred_phone_active')) {
        throw Object.assign(new Error('already_referred'), { status: 409 });
      }
      throw err;
    }

    await client.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('user',$1,'friend_used_code',$2),
              ('practice_contact',$3,'new_inquiry',$4)`,
      [
        codeRow.user_id,
        JSON.stringify({ friendName: firstNameInitial(fullName) }),
        preferredPracticeId,
        JSON.stringify({ name: fullName, interest: treatmentInterest }),
      ],
    );
    await client.query(`insert into analytics_events (user_id, name) values ($1,'referral_submitted')`, [referredUser.id]);
    await logEvent(client, { actorId: referredUser.id, entityType: 'referral', entityId: referral.id, action: 'created' });
    return referral;
  });
}

/** Adjacent-only transitions, 409 otherwise; lost needs a reason; completion credits (FR-12/FR-17). */
export async function updateStatus({ referralId, status, lostReason, actorId, privilegedComplete = false }) {
  const { rows } = await db.query(`select * from referrals where id=$1`, [referralId]);
  const referral = rows[0];
  if (!referral) throw Object.assign(new Error('not_found'), { status: 404 });
  const from = referral.status;

  if (from === 'treatment_completed' || from === 'lost') {
    throw Object.assign(new Error('invalid_transition'), { status: 409 });
  }
  if (status === 'lost') {
    if (!lostReason) throw Object.assign(new Error('lost_reason_required'), { status: 422 });
  } else if (status === 'treatment_completed' && privilegedComplete) {
    // privileged jump allowed; skipped stages recorded below
  } else {
    const fromIdx = STATUS_ORDER.indexOf(from);
    const toIdx = STATUS_ORDER.indexOf(status);
    if (toIdx !== fromIdx + 1) throw Object.assign(new Error('invalid_transition'), { status: 409 });
  }
  if (status === 'treatment_completed' && referral.review_status === 'existing_patient_suspect') {
    throw Object.assign(new Error('review_pending'), { status: 409 });
  }

  await db.query(`update referrals set status=$2, lost_reason=$3 where id=$1`, [referralId, status, lostReason ?? null]);
  await logEvent(db, {
    actorId, entityType: 'referral', entityId: referralId, action: 'status_changed',
    fromValue: from, toValue: status,
    reason: privilegedComplete && status === 'treatment_completed' ? `privileged (skipped from ${from})` : lostReason ?? null,
  });

  if (['booked', 'treatment_completed'].includes(status)) {
    await db.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('user',$1,$2,$3)`,
      [referral.referrer_id, status === 'booked' ? 'friend_booked' : 'friend_completed', JSON.stringify({ friendName: firstNameInitial(referral.referred_name) })],
    );
  }

  let credit = null;
  if (status === 'treatment_completed') {
    credit = await creditReferral({
      referral,
      practiceId: referral.preferred_practice_id,
      actorId,
      reason: 'treatment completed (admin confirmed)',
    });
  }
  return { from, to: status, credit };
}

export async function referralsForReferrer(referrerId) {
  const { rows } = await db.query(
    `select r.id, r.referred_name, r.status, r.created_at::date::text as created_at,
            l.amount_pennies as credit_pennies
     from referrals r
     left join wallet_ledger l on l.referral_id = r.id and l.kind='credit'
     where r.referrer_id = $1 order by r.created_at desc`,
    [referrerId],
  );
  return rows.map((r) => ({
    id: r.id,
    friendName: firstNameInitial(r.referred_name),
    status: r.status,
    createdAt: r.created_at,
    creditPennies: r.credit_pennies ?? undefined,
  }));
}

export async function referredStatusFor(userId) {
  const { rows } = await db.query(
    `select r.status, p.name as practice_name, u.first_name as referrer_name
     from referrals r
     left join practices p on p.id = r.preferred_practice_id
     left join users u on u.id = r.referrer_id
     where r.referred_user_id = $1 order by r.created_at desc limit 1`,
    [userId],
  );
  return rows[0]
    ? { status: rows[0].status, practiceName: rows[0].practice_name, referrerName: rows[0].referrer_name }
    : null;
}

/** "Jane Smith" -> "Jane S." (data minimization toward the referrer, NFR-02). */
export function firstNameInitial(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}
