# GM Referral

Patient referral app for GM Dental: patients carry a gold card in the app, friends join with their
code, and completed treatments pay the referrer a cash commission (admin-set amount, threshold
payout collected at any practice).

Docs: `docs/DESIGN.md` (decisions + build sequence), `docs/FLOWS.md`, `docs/REQUIREMENTS.md`, `TODOS.md`.

## Layout

```
apps/mobile      Expo React Native app (referrer + referred flows), plain JS
apps/api         Express API — layered ESM JS, advisory-locked wallet, outbox
packages/shared  phone / referral-code / money / zod schemas (one source of truth)
supabase/        SQL migrations (same files run on dev PGlite and Supabase)
```

## Run it

```bash
npm install
npm run api      # Express on http://localhost:4000 (embedded Postgres; DATABASE_URL swaps to Supabase)
npm run mobile   # Expo dev server — press w for web preview, or scan the QR with Expo Go
```

Dev sign-in: any UK mobile number; the 6-digit code is printed by the API console and shown as a
dev hint in the app. OTP mode is `dev` until the email/SMS provider lands — email replaces
WhatsApp for auth and reminders (decision 2026-08-22, see TODOS.md).

## Dentally sync (Stage 5)

The FR-16 worker (poll every 15 min + `POST /webhooks/dentally` doorbell) detects completed-and-paid
treatments, matches patient mobiles against open referrals, and files **proposals** the admin
confirms with one click (that click = referral completed + wallet credit, one transaction).
Referrer verification (FR-05) reads the same patient index; unmatched numbers go to the admin
verify queue and auto-resolve when a clean match appears.

**Active source — Dental Os (2026-08-21):** the sync reads Dentally facts from the company's
central Dental Os Supabase (`mkfhpzjbijbachoonytt`, already fed by Dentally webhooks) via the
read-only role `gm_referral_reader` (SELECT on contacts/appointments/invoices/practices only) —
`DENTAL_OS_DATABASE_URL` in `apps/api/.env`. No Dentally credentials needed. Instant updates:
`gmref_doorbell` triggers on Dental Os (appointments→completed, invoices→paid) POST to
`/webhooks/dentally` with the `x-gmref-secret` header (= `DENTALLY_WEBHOOK_SECRET`), so a
completion syncs in seconds; the 15-min cron is the safety net. Real practices (Ashford, Barnet,
Bexleyheath, Rochester, Warwick Lodge) are seeded by migration 0006 with their true Dentally site
uuids in `practices.dentally_site_id`; app screens auto-refresh every 30s so credits appear
without pull-to-refresh.

Effective mode per request: `DENTALLY_MODE` override → `DENTAL_OS_DATABASE_URL` (**dentalos**) →
`DENTALLY_API_TOKEN` (live, direct) → admin-dashboard OAuth connection (live, direct; "Connect
Dentally" button, credentials via `DENTALLY_CLIENT_ID/SECRET`) → `stub` in dev / `off` in
production. The direct-Dentally paths are kept as fallbacks; the spike script
(`apps/api/scripts/dentally-spike.js`) remains the go/no-go if they're ever activated.

Dev-only stub triggers (walk the whole loop with zero Dentally access):

```bash
curl -X POST localhost:4000/dev/dentally/complete-treatment \
  -H 'content-type: application/json' \
  -d '{"phone":"+447700900777","practiceId":"<uuid>","amountPennies":52000}'
# also: /dev/dentally/add-patient {phone} — seed a patient so signup verifies
```

## Tests

```bash
npm test         # shared (15) + api (11, +1 skipped until DATABASE_URL points at real Postgres)
```

## Supabase (provisioned 2026-08-21)

Project **"gm refferal app"** (`xiijsxabqwngeoxlflya`) — ⚠ created in **ap-southeast-2 (Sydney)**;
the design calls for **eu-west-2 (London)** for UK latency + GDPR residency. Recreate before real
patient data lands (the DB is scripted — apply `supabase/migrations/*.sql` in order and it is
identical). All migrations (0001–0004) are applied and recorded in the API's `_migrations` ledger;
RLS is enabled on every table with no policies (Express connects as table owner and bypasses RLS;
the anon/REST surface is fully locked out).

The API connects as the dedicated role **`gm_referral_api`** (login-only, no superuser; admitted
through per-table `api_rw` RLS policies — a new table needs one
`create policy api_rw on <t> for all to gm_referral_api using (true) with check (true);`).
`apps/api/.env` (gitignored) holds the working `DATABASE_URL` via the **session pooler**
(IPv4 — the direct host is IPv6-only). `npm run api` auto-loads it; delete/rename the file to
fall back to embedded PGlite. On Railway, set the same `DATABASE_URL` as a service variable.
Session mode only, never transaction mode — the wallet + sync advisory locks need real sessions.
With `DATABASE_URL` set, the skipped concurrency test (matrix row 9) unskips: `npm test`.

## Hosting (staging on Railway)

Project `gm-referral` on Railway (Docker builds, account developergmd@outlook.com):

- **api** — `Dockerfile.api`, embedded PGlite persisted on a volume at `/app/apps/api/data`
  (set `DATABASE_URL` to switch to Supabase at production). https://api-production-9d24.up.railway.app
- **admin** — `Dockerfile.admin` (Vite build served by Caddy), `VITE_API_URL` baked at build time.
  https://admin-production-ae73.up.railway.app

Deploy by hand with `railway up --service api|admin`, or push to `main` once the repo has a
`RAILWAY_TOKEN` secret (Railway → project → Settings → Tokens) for `.github/workflows/deploy.yml`.
Staging runs dev OTP mode and the dev admin gate — do not point real patient data at it until
real admin auth (Supabase email) lands.

## Demo the loop

1. App: sign in → "I'm a GM Dental patient" → your card shows a live code.
2. Second phone/incognito web: sign in with another number → "A friend referred me" → enter the code → submit.
3. Front desk (dev): `PATCH /admin/referrals/:id/status {"status":"treatment_completed"}` with any signed-in bearer token.
4. App wallet: +£20 lands, seam moves, notification prints in the API console.
