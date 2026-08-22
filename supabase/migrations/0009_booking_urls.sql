-- Dentally online-booking portals per practice (provided by Ruhith, 2026-08-22).
-- Note: these portals return CloudFront 403 when probed from outside the UK (likely
-- geo-restriction); verify from a UK connection if a patient reports a blocked page.

update practices set booking_url = 'https://gmdental-ashford.portal.dental/' where name = 'Ashford';
update practices set booking_url = 'https://gmdentalbarnet.portal.dental/' where name = 'Barnet';
update practices set booking_url = 'https://fixed-teeth-solutions.portal.dental/' where name = 'Bexleyheath';
update practices set booking_url = 'https://gmdental-rochester.portal.dental/' where name = 'Rochester';

-- Warwick Lodge retired from the app (Ruhith, 2026-08-22). Deactivated, not deleted —
-- existing referrals/payouts may reference it.
update practices set active = false where name = 'Warwick Lodge';
