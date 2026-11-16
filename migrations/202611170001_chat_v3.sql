-- Stayblz Chat v3 (builds on 202611120001_chat_v2.sql). LOCAL until a release is approved.
-- Adds: mute for a while (15 min … 24 h) as well as "until I turn it back on"; who reacted (account ids per
-- emoji); the last sender's name and the other members' ids in chat previews (group previews like
-- "Bo: see you there", profile photos in the list); voice clips (audio files, same 4 MB / 50 MB limits);
-- a "Links" list for Chat info; and chat_incoming() — the newest unread message per chat since a time,
-- which the menu poll uses for on-screen notifications.
--
-- Also: video messages, and files up to 25 MB when the server stores them in Cloudflare R2 (the backend decides the
-- real limit: 4 MB on Supabase Storage, 25 MB on R2); and a group photo for group chats.
--
-- Same rules as before: RLS on, no browser grants, service-role-only functions that check membership.

-- ————— Group photos (storage path; the file lives in the chat file store: R2 or Supabase) —————
alter table public.personal_conversations add column if not exists photo text
  check (photo is null or (length(photo) between 10 and 300 and photo like 'group-photos/%'));
alter table public.member_conversations add column if not exists photo text
  check (photo is null or (length(photo) between 10 and 300 and photo like 'group-photos/%'));

-- ————— Mute for a while —————
alter table public.chat_settings add column if not exists muted_until timestamptz;

-- Muted right now: "until I turn it back on", or a timed mute that hasn't run out.
create or replace function public.chat_is_muted(s jsonb) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((s ->> 'muted')::boolean, false)
      or coalesce((s ->> 'muted_until')::timestamptz > now(), false)
$$;

-- ————— Messages: reactions say who (account ids) —————
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
      select jsonb_agg(jsonb_build_object('emoji', e, 'count', n, 'mine', mine, 'ids', ids) order by n desc, e)
      from (select value #>> '{}' as e, count(*) as n, bool_or(key = p_user::text) as mine,
                   jsonb_agg(key order by key) as ids
            from jsonb_each(coalesce(m -> 'reactions', '{}')) group by 1) x), '[]'),
    'replyTo', case when r is null then null else jsonb_build_object(
      'id', r ->> 'id', 'from', r ->> 'sender', 'senderId', r ->> 'sender_id', 'removed', r ->> 'deleted_at' is not null,
      'attachment', case when r ->> 'deleted_at' is null then r -> 'attachment' ->> 'name' end,
      'body', case when r ->> 'deleted_at' is null then left(r ->> 'body', 160) else '' end) end)
$$;

-- ————— Chat previews: last sender's name, other members' ids, timed mute —————
create or replace function public.chat_preview(p_kind text, p_user uuid, c jsonb, names jsonb, s jsonb) returns jsonb
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
  muted_until timestamptz := (s ->> 'muted_until')::timestamptz;
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
    'participantIds', to_jsonb(other_ids),
    'otherId', case when c ->> 'kind' = 'direct' then other_ids[1] end,
    'createdBy', c ->> 'created_by',
    'lastMessage', c ->> 'last_message',
    'lastMessageMine', coalesce(last_sender = me, false),
    'lastSenderId', last_sender,
    'lastSenderName', case when last_sender is null then null
                           else coalesce(names ->> last_sender, case when p_kind = 'personal' then 'Stayblz member' else 'Former teammate' end) end,
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
    'muted', public.chat_is_muted(s),
    'mutedUntil', case when not coalesce((s ->> 'muted')::boolean, false) and muted_until > now() then to_jsonb(muted_until) end,
    -- Group photo version (the last part of its path); the file itself is served to members only.
    'photo', case when c ->> 'kind' = 'group' and c ->> 'photo' is not null
                  then regexp_replace(c ->> 'photo', '^.*/', '') end,
    'folderId', s ->> 'folder_id');
end $$;

-- Set or clear a group's photo (any member of the group). Returns the old path so the backend can delete the file.
create or replace function public.chat_set_photo(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
  p_display text, p_path text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t record := public.chat_tables(p_kind); c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
begin
  if c is null then raise exception 'not_found'; end if;
  if c ->> 'kind' <> 'group' then raise exception 'not_group'; end if;
  if coalesce(c -> 'requested_ids', '[]') ? p_user::text then raise exception 'request_pending'; end if;
  if p_path is not null and (p_path not like 'group-photos/' || p_kind || '/' || p_conversation::text || '/%' or length(p_path) > 300) then
    raise exception 'invalid_attachment';
  end if;
  if p_path is null and c ->> 'photo' is null then
    return jsonb_build_object('old', null);
  end if;
  execute format('update public.%I set photo = $2 where id = $1', t.conversations) using p_conversation, p_path;
  perform public.chat_system_line(p_kind, p_conversation, p_user, p_display,
    p_display || case when p_path is null then ' removed the group photo' else ' changed the group photo' end);
  return jsonb_build_object('old', c ->> 'photo');
end $$;

-- ————— Per-chat settings: mute for N minutes —————
create or replace function public.chat_settings_set(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_changes jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  folder uuid;
  pinned integer;
  minutes integer;
  result jsonb;
begin
  if c is null then raise exception 'not_found'; end if;
  if jsonb_typeof(p_changes) <> 'object' then raise exception 'invalid_settings'; end if;
  if p_changes ? 'folder' and p_changes ->> 'folder' is not null then
    select id into folder from public.chat_folders where id = (p_changes ->> 'folder')::uuid and user_id = p_user;
    if folder is null then raise exception 'invalid_folder'; end if;
  end if;
  if p_changes ? 'muteMinutes' then
    if jsonb_typeof(p_changes -> 'muteMinutes') <> 'number' then raise exception 'invalid_settings'; end if;
    minutes := (p_changes ->> 'muteMinutes')::integer;
    if minutes not between 1 and 10080 then raise exception 'invalid_settings'; end if;
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
    -- "Mute for a while" sets a time; "muted" true/false is the open-ended switch and clears any timer.
    muted = case when minutes is not null then false
                 when p_changes ? 'muted' then (p_changes ->> 'muted')::boolean else x.muted end,
    muted_until = case when minutes is not null then now() + make_interval(mins => minutes)
                       when p_changes ? 'muted' then null else x.muted_until end,
    marked_unread = case when p_changes ? 'unread' then (p_changes ->> 'unread')::boolean else x.marked_unread end,
    folder_id = case when p_changes ? 'folder' then folder else x.folder_id end
  where x.user_id = p_user and x.kind = p_kind and x.conversation_id = p_conversation
  returning jsonb_build_object('pinned', x.pinned_at is not null, 'archived', x.archived_at is not null,
                               'muted', x.muted or coalesce(x.muted_until > now(), false),
                               'mutedUntil', case when not x.muted and x.muted_until > now() then to_jsonb(x.muted_until) end,
                               'unread', x.marked_unread, 'folderId', x.folder_id) into result;
  return result;
end $$;

-- Menu badge counts: a timed mute keeps a chat out of the count until it runs out.
create or replace function public.chat_unread(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'personal', (select count(*) from public.personal_conversations c
      left join public.chat_settings s on s.user_id = p_user and s.kind = 'personal' and s.conversation_id = c.id
      where c.member_ids @> array[p_user] and not c.requested_ids @> array[p_user]
        and not public.chat_is_muted(to_jsonb(s))
        and (coalesce(s.marked_unread, false) or (c.last_sender_id <> p_user
          and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)))),
    'requests', (select count(*) from public.personal_conversations c
      where c.requested_ids @> array[p_user] and c.last_sender_id is not null),
    'team', (select count(*) from public.member_conversations c
      join public.stable_memberships m on m.stable_id = c.stable_id and m.user_id = p_user
      left join public.chat_settings s on s.user_id = p_user and s.kind = 'team' and s.conversation_id = c.id
      where c.member_ids @> array[p_user] and not public.chat_is_muted(to_jsonb(s))
        and (coalesce(s.marked_unread, false) or (c.last_sender_id <> p_user
          and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)))))
$$;

-- ————— Voice clips and videos are allowed attachments (up to 25 MB; the backend applies the lower Supabase limit) —————
create or replace function public.chat_attachment_ok(p_kind text, p_conversation uuid, a jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select a is null or (
    jsonb_typeof(a) = 'object'
    and a ->> 'path' like p_kind || '/' || coalesce(p_conversation::text, '%') || '/%'
    and length(coalesce(a ->> 'name', '')) between 1 and 120
    and (a ->> 'size') ~ '^[0-9]{1,8}$' and (a ->> 'size')::bigint between 1 and 26214400
    and (a ->> 'duration' is null or ((a ->> 'duration') ~ '^[0-9]{1,4}$' and (a ->> 'duration')::integer between 1 and 3600))
    and a ->> 'type' in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg',
      'video/mp4', 'video/quicktime', 'video/webm'))
$$;

-- Same as v2, with "🎤 Voice message" as the chat-list preview for audio.
create or replace function public.chat_send(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
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
      when p_attachment ->> 'type' like 'audio/%' then '🎤 Voice message'
      when p_attachment ->> 'type' like 'video/%' then '🎬 Video'
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

-- ————— Links shared in a chat (Chat info → Links) —————
create or replace function public.chat_links(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t record := public.chat_tables(p_kind); result jsonb;
begin
  if public.chat_get(p_kind, p_user, p_stable, p_conversation) is null then raise exception 'not_found'; end if;
  execute format(
    'select coalesce(jsonb_agg(public.chat_message_out($2, to_jsonb(m), null) order by m.sent_at desc), ''[]'')
     from (select * from public.%I where conversation_id = $1 and deleted_at is null and not system
           and body ~* ''https?://'' order by sent_at desc limit 60) m', t.messages)
    into result using p_conversation, p_user;
  return result;
end $$;

-- ————— New messages for notifications —————
-- The newest unread message per chat that arrived after p_since (at most the last 15 minutes, so a sleeping tab
-- that wakes up doesn't flood the screen), from someone else, in chats you haven't muted. Message requests are
-- included and marked. Team chats only for stables you still belong to.
create or replace function public.chat_incoming(p_user uuid, p_since timestamptz) returns jsonb
language sql stable security definer set search_path = '' as $$
  with since as (select greatest(coalesce(p_since, now() - interval '2 minutes'), now() - interval '15 minutes') as at)
  select coalesce(jsonb_agg(x.item order by x.at), '[]') from (
    select c.last_message_at as at, jsonb_build_object(
      'chatId', c.id, 'kind', 'personal', 'stableId', null, 'stableName', null,
      'group', c.kind = 'group', 'title', case when c.kind = 'group' then c.title end,
      'from', coalesce(c.member_names ->> c.last_sender_id::text, 'Stayblz member'),
      'fromId', c.last_sender_id, 'body', c.last_message, 'at', c.last_message_at,
      'request', c.requested_ids @> array[p_user]) as item
    from public.personal_conversations c
    left join public.chat_settings s on s.user_id = p_user and s.kind = 'personal' and s.conversation_id = c.id
    where c.member_ids @> array[p_user] and c.last_sender_id is not null and c.last_sender_id <> p_user
      and c.last_message_at > (select at from since)
      and not public.chat_is_muted(to_jsonb(s))
      and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)
    union all
    select c.last_message_at, jsonb_build_object(
      'chatId', c.id, 'kind', 'team', 'stableId', c.stable_id, 'stableName', st.name,
      'group', c.kind = 'group', 'title', case when c.kind = 'group' then c.title end,
      'from', coalesce(sender.display_name, 'Teammate'),
      'fromId', c.last_sender_id, 'body', c.last_message, 'at', c.last_message_at, 'request', false)
    from public.member_conversations c
    join public.stable_memberships m on m.stable_id = c.stable_id and m.user_id = p_user
    join public.member_stables st on st.id = c.stable_id
    left join public.stable_memberships sender on sender.stable_id = c.stable_id and sender.user_id = c.last_sender_id
    left join public.chat_settings s on s.user_id = p_user and s.kind = 'team' and s.conversation_id = c.id
    where c.member_ids @> array[p_user] and c.last_sender_id is not null and c.last_sender_id <> p_user
      and c.last_message_at > (select at from since)
      and not public.chat_is_muted(to_jsonb(s))
      and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)
    order by 1 desc limit 20) x
$$;

-- Every chat_* function: service role only.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'chat\_%' ) loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
