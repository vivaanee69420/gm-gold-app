-- Real email delivery + an honest outbox (todo.md §4c).
--
-- Everything here is ADDITIVE and independent of Supabase Auth, so it lands ahead of the
-- identity migration. Deliberately contains NO reference to the `auth` schema: db.js
-- initDb() runs migrate() unconditionally, including under PGlite (the test default when
-- DATABASE_URL is unset), and PGlite has no `auth` schema at all. A foreign key to
-- auth.users here would fail every test suite at beforeAll, not just the auth tests.

-- ---- users: email becomes a first-class contact field -----------------------------------
-- Nullable for now. Supabase Auth makes it the login identity in the next migration; today
-- it is simply where notification email goes. Unique so two accounts cannot claim one inbox.
alter table users add column email text;
create unique index users_email_unique on users (email) where email is not null;
alter table users add column email_verified_at timestamptz;
alter table users add column phone_verified_at timestamptz;

-- Phone stops being mandatory: an email-first signup has no phone until the profile step.
-- Safe to relax now; the referrer path gates on phone presence in code, not in the schema.
alter table users alter column phone drop not null;

-- ---- dentally_patient_index: match on email as well as phone (todo.md Q2) ---------------
-- Q2 chose "verification requires email AND phone to match the same Dental OS contact", so
-- the index has to carry both. Dental OS contacts already hold an email (client.js:185
-- selects c.email); only the bulk listPatients query and this table were dropping it.
alter table dentally_patient_index add column email text;
-- Was `not null`. An email-only contact is exactly the row this change exists to admit, so
-- the constraint would reject the new case on the first sync pass.
alter table dentally_patient_index alter column phone drop not null;
-- Mirrors dentally_patient_index_phone (0003:32) so the two-key lookup stays symmetric.
create index dentally_patient_index_email on dentally_patient_index (email);
-- A row with neither key is unmatchable and only wastes space on every sync pass.
alter table dentally_patient_index
  add constraint dentally_patient_index_has_a_key check (phone is not null or email is not null);

-- ---- notification_outbox: a real queue, not a log ---------------------------------------
--
--   queued -> sending -> sent                        (provider accepted it)
--                     -> queued   (backoff, retry)   (provider failed, attempts < 5)
--                     -> failed   (terminal)         (attempts exhausted, or hard bounce)
--                     -> skipped  (terminal)         (opted out, or a phase-2 template)
--
-- Until now the drain marked rows 'sent' in the same UPDATE that read them and then
-- console.logged. Every wallet_credit and payout_receipt ever queued is recorded as sent
-- and none were.
alter table notification_outbox add column next_attempt_at timestamptz not null default now();
alter table notification_outbox add column last_error text;
alter table notification_outbox add column skip_reason text;

alter table notification_outbox drop constraint notification_outbox_status_check;
alter table notification_outbox add constraint notification_outbox_status_check
  check (status in ('queued','sending','sent','failed','skipped'));

-- Partial index: a row leaves it the moment it reaches a terminal state, so the index stays
-- small forever even though the table is append-only. The drain runs every 3 seconds against
-- a table that only grows; without this it is a sequential scan 28,800 times a day.
create index notification_outbox_pending
  on notification_outbox (next_attempt_at, created_at)
  where status in ('queued','sending');

-- Rows queued before this migration were marked 'sent' without being sent. They are not
-- recoverable as sends (the events they describe are days old and re-sending would confuse
-- people), but they should not read as successful delivery either.
update notification_outbox
set skip_reason = 'never_actually_sent_pre_0013'
where status = 'sent' and channel_resolved = 'console';
