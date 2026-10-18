-- weddingSync :: 004 views + functions
-- Requires 001-003. Run before 005.
--
-- Headcount semantics: events OVERLAP. A family attending both baraats
-- and the Walima appears in three event counts but is only 5 people.
-- Summing event_counts would triple-count them, so:
--   event_counts  -> per-event numbers (filter chips)
--   guest_rollup  -> the union, each family counted ONCE (top bar)

-- ─── per-event counts ───────────────────────────────────────────────
-- One row per event: feeds "Faiz Baraat (180)" chips and the card
-- progress figure.
--
-- men/women are NULL when no family in the event has that side recorded.
-- Reporting 0 would claim "no women are coming" for a list whose women
-- were simply never counted; `uncounted` is what makes the gap visible.
create or replace view public.event_counts with (security_invoker = true) as
select
  e.id,
  e.name,
  e.event_date,
  e.sort_order,
  case when count(g.male_count) = 0 then null
       else coalesce(sum(g.male_count), 0)::int end            as men,
  case when count(g.female_count) = 0 then null
       else coalesce(sum(g.female_count), 0)::int end          as women,
  coalesce(sum(g.male_count), 0)::int
    + coalesce(sum(g.female_count), 0)::int                     as total,
  count(g.id)                                                 as families,
  -- families present but not yet counted, surfaced so the summary bar can
  -- say "12 not counted" instead of quietly under-reporting
  count(g.id) filter (where g.male_count is null
                       or g.female_count is null)               as uncounted,
  count(*) filter (where ge.card_sent)                         as cards_sent
from events e
left join guest_events ge on ge.event_id = e.id and ge.deleted_at is null
left join guests g on g.id = ge.guest_id and g.deleted_at is null
where e.deleted_at is null
group by e.id, e.name, e.event_date, e.sort_order;

grant select on public.event_counts to authenticated;

-- ─── overall rollup ─────────────────────────────────────────────────
-- Each family contributes exactly once, regardless of how many events it
-- attends. Families not assigned to any event are excluded: they are not
-- invited anywhere yet, so they should not inflate the number.
--
-- Same NULL rule as event_counts above.
create or replace view public.guest_rollup with (security_invoker = true) as
select
  count(*)::int                                                as families,
  case when count(g.male_count) = 0 then null
       else coalesce(sum(g.male_count), 0)::int end            as men,
  case when count(g.female_count) = 0 then null
       else coalesce(sum(g.female_count), 0)::int end          as women,
  coalesce(sum(g.male_count), 0)::int
    + coalesce(sum(g.female_count), 0)::int                     as total,
  count(*) filter (where g.male_count is null
                    or g.female_count is null)::int             as uncounted
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
-- One function serves both the search bar and the "already added?"
-- duplicate warning on the add screen.
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