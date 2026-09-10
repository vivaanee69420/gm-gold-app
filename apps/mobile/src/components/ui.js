// Shared UI primitives. Quiet by design — the GoldCard and the Seam carry the identity.
import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radius, space, type } from '../theme';

// A phone layout stretched across a 1400px browser window looks like a mistake. Cap the
// column and centre it; on native this is wider than any device, so it never applies.
export const COLUMN_MAX_WIDTH = 460;

export function Screen({ children, scroll = true, style, center = false }) {
  const inner = (
    <View style={[styles.screenInner, center && styles.screenInnerCentered, style]}>
      <View style={[styles.column, !center && { flex: 1 }]}>{children}</View>
    </View>
  );
  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
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
      </KeyboardAvoidingView>
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

export function GoldButton({ label, onPress, disabled, variant = 'solid', busy = false, style }) {
  const [focused, setFocused] = useState(false);
  const ghost = variant === 'ghost';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled), busy }}
      onPress={onPress}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.button,
        ghost && styles.buttonGhost,
        // Keyboard focus has to be visible now that we've removed the browser outline.
        focused && (ghost ? styles.buttonGhostFocused : styles.buttonFocused),
        // Not `opacity: 0.4` — gold at 40% over the card face turns to mud, and a muddy
        // primary button is the first thing you see on the sign-in screen. Drop it to a
        // flat inactive surface instead: clearly not tappable, still clearly a button.
        disabled && (ghost ? styles.buttonGhostDisabled : styles.buttonDisabled),
        pressed && { opacity: 0.75 },
        style,
      ]}
    >
      <View style={styles.buttonInner}>
        {busy ? (
          <ActivityIndicator size="small" color={ghost ? colors.gold : colors.black} />
        ) : (
          <Text
            style={[
              styles.buttonLabel,
              ghost && { color: colors.gold },
              disabled && { color: colors.mist },
            ]}
          >
            {label}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * A text field.
 *
 * `serial` renders it the way the referral code is set on the gold card itself — mono, foil
 * gold, tracked wide — so the six digits you type land in the same slot the real card's
 * serial occupies. `invalid` turns the edge red without moving anything.
 */
export function Field({ label, hint, invalid = false, serial = false, style, ...props }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[{ marginBottom: space(4) }, style]}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={serial ? colors.mistFaint : colors.mist}
        style={[
          styles.input,
          serial && styles.inputSerial,
          focused && styles.inputFocused,
          invalid && styles.inputInvalid,
        ]}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        {...props}
      />
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

/**
 * A message above the button — an error, or the green "new code sent".
 *
 * The old screens rendered bare red text conditionally, so it read as debug output and the
 * gap above the button changed depending on whether anything had gone wrong. Keeping the
 * same margin in both states holds the button still; the tinted slab with a red edge makes
 * the message look like part of the design rather than something that fell out of it.
 */
export function Notice({ children, tone = 'error' }) {
  const good = tone === 'success';
  if (!children) return <View style={styles.noticeSpacer} />;
  return (
    <View style={[styles.notice, good && styles.noticeSuccess]}>
      <Text style={[styles.noticeText, good && { color: colors.success }]}>{children}</Text>
    </View>
  );
}

const STATUS_LABELS = {
  new: 'Pending',
  contacted: 'Contacted',
  booked: 'Booked',
  attended: 'Attended',
  treatment_agreed: 'Treatment agreed',
  treatment_started: 'Treatment started',
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
    const target = Math.max(0, Math.min(1, ratio));
    let cancelled = false;
    // The one piece of motion in the app that isn't a response to a tap, so it's also the one
    // that has to honour "reduce motion" — jump straight to the value instead.
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) { anim.setValue(target); return; }
      Animated.timing(anim, {
        toValue: target,
        duration: 900,
        delay: 250,
        useNativeDriver: false,
      }).start();
    }).catch(() => anim.setValue(target));
    return () => { cancelled = true; };
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
  screenInner: { flexGrow: 1, padding: space(5), paddingTop: space(20), alignItems: 'center' },
  // Vertically centred, without the 80px of dead ground the fixed paddingTop left at the top
  // of every auth screen.
  screenInnerCentered: { paddingTop: space(6), paddingBottom: space(6), justifyContent: 'center' },
  column: { width: '100%', maxWidth: COLUMN_MAX_WIDTH },
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
    borderWidth: 1,
    borderColor: 'transparent', // so a focus ring can't resize the button
    paddingVertical: space(3.5),
    alignItems: 'center',
    marginTop: space(2),
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.gold,
  },
  buttonInner: { minHeight: 20, justifyContent: 'center' },
  // Focus only ever changes the border COLOUR — the transparent border is on the base style
  // above so that gaining focus can't change the button's size.
  buttonFocused: { borderColor: colors.ivory },
  buttonGhostFocused: { borderColor: colors.goldbright, backgroundColor: colors.goldFaint },
  buttonDisabled: { backgroundColor: 'transparent', borderColor: colors.mistFaint },
  buttonGhostDisabled: { borderColor: colors.mistFaint },
  buttonLabel: { color: colors.black, fontSize: 15, fontWeight: '700', letterSpacing: 0.3, textAlign: 'center' },
  fieldLabel: { color: colors.mist, fontSize: 12, letterSpacing: 0.8, marginBottom: space(1.5), textTransform: 'uppercase' },
  fieldHint: { color: colors.mist, fontSize: 12, lineHeight: 17, marginTop: space(1.5) },
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
  // The card's serial, as an input: mono, foil gold, tracked wide.
  inputSerial: {
    fontFamily: type.mono,
    color: colors.goldbright,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
    paddingVertical: space(4),
  },
  inputFocused: { borderColor: colors.gold, backgroundColor: colors.cardedge },
  inputInvalid: { borderColor: colors.dangerEdge },
  notice: {
    backgroundColor: colors.dangerFaint,
    borderLeftWidth: 2,
    borderLeftColor: colors.danger,
    borderRadius: 6,
    paddingVertical: space(2.5),
    paddingHorizontal: space(3),
    marginBottom: space(3),
  },
  noticeSuccess: { backgroundColor: 'rgba(127,176,105,0.12)', borderLeftColor: colors.success },
  noticeText: { color: colors.danger, fontSize: 13, lineHeight: 19 },
  // Reserved space so the button never jumps when a message appears.
  noticeSpacer: { marginBottom: space(3) },
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
