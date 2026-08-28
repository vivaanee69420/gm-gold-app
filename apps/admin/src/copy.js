// API error codes → front-desk language. Unknown codes pass through so
// nothing is ever swallowed silently.
const ERRORS = {
  invalid_transition: "That status move isn't allowed from where the referral is now.",
  payout_not_open: 'This payout request is no longer open.',
  amount_required: 'Type the cash amount handed over before marking paid.',
  amount_mismatch: "That amount doesn't match the request — check the cash and try again.",
  insufficient_balance: "The member's balance no longer covers this payout.",
  already_credited: 'This referral has already been credited.',
  no_active_rule: 'No commission amount is set — save one in Reward levers first.',
  proposal_not_open: 'This proposal was already decided (maybe by a colleague just now).',
  review_pending: 'This referral is flagged for existing-patient review — resolve that first.',
  reason_required: 'A rejection needs a short reason.',
  not_pending: 'This member is no longer waiting for verification.',
  dentally_not_configured: "Dentally OAuth isn't configured yet — add DENTALLY_CLIENT_ID and DENTALLY_CLIENT_SECRET to the API's .env.",
  dentally_not_connected: 'Dentally is not connected yet.',
  dentally_not_stub: 'Dev stub actions only work while Dentally is in demo (stub) mode.',
  not_in_review: 'This referral is no longer waiting for review (maybe a colleague decided it).',
  forbidden: "This account doesn't have dashboard access — ask an admin to grant it.",
  unauthorized: 'Your session ended — sign in again.',
  not_found: 'That account no longer exists.',
  validation: "Some of those values didn't validate — check and try again.",
  load_failed: "Couldn't reach the API — is it running?",
  // The four codes a component invents when a request never landed at all (fetch threw, or the
  // response carried no error code). They all mean the same thing to the person at the desk.
  sign_in_failed: "Couldn't reach the API — check your connection and try again.",
  save_failed: "Couldn't reach the API — check your connection and try again.",
  create_failed: "Couldn't reach the API — check your connection and try again.",
  request_failed: "Couldn't reach the API — check your connection and try again.",
  invalid_credentials: 'Email or password is wrong.',
  rate_limited: 'Too many attempts — wait 15 minutes and try again.',
  email_taken: 'An account with that email already exists.',
  weak_password: 'Passwords need at least 10 characters.',
  practice_required: 'A manager needs exactly one practice.',
  cannot_deactivate_self: "You can't deactivate your own account.",
  last_admin: 'There must be at least one active admin.',
  wrong_password: 'Your current password is wrong.',
  practice_not_allowed: 'Admins cover every practice — leave the practice blank.',
  // Not an error: the Team card notifies through the same channel, and a bare "Saved." is
  // clearer than silence after a password reset or a re-scope.
  team_saved: 'Saved.',
};

export const errorMessage = (code) => ERRORS[code] ?? code;
