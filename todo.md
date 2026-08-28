# todo.md — GM Referral: gap audit + work list

Audit date: 2026-08-28 (for work starting 2026-08-29). Companion to `TODOS.md` (external waits / parked
decisions) and `docs/REQUIREMENTS.md` (numbered FRs). This file is the concrete build list.

Legend: **P0** = do before anyone real uses the deployed API · **P1** = this week · **P2** = next.

---

## 0. What is already built (and where)

| Area | Status | Where |
|---|---|---|
| Phone + OTP login (dev delivery only: code printed to console + returned as `devHint`) | ✅ policy, ❌ delivery | `apps/api/src/services/otpService.js`, `app.js:100-108` |
| Profile + role picker + referral code generation | ✅ | `services/userService.js` |
| Referrer verification vs Dentally patient index (auto + admin queue) | ✅ | `services/dentally/syncService.js:299-317`, `proposalService.js:123-156`, admin `VerificationQueue.jsx` |
| Referral submit: self-referral block, first-code-wins, consent version | ✅ | `services/referralService.js:10-61` |
| Pipeline transitions + audit events | ⚠️ partial (see §2) | `referralService.js:64-111`, `app.js:204-213` |
| Dentally sync → booked detection + completion proposals (idempotent, cursor, advisory lock) | ✅ | `services/dentally/syncService.js` |
| **Confirm-completions queue (the “verify before commission” gate for Dentally-detected treatments)** | ✅ | `proposalService.js:31-107`, admin `ConfirmQueue.jsx` |
| Wallet ledger + per-user advisory lock + one-credit-per-referral index | ✅ | `services/walletService.js`, `db.js:67-80`, migration `0001` |
| Payout request / mark-paid / cancel | ⚠️ race bug (see §5) | `walletService.js:119-184` |
| Admin: liability stat, pipeline board, referral record (searchable), payout queue, verification queue, existing-patient review, aging report, funnel + tripwire, top referrers, reward levers, Dentally card | ✅ | `apps/admin/src/components/*` |
| Admin roles + practice scoping (`admin_users`) | ⚠️ inconsistent (see §3) | `middleware/auth.js`, `app.js:63-64` |
| Session revocation endpoint | ✅ API, ❌ no UI | `app.js:412-420` |
| Notification outbox (written in-tx) | ✅ rows, ❌ sender is `console.log` | `server.js:17-30` |
| Daily digest | ✅ (to outbox → console) | `services/digestService.js` |
| Mobile: referrer tabs (card/QR, referrals, wallet), referred flow (code → booking form → status), booking links | ✅ | `apps/mobile/src/screens/*` |

**Not built at all** (each has a task below): email auth, any real OTP/notification delivery, FR-11 async
existing-patient flag (nothing ever *sets* `existing_patient_suspect`, so that queue is always empty),
payout expiry, payout-ready notification, manual adjustments/void, per-practice earned/paid report,
audit-log viewer, admin user management UI, CSV exports, rate limiting by IP, ledger immutability
triggers, reconciliation job, error monitoring, CI tests.

---

## 1. P0 — Security blockers on the deployed API (do first, ~half a day)

The Railway API is connected to the real Supabase DB + Dental OS, but runs as **development**:

- [ ] **`Dockerfile.api` sets `ENV NODE_ENV=development`.** Change to `production` and set `NODE_ENV`
      explicitly in Railway. In dev mode today:
  - [ ] `requireAdmin` falls back to **owner for any signed-in user** (`middleware/auth.js:41-44`) →
        any patient with the app can call `/admin/*` (mark payouts paid, change commission, credit referrals).
  - [ ] `/auth/otp/send` returns the OTP in `devHint` (`otpService.js:36`) → anyone can sign in as **any**
        phone number, including admin accounts. Also logs the code (`otpService.js:34`).
  - [ ] `/dev/dentally/*` stub endpoints are mounted (`app.js:451-485`).
  - [ ] `/webhooks/dentally` accepts unsigned calls when no secret is set (`app.js:77-79`).
- [ ] **Verify `API_JWT_SECRET` is set on Railway.** Default is `'dev-only-secret-change-me'`
      (`config.js:9`) — if unset, anyone can mint admin tokens. Make the API **refuse to boot** in
      production without it (and without `DATABASE_URL`).
- [ ] Add a startup guard: `if (!isDev && (!process.env.API_JWT_SECRET || config.otpChannelMode === 'dev')) throw`.
- [ ] Until email OTP ships (§4), production login is impossible without `devHint` → either keep the
      API private (Railway private networking / IP allowlist) or gate `devHint` behind an explicit
      `OTP_DEV_HINT=1` env that is never set in prod.
- [ ] Error handler leaks raw error text (incl. Postgres messages) for 5xx (`app.js:489-493`): return
      `{error:'internal'}` for status ≥ 500; keep codes for 4xx.
- [ ] `app.use(cors())` is wide open (`app.js:68`) — restrict `origin` to the admin URL(s) + allow
      no-origin (mobile).
- [ ] Rotate anything that may have leaked while dev mode was live (JWT secret, webhook secret).

---

## 2. Manager verification before commission (the ask: “check treatment is completed before paying”)

**Built today:** the *Dentally* path — sync creates a `completion_proposal` only when Dental OS shows a
completed appointment **and** a paid invoice, admin sees invoice state + matched phone + treating
practice and clicks **Confirm — credit referrer** (`ConfirmQueue.jsx`, `proposalService.js:31-107`).
That is the verification gate and it works.

**Not built / bypassable:** the *manual* path. From the Pipeline board an admin can pick **Completed**
on any referral (even `new`) and it credits **immediately, with no reason, no evidence, no confirm
step**, because `PATCH /admin/referrals/:id/status` always passes `privilegedComplete: true`
(`app.js:204-213`). This violates FR-12 (adjacent-only) and FR-18 (reason + chosen practice + idempotency key).

- [ ] **API:** split completion out of the generic status PATCH.
  - [ ] `PATCH /admin/referrals/:id/status` → adjacent-only, `treatment_completed` **not allowed** here.
  - [ ] New `POST /admin/referrals/:id/complete-manually` body `{ reason (required, ≥10 chars),
        practiceId (required), idempotencyKey (client uuid), evidence? }` → runs referral→completed +
        credit in **one transaction** under the wallet lock (today `updateStatus` flips status, then
        credits in a *separate* transaction — if the credit fails the referral is stuck “completed, due”).
  - [ ] Owner-only? Decide: manual completion = `owner`, or `admin` with a second admin’s confirmation.
        Recommend: `admin` may complete, but a **different** admin must confirm if amount > £X — or
        simply owner-only for MVP (`requireOwner` already exists, unused).
- [ ] **Verification helper:** `GET /admin/referrals/:id/dentally-check` → looks up the referred
      phone/email in Dental OS (`dentalOsClient.getPatient` + `listAppointments` + `listInvoices`) and
      returns: patient found?, last completed appointment date, paid invoices (date, amount), treating
      site. Show this in the manual-complete dialog so the manager *sees* the treatment evidence before
      clicking. Also show it on each proposal row (expand → evidence).
- [ ] **Admin UI:** replace the `select` jump with a **“Mark treatment completed…”** button → modal:
      Dentally evidence panel, practice picker, reason field, big “Credit £20 to {referrer}” confirm.
      Disable while `review_status='existing_patient_suspect'`.
- [ ] **Aging report → manual path** link: each aging row gets the same “Verify & complete” button.
- [ ] **Rejected/void:** owner-only `POST /admin/wallet/:userId/adjust` `{ amountPennies (±),
      reason, referralId? }` writing an `adjustment` ledger row under the lock, balance ≥ 0 asserted
      (FR-17 “void via reasoned adjustment”; also clawback on refund later).
- [ ] Tests: manual complete requires reason+practice; double-click (same idempotency key) credits once;
      status PATCH to completed now 409s; complete is atomic (force credit failure → status unchanged).

---

## 3. Admin dashboard — “conversions, payouts, referrals, everything”

### 3a. Correctness / scoping gaps in what exists
- [x] **Manager role + payouts-only ManagerPage** — DONE 2026-08-28 (`feat/practice-payouts`): `admin_users.role='manager'` (one practice), `GET /admin/me`, managers fenced to `/admin/me` + `/admin/payouts*`, mark-paid/cancel 403 outside their practice, payout rows show phone/code/unpaid credits, **typed amount must match** (Q25). Seed with `node apps/api/scripts/grant-admin.js <phone> <email> manager <practiceId>`.
- [ ] Practice scoping is applied only to `/admin/referrals`, `/admin/payouts`, `/admin/referral-review`.
      **Unscoped:** `/admin/proposals`, `/admin/verifications`, `/admin/aging`, `/admin/stats`,
      `/admin/reports/*`. A practice-scoped admin sees every practice’s data. Scope them all (owner = all).
- [ ] `requireOwner` is never used. Make owner-only: `PUT /admin/reward-amount`, `PUT /admin/settings`,
      adjustments, exports, admin-user management, session revoke.
- [ ] `PUT /admin/settings` accepts any string (`app.js:246-259`). `payout_threshold_pennies='abc'` →
      `Number()` = NaN → `balance < NaN` is false → **payout allowed at any balance**. Validate with zod
      (positive ints; `otp_channel_mode` enum).
- [ ] Pipeline board hides `lost_reason` (FLOWS §6 says show it). Show reason chip on lost rows.
- [ ] Dashboard loads once (`App.jsx loadAll`) — 4 front desks will act on stale queues. Poll every
      30s while the tab is visible (or SSE later). Re-check `status='open'` server-side on every action
      (already done for proposals; add for payouts — see §5).
- [ ] `ConfirmQueue` uses `window.prompt` for reject reason — replace with inline field (consistency +
      testability).
- [ ] `/admin/referrals` returns everything, no pagination/filters. Add `?status=&practiceId=&from=&to=&q=&page=`.

### 3b. Missing surfaces
- [ ] **Conversions report** (`GET /admin/reports/conversions?from&to&practiceId`): per practice and per
      month — submitted → booked → attended → completed → credited → paid, with rates between steps and
      median days between stages (from `events`). Feeds a table + small bar chart on Reports page.
- [ ] **Payout report** (FR-23): total paid out (date range), **paid out per practice** (debits by
      collecting practice), **earned per practice** (credits by attributed practice), open requests
      ageing (days waiting), average request→paid latency. Endpoint `/admin/reports/liability` returns
      total + both per-practice breakdowns.
- [ ] **Referral detail drawer**: click any referral → full record + **audit timeline** (from `events`),
      proposals for it, ledger rows, notifications sent, Dentally evidence panel (§2), actions
      (status, manual complete, mark lost, flag/clear review).
- [ ] **Member (referrer) directory**: list referrers with verification status, code, balance (sum),
      lifetime earned, referrals count, last activity; row actions: deactivate code (FR-07 fraud),
      revoke sessions (endpoint exists `app.js:412`), re-link Dentally id, view ledger, adjustment (owner).
- [ ] **Audit log page** (owner): filterable `events` table (actor, entity, action, date range) — the
      acceptance demo item 8 (“every step visible in the audit log”) has no UI today.
- [ ] **Admin users management** (owner): list/add/deactivate admins, set role + practices — today only
      `apps/api/scripts/grant-admin.js`. Becomes email-based after §4.
- [ ] **Reward rules** (FR-15): per-practice rules, `active_from` date, overlap rejection on save,
      history table. Today only a global “insert new rule now” (`app.js:278-286`).
- [ ] **Levers**: add `otp_channel_mode`/`email` toggles, referral booking window hours (currently env
      only: `REFERRAL_BOOKING_WINDOW_HOURS`), aging-report days.
- [ ] **System health card** (pull forward from Phase 2 — this system moves cash): last sync time +
      result, Dental OS reachable?, outbox queued/failed counts, last digest date, DB region.
- [ ] **Notifications log**: outbox rows per user with status/attempts (support questions “did they
      get the message?”).
- [ ] **CSV exports** (owner): ledger, payouts, referrals by date range (`FR-26`; trivial once reports exist).
- [ ] **Existing-patient review queue is dead** until FR-11 is implemented (§6) — today nothing sets the flag.

---

## 4. Email auth (decision 2026-08-22: email replaces WhatsApp for OTP + reminders)

Design first (30 min), then build. Two distinct audiences:

### 4a. Admin dashboard — email OTP / magic link
- [x] **SUPERSEDED 2026-08-29:** dashboard uses **email + password** (decision 2026-08-29): `admin_users` is its own identity table (migration 0011), roles `admin` | `manager`, admins create/deactivate/re-scope accounts and set passwords from the Team card, everyone changes their own password; scrypt, per-email+IP + per-IP login limits, 12h admin JWT, boot guard for `API_JWT_SECRET`. No email sending needed for dashboard auth. First admin: `railway run --service api node apps/api/scripts/create-admin.js <email> <password>`.
- [ ] `admin_users` becomes email-keyed: `id uuid pk, email unique, role, practice_ids, active,
      last_login_at` (drop `user_id → users` FK; admins are not patients). Migration `0010`.
- [ ] `POST /auth/admin/otp/send {email}` → only if an active `admin_users` row exists (generic 200
      either way); 6-digit code hashed into `otp_deliveries` (channel `email`) or a signed magic link
      (15 min). `POST /auth/admin/otp/verify` → admin JWT `{ sub: adminId, role, kind:'admin' }`.
- [ ] `requireAdmin` reads `kind:'admin'` tokens; **remove the dev owner fallback** or gate it behind
      `ADMIN_DEV_OPEN=1`.
- [ ] `SignIn.jsx` → email field; keep phone sign-in out of the admin app entirely.
- [ ] Invite flow: owner adds an email → invite email with magic link.

### 4b. Patient app — decide identity model (needs your call, options ranked)
Phone is the Dentally matching key, so phone must still be captured; the question is what proves ownership.
1. **Recommended:** sign in with **email OTP**; capture phone in profile; referrer verification requires
   **both** email *and* phone to match the **same** Dental OS contact (contacts have `email` + `phone`).
   No SMS provider needed; spoofing someone’s phone alone no longer verifies.
2. Phone sign-in with OTP by **SMS** (needs a provider, e.g. Twilio/Vonage) — keeps FR-01 as written.
3. Email OTP + SMS fallback (both providers) — most robust, most work.
- [ ] Add `users.email unique`, `users.email_verified_at`, `users.phone_verified_at`.
- [ ] Referred-friend form already collects email → store on `users` too.

### 4c. Shared plumbing
- [ ] Pick provider: **Resend** or **Postmark** (UK-fine, DKIM/SPF, webhooks for bounces). Env:
      `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`. Verify domain + set up DKIM/SPF/DMARC.
- [ ] `services/emailService.js` with `sendOtp`, `sendTemplate(template, to, payload)`; retry with
      backoff; bounce webhook → mark `notification_outbox` failed.
- [ ] Outbox drain becomes the real sender: **mark `sent` only after provider success**, `attempts++`
      and backoff on failure, `failed` after N, `FOR UPDATE SKIP LOCKED` (see §5). Respect
      `users.notify_opt_in` for utility templates (today never checked — `server.js:17-30`).
- [ ] Templates (HTML + text, versioned): otp, friend_used_code, friend_booked, friend_completed,
      wallet_credit, payout_ready, payout_receipt, payout_cancelled, verification_approved/rejected,
      new_inquiry (practice), daily_digest (practice).
- [ ] OTP hygiene: per-email + per-IP send limits; `otp_deliveries` TTL cleanup job (NFR-01 — rows never
      deleted today); constant-time compare.
- [ ] Sessions: keep 90-day JWT for now, but add `POST /auth/logout` that stamps a per-token jti into a
      `revoked_tokens` table (or move to access 1h + refresh 90d rotated — see §7).

---

## 5. DB locks, transactions, integrity — bugs found

- [x] **Mark-paid vs cancel race** — DONE 2026-08-28 on `feat/practice-payouts` (both under `withWalletLock` + `for update` + `and status='open'`; interleaved race test is `skipIf(!DATABASE_URL)`). Original note: (`walletService.js:138-165` + `167-184`): `markPayoutPaid` reads the
      payout *outside* the lock, then inside the lock does `update … set status='paid' where id=$1`
      **without `and status='open'`**; `cancelPayout` runs without the lock. Interleaving → a cancelled
      payout gets marked paid and a **debit is written for cash never collected**. Fix: do the read +
      `update … where id=$1 and status='open' returning *` inside `withWalletLock`; put `cancelPayout`
      under the same lock; add a concurrency test.
- [ ] **`updateStatus` is not atomic** (`referralService.js:86-109`): status update, outbox, and credit
      are separate statements/transactions. Wrap in one `withWalletLock(referrer_id)` transaction (or
      remove crediting from it per §2).
- [ ] **Outbox drain has no `FOR UPDATE SKIP LOCKED`** (`server.js:20-22`) → a second replica double-sends.
      Also marks `sent` *before* sending. Fix with §4c.
- [ ] **Ledger/events immutability** is not enforced in the DB (REQUIREMENTS §3 says no UPDATE/DELETE).
      Migration: `create trigger … before update or delete on wallet_ledger/events … raise exception`.
- [ ] **Sign checks by kind**: `check ((kind='credit' and amount_pennies>0) or (kind='debit' and
      amount_pennies<0) or kind='adjustment')` on `wallet_ledger`.
- [ ] **Advisory locks need the Supabase *session* pooler** (port 5432 pooler host, as in `.env`).
      Session-level `pg_try_advisory_lock` in `runSync` breaks silently on the transaction pooler (6543).
      Document in README + assert at boot (`show pool_mode` isn’t visible; at least log the host/port).
- [ ] **Pool hygiene** (`db.js:17`): add `pool.on('error', …)` (an idle-client error currently crashes
      the process), `statement_timeout` (e.g. 15s), `idleTimeoutMillis`, `connectionTimeoutMillis`.
- [ ] **Missing indexes**: `events(entity_type, entity_id, created_at)` (aging report runs two correlated
      subqueries per referral), `referrals(status, created_at)` (12h expiry scan runs on every
      `/referrals/referred-status` GET), `users(verification_status) where role_referrer`,
      `notification_outbox(status, created_at)`, `wallet_ledger(referral_id)` (register join).
- [ ] **Writes on GET**: `referredStatusFor` calls `expireUnbookedReferrals()` on every poll
      (`referralService.js:158`) — move to the sync/cron only.
- [ ] **12h booking window** auto-marks referrals `lost` when no Dentally appointment appears
      (`config.js:13`, `referralService.js:137-155`). Edge cases to decide: friend books **by phone**
      (front desk must set `booked` manually within 12h or it’s lost); Dental OS lag; portal geo-403
      (TODOS). Consider 48–72h, exclude `contacted`, notify referrer on expiry, and make it a lever.
- [ ] **Payout expiry** (FR-21, `payout_expiry_days`) — never enforced; add to the cron: open requests
      older than N days → `expired` + notification.
- [ ] **Payout-ready notification** (FR-20) — flag is cleared on mark-paid but never set/fired; fire on
      credit when balance ≥ threshold, no open request, flag clear.
- [ ] **Referral code collision retry** swallows all errors 5× (`userService.js:69-76`) — only retry on
      unique-violation.
- [ ] **Reconciliation job** (nightly + admin button): referrals `treatment_completed` with no credit;
      proposals `confirmed` with no credit; credits with no completed referral; balances < 0; open
      payouts > expiry; users with >1 active code. Surface on the health card, alert on non-zero.
- [ ] **Concurrency test suite** is a placeholder (`api.test.js:307-311`). Write the real ones against
      `DATABASE_URL`: two simultaneous payout requests, mark-paid vs cancel, two confirms of proposals
      for the same referral, two manual completes with different keys → exactly one credit.
- [ ] Supabase project is in **ap-southeast-2 (Sydney)** — recreate in **eu-west-2 (London)** before
      real patient data (latency on every request + UK GDPR residency). Still holds test data only?
      Confirm, then move (TODOS.md).

---

## 6. Fraud / edge cases not yet covered

- [ ] **FR-11 async existing-patient check is unimplemented** — nothing sets
      `review_status='existing_patient_suspect'`. Add to `submitReferral` (post-commit) and to the
      sync pass: if `referred_phone`/`referred_email` matches a `dentally_patient_index` row whose
      patient existed **before** the referral (or has any appointment before `created_at`), flag it.
      Retroactive flag after credit → surface in review list (FR-17).
- [ ] Referred phone override (`submitReferral` accepts any `phone`) → a user could submit a referral
      for someone else’s number or a made-up number. Mitigate: existing-patient check above + require
      the referred user to verify that phone/email (ties to §4b) + per-account submit limit (1 open
      referral per referred account).
- [ ] Referrer self-collusion: referrer A refers friend B who is actually A with a second email —
      caught by Dentally patient identity (same patient id as referrer) → add check: proposal’s Dentally
      patient id == referrer’s `dentally_patient_id` → reject + flag.
- [ ] Rate limits by **IP** and per account: `/auth/*` (5/min/IP), `/referrals` (3/day/account),
      `/events` (60/min), `/payouts`. Use `express-rate-limit` with a Postgres or in-memory store
      (single instance) — the OTP per-phone limit exists, IP limit does not.
- [ ] Refund / clawback: Dental OS `invoices` likely carry refunds/credit notes — investigate columns;
      if visible, sync creates a **clawback proposal** → owner confirms → `adjustment` debit (needs §2 adjust endpoint).
- [x] Mobile payout picks `practices[0]` — DONE 2026-08-28: "Where will you collect?" picker (FR-21).
- [x] Mobile “cancel my payout request” — DONE 2026-08-28 (and `DELETE /payouts/:id` now checks ownership).
- [ ] Mobile card screen shows a hard-coded fallback code `GMRF7K2X` when `referralCode` is null
      (`referrer.js:25,660`) — show “pending” instead; a rejected referrer must see a clear “not eligible” state.
- [ ] `expo-updates` runtime: sign-out only clears the local token; the 90-day JWT stays valid (§4c logout).
- [x] Uncommitted wallet redesign in `apps/mobile/src/screens/referrer.js` — committed 2026-08-28 (2b7ec6e).

---

## 7. Security hardening (beyond §1)

- [ ] **Revocation compare fail-closed** (from 2026-08-29 review): `tokenRevoked` uses `iatMs < revokedMs`; make it `<=` and have the two re-issue paths (`setPassword` on self, `changeOwnPassword`) mint `iatMs = revokedAtMs + 1`; or write `sessions_revoked_at = greatest(now(), to_timestamp($js_now/1000.0))` and use `clock_timestamp()` inside `setActive`'s transaction. Also: 5xx masking hides the two actionable Dentally 502 codes (`dentally_token_*`) — special-case them; TeamCard practice select when the manager's current practice is inactive; `requireAdmin`'s bare catch turns DB errors into 401 (log them). Test infra: cap `poolOptions.forks.maxForks` in `apps/api/vitest.config.js` if CI flakes under parallel PGlite + scrypt.
- [ ] Param validation on every `:id` route (uuid) — today a bad id becomes a Postgres 22P02 → 500 + leaked message.
- [ ] `helmet()` on the API; Caddy security headers + CSP on the admin (`apps/admin/Caddyfile`).
- [ ] Structured logging (pino) with request ids; **no PII in logs** (`[otp] phone → code`,
      `[notify]` payload dumps today). Log levels by env.
- [ ] **Sentry** (or equivalent) on API + admin + mobile — DESIGN lists it as day-one; nothing wired.
- [ ] Least-privilege DB role: confirm Railway `DATABASE_URL` uses `gm_referral_api`, not `postgres`.
      With RLS enabled and no policies, a non-owner role is blocked — so today it is probably the
      owner/superuser. Either grant `bypassrls` to the API role or add `api_rw` policies per table
      (pattern already in migration `0005`).
- [ ] Secrets: rotate `DENTALLY_WEBHOOK_SECRET`/`API_JWT_SECRET` after §1; move `.env` values to a
      password manager; never paste connection strings into chat/docs.
- [ ] Admin token in `localStorage` → acceptable for MVP behind CSP; plan httpOnly cookie + CSRF later.
- [ ] Dependency audit in CI (`npm audit --omit=dev`, Dependabot).
- [ ] CI runs **no tests** (`.github/workflows/deploy.yml` deploys only, and the token is broken —
      TODOS). Add `test` job (shared + api + admin) that gates deploy; fix `RAILWAY_TOKEN`.
- [ ] Backups: enable Supabase PITR; write + test a restore runbook (`docs/runbooks/` is empty).

---

## 8. System design — recommendations for this class of app (referral + wallet, 6 practices, ~20k patients)

Scale is small (hundreds of referrals/month). Optimise for **money correctness, auditability, and
front-desk trust**, not throughput. Concrete changes vs. today:

- [ ] **Single writer, explicit workers.** Keep one API replica (Railway `replicas=1`, document it) and
      move the three `setInterval` loops (`server.js`) into `src/workers/` with a `--worker` flag so they
      can run as a separate Railway service later. Every worker takes a DB advisory lock (sync already does).
- [ ] **Sessions:** short-lived access token (1h) + refresh token (90d, hashed in `sessions` table,
      rotated on use, per-device) → server-side logout, revoke-one-device, and “months without
      re-login” all at once. Replaces the 90-day bearer JWT.
- [ ] **Money invariants in the database, not only in code:** immutability triggers, sign checks,
      partial unique indexes (have), and a nightly reconciliation (§5). Treat the ledger as the source
      of truth; every screen derives from it.
- [ ] **Idempotency everywhere on admin POSTs:** `Idempotency-Key` header stored in an
      `idempotency_keys(key, response, created_at)` table (24h TTL) — double-clicks and retries on
      flaky front-desk Wi-Fi never double-act. Proposal confirm already has a status guard; generalise.
- [ ] **Outbox → real delivery** with retry/backoff/dead-letter and a visible failed count; email now,
      SMS later behind the same interface (`channel_resolved`).
- [ ] **Read models for the dashboard:** one `GET /admin/overview` (counts + liability + health) polled
      every 30s, plus paginated list endpoints with filters. Keep Postgres; add materialised views
      only if reports get slow (they won’t at this size).
- [ ] **Practice as a first-class tenant:** every admin query scoped by `practice_ids` through one
      helper (`scopeSql(req)`), owner bypass explicit. Add `practice_id` to `events` for scoped audit.
- [ ] **Observability:** Sentry + structured logs + 3 alerts (sync failed twice in a row, outbox
      failed > 0, any 5xx on `/admin/payouts/*` or `/admin/proposals/*`).
- [ ] **Data lifecycle:** `otp_deliveries` TTL 24h, `analytics_events` 13 months, outbox archive
      90 days; SAR export/anonymise runbook (TODOS) — pseudonymise `users`, keep ledger/events.
- [ ] **Environments:** staging vs production Supabase projects (today one shared DB for local dev,
      Railway, and the phone app — a local test run can touch “production” rows). Split before real patients.
- [ ] **Region:** London for Supabase (and Railway EU region if available).
- [ ] **Docs:** `docs/runbooks/` — cash-ops per practice, SAR, restore, “sync stopped” playbook,
      “payout marked paid by mistake” playbook (owner adjustment + audit note).

---

## 9. Tests to add alongside the above

- [ ] Manual completion: reason/practice required, atomic, idempotent, 409 from status PATCH.
- [ ] Mark-paid vs cancel race; two payout requests; two proposal confirms (real Postgres).
- [ ] FR-11 flag set on submit and retroactively; confirm blocked while flagged.
- [ ] Settings validation rejects non-numeric thresholds.
- [ ] Practice scoping on every admin endpoint (owner sees all, admin sees own).
- [ ] Email OTP: send/verify/limits/no-enumeration; admin login by email; dev fallback disabled in prod.
- [ ] Outbox: sent only after provider success; retry count; skip-locked under two drains.
- [ ] Payout expiry + payout-ready notification episodes (matrix rows 10, 14).
- [ ] Startup guard: boots refuse without `API_JWT_SECRET` in production.

---

## 10. Questions that need answers (blocking or shaping the work above)

Answer inline (edit this file) — "default" means accept the suggested default. Items marked ⛔ block a task.
**2026-08-29: Q3 superseded — admin login is email + password (no OTP), admins create managers.** 2026-08-28: Q1–Q5, Q7, Q9, Q10, Q12, Q14, Q15, Q16, Q21 answered by Ruhith (Answer column). Still open: Q6, Q8, Q11, Q13, Q17–Q20 (defaults stand unless changed), all of 10b–10d.**

### 10a. Ruhith — product / technical decisions

| # | Question | Blocks | Suggested default | Answer (2026-08-28) |
|---|---|---|---|---|
| Q1 ⛔ | **Are real patients or staff using the deployed app/API today?** (Decides how urgent §1 is and whether secrets must be rotated.) | §1 | Assume yes → do §1 first thing, rotate `API_JWT_SECRET` + `DENTALLY_WEBHOOK_SECRET`. | **No — test data only.** Still do §1 first; no emergency rotation or misuse audit needed. |
| Q2 ⛔ | **Patient identity model for email auth** (§4b): (1) email OTP sign-in + phone captured, verification needs phone **and** email to match one Dental OS contact; (2) phone sign-in with SMS OTP (needs SMS provider); (3) both. | §4b, §6 | Option 1. | **Option 1** — email OTP sign-in, phone captured in profile, verification requires email *and* phone to match one Dental OS contact. |
| Q3 ⛔ | **Admin login style**: 6-digit code by email, or magic link? | §4a | 6-digit code (works when the mail client opens on a different device than the dashboard). | **6-digit code by email.** |
| Q4 ⛔ | **Email provider + sending domain**: Resend or Postmark? Send from `noreply@gmdental.co.uk` (or which domain)? Who can add DNS records (DKIM/SPF/DMARC)? | §4c | Resend; a `gmdental` subdomain like `mail.gmdental.co.uk` so DNS changes don't touch the main domain. | **Resend**, send from `mail.gmdental.co.uk`. Ruhith adds the DNS records. |
| Q5 ⛔ | **Who may manually mark a treatment completed and credit** (§2): owner only; any admin; or admin + a second admin's confirmation? | §2 | Owner only at MVP; admins use the Dentally proposal queue. Revisit once volume justifies it. | **Owner only.** Admins use the Dentally proposal queue. |
| Q6 | **Dentally evidence panel**: is "completed appointment + paid invoice in Dental OS" the *required* evidence for a manual completion, or may a manager complete with a written reason alone (e.g. paid by finance plan, Dental OS lagging)? | §2 | Reason alone allowed **only for owner**, and the record is flagged "no Dentally evidence" on the register. | — |
| Q7 | **12h booking window** (§5): keep 12h? Should `contacted` referrals be exempt (front desk is working it)? Notify the referrer when a referral expires? | §5 | 48h, exempt `contacted`, notify referrer, make it a dashboard lever. | **48h**, exempt `contacted`, notify referrer on expiry, expose as a dashboard lever. |
| Q8 | **Referred phone override**: the friend can type any phone. Require it to be verified (OTP), or rely on the FR-11 existing-patient check + Dentally identity checks? | §6 | Rely on checks at MVP; verify phone only if fraud appears. | — |
| Q9 | **Session model now or later**: keep 90-day JWT + logout blacklist (small), or build access/refresh rotation now (§8)? | §4c, §8 | Blacklist now; refresh tokens after launch. | **Blacklist now** (`revoked_tokens` + jti); refresh tokens after launch. |
| Q10 | **Staging vs production split**: confirm the Supabase project holds only test data; OK to recreate it in **London** and to create a separate staging project? When? | §5, §8 | Yes, before the first real referral; this week. | **Leave as is for now** (Sydney, single shared DB). Revisit before real patients. |
| Q11 | **Railway topology**: OK to pin the API to **1 replica** (advisory locks + in-process workers assume it)? Or split workers into their own service now? | §8 | 1 replica now; worker service later. | — |
| Q12 | **API exposure until email OTP ships**: keep the API publicly reachable with `devHint` gated by env (nobody can log in), or leave dev mode on but restrict by Railway private networking / IP allowlist? | §1 | Gate `devHint` behind `OTP_DEV_HINT=1`, never set in prod; accept no logins until §4 lands. | **Gate `devHint` behind `OTP_DEV_HINT=1`**; accept no prod logins until §4 lands. |
| Q13 | **Admin users**: list of admin/owner **emails** and which practices each covers (needed to seed `admin_users` for email login). | §3b, §4a | — | — |
| Q14 | **Practice inquiry contacts**: `practices.inquiry_email` / `inquiry_phone` are empty — which email per practice receives `new_inquiry` and the daily digest? | §4c | — | **No practice emails.** Inquiries/digest are shown on the dashboard instead; `new_inquiry`/`daily_digest` templates dropped. |
| Q15 | **Which notifications go out by email at launch?** OTP only, or also friend_used_code / booked / credit / payout_ready / receipt? (Memory says "reminders later phase".) | §4c | OTP + wallet_credit + payout_receipt + practice new_inquiry/digest at launch; the rest phase 2. | **OTP + wallet_credit + payout_receipt** at launch (practice emails dropped per Q14); rest phase 2. |
| Q16 | **Dashboard must-haves for launch** vs later (§3b): conversions report, per-practice payout report, referral drawer + audit timeline, member directory, audit log page, admin-user management, system health, CSV exports — rank them. | §3b | Order as listed in §3b; exports last. | **Must-haves:** conversions report, payout report, referral drawer + audit timeline, member directory + admin user mgmt. Audit log page, health card, notifications log, CSV exports → after. |
| Q17 | **Referral register PII**: every admin (all practices) can see referred friends' phone + email. Acceptable, or mask for non-owner / other-practice admins? | §3a | Mask to last 3 digits for admins outside the referral's practice. | — |
| Q18 | **Rate-limit numbers**: OTP 5/min/IP, referrals 3/day/account, events 60/min — fine? | §6 | Yes. | — |
| Q19 | **Data retention**: OTP rows 24h, analytics 13 months, outbox 90 days, audit `events` forever? | §8 | Yes. | — |
| Q20 | **Aging report** default (7 days) and payout expiry default (14 days) — confirm. | §3b, §5 | Keep. | — |
| Q21 | The uncommitted wallet redesign in `apps/mobile/src/screens/referrer.js` — finish it, or stash and commit later? | §6 | Finish (it's mostly done) and commit with the mobile fixes. | **Finish and commit** with the §6 mobile fixes. |

### 10b. GM Dental principal — business rules

| # | Question | Blocks | Suggested default |
|---|---|---|---|
| Q22 | **Clawback on refund**: if a referred treatment is refunded after the commission is paid, do we claw back (owner adjustment) or absorb? Is a refund visible in Dental OS `invoices`? (DESIGN open Q5) | §2 adjust, §6 | Absorb at MVP; owner adjustment tool exists for manual clawback. |
| Q23 | **Referred-friend incentive wording** (free consultation + 5% off?) — finalises share message, booking form promise line, terms. (DESIGN open Q3) | mobile copy, terms | — |
| Q24 | **Per-practice commission or thresholds** at launch, or one global rule? (Affects how much of the rules UI to build now.) | §3b rules | Global only; keep the per-practice data model. |
| Q25 | **Who authorises cash at reception** — does the front desk need the referrer's **name + phone + code** on the payout row (identity check), and should marking paid require typing the amount handed over? | §3b payouts | Show name/phone/code; require typing the amount. |
| Q26 | **Commission expiry** — does an unclaimed balance ever expire? | §5 | No expiry. |
| Q27 | **GHL push at MVP** or Phase 2? (DESIGN open Q4) | scope | Phase 2. |
| Q28 | **Booking by phone**: if a friend calls the practice instead of using the portal, is the front desk expected to set `booked` in the dashboard (otherwise the 12h/48h window loses the referral)? | §5, runbook | Yes — document in the cash-ops/front-desk runbook. |

### 10c. Accountant / solicitor (carried from TODOS.md, still open)

| # | Question | Blocks |
|---|---|---|
| Q29 | Tax treatment of cash commissions to patients; receipt wording. | payout receipt template, terms |
| Q30 | Incentive claims vs CQC/GDC advertising rules; UK GDPR Article 9 basis for health-data disclosure to referrers; consent wording version 2. | consent text, launch |
| Q31 | DPAs: Supabase, Railway, email provider, Dental OS host. | launch |

### 10d. Dental OS owner (technical)

| # | Question | Blocks |
|---|---|---|
| Q32 | Do `invoices` rows expose refunds / credit notes (column names)? Do `contacts` reliably carry `email`? | Q22, §4b option 1 |
| Q33 | Can the `gmref_doorbell` trigger also fire on appointment insert/update (not only completed+paid) so bookings confirm instantly? (TODOS) | booking latency |
| Q34 | Is the `gm_referral_reader` role limited to the four tables, and is there a staging copy of Dental OS we can point staging at? | §8 environments |

---

## Suggested order for tomorrow (2026-08-29)

1. §1 all (prod hardening + startup guard) → redeploy.
2. §5 mark-paid race + atomic completion + immutability triggers + indexes (one migration `0010`).
3. §2 manual-complete endpoint + Dentally evidence check + admin modal.
4. §4a admin email OTP (Resend, 6-digit code) → §4b email OTP for patients (option 1).
5. §3a scoping/validation fixes, then §3b starting with conversions + payout reports and the referral drawer.
