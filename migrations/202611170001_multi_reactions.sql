-- Stayblz Chat: several different reactions per person on one message (up to 10), instead of one.
-- Apply after 202611120001_chat_v2.sql. Re-runnable.
--
-- messages.reactions changes from { account id -> "emoji" } to { account id -> ["emoji", ...] }.
-- Existing single reactions are converted below; the readers also accept the old string form, so a
-- row written by the old code between deploy steps still shows correctly.
begin;

-- ————— Convert stored reactions —————
do $$ declare t text; begin
  foreach t in array array['personal_messages', 'member_messages'] loop
    execute format(
      'update public.%I set reactions = (select jsonb_object_agg(key,
         case when jsonb_typeof(value) = ''array'' then value else jsonb_build_array(value) end) from jsonb_each(reactions))
       where reactions <> ''{}'' and exists (select 1 from jsonb_each(reactions) where jsonb_typeof(value) <> ''array'')', t);
  end loop;
end $$;

-- ————— Toggle one emoji in one person's list —————
-- Picking an emoji you already used removes it; any other emoji is added (max 10 each). '' removes all of yours.
create or replace function public.chat_toggle_reaction(r jsonb, p_key text, p_emoji text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  mine jsonb := case jsonb_typeof(r -> p_key)
                  when 'array' then r -> p_key
                  when 'string' then jsonb_build_array(r -> p_key)
                  else '[]'::jsonb end;
begin
  if coalesce(p_emoji, '') = '' then return r - p_key; end if;
  if mine ? p_emoji then
    mine := coalesce((select jsonb_agg(e) from jsonb_array_elements(mine) e where e #>> '{}' <> p_emoji), '[]'::jsonb);
  else
    if jsonb_array_length(mine) >= 10 then raise exception 'too_many_reactions'; end if;
    mine := mine || to_jsonb(p_emoji);
  end if;
  if jsonb_array_length(mine) = 0 then return r - p_key; end if;
  return r || jsonb_build_object(p_key, mine);
end $$;

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
      from (select a #>> '{}' as e, count(distinct p.key) as n, bool_or(p.key = p_user::text) as mine
            from jsonb_each(coalesce(m -> 'reactions', '{}')) p,
                 jsonb_array_elements(case when jsonb_typeof(p.value) = 'array' then p.value
                                           else jsonb_build_array(p.value) end) a
            group by 1) x), '[]'),
    'replyTo', case when r is null then null else jsonb_build_object(
      'id', r ->> 'id', 'from', r ->> 'sender', 'removed', r ->> 'deleted_at' is not null,
      'attachment', case when r ->> 'deleted_at' is null then r -> 'attachment' ->> 'name' end,
      'body', case when r ->> 'deleted_at' is null then left(r ->> 'body', 160) else '' end) end)
$$;

-- Same checks as chat_v2; only the update now toggles within your own list.
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
       reactions = public.chat_toggle_reaction(m.reactions, $2, $3)
     where m.id = $1 and m.conversation_id = $4 and m.deleted_at is null and not m.system returning to_jsonb(m.*)', t.messages)
    into result using p_message, p_user::text, coalesce(p_emoji, ''), p_conversation;
  if result is null then raise exception 'not_found'; end if;
  if result ->> 'reply_to' is not null then
    execute format('select to_jsonb(r) from public.%I r where r.id = $1', t.messages)
      into reply using (result ->> 'reply_to')::uuid;
  end if;
  return public.chat_message_out(p_user, result, reply);
end $$;

-- Every chat_* function: service role only.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'chat\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
