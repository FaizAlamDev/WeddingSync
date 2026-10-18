import { Text, View, StyleSheet } from 'react-native';

import type { LogRow } from '../db/queries';
import { colors, fontSize, spacing } from '../theme';

export function Timeline({
  rows,
  emptyText,
  describe,
}: {
  rows: LogRow[];
  emptyText: string;
  describe: (row: LogRow) => string;
}) {
  if (rows.length === 0) {
    return <Text style={styles.muted}>{emptyText}</Text>;
  }

  return (
    <>
      {rows.map((row) => (
        <View key={row.id} style={styles.row}>
          <View style={styles.dot} />
          <View style={styles.body}>
            <Text style={styles.text}>{describe(row)}</Text>
            <Text style={styles.meta}>
              {row.actor_name ?? 'Someone'} · {formatWhen(row.created_at)}
            </Text>
          </View>
        </View>
      ))}
    </>
  );
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.primary,
    marginTop: 6,
  },
  body: { flex: 1 },
  text: { fontSize: fontSize.body, color: colors.text, lineHeight: 22 },
  meta: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 2 },
  muted: { fontSize: fontSize.body, color: colors.textMuted, lineHeight: 24 },
});
