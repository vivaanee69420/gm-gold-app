// Proposal decisions (FR-17) and the FR-05 verification queue.
//
// Confirm is ONE transaction under the referrer's wallet lock (NFR-09):
//   proposal open→confirmed  +  referral →treatment_completed (privileged)
//   +  ledger credit (the tier on the referral)  +  outbox rows  +  audit events
// Any failure rolls the whole thing back; the one-credit-per-referral partial
// unique index is the last line of defence against double crediting.
import { db, logEvent, withWalletLock } from '../../db.js';
import { firstNameInitial } from '../referralService.js';

const httpError = (message, status) => Object.assign(new Error(message), { status });

export async function openProposals() {
  const { rows } = await db.query(
    `select cp.id, cp.matched_phone, cp.invoice_state, cp.created_at,
            r.id as referral_id, r.referred_name, r.status as referral_status, r.review_status,
            u.first_name || ' ' || coalesce(u.last_name,'') as referrer,
            coalesce(tp.name, pp.name) as practice
     from completion_proposals cp
     join referrals r on r.id = cp.referral_id
     join users u on u.id = r.referrer_id
     left join practices tp on tp.id = cp.treating_practice_id
     left join practices pp on pp.id = r.preferred_practice_id
     where cp.status = 'open'
     order by cp.created_at asc`,
  );
  return rows;
}

export async function confirmProposal(proposalId, adminId) {
  const { rows } = await db.query(`select * from completion_proposals where id=$1`, [proposalId]);
  const proposal = rows[0];
  if (!proposal || proposal.status !== 'open') throw httpError('proposal_not_open', 409);

  const { rows: refRows } = await db.query(`select * from referrals where id=$1`, [proposal.referral_id]);
  const referral = refRows[0];
  if (referral.review_status === 'existing_patient_suspect') throw httpError('review_pending', 409); // FR-17
  if (referral.status === 'lost') throw httpError('invalid_transition', 409);

  // Canonical owning-practice resolution (same coalesce order as referralService.js,
  // digestService.js and app.js): the actual booked practice outranks the form's original
  // choice. treating_practice_id (the Dentally appointment site) outranks both — it is what
  // the treatment actually happened at.
  const practiceId = proposal.treating_practice_id ?? referral.booked_practice_id ?? referral.preferred_practice_id;

  // The tier the practice manager picked on the card (2026-09-11, replacing FR-15's rule
  // resolution). This path has no gate of its own — updateStatus's missingTreatmentDetails
  // check guards the manager route, not this one — so confirming refuses outright rather than
  // guessing an amount. The Confirm queue is no longer one click for an unpriced referral:
  // someone has to open it and choose, which is the accepted cost of per-referral control.
  const amountPennies = referral.commission_pennies;
  if (!Number.isSafeInteger(amountPennies) || amountPennies <= 0) {
    throw httpError('commission_not_set', 409);
  }

  return withWalletLock(referral.referrer_id, async (client) => {
    const { rows: decided } = await client.query(
      `update completion_proposals set status='confirmed', decided_by=$2, decided_at=now()
       where id=$1 and status='open' returning id`,
      [proposalId, adminId],
    );
    if (!decided[0]) throw httpError('proposal_not_open', 409); // raced another admin click

    // The manager path may have credited this referral already. That is success, not a
    // conflict: mark the proposal resolved, advance the referral to its final stage, and
    // write no second ledger row.
    const { rows: existing } = await client.query(
      `select id from wallet_ledger where referral_id = $1 and kind = 'credit' limit 1`,
      [referral.id],
    );

    const { rows: transitioned } = await client.query(
      `update referrals set status='treatment_completed'
       where id=$1 and status not in ('lost','treatment_completed') returning status`,
      [referral.id],
    );

    if (existing[0]) {
      await logEvent(client, {
        actorId: adminId, actorKind: 'admin', entityType: 'proposal', entityId: proposalId,
        action: 'confirmed', toValue: referral.id,
        reason: 'already credited by manager — no second credit written',
      });
      if (transitioned[0]) {
        await logEvent(client, {
          actorId: adminId, actorKind: 'admin', entityType: 'referral', entityId: referral.id,
          action: 'status_changed', fromValue: referral.status, toValue: 'treatment_completed',
          reason: 'dentally proposal confirmed (already credited)',
        });
      }
      return { ok: true, credit: null, alreadyCredited: true };
    }

    let credit;
    try {
      const { rows: creditRows } = await client.query(
        // rule_id null: no rule decided this any more. Historical credits keep theirs, which
        // is why reward_rules and its rows still exist.
        `insert into wallet_ledger (user_id, kind, amount_pennies, referral_id, rule_id, practice_id, reason, created_by)
         values ($1,'credit',$2,$3,null,$4,$5,$6) returning *`,
        [
          referral.referrer_id,
          amountPennies,
          referral.id,
          practiceId,
          `dentally proposal confirmed (${proposal.invoice_state ?? 'completed'})`,
          adminId,
        ],
      );
      credit = creditRows[0];
    } catch (err) {
      if (String(err.message).includes('wallet_ledger_one_credit_per_referral')) {
        throw httpError('already_credited', 409); // a second event proposed the same referral — first credit stands
      }
      throw err;
    }

    await client.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('user',$1,'friend_completed',$2), ('user',$1,'wallet_credit',$3)`,
      [
        referral.referrer_id,
        JSON.stringify({ friendName: firstNameInitial(referral.referred_name) }),
        JSON.stringify({ amountPennies, referralId: referral.id }),
      ],
    );
    await logEvent(client, {
      actorId: adminId, actorKind: 'admin', entityType: 'proposal', entityId: proposalId, action: 'confirmed', toValue: referral.id,
    });
    if (transitioned[0]) {
      await logEvent(client, {
        actorId: adminId, actorKind: 'admin', entityType: 'referral', entityId: referral.id, action: 'status_changed',
        fromValue: referral.status, toValue: 'treatment_completed',
        reason: `privileged (dentally proposal, skipped from ${referral.status})`,
      });
    }
    await logEvent(client, {
      actorId: adminId, actorKind: 'admin', entityType: 'wallet', entityId: referral.referrer_id,
      action: 'credit', toValue: String(amountPennies), reason: `proposal ${proposalId}`,
    });
    return { ok: true, credit: { amountPennies: credit.amount_pennies }, alreadyCredited: false };
  });
}

export async function rejectProposal(proposalId, adminId, reason) {
  if (!reason) throw httpError('reason_required', 422);
  const { rows } = await db.query(
    `update completion_proposals set status='rejected', decided_by=$2, decided_at=now(), reason=$3
     where id=$1 and status='open' returning id`,
    [proposalId, adminId, reason],
  );
  if (!rows[0]) throw httpError('proposal_not_open', 409);
  await logEvent(db, { actorId: adminId, actorKind: 'admin', entityType: 'proposal', entityId: proposalId, action: 'rejected', reason });
  return { ok: true };
}

// ---- FR-05 verification queue ----
