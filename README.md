# weddingSync

Offline-first Android app for coordinating a wedding: the family list, the
invitation-card book, and the task board. One shared backend, no separate
front- and back-end deploy.

This repo is split into two top-level directories by **concern**:

```
weddingSync/
├── app/        Expo / React Native client (Android-first, offline-first)
└── supabase/   SQL backend: schema, RLS, views, seeds, verification scripts
```

`app/` and `supabase/` do not import from each other — they only agree on
column names and types. Anything in one would have to be pasted into the
Supabase SQL editor or run by Metro; there is no build-time dependency
between them. That is why they sit side by side rather than one inside
the other.

## Quick links

- Client setup and architecture: [`app/README.md`](app/README.md)
- Agent / lint / run commands: [`app/AGENTS.md`](app/AGENTS.md)
- Database deploy order and access model: [`supabase/README.md`](supabase/README.md)

## How it works in one paragraph

Families are rows, not people. Phone numbers, male/female counts and event
attendance live on related tables. Cards are tracked per family *per event*.
The device writes to local SQLite first, queues the change in an outbox, and
flushes when it can. Reads come from the local mirror only. Supabase holds
the canonical copy, the triggers own the audit trail, and RLS (revoked well
before granted) keeps the public anon key harmless. The list exports to an
Excel sheet and to an A4 print page, both built on the phone.

## Local-first promises

- No `CALL_PHONE`, `READ_CALL_LOG`, contacts, camera or microphone permissions
- No password or email — name picker + anonymous Supabase sign-in
- Headcount is a union, not a sum: overlapping events never triple-count
- nullable counts mean "not recorded", never zero

## Ground rules

- Never paste `supabase/tests/*.sql` into the Supabase SQL editor — local only
- Never put the `service_role` key in `app/.env`
- Clear app data between big sync changes, or wait for the self-heal pass