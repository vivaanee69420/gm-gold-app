# TODOS — GM Referral

Index of parked work and external waits. Details live in the linked docs; this file is pointers, not copies.
Created by /plan-eng-review on 2026-08-14.

**Concrete build list (2026-08-28 audit): see `todo.md`** — security blockers, manager verification, admin dashboard gaps, email auth, DB/lock bugs, system design.

## External waits (Stage 0 — all four emails should be sent today)

- [x] **Dentally data — LIVE via Dental Os (2026-08-21, decision by Ruhith)**: the sync reads the central Dental Os DB (fed by Dentally webhooks) through read-only role `gm_referral_reader`; ~16k patients indexed on first backfill; `gmref_doorbell` triggers on Dental Os ping `/webhooks/dentally` for second-level latency. Real practices seeded (migration 0006). Direct-Dentally OAuth + token paths remain as built fallbacks (spike script kept). **The Dentally-credentials email is now OPTIONAL** — only needed if we ever switch to direct mode.
  - [ ] Deploy current code + env (`DATABASE_URL`, `DENTAL_OS_DATABASE_URL`, `DENTALLY_WEBHOOK_SECRET`) to Railway so the doorbell (which targets the staging URL) completes the instant-update chain in staging.
- [x] ~~**Meta WhatsApp Business verification**~~ — OBSOLETE (2026-08-22, decision by Ruhith): **email replaces WhatsApp** for auth OTP and reminders. Auth email first; reminder emails are a later phase. No Meta verification needed; `whatsapp_primary` mode is dropped from the plan. → new work item: pick an email provider + wire OTP-by-email alongside SMS.
- [ ] 🚨 **BLOCKER — Dental OS reads are denied: the sync cannot see anything** (owner: Dental OS
  owner). Diagnosed 2026-09-09 against the live `DENTAL_OS_DATABASE_URL`:

  ```
  connected as:       gm_referral_reader                              OK
  tables visible:     appointments, contacts, invoices, practices     OK
  current_org_id():   exists, owned by postgres
  EXECUTE privilege:  false                                        <-- the blocker
  ```

  RLS policies on `contacts`, `appointments` and `invoices` all call `current_org_id()`, and
  `gm_referral_reader` cannot execute it, so **every** read fails with
  `permission denied for function current_org_id`. That is patients, appointments AND invoices —
  the whole sync. No booking detection, no treatment tracking, no commission, ever.

  It fails SILENTLY: `runSync` catches and returns `{error}`, so it has been failing every 15
  minutes into the Railway logs rather than alerting anyone. Nothing in the app looks broken.

  **Ask the Dental OS owner for:**
  ```sql
  grant execute on function current_org_id() to gm_referral_reader;
  ```
  and then confirm it RESOLVES an org for that role — if it returns null, the policies will
  return zero rows and the sync will look "working but empty", which is worse than an error.
  Verify with: `select count(*) from appointments;` as `gm_referral_reader`.

- [ ] **Accountant: cash-commission tax treatment** (owner: practice accountant) — blocks payout wording + terms. → open question 2
- [ ] **Solicitor: incentive claims + UK GDPR Article 9 basis** (owner: solicitor) — blocks consent wording finalization + launch. → open question 5 / compliance checklist

## Booking-first referred flow (built 2026-08-22)

- [x] **Per-practice Dentally booking links** — DONE for Ashford, Barnet, Bexleyheath, Rochester
  (migration 0009, provided by Ruhith 2026-08-22). Warwick Lodge removed from the app (deactivated)
  per Ruhith, same day. Remaining:
  - [ ] ⚠ All four portals return CloudFront 403 from a non-UK connection (likely geo-restriction) —
    verify they open from a UK network/phone before promoting the flow.
- [ ] **Dental Os doorbell for bookings** — the trigger only fires on appointment-completed +
  invoice-paid, so new bookings confirm on the 15-min poll (or admin "Sync now"), not in seconds.
  Extend the Dental Os trigger to also ping on appointment insert/update when instant confirmation matters.

## Launch deliverables not yet written

- [ ] SAR runbook (per-user export + anonymization SQL, tested on staging) → `docs/runbooks/` — REQUIREMENTS FR-27
- [ ] Cash-operations runbook per practice (float, authorization, till reconciliation) → `docs/runbooks/` — REQUIREMENTS §7 checklist

## Deployment gates

- [x] **Provision Supabase project** — DONE 2026-08-21: "gm refferal app" (`xiijsxabqwngeoxlflya`), migrations 0001–0004 applied + `_migrations` ledger written + RLS enabled everywhere (see README "Supabase"). Remaining:
  - [ ] ⚠ **Region is ap-southeast-2 (Sydney), design says eu-west-2 (London)** — recreate in London before launch (UK latency + GDPR residency); DB is fully scripted so the move is ~5 minutes while it holds no real data.
  - [x] Local `DATABASE_URL` — DONE 2026-08-21: dedicated `gm_referral_api` role + `apps/api/.env` (session pooler), verified live incl. advisory locks.
  - [ ] Set the same `DATABASE_URL` on the Railway api service when staging should switch off its PGlite volume.

## Design gates awaiting answers

- [ ] Refund/clawback detection mechanism — cannot be designed until Dentally's API answer arrives; today the sync worker cannot see refunds at all. → DESIGN open question 5
- [ ] Referred-friend incentive (free consult + 5% off carry-over?) — finalizes the referred screens' promise line, share message, terms. → open question 3
- [ ] GHL push at MVP or Phase 2 → open question 4
- [ ] Backend hosting choice + environments → open question 7

## Surfaced by /plan-eng-review 2026-09-09 (Supabase Auth + email plan)

- [ ] **Bounced money emails fail silently** — alerting or a worklist for `notification_outbox`
  rows reaching `status='failed'`. A hard-bounced `wallet_credit` or `payout_receipt` means a
  referrer is never told they earned money, and nothing surfaces it. The plan's stats-strip
  counter is not a real owner — nobody watches a counter. Cheap to build once the sender exists
  (`failed` and `last_error` are already written); the open decision is where the alert goes:
  dashboard worklist, email to the owner, or Sentry. **Blocked by:** change 3's outbox sender.
- [ ] **Migrate `admin_users` to Supabase Auth** — decision I2 (2026-09-09) sequenced the
  dashboard *after* patients, so until this lands you run two auth systems and still own scrypt,
  lockout tuning and the admin password-reset flow that does not exist today. This supersedes the
  2026-08-29 email+password decision as a permanent end state. **`verifyToken` and `tokenRevoked`
  must stay in `userService.js` until this happens** — `requireAdmin` (`middleware/auth.js:36`)
  and `adminService.js:244` both use them. ~900 lines deleted with ~900 lines of tests behind
  them, so it needs its own review pass. **Blocked by:** change 3 proving JWKS verification in prod.
- [ ] **Outbox + analytics retention job** — Q19's answer as code: outbox rows 90 days,
  `analytics_events` 13 months, audit `events` forever. `notification_outbox` is append-only today
  and nothing ever deletes from it. Storage hygiene and GDPR data-minimisation, not performance —
  the partial index from I9 keeps the drain fast regardless. `otp_deliveries` retention is moot;
  that table is dropped in migration 0013.

- [ ] **Move sending back to `mail.gmdental.co.uk` before the first real patient** — testing
  currently borrows `mail.plan4growth.uk`, which was already verified in Resend (2026-09-09).
  Two reasons it cannot ship: a GM Dental login code arriving from `plan4growth.uk` is
  indistinguishable from phishing, and it trains patients to accept codes from a domain that
  is not their dentist; and sender reputation is per-domain, so a spam complaint against
  either business would degrade the other's deliverability. Work: verify
  `mail.gmdental.co.uk` in Resend (DKIM/SPF/DMARC), then change BOTH the Supabase SMTP
  "Sender email address" AND `EMAIL_FROM` in the API env — they must match.
  **Blocked by:** nothing. It is 10 minutes of DNS whenever you want it.

- [ ] **Rare cross-file test flake (~1 run in 11)** — not root-caused, recorded so the next
  person does not start from zero. Symptom: a handful of tests fail with the sync worker
  returning nothing (`verificationsResolved: 0`, `proposalsCreated: 0`) or `requireUser`
  answering 401 to a token that is valid. Always passes on a re-run.
  **What is established:** `test/dentally.test.js` alone is 8/8 green, so it is not
  order-dependence inside that file. It only appears when files run together, which points at
  module-global state that each test file implicitly assumes it owns: `db.js:13` holds a
  module-level `driver` that `initDb()` reassigns, and `syncService.js:27` holds a
  module-level `inFlight` guard. In the default pool each file gets its own worker and module
  registry, so that assumption normally holds — under load or a shared registry it does not.
  **Do NOT use `--poolOptions.threads.singleThread` on this suite.** It shares one registry
  across files, so the second file's `initDb()` swaps the database out from under the first,
  and it fails ~1 run in 3. It is not a stricter check; it is an invalid one.
  **Where to start:** make `db.js` expose a per-caller handle rather than a module-global
  driver, or give vitest `isolate` guarantees the suite can actually rely on.

- [ ] 💰 **Refund / clawback: commission paid on treatment that gets refunded is unrecoverable**
  — now the single largest uncapped money hole, and the sync cannot see refunds at all. Flow:
  patient pays first invoice → we credit the referrer → the practice refunds them → the £20 is
  gone with nothing marking it. Newly actionable: the Dental OS read-only access was granted
  2026-09-09, so `invoices` is queryable. Work: detect a paid invoice becoming unpaid/refunded
  (or a credit note) for a contact behind a credited referral, then write a reasoned negative
  adjustment via the existing wallet ledger — do NOT delete the original credit, the ledger is
  append-only (NFR-03). Also decide what happens if the referrer has already been paid out.

- [ ] **Self-referral via a different phone** — `referralService.js:24` only rejects
  `referrer_phone === referred_phone`. Refer yourself using a spouse's or second number and it
  passes. The FR-11 existing-patient check now catches the case where you refer yourself and
  you were already a patient, which is the common one, but not a genuinely new second person.
  Options: device fingerprint, same-household heuristics, or a per-referrer cap.

- [ ] **No rate limit on referral submission** — `todo.md` Q18 specifies 3/day/account. Not
  implemented; there is no limit at all. One compromised or abusive account can submit
  unbounded referrals.

- [ ] **Staff participation is undefined** — anyone can refer, including practice employees.
  This is the sharpest edge of the GDC "referral fee" guidance, which restricts dental
  professionals receiving benefit for referrals. Patient word-of-mouth is a different thing and
  is normal, but staff earning per head is not. Ask the solicitor alongside the incentive-claims
  question, and consider flagging staff accounts.

- [ ] **Shared family phone blocks legitimate referrals** —
  `referrals_referred_phone_active` is unique per phone, so a household sharing one mobile can
  only ever have ONE referred member. Common in dentistry. Consider keying on phone+name, or
  allowing an admin override.

## Phase 2 backlog

See `docs/FLOWS.md` §9 — the authoritative list (web capture page tripwire lever, wallet passes, leaderboard/draw, percent rules, fraud scoring, deferred deep linking, admin conveniences with MVP stand-ins, staff-side referral entry, self-service phone change, fuzzy matching).
