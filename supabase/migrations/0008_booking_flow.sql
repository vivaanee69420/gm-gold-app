-- Booking-first referred flow (2026-08-22): the referred friend leaves name/phone/email,
-- is redirected to the practice's Dentally online-booking page, and the booked
-- appointment flows back via the Dentally sync to confirm in-app.

alter table referrals add column if not exists referred_email text;
alter table referrals add column if not exists appointment_dentally_id text;
alter table referrals add column if not exists appointment_starts_at timestamptz;

-- The form no longer asks for a treatment interest; the column stays for admin
-- reporting and older rows.
alter table referrals alter column treatment_interest set default 'not_sure';

-- Per-practice Dentally online-booking page. Null = no online booking yet; the
-- app falls back to "the practice will call you".
alter table practices add column if not exists booking_url text;
