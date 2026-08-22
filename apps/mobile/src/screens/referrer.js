// Referrer tabs: Card (hero + share), Referrals (pending kept alive), Wallet (the money).
import React, { useCallback, useState } from 'react';
import { FlatList, RefreshControl, Share, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { formatPennies } from '@gm-referral/shared/money';
import { formatCode } from '@gm-referral/shared/referral-code';
import { api } from '../api/client';
import { GoldCard } from '../components/GoldCard';
import { Body, Eyebrow, GoldButton, GoldSeam, Hairline, Screen, StatusChip, Title } from '../components/ui';
import { colors, space, type } from '../theme';
import { useAppState } from '../state/AppState';

const STORE_LINKS = 'iPhone: https://apps.apple.com/gb/app/gm-referral · Android: https://play.google.com/store/apps/details?id=uk.co.gmdental.referral';

export function CardScreen() {
  const { user, signOut } = useAppState();
  const code = user?.referralCode ?? 'GMRF7K2X';

  const share = () =>
    Share.share({
      message:
        `I get looked after at GM Dental — you'd get a free consultation if you mention me. ` +
        `Get the GM Referral app and enter my code ${formatCode(code)} when it asks who sent you.\n${STORE_LINKS}`,
    });

  return (
    <Screen>
      <Eyebrow>Your card</Eyebrow>
      <Title>Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}, {user?.firstName ?? 'there'}</Title>
      <View style={{ marginTop: space(2) }}>
        <GoldCard name={`${user?.firstName ?? 'Gold'} ${user?.lastName ?? 'Member'}`} code={code} />
      </View>
      <GoldButton label="Share my card" onPress={share} style={{ marginTop: space(5) }} />
      {user?.verificationStatus === 'pending_review' ? (
        <Body muted style={{ textAlign: 'center', marginTop: space(3), fontSize: 12 }}>
          We’re confirming you’re a GM Dental patient — your card works while we check.
        </Body>
      ) : null}
      <Body muted style={{ textAlign: 'center', marginTop: space(3), fontSize: 12 }}>
        You earn cash when a friend’s treatment completes. No limit on friends.
      </Body>
      <View style={{ flex: 1 }} />
      <Text style={styles.signOut} onPress={signOut} accessibilityRole="button">
        Sign out{user?.phone ? ` · ${user.phone}` : ''}
      </Text>
    </Screen>
  );
}

export function ReferralsScreen() {
  const [referrals, setReferrals] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const out = await api.myReferrals();
      setReferrals(out.referrals ?? []);
    } catch {
      // offline blip mid-session — keep whatever we already show
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      // Auto-refresh while the screen is open: a confirmed commission appears
      // within 30s without pull-to-refresh.
      const timer = setInterval(load, 30_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  const lifetime = referrals.filter((r) => r.status === 'treatment_completed').length;

  return (
    <Screen scroll={false}>
      <Eyebrow>My referrals</Eyebrow>
      <Title>{referrals.length ? `${referrals.length} friends referred` : 'No referrals yet'}</Title>
      <Body muted style={{ marginBottom: space(4) }}>
        {referrals.length
          ? `${lifetime} completed treatment. We’ll message you as each friend moves along.`
          : 'Show your card to a friend — their journey will appear here.'}
      </Body>
      <FlatList
        data={referrals}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.gold} />}
        ItemSeparatorComponent={Hairline}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View>
              <Text style={styles.friend}>{item.friendName}</Text>
              <Text style={styles.date}>{item.createdAt}</Text>
            </View>
            <StatusChip status={item.status} creditPennies={item.creditPennies} />
          </View>
        )}
      />
    </Screen>
  );
}

export function WalletScreen() {
  const [wallet, setWallet] = useState(null);
  const [practices, setPractices] = useState([]);
  const [requesting, setRequesting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, p] = await Promise.all([api.wallet(), api.practices()]);
      setWallet(w.wallet);
      setPractices(p.practices ?? []);
    } catch {
      // offline blip mid-session — keep whatever we already show
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      // Auto-refresh while the screen is open: a confirmed commission appears
      // within 30s without pull-to-refresh.
      const timer = setInterval(load, 30_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  if (!wallet) {
    return (
      <Screen>
        <Eyebrow>Wallet</Eyebrow>
        <Title>Loading…</Title>
      </Screen>
    );
  }

  const { balancePennies, thresholdPennies, lifetimePennies, ledger, openPayout } = wallet;
  const toGo = Math.max(0, thresholdPennies - balancePennies);
  const unlocked = balancePennies >= thresholdPennies;

  const requestPayout = async () => {
    setRequesting(true);
    try {
      // MVP: collect at the first practice; a picker lands with the admin build.
      await api.requestPayout(practices[0]?.id);
      await load();
    } catch {
      // request didn't land — leave the button enabled to try again
    } finally {
      setRequesting(false);
    }
  };

  return (
    <Screen>
      <Eyebrow>Wallet</Eyebrow>
      <Text style={styles.balance}>{formatPennies(balancePennies)}</Text>
      <GoldSeam ratio={balancePennies / thresholdPennies} />
      <Body muted style={{ marginTop: space(2), marginBottom: space(5) }}>
        {openPayout
          ? `Payout requested — collect ${formatPennies(openPayout.amountPennies)} at ${openPayout.practiceName} reception.`
          : unlocked
            ? `Ready to collect at any practice.`
            : `${formatPennies(toGo)} to go — collect in cash at any practice from ${formatPennies(thresholdPennies)}.`}
      </Body>
      {unlocked && !openPayout ? (
        <GoldButton label="Collect my cash" onPress={requestPayout} disabled={requesting} />
      ) : null}
      <View style={styles.lifetimeRow}>
        <Body muted>Lifetime earned</Body>
        <Text style={styles.lifetime}>{formatPennies(lifetimePennies)}</Text>
      </View>
      <Hairline style={{ marginBottom: space(2) }} />
      {ledger.map((entry) => (
        <View key={entry.id} style={styles.row}>
          <View style={{ flex: 1, paddingRight: space(2) }}>
            <Text style={styles.friend}>{entry.note}</Text>
            <Text style={styles.date}>{entry.at}</Text>
          </View>
          <Text style={[styles.amount, entry.amountPennies < 0 && { color: colors.mist }]}>
            {entry.amountPennies > 0 ? '+' : ''}
            {formatPennies(entry.amountPennies)}
          </Text>
        </View>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space(3.5),
  },
  friend: { color: colors.ivory, fontSize: 15 },
  date: { color: colors.mist, fontSize: 12, marginTop: 2 },
  balance: {
    fontFamily: type.display,
    color: colors.goldbright,
    fontSize: 52,
    marginBottom: space(3),
  },
  lifetimeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space(6),
    marginBottom: space(2),
  },
  lifetime: { color: colors.ivory, fontSize: 15, fontWeight: '600' },
  amount: { color: colors.goldbright, fontSize: 15, fontVariant: ['tabular-nums'] },
  signOut: {
    color: colors.mist,
    fontSize: 12,
    textAlign: 'center',
    marginTop: space(6),
    padding: space(2),
    textDecorationLine: 'underline',
  },
});
