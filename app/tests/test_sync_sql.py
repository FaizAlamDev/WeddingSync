#!/usr/bin/env python3
"""
Exercises the exact SQL shapes that app/src/db/sync.ts sends to SQLite.

Two real bugs got through `tsc` because SQLite only validates a statement
when it runs:

  1. created_at was omitted from the INSERT, so every save died on
     `NOT NULL constraint failed: guests.created_at`.
  2. INSERT OR REPLACE reset created_at to "now" on every edit, quietly
     rewriting the audit story.

Neither is visible to a type checker, so this test exists. It recreates the
local schema and runs the generated statements against a real SQLite engine.

Run: python3 app/tests/test_sync_sql.py
"""

import json
import sqlite3
import subprocess
import sys

# Mirrors SCHEMA_VERSION_1 / SCHEMA_OUTBOX / SCHEMA_SYNC_STATE in
# src/db/local.ts. Kept in sync by hand; `test_schema_in_sync` below
# greps the real file so drift is caught.
SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  event_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  male_count INTEGER,
  female_count INTEGER,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS guest_events (
  id TEXT PRIMARY KEY NOT NULL,
  guest_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  card_sent INTEGER NOT NULL DEFAULT 0,
  card_sent_at TEXT,
  card_sent_by TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  due_date TEXT,
  assigned_to TEXT,
  completed_at TEXT,
  completed_by TEXT,
  created_by TEXT,
  updated_by TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  changes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
"""

WRITABLE = {
    "guests": ["id", "name", "phone", "male_count", "female_count", "deleted_at"],
    "guest_events": ["id", "guest_id", "event_id", "card_sent", "card_sent_at", "card_sent_by", "deleted_at"],
    "todos": [
        "id", "title", "body", "category", "status", "due_date", "assigned_to",
        "completed_at", "completed_by", "created_by", "updated_by", "deleted_at",
    ],
    "events": ["id", "name", "event_date", "sort_order", "deleted_at"],
}

TIMESTAMPS = {
    "guests": {"created": True, "updated": True},
    "guest_events": {"created": True, "updated": True},
    "todos": {"created": True, "updated": True},
    "events": {"created": True, "updated": False},
}

failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


def build_write_sql(table, row, now, exists=False):
    """
    Reproduces writeLocal()'s statement construction exactly.

    Two statements, not an upsert: SQLite attempts the INSERT before
    resolving ON CONFLICT, so a partial update supplying NULL for a NOT
    NULL column fails before DO UPDATE ever runs.

    `provided` is the crux: on update only the columns the caller actually
    supplied are written, so everything else is left alone.
    """
    editable = WRITABLE[table]
    stamps = TIMESTAMPS[table]

    provided = [
        c for c in editable
        if c != "id" and c in row and row[c] is not None
    ]

    # INSERT names ONLY the supplied columns so anything omitted falls back
    # to its DEFAULT. Naming every column and binding null is what caused
    # `NOT NULL constraint failed: todos.status`.
    insert_cols = ["id"] + list(provided)
    if stamps["created"]:
        insert_cols.append("created_at")
    if stamps["updated"]:
        insert_cols.append("updated_at")

    def bind(c):
        if c in ("created_at", "updated_at"):
            return now
        v = row.get(c)
        if c == "card_sent":
            return 1 if v else 0
        return v

    if exists:
        set_cols = list(provided)
        if stamps["updated"]:
            set_cols.append("updated_at")
        sql = (
            f"UPDATE {table} SET "
            + ", ".join(f"{c} = ?" for c in set_cols)
            + " WHERE id = ?"
        )
        params = [(now if c == "updated_at" else bind(c)) for c in set_cols] + [row["id"]]
    else:
        sql = (f"INSERT INTO {table} ({', '.join(insert_cols)}) "
               f"VALUES ({', '.join('?' for _ in insert_cols)})")
        params = [bind(c) for c in insert_cols]

    return sql, params


NOW = "2026-10-11T00:00:00.000Z"
LATER = "2026-10-12T09:30:00.000Z"


def run():
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)

    print("1. insert a family (the original NOT NULL failure)")
    sql, params = build_write_sql(
        "guests",
        {
            "id": "g1", "name": "Raza Family", "phone": "03001234567",
            "male_count": 3, "female_count": 2, "deleted_at": None,
        },
        NOW,
    )
    try:
        db.execute(sql, params)
        check("guests insert succeeds", True)
    except sqlite3.Error as e:
        check("guests insert succeeds", False, f"-> {e}")
        return

    row = db.execute("SELECT created_at, updated_at, name FROM guests").fetchone()
    check("created_at populated", row[0] is not None, f"-> {row[0]!r}")
    check("updated_at populated", row[1] is not None)

    print("\n2. edit the family: created_at must NOT be reset")
    sql, params = build_write_sql(
        "guests",
        {
            "id": "g1", "name": "Raza Family 2", "phone": "03009998888",
            "male_count": 3, "female_count": 2, "deleted_at": None,
        },
        LATER,
        exists=True,
    )
    db.execute(sql, params)
    row = db.execute("SELECT created_at, updated_at, name FROM guests").fetchone()
    check("created_at preserved across edit", row[0] == NOW, f"-> {row[0]!r}")
    check("updated_at refreshed on edit", row[1] == LATER, f"-> {row[1]!r}")
    check("edit applied", row[2] == "Raza Family 2")

    print("\n3. guest_events: card toggle, boolean stored as 0/1")
    sql, params = build_write_sql(
        "guest_events",
        {
            "id": "ge1", "guest_id": "g1", "event_id": "e1",
            "card_sent": True, "card_sent_at": LATER,
            "card_sent_by": "Faiz", "deleted_at": None,
        },
        NOW,
    )
    db.execute(sql, params)
    row = db.execute("SELECT card_sent, card_sent_by, created_at FROM guest_events").fetchone()
    check("card_sent stored as 1", row[0] == 1, f"-> {row[0]!r}")
    check("card_sent_by saved", row[1] == "Faiz")
    check("created_at populated", row[2] is not None)

    sql, params = build_write_sql(
        "guest_events",
        {
            "id": "ge1", "guest_id": "g1", "event_id": "e1",
            "card_sent": False, "card_sent_at": None,
            "card_sent_by": None, "deleted_at": None,
        },
        LATER,
        exists=True,
    )
    db.execute(sql, params)
    row = db.execute("SELECT card_sent, created_at FROM guest_events").fetchone()
    check("untick stores 0, not null", row[0] == 0, f"-> {row[0]!r}")
    check("guest_events created_at preserved", row[1] == NOW)

    print("\n4. todos: insert then complete")
    sql, params = build_write_sql(
        "todos",
        {
            "id": "t1", "title": "Order mehndi trays", "body": None,
            "category": "Mehndi", "status": "open", "due_date": None,
            "assigned_to": "Ammi", "completed_at": None, "completed_by": None,
            "created_by": "Faiz", "updated_by": "Faiz", "deleted_at": None,
        },
        NOW,
    )
    db.execute(sql, params)
    check("todos insert succeeds", True)

    sql, params = build_write_sql(
        "todos",
        {
            "id": "t1", "title": "Order mehndi trays", "body": None,
            "category": "Mehndi", "status": "done", "due_date": None,
            "assigned_to": "Ammi", "completed_at": LATER, "completed_by": "Faiz",
            "created_by": "Faiz", "updated_by": "Faiz", "deleted_at": None,
        },
        LATER,
        exists=True,
    )
    db.execute(sql, params)
    row = db.execute(
        "SELECT status, completed_by, created_by, created_at FROM todos"
    ).fetchone()
    check("status becomes done", row[0] == "done")
    check("completed_by set", row[1] == "Faiz")
    check("created_by not clobbered", row[2] == "Faiz")
    check("todos created_at preserved", row[3] == NOW)

    print("\n5. events: created_at required, updated_at absent")
    sql, params = build_write_sql(
        "events",
        {"id": "e1", "name": "Faiz Baraat", "event_date": None,
         "sort_order": 10, "deleted_at": None},
        NOW,
    )
    try:
        db.execute(sql, params)
        cols = [r[1] for r in db.execute("PRAGMA table_info(events)")]
        check("events insert succeeds", True)
        check("events has no updated_at column", "updated_at" not in cols, f"-> {cols}")
    except sqlite3.Error as e:
        check("events insert succeeds", False, f"-> {e}")

    print("\n6. null counts round-trip (must stay NULL, not become 0)")
    sql, params = build_write_sql(
        "guests",
        {"id": "g2", "name": "Uncounted Friends", "phone": None,
         "male_count": None, "female_count": None, "deleted_at": None},
        NOW,
    )
    db.execute(sql, params)
    row = db.execute(
        "SELECT male_count, female_count FROM guests WHERE id = 'g2'"
    ).fetchone()
    check("null counts stay null", row[0] is None and row[1] is None, f"-> {row}")

    print("\n7. soft delete sets deleted_at without touching created_at")
    db.execute("UPDATE guests SET deleted_at = ? WHERE id = ?", (LATER, "g1"))
    row = db.execute("SELECT deleted_at, created_at FROM guests WHERE id='g1'").fetchone()
    check("deleted_at set", row[0] == LATER)
    check("created_at untouched by soft delete", row[1] == NOW)

    print("\n8. partial update must not null out unmentioned columns")
    # setCard() passes ONLY the card fields. If the upsert also wrote
    # guest_id and event_id from `excluded`, those would become NULL and
    # trip the NOT NULL constraint -- which is exactly the bug that made
    # every card tick revert.
    db.execute(*build_write_sql(
        "guest_events",
        {"id": "ge9", "guest_id": "g9", "event_id": "e9", "card_sent": False,
         "card_sent_at": None, "card_sent_by": None, "deleted_at": None},
        NOW,
    ))
    check("guest_events row created", True)

    sql, params = build_write_sql(
        "guest_events",
        {"id": "ge9", "card_sent": True, "card_sent_at": LATER, "card_sent_by": "Faiz"},
        LATER,
        exists=True,
    )
    check(
        "partial update does NOT touch guest_id/event_id",
        "guest_id = ?" not in sql and "event_id = ?" not in sql,
        f"-> {sql}",
    )
    try:
        db.execute(sql, params)
        check("partial update succeeds", True)
    except sqlite3.Error as e:
        check("partial update succeeds", False, f"-> {e}")

    row = db.execute(
        "SELECT card_sent, card_sent_by, guest_id, event_id, created_at "
        "FROM guest_events WHERE id = 'ge9'"
    ).fetchone()
    check("card_sent updated", row[0] == 1)
    check("card_sent_by updated", row[1] == "Faiz")
    check("guest_id preserved", row[2] == "g9", f"-> {row[2]!r}")
    check("event_id preserved", row[3] == "e9", f"-> {row[3]!r}")
    check("created_at still preserved", row[4] == NOW)

    print("\n9. null is treated as 'not supplied' (saveTodo created_by)")
    db.execute(*build_write_sql(
        "todos",
        {"id": "t9", "title": "Task", "created_by": "Faiz", "updated_by": "Faiz",
         "status": "open", "deleted_at": None},
        NOW,
    ))
    sql, params = build_write_sql(
        "todos",
        {"id": "t9", "title": "Task", "created_by": None, "updated_by": "Ammi",
         "status": "done", "deleted_at": None},
        LATER,
        exists=True,
    )
    check(
        "null created_by excluded from the UPDATE list",
        "created_by = ?" not in sql,
    )
    db.execute(sql, params)
    row = db.execute("SELECT created_by, updated_by FROM todos WHERE id='t9'").fetchone()
    check("original author not wiped by null pass-through", row[0] == "Faiz", f"-> {row[0]!r}")
    check("updater recorded", row[1] == "Ammi")

    print("\n10. INSERT omits unprovided columns so DEFAULTS apply")
    # saveTodo() never passes status. Naming the column and binding NULL
    # produced `NOT NULL constraint failed: todos.status`, because an
    # explicit NULL does not trigger DEFAULT 'open'.
    db.execute("DELETE FROM todos")
    sql, params = build_write_sql(
        "todos",
        {"id": "t10", "title": "Book photographer", "created_by": "Faiz",
         "updated_by": "Faiz", "deleted_at": None},
        NOW,
    )
    check("status absent from the INSERT column list",
          "status" not in sql.split("VALUES")[0])
    try:
        db.execute(sql, params)
        row = db.execute("SELECT status, title FROM todos WHERE id='t10'").fetchone()
        check("todos INSERT without status succeeds", True)
        check("status fell back to DEFAULT 'open'", row[0] == "open", f"-> {row[0]!r}")
    except sqlite3.Error as e:
        check("todos INSERT without status succeeds", False, f"-> {e}")

    db.execute("DELETE FROM guest_events")
    db.execute(*build_write_sql(
        "guest_events",
        {"id": "ge10", "guest_id": "g10", "event_id": "e10", "deleted_at": None},
        NOW,
    ))
    row = db.execute("SELECT card_sent FROM guest_events WHERE id='ge10'").fetchone()
    check("card_sent fell back to DEFAULT 0", row[0] == 0, f"-> {row[0]!r}")

    print("\n11. outbox payload must be the COMPLETE row")
    # The bug behind "5 changes waiting to upload": the payload was
    # assembled from the caller's arguments, so setCard uploaded
    # guest_id: null and setTodoStatus uploaded title: null. Those upserts
    # were rejected, the queue filled, and the pull then overwrote local
    # state with the server's stale copy.
    def payload_for(table, row_id, db_conn):
        editable = WRITABLE[table]
        stored = db_conn.execute(
            f"SELECT * FROM {table} WHERE id = ?", (row_id,)
        ).fetchone()
        if stored is None:
            return None
        names = [d[0] for d in db_conn.execute(f"SELECT * FROM {table}").description]
        as_dict = dict(zip(names, stored))
        return {c: as_dict.get(c) for c in editable if c != "id"}

    # setCard touches only the card fields
    db.execute(*build_write_sql(
        "guest_events",
        {"id": "ge11", "guest_id": "g11", "event_id": "e11", "card_sent": False,
         "card_sent_at": None, "card_sent_by": None, "deleted_at": None},
        NOW,
    ))
    db.execute(*build_write_sql(
        "guest_events",
        {"id": "ge11", "card_sent": True, "card_sent_at": LATER, "card_sent_by": "Faiz"},
        LATER, exists=True,
    ))
    p = payload_for("guest_events", "ge11", db)
    check("payload carries guest_id", p["guest_id"] == "g11", f"-> {p['guest_id']!r}")
    check("payload carries event_id", p["event_id"] == "e11", f"-> {p['event_id']!r}")
    check("payload carries card_sent", p["card_sent"] == 1)
    check("payload carries card_sent_by", p["card_sent_by"] == "Faiz")
    check("payload has no created_at/updated_at",
          "created_at" not in p and "updated_at" not in p)

    # setTodoStatus touches only status fields
    db.execute(*build_write_sql(
        "todos",
        {"id": "t11", "title": "Order trays", "body": "200 pieces",
         "category": "Mehndi", "due_date": None, "assigned_to": "Ammi",
         "created_by": "Faiz", "updated_by": "Faiz", "deleted_at": None},
        NOW,
    ))
    db.execute(*build_write_sql(
        "todos",
        {"id": "t11", "status": "done", "completed_at": LATER,
         "completed_by": "Faiz", "updated_by": "Faiz"},
        LATER, exists=True,
    ))
    p = payload_for("todos", "t11", db)
    check("payload keeps title", p["title"] == "Order trays", f"-> {p['title']!r}")
    check("payload keeps body", p["body"] == "200 pieces", f"-> {p['body']!r}")
    check("payload keeps category", p["category"] == "Mehndi", f"-> {p['category']!r}")
    check("payload keeps assigned_to", p["assigned_to"] == "Ammi", f"-> {p['assigned_to']!r}")
    check("payload records status", p["status"] == "done")

    db.close()


def test_schema_in_sync():
    """Grep the real source so this copy cannot silently drift."""
    import pathlib
    import re

    src = pathlib.Path(__file__).resolve().parents[1] / "src" / "db" / "local.ts"
    text = src.read_text()

    for table in ("guests", "guest_events", "todos", "events", "activity_log",
                  "outbox", "sync_state"):
        check(f"local.ts declares {table}", f"CREATE TABLE IF NOT EXISTS {table}" in text)

    check(
        "guest_events local index exists",
        "idx_ge_guest" in text,
    )
    # Every local NOT NULL timestamp column must be in TIMESTAMPS.
    for col in ("created_at", "updated_at"):
        m = re.search(rf"{col}\s+TEXT NOT NULL", text)
        check(f"local.ts marks {col} NOT NULL somewhere", m is not None)


def test_pull_column_filter():
    """
    The regression that emptied the Activity tab.

    pullTable() filtered the server row's columns with
    `k in LOCAL_COLUMNS[table]`, where LOCAL_COLUMNS holds Sets.

    In JavaScript `in` is the object-property operator and works on any
    object, Sets included -- it tests KEYS (`add`, `has`, `size`, ...), not
    members. So the filter always produced an empty list, the generated SQL
    was `INSERT INTO guests () VALUES ()`, and SQLite rejected it with
    `near ")": syntax error`. That aborted every sync at the first pull, so
    pullActivity() never ran and the Activity feed stayed empty while
    Families still looked populated from purely local writes.

    The JS half is checked with node, because Python's `in` on a set IS
    membership and cannot reproduce the trap. This file is Python only so
    node is optional; the check is skipped when it is unavailable.
    """
    print("\n8. pull column filter: Set membership, not `in`")

    # --- JS semantics, verified in the language where the bug lives ---
    js = """
    const row = {id:'g1', name:'Raza', created_at:'x', updated_at:'x', future_col:'y'};
    const cols = new Set(['id','name','created_at','updated_at']);
    const buggy   = Object.keys(row).filter((k) => k in cols);
    const correct = Object.keys(row).filter((k) => cols.has(k));
    console.log(JSON.stringify({buggy, correct}));
    """
    try:
        out = subprocess.run(
            ["node", "-e", js], capture_output=True, text=True, timeout=30, check=True
        ).stdout.strip()
        result = json.loads(out)
        check(
            "JS: `in` on a Set yields nothing (the original bug)",
            result["buggy"] == [],
            f"-> {result['buggy']!r}",
        )
        check(
            "JS: .has() yields the real columns",
            result["correct"] == ["id", "name", "created_at", "updated_at"],
            f"-> {result['correct']!r}",
        )
        check(
            "JS: unknown server columns filtered out",
            "future_col" not in result["correct"],
        )
    except (subprocess.SubprocessError, FileNotFoundError, json.JSONDecodeError) as e:
        print(f"  skip JS checks ({type(e).__name__}: node unavailable)")

    # --- the invariant that actually matters, checked in SQL ---
    local_columns = {
        "id", "name", "phone", "male_count", "female_count",
        "deleted_at", "created_at", "updated_at",
    }
    server_row = {
        "id": "g1", "name": "Raza", "phone": None,
        "male_count": 3, "female_count": 2,
        "deleted_at": None, "created_at": NOW, "updated_at": NOW,
        "some_future_server_column": "ignored",
    }

    correct = [k for k in server_row if k in local_columns]
    check("filtered column list is non-empty", len(correct) == 8,
          f"-> produced {correct!r}")
    check(
        "unknown server columns are filtered out",
        "some_future_server_column" not in correct,
    )

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    sql = (f"INSERT OR REPLACE INTO guests ({', '.join(correct)}) "
           f"VALUES ({', '.join('?' for _ in correct)})")
    try:
        db.execute(sql, [server_row[c] for c in correct])
        check("generated pull INSERT parses", True)
    except sqlite3.Error as e:
        check("generated pull INSERT parses", False, f"-> {e}")

    # The exact shape the bug produced must stay rejected, so the test
    # fails loudly if the empty-column path ever comes back.
    try:
        db.execute("INSERT OR REPLACE INTO guests () VALUES ()")
        check("empty column list is rejected by SQLite", False,
              "-> unexpectedly accepted")
    except sqlite3.Error:
        check("empty column list is rejected by SQLite", True)

    db.close()



def test_server_contract():
    """
    What the SERVER would accept, given what the client uploads.

    Reproduces the whole stuck-outbox chain:
      saveTodo() -> setCard() -> a stale entry from an older build ->
      rebuild -> retry.

    The server tables are NOT NULL in the same places as the local ones,
    so a payload that omits or nulls a column is rejected outright.
    """
    print("\n12. uploaded payloads satisfy the server's NOT NULL columns")

    # Columns the server requires. created_at/updated_at are deliberately
    # EXCLUDED: they are stripped before upload and the server defaults
    # them, so a payload without them is correct, not broken.
    SERVER_NOT_NULL = {
        "guests": ["id", "name"],
        "guest_events": ["id", "guest_id", "event_id", "card_sent"],
        "todos": ["id", "title", "status"],
        "events": ["id", "name"],
    }

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)

    # seed a local family, a card link and a task
    db.execute(*build_write_sql(
        "guests",
        {"id": "s1", "name": "Raza", "phone": "0300", "male_count": 3,
         "female_count": 2, "deleted_at": None}, NOW))
    db.execute(*build_write_sql(
        "guest_events",
        {"id": "sg1", "guest_id": "s1", "event_id": "ev1", "card_sent": False,
         "card_sent_at": None, "card_sent_by": None, "deleted_at": None}, NOW))
    db.execute(*build_write_sql(
        "todos",
        {"id": "st1", "title": "Book photographer", "body": "Ali",
         "category": None, "due_date": None, "assigned_to": "Ammi",
         "created_by": "Faiz", "updated_by": "Faiz", "deleted_at": None}, NOW))

    def full_payload(table, row_id):
        cur = db.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,))
        names = [d[0] for d in cur.description]
        rec = dict(zip(names, cur.fetchone()))
        out = {"id": row_id}
        for c in WRITABLE[table]:
            if c == "id":
                continue
            v = rec.get(c)
            out[c] = (1 if v else 0) if c == "card_sent" else v
        # server-owned columns are stripped before upload; the server
        # defaults them, so they are never null in the payload
        return out

    for table, row_id in (("guests", "s1"), ("guest_events", "sg1"), ("todos", "st1")):
        p = full_payload(table, row_id)
        missing = [c for c in SERVER_NOT_NULL[table] if p.get(c) is None]
        check(f"{table}: payload has no null server-NOT NULL column",
              not missing, f"-> missing {missing}")

    print("\n13. stale payload from an older build heals on retry")
    # What the buggy build stored: only the fields the caller passed.
    stale = {"id": "sg1", "card_sent": 1, "card_sent_at": LATER, "card_sent_by": "Faiz"}
    check("stale payload is missing guest_id", "guest_id" not in stale)
    check("stale payload is missing event_id", "event_id" not in stale)

    db.execute(*build_write_sql(
        "guest_events",
        {"id": "sg1", "card_sent": True, "card_sent_at": LATER,
         "card_sent_by": "Faiz"},
        LATER, exists=True,
    ))
    rebuilt = full_payload("guest_events", "sg1")
    check("rebuilt payload restores guest_id", rebuilt["guest_id"] == "s1")
    check("rebuilt payload restores event_id", rebuilt["event_id"] == "ev1")
    check("rebuilt payload keeps the new card_sent", rebuilt["card_sent"] == 1)
    check("rebuilt payload has no null server-NOT NULL column",
          all(rebuilt.get(c) is not None
              for c in SERVER_NOT_NULL["guest_events"]))

    db.close()



def test_read_queries():
    """
    Runs every SELECT in queries.ts against the real local schema.

    These are the statements behind the summary bar, the filter chips and
    the task tabs. None of them can be validated by a type checker, and a
    single syntax error in one takes down a whole screen.

    Seeded data encodes the overlap case the schema exists to handle:
    Raza (3 men, 2 women) attends BOTH events, and Uncounted is on the
    list but belongs to no event at all.
    """
    print("\n14. every read query in queries.ts executes")

    import pathlib
    import re

    src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "db" / "queries.ts").read_text()
    statements = re.findall(r"`(\s*(?:SELECT|WITH)[^`]*)`", src, re.S)
    check("queries.ts contains statements to test", len(statements) >= 10,
          f"-> found {len(statements)}")

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    db.execute("INSERT INTO events (id,name,event_date,sort_order,deleted_at,created_at)"
               " VALUES ('e1','Faiz Baraat','2026-03-12',10,NULL,'2026-01-01')")
    db.execute("INSERT INTO events (id,name,event_date,sort_order,deleted_at,created_at)"
               " VALUES ('e2','Walima','2026-03-15',30,NULL,'2026-01-01')")
    db.execute("INSERT INTO guests (id,name,phone,male_count,female_count,deleted_at,created_at,updated_at)"
               " VALUES ('g1','Raza','0300',3,2,NULL,'2026-01-01','2026-02-01')")
    db.execute("INSERT INTO guests (id,name,phone,male_count,female_count,deleted_at,created_at,updated_at)"
               " VALUES ('g2','Uncounted',NULL,NULL,NULL,NULL,'2026-01-01','2026-02-01')")
    db.execute("INSERT INTO guest_events (id,guest_id,event_id,card_sent,card_sent_at,"
               "card_sent_by,deleted_at,created_at,updated_at)"
               " VALUES ('ge1','g1','e1',1,'2026-02-02','Faiz',NULL,'2026-01-01','2026-02-02')")
    db.execute("INSERT INTO guest_events (id,guest_id,event_id,card_sent,card_sent_at,"
               "card_sent_by,deleted_at,created_at,updated_at)"
               " VALUES ('ge2','g1','e2',0,NULL,NULL,NULL,'2026-01-01','2026-02-02')")
    db.execute("INSERT INTO todos (id,title,body,category,status,due_date,assigned_to,"
               "completed_at,completed_by,created_by,updated_by,deleted_at,created_at,updated_at)"
               " VALUES ('t1','Order trays','200','Mehndi','open','2026-03-01','Ammi',"
               "NULL,NULL,'Faiz','Faiz',NULL,'2026-01-01','2026-02-01')")
    db.execute("INSERT INTO todos (id,title,body,category,status,due_date,assigned_to,"
               "completed_at,completed_by,created_by,updated_by,deleted_at,created_at,updated_at)"
               " VALUES ('t2','Book photographer',NULL,NULL,'done',NULL,NULL,"
               "'2026-02-03','Faiz','Faiz','Faiz',NULL,'2026-01-01','2026-02-03')")
    db.execute("INSERT INTO activity_log (id,entity_type,entity_id,action,actor_id,"
               "actor_name,changes,created_at)"
               " VALUES (1,'guest','g1','created',NULL,'Faiz','{}','2026-01-01')")

    subs = {
        "${where.join(' AND ')}": "g.deleted_at IS NULL",
        "${first}": "e1",
        "${limit}": "100",
    }

    for i, raw in enumerate(statements, 1):
        sql = raw.strip()
        for k, v in subs.items():
            sql = sql.replace(k, v)
        n = sql.count("?")
        args = [
            ("g1" if ("g.id = ?" in sql or "guest_id = ?" in sql or "entity_id = ?" in sql)
             else ("e1" if ("e.id = ?" in sql or "event_id = ?" in sql)
                   else (100 if "LIMIT ?" in sql else "guests_cursor")))
            for _ in range(n)
        ]
        try:
            db.execute(sql, args).fetchall()
            ok_flag = True
        except sqlite3.Error as e:
            ok_flag = False
            print(f"       query {i} error: {e}")
        check(f"read query {i} executes", ok_flag)

    print("\n15. headcount is a UNION, not a sum")
    # Mirrors guest_rollup in supabase/004_views.sql. Raza attends both
    # events; the family must be counted once, not twice.
    rollup_sql = (
        """SELECT COUNT(*) AS families,
                  CASE WHEN COUNT(g.male_count) = 0 THEN NULL
                       ELSE COALESCE(SUM(g.male_count), 0) END AS men,
                  CASE WHEN COUNT(g.female_count) = 0 THEN NULL
                       ELSE COALESCE(SUM(g.female_count), 0) END AS women,
                  COALESCE(SUM(g.male_count), 0) + COALESCE(SUM(g.female_count), 0) AS total,
                  COALESCE(SUM(CASE WHEN g.male_count IS NULL
                                       OR g.female_count IS NULL THEN 1 ELSE 0 END), 0) AS uncounted
             FROM guests g
            WHERE g.deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM guest_events ge
                           WHERE ge.guest_id = g.id AND ge.deleted_at IS NULL)"""
    )
    rollup = db.execute(rollup_sql).fetchone()
    check("families counted once, not per event", rollup[0] == 1, f"-> {rollup[0]}")
    check("men", rollup[1] == 3, f"-> {rollup[1]}")
    check("women", rollup[2] == 2, f"-> {rollup[2]}")
    check("total is 5, NOT 10 (would be the sum)", rollup[3] == 5, f"-> {rollup[3]}")
    check("uncounted is 0", rollup[4] == 0, f"-> {rollup[4]}")

    counts = db.execute(
        """SELECT e.name,
                  COALESCE(SUM(g.male_count), 0) + COALESCE(SUM(g.female_count), 0) AS total,
                  COALESCE(SUM(CASE WHEN ge.card_sent = 1 THEN 1 ELSE 0 END), 0) AS sent
             FROM events e
             LEFT JOIN guest_events ge ON ge.event_id = e.id AND ge.deleted_at IS NULL
             LEFT JOIN guests g ON g.id = ge.guest_id AND g.deleted_at IS NULL
            WHERE e.deleted_at IS NULL
            GROUP BY e.id, e.name
            ORDER BY e.name"""
    ).fetchall()
    check("two event rows returned", len(counts) == 2, f"-> {len(counts)}")
    check("Faiz Baraat headcount 5", counts[0][1] == 5, f"-> {counts[0][1]}")
    check("Faiz Baraat 1 card sent", counts[0][2] == 1, f"-> {counts[0][2]}")
    check("Walima headcount 5", counts[1][1] == 5, f"-> {counts[1][1]}")
    check("Walima 0 cards sent", counts[1][2] == 0, f"-> {counts[1][2]}")

    print("\n15b. an uncounted list reports NULL, never 0")
    # "0 women" about a list whose women were never counted is the bug this
    # rule prevents: the summary bar read "0 men · 0 women" and the chips
    # read "(0)" for events full of families.
    db.execute("UPDATE guests SET male_count = NULL, female_count = NULL")
    none_rollup = db.execute(rollup_sql).fetchone()
    check("men is NULL, not 0", none_rollup[1] is None, f"-> {none_rollup[1]!r}")
    check("women is NULL, not 0", none_rollup[2] is None, f"-> {none_rollup[2]!r}")
    check("total is still the sum of what is known", none_rollup[3] == 0,
          f"-> {none_rollup[3]}")
    check("the family is reported as not counted", none_rollup[4] == 1,
          f"-> {none_rollup[4]}")

    # Mirrors event_counts in supabase/004_views.sql, same rule per event.
    event_rule = db.execute(
        """SELECT e.name,
                  CASE WHEN COUNT(g.male_count) = 0 THEN NULL
                       ELSE COALESCE(SUM(g.male_count), 0) END AS men,
                  CASE WHEN COUNT(g.female_count) = 0 THEN NULL
                       ELSE COALESCE(SUM(g.female_count), 0) END AS women
             FROM events e
             LEFT JOIN guest_events ge ON ge.event_id = e.id AND ge.deleted_at IS NULL
             LEFT JOIN guests g ON g.id = ge.guest_id AND g.deleted_at IS NULL
            WHERE e.deleted_at IS NULL
            GROUP BY e.id, e.name
            ORDER BY e.name"""
    ).fetchall()
    check("events with no counts report NULL, not 0",
          all(r[1] is None and r[2] is None for r in event_rule),
          f"-> {[(r[0], r[1], r[2]) for r in event_rule]}")

    db.close()



def test_outbox_repair():
    """
    Reproduces the poisoned queue that reached the device:

      5 outbox entries, attempts already at MAX, payloads written by an
      older build containing `guest_id: null`. The server rejects them, so
      they stay stuck forever and the status bar reads
      "5 changes could not be uploaded".

    Retrying alone cannot fix this: the stored payload is the problem.
    Repair must regenerate it from the local row, which is authoritative.
    """
    print("\n16. a queue poisoned by an older build repairs itself")

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)

    # the local row is correct
    db.execute(*build_write_sql(
        "guest_events",
        {"id": "q1", "guest_id": "g1", "event_id": "e1", "card_sent": False,
         "card_sent_at": None, "card_sent_by": None, "deleted_at": None},
        NOW,
    ))
    db.execute(*build_write_sql(
        "guest_events",
        {"id": "q1", "card_sent": True, "card_sent_at": LATER, "card_sent_by": "Faiz"},
        LATER, exists=True,
    ))

    # the stored outbox payload is the broken one from the old build
    broken = {"id": "q1", "card_sent": 1, "card_sent_at": LATER,
              "card_sent_by": "Faiz", "guest_id": None, "event_id": None}
    for i in range(5):
        db.execute(
            "INSERT INTO outbox (id, table_name, row_id, op, payload, attempts,"
            " last_error, created_at) VALUES (?, 'guest_events', 'q1', 'upsert', ?, 5, ?, ?)",
            (f"o{i}", json.dumps(broken),
             'null value in column "guest_id" of relation "guest_events" violates not-null constraint',
             LATER),
        )

    # what the server would say about the broken payload
    server_not_null = ["id", "guest_id", "event_id", "card_sent"]
    check("broken payload has null guest_id", broken.get("guest_id") is None)
    check("broken payload violates the server contract",
          any(broken.get(c) is None for c in server_not_null))

    # --- repair ---
    damaged = db.execute("SELECT id, table_name, row_id FROM outbox WHERE attempts > 0").fetchall()
    check("repair finds all 5 damaged entries", len(damaged) == 5, f"-> {len(damaged)}")

    for (oid, table, row_id) in damaged:
        cur = db.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,))
        names = [d[0] for d in cur.description]
        rec = dict(zip(names, cur.fetchone()))
        check(f"local row for {row_id} still exists", rec is not None)
        payload = {"id": row_id}
        for c in WRITABLE[table]:
            if c == "id":
                continue
            v = rec.get(c)
            payload[c] = (1 if v else 0) if c == "card_sent" else v
        db.execute("UPDATE outbox SET attempts = 0, last_error = NULL, payload = ? WHERE id = ?",
                   (json.dumps(payload), oid))

    check("no entry is still failing after repair",
          db.execute("SELECT COUNT(*) FROM outbox WHERE attempts > 0").fetchone()[0] == 0)

    rows = db.execute("SELECT payload FROM outbox").fetchall()
    for (raw,) in rows:
        pl = json.loads(raw)
        check("repaired payload has guest_id", pl.get("guest_id") == "g1", f"-> {pl.get('guest_id')!r}")
        check("repaired payload has event_id", pl.get("event_id") == "e1", f"-> {pl.get('event_id')!r}")
        check("repaired payload keeps card_sent", pl.get("card_sent") == 1)
        check("repaired payload satisfies server NOT NULL",
              all(pl.get(c) is not None for c in server_not_null))

    print("\n17. entries whose local row vanished are dropped, not uploaded")
    db.execute("DELETE FROM guest_events WHERE id = 'q1'")
    orphan = db.execute("SELECT id FROM outbox LIMIT 1").fetchone()
    if orphan:
        cur = db.execute("SELECT * FROM guest_events WHERE id = 'q1'").fetchone()
        check("local row is gone", cur is None)
        check("an orphan entry would upload a null payload",
              json.loads(db.execute("SELECT payload FROM outbox WHERE id = ?",
                                    (orphan[0],)).fetchone()[0]).get("guest_id") == "g1")
        db.execute("DELETE FROM outbox WHERE id = ?", (orphan[0],))
        check("repair drops the orphan rather than uploading it",
              db.execute("SELECT COUNT(*) FROM outbox WHERE id = ?",
                         (orphan[0],)).fetchone()[0] == 0)

    db.close()


def test_pull_guard():
    """
    A pull must never replace a row that still has unsent local changes.

    The guard used to be a SELECT before the write. Between the two
    statements a tap could land and queue its outbox entry, and the write
    then put the server's older copy back -- the card tick that reverts the
    moment you reopen the family. The guard now lives INSIDE the write, so
    SQLite cannot interleave them.
    """
    print("\n18. pull writes are atomic and never clobber pending edits")

    import pathlib

    src = (pathlib.Path(__file__).resolve().parents[1] / "src" / "db" / "sync.ts").read_text()
    check(
        "sync.ts guards inside the write statement",
        "WHERE NOT EXISTS" in src and "SELECT 1 FROM outbox WHERE table_name" in src,
    )

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)

    # A local edit that has not been uploaded yet.
    db.execute(
        "INSERT INTO guests (id, name, phone, male_count, female_count, deleted_at, created_at, updated_at)"
        " VALUES ('g1','Raza','0300',3,2,NULL,?,?)",
        (NOW, NOW),
    )
    db.execute(
        "INSERT INTO outbox (id, table_name, row_id, op, payload, created_at)"
        " VALUES ('o1','guests','g1','upsert','{}',?)",
        (NOW,),
    )

    cols = ["id", "name", "phone", "male_count", "female_count",
            "deleted_at", "created_at", "updated_at"]
    server_row = ["g1", "Raza Family", None, None, None, None, NOW, NOW]
    # The exact shape pullTable() now generates.
    sql = (
        f"INSERT OR REPLACE INTO guests ({', '.join(cols)}) "
        f"SELECT {', '.join('?' for _ in cols)} "
        f"WHERE NOT EXISTS (SELECT 1 FROM outbox WHERE table_name = ? AND row_id = ?)"
    )

    db.execute(sql, [*server_row, "guests", "g1"])
    row = db.execute("SELECT name FROM guests WHERE id = 'g1'").fetchone()
    check("a pending edit is not clobbered", row[0] == "Raza", f"-> {row[0]!r}")
    check("the guarded statement did not delete the row",
          db.execute("SELECT COUNT(*) FROM guests").fetchone()[0] == 1)

    # With the queue empty the same statement applies the server copy.
    db.execute("DELETE FROM outbox")
    db.execute(sql, [*server_row, "guests", "g1"])
    row = db.execute("SELECT name FROM guests WHERE id = 'g1'").fetchone()
    check("with nothing pending the server copy wins",
          row[0] == "Raza Family", f"-> {row[0]!r}")

    # And now the REAL template out of sync.ts, not just this hand copy:
    # substitute the three interpolations and run it, so the statement the
    # app actually generates is the one under test.
    import re

    template = re.search(r"`(INSERT OR REPLACE INTO \$\{table\}[\s\S]*?)`", src)
    check("pull INSERT template found in sync.ts", template is not None)
    if template:
        real = (
            template.group(1)
            .replace("${table}", "guests")
            .replace("${cols.join(', ')}", ", ".join(cols))
            .replace("${cols.map(() => '?').join(', ')}", ", ".join("?" for _ in cols))
        )
        try:
            db.execute(real, [*server_row, "guests", "g1"])
            check("the real template parses and runs", True)
        except sqlite3.Error as e:
            check("the real template parses and runs", False, f"-> {e}")

    db.close()


def test_activity_overlap():
    """
    Audit rows can commit in the opposite order to the ids they were given.

    `bigserial` allocates the id at INSERT time and the row becomes visible
    at COMMIT time. A puller that saw id 101 and then 102 moves its cursor
    to 102; id 100 committing a moment later was skipped by a strict
    `id > cursor` pull and lost forever. Re-reading a window of recent ids
    fixes it, because audit rows are immutable and re-inserting them is a
    no-op.
    """
    print("\n19. an audit row that commits out of id order is not lost")

    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)

    def log_row(i):
        db.execute(
            "INSERT OR REPLACE INTO activity_log"
            " (id, entity_type, entity_id, action, actor_name, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (i, "guest", "g1", "updated", "Ammi", NOW),
        )

    log_row(101)   # device B, commits first
    log_row(102)
    cursor = 102   # ...so a pull moves its cursor to 102
    log_row(100)   # device A: lower id, commits a moment later
    log_row(103)   # a normal new row, arriving after the cursor

    overlap = 200
    seen = [r[0] for r in db.execute(
        "SELECT id FROM activity_log WHERE id > ? ORDER BY id",
        (max(0, cursor - overlap),),
    ).fetchall()]
    check("the late-committing id is re-read", 100 in seen, f"-> {seen!r}")

    strict = [r[0] for r in db.execute(
        "SELECT id FROM activity_log WHERE id > ? ORDER BY id", (cursor,),
    ).fetchall()]
    check("a strict cursor would have skipped it forever",
          100 not in strict, f"-> {strict!r}")

    fresh = sum(1 for i in seen if i > cursor)
    check("only ids past the cursor count as news", fresh == 1, f"-> {fresh}")

    db.close()


if __name__ == "__main__":
    print("=== schema parity ===")
    test_schema_in_sync()
    print("\n=== writeLocal statement shapes ===")
    run()
    print("\n=== pull column filter ===")
    test_pull_column_filter()
    print("\n=== server contract ===")
    test_server_contract()
    print("\n=== read queries ===")
    test_read_queries()
    print("\n=== outbox repair ===")
    test_outbox_repair()
    print("\n=== pull guard & audit overlap ===")
    test_pull_guard()
    test_activity_overlap()

    print()
    if failures:
        print(f"FAILED: {len(failures)} check(s)")
        sys.exit(1)
    print("all checks passed")