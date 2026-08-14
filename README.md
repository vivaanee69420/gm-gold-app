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
dev hint in the app. OTP mode is `dev` until the Meta/SMS accounts land (see TODOS.md).

## Tests

```bash
npm test         # shared (15) + api (11, +1 skipped until DATABASE_URL points at real Postgres)
```

## Demo the loop

1. App: sign in → "I'm a GM Dental patient" → your card shows a live code.
2. Second phone/incognito web: sign in with another number → "A friend referred me" → enter the code → submit.
3. Front desk (dev): `PATCH /admin/referrals/:id/status {"status":"treatment_completed"}` with any signed-in bearer token.
4. App wallet: +£20 lands, seam moves, notification prints in the API console.
