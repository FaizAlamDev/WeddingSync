-- weddingSync :: 008 uncounted means "nobody counted at any event"
-- Requires 001-007. One paste for a database that already holds data.
--
-- Corrects the "not counted yet" rule. A family is considered counted when,
-- at any event it is invited to, it has either:
--   * a POSITIVE headcount on one side (men > 0 or women > 0), or
--   * BOTH sides recorded -- even 0/0, which is a deliberate "nobody".
--
-- A lone 0 with the other side blank is still uncounted: "0 men" says
-- nothing about the women. Both sides blank is uncounted too. Numbers are
-- resolved per event first: the event's own override when set, otherwise
-- the family's numbers.
--
-- This changes two views:
--   * event_counts.uncounted  -- per event, effective numbers
--   * guest_rollup.uncounted  -- any event the family is invited to
--
-- guest_rollup's men/women/total remain family-level; only the uncounted
-- flag looks at per-event numbers.
--
-- Carries verbatim copies of both definitions from 004, so re-running 004
-- afterwards is safe and keeps that file authoritative. Re-running this
-- file is also safe.

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

-- ─── overall rollup (from 004) ───────────────────────────────────────
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
