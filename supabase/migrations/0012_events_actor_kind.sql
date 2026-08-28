-- Who acted, not just their id. admin_users.id and users.id are separate id spaces, so an
-- events row carrying only actor_id can't say which table to look the actor up in — and rows
-- written by the sync worker / cron sweeps have no actor id at all. Nullable on purpose:
-- historic rows predate the column and stay null rather than being guessed at.
alter table events add column actor_kind text check (actor_kind in ('user','admin','system'));
