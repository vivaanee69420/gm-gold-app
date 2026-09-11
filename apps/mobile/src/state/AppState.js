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
  // Name and phone typed on the sign-up screen, held until there is a session to attach them
  // to. Nothing can be written to our API before the code is verified, so sign-up is
  // necessarily "collect, verify, then save" rather than "save, then verify".
  pendingProfile: null,
  authError: null,
};

// Exported for tests. The 'code-sent' case carries a rule that is easy to break by accident
// and expensive when broken (it holds a half-finished sign-up), so it is worth asserting
// directly rather than only through a rendered screen.
export function reducer(state, action) {
  switch (action.type) {
    case 'booted':
      return { ...state, booted: true, user: action.user ?? null };
    case 'code-sent':
      return {
        ...state,
        pendingEmail: action.email,
        // A resend for the SAME address must not discard a sign-up already in progress.
        // Defaulting straight to null meant any caller that omitted `profile` silently threw
        // away the name and phone the user had just typed, sending them back to Profile to
        // enter them again. A code sent to a DIFFERENT address is a different sign-up, so
        // that case still clears.
        pendingProfile: action.profile ?? (action.email === state.pendingEmail ? state.pendingProfile : null),
        authError: null,
      };
    case 'signed-in':
      return { ...state, user: action.user, pendingEmail: null, pendingProfile: null, authError: null };
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

      /**
       * Email a code.
       *
       * `createUser` is the whole difference between the two front doors, and it is a
       * security property, not a cosmetic one. Sign-in passes false, so an unknown address is
       * REJECTED rather than quietly turned into a brand-new account — mistype your own email
       * on the sign-in screen and you used to end up in an empty account wondering where your
       * referrals went. Sign-up passes true, along with the name and phone to attach once the
       * code checks out.
       */
      sendCode: async (email, { createUser = false, profile = null } = {}) => {
        if (!isAuthConfigured) throw new Error('auth_not_configured');
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { shouldCreateUser: createUser },
        });
        if (error) throw error;
        dispatch({ type: 'code-sent', email, profile });
      },

      /**
       * Exchange the code for a session, then load the profile from our API.
       *
       * On the sign-up path the name and phone collected before verification are written
       * here. A failure to save them (`phone_taken`, mostly) must NOT fail the sign-in — the
       * account exists and the session is valid at that point, so the caller gets the error
       * back and sends them to Profile to fix it rather than dumping them at the login screen
       * with no way forward.
       */
      verifyCode: async (code) => {
        const { error } = await supabase.auth.verifyOtp({
          email: state.pendingEmail,
          token: code,
          type: 'email',
        });
        if (error) throw error;
        // First call after verifying creates the profile row from the verified identity.
        const out = await api.me();
        let user = out.user;
        let profileError = null;

        if (state.pendingProfile) {
          try {
            const saved = await api.saveProfile(state.pendingProfile);
            user = saved.user;
          } catch (err) {
            profileError = err;
          }
        }

        dispatch({ type: 'signed-in', user });
        return { ...out, user, profileError };
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
    [state.pendingEmail, state.pendingProfile],
  );

  const value = useMemo(() => ({ ...state, ...actions }), [state, actions]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}
