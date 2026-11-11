-- Messenger: direct chats, message requests, read times ("Seen"), replies, reactions and unsend
-- for personal (/api/messages) and team (/api/team-messages) conversations.
--
-- Kept deliberately small for the free database plan: no attachments, no typing state, no
-- per-message read rows. Read times live in one jsonb object per conversation and reactions in
-- one jsonb object per message (account id -> emoji).
--
-- Everything goes through the service-role-only chat_* functions below. Tables keep RLS on and
-- no browser grants. `p_kind` is 'personal' or 'team' and only ever picks one of two fixed table
-- names; it is never spliced in from user input.

alter table public.personal_conversations
  add column kind text not null default 'group' check (kind in ('direct', 'group')),
  -- Members who were added to a direct chat and haven't accepted yet (message requests).
  add column requested_ids uuid[] not null default '{}',
  add column reads jsonb not null default '{}' check (jsonb_typeof(reads) = 'object'),
  add column last_sender_id uuid;
alter table public.member_conversations
  add column kind text not null default 'group' check (kind in ('direct', 'group')),
  add column reads jsonb not null default '{}' check (jsonb_typeof(reads) = 'object'),
  add column last_sender_id uuid;

-- Unsent messages keep their row (so replies and order stay intact) but lose their text.
alter table public.personal_messages
  drop constraint personal_messages_body_check,
  add column reply_to uuid references public.personal_messages(id) on delete set null,
  add column reactions jsonb not null default '{}' check (jsonb_typeof(reactions) = 'object'),
  add column deleted_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint personal_messages_body_check check (
    (deleted_at is null and length(btrim(body)) between 1 and 4000) or (deleted_at is not null and body = ''));
alter table public.member_messages
  drop constraint member_messages_body_check,
  add column reply_to uuid references public.member_messages(id) on delete set null,
  add column reactions jsonb not null default '{}' check (jsonb_typeof(reactions) = 'object'),
  add column deleted_at timestamptz,
  add column updated_at timestamptz not null default now(),
  add constraint member_messages_body_check check (
    (deleted_at is null and length(btrim(body)) between 1 and 4000) or (deleted_at is not null and body = ''));
create index personal_messages_changes on public.personal_messages (conversation_id, updated_at);
create index member_messages_changes on public.member_messages (conversation_id, updated_at);

-- Existing chats: remember who sent the last message and treat everything so far as read,
-- so nobody gets a wall of "unread" on launch day.
update public.personal_conversations c set
  last_sender_id = (select m.sender_id from public.personal_messages m where m.conversation_id = c.id
                    order by m.sent_at desc, m.id desc limit 1),
  reads = (select coalesce(jsonb_object_agg(u::text, to_jsonb(now())), '{}') from unnest(c.member_ids) u);
update public.member_conversations c set
  last_sender_id = (select m.sender_id from public.member_messages m where m.conversation_id = c.id
                    order by m.sent_at desc, m.id desc limit 1),
  reads = (select coalesce(jsonb_object_agg(u::text, to_jsonb(now())), '{}') from unnest(c.member_ids) u);

-- The reactions people can pick. Keep in sync with the frontend (components/messenger/types.ts).
create function public.chat_reactions() returns text[]
language sql immutable set search_path = '' as $$
  select array['👍', '❤️', '😂', '😮', '😢', '🐎']
$$;

create function public.chat_tables(p_kind text, out conversations text, out messages text)
language plpgsql immutable set search_path = '' as $$
begin
  if p_kind = 'personal' then conversations := 'personal_conversations'; messages := 'personal_messages';
  elsif p_kind = 'team' then conversations := 'member_conversations'; messages := 'member_messages';
  else raise exception 'invalid_kind'; end if;
end $$;

-- One message as the API returns it. `m` and `r` (the quoted message, or null) are to_jsonb(row).
create function public.chat_message_out(p_user uuid, m jsonb, r jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m ->> 'id',
    'senderId', m ->> 'sender_id',
    'from', m ->> 'sender',
    'body', case when m ->> 'deleted_at' is null then m ->> 'body' else '' end,
    'sentAt', m -> 'sent_at',
    'mine', (m ->> 'sender_id')::uuid = p_user,
    'removed', m ->> 'deleted_at' is not null,
    'reactions', coalesce((
      select jsonb_agg(jsonb_build_object('emoji', e, 'count', n, 'mine', mine) order by n desc, e)
      from (select value #>> '{}' as e, count(*) as n, bool_or(key = p_user::text) as mine
            from jsonb_each(coalesce(m -> 'reactions', '{}')) group by 1) x), '[]'),
    'replyTo', case when r is null then null else jsonb_build_object(
      'id', r ->> 'id', 'from', r ->> 'sender', 'removed', r ->> 'deleted_at' is not null,
      'body', case when r ->> 'deleted_at' is null then left(r ->> 'body', 160) else '' end) end)
$$;

-- The conversation row (as jsonb) when p_user is a member; null otherwise. Team chats must also
-- belong to the stable the request was checked against.
create function public.chat_get(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if p_kind = 'personal' then
    select to_jsonb(c) into result from public.personal_conversations c
    where c.id = p_conversation and c.member_ids @> array[p_user];
  elsif p_kind = 'team' then
    select to_jsonb(c) into result from public.member_conversations c
    where c.id = p_conversation and c.stable_id = p_stable and c.member_ids @> array[p_user];
  else raise exception 'invalid_kind'; end if;
  return result;
end $$;

-- account id -> display name for a conversation (personal: stored names; team: the stable roster).
create function public.chat_names(p_kind text, p_stable uuid, c jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when p_kind = 'personal' then coalesce(c -> 'member_names', '{}')
    else coalesce((select jsonb_object_agg(s.user_id::text, s.display_name) from public.stable_memberships s
                   where s.stable_id = p_stable), '{}') end
$$;

create function public.chat_preview(p_kind text, p_user uuid, c jsonb, names jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  me text := p_user::text;
  requested jsonb := coalesce(c -> 'requested_ids', '[]');
  others text[];
  last_read timestamptz := (c -> 'reads' ->> me)::timestamptz;
  last_sender text := c ->> 'last_sender_id';
begin
  select coalesce(array_agg(coalesce(names ->> u, case when p_kind = 'personal' then 'Stayblz member' else 'Former teammate' end)
                            order by ord), '{}')
    into others
  from jsonb_array_elements_text(c -> 'member_ids') with ordinality t(u, ord) where u <> me;
  return jsonb_build_object(
    'id', c ->> 'id',
    'kind', c ->> 'kind',
    'title', case when c ->> 'kind' = 'direct' and cardinality(others) > 0 then others[1] else c ->> 'title' end,
    'participants', to_jsonb(others),
    'lastMessage', c ->> 'last_message',
    'lastMessageMine', coalesce(last_sender = me, false),
    'lastMessageAt', c -> 'last_message_at',
    'unread', last_sender is not null and last_sender <> me and not (requested ? me)
              and (last_read is null or (c ->> 'last_message_at')::timestamptz > last_read),
    'request', (requested ? me),
    'waiting', jsonb_array_length(requested) > 0 and not (requested ? me),
    'canInvite', p_kind = 'personal' and c ->> 'kind' = 'group' and c ->> 'created_by' = me);
end $$;

create function public.chat_list(p_kind text, p_user uuid, p_stable uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare names jsonb;
begin
  if p_kind = 'personal' then
    -- Requests stay hidden until the other person actually sends something.
    return coalesce((select jsonb_agg(public.chat_preview('personal', p_user, to_jsonb(c), c.member_names)
                                      order by c.last_message_at desc, c.id)
      from (select * from public.personal_conversations
            where member_ids @> array[p_user] and not (requested_ids @> array[p_user] and last_sender_id is null)
            order by last_message_at desc limit 100) c), '[]');
  elsif p_kind = 'team' then
    names := public.chat_names('team', p_stable, null);
    return coalesce((select jsonb_agg(public.chat_preview('team', p_user, to_jsonb(c), names)
                                      order by c.last_message_at desc, c.id)
      from (select * from public.member_conversations
            where stable_id = p_stable and member_ids @> array[p_user]
            order by last_message_at desc limit 100) c), '[]');
  end if;
  raise exception 'invalid_kind';
end $$;

-- A conversation with one page of messages (newest p_limit, older than the cursor when given),
-- or — when p_since is set — only the messages added or changed since then (polling).
create function public.chat_thread(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
  p_before_time timestamptz, p_before_id uuid, p_since timestamptz, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  names jsonb;
  requested jsonb;
  members jsonb;
  reads jsonb;
  msgs jsonb;
  cursor text;
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if c is null then raise exception 'not_found'; end if;
  names := public.chat_names(p_kind, p_stable, c);
  requested := coalesce(c -> 'requested_ids', '[]');
  select coalesce(jsonb_agg(jsonb_build_object('id', u, 'me', u = p_user::text, 'pending', (requested ? u),
           'name', coalesce(names ->> u, case when p_kind = 'personal' then 'Stayblz member' else 'Former teammate' end))
           order by ord), '[]'),
         coalesce(jsonb_agg(jsonb_build_object('id', u, 'name', coalesce(names ->> u, 'Member'), 'at', c -> 'reads' -> u)
           order by ord) filter (where u <> p_user::text and not (requested ? u) and ((c -> 'reads') ? u)), '[]')
    into members, reads
  from jsonb_array_elements_text(c -> 'member_ids') with ordinality x(u, ord);

  if p_since is not null then
    -- 10 s overlap: a write that committed just after the last poll is never missed. Duplicates merge by id.
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
    'conversation', public.chat_preview(p_kind, p_user, c, names)
      || jsonb_build_object('members', members, 'reads', reads, 'messages', msgs),
    'before', cursor,
    'now', to_jsonb(now()));
end $$;

create function public.chat_send(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
  p_display text, p_body text, p_client uuid, p_reply uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb;
  display text := p_display;
  reply_id uuid;
  result jsonb;
  reply jsonb;
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
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid_message'; end if;
  display := coalesce(nullif(btrim(display), ''), 'Member');

  -- Same client id = the same message (a retry after a lost response).
  execute format('select to_jsonb(m) from public.%I m where conversation_id = $1 and sender_id = $2 and client_id = $3',
                 t.messages) into result using p_conversation, p_user, p_client;
  if result is null then
    if p_reply is not null then
      execute format('select id from public.%I where id = $1 and conversation_id = $2', t.messages)
        into reply_id using p_reply, p_conversation;
    end if;
    execute format('insert into public.%I as m (conversation_id, sender_id, sender, body, client_id, reply_to)
                    values ($1, $2, $3, btrim($4), $5, $6) returning to_jsonb(m.*)', t.messages)
      into result using p_conversation, p_user, display, p_body, p_client, reply_id;
    execute format('update public.%I set last_message = left($2, 200), last_message_at = $3, last_sender_id = $4,
                      reads = reads || jsonb_build_object($4::text, $3)%s where id = $1',
                   t.conversations,
                   case when p_kind = 'personal' then ', member_names = member_names || jsonb_build_object($4::text, $5::text)' else '' end)
      using p_conversation, result ->> 'body', (result ->> 'sent_at')::timestamptz, p_user, display;
  end if;
  if result ->> 'reply_to' is not null then
    execute format('select to_jsonb(r) from public.%I r where r.id = $1', t.messages)
      into reply using (result ->> 'reply_to')::uuid;
  end if;
  return public.chat_message_out(p_user, result, reply);
end $$;

-- Toggle a reaction: picking the same emoji again (or '') removes yours.
create function public.chat_react(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid,
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
  if coalesce(p_emoji, '') <> '' and not (p_emoji = any (public.chat_reactions())) then raise exception 'invalid_reaction'; end if;
  execute format(
    'update public.%I as m set updated_at = now(),
       reactions = case when $3 = '''' or m.reactions ->> $2 = $3 then m.reactions - $2 else m.reactions || jsonb_build_object($2, $3) end
     where m.id = $1 and m.conversation_id = $4 and m.deleted_at is null returning to_jsonb(m.*)', t.messages)
    into result using p_message, p_user::text, coalesce(p_emoji, ''), p_conversation;
  if result is null then raise exception 'not_found'; end if;
  if result ->> 'reply_to' is not null then
    execute format('select to_jsonb(r) from public.%I r where r.id = $1', t.messages)
      into reply using (result ->> 'reply_to')::uuid;
  end if;
  return public.chat_message_out(p_user, result, reply);
end $$;

-- Unsend your own message for everyone. The text is erased, not hidden.
create function public.chat_unsend(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  t record := public.chat_tables(p_kind);
  c jsonb := public.chat_get(p_kind, p_user, p_stable, p_conversation);
  result jsonb;
begin
  if c is null then raise exception 'not_found'; end if;
  execute format(
    'update public.%I as m set body = '''', deleted_at = now(), reactions = ''{}'', updated_at = now()
     where m.id = $1 and m.conversation_id = $2 and m.sender_id = $3 and m.deleted_at is null returning to_jsonb(m.*)', t.messages)
    into result using p_message, p_conversation, p_user;
  if result is null then
    execute format('select to_jsonb(m) from public.%I m where m.id = $1 and m.conversation_id = $2 and m.sender_id = $3',
                   t.messages) into result using p_message, p_conversation, p_user;
    if result is null then raise exception 'not_found'; end if;
    return public.chat_message_out(p_user, result, null);
  end if;
  -- Quotes of it refresh on the next poll; the chat list stops showing its text.
  execute format('update public.%I set updated_at = now() where conversation_id = $2 and reply_to = $1', t.messages)
    using p_message, p_conversation;
  execute format('update public.%I set last_message = ''Message unsent'' where id = $1 and last_message_at = $2 and last_sender_id = $3',
                 t.conversations) using p_conversation, (result ->> 'sent_at')::timestamptz, p_user;
  return public.chat_message_out(p_user, result, null);
end $$;

-- Mark everything in the chat as read now. People with a pending request don't send read receipts.
create function public.chat_read(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind = 'personal' then
    update public.personal_conversations set reads = reads || jsonb_build_object(p_user::text, now())
    where id = p_conversation and member_ids @> array[p_user] and not requested_ids @> array[p_user];
  elsif p_kind = 'team' then
    update public.member_conversations set reads = reads || jsonb_build_object(p_user::text, now())
    where id = p_conversation and stable_id = p_stable and member_ids @> array[p_user];
  else raise exception 'invalid_kind'; end if;
  return found;
end $$;

-- Leave a chat (also "Delete" on a message request). The last person out removes it entirely.
create function public.chat_leave(p_kind text, p_user uuid, p_stable uuid, p_conversation uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare remaining integer;
begin
  if p_kind = 'personal' then
    select cardinality(member_ids) into remaining from public.personal_conversations
    where id = p_conversation and member_ids @> array[p_user] for update;
    if not found then raise exception 'not_found'; end if;
    if remaining <= 1 then delete from public.personal_conversations where id = p_conversation;
    else update public.personal_conversations set member_ids = array_remove(member_ids, p_user),
      requested_ids = array_remove(requested_ids, p_user), reads = reads - p_user::text where id = p_conversation;
    end if;
  elsif p_kind = 'team' then
    select cardinality(member_ids) into remaining from public.member_conversations
    where id = p_conversation and stable_id = p_stable and member_ids @> array[p_user] for update;
    if not found then raise exception 'not_found'; end if;
    if remaining <= 1 then delete from public.member_conversations where id = p_conversation;
    else update public.member_conversations set member_ids = array_remove(member_ids, p_user),
      reads = reads - p_user::text where id = p_conversation;
    end if;
  else raise exception 'invalid_kind'; end if;
  return true;
end $$;

create function public.chat_accept(p_user uuid, p_conversation uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.personal_conversations set requested_ids = array_remove(requested_ids, p_user),
    reads = reads || jsonb_build_object(p_user::text, now())
  where id = p_conversation and member_ids @> array[p_user];
  if not found then raise exception 'not_found'; end if;
  return true;
end $$;

-- Start (or reopen) a one-to-one personal chat with the account that uses this email.
-- The other person sees it under Requests until they accept.
create function public.chat_start_direct(p_user uuid, p_display text, p_email text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare other uuid; other_name text; existing uuid;
begin
  select a.id, nullif(btrim(a.first_name || ' ' || a.last_name), '') into other, other_name
  from public.accounts a where lower(a.email) = lower(btrim(p_email)) and a.status = 'active' limit 1;
  if other is null then raise exception 'no_account'; end if;
  if other = p_user then raise exception 'self'; end if;
  select id into existing from public.personal_conversations
  where kind = 'direct' and member_ids @> array[p_user, other] and cardinality(member_ids) = 2
  order by last_message_at desc limit 1 for update;
  if existing is not null then
    -- Writing to someone who already wrote to you accepts their request.
    update public.personal_conversations set requested_ids = array_remove(requested_ids, p_user),
      member_names = member_names || jsonb_build_object(p_user::text, p_display) where id = existing;
    return existing;
  end if;
  insert into public.personal_conversations (title, created_by, member_ids, member_names, kind, requested_ids, reads)
  values ('Direct chat', p_user, array[p_user, other],
          jsonb_build_object(p_user::text, p_display, other::text, coalesce(other_name, 'Stayblz member')),
          'direct', array[other], jsonb_build_object(p_user::text, now()))
  returning id into existing;
  return existing;
end $$;

create function public.chat_start_team_direct(p_user uuid, p_stable uuid, p_other uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare existing uuid;
begin
  if p_other = p_user or not exists (select 1 from public.stable_memberships where stable_id = p_stable and user_id = p_other)
     or not exists (select 1 from public.stable_memberships where stable_id = p_stable and user_id = p_user) then
    raise exception 'invalid_participants';
  end if;
  select id into existing from public.member_conversations
  where stable_id = p_stable and kind = 'direct' and member_ids @> array[p_user, p_other] and cardinality(member_ids) = 2 limit 1;
  if existing is not null then return existing; end if;
  insert into public.member_conversations (stable_id, title, member_ids, created_by, kind, reads)
  values (p_stable, 'Direct chat', array[p_user, p_other], p_user, 'direct', jsonb_build_object(p_user::text, now()))
  returning id into existing;
  return existing;
end $$;

-- Counts for the menu badge: unread personal chats, unread team chats (any stable you're in), requests.
create function public.chat_unread(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'personal', (select count(*) from public.personal_conversations c
      where c.member_ids @> array[p_user] and not c.requested_ids @> array[p_user] and c.last_sender_id <> p_user
        and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)),
    'requests', (select count(*) from public.personal_conversations c
      where c.requested_ids @> array[p_user] and c.last_sender_id is not null),
    'team', (select count(*) from public.member_conversations c
      join public.stable_memberships s on s.stable_id = c.stable_id and s.user_id = p_user
      where c.member_ids @> array[p_user] and c.last_sender_id <> p_user
        and (c.reads ->> p_user::text is null or c.last_message_at > (c.reads ->> p_user::text)::timestamptz)))
$$;

do $$ declare f text; begin
  foreach f in array array[
    'chat_reactions()', 'chat_tables(text)', 'chat_message_out(uuid,jsonb,jsonb)', 'chat_get(text,uuid,uuid,uuid)',
    'chat_names(text,uuid,jsonb)', 'chat_preview(text,uuid,jsonb,jsonb)', 'chat_list(text,uuid,uuid)',
    'chat_thread(text,uuid,uuid,uuid,timestamptz,uuid,timestamptz,integer)',
    'chat_send(text,uuid,uuid,uuid,text,text,uuid,uuid)', 'chat_react(text,uuid,uuid,uuid,uuid,text)',
    'chat_unsend(text,uuid,uuid,uuid,uuid)', 'chat_read(text,uuid,uuid,uuid)', 'chat_leave(text,uuid,uuid,uuid)',
    'chat_accept(uuid,uuid)', 'chat_start_direct(uuid,text,text)', 'chat_start_team_direct(uuid,uuid,uuid)',
    'chat_unread(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
