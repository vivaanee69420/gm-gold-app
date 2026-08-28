# Practice-scoped payouts + manager role — implementation plan

Approved in chat 2026-08-28 (design, no separate spec). Branch `feat/practice-payouts` from `main`.

## Goal

GM Dental runs **4 practices** (Ashford, Barnet, Bexleyheath, Rochester) with **4 practice managers**.
A member chooses *where* they will collect cash when they request a payout. That request is visible
and payable **only** by that practice's manager (owner sees all). Managers get one simple screen in the
existing admin app; the owner keeps the full dashboard.

## Global Constraints (binding for every task)

- API error shape is `{ error: <code> }` via the existing error boundary (`err.status` + `err.message`).
  Codes used by this plan: `forbidden` (403), `payout_not_open` (409), `amount_mismatch` (409),
  `amount_required` (422).
- A `manager` may reach **only** `GET /admin/me` and `/admin/payouts*`. Every other `/admin/*` route
  returns 403 `forbidden` for a manager.
- `practiceScope(req)` applies to every non-owner role with practice ids (`admin` and `manager`);
  owners (and the dev fallback) see all.
- `POST /admin/payouts/:id/mark-paid` body `{ amountPennies }` must equal the request's
  `amount_pennies`; missing/non-positive-integer → 422 `amount_required`; different → 409 `amount_mismatch`.
- A manager acting on a payout whose `practice_id` is outside their scope → 403 `forbidden`, and the
  payout stays `open`.
- All payout mutations (request, mark-paid, cancel) run inside `withWalletLock(user_id)`; status flips
  use `where id=$1 and status='open'`.
- A member can cancel only their **own** open request (`DELETE /payouts/:id`); someone else's → 409 `payout_not_open`.
- Tests run on in-memory PGlite: `cd apps/api && npx vitest run <file>`. **Never set `DATABASE_URL`
  when running tests** (it points at the shared Supabase DB).
- Existing tests in `apps/api/test/*.test.js`, `apps/admin/test/*`, `packages/shared/test/*` must stay green.
- Commit per task. Commit message trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01Kwd8gF3Joda8Wy8JtGbS5G`.
- Do not deploy, do not touch Railway/Supabase, do not push.
- Keep UI as simple as possible: no new nav, no new pages beyond `ManagerPage`.

The API test file for Tasks 1–2 already exists (written test-first by the controller):
`apps/api/test/practice-payouts.test.js`. Run it with `-t "<describe name>"` to focus.

---

## Task 1: Migration, manager role, `/admin/me`, scoped + enriched payout list

**Files**
- Create `supabase/migrations/0010_manager_role.sql`
- Modify `apps/api/src/middleware/auth.js`
- Modify `apps/api/src/app.js` (`practiceScope`, new `/admin/me`, `/admin/payouts` query)
- Modify `apps/api/scripts/grant-admin.js`
- Tests (already written): `apps/api/test/practice-payouts.test.js` — describes `practices`,
  `GET /admin/me`, `manager payout list`, and the `is locked out of every other admin surface` case.

**Steps**
1. Run `npx vitest run test/practice-payouts.test.js` from `apps/api`. Confirm the describes above
   fail for the expected reasons (role check constraint rejects `'manager'`; `/admin/me` 404; five
   practices; missing fields). Paste the relevant failures into your report as RED evidence.
2. Migration `0010_manager_role.sql`:
   ```sql
   -- Practice managers: one practice each, payouts-only dashboard (2026-08-28 decision).
   alter table admin_users drop constraint admin_users_role_check;
   alter table admin_users add constraint admin_users_role_check check (role in ('admin','owner','manager'));
   -- Warwick Lodge is not a live GM Dental site; the scheme runs across four practices.
   update practices set active = false where name = 'Warwick Lodge';
   ```
   (Verify the constraint's actual name in PGlite/Postgres — inline check constraints on a column
   are auto-named `<table>_<column>_check`. If it differs, use `select conname from pg_constraint
   where conrelid='admin_users'::regclass` in a scratch test to find it, and write the migration
   so it works on both PGlite and Supabase.)
3. `auth.js` — in `requireAdmin`, after `req.admin` is set from the row: if `role === 'manager'` and
   `req.path` does not match `/^\/admin\/(me|payouts)(\/|$)/` → `403 { error: 'forbidden' }`.
   Keep the dev fallback exactly as is.
4. `app.js` — `practiceScope` becomes: non-owner with `practiceIds.length` → literal, else `null`.
5. `GET /admin/me` (requireUser, requireAdmin): `{ role, practices: [{ id, name }] }` — all active
   practices for owners / empty scope, otherwise only `where id = any(scope)`. Order by name.
6. `GET /admin/payouts` rows gain: `phone` (`users.phone`), `referral_code` (the member's active code
   — it lives in the `referral_codes` table; reuse the join `/me` / `userService` already uses),
   and `credits`: an array `[{ friend, amountPennies, at }]` of the member's **unpaid** credits —
   `wallet_ledger` rows with `kind='credit'` created after the member's most recent `paid` payout
   (all credits if none). `friend` = `firstNameInitial(referrals.referred_name)` (export exists in
   `services/referralService.js`), `at` = `created_at::date::text`. Do this as a second query keyed
   by user id (or a lateral/json_agg subquery) — either is fine; keep it readable.
7. `grant-admin.js`: accept `manager` in the role whitelist; usage line updated. A manager needs
   exactly one practice id — reject `manager` with 0 or >1 practices with a clear message.
8. Run the four describes → green. Run the whole api suite (`npx vitest run`) → green; the
   `admin_users practice scoping` test in `admin.test.js` must still pass.
9. Commit: `feat(api): manager role, /admin/me, practice-scoped payout list`.

---

## Task 2: mark-paid / cancel under the wallet lock — amount, practice, ownership guards

**Files**
- Modify `apps/api/src/services/walletService.js` (`markPayoutPaid`, `cancelPayout`)
- Modify `apps/api/src/app.js` (the two admin payout routes + `DELETE /payouts/:id`)
- Modify `apps/api/test/api.test.js` — the existing `mark-paid` call in
  `'payout below threshold is rejected; at threshold it works end to end'` must now send
  `{ amountPennies: 10000 }`.
- Tests (already written): `apps/api/test/practice-payouts.test.js` — describes
  `manager is fenced to their practice` (mark-paid + cancel cases), `mark paid = type the cash
  handed over`, `member cancel`. The `race` describe is skipped without `DATABASE_URL` — leave it.

**Steps**
1. Run the three describes; confirm RED for the expected reasons (no amount check, no scope check,
   ownership not checked). Paste into report.
2. `markPayoutPaid(payoutId, adminId, { amountPennies, practiceIds })`:
   - Read `user_id` for the payout (409 `payout_not_open` if no row).
   - Inside `withWalletLock(user_id)`: `select * from payout_requests where id=$1 for update`;
     `status !== 'open'` → 409 `payout_not_open`; `practiceIds` given (non-null array) and
     `!practiceIds.includes(practice_id)` → 403 `forbidden`; `amountPennies !== amount_pennies`
     → 409 `amount_mismatch`; balance check as today; then
     `update … set status='paid', paid_by, paid_at=now() where id=$1 and status='open' returning id`
     — zero rows → 409 `payout_not_open`. Ledger debit, notified-flag reset, outbox, event as today.
   - Order matters: scope check before amount check (a manager must never learn another
     practice's amount by probing).
3. `cancelPayout(payoutId, actorId, { byAdmin = false, reason = null, practiceIds = null } = {})`:
   - Read `user_id` (409 if none). Inside `withWalletLock(user_id)`: `select … for update`;
     not open → 409; `!byAdmin && user_id !== actorId` → 409 `payout_not_open`; `byAdmin &&
     practiceIds && !practiceIds.includes(practice_id)` → 403 `forbidden`; then the update with
     `and status='open'`, outbox (admin only), event — all inside the transaction.
   - Update both call sites (`DELETE /payouts/:id` and `POST /admin/payouts/:id/cancel`).
4. Routes: mark-paid parses `req.body.amountPennies`; not a positive integer → 422
   `amount_required`. Pass `practiceIds: req.admin.role === 'owner' ? null : req.admin.practiceIds`
   (empty array for a non-owner with no practices means "none allowed" → 403).
5. Full api suite green (including `admin.test.js` cancel test and `api.test.js` payout test).
6. Commit: `fix(api): payout mark-paid/cancel under the wallet lock with amount, practice and owner guards`.

---

## Task 3: Admin app — role-aware shell, ManagerPage, payout rows reception can verify

**Files**
- Modify `apps/admin/src/App.jsx`
- Create `apps/admin/src/pages/ManagerPage.jsx`
- Modify `apps/admin/src/components/PayoutQueue.jsx`
- Modify `apps/admin/src/copy.js`
- Modify `apps/admin/src/theme.css` (only what the new rows need)
- Create `apps/admin/test/PayoutQueue.test.jsx` (testing-library + jsdom are configured via
  `vitest.config.js` / `test/setup.js`; see `test/apiClient.test.js` for the fetch-stub pattern)
- Modify `apps/admin/test/copy.test.js` (new codes)

**Behaviour**
1. `App.jsx`: after sign-in, `api('/admin/me')` → `me`. `me.role === 'manager'` → render
   `<ManagerPage me={me} notify={notify} onSignOut={…} />` instead of the dashboard shell (no
   `topnav`, no `loadAll`). Anything else → existing dashboard unchanged. Keep the sign-out button.
2. `ManagerPage`: header wordmark "GM Dental", `h1` = `${me.practices[0].name} · Payouts`, then
   `<PayoutQueue payouts onChanged notify />`. Loads `GET /admin/payouts` on mount and every 30 s
   while `document.visibilityState === 'visible'`; refetches after every action via `onChanged`.
   Toast for errors like `App.jsx`.
3. `PayoutQueue` open rows show: member name, amount, `collecting at {practice} · requested {date}`
   (as today), plus a line `phone · code` (format the code with `formatCode` from
   `@gm-referral/shared/referral-code`), and a small list of `credits`:
   `{friend} · £{amount} · {at}`. Below: label "Cash handed over (£)", a text input
   (`inputMode="decimal"`, parsed with `parseGBPToPennies` from `@gm-referral/shared/money`), and a
   **Paid** button (`btn-gold`) disabled until the input parses to a positive amount; click →
   `POST /admin/payouts/:id/mark-paid { amountPennies }`. Keep the existing Cancel… flow. Settled
   list unchanged.
4. `copy.js`: `amount_required: 'Type the cash amount handed over before marking paid.'`,
   `amount_mismatch: "That amount doesn't match the request — check the cash and try again."`.
5. Tests (write first, watch fail): `PayoutQueue.test.jsx` — renders phone/code/credits for an
   open row; Paid is disabled with an empty amount; typing `100` and clicking Paid POSTs
   `{ amountPennies: 10000 }` to `/admin/payouts/<id>/mark-paid` (stub `fetch`); an
   `amount_mismatch` response calls `notify('amount_mismatch')`. `copy.test.js` — the two new codes
   map to the given strings.
6. `cd apps/admin && npx vitest run` green; `npx vite build` succeeds.
7. Commit: `feat(admin): manager payout screen + typed-amount mark paid`.

---

## Task 4: Mobile — choose where to collect, cancel a request

**Files**
- Modify `apps/mobile/src/screens/referrer.js` (WalletScreen; also commit the pre-existing
  uncommitted wallet redesign already in this file — it is intentional and approved)
- Modify `apps/mobile/src/api/client.js` (`cancelPayout`, mock branch)

**Behaviour**
1. `client.js`: `cancelPayout: (id) => request(`/payouts/${id}`, { method: 'DELETE' })`; mock mode:
   DELETE on `/payouts/*` sets `mock.wallet.openPayout = null` and returns `{ ok: true }`.
2. WalletScreen, when `unlocked && !openPayout`: a section label "Where will you collect?" and one
   pressable row per practice (name, gold check/border when selected; `accessibilityRole="radio"`,
   `accessibilityState={{ selected }}`), state `selectedPracticeId` (initially `null`). The
   `GoldButton` label becomes `Collect my cash at {practice name}` (or "Collect my cash" while none
   selected) and is `disabled` until a practice is selected. `requestPayout` sends the selected id.
3. When `openPayout` is set: keep the "Payout requested — collect £X at {practice} reception." line
   and add a ghost `GoldButton` "Cancel request" → `api.cancelPayout(openPayout.id)` then `load()`.
   (`openPayout.id` already comes from the API.)
4. Copy: `HOW_IT_WORKS[2].detail` → `'Choose a practice and collect at reception.'`; the unlocked
   line → `'Ready to collect in cash — choose a practice below.'`.
5. There is no mobile test runner. Verify syntax by transpiling the two files with the project's
   Babel preset (e.g. from `apps/mobile`: `npx babel --presets babel-preset-expo src/screens/referrer.js src/api/client.js > /dev/null`
   — if `@babel/cli` is missing, use `node -e` with `@babel/core`'s `transformFileSync`). Report
   the exact command and result.
6. Commit: `feat(mobile): choose the practice to collect at; cancel a payout request`.
