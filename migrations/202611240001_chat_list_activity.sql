-- Stayblz Chat: the chat list shows reactions, and an opened chat knows where you stopped reading.
--
-- 1. Reactions in the chat list (boss/QA, 2026-11-24): reacting didn't show anywhere in the list. Each conversation now
--    keeps its latest reaction (`last_reaction`: who, which emoji, on which message, whose message, when — never the
--    message's words). chat_preview returns it as `lastReaction` while it's newer than the last message, with the
--    message's *current* words read at that moment, so the list can read "You reacted ❤️ to “Gallops at six?”" or
--    "Ann reacted 👍 to your message". An edit shows its new words, an unsent message drops the line, and the whole
--    body is sent (the app shows plain words, spoilers stay hidden). Taking your reaction back clears it.
-- 2. `readAt` (your own read time) in chat_preview, so the chat opens at the first message you haven't read instead
--    of the bottom (previously only other members' read times were sent).
--
-- Reactions don't make a chat unread and don't move the badge. Safe to run more than once.

alter table public.personal_conversations add column if not exists last_reaction jsonb;
alter table public.member_conversations add column if not exists last_reaction jsonb;

-- Same as 202611120001_chat_v2.sql, plus the conversation's last_reaction.
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
  if result -> 'reactions' ->> p_user::text is not null then
    -- Your reaction is on: the chat list shows it (until a newer message or reaction).
    execute format('update public.%I set last_reaction = $2 where id = $1', t.conversations)
      using p_conversation, jsonb_build_object(
        'by', p_user::text,
        'emoji', result -> 'reactions' ->> p_user::text,
        'message', p_message::text,
        'to', result ->> 'sender_id',
        'at', now());
  else
    -- Taken back: the list stops showing it (only if it was this reaction).
    execute format('update public.%I set last_reaction = null where id = $1 and last_reaction ->> ''by'' = $2
                      and last_reaction ->> ''message'' = $3', t.conversations)
      using p_conversation, p_user::text, p_message::text;
  end if;
  if result ->> 'reply_to' is not null then
    execute format('select to_jsonb(r) from public.%I r where r.id = $1', t.messages)
      into reply using (result ->> 'reply_to')::uuid;
  end if;
  return public.chat_message_out(p_user, result, reply);
end $$;

-- Same as 202611170001_chat_v3.sql, plus `readAt` (your own read time) and `lastReaction` (with the reacted message's
-- current words; none once that message is unsent).
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
  reaction jsonb := c -> 'last_reaction';
  reacted jsonb;
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
  -- Only a reaction newer than the last message is news, and only while its message is still there (its words as
  -- they are now: an edit shows, an unsent message drops the line).
  if jsonb_typeof(reaction) <> 'object' or (last_at is not null and (reaction ->> 'at')::timestamptz <= last_at) then
    reaction := null;
  else
    execute format('select jsonb_build_object(''body'', m.body, ''attachment'', m.attachment ->> ''type'') from public.%I m
                    where m.id = $1 and m.conversation_id = $2 and m.deleted_at is null and not m.system',
                   case when p_kind = 'personal' then 'personal_messages' else 'member_messages' end)
      into reacted using (reaction ->> 'message')::uuid, (c ->> 'id')::uuid;
    if reacted is null then reaction := null; end if;
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
    'readAt', c -> 'reads' -> me,
    'lastReaction', case when reaction is not null then jsonb_build_object(
      'emoji', reaction ->> 'emoji',
      'mine', reaction ->> 'by' = me,
      'byName', case when reaction ->> 'by' = me then null
                     else coalesce(names ->> (reaction ->> 'by'), case when p_kind = 'personal' then 'Stayblz member' else 'Former teammate' end) end,
      'toMe', reaction ->> 'to' = me,
      'message', reaction ->> 'message',
      'body', reacted ->> 'body',
      'attachment', reacted ->> 'attachment',
      'at', reaction -> 'at') end,
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

notify pgrst, 'reload schema';
