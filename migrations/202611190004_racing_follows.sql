-- LOCAL until a release is approved. Apply after 202611190003_chat_alerts.sql. Safe to re-run; adds, never removes data.
--
-- Following on the linked racing data, with alerts that are actually delivered.
--
--   racing_follows   a person follows a horse, a jockey/driver/trainer/owner, or a horse's FAMILY
--                    (its sire and dam, brothers and sisters out of the same dam, and its foals; matched by name,
--                    because pedigree is stored as names).
--
-- Racing alerts reuse the saved alerts behind the bell, on-screen cards and Web Push (chat_alerts), with four new
-- kinds:  race_entry (a published card), race_scratch, race_result (race made official), workout (published).
-- The backend calls racing_notify(event, id) after the publishing tool changes something (lib/racingAlerts.ts);
-- the same call works for a future licensed data feed. Each person gets ONE alert per runner/workout, ever
-- (re-publishing never repeats it), and old history is skipped so a big backfill can't flood anyone:
-- entries/scratches only for races from yesterday on, results/workouts only from the last 7 days.
--
-- Older apps don't know these kinds, so the alert list only includes them when asked (p_racing => true).
-- RLS on, no browser grants; everything through service-role-only functions.

begin;

-- ---------- Follows ----------
create table if not exists public.racing_follows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.accounts(id) on delete cascade,
  kind text not null check (kind in ('horse', 'family', 'person')),
  horse_id uuid references public.racing_horses(id) on delete cascade,
  person_id uuid references public.racing_people(id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((kind in ('horse', 'family') and horse_id is not null and person_id is null)
      or (kind = 'person' and person_id is not null and horse_id is null))
);
create unique index if not exists racing_follows_once on public.racing_follows (user_id, kind, coalesce(horse_id, person_id));
create index if not exists racing_follows_user on public.racing_follows (user_id, created_at desc);
create index if not exists racing_follows_horse on public.racing_follows (horse_id) where horse_id is not null;
create index if not exists racing_follows_person on public.racing_follows (person_id) where person_id is not null;
-- Family lookups by name.
create index if not exists racing_horses_sire_name on public.racing_horses (lower(sire)) where sire <> '';
create index if not exists racing_horses_dam_name on public.racing_horses (lower(dam)) where dam <> '';

alter table public.racing_follows enable row level security;
revoke all on public.racing_follows from public, anon, authenticated;
grant select, insert, update, delete on public.racing_follows to service_role;

-- ---------- Racing kinds on the saved alerts ----------
alter table public.chat_alerts drop constraint if exists chat_alerts_kind_check;
alter table public.chat_alerts add constraint chat_alerts_kind_check check (kind in (
  'message', 'request', 'mention', 'reply', 'reaction', 'group_added', 'friend_request', 'friend_accepted',
  'request_accepted', 'race_entry', 'race_scratch', 'race_result', 'workout'));
-- Where tapping a racing alert goes: always a path on this site.
alter table public.chat_alerts add column if not exists link text
  check (link is null or (length(link) <= 300 and link ~ '^/[A-Za-z0-9]'));
-- One alert per person per runner/workout (message_id holds the runner or workout id for racing kinds).
create unique index if not exists chat_alerts_racing_once on public.chat_alerts (user_id, kind, message_id)
  where kind in ('race_entry', 'race_scratch', 'race_result', 'workout');

create or replace function public.chat_alert_out(a public.chat_alerts) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', a.id, 'kind', a.kind, 'chatKind', a.chat_kind, 'chatId', a.conversation_id, 'messageId', a.message_id,
    'stableId', a.stable_id, 'actorId', a.actor_id, 'actorName', a.actor_name, 'title', a.chat_title,
    'group', a.is_group, 'body', a.body, 'emoji', a.emoji, 'attachment', a.attachment, 'count', a.count,
    'link', a.link, 'at', a.created_at, 'read', a.read_at is not null)
$$;

-- Push for racing alerts follows the main "notifications on" switch; which racing alerts are saved at all is
-- chosen in My racing → Alert settings (racing_preferences).
create or replace function public.chat_alert_allowed(n public.notification_settings, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(n.enabled, false) and case
    when p_kind in ('message', 'group_added') then n.chat_messages
    when p_kind in ('request', 'friend_request', 'friend_accepted', 'request_accepted') then n.chat_requests
    when p_kind in ('mention', 'reply') then n.chat_mentions
    when p_kind = 'reaction' then n.chat_reactions
    when p_kind in ('race_entry', 'race_scratch', 'race_result', 'workout') then true
    else false end
$$;

drop function if exists public.chat_alerts_list(uuid, timestamptz, integer);
create or replace function public.chat_alerts_list(p_user uuid, p_since timestamptz, p_limit integer,
  p_racing boolean default false) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(public.chat_alert_out(a) order by a.created_at desc)
      from public.chat_alerts a
      where a.id in (
        select b.id from public.chat_alerts b
        where b.user_id = p_user and (p_since is null or b.created_at > p_since)
          and (coalesce(p_racing, false) or b.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout'))
          and (b.chat_kind is distinct from 'team' or exists (
            select 1 from public.stable_memberships sm where sm.stable_id = b.stable_id and sm.user_id = p_user))
        order by b.created_at desc limit least(greatest(coalesce(p_limit, 30), 1), 50))), '[]'),
    'unread', (select count(*) from public.chat_alerts a where a.user_id = p_user and a.read_at is null
      and (coalesce(p_racing, false) or a.kind not in ('race_entry', 'race_scratch', 'race_result', 'workout'))
      and (a.chat_kind is distinct from 'team' or exists (
        select 1 from public.stable_memberships sm where sm.stable_id = a.stable_id and sm.user_id = p_user))))
$$;

-- ---------- Helpers ----------
create or replace function public.racing_ordinal(n integer) returns text
language sql immutable set search_path = '' as $$
  select n::text || case when n % 100 in (11, 12, 13) then 'th' when n % 10 = 1 then 'st'
    when n % 10 = 2 then 'nd' when n % 10 = 3 then 'rd' else 'th' end
$$;

-- On public Stayblz racing pages (a published card, or a published workout)?
create or replace function public.racing_horse_public(p_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
                   join public.racing_days d on d.id = r.day_id
                 where rn.horse_id = p_id and public.racing_day_public(d))
      or exists (select 1 from public.racing_workouts w
                 where w.horse_id = p_id and w.status = 'published' and w.published_at <= now())
$$;
create or replace function public.racing_person_public(p_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (select 1 from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
                   join public.racing_days d on d.id = r.day_id
                 where p_id in (rn.jockey_id, rn.trainer_id, rn.owner_id) and public.racing_day_public(d))
$$;

-- A horse's family: sire, dam, brothers and sisters out of the same dam, and its foals. The relation is
-- symmetric (if B is in A's family, A is in B's), which racing_notify relies on.
create or replace function public.racing_relatives(p_horse uuid) returns setof uuid
language sql stable set search_path = '' as $$
  select x.id from public.racing_horses h join public.racing_horses x on lower(x.name) = lower(h.sire)
    where h.id = p_horse and h.sire <> '' and x.id <> h.id
  union
  select x.id from public.racing_horses h join public.racing_horses x on lower(x.name) = lower(h.dam)
    where h.id = p_horse and h.dam <> '' and x.id <> h.id
  union
  select x.id from public.racing_horses h join public.racing_horses x on x.dam <> '' and lower(x.dam) = lower(h.dam)
    where h.id = p_horse and h.dam <> '' and x.id <> h.id
  union
  select x.id from public.racing_horses h join public.racing_horses x on x.sire <> '' and lower(x.sire) = lower(h.name)
    where h.id = p_horse and x.id <> h.id
  union
  select x.id from public.racing_horses h join public.racing_horses x on x.dam <> '' and lower(x.dam) = lower(h.name)
    where h.id = p_horse and x.id <> h.id
$$;

-- Which racing alerts this person wants saved. No saved choice = all on (following something means you want to hear).
create or replace function public.racing_alert_wanted(p_user uuid, p_kind text) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select case p_kind
      when 'race_entry' then p.entry_alerts when 'race_scratch' then p.entry_alerts
      when 'race_result' then p.result_alerts when 'workout' then p.workout_alerts else false end
    from public.racing_preferences p where p.user_id = p_user), true)
$$;

-- ---------- Follow / unfollow / list ----------
create or replace function public.racing_follow_state(p_user uuid, p_target uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'horse', exists (select 1 from public.racing_follows where user_id = p_user and kind = 'horse' and horse_id = p_target),
    'family', exists (select 1 from public.racing_follows where user_id = p_user and kind = 'family' and horse_id = p_target),
    'person', exists (select 1 from public.racing_follows where user_id = p_user and kind = 'person' and person_id = p_target),
    'relatives', (select count(*) from public.racing_relatives(p_target) x(id) where public.racing_horse_public(x.id)),
    'total', (select count(*) from public.racing_follows where user_id = p_user))
$$;

create or replace function public.racing_follow_set(p_user uuid, p_kind text, p_target uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind is null or p_kind not in ('horse', 'family', 'person') then raise exception 'invalid_kind'; end if;
  if p_on then
    if (p_kind = 'person' and not public.racing_person_public(p_target))
       or (p_kind <> 'person' and not public.racing_horse_public(p_target)) then
      raise exception 'unknown_target';
    end if;
    if not exists (select 1 from public.racing_follows where user_id = p_user and kind = p_kind
                     and coalesce(horse_id, person_id) = p_target) then
      if (select count(*) from public.racing_follows where user_id = p_user) >= 300 then
        raise exception 'too_many_follows';
      end if;
      insert into public.racing_follows (user_id, kind, horse_id, person_id)
      values (p_user, p_kind, case when p_kind <> 'person' then p_target end, case when p_kind = 'person' then p_target end)
      on conflict do nothing;
    end if;
  else
    delete from public.racing_follows where user_id = p_user and kind = p_kind and coalesce(horse_id, person_id) = p_target;
  end if;
  return public.racing_follow_state(p_user, p_target);
end $$;

-- The next published entry (p_upcoming) or the latest official result for what a follow covers.
create or replace function public.racing_follow_start(f public.racing_follows, p_upcoming boolean) returns jsonb
language sql stable set search_path = '' as $$
  select public.racing_start_json(rn)
  from public.racing_runners rn
  join public.racing_races r on r.id = rn.race_id
  join public.racing_days d on d.id = r.day_id
  where public.racing_day_public(d) and not rn.scratched
    and case f.kind
      when 'horse' then rn.horse_id = f.horse_id
      when 'person' then f.person_id in (rn.jockey_id, rn.trainer_id, rn.owner_id)
      else rn.horse_id in (select public.racing_relatives(f.horse_id)) end
    and case when p_upcoming then r.status = 'scheduled' and d.race_date >= current_date else r.status = 'official' end
  order by case when p_upcoming then d.race_date end asc, case when p_upcoming then r.race_number end asc,
    case when not p_upcoming then d.race_date end desc, case when not p_upcoming then r.race_number end desc
  limit 1
$$;

create or replace function public.racing_follows_list(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', f.id, 'kind', f.kind, 'since', f.created_at,
      'horse', (select jsonb_build_object('id', h.id, 'name', h.name, 'country', h.country, 'foaled', h.foaled_year,
                  'sex', h.sex, 'sire', h.sire, 'dam', h.dam, 'breed', h.breed)
                from public.racing_horses h where h.id = f.horse_id),
      'person', case when f.person_id is not null then public.racing_person_ref(f.person_id) end,
      'relatives', case when f.kind = 'family' then (select count(*) from public.racing_relatives(f.horse_id) x(id)
                                                      where public.racing_horse_public(x.id)) end,
      'next', public.racing_follow_start(f, true),
      'last', public.racing_follow_start(f, false))
    order by f.created_at desc), '[]'::jsonb)
  from public.racing_follows f where f.user_id = p_user
$$;

-- ---------- Alerts ----------
--   p_event 'day'      p_ref = race day:  entries for every runner still in (published days only)
--           'race'     p_ref = race:      results, once the race is official
--           'scratch'  p_ref = runner:    that runner was scratched
--           'workout'  p_ref = workout:   a published workout
-- Saves at most one alert per person per runner/workout, choosing the closest reason (the horse itself, then a
-- person you follow, then the family). Returns { alerts: [chat_alert_out + userId], targets: [push devices] }.
create or replace function public.racing_notify(p_event text, p_ref uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_kind text; ids uuid[]; alerts jsonb;
begin
  v_kind := case p_event when 'day' then 'race_entry' when 'race' then 'race_result'
    when 'scratch' then 'race_scratch' when 'workout' then 'workout' end;
  if v_kind is null or p_ref is null then raise exception 'invalid_event'; end if;

  with ev as (
    -- Entries on a published card, from yesterday on.
    select rn.id ref_id, h.id horse_id, h.name horse_name, rn.jockey_id, rn.trainer_id, rn.owner_id,
      h.name || ' is entered' headline,
      'Race ' || r.race_number || ' · ' || t.name || ' · ' || to_char(d.race_date, 'Dy, Mon FMDD')
        || case when r.post_time <> '' then ' · post ' || r.post_time else '' end details,
      '/racing/races/' || r.id link
    from public.racing_days d join public.racing_tracks t on t.id = d.track_id
    join public.racing_races r on r.day_id = d.id
    join public.racing_runners rn on rn.race_id = r.id join public.racing_horses h on h.id = rn.horse_id
    where p_event = 'day' and d.id = p_ref and d.status = 'published' and d.race_date >= current_date - 1
      and r.status <> 'cancelled' and not rn.scratched
    union all
    -- Results once a race is official, for the last week.
    select rn.id, h.id, h.name, rn.jockey_id, rn.trainer_id, rn.owner_id,
      h.name || case when rn.finish_position = 1 then ' won' else ' finished ' || public.racing_ordinal(rn.finish_position) end,
      'Race ' || r.race_number || ' · ' || t.name || ' · ' || to_char(d.race_date, 'Dy, Mon FMDD') || ' · '
        || (select count(*) from public.racing_runners x where x.race_id = r.id and not x.scratched) || ' ran',
      '/racing/races/' || r.id
    from public.racing_races r join public.racing_days d on d.id = r.day_id
    join public.racing_tracks t on t.id = d.track_id
    join public.racing_runners rn on rn.race_id = r.id join public.racing_horses h on h.id = rn.horse_id
    where p_event = 'race' and r.id = p_ref and r.status = 'official' and d.status = 'published'
      and d.race_date >= current_date - 7 and not rn.scratched and rn.finish_position is not null
    union all
    -- A scratch on a published card.
    select rn.id, h.id, h.name, rn.jockey_id, rn.trainer_id, rn.owner_id,
      h.name || ' was scratched',
      'Race ' || r.race_number || ' · ' || t.name || ' · ' || to_char(d.race_date, 'Dy, Mon FMDD')
        || case when rn.scratch_reason <> '' then ' · ' || rn.scratch_reason else '' end,
      '/racing/races/' || r.id
    from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
    join public.racing_days d on d.id = r.day_id join public.racing_tracks t on t.id = d.track_id
    join public.racing_horses h on h.id = rn.horse_id
    where p_event = 'scratch' and rn.id = p_ref and rn.scratched and d.status = 'published'
      and d.race_date >= current_date - 1
    union all
    -- A published workout, for the last week.
    select w.id, h.id, h.name, null::uuid, null::uuid, null::uuid,
      h.name || ' worked ' || public.racing_distance_label(w.distance_value, w.distance_unit) || ' in '
        || public.racing_time_label(w.time_seconds),
      t.name || ' · ' || to_char(w.work_date, 'Dy, Mon FMDD')
        || case when w.rank is not null and w.rank_of is not null then ' · ' || w.rank || ' of ' || w.rank_of else '' end,
      '/racing/horses/' || h.id
    from public.racing_workouts w join public.racing_horses h on h.id = w.horse_id
    join public.racing_tracks t on t.id = w.track_id
    where p_event = 'workout' and w.id = p_ref and w.status = 'published' and w.work_date >= current_date - 7
  ),
  hits as (
    select f.user_id, ev.*, 1 prio, '' reason
    from ev join public.racing_follows f on f.kind = 'horse' and f.horse_id = ev.horse_id
    union all
    select f.user_id, ev.*, 2, p.name || ' (' || p.kind || ')'
    from ev join public.racing_follows f on f.kind = 'person' and f.person_id in (ev.jockey_id, ev.trainer_id, ev.owner_id)
    join public.racing_people p on p.id = f.person_id
    union all
    select f.user_id, ev.*, 3, 'Family of ' || fh.name
    from ev cross join lateral public.racing_relatives(ev.horse_id) rel(id)
    join public.racing_follows f on f.kind = 'family' and f.horse_id = rel.id
    join public.racing_horses fh on fh.id = f.horse_id
  ),
  best as (
    select distinct on (user_id, ref_id) * from hits
    where public.racing_alert_wanted(user_id, v_kind)
    order by user_id, ref_id, prio
  ),
  saved as (
    insert into public.chat_alerts (user_id, kind, message_id, actor_name, chat_title, body, link)
    select user_id, v_kind, ref_id, left(horse_name, 120), left(headline, 120),
      left(details || case when reason <> '' then ' · ' || reason else '' end, 300), link
    from best
    on conflict do nothing
    returning id
  )
  select coalesce(array_agg(id), '{}') into ids from saved;

  if cardinality(ids) = 0 then return jsonb_build_object('alerts', '[]'::jsonb, 'targets', '[]'::jsonb); end if;

  -- Keep each person's list short, as chat alerts do.
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
    'chat_alert_out(public.chat_alerts)', 'chat_alert_allowed(public.notification_settings, text)',
    'chat_alerts_list(uuid, timestamptz, integer, boolean)', 'racing_ordinal(integer)', 'racing_horse_public(uuid)',
    'racing_person_public(uuid)', 'racing_relatives(uuid)', 'racing_alert_wanted(uuid, text)',
    'racing_follow_state(uuid, uuid)', 'racing_follow_set(uuid, text, uuid, boolean)',
    'racing_follow_start(public.racing_follows, boolean)', 'racing_follows_list(uuid)', 'racing_notify(text, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
