// notification_outbox worker (NFR-10).
//
// What this replaces: a single UPDATE that set status='sent' on ten queued rows and then
// console.logged them. Nothing was ever emailed, and the table said otherwise - every
// wallet_credit and payout_receipt since launch is recorded as delivered.
//
//                    +-----------+
//   producers ---->  |  queued   |  <-----------------------+
//                    +-----------+                          |
//                          |  claim(): FOR UPDATE SKIP LOCKED,
//                          |           next_attempt_at <= now()
//                          v                                 |
//                    +-----------+                           | attempts < MAX,
//                    |  sending  |                           | next_attempt_at =
//                    +-----------+                           | now() + 2^attempts min
//                     /    |    \                            |
//        provider    /     |     \  not a launch template    |
//        accepted   /      |      \ OR notify_opt_in = false |
//                  v       |       v                         |
//           +--------+     |   +---------+                   |
//           |  sent  |     |   | skipped |  terminal         |
//           +--------+     |   +---------+                   |
//                          | EmailError                      |
//                          +--- retryable -------------------+
//                          |
//                          +--- terminal ---> +--------+
//                                             | failed |  terminal, last_error set
//                                             +--------+
//                                                  ^
//                                                  +--- Resend bounce webhook
//
// Why 'sending' exists: without it, a crash between claiming a row and recording the result
// leaves the row 'queued' and the email possibly already sent, so the retry double-sends. A
// row stuck in 'sending' past the reclaim window is visible and recoverable; a silently
// double-sent payout receipt is not.
import { db } from '../db.js';
import { send, EmailError } from './emailService.js';
import { templates } from './templates/index.js';

const BATCH = 10;
const MAX_ATTEMPTS = 5;
// A row claimed but never resolved (process killed mid-send) becomes eligible again after
// this. Longer than emailService's 10s timeout so a slow send is never reclaimed underneath
// itself and delivered twice.
const RECLAIM_AFTER = '5 minutes';

// OTP never passes through here - Supabase Auth sends it directly (decision T2). Utility
// mail respects notify_opt_in; there is no transactional exemption in the launch set,
// because both launch templates are notifications about money, not account security.
const RESPECTS_OPT_IN = new Set(['wallet_credit', 'payout_receipt']);

const backoffMinutes = (attempts) => 2 ** attempts; // 1, 2, 4, 8, 16

/**
 * Claim up to BATCH rows and mark them 'sending' in one statement.
 *
 * SKIP LOCKED is what makes a second API replica safe: two workers running this
 * simultaneously take disjoint sets rather than blocking on each other or, worse, both
 * sending the same payout receipt. Q11 left the replica count open; this removes the
 * question from the answer.
 */
async function claim(client) {
  const { rows } = await client.query(
    `update notification_outbox o
        set status = 'sending', attempts = o.attempts + 1
      where o.id in (
        select id from notification_outbox
         where (status = 'queued' and next_attempt_at <= now())
            or (status = 'sending' and next_attempt_at < now() - interval '${RECLAIM_AFTER}')
         order by next_attempt_at, created_at
         limit ${BATCH}
         for update skip locked
      )
      returning o.id, o.recipient_kind, o.recipient_id, o.template, o.payload, o.attempts`,
  );
  return rows;
}

/** Terminal: delivered. */
const markSent = (client, id, providerId, mode) =>
  client.query(
    `update notification_outbox
        set status='sent', sent_at=now(), channel_resolved=$2, last_error=null
      where id=$1`,
    [id, mode === 'console' ? 'console' : `resend:${providerId}`],
  );

/** Terminal: deliberately not sent. Not a failure, and must not read as one. */
const markSkipped = (client, id, reason) =>
  client.query(
    `update notification_outbox set status='skipped', skip_reason=$2 where id=$1`,
    [id, reason],
  );

/** Terminal: gave up. */
const markFailed = (client, id, error) =>
  client.query(`update notification_outbox set status='failed', last_error=$2 where id=$1`, [
    id,
    String(error).slice(0, 500),
  ]);

/** Back to the queue with a widening gap. */
const markRetry = (client, id, attempts, error) =>
  client.query(
    `update notification_outbox
        set status='queued', next_attempt_at = now() + ($2 || ' minutes')::interval, last_error=$3
      where id=$1`,
    [id, String(backoffMinutes(attempts)), String(error).slice(0, 500)],
  );

/**
 * Resolve the recipient's address and whether they want this kind of mail.
 * Returns null when the row can never be delivered, with a reason for skip_reason.
 */
async function resolveRecipient(client, row) {
  const { rows } = await client.query(
    `select email, notify_opt_in from users where id = $1`,
    [row.recipient_id],
  );
  const user = rows[0];
  if (!user) return { skip: 'user_not_found' };
  if (!user.email) return { skip: 'no_email_on_file' };
  if (RESPECTS_OPT_IN.has(row.template) && !user.notify_opt_in) return { skip: 'opted_out' };
  return { to: user.email };
}

/**
 * One pass. Safe to call on an interval and safe to run concurrently with itself.
 * @returns counts by outcome, for logging and tests.
 */
export async function drainOnce() {
  const out = { sent: 0, skipped: 0, failed: 0, retried: 0 };

  const rows = await db.withClient((client) => claim(client));
  if (!rows.length) return out;

  for (const row of rows) {
    await db.withClient(async (client) => {
      // Order matters here, and it is about diagnosis rather than behaviour: all three of
      // these skip the row, but skip_reason is what someone reads when asking "why did this
      // patient not get their money email?". Cheapest and most structural first, so the
      // reason names the real cause instead of whichever check happened to fire first.
      //
      //   1. recipient kind  - can never be delivered, whatever the template
      //   2. template        - not shipped yet, whoever it is addressed to
      //   3. the user        - opted out, or no address on file
      if (row.recipient_kind !== 'user') {
        // Q14 dropped practice email entirely (inquiries and the digest live on the
        // dashboard instead). digestService still queues these, so they are retired here
        // rather than accumulating. Not 'phase_2': these are cancelled, not deferred.
        await markSkipped(client, row.id, `unsupported_recipient_kind:${row.recipient_kind}`);
        out.skipped += 1;
        return;
      }

      // Phase-2 templates are queued by producers we have not changed. They are skipped, not
      // sent and not left queued - a row that stays 'queued' forever is re-read by every
      // drain pass for the life of the system.
      if (!Object.hasOwn(templates, row.template)) {
        await markSkipped(client, row.id, 'phase_2');
        out.skipped += 1;
        return;
      }

      const recipient = await resolveRecipient(client, row);
      if (recipient.skip) {
        await markSkipped(client, row.id, recipient.skip);
        out.skipped += 1;
        return;
      }

      try {
        const { id, mode } = await send({
          to: recipient.to,
          template: row.template,
          payload: row.payload ?? {},
        });
        await markSent(client, row.id, id, mode);
        out.sent += 1;
      } catch (err) {
        const retryable = err instanceof EmailError ? err.retryable : true;
        if (retryable && row.attempts < MAX_ATTEMPTS) {
          await markRetry(client, row.id, row.attempts, err.message);
          out.retried += 1;
        } else {
          await markFailed(client, row.id, err.message);
          out.failed += 1;
        }
      }
    });
  }

  return out;
}
