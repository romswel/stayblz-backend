-- LOCAL: apply after 202611010001_site_racing_records.sql. No legacy backfill.
begin;
create table public.member_stables (
 id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 100),
 owner_id uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create table public.stable_memberships (
 stable_id uuid not null references public.member_stables(id) on delete cascade,
 user_id uuid not null references auth.users(id), display_name text not null,
 role text not null check(role in ('owner','manager','member')), primary key(stable_id,user_id)
);
create index stable_memberships_user on public.stable_memberships(user_id,stable_id);
create table public.stable_invitations (
 id uuid primary key default gen_random_uuid(), stable_id uuid not null references public.member_stables(id) on delete cascade,
 email text not null, role text not null check(role in ('manager','member')), token_hash text not null unique,
 invited_by uuid not null references auth.users(id), expires_at timestamptz not null default now()+interval '7 days',
 accepted_at timestamptz, created_at timestamptz not null default now()
);
create table public.member_horses (
 id uuid primary key default gen_random_uuid(), stable_id uuid not null references public.member_stables(id) on delete cascade,
 inventory jsonb not null check(jsonb_typeof(inventory)='object'), tracking jsonb not null check(jsonb_typeof(tracking)='object'),
 created_by uuid not null references auth.users(id), created_at timestamptz not null default now()
);
create index member_horses_stable on public.member_horses(stable_id,id);
create table public.member_posts (
 id uuid primary key default gen_random_uuid(), stable_id uuid not null references public.member_stables(id) on delete cascade,
 author_id uuid not null references auth.users(id), author text not null, role text not null,
 body text not null check(length(btrim(body)) between 1 and 500), created_at timestamptz not null default now()
);
create index member_posts_stable on public.member_posts(stable_id,created_at desc,id desc);
create table public.member_conversations (
 id uuid primary key default gen_random_uuid(), stable_id uuid not null references public.member_stables(id) on delete cascade,
 title text not null check(length(btrim(title)) between 1 and 120), member_ids uuid[] not null check(cardinality(member_ids) between 1 and 30),
 last_message text not null default '', last_message_at timestamptz not null default now(), created_by uuid not null references auth.users(id)
);
create index member_conversations_stable on public.member_conversations(stable_id,last_message_at desc);
create table public.member_messages (
 id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.member_conversations(id) on delete cascade,
 sender_id uuid not null references auth.users(id), sender text not null,
 body text not null check(length(btrim(body)) between 1 and 4000), sent_at timestamptz not null default now(),
 client_id uuid not null, unique(conversation_id,sender_id,client_id)
);
create index member_messages_conversation on public.member_messages(conversation_id,sent_at desc,id desc);
create table public.member_watchlist (
 user_id uuid not null references auth.users(id), record_id uuid not null references public.site_racing_records(id) on delete cascade,
 name text not null, created_at timestamptz not null default now(), primary key(user_id,record_id)
);

-- The browser never talks to these tables. The verified backend supplies identity
-- and checks current membership. There is deliberately no platform-admin bypass.
do $$ declare t text; begin
 foreach t in array array['member_stables','stable_memberships','stable_invitations','member_horses','member_posts','member_conversations','member_messages','member_watchlist'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant select, insert, update, delete on public.%I to service_role',t);
 end loop;
end $$;

create function public.create_member_stable(p_user uuid,p_name text,p_display text) returns uuid
language plpgsql security definer set search_path='' as $$
declare sid uuid;
begin
 -- Serialize account setup so concurrent requests cannot bypass the stable limit.
 perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
 if (select count(*) from public.member_stables where owner_id=p_user)>=10 then raise exception 'stable_limit'; end if;
 insert into public.member_stables(name,owner_id) values(btrim(p_name),p_user) returning id into sid;
 insert into public.stable_memberships(stable_id,user_id,display_name,role) values(sid,p_user,p_display,'owner');
 return sid;
end $$;

create function public.accept_stable_invitation(p_user uuid,p_email text,p_display text,p_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare invitation public.stable_invitations; inviter_role text;
begin
 select * into invitation from public.stable_invitations where token_hash=p_hash for update;
 if not found or invitation.accepted_at is not null or invitation.expires_at<=now() or lower(invitation.email)<>lower(p_email) then raise exception 'invalid_invitation'; end if;
 select role into inviter_role from public.stable_memberships where stable_id=invitation.stable_id and user_id=invitation.invited_by for share;
 if inviter_role is null or inviter_role not in ('owner','manager') or (invitation.role='manager' and inviter_role<>'owner') then raise exception 'invalid_invitation'; end if;
 insert into public.stable_memberships(stable_id,user_id,display_name,role) values(invitation.stable_id,p_user,p_display,invitation.role) on conflict(stable_id,user_id) do nothing;
 update public.stable_invitations set accepted_at=now() where id=invitation.id;
 return invitation.stable_id;
end $$;

create function public.create_member_conversation(p_user uuid,p_stable uuid,p_title text,p_members uuid[]) returns public.member_conversations
language plpgsql security definer set search_path='' as $$
declare ids uuid[]; result public.member_conversations;
begin
 select array_agg(distinct v) into ids from unnest(array_append(p_members,p_user)) v;
 perform 1 from public.stable_memberships where stable_id=p_stable and user_id=any(ids) for share;
 if cardinality(ids)>30 or exists(select 1 from unnest(ids) v where not exists(select 1 from public.stable_memberships m where m.stable_id=p_stable and m.user_id=v)) then raise exception 'invalid_participants'; end if;
 insert into public.member_conversations(stable_id,title,member_ids,created_by) values(p_stable,btrim(p_title),ids,p_user) returning * into result;
 return result;
end $$;

create function public.send_member_message(p_user uuid,p_stable uuid,p_conversation uuid,p_body text,p_client uuid) returns public.member_messages
language plpgsql security definer set search_path='' as $$
declare display text; result public.member_messages;
begin
 select display_name into display from public.stable_memberships where stable_id=p_stable and user_id=p_user for share;
 if not found then raise exception 'not_a_participant'; end if;
 perform 1 from public.member_conversations where id=p_conversation and stable_id=p_stable and p_user=any(member_ids) for update;
 if not found then raise exception 'not_a_participant'; end if;
 if length(btrim(p_body)) not between 1 and 4000 then raise exception 'invalid_message'; end if;
 select * into result from public.member_messages where conversation_id=p_conversation and sender_id=p_user and client_id=p_client;
 if found then return result; end if;
 insert into public.member_messages(conversation_id,sender_id,sender,body,client_id) values(p_conversation,p_user,display,btrim(p_body),p_client) returning * into result;
 update public.member_conversations set last_message=left(result.body,200),last_message_at=result.sent_at where id=p_conversation;
 return result;
end $$;

revoke all on function public.create_member_stable(uuid,text,text),public.accept_stable_invitation(uuid,text,text,text),public.create_member_conversation(uuid,uuid,text,uuid[]),public.send_member_message(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.create_member_stable(uuid,text,text),public.accept_stable_invitation(uuid,text,text,text),public.create_member_conversation(uuid,uuid,text,uuid[]),public.send_member_message(uuid,uuid,uuid,text,uuid) to service_role;
notify pgrst, 'reload schema';
commit;
