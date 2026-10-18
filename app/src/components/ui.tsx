import { Pressable, Text, StyleSheet, View } from 'react-native';

import { colors, fontSize, spacing, radius, borderWidth } from '../theme';

export const inputStyle = {
  minHeight: 56,
  borderRadius: radius.md,
  borderWidth: borderWidth.hairline,
  borderColor: colors.border,
  backgroundColor: colors.surface,
  paddingHorizontal: spacing.md,
  fontSize: fontSize.body,
  color: colors.text,
} as const;

export function Field({
  label,
  children,
}: {
  label?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      {children}
    </View>
  );
}

export function Stepper({
  label,
  value,
  onChange,
  emptyLabel = 'Not set',
}: {
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
  emptyLabel?: string;
}) {
  const step = (delta: number) => {
    const base = value ?? 0;
    const next = Math.max(0, base + delta);
    onChange(next);
  };

  const belowMinimum = value === null || value === 0;

  return (
    <View style={styles.stepper}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperBox}>
        <Pressable
          android_ripple={{ color: 'rgba(123,45,67,0.10)' }}
          onPress={() => step(-1)}
          disabled={belowMinimum}
          accessibilityRole="button"
          accessibilityLabel={`One fewer ${label}`}
          accessibilityState={{ disabled: belowMinimum }}
          style={({ pressed }) => [
            styles.stepButton,
            belowMinimum && styles.stepButtonOff,
            pressed && styles.stepButtonPressed,
          ]}
        >
          <Text style={styles.stepButtonText}>−</Text>
        </Pressable>

        <Pressable
          android_ripple={{ color: 'rgba(123,45,67,0.10)' }}
          onPress={() => onChange(value === null ? 1 : null)}
          accessibilityRole="button"
          accessibilityLabel={
            value === null
              ? `Set ${label} to 1`
              : `Clear ${label}, currently ${value}`
          }
          style={({ pressed }) => [styles.stepValue, pressed && styles.stepValuePressed]}
        >
          <Text
            style={value === null ? styles.stepValueTextEmpty : styles.stepValueText}
            numberOfLines={1}
          >
            {value === null ? emptyLabel : String(value)}
          </Text>
        </Pressable>

        <Pressable
          android_ripple={{ color: 'rgba(123,45,67,0.10)' }}
          onPress={() => step(1)}
          accessibilityRole="button"
          accessibilityLabel={`One more ${label}`}
          style={({ pressed }) => [styles.stepButton, pressed && styles.stepButtonPressed]}
        >
          <Text style={styles.stepButtonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function ToggleChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      android_ripple={{ color: 'rgba(123,45,67,0.12)' }}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      style={[styles.toggle, selected && styles.toggleSelected]}
    >
      <Text style={[styles.toggleText, selected && styles.toggleTextSelected]}>
        {selected ? '✓  ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  busy,
  tone = 'primary',
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  tone?: 'primary' | 'danger';
}) {
  return (
    <Pressable
      android_ripple={{ color: 'rgba(255,255,255,0.22)' }}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.primary,
        tone === 'danger' && styles.primaryDanger,
        (disabled || busy) && styles.primaryOff,
        pressed && styles.primaryPressed,
      ]}
    >
      <Text style={styles.primaryText}>{busy ? 'Working…' : label}</Text>
    </Pressable>
  );
}

export function Banner({
  tone,
  title,
  body,
}: {
  tone: 'warn' | 'info' | 'error';
  title: string;
  body?: string;
}) {
  return (
    <View style={[styles.banner, tone === 'warn' && styles.bannerWarn, tone === 'error' && styles.bannerError]}>
      <Text style={styles.bannerTitle}>{title}</Text>
      {body ? <Text style={styles.bannerBody}>{body}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { marginBottom: spacing.lg },
  label: {
    fontSize: fontSize.body,
    fontWeight: '700',
    color: colors.primary,
    marginBottom: spacing.xs,
  },
  stepper: { width: '100%' },
  stepperLabel: {
    fontSize: fontSize.body,
    fontWeight: '700',
    color: colors.primary,
    marginBottom: spacing.xs,
  },
  stepperBox: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    overflow: 'hidden',
  },
  stepButton: {
    width: 56,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },
  stepButtonOff: { opacity: 0.35 },
  stepButtonPressed: { backgroundColor: colors.primaryDark },
  stepButtonText: {
    fontSize: fontSize.xxl,
    fontWeight: '700',
    color: colors.textInverse,
    lineHeight: 32,
  },
  stepValue: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  stepValuePressed: { backgroundColor: 'rgba(123,45,67,0.10)' },
  stepValueText: { fontSize: fontSize.xxl, fontWeight: '800', color: colors.text },
  stepValueTextEmpty: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    color: colors.primaryDark,
  },

  toggle: {
    minHeight: 56,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  toggleSelected: {
    borderColor: colors.primary,
    backgroundColor: colors.primarySoft,
    borderWidth: borderWidth.strong,
  },
  toggleText: { fontSize: fontSize.body, color: colors.text, fontWeight: '600' },
  toggleTextSelected: { color: colors.primary },

  primary: {
    minHeight: 60,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  primaryDanger: { backgroundColor: colors.danger },
  primaryOff: { opacity: 0.5 },
  primaryPressed: { backgroundColor: colors.primaryDark },
  primaryText: { color: colors.textInverse, fontSize: fontSize.lg, fontWeight: '700' },

  banner: {
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: borderWidth.hairline,
    borderColor: colors.border,
  },
  bannerWarn: { backgroundColor: '#FFF4E0', borderColor: '#E0A800' },
  bannerError: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  bannerTitle: { fontSize: fontSize.body, fontWeight: '700', color: colors.text },
  bannerBody: { fontSize: fontSize.sm, color: colors.textMuted, marginTop: 4, lineHeight: 22 },
});
