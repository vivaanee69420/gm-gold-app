-- Practice managers: one practice each, payouts-only dashboard (2026-08-28 decision).
alter table admin_users drop constraint if exists admin_users_role_check;
alter table admin_users add constraint admin_users_role_check check (role in ('admin','owner','manager'));
-- Defensive no-op: Warwick Lodge was already deactivated in 0009_booking_urls.sql. Restated
-- here so this migration doesn't depend on 0009 having run first on every target database.
update practices set active = false where name = 'Warwick Lodge';
