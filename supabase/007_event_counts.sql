-- weddingSync :: 007 per-event headcounts
-- Requires 001-006. One paste for a database that already holds data:
--
--   * guest_events gains male_count / female_count -- the numbers for
--     THAT event. null means "same as the family's numbers" (guests
--     row); 0 is a recorded zero. Nothing is inherited from one event
--     to another, so a family can send fewer members to the Baraat and
--     more to the Walima, or the other way round.
--   * log_guest_event_activity() learns the counts_updated action.
--   * event_counts resolves each family's effective numbers per event.
--
-- The last two sections carry verbatim copies of the updated definitions
-- from 002 and 004, so a single paste brings an existing database fully
-- up to date. Re-running 002 and 004 afterwards is always safe and keeps
-- those files authoritative.
--
-- Fresh installs get all of this from 001/002/004; for them this file is
-- a no-op beyond restating the same definitions.

-- ─── columns ─────────────────────────────────────────────────────────
alter table public.guest_events add column if not exists male_count   integer;
alter table public.guest_events add column if not exists female_count integer;

-- add constraint has no IF NOT EXISTS; drop-then-add keeps it re-runnable
alter table public.guest_events drop constraint if exists guest_events_male_nonneg;
alter table public.guest_events add  constraint guest_events_male_nonneg
  check (male_count   is null or male_count   >= 0);

alter table public.guest_events drop constraint if exists guest_events_female_nonneg;
alter table public.guest_events add  constraint guest_events_female_nonneg
  check (female_count is null or female_count >= 0);

-- ─── audit: guest_events (from 002) ──────────────────────────────────
-- entity_id is new.guest_id (not the join row's id) so that "this
-- family's history" is a single indexed filter on one column.
create or replace function public.log_guest_event_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor   uuid := auth.uid();
  v_name    text;
  v_guest   text;
  v_event   text;
  v_action  text;
  v_changes jsonb;
begin
  select display_name into v_name
    from public.profiles where id = v_actor;
  select g.name into v_guest
    from public.guests g where g.id = new.guest_id;
  select e.name into v_event
    from public.events e where e.id = new.event_id;

  if tg_op = 'INSERT' then
    v_action  := 'added_to_event';
    v_changes := jsonb_build_object('event', v_event);
  elsif new.deleted_at is not null and old.deleted_at is null then
    v_action  := 'removed_from_event';
    v_changes := jsonb_build_object('event', v_event);
  elsif new.card_sent is distinct from old.card_sent then
    v_action  := case when new.card_sent then 'card_sent' else 'card_uncheck' end;
    v_changes := jsonb_build_object('event', v_event);
  elsif new.male_count is distinct from old.male_count
     or new.female_count is distinct from old.female_count then
    -- Per-event headcount change. from/to are stored per side and may be
    -- null on either end ("was the family's number, now set" and back).
    v_action  := 'counts_updated';
    v_changes := jsonb_build_object(
      'event', v_event,
      'men',   jsonb_build_object('from', old.male_count,   'to', new.male_count),
      'women', jsonb_build_object('from', old.female_count, 'to', new.female_count));
  else
    return new;
  end if;

  insert into public.activity_log
    (entity_type, entity_id, action, actor_id, actor_name, changes)
  values
    ('guest_event', new.guest_id, v_action, v_actor, v_name,
      v_changes || jsonb_build_object('guest', v_guest));

  return new;
end $$;

-- the trigger itself already exists; create or replace function is enough

-- ─── per-event counts (from 004) ─────────────────────────────────────
create or replace view public.event_counts with (security_invoker = true) as
select
  e.id,
  e.name,
  e.event_date,
  e.sort_order,
  case when count(x.men) = 0 then null
       else coalesce(sum(x.men), 0)::int end                    as men,
  case when count(x.women) = 0 then null
       else coalesce(sum(x.women), 0)::int end                  as women,
  coalesce(sum(x.men), 0)::int
    + coalesce(sum(x.women), 0)::int                            as total,
  count(x.guest_id)                                             as families,
  count(x.guest_id) filter (
    where not (
      coalesce(x.men, 0) > 0
      or coalesce(x.women, 0) > 0
      or (x.men is not null and x.women is not null)
    )
  )                                                              as uncounted,
  count(*) filter (where x.card_sent)                           as cards_sent
from events e
left join (
  select ge.event_id,
         ge.guest_id,
         ge.card_sent,
         coalesce(ge.male_count,   g.male_count)   as men,
         coalesce(ge.female_count, g.female_count) as women
  from guest_events ge
  join guests g on g.id = ge.guest_id and g.deleted_at is null
  where ge.deleted_at is null
) x on x.event_id = e.id
where e.deleted_at is null
group by e.id, e.name, e.event_date, e.sort_order;

grant select on public.event_counts to authenticated;
