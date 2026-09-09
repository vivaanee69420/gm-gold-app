// Email delivery via Resend (todo.md §4c, Q4: Resend, sending from mail.gmdental.co.uk).
//
// Plain fetch against Resend's REST API rather than their SDK, matching how
// dentally/client.js talks to Dentally: one endpoint, one auth header, no dependency to
// keep patched. If we ever need batching or idempotency keys, revisit.
//
//   send()
//     |
//     |-- unknown template ------------------> EmailError(terminal)   caller marks 'failed'
//     |-- no recipient address --------------> EmailError(terminal)
//     |-- no API key, isDev -----------------> console, returns a fake id (local dev works
//     |                                        exactly as it did before Resend existed)
//     |-- no API key, production ------------> EmailError(retryable)  it is a config fault,
//     |                                        not this message's fault; never swallow it
//     |-- fetch throws / times out ----------> EmailError(retryable)
//     |-- 429 or 5xx ------------------------> EmailError(retryable)
//     |-- other 4xx (422 bad address, 403) --> EmailError(terminal)
//     +-- 2xx -------------------------------> { id }
//
// The retryable/terminal split is the whole point of this module: outboxService uses it to
// decide between backing off and giving up, and getting it backwards means either a bounced
// address is retried forever or a transient Resend blip permanently drops a payout receipt.
import { config, isDev } from '../config.js';
import { templates } from './templates/index.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export class EmailError extends Error {
  constructor(message, { retryable, status = null } = {}) {
    super(message);
    this.name = 'EmailError';
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * Render + send one email.
 * @returns {Promise<{id: string, mode: 'resend'|'console'}>}
 * @throws {EmailError} always EmailError, never a bare fetch error - callers branch on
 *   `.retryable` and a TypeError from fetch would have no such property.
 */
export async function send({ to, template, payload = {} }) {
  const render = templates[template];
  if (!render) {
    throw new EmailError(`unknown_template:${template}`, { retryable: false });
  }
  if (!to) {
    // A user row with no email address. Retrying cannot conjure one.
    throw new EmailError('no_recipient', { retryable: false });
  }

  let rendered;
  try {
    rendered = render(payload);
  } catch (err) {
    // A malformed payload (formatPennies throws on non-integer amounts, by design) is a bug
    // in the producer, not a delivery problem. Retrying replays the same bad payload.
    throw new EmailError(`render_failed:${err.message}`, { retryable: false });
  }

  if (!config.email.apiKey) {
    if (isDev) {
      console.log(`[email] ${template} -> ${to}: ${rendered.subject} (no API key, console mode)`);
      return { id: `console-${Date.now()}`, mode: 'console' };
    }
    // Production with no key: do NOT pretend this was delivered. That is the exact lie the
    // old outbox drain told.
    throw new EmailError('email_not_configured', { retryable: true });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.email.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.email.from,
        to: [to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        ...(config.email.replyTo ? { reply_to: config.email.replyTo } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure or our own 10s abort. Both are worth another go.
    throw new EmailError(`transport:${err.name}`, { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) {
    const body = await res.json().catch(() => ({}));
    return { id: body.id ?? 'unknown', mode: 'resend' };
  }

  // Resend puts a machine-readable reason in the body; keep it for last_error, but never
  // let a body-parse failure mask the status we already have.
  const detail = await res.text().catch(() => '');
  const retryable = res.status === 429 || res.status >= 500;
  throw new EmailError(`resend_${res.status}:${detail.slice(0, 200)}`, {
    retryable,
    status: res.status,
  });
}
