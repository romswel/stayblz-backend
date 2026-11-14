-- Stayblz Marketplace: photos (1 to 8 per listing) and optional PDF documents (up to 5).
-- Apply after 202611150001_community.sql.
--
-- The files themselves live in Cloudflare R2 (private bucket, under stayblz/marketplace/<seller>/).
-- This table only records them. A seller uploads files while filling in the form (listing_id is
-- empty), and they are attached when the listing is published or saved. The API streams every
-- file after its own sign-in check; the browser never gets an R2 address.
--
-- Same rules as the rest of Stayblz: RLS on, no browser grants, service role only.
begin;

create table public.marketplace_files (
  id uuid primary key default gen_random_uuid(),
  -- Empty until the listing is published or saved; removed with the listing.
  listing_id uuid references public.marketplace_listings(id) on delete cascade,
  seller_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('photo', 'document')),
  -- Key relative to the stayblz/ folder in R2, e.g. "marketplace/<seller>/<uuid>.jpg".
  storage_key text not null unique check (length(storage_key) between 10 and 300),
  content_type text not null
    check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  width integer check (width between 1 and 20000),
  height integer check (height between 1 and 20000),
  -- Documents keep the name the seller gave them (shown in the list and used for downloads).
  file_name text not null default '' check (length(file_name) <= 120),
  -- Display order within a listing; photo 0 is the cover.
  position smallint not null default 0 check (position between 0 and 20),
  created_at timestamptz not null default now(),
  check ((kind = 'document') = (content_type = 'application/pdf'))
);
create index marketplace_files_listing on public.marketplace_files (listing_id, kind, position)
  where listing_id is not null;
create index marketplace_files_pending on public.marketplace_files (seller_id, created_at)
  where listing_id is null;

alter table public.marketplace_files enable row level security;
revoke all on public.marketplace_files from public, anon, authenticated;
grant select, insert, update, delete on public.marketplace_files to service_role;

notify pgrst, 'reload schema';
commit;
