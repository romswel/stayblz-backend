-- Applied with the v0.19 release (2026-11-19). Safe to re-run; replaces read functions only, no data changes.
--
-- Prize money in more than one currency: racing now holds British (GBP), Irish/French (EUR) and Hong Kong (HKD) races
-- as well as US ones. Starts carry their race's currency; totals (a horse's or person's record, leaders) say which
-- currency they are in, or null when they mix currencies (the page then doesn't show a meaningless sum).

begin;

create or replace function public.racing_start_json(rn public.racing_runners) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'runnerId', rn.id, 'raceId', r.id, 'dayId', d.id, 'date', d.race_date, 'track', t.name, 'trackCode', t.code,
    'race', r.race_number, 'raceName', r.name, 'type', r.race_type, 'grade', r.grade, 'status', r.status,
    'distance', public.racing_distance_label(r.distance_value, r.distance_unit), 'surface', r.surface,
    'horse', jsonb_build_object('id', h.id, 'name', h.name),
    'jockey', public.racing_person_ref(rn.jockey_id), 'trainer', public.racing_person_ref(rn.trainer_id),
    'owner', public.racing_person_ref(rn.owner_id), 'program', rn.program_number,
    'scratched', rn.scratched,
    'finish', case when r.status = 'official' then rn.finish_position end,
    'lengths', case when r.status = 'official' then rn.beaten_lengths end,
    'odds', case when r.status = 'official' then rn.final_odds end,
    'earnings', case when r.status = 'official' then rn.earnings end, 'currency', r.currency,
    'field', (select count(*) from public.racing_runners x where x.race_id = r.id and not x.scratched))
  from public.racing_races r
  join public.racing_days d on d.id = r.day_id
  join public.racing_tracks t on t.id = d.track_id
  join public.racing_horses h on h.id = rn.horse_id
  where r.id = rn.race_id
$$;

create or replace function public.racing_stats_json(p_runner_ids uuid[]) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('starts', count(*), 'wins', count(*) filter (where rn.finish_position = 1),
    'places', count(*) filter (where rn.finish_position = 2), 'shows', count(*) filter (where rn.finish_position = 3),
    'earnings', coalesce(sum(rn.earnings), 0),
    -- The prize money's currency; null when it was won in more than one (the total then means nothing).
    'currency', case when count(distinct r.currency) filter (where rn.earnings is not null) > 1 then null
                     else coalesce(min(r.currency) filter (where rn.earnings is not null), 'USD') end)
  from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
  where rn.id = any (p_runner_ids) and r.status = 'official' and not rn.scratched
$$;

create or replace function public.racing_leaders(p_role text, p_year integer, p_breed text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; lim integer := least(greatest(coalesce(p_limit, 25), 1), 100);
begin
  if p_role not in ('jockey', 'trainer', 'owner', 'horse') then raise exception 'invalid_role'; end if;
  with starts as (
    select case p_role when 'jockey' then rn.jockey_id when 'trainer' then rn.trainer_id
        when 'owner' then rn.owner_id else rn.horse_id end who,
      rn.finish_position f, coalesce(rn.earnings, 0) e, case when rn.earnings is not null then r.currency end c
    from public.racing_runners rn join public.racing_races r on r.id = rn.race_id
    join public.racing_days d on d.id = r.day_id
    where public.racing_day_public(d) and r.status = 'official' and not rn.scratched
      and (p_year is null or extract(year from d.race_date) = p_year)
      and (p_breed is null or r.breed = p_breed)
  ), agg as (
    select who, count(*) starts, count(*) filter (where f = 1) wins, count(*) filter (where f = 2) places,
      count(*) filter (where f = 3) shows, sum(e) earnings,
      case when count(distinct c) > 1 then null else coalesce(min(c), 'USD') end currency
    from starts where who is not null group by who
  ), ranked as (
    select a.*, coalesce(p.name, h.name) as who_name from agg a
    left join public.racing_people p on p.id = a.who left join public.racing_horses h on h.id = a.who
    order by a.wins desc, a.earnings desc, a.places desc, a.shows desc, who_name limit lim
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', a.who, 'name', a.who_name, 'starts', a.starts,
      'wins', a.wins, 'places', a.places, 'shows', a.shows, 'earnings', a.earnings, 'currency', a.currency,
      'winPct', round(100.0 * a.wins / a.starts))
    order by a.wins desc, a.earnings desc, a.places desc, a.shows desc, a.who_name), '[]'::jsonb)
  into result from ranked a;
  return result;
end $$;

notify pgrst, 'reload schema';
commit;
