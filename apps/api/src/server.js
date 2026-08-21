import { buildApp } from './app.js';
import { initDb, db } from './db.js';
import { config } from './config.js';
import { runSync } from './services/dentally/syncService.js';
import { queueDailyDigest } from './services/digestService.js';

const kind = await initDb();
const app = buildApp();

// Dentally sync (FR-16d): poll every 15 minutes; webhooks just trigger an extra pass.
// runSync resolves the effective mode itself (env token / admin OAuth / stub) and
// no-ops when it is 'off', so connecting via the dashboard needs no restart.
setInterval(() => runSync('cron'), config.dentally.syncIntervalMs);
runSync('startup');

// Outbox drain (NFR-10) — dev sender logs to console; WhatsApp/SMS senders swap in later.
setInterval(async () => {
  try {
    const { rows } = await db.query(
      `update notification_outbox set status='sent', sent_at=now(), attempts=attempts+1, channel_resolved='console'
       where id in (select id from notification_outbox where status='queued' order by created_at limit 10)
       returning template, recipient_kind, recipient_id, payload`,
    );
    for (const n of rows) {
      console.log(`[notify] ${n.recipient_kind}:${n.recipient_id ?? '-'} ${n.template}`, JSON.stringify(n.payload));
    }
  } catch (err) {
    console.error('[notify] drain failed', err.message);
  }
}, 3000);

// Daily digest (FR-25): queue once per day from 08:00 London; "any time after 8" with
// the once-per-day guard inside queueDailyDigest makes restarts and downtime safe.
const digestTick = async () => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  if (Number(parts.hour) < 8) return;
  const out = await queueDailyDigest(`${parts.year}-${parts.month}-${parts.day}`);
  if (out.queued > 0) console.log(`[digest] queued for ${out.queued} practice(s)`);
};
setInterval(() => digestTick().catch((err) => console.error('[digest] failed', err.message)), 15 * 60 * 1000);
digestTick().catch((err) => console.error('[digest] failed', err.message));

app.listen(config.port, () => {
  console.log(
    `[api] listening on http://localhost:${config.port} (db: ${kind}, otp: ${config.otpChannelMode}, dentally: ${config.dentally.modeOverride ?? 'auto'})`,
  );
});
