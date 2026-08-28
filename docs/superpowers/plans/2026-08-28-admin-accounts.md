# Dashboard accounts: email + password, two roles, admins create managers — implementation plan

Decided in chat 2026-08-28 (no separate spec). Branch `feat/admin-accounts` from `main` (c7c9e1f).

## Goal

The dashboard has **two roles**: `admin` (full dashboard, all practices) and `manager` (one practice,
payouts screen only). Admins create manager/admin accounts in the dashboard, set a password, and share
it; managers log in with email + password. Phone-OTP sign-in disappears from the dashboard entirely
(it stays for the patient app). The dev "any signed-in user is owner" fallback is removed.

## Global Constraints (binding for every task)

- API error shape `{ error: <code> }` via the existing error boundary (`err.status` + `err.message`).
  New codes: `invalid_credentials` (401 — used for unknown email, wrong password AND inactive
  account, so nothing is enumerable), `rate_limited` (429), `email_taken` (409),
  `weak_password` (422), `practice_required` (422 — manager without exactly one active practice),
  `cannot_deactivate_self` (409), `last_admin` (409), `wrong_password` (401 — change-own-password),
  `forbidden` (403), `unauthorized` (401).
- Admin tokens: JWT `{ sub: <admin_users.id>, kind: 'admin', role }`, `expiresIn: '12h'`, signed with
  `config.jwtSecret`. Patient tokens are unchanged (`{ sub, phone }`, 90d). `requireAdmin` accepts ONLY
  `kind === 'admin'` tokens; a patient token on any `/admin/*` route → 401 `unauthorized`.
- `requireAdmin` loads the row by `sub`, requires `active`, rejects tokens issued before
  `sessions_revoked_at`, and sets `req.admin = { id, email, role, practiceIds }`. Manager fencing to
  `/admin/me` + `/admin/payouts*` (and `POST /admin/me/password`) stays. No dev fallback.
- Passwords: `scrypt` from `node:crypto` (N=16384, r=8, p=1, 64-byte key, 16-byte random salt), stored
  as `scrypt$<saltHex>$<hashHex>`, compared with `timingSafeEqual`. Minimum length **10**, no other rules.
- Emails: trim + lowercase before storing/comparing; validate with zod `.email()`.
- Login rate limit: **5 failed attempts per email within 15 minutes → 429** for that email until the
  window passes (in-memory `Map`, single replica — same approach as `otpService`); a successful login
  clears the counter.
- Roles: exactly `'admin' | 'manager'`. `admin` = all practices (`practiceScope`/`actionScope` → null).
  `manager` = `practice_ids` must contain exactly one ACTIVE practice at create/update time; an empty
  scope means sees/acts on nothing (existing behaviour).
- Actor ids written to `paid_by`/`created_by`/`updated_by`/`actor_id`/`cancelled_by`/`decided_by`
  etc. are `text` columns — write `req.admin.id` there. No `users` FK is involved.
- Tests run on in-memory PGlite: `cd apps/api && npx vitest run`; **never set `DATABASE_URL`**. All
  suites (`npm test` at the root) must be green at the end of every task.
- Commit per task with trailers:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01Kwd8gF3Joda8Wy8JtGbS5G`.
- Do not deploy, push, or touch Railway/Supabase. Mobile app untouched.
- Keep UI as simple as possible: one "Team" card + one "Change password" form; no new pages.

---

## Task 1: Admin identity — migration, adminService, login, requireAdmin, test harness

**Files**
- Create `supabase/migrations/0011_admin_accounts.sql`
- Create `apps/api/src/services/adminService.js`
- Modify `packages/shared/src/schemas.js` (+ `packages/shared/test/shared.test.js`)
- Modify `apps/api/src/middleware/auth.js`
- Modify `apps/api/src/app.js`
- Create `apps/api/scripts/create-admin.js`; delete `apps/api/scripts/grant-admin.js`
- Create `apps/api/test/helpers/admin.js` (test-only helper)
- Create `apps/api/test/admin-auth.test.js`
- Modify every existing API test that calls `/admin/*` (`admin.test.js`, `api.test.js`,
  `dentally.test.js`, `dentally-oauth.test.js`, `practice-payouts.test.js`) to use an admin token.

**Migration `0011_admin_accounts.sql`** (must run on PGlite and Supabase; the table currently has
`user_id uuid primary key references users(id), email, role check in ('admin','owner','manager'),
practice_ids, active, created_at`):
```sql
-- Dashboard accounts become their own identity (email + password), two roles.
alter table admin_users drop constraint admin_users_pkey;
alter table admin_users add column id uuid not null default gen_random_uuid();
alter table admin_users add primary key (id);
alter table admin_users alter column user_id drop not null;
alter table admin_users add column password_hash text;
alter table admin_users add column last_login_at timestamptz;
alter table admin_users add column sessions_revoked_at timestamptz;
update admin_users set role = 'admin', practice_ids = '{}' where role = 'owner';
update admin_users set practice_ids = '{}' where role = 'admin';
alter table admin_users drop constraint if exists admin_users_role_check;
alter table admin_users add constraint admin_users_role_check check (role in ('admin','manager'));
update admin_users set email = lower(trim(email));
```
Keep `user_id` (nullable, no longer used) so nothing is lost; the reader may drop it later.

**Shared schemas** (`packages/shared/src/schemas.js`): `adminLoginSchema = z.object({ email:
z.string().trim().toLowerCase().email(), password: z.string().min(1) })`; `adminPasswordSchema =
z.string().min(10)`; `adminCreateSchema = z.object({ email (as above), password: adminPasswordSchema,
role: z.enum(['admin','manager']), practiceId: z.string().uuid().optional() })`. Tests: valid/invalid
email, 9-char password rejected, unknown role rejected.

**`adminService.js`** exports:
- `hashPassword(password)` / `verifyPassword(password, stored)` per the constraints.
- `createAdmin({ email, password, role, practiceIds = [], createdBy = null })` → row; 409
  `email_taken` on unique violation; 422 `practice_required` unless (`role==='admin'` and no ids) or
  (`role==='manager'` and exactly one id that resolves to an ACTIVE practice).
- `authenticate(email, password)` → `{ token, admin }` or throws 401 `invalid_credentials` (same code
  for unknown email, wrong password, inactive account; always run the hash compare against a fixed dummy
  hash when the email is unknown so timing is uniform); 429 `rate_limited` after 5 failures / 15 min.
  On success: clear the counter, set `last_login_at = now()`.
- `issueAdminToken(admin)` and `loadAdminForToken(payload)` (returns null if missing/inactive/revoked).
- `publicAdmin(row, practices)` → `{ id, email, role, practices: [{id,name}] }` (practices resolved
  from `practice_ids` for managers, all active for admins).

**`auth.js`**: `requireAdmin` is now standalone (no `requireUser` before it): parse bearer, `verifyToken`,
require `payload.kind === 'admin'`, `loadAdminForToken`, set `req.admin`, apply the manager fence
(add `^/admin/me/password` to the allowed set). Everything else → 401 `unauthorized`. Remove the
`isDev` fallback and the `users`-keyed query.

**`app.js`**:
- `POST /auth/admin/login` (validate `adminLoginSchema`) → `{ token, admin: publicAdmin(...) }`.
- Every `/admin/*` route: replace `requireUser, requireAdmin` with `requireAdmin` and every
  `req.user.id` in those handlers with `req.admin.id`. (`/admin/users/:id/revoke-sessions` still
  targets a *patient* user id — keep it, it's the patient session kill switch.)
- `GET /admin/me` → `publicAdmin(req.admin …)` (same shape as before: `{ role, practices }` — also
  include `id` and `email`).
- `practiceScope`/`actionScope`: `admin` → null; `manager` → ids (unchanged semantics).

**`scripts/create-admin.js`**: `node scripts/create-admin.js <email> <password> [admin|manager] [practiceId]`
→ uses `createAdmin`; prints the id; exit 1 with a clear message on any validation error. Delete
`grant-admin.js`.

**Test harness** `apps/api/test/helpers/admin.js`: `export async function adminSession(app, { email =
'admin@test.gmdental.co.uk', password = 'correct-horse-battery', role = 'admin', practiceIds = [] } = {})`
→ creates the account via `createAdmin` if it doesn't exist, logs in via the HTTP route, returns
`{ token, admin }`. Update each existing test file: create `agents.admin = (await adminSession(app)).token`
in `beforeAll` and use it on every `/admin/*` call (the referrer/patient tokens keep being used for
patient routes). `practice-payouts.test.js`: `managerFor` creates managers via `adminSession(app,
{ email, role: 'manager', practiceIds: [practiceId] })`; the "controller ruling" describe's raw
`insert into admin_users` calls must be replaced with the helper (`role: 'manager', practiceIds: []`
and `role: 'admin'`); the old scoped-`admin` case in `admin.test.js` ("practice-scoped admin sees only
their practices") becomes a `manager` case.

**New tests `admin-auth.test.js`** (write first, watch fail): login succeeds and returns role +
practices; wrong password → 401 `invalid_credentials`; unknown email → 401 (same body); inactive
account → 401; 5 wrong attempts → 6th is 429 even with the right password; a patient token on
`/admin/me` → 401; a token for a deactivated admin → 401; `create-admin` validation: manager
without practice → 422 `practice_required`, duplicate email → 409 `email_taken`, 9-char password →
422; the role check rejects `'owner'` (raw insert fails).

**Steps**: RED (new test file + the modified harness fails: `/auth/admin/login` 404), implement,
GREEN across `apps/api` + `packages/shared`, commit
`feat(api): email+password admin accounts, two roles, no dev admin fallback`.

---

## Task 2: Team management endpoints + self password change + docs

**Files**
- Modify `apps/api/src/services/adminService.js` (`listAdmins`, `setPassword`, `setActive`,
  `changeOwnPassword`)
- Modify `apps/api/src/app.js` (routes)
- Create `apps/api/test/admin-team.test.js`
- Modify `docs/REQUIREMENTS.md` (FR-24 + data model + API surface), `README.md` (bootstrap section)

**Routes (admin role only unless stated):**
- `GET /admin/team` → `{ team: [{ id, email, role, practices:[{id,name}], active, lastLoginAt, createdAt }] }`
  ordered by role then email.
- `POST /admin/team` (validate `adminCreateSchema`) → `createAdmin(...)` → 200 `{ admin }`.
- `POST /admin/team/:id/password { password }` (validate `adminPasswordSchema`) → sets a new hash,
  bumps `sessions_revoked_at = now()` so old tokens die → `{ ok: true }`.
- `POST /admin/team/:id/active { active: boolean }` → 409 `cannot_deactivate_self` when `:id ===
  req.admin.id`; 409 `last_admin` when deactivating the last active `admin`; deactivating also bumps
  `sessions_revoked_at`.
- `POST /admin/me/password { currentPassword, newPassword }` (both roles) → 401 `wrong_password` if
  current doesn't verify; 422 `weak_password` via schema; on success re-issue a token: `{ ok: true,
  token }` (because `sessions_revoked_at` is bumped).
- A `manager` calling any `/admin/team*` route → 403 `forbidden` (fence already does this).
- Every mutation writes an `events` row (`entity_type 'admin_user'`, actor `req.admin.id`, actions
  `created` / `password_set` / `activated` / `deactivated` / `password_changed`).

**Tests** (write first): list shows created accounts without hashes; create manager needs a practice;
set password logs the manager out (old token 401) and the new password works; deactivate self → 409;
deactivate last admin → 409; deactivated manager cannot log in; reactivate works; manager → 403 on
team routes; change own password with wrong current → 401, with right → old token dead, new token
works.

**Docs**: FR-24 → two roles, email + password, admins create managers, first admin via
`scripts/create-admin.js`; data-model line for `admin_users`; API surface: `/auth/admin/login`,
`/admin/team*`, `/admin/me/password`. README: a "Dashboard accounts" section with the bootstrap
command for local PGlite and for Railway/Supabase (`DATABASE_URL=… node apps/api/scripts/create-admin.js …`).

Commit `feat(api): team management + change password; docs`.

---

## Task 3: Admin app — email + password sign-in, Team card, change password

**Files**
- Modify `apps/admin/src/api/auth.js`, `apps/admin/src/components/SignIn.jsx`, `apps/admin/src/App.jsx`,
  `apps/admin/src/pages/ReportsPage.jsx`, `apps/admin/src/copy.js`, `apps/admin/src/theme.css` (minimal)
- Create `apps/admin/src/components/TeamCard.jsx`, `apps/admin/src/components/ChangePassword.jsx`
- Modify tests `apps/admin/test/SignIn.test.jsx`, `App.test.jsx`, `copy.test.js`, `apiClient.test.js`
  (auth helpers); create `TeamCard.test.jsx`, `ChangePassword.test.jsx`

**Behaviour**
- `auth.js`: `signIn(email, password)` → `POST /auth/admin/login`, stores the token, returns `admin`;
  remove `sendOtp`/`verifyOtp`. `signOut`, `isSignedIn` unchanged.
- `SignIn.jsx`: email (`type="email"`, `autoComplete="username"`) + password
  (`type="password"`, `autoComplete="current-password"`) + "Sign in"; errors through `copy.js`.
- `App.jsx`: unchanged flow (`/admin/me` after sign-in). Header gets a "Change password" ghost
  button for both roles that toggles the `ChangePassword` form inline (in the header area for the
  manager, on the Setup zone for admins — simplest: render it in both shells directly under the header
  when toggled). On success, store the new token from the response.
- `TeamCard.jsx` (admin only, on Reports & Setup under "Setup"): table of accounts (email, role,
  practice, active, last login); "Add account" form (email, temporary password, role select, practice
  select shown only for manager — practices come from `/admin/me.practices`); per row: "Set new
  password" (inline password field + Save), "Deactivate"/"Reactivate". Uses `notify` for errors.
- `copy.js`: `invalid_credentials: 'Email or password is wrong.'`, `rate_limited: 'Too many attempts —
  wait 15 minutes and try again.'`, `email_taken: 'An account with that email already exists.'`,
  `weak_password: 'Passwords need at least 10 characters.'`, `practice_required: 'A manager needs
  exactly one practice.'`, `cannot_deactivate_self: "You can't deactivate your own account."`,
  `last_admin: 'There must be at least one active admin.'`, `wrong_password: "Your current password
  is wrong."`.
- Tests (write first): SignIn posts `{email,password}` and calls `onSignedIn`; shows the
  `invalid_credentials` copy on 401; TeamCard lists rows, creating a manager sends `practiceId`,
  set-password posts to `/admin/team/:id/password`, deactivate posts `{active:false}`;
  ChangePassword posts and stores the returned token; App test's sign-in stub updated.
- `cd apps/admin && npx vitest run` green; `npx vite build` succeeds.

Commit `feat(admin): email+password sign-in, Team card, change password`.
