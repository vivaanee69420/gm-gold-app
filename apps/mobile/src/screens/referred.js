// Referred-friend flow: enter/scan code → interest + consent → living status screen
// that then opens the chain: explore treatments, get your own card, refer onward.
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useFocusEffect } from '@react-navigation/native';
import { normalizeCode } from '@gm-referral/shared/referral-code';
import { api, isMockMode } from '../api/client';
import { Body, Eyebrow, Field, GoldButton, Hairline, Screen, Title } from '../components/ui';
import { colors, radius, space, type } from '../theme';
import { useAppState } from '../state/AppState';

const TREATMENT_BLURBS = [
  ['Implants', 'Fixed replacement teeth that look and feel like your own.'],
  ['Aligners', 'Discreet clear trays that straighten your smile over months, not years.'],
  ['Veneers', 'Hand-finished porcelain for a complete smile refresh.'],
  ['Bonding', 'Small chips and gaps repaired in a single visit.'],
];
const CONSENT_VERSION = 'referred-v1-2026-08';

export function EnterCodeScreen({ navigation }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();

  // Returning users skip straight to their status — a live referral already exists
  // (referrerName is only present on a real record, and never in preview mode).
  useEffect(() => {
    api
      .referredStatus()
      .then((out) => {
        if (!isMockMode() && out?.referrerName) {
          navigation.reset({ index: 0, routes: [{ name: 'ReferredStatus' }] });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const proceed = (raw) => {
    const code = normalizeCode(String(raw).replace(/^gmreferral:\/\/r\//i, ''));
    if (!code) {
      setError('That code doesn’t look right — it’s 8 letters and numbers, like GMRF-7K2X.');
      return;
    }
    setError(null);
    setScanning(false);
    navigation.navigate('BookingForm', { code });
  };

  const openScanner = async () => {
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        setError('Camera not available — type the code instead.');
        return;
      }
    }
    setScanning(true);
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Eyebrow>Welcome</Eyebrow>
        <Title>Were you referred{'\n'}by a friend?</Title>
        <Body muted style={{ marginBottom: space(6) }}>
          Scan the gold card on their phone, or type their code.
        </Body>
        <GoldButton label="Scan their QR code" onPress={openScanner} />
        <Body muted style={{ textAlign: 'center', marginVertical: space(3) }}>or type it</Body>
        <Field
          label="Referral code"
          value={typed}
          onChangeText={setTyped}
          placeholder="GMRF-7K2X"
          autoCapitalize="characters"
          autoCorrect={false}
          onSubmitEditing={() => proceed(typed)}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <GoldButton label="Continue" onPress={() => proceed(typed)} disabled={!typed.trim()} />
      </View>

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.scanner}>
          <CameraView
            style={{ flex: 1 }}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => proceed(data)}
          />
          <Pressable style={styles.scannerClose} onPress={() => setScanning(false)}>
            <Text style={{ color: colors.ivory, fontSize: 16 }}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>
    </Screen>
  );
}

export function BookingFormScreen({ navigation, route }) {
  const { code } = route.params;
  const { user } = useAppState();
  const [fullName, setFullName] = useState(
    user?.firstName ? `${user.firstName} ${user.lastName ?? ''}`.trim() : '',
  );
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [email, setEmail] = useState('');
  const [practices, setPractices] = useState([]);
  const [practiceId, setPracticeId] = useState(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.practices().then((out) => setPractices(out.practices ?? [])).catch(() => {});
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await api.submitReferral({
        code,
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim(),
        preferredPracticeId: practiceId,
        consent: true,
        consentVersion: CONSENT_VERSION,
      });
      // Straight to the practice's Dentally booking page; the appointment they book
      // there flows back via the sync and confirms on the Your appointment screen.
      if (out.bookingUrl) Linking.openURL(out.bookingUrl).catch(() => {});
      navigation.reset({ index: 0, routes: [{ name: 'ReferredStatus' }] });
    } catch (err) {
      const code2 = err.payload?.error;
      setError(
        code2 === 'self_referral_not_allowed'
          ? 'You can’t use your own code.'
          : code2 === 'invalid_code'
            ? 'That code isn’t active — check it with your friend.'
            : code2 === 'already_referred'
              ? 'Looks like you’ve already been referred — the practice will be in touch.'
              : 'Could not send your request. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  const emailOk = /\S+@\S+\.\S+/.test(email.trim());
  const ready = fullName.trim().length > 1 && phone.trim().length >= 10 && emailOk && practiceId && consent;
  const chosenPractice = practices.find((p) => p.id === practiceId);

  return (
    <Screen>
      <Eyebrow>Free consultation</Eyebrow>
      <Title>Book your visit</Title>
      <Body muted style={{ marginBottom: space(4) }}>
        Leave your details, then pick a time that suits you on our booking page.
      </Body>
      <Field label="Your full name" value={fullName} onChangeText={setFullName} placeholder="Jane Smith" autoComplete="name" />
      <Field
        label="Mobile number"
        value={phone}
        onChangeText={setPhone}
        placeholder="07700 900123"
        keyboardType="phone-pad"
        autoComplete="tel"
      />
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="jane@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
      />

      <Text style={styles.groupLabel}>Preferred practice</Text>
      <View style={styles.pillWrap}>
        {practices.map((p) => (
          <Pressable key={p.id} onPress={() => setPracticeId(p.id)} style={[styles.pill, practiceId === p.id && styles.pillActive]}>
            <Text style={[styles.pillText, practiceId === p.id && styles.pillTextActive]}>{p.name}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        onPress={() => setConsent(!consent)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consent }}
        style={styles.consentRow}
      >
        <View style={[styles.checkbox, consent && styles.checkboxOn]}>
          {consent ? <Text style={{ color: colors.black, fontWeight: '700' }}>✓</Text> : null}
        </View>
        <Body muted style={{ flex: 1, fontSize: 13, lineHeight: 19 }}>
          I agree GM Dental may contact me about my enquiry, may process the treatment interest I’ve shared
          (health information), and may let the friend who referred me know when I book and complete
          treatment. Required.
        </Body>
      </Pressable>

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <GoldButton label="Continue to booking" onPress={submit} disabled={!ready || busy} />
      <Body muted style={{ textAlign: 'center', marginTop: space(3), fontSize: 12 }}>
        {chosenPractice
          ? `Next: pick your appointment time on ${chosenPractice.name}’s booking page.`
          : 'Your friend earns a reward when your treatment completes — it costs you nothing.'}
      </Body>
    </Screen>
  );
}

export function ReferredStatusScreen() {
  const { user, pickRole } = useAppState();
  const [status, setStatus] = useState(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState(null);

  useFocusEffect(
    useCallback(() => {
      const load = () => api.referredStatus().then(setStatus).catch(() => {});
      load();
      const timer = setInterval(load, 30_000); // auto-refresh: status moves without reopening
      return () => clearInterval(timer);
    }, []),
  );

  const stages = [
    ['new', 'Request received'],
    ['contacted', 'We’ve been in touch'],
    ['booked', 'Consultation booked'],
    ['attended', 'Consultation done'],
    ['treatment_agreed', 'Treatment planned'],
    ['treatment_completed', 'Treatment complete'],
  ];
  const currentIndex = Math.max(0, stages.findIndex(([key]) => key === status?.status));
  const alreadyReferrer = user?.roles?.includes('referrer');
  const appt = status?.appointmentStartsAt ? new Date(status.appointmentStartsAt) : null;
  const showAppt = appt && ['booked', 'attended', 'treatment_agreed'].includes(status?.status);
  const awaitingBooking = !showAppt && status?.status === 'new';
  const completed = status?.status === 'treatment_completed';

  // The chain: a referred friend becomes a referrer with their own card. App.js
  // switches to the referrer tabs (this screen stays reachable as "My visit").
  const getMyCard = async () => {
    setJoining(true);
    setJoinError(null);
    try {
      await pickRole('referrer');
    } catch {
      setJoinError('Could not set up your card — check your connection and try again.');
      setJoining(false);
    }
  };

  return (
    <Screen>
      <Eyebrow>Your appointment</Eyebrow>
      {showAppt ? (
        <>
          <Title>Your appointment is confirmed</Title>
          <View style={styles.apptCard}>
            <Text style={styles.apptDate}>
              {appt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
            </Text>
            <Text style={styles.apptTime}>
              {appt.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })}
              {status?.practiceName ? ` · ${status.practiceName}` : ''}
            </Text>
            <Body muted style={{ fontSize: 12, marginTop: space(2) }}>
              Need to change it? Call the practice — this page updates automatically.
            </Body>
          </View>
        </>
      ) : awaitingBooking ? (
        <>
          <Title>Book your free consultation</Title>
          <Body muted style={{ marginBottom: space(4) }}>
            {status?.bookingUrl
              ? `Pick a time on ${status?.practiceName ?? 'the practice'}’s booking page — your appointment will be confirmed here.`
              : `${status?.practiceName ?? 'The practice'} will call you to book — usually within one working day.`}
          </Body>
          {status?.bookingUrl ? (
            <GoldButton
              label={`Book at ${status?.practiceName ?? 'the practice'}`}
              onPress={() => Linking.openURL(status.bookingUrl).catch(() => {})}
              style={{ marginBottom: space(4) }}
            />
          ) : null}
        </>
      ) : completed ? (
        <>
          <Title>Treatment complete</Title>
          <Body muted style={{ marginBottom: space(6) }}>
            Thanks for visiting {status?.practiceName ?? 'GM Dental'} — here’s your journey:
          </Body>
        </>
      ) : (
        <>
          <Title>{status?.practiceName ?? 'The practice'} will call you</Title>
          <Body muted style={{ marginBottom: space(6) }}>
            Usually within one working day. Here’s where things are:
          </Body>
        </>
      )}
      {stages.map(([key, label], i) => (
        <View key={key}>
          <View style={styles.stageRow}>
            <View style={[styles.dot, i <= currentIndex && styles.dotOn]} />
            <Body style={i > currentIndex ? { color: colors.mist } : null}>{label}</Body>
          </View>
          {i < stages.length - 1 ? <Hairline style={{ marginLeft: space(1.5) }} /> : null}
        </View>
      ))}

      <Eyebrow style={{ marginTop: space(8) }}>While you wait</Eyebrow>
      <Text style={styles.sectionTitle}>Explore our treatments</Text>
      <Body muted style={{ marginBottom: space(3), fontSize: 13 }}>
        Curious about something? Mention it when we call — your consultation is free.
      </Body>
      {TREATMENT_BLURBS.map(([name, blurb], i) => (
        <View key={name}>
          <View style={styles.treatmentRow}>
            <Text style={styles.treatmentName}>{name}</Text>
            <Body muted style={{ flex: 1, fontSize: 13, lineHeight: 19 }}>{blurb}</Body>
          </View>
          {i < TREATMENT_BLURBS.length - 1 ? <Hairline /> : null}
        </View>
      ))}

      {!alreadyReferrer && (
        <View style={styles.chainCard}>
          <Eyebrow>Pass it on</Eyebrow>
          <Text style={styles.sectionTitle}>Get your own gold card</Text>
          <Body muted style={{ fontSize: 13, lineHeight: 19, marginBottom: space(2) }}>
            Know someone who’d love GM Dental? You don’t have to wait for your visit — share
            your own code and earn cash each time a friend completes treatment.
          </Body>
          {joinError ? <Text style={styles.error}>{joinError}</Text> : null}
          <GoldButton label="Get my gold card" onPress={getMyCard} disabled={joining} />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.danger, marginBottom: space(2) },
  groupLabel: { color: colors.mist, fontSize: 12, letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: space(2), marginTop: space(4) },
  pillWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), marginBottom: space(3) },
  pill: {
    borderWidth: 1,
    borderColor: colors.mistFaint,
    borderRadius: radius.chip,
    paddingHorizontal: space(4),
    paddingVertical: space(2),
  },
  pillActive: { backgroundColor: colors.gold, borderColor: colors.gold },
  pillText: { color: colors.ivory, fontSize: 14 },
  pillTextActive: { color: colors.black, fontWeight: '600' },
  consentRow: {
    flexDirection: 'row',
    gap: space(3),
    marginVertical: space(4),
    alignItems: 'flex-start',
    backgroundColor: colors.cardface,
    borderRadius: radius.control,
    padding: space(4),
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: colors.gold,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.gold },
  scanner: { flex: 1, backgroundColor: colors.black },
  scannerClose: { position: 'absolute', bottom: 48, alignSelf: 'center', padding: 16 },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingVertical: space(3) },
  dot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: colors.mist },
  dotOn: { backgroundColor: colors.goldbright, borderColor: colors.goldbright },
  sectionTitle: {
    fontFamily: type.display,
    color: colors.ivory,
    fontSize: 20,
    marginBottom: space(2),
  },
  treatmentRow: { flexDirection: 'row', gap: space(3), paddingVertical: space(3), alignItems: 'baseline' },
  apptCard: {
    backgroundColor: colors.cardface,
    borderWidth: 1,
    borderColor: colors.gold,
    borderRadius: radius.card,
    padding: space(5),
    marginBottom: space(6),
  },
  apptDate: { fontFamily: type.display, color: colors.goldbright, fontSize: 24 },
  apptTime: { color: colors.ivory, fontSize: 16, marginTop: space(1) },
  treatmentName: { color: colors.goldbright, fontSize: 14, fontWeight: '600', width: 84 },
  chainCard: {
    marginTop: space(8),
    backgroundColor: colors.cardface,
    borderWidth: 1,
    borderColor: colors.gold,
    borderRadius: radius.card,
    padding: space(5),
  },
});
