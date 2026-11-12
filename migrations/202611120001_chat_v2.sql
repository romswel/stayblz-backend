-- Stayblz Chat v2 (builds on 202611110001_messenger.sql).
-- Adds: message editing, one attachment per message (photos/files in a private storage bucket), forwarding,
-- pinned messages, system lines ("Ann added Bob"), delivered receipts, per-person chat settings (pin, archive,
-- mute, mark unread, folders), friends + requests, blocking, people search, and chat privacy settings.
--
-- Same rules as before: RLS on, no browser grants, every read/write through service-role-only chat_* functions
-- that check membership themselves. Attachment files live in storage bucket `chat-files` (private) and are only
-- ever read through the backend after chat_attachment() confirms membership.

-- ————— Messages —————
alter table public.personal_messages
  drop constraint personal_messages_body_check,
  add column edited_at timestamptz,
  add column attachment jsonb check (attachment is null or jsonb_typeof(attachment) = 'object'),
  add column forwarded boolean not null default false,
  add column system boolean not null default false,
  add column pinned_at timestamptz,
  add column pinned_by uuid,
  add constraint personal_messages_body_check check (
    (deleted_at is null and length(body) <= 4000 and (length(btrim(body)) >= 1 or attachment is not null))
    or (deleted_at is not null and body = '' and attachment is null));
alter table public.member_messages
  drop constraint member_messages_body_check,
  add column edited_at timestamptz,
  add column attachment jsonb check (attachment is null or jsonb_typeof(attachment) = 'object'),
  add column forwarded boolean not null default false,
  add column system boolean not null default false,
  add column pinned_at timestamptz,
  add column pinned_by uuid,
  add constraint member_messages_body_check check (
    (deleted_at is null and length(body) <= 4000 and (length(btrim(body)) >= 1 or attachment is not null))
    or (deleted_at is not null and body = '' and attachment is null));
create index personal_messages_sender_files on public.personal_messages (sender_id) where attachment is not null;
create index member_messages_sender_files on public.member_messages (sender_id) where attachment is not null;

-- When each member's device last received the chat (for "Delivered").
alter table public.personal_conversations add column delivered jsonb not null default '{}' check (jsonb_typeof(delivered) = 'object');
alter table public.member_conversations add column delivered jsonb not null default '{}' check (jsonb_typeof(delivered) = 'object');

-- ————— Per-person tables —————
create table public.chat_profiles (
  user_id uuid primary key references public.accounts(id) on delete cascade,
  discoverable boolean not null default true,
  show_active boolean not null default true,
  updated_at timestamptz not null default now()
);
create table public.chat_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 40),
  position integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index chat_folders_name on public.chat_folders (user_id, lower(name));
create table public.chat_settings (
  user_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('personal', 'team')),
  conversation_id uuid not null,
  pinned_at timestamptz,
  archived_at timestamptz,
  muted boolean not null default false,
  marked_unread boolean not null default false,
  folder_id uuid references public.chat_folders(id) on delete set null,
  primary key (user_id, kind, conversation_id)
);
create index chat_settings_conversation on public.chat_settings (kind, conversation_id);
-- One row per pair (low < high). requested_by sent the request.
create table public.chat_friends (
  low uuid not null references public.accounts(id) on delete cascade,
  high uuid not null references public.accounts(id) on delete cascade,
  requested_by uuid not null,
  status text not null check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (low, high),
  check (low < high),
  check (requested_by in (low, high))
);
create index chat_friends_high on public.chat_friends (high);
create table public.chat_blocks (
  user_id uuid not null references public.accounts(id) on delete cascade,
  blocked_id uuid not null references public.accounts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, blocked_id),
  check (user_id <> blocked_id)
);
create index chat_blocks_blocked on public.chat_blocks (blocked_id);

do $$ declare t text; begin
  foreach t in array array['chat_profiles', 'chat_folders', 'chat_settings', 'chat_friends', 'chat_blocks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
  end loop;
end $$;

-- Settings rows go when their chat goes.
create function public.chat_settings_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chat_settings where kind = tg_argv[0] and conversation_id = old.id;
  return old;
end $$;
create trigger personal_conversations_settings_cleanup after delete on public.personal_conversations
  for each row execute function public.chat_settings_cleanup('personal');
create trigger member_conversations_settings_cleanup after delete on public.member_conversations
  for each row execute function public.chat_settings_cleanup('team');

-- Private bucket for attachments (Supabase only; the local test database has no storage schema).
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('chat-files', 'chat-files', false, 4194304)
    on conflict (id) do nothing;
  end if;
end $$;

-- ————— Helpers —————
create function public.chat_display_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(a.first_name || ' ' || a.last_name), ''), 'Stayblz member') from public.accounts a where a.id = p_user
$$;

create function public.chat_blocked_between(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chat_blocks where (user_id = a and blocked_id = b) or (user_id = b and blocked_id = a))
$$;

-- 'friends' | 'outgoing' | 'incoming' | 'none' (as seen by p_user).
create function public.chat_friend_status(p_user uuid, p_other uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select case when f.status = 'accepted' then 'friends'
                               when f.requested_by = p_user then 'outgoing' else 'incoming' end
                   from public.chat_friends f where f.low = least(p_user, p_other) and f.high = greatest(p_user, p_other)), 'none')
$$;

create or replace function public.chat_message_out(p_user uuid, m jsonb, r jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m ->> 'id',
    'senderId', m ->> 'sender_id',
    'from', m ->> 'sender',
    'body', case when m ->> 'deleted_at' is null then m ->> 'body' else '' end,
    'sentAt', m -> 'sent_at',
    'mine', (m ->> 'sender_id')::uuid = p_user,
    'removed', m ->> 'deleted_at' is not null,
    'edited', m ->> 'edited_at' is not null,
    'forwarded', coalesce((m ->> 'forwarded')::boolean, false),
    'system', coalesce((m ->> 'system')::boolean, false),
    'pinned', m ->> 'pinned_at' is not null,
    'attachment', case when m ->> 'deleted_at' is null and jsonb_typeof(m -> 'attachment') = 'object'
                       then (m -> 'attachment') - 'path' end,
    'reactions', coalesce((
      select jsonb_agg(jsonb_build_object('emoji', e, 'count', n, 'mine', mine) order by n desc, e)
      from (select value #>> '{}' as e, count(*) as n, bool_or(key = p_user::text) as mine
            from jsonb_each(coalesce(m -> 'reactions', '{}')) group by 1) x), '[]'),
    'replyTo', case when r is null then null else jsonb_build_object(
      'id', r ->> 'id', 'from', r ->> 'sender', 'removed', r ->> 'deleted_at' is not null,
      'attachment', case when r ->> 'deleted_at' is null then r -> 'attachment' ->> 'name' end,
      'body', case when r ->> 'deleted_at' is null then left(r ->> 'body', 160) else '' end) end)
$$;

drop function public.chat_preview(text, uuid, jsonb, jsonb);
create function public.chat_preview(p_kind text, p_user uuid, c jsonb, names jsonb, s jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  me text := p_user::text;
  requested jsonb := coalesce(c -> 'requested_ids', '[]');
  others text[];
  other_ids text[];
  last_read timestamptz := (c -> 'reads' ->> me)::timestamptz;
  last_at timestamptz := (c ->> 'last_message_at')::timestamptz;
  last_sender text := c ->> 'last_sender_id';
  archived_at timestamptz := (s ->> 'archived_at')::timestamptz;
  status text;
begin
  select coalesce(array_agg(coalesce(names ->> u, case when p_kind = 'personal' then 'Stayblz member' else 'Former teammate' end)
                            order by ord), '{}'),
         coalesce(array_agg(u order by ord), '{}')
    into others, other_ids
  from jsonb_array_elements_text(c -> 'member_ids') with ordinality t(u, ord) where u <> me;
  if last_sender = me then
    status := case
      when exists (select 1 from unnest(other_ids) u where (c -> 'reads' ->> u)::timestamptz >= last_at) then 'seen'
      when exists (select 1 from unnest(other_ids) u where (c -> 'delivered' ->> u)::timestamptz >= last_at) then 'delivered'
      else 'sent' end;
  end if;
  return jsonb_build_object(
    'id', c ->> 'id',
    'kind', c ->> 'kind',
    'title', case when c ->> 'kind' = 'direct' and cardinality(others) > 0 then others[1] else c ->> 'title' end,
    'participants', to_jsonb(others),
    'otherId', case when c ->> 'kind' = 'direct' then other_ids[1] end,
    'createdBy', c ->> 'created_by',
    'lastMessage', c ->> 'last_message',
    'lastMessageMine', coalesce(last_sender = me, false),
    'lastMessageAt', c -> 'last_message_at',
    'lastStatus', status,
    'unread', coalesce((s ->> 'marked_unread')::boolean, false)
              or (last_sender is not null and last_sender <> me and not (requested ? me)
                  and (last_read is null or last_at > last_read)),
    'request', (requested ? me),
    'waiting', jsonb_array_length(requested) > 0 and not (requested ? me),
    'canInvite', p_kind = 'personal' and c ->> 'kind' = 'group' and c ->> 'created_by' = me,
    'pinned', s ->> 'pinned_at' is not null,
    'pinnedAt', s -> 'pinned_at',
    'archived', archived_at is not null and archived_at >= last_at,
    'muted', coalesce((s ->> 'muted')::boolean, false),
    'folderId', s ->> 'folder_id');
end $$;

create or replace function public.chat_list(p_kind text, p_user uuid, p_stable uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare names jsonb;
begin
  if p_kind = 'personal' then
    return coalesce((select jsonb_agg(public.chat_preview('personal', p_user, to_jsonb(c), c.member_names, to_jsonb(s))
                                      order by c.last_message_at desc, c.id)
      from (select * from public.personal_conversations
            where member_ids @> array[p_user] and not (requested_ids @> array[p_user] and last_sender_id is null)) c
      left join public.chat_settings s on s.user_id = p_user and s.kind = 'personal' and s.conversation_id = c.id
      where c.id in (select x.id from public.personal_conversations x
                     left join public.chat_settings y on y.user_id = p_user and y.kind = 'personal' and y.conversation_id = x.id
                     where x.member_ids @> array[p_user]
                     order by (y.pinned_at is not null) desc, x.last_message_at desc limit 150)), '[]');
  elsif p_kind = 'team' then
    names := public.chat_names('team', p_stable, null);
    return coalesce((select jsonb_agg(public.chat_preview('team', p_user, to_jsonb(c), names, to_jsonb(s))
                                      order by c.last_message_at desc, c.id)
      from (select * from public.member_conversations where stable_id = p_stable and member_ids @> array[p_user]) c
      left join public.chat_settings s on s.user_id = p_user and s.kind = 'team' and s.conversation_id = c.id
      where c.id in (select x.id from public.member_conversations x
                     left join public.chat_settings y on y.user_id = p_user and y.kind = 'team' and y.conversation_id = x.id
                     where x.stable_id = p_stable and x.member_ids @> array[p_user]
                     order by (y.pinned_at is not null) desc, x.last_message_at desc limit 150)), '[]');
  end if;
  raise exception 'invalid_kind';
end $$;

create or replace function public.chat_thread(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
  p_before_time timestamptz, p_before_id uuid, p_since timestamptz, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  s jsonb;
  names jsonb;
  requested jsonb;
  members jsonb;
  reads jsonb;
  delivered jsonb;
  pins jsonb;
  msgs jsonb;
  cursor text;
  other uuid;
  direct jsonb := null;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if c is null then raise exception 'not_found'; end if;
  select to_jsonb(x) into s from public.chat_settings x where x.user_id = p_user and x.kind = p_kind and x.conversation_id = p_conversation;
  names := public.chat_names(p_kind, p_stable, c);
  requested := coalesce(c -> 'requested_ids', '[]');
  select coalesce(jsonb_agg(jsonb_build_object('id', u, 'me', u = p_user::text, 'pending', (requested ? u),
           'admin', u = c ->> 'created_by',
           'showActive', coalesce((select pr.show_active from public.chat_profiles pr where pr.user_id = u::uuid), true),
           'name', coalesce(names ->> u, case when p_kind = 'personal' then 'Stayblz member' else 'Former teammate' end))
           order by ord), '[]'),
         coalesce(jsonb_agg(jsonb_build_object('id', u, 'name', coalesce(names ->> u, 'Member'), 'at', c -> 'reads' -> u)
           order by ord) filter (where u <> p_user::text and not (requested ? u) and ((c -> 'reads') ? u)), '[]'),
         coalesce(jsonb_agg(jsonb_build_object('id', u, 'at', c -> 'delivered' -> u)
           order by ord) filter (where u <> p_user::text and ((c -> 'delivered') ? u)), '[]')
    into members, reads, delivered
  from jsonb_array_elements_text(c -> 'member_ids') with ordinality x(u, ord);

  if c ->> 'kind' = 'direct' then
    select u::uuid into other from jsonb_array_elements_text(c -> 'member_ids') u where u <> p_user::text limit 1;
    if other is not null then
      direct := jsonb_build_object(
        'friend', case when p_kind = 'personal' then public.chat_friend_status(p_user, other) end,
        'blockedByMe', exists (select 1 from public.chat_blocks b where b.user_id = p_user and b.blocked_id = other),
        'blockedMe', exists (select 1 from public.chat_blocks b where b.user_id = other and b.blocked_id = p_user));
    end if;
  end if;

  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''id'', m.id, ''from'', m.sender, ''body'', left(m.body, 160),
              ''attachment'', m.attachment ->> ''name'', ''pinnedAt'', m.pinned_at) order by m.pinned_at desc), ''[]'')
     from (select * from public.%I where conversation_id = $1 and pinned_at is not null and deleted_at is null
           order by pinned_at desc limit 20) m', t.messages) into pins using p_conversation;

  if p_since is not null then
    execute format(
      'select coalesce(jsonb_agg(public.chat_message_out($3, to_jsonb(m),
                (select to_jsonb(r) from public.%1$I r where r.id = m.reply_to)) order by m.sent_at, m.id), ''[]'')
       from (select * from public.%1$I where conversation_id = $1 and updated_at > $2 - interval ''10 seconds''
             order by updated_at limit 200) m', t.messages)
      into msgs using p_conversation, p_since, p_user;
  else
    execute format(
      'with page as (
         select *, row_number() over (order by sent_at desc, id desc) as rn from public.%1$I
         where conversation_id = $1 and ($2::timestamptz is null or (sent_at, id) < ($2, $3))
         order by sent_at desc, id desc limit $4 + 1)
       select coalesce(jsonb_agg(public.chat_message_out($5, to_jsonb(m) - ''rn'',
                (select to_jsonb(r) from public.%1$I r where r.id = m.reply_to)) order by m.sent_at, m.id)
                filter (where m.rn <= $4), ''[]''),
              case when count(*) > $4 then max((to_jsonb(m.sent_at) #>> ''{}'') || ''|'' || m.id) filter (where m.rn = $4) end
       from page m', t.messages)
      into msgs, cursor using p_conversation, p_before_time, p_before_id, lim, p_user;
  end if;

  return jsonb_build_object(
    'conversation', public.chat_preview(p_kind, p_user, c, names, s)
      || jsonb_build_object('members', members, 'reads', reads, 'delivered', delivered, 'pinnedMessages', pins,
                            'direct', direct, 'messages', msgs),
    'before', cursor,
    'now', to_jsonb(now()));
end $$;

-- A line like "Ann added Bob" in the chat, sent as the person who did it.
create function public.chat_system_line(p_kind text, p_conversation uuid, p_user uuid, p_display text, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare t record := public.chat_tables(p_kind); sent timestamptz;
begin
  execute format('insert into public.%I (conversation_id, sender_id, sender, body, client_id, system)
                  values ($1, $2, $3, $4, gen_random_uuid(), true) returning sent_at', t.messages)
    into sent using p_conversation, p_user, p_display, left(p_text, 4000);
  execute format('update public.%I set last_message = left($2, 200), last_message_at = $3, last_sender_id = $4,
                    reads = reads || jsonb_build_object($4::text, $3) where id = $1', t.conversations)
    using p_conversation, p_text, sent, p_user;
end $$;

-- Attachments must be a file this backend stored for this chat (when forwarding: for a chat of the same kind).
create function public.chat_attachment_ok(p_kind text, p_conversation uuid, a jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select a is null or (
    jsonb_typeof(a) = 'object'
    and a ->> 'path' like p_kind || '/' || coalesce(p_conversation::text, '%') || '/%'
    and length(coalesce(a ->> 'name', '')) between 1 and 120
    and (a ->> 'size') ~ '^[0-9]{1,8}$' and (a ->> 'size')::bigint between 1 and 4194304
    and a ->> 'type' in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'))
$$;

drop function public.chat_send(text, uuid, uuid, uuid, text, text, uuid, uuid);
create function public.chat_send(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
  p_display text, p_body text, p_client uuid, p_reply uuid,
  p_attachment jsonb default null, p_forwarded boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb;
  display text := p_display;
  reply_id uuid;
  result jsonb;
  reply jsonb;
  preview text;
begin
  if p_kind = 'team' then
    select s.display_name into display from public.stable_memberships s
    where s.stable_id = p_stable and s.user_id = p_user for share;
    if not found then raise exception 'not_a_participant'; end if;
    select to_jsonb(x) into c from public.member_conversations x
    where x.id = p_conversation and x.stable_id = p_stable and x.member_ids @> array[p_user] for update;
  else
    select to_jsonb(x) into c from public.personal_conversations x
    where x.id = p_conversation and x.member_ids @> array[p_user] for update;
  end if;
  if c is null then raise exception 'not_a_participant'; end if;
  if coalesce(c -> 'requested_ids', '[]') ? p_user::text then raise exception 'request_pending'; end if;
  -- Same client id = the same message (a retry after a lost response): return it whatever was sent.
  execute format('select to_jsonb(m) from public.%I m where conversation_id = $1 and sender_id = $2 and client_id = $3',
                 t.messages) into result using p_conversation, p_user, p_client;
  if result is null then
    if c ->> 'kind' = 'direct' and exists (
         select 1 from jsonb_array_elements_text(c -> 'member_ids') u
         where u <> p_user::text and public.chat_blocked_between(p_user, u::uuid)) then
      raise exception 'blocked';
    end if;
    if not public.chat_attachment_ok(p_kind, case when p_forwarded then null else p_conversation end, p_attachment) then
      raise exception 'invalid_attachment';
    end if;
    if length(coalesce(p_body, '')) > 4000 or (length(btrim(coalesce(p_body, ''))) = 0 and p_attachment is null) then
      raise exception 'invalid_message';
    end if;
    display := coalesce(nullif(btrim(display), ''), 'Member');
    if p_reply is not null then
      execute format('select id from public.%I where id = $1 and conversation_id = $2', t.messages)
        into reply_id using p_reply, p_conversation;
    end if;
    execute format('insert into public.%I as m (conversation_id, sender_id, sender, body, client_id, reply_to, attachment, forwarded)
                    values ($1, $2, $3, btrim($4), $5, $6, $7, $8) returning to_jsonb(m.*)', t.messages)
      into result using p_conversation, p_user, display, coalesce(p_body, ''), p_client, reply_id, p_attachment,
                        coalesce(p_forwarded, false);
    preview := case
      when result ->> 'body' <> '' then result ->> 'body'
      when p_attachment ->> 'type' like 'image/%' then '📷 Photo'
      else '📎 ' || (p_attachment ->> 'name') end;
    execute format('update public.%I set last_message = left($2, 200), last_message_at = $3, last_sender_id = $4,
                      reads = reads || jsonb_build_object($4::text, $3),
                      delivered = delivered || jsonb_build_object($4::text, $3)%s where id = $1',
                   t.conversations,
                   case when p_kind = 'personal' then ', member_names = member_names || jsonb_build_object($4::text, $5::text)' else '' end)
      using p_conversation, preview, (result ->> 'sent_at')::timestamptz, p_user, display;
  end if;
  if result ->> 'reply_to' is not null then
    execute format('select to_jsonb(r) from public.%I r where r.id = $1', t.messages)
      into reply using (result ->> 'reply_to')::uuid;
  end if;
  return public.chat_message_out(p_user, result, reply);
end $$;

-- Reactions: any single emoji from the picker (1–16 characters, no letters, digits, spaces or markup).
-- Picking the same emoji again (or '') removes yours. System lines and unsent messages can't be reacted to.
create or replace function public.chat_react(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
  p_message uuid, p_emoji text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  result jsonb;
  reply jsonb;
begin
  if c is null then raise exception 'not_found'; end if;
  if coalesce(c -> 'requested_ids', '[]') ? p_user::text then raise exception 'request_pending'; end if;
  if coalesce(p_emoji, '') <> '' and (char_length(p_emoji) > 16 or p_emoji ~ '[[:alnum:][:space:]<>&"''`\\]') then
    raise exception 'invalid_reaction';
  end if;
  execute format(
    'update public.%I as m set updated_at = now(),
       reactions = case when $3 = '''' or m.reactions ->> $2 = $3 then m.reactions - $2 else m.reactions || jsonb_build_object($2, $3) end
     where m.id = $1 and m.conversation_id = $4 and m.deleted_at is null and not m.system returning to_jsonb(m.*)', t.messages)
    into result using p_message, p_user::text, coalesce(p_emoji, ''), p_conversation;
  if result is null then raise exception 'not_found'; end if;
  if result ->> 'reply_to' is not null then
    execute format('select to_jsonb(r) from public.%I r where r.id = $1', t.messages)
      into reply using (result ->> 'reply_to')::uuid;
  end if;
  return public.chat_message_out(p_user, result, reply);
end $$;

-- Edit your own text message within 15 minutes of sending it.
create function public.chat_edit(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_message uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  old jsonb;
  result jsonb;
  reply jsonb;
begin
  if c is null then raise exception 'not_found'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid_message'; end if;
  execute format('select to_jsonb(m) from public.%I m where m.id = $1 and m.conversation_id = $2 and m.sender_id = $3 for update',
                 t.messages) into old using p_message, p_conversation, p_user;
  if old is null or old ->> 'deleted_at' is not null or coalesce((old ->> 'system')::boolean, false) then raise exception 'not_found'; end if;
  if old -> 'attachment' is not null and jsonb_typeof(old -> 'attachment') = 'object' then raise exception 'not_editable'; end if;
  if (old ->> 'sent_at')::timestamptz < now() - interval '15 minutes' then raise exception 'edit_window'; end if;
  execute format('update public.%I as m set body = btrim($2), edited_at = now(), updated_at = now()
                  where m.id = $1 returning to_jsonb(m.*)', t.messages) into result using p_message, p_body;
  execute format('update public.%I set last_message = left(btrim($2), 200) where id = $1 and last_message_at = $3 and last_sender_id = $4',
                 t.conversations) using p_conversation, p_body, (old ->> 'sent_at')::timestamptz, p_user;
  if result ->> 'reply_to' is not null then
    execute format('select to_jsonb(r) from public.%I r where r.id = $1', t.messages) into reply using (result ->> 'reply_to')::uuid;
  end if;
  return public.chat_message_out(p_user, result, reply);
end $$;

-- Pin or unpin a message for everyone in the chat (up to 20 pinned).
create function public.chat_pin(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_message uuid, p_pin boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  pinned integer;
  result jsonb;
begin
  if c is null then raise exception 'not_found'; end if;
  if coalesce(c -> 'requested_ids', '[]') ? p_user::text then raise exception 'request_pending'; end if;
  if p_pin then
    execute format('select count(*) from public.%I where conversation_id = $1 and pinned_at is not null', t.messages)
      into pinned using p_conversation;
    if pinned >= 20 then raise exception 'pin_limit'; end if;
  end if;
  execute format('update public.%I as m set pinned_at = case when $3 then coalesce(m.pinned_at, now()) end,
                    pinned_by = case when $3 then $4 end, updated_at = now()
                  where m.id = $1 and m.conversation_id = $2 and m.deleted_at is null and not m.system returning to_jsonb(m.*)',
                 t.messages) into result using p_message, p_conversation, p_pin, p_user;
  if result is null then raise exception 'not_found'; end if;
  return public.chat_message_out(p_user, result, null);
end $$;

-- Unsend: erase text and attachment for everyone. Returns the storage path to delete when no other message uses it.
drop function public.chat_unsend(text, uuid, uuid, uuid, uuid);
create function public.chat_unsend(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  old jsonb;
  result jsonb;
  path text;
  used boolean;
begin
  if c is null then raise exception 'not_found'; end if;
  execute format('select to_jsonb(m) from public.%I m where m.id = $1 and m.conversation_id = $2 and m.sender_id = $3 and not m.system for update',
                 t.messages) into old using p_message, p_conversation, p_user;
  if old is null then raise exception 'not_found'; end if;
  if old ->> 'deleted_at' is not null then
    return jsonb_build_object('message', public.chat_message_out(p_user, old, null), 'removePath', null);
  end if;
  path := old -> 'attachment' ->> 'path';
  execute format(
    'update public.%I as m set body = '''', attachment = null, deleted_at = now(), reactions = ''{}'', pinned_at = null,
       pinned_by = null, updated_at = now() where m.id = $1 returning to_jsonb(m.*)', t.messages)
    into result using p_message;
  -- Quotes of it refresh on the next poll; the chat list stops showing its text.
  execute format('update public.%I set updated_at = now() where conversation_id = $2 and reply_to = $1', t.messages)
    using p_message, p_conversation;
  execute format('update public.%I set last_message = ''Message unsent'' where id = $1 and last_message_at = $2 and last_sender_id = $3',
                 t.conversations) using p_conversation, (result ->> 'sent_at')::timestamptz, p_user;
  if path is not null then
    used := exists (select 1 from public.personal_messages where attachment ->> 'path' = path)
         or exists (select 1 from public.member_messages where attachment ->> 'path' = path);
    if used then path := null; end if;
  end if;
  return jsonb_build_object('message', public.chat_message_out(p_user, result, null), 'removePath', path);
end $$;

-- Mark read: also clears "marked as unread" and counts as delivered.
create or replace function public.chat_read(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare ok boolean;
begin
  if p_kind = 'personal' then
    update public.personal_conversations set reads = reads || jsonb_build_object(p_user::text, now()),
      delivered = delivered || jsonb_build_object(p_user::text, now())
    where id = p_conversation and member_ids @> array[p_user] and not requested_ids @> array[p_user];
  elsif p_kind = 'team' then
    update public.member_conversations set reads = reads || jsonb_build_object(p_user::text, now()),
      delivered = delivered || jsonb_build_object(p_user::text, now())
    where id = p_conversation and stable_id = p_stable and member_ids @> array[p_user];
  else raise exception 'invalid_kind'; end if;
  ok := found;
  update public.chat_settings set marked_unread = false
  where user_id = p_user and kind = p_kind and conversation_id = p_conversation and marked_unread;
  return ok;
end $$;

-- "Delivered": this person's device has fetched the newest message. Called by the menu badge poll; only
-- writes when something new arrived.
create function public.chat_mark_delivered(p_user uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; m integer;
begin
  update public.personal_conversations set delivered = delivered || jsonb_build_object(p_user::text, now())
  where member_ids @> array[p_user] and last_sender_id is not null and last_sender_id <> p_user
    and (delivered ->> p_user::text is null or last_message_at > (delivered ->> p_user::text)::timestamptz);
  get diagnostics n = row_count;
  update public.member_conversations c set delivered = c.delivered || jsonb_build_object(p_user::text, now())
  where c.member_ids @> array[p_user] and c.last_sender_id is not null and c.last_sender_id <> p_user
    and (c.delivered ->> p_user::text is null or c.last_message_at > (c.delivered ->> p_user::text)::timestamptz)
    and exists (select 1 from public.stable_memberships s where s.stable_id = c.stable_id and s.user_id = p_user);
  get diagnostics m = row_count;
  return n + m;
end $$;

create or replace function public.chat_unread(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'personal', (select count(*) from public.personal_conversations c
      left join public.chat_settings s on s.user_id = p_user and s.kind = 'personal' and s.conversation_id = c.id
      where c.member_ids @> array[p_user] and not c.requested_ids @> array[p_user] and not coalesce(s.muted, false)
        and (coalesce(s.marked_unread, false) or (c.last_sender_id <> p_user
          and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)))),
    'requests', (select count(*) from public.personal_conversations c
      where c.requested_ids @> array[p_user] and c.last_sender_id is not null),
    'team', (select count(*) from public.member_conversations c
      join public.stable_memberships m on m.stable_id = c.stable_id and m.user_id = p_user
      left join public.chat_settings s on s.user_id = p_user and s.kind = 'team' and s.conversation_id = c.id
      where c.member_ids @> array[p_user] and not coalesce(s.muted, false)
        and (coalesce(s.marked_unread, false) or (c.last_sender_id <> p_user
          and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)))))
$$;

-- Your own settings for one chat: pinned / archived / muted / unread / folder.
create function public.chat_settings_set(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  folder uuid;
  pinned integer;
  result jsonb;
begin
  if c is null then raise exception 'not_found'; end if;
  if jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_settings'; end if;
  if p_changes ? 'folder' and p_changes ->> 'folder' is not null then
    select id into folder from public.chat_folders where id = (p_changes ->> 'folder')::uuid and user_id = p_user;
    if folder is null then raise exception 'invalid_folder'; end if;
  end if;
  if coalesce((p_changes ->> 'pinned')::boolean, false) then
    select count(*) into pinned from public.chat_settings
    where user_id = p_user and kind = p_kind and pinned_at is not null and conversation_id <> p_conversation;
    if pinned >= 20 then raise exception 'pin_limit'; end if;
  end if;
  insert into public.chat_settings (user_id, kind, conversation_id) values (p_user, p_kind, p_conversation)
  on conflict do nothing;
  update public.chat_settings x set
    pinned_at = case when not p_changes ? 'pinned' then x.pinned_at
                     when (p_changes ->> 'pinned')::boolean then coalesce(x.pinned_at, now()) end,
    archived_at = case when not p_changes ? 'archived' then x.archived_at
                       when (p_changes ->> 'archived')::boolean then now() end,
    muted = case when p_changes ? 'muted' then (p_changes ->> 'muted')::boolean else x.muted end,
    marked_unread = case when p_changes ? 'unread' then (p_changes ->> 'unread')::boolean else x.marked_unread end,
    folder_id = case when p_changes ? 'folder' then folder else x.folder_id end
  where x.user_id = p_user and x.kind = p_kind and x.conversation_id = p_conversation
  returning jsonb_build_object('pinned', x.pinned_at is not null, 'archived', x.archived_at is not null,
                               'muted', x.muted, 'unread', x.marked_unread, 'folderId', x.folder_id) into result;
  return result;
end $$;

create function public.chat_search(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  q text := btrim(coalesce(p_query, ''));
  result jsonb;
begin
  if public.chat_get(p_kind, p_user, p_stable, p_conversation) is null then raise exception 'not_found'; end if;
  if length(q) not between 2 and 100 then raise exception 'invalid_query'; end if;
  q := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  execute format(
    'select coalesce(jsonb_agg(public.chat_message_out($2, to_jsonb(m), null) order by m.sent_at desc), ''[]'')
     from (select * from public.%I where conversation_id = $1 and deleted_at is null and not system
           and (body ilike $3 escape ''\'' or attachment ->> ''name'' ilike $3 escape ''\'')
           order by sent_at desc limit 30) m', t.messages)
    into result using p_conversation, p_user, q;
  return result;
end $$;

create function public.chat_media(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t record := public.chat_tables(p_kind); result jsonb;
begin
  if public.chat_get(p_kind, p_user, p_stable, p_conversation) is null then raise exception 'not_found'; end if;
  execute format(
    'select coalesce(jsonb_agg(public.chat_message_out($2, to_jsonb(m), null) order by m.sent_at desc), ''[]'')
     from (select * from public.%I where conversation_id = $1 and deleted_at is null and attachment is not null
           order by sent_at desc limit 60) m', t.messages)
    into result using p_conversation, p_user;
  return result;
end $$;

-- The stored file for one message (with its storage path), only for members of the chat.
create function public.chat_attachment(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_message uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t record := public.chat_tables(p_kind); result jsonb;
begin
  if public.chat_get(p_kind, p_user, p_stable, p_conversation) is null then raise exception 'not_found'; end if;
  execute format('select attachment from public.%I where id = $1 and conversation_id = $2 and deleted_at is null', t.messages)
    into result using p_message, p_conversation;
  if result is null then raise exception 'not_found'; end if;
  return result;
end $$;

-- Bytes of attachments this person has uploaded and not unsent (forwards don't count twice).
create function public.chat_quota(p_user uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum((attachment ->> 'size')::bigint) from public.personal_messages
                   where sender_id = p_user and attachment is not null and not forwarded and deleted_at is null), 0)
       + coalesce((select sum((attachment ->> 'size')::bigint) from public.member_messages
                   where sender_id = p_user and attachment is not null and not forwarded and deleted_at is null), 0)
$$;

-- Forward one message into another chat of the same kind (team: same stable). The file is shared, not copied.
create function public.chat_forward(p_kind text, p_user uuid, p_stable uuid, p_from uuid, p_message uuid,
  p_to uuid, p_display text, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t record := public.chat_tables(p_kind); src jsonb; a jsonb;
begin
  if public.chat_get(p_kind, p_user, p_stable, p_from) is null then raise exception 'not_found'; end if;
  execute format('select to_jsonb(m) from public.%I m where m.id = $1 and m.conversation_id = $2 and m.deleted_at is null and not m.system',
                 t.messages) into src using p_message, p_from;
  if src is null then raise exception 'not_found'; end if;
  a := case when jsonb_typeof(src -> 'attachment') = 'object' then src -> 'attachment' end;
  return public.chat_send(p_kind, p_user, p_stable, p_to, p_display, src ->> 'body', p_client, null, a, true);
end $$;

create function public.chat_rename(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_display text, p_title text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare t record := public.chat_tables(p_kind); c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
begin
  if c is null then raise exception 'not_found'; end if;
  if c ->> 'kind' <> 'group' then raise exception 'not_group'; end if;
  if coalesce(c -> 'requested_ids', '[]') ? p_user::text then raise exception 'request_pending'; end if;
  if length(btrim(coalesce(p_title, ''))) not between 1 and 120 then raise exception 'invalid_title'; end if;
  execute format('update public.%I set title = btrim($2) where id = $1', t.conversations) using p_conversation, p_title;
  perform public.chat_system_line(p_kind, p_conversation, p_user, p_display, p_display || ' named the group ' || btrim(p_title));
  return true;
end $$;

-- Add people to a group. Personal: active accounts that haven't blocked you (or you them). Team: stable members.
create function public.chat_add_members(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_display text, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  ids uuid[];
  added text[];
begin
  if c is null then raise exception 'not_found'; end if;
  if c ->> 'kind' <> 'group' then raise exception 'not_group'; end if;
  if coalesce(c -> 'requested_ids', '[]') ? p_user::text then raise exception 'request_pending'; end if;
  select coalesce(array_agg(distinct v), '{}') into ids from unnest(coalesce(p_ids, '{}')) v
  where not (c -> 'member_ids') ? v::text;
  if cardinality(ids) = 0 then return 0; end if;
  if jsonb_array_length(c -> 'member_ids') + cardinality(ids) > 30 then raise exception 'conversation_full'; end if;
  if p_kind = 'personal' then
    if exists (select 1 from unnest(ids) v where not exists (select 1 from public.accounts a where a.id = v and a.status = 'active')
               or public.chat_blocked_between(p_user, v)) then
      raise exception 'invalid_participants';
    end if;
    update public.personal_conversations set member_ids = member_ids || ids,
      member_names = member_names || (select jsonb_object_agg(v::text, public.chat_display_name(v)) from unnest(ids) v)
    where id = p_conversation;
    select array_agg(public.chat_display_name(v)) into added from unnest(ids) v;
  else
    if exists (select 1 from unnest(ids) v where not exists (
                 select 1 from public.stable_memberships s where s.stable_id = p_stable and s.user_id = v)) then
      raise exception 'invalid_participants';
    end if;
    update public.member_conversations set member_ids = member_ids || ids where id = p_conversation;
    select array_agg(s.display_name) into added from public.stable_memberships s where s.stable_id = p_stable and s.user_id = any (ids);
  end if;
  perform public.chat_system_line(p_kind, p_conversation, p_user, p_display, p_display || ' added ' || array_to_string(added, ', '));
  return cardinality(ids);
end $$;

-- The group's creator can remove someone.
create function public.chat_remove_member(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_display text, p_target uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation); who text;
begin
  if c is null then raise exception 'not_found'; end if;
  if c ->> 'kind' <> 'group' then raise exception 'not_group'; end if;
  if c ->> 'created_by' <> p_user::text then raise exception 'not_admin'; end if;
  if p_target = p_user or not (c -> 'member_ids') ? p_target::text then raise exception 'invalid_participants'; end if;
  who := coalesce(public.chat_names(p_kind, p_stable, c) ->> p_target::text, 'a member');
  if p_kind = 'personal' then
    update public.personal_conversations set member_ids = array_remove(member_ids, p_target),
      requested_ids = array_remove(requested_ids, p_target), reads = reads - p_target::text where id = p_conversation;
  else
    update public.member_conversations set member_ids = array_remove(member_ids, p_target), reads = reads - p_target::text
    where id = p_conversation;
  end if;
  delete from public.chat_settings where user_id = p_target and kind = p_kind and conversation_id = p_conversation;
  perform public.chat_system_line(p_kind, p_conversation, p_user, p_display, p_display || ' removed ' || who);
  return true;
end $$;

-- Leave a chat (also "Delete" on a request). The last person out removes it; returns the files to delete then.
drop function public.chat_leave(text, uuid, uuid, uuid);
create function public.chat_leave(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_display text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  paths jsonb := '[]';
begin
  if c is null then raise exception 'not_found'; end if;
  if jsonb_array_length(c -> 'member_ids') <= 1 then
    execute format(
      'select coalesce(jsonb_agg(distinct attachment ->> ''path''), ''[]'') from public.%I m
       where conversation_id = $1 and attachment is not null and not exists (
         select 1 from public.personal_messages o where o.attachment ->> ''path'' = m.attachment ->> ''path'' and o.conversation_id <> $1)
       and not exists (
         select 1 from public.member_messages o where o.attachment ->> ''path'' = m.attachment ->> ''path'' and o.conversation_id <> $1)',
      t.messages) into paths using p_conversation;
    execute format('delete from public.%I where id = $1', t.conversations) using p_conversation;
    return jsonb_build_object('deleted', true, 'removePaths', paths);
  end if;
  if p_kind = 'personal' then
    update public.personal_conversations set member_ids = array_remove(member_ids, p_user),
      requested_ids = array_remove(requested_ids, p_user), reads = reads - p_user::text where id = p_conversation;
  else
    update public.member_conversations set member_ids = array_remove(member_ids, p_user), reads = reads - p_user::text
    where id = p_conversation;
  end if;
  delete from public.chat_settings where user_id = p_user and kind = p_kind and conversation_id = p_conversation;
  if c ->> 'kind' = 'group' and p_display is not null then
    perform public.chat_system_line(p_kind, p_conversation, p_user, p_display, p_display || ' left the group');
  end if;
  return jsonb_build_object('deleted', false, 'removePaths', '[]'::jsonb);
end $$;

-- ————— People: search, friends, blocks, privacy —————
create function public.chat_profile_get(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('discoverable', coalesce(p.discoverable, true), 'showActive', coalesce(p.show_active, true),
                            'storageUsed', public.chat_quota(p_user))
  from (select 1) x left join public.chat_profiles p on p.user_id = p_user
$$;

create function public.chat_profile_set(p_user uuid, p_discoverable boolean, p_show_active boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.chat_profiles (user_id, discoverable, show_active, updated_at)
  values (p_user, coalesce(p_discoverable, true), coalesce(p_show_active, true), now())
  on conflict (user_id) do update set discoverable = coalesce(p_discoverable, chat_profiles.discoverable),
    show_active = coalesce(p_show_active, chat_profiles.show_active), updated_at = now();
  return public.chat_profile_get(p_user);
end $$;

-- Find members by name. Hidden people (discoverable off) only show to their friends. Blocks hide both ways.
create function public.chat_people_search(p_user uuid, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare q text := btrim(coalesce(p_query, '')); result jsonb;
begin
  if length(q) not between 2 and 60 then raise exception 'invalid_query'; end if;
  q := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'role', x.role, 'status', x.status)
                            order by x.status = 'friends' desc, x.name), '[]')
    into result
  from (select y.* from (
          select a.id, btrim(a.first_name || ' ' || a.last_name) as name, a.racing_role as role,
                 public.chat_friend_status(p_user, a.id) as status, coalesce(p.discoverable, true) as discoverable
          from public.accounts a left join public.chat_profiles p on p.user_id = a.id
          where a.id <> p_user and a.status = 'active' and btrim(a.first_name || ' ' || a.last_name) <> ''
            and (a.first_name || ' ' || a.last_name) ilike q escape '\'
            and not public.chat_blocked_between(p_user, a.id)) y
        where y.discoverable or y.status <> 'none'
        order by y.status = 'friends' desc, y.name limit 20) x;
  return result;
end $$;

create function public.chat_friends(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'friends', coalesce(jsonb_agg(p order by p ->> 'name') filter (where p ->> 'status' = 'friends'), '[]'),
    'incoming', coalesce(jsonb_agg(p order by p ->> 'name') filter (where p ->> 'status' = 'incoming'), '[]'),
    'outgoing', coalesce(jsonb_agg(p order by p ->> 'name') filter (where p ->> 'status' = 'outgoing'), '[]'))
  from (select jsonb_build_object('id', o.id, 'name', public.chat_display_name(o.id), 'role', a.racing_role,
                 'status', case when f.status = 'accepted' then 'friends' when f.requested_by = p_user then 'outgoing' else 'incoming' end) as p
        from public.chat_friends f
        cross join lateral (select case when f.low = p_user then f.high else f.low end as id) o
        join public.accounts a on a.id = o.id and a.status = 'active'
        where p_user in (f.low, f.high)
        order by public.chat_display_name(o.id)) x
$$;

-- Send a friend request, or accept theirs if they already asked. Returns the new status.
create function public.chat_friend_request(p_user uuid, p_other uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare current text;
begin
  if p_other = p_user or not exists (select 1 from public.accounts where id = p_other and status = 'active') then
    raise exception 'invalid_person';
  end if;
  if public.chat_blocked_between(p_user, p_other) then raise exception 'blocked'; end if;
  current := public.chat_friend_status(p_user, p_other);
  if current = 'incoming' then return public.chat_friend_respond(p_user, p_other, true); end if;
  if current <> 'none' then return current; end if;
  insert into public.chat_friends (low, high, requested_by, status)
  values (least(p_user, p_other), greatest(p_user, p_other), p_user, 'pending');
  return 'outgoing';
end $$;

create function public.chat_friend_respond(p_user uuid, p_other uuid, p_accept boolean) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if p_accept then
    update public.chat_friends set status = 'accepted', accepted_at = now()
    where low = least(p_user, p_other) and high = greatest(p_user, p_other) and status = 'pending' and requested_by = p_other;
    if not found then raise exception 'not_found'; end if;
    -- Friends skip message requests with each other.
    update public.personal_conversations set requested_ids = array_remove(array_remove(requested_ids, p_user), p_other)
    where kind = 'direct' and member_ids @> array[p_user, p_other] and cardinality(member_ids) = 2;
    return 'friends';
  end if;
  delete from public.chat_friends
  where low = least(p_user, p_other) and high = greatest(p_user, p_other) and status = 'pending' and requested_by = p_other;
  return 'none';
end $$;

-- Unfriend, or cancel a request you sent.
create function public.chat_friend_remove(p_user uuid, p_other uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chat_friends where low = least(p_user, p_other) and high = greatest(p_user, p_other);
  return 'none';
end $$;

create function public.chat_block_set(p_user uuid, p_other uuid, p_block boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_other = p_user then raise exception 'invalid_person'; end if;
  if p_block then
    if not exists (select 1 from public.accounts where id = p_other) then raise exception 'invalid_person'; end if;
    insert into public.chat_blocks (user_id, blocked_id) values (p_user, p_other) on conflict do nothing;
    delete from public.chat_friends where low = least(p_user, p_other) and high = greatest(p_user, p_other);
  else
    delete from public.chat_blocks where user_id = p_user and blocked_id = p_other;
  end if;
  return p_block;
end $$;

create function public.chat_blocks_list(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', b.blocked_id, 'name', public.chat_display_name(b.blocked_id))
                            order by b.created_at desc), '[]')
  from public.chat_blocks b where b.user_id = p_user
$$;

-- Start (or reopen) a one-to-one chat. Friends go straight to each other's chats; others get a request.
create function public.chat_start_direct_user(p_user uuid, p_display text, p_other uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare other_name text; existing uuid; friends boolean;
begin
  if p_other = p_user then raise exception 'self'; end if;
  if not exists (select 1 from public.accounts a where a.id = p_other and a.status = 'active') then raise exception 'no_account'; end if;
  if public.chat_blocked_between(p_user, p_other) then raise exception 'blocked'; end if;
  friends := public.chat_friend_status(p_user, p_other) = 'friends';
  other_name := public.chat_display_name(p_other);
  select id into existing from public.personal_conversations
  where kind = 'direct' and member_ids @> array[p_user, p_other] and cardinality(member_ids) = 2
  order by last_message_at desc limit 1 for update;
  if existing is not null then
    -- Writing to someone who already wrote to you accepts their request.
    update public.personal_conversations set requested_ids = array_remove(requested_ids, p_user),
      member_names = member_names || jsonb_build_object(p_user::text, p_display) where id = existing;
    return existing;
  end if;
  insert into public.personal_conversations (title, created_by, member_ids, member_names, kind, requested_ids, reads)
  values ('Direct chat', p_user, array[p_user, p_other],
          jsonb_build_object(p_user::text, p_display, p_other::text, other_name),
          'direct', case when friends then '{}'::uuid[] else array[p_other] end, jsonb_build_object(p_user::text, now()))
  returning id into existing;
  return existing;
end $$;

create or replace function public.chat_start_direct(p_user uuid, p_display text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare other uuid;
begin
  select a.id into other from public.accounts a where lower(a.email) = lower(btrim(p_email)) and a.status = 'active' limit 1;
  if other is null then raise exception 'no_account'; end if;
  return public.chat_start_direct_user(p_user, p_display, other);
end $$;

-- Every chat_* function: service role only.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'chat\_%' ) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
