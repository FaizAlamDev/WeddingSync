import { useState } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';

import { useSession, availableNames } from '../src/state/session';
import { useSync } from '../src/state/sync';
import { SyncBar } from '../src/components/SyncBar';
import { Banner } from '../src/components/ui';
import { colors, fontSize, spacing, radius } from '../src/theme';

export default function PickNameScreen() {
  const router = useRouter();
  const { displayName, pickName, error } = useSession();
  const lastCounts = useSync((s) => s.lastCounts);
  const [busy, setBusy] = useState<string | null>(null);

  async function choose(name: string) {
    if (busy !== null) return;
    setBusy(name);

    const ok = name === displayName ? true : await pickName(name);

    if (ok) router.push('/');
    setBusy(null);
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <SyncBar lastCounts={lastCounts} />

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.heading}>
          <Text style={styles.title}>Who is using the app?</Text>
        </View>

        <View style={styles.list}>
          {availableNames.map((name) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={
                name === displayName
                  ? `Continue as ${name}, already using the app`
                  : `Use the app as ${name}`
              }
              disabled={busy !== null}
              onPress={() => choose(name)}
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
                busy !== null && busy !== name && styles.buttonDimmed,
              ]}
            >
              <Text style={styles.buttonText}>{name}</Text>
              {busy === name ? (
                <ActivityIndicator color={colors.textInverse} />
              ) : null}
            </Pressable>
          ))}
        </View>

        {error ? (
          <Banner tone="error" title="Could not save your name" body={error} />
        ) : null}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    gap: spacing.xl,
    padding: spacing.lg,
  },
  heading: { gap: spacing.sm },
  title: {
    fontSize: fontSize.xxl,
    fontWeight: '800',
    color: colors.text,
    textAlign: 'center',
  },
  list: { gap: spacing.md },
  button: {
    minHeight: 76,
    borderRadius: radius.lg,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  buttonPressed: { backgroundColor: colors.primaryDark },
  buttonDimmed: { opacity: 0.5 },
  buttonText: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.textInverse,
  },
});
