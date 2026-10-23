import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

import { listActivity, type LogRow } from '../../src/db/queries';
import { SyncBar } from '../../src/components/SyncBar';
import { useSync } from '../../src/state/sync';
import { colors, fontSize, spacing, radius, borderWidth } from '../../src/theme';

type Filter = 'all' | 'cards' | 'families' | 'tasks';

export default function ActivityScreen() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const epoch = useSync((s) => s.epoch);
  const lastCounts = useSync((s) => s.lastCounts);
  const runSync = useSync((s) => s.run);

  const load = useCallback(async () => {
    setRows(await listActivity(200));
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  useEffect(() => {
    void load();
  }, [load, epoch]);

  const visible = useMemo(() => {
    switch (filter) {
      case 'cards':
        return rows.filter((r) => r.action === 'card_sent' || r.action === 'card_uncheck');
      case 'families':
        return rows.filter((r) => r.entity_type === 'guest' || r.entity_type === 'guest_event');
      case 'tasks':
        return rows.filter((r) => r.entity_type === 'todo');
      default:
        return rows;
    }
  }, [rows, filter]);

  async function onRefresh() {
    setRefreshing(true);
    // Pull first, like the families list: a pull that only re-reads local
    // rows looks broken when the whole point was fetching what is new.
    void runSync();
    await load();
    setRefreshing(false);
  }

  return (
    <View style={styles.screen}>
      <SyncBar lastCounts={lastCounts} />
      <View style={styles.chips}>
        <FilterChip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
        <FilterChip label="Cards" active={filter === 'cards'} onPress={() => setFilter('cards')} />
        <FilterChip label="Families" active={filter === 'families'} onPress={() => setFilter('families')} />
        <FilterChip label="Tasks" active={filter === 'tasks'} onPress={() => setFilter('tasks')} />
      </View>

      <FlatList
        data={visible}
        keyExtractor={(r) => String(r.id)}
        contentContainerStyle={visible.length === 0 ? styles.emptyWrap : styles.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Nothing yet</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={[styles.badge, { backgroundColor: badgeTone(item) }]}>
              <Text style={styles.badgeText}>{glyph(item)}</Text>
            </View>
            <View style={styles.body}>
              <Text style={styles.text}>{describe(item)}</Text>
              <Text style={styles.meta}>
                {item.actor_name ?? 'Someone'} · {formatAgo(item.created_at)}
              </Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}

function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/** Reads a field out of the trigger-recorded before/after diff. */
function readChange(changes: string | null, key: string): string | null {
  if (!changes) return null;
  try {
    const parsed = JSON.parse(changes) as Record<string, unknown>;
    const v = parsed[key];
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function readCountChange(
  changes: string | null,
  key: string
): { from: number | null; to: number | null } | null {
  if (!changes) return null;
  try {
    const parsed = JSON.parse(changes) as Record<string, unknown>;
    const v = parsed[key];
    if (!v || typeof v !== 'object') return null;
    const pair = v as { from?: unknown; to?: unknown };
    return {
      from: typeof pair.from === 'number' ? pair.from : null,
      to: typeof pair.to === 'number' ? pair.to : null,
    };
  } catch {
    return null;
  }
}

function showCount(value: number | null): string {
  return value === null ? 'not set' : String(value);
}

function describe(row: LogRow): string {
  const who = row.actor_name ?? 'Someone';
  const event = readChange(row.changes, 'event');
  const family = readChange(row.changes, 'guest') ?? row.guest_name;

  switch (row.action) {
    case 'card_sent':
      return `${who} posted the ${event ?? 'event'} card for ${family ?? 'a family'}`;
    case 'card_uncheck':
      return `${who} unmarked the ${event ?? 'event'} card for ${family ?? 'a family'}`;
    case 'counts_updated': {
      const parts: string[] = [];
      const men = readCountChange(row.changes, 'men');
      const women = readCountChange(row.changes, 'women');
      if (men && men.from !== men.to) {
        parts.push(`men ${showCount(men.from)} → ${showCount(men.to)}`);
      }
      if (women && women.from !== women.to) {
        parts.push(`women ${showCount(women.from)} → ${showCount(women.to)}`);
      }
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `${who} changed the ${
        event ?? 'event'
      } numbers for ${family ?? 'a family'}${detail}`;
    }
    case 'added_to_event':
      return `${who} added ${family ?? 'a family'} to ${event ?? 'an event'}`;
    case 'removed_from_event':
      return `${who} removed ${family ?? 'a family'} from ${event ?? 'an event'}`;
    case 'created':
      return row.entity_type === 'guest'
        ? `${who} added ${row.guest_name ?? 'a family'}`
        : row.entity_type === 'todo'
          ? `${who} added a task`
          : `${who} added something`;
    case 'updated':
      return row.entity_type === 'guest'
        ? `${who} edited ${row.guest_name ?? 'a family'}`
        : `${who} made an edit`;
    case 'deleted':
      return `${who} removed ${row.guest_name ?? 'a record'}`;
    case 'completed':
      return `${who} completed a task`;
    case 'reopened':
      return `${who} reopened a task`;
    case 'assigned':
      return `${who} changed an assignee`;
    default:
      return `${who} made a change`;
  }
}

function glyph(row: LogRow): string {
  switch (row.action) {
    case 'card_sent':
      return '✉';
    case 'card_uncheck':
      return '↩';
    case 'counts_updated':
      return '👥';
    case 'completed':
      return '✓';
    case 'reopened':
      return '↻';
    case 'deleted':
      return '🗑';
    case 'created':
      return '＋';
    default:
      return '•';
  }
}

function badgeTone(row: LogRow): string {
  if (row.action === 'card_sent' || row.action === 'completed') return colors.successSoft;
  if (row.action === 'deleted' || row.action === 'card_uncheck') return colors.dangerSoft;
  return colors.primarySoft;
}

function formatAgo(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;

  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;

  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    padding: spacing.lg,
  },
  chip: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    borderWidth: borderWidth.strong,
  },
  chipText: { fontSize: fontSize.sm, fontWeight: '700', color: colors.textMuted },
  chipTextActive: { color: colors.textInverse },

  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  emptyWrap: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 68,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 18, color: colors.text },
  body: { flex: 1 },
  text: { fontSize: fontSize.body, color: colors.text, fontWeight: '600' },
  meta: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text },
});
