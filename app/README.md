# weddingSync — app

React Native (Expo) client for the wedding guest list and task board.
Android-first, sized for family members with medium tech literacy.

## Setup

```bash
cd app
npm install
cp .env.example .env      # then paste your Supabase URL + anon key
npm start                 # scan the QR with Expo Go
```

No Android SDK, JDK or Gradle required. Releases are built in the cloud
with EAS Build; nothing is compiled locally.

## Environment

`.env` is gitignored. Two values are required:

| Variable | Where to find it |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Dashboard → Project Settings → API |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | same page — "publishable" (new) or "anon" (old) |
| `EXPO_PUBLIC_FAMILY_MEMBERS` | comma-separated names for the picker |

The anon key ships inside the APK and is public by design — `supabase/003_rls.sql`
revokes every privilege from the `anon` role, which is what makes that safe.
**Never** put the `secret` / `service_role` key here; it bypasses RLS.

`EXPO_PUBLIC_*` variables are inlined into the bundle at build time.

## Architecture

```
app/                       expo-router routes
src/
  config.ts                env parsing + validation
  theme.ts                 colour, spacing, type scale
  similarity.ts            local fuzzy name matching for the duplicate hint
  lib/supabase.ts          client, anonymous sign-in, profile claim
  db/
    local.ts               SQLite schema, outbox, sync cursors
    queries.ts             all reads (local only)
    sync.ts                push outbox, pull deltas
  export/
    load.ts                reads the list into one model
    model.ts               the model, and the wording both files share
    xlsx.ts                Excel writer (OOXML assembled by hand)
    print.ts               the A4 print page
  state/session.ts         who is using the app right now
supabase/                  SQL: schema, triggers, RLS, views, verify
```

### Offline-first

The UI reads **only** from local SQLite. Nothing on screen waits for the
network, so the app works on patchy signal and keeps working in airplane
mode.

- **Write**: local insert → row queued in `outbox` → flushed on the next sync.
  Ids are generated client-side, so a retry after a failed request is a
  no-op rather than a duplicate.
- **Read**: pull on app start — landing on the front page, before any name
  is picked — whenever the app returns to the foreground, and once a minute
  while the app stays open; fetching only rows changed since the last
  cursor. Pull-to-refresh and a tap on the sync bar sync on demand. Opening
  a tab does not sync: every screen reads from SQLite, so a tap never waits
  on the network.
- **Timestamps** are owned by the server. A phone with a wrong clock must not
  be able to hide its changes from the rest of the family, so the client
  never writes `updated_at`.
- **Duplicate check**: "possible duplicate" names are matched from the same
  local rows, so the hint works offline and never waits on the network. The
  query is debounced and only shown once typing pauses, so the form does not
  move under the user's hands.

Two cursors, for two reasons: data tables use `updated_at` with a 60-second
overlap (two rows can share a timestamp, and re-pulling is free at this
size), while `activity_log` uses its monotonic sequence id, which cannot
skip or collide.

### Identity without login

`signInAnonymously()` gives each device a real `auth.uid()` that nobody ever
sees or types. The name picker writes a display name bound to that id, and
the audit triggers record `auth.uid()` server-side — so "who did this" comes
from the database, not from a client that could be modified. Anonymous users
still act as the `authenticated` role, so RLS applies normally.

The picker is the app's front page: every launch opens it, and it stays
underneath the tabs, so Back from the family list returns to it instead of
closing the app. Clearing app data mints a fresh anonymous id; picking the
name again is one tap.

### Export

The family list leaves the phone in two shapes, both built from SQLite, so
both work with no signal:

- **Excel (`.xlsx`)** — one sheet per event, named after it: that event's
  families with the numbers that apply to that event — the event's own
  where set, otherwise the family's — and a bold `TOTAL` row for the sheet. Families nobody has put on an event yet get a last sheet
  of their own. Handed to `expo-sharing`, so it can go to Drive, WhatsApp
  or mail.
- **Print (A4)** — the same lists for the phone's print dialog
  (`expo-print`), where "Save as PDF" lives too: one event to a page,
  headings repeated when a list runs over, and nothing on the paper but
  the event, its date, its families and its numbers.

There is no union table in either file: a union answers a question nobody
prints. A family coming to two events is on both lists, listed once each.

`src/export/xlsx.ts` assembles the OOXML by hand instead of pulling in a
spreadsheet library, because the thing this file must get right is
printing on A4 — paper size 9, one page wide, row 1 repeated as the print
title, page numbers in the footer — and that is not something the
libraries express. `tests/test_export_xlsx.py` compiles the writer, runs it
under node and takes the resulting file apart part by part, with
LibreOffice opening it when LibreOffice is installed.

Both files obey the app's counting rules: a count nobody recorded prints
as "—" rather than 0, and a list nobody has counted says nothing at all
rather than claiming nobody is coming.

## Design constraints

Set for the older half of the family, deliberately:

- body text starts at 16sp, headings at 20sp
- a strict 4dp spacing rhythm; screen padding is 16dp
- minimum tap target 56dp, above the 48dp platform minimum
- 1dp borders at rest; 2dp only for selected, warning, or deliberately emphasised controls
- field labels and section headings are set in the brand maroon, so the accent is the same on every screen; grey is reserved for secondary text, never for a label
- per-event numbers are grey while they follow the family's numbers and switch to maroon the moment that event has its own — no extra wording needed
- three tabs, never deeper than two screens
- no swipe gestures, no hidden affordances
- every destructive action asks first
- `null` counts render as "Not counted" rather than `0`, so an incomplete
  headcount is never silently wrong; a family is only flagged "not counted
  yet" when no event has a positive side or a complete pair -- a lone `0`
  with the other side blank does not count

## Permissions

No dangerous permissions. No `CALL_PHONE` (calls go through a `tel:` intent,
which needs nothing and lets the user see the number before dialling), no
`READ_CALL_LOG` (Google Play restricts it to the default phone handler
anyway, and asking family for it would be a bad trade), no contacts, camera
or microphone. Nothing prompts the user at install.

The release manifest carries `INTERNET` plus standard Expo entries such as
`VIBRATE` and an inert `SYSTEM_ALERT_WINDOW` from Expo's template. None of
these prompt for consent.

## Known issue: `NativeDatabase.prepareAsync` NullPointerException

If you see this on Android:

```
Call to function 'NativeDatabase.prepareAsync' has been rejected.
→ Caused by: java.lang.NullPointerException
```

it is an **upstream Expo bug**, not a problem with this app.
[expo/expo#48999](https://github.com/expo/expo/issues/48999) traces it to
[expo#35818](https://github.com/expo/expo/issues/35818), which removed a
2024 refcount guard (expo#27748) in April 2025. The guard is absent in
**SDK 53 through 57**.

On Android, when the JavaScript runtime is torn down while the OS process
survives, a garbage-collected JS wrapper closes the shared native
database. Every subsequent statement then rejects with a bare NPE — no
SQLite text at all, because fbjni is dereferencing a destroyed pointer.
A plain reopen returns the same poisoned handle, so it never recovers;
only `useNewConnection: true` does.

**It reproduces in Expo Go and not in development builds or EAS builds.**
Expo Go's reload-heavy JS lifecycle is what triggers it. The Expo
maintainer confirmed this on the upstream thread.

Three things reduce the impact:

1. `getDb()` caches the open *promise*, not the resolved handle, so
   concurrent callers cannot register two JS wrappers for one database.
2. No `withTransactionAsync` anywhere. A transaction opens a second
   native connection, and extra handles are exactly the trigger. The
   cursor only advances after the writes land, so an interrupted pull
   re-fetches the same range; every write is an idempotent upsert, so a
   transaction bought nothing.
3. `withRecovery()` in `src/db/local.ts` detects the exact error shape
   and retries once against a fresh connection.

If it still recurs in Expo Go, the fix is a development build rather than
more workarounds:

```bash
npx eas-cli@latest build:configure
npx eas-cli@latest build --platform android --profile development
```

## Commands

```bash
npm start             # Metro; scan the QR with Expo Go
npm run typecheck     # tsc --noEmit
npm run doctor        # expo-doctor dependency + config checks
npm run export        # bundle to verify it compiles
python3 tests/test_sync_sql.py     # SQL shapes against a real SQLite engine
python3 tests/test_export_xlsx.py  # builds the .xlsx and reads it back apart
python3 tests/test_export_print.py # prints the A4 page and inspects the paper
```

### Why a SQL test exists

`tsc` cannot see either of these, because SQLite only validates a
statement when it runs:

- omitting a `NOT NULL` column from an INSERT — every save failed with
  `NOT NULL constraint failed: guests.created_at`
- using `INSERT OR REPLACE`, which silently resets `created_at` to "now"
  on every edit and rewrites the audit story

`tests/test_sync_sql.py` reproduces `writeLocal()`'s statement construction
against a real in-memory SQLite database and asserts the shapes hold: every
table inserts, `created_at` survives edits, `card_sent` round-trips as
0/1, null counts stay null rather than becoming 0, and the local schema in
`src/db/local.ts` has not drifted from the copy the test runs.

## Building a release APK

Not yet wired up. When the time comes:

```bash
npx eas-cli@latest login
npx eas-cli@latest build:configure
npx eas-cli@latest build --platform android --profile preview
```

EAS Free allows 15 Android builds/month on a low-priority queue, which is
far more than this project needs — build once at the end, when guests and
tasks both work.

## Status

All seven screens are implemented and the app compiles:

- **Name picker** — the front page; one tap, works offline from
  `EXPO_PUBLIC_FAMILY_MEMBERS`, and carries the sync status bar so the
  phone declares where it stands before anyone starts editing
- **Families** — union headcount bar ("—" rather than a total of 0 when
  nobody has been counted yet), per-event filter chips carrying their own
  counts, search, call button, add-family FAB; the warning looks across
  events — a positive side or a complete `0/0` pair counts, a lone `0`
  with the other side blank does not
- **Add/edit family** — name, phone, male/female steppers, event multi-select;
  a compact "possible duplicate" hint sits under the name field (only for
  names near in spelling) and opens a short review dialog, so the form never
  grows a long list or scrolls while typing
- **Family detail** — dialler, one card checkbox and one numbers row per
  event the family is actually invited to, numbers edited inline (grey while
  following the family's, maroon once the event has its own); the trail for
  the family lives on the Activity tab
- **Tasks** — Open/Done tabs, category, assignee, overdue marking, and a task
  detail screen with its own trail
- **Activity** — global feed filterable by cards / families / tasks, with
  relative timestamps
- **Export** — reached from the Families header; writes the Excel sheet and
  opens the A4 print page, both offline

Still to do: nothing blocking. The remaining work is the EAS release build.