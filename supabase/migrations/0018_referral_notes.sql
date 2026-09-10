-- What the front desk knows about a patient that no other column holds (2026-09-10).
--
-- Two things, both asked for on the pipeline card and both kept until someone removes them:
--
--   treatment_name — what they are actually having done. `treatment_interest` is the enum the
--   referral form offered ('implants', 'not_sure', …) and stays exactly as the patient chose
--   it, because commission attribution reads it. This is the real treatment, typed by the
--   practice once they know.
--
--   referral_notes — an append-and-delete log, not a single overwritable field, so two people
--   at the desk can each add what they know without erasing each other. Deleting is a real
--   delete: a note is working memory, not the audit trail (`events` is the audit trail, and
--   nothing ever leaves it).
alter table referrals add column if not exists treatment_name text;

create table if not exists referral_notes (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references referrals(id) on delete cascade,
  body text not null,
  author_admin_id uuid references admin_users(id),
  created_at timestamptz not null default now()
);

-- Every read is "the notes on this referral, oldest first".
create index if not exists referral_notes_referral on referral_notes (referral_id, created_at);

-- Notes carry patient information, so this table is closed to the public anon key like every
-- other table in this schema (0004). The API reaches it as its own role; nobody else does.
alter table referral_notes enable row level security;
