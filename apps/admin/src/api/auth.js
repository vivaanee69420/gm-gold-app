import { api, setToken, getToken, clearToken } from './client.js';

// Dashboard accounts are email + password (admin_users, not the patient/OTP identity).
export async function signIn(email, password) {
  const { token, admin } = await api('/auth/admin/login', { method: 'POST', body: { email, password } });
  setToken(token);
  return admin;
}

export const signOut = () => clearToken();
export const isSignedIn = () => Boolean(getToken());
