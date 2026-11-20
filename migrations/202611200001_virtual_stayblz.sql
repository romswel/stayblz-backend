-- LOCAL until a release is approved. Apply after 202611190006_racing_currency.sql. Safe to re-run; adds, never removes data.
--
-- Virtual Stayblz: horses a person or a stable tracks without owning them, with their own records.
--
--   virtual_horses         one tracked horse in ONE list: a person's private list (user_id) or a stable's shared
--                          list (stable_id), never both. It links to a community horse (owner_horses), a racing-data
--                          horse (racing_horses) or nothing (typed in by hand). Name/pedigree are copied when the
--                          horse is added, so the entry stays readable if the source is removed or made private.
--   virtual_horse_entries  what the person or team logs: workouts, races, sales entries and notes.
--
-- Live data from the source is never copied: the API reads it per viewer and re-checks community visibility
-- every time, so a teammate who can't see a followers-only horse only gets the copied details and the entries.
--
--   community_public_horses(viewer, query, breed, sex, status, year_from, year_to, raced, before_name, before_id, limit)
--                          community horses every signed-in member can see (the "Public horses" tab), as jsonb.
--   community_public_horse_breeds(viewer)   the breeds among them, for the breed filter.
--
-- RLS on, no browser grants; everything through the service role.

begin;

create table if not exists public.virtual_horses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.accounts(id) on delete cascade,
  stable_id uuid references public.member_stables(id) on delete cascade,
  added_by uuid references public.accounts(id) on delete set null,
  source text not null check (source in ('community', 'racing', 'manual')),
  community_horse_id uuid references public.owner_horses(id) on delete set null,
  racing_horse_id uuid references public.racing_horses(id) on delete set null,
  name text not null check (char_length(name) between 1 and 80),
  breed text not null default '' check (char_length(breed) <= 60),
  sex text not null default '' check (char_length(sex) <= 20),
  foaled_year int check (foaled_year between 1900 and 2100),
  color text not null default '' check (char_length(color) <= 40),
  sire text not null default '' check (char_length(sire) <= 80),
  dam text not null default '' check (char_length(dam) <= 80),
  trainer text not null default '' check (char_length(trainer) <= 80),
  owner_name text not null default '' check (char_length(owner_name) <= 80),
  location text not null default '' check (char_length(location) <= 80),
  notes text not null default '' check (char_length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((user_id is null) <> (stable_id is null))
);
create unique index if not exists virtual_horses_user_community on public.virtual_horses (user_id, community_horse_id)
  where user_id is not null and community_horse_id is not null;
create unique index if not exists virtual_horses_stable_community on public.virtual_horses (stable_id, community_horse_id)
  where stable_id is not null and community_horse_id is not null;
create unique index if not exists virtual_horses_user_racing on public.virtual_horses (user_id, racing_horse_id)
  where user_id is not null and racing_horse_id is not null;
create unique index if not exists virtual_horses_stable_racing on public.virtual_horses (stable_id, racing_horse_id)
  where stable_id is not null and racing_horse_id is not null;
create index if not exists virtual_horses_user_idx on public.virtual_horses (user_id, created_at desc) where user_id is not null;
create index if not exists virtual_horses_stable_idx on public.virtual_horses (stable_id, created_at desc) where stable_id is not null;

create table if not exists public.virtual_horse_entries (
  id uuid primary key default gen_random_uuid(),
  virtual_horse_id uuid not null references public.virtual_horses(id) on delete cascade,
  author_id uuid references public.accounts(id) on delete set null,
  kind text not null check (kind in ('workout', 'race', 'sale', 'note')),
  entry_date date not null,
  title text not null default '' check (char_length(title) <= 120),
  track text not null default '' check (char_length(track) <= 80),
  distance text not null default '' check (char_length(distance) <= 40),
  surface text not null default '' check (char_length(surface) <= 40),
  time_text text not null default '' check (char_length(time_text) <= 20),
  finish int check (finish between 1 and 40),
  field_size int check (field_size between 1 and 40),
  result text not null default '' check (char_length(result) <= 40),
  hip_number text not null default '' check (char_length(hip_number) <= 20),
  amount_cents bigint check (amount_cents between 0 and 100000000000),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists virtual_horse_entries_horse on public.virtual_horse_entries (virtual_horse_id, entry_date desc, created_at desc);

alter table public.virtual_horses enable row level security;
alter table public.virtual_horse_entries enable row level security;
revoke all on public.virtual_horses from public, anon, authenticated;
revoke all on public.virtual_horse_entries from public, anon, authenticated;
grant select, insert, update, delete on public.virtual_horses to service_role;
grant select, insert, update, delete on public.virtual_horse_entries to service_role;

-- Entry counts per tracked horse, for the list.
create or replace view public.virtual_horse_entry_counts with (security_invoker = true) as
  select virtual_horse_id,
    count(*) filter (where kind = 'workout')::int as workouts,
    count(*) filter (where kind = 'race')::int as races,
    count(*) filter (where kind = 'sale')::int as sales,
    count(*) filter (where kind = 'note')::int as notes,
    max(entry_date) as last_entry
  from public.virtual_horse_entries group by virtual_horse_id;
revoke all on public.virtual_horse_entry_counts from public, anon, authenticated;
grant select on public.virtual_horse_entry_counts to service_role;

-- Community horses every signed-in member can see: the horse is open to members (directly, or by following the
-- owner's setting), the owner's account is active, and it isn't the viewer's own. Optional filters (null/'' = any):
-- name contains p_query, breed (exact, any case), sex, status, foaled between p_year_from and p_year_to, raced only
-- (at least one race record). Name order, keyset paging on (lower(name), id).
create or replace function public.community_public_horses(
  p_viewer uuid, p_query text, p_breed text, p_sex text, p_status text, p_year_from int, p_year_to int,
  p_raced boolean, p_before_name text, p_before_id uuid, p_limit int
) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_name, x.id), '[]'::jsonb) from (
    select h.*, lower(h.name) as sort_name from public.owner_horses h
    join public.accounts a on a.id = h.owner_id and a.status = 'active'
    left join public.community_profiles p on p.user_id = h.owner_id
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
      and (p_before_name is null or (lower(h.name), h.id) > (p_before_name, p_before_id))
    order by lower(h.name), h.id
    limit least(greatest(coalesce(p_limit, 24), 1), 61)
  ) x;
$$;
revoke all on function public.community_public_horses(uuid, text, text, text, text, int, int, boolean, text, uuid, int) from public, anon, authenticated;
grant execute on function public.community_public_horses(uuid, text, text, text, text, int, int, boolean, text, uuid, int) to service_role;

-- The breeds among those horses (for the Public horses breed filter), most common first.
create or replace function public.community_public_horse_breeds(p_viewer uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(b.breed order by b.n desc, b.breed), '[]'::jsonb) from (
    select min(btrim(h.breed)) as breed, count(*) as n from public.owner_horses h
    join public.accounts a on a.id = h.owner_id and a.status = 'active'
    left join public.community_profiles p on p.user_id = h.owner_id
    where h.owner_id <> p_viewer and btrim(h.breed) <> ''
      and (h.visibility = 'members' or (h.visibility = 'inherit' and coalesce(p.inventory_visibility, 'members') = 'members'))
    group by lower(btrim(h.breed))
    order by count(*) desc, min(btrim(h.breed))
    limit 40
  ) b;
$$;
revoke all on function public.community_public_horse_breeds(uuid) from public, anon, authenticated;
grant execute on function public.community_public_horse_breeds(uuid) to service_role;

commit;
notify pgrst, 'reload schema';
