import { api, setToken, getToken, clearToken } from './client.js';

export const sendOtp = (phone) => api('/auth/otp/send', { method: 'POST', body: { phone } });

export async function verifyOtp(phone, code) {
  const { token, user } = await api('/auth/otp/verify', { method: 'POST', body: { phone, code } });
  setToken(token);
  return user;
}

export const signOut = () => clearToken();
export const isSignedIn = () => Boolean(getToken());
