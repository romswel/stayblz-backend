-- LOCAL ONLY. Apply after published records and member workspace migrations.
-- Personal accounts do not require stable membership. No legacy data is moved.
begin;
alter table public.member_watchlist add column kind text not null default 'horses'
 check(kind in ('horses','jockeys','trainers'));

create table public.racing_notes (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
 title text not null check(length(btrim(title)) between 1 and 120),
 body text not null check(length(body)<=4000), created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index racing_notes_user on public.racing_notes(user_id,updated_at desc,id);
create table public.racing_preferences (
 user_id uuid primary key references auth.users(id), entry_alerts boolean not null default false,
 workout_alerts boolean not null default false,result_alerts boolean not null default false,
 email_enabled boolean not null default false, updated_at timestamptz not null default now()
);
create table public.personal_conversations (
 id uuid primary key default gen_random_uuid(),title text not null check(length(btrim(title)) between 1 and 120),
 created_by uuid not null references auth.users(id),member_ids uuid[] not null check(cardinality(member_ids) between 1 and 30),
 member_names jsonb not null check(jsonb_typeof(member_names)='object'),
 last_message text not null default '', last_message_at timestamptz not null default now()
);
create index personal_conversations_members on public.personal_conversations using gin(member_ids);
create table public.personal_messages (
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.personal_conversations(id) on delete cascade,
 sender_id uuid not null references auth.users(id), sender text not null,
 body text not null check(length(btrim(body)) between 1 and 4000), sent_at timestamptz not null default now(),
 client_id uuid not null,unique(conversation_id,sender_id,client_id)
);
create index personal_messages_history on public.personal_messages(conversation_id,sent_at desc,id desc);
create table public.personal_invitations (
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references public.personal_conversations(id) on delete cascade,
 email text not null,token_hash text not null unique,invited_by uuid not null references auth.users(id),
 expires_at timestamptz not null default now()+interval '7 days',accepted_at timestamptz,created_at timestamptz not null default now()
);
do $$ declare t text;begin
 foreach t in array array['racing_notes','racing_preferences','personal_conversations','personal_messages','personal_invitations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;

create function public.accept_personal_invitation(p_user uuid,p_email text,p_display text,p_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare invitation public.personal_invitations; conversation public.personal_conversations;
begin
 select * into invitation from public.personal_invitations where token_hash=p_hash for update;
 if not found or invitation.accepted_at is not null or invitation.expires_at<=now() or lower(invitation.email)<>lower(p_email) then raise exception 'invalid_invitation';end if;
 select * into conversation from public.personal_conversations where id=invitation.conversation_id for update;
 if not found or conversation.created_by<>invitation.invited_by then raise exception 'invalid_invitation';end if;
 if not(p_user=any(conversation.member_ids)) then
  if cardinality(conversation.member_ids)>=30 then raise exception 'conversation_full';end if;
  update public.personal_conversations set member_ids=array_append(member_ids,p_user),member_names=member_names||jsonb_build_object(p_user::text,p_display) where id=conversation.id;
 end if;
 update public.personal_invitations set accepted_at=now() where id=invitation.id;
 return conversation.id;
end $$;
create function public.send_personal_message(p_user uuid,p_conversation uuid,p_display text,p_body text,p_client uuid) returns public.personal_messages
language plpgsql security definer set search_path='' as $$
declare result public.personal_messages;
begin
 perform 1 from public.personal_conversations where id=p_conversation and p_user=any(member_ids) for update;
 if not found then raise exception 'not_a_participant';end if;
 if length(btrim(p_body)) not between 1 and 4000 then raise exception 'invalid_message';end if;
 select * into result from public.personal_messages where conversation_id=p_conversation and sender_id=p_user and client_id=p_client;
 if found then return result;end if;
 insert into public.personal_messages(conversation_id,sender_id,sender,body,client_id) values(p_conversation,p_user,p_display,btrim(p_body),p_client) returning * into result;
 update public.personal_conversations set last_message=left(result.body,200),last_message_at=result.sent_at,member_names=member_names||jsonb_build_object(p_user::text,p_display) where id=p_conversation;
 return result;
end $$;
revoke all on function public.accept_personal_invitation(uuid,text,text,text),public.send_personal_message(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.accept_personal_invitation(uuid,text,text,text),public.send_personal_message(uuid,uuid,text,text,uuid) to service_role;
notify pgrst,'reload schema';
commit;
