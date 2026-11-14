-- Stayblz Paddock: free browser-to-browser video meetings (up to 8 people).
-- Apply after 202611140001_marketplace.sql.
--
-- Only the meeting itself and who attended are stored. Everything that happens during a call
-- (who is connected, camera/mic state, call setup messages, in-call chat, reactions, the waiting
-- room) lives in the API server's memory and disappears when the call ends. Video and audio go
-- directly between browsers and never reach Stayblz.
--
-- Same rules as the rest of Stayblz: RLS on, no browser grants, service-role-only paddock_*
-- functions; the API checks who may join.
begin;

create table public.paddock_meetings (
  id uuid primary key default gen_random_uuid(),
  -- Joining code, e.g. "hzpk-rwta" (letters only, no i/l/o so it reads clearly aloud).
  code text not null unique check (code ~ '^[a-z]{4}-[a-z]{4}$'),
  title text not null check (length(btrim(title)) between 1 and 100),
  host_id uuid not null references public.accounts(id) on delete cascade,
  -- Null for "start now" meetings.
  scheduled_for timestamptz,
  duration_minutes integer not null default 60 check (duration_minutes between 5 and 480),
  -- open: any signed-in Stayblz member with the link joins straight in.
  -- ask:  people who aren't invited ask to join, and the host lets them in.
  access text not null default 'ask' check (access in ('open', 'ask')),
  -- Guests (no Stayblz account) can ask to join with just a name. Always admitted by a host.
  guests_allowed boolean not null default true,
  -- A team meeting: everyone in this stable joins straight in.
  stable_id uuid references public.member_stables(id) on delete set null,
  invitee_ids uuid[] not null default '{}' check (cardinality(invitee_ids) <= 50),
  cohost_ids uuid[] not null default '{}' check (cardinality(cohost_ids) <= 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_live_at timestamptz
);
create index paddock_meetings_host on public.paddock_meetings (host_id, created_at desc);
create index paddock_meetings_invitees on public.paddock_meetings using gin (invitee_ids);
create index paddock_meetings_cohosts on public.paddock_meetings using gin (cohost_ids);
create index paddock_meetings_stable on public.paddock_meetings (stable_id) where stable_id is not null;

-- One row per account per meeting: powers "Recent" and keeps removed people out.
create table public.paddock_attendance (
  meeting_id uuid not null references public.paddock_meetings(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  first_joined_at timestamptz not null default now(),
  last_joined_at timestamptz not null default now(),
  removed boolean not null default false,
  primary key (meeting_id, account_id)
);
create index paddock_attendance_account on public.paddock_attendance (account_id, last_joined_at desc);

do $$ declare t text; begin
  foreach t in array array['paddock_meetings', 'paddock_attendance'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

create function public.paddock_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(a.first_name || ' ' || a.last_name), ''), 'Stayblz member')
  from public.accounts a where a.id = p_user
$$;

-- How this person relates to a meeting: host, cohost, invited, team (stable member) or none.
create function public.paddock_role(m public.paddock_meetings, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_user is null then 'guest'
    when m.host_id = p_user then 'host'
    when p_user = any (m.cohost_ids) then 'cohost'
    when p_user = any (m.invitee_ids) then 'invited'
    when m.stable_id is not null and exists (
      select 1 from public.stable_memberships s where s.stable_id = m.stable_id and s.user_id = p_user
    ) then 'team'
    else 'none'
  end
$$;

create function public.paddock_out(m public.paddock_meetings, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id,
    'code', m.code,
    'title', m.title,
    'hostId', m.host_id,
    'hostName', public.paddock_name(m.host_id),
    'scheduledFor', m.scheduled_for,
    'durationMinutes', m.duration_minutes,
    'access', m.access,
    'guestsAllowed', m.guests_allowed,
    'stableId', m.stable_id,
    'stableName', (select s.name from public.member_stables s where s.id = m.stable_id),
    'cohostIds', to_jsonb(m.cohost_ids),
    'createdAt', m.created_at,
    'lastLiveAt', m.last_live_at,
    'role', public.paddock_role(m, p_user),
    'removed', coalesce((select t.removed from public.paddock_attendance t
                          where t.meeting_id = m.id and t.account_id = p_user), false),
    'lastJoinedAt', (select t.last_joined_at from public.paddock_attendance t
                      where t.meeting_id = m.id and t.account_id = p_user),
    -- Only the host sees who is invited (to edit the list).
    'invitees', case when m.host_id = p_user then coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'name', public.paddock_name(a.id)) order by a.first_name, a.last_name)
      from public.accounts a where a.id = any (m.invitee_ids)), '[]'::jsonb) else null end
  )
$$;

-- One meeting by code, as this person (null p_user = a guest). Null when the code doesn't exist.
create function public.paddock_access(p_code text, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select public.paddock_out(m, p_user) from public.paddock_meetings m where m.code = p_code
$$;

-- The Paddock home page: meetings this person hosts, co-hosts, is invited to, belongs to through a
-- stable, or has joined (and wasn't removed from). Newest activity first.
create function public.paddock_home(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(item order by sort_at desc), '[]'::jsonb)
  from (
    select public.paddock_out(m, p_user) as item,
           greatest(coalesce(m.scheduled_for, m.created_at), coalesce(t.last_joined_at, m.created_at)) as sort_at
    from public.paddock_meetings m
    left join public.paddock_attendance t on t.meeting_id = m.id and t.account_id = p_user
    where (t.removed is null or t.removed = false)
      and (
        m.host_id = p_user
        or p_user = any (m.cohost_ids)
        or p_user = any (m.invitee_ids)
        or t.account_id is not null
        or (m.stable_id is not null and exists (
          select 1 from public.stable_memberships s where s.stable_id = m.stable_id and s.user_id = p_user))
      )
    order by sort_at desc
    limit 60
  ) recent
$$;

-- Record that this person joined. Returns false (and records nothing) when they were removed.
create function public.paddock_joined(p_meeting uuid, p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.paddock_attendance
             where meeting_id = p_meeting and account_id = p_user and removed) then
    return false;
  end if;
  insert into public.paddock_attendance (meeting_id, account_id)
  values (p_meeting, p_user)
  on conflict (meeting_id, account_id) do update set last_joined_at = now();
  update public.paddock_meetings set last_live_at = now() where id = p_meeting;
  return true;
end $$;

-- A host removed this person: they can't join again, directly or by asking.
create function public.paddock_remove(p_meeting uuid, p_user uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.paddock_attendance (meeting_id, account_id, removed)
  values (p_meeting, p_user, true)
  on conflict (meeting_id, account_id) do update set removed = true;
  update public.paddock_meetings set cohost_ids = array_remove(cohost_ids, p_user),
    invitee_ids = array_remove(invitee_ids, p_user), updated_at = now()
  where id = p_meeting;
  return true;
end $$;

-- Every paddock_* function: service role only.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'paddock\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
