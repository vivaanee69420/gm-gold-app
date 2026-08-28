# GM Referral — Requirements

Companion to `DESIGN.md` (decisions) and `FLOWS.md` (flows and diagrams). Money is always integer pennies. Phones are always E.164.

**Data-access topology (read first).** The mobile app and admin web talk to Supabase **Auth only** for sessions
(OTP issue/verify underneath Express, token refresh). ALL data reads and writes go through the Express API:
clients send their Supabase JWT, Express verifies it and uses the service-role key server-side. RLS is still
enabled on every table as defense in depth (and to keep a future direct-client path safe), but at MVP no
client queries Postgres directly.

## 1. Functional requirements — MVP

### Auth & identity
- **FR-01** Users authenticate with phone number + 6-digit OTP. The app calls Express (`/auth/otp/send`,
  `/auth/otp/verify`); Express enforces policy and drives Supabase Auth underneath. Delivery: Supabase's
  send-SMS hook calls Express, which sends the Meta WhatsApp authentication template; SMS fallback per FR-02a.
- **FR-02** OTP policy, enforced in Express (Supabase's built-in limits are coarser and are treated as a
  backstop only): 5-minute expiry; max 3 sends per number per 5 minutes; max 5 verification attempts per
  code; generic error on failure (no account enumeration).
- **FR-02a** SMS fallback *(revised by eng review 2026-08-14, outside voice)*: Meta reports delivery
  failures asynchronously, so on a `failed`/`undeliverable` status webhook (`/webhooks/whatsapp-status`,
  signature-verified) within the OTP window, Express requests a **fresh** Supabase-issued code delivered via
  SMS — the same path as the "Send via SMS instead" button the app shows after 20s. **Express never stores
  OTP codes**: `otp_deliveries` holds delivery metadata only (phone, channel, status, attempts). A
  late-arriving WhatsApp code is simply stale once a fresh code is issued (5-minute window,
  self-explaining). Channel selection mechanics: before asking Supabase to issue, Express
  records the requested channel as pre-send intent on `otp_deliveries` (keyed by phone); the send hook reads
  that intent to choose WhatsApp or SMS delivery. **Launch-mode switch** *(eng review 2026-08-14)*:
  `app_settings.otp_channel_mode` ∈ `sms_only` | `whatsapp_primary` gates all WhatsApp sends (OTP and
  notifications). Launch in `sms_only` (Meta business verification takes 2–4 weeks and blocks
  Authentication templates entirely until approved); flip to `whatsapp_primary` from the dashboard, no
  deploy. The same switch is the kill switch if Meta suspends the number. The acceptance demo must pass in
  both modes.
- **FR-03** Sessions persist for months via refresh tokens with silent renewal; no forced logout. Admin can
  revoke a user's sessions.
- **FR-04** First login presents a role picker: referrer ("I want to refer friends") or referred ("I was
  referred"). Role is changeable later; a user can hold both.
- **FR-05** Referrer role requires verification as an existing patient by phone match against Dentally.
  `users.verification_status ∈ {unverified, pending_review, verified, rejected}`. No match or ambiguous
  match (shared family number) → `pending_review` in the admin queue (approve links a Dentally record →
  `verified`; reject → `rejected`, user notified). **Dentally unreachable** → `pending_review` plus an
  automatic retry job that re-runs the match and auto-resolves clean matches without admin action.
  Onboarding captures first + last name whenever no Dentally record supplies one, so `pending_review` users
  always have a display name in the queue.
- **FR-06** Referral notification opt-in is captured at referrer onboarding (checkbox), stored with wording
  version + timestamp. The wording is **channel-neutral** ("Message me about my referrals and rewards —
  WhatsApp or SMS"), so consent covers the channel actually used in `sms_only` launch mode. Utility
  notifications (FLOWS §7) go only to opted-in users; OTP delivery is exempt.

### Referral capture
- **FR-07** Each verified referrer gets a unique referral code: canonical form is 8 characters from an
  unambiguous alphabet (no 0/O, 1/I/L), stored and validated without separators; displayed grouped
  `XXXX-XXXX`; entry is normalized (strip hyphens/spaces, uppercase). A QR encodes a deep link carrying the
  code. Codes flip `active=false` only via admin action (fraud, offboarding) or SAR anonymization —
  deactivated codes stop validating, history stays intact. Self-service phone-number change is Phase 2; at
  MVP an admin re-links the account (verification queue re-link).
- **FR-08** Referrer home shows QR (hero), code, and a native share action. The prefilled WhatsApp message
  always includes the code as plain text + both store links (the code must survive an app install). Android
  carries the code through install via Play Install Referrer; iOS has no deferred deep linking at MVP
  (accepted gap — manual code entry is the primary referred path).
- **FR-09** Referred users enter the code by in-app QR scan or manual typing; validated against active
  referrers.
- **FR-10** Referral submission captures: the referred person's **full name** (needed for the pipeline,
  proposal cards, and manual matching), treatment interest (implants / aligners / veneers / bonding / not
  sure), preferred practice (6 options), and a required consent checkbox with wording version + timestamp.
  The consent wording explicitly covers **special-category (health) data** and **disclosure of booking and
  completion milestones to the named referrer** (UK GDPR Article 9 — see NFR-02).
- **FR-11** Fraud rules: reject referred phone == referrer phone at submit; the Dentally existing-patient
  check runs **async** (never blocks submission) and sets `referrals.review_status =
  'existing_patient_suspect'` for admin review when the phone is already a patient (retries if Dentally is
  down; flag can apply retroactively); first referrer code wins per referred phone, but a referral that ended
  `lost` does not block re-referral (uniqueness excludes `lost`); rate-limit submissions per device and
  number.

### Pipeline
- **FR-12** Referral statuses: `new → contacted → booked → attended → treatment_agreed →
  treatment_completed`, with `lost` (reason required) reachable from any non-terminal state. Adjacent-only
  transitions (409 otherwise), with **one privileged exception**: confirming a completion proposal (FR-17)
  may move any active referral straight to `treatment_completed`, and the audit event records the skipped
  stages.
- **FR-13** Admin advances statuses from the dashboard; every transition writes an append-only audit event
  (who, when, from, to, reason).
- **FR-14** The referrer sees each referral's stage (first name + initial only) and receives WhatsApp
  notifications on `booked` and `treatment_completed` (opt-in holders only).

### Commission & wallet
- **FR-15** Reward rules: `type='fixed'`, amount in pennies (launch default 2000 = £20), scope global or per
  practice, `active_from` date. **Resolution**: the single rule in scope with the greatest
  `active_from ≤ now` — treating-practice scope first, else global; overlapping same-scope rules are
  rejected on save. Admin edits affect future confirmations only. (Shape supports percent-with-cap for
  Phase 2.) The payout threshold does NOT live on rules; see FR-20.
- **FR-16** A Dentally sync worker (in-process cron in the API; optional inbound webhook verified by HMAC
  signature) detects completed-and-paid treatments, matches patient phones against open referrals, and
  creates **proposals** carrying the **treating practice id** from the Dentally event. Matching is **exact
  E.164 phone match only** *(fuzzy confidence machinery cut — outside voice, 2026-08-14)*; misses of any
  kind are caught by the aging report (FR-25) feeding the FR-18 manual path. It never credits
  automatically. Idempotent: proposals unique per Dentally event id. The worker run itself takes a global
  advisory lock (skip if held), so overlapping deploys or replicas can never run two syncs concurrently. **Sync mechanics** *(eng review 2026-08-14)*: (a) cursor — a `sync_state` row stores
  the `updated_since` watermark, advanced only after a page is fully processed, so restarts resume, never
  re-scan; (b) eligibility — only treatments completed AFTER the linked referral was submitted may generate
  a proposal (no launch-day backlog credits); (c) matching — the worker also refreshes a minimal
  `dentally_patient_index` (dentally_patient_id, phone E.164, practice_id), which both proposal matching and
  FR-05 referrer verification read, giving one Dentally read path instead of two; (d) cadence — poll every
  15 minutes; webhook (if Dentally provides one) becomes a trigger for an immediate poll, not a separate
  ingestion path.
- **FR-17** Admin confirms a proposal with one click: referral → `treatment_completed` (privileged
  transition), and a ledger credit is written using the rule resolved per FR-15, storing amount, rule id, and
  treating practice id immutably. Confirm, the status transition, and the credit are **one transaction**
  under the NFR-09 lock. Confirm is **blocked** while the referral's
  `review_status = 'existing_patient_suspect'` (resolve the review first); if the flag lands after a credit,
  the referral surfaces in the review list and admin may void via a reasoned adjustment. One credit per
  referral is enforced by a partial unique index (§3).
- **FR-18** A manual completion path exists (Dentally down or mismatch): admin marks completed + credits with
  a required reason and a chosen practice attribution; audit-logged. Manual credits carry a client-generated
  idempotency key (unique on the ledger row) so a double-click can never credit twice.
- **FR-19** Wallet is an append-only ledger (`credit` / `debit` / `adjustment` with reason). Balance is
  computed as the sum; never a stored mutable field. App shows balance, threshold progress, lifetime earned,
  per-referral history.

### Payout
- **FR-20** Payout threshold is global at MVP: `app_settings.payout_threshold_pennies` (working default
  10000 = £100), admin-editable, effective immediately for new requests. The "payout ready" notification
  fires whenever balance ≥ threshold AND no open payout request AND the notified flag
  (`users.payout_ready_notified_at`) is clear; the flag is set on fire and cleared when the balance drops
  below the threshold or a payout is marked paid — so re-crossings after a payout are always announced,
  including when accumulated credits keep the balance above threshold across the payout. The app unlocks
  payout requests at the same condition.
- **FR-21** A payout request: referrer picks a practice; one open request per user; amount = full available
  balance at request time. The referrer can cancel their own open request; admin can cancel with a reason;
  requests expire after `app_settings.payout_expiry_days` (default 14). Cancel/expire leave the balance
  untouched.
- **FR-22** Admin marks the payout paid after in-person cash collection and identity check (referrer shows
  their in-app code). This writes a ledger debit and a WhatsApp receipt.
- **FR-23** Commission liability (sum of unpaid balances) is visible on the dashboard as a total. Per
  practice, two separate measures are reported: **earned per practice** (credits, via the ledger rows'
  practice attribution) and **paid out per practice** (debits, at the collecting practice). No per-practice
  net liability is computed, because payouts can be collected at any practice.

### Admin
- **FR-24** Admin web dashboard (React/Vite) is its own email + password identity (2026-08-28 rework —
  `admin_users` is no longer keyed off Supabase auth or a patient `users` row), with two roles: `admin`
  (every practice, every lever/queue, plus team management) and `manager` (2026-08-28 decision — one
  practice, payouts only: fenced server-side to `GET /admin/me`, `/admin/payouts*`, and
  `POST /admin/me/password`; every other `/admin/*` route 403s). Passwords are scrypt-hashed
  server-side (never Supabase); a JWT (`POST /auth/admin/login`) carries the session, with server-side
  revocation (`sessions_revoked_at`) on password change/reset and on deactivation. Admins manage the
  team themselves — `admin`s create and deactivate/reactivate other `admin`s and `manager`s and reset
  their passwords (`/admin/team*`, always logging an `events` row); every account can change its own
  password (`POST /admin/me/password`). Deactivating the last active `admin` is refused (`last_admin`),
  as is deactivating yourself (`cannot_deactivate_self`) — the team can never lock itself out. There is
  no in-dashboard sign-up: the very first `admin` account is bootstrapped from the command line with
  `scripts/create-admin.js` (see README's "Dashboard accounts" section) right after a fresh deploy, since
  migration 0011 deactivates every pre-existing (pre-password) `admin_users` row. Practice scoping of
  queues and levers reads `practice_ids`, which means different things by role: for `admin` it's always
  empty (unconditional all-practice access, not just an empty-means-all default); for `manager` it holds
  exactly the one practice they were created with.
- **FR-25** Dashboard surfaces: levers (rules + app settings), verification review queue, referral review
  list (referrals only, `existing_patient_suspect`; decisions: *clear* → `review_status='cleared'`, or
  *confirm existing patient* → referral `lost` with reason `existing_patient`, never creditable),
  confirm-completions queue, payout queue, pipeline board with lost reasons, funnel report, top referrers,
  and the **aging report**: referrals at `booked`/`treatment_agreed` for ≥ N days with no proposal — the
  catch-all surface for phone-match misses (typos, landlines, a parent's number), feeding the FR-18 manual
  path. A **daily digest** ("n proposals, n payout requests waiting") goes to each practice inquiry contact
  via the notification outbox — front desks must not need to remember to poll a dashboard.
  (System-health card deferred to Phase 2 — at MVP, failing external calls per NFR-04 are logged with
  alertable log lines, not a dashboard surface.)
- **FR-26** *(deferred to Phase 2 — eng review 2026-08-14)* Owner exports: CSV of `wallet_ledger` and
  `referrals` for a chosen date range. MVP stand-in: owner queries via the Supabase dashboard.
- **FR-27** Subject-access and erasure (GDPR): obligations are met at MVP via a **documented, tested
  runbook** — owner runs reviewed SQL scripts for per-user export and anonymization (user row pseudonymized,
  auth identity deleted; immutable ledger/audit rows retained under the financial-records lawful basis,
  linked only to the pseudonymized id). Automated endpoints are Phase 2. The runbook is a launch
  deliverable: written, tested against staging, stored in `docs/runbooks/`.

### Instrumentation
- **FR-28** First-class analytics events: `invite_sent`, `app_activated`, `share_tapped`, `code_entered`,
  `referral_submitted`, `consult_booked`, `treatment_completed`, `commission_paid`. `invite_sent` is
  externally sourced (GHL campaigns; counts entered in a manual number field on the dashboard and marked as
  such — CSV upload is Phase 2). **Tripwire metric** *(re-anchored by outside voice, 2026-08-14)*: the
  premise-3 tripwire is `code_entered → referral_submitted` completion plus store-install attribution
  (Android Install Referrer), reported on the dashboard; `share_tapped` is shown but documented as noisy
  (share-sheet opens ≠ messages sent, especially on iOS). A collapsing completion rate triggers the
  web-form fallback decision recorded in DESIGN.md.

## 2. Non-functional requirements

- **NFR-01 Security**: topology per the note at the top (Express-only data path, service-role server-side,
  JWT verified per request); RLS enabled on all tables as defense in depth; input validation at the API
  boundary (zod or equivalent in JS); no shared static API keys; webhooks (Meta status, Dentally) verified by
  signature/HMAC; transient OTP records encrypted at rest and TTL-deleted.
- **NFR-02 Privacy/GDPR**: lawful basis + consent recorded with wording version for referred contacts and for
  referrer notification opt-in; data minimization (first name + initial to referrers); SAR export and
  anonymization per FR-27, reconciling erasure with the immutable ledger (pseudonymize the person, retain the
  financial record); DPAs with processors (Meta, Supabase, hosting, SMS provider).
  **Special-category data (UK GDPR Article 9)** *(outside voice, 2026-08-14)*: treatment interest and
  treatment-progress milestones are health data, and the product deliberately discloses milestones to the
  referrer — the referred consent (FR-10) explicitly covers both, and the solicitor review (§7) covers the
  Article 9 lawful basis, not just advertising claims.
- **NFR-03 Auditability**: append-only `events` table records every status change, credit, debit, adjustment,
  payout, queue decision, and admin action with actor and timestamp.
- **NFR-04 Reliability**: OTP delivery ≥99% via WhatsApp + SMS fallback (FR-02a); Dentally sync idempotent
  (unique event id); all external calls (Dentally, Meta, SMS) retried with backoff and logged with
  alertable log lines when failing (admin health panel is Phase 2).
- **NFR-05 Performance**: app cold start to QR visible under 2s on mid-range Android; API p95 < 300ms for
  reads. The card screen (QR + code) is cached locally and renders **offline** after first load — it is the
  one screen used in someone else's living room on bad signal, and it is static per user.
- **NFR-06 Money**: integer pennies everywhere; no floats; currency GBP only at MVP.
- **NFR-07 Code standards**: ESM JavaScript (Node 22+), layered Express structure (routes / controllers /
  services / repositories), ESLint + Prettier, Supabase migrations in-repo, CI on every PR.
  **Test stack (pinned — eng review 2026-08-14)**: **vitest** (+supertest) against a local Supabase
  Postgres for API/services, including the NFR-09 concurrency tests; **Maestro** for the four mobile E2E
  flows; **Playwright** for the admin web queues. The full path-by-path matrix is §6; every path lands
  WITH its test, not after. **Shared-package contract** *(eng review 2026-08-14)*:
  `packages/shared` holds the four modules all three apps import so the rules cannot drift —
  `phone.js` (E.164 normalize/validate), `referral-code.js` (normalize, display-format, alphabet),
  `money.js` (penny math + GBP formatting), `schemas.js` (zod schemas reused by API validation and both
  front ends). Validation library is **zod** (pinned; "or equivalent" no longer applies).
- **NFR-08 Config**: all levers and secrets via environment/config or the `app_settings` table; none
  hardcoded; per-practice config in data, not code.
- **NFR-10 Durable notifications** *(outside voice, 2026-08-14)*: every user-facing notification is written
  as a `notification_outbox` row in the SAME transaction as its triggering event; a drain worker sends with
  retry/backoff — a restart never loses a message. In `sms_only` mode, utility notifications **fall back to
  SMS**, never silently dropped, so the acceptance demo's "credit message arrives" holds in both channel
  modes.
- **NFR-09 Money-path integrity** *(eng review 2026-08-14)*: every wallet-mutating operation (credit,
  debit, adjustment, payout-request create, mark-paid, cancel) runs in a single DB transaction that first
  acquires `pg_advisory_xact_lock(hashtext(user_id))`, so operations on the same wallet take turns. The
  balance is re-computed inside the lock before any debit or payout-request insert, and the transaction
  asserts the post-operation balance ≥ 0 (abort otherwise). Manual credits carry an idempotency key
  (FR-18). Each rule gets a dedicated concurrency test (two simultaneous ops on one wallet).

## 3. Data model (Supabase Postgres)

```
users            id (auth uid), phone (unique, E.164), first_name, last_name,
                 role_referrer bool, role_referred bool,
                 verification_status ('unverified'|'pending_review'|'verified'|'rejected'),
                 dentally_patient_id nullable, practice_id nullable,
                 notify_opt_in bool, notify_opt_in_version, notify_opt_in_at,
                 payout_ready_notified_at nullable, created_at
referral_codes   id, user_id, code (unique, 8-char canonical), active bool, created_at
referrals        id, referrer_id, referred_user_id, referred_phone, treatment_interest,
                 preferred_practice_id, status, lost_reason,
                 review_status (null|'existing_patient_suspect'|'cleared'),
                 consent_version, consent_at, source ('qr'|'code'), created_at
reward_rules     id, practice_id nullable (null = global), type ('fixed'),
                 amount_pennies, active_from, created_by
app_settings     key, value, updated_by, updated_at
                 (keys: payout_threshold_pennies, payout_expiry_days, otp_channel_mode, ...)
completion_proposals  id, referral_id, dentally_event_id (unique), matched_phone,
                 invoice_state, treating_practice_id,
                 status ('open'|'confirmed'|'rejected'), decided_by, decided_at, reason
wallet_ledger    id, user_id, kind ('credit'|'debit'|'adjustment'),
                 amount_pennies, referral_id nullable, rule_id nullable,
                 practice_id nullable (attribution), payout_id nullable,
                 idempotency_key nullable (unique), reason nullable,
                 created_by, created_at
payout_requests  id, user_id, amount_pennies, practice_id, status
                 ('open'|'paid'|'expired'|'cancelled'), requested_at,
                 cancelled_by nullable, paid_by, paid_at
practices        id, name, address, inquiry_phone, inquiry_email, active
events           id, actor_id, entity_type, entity_id, action, from_value,
                 to_value, reason, created_at   (append-only)
otp_deliveries   id, phone, channel, delivery_status, attempts,
                 expires_at, created_at   (delivery metadata ONLY — no codes stored;
                 doubles as the FR-02 rate-limit counter store — send counts are
                 row counts per phone per window, verify caps use attempts;
                 Postgres is the counter home, no Redis, survives restarts)
notification_outbox  id, recipient_kind ('user'|'practice_contact'), recipient_id,
                 template, payload jsonb, channel_resolved, status, attempts,
                 created_at, sent_at   (written in the SAME transaction as the
                 triggering event; drained with retry — restarts lose nothing)
admin_users      id, email (unique), password_hash, role ('admin'|'manager'),
                 practice_ids uuid[], active, last_login_at, sessions_revoked_at,
                 created_at   (own email+password identity, 2026-08-28 — separate
                 from patient `users` and from Supabase auth; queue and lever
                 scoping reads practice_ids)
sync_state       key, watermark, updated_at   (Dentally updated_since cursor)
dentally_patient_index  dentally_patient_id (unique), phone (E.164, indexed),
                 practice_id, refreshed_at   (read model for matching + verification)
analytics_events id, user_id nullable, name, properties jsonb, created_at
```

Declared indexes *(eng review 2026-08-14)*: `wallet_ledger(user_id)` (every balance computation),
`referrals(referrer_id, status)` (app home list), `referrals(referred_phone)` (dup checks),
`analytics_events(name, created_at)` (funnel report), `payout_requests(practice_id, status)` (queues),
`dentally_patient_index(phone)` (matching + verification).

Constraints that matter: at most one `credit` ledger row per referral (partial unique on
`wallet_ledger(referral_id) WHERE kind='credit'` — two different Dentally events for the same referral can
both propose, but never both credit); one open payout request per user (partial unique on `status='open'`);
`completion_proposals.dentally_event_id` unique (idempotent sync); ledger and events rows immutable (no
UPDATE/DELETE grants); `referrals.referred_phone` unique via a **partial index excluding `status='lost'`**
(first code wins, but lost referrals don't consume the person forever); at most one same-scope reward rule
per `active_from` window (overlap rejected on save).

## 4. API surface (Express, ESM) — sketch

```
POST /auth/otp/send               phone (+ channel=whatsapp|sms); Express rate limits, Supabase issues
POST /auth/otp/verify             phone + code; attempt caps enforced here
POST /auth/hook/send-otp          (Supabase send-SMS hook -> WhatsApp delivery + transient record)
POST /webhooks/whatsapp-status    Meta delivery-status webhook (signature-verified; drives SMS fallback)
GET  /me                          profile, roles, verification state
POST /me/role                     pick/add role
POST /me/notify-opt-in            record opt-in with wording version
POST /referrals                   referred user submits code + interest + consent
GET  /referrals/mine              referrer's list with stages
GET  /wallet                      balance, threshold, ledger
POST /payouts                     create payout request (balance >= threshold)
DELETE /payouts/:id               referrer cancels own open request
-- admin (own email+password identity in admin_users, role-gated — see FR-24) --
POST /auth/admin/login            email + password -> { token, admin }; scrypt-verified, rate-limited
                                   per email and per IP
GET  /admin/me                    role + practices this account can see (manager: their one practice;
                                   admin: all). A `manager` role reaches ONLY this route,
                                   /admin/payouts*, and POST /admin/me/password; every other /admin/*
                                   route 403s `forbidden` for it.
GET  /admin/team                  POST /admin/team { email, password, role, practiceId? } create a
                                   teammate; POST /admin/team/:id/password { password } reset one's
                                   password (kills their existing sessions); POST /admin/team/:id/active
                                   { active } deactivate/reactivate (409 cannot_deactivate_self /
                                   last_admin). admin-only; every mutation logs an events row.
POST /admin/me/password           { currentPassword, newPassword } — either role; 401 wrong_password,
                                   422 weak_password; re-issues a token (own sessions_revoked_at bumps too)
GET/PUT /admin/rules              commission rules (overlap-checked on save)
GET/PUT /admin/settings           payout threshold, payout expiry days
GET  /admin/verification-queue    POST /admin/verification-queue/:id/decide
GET  /admin/referral-review      POST /admin/referral-review/:id/decide
GET  /admin/proposals             POST /admin/proposals/:id/confirm|reject
GET  /admin/referrals             PATCH /admin/referrals/:id/status
GET  /admin/payouts               POST /admin/payouts/:id/mark-paid { amountPennies } | :id/cancel
GET  /admin/reports/funnel|liability|top-referrers|aging
POST /admin/users/:id/revoke-sessions   admin/owner: revoke a patient user's sessions (FR-03)
-- Phase 2 (MVP stand-ins per FR-26/FR-27: Supabase dashboard queries + SAR runbook) --
GET  /admin/exports               owner: CSV ledger/referrals by date range
POST /admin/sar/:userId/export    owner: subject-access export
POST /admin/sar/:userId/anonymize owner: pseudonymize per FR-27
POST /webhooks/dentally           optional inbound events (HMAC-verified); sync worker itself
                                  runs in-process on a cron schedule, no public trigger endpoint
```

## 5. Acceptance criteria (the demo that must pass before store submission)

1. Admin sets commission to £20 and threshold to £100; no deploy.
2. A verified referrer (Dentally phone match) logs in via WhatsApp OTP in under 60s and shares their code on
   WhatsApp. A number without WhatsApp receives the code via the SMS path.
3. A referred user installs, scans the QR (or types the code from the share message), submits interest with
   consent; the referrer gets the "friend used your code" message; the inquiry appears as `new`; the
   practice inquiry contact is notified.
4. Admin walks the pipeline to `treatment_agreed`; the Dentally sync proposes the completion with treating
   practice; admin confirms with one click.
5. The referrer's wallet shows +£20, the credit message arrives, and the threshold bar moves.
6. With balance ≥ threshold, the referrer requests payout at a practice; admin marks it paid; ledger debit +
   receipt verified. A second request while one is open is rejected; cancelling an open request restores
   nothing and loses nothing (balance untouched).
7. Self-referral (same phone) rejected; duplicate referred phone under a second code rejected; a `lost`
   referral's phone CAN be referred again; an invalid status jump returns 409; a proposal confirm from
   `booked` succeeds as the privileged transition with skipped stages audited.
8. Every step above is visible in the audit log.

## 6. Test matrix (added by eng review 2026-08-14)

Greenfield: every planned path below must land with its test. Tooling per NFR-07 (vitest/Maestro/Playwright).

| # | Path | Kind | Covers |
|---|------|------|--------|
| 1 | OTP send: rate limits, channel mode, pre-send intent | vitest | FR-01/02/02a |
| 2 | OTP verify: attempt caps, expiry, no-enumeration | vitest | FR-02 |
| 3 | Hook delivery: WhatsApp failure webhook → fresh SMS code issued within window | vitest | FR-02a |
| 4 | Referral submit: consent, self-referral, duplicate phone, rate limit | vitest | FR-10/11 |
| 5 | Async existing-patient check: down → retry → retroactive flag | vitest | FR-11 |
| 6 | Transitions: adjacent-only, 409, privileged confirm jump, lost re-referral | vitest | FR-12 |
| 7 | Credit via confirm: rule resolution (practice > global, active_from) | vitest | FR-15/17 |
| 8 | Manual credit idempotency key (double-click) | vitest | FR-18 |
| 9 | Wallet concurrency: two simultaneous ops, advisory lock, balance ≥ 0 | vitest | NFR-09 |
| 10 | Payout create / cancel / expire / mark-paid; one-open constraint | vitest | FR-20/21/22 |
| 11 | Sync cursor: advance-on-success only; restart resumes | vitest | FR-16 |
| 12 | Sync eligibility: completed-after-submit only | vitest | FR-16 |
| 13 | Aging report: referral ≥ N days at booked/agreed with no proposal appears | vitest | FR-25 |
| 14 | Payout-ready notification: once per crossing episode, flag reset | vitest | FR-20 |
| 15 | Referrer onboarding: OTP login incl. sms_only mode | Maestro E2E | FR-01..05 |
| 16 | Scan QR → submit → referrer notified, admin sees `new` | Maestro E2E | FR-08..10 |
| 17 | Confirm proposal → wallet +£20 + notification | Maestro E2E | FR-17/19 |
| 18 | Threshold cross → request → mark paid → receipt | Maestro E2E | FR-20..22 |
| 19 | Code entry normalization (hyphens, lowercase, spaces) | Maestro | FR-07/09 |
| 20 | Invalid/inactive code UX; OTP-not-arriving 20s SMS offer | Maestro | FR-02a/09 |
| 21 | Admin queues: verification decide, proposal confirm/reject, payout cancel | Playwright | FR-25 |
| 22 | Levers: change amount/threshold, effective next confirm/request | Playwright | FR-15/20 |
| 23 | Double-tap submit / stale session interaction edges | Maestro | NFR-01 |
| 24 | Dentally down during signup → pending_review + auto-resolve on retry | vitest | FR-05 |
| 25 | Notification outbox: written in triggering transaction; drain survives restart; SMS fallback in sms_only mode | vitest | NFR-10 |
| 26 | Confirm blocked while existing_patient_suspect; one-credit-per-referral index; flag-after-credit → review list | vitest | FR-17 |

## 7. Compliance checklist (before launch)

- [ ] Accountant sign-off: tax treatment of cash commissions to patients; payout receipt wording.
- [ ] Solicitor pass: referral incentive claims vs CQC/GDC advertising rules; terms page for the scheme
      (qualifying conditions, expiry, clawback on refund); **UK GDPR Article 9 lawful basis** for health-data
      processing and disclosure of treatment milestones to the referrer (outside voice, 2026-08-14).
- [ ] Cash-operations runbook per practice (float, who authorizes, ledger-vs-till reconciliation,
      unannounced walk-in collection), written and stored in `docs/runbooks/` before first payout.
- [ ] Privacy policy URL live (required by both stores); App Privacy / Data Safety forms completed.
- [ ] Consent wording versioned and stored with every referral AND with referrer notification opt-in.
- [ ] DPAs in place: Supabase, Meta WhatsApp, hosting provider, SMS fallback provider.
