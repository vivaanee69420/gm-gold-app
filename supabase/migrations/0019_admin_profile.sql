-- Team members are people, not just logins (2026-09-10).
--
-- The team screen shows a name and a phone next to every account, and the owner edits them
-- there. Until now an admin_users row carried only an email, so the list could only ever show
-- an email — and reception calling a colleague had nowhere to look their number up.
--
-- Email stays the identity: it is what you sign in with and what the audit log records, so it
-- is not editable from the team screen. Name and phone are labels on top of it.
alter table admin_users add column if not exists name text;
alter table admin_users add column if not exists phone text;
