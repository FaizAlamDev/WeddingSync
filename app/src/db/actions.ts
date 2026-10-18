import { supabase } from '../lib/supabase';
import { getDb, newId, wipeLocalData } from './local';
import { writeLocal, softDelete } from './sync';
import { useSession } from '../state/session';

export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const plus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return digits.length === 0 ? null : `${plus ? '+' : ''}${digits}`;
}

export function dialableNumber(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length > 0 ? digits : null;
}

export interface FamilyInput {
  id?: string;
  name: string;
  phone?: string | null;
  maleCount?: number | null;
  femaleCount?: number | null;
  eventIds: string[];
}

export async function saveFamily(input: FamilyInput): Promise<string> {
  const guestId = input.id ?? newId();

  await writeLocal({
    table: 'guests',
    rowId: guestId,
    values: {
      name: input.name.trim(),
      phone: normalisePhone(input.phone),
      male_count: input.maleCount ?? null,
      female_count: input.femaleCount ?? null,
    },
  });

  const db = await getDb();
  const existing = await db.getAllAsync<{ id: string; event_id: string }>(
    `SELECT id, event_id FROM guest_events
      WHERE guest_id = ? AND deleted_at IS NULL`,
    guestId
  );

  const have = new Set(existing.map((r) => r.event_id));
  const want = new Set(input.eventIds);

  for (const eventId of want) {
    if (have.has(eventId)) continue;
    await writeLocal({
      table: 'guest_events',
      values: { guest_id: guestId, event_id: eventId, card_sent: false },
    });
  }

  for (const row of existing) {
    if (!want.has(row.event_id)) {
      await softDelete('guest_events', row.id);
    }
  }

  return guestId;
}

export async function removeFamily(guestId: string): Promise<void> {
  const db = await getDb();
  const links = await db.getAllAsync<{ id: string }>(
    `SELECT id FROM guest_events WHERE guest_id = ? AND deleted_at IS NULL`,
    guestId
  );
  for (const link of links) {
    await softDelete('guest_events', link.id);
  }
  await softDelete('guests', guestId);
}

const cardWrites = new Map<string, Promise<void>>();

export function setCard(
  guestId: string,
  eventId: string,
  cardSent: boolean
): Promise<void> {
  const key = `${guestId}:${eventId}`;
  const previous = cardWrites.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeCard(guestId, eventId, cardSent));
  cardWrites.set(key, next);
  return next;
}

async function writeCard(
  guestId: string,
  eventId: string,
  cardSent: boolean
): Promise<void> {
  const db = await getDb();
  const actor = useSession.getState().displayName;

  const existing = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM guest_events
      WHERE guest_id = ? AND event_id = ? AND deleted_at IS NULL`,
    guestId,
    eventId
  );

  if (existing) {
    await writeLocal({
      table: 'guest_events',
      rowId: existing.id,
      values: {
        card_sent: cardSent,
        card_sent_at: cardSent ? new Date().toISOString() : null,
        card_sent_by: cardSent ? actor : null,
      },
    });
    return;
  }

  await writeLocal({
    table: 'guest_events',
    values: {
      guest_id: guestId,
      event_id: eventId,
      card_sent: cardSent,
      card_sent_at: cardSent ? new Date().toISOString() : null,
      card_sent_by: cardSent ? actor : null,
    },
  });
}

export interface TodoInput {
  id?: string;
  title: string;
  body?: string | null;
  category?: string | null;
  dueDate?: string | null;
  assignedTo?: string | null;
}

export async function saveTodo(input: TodoInput): Promise<string> {
  const actor = useSession.getState().displayName;
  const existing = input.id ? await getTodo(input.id) : null;

  return writeLocal({
    table: 'todos',
    rowId: input.id,
    values: {
      title: input.title.trim(),
      body: input.body?.trim() || null,
      category: input.category?.trim() || null,
      due_date: input.dueDate || null,
      assigned_to: input.assignedTo?.trim() || null,
      created_by: existing ? undefined : (actor ?? null),
      updated_by: actor ?? null,
    },
  });
}

export async function setTodoStatus(
  todoId: string,
  status: 'open' | 'done'
): Promise<void> {
  const actor = useSession.getState().displayName;
  const done = status === 'done';

  await writeLocal({
    table: 'todos',
    rowId: todoId,
    values: {
      status,
      completed_at: done ? new Date().toISOString() : null,
      completed_by: done ? actor : null,
      updated_by: actor ?? null,
    },
  });
}

export async function removeTodo(todoId: string): Promise<void> {
  await softDelete('todos', todoId);
}

export async function getTodo(id: string) {
  const db = await getDb();
  return (
    (await db.getFirstAsync<Record<string, unknown>>(
      'SELECT * FROM todos WHERE id = ?',
      id
    )) ?? null
  );
}

export interface DuplicateHit {
  id: string;
  name: string;
  male_count: number | null;
  female_count: number | null;
}

export async function findSimilarFamilies(
  name: string,
  excludeId: string | null = null
): Promise<DuplicateHit[]> {
  const trimmed = name.trim();
  if (trimmed.length < 2) return [];

  const { data, error } = await supabase.rpc('search_guests', { q: trimmed });
  if (error) return [];

  return ((data ?? []) as DuplicateHit[]).filter(
    (r) =>
      r.id !== excludeId && r.name.trim().toLowerCase() !== trimmed.toLowerCase()
  );
}

export async function findSimilarFamiliesLocal(
  name: string,
  excludeId: string | null = null
): Promise<DuplicateHit[]> {
  const trimmed = name.trim();
  if (trimmed.length < 2) return [];
  const db = await getDb();
  return db.getAllAsync<DuplicateHit>(
    `SELECT id, name, male_count, female_count
       FROM guests
      WHERE deleted_at IS NULL
        AND id <> COALESCE(?, '')
        AND name LIKE ?
        AND lower(name) <> lower(?)
      ORDER BY name LIMIT 5`,
    excludeId,
    `%${trimmed}%`,
    trimmed
  );
}

export { wipeLocalData };
