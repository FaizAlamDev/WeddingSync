-- weddingSync :: 003 RLS
-- Requires 001 + 002. Run before 004.
--
-- IDEMPOTENT: safe to re-run. Existing policies on the tables below are
-- dropped first, so editing a policy and re-pasting this file just works.
-- CREATE POLICY on its own is not re-runnable (error 42710).
--
-- Background: Supabase ships with RLS DISABLED and the anon key is public
-- by design (it is embedded in the APK). RLS policies are the only thing
-- standing between that key and your guest list. CVE-2025-48757 exposed
-- 170+ shipped apps that skipped this file.
--
-- Identity model: signInAnonymously() gives every device a real
-- auth.uid() with no password and no email shown to the user. Anonymous
-- users act as the `authenticated` role, so RLS does real work here while
-- the family never sees a login screen.
--
-- Access model: anyone can add, edit, and remove (soft delete) guests,
-- todos, and events. DELETE is deliberately NOT granted, so hard deletes
-- and audit-log tampering are rejected by the database itself rather than
-- relying on the app to behave.

-- ─── clear previous policies on our tables ──────────────────────────
-- Scoped to the six tables this schema owns, so any policy you add by
-- hand elsewhere in public is left alone.
do $$
declare r record;
begin
  for r in
    select c.relname as tbl, p.polname
    from pg_policy p
    join pg_class c     on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('events','profiles','guests',
                        'guest_events','todos','activity_log')
  loop
    execute format('drop policy if exists %I on public.%I', r.polname, r.tbl);
  end loop;
end $$;

-- ─── enable RLS on every table in the exposed schema ────────────────
alter table public.events       enable row level security;
alter table public.profiles     enable row level security;
alter table public.guests       enable row level security;
alter table public.guest_events enable row level security;
alter table public.todos        enable row level security;
alter table public.activity_log enable row level security;

-- ─── revoke, then grant back exactly what is needed ─────────────────
-- Supabase PRE-GRANTS all privileges on tables in public to both anon and
-- authenticated via ALTER DEFAULT PRIVILEGES. Granting a subset does NOT
-- subtract the rest, so everything is revoked FIRST. Skipping this is how
-- clients end up holding a DELETE grant nobody meant to hand out.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- Read access to everything shared. profiles are readable so the UI can
-- show "last edited by"; activity_log is readable but NOT writable.
grant select on public.events, public.profiles, public.guests,
                public.guest_events, public.todos, public.activity_log
  to authenticated;

-- Write access, minus activity_log. profiles IS included: the name picker
-- inserts and updates its own row, which RLS restricts to auth.uid().
grant insert, update on public.events, public.profiles, public.guests,
                                 public.guest_events, public.todos
  to authenticated;

-- There is deliberately NO delete grant anywhere. Removal happens by
-- setting deleted_at, and the audit log cannot be tampered with.

-- ─── policies ───────────────────────────────────────────────────────

-- events: full family access. name is unique per (case-insensitive,
-- undeleted) index in 001, so `using(true)` cannot create duplicates.
create policy events_read on public.events
  for select to authenticated using (true);
create policy events_add on public.events
  for insert to authenticated with check (true);
create policy events_edit on public.events
  for update to authenticated using (true) with check (true);

-- profiles: readable by everyone (so the UI can show "last edited by"),
-- writable ONLY for your own row, so one device cannot rename another.
create policy profiles_read on public.profiles
  for select to authenticated using (true);
create policy profiles_claim on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_rename on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- guests: shared family data, anyone may write
create policy guests_read on public.guests
  for select to authenticated using (true);
create policy guests_add on public.guests
  for insert to authenticated with check (true);
create policy guests_edit on public.guests
  for update to authenticated using (true) with check (true);

-- guest_events: same
create policy ge_read on public.guest_events
  for select to authenticated using (true);
create policy ge_add on public.guest_events
  for insert to authenticated with check (true);
create policy ge_edit on public.guest_events
  for update to authenticated using (true) with check (true);

-- todos: same
create policy todos_read on public.todos
  for select to authenticated using (true);
create policy todos_add on public.todos
  for insert to authenticated with check (true);
create policy todos_edit on public.todos
  for update to authenticated using (true) with check (true);

-- activity_log: READ ONLY for clients.
-- There is intentionally no insert/update/delete policy. Combined with the
-- missing DELETE grant and the SECURITY DEFINER triggers from 002, the
-- only way a row gets in is the database itself, recording auth.uid()
-- server-side. A modified client cannot forge or erase history.
create policy log_read on public.activity_log
  for select to authenticated using (true);