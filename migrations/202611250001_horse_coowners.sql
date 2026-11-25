-- LOCAL until a release is approved. Apply after 202611240001_virtual_racing_horses.sql. Safe to re-run; adds, never removes data.
--
-- Co-owned horses (My racing → My horses):
--
--   * A horse (owner_horses) keeps one lead owner (owner_id): the member who added it. The lead can invite other
--     members as co-owners (owner_horse_members). An invite stays 'pending' until the member accepts it.
--   * Every owner sees and edits the same horse, so details, photos, race records and race-data updates reach all
--     owners at once. The lead alone deletes the horse, manages owners, links race data and sets who can see it.
--   * With require_approval on, a co-owner's edits to details and race records wait in owner_horse_changes until
--     another owner accepts or declines them. Photos and videos are never held back.
--   * Shares (basis points, 5000 = 50%) are optional and only shown to the owners.
--   * Bell alerts for owners use kind 'horse' (worded by the server, like billing), through horse_alert().
--   * Race-data alerts (formfav_notify) now go to every accepted co-owner as well as the lead.
--
-- RLS on, no browser grants; everything through the service role.

begin;

alter table public.owner_horses
  add column if not exists require_approval boolean not null default false,
  add column if not exists owner_share_bps integer check (owner_share_bps is null or owner_share_bps between 1 and 10000);

create table if not exists public.owner_horse_members (
  horse_id uuid not null references public.owner_horses(id) on delete cascade,
  account_id uuid not null references public.accounts(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  share_bps integer check (share_bps is null or share_bps between 1 and 10000),
  invited_by uuid references public.accounts(id) on delete set null,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (horse_id, account_id)
);
create index if not exists owner_horse_members_account_idx on public.owner_horse_members (account_id, status);

create table if not exists public.owner_horse_changes (
  id uuid primary key default gen_random_uuid(),
  horse_id uuid not null references public.owner_horses(id) on delete cascade,
  proposed_by uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('details', 'record_add', 'record_update', 'record_remove')),
  target_id uuid,
  payload jsonb not null default '{}' check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
  decided_by uuid references public.accounts(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists owner_horse_changes_horse_idx on public.owner_horse_changes (horse_id, status, created_at desc);

alter table public.owner_horse_members enable row level security;
alter table public.owner_horse_changes enable row level security;
revoke all on public.owner_horse_members from public, anon, authenticated;
revoke all on public.owner_horse_changes from public, anon, authenticated;
grant select, insert, update, delete on public.owner_horse_members to service_role;
grant select, insert, update, delete on public.owner_horse_changes to service_role;

-- ---------- Alert kind: 'horse' (co-owner invites, edits, changes waiting for approval) ----------
alter table public.chat_alerts drop constraint if exists chat_alerts_kind_check;
alter table public.chat_alerts add constraint chat_alerts_kind_check check (kind in (
  'message', 'request', 'mention', 'reply', 'reaction', 'group_added', 'friend_request', 'friend_accepted',
  'request_accepted', 'race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change', 'horse'));

create or replace function public.chat_alert_allowed(n public.notification_settings, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(n.enabled, false) and case
    when p_kind in ('message', 'group_added') then n.chat_messages
    when p_kind in ('request', 'friend_request', 'friend_accepted', 'request_accepted') then n.chat_requests
    when p_kind in ('mention', 'reply') then n.chat_mentions
    when p_kind = 'reaction' then n.chat_reactions
    when p_kind in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change', 'horse') then true
    else false end
$$;

-- Same as 202611240001, plus 'horse' among the kinds only newer apps show (racing=1).
create or replace function public.chat_alerts_list(p_user uuid, p_since timestamptz, p_limit integer,
  p_racing boolean default false) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(public.chat_alert_out(a) order by a.created_at desc)
      from public.chat_alerts a
      where a.id in (
        select b.id from public.chat_alerts b
        where b.user_id = p_user and (p_since is null or b.created_at > p_since)
          and (coalesce(p_racing, false) or b.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change', 'horse'))
          and (b.chat_kind is distinct from 'team' or exists (
            select 1 from public.stable_memberships sm where sm.stable_id = b.stable_id and sm.user_id = p_user))
        order by b.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 50))), '[]'),
    'unread', (select count(*) from public.chat_alerts a where a.user_id = p_user and a.read_at is null
      and (coalesce(p_racing, false) or a.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout', 'billing', 'race_change', 'horse'))
      and (a.chat_kind is distinct from 'team' or exists (
        select 1 from public.stable_memberships sm where sm.stable_id = a.stable_id and sm.user_id = p_user))))
$$;

-- Saves one 'horse' alert per person and returns {alerts, targets} for push (lib/horseAlerts.ts).
-- p_ref is the horse. With p_collapse, an unread alert about the same horse from the same person with the same title
-- in the last 6 hours is refreshed instead of adding another (a burst of edits = one alert).
create or replace function public.horse_alert(p_users uuid[], p_actor uuid, p_title text, p_body text, p_link text,
  p_ref uuid, p_collapse boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid; new_id uuid; alerts jsonb := '[]'; who text;
begin
  who := coalesce(nullif(btrim((select concat_ws(' ', a.first_name, a.last_name) from public.accounts a where a.id = p_actor)), ''),
                  'Stayblz member');
  foreach u in array coalesce(p_users, '{}') loop
    if u = p_actor or not exists (select 1 from public.accounts a where a.id = u and a.status = 'active') then continue; end if;
    new_id := null;
    if coalesce(p_collapse, false) then
      update public.chat_alerts set body = left(coalesce(p_body, ''), 300), count = count + 1, created_at = now()
       where id = (select id from public.chat_alerts where user_id = u and kind = 'horse' and message_id = p_ref
                     and actor_id is not distinct from p_actor and chat_title = left(p_title, 120) and read_at is null
                     and created_at > now() - interval '6 hours' order by created_at desc limit 1)
      returning id into new_id;
    end if;
    if new_id is null then
      insert into public.chat_alerts (user_id, kind, message_id, actor_id, actor_name, chat_title, body, link)
      values (u, 'horse', p_ref, p_actor, left(who, 120), left(p_title, 120), left(coalesce(p_body, ''), 300),
              case when p_link ~ '^/[A-Za-z0-9]' then left(p_link, 300) end)
      returning id into new_id;
    end if;
    delete from public.chat_alerts where user_id = u and (created_at < now() - interval '30 days' or id in (
      select id from public.chat_alerts where user_id = u order by created_at desc offset 200));
    alerts := alerts || (select jsonb_build_array(public.chat_alert_out(x) || jsonb_build_object('userId', x.user_id))
                           from public.chat_alerts x where x.id = new_id);
  end loop;
  return jsonb_build_object('alerts', alerts, 'targets', public.chat_alert_targets(alerts));
end $$;

-- ---------- Race-data alerts reach co-owners ----------
-- Same as 202611240001, plus accepted co-owners of a linked owned horse (same priority and link as its lead owner).
create or replace function public.formfav_notify(p_events jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; alerts jsonb;
begin
  with ev as (
    select e ->> 'key' as fkey, (e ->> 'ref')::uuid as ref, e ->> 'kind' as kind,
      left(coalesce(e ->> 'horse', ''), 120) as horse, left(coalesce(e ->> 'title', ''), 120) as title,
      left(coalesce(e ->> 'body', ''), 300) as body, coalesce((e ->> 'at')::timestamptz, now()) as at
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
    where e ->> 'kind' in ('race_entry', 'race_scratch', 'race_result', 'race_change')
      and coalesce(e ->> 'ref', '') ~ '^[0-9a-f-]{36}$' and coalesce(e ->> 'key', '') <> ''
  ),
  hits as (
    select h.owner_id as uid, ev.*, 1 as prio, '/community/horses/' || h.id as link
      from ev join public.owner_horses h on h.formfav_key = ev.fkey
     where h.formfav_alerts and h.formfav_linked_at <= ev.at
    union all
    -- Co-owners hear about the horse they share, exactly like its lead owner.
    select m.account_id, ev.*, 1, '/community/horses/' || h.id
      from ev join public.owner_horses h on h.formfav_key = ev.fkey
      join public.owner_horse_members m on m.horse_id = h.id and m.status = 'accepted'
     where h.formfav_alerts and h.formfav_linked_at <= ev.at
    union all
    select vh.user_id, ev.*, 2,
      '/my-racing?tab=virtual' || case when vh.source = 'formfav' then '&vtab=racing' else '' end || '&horse=' || vh.id
      from ev join public.virtual_horses vh on vh.formfav_key = ev.fkey and vh.user_id is not null
     where vh.formfav_linked_at <= ev.at
       and not exists (select 1 from public.virtual_horse_mutes m where m.horse_id = vh.id and m.user_id = vh.user_id)
    union all
    select sm.user_id, ev.*, 3,
      '/workspace/virtual?stable=' || vh.stable_id || case when vh.source = 'formfav' then '&vtab=racing' else '' end
        || '&horse=' || vh.id
      from ev join public.virtual_horses vh on vh.formfav_key = ev.fkey and vh.stable_id is not null
      join public.stable_memberships sm on sm.stable_id = vh.stable_id
     where vh.formfav_linked_at <= ev.at
       and not exists (select 1 from public.virtual_horse_mutes m where m.horse_id = vh.id and m.user_id = sm.user_id)
  ),
  best as (
    select distinct on (hits.uid, hits.ref, hits.kind) hits.*
      from hits join public.accounts a on a.id = hits.uid and a.status = 'active'
     where public.racing_alert_wanted(hits.uid, hits.kind)
     order by hits.uid, hits.ref, hits.kind, hits.prio
  ),
  saved as (
    insert into public.chat_alerts (user_id, kind, message_id, actor_name, chat_title, body, link)
    select uid, kind, ref, horse, title, body, left(link, 300) from best
    on conflict do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into ids from saved;

  if cardinality(ids) = 0 then return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb); end if;

  delete from public.chat_alerts c using (select distinct user_id from public.chat_alerts where id = any (ids)) u
  where c.user_id = u.user_id and (c.created_at < now() - interval '30 days' or c.id in (
    select id from public.chat_alerts where user_id = u.user_id order by created_at desc offset 200));

  alerts := (select coalesce(jsonb_agg(public.chat_alert_out(a) || jsonb_build_object('userId', a.user_id)
               order by a.created_at), '[]'::jsonb)
             from public.chat_alerts a where a.id = any (ids));
  return jsonb_build_object('alerts', alerts, 'targets', public.chat_alert_targets(alerts));
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'chat_alert_allowed(public.notification_settings, text)', 'chat_alerts_list(uuid, timestamptz, integer, boolean)',
    'horse_alert(uuid[], uuid, text, text, text, uuid, boolean)', 'formfav_notify(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
