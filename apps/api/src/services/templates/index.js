// Email templates — versioned here, in the repo, rather than in a provider dashboard, so a
// change to what a patient is told about their money goes through code review like anything
// else that touches the wallet.
//
// Every template returns { subject, html, text }. Both bodies are required: a text part is
// what keeps a transactional email out of spam filters that penalise HTML-only mail, and it
// is what a screen reader and a smartwatch actually render.
//
// Email client reality, which is why this looks like 2004:
//   - Inline styles only. Gmail strips <style> blocks, Outlook ignores most of what survives.
//   - Tables for layout. Flexbox and grid are not reliably supported.
//   - No external CSS or web fonts; no remote images (they are blocked until "show images").
//   - Colours are hex literals, not tokens, because there is no build step in an inbox.
//
// Palette mirrors apps/mobile/src/theme.js (boardroom green + brushed gold). If those tokens
// change, change these to match - there is no import that will do it for you.
import { formatPennies } from '@gm-referral/shared/money';

const BOARDROOM = '#0B2B26';
const CARDFACE = '#123832';
const GOLD = '#C9A961';
const GOLD_BRIGHT = '#E8CB8A';
const IVORY = '#F4EFE4';
const MIST = '#8FA79F';

/**
 * Shared shell. `preheader` is the grey snippet an inbox shows after the subject line; left
 * unset, clients scrape the first visible text, which here would be the wordmark. Hiding it
 * with display:none alone is unreliable, hence the belt-and-braces style stack.
 */
function layout({ preheader, heading, lines, footnote }) {
  const paragraphs = lines
    .map((l) => `<p style="margin:0 0 16px;color:${IVORY};font-size:16px;line-height:1.55;">${l}</p>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading}</title></head>
<body style="margin:0;padding:0;background:${BOARDROOM};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BOARDROOM};padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:${CARDFACE};border:1px solid ${GOLD};border-radius:20px;">
      <tr><td style="height:4px;background:${GOLD};border-radius:20px 20px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px;">
        <p style="margin:0 0 4px;color:${GOLD};font-size:11px;letter-spacing:1.5px;text-transform:uppercase;">GM Dental &middot; Gold Card</p>
        <h1 style="margin:0 0 20px;color:${GOLD_BRIGHT};font-size:24px;line-height:1.25;font-weight:600;">${heading}</h1>
        ${paragraphs}
        <p style="margin:24px 0 0;color:${MIST};font-size:13px;line-height:1.5;">${footnote}</p>
      </td></tr>
    </table>
    <p style="margin:20px 0 0;color:${MIST};font-size:12px;">You are receiving this because you have a GM Dental Gold Card account.</p>
  </td></tr>
</table>
</body></html>`;
}

const textBody = ({ heading, lines, footnote }) =>
  [
    'GM DENTAL - GOLD CARD',
    '',
    heading,
    '',
    ...lines.map((l) => l.replace(/<[^>]+>/g, '')),
    '',
    footnote.replace(/<[^>]+>/g, ''),
    '',
    'You are receiving this because you have a GM Dental Gold Card account.',
  ].join('\n');

/**
 * The launch set (todo.md Q15). Anything queued into notification_outbox whose template is
 * NOT in here is marked `skipped` with skip_reason='phase_2' rather than being sent or left
 * to sit in the queue forever. Adding a template here is what "ships" it.
 */
export const templates = {
  wallet_credit: ({ amountPennies }) => {
    const amount = formatPennies(amountPennies);
    const content = {
      heading: `${amount} added to your card`,
      lines: [
        `A friend you referred has completed their treatment, so <strong style="color:${GOLD_BRIGHT};">${amount}</strong> is now on your Gold Card.`,
        'Open the app to see your balance and request a payout whenever you are ready.',
      ],
      footnote: 'Payouts are handled at your practice. There is nothing you need to do right now.',
    };
    return {
      subject: `${amount} added to your Gold Card`,
      html: layout({ preheader: `Your referral came through - ${amount} is on your card.`, ...content }),
      text: textBody(content),
    };
  },

  payout_receipt: ({ amountPennies }) => {
    const amount = formatPennies(amountPennies);
    const content = {
      heading: `${amount} paid out`,
      lines: [
        `Your practice has paid out <strong style="color:${GOLD_BRIGHT};">${amount}</strong> from your Gold Card.`,
        'Your balance has been updated in the app.',
      ],
      footnote: 'Keep this email as your receipt. If this does not look right, speak to your practice.',
    };
    return {
      subject: `${amount} paid out from your Gold Card`,
      html: layout({ preheader: `Receipt for your ${amount} payout.`, ...content }),
      text: textBody(content),
    };
  },
};

export const isLaunchTemplate = (name) => Object.hasOwn(templates, name);
