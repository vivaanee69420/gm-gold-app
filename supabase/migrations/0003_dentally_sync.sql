-- Dentally sync (FR-05 verification read model, FR-16 sync worker, FR-17 proposals).
-- Tables reserved by 0001's header comment; shapes from REQUIREMENTS.md §3.

create table completion_proposals (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references referrals(id),
  dentally_event_id text not null unique, -- idempotent sync: one proposal per Dentally event
  matched_phone text not null,
  invoice_state text,
  treating_practice_id uuid references practices(id),
  status text not null default 'open' check (status in ('open','confirmed','rejected')),
  decided_by text,
  decided_at timestamptz,
  reason text,
  created_at timestamptz not null default now()
);
create index completion_proposals_status on completion_proposals (status);
create index completion_proposals_referral on completion_proposals (referral_id);

create table sync_state (
  key text primary key,
  watermark timestamptz not null,
  updated_at timestamptz not null default now()
);

create table dentally_patient_index (
  dentally_patient_id text primary key,
  phone text not null,
  practice_id uuid references practices(id),
  refreshed_at timestamptz not null default now()
);
create index dentally_patient_index_phone on dentally_patient_index (phone);

-- Maps Dentally site ids onto our practice rows (set per practice once credentials arrive;
-- the stub uses the practice uuid itself as the site id).
alter table practices add column dentally_site_id text unique;
