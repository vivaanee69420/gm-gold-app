import React, { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import { api } from '../api/client';
import { supabase, clearLegacySession, isAuthConfigured } from '../lib/supabase';

const AppStateContext = createContext(null);

// Sign-in is now a conversation with Supabase, not with our API:
//
//   LoginScreen   -> supabase.auth.signInWithOtp({ email })   -> code arrives by email
//   VerifyScreen  -> supabase.auth.verifyOtp({ email, token }) -> session
//   everything    -> api.* with that session's access token as the bearer
//
// Our API never sees the code. It only ever verifies the token Supabase issued, which is why
// there is no `devHint` here any more — there is no code for us to leak.
const initial = {
  booted: false,
  user: null, // { email, phone, firstName, roles: [], referralCode, needsPhone }
  pendingEmail: null,
  authError: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'booted':
      return { ...state, booted: true, user: action.user ?? null };
    case 'code-sent':
      return { ...state, pendingEmail: action.email, authError: null };
    case 'signed-in':
      return { ...state, user: action.user, pendingEmail: null, authError: null };
    case 'user-updated':
      return { ...state, user: action.user };
    case 'signed-out':
      return { ...initial, booted: true };
    default:
      return state;
  }
}

export function AppStateProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initial);

  // Supabase refreshes the access token in the background and emits SIGNED_OUT when a refresh
  // token is finally rejected (revoked, or expired after long disuse). Without this listener
  // the app would sit on a dead session showing stale data until the next manual reload.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') dispatch({ type: 'signed-out' });
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const actions = useMemo(
    () => ({
      boot: async () => {
        // One-time: remove the pre-Supabase 90-day token from plaintext AsyncStorage. It is
        // already useless (the API rejects anything it signed itself) but it is still a
        // credential-shaped string sitting in a readable file on every upgraded device.
        await clearLegacySession();
        try {
          const { data } = await supabase.auth.getSession();
          if (!data.session) return dispatch({ type: 'booted', user: null });
          const out = await api.me();
          dispatch({ type: 'booted', user: out.user ?? null });
        } catch {
          dispatch({ type: 'booted', user: null });
        }
      },

      /** Ask Supabase to email a six-digit code. */
      sendCode: async (email) => {
        if (!isAuthConfigured) throw new Error('auth_not_configured');
        const { error } = await supabase.auth.signInWithOtp({
          email,
          // Open self-registration: a patient signing up IS the product. An account with no
          // phone and no matching Dentally record can do nothing and earn nothing.
          options: { shouldCreateUser: true },
        });
        if (error) throw error;
        dispatch({ type: 'code-sent', email });
      },

      /** Exchange the code for a session, then load the profile from our API. */
      verifyCode: async (code) => {
        const { error } = await supabase.auth.verifyOtp({
          email: state.pendingEmail,
          token: code,
          type: 'email',
        });
        if (error) throw error;
        // First call after verifying creates the profile row from the verified identity.
        const out = await api.me();
        dispatch({ type: 'signed-in', user: out.user });
        return out;
      },

      saveProfile: async (profile) => {
        const out = await api.saveProfile(profile);
        dispatch({ type: 'user-updated', user: out.user });
      },
      pickRole: async (role) => {
        const out = await api.pickRole(role);
        dispatch({ type: 'user-updated', user: out.user });
        return out.user;
      },
      signOut: async () => {
        // Clears the session from the keychain and revokes the refresh token.
        await supabase.auth.signOut();
        dispatch({ type: 'signed-out' });
      },
    }),
    [state.pendingEmail],
  );

  const value = useMemo(() => ({ ...state, ...actions }), [state, actions]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}
