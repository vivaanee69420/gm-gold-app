// Referrer tabs: Card (hero + share), Referrals (pending kept alive), Wallet (the money).
import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Share, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { formatPennies } from '@gm-referral/shared/money';
import { formatCode } from '@gm-referral/shared/referral-code';
import { api } from '../api/client';
import { GoldCard } from '../components/GoldCard';
import { Body, Eyebrow, GoldButton, GoldSeam, Hairline, Screen, StatusChip, Title } from '../components/ui';
import BookAppointment from '../components/BookAppointment';
import { colors, radius, space, type } from '../theme';
import { useAppState } from '../state/AppState';

const STORE_LINKS = 'iPhone: https://apps.apple.com/gb/app/gm-referral · Android: https://play.google.com/store/apps/details?id=uk.co.gmdental.referral';

const shareCard = (code = 'GMRF7K2X') =>
  Share.share({
    message:
      `I get looked after at GM Dental — you'd get a free consultation if you mention me. ` +
      `Get the GM Referral app and enter my code ${formatCode(code)} when it asks who sent you.\n${STORE_LINKS}`,
  });

export function CardScreen() {
  const { user, signOut } = useAppState();
  const code = user?.referralCode ?? 'GMRF7K2X';

  const share = () => shareCard(code);

  return (
    <Screen>
      <Eyebrow>Your card</Eyebrow>
      <Title>Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}, {user?.firstName ?? 'there'}</Title>
      <View style={{ marginTop: space(2) }}>
        <GoldCard name={`${user?.firstName ?? 'Gold'} ${user?.lastName ?? 'Member'}`} code={code} />
      </View>
      <GoldButton label="Share my card" onPress={share} style={{ marginTop: space(5) }} />
      <BookAppointment label="Book an appointment" style={{ marginTop: space(3) }} />
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

const HOW_IT_WORKS = [
  { n: '1', title: 'Share your card', detail: 'Friends get a free consultation when they mention you.' },
  { n: '2', title: 'Your friend completes treatment', detail: 'We confirm it with the practice.' },
  { n: '3', title: 'Cash lands here', detail: 'Choose a practice and collect at reception.' },
];

export function WalletScreen() {
  const { user } = useAppState();
  const [wallet, setWallet] = useState(null);
  const [practices, setPractices] = useState([]);
  const [requesting, setRequesting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [selectedPracticeId, setSelectedPracticeId] = useState(null);

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
    if (!selectedPracticeId) return;
    setRequesting(true);
    try {
      await api.requestPayout(selectedPracticeId);
      setSelectedPracticeId(null);
      await load();
    } catch {
      // request didn't land — leave the button enabled to try again
    } finally {
      setRequesting(false);
    }
  };

  const cancelRequest = async () => {
    if (!openPayout) return;
    setCancelling(true);
    try {
      await api.cancelPayout(openPayout.id);
    } catch {
      // cancel didn't land (e.g. a manager just marked it paid, 409) — refresh anyway so
      // a just-paid request shows the up-to-date wallet instead of a stale "open" state
    } finally {
      await load();
      setCancelling(false);
    }
  };

  const selectedPractice = practices.find((p) => p.id === selectedPracticeId);

  return (
    <Screen>
      <Eyebrow>Wallet</Eyebrow>
      <View style={styles.balanceCard}>
        <Text style={styles.balanceLabel}>Balance</Text>
        <Text style={styles.balance}>{formatPennies(balancePennies)}</Text>
        <GoldSeam ratio={balancePennies / thresholdPennies} />
        <Text style={styles.progress}>
          {formatPennies(balancePennies)} of {formatPennies(thresholdPennies)}
        </Text>
        <Body muted={!openPayout && !unlocked} style={{ marginTop: space(3) }}>
          {openPayout
            ? `Payout requested — collect ${formatPennies(openPayout.amountPennies)} at ${openPayout.practiceName} reception.`
            : unlocked
              ? `Ready to collect in cash — choose a practice below.`
              : `${formatPennies(toGo)} more to unlock cash collection.`}
        </Body>
        {unlocked && !openPayout ? (
          <>
            <Text style={[styles.sectionLabel, { marginTop: space(4) }]}>Where will you collect?</Text>
            {practices.map((practice) => {
              const selected = practice.id === selectedPracticeId;
              return (
                <Pressable
                  key={practice.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => setSelectedPracticeId(practice.id)}
                  style={[styles.practiceRow, selected && styles.practiceRowSelected]}
                >
                  <Text style={styles.practiceName}>{practice.name}</Text>
                  <View style={[styles.practiceRadio, selected && styles.practiceRadioSelected]}>
                    {selected ? <View style={styles.practiceRadioDot} /> : null}
                  </View>
                </Pressable>
              );
            })}
            <GoldButton
              label={selectedPractice ? `Collect my cash at ${selectedPractice.name}` : 'Collect my cash'}
              onPress={requestPayout}
              disabled={requesting || !selectedPracticeId}
              style={{ marginTop: space(4) }}
            />
          </>
        ) : null}
        {openPayout ? (
          <GoldButton
            variant="ghost"
            label="Cancel request"
            onPress={cancelRequest}
            disabled={cancelling}
            style={{ marginTop: space(4) }}
          />
        ) : null}
      </View>
      <View style={styles.lifetimeRow}>
        <Body muted>Lifetime earned</Body>
        <Text style={styles.lifetime}>{formatPennies(lifetimePennies)}</Text>
      </View>
      <Hairline style={{ marginBottom: space(4) }} />
      {ledger.length === 0 ? (
        <>
          <Text style={styles.sectionLabel}>How it works</Text>
          {HOW_IT_WORKS.map((item) => (
            <View key={item.n} style={styles.step}>
              <Text style={styles.stepNumber}>{item.n}</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.friend}>{item.title}</Text>
                <Text style={styles.date}>{item.detail}</Text>
              </View>
            </View>
          ))}
          <GoldButton
            variant="ghost"
            label="Share my card"
            onPress={() => shareCard(user?.referralCode ?? undefined)}
            style={{ marginTop: space(4) }}
          />
          <Text style={[styles.sectionLabel, { marginTop: space(7) }]}>Activity</Text>
          <Body muted>Your earnings will appear here.</Body>
        </>
      ) : (
        <>
          <Text style={styles.sectionLabel}>Activity</Text>
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
        </>
      )}
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
  balanceCard: {
    backgroundColor: colors.cardface,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.cardedge,
    padding: space(5),
    marginTop: space(2),
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  balanceLabel: {
    color: colors.mist,
    fontSize: 11,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
    marginBottom: space(2),
  },
  balance: {
    fontFamily: type.display,
    color: colors.goldbright,
    fontSize: 46,
    marginBottom: space(4),
  },
  progress: {
    color: colors.mist,
    fontSize: 12,
    marginTop: space(2),
    fontVariant: ['tabular-nums'],
  },
  sectionLabel: {
    color: colors.mist,
    fontSize: 11,
    letterSpacing: 2.2,
    textTransform: 'uppercase',
    marginBottom: space(3),
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: space(2.5),
  },
  stepNumber: {
    fontFamily: type.display,
    color: colors.gold,
    fontSize: 18,
    width: space(7),
    marginTop: -2,
  },
  practiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space(3.5),
    paddingHorizontal: space(4),
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: colors.cardedge,
    marginBottom: space(2),
  },
  practiceRowSelected: {
    borderColor: colors.gold,
  },
  practiceName: {
    color: colors.ivory,
    fontSize: 15,
  },
  practiceRadio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  practiceRadioSelected: {
    borderColor: colors.goldbright,
  },
  practiceRadioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.gold,
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
