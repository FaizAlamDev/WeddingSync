-- =====================================================================
-- LOCAL PERMISSIONS TEST — DO NOT RUN ON SUPABASE.
-- =====================================================================
-- Location: supabase/tests/08_permissions.sql
--
-- 006_verify.sql checks that grants and policies EXIST. This file checks
-- that they DO their job, by connecting as the roles the app actually
-- uses and attempting the things that must be refused. A policy missing
-- its `with check` passes every grant-level check and still lets one
-- phone claim another phone's name.
--
-- It also drives the real client path end to end: writes made AS
-- `authenticated` must land in activity_log through the SECURITY DEFINER
-- triggers, attributed to the profile behind the JWT.
--
-- Expected output: PASS lines only. Any FAIL raises and exits non-zero.
--
-- Expects 001-005 applied to a database where auth.users/profiles exist.
-- Run AFTER tests/07_behaviour.sql: this file adds rows, and 07 asserts
-- exact row counts.
-- =====================================================================

\set ON_ERROR_STOP on

-- Two devices, two people.
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222')
on conflict (id) do nothing;

insert into profiles (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Faiz'),
  ('22222222-2222-2222-2222-222222222222', 'Ammi')
on conflict (id) do nothing;

-- Device one is the one holding the phone in every case below.
select set_config('request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111', false);

-- Marker for "this run". The audit log is append-only, so a re-run must
-- not count rows written by previous runs when it asserts on the log.
select set_config('ws.test_started', now()::text, false);

\echo '=== A. anon (the key shipped inside the APK) gets nothing ==='
set role anon;

do $$
declare
  v_cases text[][] := array[
    array['read families',    'select 1 from public.guests limit 1'],
    array['read the log',     'select 1 from public.activity_log limit 1'],
    array['read events',      'select 1 from public.events limit 1'],
    array['add a family',     'insert into public.guests (name) values (''Anon'')'],
    array['claim a name',     'insert into public.profiles (id, display_name) values (''33333333-3333-3333-3333-333333333333'', ''Anon'')'],
    array['delete families',  'delete from public.guests']
  ];
  v_case text[];
  v_rows int;
  v_fail int := 0;
begin
  foreach v_case slice 1 in array v_cases loop
    v_rows := 0;
    begin
      execute v_case[2];
      get diagnostics v_rows = row_count;
    exception when others then
      raise notice 'PASS  anon cannot %  (%)', v_case[1], sqlerrm;
      continue;
    end;

    if v_rows = 0 then
      raise notice 'PASS  anon cannot %  (no rows touched)', v_case[1];
    else
      raise notice 'FAIL  anon could %  <- % row(s) touched', v_case[1], v_rows;
      v_fail := v_fail + 1;
    end if;
  end loop;

  if v_fail > 0 then
    raise exception '% anon check(s) FAILED', v_fail;
  end if;
end $$;

reset role;

\echo '=== B. authenticated: shared rows are writable, history is NOT ==='
set role authenticated;

do $$
declare
  v_cases text[][] := array[
    array['append to the log',         'insert into public.activity_log (entity_type, entity_id, action) values (''guest'', ''11111111-1111-1111-1111-111111111111'', ''created'')'],
    array['rewrite the log',           'update public.activity_log set actor_name = ''Nobody'''],
    array['erase the log',             'delete from public.activity_log'],
    array['hard-delete a family',      'delete from public.guests'],
    array['hard-delete a card',        'delete from public.guest_events'],
    array['hard-delete a task',        'delete from public.todos'],
    array['hard-delete an event',      'delete from public.events'],
    array['claim a different profile', 'insert into public.profiles (id, display_name) values (''22222222-2222-2222-2222-222222222222'', ''Not Ammi'')'],
    array['rename another profile',    'update public.profiles set display_name = ''Not Ammi'' where id = ''22222222-2222-2222-2222-222222222222''']
  ];
  v_case text[];
  v_rows int;
  v_fail int := 0;
begin
  foreach v_case slice 1 in array v_cases loop
    v_rows := 0;
    begin
      execute v_case[2];
      get diagnostics v_rows = row_count;
    exception when others then
      raise notice 'PASS  cannot %  (%)', v_case[1], sqlerrm;
      continue;
    end;

    -- A write the RLS policies exclude is not an error: postgres filters
    -- the row out and reports success with zero rows touched. Asserting on
    -- the row count is the only way to tell "refused" from "performed".
    if v_rows = 0 then
      raise notice 'PASS  cannot %  (no rows touched)', v_case[1];
    else
      raise notice 'FAIL  could %  <- % row(s) touched', v_case[1], v_rows;
      v_fail := v_fail + 1;
    end if;
  end loop;

  if v_fail > 0 then
    raise exception '% authenticated check(s) FAILED', v_fail;
  end if;
end $$;

reset role;

-- The RLS refusal above reported zero rows rather than an error, so prove
-- the other device's name really is still its own.
do $$
declare
  v_name text;
begin
  select display_name into v_name from public.profiles
   where id = '22222222-2222-2222-2222-222222222222';
  if v_name is distinct from 'Ammi' then
    raise exception 'another device''s profile was altered (display_name = %)', v_name;
  end if;
  raise notice 'PASS  the other device''s name is untouched';
end $$;

\echo '=== C. authenticated: the real work is allowed, and audited ==='

-- Clean slate, so an aborted run can be repeated without doubling rows.
delete from public.todos  where title = 'Check the permission test';
delete from public.guests where name  = 'Permission Family';

set role authenticated;

-- The upsert shape claimProfile() uses on the name picker.
insert into public.profiles (id, display_name)
values ('11111111-1111-1111-1111-111111111111', 'Faiz')
on conflict (id) do update set display_name = excluded.display_name;

insert into public.guests (name, phone, male_count, female_count)
values ('Permission Family', '03001234567', 2, 3);

update public.guests set phone = '03007654321' where name = 'Permission Family';

insert into public.guest_events (guest_id, event_id)
select g.id, e.id from public.guests g, public.events e
 where g.name = 'Permission Family' and e.name = 'Walima';

update public.guest_events
   set card_sent = true, card_sent_at = now(), card_sent_by = 'Faiz'
 where guest_id = (select id from public.guests where name = 'Permission Family');

update public.guest_events
   set male_count = 1, female_count = 2
 where guest_id = (select id from public.guests where name = 'Permission Family')
   and event_id = (select id from public.events where name = 'Walima');

insert into public.todos (title, category) values ('Check the permission test', 'Admin');
update public.todos set status = 'done', completed_at = now(), completed_by = 'Faiz'
 where title = 'Check the permission test';

\echo '    the four views must be readable from a client role:'
select (select count(*) from public.event_counts)  as event_counts,
       (select count(*) from public.guest_rollup)  as guest_rollup,
       (select count(*) from public.card_progress) as card_progress,
       (select count(*) from public.activity_feed) as activity_feed;

reset role;

do $$
declare
  v_guest uuid;
  v_n     int;
begin
  select id into v_guest from public.guests where name = 'Permission Family';
  if v_guest is null then
    raise exception 'the client write did not land';
  end if;

  -- Every row the client produced must be attributed to the JWT's profile,
  -- not to a blank or a forged name.
  select count(*) into v_n from public.activity_log
   where entity_id = v_guest and actor_name is distinct from 'Faiz';
  if v_n > 0 then
    raise exception '% audit row(s) on the new family have the wrong actor', v_n;
  end if;
  raise notice 'PASS  client writes are logged against the acting profile';

  select count(*) into v_n from public.activity_log
   where entity_type = 'guest' and entity_id = v_guest and action = 'created';
  if v_n <> 1 then
    raise exception 'expected 1 "created" row, found %', v_n;
  end if;
  raise notice 'PASS  adding the family logged exactly one row';

  -- The card tick has to be on the log too, with the event AND the family
  -- resolved, because that is what the Activity feed renders.
  select count(*) into v_n from public.activity_log
   where entity_id = v_guest and action = 'card_sent'
     and changes->>'event' = 'Walima'
     and changes->>'guest' = 'Permission Family';
  if v_n <> 1 then
    raise exception 'expected the card tick to be logged, found %', v_n;
  end if;
  raise notice 'PASS  the card tick is logged with family and event';

  -- The per-event numbers ride the same trigger. from is null here: the
  -- event was on the family's numbers until this override landed.
  select count(*) into v_n from public.activity_log
   where entity_id = v_guest and action = 'counts_updated'
     and changes->>'event' = 'Walima'
     and changes->>'guest' = 'Permission Family'
     and changes->'men'->>'from' is null
     and changes->'men'->>'to'   = '1'
     and changes->'women'->>'to' = '2';
  if v_n <> 1 then
    raise exception 'expected the per-event numbers change to be logged, found %', v_n;
  end if;
  raise notice 'PASS  the per-event numbers change is logged with from/to';

  select count(*) into v_n from public.activity_log
   where entity_type = 'todo' and action = 'created'
     and changes->>'title' = 'Check the permission test'
     and created_at >= current_setting('ws.test_started')::timestamptz;
  if v_n <> 1 then
    raise exception 'expected the task to be logged, found %', v_n;
  end if;
  raise notice 'PASS  the task was logged';
end $$;

\echo '=== all permission checks passed ==='
