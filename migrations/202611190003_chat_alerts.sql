-- Stayblz Chat alerts: one saved row per person for everything in Stayblz Chat that should tell them something.
-- Apply after 202611190002_marketplace_description.sql. Safe to re-run.
--
--   message           a new message (collapsed: one unread row per chat, with a count)
--   request           a message from someone who isn't your friend yet (collapsed like messages)
--   mention           "@Your Name" in a group (reaches you even in a muted chat)
--   reply             a reply to one of your messages (reaches you even in a muted chat)
--   reaction          someone reacted to your message
--   group_added       someone added you to a group (personal or team)
--   friend_request    someone asked to be your friend
--   friend_accepted   someone accepted your friend request
--   request_accepted  someone accepted your message request
--
-- The backend (lib/chatAlerts.ts) calls chat_notify / chat_notify_person right after the action, then sends Web Push
-- to the devices these functions return. The bell (/api/notifications/alerts) and the in-page poll read the same rows,
-- so the list survives reloads and every device sees the same history. Rows older than 30 days, or beyond the newest
-- 200 per person, are removed as new ones arrive.
--
-- Also: two new switches, "Mentions and replies" and "Reactions" (both on by default).
-- RLS on, no browser grants; everything through service-role-only functions.

begin;

create table if not exists public.chat_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('message', 'request', 'mention', 'reply', 'reaction', 'group_added',
                                     'friend_request', 'friend_accepted', 'request_accepted')),
  chat_kind text check (chat_kind is null or chat_kind in ('personal', 'team')),
  conversation_id uuid,
  message_id uuid,
  stable_id uuid,
  actor_id uuid references public.accounts(id) on delete cascade,
  actor_name text not null check (length(actor_name) between 1 and 120),
  chat_title text check (chat_title is null or length(chat_title) <= 120),
  is_group boolean not null default false,
  body text not null default '' check (length(body) <= 300),
  emoji text check (emoji is null or length(emoji) <= 16),
  attachment jsonb check (attachment is null or jsonb_typeof(attachment) = 'object'),
  count integer not null default 1 check (count >= 1),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists chat_alerts_user on public.chat_alerts (user_id, created_at desc);
create index if not exists chat_alerts_open on public.chat_alerts (user_id, conversation_id) where read_at is null;

alter table public.chat_alerts enable row level security;
revoke all on public.chat_alerts from public, anon, authenticated;
grant select, insert, update, delete on public.chat_alerts to service_role;

alter table public.notification_settings add column if not exists chat_mentions boolean not null default true;
alter table public.notification_settings add column if not exists chat_reactions boolean not null default true;

create or replace function public.notification_settings_get(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce(s.enabled, false),
    'chatMessages', coalesce(s.chat_messages, true),
    'chatRequests', coalesce(s.chat_requests, true),
    'chatMentions', coalesce(s.chat_mentions, true),
    'chatReactions', coalesce(s.chat_reactions, true),
    'paddockCalls', coalesce(s.paddock_calls, true),
    'previews', coalesce(s.previews, true),
    'sound', coalesce(s.sound, true),
    'promptedAt', s.prompted_at,
    'devices', (select count(*) from public.push_subscriptions p where p.user_id = p_user))
  from (select 1) x left join public.notification_settings s on s.user_id = p_user
$$;

-- Keys: enabled, chatMessages, chatRequests, chatMentions, chatReactions, paddockCalls, previews, sound (booleans),
-- prompted (true = "we asked").
create or replace function public.notification_settings_set(p_user uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  if jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_settings'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if k not in ('enabled', 'chatMessages', 'chatRequests', 'chatMentions', 'chatReactions', 'paddockCalls', 'previews',
                 'sound', 'prompted')
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
    chat_mentions = coalesce((p_changes ->> 'chatMentions')::boolean, chat_mentions),
    chat_reactions = coalesce((p_changes ->> 'chatReactions')::boolean, chat_reactions),
    paddock_calls = coalesce((p_changes ->> 'paddockCalls')::boolean, paddock_calls),
    previews = coalesce((p_changes ->> 'previews')::boolean, previews),
    sound = coalesce((p_changes ->> 'sound')::boolean, sound),
    prompted_at = case when coalesce((p_changes ->> 'prompted')::boolean, false) then now() else prompted_at end,
    updated_at = now()
  where user_id = p_user;
  return public.notification_settings_get(p_user);
end $$;

-- "@Ann Ames" written in the text (any case; not followed by another letter or digit), as the chat shows mentions.
create or replace function public.chat_mentions_name(p_body text, p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(length(btrim(p_name)) > 0
    and p_body ~* ('@' || regexp_replace(btrim(p_name), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '(?![[:alnum:]])'), false)
$$;

-- One alert row as the browser sees it.
create or replace function public.chat_alert_out(a public.chat_alerts) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'kind', a.kind, 'chatKind', a.chat_kind, 'chatId', a.conversation_id, 'messageId', a.message_id,
    'stableId', a.stable_id, 'actorId', a.actor_id, 'actorName', a.actor_name, 'title', a.chat_title,
    'group', a.is_group, 'body', a.body, 'emoji', a.emoji, 'attachment', a.attachment, 'count', a.count,
    'at', a.created_at, 'read', a.read_at is not null)
$$;

-- Which switch an alert kind follows.
create or replace function public.chat_alert_allowed(n public.notification_settings, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(n.enabled, false) and case
    when p_kind in ('message', 'group_added') then n.chat_messages
    when p_kind in ('request', 'friend_request', 'friend_accepted', 'request_accepted') then n.chat_requests
    when p_kind in ('mention', 'reply') then n.chat_mentions
    when p_kind = 'reaction' then n.chat_reactions
    else false end
$$;

-- Saves one alert (collapsing new messages / requests into the chat's unread row) and keeps the list short.
-- Returns the row id, or null when nothing new should be sent (a repeated reaction or friend request).
create or replace function public.chat_alert_put(p_row public.chat_alerts) returns uuid
language plpgsql security definer set search_path = '' as $$
declare found_id uuid;
begin
  if p_row.kind in ('message', 'request') then
    update public.chat_alerts set kind = p_row.kind, message_id = p_row.message_id, actor_id = p_row.actor_id,
      actor_name = p_row.actor_name, chat_title = p_row.chat_title, body = p_row.body, attachment = p_row.attachment,
      count = count + 1, created_at = now()
    where id = (select id from public.chat_alerts where user_id = p_row.user_id and conversation_id = p_row.conversation_id
                  and kind in ('message', 'request') and read_at is null order by created_at desc limit 1)
    returning id into found_id;
  elsif p_row.kind = 'reaction' then
    -- Changing your reaction on the same message within 10 minutes updates the alert instead of sending another.
    update public.chat_alerts set emoji = p_row.emoji
    where user_id = p_row.user_id and kind = 'reaction' and message_id = p_row.message_id and actor_id = p_row.actor_id
      and created_at > now() - interval '10 minutes'
    returning id into found_id;
    if found_id is not null then return null; end if;
  elsif p_row.kind = 'friend_request' then
    if exists (select 1 from public.chat_alerts where user_id = p_row.user_id and kind = 'friend_request'
                 and actor_id = p_row.actor_id and created_at > now() - interval '1 day') then
      return null;
    end if;
  end if;
  if found_id is null then
    insert into public.chat_alerts (user_id, kind, chat_kind, conversation_id, message_id, stable_id, actor_id, actor_name,
      chat_title, is_group, body, emoji, attachment)
    values (p_row.user_id, p_row.kind, p_row.chat_kind, p_row.conversation_id, p_row.message_id, p_row.stable_id,
      p_row.actor_id, left(coalesce(nullif(btrim(p_row.actor_name), ''), 'Stayblz member'), 120), left(p_row.chat_title, 120),
      coalesce(p_row.is_group, false), left(coalesce(p_row.body, ''), 300), p_row.emoji, p_row.attachment)
    returning id into found_id;
  end if;
  delete from public.chat_alerts where user_id = p_row.user_id and (created_at < now() - interval '30 days' or id in (
    select id from public.chat_alerts where user_id = p_row.user_id order by created_at desc offset 200));
  return found_id;
end $$;

-- The devices to push to for these new alerts: people who switched notifications on and allow that kind.
create or replace function public.chat_alert_targets(p_alerts jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'userId', p.user_id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth,
           'previews', n.previews, 'alertId', a ->> 'id') order by p.created_at desc), '[]')
  from jsonb_array_elements(coalesce(p_alerts, '[]')) a
  join public.notification_settings n on n.user_id = (a ->> 'userId')::uuid
  join public.push_subscriptions p on p.user_id = n.user_id
  where public.chat_alert_allowed(n, a ->> 'kind')
$$;

-- After a message, a reaction or adding people to a group: save the alerts and return who to push.
--   p_event: { "type": "message", "messageId": … }
--          | { "type": "reaction", "messageId": …, "emoji": … }
--          | { "type": "group_added", "ids": [ … ] }
-- Returns { chat: {kind, id, stableId, group, title}, alerts: [chat_alert_out + userId], targets: [...] }.
create or replace function public.chat_notify(p_kind text, p_conversation uuid, p_actor uuid, p_event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c jsonb;
  m jsonb;
  members text[];
  is_group boolean;
  title text;
  stable_ref uuid;
  actor_name text;
  ev text := p_event ->> 'type';
  reply_author uuid;
  r uuid;
  r_name text;
  s jsonb;
  k text;
  alert_id uuid;
  a_row public.chat_alerts;
  alerts jsonb := '[]';
  body text;
  attachment jsonb;
begin
  if p_kind = 'personal' then
    select to_jsonb(x) into c from public.personal_conversations x where x.id = p_conversation;
  elsif p_kind = 'team' then
    select to_jsonb(x) into c from public.member_conversations x where x.id = p_conversation;
  else raise exception 'invalid_kind'; end if;
  if c is null or not (c -> 'member_ids') ? p_actor::text then
    return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb);
  end if;
  select coalesce(array_agg(v), '{}') into members from jsonb_array_elements_text(c -> 'member_ids') v;
  is_group := c ->> 'kind' = 'group';
  title := case when is_group then c ->> 'title' end;
  stable_ref := (c ->> 'stable_id')::uuid;
  actor_name := public.chat_display_name(p_actor);

  if ev in ('message', 'reaction') then
    if p_kind = 'personal' then
      select to_jsonb(x) into m from public.personal_messages x where x.id = (p_event ->> 'messageId')::uuid and x.conversation_id = p_conversation;
    else
      select to_jsonb(x) into m from public.member_messages x where x.id = (p_event ->> 'messageId')::uuid and x.conversation_id = p_conversation;
    end if;
    if m is null or m ->> 'deleted_at' is not null or coalesce((m ->> 'system')::boolean, false) then
      return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb);
    end if;
    body := left(regexp_replace(coalesce(m ->> 'body', ''), '\s+', ' ', 'g'), 300);
    attachment := case when jsonb_typeof(m -> 'attachment') = 'object' then (m -> 'attachment') - 'path' end;
  end if;

  if ev = 'message' then
    if (m ->> 'sender_id')::uuid <> p_actor then return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb); end if;
    if m ->> 'reply_to' is not null then
      if p_kind = 'personal' then
        select sender_id into reply_author from public.personal_messages where id = (m ->> 'reply_to')::uuid;
      else
        select sender_id into reply_author from public.member_messages where id = (m ->> 'reply_to')::uuid;
      end if;
    end if;
    foreach r in array members::uuid[] loop
      continue when r = p_actor;
      continue when p_kind = 'personal' and public.chat_blocked_between(r, p_actor);
      continue when p_kind = 'team' and not exists (select 1 from public.stable_memberships sm where sm.stable_id = stable_ref and sm.user_id = r);
      select to_jsonb(x) into s from public.chat_settings x where x.user_id = r and x.kind = p_kind and x.conversation_id = p_conversation;
      r_name := case when p_kind = 'personal' then c -> 'member_names' ->> r::text
                     else (select sm.display_name from public.stable_memberships sm where sm.stable_id = stable_ref and sm.user_id = r) end;
      k := case
        when coalesce(c -> 'requested_ids', '[]') ? r::text then 'request'
        when is_group and public.chat_mentions_name(body, coalesce(r_name, public.chat_display_name(r))) then 'mention'
        when reply_author = r then 'reply'
        else 'message' end;
      -- A muted chat stays quiet, except when someone mentions you or replies to you.
      continue when public.chat_is_muted(s) and k not in ('mention', 'reply');
      a_row := null;
      a_row.user_id := r; a_row.kind := k; a_row.chat_kind := p_kind; a_row.conversation_id := p_conversation;
      a_row.message_id := (m ->> 'id')::uuid; a_row.stable_id := stable_ref; a_row.actor_id := p_actor; a_row.actor_name := actor_name;
      a_row.chat_title := title; a_row.is_group := is_group; a_row.body := body; a_row.attachment := attachment;
      alert_id := public.chat_alert_put(a_row);
      if alert_id is not null then
        alerts := alerts || (select public.chat_alert_out(x) || jsonb_build_object('userId', x.user_id) from public.chat_alerts x where x.id = alert_id);
      end if;
    end loop;

  elsif ev = 'reaction' then
    r := (m ->> 'sender_id')::uuid;
    -- Only a reaction that is really there now, on someone else's message, by a member.
    if r <> p_actor and members @> array[r::text] and (m -> 'reactions' ->> p_actor::text) = (p_event ->> 'emoji')
       and not (p_kind = 'personal' and public.chat_blocked_between(r, p_actor))
       and not (p_kind = 'team' and not exists (select 1 from public.stable_memberships sm where sm.stable_id = stable_ref and sm.user_id = r)) then
      select to_jsonb(x) into s from public.chat_settings x where x.user_id = r and x.kind = p_kind and x.conversation_id = p_conversation;
      if not public.chat_is_muted(s) then
        a_row := null;
        a_row.user_id := r; a_row.kind := 'reaction'; a_row.chat_kind := p_kind; a_row.conversation_id := p_conversation;
        a_row.message_id := (m ->> 'id')::uuid; a_row.stable_id := stable_ref; a_row.actor_id := p_actor; a_row.actor_name := actor_name;
        a_row.chat_title := title; a_row.is_group := is_group; a_row.body := body; a_row.attachment := attachment;
        a_row.emoji := left(p_event ->> 'emoji', 16);
        alert_id := public.chat_alert_put(a_row);
        if alert_id is not null then
          alerts := alerts || (select public.chat_alert_out(x) || jsonb_build_object('userId', x.user_id) from public.chat_alerts x where x.id = alert_id);
        end if;
      end if;
    end if;

  elsif ev = 'group_added' then
    foreach r in array (select coalesce(array_agg(distinct v::uuid), '{}') from jsonb_array_elements_text(coalesce(p_event -> 'ids', '[]')) v
                        where v ~ '^[0-9a-f-]{36}$') loop
      continue when r = p_actor or not members @> array[r::text];
      continue when p_kind = 'personal' and public.chat_blocked_between(r, p_actor);
      a_row := null;
      a_row.user_id := r; a_row.kind := 'group_added'; a_row.chat_kind := p_kind; a_row.conversation_id := p_conversation;
      a_row.stable_id := stable_ref; a_row.actor_id := p_actor; a_row.actor_name := actor_name; a_row.chat_title := c ->> 'title';
      a_row.is_group := true;
      alert_id := public.chat_alert_put(a_row);
      if alert_id is not null then
        alerts := alerts || (select public.chat_alert_out(x) || jsonb_build_object('userId', x.user_id) from public.chat_alerts x where x.id = alert_id);
      end if;
    end loop;
  else
    raise exception 'invalid_event';
  end if;

  return jsonb_build_object(
    'chat', jsonb_build_object('kind', p_kind, 'id', p_conversation, 'stableId', stable_ref, 'group', is_group, 'title', title),
    'alerts', alerts,
    'targets', public.chat_alert_targets(alerts));
end $$;

-- Person-to-person alerts: friend_request, friend_accepted, request_accepted (p_conversation = the chat).
create or replace function public.chat_notify_person(p_actor uuid, p_target uuid, p_type text, p_conversation uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a_row public.chat_alerts; alert_id uuid; alerts jsonb := '[]';
begin
  if p_type not in ('friend_request', 'friend_accepted', 'request_accepted') then raise exception 'invalid_event'; end if;
  if p_actor = p_target or public.chat_blocked_between(p_actor, p_target)
     or not exists (select 1 from public.accounts a where a.id = p_target and a.status = 'active') then
    return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb);
  end if;
  if p_type = 'request_accepted' and not exists (
       select 1 from public.personal_conversations x where x.id = p_conversation
         and x.member_ids @> array[p_actor, p_target]) then
    return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb);
  end if;
  a_row.user_id := p_target; a_row.kind := p_type; a_row.actor_id := p_actor; a_row.actor_name := public.chat_display_name(p_actor);
  if p_type = 'request_accepted' then a_row.chat_kind := 'personal'; a_row.conversation_id := p_conversation; end if;
  alert_id := public.chat_alert_put(a_row);
  if alert_id is not null then
    alerts := (select jsonb_build_array(public.chat_alert_out(x) || jsonb_build_object('userId', x.user_id)) from public.chat_alerts x where x.id = alert_id);
  end if;
  return jsonb_build_object('alerts', alerts, 'targets', public.chat_alert_targets(alerts));
end $$;

-- Your alerts, newest first: everything (p_since null) or what's new/updated since a time. Hides team chats you've left.
create or replace function public.chat_alerts_list(p_user uuid, p_since timestamptz, p_limit integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(public.chat_alert_out(a) order by a.created_at desc)
      from public.chat_alerts a
      where a.id in (
        select b.id from public.chat_alerts b
        where b.user_id = p_user and (p_since is null or b.created_at > p_since)
          and (b.chat_kind is distinct from 'team' or exists (
            select 1 from public.stable_memberships sm where sm.stable_id = b.stable_id and sm.user_id = p_user))
        order by b.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 50))), '[]'),
    'unread', (select count(*) from public.chat_alerts a where a.user_id = p_user and a.read_at is null
      and (a.chat_kind is distinct from 'team' or exists (
        select 1 from public.stable_memberships sm where sm.stable_id = a.stable_id and sm.user_id = p_user))))
$$;

-- Mark some (p_ids) or all (null) of your alerts read. Returns how many are still unread.
create or replace function public.chat_alerts_mark_read(p_user uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.chat_alerts set read_at = now()
  where user_id = p_user and read_at is null and (p_ids is null or id = any (p_ids));
  select count(*) into n from public.chat_alerts a where a.user_id = p_user and a.read_at is null
    and (a.chat_kind is distinct from 'team' or exists (
      select 1 from public.stable_memberships sm where sm.stable_id = a.stable_id and sm.user_id = p_user));
  return n;
end $$;

-- Opening a chat reads its alerts.
create or replace function public.chat_alerts_read_chat(p_user uuid, p_kind text, p_conversation uuid) returns void
language sql security definer set search_path = '' as $$
  update public.chat_alerts set read_at = now()
  where user_id = p_user and chat_kind = p_kind and conversation_id = p_conversation and read_at is null
$$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'chat\_alert%' or p.proname in
             ('chat_notify', 'chat_notify_person', 'chat_mentions_name', 'notification_settings_get', 'notification_settings_set')) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
