import { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, RefreshControl } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import {
  listGuests,
  listEvents,
  getRollup,
  getEventCounts,
  type GuestRow,
  type EventRow,
  type Rollup,
  type EventCount,
} from '../../src/db/queries';
import { withRecovery } from '../../src/db/local';
import { SyncBar } from '../../src/components/SyncBar';
import { useSync } from '../../src/state/sync';
import { describeCounts } from '../../src/format';
import { colors, fontSize, spacing, radius, borderWidth } from '../../src/theme';

export default function FamiliesScreen() {
  const router = useRouter();

  const [guests, setGuests] = useState<GuestRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [counts, setCounts] = useState<EventCount[]>([]);
  const [rollup, setRollup] = useState<Rollup>({
    families: 0, men: null, women: null, total: 0, uncounted: 0,
  });

  const [search, setSearch] = useState('');
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const epoch = useSync((s) => s.epoch);
  const lastCounts = useSync((s) => s.lastCounts);
  const runSync = useSync((s) => s.run);

  const activeEvent = eventFilter
    ? events.find((e) => e.id === eventFilter) ?? null
    : null;
  const activeCount = activeEvent
    ? counts.find((c) => c.eventId === activeEvent.id) ?? null
    : null;
  const summaryCounts = activeCount ?? rollup;
  const summaryLabel =
    activeCount && activeEvent
      ? `people at ${activeEvent.name}`
      : 'people expected';

  const load = useCallback(async () => {
    const [g, e, c, r] = await withRecovery(async () => {
      const results = await Promise.all([
        listGuests({ search, eventId: eventFilter }),
        listEvents(),
        getEventCounts(),
        getRollup(),
      ]);
      return results as [GuestRow[], EventRow[], EventCount[], Rollup];
    });
    setGuests(g);
    setEvents(e);
    setCounts(c);
    setRollup(r);
  }, [search, eventFilter]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  useEffect(() => {
    void load();
  }, [load, epoch]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    void runSync();
    await load();
    setRefreshing(false);
  }, [load, runSync]);

  const countFor = (eventId: string | null): string => {
    const c = eventId === null ? rollup : counts.find((x) => x.eventId === eventId);
    if (!c || c.families === 0) return '0';
    return c.men !== null || c.women !== null ? String(c.total) : '—';
  };

  return (
    <View style={styles.screen}>
      <SyncBar lastCounts={lastCounts} />
      <FlatList
        data={guests}
        keyExtractor={(g) => g.id}
        contentContainerStyle={guests.length === 0 ? styles.emptyWrap : styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListHeaderComponent={
          guests.length > 0 || search !== '' || eventFilter !== null ? (
            <View style={styles.listHeader}>
              <SummaryBar counts={summaryCounts} label={summaryLabel} />

              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search"
                placeholderTextColor={colors.textMuted}
                style={styles.search}
                autoCorrect={false}
                returnKeyType="search"
                accessibilityLabel="Search families by name"
              />

              <View style={styles.chips}>
                <Chip
                  label={`All (${countFor(null)})`}
                  active={eventFilter === null}
                  onPress={() => setEventFilter(null)}
                />
                {events.map((e) => (
                  <Chip
                    key={e.id}
                    label={`${e.name} (${countFor(e.id)})`}
                    active={eventFilter === e.id}
                    onPress={() => setEventFilter(eventFilter === e.id ? null : e.id)}
                  />
                ))}
              </View>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {search ? 'No families match' : 'No families yet'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/guest/${item.id}`)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowName} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={styles.rowMeta}>
                {formatCounts(item)}
                {item.phone ? `  ·  ${item.phone}` : ''}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        )}
      />

      <Pressable
        onPress={() => router.push('/guest/edit')}
        accessibilityRole="button"
        accessibilityLabel="Add a family"
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <Text style={styles.fabText}>+  Add family</Text>
      </Pressable>
    </View>
  );
}

function SummaryBar({
  counts,
  label,
}: {
  counts: Rollup | EventCount;
  label: string;
}) {
  const counted = counts.men !== null || counts.women !== null;

  return (
    <View style={styles.summary}>
      <View style={styles.summaryMain}>
        <Text style={styles.summaryTotal}>{counted ? counts.total : '—'}</Text>
        <Text style={styles.summaryLabel}>{label}</Text>
      </View>
      <View style={styles.summaryBreakdown}>
        <Text style={styles.summaryLine}>
          {describeCounts(counts.men, counts.women)}
        </Text>
        <Text style={styles.summaryLine}>
          {counts.families} {counts.families === 1 ? 'family' : 'families'}
        </Text>
        {counts.uncounted > 0 ? (
          <Text style={styles.summaryWarn}>
            {counts.uncounted} {counts.uncounted === 1 ? 'family' : 'families'} not
            counted yet
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Chip({
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
      <Text style={[styles.chipText, active && styles.chipTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

function formatCounts(g: GuestRow): string {
  return describeCounts(g.male_count, g.female_count);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.primarySoft,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  summaryMain: { alignItems: 'center', minWidth: 76, maxWidth: 132 },
  summaryTotal: { fontSize: 40, fontWeight: '800', color: colors.primary, lineHeight: 44 },
  summaryLabel: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
  summaryBreakdown: { flex: 1 },
  summaryLine: { fontSize: fontSize.body, color: colors.text, fontWeight: '600' },
  summaryWarn: { fontSize: fontSize.sm, color: colors.danger, fontWeight: '600' },

  listHeader: { gap: spacing.md, marginBottom: spacing.sm },
  search: {
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.body,
    color: colors.text,
  },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
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
  chipText: { fontSize: fontSize.sm, color: colors.textMuted, fontWeight: '600' },
  chipTextActive: { color: colors.textInverse },

  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: 120, gap: spacing.sm },
  row: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  rowMain: { flex: 1 },
  rowName: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  rowMeta: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  chevron: { fontSize: 32, color: colors.textMuted, marginLeft: spacing.sm },

  emptyWrap: { flexGrow: 1, paddingHorizontal: spacing.lg },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text },

  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    minHeight: 60,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    elevation: 4,
  },
  fabPressed: { backgroundColor: colors.primaryDark },
  fabText: { color: colors.textInverse, fontSize: fontSize.lg, fontWeight: '700' },
});
