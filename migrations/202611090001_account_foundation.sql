-- LOCAL: apply after 202611030002_personal_racing.sql. Non-destructive.
-- One `accounts` row per sign-in identity. It is the anchor every customer-owned
-- feature (subscriptions, carts, orders, horses, follows) should reference.
--
-- Security model
--  * The browser never touches these tables (RLS on, no anon/authenticated grants).
--  * The backend (service_role) may READ accounts but cannot write them directly.
--    Every write goes through a checked function below.
--  * platform_role (customer/admin/superadmin) can only be changed from the
--    Supabase SQL editor with public.set_platform_role(). The backend key cannot
--    call it, so a leaked server key cannot create admins.
--  * account_events is append-only, even for the database owner.
begin;

create table public.accounts (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '' check (length(email) <= 254),
  first_name text not null default '' check (length(first_name) <= 60),
  last_name text not null default '' check (length(last_name) <= 60),
  country text not null default '' check (country = '' or country ~ '^[A-Z]{2}$'),
  racing_role text not null default '' check (racing_role in ('', 'owner', 'trainer', 'jockey', 'staff', 'fan', 'other')),
  platform_role text not null default 'customer' check (platform_role in ('customer', 'admin', 'superadmin')),
  -- Staff can view the site as a lower role. Never higher than platform_role.
  acting_role text check (acting_role in ('customer', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  status_reason text not null default '' check (length(status_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    acting_role is null
    or (acting_role = 'customer' and platform_role in ('admin', 'superadmin'))
    or (acting_role = 'admin' and platform_role = 'superadmin')
  )
);
create index accounts_staff on public.accounts (platform_role) where platform_role <> 'customer';
create index accounts_created on public.accounts (created_at desc);

create table public.account_events (
  id bigint generated always as identity primary key,
  -- No foreign keys on purpose: the trail must outlive deleted accounts.
  account_id uuid,
  actor_id uuid,
  event text not null check (event ~ '^[a-z][a-z_.]{2,59}$'),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and octet_length(detail::text) <= 2048),
  created_at timestamptz not null default now()
);
create index account_events_account on public.account_events (account_id, created_at desc);
create index account_events_recent on public.account_events (created_at desc, id desc);

create function public.account_events_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'account_events is append-only';
end $$;
create trigger account_events_no_update before update or delete on public.account_events
  for each row execute function public.account_events_append_only();
create trigger account_events_no_truncate before truncate on public.account_events
  for each statement execute function public.account_events_append_only();

alter table public.accounts enable row level security;
alter table public.account_events enable row level security;
revoke all on public.accounts, public.account_events from public, anon, authenticated, service_role;
grant select on public.accounts to service_role;
grant select on public.account_events to service_role;
grant insert (account_id, actor_id, event, detail) on public.account_events to service_role;

-- Creates the account row for an existing sign-in identity (idempotent) and returns it.
-- Profile fields are copied once from sign-up details and cleaned.
create function public.ensure_account(p_user uuid) returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare result public.accounts; created integer;
begin
  select * into result from public.accounts where id = p_user;
  if found then return result; end if;
  insert into public.accounts (id, email, first_name, last_name, country, racing_role)
  select u.id,
    left(lower(coalesce(u.email, '')), 254),
    left(btrim(regexp_replace(coalesce(u.raw_user_meta_data ->> 'first_name', ''), '[[:cntrl:]<>]', '', 'g')), 60),
    left(btrim(regexp_replace(coalesce(u.raw_user_meta_data ->> 'last_name', ''), '[[:cntrl:]<>]', '', 'g')), 60),
    case when coalesce(u.raw_user_meta_data ->> 'country', '') ~ '^[A-Z]{2}$' then u.raw_user_meta_data ->> 'country' else '' end,
    case when u.raw_user_meta_data ->> 'racing_role' in ('owner', 'trainer', 'jockey', 'staff', 'fan', 'other')
      then u.raw_user_meta_data ->> 'racing_role' else '' end
  from auth.users u where u.id = p_user
  on conflict (id) do nothing;
  get diagnostics created = row_count;
  select * into result from public.accounts where id = p_user;
  if not found then raise exception 'unknown_account'; end if;
  if created > 0 then
    insert into public.account_events (account_id, actor_id, event) values (p_user, p_user, 'account.created');
  end if;
  return result;
end $$;

create function public.update_account_profile(p_user uuid, p_first text, p_last text, p_country text, p_racing_role text)
returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare result public.accounts;
begin
  update public.accounts set first_name = btrim(p_first), last_name = btrim(p_last), country = p_country,
    racing_role = p_racing_role, updated_at = now()
  where id = p_user and status = 'active' returning * into result;
  if not found then raise exception 'unknown_account'; end if;
  return result;
end $$;

-- p_role: 'customer' | 'admin' | 'superadmin'. Choosing your real role clears the view.
create function public.set_account_acting_role(p_user uuid, p_role text) returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare current public.accounts; result public.accounts; next_role text;
begin
  select * into current from public.accounts where id = p_user and status = 'active' for update;
  if not found then raise exception 'unknown_account'; end if;
  next_role := case when p_role = current.platform_role then null else p_role end;
  if next_role is not null and not (
    (next_role = 'customer' and current.platform_role in ('admin', 'superadmin'))
    or (next_role = 'admin' and current.platform_role = 'superadmin')
  ) then raise exception 'not_allowed'; end if;
  update public.accounts set acting_role = next_role, updated_at = now() where id = p_user returning * into result;
  insert into public.account_events (account_id, actor_id, event, detail)
  values (p_user, p_user, 'account.view_changed', jsonb_build_object('viewAs', coalesce(next_role, current.platform_role)));
  return result;
end $$;

-- Superadmin moderation. Superadmins cannot be suspended this way, nor can you suspend yourself.
create function public.set_account_status(p_actor uuid, p_subject uuid, p_status text, p_reason text)
returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare actor public.accounts; subject public.accounts; result public.accounts;
begin
  select * into actor from public.accounts where id = p_actor for share;
  if not found or actor.platform_role <> 'superadmin' or actor.status <> 'active' then raise exception 'not_allowed'; end if;
  if p_status not in ('active', 'suspended') or length(coalesce(p_reason, '')) > 300 then raise exception 'invalid_status'; end if;
  select * into subject from public.accounts where id = p_subject for update;
  if not found then raise exception 'unknown_account'; end if;
  if subject.id = actor.id or subject.platform_role = 'superadmin' then raise exception 'not_allowed'; end if;
  update public.accounts set status = p_status,
    status_reason = case when p_status = 'active' then '' else btrim(coalesce(p_reason, '')) end,
    acting_role = null, updated_at = now()
  where id = p_subject returning * into result;
  insert into public.account_events (account_id, actor_id, event, detail)
  values (p_subject, p_actor, 'account.status_changed',
    jsonb_build_object('from', subject.status, 'to', p_status, 'reason', left(btrim(coalesce(p_reason, '')), 300)));
  return result;
end $$;

-- SQL editor only. Example: select public.set_platform_role('person@example.com', 'admin');
create function public.set_platform_role(p_email text, p_role text) returns public.accounts
language plpgsql security definer set search_path = '' as $$
declare target uuid; previous text; result public.accounts;
begin
  if p_role not in ('customer', 'admin', 'superadmin') then raise exception 'Role must be customer, admin or superadmin'; end if;
  select id into target from auth.users where lower(email) = lower(btrim(p_email));
  if target is null then raise exception 'No sign-in account uses %', p_email; end if;
  perform public.ensure_account(target);
  select platform_role into previous from public.accounts where id = target for update;
  update public.accounts set platform_role = p_role, acting_role = null, updated_at = now()
  where id = target returning * into result;
  insert into public.account_events (account_id, actor_id, event, detail)
  values (target, null, 'account.role_changed', jsonb_build_object('from', previous, 'to', p_role, 'via', 'sql_editor'));
  return result;
end $$;

-- Keep accounts in step with sign-in identities. A failure here must never block sign-up;
-- the backend calls ensure_account() on first use as a fallback.
create function public.sync_account_from_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.ensure_account(new.id);
    elsif new.email is distinct from old.email then
      update public.accounts set email = left(lower(coalesce(new.email, '')), 254), updated_at = now() where id = new.id;
    end if;
  exception when others then
    raise warning 'account sync skipped for %', new.id;
  end;
  return new;
end $$;
create trigger stayblz_account_sync after insert or update of email on auth.users
  for each row execute function public.sync_account_from_auth();

revoke all on function public.ensure_account(uuid), public.update_account_profile(uuid, text, text, text, text),
  public.set_account_acting_role(uuid, text), public.set_account_status(uuid, uuid, text, text),
  public.set_platform_role(text, text), public.sync_account_from_auth(), public.account_events_append_only()
  from public, anon, authenticated, service_role;
grant execute on function public.ensure_account(uuid), public.update_account_profile(uuid, text, text, text, text),
  public.set_account_acting_role(uuid, text), public.set_account_status(uuid, uuid, text, text) to service_role;
-- set_platform_role stays with the database owner (SQL editor) only.

-- Existing identities get accounts; the existing trusted superadmin keeps that role.
select public.ensure_account(id) from auth.users;
update public.accounts a set platform_role = 'superadmin'
from auth.users u
where u.id = a.id and u.raw_app_meta_data ->> 'stayblz_role' = 'superadmin' and a.platform_role <> 'superadmin';

-- Default deny for everything created later in this schema: new tables, sequences and
-- functions get no browser-role access unless a migration grants it on purpose.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

notify pgrst, 'reload schema';
commit;
