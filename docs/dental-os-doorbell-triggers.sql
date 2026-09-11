-- Dental OS: ring the GM Referral doorbell when appointments change
-- ============================================================================
-- Run by:  whoever owns the Dental OS database (NOT gm_referral_api / gm_referral_reader —
--          our role has SELECT only, no CREATE on public, and is not superuser).
-- Written: 2026-09-11
--
-- WHY THIS FILE EXISTS
--
-- public.gmref_doorbell() is ALREADY installed in Dental OS and has been for some time. What
-- was never installed is any trigger that calls it — `information_schema.triggers` returns
-- nothing for `appointments` or `contacts`. So the doorbell has never rung once, and the GM
-- Referral sync has been running purely on its 15-minute cron.
--
-- That is the whole cause of "appointment checking is slow": a friend can book and wait up to
-- 15 minutes before the referral reaches the pipeline. With these triggers it is seconds.
--
-- One ring covers everything. The API's runSync() does the whole pass on every invocation —
-- booking detection, existing-patient flagging (FR-11) and refund clawback — so there is no
-- need for a separate trigger per concern. It also holds a global advisory lock and, if the
-- doorbell rings mid-pass, queues exactly one follow-up run, so ringing often is safe.
--
-- STATEMENT-level, not ROW-level, on purpose. Dental OS is fed by Dentally webhooks in
-- batches; a row-level trigger would fire one HTTP POST per row and could produce thousands
-- of pings for one import. FOR EACH STATEMENT fires once per write regardless of row count,
-- which is all the API needs — the doorbell carries no payload it acts on, it only says
-- "something changed, come and look".
--
-- gmref_doorbell() already swallows its own exceptions, so a network failure or an API outage
-- can never fail or roll back the Dental OS write that rang it.

begin;

-- Appointments: the one that matters. New and changed bookings are what move a referral onto
-- the pipeline board, and since 2026-09-11 a referral does not appear at all until Dental OS
-- confirms an appointment for it.
drop trigger if exists gmref_doorbell_appointments on public.appointments;

create trigger gmref_doorbell_appointments
  after insert or update or delete on public.appointments
  for each statement
  execute function public.gmref_doorbell();

-- Contacts: a new or corrected phone number / email is what lets a referral match at all.
-- Worth ringing on, because a contact whose phone was fixed after booking would otherwise
-- wait for the cron to notice.
drop trigger if exists gmref_doorbell_contacts on public.contacts;

create trigger gmref_doorbell_contacts
  after insert or update on public.contacts
  for each statement
  execute function public.gmref_doorbell();

commit;


-- ---------------------------------------------------------------------------
-- VERIFY (run after committing)
-- ---------------------------------------------------------------------------
-- 1. The triggers exist:
--
--      select event_object_table, trigger_name, event_manipulation, action_timing
--        from information_schema.triggers
--       where trigger_name like 'gmref_doorbell%'
--       order by event_object_table, trigger_name;
--
-- 2. pg_net is still installed (the doorbell needs it):
--
--      select extname from pg_extension where extname = 'pg_net';
--
-- 3. The ring actually lands. Touch a row and watch the GM Referral API's Railway logs for a
--    line reading  [dentally] sync {"trigger":"webhook", ...}  within a few seconds:
--
--      update public.appointments set updated_at = updated_at where id = (
--        select id from public.appointments order by updated_at desc limit 1
--      );
--
--    pg_net is asynchronous, so the POST is queued rather than sent inline. Its outcome is
--    visible in Dental OS itself:
--
--      select id, status_code, error_msg, created
--        from net._http_response order by created desc limit 5;
--
--    A 204 is success. A 401 means the x-gmref-secret baked into gmref_doorbell() no longer
--    matches DENTALLY_WEBHOOK_SECRET on the API — rotate both together, never one alone.


-- ---------------------------------------------------------------------------
-- TO REMOVE
-- ---------------------------------------------------------------------------
--   drop trigger if exists gmref_doorbell_appointments on public.appointments;
--   drop trigger if exists gmref_doorbell_contacts    on public.contacts;
--
-- Dropping them is safe: the API falls back to its 15-minute cron, which is how it has been
-- running all along. Nothing is lost, it just gets slower again.
