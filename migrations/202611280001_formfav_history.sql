-- APPLIED to Supabase 2026-11-28. Apply after 202611250001_horse_coowners.sql. Safe to re-run; adds, never removes
-- data (prune is only ever called by the API, with FORMFAV_HISTORY_DAYS, default 365).
--
-- Race history (FormFav US/Canada results, through lib/formFavHistory.ts):
--
--   FormFav serves race-by-race results for about 30 days. The API keeps every finished US/Canada day here so members
--   can still find horses, jockeys and trainers (and their runs) after they leave that window, for a rolling year.
--   Normalized to stay small (measured on 29 real days: 5.6 MB, about 40–45 MB a year): each race, horse and person is
--   stored once and a start is five small columns. No unique index per start and no trigram index: a day is always
--   written whole (delete + insert in one call) and recorded in formfav_history_days; name search is an ilike scan
--   of formfav_horses / formfav_people (tens of thousands of rows).
--
--   Keys are written by the API (its folding: '<code>|<folded name>' for horses, the folded name for people), so they
--   match formFavIndex / virtual_horses.formfav_key exactly.
--
-- RLS on, no browser grants; everything through the service role.

begin;

create table if not exists public.formfav_races (
  id integer generated always as identity primary key,
  race_date date not null,
  code text not null check (code in ('gallops', 'harness')),
  slug text not null check (char_length(slug) between 1 and 100),
  track text check (track is null or char_length(track) <= 120),
  country text not null check (country in ('us', 'ca')),
  race_number smallint,
  race_name text check (race_name is null or char_length(race_name) <= 300),
  race_class text check (race_class is null or char_length(race_class) <= 300),
  distance text check (distance is null or char_length(distance) <= 40),
  start_time timestamptz,
  field_size smallint
);
create index if not exists formfav_races_day on public.formfav_races (code, race_date);

create table if not exists public.formfav_horses (
  id integer generated always as identity primary key,
  horse_key text not null unique check (char_length(horse_key) between 3 and 120),
  code text not null check (code in ('gallops', 'harness')),
  horse_name text not null check (char_length(horse_name) between 1 and 100),
  last_date date not null
);

create table if not exists public.formfav_people (
  id integer generated always as identity primary key,
  kind text not null check (kind in ('jockey', 'trainer')),
  person_key text not null check (char_length(person_key) between 1 and 120),
  name text not null check (char_length(name) between 1 and 100),
  last_date date not null,
  unique (kind, person_key)
);

create table if not exists public.formfav_starts (
  race_id integer not null references public.formfav_races(id) on delete cascade,
  horse_id integer not null references public.formfav_horses(id) on delete cascade,
  position smallint,
  jockey_id integer references public.formfav_people(id) on delete set null,
  trainer_id integer references public.formfav_people(id) on delete set null
);
create index if not exists formfav_starts_race on public.formfav_starts (race_id);
create index if not exists formfav_starts_horse on public.formfav_starts (horse_id);
create index if not exists formfav_starts_jockey on public.formfav_starts (jockey_id);
create index if not exists formfav_starts_trainer on public.formfav_starts (trainer_id);

-- Which days are in the history (each is written whole, once; a re-write replaces it).
create table if not exists public.formfav_history_days (
  code text not null check (code in ('gallops', 'harness')),
  race_date date not null,
  races integer not null default 0,
  runners integer not null default 0,
  saved_at timestamptz not null default now(),
  primary key (code, race_date)
);

do $$ declare t text; begin
  foreach t in array array['formfav_races', 'formfav_horses', 'formfav_people', 'formfav_starts', 'formfav_history_days'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- One finished day, written whole (anything already stored for it is replaced). p_races:
--   [{slug, track, country, number, name, class, distance, startTime, fieldSize,
--     runners: [{key, name, position, jockey, jockeyKey, trainer, trainerKey}]}]
-- Returns {races, runners}.
create or replace function public.formfav_history_save_day(p_code text, p_date date, p_races jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  r jsonb;
  x jsonb;
  v_race int;
  v_horse int;
  v_jockey int;
  v_trainer int;
  n_races int := 0;
  n_runners int := 0;
begin
  if p_code not in ('gallops', 'harness') or p_date is null then
    raise exception 'formfav_history_save_day: bad day';
  end if;
  delete from public.formfav_races where code = p_code and race_date = p_date;
  -- An empty list can arrive as '{}' from some clients: anything but an array is an empty day.
  for r in select * from jsonb_array_elements(case when jsonb_typeof(p_races) = 'array' then p_races else '[]'::jsonb end) loop
    insert into public.formfav_races (race_date, code, slug, track, country, race_number, race_name, race_class, distance, start_time, field_size)
    values (
      p_date, p_code, left(r ->> 'slug', 100), left(r ->> 'track', 120), r ->> 'country',
      case when r ->> 'number' ~ '^\d{1,3}$' then (r ->> 'number')::smallint end,
      left(r ->> 'name', 300), left(r ->> 'class', 300), left(r ->> 'distance', 40),
      case when r ->> 'startTime' ~ '^\d{4}-\d{2}-\d{2}T' then (r ->> 'startTime')::timestamptz end,
      case when r ->> 'fieldSize' ~ '^\d{1,3}$' then (r ->> 'fieldSize')::smallint end)
    returning id into v_race;
    n_races := n_races + 1;
    for x in select * from jsonb_array_elements(case when jsonb_typeof(r -> 'runners') = 'array' then r -> 'runners' else '[]'::jsonb end) loop
      insert into public.formfav_horses (horse_key, code, horse_name, last_date)
      values (left(x ->> 'key', 120), p_code, left(x ->> 'name', 100), p_date)
      on conflict (horse_key) do update set
        horse_name = case when excluded.last_date >= public.formfav_horses.last_date then excluded.horse_name else public.formfav_horses.horse_name end,
        last_date = greatest(public.formfav_horses.last_date, excluded.last_date)
      returning id into v_horse;
      v_jockey := null;
      v_trainer := null;
      if coalesce(x ->> 'jockeyKey', '') <> '' then
        insert into public.formfav_people (kind, person_key, name, last_date)
        values ('jockey', left(x ->> 'jockeyKey', 120), left(x ->> 'jockey', 100), p_date)
        on conflict (kind, person_key) do update set
          name = case when excluded.last_date >= public.formfav_people.last_date then excluded.name else public.formfav_people.name end,
          last_date = greatest(public.formfav_people.last_date, excluded.last_date)
        returning id into v_jockey;
      end if;
      if coalesce(x ->> 'trainerKey', '') <> '' then
        insert into public.formfav_people (kind, person_key, name, last_date)
        values ('trainer', left(x ->> 'trainerKey', 120), left(x ->> 'trainer', 100), p_date)
        on conflict (kind, person_key) do update set
          name = case when excluded.last_date >= public.formfav_people.last_date then excluded.name else public.formfav_people.name end,
          last_date = greatest(public.formfav_people.last_date, excluded.last_date)
        returning id into v_trainer;
      end if;
      insert into public.formfav_starts (race_id, horse_id, position, jockey_id, trainer_id)
      values (v_race, v_horse, case when x ->> 'position' ~ '^\d{1,3}$' then (x ->> 'position')::smallint end, v_jockey, v_trainer);
      n_runners := n_runners + 1;
    end loop;
  end loop;
  insert into public.formfav_history_days (code, race_date, races, runners, saved_at)
  values (p_code, p_date, n_races, n_runners, now())
  on conflict (code, race_date) do update set races = excluded.races, runners = excluded.runners, saved_at = excluded.saved_at;
  return jsonb_build_object('races', n_races, 'runners', n_runners);
end $$;

-- A horse's stored runs (newest first), optionally only those before p_before; null when it isn't stored.
create or replace function public.formfav_history_horse(p_key text, p_before date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when h.id is null then null else jsonb_build_object(
    'key', h.horse_key, 'name', h.horse_name, 'code', h.code, 'lastDate', h.last_date,
    'starts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', r.race_date, 'code', r.code, 'track', r.track, 'slug', r.slug, 'country', r.country,
        'raceNumber', r.race_number, 'raceName', r.race_name, 'raceClass', r.race_class, 'distance', r.distance,
        'startTime', r.start_time, 'position', s.position, 'fieldSize', r.field_size,
        'jockey', j.name, 'trainer', t.name) order by r.race_date desc, r.start_time desc nulls last, r.race_number desc)
      from public.formfav_starts s
      join public.formfav_races r on r.id = s.race_id
      left join public.formfav_people j on j.id = s.jockey_id
      left join public.formfav_people t on t.id = s.trainer_id
      where s.horse_id = h.id and (p_before is null or r.race_date < p_before)), '[]'::jsonb)) end
  from (select 1) one left join public.formfav_horses h on h.horse_key = p_key
$$;

-- A jockey's or trainer's stored rides: totals plus first/last ride; null when they aren't stored.
create or replace function public.formfav_history_person(p_kind text, p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when p.id is null then null else (
    select jsonb_build_object(
      'name', p.name, 'kind', p.kind,
      'rides', count(*)::int,
      'wins', count(*) filter (where s.position = 1)::int,
      'places', count(*) filter (where s.position between 1 and 3)::int,
      'tracks', count(distinct r.slug)::int,
      'firstRide', min(r.race_date), 'lastRide', max(r.race_date))
    from public.formfav_starts s join public.formfav_races r on r.id = s.race_id
    where (case when p.kind = 'jockey' then s.jockey_id else s.trainer_id end) = p.id) end
  from (select 1) one left join public.formfav_people p on p.kind = p_kind and p.person_key = p_key
$$;

-- Horses ('horse') or people ('jockey' / 'trainer') whose name contains p_q, most recently seen first.
-- p_codes: comma-separated race codes for horses ('' = all).
create or replace function public.formfav_history_search(p_kind text, p_q text, p_codes text, p_limit int) returns jsonb
language sql stable security definer set search_path = '' as $$
  with needle as (
    select '%' || replace(replace(replace(coalesce(p_q, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%' as q,
           least(greatest(coalesce(p_limit, 20), 1), 100) as lim
  ), horses as (
    select h.id, h.horse_key, h.horse_name, h.code, h.last_date from public.formfav_horses h, needle
     where p_kind = 'horse' and h.horse_name ilike needle.q
       and (coalesce(p_codes, '') = '' or h.code = any(string_to_array(p_codes, ',')))
     order by h.last_date desc, h.horse_name limit (select lim from needle)
  ), people as (
    select p.id, p.person_key, p.name, p.last_date from public.formfav_people p, needle
     where p.kind = p_kind and p.name ilike needle.q
     order by p.last_date desc, p.name limit (select lim from needle)
  )
  select case when p_kind = 'horse' then coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', h.horse_key, 'name', h.horse_name, 'code', h.code, 'lastDate', h.last_date,
      'starts', (select count(*) from public.formfav_starts s where s.horse_id = h.id),
      'wins', (select count(*) from public.formfav_starts s where s.horse_id = h.id and s.position = 1),
      'places', (select count(*) from public.formfav_starts s where s.horse_id = h.id and s.position between 1 and 3))
      order by h.last_date desc, h.horse_name) from horses h), '[]'::jsonb)
  else coalesce((
    select jsonb_agg(jsonb_build_object(
      'key', p.person_key, 'name', p.name, 'lastDate', p.last_date,
      'rides', (select count(*) from public.formfav_starts s where (case when p_kind = 'jockey' then s.jockey_id else s.trainer_id end) = p.id),
      'wins', (select count(*) from public.formfav_starts s where (case when p_kind = 'jockey' then s.jockey_id else s.trainer_id end) = p.id and s.position = 1))
      order by p.last_date desc, p.name) from people p), '[]'::jsonb) end
$$;

-- Drops races older than p_keep_days (and the horses and people left with no runs). Returns what it removed.
create or replace function public.formfav_history_prune(p_keep_days int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  cutoff date := current_date - greatest(coalesce(p_keep_days, 365), 30);
  n_races int;
  n_horses int;
  n_people int;
begin
  delete from public.formfav_races where race_date < cutoff;
  get diagnostics n_races = row_count;
  delete from public.formfav_history_days where race_date < cutoff;
  delete from public.formfav_horses h where h.last_date < cutoff
    and not exists (select 1 from public.formfav_starts s where s.horse_id = h.id);
  get diagnostics n_horses = row_count;
  delete from public.formfav_people p where p.last_date < cutoff
    and not exists (select 1 from public.formfav_starts s where s.jockey_id = p.id or s.trainer_id = p.id);
  get diagnostics n_people = row_count;
  return jsonb_build_object('races', n_races, 'horses', n_horses, 'people', n_people, 'cutoff', cutoff);
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'formfav_history_save_day(text, date, jsonb)', 'formfav_history_horse(text, date)',
    'formfav_history_person(text, text)', 'formfav_history_search(text, text, text, int)',
    'formfav_history_prune(int)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
