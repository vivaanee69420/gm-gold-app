# TODOS — GM Referral

Index of parked work and external waits. Details live in the linked docs; this file is pointers, not copies.
Created by /plan-eng-review on 2026-08-14.

## External waits (Stage 0 — all four emails should be sent today)

- [ ] **Dentally API access** (owner: Ruhith) — three questions: completed+paid readable? patient mobiles readable? one account for six practices or six? + sandbox request. Blocks build Stages 5–6. → `docs/DESIGN.md` open question 1
- [ ] **Meta WhatsApp Business verification** (owner: Ruhith) — 2–4 weeks lead time; blocks `whatsapp_primary` mode only. → open question / FR-02a
- [ ] **Accountant: cash-commission tax treatment** (owner: practice accountant) — blocks payout wording + terms. → open question 2
- [ ] **Solicitor: incentive claims + UK GDPR Article 9 basis** (owner: solicitor) — blocks consent wording finalization + launch. → open question 5 / compliance checklist

## Launch deliverables not yet written

- [ ] SAR runbook (per-user export + anonymization SQL, tested on staging) → `docs/runbooks/` — REQUIREMENTS FR-27
- [ ] Cash-operations runbook per practice (float, authorization, till reconciliation) → `docs/runbooks/` — REQUIREMENTS §7 checklist

## Deployment gates

- [ ] **Provision Supabase project** (deferred by decision 2026-08-14: $10/month starts at deployment, not before). Steps: create project "GM Referral" (org uptupfxqtxfoiesfwjtf, eu-west-2) → apply `supabase/migrations/*.sql` → set `DATABASE_URL` for the API → the skipped concurrency test (matrix row 9) unskips. Dev runs on embedded PGlite until then.

## Design gates awaiting answers

- [ ] Refund/clawback detection mechanism — cannot be designed until Dentally's API answer arrives; today the sync worker cannot see refunds at all. → DESIGN open question 5
- [ ] Referred-friend incentive (free consult + 5% off carry-over?) — finalizes the referred screens' promise line, share message, terms. → open question 3
- [ ] GHL push at MVP or Phase 2 → open question 4
- [ ] Backend hosting choice + environments → open question 7

## Phase 2 backlog

See `docs/FLOWS.md` §9 — the authoritative list (web capture page tripwire lever, wallet passes, leaderboard/draw, percent rules, fraud scoring, deferred deep linking, admin conveniences with MVP stand-ins, staff-side referral entry, self-service phone change, fuzzy matching).
