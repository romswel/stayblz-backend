-- LOCAL: apply after 202611100004_drop_bulletin_seen.sql. Non-destructive; adds new tables only.
-- Linked racing data: tracks -> race days -> races -> runners (horse + jockey/driver, trainer, owner),
-- plus workouts. Admins publish a whole race day at once; readers only ever see published days.
-- No sample data: every record is entered or imported by an admin from a real source.
begin;

create table public.racing_tracks (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{2,6}$'),
  name text not null check (length(btrim(name)) between 2 and 80),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  region text not null default '' check (length(region) <= 60),
  breed text not null default 'thoroughbred' check (breed in ('thoroughbred', 'harness', 'quarter_horse')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.racing_people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 2 and 80),
  kind text not null check (kind in ('jockey', 'driver', 'trainer', 'owner')),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index racing_people_name on public.racing_people (kind, lower(name));

create table public.racing_horses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 40),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2,3}$'),
  foaled_year integer check (foaled_year between 1980 and 2100),
  sex text not null default '' check (sex in ('', 'colt', 'filly', 'gelding', 'horse', 'mare', 'ridgling')),
  color text not null default '' check (length(color) <= 30),
  sire text not null default '' check (length(sire) <= 40),
  dam text not null default '' check (length(dam) <= 40),
  dam_sire text not null default '' check (length(dam_sire) <= 40),
  breeder text not null default '' check (length(breeder) <= 80),
  breed text not null default 'thoroughbred' check (breed in ('thoroughbred', 'harness', 'quarter_horse')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index racing_horses_name on public.racing_horses (lower(name), country);

create table public.racing_days (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references public.racing_tracks(id) on delete restrict,
  race_date date not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  notes text not null default '' check (length(notes) <= 1000),
  created_by uuid references public.accounts(id) on delete set null,
  updated_by uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (track_id, race_date),
  check (status = 'draft' or published_at is not null)
);
create index racing_days_date on public.racing_days (race_date, status);

create table public.racing_races (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references public.racing_days(id) on delete cascade,
  race_number integer not null check (race_number between 1 and 40),
  post_time text not null default '' check (post_time = '' or post_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'),
  name text not null default '' check (length(name) <= 100),
  race_type text not null default 'other' check (race_type in ('maiden', 'maiden_claiming', 'claiming',
    'allowance', 'optional_claiming', 'starter', 'stakes', 'handicap', 'trial', 'other')),
  grade integer check (grade between 1 and 3),
  breed text not null default 'thoroughbred' check (breed in ('thoroughbred', 'harness', 'quarter_horse')),
  distance_value numeric(7, 2) check (distance_value > 0 and distance_value < 10000),
  distance_unit text not null default 'furlongs' check (distance_unit in ('furlongs', 'miles', 'yards', 'meters')),
  surface text not null default 'dirt' check (surface in ('dirt', 'turf', 'synthetic', 'all_weather')),
  track_condition text not null default '' check (track_condition in ('', 'fast', 'good', 'firm', 'yielding',
    'soft', 'sloppy', 'muddy', 'sealed', 'heavy', 'wet_fast', 'standard')),
  purse integer check (purse >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  conditions text not null default '' check (length(conditions) <= 500),
  status text not null default 'scheduled' check (status in ('scheduled', 'official', 'cancelled')),
  winning_time text not null default '' check (length(winning_time) <= 20),
  -- [{"pool": "Win", "combination": "4", "amount": 7.40}]
  payouts jsonb not null default '[]' check (jsonb_typeof(payouts) = 'array' and jsonb_array_length(payouts) <= 40),
  footnotes text not null default '' check (length(footnotes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (day_id, race_number)
);

create table public.racing_runners (
  id uuid primary key default gen_random_uuid(),
  race_id uuid not null references public.racing_races(id) on delete cascade,
  horse_id uuid not null references public.racing_horses(id) on delete restrict,
  program_number text not null check (program_number ~ '^[0-9]{1,2}[A-Z]?$'),
  post_position integer check (post_position between 1 and 30),
  jockey_id uuid references public.racing_people(id) on delete restrict,
  trainer_id uuid references public.racing_people(id) on delete restrict,
  owner_id uuid references public.racing_people(id) on delete restrict,
  weight integer check (weight between 50 and 200),
  medication text not null default '' check (length(medication) <= 10),
  equipment text not null default '' check (length(equipment) <= 20),
  morning_line text not null default '' check (morning_line = '' or morning_line ~ '^[0-9]{1,3}-[0-9]{1,2}$'),
  scratched boolean not null default false,
  scratch_reason text not null default '' check (length(scratch_reason) <= 80),
  finish_position integer check (finish_position between 1 and 30),
  beaten_lengths numeric(6, 2) check (beaten_lengths >= 0),
  final_odds numeric(8, 2) check (final_odds >= 0),
  earnings integer check (earnings >= 0),
  comment text not null default '' check (length(comment) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (race_id, horse_id),
  unique (race_id, program_number),
  check (not scratched or finish_position is null)
);
create index racing_runners_horse on public.racing_runners (horse_id);
create index racing_runners_jockey on public.racing_runners (jockey_id);
create index racing_runners_trainer on public.racing_runners (trainer_id);
create index racing_runners_owner on public.racing_runners (owner_id);

create table public.racing_workouts (
  id uuid primary key default gen_random_uuid(),
  horse_id uuid not null references public.racing_horses(id) on delete restrict,
  track_id uuid not null references public.racing_tracks(id) on delete restrict,
  work_date date not null,
  distance_value numeric(7, 2) not null check (distance_value > 0 and distance_value < 10000),
  distance_unit text not null default 'furlongs' check (distance_unit in ('furlongs', 'miles', 'yards', 'meters')),
  surface text not null default 'dirt' check (surface in ('dirt', 'turf', 'synthetic', 'all_weather')),
  time_seconds numeric(6, 2) not null check (time_seconds > 0 and time_seconds < 600),
  rank integer check (rank >= 1),
  rank_of integer check (rank_of >= 1),
  note text not null default '' check (length(note) <= 20),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (horse_id, work_date, track_id),
  check (rank is null or rank_of is null or rank <= rank_of),
  check (status = 'draft' or published_at is not null)
);
create index racing_workouts_date on public.racing_workouts (work_date desc, status);

do $$
declare t text;
begin
  foreach t in array array['racing_tracks', 'racing_people', 'racing_horses', 'racing_days', 'racing_races',
    'racing_runners', 'racing_workouts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- ===== Formatting helpers =====
create function public.racing_number_label(v numeric) returns text
language sql immutable set search_path = '' as $$
  select case when v is null then null
    else regexp_replace(regexp_replace(v::text, '(\.[0-9]*?)0+$', '\1'), '\.$', '') end
$$;

create function public.racing_distance_label(v numeric, u text) returns text
language sql immutable set search_path = '' as $$
  select case when v is null then '' else public.racing_number_label(v) ||
    case u when 'furlongs' then ' f' when 'miles' then ' mi' when 'yards' then ' yd' when 'meters' then ' m' else '' end end
$$;

create function public.racing_time_label(s numeric) returns text
language sql immutable set search_path = '' as $$
  select case when s is null then '' when s >= 60
    then floor(s / 60)::int::text || ':' || to_char(s - floor(s / 60) * 60, 'FM00.00')
    else to_char(s, 'FM90.00') end
$$;

-- A day is public once it is published and its publish time has passed.
create function public.racing_day_public(d public.racing_days) returns boolean
language sql stable set search_path = '' as $$
  select d.status = 'published' and d.published_at <= now()
$$;

-- ===== JSON shapes shared by the API =====
create function public.racing_track_json(t public.racing_tracks) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', t.id, 'code', t.code, 'name', t.name, 'country', t.country,
    'region', t.region, 'breed', t.breed)
$$;

create function public.racing_person_ref(p_id uuid) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind) from public.racing_people p where p.id = p_id
$$;

create function public.racing_horse_json(h public.racing_horses) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', h.id, 'name', h.name, 'country', h.country, 'foaled', h.foaled_year,
    'sex', h.sex, 'color', h.color, 'sire', h.sire, 'dam', h.dam, 'damSire', h.dam_sire,
    'breeder', h.breeder, 'breed', h.breed)
$$;

create function public.racing_runner_json(rn public.racing_runners, p_results boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', rn.id, 'program', rn.program_number, 'post', rn.post_position,
    'horse', (select public.racing_horse_json(h) from public.racing_horses h where h.id = rn.horse_id),
    'jockey', public.racing_person_ref(rn.jockey_id),
    'trainer', public.racing_person_ref(rn.trainer_id),
    'owner', public.racing_person_ref(rn.owner_id),
    'weight', rn.weight, 'medication', rn.medication, 'equipment', rn.equipment,
    'morningLine', rn.morning_line, 'scratched', rn.scratched, 'scratchReason', rn.scratch_reason)
  || case when p_results then jsonb_build_object('finish', rn.finish_position,
       'lengths', rn.beaten_lengths, 'odds', rn.final_odds, 'earnings', rn.earnings, 'comment', rn.comment)
     else '{}'::jsonb end
$$;

-- p_admin shows results being entered before the race is marked official.
create function public.racing_race_json(r public.racing_races, p_runners boolean, p_admin boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', r.id, 'number', r.race_number, 'postTime', r.post_time, 'name', r.name, 'type', r.race_type,
    'grade', r.grade, 'breed', r.breed,
    'distance', public.racing_distance_label(r.distance_value, r.distance_unit),
    'distanceValue', r.distance_value, 'distanceUnit', r.distance_unit, 'surface', r.surface,
    'condition', r.track_condition, 'purse', r.purse, 'currency', r.currency, 'conditions', r.conditions,
    'status', r.status,
    'winningTime', case when r.status = 'official' or p_admin then r.winning_time else '' end,
    'payouts', case when r.status = 'official' or p_admin then r.payouts else '[]'::jsonb end,
    'footnotes', case when r.status = 'official' or p_admin then r.footnotes else '' end,
    'runnerCount', (select count(*) from public.racing_runners x where x.race_id = r.id and not x.scratched))
  || case when p_runners then jsonb_build_object('runners', coalesce((
       select jsonb_agg(public.racing_runner_json(x, r.status = 'official' or p_admin)
         order by case when r.status = 'official' then coalesce(x.finish_position, 99) else 0 end,
           x.scratched, x.post_position nulls last, x.program_number)
       from public.racing_runners x where x.race_id = r.id), '[]'::jsonb))
     else '{}'::jsonb end
$$;

create function public.racing_day_json(d public.racing_days, p_runners boolean, p_admin boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', d.id, 'date', d.race_date, 'status', d.status, 'publishedAt', d.published_at, 'notes', d.notes,
    'track', (select public.racing_track_json(t) from public.racing_tracks t where t.id = d.track_id),
    'races', coalesce((select jsonb_agg(public.racing_race_json(r, p_runners, p_admin) order by r.race_number)
      from public.racing_races r where r.day_id = d.id), '[]'::jsonb))
$$;

-- ===== Public reads (published race days only) =====
create function public.racing_calendar(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('date', x.race_date, 'tracks', x.tracks, 'races', x.races,
    'official', x.official) order by x.race_date), '[]'::jsonb)
  from (
    select d.race_date, count(distinct d.id) tracks, count(r.id) races,
      count(r.id) filter (where r.status = 'official') official
    from public.racing_days d left join public.racing_races r on r.day_id = d.id
    where public.racing_day_public(d) and d.race_date between p_from and least(p_to, p_from + 400)
    group by d.race_date
  ) x
$$;

create function public.racing_days_on(p_date date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', d.id, 'date', d.race_date, 'notes', d.notes, 'track', public.racing_track_json(t),
      'races', (select count(*) from public.racing_races r where r.day_id = d.id),
      'official', (select count(*) from public.racing_races r where r.day_id = d.id and r.status = 'official'),
      'stakes', (select count(*) from public.racing_races r where r.day_id = d.id and r.race_type = 'stakes'),
      'firstPost', (select min(r.post_time) from public.racing_races r where r.day_id = d.id and r.post_time <> ''),
      'raceList', coalesce((select jsonb_agg(public.racing_race_json(r, false, false) || jsonb_build_object(
          'winner', (select jsonb_build_object('horse', h.name, 'horseId', h.id, 'odds', w.final_odds)
            from public.racing_runners w join public.racing_horses h on h.id = w.horse_id
            where w.race_id = r.id and w.finish_position = 1 and r.status = 'official' limit 1))
        order by r.race_number) from public.racing_races r where r.day_id = d.id), '[]'::jsonb)
    ) order by t.name), '[]'::jsonb)
  from public.racing_days d join public.racing_tracks t on t.id = d.track_id
  where public.racing_day_public(d) and d.race_date = p_date
$$;

create function public.racing_day(p_id uuid, p_admin boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.racing_day_json(d, true, p_admin) from public.racing_days d
  where d.id = p_id and (p_admin or public.racing_day_public(d))
$$;

create function public.racing_race(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'race', public.racing_race_json(r, true, false),
    'day', jsonb_build_object('id', d.id, 'date', d.race_date),
    'track', public.racing_track_json(t),
    'previous', (select jsonb_build_object('id', p.id, 'number', p.race_number) from public.racing_races p
      where p.day_id = d.id and p.race_number < r.race_number order by p.race_number desc limit 1),
    'next', (select jsonb_build_object('id', n.id, 'number', n.race_number) from public.racing_races n
      where n.day_id = d.id and n.race_number > r.race_number order by n.race_number limit 1))
  from public.racing_races r
  join public.racing_days d on d.id = r.day_id
  join public.racing_tracks t on t.id = d.track_id
  where r.id = p_id and public.racing_day_public(d)
$$;

-- One published start, from a horse's or a person's point of view.
create function public.racing_start_json(rn public.racing_runners) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'runnerId', rn.id, 'raceId', r.id, 'dayId', d.id, 'date', d.race_date, 'track', t.name, 'trackCode', t.code,
    'race', r.race_number, 'raceName', r.name, 'type', r.race_type, 'grade', r.grade, 'status', r.status,
    'distance', public.racing_distance_label(r.distance_value, r.distance_unit), 'surface', r.surface,
    'horse', jsonb_build_object('id', h.id, 'name', h.name),
    'jockey', public.racing_person_ref(rn.jockey_id), 'trainer', public.racing_person_ref(rn.trainer_id),
    'owner', public.racing_person_ref(rn.owner_id), 'program', rn.program_number,
    'scratched', rn.scratched,
    'finish', case when r.status = 'official' then rn.finish_position end,
    'lengths', case when r.status = 'official' then rn.beaten_lengths end,
    'odds', case when r.status = 'official' then rn.final_odds end,
    'earnings', case when r.status = 'official' then rn.earnings end,
    'field', (select count(*) from public.racing_runners x where x.race_id = r.id and not x.scratched))
  from public.racing_races r
  join public.racing_days d on d.id = r.day_id
  join public.racing_tracks t on t.id = d.track_id
  join public.racing_horses h on h.id = rn.horse_id
  where r.id = rn.race_id
$$;

create function public.racing_stats_json(p_runner_ids uuid[]) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('starts', count(*), 'wins', count(*) filter (where rn.finish_position = 1),
    'places', count(*) filter (where rn.finish_position = 2), 'shows', count(*) filter (where rn.finish_position = 3),
    'earnings', coalesce(sum(rn.earnings), 0))
  from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
  where rn.id = any (p_runner_ids) and r.status = 'official' and not rn.scratched
$$;

create function public.racing_horse(p_id uuid) returns jsonb
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
    'workouts', works);
end $$;

create function public.racing_person(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.racing_people; ids uuid[];
begin
  select * into p from public.racing_people where id = p_id;
  if not found then return null; end if;
  select coalesce(array_agg(rn.id), '{}') into ids from public.racing_runners rn
    join public.racing_races r on r.id = rn.race_id join public.racing_days d on d.id = r.day_id
    where (rn.jockey_id = p_id or rn.trainer_id = p_id or rn.owner_id = p_id) and public.racing_day_public(d);
  if cardinality(ids) = 0 then return null; end if;
  return jsonb_build_object(
    'person', jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind, 'country', p.country),
    'stats', public.racing_stats_json(ids),
    'byYear', coalesce((select jsonb_agg(y.j order by y.yr desc) from (
        select extract(year from d.race_date)::int yr, jsonb_build_object('year', extract(year from d.race_date)::int)
          || public.racing_stats_json(array_agg(rn.id)) j
        from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
        join public.racing_days d on d.id = r.day_id where rn.id = any (ids)
        group by extract(year from d.race_date)) y), '[]'::jsonb),
    'upcoming', coalesce((select jsonb_agg(public.racing_start_json(rn) order by d.race_date, r.race_number)
      from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
      join public.racing_days d on d.id = r.day_id
      where rn.id = any (ids) and r.status = 'scheduled' and d.race_date >= current_date and not rn.scratched), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(s.j order by s.dt desc, s.n desc) from (
        select public.racing_start_json(rn) j, d.race_date dt, r.race_number n
        from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
        join public.racing_days d on d.id = r.day_id
        where rn.id = any (ids) and r.status = 'official' order by d.race_date desc, r.race_number desc limit 60) s), '[]'::jsonb));
end $$;

-- Plain-text search over horses, people and tracks that appear in published racing.
create function public.racing_search(p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := btrim(coalesce(p_query, ''));
begin
  if length(q) < 2 then return jsonb_build_object('horses', '[]'::jsonb, 'people', '[]'::jsonb, 'tracks', '[]'::jsonb); end if;
  q := '%' || replace(replace(replace(left(q, 60), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return jsonb_build_object(
    'horses', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'country', h.country,
        'sire', h.sire, 'dam', h.dam) order by h.name) from (
      select h.* from public.racing_horses h where h.name ilike q and (
        exists (select 1 from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
          join public.racing_days d on d.id = r.day_id where rn.horse_id = h.id and public.racing_day_public(d))
        or exists (select 1 from public.racing_workouts w where w.horse_id = h.id and w.status = 'published'
          and w.published_at <= now()))
      order by h.name limit 20) h), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind) order by p.name)
      from (select p.* from public.racing_people p where p.name ilike q and exists (
          select 1 from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
          join public.racing_days d on d.id = r.day_id
          where (rn.jockey_id = p.id or rn.trainer_id = p.id or rn.owner_id = p.id) and public.racing_day_public(d))
        order by p.name limit 20) p), '[]'::jsonb),
    'tracks', coalesce((select jsonb_agg(public.racing_track_json(t) order by t.name)
      from public.racing_tracks t where t.id in (select t2.id from public.racing_tracks t2
        where (t2.name ilike q or t2.code ilike q) and exists (
          select 1 from public.racing_days d where d.track_id = t2.id and public.racing_day_public(d))
        order by t2.name limit 10)), '[]'::jsonb));
end $$;

-- Standings from official, published Stayblz results only (not complete season records).
create function public.racing_leaders(p_role text, p_year integer, p_breed text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if p_role not in ('jockey', 'trainer', 'owner', 'horse') then raise exception 'invalid_role'; end if;
  with starts as (
    select case p_role when 'jockey' then rn.jockey_id when 'trainer' then rn.trainer_id
        when 'owner' then rn.owner_id else rn.horse_id end who,
      rn.finish_position f, coalesce(rn.earnings, 0) e
    from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
    join public.racing_days d on d.id = r.day_id
    where public.racing_day_public(d) and r.status = 'official' and not rn.scratched
      and (p_year is null or extract(year from d.race_date) = p_year)
      and (p_breed is null or r.breed = p_breed)
  ), agg as (
    select who, count(*) starts, count(*) filter (where f = 1) wins, count(*) filter (where f = 2) places,
      count(*) filter (where f = 3) shows, sum(e) earnings
    from starts where who is not null group by who
  ), ranked as (
    select a.*, coalesce(p.name, h.name) as who_name from agg a
    left join public.racing_people p on p.id = a.who left join public.racing_horses h on h.id = a.who
    order by a.wins desc, a.earnings desc, a.places desc, a.shows desc, who_name limit lim
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', a.who, 'name', a.who_name, 'starts', a.starts,
      'wins', a.wins, 'places', a.places, 'shows', a.shows, 'earnings', a.earnings,
      'winPct', round(100.0 * a.wins / a.starts))
    order by a.wins desc, a.earnings desc, a.places desc, a.shows desc, a.who_name), '[]'::jsonb)
  into result from ranked a;
  return result;
end $$;

create function public.racing_stakes(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.racing_race_json(r, false, false) || jsonb_build_object(
      'date', d.race_date, 'dayId', d.id, 'track', public.racing_track_json(t),
      'winner', (select jsonb_build_object('horse', h.name, 'horseId', h.id) from public.racing_runners w
        join public.racing_horses h on h.id = w.horse_id
        where w.race_id = r.id and w.finish_position = 1 and r.status = 'official' limit 1))
    order by d.race_date, t.name, r.race_number), '[]'::jsonb)
  from public.racing_races r join public.racing_days d on d.id = r.day_id
  join public.racing_tracks t on t.id = d.track_id
  where public.racing_day_public(d) and r.race_type = 'stakes'
    and d.race_date between p_from and least(p_to, p_from + 400)
$$;

create function public.racing_workout_json(w public.racing_workouts) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('id', w.id, 'date', w.work_date, 'status', w.status,
    'horse', (select jsonb_build_object('id', h.id, 'name', h.name) from public.racing_horses h where h.id = w.horse_id),
    'track', (select public.racing_track_json(t) from public.racing_tracks t where t.id = w.track_id),
    'distance', public.racing_distance_label(w.distance_value, w.distance_unit),
    'distanceValue', w.distance_value, 'distanceUnit', w.distance_unit, 'surface', w.surface,
    'time', public.racing_time_label(w.time_seconds), 'timeSeconds', w.time_seconds,
    'rank', w.rank, 'rankOf', w.rank_of, 'note', w.note)
$$;

create function public.racing_workouts_list(p_from date, p_to date, p_track text, p_admin boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.racing_workout_json(w) order by w.work_date desc, t.name, w.time_seconds), '[]'::jsonb)
  from public.racing_workouts w join public.racing_tracks t on t.id = w.track_id
  where w.id in (select w2.id from public.racing_workouts w2
    join public.racing_tracks t2 on t2.id = w2.track_id
    where w2.work_date between p_from and least(p_to, p_from + 100)
      and (p_admin or (w2.status = 'published' and w2.published_at <= now()))
      and (p_track is null or t2.code = p_track)
    order by w2.work_date desc limit 500)
$$;

-- Flat rows for the overview, landing and report pages (same shape as the older records).
create function public.racing_section(p_kind text, p_offset integer, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare rows jsonb; off integer := greatest(coalesce(p_offset, 0), 0);
  lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  if p_kind = 'racecards' then
    select coalesce(jsonb_agg(x.j order by x.dt, x.tn, x.n), '[]'::jsonb) into rows from (
      select jsonb_strip_nulls(jsonb_build_object('id', r.id::text,
          'name', coalesce(nullif(r.name, ''), 'Race ' || r.race_number), 'track', t.name,
          'date', d.race_date::text, 'time', nullif(r.post_time, ''), 'race', 'Race ' || r.race_number,
          'surface', initcap(replace(r.surface, '_', ' ')),
          'distance', nullif(public.racing_distance_label(r.distance_value, r.distance_unit), ''),
          'runners', (select count(*) from public.racing_runners x where x.race_id = r.id and not x.scratched),
          'category', case when r.breed = 'harness' then 'harness' end)) j,
        d.race_date dt, t.name tn, r.race_number n
      from public.racing_races r join public.racing_days d on d.id = r.day_id
      join public.racing_tracks t on t.id = d.track_id
      where public.racing_day_public(d) and r.status = 'scheduled' and d.race_date >= current_date
      order by d.race_date, t.name, r.race_number offset off limit lim) x;
  elsif p_kind = 'results' then
    select coalesce(jsonb_agg(x.j order by x.dt desc, x.tn, x.n desc), '[]'::jsonb) into rows from (
      select jsonb_strip_nulls(jsonb_build_object('id', r.id::text,
          'name', coalesce(h.name, nullif(r.name, ''), 'Race ' || r.race_number), 'track', t.name,
          'date', d.race_date::text, 'time', nullif(r.post_time, ''), 'race', 'Race ' || r.race_number,
          'margin', (select public.racing_number_label(s.beaten_lengths) || ' lengths' from public.racing_runners s
            where s.race_id = r.id and s.finish_position = 2 and s.beaten_lengths is not null limit 1),
          'detail', nullif(concat_ws(' · ',
            (select 'Jockey ' || p.name from public.racing_people p where p.id = w.jockey_id),
            (select 'Trainer ' || p.name from public.racing_people p where p.id = w.trainer_id),
            case when w.final_odds is not null then public.racing_number_label(w.final_odds) || '-1' end), ''),
          'category', case when r.breed = 'harness' then 'harness' end)) j,
        d.race_date dt, t.name tn, r.race_number n
      from public.racing_races r join public.racing_days d on d.id = r.day_id
      join public.racing_tracks t on t.id = d.track_id
      left join public.racing_runners w on w.race_id = r.id and w.finish_position = 1
      left join public.racing_horses h on h.id = w.horse_id
      where public.racing_day_public(d) and r.status = 'official'
      order by d.race_date desc, t.name, r.race_number desc offset off limit lim) x;
  elsif p_kind = 'workouts' then
    select coalesce(jsonb_agg(x.j order by x.dt desc, x.tn, x.s), '[]'::jsonb) into rows from (
      select jsonb_strip_nulls(jsonb_build_object('id', w.id::text, 'name', h.name, 'track', t.name,
          'date', w.work_date::text, 'time', public.racing_time_label(w.time_seconds),
          'distance', public.racing_distance_label(w.distance_value, w.distance_unit),
          'detail', nullif(concat_ws(' · ', nullif(w.note, ''),
            case when w.rank is not null and w.rank_of is not null then w.rank || '/' || w.rank_of end), ''),
          'category', case when h.breed = 'harness' then 'harness' end)) j,
        w.work_date dt, t.name tn, w.time_seconds s
      from public.racing_workouts w join public.racing_horses h on h.id = w.horse_id
      join public.racing_tracks t on t.id = w.track_id
      where w.status = 'published' and w.published_at <= now()
      order by w.work_date desc, t.name, w.time_seconds offset off limit lim) x;
  elsif p_kind in ('horses', 'jockeys', 'trainers') then
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', e ->> 'id', 'name', e ->> 'name',
        'starts', (e ->> 'starts')::int, 'wins', (e ->> 'wins')::int,
        'detail', case when p_kind = 'horses' then 'Earnings ' || to_char((e ->> 'earnings')::numeric, 'FM999,999,999,990')
          else 'Win rate ' || (e ->> 'winPct') || '%' end))) , '[]'::jsonb) into rows
    from (select e from jsonb_array_elements(public.racing_leaders(
        case p_kind when 'horses' then 'horse' when 'jockeys' then 'jockey' else 'trainer' end, null, null, off + lim)) e
      offset off) s;
  elsif p_kind = 'stakes' then
    select coalesce(jsonb_agg(x.j order by x.dt, x.tn, x.n), '[]'::jsonb) into rows from (
      select jsonb_strip_nulls(jsonb_build_object('id', r.id::text,
          'name', coalesce(nullif(r.name, ''), 'Stakes race'), 'track', t.name, 'date', d.race_date::text,
          'surface', initcap(replace(r.surface, '_', ' ')),
          'distance', nullif(public.racing_distance_label(r.distance_value, r.distance_unit), ''),
          'runners', (select count(*) from public.racing_runners x where x.race_id = r.id and not x.scratched),
          'detail', nullif(concat_ws(' · ', case when r.grade is not null then 'Grade ' || r.grade end,
            case when r.purse is not null then r.currency || ' ' || to_char(r.purse, 'FM999,999,999,990') end), ''),
          'category', case when r.breed = 'harness' then 'harness' end)) j,
        d.race_date dt, t.name tn, r.race_number n
      from public.racing_races r join public.racing_days d on d.id = r.day_id
      join public.racing_tracks t on t.id = d.track_id
      where public.racing_day_public(d) and r.race_type = 'stakes' and d.race_date >= current_date
      order by d.race_date, t.name, r.race_number offset off limit lim) x;
  else
    raise exception 'invalid_kind';
  end if;
  return rows;
end $$;

-- ===== Admin (staff) reads and atomic writes =====
create function public.racing_assert_staff(p_actor uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_actor is null or not exists (select 1 from public.accounts a where a.id = p_actor and a.status = 'active'
      and a.platform_role in ('admin', 'superadmin')) then
    raise exception 'not_allowed';
  end if;
end $$;

create function public.racing_admin_days(p_from date, p_to date) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'date', d.race_date, 'status', d.status,
      'publishedAt', d.published_at, 'updatedAt', d.updated_at, 'track', public.racing_track_json(t),
      'races', (select count(*) from public.racing_races r where r.day_id = d.id),
      'official', (select count(*) from public.racing_races r where r.day_id = d.id and r.status = 'official'),
      'runners', (select count(*) from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
        where r.day_id = d.id))
    order by d.race_date desc, t.name), '[]'::jsonb)
  from public.racing_days d join public.racing_tracks t on t.id = d.track_id
  where d.race_date between p_from and least(p_to, p_from + 800)
$$;

-- Lookup for the publishing tool (drafts included). p_kind: horse, track, jockey, driver, trainer, owner.
create function public.racing_lookup(p_kind text, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := '%' || replace(replace(replace(left(btrim(coalesce(p_query, '')), 60), '\', '\\'), '%', '\%'), '_', '\_') || '%';
begin
  if p_kind = 'horse' then
    return coalesce((select jsonb_agg(public.racing_horse_json(h) order by h.name) from public.racing_horses h
      where h.id in (select h2.id from public.racing_horses h2 where h2.name ilike q order by h2.name limit 25)), '[]'::jsonb);
  elsif p_kind = 'track' then
    return coalesce((select jsonb_agg(public.racing_track_json(t) order by t.name) from public.racing_tracks t
      where t.id in (select t2.id from public.racing_tracks t2 where t2.name ilike q or t2.code ilike q
        order by t2.name limit 50)), '[]'::jsonb);
  elsif p_kind in ('jockey', 'driver', 'trainer', 'owner') then
    return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind, 'country', p.country)
        order by p.name) from (
      select * from public.racing_people p where p.kind = p_kind and p.name ilike q order by p.name limit 25) p), '[]'::jsonb);
  end if;
  raise exception 'invalid_kind';
end $$;

-- Results for one race, saved together. p_data: {status, winningTime, condition, payouts, footnotes,
-- runners: [{id, finish, lengths, odds, earnings, comment}]}. Finish positions must be unique.
create function public.racing_save_results(p_actor uuid, p_race uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.racing_races; item jsonb; updated integer;
begin
  perform public.racing_assert_staff(p_actor);
  select * into r from public.racing_races where id = p_race for update;
  if not found then raise exception 'unknown_race'; end if;
  for item in select * from jsonb_array_elements(coalesce(p_data -> 'runners', '[]'::jsonb)) loop
    update public.racing_runners set
      finish_position = nullif(item ->> 'finish', '')::int,
      beaten_lengths = nullif(item ->> 'lengths', '')::numeric,
      final_odds = nullif(item ->> 'odds', '')::numeric,
      earnings = nullif(item ->> 'earnings', '')::int,
      comment = coalesce(item ->> 'comment', ''),
      updated_at = now()
    where id = (item ->> 'id')::uuid and race_id = p_race;
    get diagnostics updated = row_count;
    if updated = 0 then raise exception 'unknown_runner'; end if;
  end loop;
  if exists (select 1 from public.racing_runners where race_id = p_race and finish_position is not null
      group by finish_position having count(*) > 1) then
    raise exception 'duplicate_finish';
  end if;
  if coalesce(p_data ->> 'status', r.status) = 'official' and not exists (
      select 1 from public.racing_runners where race_id = p_race and finish_position = 1) then
    raise exception 'winner_required';
  end if;
  update public.racing_races set
    status = coalesce(p_data ->> 'status', status),
    winning_time = coalesce(p_data ->> 'winningTime', winning_time),
    track_condition = coalesce(p_data ->> 'condition', track_condition),
    payouts = coalesce(p_data -> 'payouts', payouts),
    footnotes = coalesce(p_data ->> 'footnotes', footnotes),
    updated_at = now()
  where id = p_race;
  insert into public.account_events (account_id, actor_id, event, detail)
  values (p_actor, p_actor, 'racing.results_saved', jsonb_build_object('race', p_race,
    'status', coalesce(p_data ->> 'status', r.status)));
  return public.racing_day(r.day_id, true);
end $$;

-- Imports entries for one race day in one transaction. Each row is one runner:
-- {race, postTime, raceName, raceType, grade, distance, unit, surface, purse, conditions,
--  program, post, horse, country, sire, dam, sex, foaled, jockey, trainer, owner, weight, ml, medication, equipment}
-- Horses and people are matched by name (case-insensitive) or created. Existing runners are updated.
create function public.racing_import_card(p_actor uuid, p_day uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d public.racing_days; trk public.racing_tracks; item jsonb; v_race uuid; v_horse uuid;
  rider_kind text; v_rider uuid; v_trainer uuid; v_owner uuid;
  races_created integer := 0; horses_created integer := 0; people_created integer := 0; runners integer := 0;
begin
  perform public.racing_assert_staff(p_actor);
  select * into d from public.racing_days where id = p_day for update;
  if not found then raise exception 'unknown_day'; end if;
  select * into trk from public.racing_tracks where id = d.track_id;
  rider_kind := case when trk.breed = 'harness' then 'driver' else 'jockey' end;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 400 then
    raise exception 'invalid_rows';
  end if;
  for item in select * from jsonb_array_elements(p_rows) loop
    v_race := null; v_horse := null;
    select r.id into v_race from public.racing_races r where r.day_id = p_day and r.race_number = (item ->> 'race')::int;
    if v_race is null then
      insert into public.racing_races (day_id, race_number, post_time, name, race_type, grade, breed,
        distance_value, distance_unit, surface, purse, conditions)
      values (p_day, (item ->> 'race')::int, coalesce(item ->> 'postTime', ''), coalesce(item ->> 'raceName', ''),
        coalesce(nullif(item ->> 'raceType', ''), 'other'), nullif(item ->> 'grade', '')::int, trk.breed,
        nullif(item ->> 'distance', '')::numeric, coalesce(nullif(item ->> 'unit', ''), 'furlongs'),
        coalesce(nullif(item ->> 'surface', ''), 'dirt'), nullif(item ->> 'purse', '')::int,
        coalesce(item ->> 'conditions', ''))
      returning id into v_race;
      races_created := races_created + 1;
    end if;

    select h.id into v_horse from public.racing_horses h
      where lower(h.name) = lower(btrim(item ->> 'horse')) and h.country = coalesce(item ->> 'country', '');
    if v_horse is null then
      insert into public.racing_horses (name, country, sire, dam, sex, foaled_year, breed)
      values (btrim(item ->> 'horse'), coalesce(item ->> 'country', ''), coalesce(item ->> 'sire', ''),
        coalesce(item ->> 'dam', ''), coalesce(item ->> 'sex', ''), nullif(item ->> 'foaled', '')::int, trk.breed)
      returning id into v_horse;
      horses_created := horses_created + 1;
    end if;

    v_rider := null; v_trainer := null; v_owner := null;
    if coalesce(btrim(item ->> 'jockey'), '') <> '' then
      select p.id into v_rider from public.racing_people p where p.kind = rider_kind and lower(p.name) = lower(btrim(item ->> 'jockey'));
      if v_rider is null then
        insert into public.racing_people (name, kind) values (btrim(item ->> 'jockey'), rider_kind) returning id into v_rider;
        people_created := people_created + 1;
      end if;
    end if;
    if coalesce(btrim(item ->> 'trainer'), '') <> '' then
      select p.id into v_trainer from public.racing_people p where p.kind = 'trainer' and lower(p.name) = lower(btrim(item ->> 'trainer'));
      if v_trainer is null then
        insert into public.racing_people (name, kind) values (btrim(item ->> 'trainer'), 'trainer') returning id into v_trainer;
        people_created := people_created + 1;
      end if;
    end if;
    if coalesce(btrim(item ->> 'owner'), '') <> '' then
      select p.id into v_owner from public.racing_people p where p.kind = 'owner' and lower(p.name) = lower(btrim(item ->> 'owner'));
      if v_owner is null then
        insert into public.racing_people (name, kind) values (btrim(item ->> 'owner'), 'owner') returning id into v_owner;
        people_created := people_created + 1;
      end if;
    end if;

    insert into public.racing_runners (race_id, horse_id, program_number, post_position, jockey_id, trainer_id,
      owner_id, weight, medication, equipment, morning_line)
    values (v_race, v_horse, upper(btrim(item ->> 'program')), nullif(item ->> 'post', '')::int, v_rider, v_trainer, v_owner,
      nullif(item ->> 'weight', '')::int, coalesce(item ->> 'medication', ''), coalesce(item ->> 'equipment', ''),
      coalesce(item ->> 'ml', ''))
    on conflict (race_id, horse_id) do update set
      program_number = excluded.program_number, post_position = excluded.post_position,
      jockey_id = excluded.jockey_id, trainer_id = excluded.trainer_id, owner_id = excluded.owner_id,
      weight = excluded.weight, medication = excluded.medication, equipment = excluded.equipment,
      morning_line = excluded.morning_line, updated_at = now();
    runners := runners + 1;
  end loop;
  update public.racing_days set updated_at = now(), updated_by = p_actor where id = p_day;
  insert into public.account_events (account_id, actor_id, event, detail)
  values (p_actor, p_actor, 'racing.card_imported', jsonb_build_object('day', p_day, 'runners', runners,
    'racesCreated', races_created, 'horsesCreated', horses_created, 'peopleCreated', people_created));
  return jsonb_build_object('runners', runners, 'racesCreated', races_created,
    'horsesCreated', horses_created, 'peopleCreated', people_created);
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'racing_number_label(numeric)', 'racing_distance_label(numeric, text)', 'racing_time_label(numeric)',
    'racing_day_public(public.racing_days)', 'racing_track_json(public.racing_tracks)', 'racing_person_ref(uuid)',
    'racing_horse_json(public.racing_horses)', 'racing_runner_json(public.racing_runners, boolean)',
    'racing_race_json(public.racing_races, boolean, boolean)', 'racing_day_json(public.racing_days, boolean, boolean)',
    'racing_calendar(date, date)', 'racing_days_on(date)', 'racing_day(uuid, boolean)', 'racing_race(uuid)',
    'racing_start_json(public.racing_runners)', 'racing_stats_json(uuid[])', 'racing_horse(uuid)',
    'racing_person(uuid)', 'racing_search(text)', 'racing_leaders(text, integer, text, integer)',
    'racing_stakes(date, date)', 'racing_workout_json(public.racing_workouts)',
    'racing_workouts_list(date, date, text, boolean)', 'racing_section(text, integer, integer)',
    'racing_assert_staff(uuid)', 'racing_admin_days(date, date)', 'racing_lookup(text, text)',
    'racing_save_results(uuid, uuid, jsonb)', 'racing_import_card(uuid, uuid, jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
