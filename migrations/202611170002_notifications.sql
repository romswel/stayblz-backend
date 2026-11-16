-- Notifications, part 1: account settings + Web Push subscriptions (Stayblz Chat first). LOCAL until approved.
--
-- notification_settings: one row per account (missing row = defaults, everything off until the person says yes).
-- push_subscriptions:   one row per browser/device that turned on "alerts when Stayblz is closed". A device belongs to
--                        the account that subscribed last (shared computers don't get someone else's alerts).
-- Push is sent by the backend (lib/push.ts) after a chat message is saved, only to members who switched
-- notifications on, haven't muted that chat, and (for message requests) allow request alerts.
--
-- RLS on, no browser grants; everything through service-role-only functions.

create table if not exists public.notification_settings (
  user_id uuid primary key references public.accounts(id) on delete cascade,
  enabled boolean not null default false,
  chat_messages boolean not null default true,
  chat_requests boolean not null default true,
  previews boolean not null default true,
  sound boolean not null default true,
  prompted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  endpoint text not null unique check (length(endpoint) between 20 and 1000 and endpoint like 'https://%'),
  p256dh text not null check (length(p256dh) between 20 and 200),
  auth text not null check (length(auth) between 8 and 100),
  user_agent text check (user_agent is null or length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['notification_settings', 'push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

create or replace function public.notification_settings_get(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce(s.enabled, false),
    'chatMessages', coalesce(s.chat_messages, true),
    'chatRequests', coalesce(s.chat_requests, true),
    'previews', coalesce(s.previews, true),
    'sound', coalesce(s.sound, true),
    'promptedAt', s.prompted_at,
    'devices', (select count(*) from public.push_subscriptions p where p.user_id = p_user))
  from (select 1) x left join public.notification_settings s on s.user_id = p_user
$$;

-- Change some settings. Keys: enabled, chatMessages, chatRequests, previews, sound (booleans), prompted (true = "we asked").
create or replace function public.notification_settings_set(p_user uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_settings'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('enabled', 'chatMessages', 'chatRequests', 'previews', 'sound', 'prompted')
       or jsonb_typeof(p_changes -> k) <> 'boolean' then
      raise exception 'invalid_settings';
    end if;
  end loop;
  if not exists (select 1 from public.accounts where id = p_user and status = 'active') then raise exception 'unknown_account'; end if;
  insert into public.notification_settings (user_id) values (p_user) on conflict (user_id) do nothing;
  update public.notification_settings set
    enabled = coalesce((p_changes ->> 'enabled')::boolean, enabled),
    chat_messages = coalesce((p_changes ->> 'chatMessages')::boolean, chat_messages),
    chat_requests = coalesce((p_changes ->> 'chatRequests')::boolean, chat_requests),
    previews = coalesce((p_changes ->> 'previews')::boolean, previews),
    sound = coalesce((p_changes ->> 'sound')::boolean, sound),
    prompted_at = case when coalesce((p_changes ->> 'prompted')::boolean, false) then now() else prompted_at end,
    updated_at = now()
  where user_id = p_user;
  return public.notification_settings_get(p_user);
end $$;

-- Save this device's push subscription for p_user (moving it from any other account). Keeps the newest 10 per account.
create or replace function public.push_subscription_save(p_user uuid, p_endpoint text, p_p256dh text, p_auth text, p_agent text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not exists (select 1 from public.accounts where id = p_user and status = 'active') then raise exception 'unknown_account'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (p_user, p_endpoint, p_p256dh, p_auth, left(p_agent, 300))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, created_at = now();
  delete from public.push_subscriptions where id in (
    select id from public.push_subscriptions where user_id = p_user order by created_at desc offset 10);
  select count(*) into n from public.push_subscriptions where user_id = p_user;
  return n;
end $$;

create or replace function public.push_subscription_remove(p_user uuid, p_endpoint text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_subscriptions where user_id = p_user and endpoint = p_endpoint;
  return found;
end $$;

-- The push service said this subscription is gone (404/410): forget it. Or it worked: remember when.
create or replace function public.push_subscription_result(p_endpoint text, p_ok boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_ok then update public.push_subscriptions set last_ok_at = now() where endpoint = p_endpoint;
  else delete from public.push_subscriptions where endpoint = p_endpoint; end if;
end $$;

-- This account's devices (for "Send a test notification").
create or replace function public.push_subscriptions_for(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth) order by created_at desc), '[]')
  from public.push_subscriptions where user_id = p_user
$$;

-- Who gets a push for a new message in this chat: members other than the sender with notifications on, who haven't
-- muted the chat, still belong to the stable (team), and allow this kind (message vs. request). One row per device.
-- Returns { group, title, stableId, targets: [...] } (title only for groups).
create or replace function public.chat_push_targets(p_kind text, p_conversation uuid, p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb; result jsonb;
begin
  if p_kind = 'personal' then
    select to_jsonb(x) into c from public.personal_conversations x where x.id = p_conversation;
  elsif p_kind = 'team' then
    select to_jsonb(x) into c from public.member_conversations x where x.id = p_conversation;
  else raise exception 'invalid_kind'; end if;
  if c is null or not (c -> 'member_ids') ? p_sender::text then
    return jsonb_build_object('group', false, 'title', null, 'stableId', null, 'targets', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'userId', p.user_id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth,
           'previews', n.previews, 'request', coalesce(c -> 'requested_ids', '[]') ? p.user_id::text)), '[]')
    into result
  from public.push_subscriptions p
  join public.notification_settings n on n.user_id = p.user_id and n.enabled
  left join public.chat_settings s on s.user_id = p.user_id and s.kind = p_kind and s.conversation_id = p_conversation
  where (c -> 'member_ids') ? p.user_id::text and p.user_id <> p_sender
    and not public.chat_is_muted(to_jsonb(s))
    and case when coalesce(c -> 'requested_ids', '[]') ? p.user_id::text then n.chat_requests else n.chat_messages end
    and (p_kind = 'personal' or exists (
      select 1 from public.stable_memberships m where m.stable_id = (c ->> 'stable_id')::uuid and m.user_id = p.user_id))
    and not (p_kind = 'personal' and public.chat_blocked_between(p.user_id, p_sender));
  return jsonb_build_object('group', c ->> 'kind' = 'group',
                            'title', case when c ->> 'kind' = 'group' then c ->> 'title' end,
                            'stableId', c ->> 'stable_id', 'targets', result);
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'notification\_%' or p.proname like 'push\_%'
                                           or p.proname = 'chat_push_targets') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
