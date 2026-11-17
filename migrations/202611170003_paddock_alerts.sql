-- Stayblz Paddock alerts: incoming calls, "meeting started" and invitations reach people through the
-- site-wide notifications (in-page card, system notification, Web Push).
-- Apply after 202611170002_notifications.sql.
--
-- 1. A new notification choice, "Calls and meetings" (on unless the person turns it off).
-- 2. paddock_alert_targets(): who may be alerted by a caller — active accounts that haven't blocked
--    them on Stayblz Chat — with their choice and their push devices.
-- The alerts themselves live in the API server's memory (lib/paddockAlerts.ts), like live calls.
begin;

alter table public.notification_settings add column if not exists paddock_calls boolean not null default true;

create or replace function public.notification_settings_get(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce(s.enabled, false),
    'chatMessages', coalesce(s.chat_messages, true),
    'chatRequests', coalesce(s.chat_requests, true),
    'paddockCalls', coalesce(s.paddock_calls, true),
    'previews', coalesce(s.previews, true),
    'sound', coalesce(s.sound, true),
    'promptedAt', s.prompted_at,
    'devices', (select count(*) from public.push_subscriptions p where p.user_id = p_user))
  from (select 1) x left join public.notification_settings s on s.user_id = p_user
$$;

-- Change some settings. Keys: enabled, chatMessages, chatRequests, paddockCalls, previews, sound (booleans),
-- prompted (true = "we asked").
create or replace function public.notification_settings_set(p_user uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_settings'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('enabled', 'chatMessages', 'chatRequests', 'paddockCalls', 'previews', 'sound', 'prompted')
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
    paddock_calls = coalesce((p_changes ->> 'paddockCalls')::boolean, paddock_calls),
    previews = coalesce((p_changes ->> 'previews')::boolean, previews),
    sound = coalesce((p_changes ->> 'sound')::boolean, sound),
    prompted_at = case when coalesce((p_changes ->> 'prompted')::boolean, false) then now() else prompted_at end,
    updated_at = now()
  where user_id = p_user;
  return public.notification_settings_get(p_user);
end $$;

-- People p_from may alert: active accounts (never p_from) that haven't blocked p_from and allow call alerts.
-- push = their devices, only when they switched notifications on.
create or replace function public.paddock_alert_targets(p_from uuid, p_users uuid[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'userId', a.id,
    'name', public.paddock_name(a.id),
    'push', case when coalesce(n.enabled, false) then coalesce((
      select jsonb_agg(jsonb_build_object('endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth) order by p.created_at desc)
      from public.push_subscriptions p where p.user_id = a.id), '[]'::jsonb) else '[]'::jsonb end
  )), '[]'::jsonb)
  from public.accounts a
  left join public.notification_settings n on n.user_id = a.id
  where a.id = any (p_users)
    and a.id <> p_from
    and a.status = 'active'
    and coalesce(n.paddock_calls, true)
    and not exists (select 1 from public.chat_blocks b where b.user_id = a.id and b.blocked_id = p_from)
$$;

revoke all on function public.paddock_alert_targets(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.paddock_alert_targets(uuid, uuid[]) to service_role;
revoke all on function public.notification_settings_get(uuid) from public, anon, authenticated;
grant execute on function public.notification_settings_get(uuid) to service_role;
revoke all on function public.notification_settings_set(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.notification_settings_set(uuid, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
