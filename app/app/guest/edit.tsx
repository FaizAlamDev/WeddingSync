import { useEffect, useMemo, useRef, useState } from 'react';
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
  Stepper,
  ToggleChip,
  PrimaryButton,
  Banner,
  inputStyle,
} from '../../src/components/ui';
import { getDb } from '../../src/db/local';
import { listEvents } from '../../src/db/queries';
import {
  saveFamily,
  findSimilarFamilies,
  findSimilarFamiliesLocal,
  normalisePhone,
  type DuplicateHit,
} from '../../src/db/actions';
import { describeCounts, formatDay } from '../../src/format';
import { colors, fontSize, spacing, radius, borderWidth } from '../../src/theme';

export default function FamilyEditor() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const editingId = params.id ?? null;
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [male, setMale] = useState<number | null>(null);
  const [female, setFemale] = useState<number | null>(null);
  const [eventIds, setEventIds] = useState<string[]>([]);
  const [events, setEvents] = useState<{ id: string; name: string; event_date: string | null }[]>([]);

  const [duplicates, setDuplicates] = useState<DuplicateHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!editingId);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void (async () => {
      setEvents(await listEvents());
    })();
  }, []);

  // Load the existing family when editing.
  useEffect(() => {
    if (!editingId) return;
    void (async () => {
      const db = await getDb();
      const row = await db.getFirstAsync<Record<string, unknown>>(
        'SELECT * FROM guests WHERE id = ?',
        editingId
      );
      if (row) {
        setName(String(row.name ?? ''));
        setPhone(String(row.phone ?? ''));
        setMale((row.male_count as number | null) ?? null);
        setFemale((row.female_count as number | null) ?? null);
      }
      const links = await db.getAllAsync<{ event_id: string }>(
        'SELECT event_id FROM guest_events WHERE guest_id = ? AND deleted_at IS NULL',
        editingId
      );
      setEventIds(links.map((l) => l.event_id));
      setLoaded(true);
    })();
  }, [editingId]);

  function onNameChange(next: string) {
    setName(next);
    if (debounce.current) clearTimeout(debounce.current);

    const trimmed = next.trim();
    if (trimmed.length < 2) {
      setDuplicates([]);
      return;
    }

    debounce.current = setTimeout(() => {
      void (async () => {
        const hits = await findSimilarFamilies(trimmed, editingId);
        if (hits.length > 0) {
          setDuplicates(hits);
          return;
        }
        setDuplicates(await findSimilarFamiliesLocal(trimmed, editingId));
      })();
    }, 400);
  }

  const canSave = useMemo(() => name.trim().length > 0 && !saving, [name, saving]);

  async function onSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const id = await saveFamily({
        id: editingId ?? undefined,
        name,
        phone: normalisePhone(phone),
        maleCount: male,
        femaleCount: female,
        eventIds,
      });
      if (router.canGoBack()) router.back();
      else router.replace(editingId ? `/guest/${id}` : '/');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  function toggleEvent(id: string) {
    setEventIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  if (!loaded) return <View style={styles.screen} />;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: editingId ? 'Edit family' : 'Add family' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error ? <Banner tone="error" title="Could not save" body={error} /> : null}

        {duplicates.length > 0 ? (
          <Banner
            tone="warn"
            title={
              duplicates.length === 1
                ? 'This may already be on the list'
                : `${duplicates.length} similar families exist`
            }
          />
        ) : null}

        {duplicates.length > 0 ? (
          <View style={styles.dupList}>
            {duplicates.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => router.push(`/guest/${d.id}`)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.dupRow, pressed && styles.dupRowPressed]}
              >
                <Text style={styles.dupName}>{d.name}</Text>
                <Text style={styles.dupMeta}>
                  {describeCounts(d.male_count, d.female_count)}
                </Text>
                <Text style={styles.dupOpen}>Open →</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <Field label="Family name">
          <TextInput
            value={name}
            onChangeText={onNameChange}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            autoCorrect={false}
            accessibilityLabel="Family name"
          />
        </Field>

        <Field label="Phone number">
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            keyboardType="phone-pad"
            accessibilityLabel="Phone number"
          />
        </Field>

        <Field>
          <View style={styles.stepperRow}>
            <Stepper label="Men" value={male} onChange={setMale} />
            <Stepper label="Women" value={female} onChange={setFemale} />
          </View>
        </Field>

        <Field label="Attending">
          {events.length === 0 ? (
            <Text style={styles.noEvents}>No events yet</Text>
          ) : (
            events.map((e) => (
              <ToggleChip
                key={e.id}
                label={e.event_date ? `${e.name} · ${formatDay(e.event_date)}` : e.name}
                selected={eventIds.includes(e.id)}
                onPress={() => toggleEvent(e.id)}
              />
            ))
          )}
        </Field>

      </ScrollView>

      <View style={[styles.footer, { paddingBottom: spacing.md + insets.bottom }]}>
        <PrimaryButton
          label={editingId ? 'Save changes' : 'Add family'}
          onPress={onSave}
          disabled={!canSave}
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
  stepperRow: { flexDirection: 'column', gap: spacing.md },
  noEvents: { fontSize: fontSize.body, color: colors.textMuted },

  dupList: { marginBottom: spacing.lg, gap: spacing.sm },
  dupRow: {
    minHeight: 72,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: borderWidth.strong,
    borderColor: '#E0A800',
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
  },
  dupRowPressed: { backgroundColor: colors.surfaceAlt },
  dupName: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  dupMeta: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  dupOpen: { fontSize: fontSize.sm, color: colors.primary, fontWeight: '700', marginTop: 4 },

  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});
