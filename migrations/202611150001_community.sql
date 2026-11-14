-- ============================================================================
-- Stayblz Community: owner horse profiles (photos, race records), follows,
-- feed posts, likes and comments, plus each member's privacy settings.
--
-- Every read and write goes through the API (service role). Row level security
-- is on with no policies, and the functions below are only executable by the
-- service role, so the browser's public key can't reach any of this directly.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------- Privacy and profile settings (one row per member, optional) ----------
create table if not exists community_profiles (
  user_id uuid primary key references accounts(id) on delete cascade,
  headline text not null default '' check (char_length(headline) <= 120),
  -- Who can see this member's horses: every signed-in member, followers only, or nobody else.
  inventory_visibility text not null default 'members'
    check (inventory_visibility in ('members', 'followers', 'private')),
  -- Earnings totals are shown to others only when this is on.
  show_earnings boolean not null default true,
  -- Shown in the Members directory.
  listed boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- Horses ----------
create table if not exists owner_horses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references accounts(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  breed text not null default '' check (char_length(breed) <= 60),
  sex text not null default ''
    check (sex in ('', 'colt', 'filly', 'mare', 'stallion', 'gelding', 'ridgling')),
  foaled_year int check (foaled_year between 1980 and 2100),
  color text not null default '' check (char_length(color) <= 40),
  sire text not null default '' check (char_length(sire) <= 80),
  dam text not null default '' check (char_length(dam) <= 80),
  status text not null default 'racing'
    check (status in ('racing', 'training', 'resting', 'injured', 'retired', 'for_sale', 'breeding')),
  trainer text not null default '' check (char_length(trainer) <= 80),
  location text not null default '' check (char_length(location) <= 80),
  description text not null default '' check (char_length(description) <= 4000),
  -- 'inherit' follows the owner's inventory setting.
  visibility text not null default 'inherit'
    check (visibility in ('inherit', 'members', 'followers', 'private')),
  cover_image_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists owner_horses_owner_idx on owner_horses (owner_id, created_at desc);

create table if not exists owner_horse_images (
  id uuid primary key default gen_random_uuid(),
  horse_id uuid not null references owner_horses(id) on delete cascade,
  owner_id uuid not null references accounts(id) on delete cascade,
  path text not null unique,
  content_type text not null,
  size_bytes int not null check (size_bytes > 0),
  width int check (width between 1 and 20000),
  height int check (height between 1 and 20000),
  caption text not null default '' check (char_length(caption) <= 200),
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists owner_horse_images_horse_idx on owner_horse_images (horse_id, position);

do $$ begin
  alter table owner_horses
    add constraint owner_horses_cover_fk foreign key (cover_image_id)
    references owner_horse_images(id) on delete set null;
exception when duplicate_object then null; end $$;

-- Race records: the performance history. Starts, wins and earnings are always
-- calculated from these rows, so totals can't drift from the history.
create table if not exists owner_horse_records (
  id uuid primary key default gen_random_uuid(),
  horse_id uuid not null references owner_horses(id) on delete cascade,
  owner_id uuid not null references accounts(id) on delete cascade,
  race_date date not null,
  track text not null check (char_length(track) between 1 and 80),
  race_name text not null default '' check (char_length(race_name) <= 120),
  distance text not null default '' check (char_length(distance) <= 40),
  surface text not null default '' check (surface in ('', 'dirt', 'turf', 'synthetic')),
  -- Empty finish = did not finish / scratched.
  finish int check (finish between 1 and 30),
  field_size int check (field_size between 1 and 30),
  earnings_cents bigint not null default 0 check (earnings_cents between 0 and 100000000000),
  notes text not null default '' check (char_length(notes) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (finish is null or field_size is null or finish <= field_size)
);
create index if not exists owner_horse_records_horse_idx on owner_horse_records (horse_id, race_date desc);

-- ---------- Follows ----------
create table if not exists community_follows (
  follower_id uuid not null references accounts(id) on delete cascade,
  followee_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  check (follower_id <> followee_id)
);
create index if not exists community_follows_followee_idx on community_follows (followee_id);

-- ---------- Posts, images, likes, comments ----------
create table if not exists community_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references accounts(id) on delete cascade,
  kind text not null default 'update'
    check (kind in ('update', 'horse_update', 'new_horse', 'result', 'achievement', 'announcement')),
  body text not null default '' check (char_length(body) <= 2000),
  horse_id uuid references owner_horses(id) on delete set null,
  -- Snapshot of a shared race result, so the post still reads right if the record changes.
  result jsonb,
  visibility text not null default 'members' check (visibility in ('members', 'followers')),
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists community_posts_time_idx on community_posts (created_at desc, id desc);
create index if not exists community_posts_author_idx on community_posts (author_id, created_at desc);
create index if not exists community_posts_horse_idx on community_posts (horse_id);

-- Photos are uploaded first (post_id empty) and attached when the post is published.
create table if not exists community_post_images (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references community_posts(id) on delete cascade,
  author_id uuid not null references accounts(id) on delete cascade,
  path text not null unique,
  content_type text not null,
  size_bytes int not null check (size_bytes > 0),
  width int check (width between 1 and 20000),
  height int check (height between 1 and 20000),
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists community_post_images_post_idx on community_post_images (post_id, position);
create index if not exists community_post_images_pending_idx on community_post_images (author_id) where post_id is null;

create table if not exists community_likes (
  post_id uuid not null references community_posts(id) on delete cascade,
  user_id uuid not null references accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists community_likes_user_idx on community_likes (user_id);

create table if not exists community_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references community_posts(id) on delete cascade,
  author_id uuid not null references accounts(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index if not exists community_comments_post_idx on community_comments (post_id, created_at);

-- ---------- Locked down: API (service role) only ----------
alter table community_profiles enable row level security;
alter table owner_horses enable row level security;
alter table owner_horse_images enable row level security;
alter table owner_horse_records enable row level security;
alter table community_follows enable row level security;
alter table community_posts enable row level security;
alter table community_post_images enable row level security;
alter table community_likes enable row level security;
alter table community_comments enable row level security;

-- ---------- Per-horse totals, always calculated from the race records ----------
create or replace view owner_horse_stats with (security_invoker = true) as
select
  h.id as horse_id,
  h.owner_id,
  count(r.id)::int as starts,
  (count(r.id) filter (where r.finish = 1))::int as wins,
  (count(r.id) filter (where r.finish = 2))::int as places,
  (count(r.id) filter (where r.finish = 3))::int as shows,
  coalesce(sum(r.earnings_cents), 0)::bigint as earnings_cents,
  max(r.race_date) as last_race
from owner_horses h
left join owner_horse_records r on r.horse_id = h.id
group by h.id, h.owner_id;

-- ---------- Visibility ----------
-- A horse's effective level: its own setting, or the owner's inventory setting.
create or replace function community_horse_level(p_level text, p_owner uuid)
returns text language sql stable set search_path = public as $$
  select case
    when p_level <> 'inherit' then p_level
    else coalesce((select inventory_visibility from community_profiles where user_id = p_owner), 'members')
  end
$$;

-- Can p_viewer see something p_owner shared at p_level?
create or replace function community_visible(p_viewer uuid, p_owner uuid, p_level text)
returns boolean language sql stable set search_path = public as $$
  select p_viewer = p_owner
    or p_level = 'members'
    or (p_level = 'followers' and exists (
      select 1 from community_follows f where f.follower_id = p_viewer and f.followee_id = p_owner
    ))
$$;

-- ---------- Members directory and profile summaries ----------
-- Counts only include horses the viewer is allowed to see. Earnings are empty when
-- the member hides them (members always see their own).
create or replace function community_people(
  p_viewer uuid, p_query text, p_sort text, p_limit int, p_offset int, p_only uuid default null
)
returns jsonb language sql stable set search_path = public as $$
  with base as (
    select
      a.id,
      trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')) as name,
      a.created_at,
      coalesce(cp.headline, '') as headline,
      coalesce(cp.show_earnings, true) as show_earnings,
      coalesce(cp.inventory_visibility, 'members') as inventory_visibility
    from accounts a
    left join community_profiles cp on cp.user_id = a.id
    where a.status = 'active'
      and (
        (p_only is not null and a.id = p_only)
        or (p_only is null and (coalesce(cp.listed, true) or a.id = p_viewer))
      )
      and (
        coalesce(p_query, '') = ''
        or (coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')) ilike '%' || p_query || '%' escape '\'
        or coalesce(cp.headline, '') ilike '%' || p_query || '%' escape '\'
      )
  ),
  visible_horses as (
    select h.id, h.owner_id
    from owner_horses h
    join base b on b.id = h.owner_id
    where community_visible(p_viewer, h.owner_id, community_horse_level(h.visibility, h.owner_id))
  ),
  stats as (
    select
      b.id, b.name, b.created_at, b.headline,
      (b.id = p_viewer) as me,
      community_visible(p_viewer, b.id, b.inventory_visibility) as inventory_open,
      (select count(*) from visible_horses v where v.owner_id = b.id)::int as horses,
      case when b.show_earnings or b.id = p_viewer then
        (select coalesce(sum(s.earnings_cents), 0)
           from owner_horse_stats s join visible_horses v on v.id = s.horse_id
          where v.owner_id = b.id)::bigint
      end as earnings_cents,
      (select count(*) from owner_horse_records r join visible_horses v on v.id = r.horse_id
        where v.owner_id = b.id and r.finish = 1)::int as wins,
      (select count(*) from owner_horse_records r join visible_horses v on v.id = r.horse_id
        where v.owner_id = b.id)::int as starts,
      (select count(*) from community_follows f where f.followee_id = b.id)::int as followers,
      (select count(*) from community_follows f where f.follower_id = b.id)::int as following_count,
      (select count(*) from community_posts p where p.author_id = b.id)::int as posts,
      exists (select 1 from community_follows f where f.follower_id = p_viewer and f.followee_id = b.id) as following,
      exists (select 1 from community_follows f where f.follower_id = b.id and f.followee_id = p_viewer) as follows_me,
      (select max(p.created_at) from community_posts p where p.author_id = b.id) as last_active
    from base b
  ),
  ranked as (
    select st.*, row_number() over (
      order by
        case when p_sort = 'horses' then st.horses end desc nulls last,
        case when p_sort = 'earnings' then st.earnings_cents end desc nulls last,
        case when p_sort = 'followers' then st.followers end desc nulls last,
        case when p_sort = 'new' then st.created_at end desc nulls last,
        st.last_active desc nulls last,
        st.horses desc,
        st.name
    ) as ord
    from stats st
  )
  select coalesce(jsonb_agg(to_jsonb(r) - 'ord' order by r.ord), '[]'::jsonb)
  from (
    select * from ranked
    order by ord
    limit greatest(1, least(coalesce(p_limit, 30), 61))
    offset greatest(0, coalesce(p_offset, 0))
  ) r
$$;

-- ---------- Feed ----------
-- p_scope: 'all' | 'following' | 'author' (p_target = member) | 'horse' (p_target = horse) | 'post' (p_target = post).
-- Newest first; page with p_before_time + p_before_id; p_after counts newer posts.
create or replace function community_feed(
  p_viewer uuid, p_scope text, p_target uuid,
  p_before_time timestamptz, p_before_id uuid, p_after timestamptz, p_limit int
)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id desc), '[]'::jsonb)
  from (
    select
      p.id, p.kind, p.body, p.visibility, p.created_at, p.edited_at,
      -- Shared results drop their prize money while the author hides earnings.
      case when coalesce(cp.show_earnings, true) or p.author_id = p_viewer
        then p.result else p.result - 'earningsCents' end as result,
      (p.author_id = p_viewer) as mine,
      jsonb_build_object(
        'id', a.id,
        'name', trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')),
        'headline', coalesce(cp.headline, '')
      ) as author,
      case
        when h.id is not null
         and community_visible(p_viewer, h.owner_id, community_horse_level(h.visibility, h.owner_id))
        then jsonb_build_object(
          'id', h.id, 'name', h.name, 'breed', h.breed, 'status', h.status,
          'coverImageId', h.cover_image_id
        )
      end as horse,
      coalesce((
        select jsonb_agg(jsonb_build_object('id', i.id, 'width', i.width, 'height', i.height)
                         order by i.position, i.created_at)
        from community_post_images i where i.post_id = p.id
      ), '[]'::jsonb) as images,
      (select count(*) from community_likes l where l.post_id = p.id)::int as likes,
      exists (select 1 from community_likes l where l.post_id = p.id and l.user_id = p_viewer) as liked,
      (select count(*) from community_comments c where c.post_id = p.id)::int as comments
    from community_posts p
    join accounts a on a.id = p.author_id and a.status = 'active'
    left join community_profiles cp on cp.user_id = p.author_id
    left join owner_horses h on h.id = p.horse_id
    where community_visible(p_viewer, p.author_id, p.visibility)
      and (p_scope <> 'following' or p.author_id = p_viewer or exists (
        select 1 from community_follows f where f.follower_id = p_viewer and f.followee_id = p.author_id))
      and (p_scope <> 'author' or p.author_id = p_target)
      and (p_scope <> 'post' or p.id = p_target)
      and (p_scope <> 'horse' or (
        p.horse_id = p_target and h.id is not null
        and community_visible(p_viewer, h.owner_id, community_horse_level(h.visibility, h.owner_id))))
      and (p_before_time is null or (p.created_at, p.id) < (p_before_time, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
      and (p_after is null or p.created_at > p_after)
    order by p.created_at desc, p.id desc
    limit greatest(1, least(coalesce(p_limit, 20), 51))
  ) x
$$;

-- Server only.
revoke all on owner_horse_stats from public, anon, authenticated;
revoke all on function community_horse_level(text, uuid) from public, anon, authenticated;
revoke all on function community_visible(uuid, uuid, text) from public, anon, authenticated;
revoke all on function community_people(uuid, text, text, int, int, uuid) from public, anon, authenticated;
revoke all on function community_feed(uuid, text, uuid, timestamptz, uuid, timestamptz, int) from public, anon, authenticated;
grant select on owner_horse_stats to service_role;
grant execute on function community_horse_level(text, uuid) to service_role;
grant execute on function community_visible(uuid, uuid, text) to service_role;
grant execute on function community_people(uuid, text, text, int, int, uuid) to service_role;
grant execute on function community_feed(uuid, text, uuid, timestamptz, uuid, timestamptz, int) to service_role;

-- ---------- Private storage bucket for horse and post photos ----------
-- Photos are streamed through the API after a visibility check; the bucket is never public.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('community-media', 'community-media', false, 6291456,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

-- Make the new tables and functions visible to the API right away.
notify pgrst, 'reload schema';