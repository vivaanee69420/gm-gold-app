// The patients register (2026-09-10): every referred person, who referred them, where they
// booked, and everything that has happened to them since.
//
// A "patient" here is a referred lead — a row in `referrals`. This app deliberately does not
// hold a copy of the wider Dental Os patient list.
//
// The timeline needs no new storage: `events` has recorded every status change with actor and
// timestamp since day one (NFR-03, append-only). It has simply never been displayed.
import { db } from '../db.js';
import { listNotes } from './referralService.js';

// The owning practice, defined the same way everywhere: where they actually booked, falling
// back to the practice the referral form chose.
const OWNING = 'coalesce(r.booked_practice_id, r.preferred_practice_id)';

export async function listPatients(scope) {
  const { rows } = await db.query(
    `select r.id, r.referred_name, r.referred_phone, r.referred_email, r.status,
            r.appointment_starts_at, r.created_at::date::text as created_at,
            coalesce(bp.name, pp.name) as practice,
            u.first_name || ' ' || coalesce(u.last_name,'') as referrer,
            wl.amount_pennies as commission_pennies
       from referrals r
       left join practices pp on pp.id = r.preferred_practice_id
       left join practices bp on bp.id = r.booked_practice_id
       join users u on u.id = r.referrer_id
       left join wallet_ledger wl on wl.referral_id = r.id and wl.kind = 'credit'
      ${scope ? `where ${OWNING} = any($1::uuid[])` : ''}
      order by r.created_at desc`,
    scope ? [scope] : [],
  );
  return rows;
}

/** Null when the id is unknown OR outside `scope` — the caller 404s either way, on purpose. */
export async function patientDetail(referralId, scope) {
  const { rows } = await db.query(
    `select r.id, r.referred_name, r.referred_phone, r.referred_email, r.status,
            r.treatment_interest, r.treatment_name, r.doctor_name, r.treatment_value_pennies,
            r.source, r.lost_reason,
            r.appointment_starts_at, r.appointment_dentally_id, r.created_at,
            pp.name as chosen_practice, bp.name as booked_practice,
            u.id as referrer_id, u.first_name || ' ' || coalesce(u.last_name,'') as referrer_name,
            u.phone as referrer_phone, rc.code as referrer_code,
            wl.amount_pennies as commission_pennies, wl.created_at as commission_at
       from referrals r
       left join practices pp on pp.id = r.preferred_practice_id
       left join practices bp on bp.id = r.booked_practice_id
       join users u on u.id = r.referrer_id
       left join lateral (
         select code from referral_codes
         where user_id = r.referrer_id and active
         order by created_at desc limit 1
       ) rc on true
       left join wallet_ledger wl on wl.referral_id = r.id and wl.kind = 'credit'
      where r.id = $1 ${scope ? `and ${OWNING} = any($2::uuid[])` : ''}`,
    scope ? [referralId, scope] : [referralId],
  );
  const row = rows[0];
  if (!row) return null;

  // events.entity_id is text; referral ids are uuids, hence the cast at the write site too.
  const { rows: timeline } = await db.query(
    `select e.action, e.from_value, e.to_value, e.reason, e.actor_kind, e.created_at,
            au.email as actor_email
       from events e
       left join admin_users au on au.id::text = e.actor_id
      where e.entity_type = 'referral' and e.entity_id = $1
      order by e.created_at asc`,
    [String(referralId)],
  );

  return {
    patient: {
      id: row.id,
      name: row.referred_name,
      phone: row.referred_phone,
      email: row.referred_email,
      status: row.status,
      // What the patient picked on the form, then what the practice is actually doing. Both,
      // never one overwriting the other — commission attribution reads the first.
      treatmentInterest: row.treatment_interest,
      treatmentName: row.treatment_name ?? null,
      doctorName: row.doctor_name ?? null,
      treatmentValuePennies: row.treatment_value_pennies ?? null,
      source: row.source,
      lostReason: row.lost_reason,
      referredAt: row.created_at,
    },
    referrer: {
      id: row.referrer_id,
      name: row.referrer_name,
      phone: row.referrer_phone,
      code: row.referrer_code,
    },
    practice: {
      chosen: row.chosen_practice,
      // Null until Dental Os reports an appointment. When it differs from `chosen`, the
      // patient booked somewhere other than the practice on their referral link.
      booked: row.booked_practice ?? null,
    },
    appointment: {
      startsAt: row.appointment_starts_at,
      dentallyId: row.appointment_dentally_id,
    },
    commission: {
      amountPennies: row.commission_pennies ?? null,
      creditedAt: row.commission_at ?? null,
    },
    notes: await listNotes(referralId),
    timeline: timeline.map((e) => ({
      action: e.action,
      from: e.from_value,
      to: e.to_value,
      reason: e.reason,
      actorKind: e.actor_kind,
      actorEmail: e.actor_email,
      at: e.created_at,
    })),
  };
}
