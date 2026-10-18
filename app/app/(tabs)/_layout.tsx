import { Tabs, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useSession } from '../../src/state/session';
import { colors, fontSize, radius, spacing, borderWidth } from '../../src/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.primary },
        headerTintColor: colors.textInverse,
        headerTitleStyle: { fontSize: fontSize.lg, fontWeight: '700' },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { paddingTop: 4 },
        tabBarLabelStyle: { fontSize: fontSize.sm, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Families',
          headerRight: () => <FamiliesHeaderRight />,
          tabBarIcon: ({ focused }) => <TabGlyph label="👥" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Tasks',
          tabBarIcon: ({ focused }) => <TabGlyph label="✅" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ focused }) => <TabGlyph label="🕒" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

function FamiliesHeaderRight() {
  const router = useRouter();
  return (
    <View style={styles.headerRight}>
      <Pressable
        onPress={() => router.push('/export')}
        accessibilityRole="button"
        accessibilityLabel="Export the family list"
        style={({ pressed }) => [styles.export, pressed && styles.exportPressed]}
      >
        <Text style={styles.exportText}>Export</Text>
      </Pressable>
      <WhoAmI />
    </View>
  );
}

function WhoAmI() {
  const { displayName, switchPerson } = useSession();
  return (
    <Pressable
      onPress={switchPerson}
      accessibilityRole="button"
      accessibilityLabel={`Using the app as ${displayName}. Tap to switch person.`}
      style={({ pressed }) => [styles.whoami, pressed && styles.whoamiPressed]}
    >
      <Text style={styles.whoamiText} numberOfLines={1}>
        {displayName}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  export: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: borderWidth.hairline,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  exportPressed: { backgroundColor: 'rgba(255,255,255,0.22)' },
  exportText: { color: colors.textInverse, fontSize: fontSize.body, fontWeight: '700' },
  whoami: {
    minHeight: 40,
    maxWidth: 160,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  whoamiPressed: { backgroundColor: 'rgba(255,255,255,0.32)' },
  whoamiText: { color: colors.textInverse, fontSize: fontSize.body, fontWeight: '700' },
});

function TabGlyph({ label, focused }: { label: string; focused: boolean }) {
  return <Text style={{ fontSize: 22, opacity: focused ? 1 : 0.45 }}>{label}</Text>;
}
