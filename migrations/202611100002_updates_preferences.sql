-- LOCAL: apply after 202611100001_community_profiles.sql. Non-destructive and safe to re-run.
-- "Bulletin" became "Updates": people's read state is now a time (server clock), so the menu can
-- count every post published since. The pop-up setting keeps its value under the new name.
-- The old bulletin_seen column is no longer used; it is left in place (dropping it needs approval).
begin;

alter table public.accounts add column if not exists updates_seen_at timestamptz;

do $$
begin
  if exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'accounts' and column_name = 'bulletin_popup')
    and not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'accounts' and column_name = 'updates_popup') then
    alter table public.accounts rename column bulletin_popup to updates_popup;
  end if;
end $$;
alter table public.accounts add column if not exists updates_popup boolean not null default true;

-- Null leaves a setting unchanged. p_updates_seen = true records "read every Update up to now".
drop function if exists public.update_account_preferences(uuid, boolean, text, boolean);
create or replace function public.update_account_preferences(p_user uuid, p_marketing boolean,
  p_updates_seen boolean, p_updates_popup boolean)
returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare result public.accounts;
begin
  update public.accounts set
    marketing_opt_in = coalesce(p_marketing, marketing_opt_in),
    updates_seen_at = case when p_updates_seen then now() else updates_seen_at end,
    updates_popup = coalesce(p_updates_popup, updates_popup),
    updated_at = now()
  where id = p_user and status = 'active' returning * into result;
  if not found then raise exception 'unknown_account'; end if;
  return result;
end $$;

revoke all on function public.update_account_preferences(uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.update_account_preferences(uuid, boolean, boolean, boolean) to service_role;

notify pgrst, 'reload schema';
commit;
