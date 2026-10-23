-- weddingSync :: 006 verify
-- Requires 001-005. Run LAST.
--
-- READ-ONLY. Creates, alters and drops nothing, so it provokes no
-- destructive-operation warning and no false "table without RLS" warning
-- from the Supabase SQL Editor. An earlier version built a TEMP table
-- named _check; temp tables live in pg_temp and are unreachable from
-- PostgREST, but the linter cannot tell that and warns about it. A tool
-- reporting a security problem that does not exist is worse than no tool.
--
-- The eleven checks are computed inside one plpgsql block, stashed in a
-- session setting for display, and raised as one error listing EVERY
-- failure. Run 1-005 (and 007 on an older database) first; this file
-- changes nothing.
--
-- Reading the output: look at the `result` column, and note that failures
-- sort to the TOP. A clean run is 12 rows (11 checks + a summary), all
-- PASS, ending with no error.

do $$
declare
  v_results jsonb;
begin
  v_results := jsonb_build_array(

    -- 1. RLS enabled on every table in the exposed schema
    jsonb_build_object(
      'seq', 1,
      'name', 'RLS enabled on all tables',
      'ok', not exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and not c.relrowsecurity),
      'detail', case when exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and not c.relrowsecurity)
        then 'RLS DISABLED on: ' || (
          select string_agg(c.relname, ', ' order by c.relname)
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and not c.relrowsecurity)
        else 'all public tables' end),

    -- 2. anon role has NO privileges. The anon key ships inside the APK,
    -- so this is the line between the guest list and the public internet.
    jsonb_build_object(
      'seq', 2,
      'name', 'anon has zero privileges',
      'ok', not exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and ( has_table_privilege('anon', c.oid, 'select')
             or has_table_privilege('anon', c.oid, 'insert')
             or has_table_privilege('anon', c.oid, 'update')
             or has_table_privilege('anon', c.oid, 'delete') )),
      'detail', case when exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and ( has_table_privilege('anon', c.oid, 'select')
             or has_table_privilege('anon', c.oid, 'insert')
             or has_table_privilege('anon', c.oid, 'update')
             or has_table_privilege('anon', c.oid, 'delete') ))
        then 'anon can reach: ' || coalesce((
          -- enumerate ANY privilege, not just SELECT, otherwise an
          -- UPDATE-only leak yields a NULL detail and vanishes from the report
          select string_agg(relname, ', ' order by relname) from (
            select c.relname
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
              and ( has_table_privilege('anon', c.oid, 'select')
                 or has_table_privilege('anon', c.oid, 'insert')
                 or has_table_privilege('anon', c.oid, 'update')
                 or has_table_privilege('anon', c.oid, 'delete') )) s)
          , 'unknown')
        else 'anon blocked on everything' end),

    -- 3. authenticated has NO delete grant: soft delete is enforced by the
    --    database, and the audit log cannot be erased
    jsonb_build_object(
      'seq', 3,
      'name', 'no hard deletes possible',
      'ok', not exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and has_table_privilege('authenticated', c.oid, 'delete')),
      'detail', case when exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
          and has_table_privilege('authenticated', c.oid, 'delete'))
        then 'authenticated can hard-delete: ' || (
          select string_agg(c.relname, ', ' order by c.relname)
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r'
            and has_table_privilege('authenticated', c.oid, 'delete'))
        else 'authenticated has no DELETE on any table' end),

    -- 4. activity_log readable but not writable by clients; the only
    --    writer is the SECURITY DEFINER trigger. cmd renders as a word.
    jsonb_build_object(
      'seq', 4,
      'name', 'activity_log is trigger-only',
      'ok', not exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'activity_log'
          and cmd <> 'SELECT'),
      'detail', case when exists (
        select 1 from pg_policies
        where schemaname = 'public' and tablename = 'activity_log'
          and cmd <> 'SELECT')
        then 'write policy: ' || (
          select string_agg(roles::text || ':' || cmd, ', ')
          from pg_policies
          where schemaname = 'public' and tablename = 'activity_log'
            and cmd <> 'SELECT')
        else 'SELECT-only, writes come from triggers' end),

    -- 5. the tables the app writes to must actually be writable. A missing
    --    grant fails at 42501 BEFORE RLS is evaluated, so it stays invisible
    --    until the app tries the write.
    jsonb_build_object(
      'seq', 5,
      'name', 'app-writable tables are writable',
      'ok', (select count(*) = 0 from unnest(
               array['events','profiles','guests','guest_events','todos']) t
               where not ( has_table_privilege('authenticated', format('public.%I', t), 'insert')
                       and has_table_privilege('authenticated', format('public.%I', t), 'update')
                       and has_table_privilege('authenticated', format('public.%I', t), 'select') )),
      'detail', case when exists (
        select 1 from unnest(array['events','profiles','guests','guest_events','todos']) t
        where not ( has_table_privilege('authenticated', format('public.%I', t), 'insert')
                and has_table_privilege('authenticated', format('public.%I', t), 'update')
                and has_table_privilege('authenticated', format('public.%I', t), 'select') ))
        then 'MISSING grants on: ' || (
          select string_agg(t, ', ' order by t)
          from unnest(array['events','profiles','guests','guest_events','todos']) t
          where not ( has_table_privilege('authenticated', format('public.%I', t), 'insert')
                  and has_table_privilege('authenticated', format('public.%I', t), 'update')
                  and has_table_privilege('authenticated', format('public.%I', t), 'select') ))
        else 'events, profiles, guests, guest_events, todos all writable' end),

    -- 6. audit triggers exist and are SECURITY DEFINER, which is what lets
    --    them write activity_log past its SELECT-only policy
    jsonb_build_object(
      'seq', 6,
      'name', 'audit triggers present',
      'ok', (select count(*) = 3
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('log_guest_activity','log_guest_event_activity','log_todo_activity')
               and p.prosecdef),
      'detail', 'found ' || (select count(*) from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public'
               and p.proname in ('log_guest_activity','log_guest_event_activity','log_todo_activity')
               and p.prosecdef) || ' of 3 SECURITY DEFINER audit functions'),

    -- 7. views and the search function
    jsonb_build_object(
      'seq', 7,
      'name', 'views and search present',
      'ok', (select count(*) = 4 from pg_views
             where schemaname = 'public'
               and viewname in ('event_counts','guest_rollup','card_progress','activity_feed'))
           and (select count(*) = 1 from pg_proc p
                join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'search_guests'),
      'detail', (select count(*) || ' of 4 views, ' || (
                   select count(*) || ' search_guests'
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'search_guests')
                 || ' function'
                 from pg_views where schemaname = 'public'
                   and viewname in ('event_counts','guest_rollup','card_progress','activity_feed'))),

    -- 8. the three events seeded exactly once, no case-duplicates
    jsonb_build_object(
      'seq', 8,
      'name', 'events seeded',
      'ok', (select count(*) from events where deleted_at is null) = 3
            and (select count(*) from events where deleted_at is null and name = 'Faiz Baraat') = 1
            and (select count(*) from events where deleted_at is null and name = 'Moiz Baraat') = 1
            and (select count(*) from events where deleted_at is null and name = 'Walima') = 1,
      'detail', coalesce(
        (select string_agg(name, ', ' order by sort_order)
         from events where deleted_at is null), 'none')),

    -- 9. views return one row per event and search runs. Deliberately does
    --    NOT assert zero guests, so this keeps passing once real data lands.
    jsonb_build_object(
      'seq', 9,
      'name', 'views return data',
      'ok', (select count(*) from event_counts)
              = (select count(*) from events where deleted_at is null)
            and (select count(*) from guest_rollup) = 1
            and (select count(*) from card_progress)
              = (select count(*) from events where deleted_at is null)
            and (select count(*) from search_guests('rza')) >= 0,
      'detail', 'event_counts ' || (select count(*) from event_counts)
                || ', guest_rollup ' || (select count(*) from guest_rollup)
                || ', card_progress ' || (select count(*) from card_progress)),

    -- 10. every writable table needs an actual RLS policy for INSERT and
    --     UPDATE. Check 5 proves the GRANT exists, but a grant with no
    --     policy means RLS denies every row -- the app would appear to
    --     "just not save". This is the difference between a permission
    --     error and a silent no-op.
    jsonb_build_object(
      'seq', 10,
      'name', 'write policies present',
      'ok', (select count(*) = 0 from unnest(
               array['events','profiles','guests','guest_events','todos']) t
               where not exists (
                 select 1 from pg_policies
                 where schemaname = 'public' and tablename = t and cmd = 'INSERT')
                  or not exists (
                 select 1 from pg_policies
                 where schemaname = 'public' and tablename = t and cmd = 'UPDATE')),
      'detail', case when exists (
        select 1 from unnest(array['events','profiles','guests','guest_events','todos']) t
        where not exists (
          select 1 from pg_policies
          where schemaname = 'public' and tablename = t and cmd = 'INSERT')
           or not exists (
          select 1 from pg_policies
          where schemaname = 'public' and tablename = t and cmd = 'UPDATE'))
        then 'no INSERT/UPDATE policy on: ' || (
          select string_agg(t, ', ' order by t)
          from unnest(array['events','profiles','guests','guest_events','todos']) t
          where not exists (
            select 1 from pg_policies
            where schemaname = 'public' and tablename = t and cmd = 'INSERT')
             or not exists (
            select 1 from pg_policies
            where schemaname = 'public' and tablename = t and cmd = 'UPDATE'))
        else 'all 5 writable tables have INSERT + UPDATE policies' end),

    -- 11. per-event headcount columns. A database from before 007 pushes
    --     count changes that go nowhere and reads family numbers where
    --     overrides were intended; both fail quietly at the app level.
    jsonb_build_object(
      'seq', 11,
      'name', 'per-event headcount columns present',
      'ok', (select count(*) = 2 from information_schema.columns
             where table_schema = 'public' and table_name = 'guest_events'
               and column_name in ('male_count', 'female_count')),
      'detail', case when (select count(*) from information_schema.columns
                           where table_schema = 'public' and table_name = 'guest_events'
                             and column_name in ('male_count', 'female_count')) = 2
        then 'guest_events.male_count / female_count exist'
        else 'missing on guest_events -- run 007_event_counts.sql' end)
  );

  -- stash for the display statement below. No table is involved, and no
  -- RAISE here on purpose: raising aborts the transaction, which discards
  -- the setting, so a failure would print an error and NOTHING ELSE. The
  -- display statement carries its own unmissable summary row instead.
  perform set_config('ws.verify_results', v_results::text, false);
end $$;

-- ── results ──────────────────────────────────────────────────────────
-- Always displays, pass or fail. Failures sort to the TOP and are marked
-- '*** FAIL ***', with a summary row pinned last.
with results as (
  select e.ord                                       as seq,
         (e.elem->>'ok')::boolean                    as ok,
         e.elem->>'name'                             as name,
         e.elem->>'detail'                           as detail
  from jsonb_array_elements(
         coalesce(nullif(current_setting('ws.verify_results', true), ''), '[]')::jsonb
       ) with ordinality as e(elem, ord)
)
select seq, result, name, detail
from (
  -- failures first, so they cannot scroll past unnoticed
  select 0 as band, seq, ok,
         case when ok then 'PASS' else '*** FAIL ***' end as result,
         name, detail
  from results where not ok
  union all
  select 1, seq, ok, 'PASS', name, detail
  from results where ok
  union all
  -- summary pinned last. `result` here is used verbatim, never overwritten.
  select 2, 99, true,
         case when (select count(*) from results where not ok) = 0
              then '*** ALL PASS ***'
              else '*** VERIFY FAILED ***' end,
         'summary',
         (select (select count(*) from results)::text || ' checks, '
                 || (select count(*) from results where not ok)::text || ' failed')
) t
order by band, seq;