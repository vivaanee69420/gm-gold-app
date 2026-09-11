# Per-referral commission, chosen by the practice manager

**Date:** 2026-09-11
**Decision by:** Ruhith, with the consequences below stated in advance
**Status:** approved, implementing

## What changes

Commission stops being a *rule* and becomes a *per-referral figure the manager picks* from five
tiers: **£20, £50, £100, £200, £250** (`2000, 5000, 10000, 20000, 25000` pennies).

The manager chooses it on the pipeline card's record, and it appears in the referrer's app when
the commission is paid.

## What this retires

This was confirmed deliberately, not overlooked.

- **FR-15 is retired.** Reward rules (`type='fixed'`, global or per-practice scope, `active_from`
  versioning, "treating-practice scope first, else global") no longer decide any payment. The
  documented Phase-2 shape for percent-with-cap goes with it.
- **FR-17 is amended.** It states the credit stores "amount, **rule id**, and treating practice
  id immutably". `rule_id` is nullable and will now always be null for new credits; the amount's
  provenance moves to `referrals.commission_pennies` plus the audit event.
- **Requirements test matrix row 7** ("Credit via confirm: rule resolution (practice > global,
  active_from) — FR-15/17") describes behaviour that will no longer exist.

`REQUIREMENTS.md` is updated in the same change so the docs do not start lying.

### The accepted cost

Every referral now needs a manual choice before it can *ever* pay, **including
Dentally-detected ones**. The Confirm queue stops being one click: an unpriced referral must be
refused, so someone opens it and picks a tier first. That is permanent extra work per payout,
accepted in exchange for per-referral control.

## Design

### Data

```sql
alter table referrals add column if not exists commission_pennies integer
  check (commission_pennies is null or commission_pennies > 0);
```

Nullable, like the other three treatment details — filled in as the practice decides, with the
gate at the paying move rather than at the keystroke.

**No CHECK on the five exact values.** The tier list is a business decision that will change;
a constraint would make each change a migration. The `> 0` check is the database's floor, and
the exact set is enforced in `treatmentDetailsSchema` at the validation boundary.

### The gate

`missingTreatmentDetails` gains `'commission'`. That one change blocks both crediting stages
through `updateStatus` — including the privileged jump straight to `treatment_completed` — with
the existing 422 and `missing` array. `ReferralModal` already opens on Treatment and lists what
is missing, so the UI affordance comes free.

### Crediting — both paths

There are **two** paths that write a credit, and they must agree:

1. `updateStatus` → `creditReferral` (the manager path, at `treatment_started`)
2. `confirmProposal` (the Dentally path, from the Confirm queue)

`creditReferral` takes `amountPennies` as an argument instead of calling `resolveRule`, and
throws `commission_not_set` (409) when it is absent. `confirmProposal` reads
`referral.commission_pennies` and refuses the same way, so the queue cannot pay an unpriced
referral. `rule_id` is written null.

### Locked once paid

After a credit exists, `setTreatmentDetails` rejects a *change* to `commission_pennies` with
409 `commission_locked`, and the dropdown renders read-only. The ledger is append-only —
restating a paid figure would need an adjustment row and a reason, which is a different
feature and not in this change.

The other three treatment details stay editable after payment, as today.

### Retired code

- `PUT /admin/reward-amount` and the reward control in `Levers.jsx`
- `resolveRule`, once nothing reads it
- `/admin/stats` currently reports `resolveRule(null)` as the current commission. With no
  single commission, it reports the tier range instead.
- The £20 global rule seeded in `0002_seed_dev.sql`

`reward_rules` the *table* stays, with its existing rows, because `wallet_ledger.rule_id`
references it and historical credits must keep resolving. Nothing writes to it any more.

### Mobile

Nothing to build. `referralsForReferrer` already returns `creditPennies` from the ledger, and
`StatusChip` already shows it on payment. The chosen tier reaches the referrer by being the
amount that was actually credited.

## Testing

- The gate blocks `treatment_started` **and** the privileged jump to `treatment_completed`
- Each of the five tiers credits exactly that amount
- The Dentally proposal path pays the chosen figure, and refuses when none is set
- The post-credit lock rejects a change and leaves the ledger untouched
- `rule_id` is null on new credits

Roughly eleven existing sites need rework, most of them tests that set the global rule via the
lever to control payouts. Two tests lose their premise entirely (rule resolution by practice)
and are removed rather than weakened.

## Explicitly out of scope

- Changing a commission after payment (needs an adjustment row and a reason)
- Percent-of-treatment-value commission (FR-15's Phase-2 shape, retired here)
- Per-practice defaults of any kind — rejected in favour of always choosing
