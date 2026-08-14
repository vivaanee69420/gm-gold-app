// Auth flow: phone → code → name + opt-in → role.
import React, { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';
import { normalizePhone } from '@gm-referral/shared/phone';
import { Body, Eyebrow, Field, GoldButton, Screen, Title } from '../components/ui';
import { colors, space } from '../theme';
import { useAppState } from '../state/AppState';

export function LoginScreen({ navigation }) {
  const { sendOtp } = useAppState();
  const [phone, setPhone] = useState('');
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
      await sendOtp(e164);
      navigation.navigate('Verify');
    } catch (err) {
      setError('Could not send the code. Check the number and try again.');
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
          Sign in with your mobile number. We’ll message you a 6-digit code.
        </Body>
        <Field
          label="Mobile number"
          value={phone}
          onChangeText={setPhone}
          placeholder="07700 900123"
          keyboardType="phone-pad"
          autoComplete="tel"
          onSubmitEditing={submit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <GoldButton label="Send my code" onPress={submit} disabled={busy || !phone.trim()} />
      </View>
    </Screen>
  );
}

export function VerifyScreen({ navigation }) {
  const { verifyOtp, pendingPhone, devHint, sendOtp } = useAppState();
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await verifyOtp(code.trim());
      const user = out.user;
      if (!user?.firstName) navigation.reset({ index: 0, routes: [{ name: 'Profile' }] });
      else if (!user.roles?.length) navigation.reset({ index: 0, routes: [{ name: 'RolePicker' }] });
      // else: App.js switches stacks automatically once a role exists
    } catch (err) {
      setError(err.payload?.error === 'invalid_otp' ? 'Wrong code — check the message and try again.' : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Eyebrow>Check your messages</Eyebrow>
        <Title>Enter your code</Title>
        <Body muted style={{ marginBottom: space(6) }}>
          Sent to {pendingPhone}. It expires in 5 minutes.
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
        {devHint ? <Text style={styles.dev}>{devHint}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <GoldButton label="Sign in" onPress={submit} disabled={busy || code.trim().length !== 6} />
        <GoldButton
          label="Send it again by SMS"
          variant="ghost"
          onPress={() => pendingPhone && sendOtp(pendingPhone)}
        />
      </View>
    </Screen>
  );
}

export function ProfileScreen({ navigation }) {
  const { saveProfile } = useAppState();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [notifyOptIn, setNotifyOptIn] = useState(true);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await saveProfile({ firstName: firstName.trim(), lastName: lastName.trim(), notifyOptIn });
      navigation.reset({ index: 0, routes: [{ name: 'RolePicker' }] });
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
          So the practice knows who to thank.
        </Body>
        <Field label="First name" value={firstName} onChangeText={setFirstName} placeholder="Sarah" autoComplete="given-name" />
        <Field label="Last name" value={lastName} onChangeText={setLastName} placeholder="Lewis" autoComplete="family-name" />
        <View style={styles.optRow}>
          <View style={{ flex: 1, paddingRight: space(3) }}>
          <Body>Message me about my referrals and rewards</Body>
          <Body muted style={{ fontSize: 12, marginTop: 2 }}>WhatsApp or SMS. You can turn this off any time.</Body>
          </View>
          <Switch
            value={notifyOptIn}
            onValueChange={setNotifyOptIn}
            trackColor={{ true: colors.gold, false: colors.mistFaint }}
            thumbColor={colors.ivory}
          />
        </View>
        <GoldButton label="Continue" onPress={submit} disabled={busy || !firstName.trim() || !lastName.trim()} />
      </View>
    </Screen>
  );
}

export function RolePickerScreen() {
  const { pickRole } = useAppState();
  const [busy, setBusy] = useState(false);

  const choose = async (role) => {
    setBusy(true);
    try {
      await pickRole(role); // App.js switches stacks based on the updated user
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
        <GoldButton label="I’m a GM Dental patient — I want to refer friends" onPress={() => choose('referrer')} disabled={busy} />
        <GoldButton label="A friend referred me — I have their code" variant="ghost" onPress={() => choose('referred')} disabled={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.danger, marginBottom: space(2) },
  dev: { color: colors.gold, fontSize: 12, marginBottom: space(2) },
  optRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.cardface,
    borderRadius: 12,
    padding: space(4),
    marginBottom: space(2),
  },
});
