-- Stayblz Chat: "@everyone" in a group chat mentions every member.
--
-- chat_notify (202611190003_chat_alerts.sql) decides a member's alert kind with chat_mentions_name(body, name):
-- true means a 'mention' alert ("X mentioned you in Group"), which follows the "Mentions and replies" switch and
-- reaches people even in a muted chat — the same as writing their name. Now "@everyone" (any case, as its own word,
-- not part of an email address) counts as mentioning each member. Only group chats use mentions (chat_notify checks
-- that), so "@everyone" in a one-to-one chat is just text.
--
-- "@highlight" is shown by the app as a highlighted message and is NOT a mention: nothing here changes for it.
-- Safe to run more than once (create or replace; grants on the function are kept).

create or replace function public.chat_mentions_name(p_body text, p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    p_body ~* '(^|[^[:alnum:]_.@])@everyone(?![[:alnum:]_])'
    or (length(btrim(p_name)) > 0
        and p_body ~* ('@' || regexp_replace(btrim(p_name), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '(?![[:alnum:]])')),
    false)
$$;
