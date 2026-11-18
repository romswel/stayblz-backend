-- Share a horse to the Feed, and videos on horses.
-- Apply after 202611180001_update_reactions.sql.
--
-- * community_posts.kind gains 'horse_share' (an owner shares one of their horses; the post shows
--   the horse's current photos and videos, so nothing is copied).
-- * owner_horse_images holds videos too (kind 'video', MP4 / WebM / MOV, up to 100 MB, 3 minutes),
--   each with an optional poster frame. The API keeps the cover a photo and allows 3 videos per horse.
-- * community_feed's horse object gains `media` (up to 5, cover first) and `mediaCount`.
begin;

alter table public.community_posts drop constraint if exists community_posts_kind_check;
alter table public.community_posts add constraint community_posts_kind_check
  check (kind in ('update', 'horse_update', 'new_horse', 'result', 'achievement', 'announcement', 'horse_share'));

alter table public.owner_horse_images drop constraint if exists owner_horse_images_size_bytes_check;
alter table public.owner_horse_images
  add column if not exists kind text not null default 'photo',
  add column if not exists poster_path text,
  add column if not exists duration_seconds integer;
alter table public.owner_horse_images drop constraint if exists owner_horse_images_kind_check;
alter table public.owner_horse_images drop constraint if exists owner_horse_images_kind_type_check;
alter table public.owner_horse_images drop constraint if exists owner_horse_images_poster_path_check;
alter table public.owner_horse_images drop constraint if exists owner_horse_images_duration_check;
alter table public.owner_horse_images
  add constraint owner_horse_images_size_bytes_check check (size_bytes between 1 and 104857600),
  add constraint owner_horse_images_kind_check check (kind in ('photo', 'video')),
  add constraint owner_horse_images_kind_type_check check (
    (kind = 'photo' and content_type like 'image/%')
    or (kind = 'video' and content_type in ('video/mp4', 'video/webm', 'video/quicktime'))
  ),
  add constraint owner_horse_images_poster_path_check check (
    poster_path is null or (kind = 'video' and char_length(poster_path) between 10 and 300)),
  add constraint owner_horse_images_duration_check check (
    duration_seconds is null or (kind = 'video' and duration_seconds between 0 and 600));

-- ---------- Feed: horse media ----------
create or replace function public.community_feed(
  p_viewer uuid, p_scope text, p_target uuid,
  p_before_time timestamptz, p_before_id uuid, p_after timestamptz, p_limit int
)
returns jsonb language sql stable security definer set search_path = '' as $$
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
        'name', coalesce(nullif(btrim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')), ''), 'Stayblz member'),
        'headline', coalesce(cp.headline, '')
      ) as author,
      case
        when h.id is not null
         and public.community_visible(p_viewer, h.owner_id, public.community_horse_level(h.visibility, h.owner_id))
        then jsonb_build_object(
          'id', h.id, 'name', h.name, 'breed', h.breed, 'status', h.status,
          'coverImageId', h.cover_image_id,
          -- Live media for shared horses: cover first, then the owner's order (at most 5 here).
          'media', coalesce((
            select jsonb_agg(jsonb_build_object('id', m.id, 'kind', m.kind, 'width', m.width, 'height', m.height,
                                                'hasPoster', m.poster_path is not null) order by m.ord)
            from (
              select hi.*, row_number() over (
                order by (hi.id = h.cover_image_id) desc, hi.position, hi.created_at) as ord
              from public.owner_horse_images hi where hi.horse_id = h.id
            ) m where m.ord <= 5
          ), '[]'::jsonb),
          'mediaCount', (select count(*) from public.owner_horse_images hi where hi.horse_id = h.id)::int
        )
      end as horse,
      coalesce((
        select jsonb_agg(jsonb_build_object('id', i.id, 'width', i.width, 'height', i.height)
                         order by i.position, i.created_at)
        from public.community_post_images i where i.post_id = p.id
      ), '[]'::jsonb) as images,
      (select count(*) from public.community_likes l where l.post_id = p.id)::int as likes,
      exists (select 1 from public.community_likes l where l.post_id = p.id and l.user_id = p_viewer) as liked,
      (select count(*) from public.community_comments c where c.post_id = p.id)::int as comments
    from public.community_posts p
    join public.accounts a on a.id = p.author_id and a.status = 'active'
    left join public.community_profiles cp on cp.user_id = p.author_id
    left join public.owner_horses h on h.id = p.horse_id
    where public.community_visible(p_viewer, p.author_id, p.visibility)
      and (p_scope <> 'following' or p.author_id = p_viewer or exists (
        select 1 from public.community_follows f where f.follower_id = p_viewer and f.followee_id = p.author_id))
      and (p_scope <> 'author' or p.author_id = p_target)
      and (p_scope <> 'post' or p.id = p_target)
      and (p_scope <> 'horse' or (
        p.horse_id = p_target and h.id is not null
        and public.community_visible(p_viewer, h.owner_id, public.community_horse_level(h.visibility, h.owner_id))))
      and (p_before_time is null or (p.created_at, p.id) < (p_before_time, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
      and (p_after is null or p.created_at > p_after)
    order by p.created_at desc, p.id desc
    limit greatest(1, least(coalesce(p_limit, 20), 51))
  ) x
$$;

revoke all on function public.community_feed(uuid, text, uuid, timestamptz, uuid, timestamptz, int) from public, anon, authenticated;
grant execute on function public.community_feed(uuid, text, uuid, timestamptz, uuid, timestamptz, int) to service_role;

-- Supabase fallback store only (R2 is the main store): allow videos up to 50 MB.
update storage.buckets
   set file_size_limit = 52428800,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']
 where id = 'community-media';

notify pgrst, 'reload schema';
commit;
