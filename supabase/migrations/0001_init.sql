-- GM Referral — MVP schema (REQUIREMENTS.md §3 subset: everything the core loop needs).
-- Dentally sync tables (completion_proposals, sync_state, dentally_patient_index) land in
-- migration 0002 when API credentials arrive.

-- gen_random_uuid() is built into Postgres 13+; no extension required.

create table practices (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  inquiry_phone text,
  inquiry_email text,
  active boolean not null default true
);

create table users (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  first_name text,
  last_name text,
  role_referrer boolean not null default false,
  role_referred boolean not null default false,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified','pending_review','verified','rejected')),
  dentally_patient_id text,
  practice_id uuid references practices(id),
  notify_opt_in boolean not null default false,
  notify_opt_in_version text,
  notify_opt_in_at timestamptz,
  payout_ready_notified_at timestamptz,
  created_at timestamptz not null default now()
);

create table referral_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  code text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references users(id),
  referred_user_id uuid references users(id),
  referred_phone text not null,
  referred_name text not null,
  treatment_interest text not null,
  preferred_practice_id uuid references practices(id),
  status text not null default 'new'
    check (status in ('new','contacted','booked','attended','treatment_agreed','treatment_completed','lost')),
  lost_reason text,
  review_status text check (review_status in ('existing_patient_suspect','cleared')),
  consent_version text not null,
  consent_at timestamptz not null default now(),
  source text not null default 'code' check (source in ('qr','code')),
  created_at timestamptz not null default now()
);
-- First code wins, but a lost referral frees the phone for re-referral.
create unique index referrals_referred_phone_active on referrals (referred_phone) where status <> 'lost';
create index referrals_referrer_status on referrals (referrer_id, status);
create index referrals_referred_phone on referrals (referred_phone);

create table reward_rules (
  id uuid primary key default gen_random_uuid(),
  practice_id uuid references practices(id),
  type text not null default 'fixed' check (type = 'fixed'),
  amount_pennies integer not null check (amount_pennies > 0),
  active_from timestamptz not null default now(),
  created_by text
);

create table app_settings (
  key text primary key,
  value text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

create table wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('credit','debit','adjustment')),
  amount_pennies integer not null,
  referral_id uuid references referrals(id),
  rule_id uuid references reward_rules(id),
  practice_id uuid references practices(id),
  payout_id uuid,
  idempotency_key text unique,
  reason text,
  created_by text,
  created_at timestamptz not null default now()
);
-- One credit per referral, ever (outside voice #1).
create unique index wallet_ledger_one_credit_per_referral on wallet_ledger (referral_id) where kind = 'credit';
create index wallet_ledger_user on wallet_ledger (user_id);

create table payout_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  amount_pennies integer not null check (amount_pennies > 0),
  practice_id uuid not null references practices(id),
  status text not null default 'open' check (status in ('open','paid','expired','cancelled')),
  requested_at timestamptz not null default now(),
  cancelled_by text,
  paid_by text,
  paid_at timestamptz
);
create unique index payout_requests_one_open_per_user on payout_requests (user_id) where status = 'open';
create index payout_requests_practice_status on payout_requests (practice_id, status);

create table events (
  id uuid primary key default gen_random_uuid(),
  actor_id text,
  entity_type text not null,
  entity_id text not null,
  action text not null,
  from_value text,
  to_value text,
  reason text,
  created_at timestamptz not null default now()
);

create table otp_deliveries (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text,
  channel text not null default 'dev',
  delivery_status text not null default 'sent',
  attempts integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index otp_deliveries_phone_created on otp_deliveries (phone, created_at);

create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_kind text not null check (recipient_kind in ('user','practice_contact')),
  recipient_id uuid,
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  channel_resolved text,
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create table analytics_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  name text not null,
  properties jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index analytics_events_name_created on analytics_events (name, created_at);
