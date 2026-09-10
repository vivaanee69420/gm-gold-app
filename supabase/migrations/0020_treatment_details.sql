-- What was actually agreed, before any commission is released (2026-09-10).
--
-- Treatment started is the moment this scheme pays out, and until now it could fire on a card
-- carrying nothing but a name. These three facts are what a payment needs to be defensible
-- later: what is being done, who is doing it, and what it is worth. updateStatus refuses the
-- move to either crediting stage while any of them is missing.
--
-- Nullable, because they are filled in as the practice learns them — the gate is at the move,
-- not at the keystroke.
alter table referrals add column if not exists doctor_name text;
alter table referrals add column if not exists treatment_value_pennies integer;
