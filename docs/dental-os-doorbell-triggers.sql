-- ============================================================================
-- GM Referral — install and verify the Dental OS doorbell, in one script
-- ============================================================================
--
-- Run as:   the Dental OS database OWNER (or any role with CREATE on public).
--           NOT gm_referral_reader — that role has SELECT only, which is why the
--           GM Referral API cannot install this itself.
-- Written:  2026-09-11
-- Safe to:  re-run any time. Every step is idempotent.
--
-- WHAT THIS IS FOR
--
-- Dentally delivers appointments to Dental OS by webhook. This script makes the
-- moment that row lands also notify the GM Referral API, so a booking reaches the
-- referral pipeline in seconds instead of waiting for the API's 15-minute cron.
--
-- public.gmref_doorbell() is ALREADY installed here and has been for some time —
-- SECURITY DEFINER, calls net.http_post() to the API, and swallows its own errors
-- so it can never fail or roll back the write that rang it. What was never
-- installed is any trigger that calls it: information_schema.triggers returns
-- nothing for appointments or contacts. That is the whole reason detection is slow.
--
-- This script only attaches the function. It does NOT recreate it — the function
-- holds the API URL and the shared secret, and recreating it from anywhere other
-- than the real values would break the link silently.
--
-- TWO CHOICES WORTH KNOWING
--
-- FOR EACH STATEMENT, not FOR EACH ROW. Dental OS is fed in batches; a row-level
-- trigger would fire one HTTP POST per row and could produce thousands of pings
-- for a single import. Statement-level fires once per write whatever the row
-- count, which is all the API needs — the doorbell carries no payload it acts on,
-- it only says "something changed, come and look".
--
-- DELETE is included on appointments. A booking cancelled by deletion should also
-- prompt a re-check, or a referral sits at Booked against an appointment that no
-- longer exists.
--
-- No explicit BEGIN/COMMIT: some SQL consoles (Supabase's included) already wrap a
-- script in one transaction and error on a nested COMMIT. The steps are idempotent
-- instead, so a partial run is fixed by running it again.


-- ---------------------------------------------------------------------------
-- 1. Preflight — fail loudly now rather than silently later
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'pg_net is not installed: gmref_doorbell() has no way to make its HTTP call';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where p.proname = 'gmref_doorbell' and n.nspname = 'public'
  ) then
    raise exception 'public.gmref_doorbell() is missing. Do NOT recreate it from this script — '
      'it holds the API URL and shared secret. Ask the GM Referral side for the real definition.';
  end if;

  if not has_schema_privilege(current_user, 'public', 'CREATE') then
    raise exception 'role % cannot CREATE in schema public — run this as the Dental OS owner', current_user;
  end if;

  raise notice 'preflight OK as role %', current_user;
end $$;


-- ---------------------------------------------------------------------------
-- 2. Install
-- ---------------------------------------------------------------------------
drop trigger if exists gmref_doorbell_appointments on public.appointments;

create trigger gmref_doorbell_appointments
  after insert or update or delete on public.appointments
  for each statement
  execute function public.gmref_doorbell();

drop trigger if exists gmref_doorbell_contacts on public.contacts;

create trigger gmref_doorbell_contacts
  after insert or update on public.contacts
  for each statement
  execute function public.gmref_doorbell();


-- ---------------------------------------------------------------------------
-- 3. Confirm they exist
-- ---------------------------------------------------------------------------
do $$
declare n int;
begin
  select count(*) into n
    from information_schema.triggers
   where trigger_name like 'gmref_doorbell%';
  if n = 0 then
    raise exception 'no gmref_doorbell triggers found after install — something dropped them';
  end if;
  raise notice 'installed: % trigger event rows', n;
end $$;

select event_object_table as "table",
       trigger_name,
       event_manipulation as event,
       action_timing      as timing
  from information_schema.triggers
 where trigger_name like 'gmref_doorbell%'
 order by event_object_table, trigger_name, event_manipulation;


-- ---------------------------------------------------------------------------
-- 4. Ring the bell for real
-- ---------------------------------------------------------------------------
-- Sets updated_at to its own value on a single row: the statement trigger fires,
-- no data changes, and no Dentally state is touched. (A statement-level trigger
-- fires even when no row actually changes.)
update public.appointments
   set updated_at = updated_at
 where id = (select id from public.appointments order by updated_at desc limit 1);

-- net.http_post queues the request and sends it after commit, asynchronously.
select pg_sleep(5);


-- ---------------------------------------------------------------------------
-- 5. Did it land?
-- ---------------------------------------------------------------------------
--   204            -> working. Look for [dentally] sync {"trigger":"webhook"...}
--                     in the GM Referral API's Railway logs within a few seconds.
--   401            -> the secret inside gmref_doorbell() no longer matches
--                     DENTALLY_WEBHOOK_SECRET on the API. Rotate BOTH together.
--   timeout/error  -> check error_msg; the API may be asleep or the URL stale.
--   no rows at all -> pg_net's worker is not running. On Supabase, check the
--                     pg_net extension is enabled and the project is not paused.
select id, status_code, error_msg, created
  from net._http_response
 order by created desc
 limit 5;


-- ---------------------------------------------------------------------------
-- TO REMOVE
-- ---------------------------------------------------------------------------
-- Safe at any time: the API falls back to its 15-minute cron, which is how it has
-- been running all along. Nothing is lost, detection just gets slower again.
--
--   drop trigger if exists gmref_doorbell_appointments on public.appointments;
--   drop trigger if exists gmref_doorbell_contacts    on public.contacts;
