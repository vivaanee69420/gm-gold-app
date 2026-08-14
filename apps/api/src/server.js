import { buildApp } from './app.js';
import { initDb, db } from './db.js';
import { config } from './config.js';

const kind = await initDb();
const app = buildApp();

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

app.listen(config.port, () => {
  console.log(`[api] listening on http://localhost:${config.port} (db: ${kind}, otp: ${config.otpChannelMode})`);
});
