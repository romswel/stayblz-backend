-- LOCAL DRAFT: not applied remotely. No seed records or legacy data changes.
-- Content is explicitly curated for publication; never backfill private stable data.
begin;

create table public.site_racing_records (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('racecards', 'results', 'workouts', 'horses', 'jockeys', 'trainers', 'stakes', 'notes')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 16384),
  publication_status text not null default 'draft' check (publication_status in ('draft', 'published')),
  published_at timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check (publication_status <> 'published' or published_at is not null)
);

create index site_racing_records_published on public.site_racing_records (kind, sort_order, id)
where publication_status = 'published';

alter table public.site_racing_records enable row level security;
revoke all on public.site_racing_records from anon, authenticated;
grant select, insert, update, delete on public.site_racing_records to service_role;
-- Browser access stays behind the backend projection. Publishing is a server/admin task.

commit;
