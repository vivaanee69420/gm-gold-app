// API error codes → front-desk language. Unknown codes pass through so
// nothing is ever swallowed silently.
const ERRORS = {
  invalid_transition: "That status move isn't allowed from where the referral is now.",
  payout_not_open: 'This payout request is no longer open.',
  insufficient_balance: "The member's balance no longer covers this payout.",
  already_credited: 'This referral has already been credited.',
  no_active_rule: 'No commission amount is set — save one in Reward levers first.',
  unauthorized: 'Your session ended — sign in again.',
  validation: "Some of those values didn't validate — check and try again.",
  load_failed: "Couldn't reach the API — is it running?",
};

export const errorMessage = (code) => ERRORS[code] ?? code;
