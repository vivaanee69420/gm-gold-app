// Outbox worker + email service (todo.md §4c).
//
// The bug being fixed: server.js used to mark rows 'sent' in the same UPDATE that read them
// and then console.log them. Nothing was emailed and the table claimed otherwise. So the
// assertions here are mostly about the DIFFERENCE between "we tried" and "it went" - a test
// that only checks status='sent' would have passed against the broken version too.
//
// Resend is stubbed at the fetch boundary rather than by mocking emailService, so the real
// request shape, the real status-code branching and the real retryable/terminal split are
// all exercised.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { bootTestApp } from './helpers/app.js';

process.env.PGLITE_MEMORY = '1';

let app;
let db;
let drainOnce;
let send;
let EmailError;

/** Replace global fetch with a scripted Resend. Returns the captured request bodies. */
function stubResend(responder) {
  const calls = [];
  vi.stubGlobal('fetch', async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return responder(calls.length);
  });
  return calls;
}

const ok = (id = 're_123') => new Response(JSON.stringify({ id }), { status: 200 });
const err = (status, body = 'nope') => new Response(body, { status });

// users.email is unique (migration 0013), so every fixture needs its own address unless a
// test is deliberately exercising the collision.
let seq = 0;
async function makeUser({ email, optIn = true } = {}) {
  seq += 1;
  const address = email === null ? null : (email ?? `sarah+${seq}@example.com`);
  const { rows } = await db.query(
    `insert into users (phone, email, notify_opt_in) values ($1,$2,$3) returning id`,
    [`+44770090${String(seq).padStart(4, '0')}`, address, optIn],
  );
  return rows[0].id;
}

async function queue(userId, template, payload = { amountPennies: 2500 }) {
  const { rows } = await db.query(
    `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
     values ('user',$1,$2,$3) returning id`,
    [userId, template, JSON.stringify(payload)],
  );
  return rows[0].id;
}

const rowOf = async (id) =>
  (await db.query(`select * from notification_outbox where id=$1`, [id])).rows[0];

beforeAll(async () => {
  ({ app, db } = await bootTestApp());
  // Assign onto the loaded config rather than setting env: config.js is evaluated once per
  // worker and may already have been imported by an earlier file in it, in which case env
  // changes here would be silently ignored. Same reason bootTestApp works this way.
  const { config } = await import('../src/config.js');
  config.email.apiKey = 'test-resend-key';
  config.email.from = 'GM Dental <noreply@mail.gmdental.co.uk>';
  config.email.webhookSecret = 'test-email-hook-secret';
  ({ drainOnce } = await import('../src/services/outboxService.js'));
  ({ send, EmailError } = await import('../src/services/emailService.js'));
});

beforeEach(async () => {
  await db.query(`delete from notification_outbox`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emailService', () => {
  it('posts a rendered email to Resend with both html and text parts', async () => {
    const calls = stubResend(() => ok('re_abc'));
    const out = await send({ to: 'sarah@example.com', template: 'wallet_credit', payload: { amountPennies: 2500 } });

    expect(out).toEqual({ id: 're_abc', mode: 'resend' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].headers.authorization).toBe('Bearer test-resend-key');
    expect(calls[0].body.to).toEqual(['sarah@example.com']);
    expect(calls[0].body.subject).toBe('£25.00 added to your Gold Card');
    // A text part is what keeps transactional mail out of spam filters that penalise
    // HTML-only messages, and it is what a screen reader renders.
    expect(calls[0].body.text).toContain('£25.00');
    expect(calls[0].body.html).toContain('£25.00');
  });

  it('classifies a 5xx as retryable', async () => {
    stubResend(() => err(503));
    await expect(send({ to: 'a@b.com', template: 'wallet_credit', payload: { amountPennies: 100 } }))
      .rejects.toMatchObject({ name: 'EmailError', retryable: true, status: 503 });
  });

  it('classifies a 429 as retryable', async () => {
    stubResend(() => err(429));
    await expect(send({ to: 'a@b.com', template: 'wallet_credit', payload: { amountPennies: 100 } }))
      .rejects.toMatchObject({ retryable: true, status: 429 });
  });

  it('classifies a 422 bad address as terminal', async () => {
    stubResend(() => err(422, 'invalid to address'));
    await expect(send({ to: 'not-an-address', template: 'wallet_credit', payload: { amountPennies: 100 } }))
      .rejects.toMatchObject({ retryable: false, status: 422 });
  });

  it('treats a network failure as retryable, not as a crash', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const caught = await send({ to: 'a@b.com', template: 'wallet_credit', payload: { amountPennies: 100 } })
      .catch((e) => e);
    // Must be an EmailError, not the raw TypeError — outboxService branches on .retryable,
    // which a TypeError does not have, and would default to retrying forever.
    expect(caught).toBeInstanceOf(EmailError);
    expect(caught.retryable).toBe(true);
  });

  it('rejects an unknown template as terminal', async () => {
    await expect(send({ to: 'a@b.com', template: 'does_not_exist' }))
      .rejects.toMatchObject({ retryable: false });
  });

  it('rejects a missing recipient as terminal', async () => {
    await expect(send({ to: null, template: 'wallet_credit', payload: { amountPennies: 1 } }))
      .rejects.toMatchObject({ retryable: false });
  });

  it('rejects a malformed payload as terminal rather than retrying a bad amount', async () => {
    // formatPennies throws on non-integers by design (NFR-06: money is always integer pennies).
    await expect(send({ to: 'a@b.com', template: 'wallet_credit', payload: { amountPennies: 12.5 } }))
      .rejects.toMatchObject({ retryable: false });
  });
});

describe('outbox drain', () => {
  it('sends, and only marks sent AFTER the provider accepted it', async () => {
    const calls = stubResend(() => ok('re_sent'));
    const user = await makeUser();
    const id = await queue(user, 'wallet_credit');

    const out = await drainOnce();

    expect(out.sent).toBe(1);
    expect(calls).toHaveLength(1); // an email genuinely left
    const row = await rowOf(id);
    expect(row.status).toBe('sent');
    expect(row.sent_at).not.toBeNull();
    expect(row.channel_resolved).toBe('resend:re_sent');
  });

  it('does NOT mark sent when the provider rejects it', async () => {
    stubResend(() => err(503));
    const user = await makeUser();
    const id = await queue(user, 'wallet_credit');

    const out = await drainOnce();

    expect(out.sent).toBe(0);
    expect(out.retried).toBe(1);
    const row = await rowOf(id);
    // The whole point: a failed send leaves the row recoverable, not falsely successful.
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('resend_503');
  });

  it('backs off exponentially instead of hammering a struggling provider', async () => {
    stubResend(() => err(503));
    const user = await makeUser();
    const id = await queue(user, 'wallet_credit');

    await drainOnce();
    const first = await rowOf(id);
    // attempts=1 -> 2^1 = 2 minutes out, so a second immediate pass must not pick it up.
    expect(new Date(first.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000);

    const second = await drainOnce();
    expect(second).toEqual({ sent: 0, skipped: 0, failed: 0, retried: 0 });
  });

  it('gives up after MAX_ATTEMPTS and records why', async () => {
    stubResend(() => err(503));
    const user = await makeUser();
    const id = await queue(user, 'wallet_credit');
    // Fast-forward: pretend four attempts have already been made and the wait has elapsed.
    await db.query(
      `update notification_outbox set attempts=4, next_attempt_at=now() - interval '1 hour' where id=$1`,
      [id],
    );

    const out = await drainOnce();

    expect(out.failed).toBe(1);
    const row = await rowOf(id);
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('resend_503');
  });

  it('fails immediately on a terminal error without burning retries', async () => {
    stubResend(() => err(422, 'invalid to address'));
    const user = await makeUser();
    const id = await queue(user, 'wallet_credit');

    const out = await drainOnce();

    expect(out.failed).toBe(1);
    const row = await rowOf(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1); // not retried four more times against a dead address
  });

  it('skips a user who opted out of notifications', async () => {
    const calls = stubResend(() => ok());
    const user = await makeUser({ optIn: false });
    const id = await queue(user, 'wallet_credit');

    const out = await drainOnce();

    expect(out.skipped).toBe(1);
    expect(calls).toHaveLength(0); // nothing sent
    const row = await rowOf(id);
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toBe('opted_out');
  });

  it('skips a user with no email on file rather than retrying forever', async () => {
    stubResend(() => ok());
    const user = await makeUser({ email: null });
    const id = await queue(user, 'wallet_credit');

    await drainOnce();

    const row = await rowOf(id);
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toBe('no_email_on_file');
  });

  it('skips a phase-2 template instead of leaving it queued forever', async () => {
    const calls = stubResend(() => ok());
    const user = await makeUser();
    const id = await queue(user, 'friend_booked', { friendName: 'S' });

    const out = await drainOnce();

    expect(out.skipped).toBe(1);
    expect(calls).toHaveLength(0);
    const row = await rowOf(id);
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toBe('phase_2');
    // And it must not come back on the next pass — a permanently queued row is re-read by
    // every drain for the life of the system.
    expect(await drainOnce()).toEqual({ sent: 0, skipped: 0, failed: 0, retried: 0 });
  });

  it('skips practice_contact rows, which Q14 dropped but digestService still queues', async () => {
    stubResend(() => ok());
    const { rows } = await db.query(`select id from practices limit 1`);
    const { rows: ins } = await db.query(
      `insert into notification_outbox (recipient_kind, recipient_id, template, payload)
       values ('practice_contact',$1,'daily_digest','{}'::jsonb) returning id`,
      [rows[0].id],
    );

    await drainOnce();

    const row = await rowOf(ins[0].id);
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toContain('unsupported_recipient_kind');
  });

  it('sends payout_receipt with the right money in the subject', async () => {
    const calls = stubResend(() => ok());
    const user = await makeUser();
    await queue(user, 'payout_receipt', { amountPennies: 12050 });

    await drainOnce();

    expect(calls[0].body.subject).toBe('£120.50 paid out from your Gold Card');
  });

  it('is a no-op when the queue is empty', async () => {
    const calls = stubResend(() => ok());
    expect(await drainOnce()).toEqual({ sent: 0, skipped: 0, failed: 0, retried: 0 });
    expect(calls).toHaveLength(0);
  });

  it('processes at most one batch per pass', async () => {
    const calls = stubResend(() => ok());
    const user = await makeUser();
    for (let i = 0; i < 13; i += 1) await queue(user, 'wallet_credit');

    const first = await drainOnce();
    expect(first.sent).toBe(10);
    const second = await drainOnce();
    expect(second.sent).toBe(3);
    expect(calls).toHaveLength(13);
  });
});

describe('Resend delivery webhook', () => {
  // A hard bounce is the one failure mode the outbox cannot detect itself: Resend accepted
  // the message, so the send looked like a success, and the mailbox rejected it afterwards.
  // Without this the row sits at 'sent' forever and a referrer is simply never told they
  // earned money.
  const hook = (body, secret = 'test-email-hook-secret') =>
    request(app).post('/webhooks/resend').set('x-gmref-email-secret', secret).send(body);

  it('marks a bounced notification failed', async () => {
    stubResend(() => ok('re_bounce_me'));
    const user = await makeUser();
    const id = await queue(user, 'wallet_credit');
    await drainOnce();
    expect((await rowOf(id)).status).toBe('sent');

    const res = await hook({ type: 'email.bounced', data: { email_id: 're_bounce_me' } });

    expect(res.status).toBe(204);
    const row = await rowOf(id);
    expect(row.status).toBe('failed');
    expect(row.last_error).toContain('email.bounced');
  });

  it('marks a spam complaint failed too', async () => {
    stubResend(() => ok('re_complaint'));
    const user = await makeUser();
    const id = await queue(user, 'payout_receipt', { amountPennies: 500 });
    await drainOnce();

    await hook({ type: 'email.complained', data: { email_id: 're_complaint' } });
    expect((await rowOf(id)).status).toBe('failed');
  });

  it('ignores a delivered event — it must not undo a successful send', async () => {
    stubResend(() => ok('re_delivered'));
    const user = await makeUser();
    const id = await queue(user, 'wallet_credit');
    await drainOnce();

    await hook({ type: 'email.delivered', data: { email_id: 're_delivered' } });
    expect((await rowOf(id)).status).toBe('sent');
  });

  it('rejects a wrong secret', async () => {
    const res = await hook({ type: 'email.bounced', data: { email_id: 'x' } }, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('rejects a missing secret', async () => {
    const res = await request(app).post('/webhooks/resend').send({ type: 'email.bounced', data: { email_id: 'x' } });
    expect(res.status).toBe(401);
  });

  it('204s an unknown provider id rather than erroring', async () => {
    // Resend retries non-2xx. An event we cannot correlate is not a failure worth retrying.
    const res = await hook({ type: 'email.bounced', data: { email_id: 'never-seen' } });
    expect(res.status).toBe(204);
  });

  it('refuses everything when no webhook secret is configured', async () => {
    const { config } = await import('../src/config.js');
    const saved = config.email.webhookSecret;
    config.email.webhookSecret = null;
    try {
      const res = await hook({ type: 'email.bounced', data: { email_id: 'x' } });
      expect(res.status).toBe(503);
    } finally {
      config.email.webhookSecret = saved;
    }
  });
});
