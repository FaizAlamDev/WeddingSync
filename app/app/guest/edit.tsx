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
  Modal,
  Keyboard,
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
  normalisePhone,
  type DuplicateHit,
} from '../../src/db/actions';
import { describeCounts, formatDay } from '../../src/format';
import { normaliseName } from '../../src/similarity';
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
  const [dupQuery, setDupQuery] = useState('');
  const [dupOpen, setDupOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(!editingId);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      searchSeq.current += 1;
    };
  }, []);

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
    if (trimmed.length < 3) {
      searchSeq.current += 1;
      setDuplicates([]);
      setDupQuery('');
      setDupOpen(false);
      return;
    }

    const seq = ++searchSeq.current;
    debounce.current = setTimeout(() => {
      void (async () => {
        try {
          const hits = await findSimilarFamilies(trimmed, editingId);
          if (seq !== searchSeq.current) return;
          setDuplicates(hits);
          setDupQuery(trimmed);
          if (hits.length === 0) setDupOpen(false);
        } catch {
          if (seq === searchSeq.current) {
            setDuplicates([]);
            setDupQuery('');
          }
        }
      })();
    }, 500);
  }

  function openDuplicates() {
    Keyboard.dismiss();
    setDupOpen(true);
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

  const trimmedName = name.trim();
  const exactDuplicate = duplicates.find(
    (d) => normaliseName(d.name) === normaliseName(trimmedName)
  );
  // Only describe matches for the text that is in the field right now.
  // While someone is still typing, the previous answer is stale.
  const showDuplicates = dupQuery === trimmedName && duplicates.length > 0;
  const duplicateHint = !showDuplicates
    ? ''
    : exactDuplicate
      ? `Already on the list: ${exactDuplicate.name}`
      : duplicates.length === 1
        ? `Possible duplicate: ${duplicates[0].name}`
        : `${duplicates.length} possible duplicates`;

  if (!loaded) return <View style={styles.screen} />;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Stack.Screen options={{ title: editingId ? 'Edit family' : 'Add family' }} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {error ? <Banner tone="error" title="Could not save" body={error} /> : null}

        <Field label="Family name">
          <TextInput
            value={name}
            onChangeText={onNameChange}
            placeholderTextColor={colors.textMuted}
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="words"
            accessibilityLabel="Family name"
          />
          {showDuplicates ? (
            <Pressable
              onPress={openDuplicates}
              accessibilityRole="button"
              accessibilityLabel={`${duplicateHint}. Review similar families`}
              style={({ pressed }) => [
                styles.dupHint,
                pressed && styles.dupHintPressed,
              ]}
            >
              <Text style={styles.dupHintText} numberOfLines={2}>
                {duplicateHint}
              </Text>
              <Text style={styles.dupHintAction}>Review</Text>
            </Pressable>
          ) : null}
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

      <Modal
        visible={dupOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setDupOpen(false)}
      >
        <View style={styles.modalBackdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setDupOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close similar families"
          />
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Similar families</Text>
            <Text style={styles.modalBody}>
              These names are close in spelling to “{trimmedName}”. Open one to
              check it, or keep editing if this is a different family.
            </Text>

            <View style={styles.modalList}>
              {duplicates.map((d) => (
                <Pressable
                  key={d.id}
                  onPress={() => {
                    setDupOpen(false);
                    router.push(`/guest/${d.id}`);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${d.name}`}
                  style={({ pressed }) => [
                    styles.modalRow,
                    pressed && styles.modalRowPressed,
                  ]}
                >
                  <View style={styles.modalRowText}>
                    <Text style={styles.modalName}>{d.name}</Text>
                    <Text style={styles.modalMeta}>
                      {describeCounts(d.male_count, d.female_count)}
                    </Text>
                  </View>
                  <Text style={styles.modalOpen}>Open →</Text>
                </Pressable>
              ))}
            </View>

            <PrimaryButton label="Keep editing" onPress={() => setDupOpen(false)} />
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  input: inputStyle,
  stepperRow: { flexDirection: 'column', gap: spacing.md },
  noEvents: { fontSize: fontSize.body, color: colors.textMuted },

  dupHint: {
    minHeight: 48,
    marginTop: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: '#FFF4E0',
    borderRadius: radius.md,
    borderLeftWidth: 4,
    borderLeftColor: '#E0A800',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  dupHintPressed: { backgroundColor: '#FFE9BF' },
  dupHintText: {
    flex: 1,
    fontSize: fontSize.body,
    lineHeight: 22,
    color: colors.text,
  },
  dupHintAction: {
    fontSize: fontSize.body,
    fontWeight: '700',
    color: colors.primary,
  },

  modalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: 'rgba(20,20,26,0.5)',
  },
  modalCard: {
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  modalTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.primary,
  },
  modalBody: {
    fontSize: fontSize.body,
    lineHeight: 23,
    color: colors.textMuted,
  },
  modalList: { gap: spacing.sm },
  modalRow: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  modalRowPressed: { backgroundColor: colors.surfaceAlt },
  modalRowText: { flex: 1 },
  modalName: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  modalMeta: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  modalOpen: {
    fontSize: fontSize.body,
    fontWeight: '700',
    color: colors.primary,
  },

  footer: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background,
  },
});
