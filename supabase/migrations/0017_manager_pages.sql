-- Per-manager tab access (2026-09-10). Until now every manager saw the same three screens.
-- The owner now decides, per account, which of them that manager gets.
--
-- null means "every manager page", which is what every existing manager already had — this
-- migration changes nobody's access. An empty array is a real answer, not a missing one: it
-- means a manager who can sign in and change their password and nothing else.
alter table admin_users add column if not exists pages text[];
