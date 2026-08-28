// Proposal decisions (FR-17) and the FR-05 verification queue.
//
// Confirm is ONE transaction under the referrer's wallet lock (NFR-09):
//   proposal open→confirmed  +  referral →treatment_completed (privileged)
//   +  ledger credit (rule resolved per FR-15)  +  outbox rows  +  audit events
// Any failure rolls the whole thing back; the one-credit-per-referral partial
// unique index is the last line of defence against double crediting.
import { db, logEvent, withWalletLock } from '../../db.js';
import { resolveRule } from '../walletService.js';
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

  const practiceId = proposal.treating_practice_id ?? referral.preferred_practice_id;
  const rule = await resolveRule(practiceId);
  if (!rule) throw httpError('no_active_rule', 409);

  return withWalletLock(referral.referrer_id, async (client) => {
    const { rows: decided } = await client.query(
      `update completion_proposals set status='confirmed', decided_by=$2, decided_at=now()
       where id=$1 and status='open' returning id`,
      [proposalId, adminId],
    );
    if (!decided[0]) throw httpError('proposal_not_open', 409); // raced another admin click

    const { rows: transitioned } = await client.query(
      `update referrals set status='treatment_completed'
       where id=$1 and status not in ('lost','treatment_completed') returning status`,
      [referral.id],
    );

    let credit;
    try {
      const { rows: creditRows } = await client.query(
        `insert into wallet_ledger (user_id, kind, amount_pennies, referral_id, rule_id, practice_id, reason, created_by)
         values ($1,'credit',$2,$3,$4,$5,$6,$7) returning *`,
        [
          referral.referrer_id,
          rule.amount_pennies,
          referral.id,
          rule.id,
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
        JSON.stringify({ amountPennies: rule.amount_pennies, referralId: referral.id }),
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
      action: 'credit', toValue: String(rule.amount_pennies), reason: `proposal ${proposalId}`,
    });
    return { ok: true, credit: { amountPennies: credit.amount_pennies } };
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

export async function pendingVerifications() {
  const { rows } = await db.query(
    `select id, phone, first_name, last_name, created_at from users
     where role_referrer and verification_status='pending_review'
     order by created_at asc`,
  );
  return rows;
}

export async function decideVerification(userId, adminId, { approve, dentallyPatientId = null }) {
  const { rows } = await db.query(`select * from users where id=$1 and verification_status='pending_review'`, [userId]);
  if (!rows[0]) throw httpError('not_pending', 409);

  if (approve) {
    await db.query(
      `update users set verification_status='verified', dentally_patient_id=coalesce($2, dentally_patient_id) where id=$1`,
      [userId, dentallyPatientId],
    );
  } else {
    // Rejected referrers keep the account but their code stops working.
    await db.query(`update users set verification_status='rejected' where id=$1`, [userId]);
    await db.query(`update referral_codes set active=false where user_id=$1`, [userId]);
  }
  await db.query(
    `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
     values ('user',$1,$2,'{}'::jsonb)`,
    [userId, approve ? 'verification_approved' : 'verification_rejected'],
  );
  await logEvent(db, {
    actorId: adminId, actorKind: 'admin', entityType: 'user', entityId: userId,
    action: approve ? 'verification_approved' : 'verification_rejected',
  });
  return { ok: true };
}
