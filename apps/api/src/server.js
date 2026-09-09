import { buildApp } from './app.js';
import { initDb } from './db.js';
import { config } from './config.js';
import { runSync } from './services/dentally/syncService.js';
import { queueDailyDigest } from './services/digestService.js';
import { drainOnce } from './services/outboxService.js';

const kind = await initDb();
const app = buildApp();

// Dentally sync (FR-16d): poll every 15 minutes; webhooks just trigger an extra pass.
// runSync resolves the effective mode itself (env token / admin OAuth / stub) and
// no-ops when it is 'off', so connecting via the dashboard needs no restart.
setInterval(() => runSync('cron'), config.dentally.syncIntervalMs);
runSync('startup');

// Outbox drain (NFR-10). The real sender: claims rows, sends via Resend, and only then
// records the outcome. See outboxService for the state machine.
//
// `draining` is a same-process guard, not a correctness one — drainOnce is already safe to
// run concurrently thanks to FOR UPDATE SKIP LOCKED. It just stops a slow batch from
// stacking up ticks behind it and holding ten connections per pass.
let draining = false;
setInterval(async () => {
  if (draining) return;
  draining = true;
  try {
    const out = await drainOnce();
    // Quiet when there is nothing to do; the drain runs every 3 seconds all day.
    if (out.sent || out.failed || out.retried || out.skipped) {
      console.log(
        `[notify] sent=${out.sent} skipped=${out.skipped} retried=${out.retried} failed=${out.failed}`,
      );
    }
    // A failed row is a notification about money that a patient will never receive, and
    // nothing else surfaces it yet (TODOS.md TODO-1). Until that lands, be loud.
    if (out.failed) console.error(`[notify] ${out.failed} notification(s) permanently failed`);
  } catch (err) {
    console.error('[notify] drain failed', err.message);
  } finally {
    draining = false;
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
    `[api] listening on http://localhost:${config.port} (db: ${kind}, dentally: ${config.dentally.modeOverride ?? 'auto'})`,
  );
});
