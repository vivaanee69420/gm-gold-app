// E.164 phone normalization for UK-first usage (FR-05, FR-11).
// One implementation shared by mobile, admin, and API so validation can never drift.

const E164_RE = /^\+[1-9]\d{7,14}$/;
const UK_MOBILE_RE = /^\+447\d{9}$/;

/**
 * Normalize free-typed input to E.164. UK-first rules:
 *   "07700 900123"   -> "+447700900123"
 *   "0044 7700..."   -> "+447700..."
 *   "+44 (0)7700..." -> "+447700..."
 * Already-international input (+33..., +1...) passes through when valid.
 * Returns the E.164 string, or null when the input cannot be a valid number.
 */
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+44')) {
    // Domestic habit: writing +44 (0)7... — drop the redundant trunk zero.
    if (s.startsWith('+440')) s = `+44${s.slice(4)}`;
  } else if (s.startsWith('0')) {
    s = `+44${s.slice(1)}`;
  }
  if (!E164_RE.test(s)) return null;
  return s;
}

export function isUkMobile(e164) {
  return UK_MOBILE_RE.test(e164);
}

export function isE164(value) {
  return typeof value === 'string' && E164_RE.test(value);
}
