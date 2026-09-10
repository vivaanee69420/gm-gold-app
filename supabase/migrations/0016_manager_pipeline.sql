-- Manager-driven pipeline (2026-09-10). Managers, not the Dentally poller, are now the
-- primary path to a commission credit: they move a patient into treatment_started and the
-- referrer is credited on the spot. See docs/superpowers/specs/2026-09-10-manager-pipeline-design.md

-- The new crediting stage, between treatment_agreed and treatment_completed.
-- treatment_completed stays as the final bookkeeping stage and credits nothing on its own.
alter table referrals drop constraint if exists referrals_status_check;
alter table referrals add constraint referrals_status_check
  check (status in ('new','contacted','booked','attended',
                    'treatment_agreed','treatment_started','treatment_completed','lost'));

-- Where the appointment actually is, per Dental Os. preferred_practice_id keeps saying what
-- the referral form said. Neither column overwrites the other: a commission dispute needs the
-- original attribution, and the manager who can actually advance the patient needs the real one.
alter table referrals add column booked_practice_id uuid references practices(id);

-- The owning practice — the single definition every scoped query uses. Existing rows have a
-- null booked_practice_id and so keep their current owner; this migration moves nobody.
create index referrals_owning_practice
  on referrals (coalesce(booked_practice_id, preferred_practice_id));
