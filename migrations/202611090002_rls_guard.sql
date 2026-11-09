-- LOCAL, OPTIONAL extra guard. Apply after 202611090001_account_foundation.sql.
-- Any table created later in `public` gets row level security switched on automatically,
-- so a forgotten "enable row level security" line can never expose a table.
-- If the SQL editor rejects event triggers on your plan, skip this file: the default
-- privileges in 202611090001 already deny browser roles on new tables.
begin;
create function public.stayblz_enforce_rls() returns event_trigger
language plpgsql security definer set search_path = '' as $$
declare item record;
begin
  for item in select * from pg_event_trigger_ddl_commands()
    where object_type = 'table' and schema_name = 'public'
  loop
    execute format('alter table %s enable row level security', item.object_identity);
  end loop;
end $$;
revoke all on function public.stayblz_enforce_rls() from public, anon, authenticated, service_role;
create event trigger stayblz_enforce_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.stayblz_enforce_rls();
commit;
