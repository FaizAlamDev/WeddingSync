import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

const DB_NAME = 'weddingsync.db';

let dbPromise: Promise<SQLiteDatabase> | null = null;

async function openDatabase(): Promise<SQLiteDatabase> {
  const database = await SQLite.openDatabaseAsync(DB_NAME);
  await database.execAsync(SCHEMA_VERSION_1);
  await database.execAsync(SCHEMA_OUTBOX);
  await database.execAsync(SCHEMA_SYNC_STATE);
  return database;
}

export async function getDb(): Promise<SQLiteDatabase> {
  if (!dbPromise) {
    const attempt = openDatabase();
    dbPromise = attempt;
    attempt.catch(() => {
      if (dbPromise === attempt) dbPromise = null;
    });
  }
  return dbPromise;
}

function isDeadHandle(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('has been rejected') && message.includes('NullPointerException');
}

export async function withRecovery<T>(
  op: (db: SQLiteDatabase) => Promise<T>
): Promise<T> {
  try {
    return await op(await getDb());
  } catch (error) {
    if (!isDeadHandle(error)) throw error;

    dbPromise = null;
    const fresh = await SQLite.openDatabaseAsync(DB_NAME, { useNewConnection: true });
    dbPromise = Promise.resolve(fresh);
    return op(fresh);
  }
}

const SCHEMA_VERSION_1 = `
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL,
  event_date  TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_sort ON events (sort_order);

CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- One row = one FAMILY.
CREATE TABLE IF NOT EXISTS guests (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL,
  phone         TEXT,
  male_count    INTEGER,
  female_count  INTEGER,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guests_updated ON guests (updated_at);
CREATE INDEX IF NOT EXISTS idx_guests_deleted ON guests (deleted_at);

-- Attendance + per-event card status.
CREATE TABLE IF NOT EXISTS guest_events (
  id            TEXT PRIMARY KEY NOT NULL,
  guest_id      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  card_sent     INTEGER NOT NULL DEFAULT 0,
  card_sent_at  TEXT,
  card_sent_by  TEXT,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ge_guest ON guest_events (guest_id);
CREATE INDEX IF NOT EXISTS idx_ge_event ON guest_events (event_id);
CREATE INDEX IF NOT EXISTS idx_ge_updated ON guest_events (updated_at);

CREATE TABLE IF NOT EXISTS todos (
  id            TEXT PRIMARY KEY NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  category      TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  due_date      TEXT,
  assigned_to   TEXT,
  completed_at  TEXT,
  completed_by  TEXT,
  created_by    TEXT,
  updated_by    TEXT,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_updated ON todos (updated_at);
CREATE INDEX IF NOT EXISTS idx_todos_status  ON todos (status);

-- Append-only, written by server triggers and pulled by monotonic id.
CREATE TABLE IF NOT EXISTS activity_log (
  id           INTEGER PRIMARY KEY NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  actor_id     TEXT,
  actor_name   TEXT,
  changes      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_entity ON activity_log (entity_type, entity_id);
`;

const SCHEMA_OUTBOX = `
CREATE TABLE IF NOT EXISTS outbox (
  id           TEXT PRIMARY KEY NOT NULL,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  op           TEXT NOT NULL,
  payload      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox (created_at);
`;

const SCHEMA_SYNC_STATE = `
CREATE TABLE IF NOT EXISTS sync_state (
  key          TEXT PRIMARY KEY NOT NULL,
  value        TEXT NOT NULL
);
`;

export type SyncStateKey =
  | 'guests_cursor'
  | 'guest_events_cursor'
  | 'todos_cursor'
  | 'activity_cursor';

export async function getSyncState(key: SyncStateKey): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM sync_state WHERE key = ?',
    key
  );
  return row?.value ?? null;
}

export async function setSyncState(key: SyncStateKey, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO sync_state (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    key,
    value
  );
}

export function newId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export async function wipeLocalData(): Promise<void> {
  const d = await getDb();
  await d.execAsync(`
    DELETE FROM guests;
    DELETE FROM guest_events;
    DELETE FROM todos;
    DELETE FROM activity_log;
    DELETE FROM events;
    DELETE FROM profiles;
    DELETE FROM outbox;
    DELETE FROM sync_state;
  `);
}
