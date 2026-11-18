-- Marketplace: a free-text description on each listing (optional, up to 2,000 characters).
-- Apply after 202611190001_horse_share.sql.
begin;
alter table public.marketplace_listings
  add column if not exists description text not null default ''
  check (length(description) <= 2000);
commit;
