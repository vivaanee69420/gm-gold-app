// Daily digest (FR-25): "n proposals, n payout requests waiting" to each practice
// inquiry contact via the outbox — front desks must not need to remember to poll
// the dashboard. Queued once per calendar day; server.js decides when to call.
import { db } from '../db.js';

export async function queueDailyDigest(today) {
  const { rows: last } = await db.query(`select value from app_settings where key='digest_last_date'`, []);
  if (last[0]?.value === today) return { queued: 0, skipped: 'already_sent' };

  const { rows: practices } = await db.query(`select id, name from practices where active`, []);
  let queued = 0;
  for (const practice of practices) {
    // Proposals without a treating practice yet (stub mode, unmapped sites) count for
    // every practice — better two front desks glance than none.
    const { rows: [p] } = await db.query(
      `select count(*)::int as n from completion_proposals
       where status='open' and (treating_practice_id = $1 or treating_practice_id is null)`,
      [practice.id],
    );
    const { rows: [pay] } = await db.query(
      `select count(*)::int as n from payout_requests where status='open' and practice_id = $1`,
      [practice.id],
    );
    const { rows: [rev] } = await db.query(
      `select count(*)::int as n from referrals
       where review_status='existing_patient_suspect' and status <> 'lost' and preferred_practice_id = $1`,
      [practice.id],
    );
    if (p.n + pay.n + rev.n === 0) continue;
    await db.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('practice_contact',$1,'daily_digest',$2)`,
      [practice.id, JSON.stringify({ proposals: p.n, payouts: pay.n, reviews: rev.n, date: today })],
    );
    queued += 1;
  }

  await db.query(
    `insert into app_settings (key, value, updated_by) values ('digest_last_date',$1,'digest')
     on conflict (key) do update set value=$1, updated_by='digest', updated_at=now()`,
    [today],
  );
  return { queued };
}
