# Manager-driven pipeline, practice-scoped access, and the Patients page

Date: 2026-09-10
Status: approved, ready for implementation planning

## Problem

Commission reaches a referrer's wallet only when the Dentally sync detects a completed-and-paid
treatment and an admin confirms the resulting proposal. That makes the owner a bottleneck on every
payout, and it makes the credit depend on Dentally invoicing being both prompt and correct.

The people who actually know a treatment has started are the practice managers. They should be
able to move a patient into a "treatment started" stage from a UI and have the referrer credited
on the spot.

Three things follow from that, and are in scope here:

1. **Managers need the pipeline**, scoped to their own practice — today they get a payouts-only
   screen and every other `/admin` route 403s.
2. **A lead has to land in the right practice's pipeline.** The referral form records the practice
   the friend chose, but they may book somewhere else. Dental Os knows where the appointment
   actually is; nothing currently reads that back onto the referral.
3. **There is no patients view.** `ReferralRecord` is a flat table with no detail view, so
   "who referred this person, when, and when is their appointment" cannot be answered in one place.

## Decisions

| Question | Decision |
|---|---|
| What happens to the Dentally completion poller? | **Kept as a safety net.** Managers are the primary path; the poller only surfaces what they missed. |
| Which stage credits? | A **new `treatment_started` stage** between `treatment_agreed` and `treatment_completed`. The credit trigger moves to it. |
| Lead books at a different practice than the form said? | **The pipeline follows reality** — the practice they booked at owns the lead. The form's choice is retained, not overwritten. |
| Can a manager credit unilaterally? | **Yes.** The credit is a wallet balance, not a bank transfer — real money only moves at `payout_requests` time, which managers already handle at the counter. Every credit is in the append-only `events` log. |
| What is a "patient"? | **Referred leads only** — the `referrals` table. No copying of the wider Dental Os patient list into this app. |
| Manager screens | Pipeline, Patients, Payouts, and a stats strip for their own practice. |
| Multi-practice managers? | **No** — one practice each, matching today's `setPractice` behaviour. |
| How do managers get their UI? | **One dashboard, role-filtered** (approach A). Same app, same components; the API's practice scope decides what data comes back. |

Approach A was chosen over a separate manager app because "manager sees a subset of what the owner
sees" is a scope problem, not a different-app problem. Two shells means every bug and every design
tweak is fixed twice, and drift between them is exactly how a manager ends up seeing another
practice's patient.

## What already exists

Roughly 60% of this is built and only needs opening up:

- `referrals.status` already is the pipeline (`packages/shared/src/schemas.js`).
- `updateStatus()` → `creditReferral()` already credits on a stage move
  (`apps/api/src/services/referralService.js`).
- `PipelineBoard.jsx` already renders and drives that, admin-only.
- `admin_users.practice_ids uuid[]` and `practiceScope(req)` (`apps/api/src/app.js:91`) already
  filter reads by practice.
- `wallet_ledger_one_credit_per_referral`, a partial unique index, already makes a double credit
  impossible at the database level.

---

## §1 Schema — migration `0016_manager_pipeline.sql`

All three changes are additive; no backfill.

```sql
-- 1. The new crediting stage.
alter table referrals drop constraint referrals_status_check;
alter table referrals add constraint referrals_status_check
  check (status in ('new','contacted','booked','attended',
                    'treatment_agreed','treatment_started','treatment_completed','lost'));

-- 2. Where the appointment actually is, per Dental Os. preferred_practice_id keeps
--    saying what the referral form said; neither column overwrites the other.
alter table referrals add column booked_practice_id uuid references practices(id);

-- 3. Everything scopes on the owning practice.
create index referrals_owning_practice
  on referrals (coalesce(booked_practice_id, preferred_practice_id));
```

**Owning practice** is defined once, as `coalesce(booked_practice_id, preferred_practice_id)`.
Before an appointment exists the form's choice owns the lead; once Dental Os reports an
appointment, the practice treating them owns it. Keeping both columns means the original
attribution survives, which is what a commission dispute needs.

Existing rows get `booked_practice_id = null` and keep their current owner, so the migration
changes no visible behaviour on its own.

**Expression-index risk — self-resolving.** The index must be accepted by PGlite as well as real
Postgres. This needs no separate verification step: `apps/api/test/migrations.test.js` already
applies every migration in `supabase/migrations/` to a scratch PGlite instance, so writing `0016`
proves it on the next `npm test`. If PGlite rejects it, fall back to a plain index on each column
plus an `or` predicate in the scoped queries — the semantics are identical, only the plan differs,
and at this row count neither is measurable.

PGlite stays. It is not a dev convenience that can be dropped in favour of pointing everything at
Supabase: the whole API suite (`apps/api/test/api.test.js`, 136 tests) runs on in-memory PGlite,
and the migration test above is the only thing standing between a bad migration and production.
Real Postgres remains the deployment target and `DATABASE_URL` still swaps to it.

**Applying `0016` to production.** Ruhith has authorised running migrations against the deployed
databases (2026-09-10). Sequence matters: land the code and get the suite green first, then apply
to staging, then production. Applying the migration ahead of the code is safe in isolation (all
three statements are additive and no existing row changes owner), but does not help anything until
the code that reads `booked_practice_id` ships.

## §2 Permissions

`requireAdmin` currently gates managers with a single regex, `MANAGER_ALLOWED`
(`apps/api/src/middleware/auth.js`). Fail-closed is right and stays; the regex becomes an explicit,
readable list, and a test enforces that the list is complete.

```js
// middleware/auth.js — every /admin route a manager may reach, and nothing else.
const MANAGER_ROUTES = [
  'GET  /admin/me',            'POST /admin/me/password',
  'GET  /admin/payouts',       'POST /admin/payouts/:id/mark-paid',
  'POST /admin/payouts/:id/cancel',
  'GET  /admin/referrals',     'PATCH /admin/referrals/:id/status',
  'GET  /admin/patients',      'GET  /admin/patients/:id',
  'GET  /admin/stats',
];
```

A **route-coverage test** walks the Express router stack and asserts that every registered
`/admin/*` route is either in that list or answers 403 to a manager's token. A route added later
without a deliberate decision fails the test instead of silently opening.

### Three scoping holes that must close in the same change

| Route | Hole | Fix |
|---|---|---|
| `PATCH /admin/referrals/:id/status` | **No practice check on the write.** It is admin-only today so it never needed one. Opening it to managers unchanged would let any manager credit commission on any practice's patient by guessing a uuid. | `updateStatus()` takes a `practiceScope` argument (null = unrestricted). A referral outside scope answers **404 `not_found`**, not 403, so the response does not confirm the row exists. Mirrors `assertInScope` in `walletService.js`. |
| `GET /admin/stats` | Fully unscoped (`_req`, no filter) — returns company-wide liability and every practice's status counts. | Scope both the liability sum and the status counts to the practice. A manager sees their own numbers only. |
| `GET /admin/referrals` | Scopes on `preferred_practice_id` alone. | Switch to the owning-practice expression. |

This section is the highest-risk part of the change. The write-side check on
`PATCH /admin/referrals/:id/status` is the single line that stands between a scoped manager and
crediting commission against another practice's patient.

## §3 The credit trigger moves to `treatment_started`

- `STATUS_ORDER` in `referralService.js` gains `treatment_started` before `treatment_completed`.
- **The credit rule is "at or past `treatment_started`, if not already credited"**, not
  "exactly on `treatment_started`". `updateStatus()` calls `creditReferral()` when the target
  status is `treatment_started` **or** `treatment_completed`; the partial unique index turns the
  second call into a no-op when the first already paid. Stated as "exactly on `treatment_started`"
  it would silently skip the credit for anyone jumping straight to completed, which is precisely
  what the privileged path allows.
- In the normal (non-privileged) flow `treatment_completed` therefore credits nothing, because
  the referral must pass through `treatment_started` to reach it.
- The `privilegedComplete` jump may target either `treatment_started` or `treatment_completed`,
  and credits in both cases per the rule above.
- `wallet_ledger_one_credit_per_referral` stays as the hard backstop: `treatment_started` →
  `treatment_completed` cannot double-pay even if the branch logic were wrong.

The referrer's notification currently uses the `friend_completed` template. Money now lands at
"treatment started", so the copy must say that. The template **key** stays (avoiding an outbox
migration for queued rows); the wording in `docs/email-templates` changes.

Sites that need the new stage added — the full blast radius, 10 places:

- `packages/shared/src/schemas.js` (`REFERRAL_STATUSES`)
- `apps/api/src/services/referralService.js` (`STATUS_ORDER`, credit branch)
- `apps/api/src/services/dentally/proposalService.js` — `confirmProposal` keeps targeting
  `treatment_completed` (the poller has evidence the treatment *finished*), and keeps writing its
  own ledger row rather than going through `updateStatus`. Its behaviour change is §4's, not a
  target-status change.
- `apps/api/src/services/dentally/syncService.js` (aging report status list)
- `apps/api/src/app.js` (funnel report status arithmetic)
- `apps/admin/src/components/PipelineBoard.jsx`, `ReferralRecord.jsx` (labels)
- `apps/mobile/src/components/ui.js`, `apps/mobile/src/screens/referred.js` (labels, appointment
  visibility list)

## §4 Dentally sync — safety net and re-attribution

### Re-attribution

In `processBookedPage`, when an appointment matches a referral, resolve
`practiceIdForSite(appointment.siteId)` and write it to `booked_practice_id`. When the owning
practice changes as a result, log a `practice_reassigned` event against the referral. Reschedules
refresh both the appointment time and the practice.

This is what makes "the lead booked through Ashford's link but attended Barnet" put the patient in
Barnet's pipeline, where the manager who can actually advance them will see them.

### Safety net without double payment

- `scanCompletions` **skips filing a proposal** when a credit already exists for that referral. No
  chore lands in the owner's queue for something a manager already handled.
- `confirmProposal` **stops throwing `409 already_credited`** in that case. It marks the proposal
  confirmed, advances the referral to `treatment_completed`, skips the credit insert, and logs
  "already credited by manager".

Net effect: the poller only ever surfaces treatments the managers missed. Clawback-on-refund
(`clawbackRefunded`) is untouched and keeps working.

## §5 API additions

```
GET /admin/patients        practice-scoped list
GET /admin/patients/:id    detail for one referred patient
```

Both are in `MANAGER_ROUTES` and both apply the owning-practice scope; an out-of-scope id answers
404.

The detail payload:

- patient name, phone, email
- referrer name, phone, and the referral code used
- date referred
- practice chosen on the form vs practice actually booked
- appointment date and time
- **stage timeline** — every stage change with actor and timestamp
- commission amount and credit date, or why it has not credited yet

The timeline needs no new storage. `events` already records every `status_changed` with
`actor_id`, `actor_kind`, `from_value`, `to_value` and `created_at`. That history has been written
since day one and has simply never been displayed.

## §6 UI

`apps/admin/src/pages/ManagerPage.jsx` is deleted. Navigation is built from `me.role`.

| Surface | Manager | Admin |
|---|---|---|
| Pipeline | yes | yes |
| Patients | yes | yes |
| Payouts | yes | yes |
| Stats strip | yes, their practice | yes, company-wide |
| Reports & Setup, Team, Dentally card, Confirm queue, Review queue | no | yes |

`App.jsx`'s `loadAll` currently fires ten requests in parallel and is skipped entirely for
managers. It becomes role-aware: managers load only the endpoints they can reach.

Interaction and visual bar — clean, smooth, easy to understand, animated:

- `PipelineBoard` becomes **stage columns with drag-to-move**, animated with FLIP transitions. The
  existing `<select>` per card is **kept** as the keyboard-accessible path — the current tests
  drive it, and drag-only would be an accessibility regression.
- Stage moves are **optimistic**: the card animates into the new column immediately and rolls back
  with a toast if the API rejects it.
- Moving a card into `treatment_started` shows an **inline confirm step** before committing,
  because it credits money. Not a browser `confirm()` dialog.
- Patients page: search field, then a slide-in detail panel rendering the stage timeline as a
  vertical trail.
- Run the `frontend-design` skill during implementation rather than inventing styling ad hoc.

## §7 Testing

Test-driven, against the existing suites (`apps/api/test`, `apps/admin/test`). The tests that carry
the design:

1. A manager PATCHing another practice's referral gets **404** and no ledger row is written.
2. A manager GETting another practice's patient detail gets **404**.
3. `GET /admin/stats` as a manager returns their practice's counts, not company liability.
4. Route-coverage: every registered `/admin/*` route is either in `MANAGER_ROUTES` or 403s for a
   manager.
5. Moving to `treatment_started` credits exactly once; moving on to `treatment_completed` credits
   nothing.
6. Confirming a proposal for a referral a manager already credited resolves cleanly — no 409, no
   second credit, referral ends at `treatment_completed`.
7. The sync writes `booked_practice_id`, and the lead moves into the booked practice's scope.
8. Migration `0016` applies cleanly — covered for free by the existing `migrations.test.js`, which
   replays every migration onto a scratch PGlite. This is also what settles the §1 expression-index
   question. Confirm against real Postgres as part of the staging deploy, not as a code change.

Existing `PipelineBoard.test.jsx` and `ManagerPage.test.jsx` both change: the first gains the new
stage and the confirm step, the second is deleted along with the component it covers.

## Out of scope

- Multi-practice managers. The `practice_ids uuid[]` column already allows it; nothing here uses
  it. One practice per manager, as today.
- Importing the wider Dental Os patient list. Patients means referred leads.
- Manually adding a walk-in who mentioned a referrer but never used the link.
- Removing the Dentally completion poller. It stays as the safety net.
- Any change to how payouts are collected or marked paid.
