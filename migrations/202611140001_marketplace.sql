-- LOCAL ONLY. Apply after 202611120001_chat_v2.sql.
-- Horse marketplace: members list horses for sale; every signed-in member can browse them.
-- Breed, discipline, type, gender and colour are checked against fixed lists in the API
-- (src/lib/marketplaceInput.ts), so the lists can grow without a migration.
begin;
create table public.marketplace_listings (
 id uuid primary key default gen_random_uuid(),
 seller_id uuid not null references auth.users(id) on delete cascade,
 seller_name text not null check(length(btrim(seller_name)) between 1 and 120),
 name text not null check(length(btrim(name)) between 1 and 80),
 price integer not null check(price between 1 and 100000000),
 breed text not null check(length(breed) between 1 and 40),
 discipline text not null check(length(discipline) between 1 and 40),
 horse_type text not null check(length(horse_type) between 1 and 40),
 gender text not null check(length(gender) between 1 and 40),
 color text not null check(length(color) between 1 and 40),
 age smallint not null check(age between 0 and 40),
 -- Height in inches (1 hand = 4 in). 16.2 hh is stored as 66.
 height_in smallint not null check(height_in between 24 and 80),
 location text not null check(length(btrim(location)) between 2 and 80),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index marketplace_listings_newest on public.marketplace_listings(created_at desc, id desc);
create index marketplace_listings_seller on public.marketplace_listings(seller_id, created_at desc);
create index marketplace_listings_price on public.marketplace_listings(price, id);
alter table public.marketplace_listings enable row level security;
revoke all on public.marketplace_listings from public, anon, authenticated;
grant select, insert, update, delete on public.marketplace_listings to service_role;
commit;
