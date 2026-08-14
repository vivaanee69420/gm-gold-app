import React, { createContext, useContext, useMemo, useReducer } from 'react';
import { api, clearToken } from '../api/client';

const AppStateContext = createContext(null);

const initial = {
  booted: false,
  user: null, // { phone, firstName, roles: [], verificationStatus, referralCode }
  pendingPhone: null,
  devHint: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'booted':
      return { ...state, booted: true, user: action.user ?? null };
    case 'otp-sent':
      return { ...state, pendingPhone: action.phone, devHint: action.devHint ?? null };
    case 'signed-in':
      return { ...state, user: action.user, pendingPhone: null, devHint: null };
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

  const actions = useMemo(
    () => ({
      boot: async () => {
        try {
          const out = await api.me();
          dispatch({ type: 'booted', user: out.user ?? null });
        } catch {
          dispatch({ type: 'booted', user: null });
        }
      },
      sendOtp: async (phone) => {
        const out = await api.sendOtp(phone);
        dispatch({ type: 'otp-sent', phone, devHint: out.devHint });
        return out;
      },
      verifyOtp: async (code) => {
        const out = await api.verifyOtp(state.pendingPhone, code);
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
        await clearToken();
        dispatch({ type: 'signed-out' });
      },
    }),
    [state.pendingPhone],
  );

  const value = useMemo(() => ({ ...state, ...actions }), [state, actions]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState outside provider');
  return ctx;
}
