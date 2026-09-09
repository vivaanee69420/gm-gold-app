-- Retire the self-issued OTP (decision 2026-09-09: Supabase Auth owns patient identity).
--
-- The API no longer generates, stores or checks login codes, so the table that held them and
-- the setting that chose their delivery channel are both dead weight. Dropped rather than
-- left in place: an unused table holding hashed credentials is a thing someone re-wires by
-- accident later, and `otp_deliveries` was the store behind an endpoint that would mint a
-- session for any phone number.
--
-- Note on the rows being destroyed: they are five-minute-TTL login codes, all long expired.
-- There is nothing here to keep and nothing that can be reconstructed from it.
drop table if exists otp_deliveries;

-- Was surfaced as an admin "lever" in the dashboard. There is no channel to choose any more;
-- Supabase sends the code and Resend carries it.
delete from app_settings where key = 'otp_channel_mode';

-- users.id is now Supabase's auth.users.id (see services/userService.js getOrCreateUserByAuthId).
--
-- Deliberately NOT enforced with a foreign key: db.js runs every migration unconditionally,
-- including under PGlite in the test suite, and PGlite has no `auth` schema — a reference to
-- auth.users here would fail all 11 suites at beforeAll rather than only the auth ones. The
-- FK would also buy little: wallet_ledger and payout_requests already reference users(id), so
-- a cascade delete of a patient carrying money is blocked regardless.
--
-- Existing patient rows predate this and carry uuids Supabase never issued, so nobody can log
-- back into them. They are inert rather than harmful: nothing can authenticate as them, and
-- Q1 confirms they are test data. They are left alone rather than truncated here, because a
-- destructive statement that runs automatically on every boot is the wrong place to make that
-- call — clear them by hand if you want a clean slate.
comment on column users.id is
  'Equals auth.users.id (Supabase Auth). Maintained by getOrCreateUserByAuthId, not by a FK: '
  'the migration runner also runs against PGlite, which has no auth schema.';
