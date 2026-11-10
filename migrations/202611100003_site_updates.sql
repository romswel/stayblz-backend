-- LOCAL: apply after 202611100002_updates_preferences.sql. Non-destructive and safe to re-run.
-- Stayblz Updates: release notes, announcements, news, maintenance and event posts.
-- Admins write through checked functions; readers get published posts through the API only.
begin;

create table if not exists public.site_updates (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 80),
  kind text not null default 'update'
    check (kind in ('update', 'announcement', 'news', 'maintenance', 'event')),
  title text not null check (length(btrim(title)) between 1 and 140),
  summary text not null default '' check (length(summary) <= 400),
  body text not null default '' check (length(body) <= 20000),
  -- Patch-note lines: [{"tag": "new|improved|fixed|security|notice", "text": "..."}]
  items jsonb not null default '[]'
    check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 40),
  version text not null default '' check (length(version) <= 20),
  -- public: anyone, including signed-out visitors. members: signed-in accounts only.
  audience text not null default 'public' check (audience in ('public', 'members')),
  pinned boolean not null default false,
  popup boolean not null default true,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  published_at timestamptz,
  author_label text not null default 'Stayblz team' check (length(btrim(author_label)) between 1 and 80),
  created_by uuid references public.accounts(id) on delete set null,
  updated_by uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_updates_published_has_date check (status = 'draft' or published_at is not null)
);
create index if not exists site_updates_feed on public.site_updates (status, published_at desc, id desc);

alter table public.site_updates enable row level security;
revoke all on public.site_updates from public, anon, authenticated, service_role;
grant select on public.site_updates to service_role;

-- One post as the API shows it. Drafts and archived posts are never returned to readers.
create or replace function public.site_update_json(u public.site_updates, p_full boolean) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', u.id, 'slug', u.slug, 'kind', u.kind, 'title', u.title, 'summary', u.summary,
    'items', u.items, 'version', u.version, 'audience', u.audience, 'pinned', u.pinned,
    'popup', u.popup, 'status', u.status, 'publishedAt', u.published_at,
    'authorLabel', u.author_label, 'updatedAt', u.updated_at,
    'readMinutes', greatest(1, ceil((length(u.body) + length(u.items::text)) / 1100.0))::int,
    'hasBody', length(u.body) > 0
  ) || case when p_full then jsonb_build_object('body', u.body) else '{}'::jsonb end
$$;

-- Reader feed: newest first, optional kind / search / cursor. Pinned posts come back
-- separately on the first page so they stay on top.
create or replace function public.list_site_updates(p_members boolean, p_kind text, p_query text,
  p_before timestamptz, p_limit integer)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  lim integer := least(greatest(coalesce(p_limit, 12), 1), 30);
  q text := nullif(btrim(coalesce(p_query, '')), '');
  rows jsonb; pinned jsonb; more boolean;
begin
  -- Escape LIKE wildcards so a search is always plain text.
  if q is not null then q := '%' || replace(replace(replace(left(q, 80), '\', '\\'), '%', '\%'), '_', '\_') || '%'; end if;
  with feed as (
    select u.id, u.published_at from public.site_updates u
    where u.status = 'published' and u.published_at <= now()
      and (u.audience = 'public' or p_members)
      and (p_kind is null or u.kind = p_kind)
      and (q is null or u.title ilike q or u.summary ilike q or u.body ilike q or u.items::text ilike q)
      and (p_before is null or u.published_at < p_before)
    order by u.published_at desc, u.id desc
    limit lim + 1
  )
  select coalesce(jsonb_agg(public.site_update_json(u, false) order by u.published_at desc, u.id desc), '[]'),
    count(*) > lim
  into rows, more from feed f join public.site_updates u on u.id = f.id;
  if more then rows := rows - lim; end if;
  if p_before is null and q is null then
    select coalesce(jsonb_agg(public.site_update_json(u, false) order by u.published_at desc), '[]') into pinned
    from public.site_updates u
    where u.id in (select p.id from public.site_updates p
      where p.status = 'published' and p.published_at <= now() and p.pinned
        and (p.audience = 'public' or p_members) and (p_kind is null or p.kind = p_kind)
      order by p.published_at desc limit 3);
  else
    pinned := '[]';
  end if;
  return jsonb_build_object('updates', rows, 'pinned', pinned, 'hasMore', more);
end $$;

-- One published post with its neighbours for "newer / older" links.
create or replace function public.get_site_update(p_slug text, p_members boolean) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare u public.site_updates; newer jsonb; older jsonb;
begin
  select * into u from public.site_updates s
  where s.slug = p_slug and s.status = 'published' and s.published_at <= now()
    and (s.audience = 'public' or p_members);
  if not found then return null; end if;
  select jsonb_build_object('slug', n.slug, 'title', n.title) into newer from public.site_updates n
  where n.status = 'published' and n.published_at <= now() and (n.audience = 'public' or p_members)
    and (n.published_at, n.id) > (u.published_at, u.id)
  order by n.published_at, n.id limit 1;
  select jsonb_build_object('slug', o.slug, 'title', o.title) into older from public.site_updates o
  where o.status = 'published' and o.published_at <= now() and (o.audience = 'public' or p_members)
    and (o.published_at, o.id) < (u.published_at, u.id)
  order by o.published_at desc, o.id desc limit 1;
  return jsonb_build_object('update', public.site_update_json(u, true), 'newer', newer, 'older', older);
end $$;

-- Staff view: every post, any status.
create or replace function public.admin_list_site_updates() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(public.site_update_json(u, true)
    || jsonb_build_object('createdAt', u.created_at) order by u.status = 'published' desc,
       coalesce(u.published_at, u.updated_at) desc), '[]')
  from public.site_updates u
  where u.id in (select r.id from public.site_updates r order by r.updated_at desc limit 300)
$$;

-- Create (p_id null) or edit a post. p_actor null is the release script (service key);
-- otherwise the actor must be an active admin or superadmin. Publishing stamps the time once.
create or replace function public.save_site_update(p_actor uuid, p_id uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result public.site_updates;
  next_status text := coalesce(p_data ->> 'status', 'draft');
  stamp timestamptz := case when coalesce(p_data ->> 'publishedAt', '') ~ '^\d{4}-\d{2}-\d{2}T'
    then (p_data ->> 'publishedAt')::timestamptz end;
begin
  if p_actor is not null and not exists (select 1 from public.accounts a where a.id = p_actor
      and a.status = 'active' and a.platform_role in ('admin', 'superadmin')) then
    raise exception 'not_allowed';
  end if;
  if p_id is null then
    insert into public.site_updates (slug, kind, title, summary, body, items, version, audience, pinned,
      popup, status, published_at, author_label, created_by, updated_by)
    values (p_data ->> 'slug', p_data ->> 'kind', btrim(p_data ->> 'title'), coalesce(p_data ->> 'summary', ''),
      coalesce(p_data ->> 'body', ''), coalesce(p_data -> 'items', '[]'), coalesce(p_data ->> 'version', ''),
      coalesce(p_data ->> 'audience', 'public'), coalesce((p_data ->> 'pinned')::boolean, false),
      coalesce((p_data ->> 'popup')::boolean, true), next_status,
      case when next_status = 'draft' then null else coalesce(stamp, now()) end,
      coalesce(nullif(btrim(p_data ->> 'authorLabel'), ''), 'Stayblz team'), p_actor, p_actor)
    returning * into result;
  else
    update public.site_updates u set
      slug = p_data ->> 'slug', kind = p_data ->> 'kind', title = btrim(p_data ->> 'title'),
      summary = coalesce(p_data ->> 'summary', ''), body = coalesce(p_data ->> 'body', ''),
      items = coalesce(p_data -> 'items', '[]'), version = coalesce(p_data ->> 'version', ''),
      audience = coalesce(p_data ->> 'audience', 'public'),
      pinned = coalesce((p_data ->> 'pinned')::boolean, false),
      popup = coalesce((p_data ->> 'popup')::boolean, true),
      status = next_status,
      -- First publish stamps now; later edits keep the original date unless one is given.
      published_at = case when next_status = 'draft' then null
        else coalesce(stamp, u.published_at, now()) end,
      author_label = coalesce(nullif(btrim(p_data ->> 'authorLabel'), ''), 'Stayblz team'),
      updated_by = p_actor, updated_at = now()
    where u.id = p_id returning * into result;
    if not found then raise exception 'unknown_update'; end if;
  end if;
  if p_actor is not null then
    insert into public.account_events (account_id, actor_id, event, detail)
    values (p_actor, p_actor, case when p_id is null then 'update.created' else 'update.edited' end,
      jsonb_build_object('update', result.id, 'slug', result.slug, 'status', result.status));
  end if;
  return public.site_update_json(result, true) || jsonb_build_object('createdAt', result.created_at);
end $$;

create or replace function public.delete_site_update(p_actor uuid, p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare gone public.site_updates;
begin
  if not exists (select 1 from public.accounts a where a.id = p_actor
      and a.status = 'active' and a.platform_role in ('admin', 'superadmin')) then
    raise exception 'not_allowed';
  end if;
  delete from public.site_updates where id = p_id returning * into gone;
  if not found then raise exception 'unknown_update'; end if;
  insert into public.account_events (account_id, actor_id, event, detail)
  values (p_actor, p_actor, 'update.deleted', jsonb_build_object('update', gone.id, 'slug', gone.slug, 'title', gone.title));
  return true;
end $$;

revoke all on function public.site_update_json(public.site_updates, boolean),
  public.list_site_updates(boolean, text, text, timestamptz, integer),
  public.get_site_update(text, boolean), public.admin_list_site_updates(),
  public.save_site_update(uuid, uuid, jsonb), public.delete_site_update(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.site_update_json(public.site_updates, boolean),
  public.list_site_updates(boolean, text, text, timestamptz, integer),
  public.get_site_update(text, boolean), public.admin_list_site_updates(),
  public.save_site_update(uuid, uuid, jsonb), public.delete_site_update(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
commit;
