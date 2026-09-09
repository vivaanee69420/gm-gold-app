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

process.env.PGLITE_MEMORY = '1';

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
  // Same discipline as prod-mode.test.js: config.js reads these once at module evaluation,
  // and vitest reuses worker processes between files, so anything left in process.env leaks
  // into whichever suite runs next in this worker. Set, let the import capture it, restore.
  const restore = { EMAIL_API_KEY: process.env.EMAIL_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM };
  process.env.EMAIL_API_KEY = 'test-resend-key';
  process.env.EMAIL_FROM = 'GM Dental <noreply@mail.gmdental.co.uk>';
  try {
    const dbMod = await import('../src/db.js');
    db = dbMod.db;
    await dbMod.initDb();
    ({ drainOnce } = await import('../src/services/outboxService.js'));
    ({ send, EmailError } = await import('../src/services/emailService.js'));
  } finally {
    for (const [k, v] of Object.entries(restore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
