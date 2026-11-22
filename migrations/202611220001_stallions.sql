-- Stayblz Stallions: owners showcase their stallions, breeders find, compare and check them against their mares,
-- and ask about a breeding (the request goes to the owner's Stayblz Chat with a stallion card, and is tracked on
-- both sides). Apply after 202611210002_billing.sql. Safe to run again.
--
-- * stallions             one row per stallion. Owner-stated facts (fee, record, genetics, fertility) are labelled
--                         as the owner's in the app; facts from Stayblz racing data are computed, never typed.
-- * stallion_files        photos, videos and PDFs (same storage rules as Marketplace files, under stayblz/stallions/).
-- * stallion_saves        "Save" (a breeder's shortlist); the count is shown on cards.
-- * stallion_views        page views per day, for the owner's stats.
-- * stallion_inquiries    breeding requests: who asked, which mare, which season, and the owner's status.
-- * stallion_mares        a member's saved mares (pedigree + genetics) for mating checks and requests.
-- * Billing               "Featured stallion" products (effect stallion_feature), like featured Marketplace listings.
--
-- Pedigrees are JSON objects keyed by path: "s" = sire, "d" = dam, "ds" = dam's sire, "sss" = sire's sire's sire...
-- up to 4 generations for a stallion (30 names) and 3 for a mare (14). Offspring statistics only ever count horses
-- already on public Stayblz racing pages (racing_horse_public), so draft or unlicensed data never leaks into totals.
--
-- Same rules as the rest of Stayblz: RLS on, no browser grants, the API (service role) checks every permission.
begin;

-- ---------- Helpers ----------

-- A horse name as a matching key: lower case, single spaces, no country suffix ("Frankel (GB)" -> "frankel").
create or replace function public.stallion_key(p text) returns text
language sql immutable set search_path = '' as $$
  select lower(btrim(regexp_replace(regexp_replace(coalesce(p, ''), '\s*\([A-Za-z]{2,3}\)\s*$', ''), '\s+', ' ', 'g')))
$$;

create or replace function public.stallion_furlongs(p_value numeric, p_unit text) returns numeric
language sql immutable set search_path = '' as $$
  select case when p_value is null then null
    when p_unit = 'miles' then p_value * 8
    when p_unit = 'yards' then p_value / 220
    when p_unit = 'meters' then p_value / 201.168
    else p_value end
$$;

-- Offspring are found by their sire's (and dam's sire's) name.
create index if not exists racing_horses_sire_key on public.racing_horses (public.stallion_key(sire)) where sire <> '';
create index if not exists racing_horses_damsire_key on public.racing_horses (public.stallion_key(dam_sire)) where dam_sire <> '';
create index if not exists racing_horses_name_key on public.racing_horses (public.stallion_key(name));

-- ---------- Tables ----------

create table if not exists public.stallions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.accounts(id) on delete cascade,
  owner_name text not null check (length(btrim(owner_name)) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'published', 'hidden')),
  -- Set by an admin who hides a stallion (shown to its owner).
  hidden_reason text not null default '' check (length(hidden_reason) <= 300),
  name text not null check (length(btrim(name)) between 1 and 60),
  breed text not null check (breed in ('thoroughbred', 'quarter_horse', 'standardbred', 'arabian', 'paint', 'appaloosa', 'warmblood', 'other')),
  registry text not null default '' check (length(registry) <= 60),
  registration text not null default '' check (length(registration) <= 40),
  foaled_year integer check (foaled_year between 1980 and 2100),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  color text not null default '' check (length(color) <= 30),
  height_in smallint check (height_in between 48 and 80),
  farm text not null default '' check (length(farm) <= 80),
  location text not null check (length(btrim(location)) between 2 and 80),
  -- "US-KY", "CA-ON", or a country such as "GB" (filters).
  region text not null check (region ~ '^[A-Z]{2}(-[A-Z]{2})?$'),
  season_year integer not null check (season_year between 2000 and 2100),
  -- Empty = private fee ("ask the owner").
  fee_cents bigint check (fee_cents between 0 and 1000000000000),
  fee_currency text not null default 'USD' check (fee_currency ~ '^[A-Z]{3}$'),
  fee_terms text not null default 'live_foal' check (fee_terms in ('live_foal', 'return_privilege', 'no_guarantee', 'other')),
  fee_note text not null default '' check (length(fee_note) <= 300),
  booking_fee_cents bigint check (booking_fee_cents between 0 and 100000000000),
  availability text not null default 'open' check (availability in ('open', 'limited', 'full', 'private', 'closed')),
  methods text[] not null default '{live_cover}'
    check (cardinality(methods) between 1 and 3 and methods <@ array['live_cover', 'cooled', 'frozen']),
  shipping_note text not null default '' check (length(shipping_note) <= 300),
  first_season integer check (first_season between 1980 and 2100),
  programs text not null default '' check (length(programs) <= 300),
  pedigree jsonb not null default '{}' check (jsonb_typeof(pedigree) = 'object' and octet_length(pedigree::text) <= 4000),
  -- {starts, wins, places, shows, earnings (cents), currency}: as the owner states it.
  race_record jsonb not null default '{}' check (jsonb_typeof(race_record) = 'object' and octet_length(race_record::text) <= 500),
  highlights text[] not null default '{}' check (cardinality(highlights) <= 8),
  -- {"GBED": "N/N", "HERDA": "N/HRD"...}: as the owner states it.
  genetics jsonb not null default '{}' check (jsonb_typeof(genetics) = 'object' and octet_length(genetics::text) <= 1000),
  fertility_rate smallint check (fertility_rate between 0 and 100),
  fertility_note text not null default '' check (length(fertility_note) <= 300),
  description text not null default '' check (length(description) <= 4000),
  -- The stallion's own racing record in Stayblz racing data (picked by the owner from a search).
  racing_horse_id uuid references public.racing_horses(id) on delete set null,
  inquiries_open boolean not null default true,
  featured_until timestamptz,
  -- "I own or manage this stallion and these details are true" (required to save).
  owner_confirmed_at timestamptz not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stallions_owner on public.stallions (owner_id, created_at desc);
create index if not exists stallions_published on public.stallions (status, published_at desc);
create index if not exists stallions_name_key on public.stallions (public.stallion_key(name));
create index if not exists stallions_featured on public.stallions (featured_until desc) where featured_until is not null;

create table if not exists public.stallion_files (
  id uuid primary key default gen_random_uuid(),
  -- Empty until the stallion is saved; removed with the stallion.
  stallion_id uuid references public.stallions(id) on delete cascade,
  owner_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('photo', 'video', 'document')),
  -- Key relative to the stayblz/ folder in R2 (or the path in the Supabase bucket): "stallions/<owner>/<uuid>.jpg".
  storage_key text not null unique check (length(storage_key) between 10 and 300),
  poster_key text check (poster_key is null or length(poster_key) between 10 and 300),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 104857600),
  width integer check (width between 1 and 20000),
  height integer check (height between 1 and 20000),
  duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 600),
  file_name text not null default '' check (length(file_name) <= 120),
  position smallint not null default 0 check (position between 0 and 20),
  created_at timestamptz not null default now(),
  check ((kind = 'photo' and content_type like 'image/%') or (kind = 'video' and content_type like 'video/%')
    or (kind = 'document' and content_type = 'application/pdf'))
);
create index if not exists stallion_files_stallion on public.stallion_files (stallion_id, kind, position) where stallion_id is not null;
create index if not exists stallion_files_pending on public.stallion_files (owner_id, created_at) where stallion_id is null;

create table if not exists public.stallion_saves (
  account_id uuid not null references public.accounts(id) on delete cascade,
  stallion_id uuid not null references public.stallions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (account_id, stallion_id)
);
create index if not exists stallion_saves_stallion on public.stallion_saves (stallion_id);

create table if not exists public.stallion_views (
  stallion_id uuid not null references public.stallions(id) on delete cascade,
  day date not null,
  views integer not null default 0 check (views >= 0),
  primary key (stallion_id, day)
);

create table if not exists public.stallion_inquiries (
  id uuid primary key default gen_random_uuid(),
  -- Kept (with the name) when the stallion is removed, so both sides keep their history.
  stallion_id uuid references public.stallions(id) on delete set null,
  stallion_name text not null check (length(stallion_name) between 1 and 60),
  owner_id uuid not null references public.accounts(id) on delete cascade,
  sender_id uuid not null references public.accounts(id) on delete cascade,
  sender_name text not null check (length(sender_name) between 1 and 120),
  conversation_id uuid,
  message_id uuid,
  -- The browser's id for this request: a retry returns the request already sent.
  client_id uuid not null unique,
  -- {name, foaled, sire, dam, damSire, status, registration, breed}
  mare jsonb not null default '{}' check (jsonb_typeof(mare) = 'object' and octet_length(mare::text) <= 2000),
  season_year integer check (season_year between 2000 and 2100),
  method text not null default '' check (method in ('', 'live_cover', 'cooled', 'frozen')),
  message text not null default '' check (length(message) <= 1000),
  -- The breeder sees the status too; the note is the owner's alone.
  status text not null default 'new' check (status in ('new', 'talking', 'booked', 'declined', 'closed')),
  owner_note text not null default '' check (length(owner_note) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stallion_inquiries_owner on public.stallion_inquiries (owner_id, created_at desc);
create index if not exists stallion_inquiries_sender on public.stallion_inquiries (sender_id, created_at desc);
create index if not exists stallion_inquiries_stallion on public.stallion_inquiries (stallion_id, created_at desc);

create table if not exists public.stallion_mares (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  breed text not null default 'thoroughbred' check (breed in ('thoroughbred', 'quarter_horse', 'standardbred', 'arabian', 'paint', 'appaloosa', 'warmblood', 'other')),
  foaled_year integer check (foaled_year between 1980 and 2100),
  color text not null default '' check (length(color) <= 30),
  registration text not null default '' check (length(registration) <= 40),
  racing_horse_id uuid references public.racing_horses(id) on delete set null,
  pedigree jsonb not null default '{}' check (jsonb_typeof(pedigree) = 'object' and octet_length(pedigree::text) <= 2000),
  genetics jsonb not null default '{}' check (jsonb_typeof(genetics) = 'object' and octet_length(genetics::text) <= 1000),
  notes text not null default '' check (length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stallion_mares_account on public.stallion_mares (account_id, name);

do $$
declare t text;
begin
  foreach t in array array['stallions', 'stallion_files', 'stallion_saves', 'stallion_views', 'stallion_inquiries', 'stallion_mares'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- ---------- Offspring and crosses from Stayblz racing data ----------

-- Every counted start of these horses: Stayblz's own published official results, plus earlier starts from the data
-- feed (a start already on a Stayblz card isn't counted twice). Callers pass only horses on public racing pages.
create or replace function public.stallion_starts(p_horses uuid[])
returns table (horse_id uuid, race_date date, finish integer, surface text, furlongs numeric, earnings bigint,
  currency text, stakes boolean, graded boolean)
language sql stable security definer set search_path = '' as $$
  with own as (
    select rn.horse_id, d.race_date, t.code as track_code, lower(t.name) as track_name, rn.finish_position as finish,
      r.surface, public.stallion_furlongs(r.distance_value, r.distance_unit) as furlongs, rn.earnings::bigint as earnings,
      r.currency, (r.race_type = 'stakes' or r.grade is not null) as stakes, r.grade is not null as graded
    from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
      join public.racing_days d on d.id = r.day_id join public.racing_tracks t on t.id = d.track_id
    where rn.horse_id = any (p_horses) and public.racing_day_public(d) and r.status = 'official' and not rn.scratched
  )
  select o.horse_id, o.race_date, o.finish, o.surface, o.furlongs, o.earnings, o.currency, o.stakes, o.graded from own o
  union all
  select hh.horse_id, hh.race_date, hh.finish_position, hh.surface, public.stallion_furlongs(hh.distance_value, hh.distance_unit),
    null::bigint, null::text, hh.race_type ~* '(group|grade|listed|stakes)', hh.race_type ~* '(group|grade) ?[123]'
  from public.racing_horse_history hh
  where hh.horse_id = any (p_horses)
    and not exists (select 1 from own o where o.horse_id = hh.horse_id and o.race_date = hh.race_date
                    and (o.track_code = hh.track_code or o.track_name = lower(hh.track_name)))
$$;

-- Totals for a group of horses (a stallion's offspring, a cross, or one horse's own record).
create or replace function public.stallion_progeny_json(p_horses uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (select * from public.stallion_starts(p_horses))
  select jsonb_build_object(
    'runners', (select count(distinct horse_id) from s),
    'winners', (select count(distinct horse_id) from s where finish = 1),
    'stakesWinners', (select count(distinct horse_id) from s where finish = 1 and stakes),
    'gradedWinners', (select count(distinct horse_id) from s where finish = 1 and graded),
    'starts', (select count(*) from s),
    'wins', (select count(*) from s where finish = 1),
    'places', (select count(*) from s where finish = 2),
    'shows', (select count(*) from s where finish = 3),
    'earnings', coalesce((select jsonb_agg(jsonb_build_object('currency', e.currency, 'amount', e.total) order by e.total desc)
        from (select currency, sum(earnings) as total from s where earnings > 0 group by currency) e), '[]'::jsonb),
    'surfaces', coalesce((select jsonb_agg(jsonb_build_object('surface', x.surface, 'starts', x.n, 'wins', x.w) order by x.n desc)
        from (select coalesce(nullif(surface, ''), 'unknown') as surface, count(*) as n, count(*) filter (where finish = 1) as w
              from s group by 1) x), '[]'::jsonb),
    'winDistance', (select jsonb_build_object('average', round(avg(furlongs), 1), 'shortest', round(min(furlongs), 1),
        'longest', round(max(furlongs), 1)) from s where finish = 1 and furlongs is not null having count(*) > 0),
    'from', (select min(race_date) from s),
    'to', (select max(race_date) from s))
$$;

-- Horses on public racing pages by this sire and/or out of mares by this dam's sire ('' = any).
-- (One query per case, so each uses its name index.)
create or replace function public.stallion_horses(p_sire text, p_damsire text) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare a text := public.stallion_key(p_sire); b text := public.stallion_key(p_damsire); ids uuid[];
begin
  if a <> '' and b <> '' then
    select array_agg(h.id) into ids from public.racing_horses h
     where h.sire <> '' and public.stallion_key(h.sire) = a and h.dam_sire <> '' and public.stallion_key(h.dam_sire) = b
       and public.racing_horse_public(h.id);
  elsif a <> '' then
    select array_agg(h.id) into ids from public.racing_horses h
     where h.sire <> '' and public.stallion_key(h.sire) = a and public.racing_horse_public(h.id);
  elsif b <> '' then
    select array_agg(h.id) into ids from public.racing_horses h
     where h.dam_sire <> '' and public.stallion_key(h.dam_sire) = b and public.racing_horse_public(h.id);
  end if;
  return coalesce(ids, '{}');
end $$;

-- The best of these horses (most stakes wins, then wins, then starts).
create or replace function public.stallion_top_horses(p_horses uuid[], p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'foaled', t.foaled_year, 'sex', t.sex,
      'sire', t.sire, 'dam', t.dam, 'damSire', t.dam_sire, 'starts', t.starts, 'wins', t.wins, 'places', t.places,
      'shows', t.shows, 'stakesWins', t.stakes_wins, 'lastRun', t.last_run)
      order by t.stakes_wins desc, t.wins desc, t.starts desc, t.name), '[]'::jsonb)
  from (select h.id, h.name, h.foaled_year, h.sex, h.sire, h.dam, h.dam_sire, count(st.horse_id) as starts,
          count(st.horse_id) filter (where st.finish = 1) as wins, count(st.horse_id) filter (where st.finish = 2) as places,
          count(st.horse_id) filter (where st.finish = 3) as shows,
          count(st.horse_id) filter (where st.finish = 1 and st.stakes) as stakes_wins, max(st.race_date) as last_run
        from public.racing_horses h left join public.stallion_starts(p_horses) st on st.horse_id = h.id
        where h.id = any (p_horses)
        group by h.id
        order by stakes_wins desc, wins desc, starts desc, h.name
        limit greatest(1, least(p_limit, 25))) t
$$;

-- A stallion's offspring in Stayblz racing data: totals, the best of them, and how they do by mare's sire.
create or replace function public.stallion_offspring(p_name text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ids uuid[];
begin
  if public.stallion_key(p_name) = '' then return null; end if;
  ids := public.stallion_horses(p_name, '');
  if cardinality(ids) = 0 then return jsonb_build_object('named', 0); end if;
  return public.stallion_progeny_json(ids) || jsonb_build_object(
    'named', cardinality(ids),
    'top', public.stallion_top_horses(ids, 12),
    'crosses', coalesce((select jsonb_agg(jsonb_build_object('damSire', c.name, 'runners', c.runners, 'winners', c.winners,
        'starts', c.starts, 'wins', c.wins) order by c.runners desc, c.winners desc, c.name)
      from (select max(h.dam_sire) as name, count(distinct st.horse_id) as runners,
              count(distinct st.horse_id) filter (where st.finish = 1) as winners,
              count(st.horse_id) as starts, count(st.horse_id) filter (where st.finish = 1) as wins
            from public.racing_horses h join public.stallion_starts(ids) st on st.horse_id = h.id
            where h.id = any (ids) and h.dam_sire <> ''
            group by public.stallion_key(h.dam_sire)
            order by 2 desc, 3 desc
            limit 12) c), '[]'::jsonb));
end $$;

-- Horses by p_sire out of p_damsire mares ('' = any sire, e.g. how a mare's sire does as a broodmare sire).
create or replace function public.stallion_cross(p_sire text, p_damsire text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ids uuid[];
begin
  if public.stallion_key(p_sire) = '' and public.stallion_key(p_damsire) = '' then return null; end if;
  ids := public.stallion_horses(p_sire, p_damsire);
  if cardinality(ids) = 0 then return jsonb_build_object('named', 0, 'runners', 0); end if;
  return public.stallion_progeny_json(ids) || jsonb_build_object('named', cardinality(ids), 'top', public.stallion_top_horses(ids, 5));
end $$;

-- How many offspring of each stallion are on public racing pages (cards and sorting).
create or replace function public.stallion_runner_count(p_name text) returns integer
language sql stable security definer set search_path = '' as $$
  select cardinality(public.stallion_horses(p_name, ''))
$$;

-- Horses on public racing pages whose name matches (linking a stallion's record, picking a mare).
create or replace function public.stallion_racing_lookup(p_query text, p_sex text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := btrim(coalesce(p_query, ''));
begin
  if length(q) < 2 then return '[]'::jsonb; end if;
  q := replace(replace(replace(left(q, 40), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'country', h.country, 'foaled', h.foaled_year,
      'sex', h.sex, 'color', h.color, 'breed', h.breed, 'sire', h.sire, 'dam', h.dam, 'damSire', h.dam_sire) order by h.name)
    from (select * from public.racing_horses x
          where (x.name ilike q or x.name ilike '% ' || q)
            and (coalesce(p_sex, '') = '' or (p_sex = 'female' and x.sex in ('mare', 'filly', ''))
                 or (p_sex = 'male' and x.sex in ('horse', 'colt', 'ridgling', '')))
            and public.racing_horse_public(x.id)
          order by x.name limit 15) h), '[]'::jsonb);
end $$;

-- What Stayblz already knows about these horses' ancestors: a published stallion's pedigree (deepest), or the
-- sire / dam / dam's sire of a horse on public racing pages. Used to fill in pedigrees automatically.
create or replace function public.stallion_known_parents(p_names text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select jsonb_build_object('key', public.stallion_key(s.name), 'name', s.name, 'pedigree', s.pedigree, 'source', 'stallion') as x
      from public.stallions s
     where s.status = 'published' and public.stallion_key(s.name) = any (select public.stallion_key(n) from unnest(p_names) n)
    union all
    select jsonb_build_object('key', public.stallion_key(h.name), 'name', h.name, 'source', 'racing', 'pedigree',
        jsonb_strip_nulls(jsonb_build_object('s', nullif(h.sire, ''), 'd', nullif(h.dam, ''), 'ds', nullif(h.dam_sire, ''))))
      from public.racing_horses h
     where public.stallion_key(h.name) = any (select public.stallion_key(n) from unnest(p_names) n)
       and (h.sire <> '' or h.dam <> '') and public.racing_horse_public(h.id)
  ) t
$$;

-- Runners out of p_damsire mares, counted per sire (the "check my mare against every stallion" list).
create or replace function public.stallion_cross_counts(p_damsire text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with ids as (select unnest(public.stallion_horses('', p_damsire)) as id),
  s as (select st.*, public.stallion_key(h.sire) as sire_key
        from public.stallion_starts(array(select id from ids)) st join public.racing_horses h on h.id = st.horse_id)
  select coalesce(jsonb_object_agg(sire_key, jsonb_build_object('runners', runners, 'winners', winners, 'wins', wins)), '{}'::jsonb)
  from (select sire_key, count(distinct horse_id) as runners, count(distinct horse_id) filter (where finish = 1) as winners,
          count(*) filter (where finish = 1) as wins
        from s where sire_key <> '' group by sire_key) c
$$;

-- ---------- Reading stallions ----------

create or replace function public.stallion_card(s public.stallions, p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', s.id, 'name', s.name, 'breed', s.breed, 'foaled', s.foaled_year, 'color', s.color,
    'heightIn', s.height_in, 'country', s.country,
    'sire', coalesce(s.pedigree ->> 's', ''), 'dam', coalesce(s.pedigree ->> 'd', ''), 'damSire', coalesce(s.pedigree ->> 'ds', ''),
    'farm', s.farm, 'location', s.location, 'region', s.region, 'seasonYear', s.season_year,
    'fee', s.fee_cents, 'feeCurrency', s.fee_currency, 'feeTerms', s.fee_terms, 'availability', s.availability,
    'methods', to_jsonb(s.methods), 'firstSeason', s.first_season, 'ownerName', s.owner_name, 'raceRecord', s.race_record,
    'featured', coalesce(s.featured_until > now(), false),
    'saves', (select count(*) from public.stallion_saves v where v.stallion_id = s.id),
    'saved', p_viewer is not null and exists (select 1 from public.stallion_saves v where v.stallion_id = s.id and v.account_id = p_viewer),
    'mine', p_viewer is not null and s.owner_id = p_viewer,
    'status', s.status,
    'cover', (select jsonb_build_object('id', f.id, 'kind', f.kind, 'poster', f.poster_key is not null)
              from public.stallion_files f where f.stallion_id = s.id and f.kind in ('photo', 'video')
              order by f.position, f.created_at limit 1),
    'photoCount', (select count(*) from public.stallion_files f where f.stallion_id = s.id and f.kind = 'photo'),
    'videoCount', (select count(*) from public.stallion_files f where f.stallion_id = s.id and f.kind = 'video'),
    'publishedAt', s.published_at, 'updatedAt', s.updated_at)
$$;

-- The directory. p_q: {q, breed, region, feeMin, feeMax, privateFee, availability, method, sire, ancestor, saved,
-- video, inData, sort (popular | newest | fee-asc | fee-desc | name | runners | young), page}.
create or replace function public.stallions_search(p_viewer uuid, p_q jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  -- Typed text matches as text: %, _ and \ are not wildcards.
  v_q text := nullif(replace(replace(replace(left(btrim(coalesce(p_q ->> 'q', '')), 60), '\', '\\'), '%', '\%'), '_', '\_'), '');
  v_breed text := nullif(p_q ->> 'breed', '');
  v_region text := nullif(p_q ->> 'region', '');
  v_fee_min bigint := nullif(p_q ->> 'feeMin', '')::bigint;
  v_fee_max bigint := nullif(p_q ->> 'feeMax', '')::bigint;
  v_private boolean := coalesce((p_q ->> 'privateFee')::boolean, false);
  v_avail text := nullif(p_q ->> 'availability', '');
  v_method text := nullif(p_q ->> 'method', '');
  v_sire text := public.stallion_key(p_q ->> 'sire');
  v_ancestor text := public.stallion_key(p_q ->> 'ancestor');
  v_saved boolean := coalesce((p_q ->> 'saved')::boolean, false) and p_viewer is not null;
  v_video boolean := coalesce((p_q ->> 'video')::boolean, false);
  v_in_data boolean := coalesce((p_q ->> 'inData')::boolean, false);
  v_sort text := coalesce(nullif(p_q ->> 'sort', ''), 'popular');
  v_page integer := greatest(0, least(coalesce(nullif(p_q ->> 'page', '')::integer, 0), 200));
  v_size constant integer := 24;
  v_total integer;
  v_rows jsonb;
begin
  with base as (
    select s.*,
      (select count(*) from public.stallion_saves v where v.stallion_id = s.id) as saves_n,
      coalesce((select sum(w.views) from public.stallion_views w where w.stallion_id = s.id and w.day > current_date - 30), 0) as views_n,
      coalesce(s.featured_until > now(), false) as featured_now,
      case when v_sort = 'runners' or v_in_data then public.stallion_runner_count(s.name) else 0 end as runners_n
    from public.stallions s
    where s.status = 'published'
      and (v_breed is null or s.breed = v_breed)
      and (v_region is null or s.region = v_region or s.region like v_region || '-%')
      and (v_avail is null or (v_avail = 'open' and s.availability in ('open', 'limited')) or s.availability = v_avail)
      and (v_method is null or v_method = any (s.methods))
      -- Fee steps are US dollars: only fees in dollars can be compared with them.
      and (v_fee_min is null or (s.fee_currency = 'USD' and s.fee_cents >= v_fee_min) or (v_private and s.fee_cents is null))
      and (v_fee_max is null or (s.fee_currency = 'USD' and s.fee_cents <= v_fee_max) or (v_private and s.fee_cents is null))
      and (not v_private or v_fee_min is not null or v_fee_max is not null or s.fee_cents is null)
      and (v_sire = '' or public.stallion_key(s.pedigree ->> 's') = v_sire)
      and (v_ancestor = '' or exists (select 1 from jsonb_each_text(s.pedigree) e where public.stallion_key(e.value) = v_ancestor))
      and (not v_saved or exists (select 1 from public.stallion_saves v where v.stallion_id = s.id and v.account_id = p_viewer))
      and (not v_video or exists (select 1 from public.stallion_files f where f.stallion_id = s.id and f.kind = 'video'))
      and (v_q is null or s.name ilike '%' || v_q || '%' or s.farm ilike '%' || v_q || '%' or s.location ilike '%' || v_q || '%'
           or coalesce(s.pedigree ->> 's', '') ilike '%' || v_q || '%')
  ), kept as (
    select * from base where not v_in_data or runners_n > 0
  ), ordered as (
    select k.*, count(*) over () as total_n,
      row_number() over (order by
        case when v_sort = 'popular' and k.featured_now then 0 else 1 end,
        case when v_sort = 'popular' then k.saves_n * 5 + k.views_n end desc nulls last,
        -- By fee: dollars first, then each other currency on its own, private fees last.
        case when v_sort in ('fee-asc', 'fee-desc') then case when k.fee_cents is null then 2 when k.fee_currency = 'USD' then 0 else 1 end end asc nulls last,
        case when v_sort in ('fee-asc', 'fee-desc') then k.fee_currency end asc nulls last,
        case when v_sort = 'fee-asc' then coalesce(k.fee_cents, 9223372036854775807) end asc nulls last,
        case when v_sort = 'fee-desc' then coalesce(k.fee_cents, -1) end desc nulls last,
        case when v_sort = 'name' then lower(k.name) end asc nulls last,
        case when v_sort = 'runners' then k.runners_n end desc nulls last,
        case when v_sort = 'young' then coalesce(k.first_season, k.foaled_year + 4) end desc nulls last,
        k.published_at desc nulls last, k.id) as rn
    from kept k
  )
  select coalesce(max(o.total_n), 0)::integer,
    coalesce(jsonb_agg(public.stallion_card(st, p_viewer) || jsonb_build_object('runners',
        case when v_sort = 'runners' or v_in_data then o.runners_n else public.stallion_runner_count(o.name) end) order by o.rn)
      filter (where o.rn > v_page * v_size and o.rn <= (v_page + 1) * v_size), '[]'::jsonb)
    into v_total, v_rows
  from ordered o join public.stallions st on st.id = o.id;
  return jsonb_build_object('stallions', v_rows, 'total', v_total, 'page', v_page, 'more', v_total > (v_page + 1) * v_size);
end $$;

-- Which breeds and regions have published stallions (filter menus show only what exists).
create or replace function public.stallions_facets() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'breeds', coalesce((select jsonb_agg(jsonb_build_object('value', breed, 'count', n) order by n desc)
      from (select breed, count(*) as n from public.stallions where status = 'published' group by breed) b), '[]'::jsonb),
    'regions', coalesce((select jsonb_agg(jsonb_build_object('value', region, 'count', n) order by region)
      from (select region, count(*) as n from public.stallions where status = 'published' group by region) r), '[]'::jsonb),
    'total', (select count(*) from public.stallions where status = 'published'))
$$;

-- One stallion's full page. Drafts and hidden stallions only for their owner (and staff).
create or replace function public.stallion_profile(p_id uuid, p_viewer uuid, p_staff boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.stallions; own boolean; racing jsonb := null;
begin
  select * into s from public.stallions where id = p_id;
  if not found then return null; end if;
  own := p_viewer is not null and s.owner_id = p_viewer;
  if s.status <> 'published' and not own and not coalesce(p_staff, false) then return null; end if;
  if s.racing_horse_id is not null and public.racing_horse_public(s.racing_horse_id) then
    select public.stallion_progeny_json(array[h.id]) || jsonb_build_object('id', h.id, 'name', h.name, 'foaled', h.foaled_year,
        'sire', h.sire, 'dam', h.dam, 'damSire', h.dam_sire)
      into racing from public.racing_horses h where h.id = s.racing_horse_id;
  end if;
  return public.stallion_card(s, p_viewer) || jsonb_build_object(
    'registry', s.registry, 'registration', s.registration, 'feeNote', s.fee_note, 'bookingFee', s.booking_fee_cents,
    'shippingNote', s.shipping_note, 'programs', s.programs, 'pedigree', s.pedigree, 'highlights', to_jsonb(s.highlights),
    'genetics', s.genetics, 'fertilityRate', s.fertility_rate, 'fertilityNote', s.fertility_note, 'description', s.description,
    'inquiriesOpen', s.inquiries_open, 'racingHorseId', s.racing_horse_id, 'racing', racing,
    'hiddenReason', case when own or coalesce(p_staff, false) then s.hidden_reason else '' end,
    'featuredUntil', case when own then s.featured_until end,
    'media', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'width', f.width, 'height', f.height,
        'duration', f.duration_seconds, 'poster', f.poster_key is not null) order by f.position, f.created_at)
      from public.stallion_files f where f.stallion_id = s.id and f.kind in ('photo', 'video')), '[]'::jsonb),
    'documents', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.file_name, 'size', f.size_bytes)
        order by f.position, f.created_at)
      from public.stallion_files f where f.stallion_id = s.id and f.kind = 'document'), '[]'::jsonb),
    'offspring', public.stallion_offspring(s.name),
    'owner', case when own then jsonb_build_object(
      'views30', coalesce((select sum(w.views) from public.stallion_views w where w.stallion_id = s.id and w.day > current_date - 30), 0),
      'requests', (select count(*) from public.stallion_inquiries i where i.stallion_id = s.id),
      'newRequests', (select count(*) from public.stallion_inquiries i where i.stallion_id = s.id and i.status = 'new')) end);
end $$;

-- The owner's stallions with their numbers (views per day for the last 30 days, saves, requests).
create or replace function public.stallions_mine(p_owner uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.stallion_card(s, p_owner) || jsonb_build_object(
      'hiddenReason', s.hidden_reason, 'featuredUntil', s.featured_until, 'inquiriesOpen', s.inquiries_open,
      'views30', coalesce((select sum(w.views) from public.stallion_views w where w.stallion_id = s.id and w.day > current_date - 30), 0),
      'daily', (select jsonb_agg(coalesce((select w.views from public.stallion_views w where w.stallion_id = s.id and w.day = g.day::date), 0) order by g.day)
                from generate_series(current_date - 29, current_date, interval '1 day') g(day)),
      'requests', (select count(*) from public.stallion_inquiries i where i.stallion_id = s.id),
      'newRequests', (select count(*) from public.stallion_inquiries i where i.stallion_id = s.id and i.status = 'new'))
    order by s.created_at desc), '[]'::jsonb)
  from public.stallions s where s.owner_id = p_owner
$$;

-- Every published stallion with his pedigree and genetics (a mare checked against all of them).
create or replace function public.stallions_for_matching(p_viewer uuid, p_breed text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.stallion_card(s, p_viewer) || jsonb_build_object('pedigree', s.pedigree, 'genetics', s.genetics)
    order by s.published_at desc), '[]'::jsonb)
  from (select * from public.stallions x where x.status = 'published' and (coalesce(p_breed, '') = '' or x.breed = p_breed)
        order by x.published_at desc limit 500) s
$$;

-- A visit to a published stallion's page (the owner's own visits don't count).
create or replace function public.stallion_seen(p_id uuid, p_viewer uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.stallion_views (stallion_id, day, views)
  select s.id, current_date, 1 from public.stallions s
   where s.id = p_id and s.status = 'published' and s.owner_id is distinct from p_viewer
  on conflict (stallion_id, day) do update set views = public.stallion_views.views + 1;
  return found;
end $$;

-- ---------- Breeding requests ----------

-- A breeder asks about a breeding. Starts (or reopens) their direct chat with the owner, sends the message with a
-- stallion card under it, and records the request for both sides. Straight to the owner's inbox (listing a stallion
-- is agreeing to be contacted); blocks still apply (chat_start_direct_user). A retry with the same p_client returns
-- the request already sent.
create or replace function public.stallion_inquiry(p_user uuid, p_display text, p_stallion uuid, p_snapshot jsonb,
  p_body text, p_client uuid, p_mare jsonb, p_season integer, p_method text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.stallions; conv uuid; msg jsonb; req public.stallion_inquiries;
begin
  select * into req from public.stallion_inquiries where client_id = p_client and sender_id = p_user;
  if found then
    return jsonb_build_object('conversationId', req.conversation_id, 'requestId', req.id, 'replayed', true);
  end if;
  select * into s from public.stallions where id = p_stallion;
  if not found or s.status <> 'published' then raise exception 'stallion_not_found'; end if;
  if s.owner_id = p_user then raise exception 'self'; end if;
  if not s.inquiries_open or s.availability = 'closed' then raise exception 'requests_closed'; end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or p_snapshot ->> 'id' <> p_stallion::text then
    raise exception 'invalid_stallion';
  end if;
  conv := public.chat_start_direct_user(p_user, p_display, s.owner_id);
  update public.personal_conversations set requested_ids = array_remove(requested_ids, s.owner_id) where id = conv;
  msg := public.chat_send('personal', p_user, null, conv, p_display, p_body, p_client, null, null, false);
  update public.personal_messages set listing = p_snapshot
   where id = (msg ->> 'id')::uuid and conversation_id = conv and listing is null;
  insert into public.stallion_inquiries (stallion_id, stallion_name, owner_id, sender_id, sender_name, conversation_id,
    message_id, client_id, mare, season_year, method, message)
  values (s.id, s.name, s.owner_id, p_user, left(coalesce(nullif(btrim(p_display), ''), 'Stayblz member'), 120), conv,
    (msg ->> 'id')::uuid, p_client, coalesce(p_mare, '{}'::jsonb), p_season, coalesce(p_method, ''), left(p_body, 1000))
  returning * into req;
  return jsonb_build_object('conversationId', conv, 'requestId', req.id, 'messageId', msg ->> 'id', 'replayed', false);
end $$;

create or replace function public.stallion_request_json(i public.stallion_inquiries, p_side text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', i.id, 'stallionId', i.stallion_id, 'stallionName', i.stallion_name,
    'senderName', i.sender_name, 'conversationId', i.conversation_id, 'mare', i.mare, 'seasonYear', i.season_year,
    'method', i.method, 'message', i.message, 'status', i.status, 'createdAt', i.created_at, 'updatedAt', i.updated_at,
    'cover', (select jsonb_build_object('id', f.id, 'kind', f.kind, 'poster', f.poster_key is not null)
              from public.stallion_files f where f.stallion_id = i.stallion_id and f.kind in ('photo', 'video')
              order by f.position, f.created_at limit 1),
    'ownerName', (select s.owner_name from public.stallions s where s.id = i.stallion_id))
    || case when p_side = 'received' then jsonb_build_object('ownerNote', i.owner_note) else '{}'::jsonb end
$$;

-- p_side: 'received' (my stallions' requests) or 'sent' (requests I sent).
create or replace function public.stallion_requests(p_user uuid, p_side text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.stallion_request_json(i, p_side) order by i.created_at desc), '[]'::jsonb)
  from (select * from public.stallion_inquiries i
        where (p_side = 'received' and i.owner_id = p_user) or (p_side = 'sent' and i.sender_id = p_user)
        order by i.created_at desc limit 300) i
$$;

-- ---------- Billing: "Featured stallion" ----------

alter table public.billing_catalog drop constraint if exists billing_catalog_effect_check;
alter table public.billing_catalog add constraint billing_catalog_effect_check
  check (effect in ('marketplace_feature', 'stallion_feature'));

insert into public.billing_catalog (id, kind, family, name, description, amount_cents, effect, effect_days, status, sort) values
  ('stallion_feature_7', 'product', 'stallions', 'Featured stallion - 7 days',
   'Your stallion shows first in Stayblz Stallions with a Featured tag for 7 days.', 999, 'stallion_feature', 7, 'active', 60),
  ('stallion_feature_30', 'product', 'stallions', 'Featured stallion - 30 days',
   'Your stallion shows first in Stayblz Stallions with a Featured tag for 30 days.', 2999, 'stallion_feature', 30, 'active', 61)
on conflict (id) do nothing;
update public.billing_catalog set description = 'List and promote your stallions in Stayblz Stallions.', updated_at = now()
 where id = 'stallion_showcase' and description like '%(opens with that section)%';

-- Same as 202611210002_billing.sql, plus featuring a stallion.
create or replace function public.billing_after_paid(p_invoice uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare inv public.billing_invoices; cat public.billing_catalog; days integer;
begin
  select * into inv from public.billing_invoices where id = p_invoice;
  if inv.kind = 'subscription' and inv.subscription_id is not null then
    update public.billing_subscriptions set
      status = 'active',
      periods = greatest(periods, coalesce(inv.period_index, periods)),
      current_period_start = inv.period_start,
      current_period_end = inv.period_end,
      updated_at = now()
    where id = inv.subscription_id and status in ('incomplete', 'trialing', 'active', 'past_due')
      and (current_period_end is null or inv.period_end >= current_period_end or status = 'incomplete');
  elsif inv.kind = 'purchase' then
    select * into cat from public.billing_catalog where id = inv.catalog_id;
    days := cat.effect_days;
    if cat.effect = 'marketplace_feature' and inv.target ? 'listingId' then
      update public.marketplace_listings
         set featured_until = greatest(coalesce(featured_until, now()), now()) + make_interval(days => days)
       where id = (inv.target ->> 'listingId')::uuid;
    elsif cat.effect = 'stallion_feature' and inv.target ? 'stallionId' then
      update public.stallions
         set featured_until = greatest(coalesce(featured_until, now()), now()) + make_interval(days => days)
       where id = (inv.target ->> 'stallionId')::uuid;
    end if;
  end if;
end $$;

-- Same as 202611210002_billing.sql, plus featuring a stallion (only your own).
create or replace function public.billing_purchase(p_account uuid, p_product text, p_target jsonb, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cat public.billing_catalog; inv_id uuid; inv public.billing_invoices; prof public.billing_profiles; acct record; listing record;
  stallion record; label text := '';
begin
  select * into cat from public.billing_catalog where id = p_product;
  if not found or cat.kind <> 'product' or cat.status <> 'active' then raise exception 'product_unavailable'; end if;
  if cat.effect = 'marketplace_feature' then
    if p_target is null or not (p_target ? 'listingId') then raise exception 'invalid_target'; end if;
    select l.id, l.name, l.seller_id into listing from public.marketplace_listings l where l.id::text = p_target ->> 'listingId';
    if not found then raise exception 'listing_not_found'; end if;
    if listing.seller_id <> p_account then raise exception 'not_your_listing'; end if;
    label := ': ' || listing.name;
  elsif cat.effect = 'stallion_feature' then
    if p_target is null or not (p_target ? 'stallionId') then raise exception 'invalid_target'; end if;
    select s.id, s.name, s.owner_id, s.status into stallion from public.stallions s where s.id::text = p_target ->> 'stallionId';
    if not found or stallion.status = 'hidden' then raise exception 'stallion_not_found'; end if;
    if stallion.owner_id <> p_account then raise exception 'not_your_stallion'; end if;
    -- Featured days only count in the directory: publish him first.
    if stallion.status <> 'published' then raise exception 'stallion_not_published'; end if;
    label := ': ' || stallion.name;
  end if;
  -- Reuse an unpaid invoice for the same thing instead of piling up new ones.
  select * into inv from public.billing_invoices
   where account_id = p_account and kind = 'purchase' and catalog_id = cat.id and status = 'open' and target = p_target
   order by created_at desc limit 1 for update;
  if found then
    return jsonb_build_object('invoice', public.billing_invoice_json(inv, true), 'reused', true);
  end if;
  select * into prof from public.billing_profiles where account_id = p_account;
  select a.email, btrim(a.first_name || ' ' || a.last_name) as name into acct from public.accounts a where a.id = p_account;
  insert into public.billing_invoices (number, issuer, kind, account_id, bill_to, catalog_id, target, status, subtotal_cents,
    total_cents, due_on, issued_at, created_by)
  values ('SBZ-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.billing_invoice_number')::text, 6, '0'),
    'stayblz', 'purchase', p_account,
    jsonb_build_object('name', coalesce(nullif(prof.name, ''), acct.name, ''), 'email', coalesce(nullif(prof.email, ''), acct.email, '')),
    cat.id, p_target, 'open', cat.amount_cents, cat.amount_cents, now()::date, now(), p_actor)
  returning id into inv_id;
  insert into public.billing_invoice_lines (invoice_id, position, category, description, quantity, unit_cents, amount_cents)
  values (inv_id, 0, 'purchase', left(cat.name || label, 200), 1, cat.amount_cents, cat.amount_cents);
  select * into inv from public.billing_invoices where id = inv_id;
  perform public.billing_event(p_actor, p_account, null, inv_id, null, 'purchase.started', jsonb_build_object('product', cat.id));
  return jsonb_build_object('invoice', public.billing_invoice_json(inv, true), 'reused', false);
end $$;

-- ---------- Function access: the API only ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'stallion%' or p.proname in ('billing_after_paid', 'billing_purchase')) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
