// Auth flow: email → code → name + PHONE + opt-in → role.
//
// Phone moved from the front door to the profile step (2026-09-09). Supabase Auth verifies an
// email address; the phone number is what matches a patient to their Dentally record (FR-05),
// so it is still required — just captured after we know who someone is rather than as the
// claim of who they are. Verification needs BOTH to match one Dental OS contact, so knowing
// somebody's mobile number is no longer enough to collect their rewards.
import React, { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { normalizePhone } from '@gm-referral/shared/phone';
import { Body, Eyebrow, Field, GoldButton, Screen, Title } from '../components/ui';
import { colors, space } from '../theme';
import { useAppState } from '../state/AppState';

// Deliberately permissive: the real check is whether the code arrives. A clever regex here
// only ever rejects valid addresses someone actually owns.
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export function LoginScreen({ navigation }) {
  const { sendCode } = useAppState();
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const address = email.trim().toLowerCase();
    if (!looksLikeEmail(address)) {
      setError('That doesn’t look like an email address.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await sendCode(address);
      navigation.navigate('Verify');
    } catch (err) {
      // Supabase rate-limits sends per address and per IP. Say so plainly rather than
      // inviting someone to hammer the button.
      setError(
        err?.status === 429
          ? 'Too many codes requested. Wait a minute and try again.'
          : 'Could not send the code. Check the address and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Eyebrow>GM Dental · Gold Card</Eyebrow>
        <Title>Your smile pays{'\n'}you back.</Title>
        <Body muted style={{ marginBottom: space(6) }}>
          Sign in with your email. We’ll send you a 6-digit code.
        </Body>
        <Field
          label="Email address"
          value={email}
          onChangeText={setEmail}
          placeholder="sarah@example.com"
          keyboardType="email-address"
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <GoldButton label="Send my code" onPress={submit} disabled={busy || !email.trim()} />
      </View>
    </Screen>
  );
}

export function VerifyScreen({ navigation }) {
  const { verifyCode, pendingEmail, sendCode } = useAppState();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Eyebrow>Check your inbox</Eyebrow>
        <Title>Enter your code</Title>
        <Body muted style={{ marginBottom: space(6) }}>
          Sent to {pendingEmail}. It expires in a few minutes — check spam if it hasn’t arrived.
        </Body>
        <Field
          label="6-digit code"
          value={code}
          onChangeText={setCode}
          placeholder="••••••"
          keyboardType="number-pad"
          maxLength={6}
          onSubmitEditing={submit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <GoldButton label="Sign in" onPress={submit} disabled={busy || code.trim().length !== 6} />
        <GoldButton
          label="Email it again"
          variant="ghost"
          onPress={() => pendingEmail && sendCode(pendingEmail)}
        />
      </View>
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
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const e164 = normalizePhone(phone);
    if (!e164) {
      setError('That doesn’t look like a phone number. Try 07700 900123.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await saveProfile({ firstName: firstName.trim(), lastName: lastName.trim(), phone: e164, notifyOptIn });
      navigation.reset({ index: 0, routes: [{ name: 'RolePicker' }] });
    } catch (err) {
      // users.phone is unique. Two accounts claiming one number is a real case now that
      // identity is email — someone signing up twice with different addresses, or typing a
      // number that is not theirs.
      setError(err.payload?.error === 'phone_taken'
        ? 'That number is already on another account. Use the number the practice has for you.'
        : 'Could not save your details. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Eyebrow>Nearly there</Eyebrow>
        <Title>What’s your name?</Title>
        <Body muted style={{ marginBottom: space(6) }}>
          So the practice knows who to thank. Your mobile number is how we match you to your
          patient record — use the one the practice has on file.
        </Body>
        <Field label="First name" value={firstName} onChangeText={setFirstName} placeholder="Sarah" autoComplete="given-name" />
        <Field label="Last name" value={lastName} onChangeText={setLastName} placeholder="Lewis" autoComplete="family-name" />
        <Field
          label="Mobile number"
          value={phone}
          onChangeText={setPhone}
          placeholder="07700 900123"
          keyboardType="phone-pad"
          autoComplete="tel"
        />
        <View style={styles.optRow}>
          <View style={{ flex: 1, paddingRight: space(3) }}>
          <Body>Message me about my referrals and rewards</Body>
          <Body muted style={{ fontSize: 12, marginTop: 2 }}>By email. You can turn this off any time.</Body>
          </View>
          <Switch
            value={notifyOptIn}
            onValueChange={setNotifyOptIn}
            trackColor={{ true: colors.gold, false: colors.mistFaint }}
            thumbColor={colors.ivory}
          />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <GoldButton
          label="Continue"
          onPress={submit}
          disabled={busy || !firstName.trim() || !lastName.trim() || !phone.trim()}
        />
      </View>
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
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Eyebrow>One question</Eyebrow>
        <Title>How did you get here?</Title>
        <Body muted style={{ marginBottom: space(6) }}>
          You can do both later — this just sets up your first screen.
        </Body>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <GoldButton label="I’m a GM Dental patient — I want to refer friends" onPress={() => choose('referrer')} disabled={busy} />
        <GoldButton label="A friend referred me — I have their code" variant="ghost" onPress={() => choose('referred')} disabled={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.danger, marginBottom: space(2) },
  optRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardface,
    borderRadius: 12,
    padding: space(4),
    marginBottom: space(2),
  },
});
