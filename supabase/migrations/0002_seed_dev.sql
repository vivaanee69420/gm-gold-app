-- Dev/demo seed: six practices, the £20 launch rule, settings, and one demo referrer
-- so the app has a live counterpart to its screens. Idempotent by construction
-- (runs once via the _migrations ledger).

insert into practices (name) values
  ('Sidcup'), ('Bexley'), ('Bromley'), ('Dartford'), ('Orpington'), ('Sevenoaks');

insert into reward_rules (practice_id, type, amount_pennies, created_by)
values (null, 'fixed', 2000, 'seed'); -- global £20

insert into app_settings (key, value, updated_by) values
  ('payout_threshold_pennies', '10000', 'seed'),
  ('payout_expiry_days', '14', 'seed'),
  ('otp_channel_mode', 'dev', 'seed');
