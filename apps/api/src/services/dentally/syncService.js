// Dentally sync worker (FR-16). One pass =
//
//   pg_try_advisory_lock('dentally_sync')      -- skip if another instance holds it
//     ├─ refreshPatientIndex()                 -- patients cursor → dentally_patient_index upserts
//     │                                           (phone AND email; either alone is indexable,
//     │                                            neither is not — see the check constraint)
//     ├─ scanCompletions()                     -- appointments cursor → completed appts
//     │     └─ exact E.164 match against open referrals
//     │        + eligibility (completed AFTER referral submitted)
//     │        + a paid invoice for the patient
//     │        → completion_proposals (unique per dentally_event_id — idempotent)
//     ├─ clawbackRefunded()                    -- credit reversed when the payment that
//     │                                          earned it is no longer paid in Dentally
//     ├─ flagExistingPatients()                -- FR-11: referred person was ALREADY a
//     │                                          patient -> existing_patient_suspect,
//     │                                          which blocks the credit
//     └─ expireUnbookedReferrals()             -- referrals that never got booked in time
//   unlock
//
// No referrer verification pass: anyone can refer (2026-09-09). The Dentally check that
// matters is on the REFERRED person — their phone is what confirms the booking and the
// treatment, which is what releases commission.
//
// Watermarks (sync_state) advance only after a page is fully processed, so a
// crash mid-page re-scans that page and the unique event id absorbs the replay.
import { db, logEvent } from '../../db.js';
import { dentallyClient } from './client.js';
import { resolveDentallyMode } from './connectionService.js';
import { expireUnbookedReferrals } from '../referralService.js';
import { clawbackReferralCredit } from '../walletService.js';

const APPTS_CURSOR = 'dentally_appointments';
const PATIENTS_CURSOR = 'dentally_patients';

let inFlight = false; // in-process guard; the advisory lock covers other instances

let currentMode = 'stub'; // set at the top of each runSync pass

function initialWatermark() {
  // Real sources (live Dentally / Dental Os): 30 days back on first run, so we never
  // scan years of history. Stub: epoch, so tests and dev fixtures are always in range.
  return currentMode === 'stub'
    ? '1970-01-01T00:00:00.000Z'
    : new Date(Date.now() - 30 * 86_400_000).toISOString();
}

async function getWatermark(key) {
  const { rows } = await db.query(`select watermark from sync_state where key=$1`, [key]);
  return rows[0] ? new Date(rows[0].watermark).toISOString() : initialWatermark();
}

async function setWatermark(key, iso) {
  await db.query(
    `insert into sync_state (key, watermark) values ($1,$2)
     on conflict (key) do update set watermark=$2, updated_at=now()`,
    [key, iso],
  );
}

const maxUpdatedAt = (items, fallback) =>
  items.reduce((acc, x) => (x.updatedAt && x.updatedAt > acc ? x.updatedAt : acc), fallback);

const practiceBySite = new Map(); // per-run cache; cleared at the top of runSync

async function practiceIdForSite(siteId) {
  if (!siteId) return null;
  if (!practiceBySite.has(siteId)) {
    const { rows } = await db.query(`select id from practices where dentally_site_id=$1`, [siteId]);
    practiceBySite.set(siteId, rows[0]?.id ?? null);
  }
  return practiceBySite.get(siteId);
}

/** One multi-row upsert per page — the backfill would crawl doing 500 single inserts. */
async function batchUpsertPatientIndex(patients) {
  const byId = new Map(); // dedup within the page (last write wins), else ON CONFLICT errors
  // At least one key, not specifically a phone: an email-only contact is indexable now and
  // is the case the two-key match exists to strengthen. A contact with neither is unmatchable
  // and only costs space on every pass (the table has a check constraint saying the same).
  for (const p of patients) if (p?.phone || p?.email) byId.set(p.id, p);
  const rows = [];
  for (const p of byId.values()) {
    rows.push([p.id, p.phone ?? null, p.email ?? null, await practiceIdForSite(p.siteId)]);
  }
  if (!rows.length) return 0;
  const values = rows.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4},now())`).join(',');
  await db.query(
    `insert into dentally_patient_index (dentally_patient_id, phone, email, practice_id, refreshed_at)
     values ${values}
     on conflict (dentally_patient_id) do update
       set phone=excluded.phone, email=excluded.email,
           practice_id=excluded.practice_id, refreshed_at=now()`,
    rows.flat(),
  );
  return rows.length;
}

// Page-by-watermark: process a page, advance the cursor past it, re-query page 1 of the
// NEW window (querying page 2 of a moved window would skip rows). Advance-on-success only:
// a crash mid-page re-scans it and unique event ids absorb the replay. The guard caps one
// run at 50 pages — anything beyond waits for the next cron tick.
async function drainPages(cursorKey, fetchPage, processPage) {
  let watermark = await getWatermark(cursorKey);
  let processed = 0;
  for (let guard = 0; guard < 50; guard += 1) {
    const { items, hasMore } = await fetchPage(watermark);
    processed += await processPage(items);
    const advanced = maxUpdatedAt(items, watermark);
    if (items.length) await setWatermark(cursorKey, advanced);
    if (!hasMore) break;
    if (advanced === watermark) {
      console.warn(`[dentally] ${cursorKey}: page full of identical updated_at — deferring to next run`);
      break;
    }
    watermark = advanced;
  }
  return processed;
}

// Match a referral to a Dentally patient: exact E.164 phone first, email as the
// fallback (FR-16e) — covers portal bookings whose phone Dentally stored differently.
const matchesPatient = (referral, patient) =>
  (patient.phone && referral.referred_phone === patient.phone) ||
  (patient.email && referral.referred_email && referral.referred_email.trim().toLowerCase() === patient.email);

const patientKeys = (patients) => {
  const values = [...patients.values()];
  return {
    phones: [...new Set(values.filter((p) => p?.phone).map((p) => p.phone))],
    emails: [...new Set(values.filter((p) => p?.email).map((p) => p.email))],
  };
};

async function refreshPatientIndex(client) {
  return drainPages(
    PATIENTS_CURSOR,
    (updatedAfter) => client.listPatients({ updatedAfter }),
    (patients) => batchUpsertPatientIndex(patients),
  );
}

/**
 * One page of appointments → proposals. Batched: resolve patients (source-local, cheap),
 * refresh the index in one upsert, match ALL page phones against open referrals in one
 * query (almost always empty), then do the per-match eligibility + paid-invoice work.
 */
async function processCompletedPage(client, appointments) {
  const completed = appointments.filter((a) => a.completedAt && a.patientId);
  if (!completed.length) return 0;

  const patients = new Map();
  for (const a of completed) {
    if (!patients.has(a.patientId)) patients.set(a.patientId, await client.getPatient(a.patientId));
  }
  await batchUpsertPatientIndex([...patients.values()].filter(Boolean)); // one read path (FR-16c)

  const { phones, emails } = patientKeys(patients);
  if (!phones.length && !emails.length) return 0;
  const { rows: referrals } = await db.query(
    `select * from referrals
     where (referred_phone = any($1) or lower(referred_email) = any($2))
       and status not in ('lost','treatment_completed')`,
    [phones, emails],
  );
  if (!referrals.length) return 0;

  let created = 0;
  for (const appointment of completed) {
    const patient = patients.get(appointment.patientId);
    if (!patient?.phone && !patient?.email) continue;
    const matching = referrals.filter((r) => matchesPatient(r, patient));
    if (!matching.length) continue;

    let paidInvoice; // fetched once per appointment, only when a referral matched
    for (const referral of matching) {
      // Eligibility: only treatments completed AFTER the referral was submitted (FR-16b).
      if (new Date(appointment.completedAt) <= new Date(referral.created_at)) continue;

      if (paidInvoice === undefined) {
        const { items: invoices } = await client.listInvoices({ patientId: appointment.patientId });
        // Creditable = ANY paid invoice for THIS treatment. Two deliberate parts:
        //
        //   amount: does not matter (decision 2026-09-09). A minimum-spend threshold was built
        //   and removed. The data would have supported one — half these patients pay across
        //   several invoices, the first averaging £246 of £2,548 eventually paid over 258 days,
        //   and the largest band of first invoices is under £50 — but paying referrers promptly
        //   on any real payment won. Do not reintroduce a threshold without asking.
        //
        //   date: must be on or after the referral. `invoices.find((i) => i.paid)` alone
        //   accepted any paid invoice EVER, so a returning patient's years-old invoice
        //   satisfied "they have paid" — 31.5% of recent attendees have one dated more than 30
        //   days before their appointment, so this was not theoretical. flagExistingPatients is
        //   the primary defence against those people; this is the second line, for when that
        //   check could not run or was fooled by a duplicate contact record.
        const referredOn = new Date(referral.created_at).toISOString().slice(0, 10);
        paidInvoice = invoices.find((i) => i.paid && (!i.paidOn || i.paidOn >= referredOn)) ?? null;
      }
      if (!paidInvoice) continue; // no paid invoice for this treatment yet — not creditable

      // A manager already credited this one — the outcome the proposal exists to produce has
      // happened. Filing it anyway just puts a chore in the owner's queue for settled work.
      // Note: `client` here is the Dentally SOURCE client (listInvoices/getPatient above) —
      // this check, like the completion_proposals insert below it, needs the module-level `db`.
      const { rows: alreadyCredited } = await db.query(
        `select 1 from wallet_ledger where referral_id = $1 and kind = 'credit' limit 1`,
        [referral.id],
      );
      if (alreadyCredited[0]) continue;

      const invoiceState = `paid${paidInvoice.paidOn ? ` ${paidInvoice.paidOn}` : ''}${
        paidInvoice.amountPennies != null ? ` £${(paidInvoice.amountPennies / 100).toFixed(2)}` : ''
      }`;
      const { rows: inserted } = await db.query(
        `insert into completion_proposals (referral_id, dentally_event_id, matched_phone, invoice_state, treating_practice_id)
         values ($1,$2,$3,$4,$5)
         on conflict (dentally_event_id) do nothing
         returning id`,
        [
          referral.id,
          `appointment-${appointment.id}`,
          patient.phone ?? patient.email,
          invoiceState,
          await practiceIdForSite(appointment.siteId),
        ],
      );
      if (inserted[0]) {
        created += 1;
        await logEvent(db, {
          actorKind: 'system', // the sync worker, not a person
          entityType: 'proposal',
          entityId: inserted[0].id,
          action: 'created',
          toValue: referral.id,
          reason: `dentally appointment-${appointment.id}`,
        });
      }
    }
  }
  return created;
}

/**
 * One page of appointments → booked referrals. A future, uncancelled appointment for
 * a phone with an open referral (new/contacted) confirms the friend's Dentally booking:
 * the referral moves to 'booked' with the appointment time, the app's "Your appointment"
 * page fills in, and the referrer is notified. Rebooking refreshes the stored time.
 */
async function processBookedPage(client, appointments) {
  const upcoming = appointments.filter((a) => a.startsAt && !a.completedAt && !a.cancelled && a.patientId);
  if (!upcoming.length) return 0;

  const patients = new Map();
  for (const a of upcoming) {
    if (!patients.has(a.patientId)) patients.set(a.patientId, await client.getPatient(a.patientId));
  }
  const { phones, emails } = patientKeys(patients);
  if (!phones.length && !emails.length) return 0;
  const { rows: referrals } = await db.query(
    `select id, referrer_id, referred_name, referred_phone, referred_email, status,
            appointment_dentally_id, booked_practice_id, preferred_practice_id
     from referrals
     where (referred_phone = any($1) or lower(referred_email) = any($2))
       and status in ('new','contacted','booked')`,
    [phones, emails],
  );
  if (!referrals.length) return 0;

  let booked = 0;
  for (const appointment of upcoming) {
    const patient = patients.get(appointment.patientId);
    if (!patient?.phone && !patient?.email) continue;
    for (const referral of referrals.filter((r) => matchesPatient(r, patient))) {
      const fromStatus = referral.status;
      const isNewBooking = fromStatus !== 'booked';
      // Already booked: only refresh the time for the SAME appointment (a reschedule).
      if (!isNewBooking && referral.appointment_dentally_id !== `appointment-${appointment.id}`) continue;

      // Where the appointment actually is. This is what puts the lead in front of the manager
      // who can advance them — the referral form's choice is often not where they booked.
      const bookedPracticeId = await practiceIdForSite(appointment.siteId);
      const previousOwner = referral.booked_practice_id ?? referral.preferred_practice_id;

      const { rows: updated } = await db.query(
        `update referrals set status='booked', appointment_dentally_id=$2, appointment_starts_at=$3,
                              booked_practice_id=coalesce($4, booked_practice_id)
         where id=$1 and status in ('new','contacted','booked') returning id`,
        [referral.id, `appointment-${appointment.id}`, appointment.startsAt, bookedPracticeId],
      );
      if (!updated[0] || !isNewBooking) continue;
      booked += 1;
      referral.status = 'booked';
      referral.appointment_dentally_id = `appointment-${appointment.id}`;
      await logEvent(db, {
        actorKind: 'system',
        entityType: 'referral', entityId: referral.id, action: 'status_changed',
        fromValue: fromStatus, toValue: 'booked', reason: `dentally appointment-${appointment.id}`,
      });
      if (bookedPracticeId && bookedPracticeId !== previousOwner) {
        await logEvent(db, {
          actorKind: 'system',
          entityType: 'referral',
          entityId: referral.id,
          action: 'practice_reassigned',
          fromValue: previousOwner,
          toValue: bookedPracticeId,
          reason: `dentally appointment-${appointment.id}`,
        });
      }
      referral.booked_practice_id = bookedPracticeId ?? referral.booked_practice_id;
      await db.query(
        `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
         values ('user',$1,'friend_booked',$2)`,
        [referral.referrer_id, JSON.stringify({ friendName: referral.referred_name.split(' ')[0] })],
      );
    }
  }
  return booked;
}

async function scanCompletions(client) {
  let proposals = 0;
  let bookings = 0;
  await drainPages(
    APPTS_CURSOR,
    (updatedAfter) => client.listAppointments({ updatedAfter }),
    async (appointments) => {
      bookings += await processBookedPage(client, appointments);
      proposals += await processCompletedPage(client, appointments);
      return appointments.length;
    },
  );
  return { proposals, bookings };
}

/** FR-05 auto-resolve: pending_review referrers with a now-clean index match become verified. */
/**
 * FR-11: flag referrals whose "new patient" was already a patient here.
 *
 * The commission rule (2026-09-09): the REFERRER can be anyone, but the REFERRED person must
 * be genuinely new. Existing patient means they have a COMPLETED appointment in Dental OS
 * dated before the referral was submitted — treated here before, whether or not an invoice was
 * ever raised (NHS work, a free check-up and warranty work are all treatment with no invoice).
 *
 * Measured against real data 2026-09-09: ~63% of people attending these practices in a given
 * quarter had been treated before. Without this, most commission would go on patients who were
 * already yours.
 *
 * Runs here, in the sync, rather than at submission — which is what FR-11 asks for: never block
 * a referral being submitted, retry when Dentally is unreachable, and apply retroactively if
 * the evidence arrives late.
 *
 * `hasPriorTreatment` returning null means COULD NOT CHECK (the live Dentally REST path does
 * not implement it). That is skipped, not treated as clean — marking an unchecked referral as
 * fine is how you end up paying on existing patients silently.
 */
async function flagExistingPatients(client) {
  const { rows: candidates } = await db.query(
    `select id, referred_phone, referred_email, created_at
       from referrals
      where review_status is null
        and status not in ('lost', 'treatment_completed')`,
  );
  let flagged = 0;
  for (const referral of candidates) {
    const prior = await client.hasPriorTreatment({
      phone: referral.referred_phone,
      email: referral.referred_email ? referral.referred_email.trim().toLowerCase() : null,
      before: referral.created_at,
    });
    if (prior !== true) continue; // false = genuinely new; null = could not check, try next pass

    await db.query(`update referrals set review_status='existing_patient_suspect' where id=$1`, [referral.id]);
    await logEvent(db, {
      actorKind: 'system',
      entityType: 'referral',
      entityId: referral.id,
      action: 'existing_patient_flagged',
      reason: 'completed appointment in Dental OS predating the referral',
    });
    flagged += 1;
  }
  return flagged;
}

/**
 * Reverse commission when the treatment that earned it gets refunded.
 *
 * Dental OS emits no refund event — a reversed payment just shows up as an invoice that is no
 * longer paid. So the only way to see one is to re-ask the question that justified the credit
 * and notice the answer changed.
 *
 * Runs every pass over every credited referral. That is a small set (one row per paid
 * referral) and the query is indexed, so re-checking forever is cheap and means a refund six
 * months later is still caught.
 *
 * null from the client means COULD NOT CHECK — skipped, never treated as a refund. Clawing back
 * money because Dentally was briefly unreachable would be far worse than catching it late.
 */
async function clawbackRefunded(client) {
  const { rows: credited } = await db.query(
    `select distinct r.id, r.referred_phone, r.referred_email, r.created_at
       from referrals r
       join wallet_ledger w on w.referral_id = r.id and w.kind = 'credit'
      where not exists (
        select 1 from wallet_ledger c
         where c.referral_id = r.id and c.idempotency_key = 'clawback:' || r.id::text
      )`,
  );
  let clawedBack = 0;
  for (const referral of credited) {
    const stillPaid = await client.hasQualifyingPaidInvoice({
      phone: referral.referred_phone,
      email: referral.referred_email ? referral.referred_email.trim().toLowerCase() : null,
      since: new Date(referral.created_at).toISOString().slice(0, 10),
    });
    if (stillPaid !== false) continue; // true = fine; null = could not check, try next pass

    const reversed = await clawbackReferralCredit(
      referral.id,
      'payment reversed in Dentally after the credit was issued',
    );
    if (reversed) {
      clawedBack += 1;
      console.error(`[dentally] clawed back commission for referral ${referral.id} — payment reversed`);
    }
  }
  return clawedBack;
}

/** One full sync pass. Safe to call from the cron interval, a webhook, or an admin button. */
let rerunQueued = false;

export async function runSync(trigger = 'manual') {
  const mode = await resolveDentallyMode();
  if (mode === 'off') return { skipped: 'off' };
  if (inFlight) {
    // Doorbell rang mid-pass: queue exactly one follow-up so the event that rang it
    // is picked up seconds later, not on the next cron tick.
    rerunQueued = true;
    return { skipped: 'in_flight', rerunQueued: true };
  }
  inFlight = true;
  currentMode = mode;
  practiceBySite.clear();
  try {
    return await db.withClient(async (lockClient) => {
      const { rows } = await lockClient.query(`select pg_try_advisory_lock(hashtext('dentally_sync')) as ok`);
      if (!rows[0].ok) return { skipped: 'locked' }; // another instance is mid-run (FR-16 global lock)
      try {
        const client = dentallyClient(mode);
        const patientsIndexed = await refreshPatientIndex(client);
        const { proposals: proposalsCreated, bookings: bookingsDetected } = await scanCompletions(client);
        const existingPatientsFlagged = await flagExistingPatients(client);
        const clawedBack = await clawbackRefunded(client);
        const referralsExpired = await expireUnbookedReferrals();
        const summary = { trigger, patientsIndexed, proposalsCreated, bookingsDetected, existingPatientsFlagged, clawedBack, referralsExpired };
        if (proposalsCreated || bookingsDetected || existingPatientsFlagged || clawedBack || referralsExpired) console.log('[dentally] sync', JSON.stringify(summary));
        return summary;
      } finally {
        await lockClient.query(`select pg_advisory_unlock(hashtext('dentally_sync'))`);
      }
    });
  } catch (err) {
    // Alertable log line (NFR-04): the next cron tick retries; watermarks make retries safe.
    console.error(`[dentally] sync failed (${trigger}):`, err.message);
    return { error: err.message };
  } finally {
    inFlight = false;
    if (rerunQueued) {
      rerunQueued = false;
      setTimeout(() => runSync('doorbell-rerun').catch(() => {}), 1000);
    }
  }
}

/** FR-25 aging report: referrals sitting at booked/treatment_agreed/treatment_started ≥ N days with no proposal. */
export async function agingReport(days = 7) {
  const { rows } = await db.query(
    `select r.id, r.referred_name, r.referred_phone, r.status, p.name as practice,
            u.first_name || ' ' || coalesce(u.last_name,'') as referrer,
            greatest(0, extract(day from now() - coalesce(
              (select max(e.created_at) from events e
               where e.entity_type='referral' and e.entity_id=r.id::text and e.action='status_changed'),
              r.created_at)))::int as days_waiting
     from referrals r
     join users u on u.id = r.referrer_id
     left join practices p on p.id = r.preferred_practice_id
     where r.status in ('booked','treatment_agreed','treatment_started')
       and not exists (select 1 from completion_proposals cp where cp.referral_id = r.id)
       and coalesce(
             (select max(e.created_at) from events e
              where e.entity_type='referral' and e.entity_id=r.id::text and e.action='status_changed'),
             r.created_at) <= now() - ($1 || ' days')::interval
     order by days_waiting desc`,
    [String(days)],
  );
  return rows;
}
