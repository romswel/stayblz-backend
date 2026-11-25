-- Stayblz Chat: scheduled updates (user request 2026-11-25).
--
-- Up to three notes per person. Each one is sent once a day, at its own Philippine time (Asia/Manila, UTC+8, no
-- daylight saving; defaults 9:00 PM, 1:00 AM and 5:00 AM), into a chat that person is in, through the normal chat send
-- (chat_send), so it arrives like any message they type. lib/chatSchedule.ts checks every minute while the API is awake.
--
-- Private: only accounts listed in chat_schedule_access can see or use it (everyone else gets a plain "not found").
-- Grant it in the SQL editor:   select public.set_chat_schedule_access('person@example.com');
-- Take it away:                 select public.set_chat_schedule_access('person@example.com', false);
--
-- A send happens at most once per note and time: chat_schedule_claim marks the time as handled before anything is
-- sent (two servers awake at once can't both send), and the chat message's client id is fixed per note + time.
-- Safe to run more than once.
begin;

create table if not exists public.chat_schedule_access (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  added_at timestamptz not null default now()
);

create table if not exists public.chat_scheduled_notes (
  account_id uuid not null references public.accounts(id) on delete cascade,
  slot smallint not null check (slot between 1 and 3),
  body text not null default '' check (char_length(body) <= 4000),
  enabled boolean not null default true,
  -- Time of day in the Philippines.
  send_at time not null,
  -- Where it goes: a personal chat, or a team chat of one stable.
  chat_kind text check (chat_kind in ('personal', 'team')),
  chat_id uuid,
  stable_id uuid,
  -- false: the note empties after it is sent (yesterday's update never goes twice). true: it repeats every day.
  keep_after_send boolean not null default false,
  -- The scheduled time this note last dealt with (sent, empty, missed, failed, or skipped ahead of time).
  handled_due timestamptz,
  updated_at timestamptz not null default now(),
  primary key (account_id, slot),
  check ((chat_kind is null and chat_id is null and stable_id is null)
      or (chat_kind = 'personal' and chat_id is not null and stable_id is null)
      or (chat_kind = 'team' and chat_id is not null and stable_id is not null))
);

-- What happened at each time: sent, empty (nothing written), missed (the API was asleep), failed (with the reason).
create table if not exists public.chat_scheduled_log (
  id bigint generated always as identity primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  slot smallint not null check (slot between 1 and 3),
  -- null = "Send now".
  due_at timestamptz,
  status text not null check (status in ('sent', 'empty', 'missed', 'failed')),
  chat_kind text,
  chat_id uuid,
  stable_id uuid,
  message_id uuid,
  preview text check (char_length(preview) <= 200),
  detail text check (char_length(detail) <= 300),
  created_at timestamptz not null default now()
);
create index if not exists chat_scheduled_log_account on public.chat_scheduled_log (account_id, created_at desc);

alter table public.chat_schedule_access enable row level security;
alter table public.chat_scheduled_notes enable row level security;
alter table public.chat_scheduled_log enable row level security;
revoke all on public.chat_schedule_access, public.chat_scheduled_notes, public.chat_scheduled_log
  from public, anon, authenticated;
-- Only the API (service role) reads and writes them.
grant select, insert, update, delete on public.chat_schedule_access, public.chat_scheduled_notes, public.chat_scheduled_log
  to service_role;
do $$ begin
  execute format('grant usage, select on sequence %s to service_role', pg_get_serial_sequence('public.chat_scheduled_log', 'id'));
end $$;

-- Marks `p_due` as handled for one note and returns the note, or null when it was already handled (by this server or
-- another one). Called before sending, so a time is never sent twice.
create or replace function public.chat_schedule_claim(p_account uuid, p_slot smallint, p_due timestamptz) returns jsonb
language sql security definer set search_path = '' as $$
  update public.chat_scheduled_notes n set handled_due = p_due
  where n.account_id = p_account and n.slot = p_slot and (n.handled_due is null or n.handled_due < p_due)
    and exists (select 1 from public.chat_schedule_access a where a.account_id = p_account)
  returning to_jsonb(n.*);
$$;
revoke all on function public.chat_schedule_claim(uuid, smallint, timestamptz) from public, anon, authenticated;
grant execute on function public.chat_schedule_claim(uuid, smallint, timestamptz) to service_role;

-- SQL editor only (the API's key can't call it, so a leaked key can't hand out access).
create or replace function public.set_chat_schedule_access(p_email text, p_allowed boolean default true) returns text
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  select id into target from public.accounts where lower(email) = lower(btrim(p_email));
  if target is null then raise exception 'No Stayblz account uses %', p_email; end if;
  if p_allowed then
    insert into public.chat_schedule_access (account_id) values (target) on conflict do nothing;
    return 'Scheduled updates turned on for ' || p_email;
  end if;
  delete from public.chat_schedule_access where account_id = target;
  delete from public.chat_scheduled_notes where account_id = target;
  return 'Scheduled updates turned off for ' || p_email || ' (their notes were removed)';
end;
$$;
revoke all on function public.set_chat_schedule_access(text, boolean) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
