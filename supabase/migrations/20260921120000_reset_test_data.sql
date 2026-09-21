-- reset_test_data(): wipe every row from every base table in public.
-- Test-rounds utility (service-role only). Returns the per-table row counts
-- as they were just before the wipe, so every reset is self-reporting:
--   select public.reset_test_data();
--   -> {"wiped": {"leads": 2, "messages": 55, ...}, "at": "..."}
--
-- Dynamic over pg_tables so new tables are covered automatically. If a
-- reference/config table ever appears, add it to the exclusion list below.

create or replace function public.reset_test_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t record;
  counts jsonb := '{}'::jsonb;
  n bigint;
begin
  for t in
    select tablename from pg_tables
    where schemaname = 'public'
    -- exclusions (none today): and tablename not in ('some_reference_table')
    order by tablename
  loop
    execute format('select count(*) from public.%I', t.tablename) into n;
    counts := counts || jsonb_build_object(t.tablename, n);
  end loop;

  for t in
    select tablename from pg_tables
    where schemaname = 'public'
  loop
    execute format('truncate table public.%I restart identity cascade', t.tablename);
  end loop;

  return jsonb_build_object('wiped', counts, 'at', now());
end;
$$;

revoke all on function public.reset_test_data() from public, anon, authenticated;
grant execute on function public.reset_test_data() to service_role;
