-- Marketplace inquiries: "Message seller" on a listing.
-- Apply after 202611200001_virtual_stayblz.sql.
--
-- * personal_messages.listing holds a small snapshot of the listing a message is about
--   ({id, name, price, location, cover}), so the chat shows the buyer's message followed by a
--   listing card without loading anything else, and still makes sense after the listing is removed.
-- * chat_message_out returns it as `listing` (hidden once the message is unsent).
-- * marketplace_inquiry starts (or reopens) the buyer's direct chat with the seller and sends the
--   message. Inquiries go straight to the seller's inbox, never into message requests: listing a
--   horse is the seller agreeing to be contacted. Blocks still apply (chat_start_direct_user).
begin;

alter table public.personal_messages
  add column if not exists listing jsonb check (listing is null or jsonb_typeof(listing) = 'object');

-- Same as chat_v3, plus `listing`.
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
    'listing', case when m ->> 'deleted_at' is null and jsonb_typeof(m -> 'listing') = 'object'
                    then m -> 'listing' end,
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

-- A buyer messages the seller of a listing. p_snapshot is built by the API from the listing row.
-- Retrying with the same p_client returns the message already sent (chat_send).
create or replace function public.marketplace_inquiry(p_user uuid, p_display text, p_listing uuid,
  p_snapshot jsonb, p_body text, p_client uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare seller uuid; conv uuid; msg jsonb;
begin
  select l.seller_id into seller from public.marketplace_listings l where l.id = p_listing;
  if seller is null then raise exception 'listing_not_found'; end if;
  if seller = p_user then raise exception 'self'; end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or p_snapshot ->> 'id' <> p_listing::text then
    raise exception 'invalid_listing';
  end if;
  conv := public.chat_start_direct_user(p_user, p_display, seller);
  -- Straight to the seller's inbox: no message request for listing inquiries.
  update public.personal_conversations set requested_ids = array_remove(requested_ids, seller) where id = conv;
  msg := public.chat_send('personal', p_user, null, conv, p_display, p_body, p_client, null, null, false);
  update public.personal_messages set listing = p_snapshot
   where id = (msg ->> 'id')::uuid and conversation_id = conv and listing is null;
  select public.chat_message_out(p_user, to_jsonb(m), null) into msg
    from public.personal_messages m where m.id = (msg ->> 'id')::uuid;
  return jsonb_build_object('conversationId', conv, 'message', msg);
end $$;

revoke all on function public.marketplace_inquiry(uuid, text, uuid, jsonb, text, uuid) from public, anon, authenticated;
grant execute on function public.marketplace_inquiry(uuid, text, uuid, jsonb, text, uuid) to service_role;

notify pgrst, 'reload schema';
commit;
