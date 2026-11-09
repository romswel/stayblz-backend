-- LOCAL: apply after 202611090001_account_foundation.sql. Non-destructive.
-- Community profile (who you are in racing), Terms acceptance and personal preferences.
begin;

-- Community roles describe a person; they never grant access. Keys are stable;
-- labels live in the apps. Older keys (owner, trainer, jockey, staff, fan, other) stay valid.
create function public.stayblz_community_roles() returns text[]
language sql immutable set search_path = '' as $$
  select array[
    'owner', 'syndicate', 'breeder', 'bloodstock',
    'trainer', 'assistant_trainer', 'jockey', 'apprentice', 'exercise_rider', 'jockey_agent',
    'staff', 'farrier', 'vet', 'equine_therapist',
    'official', 'track_staff',
    'handicapper', 'media',
    'fan', 'newcomer',
    'other'
  ]::text[]
$$;

alter table public.accounts drop constraint accounts_racing_role_check;
alter table public.accounts
  add constraint accounts_racing_role_check
    check (racing_role = '' or racing_role = any (public.stayblz_community_roles())),
  add column community_roles text[] not null default '{}'
    check (cardinality(community_roles) <= 3 and community_roles <@ public.stayblz_community_roles()),
  add column organisation text not null default '' check (length(organisation) <= 100),
  add column city text not null default '' check (length(city) <= 80),
  add column bio text not null default '' check (length(bio) <= 280),
  add column terms_version text not null default '' check (length(terms_version) <= 20),
  add column terms_accepted_at timestamptz,
  add column marketing_opt_in boolean not null default false,
  add column updates_seen_at timestamptz,
  add column updates_popup boolean not null default true;

-- Same signature as before; now also copies the new sign-up details (cleaned) once.
create or replace function public.ensure_account(p_user uuid) returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare result public.accounts; created integer; meta jsonb; roles text[];
begin
  select * into result from public.accounts where id = p_user;
  if found then return result; end if;
  select coalesce(u.raw_user_meta_data, '{}'::jsonb) into meta from auth.users u where u.id = p_user;
  select coalesce(array_agg(distinct r), '{}') into roles
  from jsonb_array_elements_text(case when jsonb_typeof(meta -> 'community_roles') = 'array' then meta -> 'community_roles' else '[]'::jsonb end) r
  where r = any (public.stayblz_community_roles()) and r is distinct from meta ->> 'racing_role';
  insert into public.accounts (id, email, first_name, last_name, country, racing_role, community_roles,
    organisation, city, terms_version, terms_accepted_at, marketing_opt_in)
  select u.id,
    left(lower(coalesce(u.email, '')), 254),
    left(btrim(regexp_replace(coalesce(meta ->> 'first_name', ''), '[[:cntrl:]<>]', '', 'g')), 60),
    left(btrim(regexp_replace(coalesce(meta ->> 'last_name', ''), '[[:cntrl:]<>]', '', 'g')), 60),
    case when coalesce(meta ->> 'country', '') ~ '^[A-Z]{2}$' then meta ->> 'country' else '' end,
    case when meta ->> 'racing_role' = any (public.stayblz_community_roles()) then meta ->> 'racing_role' else '' end,
    roles[1:3],
    left(btrim(regexp_replace(coalesce(meta ->> 'organisation', ''), '[[:cntrl:]<>]', '', 'g')), 100),
    left(btrim(regexp_replace(coalesce(meta ->> 'city', ''), '[[:cntrl:]<>]', '', 'g')), 80),
    left(coalesce(meta ->> 'terms_version', ''), 20),
    case when coalesce(meta ->> 'terms_accepted_at', '') ~ '^\d{4}-\d{2}-\d{2}T'
      then (meta ->> 'terms_accepted_at')::timestamptz end,
    coalesce(meta ->> 'marketing_opt_in', '') = 'true'
  from auth.users u where u.id = p_user
  on conflict (id) do nothing;
  get diagnostics created = row_count;
  select * into result from public.accounts where id = p_user;
  if not found then raise exception 'unknown_account'; end if;
  if created > 0 then
    insert into public.account_events (account_id, actor_id, event, detail)
    values (p_user, p_user, 'account.created', jsonb_build_object('termsVersion', result.terms_version));
  end if;
  return result;
end $$;

drop function public.update_account_profile(uuid, text, text, text, text);
create function public.update_account_profile(p_user uuid, p_first text, p_last text, p_country text,
  p_racing_role text, p_community_roles text[], p_organisation text, p_city text, p_bio text)
returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare result public.accounts;
begin
  -- The superadmin profile is fixed (see docs/accounts-and-security.md).
  update public.accounts set first_name = btrim(p_first), last_name = btrim(p_last), country = p_country,
    racing_role = p_racing_role, community_roles = coalesce(p_community_roles, '{}'),
    organisation = btrim(p_organisation), city = btrim(p_city), bio = btrim(p_bio), updated_at = now()
  where id = p_user and status = 'active' and platform_role <> 'superadmin' returning * into result;
  if not found then raise exception 'not_allowed'; end if;
  return result;
end $$;

-- Null leaves a setting unchanged.
-- p_updates_seen = true records "read every Update up to now" (server time, never the client's).
create function public.update_account_preferences(p_user uuid, p_marketing boolean,
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

revoke all on function public.stayblz_community_roles(),
  public.update_account_profile(uuid, text, text, text, text, text[], text, text, text),
  public.update_account_preferences(uuid, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.stayblz_community_roles(),
  public.update_account_profile(uuid, text, text, text, text, text[], text, text, text),
  public.update_account_preferences(uuid, boolean, boolean, boolean) to service_role;

notify pgrst, 'reload schema';
commit;
