-- weddingSync :: 001 schema
-- Tables and indexes only. No RLS, no triggers, no data.
-- Run order: 001 -> 002 -> 003 -> 004 -> 005 -> 006

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists pg_trgm;    -- typo-tolerant search

-- ─── events ──────────────────────────────────────────────────────────
-- The wedding functions. Seeded in 005, created by hand afterwards.
create table if not exists public.events (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  event_date date,                            -- optional
  sort_order integer not null default 100,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

-- case-insensitive uniqueness, ignores tombstoned rows so a removed
-- event name can be reused later
create unique index if not exists events_name_key
  on public.events (lower(name)) where deleted_at is null;

-- ─── profiles ────────────────────────────────────────────────────────
-- Maps a Supabase anonymous auth user (device) to a display name.
-- No password, no email: the name picker writes one row.
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);

-- ─── guests ──────────────────────────────────────────────────────────
-- One row = one FAMILY. Name required, everything else optional.
-- null counts mean "not recorded", which is NOT the same as zero:
-- summing COALESCE at read time keeps under-reporting visible.
create table if not exists public.guests (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  phone        text,                          -- one number, optional
  male_count   integer,
  female_count integer,
  deleted_at   timestamptz,                   -- soft delete only
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint guests_male_nonneg   check (male_count   is null or male_count   >= 0),
  constraint guests_female_nonneg check (female_count is null or female_count >= 0)
);

-- ─── guest_events ────────────────────────────────────────────────────
-- Which events a family attends, card status per event, and the
-- per-event headcount override.
--
-- A family sends different numbers to different events: 3 men to the
-- Baraat, 20 to the Walima -- and which event is the bigger one depends
-- entirely on whose side of the wedding it is. So every family x event
-- pair is independent: male_count/female_count here are THAT event's
-- numbers, null means "same as the family's numbers" (guests row), and 0
-- is a recorded zero, not "unset". Nothing is inherited from one event
-- to another, and nothing assumes a direction.
--
-- A family in both baraats gets two independent card checkboxes.
create table if not exists public.guest_events (
  id           uuid primary key default gen_random_uuid(),
  guest_id     uuid not null references public.guests(id) on delete cascade,
  event_id     uuid not null references public.events(id) on delete cascade,
  card_sent    boolean not null default false,
  card_sent_at timestamptz,
  card_sent_by text,                          -- display name, denormalized
  male_count   integer,                       -- null = use the family count
  female_count integer,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint guest_events_male_nonneg   check (male_count   is null or male_count   >= 0),
  constraint guest_events_female_nonneg check (female_count is null or female_count >= 0)
);

-- partial unique: remove a family from an event and re-add later creates a
-- clean row rather than colliding with the tombstone
create unique index if not exists guest_events_active_key
  on public.guest_events (guest_id, event_id) where deleted_at is null;

-- ─── todos ───────────────────────────────────────────────────────────
create table if not exists public.todos (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  body         text,
  category     text,
  status       text not null default 'open' check (status in ('open','done')),
  due_date     date,
  assigned_to  text,
  completed_at timestamptz,
  completed_by text,
  created_by   text,
  updated_by   text,
  deleted_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ─── activity_log ────────────────────────────────────────────────────
-- Append-only. Written exclusively by the SECURITY DEFINER triggers in
-- 002. No client INSERT/UPDATE/DELETE policy exists (see 003).
-- id is a sequence rather than a timestamp on purpose: clients delta-pull
-- with `id > last_seen_id`, and sequences cannot skip or collide under
-- device clock drift the way timestamps can.
create table if not exists public.activity_log (
  id          bigserial primary key,
  entity_type text not null,                  -- guest | guest_event | todo
  entity_id   uuid not null,
  action      text not null,
  actor_id    uuid,
  actor_name  text,                           -- survives device wipe
  changes     jsonb,
  created_at  timestamptz not null default now()
);

-- ─── indexes ─────────────────────────────────────────────────────────
create index if not exists guests_name_trgm on public.guests using gin (name gin_trgm_ops);
create index if not exists guests_updated_idx on public.guests (updated_at);

create index if not exists guest_events_event_idx on public.guest_events (event_id) where deleted_at is null;
create index if not exists guest_events_updated_idx on public.guest_events (updated_at);

create index if not exists todos_updated_idx on public.todos (updated_at);
create index if not exists todos_status_idx  on public.todos (status) where deleted_at is null;

create index if not exists activity_entity_idx  on public.activity_log (entity_type, entity_id);
create index if not exists activity_created_idx on public.activity_log (created_at desc);