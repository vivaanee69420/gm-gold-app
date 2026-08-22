// Shared UI primitives. Quiet by design — the GoldCard and the Seam carry the identity.
import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius, space, type } from '../theme';

export function Screen({ children, scroll = true, style }) {
  const inner = (
    <View style={[styles.screenInner, style]}>{children}</View>
  );
  return (
    <SafeAreaView style={styles.screen}>
      {scroll ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ flexGrow: 1 }}
          keyboardShouldPersistTaps="handled"
        >
          {inner}
        </ScrollView>
      ) : (
        inner
      )}
    </SafeAreaView>
  );
}

export function Eyebrow({ children, style }) {
  return <Text style={[styles.eyebrow, style]}>{children}</Text>;
}

export function Title({ children, style }) {
  return <Text style={[styles.title, style]}>{children}</Text>;
}

export function Body({ children, style, muted }) {
  return <Text style={[styles.body, muted && { color: colors.mist }, style]}>{children}</Text>;
}

export function GoldButton({ label, onPress, disabled, variant = 'solid', style }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'ghost' && styles.buttonGhost,
        disabled && { opacity: 0.4 },
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      <Text style={[styles.buttonLabel, variant === 'ghost' && { color: colors.gold }]}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, ...props }) {
  return (
    <View style={{ marginBottom: space(4) }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.mist}
        style={styles.input}
        {...props}
      />
    </View>
  );
}

const STATUS_LABELS = {
  new: 'Pending',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_completed: 'Completed',
  lost: 'Closed',
};

export function StatusChip({ status, creditPennies }) {
  const done = status === 'treatment_completed';
  const label = done && creditPennies
    ? `${STATUS_LABELS[status]} · +£${(creditPennies / 100).toFixed(0)}`
    : STATUS_LABELS[status] ?? status;
  return (
    <View style={[styles.chip, done && { borderColor: colors.success }]}>
      <Text style={[styles.chipText, done && { color: colors.success }]}>{label}</Text>
    </View>
  );
}

/**
 * The signature element: a thin gold seam that fills toward the payout threshold,
 * like foil edging being applied to the card. Animated once when it appears.
 */
export function GoldSeam({ ratio }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: Math.max(0, Math.min(1, ratio)),
      duration: 900,
      delay: 250,
      useNativeDriver: false,
    }).start();
  }, [ratio, anim]);
  return (
    <View style={styles.seamTrack}>
      <Animated.View
        style={[
          styles.seamFill,
          { width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) },
        ]}
      />
    </View>
  );
}

export function Hairline({ style }) {
  return <View style={[{ height: 1, backgroundColor: colors.mistFaint }, style]} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.boardroom },
  screenInner: { flexGrow: 1, padding: space(5), paddingTop: space(8) },
  eyebrow: {
    color: colors.gold,
    fontSize: 11,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
    marginBottom: space(2),
  },
  title: {
    fontFamily: type.display,
    color: colors.ivory,
    fontSize: 28,
    lineHeight: 34,
    marginBottom: space(2),
  },
  body: { color: colors.ivory, fontSize: 15, lineHeight: 22 },
  button: {
    backgroundColor: colors.gold,
    borderRadius: radius.control,
    paddingVertical: space(3.5),
    alignItems: 'center',
    marginTop: space(2),
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.gold,
  },
  buttonLabel: { color: colors.black, fontSize: 15, fontWeight: '700', letterSpacing: 0.3, textAlign: 'center' },
  fieldLabel: { color: colors.mist, fontSize: 12, letterSpacing: 0.8, marginBottom: space(1.5), textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.cardface,
    borderWidth: 1,
    borderColor: colors.cardedge,
    borderRadius: radius.control,
    color: colors.ivory,
    paddingHorizontal: space(4),
    paddingVertical: space(3.5),
    fontSize: 16,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.mistFaint,
    borderRadius: radius.chip,
    paddingHorizontal: space(3),
    paddingVertical: space(1),
  },
  chipText: { color: colors.mist, fontSize: 12, letterSpacing: 0.4 },
  seamTrack: { height: 2, backgroundColor: colors.mistFaint, borderRadius: 1, overflow: 'hidden' },
  seamFill: { height: 2, backgroundColor: colors.goldbright },
});
