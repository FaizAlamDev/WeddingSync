-- weddingSync :: 005 seed
-- Requires 001-004. Safe to re-run: the guard skips names already present.
--
-- event_date is left NULL on purpose. Set the three real dates either by
-- editing these rows here, or from the Supabase table editor once, or from
-- the app's event settings screen later.

insert into events (name, sort_order)
select v.name, v.sort_order
from (values
        ('Faiz Baraat', 10),
        ('Moiz Baraat', 20),
        ('Walima',      30)
     ) as v(name, sort_order)
where not exists (
  select 1 from events e
   where lower(e.name) = lower(v.name)
     and e.deleted_at is null
);

-- To set the dates, uncomment and fill in:
--
-- update events set event_date = date '2026-03-12' where name = 'Faiz Baraat';
-- update events set event_date = date '2026-03-13' where name = 'Moiz Baraat';
-- update events set event_date = date '2026-03-15' where name = 'Walima';