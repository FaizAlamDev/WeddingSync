# Supabase schema — weddingSync

Shared backend for the wedding app. Postgres on the Supabase free tier.

## Deploy order

Paste each file into the Supabase SQL Editor (**Dashboard → SQL Editor → New
query**) and run them one at a time, in this order:

| File | Contents |
|---|---|
| `001_schema.sql` | Tables + indexes. Creates `pgcrypto` and `pg_trgm`. |
| `002_triggers.sql` | Server-owned `updated_at` + the three audit triggers. |
| `003_rls.sql` | RLS, grants, policies. **Required — read the notes below.** |
| `004_views.sql` | `event_counts`, `guest_rollup`, `card_progress`, `activity_feed`, `search_guests()`. |
| `005_seed.sql` | Faiz Baraat, Moiz Baraat, Walima. Safe to re-run. |
| `006_verify.sql` | 10 assertions, printed as a PASS/FAIL table. **Read-only.** |

Every file is **idempotent** — paste and Run as often as you like.

| Concern | Handled by |
|---|---|
| `CREATE POLICY` already exists (42710) | `003_rls.sql` drops our policies first |
| `CREATE TRIGGER` already exists (42751) | `002_triggers.sql` uses `drop trigger if exists` |
| `CREATE TABLE` already exists (42P07) | `001_schema.sql` uses `if not exists` |
| Duplicate events on re-seed | `005_seed.sql` guards with `where not exists` |

This matters more than it sounds: policies and triggers are the two things
you will edit and re-paste repeatedly, and both `CREATE` forms are one-shot.
Verified locally by applying `001`–`005` three times in a row against a
database with Supabase's default grants in place.

### Reading the verify output

`006_verify.sql` returns a table. **Read the `result` column** — failures
sort to the *top* and are marked `*** FAIL ***`, with a summary row pinned
last.

```
 seq |      result      |               name               |            detail
-----+------------------+----------------------------------+---------------------------
   1 | PASS             | RLS enabled on all tables        | all public tables
   ...
  10 | PASS             | write policies present           | all 5 writable tables ...
  99 | *** ALL PASS *** | summary                          | 10 checks, 0 failed
```

On failure:

```
   3 | *** FAIL ***     | no hard deletes possible         | authenticated can hard-delete: guests, activity_log
  ...
  99 | *** VERIFY FAILED *** | summary                     | 10 checks, 2 failed
```

### Why 006 creates nothing

An earlier version collected results into a `TEMP` table named `_check`.
Temp tables live in `pg_temp` and are unreachable from PostgREST, but the
Supabase SQL Editor's linter cannot tell that and warns:

> This query creates a table without enabling Row Level Security. Clients
> using anon or authenticated keys may be able to access _check.

That warning is false, and a tool reporting a security problem that does not
exist is worse than no tool. The current version creates nothing at all: the
checks run inside one plpgsql block, the results are passed to the display
query through a session setting, and the file contains zero `CREATE`,
`ALTER`, `DROP`, `GRANT`, `REVOKE`, `INSERT`, `UPDATE` or `DELETE`
statements. Verified by object count before and after: unchanged.

Don't read bare "Success. No rows returned" as verification — re-paste
`006_verify.sql` and confirm the last row says `*** ALL PASS ***`.

### What the checks cover

| # | Check | Catches |
|---|---|---|
| 1 | RLS enabled everywhere | Supabase's default of RLS off |
| 2 | anon has zero privileges | guest list readable by anyone with the APK |
| 3 | authenticated cannot DELETE | hard-deleting guests or erasing the audit log |
| 4 | activity_log is SELECT-only | forged or tampered history |
| 5 | app tables are writable | missing GRANT, fails silently at runtime |
| 6 | audit triggers are SECURITY DEFINER | triggers unable to write past RLS |
| 7 | views and search function exist | 004 never ran |
| 8 | three events seeded once | duplicate seed from re-running 005 |
| 9 | views return data | 004 exists but is broken |
| 10 | write policies exist | GRANT without policy: RLS denies every row, so the app appears to "just not save" |

Then enable anonymous sign-ins: **Authentication → Providers → Anonymous → ON**.

## Local-only test files

Everything in `tests/` is for local validation only. Never paste any of it
into the Supabase SQL editor — `tests/00_stub.sql` recreates objects that
already exist on Supabase and will fail there.

| File | Purpose |
|---|---|
| `tests/00_stub.sql` | Recreates `auth` schema + `anon`/`authenticated` roles |
| `tests/01_default_grants.sql` | Reproduces Supabase's default ALL-grants |
| `tests/07_behaviour.sql` | Exercises the audit triggers, soft deletes, headcount math, search |
| `tests/08_permissions.sql` | Connects as `anon` and `authenticated` and tries what must be refused |

`tests/01_default_grants.sql` is not optional. Supabase pre-grants ALL on
`public` tables to `anon` and `authenticated`, and `003_rls.sql` must revoke
everything before granting a subset back. Without this file, local validation
starts from a cleaner state than Supabase does and will pass on bugs that
fail in production.

`tests/08_permissions.sql` covers what grants alone cannot: `006_verify.sql`
proves the grants and policies *exist*, while 08 connects as each role and
proves they *refuse* — the log cannot be appended to or rewritten, hard
deletes are rejected, one device cannot claim or rename another device's
profile — and then does the app's real writes as `authenticated`, checking
they land in `activity_log` attributed to the acting profile. Note that an
RLS `using` clause *filters* rows rather than raising, so a refused UPDATE
reports success with 0 rows touched; the test asserts on row counts for
exactly that reason.

Run order matters: `07_behaviour.sql` asserts exact row counts on a fresh
database, so it must run before 08 (which adds rows).

### Re-running the tests locally

```bash
podman run -d --name ws-pgtest -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=wedding -p 55433:5432 docker.io/library/postgres:16
```

Files live on the host, so pipe into `psql` rather than using `-f`. Order
matters: `01_default_grants.sql` uses `ALTER DEFAULT PRIVILEGES`, which only
affects tables created afterwards.

```bash
cd supabase

# apply stub + schema to a fresh database
for f in tests/00_stub.sql tests/01_default_grants.sql \
         001_schema.sql 002_triggers.sql 003_rls.sql \
         004_views.sql 005_seed.sql; do
  podman exec -i ws-pgtest psql -U postgres -d wedding \
    -v ON_ERROR_STOP=1 -q < "$f" || break
done

# 10 assertions, raises on failure
podman exec -i ws-pgtest psql -U postgres -d wedding -q < 006_verify.sql

# trigger behaviour, headcount math, search, client-role flows
podman exec -i ws-pgtest psql -U postgres -d wedding -q < tests/07_behaviour.sql

# anon gets nothing; authenticated cannot touch the log or other profiles
podman exec -i ws-pgtest psql -U postgres -d wedding -q < tests/08_permissions.sql

podman rm -f ws-pgtest
```

Reset between runs. Roles are cluster-level and survive `drop database`,
which is why `tests/00_stub.sql` is idempotent:

```bash
podman exec -i ws-pgtest psql -U postgres -d postgres -q \
  -c "drop database if exists wedding;" -c "create database wedding;"
```

Section B of the behaviour test intentionally provokes a permission error.
That output is the expected result, not a failure.

## Model

One `guests` row is one **family**, not one person.

```
guests ──┬── male_count / female_count   (family size)
         └── guest_events ── events      (attendance + card_sent per event)
```

`card_sent` lives on `guest_events`, so a family attending both baraats has
two independent card checkboxes.

### Headcount: union, not sum

Events overlap. A family of 5 at both baraats and the Walima appears as 5 in
three event counts but is only 5 people. Summing `event_counts` would report
15.

- `event_counts` — per-event, feeds the filter chips
- `guest_rollup` — each family counted **once**, feeds the top summary bar

Families assigned to no event are excluded from `guest_rollup`; they are not
invited anywhere yet.

### Nullable counts are deliberate

`male_count` / `female_count` are `null` = "not recorded", which is different
from `0`. With a `default 0`, an uncounted family would be silently
under-reported. `guest_rollup.uncounted` surfaces the gap so the UI can say
"12 not counted" rather than showing a number you can't trust.

The same rule reaches the totals: `men` and `women` in `guest_rollup` and
`event_counts` are **NULL when not one family in scope has that side
recorded**, rather than a sum of 0. A 0 would assert "no women are coming"
about a list whose women were never counted. `total` stays a plain sum of
what is known, so it is a floor -- and `uncounted` says how much is missing.
The app applies the identical rule locally in `src/db/queries.ts`.

## Access model

- `signInAnonymously()` — no password, no email shown to any user
- Anyone can add, edit, and remove guests, todos, and events
- **Deletion is soft** (`deleted_at`). No `DELETE` grant exists, so hard
  deletes are rejected by the database, not merely avoided by the app.
- `anon` has zero privileges on every table. This matters: the anon key ships
  inside the APK and is public by design.

## Audit trail

`activity_log` is written **exclusively** by `SECURITY DEFINER` triggers in
`002_triggers.sql`. There is no client INSERT policy and no DELETE grant, so a
modified client cannot forge or erase history. Actor identity comes from
`auth.uid()`, resolved server-side.

Delta-pull log rows with `id > last_seen_id`. `id` is a `bigserial` on purpose
— sequences cannot skip or collide under device clock drift, which timestamps
can.

### Actions

| Trigger | `action` values |
|---|---|
| `guests` | `created`, `updated`, `deleted` |
| `guest_events` | `added_to_event`, `removed_from_event`, `card_sent`, `card_uncheck` |
| `todos` | `created`, `updated`, `assigned`, `completed`, `reopened`, `deleted` |

Phone calls are deliberately **not** logged.

A no-op update writes nothing. Without that guard the Activity tab would fill
with meaningless `updated` rows on every sync pull, since the client
re-upserts rows while pulling.

## Search

`search_guests(q)` backs both the search bar and the "already added?" warning
on the add screen.

It uses `word_similarity(q, name) > 0.25`, not `similarity()`. Plain
similarity diffs the query against the *whole* string, so
`similarity('rza','Raza Family')` is only 0.14 and a typo would find nothing.
`word_similarity` compares against each word and scores the same pair 0.29.

Threshold measured against the real name set:

| Query | Name | Score | Match |
|---|---|---|---|
| `rza` | Raza Family | 0.286 | yes |
| `far` | Farooq Family | 0.750 | yes |
| `raza` | Bokhari Family | 0.000 | no |
| `khan` | Kareem Family | 0.200 | no |

## After deploying

`006_verify.sql` checks the database. That is necessary but not sufficient —
also prove the shipped key is blocked from outside:

```bash
curl "$SUPABASE_URL/rest/v1/guests?select=*" -H "apikey: $SUPABASE_ANON_KEY"
```

Expect a permission-denied error, **not** rows. Rows here mean the `anon`
revoke did not take effect and the guest list is readable by anyone who
decompiles the APK.

Set the event dates once, either by editing the commented statements in
`005_seed.sql` or from the table editor.

## Backup note

The free tier has no automatic backups. Occasionally dump from
**Dashboard → Database → Backups**, or run `supabase db dump`. This is the
only copy of the guest list.