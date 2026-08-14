// The gold card itself — the product's hero object. QR in an ivory well,
// referral code as an embossed serial, member name in Fraunces.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { formatCode } from '@gm-referral/shared/referral-code';
import { colors, radius, space, type } from '../theme';

export function GoldCard({ name, code }) {
  const deepLink = `gmreferral://r/${code}`;
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.brand}>GM DENTAL</Text>
        <Text style={styles.tier}>GOLD MEMBER</Text>
      </View>
      <Text style={styles.name}>{name}</Text>
      <View style={styles.qrWell}>
        <QRCode value={deepLink} size={148} backgroundColor={colors.ivory} color={colors.black} />
      </View>
      <Text style={styles.serial}>{formatCode(code)}</Text>
      <Text style={styles.hint}>Friend scans this — or types the code in their app</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.gold,
    padding: space(5),
    alignItems: 'center',
    // top-light edge, like light catching a card held in hand
    borderTopColor: colors.goldbright,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 8,
  },
  cardHeader: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: space(4),
  },
  brand: { color: colors.ivory, fontSize: 12, letterSpacing: 3 },
  tier: { color: colors.gold, fontSize: 12, letterSpacing: 3 },
  name: {
    fontFamily: type.display,
    color: colors.ivory,
    fontSize: 24,
    marginBottom: space(4),
  },
  qrWell: {
    backgroundColor: colors.ivory,
    borderRadius: radius.control,
    padding: space(3),
  },
  serial: {
    fontFamily: type.mono,
    color: colors.goldbright,
    fontSize: 20,
    letterSpacing: 4,
    marginTop: space(4),
  },
  hint: { color: colors.mist, fontSize: 12, marginTop: space(2), textAlign: 'center' },
});
