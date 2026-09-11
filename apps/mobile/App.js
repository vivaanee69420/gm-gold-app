// GM Referral — navigation shell.
//
//   boot ──▶ no user ──▶ [Login → Verify → Profile → RolePicker]
//        └─▶ user.roles includes 'referrer' ──▶ tabs: Card / Referrals / Wallet
//        └─▶ user.roles == ['referred']     ──▶ [EnterCode → InterestForm → ReferredStatus]
import React, { useEffect } from 'react';
import { Platform, Text, View } from 'react-native';
import { NavigationContainer, DarkTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { StatusBar } from 'expo-status-bar';
import { useFonts, Fraunces_400Regular, Fraunces_600SemiBold } from '@expo-google-fonts/fraunces';
import { AppStateProvider, useAppState } from './src/state/AppState';
import { LoginScreen, SignUpScreen, VerifyScreen, ProfileScreen, RolePickerScreen } from './src/screens/auth';
import { CardScreen, ReferralsScreen, WalletScreen } from './src/screens/referrer';
import { EnterCodeScreen, BookingFormScreen, ReferredStatusScreen } from './src/screens/referred';
import { isMockMode } from './src/api/client';
import { installWebStyles } from './src/lib/webStyles';
import { colors } from './src/theme';

// Autofill colours, focus rings and the page background — things StyleSheet can't reach on
// web. No-op on native. Called at module scope so it lands before the first paint.
installWebStyles();

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

// The LOGIN_DISABLED dev shortcut is gone (2026-09-09). It worked by asking the API for an
// OTP and reading the code back out of the response's devHint field — the same hole that let
// anyone sign in as anyone. Supabase issues codes now and never hands them to us, so there is
// nothing left to read. To test on a device, sign in with a real address; Supabase's own
// dashboard shows the sent emails.

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
  // A referred friend who joined the chain keeps their own treatment journey
  // in a "My visit" tab alongside the full referrer experience.
  const { user } = useAppState();
  const alsoReferred = user?.roles?.includes('referred');
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
      {alsoReferred && (
        <Tabs.Screen
          name="Appointment"
          component={ReferredStatusScreen}
          options={{ tabBarIcon: (p) => <TabIcon glyph="✦" {...p} /> }}
        />
      )}
    </Tabs.Navigator>
  );
}

function Router() {
  const { booted, user, boot } = useAppState();

  useEffect(() => {
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!booted) return <View style={{ flex: 1, backgroundColor: colors.boardroom }} />;

  const roles = user?.roles ?? [];
  // A signed-in user without a name/role starts past Login/Verify.
  // needsPhone: identity is email now, so a new account arrives with no phone — and phone is
  // the Dentally matching key, so the referrer role means nothing without it.
  const initialAuthRoute = !user ? 'Login' : (!user.firstName || user.needsPhone) ? 'Profile' : 'RolePicker';
  return (
    <NavigationContainer theme={navTheme}>
      {roles.includes('referrer') ? (
        <ReferrerTabs />
      ) : roles.includes('referred') ? (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="EnterCode" component={EnterCodeScreen} />
          <Stack.Screen name="BookingForm" component={BookingFormScreen} />
          <Stack.Screen name="ReferredStatus" component={ReferredStatusScreen} />
          {/* Reachable from EnterCode's back link. Without it, picking "I was referred" was a
              one-way door: EnterCode is this stack's first screen, so goBack() did nothing and
              the role picker lived only in the no-roles navigator below — unreachable once a
              role existed. Someone who mis-tapped was stuck on the code screen for good.
              Choosing "I want to refer" here adds the referrer role, and the tree above swaps
              itself to ReferrerTabs. */}
          <Stack.Screen name="RolePicker" component={RolePickerScreen} />
        </Stack.Navigator>
      ) : (
        <Stack.Navigator screenOptions={{ headerShown: false }} initialRouteName={initialAuthRoute}>
          <Stack.Screen name="Login" component={LoginScreen} />
          <Stack.Screen name="SignUp" component={SignUpScreen} />
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
