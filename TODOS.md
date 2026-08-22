# TODOS — GM Referral

Index of parked work and external waits. Details live in the linked docs; this file is pointers, not copies.
Created by /plan-eng-review on 2026-08-14.

## External waits (Stage 0 — all four emails should be sent today)

- [x] **Dentally data — LIVE via Dental Os (2026-08-21, decision by Ruhith)**: the sync reads the central Dental Os DB (fed by Dentally webhooks) through read-only role `gm_referral_reader`; ~16k patients indexed on first backfill; `gmref_doorbell` triggers on Dental Os ping `/webhooks/dentally` for second-level latency. Real practices seeded (migration 0006). Direct-Dentally OAuth + token paths remain as built fallbacks (spike script kept). **The Dentally-credentials email is now OPTIONAL** — only needed if we ever switch to direct mode.
  - [ ] Deploy current code + env (`DATABASE_URL`, `DENTAL_OS_DATABASE_URL`, `DENTALLY_WEBHOOK_SECRET`) to Railway so the doorbell (which targets the staging URL) completes the instant-update chain in staging.
- [x] ~~**Meta WhatsApp Business verification**~~ — OBSOLETE (2026-08-22, decision by Ruhith): **email replaces WhatsApp** for auth OTP and reminders. Auth email first; reminder emails are a later phase. No Meta verification needed; `whatsapp_primary` mode is dropped from the plan. → new work item: pick an email provider + wire OTP-by-email alongside SMS.
- [ ] **Accountant: cash-commission tax treatment** (owner: practice accountant) — blocks payout wording + terms. → open question 2
- [ ] **Solicitor: incentive claims + UK GDPR Article 9 basis** (owner: solicitor) — blocks consent wording finalization + launch. → open question 5 / compliance checklist

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

## Phase 2 backlog

See `docs/FLOWS.md` §9 — the authoritative list (web capture page tripwire lever, wallet passes, leaderboard/draw, percent rules, fraud scoring, deferred deep linking, admin conveniences with MVP stand-ins, staff-side referral entry, self-service phone change, fuzzy matching).
