-- LOCAL: apply after 202611170003_paddock_alerts.sql. Non-destructive and safe to re-run.
-- Reactions on Updates posts: a signed-in account can mark a published post it can read with
-- any of four fixed reactions. Everyone who can read the post sees the counts.
-- Reads and writes go through checked functions only (RLS on, no browser grants).
begin;

create table if not exists public.site_update_reactions (
  update_id uuid not null references public.site_updates(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  reaction text not null check (reaction in ('like', 'celebrate', 'love', 'horse')),
  created_at timestamptz not null default now(),
  primary key (update_id, account_id, reaction)
);
create index if not exists site_update_reactions_account on public.site_update_reactions (account_id);

alter table public.site_update_reactions enable row level security;
revoke all on public.site_update_reactions from public, anon, authenticated, service_role;
grant select on public.site_update_reactions to service_role;

-- Counts (and this account's own picks) for the published posts the reader may see.
-- { "<slug>": { "counts": { "like": 3, ... }, "mine": ["like"] }, ... }
create or replace function public.site_update_reactions_for(p_slugs text[], p_members boolean, p_account uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(s.slug, jsonb_build_object(
    'counts', coalesce((
      select jsonb_object_agg(c.reaction, c.total)
      from (
        select r.reaction, count(*)::int as total
        from public.site_update_reactions r
        where r.update_id = s.id
        group by r.reaction
      ) c
    ), '{}'::jsonb),
    'mine', coalesce((
      select jsonb_agg(m.reaction order by m.reaction)
      from public.site_update_reactions m
      where m.update_id = s.id and p_account is not null and m.account_id = p_account
    ), '[]'::jsonb)
  )), '{}'::jsonb)
  from public.site_updates s
  where s.slug = any(coalesce(p_slugs, '{}'::text[]))
    and s.status = 'published' and s.published_at <= now()
    and (s.audience = 'public' or p_members);
$$;

-- Add or take back one reaction. Signed-in accounts can read members-only posts too.
create or replace function public.react_to_site_update(p_account uuid, p_slug text, p_reaction text, p_on boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
begin
  if p_reaction is null or p_reaction not in ('like', 'celebrate', 'love', 'horse') then
    raise exception 'unknown_reaction';
  end if;
  if not exists (select 1 from public.accounts a where a.id = p_account and a.status = 'active') then
    raise exception 'not_allowed';
  end if;
  select s.id into target from public.site_updates s
  where s.slug = p_slug and s.status = 'published' and s.published_at <= now();
  if target is null then
    raise exception 'unknown_update';
  end if;
  if coalesce(p_on, false) then
    insert into public.site_update_reactions (update_id, account_id, reaction)
    values (target, p_account, p_reaction)
    on conflict do nothing;
  else
    delete from public.site_update_reactions r
    where r.update_id = target and r.account_id = p_account and r.reaction = p_reaction;
  end if;
  return public.site_update_reactions_for(array[p_slug], true, p_account) -> p_slug;
end $$;

revoke all on function public.site_update_reactions_for(text[], boolean, uuid),
  public.react_to_site_update(uuid, text, text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.site_update_reactions_for(text[], boolean, uuid),
  public.react_to_site_update(uuid, text, text, boolean)
  to service_role;

notify pgrst, 'reload schema';
commit;
