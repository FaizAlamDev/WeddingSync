-- =====================================================================
-- LOCAL ONLY — reproduces Supabase's default privileges.
-- DO NOT RUN ON SUPABASE.
-- =====================================================================
-- A fresh Supabase project grants ALL privileges on every table in the
-- public schema to anon, authenticated and service_role via:
--
--   alter default privileges in schema public
--     grant all on tables to postgres, anon, authenticated, service_role;
--
-- 003_rls.sql must therefore REVOKE everything before granting back a
-- subset. This file recreates that starting state so local validation
-- fails the same way Supabase does.
--
-- Why this file exists: the first version of tests/00_stub.sql left anon
-- and authenticated with NO privileges. 003_rls.sql then looked correct
-- locally -- granting only SELECT/INSERT/UPDATE appeared to remove
-- DELETE -- but on real Supabase the pre-existing DELETE grant survived,
-- and 006_verify.sql caught it on the user's project.
--
-- Ordering note: ALTER DEFAULT PRIVILEGES only affects tables created
-- AFTER it runs. Supabase sets it on the postgres role at project
-- creation, so the grants apply to every table made since. Locally, that
-- means running this file BEFORE 001_schema.sql creates the tables, which
-- is what the README loop does.
-- =====================================================================

alter default privileges in schema public
  grant all on tables to postgres, anon, authenticated, service_role;