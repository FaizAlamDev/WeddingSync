import { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  Field,
  PrimaryButton,
  Banner,
  ToggleChip,
  inputStyle,
} from '../../src/components/ui';
import { getDb } from '../../src/db/local';
import { listCategories } from '../../src/db/queries';
import { saveTodo } from '../../src/db/actions';
import { availableNames } from '../../src/state/session';
import { colors, fontSize, spacing } from '../../src/theme';

export default function TodoEditor() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editingId = params.id ?? null;
  const insets = useSafeAreaInsets();

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [assignedTo, setAssignedTo] = useState<string | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [customCategory, setCustomCategory] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!editingId);

  useEffect(() => {
    void (async () => {
      setCategories(await listCategories());
    })();
  }, []);

  useEffect(() => {
    if (!editingId) return;
    void (async () => {
      const db = await getDb();
      const row = await db.getFirstAsync<Record<string, unknown>>(
        'SELECT * FROM todos WHERE id = ?',
        editingId
      );
      if (row) {
        setTitle(String(row.title ?? ''));
        setBody(String(row.body ?? ''));
        setCategory((row.category as string | null) ?? null);
        setAssignedTo((row.assigned_to as string | null) ?? null);
      }
      setLoaded(true);
    })();
  }, [editingId]);

  async function onSave() {
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const finalCategory = customCategory.trim() || category;
      const id = await saveTodo({
        id: editingId ?? undefined,
        title,
        body,
        category: finalCategory,
        assignedTo,
      });
      if (router.canGoBack()) router.back();
      else router.replace(editingId ? `/todo/${id}` : '/tasks');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  if (!loaded) return <View style={styles.screen} />;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: editingId ? 'Edit task' : 'New task' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error ? <Banner tone="error" title="Could not save" body={error} /> : null}

        <Field label="Task">
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            accessibilityLabel="Task title"
          />
        </Field>

        <Field label="Details">
          <TextInput
            value={body}
            onChangeText={setBody}
            placeholderTextColor={colors.textMuted}
            style={[styles.input, styles.multiline]}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            accessibilityLabel="Task details"
          />
        </Field>

        <Field label="Category">
          <View style={styles.chipWrap}>
            {categories.map((c) => (
              <View key={c} style={styles.chipHolder}>
                <ToggleChip
                  label={c}
                  selected={category === c && !customCategory.trim()}
                  onPress={() => {
                    setCategory(category === c ? null : c);
                    setCustomCategory('');
                  }}
                />
              </View>
            ))}
          </View>
          <TextInput
            value={customCategory}
            onChangeText={(v) => {
              setCustomCategory(v);
              if (v.trim()) setCategory(null);
            }}
            placeholder="New category"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            accessibilityLabel="New category"
          />
        </Field>

        <Field label="Assigned to">
          {availableNames.map((n) => (
            <ToggleChip
              key={n}
              label={n}
              selected={assignedTo === n}
              onPress={() => setAssignedTo(assignedTo === n ? null : n)}
            />
          ))}
        </Field>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: spacing.md + insets.bottom }]}>
        <PrimaryButton
          label={editingId ? 'Save changes' : 'Add task'}
          onPress={onSave}
          disabled={!title.trim() || saving}
          busy={saving}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  input: inputStyle,
  multiline: { minHeight: 120, paddingTop: spacing.md },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  chipHolder: { minWidth: 140, flexGrow: 1 },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});
