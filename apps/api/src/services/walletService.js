// Wallet — every mutation runs under the per-user advisory lock (NFR-09):
//
//   credit / debit / adjust / payout-request / mark-paid
//        └── BEGIN
//            SELECT pg_advisory_xact_lock(hashtext(user_id))
//            re-read balance inside the lock
//            assert invariants (balance >= 0, threshold met, one credit per referral)
//            write ledger row(s) + outbox row in the SAME transaction
//        └── COMMIT
import { db, logEvent, withWalletLock } from '../db.js';
import { firstNameInitial } from './referralService.js';

export async function getSetting(key, fallback = null) {
  const { rows } = await db.query(`select value from app_settings where key=$1`, [key]);
  return rows[0]?.value ?? fallback;
}

async function balanceOf(client, userId) {
  const { rows } = await client.query(
    `select coalesce(sum(amount_pennies),0)::int as balance from wallet_ledger where user_id=$1`,
    [userId],
  );
  return rows[0].balance;
}

/** Resolve the active rule: treating practice scope first, else global (FR-15). */
export async function resolveRule(practiceId) {
  const { rows } = await db.query(
    `select * from reward_rules
     where active_from <= now() and (practice_id = $1 or practice_id is null)
     order by (practice_id is null) asc, active_from desc
     limit 1`,
    [practiceId],
  );
  return rows[0] ?? null;
}

/** Credit a completed referral (FR-17/FR-18 manual path). One credit per referral, enforced twice. */
export async function creditReferral({ referral, practiceId, actorId, actorKind = null, idempotencyKey = null, reason = null }) {
  const rule = await resolveRule(practiceId);
  if (!rule) throw Object.assign(new Error('no_active_rule'), { status: 409 });

  return withWalletLock(referral.referrer_id, async (client) => {
    try {
      const { rows } = await client.query(
        `insert into wallet_ledger (user_id, kind, amount_pennies, referral_id, rule_id, practice_id, idempotency_key, reason, created_by)
         values ($1,'credit',$2,$3,$4,$5,$6,$7,$8) returning *`,
        [referral.referrer_id, rule.amount_pennies, referral.id, rule.id, practiceId, idempotencyKey, reason, actorId],
      );
      await client.query(
        `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
         values ('user',$1,'wallet_credit',$2)`,
        [referral.referrer_id, JSON.stringify({ amountPennies: rule.amount_pennies, referralId: referral.id })],
      );
      await logEvent(client, {
        actorId, actorKind, entityType: 'wallet', entityId: referral.referrer_id,
        action: 'credit', toValue: String(rule.amount_pennies), reason,
      });
      return rows[0];
    } catch (err) {
      // Partial unique index (one credit per referral) or idempotency key replay.
      if (String(err.message).includes('wallet_ledger_one_credit_per_referral') || String(err.message).includes('idempotency_key')) {
        const dup = Object.assign(new Error('already_credited'), { status: 409 });
        throw dup;
      }
      throw err;
    }
  });
}

export async function walletFor(userId) {
  const threshold = Number(await getSetting('payout_threshold_pennies', '10000'));
  return withWalletLock(userId, async (client) => {
    const balance = await balanceOf(client, userId);
    const { rows: ledger } = await client.query(
      `select l.id, l.kind, l.amount_pennies, l.reason, l.created_at::date::text as at,
              r.referred_name, p.name as practice_name
       from wallet_ledger l
       left join referrals r on r.id = l.referral_id
       left join payout_requests pr on pr.id = l.payout_id
       left join practices p on p.id = coalesce(pr.practice_id, l.practice_id)
       where l.user_id = $1 order by l.created_at desc limit 50`,
      [userId],
    );
    const { rows: lifetimeRows } = await client.query(
      `select coalesce(sum(amount_pennies),0)::int as lifetime from wallet_ledger where user_id=$1 and kind='credit'`,
      [userId],
    );
    const { rows: openRows } = await client.query(
      `select pr.*, p.name as practice_name from payout_requests pr
       join practices p on p.id = pr.practice_id
       where pr.user_id=$1 and pr.status='open'`,
      [userId],
    );
    const open = openRows[0];
    return {
      balancePennies: balance,
      thresholdPennies: threshold,
      lifetimePennies: lifetimeRows[0].lifetime,
      openPayout: open
        ? { id: open.id, amountPennies: open.amount_pennies, practiceName: open.practice_name, status: open.status }
        : null,
      ledger: ledger.map((l) => ({
        id: l.id,
        kind: l.kind,
        amountPennies: l.amount_pennies,
        note:
          l.kind === 'credit'
            ? `${l.referred_name ? firstNameInitial(l.referred_name) : 'Referral'} completed treatment`
            : l.kind === 'debit'
              ? `Collected at ${l.practice_name ?? 'practice'}`
              : (l.reason ?? 'Adjustment'),
        at: l.at,
      })),
    };
  });
}

export async function requestPayout(userId, practiceId) {
  const threshold = Number(await getSetting('payout_threshold_pennies', '10000'));
  return withWalletLock(userId, async (client) => {
    const balance = await balanceOf(client, userId);
    if (balance < threshold) throw Object.assign(new Error('below_threshold'), { status: 409 });
    const { rows } = await client.query(
      `insert into payout_requests (user_id, amount_pennies, practice_id) values ($1,$2,$3) returning *`,
      [userId, balance, practiceId],
    ).catch((err) => {
      if (String(err.message).includes('payout_requests_one_open_per_user')) {
        throw Object.assign(new Error('payout_already_open'), { status: 409 });
      }
      throw err;
    });
    await logEvent(client, { actorId: userId, actorKind: 'user', entityType: 'payout', entityId: rows[0].id, action: 'requested', toValue: String(balance) });
    return rows[0];
  });
}

/** Find which user owns a payout, without locking — just enough to pick the wallet lock key. */
async function ownerOf(payoutId) {
  const { rows } = await db.query(`select user_id from payout_requests where id=$1`, [payoutId]);
  return rows[0]?.user_id ?? null;
}

/** Re-read and row-lock the payout inside the wallet-lock transaction; 409 unless still open. */
async function lockOpenPayout(client, payoutId) {
  const { rows } = await client.query(`select * from payout_requests where id=$1 for update`, [payoutId]);
  const payout = rows[0];
  if (!payout || payout.status !== 'open') throw Object.assign(new Error('payout_not_open'), { status: 409 });
  return payout;
}

/** FR-24: a practice-scoped manager/admin may only touch payouts at their own practice(s). */
function assertInScope(practiceIds, payout) {
  if (practiceIds && !practiceIds.includes(payout.practice_id)) {
    throw Object.assign(new Error('forbidden'), { status: 403 });
  }
}

export async function markPayoutPaid(payoutId, adminId, { amountPennies, practiceIds = null } = {}) {
  const userId = await ownerOf(payoutId);
  if (!userId) throw Object.assign(new Error('payout_not_open'), { status: 409 });

  return withWalletLock(userId, async (client) => {
    const payout = await lockOpenPayout(client, payoutId);
    // Scope before amount: a manager must never learn another practice's amount by probing.
    assertInScope(practiceIds, payout);
    if (amountPennies !== payout.amount_pennies) {
      throw Object.assign(new Error('amount_mismatch'), { status: 409 });
    }
    const balance = await balanceOf(client, payout.user_id);
    if (balance - payout.amount_pennies < 0) throw Object.assign(new Error('insufficient_balance'), { status: 409 });
    const { rows: updated } = await client.query(
      `update payout_requests set status='paid', paid_by=$2, paid_at=now() where id=$1 and status='open' returning id`,
      [payoutId, adminId],
    );
    if (!updated[0]) throw Object.assign(new Error('payout_not_open'), { status: 409 });
    await client.query(
      `insert into wallet_ledger (user_id, kind, amount_pennies, payout_id, created_by)
       values ($1,'debit',$2,$3,$4)`,
      [payout.user_id, -payout.amount_pennies, payoutId, adminId],
    );
    // Re-crossing rule (FR-20): clear the notified flag on mark-paid.
    await client.query(`update users set payout_ready_notified_at=null where id=$1`, [payout.user_id]);
    await client.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('user',$1,'payout_receipt',$2)`,
      [payout.user_id, JSON.stringify({ amountPennies: payout.amount_pennies })],
    );
    await logEvent(client, { actorId: adminId, actorKind: 'admin', entityType: 'payout', entityId: payoutId, action: 'paid', toValue: String(payout.amount_pennies) });
    return { ok: true };
  });
}

export async function cancelPayout(payoutId, actorId, { byAdmin = false, reason = null, practiceIds = null } = {}) {
  const userId = await ownerOf(payoutId);
  if (!userId) throw Object.assign(new Error('payout_not_open'), { status: 409 });

  return withWalletLock(userId, async (client) => {
    const payout = await lockOpenPayout(client, payoutId);
    // A member cancelling their own request is fine; anyone else's open request looks
    // "not open" to them (no ownership leak). An admin cancel instead checks practice scope.
    if (!byAdmin && payout.user_id !== actorId) {
      throw Object.assign(new Error('payout_not_open'), { status: 409 });
    }
    if (byAdmin) assertInScope(practiceIds, payout);
    const { rows: updated } = await client.query(
      `update payout_requests set status='cancelled', cancelled_by=$2 where id=$1 and status='open' returning *`,
      [payoutId, actorId],
    );
    if (!updated[0]) throw Object.assign(new Error('payout_not_open'), { status: 409 });
    if (byAdmin) {
      // FR-21: an admin cancel carries a reason and the member hears about it — their
      // balance is intact and they can re-request, so the message says exactly that.
      await client.query(
        `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
         values ('user',$1,'payout_cancelled',$2)`,
        [updated[0].user_id, JSON.stringify({ amountPennies: updated[0].amount_pennies, reason })],
      );
    }
    // Same route, two actors: `byAdmin` already distinguishes them, so nothing is guessed here.
    await logEvent(client, {
      actorId, actorKind: byAdmin ? 'admin' : 'user', entityType: 'payout', entityId: payoutId,
      action: byAdmin ? 'cancelled_by_admin' : 'cancelled', reason,
    });
    return { ok: true };
  });
}
