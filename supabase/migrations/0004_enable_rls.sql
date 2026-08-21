-- Lock the tables away from Supabase's auto-generated REST/GraphQL surface (DESIGN: "RLS on").
-- All access goes through the Express API, which connects as the table owner and is unaffected
-- by RLS. With RLS enabled and NO policies, PostgREST's anon/authenticated roles can read nothing.

alter table practices enable row level security;
alter table users enable row level security;
alter table referral_codes enable row level security;
alter table referrals enable row level security;
alter table reward_rules enable row level security;
alter table app_settings enable row level security;
alter table wallet_ledger enable row level security;
alter table payout_requests enable row level security;
alter table events enable row level security;
alter table otp_deliveries enable row level security;
alter table notification_outbox enable row level security;
alter table analytics_events enable row level security;
alter table completion_proposals enable row level security;
alter table sync_state enable row level security;
alter table dentally_patient_index enable row level security;
-- The migration ledger exists before any file runs (created by db.js migrate()).
alter table _migrations enable row level security;
