-- Indexes the read paths were missing (2026-09-12).
--
-- Found by benchmarking the patient-facing endpoints against 50k referrals / 500k events on
-- PGlite. Most were already fine: /me, /referrals/mine, /wallet and /practices were flat from
-- 1k to 50k rows, because each is keyed by a user id that already has an index. Two were not.

-- 1. The booking-window sweep.
--
-- GET /referrals/referred-status went 1.7ms -> 14.2ms across that 50x, an 8x rise on a 50x
-- data increase, because referredStatusFor calls expireUnbookedReferrals() and that UPDATE had
-- no usable index: referrals_referrer_status is (referrer_id, status), which the sweep's
-- predicate cannot use. So every time a referred patient opened the app, Postgres scanned the
-- whole referrals table.
--
-- Partial, and matching the sweep's WHERE exactly, so the index holds only the handful of rows
-- that are candidates rather than a copy of the table. When nothing has expired it returns no
-- rows, and an UPDATE matching no rows writes nothing and locks nothing — which is what makes
-- keeping the sweep on the read path acceptable rather than merely tolerable.
create index if not exists referrals_expiry_sweep
  on referrals (created_at)
  where status in ('new','contacted') and appointment_dentally_id is null;

-- 2. The audit log had no index of any kind.
--
-- `events` grows faster than anything else here — every status change, credit, note, login and
-- review decision writes a row — and patientDetail reads it back with
-- `where entity_type = ... and entity_id = ...`, so opening one patient record scanned every
-- event ever recorded. Fine at 41 rows in dev; seconds at a million.
--
-- created_at descending because every consumer wants newest-first (the record's timeline).
create index if not exists events_entity
  on events (entity_type, entity_id, created_at desc);

-- 3. Newest-first listing.
--
-- /admin/referrals, /admin/patients and /referrals/mine all `order by created_at desc`. The
-- first two are now paginated, but the sort still needs support or Postgres sorts the whole
-- table to return the first page.
create index if not exists referrals_created_at
  on referrals (created_at desc);
