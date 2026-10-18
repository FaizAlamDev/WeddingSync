-- =====================================================================
-- LOCAL VALIDATION STUB — DO NOT RUN ON SUPABASE.
-- =====================================================================
-- Location: supabase/tests/00_stub.sql
--
-- This file exists ONLY so the real 001-006 files can be syntax-checked
-- and behaviour-tested in a stock Postgres container. It recreates the
-- few Supabase-specific objects that 001-006 reference:
--   * roles: anon, authenticated, service_role
--   * schema auth, table auth.users
--   * function auth.uid()
--
-- On a real Supabase project these already exist. Never paste this into
-- the Supabase SQL editor.
--
--   podman run -d --name ws-pgtest -e POSTGRES_PASSWORD=test \
--     -e POSTGRES_DB=wedding -p 55433:5432 docker.io/library/postgres:16
--
-- Run order: this first, then 001 -> 002 -> 003 -> 004 -> 005.
-- =====================================================================

-- Roles are cluster-level and survive `drop database`, so each one is
-- created defensively. This makes the stub safely re-runnable.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;

create schema if not exists auth;

create table if not exists auth.users (
  id          uuid primary key default gen_random_uuid(),
  is_anonymous boolean not null default true
);

-- Mirrors Supabase's implementation: reads the JWT sub claim, tolerating
-- both the flat and the JSON settings form.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;

-- ── FAITHFULNESS WARNING ────────────────────────────────────────────
-- Supabase's default privileges hand ALL privileges on every table in
-- public to anon and authenticated:
--
--   alter default privileges in schema public
--     grant all on tables to postgres, anon, authenticated, service_role;
--
-- The first version of this stub did NOT replicate that, so 003_rls.sql
-- passed locally while leaving clients with a DELETE grant on Supabase.
-- This block is applied by 01_default_grants.sql AFTER the tables exist
-- (ALTER DEFAULT PRIVILEGES only affects future tables), reproducing the
-- real starting state. Keep it -- without it, local validation is a lie.
--
-- See tests/01_default_grants.sql.