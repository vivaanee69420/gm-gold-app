-- Practice managers: one practice each, payouts-only dashboard (2026-08-28 decision).
alter table admin_users drop constraint admin_users_role_check;
alter table admin_users add constraint admin_users_role_check check (role in ('admin','owner','manager'));
-- Warwick Lodge is not a live GM Dental site; the scheme runs across four practices.
update practices set active = false where name = 'Warwick Lodge';
