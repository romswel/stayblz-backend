-- Stayblz Marketplace: videos on listings (up to 3, MP4 / WebM / MOV, up to 100 MB each),
-- next to the photos (up to 8). A listing needs at least one photo or video.
-- Apply after 202611150002_marketplace_media.sql.
--
-- Videos live in R2 like the photos (private bucket, stayblz/marketplace/<seller>/). Each video
-- can have a poster image (a frame the seller's browser captures) shown on cards and before playing.
begin;

alter table public.marketplace_files drop constraint if exists marketplace_files_kind_check;
alter table public.marketplace_files drop constraint if exists marketplace_files_content_type_check;
alter table public.marketplace_files drop constraint if exists marketplace_files_size_bytes_check;
alter table public.marketplace_files drop constraint if exists marketplace_files_check;
alter table public.marketplace_files drop constraint if exists marketplace_files_kind_type_check;

alter table public.marketplace_files
  add constraint marketplace_files_kind_check check (kind in ('photo', 'video', 'document')),
  add constraint marketplace_files_content_type_check check (content_type in (
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm', 'video/quicktime',
    'application/pdf'
  )),
  -- Photos 8 MB, documents 10 MB, videos 100 MB (the API checks each kind's own limit).
  add constraint marketplace_files_size_bytes_check check (size_bytes between 1 and 104857600),
  add constraint marketplace_files_kind_type_check check (
    (kind = 'photo' and content_type like 'image/%')
    or (kind = 'video' and content_type like 'video/%')
    or (kind = 'document' and content_type = 'application/pdf')
  );

-- Videos only: the poster image (R2 key) and the length in seconds.
alter table public.marketplace_files
  add column if not exists poster_key text check (poster_key is null or length(poster_key) between 10 and 300),
  add column if not exists duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 600);

notify pgrst, 'reload schema';
commit;
