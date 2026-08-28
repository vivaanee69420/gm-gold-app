-- Dashboard accounts become their own identity (email + password), two roles.
alter table admin_users drop constraint admin_users_pkey;
alter table admin_users add column id uuid not null default gen_random_uuid();
alter table admin_users add primary key (id);
alter table admin_users alter column user_id drop not null;
alter table admin_users add column password_hash text;
alter table admin_users add column last_login_at timestamptz;
alter table admin_users add column sessions_revoked_at timestamptz;
update admin_users set role = 'admin', practice_ids = '{}' where role = 'owner';
update admin_users set practice_ids = '{}' where role = 'admin';
alter table admin_users drop constraint if exists admin_users_role_check;
alter table admin_users add constraint admin_users_role_check check (role in ('admin','manager'));
update admin_users set email = lower(trim(email));
-- Legacy rows carry no password (they predate email+password login) and must not be able to
-- authenticate; the first real admin is created with create-admin.js.
update admin_users set active = false where password_hash is null;
