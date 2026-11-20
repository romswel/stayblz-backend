-- LOCAL until a release is approved. Apply after 202611190004_racing_follows.sql. Safe to re-run; adds, never removes data.
--
-- Racing data feed: one checked way to load a whole card from a data provider (The Racing API, pulled automatically;
-- the licensed Equibase feed once its spec arrives; the co-dev's collected files for local testing) into the linked
-- racing tables.
--
--   * Horses, people, tracks and races carry the provider's id (source + source_ref, e.g. 'theracingapi' + 'hrs_123'
--     or 'equibase' + 'T:11513931'), so the same record is matched on every import even if its name is written
--     differently. Without an id, people match by name and tracks by code.
--   * racing_horse_history: a horse's earlier starts as the provider lists them (date, track, race, distance, finish,
--     odds, rider). Provider ratings (speed figures, RPR, Topspeed) and race comments are never stored: they're another
--     company's product.
--   * Automatic imports (the scheduled puller) pass no actor; the publishing tool always passes the admin.
--   * racing_feed_import(actor, card, publish) loads one track's day atomically: races, runners, scratches, official
--     results, payouts, horses' earlier starts and workouts. Re-importing updates in place. Imported cards stay drafts.
--   * Licence switch: a card or workout that came from a provider can only be published when the server says that
--     source's licence allows it (lib/racingFeed/licence.ts: The Racing API's terms allow websites; anything else needs
--     RACING_FEED_LICENSED). Hand-entered cards are unaffected.
--   * racing_feed_runs: a log of every import (who, which source, what changed).
-- RLS on, no browser grants; everything through service-role-only functions.

begin;

-- ---------- Provider ids ----------
alter table public.racing_horses add column if not exists source text not null default ''
  check (source = '' or source ~ '^[a-z0-9_-]{2,30}$');
alter table public.racing_horses add column if not exists source_ref text
  check (source_ref is null or source_ref ~ '^[A-Za-z0-9:_-]{1,40}$');
create unique index if not exists racing_horses_source_ref on public.racing_horses (source, source_ref)
  where source_ref is not null;
alter table public.racing_people add column if not exists source text not null default ''
  check (source = '' or source ~ '^[a-z0-9_-]{2,30}$');
alter table public.racing_people add column if not exists source_ref text
  check (source_ref is null or source_ref ~ '^[A-Za-z0-9:_-]{1,40}$');
create unique index if not exists racing_people_source_ref on public.racing_people (source, source_ref)
  where source_ref is not null;
alter table public.racing_tracks add column if not exists source text not null default ''
  check (source = '' or source ~ '^[a-z0-9_-]{2,30}$');
alter table public.racing_tracks add column if not exists source_ref text
  check (source_ref is null or source_ref ~ '^[A-Za-z0-9:_-]{1,40}$');
create unique index if not exists racing_tracks_source_ref on public.racing_tracks (source, source_ref)
  where source_ref is not null;
-- A provider's race id (the day already says which source).
alter table public.racing_races add column if not exists source_ref text
  check (source_ref is null or source_ref ~ '^[A-Za-z0-9:_-]{1,40}$');
create unique index if not exists racing_races_source_ref on public.racing_races (day_id, source_ref)
  where source_ref is not null;
-- When the provider's list of earlier starts was last read for this horse.
alter table public.racing_horses add column if not exists history_synced_at timestamptz;
-- Big fields (up to 40 runners, e.g. the Grand National).
alter table public.racing_runners drop constraint if exists racing_runners_post_position_check;
alter table public.racing_runners add constraint racing_runners_post_position_check check (post_position between 1 and 40);
alter table public.racing_runners drop constraint if exists racing_runners_finish_position_check;
alter table public.racing_runners add constraint racing_runners_finish_position_check check (finish_position between 1 and 40);
-- Where a card / workout came from ('' = entered by hand in the publishing tool).
alter table public.racing_days add column if not exists source text not null default ''
  check (source = '' or source ~ '^[a-z0-9_-]{2,30}$');
alter table public.racing_workouts add column if not exists source text not null default ''
  check (source = '' or source ~ '^[a-z0-9_-]{2,30}$');

-- ---------- Earlier starts from a provider ----------
create table if not exists public.racing_horse_history (
  id uuid primary key default gen_random_uuid(),
  horse_id uuid not null references public.racing_horses(id) on delete cascade,
  source text not null check (source ~ '^[a-z0-9_-]{2,30}$'),
  race_date date not null,
  track_code text not null check (track_code ~ '^[A-Z0-9]{2,6}$'),
  track_name text not null default '' check (length(track_name) <= 80),
  race_number integer check (race_number between 1 and 40),
  race_name text not null default '' check (length(race_name) <= 100),
  race_type text not null default '' check (length(race_type) <= 60),
  breed text not null default 'thoroughbred' check (breed in ('thoroughbred', 'harness', 'quarter_horse')),
  distance_value numeric(7, 2) check (distance_value > 0 and distance_value < 10000),
  distance_unit text not null default 'furlongs' check (distance_unit in ('furlongs', 'miles', 'yards', 'meters')),
  surface text not null default '' check (surface in ('', 'dirt', 'turf', 'synthetic', 'all_weather')),
  field_size integer check (field_size between 1 and 60),
  finish_position integer check (finish_position between 1 and 60),
  odds numeric(8, 2) check (odds >= 0),
  rider text not null default '' check (length(rider) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A horse runs at most once a day at one track.
  unique (horse_id, race_date, track_code)
);
create index if not exists racing_horse_history_horse on public.racing_horse_history (horse_id, race_date desc);

create table if not exists public.racing_feed_runs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source ~ '^[a-z0-9_-]{2,30}$'),
  actor_id uuid references public.accounts(id) on delete set null,
  day_id uuid references public.racing_days(id) on delete set null,
  track_code text not null,
  race_date date not null,
  summary jsonb not null default '{}'::jsonb check (jsonb_typeof(summary) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists racing_feed_runs_recent on public.racing_feed_runs (created_at desc);

do $$ declare t text; begin
  foreach t in array array['racing_horse_history', 'racing_feed_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- ---------- Reads: the card says where it came from; a horse shows its earlier starts ----------
create or replace function public.racing_day_json(d public.racing_days, p_runners boolean, p_admin boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id, 'date', d.race_date, 'status', d.status, 'publishedAt', d.published_at, 'notes', d.notes,
    'source', d.source,
    'track', (select public.racing_track_json(t) from public.racing_tracks t where t.id = d.track_id),
    'races', coalesce((select jsonb_agg(public.racing_race_json(r, p_runners, p_admin) order by r.race_number)
      from public.racing_races r where r.day_id = d.id), '[]'::jsonb))
$$;

-- Same as before, plus 'history': the provider's earlier starts that aren't already published races on Stayblz.
create or replace function public.racing_horse(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare h public.racing_horses; ids uuid[]; works jsonb;
begin
  select * into h from public.racing_horses where id = p_id;
  if not found then return null; end if;
  select coalesce(array_agg(rn.id), '{}') into ids from public.racing_runners rn
    join public.racing_races r on r.id = rn.race_id join public.racing_days d on d.id = r.day_id
    where rn.horse_id = p_id and public.racing_day_public(d);
  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'date', w.work_date, 'track', t.name,
      'distance', public.racing_distance_label(w.distance_value, w.distance_unit), 'surface', w.surface,
      'time', public.racing_time_label(w.time_seconds), 'rank', w.rank, 'rankOf', w.rank_of, 'note', w.note)
    order by w.work_date desc), '[]'::jsonb) into works
  from public.racing_workouts w join public.racing_tracks t on t.id = w.track_id
  where w.horse_id = p_id and w.status = 'published' and w.published_at <= now();
  if cardinality(ids) = 0 and works = '[]'::jsonb then return null; end if;
  return jsonb_build_object('horse', public.racing_horse_json(h), 'stats', public.racing_stats_json(ids),
    'starts', coalesce((select jsonb_agg(public.racing_start_json(rn) order by d.race_date desc, r.race_number desc)
      from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
      join public.racing_days d on d.id = r.day_id where rn.id = any (ids)), '[]'::jsonb),
    'workouts', works,
    'history', coalesce((select jsonb_agg(jsonb_build_object('date', x.race_date, 'trackCode', x.track_code,
        'track', x.track_name, 'race', x.race_number, 'name', x.race_name, 'type', x.race_type, 'breed', x.breed,
        'distance', case when x.distance_value is null then '' else public.racing_distance_label(x.distance_value, x.distance_unit) end,
        'surface', x.surface, 'fieldSize', x.field_size, 'finish', x.finish_position, 'odds', x.odds, 'rider', x.rider,
        'source', x.source) order by x.race_date desc, x.race_number desc nulls last)
      from (select * from public.racing_horse_history hh where hh.horse_id = p_id
            -- Starts already shown from Stayblz's own published cards aren't listed twice.
            and not exists (select 1 from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
              join public.racing_days d on d.id = r.day_id join public.racing_tracks t on t.id = d.track_id
              where rn.id = any (ids) and d.race_date = hh.race_date
                and (t.code = hh.track_code or lower(t.name) = lower(hh.track_name)))
            order by hh.race_date desc limit 200) x), '[]'::jsonb));
end $$;

-- ---------- Import helpers ----------
-- The horse for a provider record: by provider id, else an unclaimed horse with the same name and country (which is
-- then claimed), else a new horse. Fills blanks, never overwrites what an admin typed.
create or replace function public.racing_feed_horse(p_source text, p_horse jsonb, p_breed text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_ref text; v_name text; v_country text;
begin
  v_ref := nullif(btrim(coalesce(p_horse ->> 'ref', '')), '');
  v_name := btrim(p_horse ->> 'name');
  v_country := coalesce(p_horse ->> 'country', '');
  if v_ref is not null then
    select id into v_id from public.racing_horses where source = p_source and source_ref = v_ref;
  end if;
  if v_id is null then
    select id into v_id from public.racing_horses
      where lower(name) = lower(v_name) and country = v_country and (source_ref is null or v_ref is null) limit 1;
    if v_id is not null and v_ref is not null then
      update public.racing_horses set source = p_source, source_ref = v_ref where id = v_id;
    end if;
  end if;
  if v_id is null then
    insert into public.racing_horses (name, country, sex, foaled_year, sire, dam, dam_sire, breeder, breed, source, source_ref)
    values (v_name, v_country, coalesce(p_horse ->> 'sex', ''), nullif(p_horse ->> 'foaled', '')::int,
      coalesce(p_horse ->> 'sire', ''), coalesce(p_horse ->> 'dam', ''), coalesce(p_horse ->> 'damSire', ''),
      coalesce(p_horse ->> 'breeder', ''), p_breed, case when v_ref is null then '' else p_source end, v_ref)
    returning id into v_id;
  else
    update public.racing_horses set
      sex = case when sex = '' then coalesce(p_horse ->> 'sex', '') else sex end,
      foaled_year = coalesce(foaled_year, nullif(p_horse ->> 'foaled', '')::int),
      sire = case when sire = '' then coalesce(p_horse ->> 'sire', '') else sire end,
      dam = case when dam = '' then coalesce(p_horse ->> 'dam', '') else dam end,
      dam_sire = case when dam_sire = '' then coalesce(p_horse ->> 'damSire', '') else dam_sire end,
      breeder = case when breeder = '' then coalesce(p_horse ->> 'breeder', '') else breeder end,
      updated_at = now()
    where id = v_id;
  end if;
  return v_id;
end $$;

-- A person by provider id, else by name and role (an unclaimed record is then claimed), else new.
create or replace function public.racing_feed_person(p_name text, p_kind text, p_source text, p_ref text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_ref text := nullif(btrim(coalesce(p_ref, '')), '');
begin
  if coalesce(length(btrim(p_name)), 0) < 2 then return null; end if;
  if v_ref is not null and v_ref !~ '^[A-Za-z0-9:_-]{1,40}$' then v_ref := null; end if;
  if v_ref is not null then
    select id into v_id from public.racing_people where source = p_source and source_ref = v_ref and kind = p_kind;
    if v_id is not null then return v_id; end if;
  end if;
  -- Names are unique per role (racing_people_name), so a same-named person is the same record.
  select id into v_id from public.racing_people where kind = p_kind and lower(name) = lower(btrim(p_name));
  if v_id is not null and v_ref is not null then
    update public.racing_people set source = p_source, source_ref = v_ref where id = v_id and source_ref is null;
  end if;
  if v_id is null then
    insert into public.racing_people (name, kind, source, source_ref)
    values (left(btrim(p_name), 80), p_kind, case when v_ref is null then '' else p_source end, v_ref) returning id into v_id;
  end if;
  return v_id;
end $$;

-- One earlier start (see the card format below); re-saving the same day and track updates it.
create or replace function public.racing_feed_history_row(p_horse uuid, p_source text, item jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into public.racing_horse_history (horse_id, source, race_date, track_code, track_name, race_number, race_name,
    race_type, breed, distance_value, distance_unit, surface, field_size, finish_position, odds, rider)
  values (p_horse, p_source, (item ->> 'date')::date, upper(item ->> 'trackCode'), coalesce(item ->> 'trackName', ''),
    nullif(item ->> 'race', '')::int, coalesce(item ->> 'name', ''), coalesce(item ->> 'type', ''),
    coalesce(nullif(item ->> 'breed', ''), 'thoroughbred'), nullif(item ->> 'distanceValue', '')::numeric,
    coalesce(nullif(item ->> 'distanceUnit', ''), 'furlongs'), coalesce(item ->> 'surface', ''),
    nullif(item ->> 'fieldSize', '')::int, nullif(item ->> 'finish', '')::int, nullif(item ->> 'odds', '')::numeric,
    coalesce(item ->> 'rider', ''))
  on conflict (horse_id, race_date, track_code) do update set
    track_name = excluded.track_name, race_number = coalesce(excluded.race_number, public.racing_horse_history.race_number),
    race_name = excluded.race_name, race_type = excluded.race_type, breed = excluded.breed,
    distance_value = excluded.distance_value, distance_unit = excluded.distance_unit, surface = excluded.surface,
    field_size = excluded.field_size, finish_position = excluded.finish_position, odds = excluded.odds,
    rider = excluded.rider, updated_at = now()
$$;

-- Earlier starts for several horses at once (the puller reads each horse's record from the provider):
-- p_items = [{ horse: {ref, name, country, sex, foaled, sire, dam, damSire, breeder}, history: [...] }].
-- Fills pedigree blanks, saves the starts and stamps history_synced_at. Returns how many starts were saved.
create or replace function public.racing_feed_histories(p_source text, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare item jsonb; h jsonb; v_horse uuid; total integer := 0;
begin
  if p_source is null or p_source !~ '^[a-z0-9_-]{2,30}$' then raise exception 'invalid_card'; end if;
  for item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_horse := public.racing_feed_horse(p_source, item -> 'horse', 'thoroughbred');
    for h in select * from jsonb_array_elements(coalesce(item -> 'history', '[]'::jsonb)) loop
      perform public.racing_feed_history_row(v_horse, p_source, h);
      total := total + 1;
    end loop;
    update public.racing_horses set history_synced_at = now() where id = v_horse;
  end loop;
  return total;
end $$;

-- Horses from a source whose earlier starts should be read (again): running from 3 days ago to 3 days ahead, and
-- never read or not read for a week; the races nearest today first.
create or replace function public.racing_feed_history_due(p_source text, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'ref', x.source_ref) order by x.gap), '[]'::jsonb)
  from (select h.id, h.source_ref, min(abs(d.race_date - current_date)) as gap
        from public.racing_horses h
        join public.racing_runners rn on rn.horse_id = h.id
        join public.racing_races r on r.id = rn.race_id
        join public.racing_days d on d.id = r.day_id
        where h.source = p_source and h.source_ref is not null
          and d.race_date between current_date - 3 and current_date + 3
          and (h.history_synced_at is null or h.history_synced_at < now() - interval '7 days')
        group by h.id, h.source_ref
        order by gap limit least(greatest(coalesce(p_limit, 50), 1), 500)) x
$$;

-- ---------- Import one card ----------
-- p_card (checked by the backend first, lib/racingFeed/card.ts):
--   { source, date, track: {code, name, country, breed, ref},
--     races: [{ number, ref, postTime, name, type, grade, breed, distanceValue, distanceUnit, surface, condition, purse,
--               currency, conditions, status, winningTime, payouts: [{pool, combination, amount}],
--               runners: [{ program, post, horse: {ref, name, country, sex, foaled, sire, dam, damSire, breeder},
--                           jockey, jockeyRef, trainer, trainerRef, owner, ownerRef, weight, medication, equipment,
--                           morningLine, scratched, scratchReason, finish, odds, earnings }] }],
--     horses: [{ ref, name, country, history: [{date, trackCode, trackName, race, name, type, breed, distanceValue,
--                distanceUnit, surface, fieldSize, finish, odds, rider}],
--                workouts: [{date, trackCode, trackName, distanceValue, distanceUnit, surface, timeSeconds, rank,
--                            rankOf, note}] }] }
-- p_actor: the admin importing, or null for the automatic puller (the backend only; this function is service-role only).
-- p_publish: publish the card and its workouts (the backend only allows it when the source's licence allows it).
-- A card value left blank (no post time, purse, distance…) keeps what the race already had, so a results-only update
-- never wipes what the racecard said.
-- Returns a summary plus what changed for alerts: { dayId, published, officialRaces, scratchedRunners, workouts }.
create or replace function public.racing_feed_import(p_actor uuid, p_card jsonb, p_publish boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_source text := p_card ->> 'source';
  trk public.racing_tracks; v_day public.racing_days; race jsonb; rn jsonb; h jsonb; item jsonb;
  v_race uuid; v_old_status text; v_status text; v_breed text; v_horse uuid; v_runner uuid; v_was_scratched boolean;
  v_rider_kind text; v_track uuid; v_work uuid;
  v_code text := upper(p_card -> 'track' ->> 'code'); v_track_ref text := nullif(btrim(coalesce(p_card -> 'track' ->> 'ref', '')), '');
  v_number integer; v_race_ref text; v_old_ref text; n integer;
  n_races integer := 0; n_runners integer := 0; n_results integer := 0; n_history integer := 0; n_workouts integer := 0;
  horses_before integer; people_before integer;
  v_official uuid[] := '{}'; v_scratched uuid[] := '{}'; v_works uuid[] := '{}';
  v_summary jsonb;
begin
  if p_actor is not null then perform public.racing_assert_staff(p_actor); end if;
  if v_source is null or v_source !~ '^[a-z0-9_-]{2,30}$' then raise exception 'invalid_card'; end if;
  select count(*) into horses_before from public.racing_horses;
  select count(*) into people_before from public.racing_people;

  -- The track: by provider id; else by code (from a card without ids, or a same-named track without one, which is
  -- then claimed); else a new track, with a free code if this one belongs to another track (KEMP → KEMP2).
  if v_track_ref is not null then
    select * into trk from public.racing_tracks where source = v_source and source_ref = v_track_ref;
  end if;
  if trk.id is null then
    select * into trk from public.racing_tracks where code = v_code
      and (v_track_ref is null or (source_ref is null and lower(name) = lower(btrim(p_card -> 'track' ->> 'name'))));
    if trk.id is not null and v_track_ref is not null and trk.source_ref is null then
      update public.racing_tracks set source = v_source, source_ref = v_track_ref, updated_at = now() where id = trk.id
        returning * into trk;
    end if;
  end if;
  if trk.id is null then
    n := 1;
    while exists (select 1 from public.racing_tracks where code = v_code) loop
      n := n + 1;
      if n > 99 then raise exception 'invalid_card'; end if;
      v_code := left(upper(p_card -> 'track' ->> 'code'), 6 - length(n::text)) || n;
    end loop;
    insert into public.racing_tracks (code, name, country, breed, source, source_ref)
    values (v_code, coalesce(nullif(btrim(p_card -> 'track' ->> 'name'), ''), v_code),
      coalesce(p_card -> 'track' ->> 'country', ''), coalesce(nullif(p_card -> 'track' ->> 'breed', ''), 'thoroughbred'),
      case when v_track_ref is null then '' else v_source end, v_track_ref)
    returning * into trk;
  end if;
  v_rider_kind := case when trk.breed = 'harness' then 'driver' else 'jockey' end;

  select * into v_day from public.racing_days where track_id = trk.id and race_date = (p_card ->> 'date')::date for update;
  if not found then
    insert into public.racing_days (track_id, race_date, created_by, updated_by, source)
    values (trk.id, (p_card ->> 'date')::date, p_actor, p_actor, v_source) returning * into v_day;
  else
    update public.racing_days set source = v_source, updated_by = p_actor, updated_at = now() where id = v_day.id;
  end if;

  for race in select * from jsonb_array_elements(coalesce(p_card -> 'races', '[]'::jsonb)) loop
    v_breed := coalesce(nullif(race ->> 'breed', ''), trk.breed);
    -- The race: by the provider's race id, else by number. A number already used by another provider race means the
    -- card's numbering moved (e.g. an abandoned race was dropped): this race takes the next free number.
    v_race := null; v_old_status := null; v_old_ref := null;
    v_number := (race ->> 'number')::int;
    v_race_ref := nullif(btrim(coalesce(race ->> 'ref', '')), '');
    if v_race_ref is not null then
      select id, status, race_number into v_race, v_old_status, v_number from public.racing_races
        where day_id = v_day.id and source_ref = v_race_ref;
      if v_race is null then v_number := (race ->> 'number')::int; end if;
    end if;
    if v_race is null then
      select id, status, source_ref into v_race, v_old_status, v_old_ref from public.racing_races
        where day_id = v_day.id and race_number = v_number;
      if v_race is not null and v_old_ref is not null and v_race_ref is not null and v_old_ref <> v_race_ref then
        v_race := null; v_old_status := null;
        select coalesce(max(race_number), 0) + 1 into v_number from public.racing_races where day_id = v_day.id;
        if v_number > 40 then continue; end if;
      end if;
    end if;
    -- Never step an official race back to scheduled (a provider can lag behind a correction made here).
    v_status := case when v_old_status = 'official' and race ->> 'status' = 'scheduled' then 'official'
      else coalesce(race ->> 'status', 'scheduled') end;
    if v_race is null then
      insert into public.racing_races (day_id, race_number, breed, source_ref) values (v_day.id, v_number, v_breed, v_race_ref)
      returning id into v_race;
    end if;
    update public.racing_races set
      post_time = coalesce(nullif(race ->> 'postTime', ''), post_time), name = coalesce(nullif(race ->> 'name', ''), name),
      race_type = case when coalesce(nullif(race ->> 'type', ''), 'other') = 'other' then race_type else race ->> 'type' end,
      grade = coalesce(nullif(race ->> 'grade', '')::int, grade), breed = v_breed,
      distance_value = coalesce(nullif(race ->> 'distanceValue', '')::numeric, distance_value),
      distance_unit = case when nullif(race ->> 'distanceValue', '') is null then distance_unit
                           else coalesce(nullif(race ->> 'distanceUnit', ''), 'furlongs') end,
      surface = coalesce(nullif(race ->> 'surface', ''), surface),
      track_condition = coalesce(nullif(race ->> 'condition', ''), track_condition),
      purse = coalesce(nullif(race ->> 'purse', '')::int, purse), currency = coalesce(nullif(race ->> 'currency', ''), currency),
      conditions = coalesce(nullif(race ->> 'conditions', ''), conditions), status = v_status,
      source_ref = coalesce(v_race_ref, source_ref),
      winning_time = case when v_status = 'official' then coalesce(race ->> 'winningTime', winning_time) else winning_time end,
      payouts = case when v_status = 'official' and jsonb_array_length(coalesce(race -> 'payouts', '[]'::jsonb)) > 0
                     then race -> 'payouts' else payouts end,
      updated_at = now()
    where id = v_race;
    n_races := n_races + 1;

    for rn in select * from jsonb_array_elements(coalesce(race -> 'runners', '[]'::jsonb)) loop
      -- A non-runner without its number: scratch the runner already on this card, if there is one.
      if coalesce(rn ->> 'program', '') = '' then
        select rr.horse_id into v_horse from public.racing_runners rr join public.racing_horses hz on hz.id = rr.horse_id
          where rr.race_id = v_race and ((hz.source = v_source and hz.source_ref = rn -> 'horse' ->> 'ref')
            or (rn -> 'horse' ->> 'ref' is null and lower(hz.name) = lower(btrim(rn -> 'horse' ->> 'name'))))
          limit 1;
        if v_horse is null then continue; end if;
        update public.racing_runners set scratched = true, finish_position = null,
          scratch_reason = coalesce(nullif(rn ->> 'scratchReason', ''), scratch_reason), updated_at = now()
        where race_id = v_race and horse_id = v_horse and not scratched
        returning id into v_runner;
        if found then v_scratched := v_scratched || v_runner; n_runners := n_runners + 1; end if;
        continue;
      end if;
      v_horse := public.racing_feed_horse(v_source, rn -> 'horse', v_breed);
      -- A program number now belongs to another horse (a late change): that old runner goes.
      delete from public.racing_runners where race_id = v_race and program_number = upper(rn ->> 'program') and horse_id <> v_horse;
      select id, scratched into v_runner, v_was_scratched from public.racing_runners where race_id = v_race and horse_id = v_horse;
      insert into public.racing_runners (race_id, horse_id, program_number, post_position, jockey_id, trainer_id, owner_id,
        weight, medication, equipment, morning_line, scratched, scratch_reason, finish_position, final_odds, earnings)
      values (v_race, v_horse, upper(rn ->> 'program'), nullif(rn ->> 'post', '')::int,
        public.racing_feed_person(rn ->> 'jockey', v_rider_kind, v_source, rn ->> 'jockeyRef'),
        public.racing_feed_person(rn ->> 'trainer', 'trainer', v_source, rn ->> 'trainerRef'),
        public.racing_feed_person(rn ->> 'owner', 'owner', v_source, rn ->> 'ownerRef'), nullif(rn ->> 'weight', '')::int,
        coalesce(rn ->> 'medication', ''), coalesce(rn ->> 'equipment', ''), coalesce(rn ->> 'morningLine', ''),
        coalesce((rn ->> 'scratched')::boolean, false), coalesce(rn ->> 'scratchReason', ''),
        case when v_status = 'official' and not coalesce((rn ->> 'scratched')::boolean, false) then nullif(rn ->> 'finish', '')::int end,
        case when v_status = 'official' then nullif(rn ->> 'odds', '')::numeric end,
        case when v_status = 'official' then nullif(rn ->> 'earnings', '')::int end)
      on conflict (race_id, horse_id) do update set
        program_number = excluded.program_number, post_position = excluded.post_position,
        jockey_id = coalesce(excluded.jockey_id, public.racing_runners.jockey_id),
        trainer_id = coalesce(excluded.trainer_id, public.racing_runners.trainer_id),
        owner_id = coalesce(excluded.owner_id, public.racing_runners.owner_id),
        weight = excluded.weight, medication = excluded.medication, equipment = excluded.equipment,
        morning_line = excluded.morning_line, scratched = excluded.scratched, scratch_reason = excluded.scratch_reason,
        finish_position = case when v_status = 'official' then excluded.finish_position else public.racing_runners.finish_position end,
        final_odds = case when v_status = 'official' then excluded.final_odds else public.racing_runners.final_odds end,
        earnings = case when v_status = 'official' then coalesce(excluded.earnings, public.racing_runners.earnings)
                        else public.racing_runners.earnings end,
        updated_at = now()
      returning id into v_runner;
      n_runners := n_runners + 1;
      if coalesce((rn ->> 'scratched')::boolean, false) and not coalesce(v_was_scratched, false) then
        v_scratched := v_scratched || v_runner;
      end if;
    end loop;
    if v_status = 'official' then
      n_results := n_results + 1;
      if v_old_status is distinct from 'official' then v_official := v_official || v_race; end if;
    end if;
  end loop;

  -- Horses: earlier starts and workouts.
  for h in select * from jsonb_array_elements(coalesce(p_card -> 'horses', '[]'::jsonb)) loop
    v_horse := public.racing_feed_horse(v_source, h, trk.breed);
    for item in select * from jsonb_array_elements(coalesce(h -> 'history', '[]'::jsonb)) loop
      perform public.racing_feed_history_row(v_horse, v_source, item);
      n_history := n_history + 1;
    end loop;
    for item in select * from jsonb_array_elements(coalesce(h -> 'workouts', '[]'::jsonb)) loop
      select id into v_track from public.racing_tracks where code = upper(item ->> 'trackCode');
      if v_track is null then
        insert into public.racing_tracks (code, name, breed)
        values (upper(item ->> 'trackCode'), coalesce(nullif(btrim(item ->> 'trackName'), ''), upper(item ->> 'trackCode')), trk.breed)
        returning id into v_track;
      end if;
      insert into public.racing_workouts (horse_id, track_id, work_date, distance_value, distance_unit, surface, time_seconds,
        rank, rank_of, note, status, published_at, source)
      values (v_horse, v_track, (item ->> 'date')::date, (item ->> 'distanceValue')::numeric,
        coalesce(nullif(item ->> 'distanceUnit', ''), 'furlongs'), coalesce(nullif(item ->> 'surface', ''), 'dirt'),
        (item ->> 'timeSeconds')::numeric, nullif(item ->> 'rank', '')::int, nullif(item ->> 'rankOf', '')::int,
        coalesce(item ->> 'note', ''), case when p_publish then 'published' else 'draft' end,
        case when p_publish then now() end, v_source)
      on conflict (horse_id, work_date, track_id) do update set
        distance_value = excluded.distance_value, distance_unit = excluded.distance_unit, surface = excluded.surface,
        time_seconds = excluded.time_seconds, rank = excluded.rank, rank_of = excluded.rank_of, note = excluded.note,
        source = excluded.source,
        status = case when p_publish then 'published' else public.racing_workouts.status end,
        published_at = case when p_publish then coalesce(public.racing_workouts.published_at, now())
                            else public.racing_workouts.published_at end,
        updated_at = now()
      returning id into v_work;
      n_workouts := n_workouts + 1;
      if p_publish then v_works := v_works || v_work; end if;
    end loop;
  end loop;

  if p_publish and n_races > 0 and v_day.status <> 'published' then
    update public.racing_days set status = 'published', published_at = now(), updated_at = now() where id = v_day.id;
  end if;
  select * into v_day from public.racing_days where id = v_day.id;

  v_summary := jsonb_build_object('track', trk.code, 'date', v_day.race_date, 'races', n_races, 'runners', n_runners,
    'officialRaces', n_results, 'history', n_history, 'workouts', n_workouts,
    'horsesCreated', (select count(*) from public.racing_horses) - horses_before,
    'peopleCreated', (select count(*) from public.racing_people) - people_before,
    'published', v_day.status = 'published');
  insert into public.racing_feed_runs (source, actor_id, day_id, track_code, race_date, summary)
  values (v_source, p_actor, v_day.id, trk.code, v_day.race_date, v_summary);
  insert into public.account_events (account_id, actor_id, event, detail)
  values (p_actor, p_actor, 'racing.feed_imported', v_summary || jsonb_build_object('day', v_day.id, 'source', v_source));
  return v_summary || jsonb_build_object('dayId', v_day.id, 'officialRaceIds', to_jsonb(v_official),
    'scratchedRunnerIds', to_jsonb(v_scratched), 'workoutIds', to_jsonb(v_works));
end $$;

-- Recent imports for the publishing tool.
create or replace function public.racing_feed_recent(p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'source', f.source, 'track', f.track_code, 'date', f.race_date,
      'dayId', f.day_id, 'summary', f.summary, 'at', f.created_at,
      'by', (select nullif(btrim(a.first_name || ' ' || a.last_name), '') from public.accounts a where a.id = f.actor_id)) order by f.created_at desc), '[]'::jsonb)
  from (select * from public.racing_feed_runs order by created_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)) f
$$;

do $$ declare f text; begin
  foreach f in array array[
    'racing_day_json(public.racing_days, boolean, boolean)', 'racing_horse(uuid)', 'racing_feed_horse(text, jsonb, text)',
    'racing_feed_person(text, text, text, text)', 'racing_feed_history_row(uuid, text, jsonb)',
    'racing_feed_histories(text, jsonb)', 'racing_feed_history_due(text, integer)',
    'racing_feed_import(uuid, jsonb, boolean)', 'racing_feed_recent(integer)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
