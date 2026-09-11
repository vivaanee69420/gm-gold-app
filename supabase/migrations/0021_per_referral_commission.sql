-- Commission becomes a per-referral figure the practice manager picks (2026-09-11).
--
-- It used to come from reward_rules: a fixed amount, scoped globally or per practice, resolved
-- at credit time (FR-15). That is retired. Different treatments are worth wildly different
-- amounts to the practice, and a single rule could not express it — so the manager who knows
-- what was agreed now chooses the commission from a fixed set of tiers.
--
-- Nullable, like the three treatment details added in 0020 and for the same reason: it is
-- filled in as the practice decides, and the gate is at the paying move (updateStatus refuses
-- treatment_started or treatment_completed while it is unset), not at the keystroke.
--
-- No CHECK on the five exact tier values. The tier list is a business decision that will
-- change, and a constraint here would make every change a migration. `> 0` is the database's
-- floor — a commission of zero or less is never a real payment — and the exact set is enforced
-- at the validation boundary in shared/schemas.js, where it can move freely.
alter table referrals add column if not exists commission_pennies integer;

alter table referrals drop constraint if exists referrals_commission_pennies_positive;
alter table referrals add constraint referrals_commission_pennies_positive
  check (commission_pennies is null or commission_pennies > 0);

-- reward_rules and its rows STAY. wallet_ledger.rule_id references it, so every historical
-- credit must keep resolving to the rule that paid it. Nothing writes to the table any more.
