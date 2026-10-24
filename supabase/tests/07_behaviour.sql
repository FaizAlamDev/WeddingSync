-- =====================================================================
-- LOCAL BEHAVIOUR TEST — DO NOT RUN ON SUPABASE.
-- =====================================================================
-- Location: supabase/tests/07_behaviour.sql
--
-- Validates that the audit triggers actually fire, that no-op updates
-- stay silent, that hard deletes are rejected for clients, and that
-- overlapping events do NOT triple-count headcount. Also covers the
-- per-event headcount override: setting it, a recorded zero, the
-- family-number fallback, and clearing it again.
--
-- Expects 001-006 applied to an EMPTY database (this file inserts rows).
-- Run after tests/00_stub.sql + 001 -> 002 -> 003 -> 004 -> 005.
--
-- Sections:
--   A  audit trail, correct actors and before/after diffs
--   A2 counts_updated carries per-side from/to
--   B  hard delete rejected as the `authenticated` role (EXPECTED error)
--   C  no-op update wrote nothing
--   D  per-event counts, with an override of 0 women (recorded zero)
--   E  rollup counts each family once, not once per event
--   E2 counted needs a positive side or a complete pair, at any event
--   F  typo-tolerant search, true and false positives
--   G  soft-deleted rows vanish from search and counts
--   H  card_progress
--   I  activity_feed joins resolve names
--   I2 clearing an override returns to the family numbers
--   J  remove + re-add to an event does not collide
-- =====================================================================

\set ON_ERROR_STOP on

-- ── setup: a signed-in device ───────────────────────────────────────
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');
select set_config('request.jwt.claim.sub',
  '11111111-1111-1111-1111-111111111111', false);

insert into profiles (id, display_name) values
  ('11111111-1111-1111-1111-111111111111', 'Faiz'),
  ('22222222-2222-2222-2222-222222222222', 'Ammi');

\echo '--- 1. create a family ---'
insert into guests (name, phone, male_count, female_count)
values ('Raza Family', '03001234567', 3, 2);

\echo '--- 2. attend all three events ---'
insert into guest_events (guest_id, event_id)
select (select id from guests where name = 'Raza Family'), id from events;

\echo '--- 3. card sent for Faiz Baraat only ---'
update guest_events set card_sent = true, card_sent_at = now(), card_sent_by = 'Faiz'
where event_id = (select id from events where name = 'Faiz Baraat')
  and guest_id = (select id from guests where name = 'Raza Family');

\echo '--- 3b. per-event numbers: only 1 man and 0 women go to Faiz Baraat ---'
-- Raza's family numbers are 3/2; this event gets its own. Note 0 women
-- is a RECORDED zero, different from the null "not counted" rule.
update guest_events set male_count = 1, female_count = 0
where event_id = (select id from events where name = 'Faiz Baraat')
  and guest_id = (select id from guests where name = 'Raza Family');

\echo '--- 4. edit the phone number ---'
update guests set phone = '03009998888' where name = 'Raza Family';

\echo '--- 5. a NO-OP update must NOT write a log row ---'
update guests set phone = '03009998888' where name = 'Raza Family';

\echo '--- 6. a family with no counts recorded ---'
insert into guests (name) values ('Uncounted Friends');

\echo '--- 7. todo lifecycle ---'
insert into todos (title, category, assigned_to) values ('Order mehndi trays', 'Mehndi', 'Ammi');
update todos set status = 'done', completed_at = now(), completed_by = 'Faiz'
 where title = 'Order mehndi trays';
update todos set status = 'open' where title = 'Order mehndi trays';

\echo '--- 8. soft delete a family ---'
update guests set deleted_at = now() where name = 'Uncounted Friends';

\echo '--- 9. switch actor mid-session, then another action ---'
select set_config('request.jwt.claim.sub',
  '22222222-2222-2222-2222-222222222222', false);
update guest_events set card_sent = true, card_sent_at = now(), card_sent_by = 'Ammi'
where event_id = (select id from events where name = 'Walima')
  and guest_id = (select id from guests where name = 'Raza Family');

\echo '=== A. audit trail (expect exactly 13 rows) ==='
select actor_name, entity_type, action, changes from activity_log order by id;

\echo '=== A2. the counts_updated row carries per-side from/to ==='
do $$
declare v jsonb;
begin
  select changes into v from activity_log where action = 'counts_updated';
  -- from is null: the link had no override, so the event was on the
  -- family's numbers until this write. to carries the new overrides,
  -- including a recorded zero.
  if v->'men'->>'from'    is not null
     or v->'men'->>'to'    is distinct from '1'
     or v->'women'->>'from' is not null
     or v->'women'->>'to'   is distinct from '0' then
    raise exception 'counts_updated changes are wrong: %', v;
  end if;
  raise notice 'ok: counts_updated logged null->1 men, null->0 women (first override)';
end $$;

\echo '=== B. hard delete as an app client must be REJECTED ==='
\echo '    (the ERROR line below is the EXPECTED outcome, not a failure)'
-- statement 1 deliberately provokes a permission error, so psql must not
-- abort on it; re-enable strict mode immediately afterwards.
\set ON_ERROR_STOP off
set role authenticated;
delete from guests where name = 'Raza Family';
reset role;
\set ON_ERROR_STOP on
\echo '    row still present:'
select count(*) as raza_still_there from guests where name = 'Raza Family';

\echo '=== C. no-op update wrote nothing (expect 13 rows) ==='
select count(*) as log_rows from activity_log;

\echo '=== D. per-event counts: Faiz 1 (1 man, 0 women -- override), Moiz 5, Walima 5 ==='
select name, men, women, total, families, uncounted, cards_sent
  from event_counts order by sort_order;

\echo '=== E. rollup counts the family ONCE (expect 5, NOT 15) ==='
select families, men, women, total, uncounted from guest_rollup;

\echo '=== E2. counted means a positive side or a complete pair, at any event ==='
-- Family-level numbers are blank throughout this section; the only
-- numbers are on the event links. This isolates the per-event rule and
-- the union's "any event is enough" behaviour.

update guests set male_count = null, female_count = null
 where name = 'Raza Family';
-- Faiz Baraat still has its 1/0 override from section 3b: a complete pair.
do $$
declare v record;
begin
  select men, women, uncounted into v from guest_rollup;
  if v.men is not null or v.women is not null
     or v.uncounted is distinct from 0 then
    raise exception 'a complete pair at one event did not count the family: %', v;
  end if;

  select uncounted into v from event_counts where name = 'Walima';
  if v.uncounted is distinct from 1 then
    raise exception 'an event with both sides blank was not flagged: %', v;
  end if;
  raise notice 'ok: numbers at one event count the family; a blank event stays flagged';
end $$;

-- Clear the last override: now no event has any numbers.
update guest_events set male_count = null, female_count = null
 where guest_id = (select id from guests where name = 'Raza Family')
   and event_id = (select id from events where name = 'Faiz Baraat');

do $$
declare v record;
begin
  select uncounted into v from guest_rollup;
  if v.uncounted is distinct from 1 then
    raise exception 'family with no numbers at any event was not flagged: %', v;
  end if;
  raise notice 'ok: no numbers at any event means uncounted';
end $$;

-- A lone 0 says nothing about the other side.
update guest_events set male_count = 0, female_count = null
 where guest_id = (select id from guests where name = 'Raza Family')
   and event_id = (select id from events where name = 'Walima');

do $$
declare v record;
begin
  select uncounted into v from event_counts where name = 'Walima';
  if v.uncounted is distinct from 1 then
    raise exception 'a lone zero was treated as counted: %', v;
  end if;
  select uncounted into v from guest_rollup;
  if v.uncounted is distinct from 1 then
    raise exception 'a lone zero counted the family at union level: %', v;
  end if;
  raise notice 'ok: lone 0 + blank is not counted';
end $$;

-- Both sides recorded, even 0/0, is a deliberate answer.
update guest_events set male_count = 0, female_count = 0
 where guest_id = (select id from guests where name = 'Raza Family')
   and event_id = (select id from events where name = 'Walima');

do $$
declare v record;
begin
  select uncounted into v from event_counts where name = 'Walima';
  if v.uncounted is distinct from 0 then
    raise exception 'a complete 0/0 pair was treated as uncounted: %', v;
  end if;
  select uncounted into v from guest_rollup;
  if v.uncounted is distinct from 0 then
    raise exception 'a complete 0/0 pair did not count the family: %', v;
  end if;
  raise notice 'ok: 0/0 is a complete answer';
end $$;

-- A positive one-sided number is enough.
update guest_events set male_count = 1, female_count = null
 where guest_id = (select id from guests where name = 'Raza Family')
   and event_id = (select id from events where name = 'Walima');

do $$
declare v record;
begin
  select uncounted into v from event_counts where name = 'Walima';
  if v.uncounted is distinct from 0 then
    raise exception 'a positive one-sided count was treated as uncounted: %', v;
  end if;
  raise notice 'ok: one positive side is enough';
end $$;

-- Restore the numbers the later sections expect.
update guest_events set male_count = null, female_count = null
 where guest_id = (select id from guests where name = 'Raza Family')
   and event_id = (select id from events where name = 'Walima');
update guest_events set male_count = 1, female_count = 0
 where guest_id = (select id from guests where name = 'Raza Family')
   and event_id = (select id from events where name = 'Faiz Baraat');
update guests set male_count = 3, female_count = 2
 where name = 'Raza Family';

\echo '=== F. typo-tolerant search: "rza" -> Raza Family ==='
select name, male_count, female_count from search_guests('rza');

\echo '=== F2. must NOT match an unrelated family ==='
select count(*) as false_positives from search_guests('khan');

\echo '=== G. soft-deleted family is gone from search and counts ==='
select count(*) as should_be_0 from search_guests('uncounted');

\echo '=== H. card_progress ==='
select * from card_progress order by event_name;

\echo '=== I. activity feed with resolved names ==='
select id, actor_name, entity_type, action, guest_name, todo_title
  from activity_feed order by id;

\echo '=== I2. clearing the override returns the event to the family numbers ==='
update guest_events set male_count = null, female_count = null
where event_id = (select id from events where name = 'Faiz Baraat')
  and guest_id = (select id from guests where name = 'Raza Family');

do $$
declare v record;
begin
  select men, women, total, uncounted into v
    from event_counts where name = 'Faiz Baraat';
  if v.men is distinct from 3 or v.women is distinct from 2
     or v.total is distinct from 5 or v.uncounted is distinct from 0 then
    raise exception 'clearing the override did not return to the family numbers: %', v;
  end if;
  raise notice 'ok: cleared override falls back to 3 men, 2 women';
end $$;

\echo '    and the clear was logged with from/to:'
select changes from activity_log where action = 'counts_updated' order by id desc limit 1;

\echo '=== J. re-adding to a tombstoned event must not collide ==='
do $$
declare v_id uuid; v_ev uuid := (select id from events where name = 'Moiz Baraat');
  v_g uuid := (select id from guests where name = 'Raza Family');
begin
  select id into v_id from guest_events
   where guest_id = v_g and event_id = v_ev and deleted_at is null;
  update guest_events set deleted_at = now() where id = v_id;
  insert into guest_events (guest_id, event_id) values (v_g, v_ev);
  raise notice 'ok: remove + re-add produced a fresh row';
end $$;

select count(*) as active_rows_for_raza
  from guest_events where guest_id = (select id from guests where name='Raza Family')
    and deleted_at is null;

-- ── everything above ran as superuser, which bypasses BOTH grants and
--    RLS. Sections K and L re-run the real client flows as `authenticated`
--    so that missing grants and wrong policies actually surface.

\echo '=== K. name picker as a real client (authenticated) ==='
insert into auth.users (id) values ('33333333-3333-3333-3333-333333333333');
select set_config('request.jwt.claim.sub',
  '33333333-3333-3333-3333-333333333333', false);

\set ON_ERROR_STOP on
set role authenticated;

\echo '    writing my own profile row (must succeed):'
insert into profiles (id, display_name)
  values ('33333333-3333-3333-3333-333333333333', 'Moiz');

\echo '    writing SOMEONE ELSE''s row (ERROR below is EXPECTED):'
\set ON_ERROR_STOP off
insert into profiles (id, display_name)
  values ('22222222-2222-2222-2222-222222222222', 'Impostor');
\set ON_ERROR_STOP on
reset role;

select
  (select count(*) from profiles where display_name = 'Moiz')      as own_row_written,
  (select count(*) from profiles where display_name = 'Impostor') as forged_rows;

\echo '=== L. guest writes as a real client ==='
\set ON_ERROR_STOP on
set role authenticated;
insert into guests (name, phone, male_count, female_count)
  values ('Kareem Family', '03111222333', 2, 4);
update guest_events set card_sent = true, card_sent_at = now(), card_sent_by = 'Moiz'
 where guest_id = (select id from guests where name = 'Kareem Family')
   and event_id = (select id from events where name = 'Moiz Baraat');
reset role;
\set ON_ERROR_STOP on

select count(*) as kareem_added from guests where name = 'Kareem Family';
select actor_name, action from activity_log order by id desc limit 2;

\echo '--- expected: own_row_written=1, forged_rows=0, kareem_added=1 ---'