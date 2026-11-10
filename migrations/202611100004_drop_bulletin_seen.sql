-- LOCAL: apply after 202611100003_site_updates.sql. Approved by the user on 2026-11-10.
-- Removes the unused "Bulletin" read marker. Updates use updates_seen_at instead; nothing reads this column.
begin;
alter table public.accounts drop column if exists bulletin_seen;
notify pgrst, 'reload schema';
commit;
