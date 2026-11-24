-- LOCAL until a release is approved. Apply after 202611220001_stallions.sql. Safe to re-run; adds, never removes data.
--
-- Virtual Stayblz × race data (FormFav, through lib/formFavIndex.ts):
--
--   * Virtual Stayblz horses can come from race data (source 'formfav', the "Racing horses" tab), and a horse typed in
--     by hand can be linked to one. An owned horse (owner_horses) can be linked too; one owner per race-data horse.
--     A link is (formfav_code, formfav_name) plus formfav_key = '<code>|<folded name>' written by the API, which is
--     what everything matches on (the API's folding, not SQL lower(), so every name compares the same way).
--   * While linked, the details race data knows (trainer, sire, dam, sex, foaled year, breed) are kept up to date
--     and locked by the API, and every final result is added to the horse's log (formfav_ref = one race start).
--     Unlinking keeps the values and turns those log rows into ordinary ones.
--   * Alerts for linked horses (entered, scratched/abandoned, result, jockey/trainer change) go to the list's owner,
--     every member of a stable list, or the owned horse's owner. Each person can mute a horse.
--   * Follower counts: how many distinct people track a horse (personal lists + every member of a stable list).
--     community_public_horses_v2 orders Public horses by it; community_public_horses stays for the backend that is
--     live while this is applied (drop it in a later clean-up).
--
-- RLS on, no browser grants; everything through the service role.

begin;

-- ---------- Links on Virtual Stayblz horses ----------
alter table public.virtual_horses drop constraint if exists virtual_horses_source_check;
alter table public.virtual_horses add constraint virtual_horses_source_check
  check (source in ('community', 'racing', 'manual', 'formfav'));
alter table public.virtual_horses
  add column if not exists formfav_name text check (formfav_name is null or char_length(formfav_name) between 1 and 100),
  add column if not exists formfav_code text check (formfav_code is null or formfav_code in ('gallops', 'harness')),
  add column if not exists formfav_key text check (formfav_key is null or char_length(formfav_key) between 3 and 120),
  add column if not exists formfav_runner_id bigint,
  add column if not exists formfav_linked_at timestamptz,
  add column if not exists formfav_linked_by uuid references public.accounts(id) on delete set null,
  add column if not exists formfav_synced_at timestamptz;
alter table public.virtual_horses drop constraint if exists virtual_horses_formfav_link;
alter table public.virtual_horses add constraint virtual_horses_formfav_link check (
  (formfav_key is null) = (formfav_name is null) and (formfav_key is null) = (formfav_code is null)
  and (formfav_key is null) = (formfav_linked_at is null)
  and (source <> 'formfav' or formfav_key is not null)
  and (formfav_key is null or source in ('formfav', 'manual')));
create unique index if not exists virtual_horses_user_formfav on public.virtual_horses (user_id, formfav_key)
  where user_id is not null and formfav_key is not null;
create unique index if not exists virtual_horses_stable_formfav on public.virtual_horses (stable_id, formfav_key)
  where stable_id is not null and formfav_key is not null;
create index if not exists virtual_horses_formfav_key on public.virtual_horses (formfav_key) where formfav_key is not null;

-- ---------- Links on owned horses ----------
alter table public.owner_horses
  add column if not exists formfav_name text check (formfav_name is null or char_length(formfav_name) between 1 and 100),
  add column if not exists formfav_code text check (formfav_code is null or formfav_code in ('gallops', 'harness')),
  add column if not exists formfav_key text check (formfav_key is null or char_length(formfav_key) between 3 and 120),
  add column if not exists formfav_runner_id bigint,
  add column if not exists formfav_linked_at timestamptz,
  add column if not exists formfav_synced_at timestamptz,
  add column if not exists formfav_alerts boolean not null default true;
alter table public.owner_horses drop constraint if exists owner_horses_formfav_link;
alter table public.owner_horses add constraint owner_horses_formfav_link check (
  (formfav_key is null) = (formfav_name is null) and (formfav_key is null) = (formfav_code is null)
  and (formfav_key is null) = (formfav_linked_at is null));
-- One owner per race-data horse: the first to link it claims it.
create unique index if not exists owner_horses_formfav on public.owner_horses (formfav_key) where formfav_key is not null;

-- ---------- Log rows that came from race data (one per race start) ----------
alter table public.virtual_horse_entries add column if not exists formfav_ref uuid;
create unique index if not exists virtual_horse_entries_formfav on public.virtual_horse_entries (virtual_horse_id, formfav_ref)
  where formfav_ref is not null;
alter table public.owner_horse_records add column if not exists formfav_ref uuid;
create unique index if not exists owner_horse_records_formfav on public.owner_horse_records (horse_id, formfav_ref)
  where formfav_ref is not null;

-- ---------- Alert state ----------
-- A person who doesn't want alerts for one horse of a list (personal or stable).
create table if not exists public.virtual_horse_mutes (
  horse_id uuid not null references public.virtual_horses(id) on delete cascade,
  user_id uuid not null references public.accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (horse_id, user_id)
);
-- Each upcoming entry of a followed horse when first seen, with its rider and trainer, so a restart never re-sends
-- "entered" and a later change of jockey/trainer can be told. Kept until 3 days after the race.
create table if not exists public.formfav_entry_seen (
  ref uuid primary key,
  race_date date not null,
  jockey text not null default '',
  jockey_key text not null default '',
  trainer text not null default '',
  trainer_key text not null default '',
  seen_at timestamptz not null default now()
);
alter table public.virtual_horse_mutes enable row level security;
alter table public.formfav_entry_seen enable row level security;
revoke all on public.virtual_horse_mutes from public, anon, authenticated;
revoke all on public.formfav_entry_seen from public, anon, authenticated;
grant select, insert, update, delete on public.virtual_horse_mutes to service_role;
grant select, insert, update, delete on public.formfav_entry_seen to service_role;

-- ---------- Alert kind: jockey/trainer change ----------
alter table public.chat_alerts drop constraint if exists chat_alerts_kind_check;
alter table public.chat_alerts add constraint chat_alerts_kind_check check (kind in (
  'message', 'request', 'mention', 'reply', 'reaction', 'group_added', 'friend_request', 'friend_accepted',
  'request_accepted', 'race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change'));
drop index if exists public.chat_alerts_racing_once;
create unique index if not exists chat_alerts_racing_once on public.chat_alerts (user_id, kind, message_id)
  where kind in ('race_entry', 'race_scratch', 'race_result', 'workout', 'race_change');

create or replace function public.chat_alert_allowed(n public.notification_settings, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(n.enabled, false) and case
    when p_kind in ('message', 'group_added') then n.chat_messages
    when p_kind in ('request', 'friend_request', 'friend_accepted', 'request_accepted') then n.chat_requests
    when p_kind in ('mention', 'reply') then n.chat_mentions
    when p_kind = 'reaction' then n.chat_reactions
    when p_kind in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change') then true
    else false end
$$;

-- Same as 202611210002, plus 'race_change' among the kinds only newer apps show (racing=1).
create or replace function public.chat_alerts_list(p_user uuid, p_since timestamptz, p_limit integer,
  p_racing boolean default false) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(public.chat_alert_out(a) order by a.created_at desc)
      from public.chat_alerts a
      where a.id in (
        select b.id from public.chat_alerts b
        where b.user_id = p_user and (p_since is null or b.created_at > p_since)
          and (coalesce(p_racing, false) or b.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change'))
          and (b.chat_kind is distinct from 'team' or exists (
            select 1 from public.stable_memberships sm where sm.stable_id = b.stable_id and sm.user_id = p_user))
        order by b.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 50))), '[]'),
    'unread', (select count(*) from public.chat_alerts a where a.user_id = p_user and a.read_at is null
      and (coalesce(p_racing, false) or a.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change'))
      and (a.chat_kind is distinct from 'team' or exists (
        select 1 from public.stable_memberships sm where sm.stable_id = a.stable_id and sm.user_id = p_user))))
$$;

-- A jockey/trainer change follows the "entries" switch in My racing → Alert settings.
create or replace function public.racing_alert_wanted(p_user uuid, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select case p_kind
      when 'race_entry' then p.entry_alerts when 'race_scratch' then p.entry_alerts when 'race_change' then p.entry_alerts
      when 'race_result' then p.result_alerts when 'workout' then p.workout_alerts else false end
    from public.racing_preferences p where p.user_id = p_user), true)
$$;

-- ---------- Follower counts ----------
-- Who tracks each Virtual Stayblz horse: the list's owner, or every active member of the stable that holds it.
create or replace view public.virtual_horse_followers with (security_invoker = true) as
  select vh.id as virtual_horse_id, vh.user_id
    from public.virtual_horses vh join public.accounts a on a.id = vh.user_id and a.status = 'active'
   where vh.user_id is not null
  union
  select vh.id, m.user_id
    from public.virtual_horses vh join public.stable_memberships m on m.stable_id = vh.stable_id
    join public.accounts a on a.id = m.user_id and a.status = 'active'
   where vh.stable_id is not null;
revoke all on public.virtual_horse_followers from public, anon, authenticated;
grant select on public.virtual_horse_followers to service_role;

-- Distinct people tracking each race-data horse (only horses someone tracks), keyed like formfav_key.
create or replace function public.formfav_follower_counts() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', c.formfav_key, 'followers', c.n) order by c.n desc, c.formfav_key), '[]'::jsonb)
  from (
    select vh.formfav_key, count(distinct f.user_id)::int as n
      from public.virtual_horses vh join public.virtual_horse_followers f on f.virtual_horse_id = vh.id
     where vh.formfav_key is not null
     group by vh.formfav_key
  ) c
$$;

-- community_public_horses (202611200001) with `followers` (distinct people tracking the horse in Virtual Stayblz),
-- most followed first, then name. Keyset paging on (followers desc, lower(name), id).
create or replace function public.community_public_horses_v2(
  p_viewer uuid, p_query text, p_breed text, p_sex text, p_status text, p_year_from int, p_year_to int,
  p_raced boolean, p_before_followers int, p_before_name text, p_before_id uuid, p_limit int
) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.followers desc, x.sort_name, x.id), '[]'::jsonb) from (
    select h.*, lower(h.name) as sort_name, fc.n as followers from public.owner_horses h
    join public.accounts a on a.id = h.owner_id and a.status = 'active'
    left join public.community_profiles p on p.user_id = h.owner_id
    cross join lateral (
      select count(distinct f.user_id)::int as n
        from public.virtual_horses vh join public.virtual_horse_followers f on f.virtual_horse_id = vh.id
       where vh.community_horse_id = h.id
    ) fc
    where h.owner_id <> p_viewer
      and (h.visibility = 'members' or (h.visibility = 'inherit' and coalesce(p.inventory_visibility, 'members') = 'members'))
      and (coalesce(btrim(p_query), '') = '' or h.name ilike
        '%' || replace(replace(replace(left(btrim(p_query), 60), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      and (coalesce(p_breed, '') = '' or lower(btrim(h.breed)) = lower(btrim(p_breed)))
      and (coalesce(p_sex, '') = '' or h.sex = p_sex)
      and (coalesce(p_status, '') = '' or h.status = p_status)
      and (p_year_from is null or h.foaled_year >= p_year_from)
      and (p_year_to is null or h.foaled_year <= p_year_to)
      and (not coalesce(p_raced, false) or exists (select 1 from public.owner_horse_records r where r.horse_id = h.id))
      and (p_before_name is null or fc.n < p_before_followers
        or (fc.n = p_before_followers and (lower(h.name), h.id) > (p_before_name, p_before_id)))
    order by fc.n desc, lower(h.name), h.id
    limit least(greatest(coalesce(p_limit, 24), 1), 61)
  ) x;
$$;

-- ---------- Sync (lib/formFavSync.ts) ----------
-- Every linked horse: Virtual Stayblz horses and owned horses of active owners.
create or replace function public.formfav_linked_horses() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x ->> 'key', x ->> 'id'), '[]'::jsonb) from (
    select jsonb_build_object('kind', 'virtual', 'id', vh.id, 'key', vh.formfav_key, 'name', vh.formfav_name,
             'code', vh.formfav_code, 'runnerId', vh.formfav_runner_id, 'linkedAt', vh.formfav_linked_at,
             'syncedAt', vh.formfav_synced_at, 'sire', vh.sire, 'dam', vh.dam, 'sex', vh.sex,
             'foaledYear', vh.foaled_year) as x
      from public.virtual_horses vh where vh.formfav_key is not null
    union all
    select jsonb_build_object('kind', 'owned', 'id', h.id, 'key', h.formfav_key, 'name', h.formfav_name,
             'code', h.formfav_code, 'runnerId', h.formfav_runner_id, 'linkedAt', h.formfav_linked_at,
             'syncedAt', h.formfav_synced_at, 'sire', h.sire, 'dam', h.dam, 'sex', h.sex,
             'foaledYear', h.foaled_year)
      from public.owner_horses h join public.accounts a on a.id = h.owner_id and a.status = 'active'
     where h.formfav_key is not null
  ) s
$$;

-- Updates a linked horse's details from race data and adds its final results to the log.
--   p_kind    'virtual' | 'owned'
--   p_fields  only the keys to set: trainer, sire, dam, sex, foaledYear, breed, runnerId
--   p_runs    [{ref, date, track, raceName, distance, finish, fieldSize}]
-- A run already logged (same ref) is skipped; a hand-written race row on the same day and track gets the ref
-- (filling in only what it left empty) instead of a duplicate. Returns {added, attached}, or null when the horse
-- isn't linked (any more).
create or replace function public.formfav_apply(p_kind text, p_id uuid, p_fields jsonb, p_runs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  f jsonb := coalesce(p_fields, '{}'::jsonb);
  r jsonb;
  added int := 0;
  attached int := 0;
  logged int;
  v_owner uuid;
  v_ref uuid;
  v_date date;
  v_track text;
  v_name text;
  v_distance text;
  v_finish int;
  v_field int;
  v_max int := case when p_kind = 'owned' then 30 else 40 end;
  v_year int := case when f ->> 'foaledYear' ~ '^\d{4}$' then (f ->> 'foaledYear')::int end;
  v_runner bigint := case when f ->> 'runnerId' ~ '^\d{1,15}$' then (f ->> 'runnerId')::bigint end;
  hit uuid;
begin
  if p_kind = 'virtual' then
    update public.virtual_horses set
      trainer = case when f ? 'trainer' then left(f ->> 'trainer', 80) else trainer end,
      sire = case when f ? 'sire' then left(f ->> 'sire', 80) else sire end,
      dam = case when f ? 'dam' then left(f ->> 'dam', 80) else dam end,
      sex = case when f ? 'sex' then left(f ->> 'sex', 20) else sex end,
      foaled_year = case when v_year between 1900 and 2100 then v_year else foaled_year end,
      breed = case when f ? 'breed' then left(f ->> 'breed', 60) else breed end,
      formfav_runner_id = coalesce(v_runner, formfav_runner_id),
      formfav_synced_at = now()
    where id = p_id and formfav_key is not null;
    if not found then return null; end if;
    select count(*) into logged from public.virtual_horse_entries where virtual_horse_id = p_id;
  elsif p_kind = 'owned' then
    update public.owner_horses set
      trainer = case when f ? 'trainer' then left(f ->> 'trainer', 80) else trainer end,
      sire = case when f ? 'sire' then left(f ->> 'sire', 80) else sire end,
      dam = case when f ? 'dam' then left(f ->> 'dam', 80) else dam end,
      sex = case when f ->> 'sex' in ('', 'colt', 'filly', 'mare', 'stallion', 'gelding', 'ridgling') then f ->> 'sex' else sex end,
      foaled_year = case when v_year between 1980 and extract(year from now())::int then v_year else foaled_year end,
      breed = case when f ? 'breed' then left(f ->> 'breed', 60) else breed end,
      formfav_runner_id = coalesce(v_runner, formfav_runner_id),
      formfav_synced_at = now()
    where id = p_id and formfav_key is not null
    returning owner_id into v_owner;
    if not found then return null; end if;
    select count(*) into logged from public.owner_horse_records where horse_id = p_id;
  else
    raise exception 'invalid_kind';
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_runs, '[]'::jsonb)) loop
    if coalesce(r ->> 'ref', '') !~ '^[0-9a-f-]{36}$' or coalesce(r ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
    v_ref := (r ->> 'ref')::uuid;
    v_date := (r ->> 'date')::date;
    v_track := left(coalesce(nullif(btrim(r ->> 'track'), ''), 'Unknown track'), 80);
    v_name := left(coalesce(btrim(r ->> 'raceName'), ''), 120);
    v_distance := left(coalesce(btrim(r ->> 'distance'), ''), 40);
    v_finish := case when r ->> 'finish' ~ '^\d{1,3}$' and (r ->> 'finish')::int between 1 and v_max then (r ->> 'finish')::int end;
    v_field := case when r ->> 'fieldSize' ~ '^\d{1,3}$' and (r ->> 'fieldSize')::int between 1 and v_max then (r ->> 'fieldSize')::int end;
    if v_finish is not null and v_field is not null and v_finish > v_field then v_field := null; end if;

    if p_kind = 'virtual' then
      if exists (select 1 from public.virtual_horse_entries where virtual_horse_id = p_id and formfav_ref = v_ref) then continue; end if;
      select id into hit from public.virtual_horse_entries
       where virtual_horse_id = p_id and formfav_ref is null and kind = 'race' and entry_date = v_date
         and lower(btrim(track)) = lower(v_track)
       order by created_at limit 1;
      if hit is not null then
        update public.virtual_horse_entries set formfav_ref = v_ref,
          title = case when title = '' then v_name else title end,
          distance = case when distance = '' then v_distance else distance end,
          finish = case when finish is null and field_size is null then v_finish else finish end,
          field_size = case when finish is null and field_size is null then v_field else field_size end,
          updated_at = now()
        where id = hit;
        attached := attached + 1;
      elsif logged < 2000 then
        insert into public.virtual_horse_entries (virtual_horse_id, author_id, kind, entry_date, title, track, distance,
          finish, field_size, formfav_ref)
        values (p_id, null, 'race', v_date, v_name, v_track, v_distance, v_finish, v_field, v_ref);
        added := added + 1;
        logged := logged + 1;
      end if;
    else
      if exists (select 1 from public.owner_horse_records where horse_id = p_id and formfav_ref = v_ref) then continue; end if;
      select id into hit from public.owner_horse_records
       where horse_id = p_id and formfav_ref is null and race_date = v_date and lower(btrim(track)) = lower(v_track)
       order by created_at limit 1;
      if hit is not null then
        update public.owner_horse_records set formfav_ref = v_ref,
          race_name = case when race_name = '' then v_name else race_name end,
          distance = case when distance = '' then v_distance else distance end,
          finish = case when finish is null and field_size is null then v_finish else finish end,
          field_size = case when finish is null and field_size is null then v_field else field_size end,
          updated_at = now()
        where id = hit;
        attached := attached + 1;
      elsif logged < 2000 then
        insert into public.owner_horse_records (horse_id, owner_id, race_date, track, race_name, distance, finish,
          field_size, formfav_ref)
        values (p_id, v_owner, v_date, v_track, v_name, v_distance, v_finish, v_field, v_ref);
        added := added + 1;
        logged := logged + 1;
      end if;
    end if;
  end loop;

  if added + attached > 0 then
    if p_kind = 'virtual' then update public.virtual_horses set updated_at = now() where id = p_id;
    else update public.owner_horses set updated_at = now() where id = p_id; end if;
  end if;
  return jsonb_build_object('added', added, 'attached', attached);
end $$;

-- Ends a link: the copied details stay, log rows become ordinary rows, mutes go. A horse added from race data
-- (source 'formfav') can't be unlinked, only removed. Returns false when there was nothing to unlink.
create or replace function public.formfav_unlink(p_kind text, p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind = 'virtual' then
    update public.virtual_horses set formfav_name = null, formfav_code = null, formfav_key = null, formfav_runner_id = null,
      formfav_linked_at = null, formfav_linked_by = null, formfav_synced_at = null, updated_at = now()
    where id = p_id and source = 'manual' and formfav_key is not null;
    if not found then return false; end if;
    update public.virtual_horse_entries set formfav_ref = null where virtual_horse_id = p_id and formfav_ref is not null;
    delete from public.virtual_horse_mutes where horse_id = p_id;
  elsif p_kind = 'owned' then
    update public.owner_horses set formfav_name = null, formfav_code = null, formfav_key = null, formfav_runner_id = null,
      formfav_linked_at = null, formfav_synced_at = null, formfav_alerts = true, updated_at = now()
    where id = p_id and formfav_key is not null;
    if not found then return false; end if;
    update public.owner_horse_records set formfav_ref = null where horse_id = p_id and formfav_ref is not null;
  else
    raise exception 'invalid_kind';
  end if;
  return true;
end $$;

-- Records upcoming entries of followed horses: p_entries [{ref, date, jockey, jockeyKey, trainer, trainerKey}]
-- (keys = the API's folded names). Returns the ones first seen now ({ref, new: true}) and the ones whose jockey or
-- trainer changed since ({ref, jockey: [old, new]?, trainer: [old, new]?}). A name appearing where none was known
-- isn't a change. Forgets entries 3 days after their race.
create or replace function public.formfav_entries_seen(p_entries jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  e jsonb;
  prev public.formfav_entry_seen;
  found_rows jsonb := '[]'::jsonb;
  diff jsonb;
  v_ref uuid;
begin
  delete from public.formfav_entry_seen where race_date < current_date - 3;
  for e in select * from jsonb_array_elements(coalesce(p_entries, '[]'::jsonb)) loop
    if coalesce(e ->> 'ref', '') !~ '^[0-9a-f-]{36}$' or coalesce(e ->> 'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
    v_ref := (e ->> 'ref')::uuid;
    select * into prev from public.formfav_entry_seen where ref = v_ref;
    if not found then
      insert into public.formfav_entry_seen (ref, race_date, jockey, jockey_key, trainer, trainer_key)
      values (v_ref, (e ->> 'date')::date, left(coalesce(e ->> 'jockey', ''), 100), left(coalesce(e ->> 'jockeyKey', ''), 100),
              left(coalesce(e ->> 'trainer', ''), 100), left(coalesce(e ->> 'trainerKey', ''), 100))
      on conflict (ref) do nothing;
      found_rows := found_rows || jsonb_build_array(jsonb_build_object('ref', v_ref, 'new', true));
      continue;
    end if;
    diff := '{}'::jsonb;
    if coalesce(e ->> 'jockeyKey', '') <> '' and prev.jockey_key <> '' and prev.jockey_key <> e ->> 'jockeyKey' then
      diff := diff || jsonb_build_object('jockey', jsonb_build_array(prev.jockey, e ->> 'jockey'));
    end if;
    if coalesce(e ->> 'trainerKey', '') <> '' and prev.trainer_key <> '' and prev.trainer_key <> e ->> 'trainerKey' then
      diff := diff || jsonb_build_object('trainer', jsonb_build_array(prev.trainer, e ->> 'trainer'));
    end if;
    if diff <> '{}'::jsonb then found_rows := found_rows || jsonb_build_array(diff || jsonb_build_object('ref', v_ref)); end if;
    if coalesce(e ->> 'jockeyKey', '') <> '' and prev.jockey_key is distinct from e ->> 'jockeyKey'
       or coalesce(e ->> 'trainerKey', '') <> '' and prev.trainer_key is distinct from e ->> 'trainerKey' then
      update public.formfav_entry_seen set
        jockey = case when coalesce(e ->> 'jockeyKey', '') <> '' then left(e ->> 'jockey', 100) else jockey end,
        jockey_key = case when coalesce(e ->> 'jockeyKey', '') <> '' then left(e ->> 'jockeyKey', 100) else jockey_key end,
        trainer = case when coalesce(e ->> 'trainerKey', '') <> '' then left(e ->> 'trainer', 100) else trainer end,
        trainer_key = case when coalesce(e ->> 'trainerKey', '') <> '' then left(e ->> 'trainerKey', 100) else trainer_key end
      where ref = v_ref;
    end if;
  end loop;
  return found_rows;
end $$;

-- Saves alerts about linked horses and returns {alerts, targets} for push, like racing_notify.
--   p_events [{key, ref, kind, horse, title, body, at}]  kind: race_entry | race_scratch | race_result | race_change
-- Who: the owner of a personal list, every member of a stable list, the owner of a linked owned horse — once per
-- person per event (owned horse > personal list > stable list for the link), minus mutes, owners who turned the
-- horse's alerts off, and racing_preferences. Events from before the horse was linked (`at`) are skipped. One alert
-- per person per event ever (chat_alerts_racing_once), so a re-run or restart never repeats one.
create or replace function public.formfav_notify(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; alerts jsonb;
begin
  with ev as (
    select e ->> 'key' as fkey, (e ->> 'ref')::uuid as ref, e ->> 'kind' as kind,
      left(coalesce(e ->> 'horse', ''), 120) as horse, left(coalesce(e ->> 'title', ''), 120) as title,
      left(coalesce(e ->> 'body', ''), 300) as body, coalesce((e ->> 'at')::timestamptz, now()) as at
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
    where e ->> 'kind' in ('race_entry', 'race_scratch', 'race_result', 'race_change')
      and coalesce(e ->> 'ref', '') ~ '^[0-9a-f-]{36}$' and coalesce(e ->> 'key', '') <> ''
  ),
  hits as (
    select h.owner_id as uid, ev.*, 1 as prio, '/community/horses/' || h.id as link
      from ev join public.owner_horses h on h.formfav_key = ev.fkey
     where h.formfav_alerts and h.formfav_linked_at <= ev.at
    union all
    select vh.user_id, ev.*, 2,
      '/my-racing?tab=virtual' || case when vh.source = 'formfav' then '&vtab=racing' else '' end || '&horse=' || vh.id
      from ev join public.virtual_horses vh on vh.formfav_key = ev.fkey and vh.user_id is not null
     where vh.formfav_linked_at <= ev.at
       and not exists (select 1 from public.virtual_horse_mutes m where m.horse_id = vh.id and m.user_id = vh.user_id)
    union all
    select sm.user_id, ev.*, 3,
      '/workspace/virtual?stable=' || vh.stable_id || case when vh.source = 'formfav' then '&vtab=racing' else '' end
        || '&horse=' || vh.id
      from ev join public.virtual_horses vh on vh.formfav_key = ev.fkey and vh.stable_id is not null
      join public.stable_memberships sm on sm.stable_id = vh.stable_id
     where vh.formfav_linked_at <= ev.at
       and not exists (select 1 from public.virtual_horse_mutes m where m.horse_id = vh.id and m.user_id = sm.user_id)
  ),
  best as (
    select distinct on (hits.uid, hits.ref, hits.kind) hits.*
      from hits join public.accounts a on a.id = hits.uid and a.status = 'active'
     where public.racing_alert_wanted(hits.uid, hits.kind)
     order by hits.uid, hits.ref, hits.kind, hits.prio
  ),
  saved as (
    insert into public.chat_alerts (user_id, kind, message_id, actor_name, chat_title, body, link)
    select uid, kind, ref, horse, title, body, left(link, 300) from best
    on conflict do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into ids from saved;

  if cardinality(ids) = 0 then return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb); end if;

  delete from public.chat_alerts c using (select distinct user_id from public.chat_alerts where id = any (ids)) u
  where c.user_id = u.user_id and (c.created_at < now() - interval '30 days' or c.id in (
    select id from public.chat_alerts where user_id = u.user_id order by created_at desc offset 200));

  alerts := (select coalesce(jsonb_agg(public.chat_alert_out(a) || jsonb_build_object('userId', a.user_id)
               order by a.created_at), '[]'::jsonb)
             from public.chat_alerts a where a.id = any (ids));
  return jsonb_build_object('alerts', alerts, 'targets', public.chat_alert_targets(alerts));
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'chat_alert_allowed(public.notification_settings, text)', 'chat_alerts_list(uuid, timestamptz, integer, boolean)',
    'racing_alert_wanted(uuid, text)', 'formfav_follower_counts()',
    'community_public_horses_v2(uuid, text, text, text, text, int, int, boolean, int, text, uuid, int)',
    'formfav_linked_horses()', 'formfav_apply(text, uuid, jsonb, jsonb)', 'formfav_unlink(text, uuid)',
    'formfav_entries_seen(jsonb)', 'formfav_notify(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
