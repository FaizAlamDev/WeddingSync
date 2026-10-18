import { supabase, ensureSession } from '../lib/supabase';
import type { SQLiteDatabase } from 'expo-sqlite';
import {
  getSyncState,
  setSyncState,
  newId,
  withRecovery,
  type SyncStateKey,
} from './local';

type TableName = 'guests' | 'guest_events' | 'todos' | 'events';

interface WriteInput {
  table: TableName;
  rowId?: string;
  values: Record<string, unknown>;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  lastLogId: number;
  error?: string;
}

const WRITABLE: Record<TableName, string[]> = {
  guests: ['id', 'name', 'phone', 'male_count', 'female_count', 'deleted_at'],
  guest_events: ['id', 'guest_id', 'event_id', 'card_sent', 'card_sent_at', 'card_sent_by', 'deleted_at'],
  todos: [
    'id', 'title', 'body', 'category', 'status', 'due_date', 'assigned_to',
    'completed_at', 'completed_by', 'created_by', 'updated_by', 'deleted_at',
  ],
  events: ['id', 'name', 'event_date', 'sort_order', 'deleted_at'],
};

const TIMESTAMPS: Record<TableName, { created: boolean; updated: boolean }> = {
  guests: { created: true, updated: true },
  guest_events: { created: true, updated: true },
  todos: { created: true, updated: true },
  // events has no updated_at anywhere, locally or server-side.
  events: { created: true, updated: false },
};

export async function writeLocal(input: WriteInput): Promise<string> {
  const id = input.rowId ?? newId();
  const now = new Date().toISOString();

  const editable = WRITABLE[input.table];
  const row: Record<string, unknown> = { ...input.values, id };

  const provided = editable.filter(
    (c) => c !== 'id' && input.values[c] !== undefined
  );

  const stamps = TIMESTAMPS[input.table];

  const bind = (c: string): string | number | null => {
    if (c === 'created_at' || c === 'updated_at') return now;
    const v = row[c];
    if (c === 'card_sent') return v ? 1 : 0;
    return v === undefined ? null : (v as string | number | null);
  };

  const insertCols = ['id', ...provided];
  if (stamps.created) insertCols.push('created_at');
  if (stamps.updated) insertCols.push('updated_at');

  const insertSql =
    `INSERT INTO ${input.table} (${insertCols.join(', ')}) ` +
    `VALUES (${insertCols.map(() => '?').join(', ')})`;

  const setCols = [...provided, ...(stamps.updated ? ['updated_at'] : [])];
  const updateSql =
    `UPDATE ${input.table} SET ` +
    setCols.map((c) => `${c} = ?`).join(', ') +
    ` WHERE id = ?`;

  await withRecovery(async (db) => {
    const existing = await db.getFirstAsync<{ id: string }>(
      `SELECT id FROM ${input.table} WHERE id = ?`,
      id
    );

    if (existing) {
      if (setCols.length > 0) {
        await db.runAsync(
          updateSql,
          ...setCols.map((c) => (c === 'updated_at' ? now : bind(c))),
          id
        );
      }
    } else {
      await db.runAsync(insertSql, ...insertCols.map(bind));
    }

    const stored = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM ${input.table} WHERE id = ?`,
      id
    );
    const payload: Record<string, unknown> = {};
    for (const c of editable) {
      if (c === 'id') continue;
      let v = input.values[c] !== undefined ? row[c] : stored?.[c] ?? null;
      if (c === 'card_sent') v = v ? 1 : 0;
      if (v === undefined) v = null;
      payload[c] = v;
    }

    await db.runAsync(
      `INSERT INTO outbox (id, table_name, row_id, op, payload, created_at)
       VALUES (?, ?, ?, 'upsert', ?, ?)`,
      newId(),
      input.table,
      id,
      JSON.stringify(payload),
      now
    );
  });

  return id;
}

export async function softDelete(table: TableName, rowId: string): Promise<void> {
  const now = new Date().toISOString();
  const editable = WRITABLE[table];

  await withRecovery(async (db) => {
    await db.runAsync(
      `UPDATE ${table} SET deleted_at = ? WHERE id = ?`,
      now,
      rowId
    );

    const stored = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE id = ?`,
      rowId
    );

    const payload: Record<string, unknown> = {};
    for (const c of editable) {
      if (c === 'id') continue;
      let v = c === 'deleted_at' ? now : stored?.[c] ?? null;
      if (c === 'card_sent') v = v ? 1 : 0;
      if (v === undefined) v = null;
      payload[c] = v;
    }

    await db.runAsync(
      `INSERT INTO outbox (id, table_name, row_id, op, payload, created_at)
       VALUES (?, ?, ?, 'upsert', ?, ?)`,
      newId(),
      table,
      rowId,
      JSON.stringify(payload),
      now
    );
  });
}

const MAX_ATTEMPTS = 5;

function fullPayloadFrom(
  stored: Record<string, unknown>,
  table: TableName
): Record<string, unknown> {
  const payload: Record<string, unknown> = { id: String(stored.id) };
  for (const c of WRITABLE[table]) {
    if (c === 'id') continue;
    let v = stored[c] ?? null;
    if (c === 'card_sent') v = v ? 1 : 0;
    if (v === undefined) v = null;
    payload[c] = v;
  }
  return payload;
}

async function repairOutbox(db: SQLiteDatabase): Promise<number> {
  const damaged = await db.getAllAsync<{
    id: string;
    table_name: TableName;
    row_id: string;
  }>(
    `SELECT id, table_name, row_id FROM outbox WHERE attempts > 0`
  );
  if (damaged.length === 0) return 0;

  for (const item of damaged) {
    let stored: Record<string, unknown> | null = null;
    try {
      stored = await db.getFirstAsync<Record<string, unknown>>(
        `SELECT * FROM ${item.table_name} WHERE id = ?`,
        item.row_id
      );
    } catch {
      stored = null;
    }

    if (!stored) {
      await db.runAsync(`DELETE FROM outbox WHERE id = ?`, item.id);
      continue;
    }

    const payload = fullPayloadFrom(stored, item.table_name);
    await db.runAsync(
      `UPDATE outbox
          SET attempts = 0, last_error = NULL, payload = ?
        WHERE id = ?`,
      JSON.stringify(payload),
      item.id
    );
  }

  return damaged.length;
}

export async function repairPendingChanges(): Promise<number> {
  try {
    return await withRecovery(repairOutbox);
  } catch {
    return 0;
  }
}

export async function pushOutbox(): Promise<{ pushed: number; error?: string }> {
  return withRecovery(async (db) => {
    await ensureSession();
    await repairOutbox(db);

    const pending = await db.getAllAsync<{
      id: string;
      table_name: TableName;
      row_id: string;
      payload: string;
      attempts: number;
    }>(
      `SELECT id, table_name, row_id, payload, attempts
         FROM outbox
        WHERE attempts < ?
        ORDER BY created_at
        LIMIT 50`,
      MAX_ATTEMPTS
    );

    let pushed = 0;

    for (const item of pending) {
      const localExists = await db.getFirstAsync<{ id: string }>(
        `SELECT id FROM ${item.table_name} WHERE id = ?`,
        item.row_id
      );
      if (!localExists) {
        await db.runAsync(`DELETE FROM outbox WHERE id = ?`, item.id);
        continue;
      }

      const payload = await rebuildPayload(db, item.table_name, item.row_id, item.payload);

      const { error } = await supabase
        .from(item.table_name)
        .upsert(payload, { onConflict: 'id' });

      if (error) {
        await db.runAsync(
          `UPDATE outbox SET attempts = attempts + 1, last_error = ?, payload = ? WHERE id = ?`,
          error.message,
          JSON.stringify(payload),
          item.id
        );
        continue;
      }

      await db.runAsync(`DELETE FROM outbox WHERE id = ?`, item.id);
      pushed += 1;
    }

    return { pushed };
  });
}

async function rebuildPayload(
  db: SQLiteDatabase,
  table: TableName,
  rowId: string,
  fallbackJson: string
): Promise<Record<string, unknown>> {
  const fallback = (() => {
    try {
      return JSON.parse(fallbackJson) as Record<string, unknown>;
    } catch {
      return {};
    }
  })();

  let stored: Record<string, unknown> | null = null;
  try {
    stored = await db.getFirstAsync<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE id = ?`,
      rowId
    );
  } catch {
    return { ...fallback, id: rowId };
  }

  if (!stored) return { ...fallback, id: rowId };

  return fullPayloadFrom(stored, table);
}

const PULLS: { table: TableName; cursor: SyncStateKey }[] = [
  { table: 'guests', cursor: 'guests_cursor' },
  { table: 'guest_events', cursor: 'guest_events_cursor' },
  { table: 'todos', cursor: 'todos_cursor' },
];

const OVERLAP_MS = 60_000;

async function pullEvents(): Promise<number> {
  return withRecovery(async (db) => {
  const { data, error } = await supabase.from('events').select('*');
  if (error) throw error;
  if (!data || data.length === 0) return 0;

  for (const row of data) {
    await db.runAsync(
      `INSERT OR REPLACE INTO events (id, name, event_date, sort_order, deleted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      row.id,
      row.name,
      row.event_date ?? null,
      row.sort_order ?? 100,
      row.deleted_at ?? null,
      row.created_at
    );
  }
  return data.length;
  });
}

async function pullTable(table: TableName, cursorKey: SyncStateKey): Promise<number> {
  return withRecovery(async (db) => {
  const raw = await getSyncState(cursorKey);
  const since = raw
    ? new Date(new Date(raw).getTime() - OVERLAP_MS).toISOString()
    : '1970-01-01T00:00:00.000Z';

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .gt('updated_at', since)
    .order('updated_at', { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) return 0;

  const rows = data as Record<string, unknown>[];

  for (const row of rows) {
    const cols = Object.keys(row).filter((k) => LOCAL_COLUMNS[table].has(k));

    await db.runAsync(
      `INSERT OR REPLACE INTO ${table} (${cols.join(', ')})
       SELECT ${cols.map(() => '?').join(', ')}
        WHERE NOT EXISTS (
          SELECT 1 FROM outbox WHERE table_name = ? AND row_id = ?)`,
      ...cols.map((c) => normalise(c, row[c])),
      table,
      String(row.id ?? '')
    );
  }

  const newest = rows.reduce((acc, r) => {
    const t = String(r.updated_at ?? '');
    return t > acc ? t : acc;
  }, since);
  await setSyncState(cursorKey, newest);

  return rows.length;
  });
}

const LOCAL_COLUMNS: Record<string, Set<string>> = {
  guests: new Set(['id', 'name', 'phone', 'male_count', 'female_count', 'deleted_at', 'created_at', 'updated_at']),
  guest_events: new Set(['id', 'guest_id', 'event_id', 'card_sent', 'card_sent_at', 'card_sent_by', 'deleted_at', 'created_at', 'updated_at']),
  todos: new Set([
    'id', 'title', 'body', 'category', 'status', 'due_date', 'assigned_to',
    'completed_at', 'completed_by', 'created_by', 'updated_by', 'deleted_at',
    'created_at', 'updated_at',
  ]),
};

function normalise(column: string, value: unknown): string | number | null {
  if (column === 'card_sent') return value ? 1 : 0;
  return value === undefined || value === null ? null : (value as string | number);
}

const ACTIVITY_OVERLAP = 200;

async function pullActivity(): Promise<number> {
  return withRecovery(async (db) => {
  const raw = await getSyncState('activity_cursor');
  const cursor = raw ? Number(raw) : 0;
  const since = Math.max(0, cursor - ACTIVITY_OVERLAP);

  const { data, error } = await supabase
    .from('activity_log')
    .select('*')
    .gt('id', since)
    .order('id', { ascending: true })
    .limit(500);

  if (error) throw error;
  if (!data || data.length === 0) return 0;

  let fresh = 0;
  for (const row of data) {
    if (row.id > cursor) fresh += 1;

    await db.runAsync(
      `INSERT OR REPLACE INTO activity_log
         (id, entity_type, entity_id, action, actor_id, actor_name, changes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.entity_type, row.entity_id, row.action,
      row.actor_id ?? null, row.actor_name ?? null,
      row.changes ? JSON.stringify(row.changes) : null, row.created_at
    );
  }

  await setSyncState('activity_cursor', String(data[data.length - 1].id));
  return fresh;
  });
}

export async function syncNow(): Promise<SyncResult> {
  try {
    await ensureSession();

    const { pushed } = await pushOutbox();

    let pulled = 0;
    for (const { table, cursor } of PULLS) {
      pulled += await pullTable(table, cursor);
    }
    pulled += await pullEvents();
    const lastLogId = await pullActivity();

    return { pushed, pulled, lastLogId };
  } catch (error) {
    return {
      pushed: 0,
      pulled: 0,
      lastLogId: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface OutboxStats {
  pending: number;
  failed: number;
  lastError: string | null;
}

export async function outboxStats(): Promise<OutboxStats> {
  try {
    return await withRecovery(async (db) => {
      const row = await db.getFirstAsync<{ pending: number; failed: number }>(
        `SELECT
           COALESCE(SUM(CASE WHEN attempts < ? THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END), 0) AS failed
         FROM outbox`,
        MAX_ATTEMPTS,
        MAX_ATTEMPTS
      );
      const err = await db.getFirstAsync<{ last_error: string | null }>(
        `SELECT last_error FROM outbox
          WHERE last_error IS NOT NULL AND last_error <> ''
          ORDER BY attempts DESC LIMIT 1`
      );
      return {
        pending: row?.pending ?? 0,
        failed: row?.failed ?? 0,
        lastError: err?.last_error ?? null,
      };
    });
  } catch {
    return { pending: 0, failed: 0, lastError: null };
  }
}

export async function retryFailed(): Promise<void> {
  await withRecovery(async (db) => {
    await db.runAsync(`UPDATE outbox SET attempts = 0 WHERE attempts >= ?`, MAX_ATTEMPTS);
  });
}

export async function discardFailed(): Promise<number> {
  return withRecovery(async (db) => {
    const rows = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM outbox WHERE attempts >= ?`,
      MAX_ATTEMPTS
    );
    for (const r of rows) {
      await db.runAsync(`DELETE FROM outbox WHERE id = ?`, r.id);
    }
    return rows.length;
  });
}

export async function pendingCount(): Promise<number> {
  return (await outboxStats()).pending;
}
