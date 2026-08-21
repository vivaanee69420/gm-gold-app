-- Admin dashboard completion (FR-24 admin_users + roles, FR-03 session revocation).
-- Admin sessions ride the existing API tokens for now; the email column is the join
-- key for the Supabase Auth swap planned for Stage 2-proper (see apps/admin client.js).

create table admin_users (
  user_id uuid primary key references users(id),
  email text not null unique,
  role text not null default 'admin' check (role in ('admin','owner')),
  practice_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- FR-03: admin-triggered "sign out everywhere" — tokens issued before this instant die.
alter table users add column sessions_revoked_at timestamptz;

alter table admin_users enable row level security;
