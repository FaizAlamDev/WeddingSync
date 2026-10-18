import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { Alert } from 'react-native';

import { useSync, describeSync } from '../state/sync';
import { colors, fontSize, spacing, radius } from '../theme';

export function SyncBar({
  lastCounts,
}: {
  lastCounts?: { pushed: number; pulled: number } | null;
}) {
  const state = useSync();
  const { text, tone } = describeSync(state);

  function onPress() {
    if (state.failed > 0) {
      Alert.alert(
        'Some changes failed to upload',
        state.lastOutboxError ? `Last error: ${state.lastOutboxError}` : undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => void state.discard(),
          },
          { text: 'Try again', onPress: () => void state.retry() },
        ]
      );
      return;
    }
    void state.run();
  }

  const detail =
    state.phase === 'idle' && state.lastCounts
      ? `${state.lastCounts.pushed} sent · ${state.lastCounts.pulled} received`
      : state.phase === 'error'
        ? (state.error ?? '')
        : state.failed > 0
          ? (state.lastOutboxError ?? '')
          : '';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        state.failed > 0 ? `${text}. Tap for options.` : `${text}. Tap to sync now.`
      }
      style={({ pressed }) => [
        styles.bar,
        tone === 'error' && styles.barError,
        tone === 'warn' && styles.barWarn,
        pressed && styles.barPressed,
      ]}
    >
      {state.phase === 'syncing' ? (
        <ActivityIndicator size="small" color={colors.primary} />
      ) : (
        <Text style={[styles.dot, tone !== 'ok' && styles.dotAlert]}>
          {tone === 'ok' ? '●' : tone === 'busy' ? '◌' : '!'}
        </Text>
      )}

      <View style={styles.textWrap}>
        <Text
          style={[
            styles.text,
            tone === 'error' && styles.textError,
            tone === 'warn' && styles.textWarn,
          ]}
        >
          {text}
        </Text>
        {detail ? (
          <Text style={styles.detail} numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  barError: { backgroundColor: colors.dangerSoft },
  barWarn: { backgroundColor: '#FFF4E0' },
  barPressed: { opacity: 0.7 },
  dot: { fontSize: 14, color: colors.success, fontWeight: '800', lineHeight: 18 },
  dotAlert: { color: colors.danger },
  textWrap: { flex: 1 },
  text: { fontSize: fontSize.sm, fontWeight: '700', color: colors.text },
  textError: { color: colors.danger },
  textWarn: { color: '#8A6300' },
  detail: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
});
