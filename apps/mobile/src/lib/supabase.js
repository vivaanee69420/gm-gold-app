// Supabase Auth client (decision 2026-09-09: Supabase owns patient identity).
//
// The session lives in the OS keychain, not AsyncStorage. This matters more than it used to:
// AsyncStorage is a plain unencrypted file, and what is stored here is now a REFRESH token,
// whose whole job is minting new access tokens on demand. Anyone who reads that file — a
// rooted phone, an unencrypted device backup — has a working account for as long as the token
// lives, and there is no server-side expiry to wait out. iOS Keychain / Android Keystore is
// what that belongs in.
//
// SecureStore caps a value at 2048 bytes and a Supabase session (two JWTs plus user metadata)
// regularly exceeds it, so the adapter chunks. Without chunking, writes fail silently-ish and
// the user is signed out on next launch with no obvious cause.
import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const CHUNK = 1800; // headroom under SecureStore's 2048-byte ceiling
const countKey = (key) => `${key}.chunks`;
const chunkKey = (key, i) => `${key}.${i}`;

/**
 * SecureStore, made to look like the simple key/value store supabase-js expects, with
 * transparent chunking.
 *
 * Read/write/remove are all "count first, then parts", so a partially-written value reads
 * back as a miss rather than as corrupt JSON that would throw inside supabase-js.
 */
const SecureStoreAdapter = {
  async getItem(key) {
    try {
      const count = Number(await SecureStore.getItemAsync(countKey(key)));
      if (!Number.isInteger(count) || count <= 0) return null;
      const parts = [];
      for (let i = 0; i < count; i += 1) {
        const part = await SecureStore.getItemAsync(chunkKey(key, i));
        if (part === null) return null; // torn write: treat as absent, force a fresh login
        parts.push(part);
      }
      return parts.join('');
    } catch {
      // Keychain unavailable (locked device, simulator quirk). A miss means "sign in again",
      // which is recoverable; throwing here would crash the app at launch.
      return null;
    }
  },

  async setItem(key, value) {
    try {
      const previous = Number(await SecureStore.getItemAsync(countKey(key))) || 0;
      const chunks = Math.ceil(value.length / CHUNK) || 1;
      for (let i = 0; i < chunks; i += 1) {
        await SecureStore.setItemAsync(chunkKey(key, i), value.slice(i * CHUNK, (i + 1) * CHUNK));
      }
      // Drop any chunks left over from a longer previous value, or they linger in the
      // keychain forever holding fragments of an old session.
      for (let i = chunks; i < previous; i += 1) {
        await SecureStore.deleteItemAsync(chunkKey(key, i));
      }
      await SecureStore.setItemAsync(countKey(key), String(chunks));
    } catch {
      // Nothing useful to do: failing to persist means the session is memory-only for this
      // launch. Better than crashing mid sign-in.
    }
  },

  async removeItem(key) {
    try {
      const count = Number(await SecureStore.getItemAsync(countKey(key))) || 0;
      for (let i = 0; i < count; i += 1) await SecureStore.deleteItemAsync(chunkKey(key, i));
      await SecureStore.deleteItemAsync(countKey(key));
    } catch {
      // ignore
    }
  },
};

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** False until the project is configured, so the UI can say so instead of failing obscurely. */
export const isAuthConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = createClient(SUPABASE_URL || 'http://localhost', SUPABASE_ANON_KEY || 'anon', {
  auth: {
    storage: SecureStoreAdapter,
    autoRefreshToken: true,
    persistSession: true,
    // No deep-link handling yet: we use six-digit codes, not magic links, so there is no
    // callback URL to parse (todo.md Q3).
    detectSessionInUrl: false,
  },
});

/**
 * One-time cleanup of the pre-Supabase token.
 *
 * Every device that ran an earlier build has a 90-day self-issued JWT sitting in plaintext
 * AsyncStorage. It is useless now — the API rejects anything it signed itself — but it is
 * still a credential-shaped string in a readable file, so remove it rather than leave it.
 */
export async function clearLegacySession() {
  try {
    await AsyncStorage.removeItem('gmref.session.token');
  } catch {
    // ignore
  }
}

/** The current access token, or null. supabase-js refreshes it under the hood. */
export async function currentAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
