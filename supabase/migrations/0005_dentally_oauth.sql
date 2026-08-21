-- Dentally OAuth connection (admin dashboard "Connect Dentally" button).
-- Single row: the practice group's authorized tokens. Replaces/augments DENTALLY_API_TOKEN.

create table dentally_oauth (
  id boolean primary key default true check (id), -- at most one connection
  access_token text not null,
  refresh_token text,
  token_type text not null default 'Bearer',
  scope text,
  expires_at timestamptz,          -- null = token does not expire
  connected_by text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table dentally_oauth enable row level security;

-- Admit the API role where it exists (Supabase); dev PGlite has no such role.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'gm_referral_api') then
    execute 'create policy api_rw on dentally_oauth for all to gm_referral_api using (true) with check (true)';
  end if;
end $$;
