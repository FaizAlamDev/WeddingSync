import { getDb } from './local';

export interface GuestRow {
  id: string;
  name: string;
  phone: string | null;
  male_count: number | null;
  female_count: number | null;
  updated_at: string;
}

export interface EventRow {
  id: string;
  name: string;
  event_date: string | null;
  sort_order: number;
}

export interface Rollup {
  families: number;
  men: number | null;
  women: number | null;
  total: number;
  uncounted: number;
}

export interface EventCount {
  eventId: string;
  name: string;
  men: number | null;
  women: number | null;
  total: number;
  families: number;
  cardsSent: number;
  uncounted: number;
}

export async function listGuests(options: {
  search?: string;
  eventId?: string | null;
  cardStatus?: 'all' | 'pending' | 'sent';
} = {}): Promise<GuestRow[]> {
  const db = await getDb();
  const { search, eventId = null, cardStatus = 'all' } = options;

  const where: string[] = ['g.deleted_at IS NULL'];
  const args: (string | number | null)[] = [];

  if (search && search.trim()) {
    where.push('g.name LIKE ?');
    args.push(`%${search.trim()}%`);
  }

  if (eventId) {
    where.push(
      `EXISTS (SELECT 1 FROM guest_events ge
                WHERE ge.guest_id = g.id
                  AND ge.event_id = ?
                  AND ge.deleted_at IS NULL)`
    );
    args.push(eventId);
  }

  if (cardStatus !== 'all' && eventId) {
    where.push(
      `EXISTS (SELECT 1 FROM guest_events ge
                WHERE ge.guest_id = g.id
                  AND ge.event_id = ?
                  AND ge.deleted_at IS NULL
                  AND ge.card_sent = ?)`
    );
    args.push(eventId);
    args.push(cardStatus === 'sent' ? 1 : 0);
  }

  return db.getAllAsync<GuestRow>(
    `SELECT g.id, g.name, g.phone, g.male_count, g.female_count, g.updated_at
       FROM guests g
      WHERE ${where.join(' AND ')}
      ORDER BY g.name COLLATE NOCASE ASC`,
    ...args
  );
}

export async function listEvents(): Promise<EventRow[]> {
  const db = await getDb();
  return db.getAllAsync<EventRow>(
    `SELECT id, name, event_date, sort_order
       FROM events
      WHERE deleted_at IS NULL
      ORDER BY event_date ASC NULLS LAST, sort_order ASC, name ASC`
  );
}

export async function getRollup(): Promise<Rollup> {
  const db = await getDb();
  const row = await db.getFirstAsync<Rollup>(
    `SELECT
       COUNT(*)                                        AS families,
       CASE WHEN COUNT(g.male_count) = 0
            THEN NULL
            ELSE COALESCE(SUM(g.male_count), 0)        END AS men,
       CASE WHEN COUNT(g.female_count) = 0
            THEN NULL
            ELSE COALESCE(SUM(g.female_count), 0)      END AS women,
       COALESCE(SUM(g.male_count), 0)
         + COALESCE(SUM(g.female_count), 0)            AS total,
       COALESCE(SUM(
         CASE WHEN g.male_count IS NULL OR g.female_count IS NULL
              THEN 1 ELSE 0 END), 0)                   AS uncounted
     FROM guests g
     WHERE g.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM guest_events ge
                    WHERE ge.guest_id = g.id AND ge.deleted_at IS NULL)`
  );
  return (
    row ?? { families: 0, men: null, women: null, total: 0, uncounted: 0 }
  );
}

export async function getEventCounts(): Promise<EventCount[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Omit<EventCount, 'name'>>(
    `SELECT e.id                                     AS eventId,
            CASE WHEN COUNT(x.men) = 0
                 THEN NULL
                 ELSE COALESCE(SUM(x.men), 0)     END AS men,
            CASE WHEN COUNT(x.women) = 0
                 THEN NULL
                 ELSE COALESCE(SUM(x.women), 0)   END AS women,
            COALESCE(SUM(x.men), 0)
              + COALESCE(SUM(x.women), 0)         AS total,
            COUNT(x.guest_id)                     AS families,
            COALESCE(SUM(CASE WHEN x.card_sent = 1 THEN 1 ELSE 0 END), 0) AS cardsSent,
            COALESCE(SUM(
              CASE WHEN x.guest_id IS NOT NULL
                    AND (x.men IS NULL OR x.women IS NULL)
                   THEN 1 ELSE 0 END), 0)         AS uncounted
       FROM events e
       LEFT JOIN (
         -- one row per family attending the event, numbers already
         -- resolved: the event's own override when set, the family's
         -- otherwise. The inner join keeps soft-deleted guests (and any
         -- stale override on their link) out of the sums.
         SELECT ge.event_id,
                ge.guest_id,
                ge.card_sent,
                COALESCE(ge.male_count,   g.male_count)   AS men,
                COALESCE(ge.female_count, g.female_count) AS women
           FROM guest_events ge
           JOIN guests g ON g.id = ge.guest_id AND g.deleted_at IS NULL
          WHERE ge.deleted_at IS NULL
       ) x ON x.event_id = e.id
      WHERE e.deleted_at IS NULL
      GROUP BY e.id`
  );

  const events = await listEvents();
  const names = new Map(events.map((e) => [e.id, e.name]));
  return rows.map((r) => ({ ...r, name: names.get(r.eventId) ?? '' }));
}

export interface EventLinkRow {
  guest_id: string;
  event_id: string;
  male_count: number | null;
  female_count: number | null;
}

export async function listEventLinks(): Promise<EventLinkRow[]> {
  const db = await getDb();
  return db.getAllAsync<EventLinkRow>(
    `SELECT guest_id, event_id, male_count, female_count
       FROM guest_events
      WHERE deleted_at IS NULL`
  );
}

export interface GuestEventStatus {
  eventId: string;
  cardSent: boolean;
  maleCount: number | null;
  femaleCount: number | null;
}

export async function getGuestEvents(guestId: string): Promise<GuestEventStatus[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    event_id: string;
    card_sent: number;
    male_count: number | null;
    female_count: number | null;
  }>(
    `SELECT event_id, card_sent, male_count, female_count
       FROM guest_events
      WHERE guest_id = ? AND deleted_at IS NULL`,
    guestId
  );
  return rows.map((r) => ({
    eventId: r.event_id,
    cardSent: r.card_sent === 1,
    maleCount: r.male_count,
    femaleCount: r.female_count,
  }));
}

export async function getGuest(id: string): Promise<GuestRow | null> {
  const db = await getDb();
  return (
    (await db.getFirstAsync<GuestRow>(
      `SELECT id, name, phone, male_count, female_count, updated_at
         FROM guests WHERE id = ?`,
      id
    )) ?? null
  );
}

export interface LogRow {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_name: string | null;
  changes: string | null;
  created_at: string;
  guest_name: string | null;
}

export interface TodoRow {
  id: string;
  title: string;
  body: string | null;
  category: string | null;
  status: 'open' | 'done';
  due_date: string | null;
  assigned_to: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_by: string | null;
  updated_at: string;
}

export async function listTodos(status: 'open' | 'done'): Promise<TodoRow[]> {
  const db = await getDb();
  return db.getAllAsync<TodoRow>(
    `SELECT id, title, body, category, status, due_date, assigned_to,
            completed_at, completed_by, created_by, updated_at
       FROM todos
      WHERE deleted_at IS NULL
        AND status = ?
      ORDER BY
        CASE WHEN status = 'open' THEN 0 ELSE 1 END,
        due_date IS NULL, due_date ASC,
        updated_at DESC`,
    status
  );
}

export async function getTodo(id: string): Promise<TodoRow | null> {
  const db = await getDb();
  return (
    (await db.getFirstAsync<TodoRow>(
      `SELECT id, title, body, category, status, due_date, assigned_to,
              completed_at, completed_by, created_by, updated_at
         FROM todos WHERE id = ?`,
      id
    )) ?? null
  );
}

export async function listCategories(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ category: string }>(
    `SELECT DISTINCT category FROM todos
      WHERE deleted_at IS NULL AND category IS NOT NULL AND category <> ''
      ORDER BY category COLLATE NOCASE`
  );
  return rows.map((r) => r.category);
}

export interface TodoCounts {
  open: number;
  done: number;
}

export async function getTodoCounts(): Promise<TodoCounts> {
  const db = await getDb();
  const row = await db.getFirstAsync<TodoCounts>(
    `SELECT
       COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open,
       COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
     FROM todos WHERE deleted_at IS NULL`
  );
  return row ?? { open: 0, done: 0 };
}

export async function listActivity(limit = 100): Promise<LogRow[]> {
  const db = await getDb();
  return db.getAllAsync<LogRow>(
    `SELECT al.id, al.entity_type, al.entity_id, al.action,
            al.actor_name, al.changes, al.created_at,
            COALESCE(g.name, NULL) AS guest_name
       FROM activity_log al
       LEFT JOIN guests g
         ON al.entity_type IN ('guest','guest_event') AND g.id = al.entity_id
      ORDER BY al.id DESC
      LIMIT ?`,
    limit
  );
}
