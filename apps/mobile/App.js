// GM Referral — navigation shell.
//
//   boot ──▶ no user ──▶ [Login → Verify → Profile → RolePicker]
//        └─▶ user.roles includes 'referrer' ──▶ tabs: Card / Referrals / Wallet
//        └─▶ user.roles == ['referred']     ──▶ [EnterCode → InterestForm → ReferredStatus]
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { useFonts, Fraunces_400Regular, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';
import { AppStateProvider, useAppState } from './src/state/AppState';
import { LoginScreen, VerifyScreen, ProfileScreen, RolePickerScreen } from './src/screens/auth';
import { CardScreen, ReferralsScreen, WalletScreen } from './src/screens/referrer';
import { EnterCodeScreen, InterestFormScreen, ReferredStatusScreen } from './src/screens/referred';
import { isMockMode } from './src/api/client';
import { colors } from './src/theme';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

// Login screen is disabled for now — flip to false to bring it back.
// While true, the app silently signs in with the dev phone below (dev OTP mode
// only; in production devSignIn fails and the login screen shows as a fallback).
const LOGIN_DISABLED = true;
const AUTO_LOGIN_PHONE = '+447700900001';

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.boardroom,
    card: colors.black,
    border: colors.mistFaint,
    primary: colors.gold,
    text: colors.ivory,
  },
};

function TabIcon({ glyph, focused }) {
  return <Text style={{ fontSize: 17, color: focused ? colors.gold : colors.mist }}>{glyph}</Text>;
}

function ReferrerTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.black, borderTopColor: colors.mistFaint },
        tabBarActiveTintColor: colors.gold,
        tabBarInactiveTintColor: colors.mist,
      }}
    >
      <Tabs.Screen name="Card" component={CardScreen} options={{ tabBarIcon: (p) => <TabIcon glyph="▣" {...p} /> }} />
      <Tabs.Screen name="Referrals" component={ReferralsScreen} options={{ tabBarIcon: (p) => <TabIcon glyph="☰" {...p} /> }} />
      <Tabs.Screen name="Wallet" component={WalletScreen} options={{ tabBarIcon: (p) => <TabIcon glyph="◈" {...p} /> }} />
    </Tabs.Navigator>
  );
}

function Router() {
  const { booted, user, boot, devSignIn } = useAppState();
  const [autoLoginFailed, setAutoLoginFailed] = useState(false);
  const autoLoginTried = useRef(false);

  useEffect(() => {
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // LOGIN_DISABLED bypass: once boot confirms there's no session, sign in silently.
  useEffect(() => {
    if (!LOGIN_DISABLED || !booted || user || autoLoginTried.current) return;
    autoLoginTried.current = true; // one attempt in flight at a time (sign-out retriggers)
    devSignIn(AUTO_LOGIN_PHONE)
      .catch(() => setAutoLoginFailed(true))
      .finally(() => {
        autoLoginTried.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [booted, user]);

  const autoLoginPending = LOGIN_DISABLED && !user && !autoLoginFailed;
  if (!booted || autoLoginPending) return <View style={{ flex: 1, backgroundColor: colors.boardroom }} />;

  const roles = user?.roles ?? [];
  // A signed-in user without a name/role starts past Login/Verify.
  const initialAuthRoute = !user ? 'Login' : !user.firstName ? 'Profile' : 'RolePicker';
  return (
    <NavigationContainer theme={navTheme}>
      {roles.includes('referrer') ? (
        <ReferrerTabs />
      ) : roles.includes('referred') ? (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="EnterCode" component={EnterCodeScreen} />
          <Stack.Screen name="InterestForm" component={InterestFormScreen} />
          <Stack.Screen name="ReferredStatus" component={ReferredStatusScreen} />
        </Stack.Navigator>
      ) : (
        <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={initialAuthRoute}>
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="Verify" component={VerifyScreen} />
          <Stack.Screen name="Profile" component={ProfileScreen} />
          <Stack.Screen name="RolePicker" component={RolePickerScreen} />
        </Stack.Navigator>
      )}
      {isMockMode() ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 8,
            alignSelf: 'center',
            backgroundColor: colors.cardface,
            borderRadius: 999,
            paddingHorizontal: 12,
            paddingVertical: 4,
            borderWidth: 1,
            borderColor: colors.mistFaint,
          }}
        >
          <Text style={{ color: colors.mist, fontSize: 11 }}>Preview data — backend not connected</Text>
        </View>
      ) : null}
    </NavigationContainer>
  );
}

/** On web, present the app in a centered phone-width frame instead of full-bleed. */
function PhoneFrame({ children }) {
  if (Platform.OS !== 'web') return children;
  return (
    <View style={{ flex: 1, backgroundColor: '#041613', alignItems: 'center' }}>
      <View
        style={{
          flex: 1,
          width: '100%',
          maxWidth: 420,
          backgroundColor: colors.boardroom,
          borderLeftWidth: 1,
          borderRightWidth: 1,
          borderColor: colors.mistFaint,
        }}
      >
        {children}
      </View>
    </View>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({ Fraunces_400Regular, Fraunces_600SemiBold });
  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: colors.boardroom }} />;
  return (
    <AppStateProvider>
      <StatusBar style="light" />
      <PhoneFrame>
        <Router />
      </PhoneFrame>
    </AppStateProvider>
  );
}
