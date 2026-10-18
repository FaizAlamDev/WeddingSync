import { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton, Banner } from '../../src/components/ui';
import { Timeline } from '../../src/components/Timeline';
import { getDb } from '../../src/db/local';
import { getTodo, type TodoRow, type LogRow } from '../../src/db/queries';
import { setTodoStatus, removeTodo } from '../../src/db/actions';
import { colors, fontSize, spacing, radius } from '../../src/theme';

export default function TodoDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [todo, setTodo] = useState<TodoRow | null>(null);
  const [timeline, setTimeline] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!id) return;
    const db = await getDb();
    const [t, logs] = await Promise.all([
      getTodo(id),
      db.getAllAsync<LogRow>(
        `SELECT id, entity_type, entity_id, action, actor_name, changes, created_at, NULL AS guest_name
           FROM activity_log
          WHERE entity_id = ? AND entity_type = 'todo'
          ORDER BY id DESC`,
        id
      ),
    ]);
    setTodo(t);
    setTimeline(logs);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function toggle() {
    if (!todo) return;
    const next = todo.status === 'done' ? 'open' : 'done';
    setTodo({ ...todo, status: next });
    try {
      await setTodoStatus(todo.id, next);
      await load();
    } catch {
      await load();
    }
  }

  function confirmDelete() {
    if (!todo) return;
    Alert.alert(
      'Delete this task?',
      `"${todo.title}" will be removed.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeTodo(todo.id);
                router.replace('/tasks');
              } catch (e) {
                Alert.alert(
                  'Could not delete',
                  e instanceof Error ? e.message : String(e)
                );
              }
            })();
          },
        },
      ]
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (!todo) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>This task is no longer here.</Text>
        <PrimaryButton label="Back to tasks" onPress={() => router.replace('/tasks')} />
      </View>
    );
  }

  const done = todo.status === 'done';

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: spacing.xxl + insets.bottom },
      ]}
    >
      <Stack.Screen options={{ title: 'Task' }} />

      <Text style={[styles.title, done && styles.titleDone]}>{todo.title}</Text>

      <View style={styles.metaRow}>
        {todo.category ? <Text style={styles.chip}>{todo.category}</Text> : null}
        {todo.assigned_to ? (
          <Text style={styles.metaText}>Assigned to {todo.assigned_to}</Text>
        ) : null}
        {todo.created_by ? (
          <Text style={styles.metaText}>Added by {todo.created_by}</Text>
        ) : null}
      </View>

      {todo.body ? <Text style={styles.body}>{todo.body}</Text> : null}

      {done ? <Banner tone="info" title="Completed" /> : null}

      <PrimaryButton
        label={done ? 'Reopen task' : 'Mark as done'}
        onPress={toggle}
      />

      <Text style={styles.sectionTitle}>History</Text>
      <Timeline
        rows={timeline}
        emptyText="Nothing recorded yet"
        describe={describeTodo}
      />

      <View style={styles.actions}>
        <PrimaryButton
          label="Edit task"
          onPress={() => router.push(`/todo/edit?id=${todo.id}`)}
        />
        <View style={styles.actionGap} />
        <PrimaryButton label="Delete task" tone="danger" onPress={confirmDelete} />
      </View>
    </ScrollView>
  );
}

function describeTodo(row: LogRow): string {
  const who = row.actor_name ?? 'Someone';
  switch (row.action) {
    case 'created':
      return `${who} added this task`;
    case 'updated':
      return `${who} edited the task`;
    case 'completed':
      return `${who} marked it done`;
    case 'reopened':
      return `${who} reopened it`;
    case 'assigned':
      return `${who} changed who it is assigned to`;
    case 'deleted':
      return `${who} deleted this task`;
    default:
      return `${who}: ${row.action}`;
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
    backgroundColor: colors.background,
  },
  missing: { fontSize: fontSize.lg, color: colors.textMuted },

  title: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.text },
  titleDone: { textDecorationLine: 'line-through', color: colors.textMuted },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.primary,
    backgroundColor: colors.primarySoft,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  metaText: { fontSize: fontSize.sm, color: colors.textMuted },
  body: { fontSize: fontSize.body, color: colors.text, marginTop: spacing.lg, lineHeight: 27 },

  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.primary,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },

  actions: { marginTop: spacing.xxl },
  actionGap: { height: spacing.md },
});
