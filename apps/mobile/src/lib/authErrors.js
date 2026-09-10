// Turning a Supabase Auth failure into a sentence a patient can act on.
//
// Written after 2026-09-10, when every send failed and the app said "Check the address and
// try again." The addresses were fine. The project's SMTP sender pointed at an unverified
// domain, Resend answered `550 domain is not verified`, and GoTrue turned that into a 500 —
// a fault entirely on our side of the wire. People with perfectly good email addresses were
// told their email address was wrong, so they retyped it, failed again, and concluded the
// app was broken. It was, just not where the message pointed.
//
// An error that blames the wrong party is worse than a vague one: it sends someone down a
// road that cannot possibly work. So classify by WHO CAN ACTUALLY FIX IT — the patient, the
// clock, or us — and never say "check the address" unless the address is genuinely the thing
// the server rejected.

/** Thrown by sendCode when the build has no Supabase project compiled into it. */
export const NOT_CONFIGURED = 'auth_not_configured';

// Supabase's documented error codes. Status alone is the fallback signal, because these
// strings are the part most likely to drift between GoTrue versions.
const RATE_LIMITED = new Set(['over_email_send_rate_limit', 'over_request_rate_limit']);
const BAD_ADDRESS = new Set(['email_address_invalid', 'validation_failed']);

// What Supabase answers when signInWithOtp runs with shouldCreateUser:false and the address
// has never signed up. It is the sign-in screen's most important error, and it arrives as a
// 422 — which would otherwise be read as "that address is malformed". It isn't; the address
// is fine, there is just nobody behind it.
const NO_SUCH_ACCOUNT = new Set(['otp_disabled', 'signup_disabled', 'user_not_found']);

/** True when the failure means "this email has no account yet", i.e. offer sign-up. */
export function isUnknownAccount(err) {
  return NO_SUCH_ACCOUNT.has(err?.code);
}

/**
 * A message for a failed "send me a code" attempt.
 *
 * @param {unknown} err   whatever sendCode threw
 * @param {{ resend?: boolean }} [opts]  wording for the second code rather than the first
 * @returns {string} one sentence, safe to show a patient
 */
export function describeSendFailure(err, { resend = false } = {}) {
  const status = err?.status;
  const code = err?.code;
  const thing = resend ? 'another code' : 'your code';

  if (err?.message === NOT_CONFIGURED) {
    // Only reachable in a binary built without EXPO_PUBLIC_SUPABASE_*. Nothing the person
    // holding the phone can do, so don't imply there is.
    return 'Sign-in isn’t available in this version of the app. Please contact the practice.';
  }

  // CAREFUL: supabase-js throws AuthRetryableFetchError for BOTH a dead network AND any 5xx
  // (auth-js/lib/fetch.js — `NETWORK_ERROR_CODES` covers 500-504 and Cloudflare's 52x). The
  // only thing separating "your Wi-Fi is off" from "our mail server is misconfigured" is
  // `status`: 0 when the request never left the device, the real code when it did. Branch on
  // the class alone and every server fault gets reported as the user's connection problem.
  const offline = err?.name === 'AuthRetryableFetchError' && !status;
  if (offline) {
    return 'No connection. Check your internet and try again.';
  }

  // Checked before the generic 4xx branch below, which would otherwise blame the address.
  if (isUnknownAccount(err)) {
    return 'No account with that email yet. Create one below — it takes a minute.';
  }

  if (status === 429 || RATE_LIMITED.has(code)) {
    return resend
      ? 'Please wait a moment before asking for another code.'
      : 'Too many codes requested. Wait a minute and try again.';
  }

  // The server took the request and then failed to deliver — bad SMTP credentials, an
  // unverified sender domain, a provider outage. Ours to fix, and no amount of retyping helps.
  if (status >= 500 || code === 'unexpected_failure') {
    return `We couldn’t send ${thing} — that’s a fault on our side, not your email address. Try again in a few minutes.`;
  }

  // The one case where the address really is the problem.
  if (BAD_ADDRESS.has(code) || status === 400 || status === 422) {
    return 'That email address was rejected. Check it for typos and try again.';
  }

  return `Couldn’t send ${thing}. Try again in a moment.`;
}

/**
 * Is the email field itself the thing at fault?
 *
 * Drives the red edge on the input. It has to agree with the message: outlining the field in
 * red under the words "not your email address" tells the patient two opposite things at once,
 * and the red edge is the one they'll believe.
 */
export function isAddressProblem(err) {
  // "No account yet" also arrives as a 422, but the address is spelled perfectly — the fix is
  // to sign up, not to retype it. Marking the field red there sends people hunting for a typo
  // that isn't in it.
  if (isUnknownAccount(err)) return false;
  return BAD_ADDRESS.has(err?.code) || err?.status === 400 || err?.status === 422;
}
