-- Profile pictures: at most one per account. Apply after 202611150001_community.sql.
--
-- The picture itself is stored by the API (lib/communityStorage.ts): in Cloudflare R2 under
-- stayblz/community/avatars/... when R2 is set up, otherwise in the private "community-media"
-- Supabase bucket. Either way it is streamed through /api/avatars to signed-in members only.
-- The last part of `path` (a random id) doubles as the picture's version, so a new picture
-- always gets a new web address and old copies in browser caches are never shown.
--
-- Same rules as the rest of Stayblz: RLS on, no browser grants, service role only.
-- Safe to re-run.
begin;

create table if not exists public.account_avatars (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  path text not null unique
    check (path ~ '^avatars/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  content_type text not null
    check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes int not null check (size_bytes between 1 and 2097152),
  width int check (width between 1 and 4000),
  height int check (height between 1 and 4000),
  updated_at timestamptz not null default now()
);

alter table public.account_avatars enable row level security;
revoke all on public.account_avatars from public, anon, authenticated;
grant select, insert, update, delete on public.account_avatars to service_role;

notify pgrst, 'reload schema';
commit;
