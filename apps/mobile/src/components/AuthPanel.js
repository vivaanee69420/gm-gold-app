// The sign-in card.
//
// Signing up for this product IS being issued a gold card, so the auth screens are built as
// one: the same card face, gold hairline and top-light edge as GoldCard, with the brand row
// across the top. It starts blank — no member name, no serial — and fills in as you go.
//
// The seam along the top edge is the app's existing signature element (a thin gold line that
// fills toward the payout threshold on the Wallet screen) doing the same job here: foil
// edging being applied to a card as it's issued. Four steps, four quarters. It is the only
// thing on these screens that moves, and it earns it by telling you how far in you are.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, space } from '../theme';
import { GoldSeam } from './ui';

export const AUTH_STEPS = 4;

export function AuthPanel({ step, children }) {
  return (
    <View style={styles.panel}>
      <View style={styles.seam}>
        <GoldSeam ratio={step / AUTH_STEPS} />
      </View>
      <View style={styles.brandRow}>
        <Text style={styles.brand}>GM DENTAL</Text>
        <Text style={styles.tier}>GOLD CARD</Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.cardface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.gold,
    borderTopColor: colors.goldbright, // light catching the edge of a card held in hand
    padding: space(6),
    paddingTop: space(5),
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  // Bleeds to the panel's edges, under the top border.
  seam: {
    marginHorizontal: -space(6),
    marginTop: -space(5),
    marginBottom: space(5),
  },
  brandRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: space(5),
  },
  brand: { color: colors.ivory, fontSize: 11, letterSpacing: 3 },
  tier: { color: colors.gold, fontSize: 11, letterSpacing: 3 },
});
