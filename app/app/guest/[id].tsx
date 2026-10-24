import { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  StyleSheet,
  Alert,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { Stack, useLocalSearchParams, useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton, Banner, Stepper } from '../../src/components/ui';
import { getDb } from '../../src/db/local';
import { getGuest, listEvents, type GuestRow, type EventRow } from '../../src/db/queries';
import { setCard, setEventCounts, removeFamily, dialableNumber } from '../../src/db/actions';
import { describeCounts } from '../../src/format';
import { colors, fontSize, spacing, radius, borderWidth } from '../../src/theme';

interface LinkState {
  cardSent: boolean;
  maleCount: number | null;
  femaleCount: number | null;
}

const EMPTY_LINK: LinkState = { cardSent: false, maleCount: null, femaleCount: null };

export default function GuestDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [guest, setGuest] = useState<GuestRow | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [links, setLinks] = useState<Record<string, LinkState>>({});
  const [loading, setLoading] = useState(true);
  const [writeError, setWriteError] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ men: number | null; women: number | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    const db = await getDb();
    const [g, evs, rows] = await Promise.all([
      getGuest(id),
      listEvents(),
      db.getAllAsync<{
        event_id: string;
        card_sent: number;
        male_count: number | null;
        female_count: number | null;
      }>(
        `SELECT event_id, card_sent, male_count, female_count
           FROM guest_events
          WHERE guest_id = ? AND deleted_at IS NULL`,
        id
      ),
    ]);

    setGuest(g);
    setEvents(evs);

    // Only events this family is actually linked to. Initialising the
    // missing ones would render a card checkbox and the family's numbers
    // for an event they were never invited to -- and either control would
    // then create a link, silently inviting them.
    const next: Record<string, LinkState> = {};
    for (const r of rows) {
      next[r.event_id] = {
        cardSent: r.card_sent === 1,
        maleCount: r.male_count,
        femaleCount: r.female_count,
      };
    }
    setLinks(next);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function toggleCard(eventId: string) {
    if (!id) return;
    const current = links[eventId]?.cardSent ?? false;
    const next = !current;

    // Optimistic: the box moves immediately, then the outbox catches up.
    setWriteError(null);
    setLinks((prev) => ({
      ...prev,
      [eventId]: { ...(prev[eventId] ?? EMPTY_LINK), cardSent: next },
    }));

    try {
      await setCard(id, eventId, next);
    } catch (e) {
      setLinks((prev) => ({
        ...prev,
        [eventId]: { ...(prev[eventId] ?? EMPTY_LINK), cardSent: current },
      }));
      setWriteError(e instanceof Error ? e.message : String(e));
    }
  }

  function openEditor(eventId: string, men: number | null, women: number | null) {
    setDraft({ men, women });
    setEditing(eventId);
  }

  async function saveCounts(eventId: string) {
    if (!guest || !draft) return;
    const men = draft.men === guest.male_count ? null : draft.men;
    const women = draft.women === guest.female_count ? null : draft.women;
    await writeCounts(eventId, men, women);
  }

  async function useFamilyNumbers(eventId: string) {
    await writeCounts(eventId, null, null);
  }

  async function writeCounts(
    eventId: string,
    men: number | null,
    women: number | null
  ) {
    if (!guest) return;
    const previous = links[eventId] ?? EMPTY_LINK;

    setWriteError(null);
    setSaving(true);
    setLinks((prev) => ({
      ...prev,
      [eventId]: { ...previous, maleCount: men, femaleCount: women },
    }));
    setEditing(null);
    setDraft(null);

    try {
      await setEventCounts(guest.id, eventId, men, women);
    } catch (e) {
      setLinks((prev) => ({ ...prev, [eventId]: previous }));
      setWriteError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function callGuest() {
    const number = dialableNumber(guest?.phone ?? null);
    if (!number) return;

    void Linking.openURL(`tel:${number}`).catch(() => {
      Alert.alert('Could not open the dialer', 'No phone app was found.');
    });
  }

  function confirmRemove() {
    if (!id) return;
    Alert.alert(
      'Remove this family?',
      `${guest?.name ?? 'This family'} will be taken off the list.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeFamily(id);
                router.replace('/');
              } catch (e) {
                Alert.alert(
                  'Could not remove',
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

  if (!guest) {
    return (
      <View style={styles.center}>
        <Text style={styles.missing}>This family is no longer on the list.</Text>
        <PrimaryButton label="Back to families" onPress={() => router.replace('/')} />
      </View>
    );
  }

  const hasPhone = Boolean(dialableNumber(guest.phone));
  const invitedEvents = events.filter((e) => links[e.id] !== undefined);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: spacing.xxl + insets.bottom },
      ]}
    >
      <Stack.Screen options={{ title: guest.name }} />

      {writeError ? (
        <Banner tone="error" title="Could not save that" body={writeError} />
      ) : null}

      <Text style={styles.name}>{guest.name}</Text>
      <Text style={styles.counts}>
        {describeCounts(guest.male_count, guest.female_count)}
      </Text>

      {hasPhone ? (
        <Pressable
          onPress={callGuest}
          accessibilityRole="button"
          accessibilityLabel={`Call ${guest.name} on ${guest.phone}`}
          style={({ pressed }) => [styles.callButton, pressed && styles.callPressed]}
        >
          <Text style={styles.callIcon}>📞</Text>
          <View style={styles.callText}>
            <Text style={styles.callLabel}>Call</Text>
            <Text style={styles.callNumber}>{guest.phone}</Text>
          </View>
        </Pressable>
      ) : (
        <View style={styles.noPhone}>
          <Text style={styles.noPhoneText}>No number yet</Text>
        </View>
      )}

      <Text style={styles.sectionTitle}>Invitations</Text>
      {events.length === 0 ? (
        <Text style={styles.muted}>No events yet</Text>
      ) : invitedEvents.length === 0 ? (
        <Text style={styles.muted}>
          This family isn&apos;t on any event yet. Use Edit details to add one.
        </Text>
      ) : (
        invitedEvents.map((e) => {
          const link = links[e.id];
          if (!link) return null;
          const cardSent = link.cardSent;
          const men = link.maleCount ?? guest.male_count;
          const women = link.femaleCount ?? guest.female_count;
          const ownNumbers =
            link.maleCount !== null || link.femaleCount !== null;
          const open = editing === e.id;

          return (
            <View key={e.id} style={styles.eventBlock}>
              <Pressable
                onPress={() => toggleCard(e.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: cardSent }}
                accessibilityLabel={`Card sent for ${e.name}`}
                style={({ pressed }) => [
                  styles.cardRow,
                  cardSent && styles.cardRowDone,
                  pressed && styles.cardRowPressed,
                ]}
              >
                <View style={[styles.checkbox, cardSent && styles.checkboxOn]}>
                  {cardSent ? <Text style={styles.checkmark}>✓</Text> : null}
                </View>
                <View style={styles.cardText}>
                  <Text style={styles.cardName}>{e.name}</Text>
                  <Text style={styles.cardStatus}>
                    {cardSent ? 'Card sent' : 'Card not sent'}
                  </Text>
                </View>
              </Pressable>

              <Pressable
                onPress={() => {
                  if (open) {
                    setEditing(null);
                    setDraft(null);
                  } else {
                    openEditor(e.id, men, women);
                  }
                }}
                accessibilityRole="button"
                accessibilityLabel={`Numbers for ${e.name}: ${describeCounts(men, women)}. ${open ? 'Close' : 'Change'}`}
                style={({ pressed }) => [
                  styles.countsRow,
                  open && styles.countsRowOpen,
                  pressed && styles.countsRowPressed,
                ]}
              >
                <Text
                  style={[styles.countsValue, ownNumbers && styles.countsValueOwn]}
                  numberOfLines={1}
                >
                  {describeCounts(men, women)}
                </Text>
                <Text style={styles.countsAction}>{open ? 'Close' : 'Change'}</Text>
              </Pressable>

              {open && draft ? (
                <View style={styles.editor}>
                  <Stepper
                    label="Men"
                    value={draft.men}
                    onChange={(v) => setDraft((d) => (d ? { ...d, men: v } : d))}
                  />
                  <Stepper
                    label="Women"
                    value={draft.women}
                    onChange={(v) => setDraft((d) => (d ? { ...d, women: v } : d))}
                  />
                  <PrimaryButton
                    label="Save numbers"
                    busy={saving}
                    onPress={() => void saveCounts(e.id)}
                  />
                  {ownNumbers ? (
                    <Pressable
                      onPress={() => void useFamilyNumbers(e.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Use the family's numbers for ${e.name}`}
                      style={({ pressed }) => [
                        styles.resetButton,
                        pressed && styles.resetButtonPressed,
                      ]}
                    >
                      <Text style={styles.resetText}>Use family numbers</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })
      )}

      <View style={styles.actions}>
        <PrimaryButton
          label="Edit details"
          onPress={() => router.push(`/guest/edit?id=${guest.id}`)}
        />
        <View style={styles.actionGap} />
        <PrimaryButton
          label="Remove family"
          tone="danger"
          onPress={confirmRemove}
        />
      </View>
    </ScrollView>
  );
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
  missing: { fontSize: fontSize.lg, color: colors.textMuted, textAlign: 'center' },

  name: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.text },
  counts: { fontSize: fontSize.lg, color: colors.textMuted, marginTop: 2 },

  callButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 76,
    marginTop: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.successSoft,
    borderWidth: borderWidth.hairline,
    borderColor: colors.success,
  },
  callPressed: { opacity: 0.8 },
  callIcon: { fontSize: 30 },
  callText: { flex: 1 },
  callLabel: { fontSize: fontSize.sm, color: colors.success, fontWeight: '700' },
  callNumber: { fontSize: fontSize.xl, fontWeight: '700', color: colors.text },

  noPhone: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
  },
  noPhoneText: { fontSize: fontSize.body, fontWeight: '700', color: colors.textMuted },

  sectionTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.primary,
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  muted: { fontSize: fontSize.body, color: colors.textMuted },

  eventBlock: { marginBottom: spacing.lg },

  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 72,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  cardRowDone: {
    borderColor: colors.success,
    backgroundColor: colors.successSoft,
    borderWidth: borderWidth.strong,
  },
  cardRowPressed: { opacity: 0.85 },
  checkbox: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    borderWidth: borderWidth.strong,
    borderColor: colors.border,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.success, borderColor: colors.success },
  checkmark: { color: colors.textInverse, fontSize: 22, fontWeight: '800', lineHeight: 26 },
  cardText: { flex: 1 },
  cardName: { fontSize: fontSize.lg, fontWeight: '700', color: colors.text },
  cardStatus: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },

  countsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  countsRowOpen: { borderColor: colors.primary },
  countsRowPressed: { opacity: 0.85 },
  countsValue: { flex: 1, fontSize: fontSize.body, fontWeight: '600', color: colors.textMuted },
  countsValueOwn: { color: colors.primary, fontWeight: '700' },
  countsAction: { fontSize: fontSize.sm, fontWeight: '700', color: colors.primary },

  editor: {
    marginTop: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
    gap: spacing.md,
  },
  resetButton: {
    minHeight: 56,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  resetButtonPressed: { backgroundColor: colors.primarySoft },
  resetText: { fontSize: fontSize.body, fontWeight: '700', color: colors.primary },

  actions: { marginTop: spacing.xxl },
  actionGap: { height: spacing.md },
});
