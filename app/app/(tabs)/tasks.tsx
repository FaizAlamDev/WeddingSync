import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  FlatList,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { listTodos, getTodoCounts, type TodoRow, type TodoCounts } from '../../src/db/queries';
import { SyncBar } from '../../src/components/SyncBar';
import { Banner } from '../../src/components/ui';
import { useSync } from '../../src/state/sync';
import { setTodoStatus } from '../../src/db/actions';
import { formatDay, isOverdue } from '../../src/format';
import { colors, fontSize, spacing, radius, borderWidth } from '../../src/theme';

export default function TasksScreen() {
  const router = useRouter();
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [counts, setCounts] = useState<TodoCounts>({ open: 0, done: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useSync((s) => s.epoch);
  const lastCounts = useSync((s) => s.lastCounts);
  const runSync = useSync((s) => s.run);

  const load = useCallback(async () => {
    const [t, c] = await Promise.all([listTodos(tab), getTodoCounts()]);
    setTodos(t);
    setCounts(c);
    setLoading(false);
  }, [tab]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  useEffect(() => {
    void load();
  }, [load, epoch]);

  async function toggle(todo: TodoRow) {
    const next = todo.status === 'done' ? 'open' : 'done';
    setError(null);
    setTodos((prev) =>
      prev.map((t) => (t.id === todo.id ? { ...t, status: next } : t))
    );
    try {
      await setTodoStatus(todo.id, next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    await load();
  }

  async function onRefresh() {
    setRefreshing(true);
    void runSync();
    await load();
    setRefreshing(false);
  }

  return (
    <View style={styles.screen}>
      <SyncBar lastCounts={lastCounts} />

      {error ? (
        <View style={styles.errorPad}>
          <Banner tone="error" title="Could not change that task" body={error} />
        </View>
      ) : null}

      <View style={styles.tabs}>
        <TabButton
          label={`Open (${counts.open})`}
          active={tab === 'open'}
          onPress={() => setTab('open')}
        />
        <TabButton
          label={`Done (${counts.done})`}
          active={tab === 'done'}
          onPress={() => setTab('done')}
        />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={todos}
          keyExtractor={(t) => t.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>
                {tab === 'open' ? 'Nothing outstanding' : 'Nothing finished yet'}
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={[styles.row, item.status === 'done' && styles.rowDone]}>
              <Pressable
                onPress={() => toggle(item)}
                hitSlop={9}
                android_ripple={{ color: 'rgba(123,45,67,0.12)', borderless: true, radius: 28 }}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.status === 'done' }}
                accessibilityLabel={
                  item.status === 'done'
                    ? `Reopen ${item.title}`
                    : `Mark ${item.title} as done`
                }
                style={[styles.checkbox, item.status === 'done' && styles.checkboxOn]}
              >
                {item.status === 'done' ? (
                  <Text style={styles.checkmark}>✓</Text>
                ) : null}
              </Pressable>

              <Pressable
                style={styles.rowBody}
                onPress={() => router.push(`/todo/${item.id}`)}
                accessibilityRole="button"
              >
                <Text
                  style={[styles.title, item.status === 'done' && styles.titleDone]}
                  numberOfLines={2}
                >
                  {item.title}
                </Text>
                <View style={styles.metaRow}>
                  {item.category ? (
                    <Text style={styles.metaChip}>{item.category}</Text>
                  ) : null}
                  {item.assigned_to ? (
                    <Text style={styles.metaText}>{item.assigned_to}</Text>
                  ) : null}
                  {item.due_date ? (
                    <Text
                      style={[
                        styles.metaText,
                        item.status === 'open' && isOverdue(item.due_date)
                          ? styles.overdue
                          : null,
                      ]}
                    >
                      {item.status === 'done'
                        ? `Done${item.completed_by ? ` by ${item.completed_by}` : ''}`
                        : isOverdue(item.due_date)
                          ? `Overdue · ${formatDay(item.due_date)}`
                          : `Due ${formatDay(item.due_date)}`}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
            </View>
          )}
        />
      )}

      <Pressable
        onPress={() => router.push('/todo/edit')}
        accessibilityRole="button"
        accessibilityLabel="Add a task"
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
      >
        <Text style={styles.fabText}>+  Add task</Text>
      </Pressable>
    </View>
  );
}

function TabButton({
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
      style={[styles.tab, active && styles.tabActive]}
    >
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  errorPad: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  tabs: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
  },
  tab: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
  },
  tabActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    borderWidth: borderWidth.strong,
  },
  tabText: { fontSize: fontSize.body, fontWeight: '700', color: colors.textMuted },
  tabTextActive: { color: colors.textInverse },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: spacing.lg, paddingBottom: 120, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    minHeight: 76,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowDone: { backgroundColor: colors.surfaceAlt, opacity: 0.75 },
  checkbox: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: borderWidth.strong,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkboxOn: { backgroundColor: colors.success, borderColor: colors.success },
  checkmark: { color: colors.textInverse, fontSize: 24, fontWeight: '800', lineHeight: 30 },
  rowBody: { flex: 1 },
  title: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  titleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, marginTop: 4 },
  metaChip: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  metaText: { fontSize: fontSize.sm, color: colors.textMuted },
  overdue: { color: colors.danger, fontWeight: '700' },

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
