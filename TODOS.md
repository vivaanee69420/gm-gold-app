# TODOS — GM Referral

Index of parked work and external waits. Details live in the linked docs; this file is pointers, not copies.
Created by /plan-eng-review on 2026-08-14.

**Concrete build list (2026-08-28 audit): see `todo.md`** — security blockers, manager verification, admin dashboard gaps, email auth, DB/lock bugs, system design.

## External waits (Stage 0 — all four emails should be sent today)

- [x] **Dentally data — LIVE via Dental Os (2026-08-21, decision by Ruhith)**: the sync reads the central Dental Os DB (fed by Dentally webhooks) through read-only role `gm_referral_reader`; ~16k patients indexed on first backfill; `gmref_doorbell` triggers on Dental Os ping `/webhooks/dentally` for second-level latency. Real practices seeded (migration 0006). Direct-Dentally OAuth + token paths remain as built fallbacks (spike script kept). **The Dentally-credentials email is now OPTIONAL** — only needed if we ever switch to direct mode.
  - [ ] Deploy current code + env (`DATABASE_URL`, `DENTAL_OS_DATABASE_URL`, `DENTALLY_WEBHOOK_SECRET`) to Railway so the doorbell (which targets the staging URL) completes the instant-update chain in staging.
- [x] ~~**Meta WhatsApp Business verification**~~ — OBSOLETE (2026-08-22, decision by Ruhith): **email replaces WhatsApp** for auth OTP and reminders. Auth email first; reminder emails are a later phase. No Meta verification needed; `whatsapp_primary` mode is dropped from the plan. → new work item: pick an email provider + wire OTP-by-email alongside SMS.
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

## Phase 2 backlog

See `docs/FLOWS.md` §9 — the authoritative list (web capture page tripwire lever, wallet passes, leaderboard/draw, percent rules, fraud scoring, deferred deep linking, admin conveniences with MVP stand-ins, staff-side referral entry, self-service phone change, fuzzy matching).
