-- weddingSync :: 004 views + functions
-- Requires 001-003. Run before 005.
--
-- Headcount semantics: events OVERLAP. A family attending both baraats
-- and the Walima appears in three event counts but is only 5 people.
-- Summing event_counts would triple-count them, so:
--   event_counts  -> per-event numbers (filter chips)
--   guest_rollup  -> the union, each family counted ONCE (top bar)
--
-- Per-event numbers: a family can send 3 members to one event and 20 to
-- another. guest_events.male_count / female_count override the family's
-- numbers for that event alone; null means "same as the family". Both
-- directions are supported -- no event is assumed to be the bigger one.

-- ─── per-event counts ───────────────────────────────────────────────
-- One row per event: feeds "Faiz Baraat (180)" chips and the card
-- progress figure.
--
-- Each family's numbers for an event are its OWN override when set, and
-- the family's numbers otherwise. Which event ends up overridden is up
-- to whoever knows the family -- the view never assumes that the smaller
-- event is the Walima, or any other direction.
--
-- men/women are NULL when no family in the event has that side recorded
-- (an override of 0 counts as recorded). Reporting 0 would claim "no
-- women are coming" for a list whose women were simply never counted;
-- `uncounted` is what makes the gap visible.
--
-- A family is counted for an event when it has a POSITIVE headcount on
-- either side, or both sides recorded (even 0/0, a deliberate "nobody").
-- A lone 0 with the other side blank is still uncounted: zero men says
-- nothing about the women. This is why the rule is not simply "any
-- non-null value".
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
  -- families present but not yet counted, surfaced so the summary bar can
  -- say "12 not counted" instead of quietly under-reporting
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
  -- one row per family attending the event, numbers already resolved.
  -- The inner join keeps soft-deleted guests out of the sums even when a
  -- stale override sits on a tombstoned link.
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

-- ─── overall rollup ─────────────────────────────────────────────────
-- Each family contributes exactly once, regardless of how many events it
-- attends. Families not assigned to any event are excluded: they are not
-- invited anywhere yet, so they should not inflate the number.
--
-- Same counting rule as event_counts above, applied across every event
-- the family is invited to: one positive side or one complete pair
-- anywhere is enough. The rollup's men/women/total stay family-level --
-- only the uncounted flag looks at the per-event numbers.
create or replace view public.guest_rollup with (security_invoker = true) as
select
  count(*)::int                                                as families,
  case when count(g.male_count) = 0 then null
       else coalesce(sum(g.male_count), 0)::int end            as men,
  case when count(g.female_count) = 0 then null
       else coalesce(sum(g.female_count), 0)::int end          as women,
  coalesce(sum(g.male_count), 0)::int
    + coalesce(sum(g.female_count), 0)::int                     as total,
  count(*) filter (
    where not exists (
      select 1
        from guest_events ge2
       where ge2.guest_id = g.id
         and ge2.deleted_at is null
         and (
           coalesce(ge2.male_count,   g.male_count)   > 0
           or coalesce(ge2.female_count, g.female_count) > 0
           or (coalesce(ge2.male_count,   g.male_count)   is not null
               and coalesce(ge2.female_count, g.female_count) is not null)
         )
    )
  )::int                                                        as uncounted
from guests g
where g.deleted_at is null
  and exists (
    select 1 from guest_events ge
     where ge.guest_id = g.id and ge.deleted_at is null
  );

grant select on public.guest_rollup to authenticated;

-- ─── card progress ──────────────────────────────────────────────────
-- Flat across events, since one row = one physical card to post.
create or replace view public.card_progress with (security_invoker = true) as
select
  e.id   as event_id,
  e.name as event_name,
  count(*) filter (where ge.card_sent)      as sent,
  count(*) filter (where not ge.card_sent)  as pending,
  count(ge.id)                              as total_cards
from events e
left join guest_events ge on ge.event_id = e.id and ge.deleted_at is null
where e.deleted_at is null
group by e.id, e.name;

grant select on public.card_progress to authenticated;

-- ─── search ─────────────────────────────────────────────────────────
-- Server-side search helper. The app searches and matches possible
-- duplicate names LOCALLY in SQLite, so this function is not called by
-- the app; it remains for ad-hoc SQL and the SQL test suite.
--
-- word_similarity (not similarity) compares the query against each WORD
-- of the name. That matters: similarity('rza','Raza Family') is only
-- 0.14 because it diffs against the whole string, so "Rza" would never
-- find "Raza Family". word_similarity scores it 0.29.
--
-- Threshold 0.25 separates cleanly in testing -- lowest true positive
-- ("rza" -> "Raza Family") scores 0.286, highest false positive
-- ("khan" -> "Kareem Family") scores 0.200.
create or replace function public.search_guests(q text)
returns setof public.guests
language sql
stable
as $$
  select g.*
  from guests g
  where g.deleted_at is null
    and (
      g.name ilike '%' || q || '%'
      or coalesce(g.phone, '') ilike '%' || q || '%'
      or word_similarity(q, g.name) > 0.25
    )
  order by
    case when lower(g.name)   = lower(q)  then 0
         when g.name ilike q || '%'       then 1
         when g.name ilike '%' || q || '%' then 2
         else 3
    end,
    word_similarity(q, g.name) desc,
    g.name
  limit 50;
$$;

grant execute on function public.search_guests(text) to authenticated;

-- ─── activity feed ──────────────────────────────────────────────────
-- Join helper for the Activity tab. actor_name is denormalized into
-- activity_log, so this renders correctly even if a device is wiped and
-- its profile row disappears.
create or replace view public.activity_feed with (security_invoker = true) as
select
  al.id,
  al.entity_type,
  al.entity_id,
  al.action,
  al.actor_name,
  al.changes,
  al.created_at,
  g.name   as guest_name,
  t.title  as todo_title
from activity_log al
left join guests g on al.entity_type in ('guest', 'guest_event')
                  and g.id = al.entity_id
left join todos  t on al.entity_type = 'todo'
                  and t.id = al.entity_id;

grant select on public.activity_feed to authenticated;