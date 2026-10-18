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

import { PrimaryButton, Banner } from '../../src/components/ui';
import { getDb } from '../../src/db/local';
import { getGuest, listEvents, type GuestRow, type EventRow } from '../../src/db/queries';
import { setCard, removeFamily, dialableNumber } from '../../src/db/actions';
import { describeCounts } from '../../src/format';
import { colors, fontSize, spacing, radius, borderWidth } from '../../src/theme';

interface CardState {
  cardSent: boolean;
}

export default function GuestDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [guest, setGuest] = useState<GuestRow | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [cards, setCards] = useState<Record<string, CardState>>({});
  const [loading, setLoading] = useState(true);
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const db = await getDb();
    const [g, evs, links] = await Promise.all([
      getGuest(id),
      listEvents(),
      db.getAllAsync<{ event_id: string; card_sent: number }>(
        'SELECT event_id, card_sent FROM guest_events WHERE guest_id = ? AND deleted_at IS NULL',
        id
      ),
    ]);

    setGuest(g);
    setEvents(evs);

    const next: Record<string, CardState> = {};
    for (const e of evs) next[e.id] = { cardSent: false };
    for (const l of links) next[l.event_id] = { cardSent: l.card_sent === 1 };
    setCards(next);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  async function toggleCard(eventId: string) {
    if (!id) return;
    const current = cards[eventId]?.cardSent ?? false;
    const next = !current;

    // Optimistic: the box moves immediately, then the outbox catches up.
    setWriteError(null);
    setCards((prev) => ({ ...prev, [eventId]: { cardSent: next } }));

    try {
      await setCard(id, eventId, next);
    } catch (e) {
      setCards((prev) => ({ ...prev, [eventId]: { cardSent: current } }));
      setWriteError(e instanceof Error ? e.message : String(e));
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

      <Text style={styles.sectionTitle}>Invitation cards</Text>
      {events.length === 0 ? (
        <Text style={styles.muted}>No events yet</Text>
      ) : (
        events.map((e) => {
          const state = cards[e.id]?.cardSent ?? false;
          return (
            <Pressable
              key={e.id}
              onPress={() => toggleCard(e.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: state }}
              accessibilityLabel={`Card sent for ${e.name}`}
              style={({ pressed }) => [
                styles.cardRow,
                state && styles.cardRowDone,
                pressed && styles.cardRowPressed,
              ]}
            >
              <View style={[styles.checkbox, state && styles.checkboxOn]}>
                {state ? <Text style={styles.checkmark}>✓</Text> : null}
              </View>
              <View style={styles.cardText}>
                <Text style={styles.cardName}>{e.name}</Text>
                <Text style={styles.cardStatus}>
                  {state ? 'Card sent' : 'Card not sent'}
                </Text>
              </View>
            </Pressable>
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

  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 72,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
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

  actions: { marginTop: spacing.xxl },
  actionGap: { height: spacing.md },
});
