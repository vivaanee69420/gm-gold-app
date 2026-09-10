// Auth flow: email → code → name + PHONE + opt-in → role.
//
// Phone moved from the front door to the profile step (2026-09-09). Supabase Auth verifies an
// email address; the phone number is what matches a patient to their Dentally record (FR-05),
// so it is still required — just captured after we know who someone is rather than as the
// claim of who they are. Verification needs BOTH to match one Dental OS contact, so knowing
// somebody's mobile number is no longer enough to collect their rewards.
//
// All four screens are built as one object: the gold card being issued (components/AuthPanel).
// The seam across the panel's top edge fills a quarter per step, so the flow reads as the
// card's foil edging going on rather than as four unrelated forms.
import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import { normalizePhone } from '@gm-referral/shared/phone';
import { Body, Field, GoldButton, Notice, Screen, Title } from '../components/ui';
import { AuthPanel } from '../components/AuthPanel';
import { describeSendFailure, isAddressProblem } from '../lib/authErrors';
import { colors, space } from '../theme';
import { useAppState } from '../state/AppState';

// Deliberately permissive: the real check is whether the code arrives. A clever regex here
// only ever rejects valid addresses someone actually owns.
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export function LoginScreen({ navigation }) {
  const { sendCode } = useAppState();
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  // Separate from `error` on purpose: most send failures are nothing to do with the address,
  // so most of them must not put a red edge on the field. See isAddressProblem.
  const [badAddress, setBadAddress] = useState(false);
  const [busy, setBusy] = useState(false);

  const edit = (value) => {
    setEmail(value);
    if (badAddress) setBadAddress(false); // typing is an attempt to fix it; stop shouting
  };

  const submit = async () => {
    const address = email.trim().toLowerCase();
    if (!looksLikeEmail(address)) {
      setError('That doesn’t look like an email address.');
      setBadAddress(true);
      return;
    }
    setError(null);
    setBadAddress(false);
    setBusy(true);
    try {
      await sendCode(address);
      navigation.navigate('Verify');
    } catch (err) {
      // Who can actually fix it? Rate limit, dead connection, bad address and "our SMTP is
      // misconfigured" are four different problems, and only one of them is the address.
      setError(describeSendFailure(err));
      setBadAddress(isAddressProblem(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen center>
      <AuthPanel step={1}>
        <Title style={styles.title}>Your smile pays{'\n'}you back.</Title>
        <Body muted style={styles.lede}>
          Refer a friend to GM Dental and earn credit toward your own treatment.
        </Body>
        <Field
          label="Email address"
          value={email}
          onChangeText={edit}
          invalid={badAddress}
          placeholder="sarah@example.com"
          keyboardType="email-address"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
          hint={`We’ll send a ${OTP_LENGTH}-digit code. No password to remember.`}
        />
        <Notice>{error}</Notice>
        <GoldButton label="Send my code" onPress={submit} busy={busy} disabled={busy || !email.trim()} />
      </AuthPanel>
      <Text style={styles.footnote}>Already a patient? Use the address the practice has on file.</Text>
    </Screen>
  );
}

// Supabase enforces a minimum interval between codes to the same address (the SMTP
// setting, 60s by default) and answers 429 inside it. Mirror it in the UI: a button that
// silently does nothing gets tapped again, and again, which is how a patient concludes the
// app is broken and gives up on the spot.
const RESEND_COOLDOWN_SECONDS = 60;

// SUPABASE OWNS THIS NUMBER — Authentication → Sign In / Providers → Email → "Email OTP
// Length". Keep OTP_LENGTH in step with the dashboard; it only drives the copy.
//
// The field accepts up to OTP_MAX_LENGTH (Supabase's ceiling) rather than exactly
// OTP_LENGTH, and that is deliberate. On 2026-09-10 the dashboard was set to 8 while this
// file said 6: `maxLength={6}` silently swallowed the last two digits, the button then
// looked perfectly happy, and Supabase rejected the truncated code as "wrong or expired" —
// blaming the patient for a setting only we can see. A client that hard-truncates a value
// the server defines will always turn a config drift into a lie about the user's input.
const OTP_LENGTH = 6;
const OTP_MAX_LENGTH = 10;

export function VerifyScreen({ navigation }) {
  const { verifyCode, pendingEmail, sendCode } = useAppState();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  // Only a rejected code reddens the code field. A failed RESEND is a mail-server problem —
  // the six digits sitting in the box have nothing to do with it.
  const [badCode, setBadCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = async () => {
    if (!pendingEmail || cooldown > 0) return;
    setError(null);
    setNotice(null);
    try {
      await sendCode(pendingEmail);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      setNotice('New code sent. Check your inbox.');
    } catch (err) {
      setError(describeSendFailure(err, { resend: true }));
      setCooldown(RESEND_COOLDOWN_SECONDS);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await verifyCode(code.trim());
      const user = out.user;
      // needsPhone: an email-first signup has no phone yet, and phone is the Dentally
      // matching key — so Profile is the next stop even for a returning user who has a name.
      if (!user?.firstName || user?.needsPhone) navigation.reset({ index: 0, routes: [{ name: 'Profile' }] });
      else if (!user.roles?.length) navigation.reset({ index: 0, routes: [{ name: 'RolePicker' }] });
      // else: App.js switches stacks automatically once a role exists
    } catch (err) {
      // Supabase returns 403 for a wrong or expired code; our own API errors carry a payload.
      const wrongCode = err?.status === 403 || /invalid|expired/i.test(err?.message ?? '');
      setError(wrongCode
        ? 'Wrong or expired code — check your email and try again.'
        : 'Something went wrong. Try again.');
      setBadCode(wrongCode);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen center>
      <AuthPanel step={2}>
        <Title style={styles.title}>Enter your code</Title>
        {/* pendingEmail lives in memory, so a browser refresh on this screen loses it and the
            sentence used to render as a bare "Sent to .". */}
        <Body muted style={styles.lede}>
          {pendingEmail ? `Sent to ${pendingEmail}.` : 'Check your inbox.'} It expires in 10 minutes.
        </Body>
        {/* Typed where the card's serial sits — mono, foil gold, tracked wide. */}
        <Field
          label={`${OTP_LENGTH}-digit code`}
          value={code}
          onChangeText={(v) => { setCode(v); if (badCode) setBadCode(false); }}
          serial
          invalid={badCode}
          placeholder={'—'.repeat(OTP_LENGTH)}
          keyboardType="number-pad"
          maxLength={OTP_MAX_LENGTH}
          autoFocus
          onSubmitEditing={submit}
          hint="Not arrived? Check your spam folder."
        />
        <Notice tone={error ? 'error' : 'success'}>{error || notice}</Notice>
        <GoldButton label="Sign in" onPress={submit} busy={busy} disabled={busy || code.trim().length < OTP_LENGTH} />
        <GoldButton
          label={cooldown > 0 ? `Email it again in ${cooldown}s` : 'Email it again'}
          variant="ghost"
          onPress={resend}
          disabled={cooldown > 0}
        />
      </AuthPanel>
    </Screen>
  );
}

export function ProfileScreen({ navigation }) {
  const { saveProfile, user } = useAppState();
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [notifyOptIn, setNotifyOptIn] = useState(user?.notifyOptIn ?? true);
  const [error, setError] = useState(null);
  // A dropped connection while saving isn't the phone number's fault; a duplicate is.
  const [badPhone, setBadPhone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const e164 = normalizePhone(phone);
    if (!e164) {
      setError('That doesn’t look like a phone number. Try 07700 900123.');
      setBadPhone(true);
      return;
    }
    setError(null);
    setBadPhone(false);
    setBusy(true);
    try {
      await saveProfile({ firstName: firstName.trim(), lastName: lastName.trim(), phone: e164, notifyOptIn });
      navigation.reset({ index: 0, routes: [{ name: 'RolePicker' }] });
    } catch (err) {
      // users.phone is unique. Two accounts claiming one number is a real case now that
      // identity is email — someone signing up twice with different addresses, or typing a
      // number that is not theirs.
      const taken = err.payload?.error === 'phone_taken';
      setError(taken
        ? 'That number is already on another account. Use the number the practice has for you.'
        : 'Could not save your details. Check your connection and try again.');
      setBadPhone(taken);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen center>
      <AuthPanel step={3}>
        <Title style={styles.title}>What’s your name?</Title>
        <Body muted style={styles.lede}>
          This is the name that goes on your card.
        </Body>
        <View style={styles.nameRow}>
          <Field
            label="First name"
            value={firstName}
            onChangeText={setFirstName}
            placeholder="Sarah"
            autoComplete="given-name"
            style={styles.nameField}
          />
          <Field
            label="Last name"
            value={lastName}
            onChangeText={setLastName}
            placeholder="Lewis"
            autoComplete="family-name"
            style={styles.nameField}
          />
        </View>
        <Field
          label="Mobile number"
          value={phone}
          onChangeText={(v) => { setPhone(v); if (badPhone) setBadPhone(false); }}
          invalid={badPhone}
          placeholder="07700 900123"
          keyboardType="phone-pad"
          autoComplete="tel"
          hint="How we match you to your patient record — use the number the practice has on file."
        />
        <View style={styles.optRow}>
          <View style={{ flex: 1, paddingRight: space(3) }}>
            <Body style={styles.optLabel}>Message me about my referrals and rewards</Body>
            <Body muted style={styles.optHint}>By email. You can turn this off any time.</Body>
          </View>
          <Switch
            value={notifyOptIn}
            onValueChange={setNotifyOptIn}
            trackColor={{ true: colors.gold, false: colors.mistFaint }}
            thumbColor={colors.ivory}
            // react-native-web ignores thumbColor/trackColor for the ON state and falls back
            // to its own green, which lands as a teal pill in the middle of a gold card.
            // These two props are web-only; Platform.select keeps them off native.
            {...Platform.select({
              web: { activeThumbColor: colors.ivory, activeTrackColor: colors.gold },
              default: {},
            })}
          />
        </View>
        <Notice>{error}</Notice>
        <GoldButton
          label="Continue"
          onPress={submit}
          busy={busy}
          disabled={busy || !firstName.trim() || !lastName.trim() || !phone.trim()}
        />
      </AuthPanel>
    </Screen>
  );
}

export function RolePickerScreen() {
  const { pickRole } = useAppState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const choose = async (role) => {
    setBusy(true);
    setError(null);
    try {
      await pickRole(role); // App.js switches stacks based on the updated user
    } catch {
      setError('Could not save your choice — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen center>
      <AuthPanel step={4}>
        <Title style={styles.title}>How did you get here?</Title>
        <Body muted style={styles.lede}>
          You can do both later — this just sets up your first screen.
        </Body>
        <Notice>{error}</Notice>
        <GoldButton
          label="I’m a patient — I want to refer friends"
          onPress={() => choose('referrer')}
          disabled={busy}
        />
        <GoldButton
          label="A friend referred me — I have their code"
          variant="ghost"
          onPress={() => choose('referred')}
          disabled={busy}
        />
      </AuthPanel>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 30, lineHeight: 36, marginBottom: space(2) },
  lede: { marginBottom: space(6), fontSize: 14, lineHeight: 21 },
  footnote: {
    color: colors.mist,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    marginTop: space(5),
    paddingHorizontal: space(4),
  },
  nameRow: { flexDirection: 'row', gap: space(3) },
  nameField: { flex: 1 },
  optRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.boardroom,
    borderRadius: 12,
    padding: space(4),
    marginBottom: space(4),
  },
  optLabel: { fontSize: 14, lineHeight: 20 },
  optHint: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});
