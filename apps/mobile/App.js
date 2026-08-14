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
import { LoginScreen, VerifyScreen, ProfileScreen, RolePickerScreen } from './src/screens/auth';
import { CardScreen, ReferralsScreen, WalletScreen } from './src/screens/referrer';
import { EnterCodeScreen, InterestFormScreen, ReferredStatusScreen } from './src/screens/referred';
import { isMockMode } from './src/api/client';
import { colors } from './src/theme';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

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
  const { booted, user, boot } = useAppState();

  useEffect(() => {
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!booted) return <View style={{ flex: 1, backgroundColor: colors.boardroom }} />;

  const roles = user?.roles ?? [];
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
        <Stack.Navigator screenOptions={{ headerShown: false }}>
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
