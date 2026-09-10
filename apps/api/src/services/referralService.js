// Referral pipeline (FR-08..FR-14): capture, adjacent-only transitions,
// privileged completion (which credits in the same flow), fraud rules.
import { normalizePhone } from '@gm-referral/shared/phone';
import { missingTreatmentDetails } from '@gm-referral/shared/schemas';
import { db, logEvent, withTransaction } from '../db.js';
import { config } from '../config.js';
import { creditReferral } from './walletService.js';

export const STATUS_ORDER = ['new', 'contacted', 'booked', 'attended', 'treatment_agreed', 'treatment_started', 'treatment_completed'];

export async function submitReferral({ code, fullName, email, phone, treatmentInterest, preferredPracticeId, consentVersion, referredUser, source = 'code' }) {
  // The phone the friend will book with at Dentally is what commission matching
  // runs on — accept an override, normalized, falling back to the account phone.
  const referredPhone = (phone ? normalizePhone(phone) : null) ?? referredUser.phone;
  if (phone && !normalizePhone(phone)) throw Object.assign(new Error('validation'), { status: 422 });

  const { rows: codeRows } = await db.query(
    `select rc.code, rc.user_id, u.phone as referrer_phone
     from referral_codes rc join users u on u.id = rc.user_id
     where rc.code = $1 and rc.active`,
    [code],
  );
  const codeRow = codeRows[0];
  if (!codeRow) throw Object.assign(new Error('invalid_code'), { status: 404 });
  if (codeRow.referrer_phone === referredPhone) {
    throw Object.assign(new Error('self_referral_not_allowed'), { status: 422 });
  }

  return withTransaction(async (client) => {
    let referral;
    try {
      const { rows } = await client.query(
        `insert into referrals (referrer_id, referred_user_id, referred_phone, referred_name, referred_email,
                                treatment_interest, preferred_practice_id, consent_version, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [codeRow.user_id, referredUser.id, referredPhone, fullName, email ?? null, treatmentInterest, preferredPracticeId, consentVersion, source],
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
    await logEvent(client, { actorId: referredUser.id, actorKind: 'user', entityType: 'referral', entityId: referral.id, action: 'created' });
    return referral;
  });
}

/** Adjacent-only transitions, 409 otherwise; lost needs a reason; completion credits (FR-12/FR-17). */
export async function updateStatus({ referralId, status, lostReason, actorId, actorKind = null, privilegedComplete = false, practiceIds = null }) {
  const { rows } = await db.query(`select * from referrals where id=$1`, [referralId]);
  const referral = rows[0];
  if (!referral) throw Object.assign(new Error('not_found'), { status: 404 });

  // A manager may only touch their own practice's patients. 404 rather than 403 on purpose:
  // a 403 tells someone who should not know that this referral id exists at all. `null` means
  // unrestricted (an admin); an empty array means a manager with no practice, who reaches nothing.
  if (practiceIds !== null) {
    const owning = referral.booked_practice_id ?? referral.preferred_practice_id;
    if (!owning || !practiceIds.includes(owning)) {
      throw Object.assign(new Error('not_found'), { status: 404 });
    }
  }

  const from = referral.status;

  if (from === 'treatment_completed' || from === 'lost') {
    throw Object.assign(new Error('invalid_transition'), { status: 409 });
  }
  if (status === 'lost') {
    if (!lostReason) throw Object.assign(new Error('lost_reason_required'), { status: 422 });
  } else if (privilegedComplete && (status === 'treatment_started' || status === 'treatment_completed')) {
    // privileged jump allowed; skipped stages recorded below
  } else {
    const fromIdx = STATUS_ORDER.indexOf(from);
    const toIdx = STATUS_ORDER.indexOf(status);
    if (toIdx !== fromIdx + 1) throw Object.assign(new Error('invalid_transition'), { status: 409 });
  }
  // The gate must cover every transition that releases money, not just the last one. The
  // credit fires at treatment_started AND treatment_completed (the "at or past" rule), so a
  // gate that named only treatment_completed would let a flagged referral be paid one step
  // earlier — which is the whole population FR-11 exists to exclude.
  if ((status === 'treatment_started' || status === 'treatment_completed')
      && referral.review_status === 'existing_patient_suspect') {
    throw Object.assign(new Error('review_pending'), { status: 409 });
  }

  // What a commission credit has to be able to point at afterwards: the treatment, the dentist
  // who agreed it, and its value. Both crediting stages are gated, not just treatment_started —
  // the dashboard sends privilegedComplete, so a jump straight to Completed releases the same
  // money and would otherwise be the way around this. The Dentally proposal path writes
  // treatment_completed with its own UPDATE (proposalService), so it is unaffected.
  if (status === 'treatment_started' || status === 'treatment_completed') {
    const missing = missingTreatmentDetails(referral);
    if (missing.length) {
      throw Object.assign(new Error('treatment_details_required'), { status: 422, missing });
    }
  }

  await db.query(`update referrals set status=$2, lost_reason=$3 where id=$1`, [referralId, status, lostReason ?? null]);
  await logEvent(db, {
    actorId, actorKind, entityType: 'referral', entityId: referralId, action: 'status_changed',
    fromValue: from, toValue: status,
    reason: privilegedComplete && status === 'treatment_completed' ? `privileged (skipped from ${from})` : lostReason ?? null,
  });

  if (status === 'booked') {
    await db.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('user',$1,'friend_booked',$2)`,
      [referral.referrer_id, JSON.stringify({ friendName: firstNameInitial(referral.referred_name) })],
    );
  }

  // "At or past treatment_started, if not already credited" — deliberately NOT "exactly on
  // treatment_started". The privileged path can jump straight to treatment_completed, and a
  // narrower condition would silently never pay that referrer. The partial unique index
  // wallet_ledger_one_credit_per_referral makes the second call a no-op, not a double payment.
  let credit = null;
  if (status === 'treatment_started' || status === 'treatment_completed') {
    try {
      credit = await creditReferral({
        referral,
        // The practice that is actually treating them owns the commission (FR-15 rule
        // resolution is per-practice), falling back to the practice the form chose.
        practiceId: referral.booked_practice_id ?? referral.preferred_practice_id,
        actorId,
        actorKind,
        reason: `${status === 'treatment_started' ? 'treatment started' : 'treatment completed'} (${actorKind ?? 'system'} confirmed)`,
      });
    } catch (err) {
      // already_credited is the expected, correct outcome of started -> completed. Anything
      // else (no_active_rule, a real failure) still propagates.
      if (err.message !== 'already_credited') throw err;
    }
  }

  // Tied to the credit, not to a status. The money is what the referrer is being told about,
  // and `credit` is non-null exactly once per referral (the partial unique index guarantees
  // it), so this fires on whichever transition actually paid them — treatment_started in the
  // normal flow, or a privileged jump straight to treatment_completed — and never twice.
  if (credit) {
    await db.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('user',$1,'friend_completed',$2)`,
      [referral.referrer_id, JSON.stringify({ friendName: firstNameInitial(referral.referred_name) })],
    );
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

/**
 * Booking window (FR: 12h default): an unbooked referral (new/contacted, no Dentally
 * appointment) older than the window flips to 'lost'. That frees the friend's phone
 * (partial unique index skips lost) so they start the flow from the beginning.
 * Runs from the sync worker and lazily on status reads.
 */
export async function expireUnbookedReferrals() {
  const { rows } = await db.query(
    `update referrals set status='lost'
     where status in ('new','contacted') and appointment_dentally_id is null
       and created_at < now() - make_interval(hours => $1)
     returning id, referred_name`,
    [config.referralBookingWindowHours],
  );
  for (const r of rows) {
    await logEvent(db, {
      actorKind: 'system', // the booking-window sweep, not a person
      entityType: 'referral',
      entityId: r.id,
      action: 'status_changed',
      toValue: 'lost',
      reason: `booking_window_expired_${config.referralBookingWindowHours}h`,
    });
  }
  return rows.length;
}

export async function referredStatusFor(userId) {
  await expireUnbookedReferrals();
  const { rows } = await db.query(
    `select r.status, r.appointment_starts_at, p.name as practice_name, p.booking_url,
            u.first_name as referrer_name
     from referrals r
     left join practices p on p.id = r.preferred_practice_id
     left join users u on u.id = r.referrer_id
     where r.referred_user_id = $1 and r.status <> 'lost'
     order by r.created_at desc limit 1`,
    [userId],
  );
  return rows[0]
    ? {
        status: rows[0].status,
        practiceName: rows[0].practice_name,
        referrerName: rows[0].referrer_name,
        bookingUrl: rows[0].booking_url,
        appointmentStartsAt: rows[0].appointment_starts_at,
      }
    : null;
}

/** "Jane Smith" -> "Jane S." (data minimization toward the referrer, NFR-02). */
export function firstNameInitial(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
}

// ---- the pipeline card's own fields (0018) ----
//
// Both of these hang off a referral, so both need the same practice fence the status PATCH
// has: a manager may only touch their own practice's patients, and an id outside that scope
// answers 404 rather than 403 — a 403 would confirm to someone who should not know that this
// referral exists at all.
const OWNING_PRACTICE = 'coalesce(booked_practice_id, preferred_practice_id)';

async function referralInScope(referralId, practiceIds) {
  const { rows } = await db.query(
    `select id from referrals
      where id = $1 ${practiceIds ? `and ${OWNING_PRACTICE} = any($2::uuid[])` : ''}`,
    practiceIds ? [referralId, practiceIds] : [referralId],
  );
  if (!rows[0]) throw Object.assign(new Error('not_found'), { status: 404 });
}

/**
 * What was agreed: the treatment, the dentist, and what it is worth. Distinct from
 * `treatment_interest`, which is the enum the patient picked on the referral form and stays
 * untouched because commission attribution reads it. Any field may be null — the requirement
 * lands at the move that pays, not here.
 */
export async function setTreatmentDetails({
  referralId, treatmentName, doctorName, treatmentValuePennies, actorId, practiceIds = null,
}) {
  await referralInScope(referralId, practiceIds);
  const { rows } = await db.query(
    `update referrals
        set treatment_name = $2, doctor_name = $3, treatment_value_pennies = $4
      where id = $1
      returning treatment_name, doctor_name, treatment_value_pennies`,
    [referralId, treatmentName ?? null, doctorName ?? null, treatmentValuePennies ?? null],
  );
  const row = rows[0];
  await logEvent(db, {
    actorId, actorKind: 'admin', entityType: 'referral', entityId: String(referralId),
    action: 'treatment_details_changed',
    toValue: [row.treatment_name, row.doctor_name, row.treatment_value_pennies]
      .map((v) => (v === null ? '—' : v)).join(' · '),
  });
  return {
    treatmentName: row.treatment_name,
    doctorName: row.doctor_name,
    treatmentValuePennies: row.treatment_value_pennies,
  };
}

export async function listNotes(referralId) {
  const { rows } = await db.query(
    `select n.id, n.body, n.created_at, au.email as author_email
       from referral_notes n
       left join admin_users au on au.id = n.author_admin_id
      where n.referral_id = $1
      order by n.created_at asc`,
    [referralId],
  );
  return rows.map((n) => ({
    id: n.id,
    body: n.body,
    author: n.author_email ?? null,
    createdAt: n.created_at,
  }));
}

export async function addNote({ referralId, body, actorId, practiceIds = null }) {
  await referralInScope(referralId, practiceIds);
  const { rows } = await db.query(
    `insert into referral_notes (referral_id, body, author_admin_id)
     values ($1, $2, $3) returning id`,
    [referralId, body, actorId],
  );
  return { id: rows[0].id, notes: await listNotes(referralId) };
}

/**
 * Scoped by referral as well as by note id: without the referral in the where clause, a
 * manager could delete a note on another practice's patient by guessing its id alone.
 */
export async function deleteNote({ referralId, noteId, practiceIds = null }) {
  await referralInScope(referralId, practiceIds);
  const { rows } = await db.query(
    `delete from referral_notes where id = $1 and referral_id = $2 returning id`,
    [noteId, referralId],
  );
  if (!rows[0]) throw Object.assign(new Error('not_found'), { status: 404 });
  return { ok: true, notes: await listNotes(referralId) };
}
