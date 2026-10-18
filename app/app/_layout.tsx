import { useEffect, useRef } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Text, View, Pressable, ActivityIndicator, StyleSheet, AppState } from 'react-native';

import { useSession } from '../src/state/session';
import { useSync } from '../src/state/sync';
import { configError } from '../src/config';
import { colors, fontSize, spacing, radius } from '../src/theme';

export default function RootLayout() {
  const router = useRouter();
  const segments = useSegments();
  const { ready, displayName, bootstrap } = useSession();
  const runSync = useSync((s) => s.run);
  const startedAtFrontPage = useRef(false);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!ready) return;

    const starting = !startedAtFrontPage.current;
    startedAtFrontPage.current = true;

    const onPicker = segments[0] === 'pick';
    if (onPicker) return;
    if (!starting && displayName) return;

    if (router.canGoBack()) router.back();
    else router.replace('/pick');
  }, [ready, displayName, segments, router]);

  useEffect(() => {
    if (!ready || configError) return;

    void runSync();

    const oneMinute = setInterval(() => {
      if (AppState.currentState === 'active') void runSync();
    }, 60_000);

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') void runSync();
    });

    return () => {
      clearInterval(oneMinute);
      subscription.remove();
    };
  }, [ready, runSync]);

  if (configError) {
    return (
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <SetupNotice message={configError} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={displayName && segments[0] !== 'pick' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.primary },
          headerTintColor: colors.textInverse,
          headerTitleStyle: { fontSize: fontSize.lg, fontWeight: '700' },
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pick" options={{ headerShown: false }} />
        <Stack.Screen name="guest/[id]" options={{ title: 'Family' }} />
        <Stack.Screen name="guest/edit" options={{ title: 'Add family' }} />
        <Stack.Screen name="todo/[id]" options={{ title: 'Task' }} />
        <Stack.Screen name="todo/edit" options={{ title: 'New task' }} />
        <Stack.Screen name="export" options={{ title: 'Export' }} />
      </Stack>
    </SafeAreaProvider>
  );
}

function SetupNotice({ message }: { message: string }) {
  return (
    <View style={styles.setup}>
      <Text style={styles.setupTitle}>Setup needed</Text>
      <Text style={styles.setupBody}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  setup: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  setupTitle: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    color: colors.text,
    marginBottom: spacing.md,
  },
  setupBody: {
    fontSize: fontSize.body,
    color: colors.textMuted,
    textAlign: 'center',
    lineHeight: 26,
  },
});
