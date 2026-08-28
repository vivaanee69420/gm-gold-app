// Fetch wrapper: bearer token, JSON bodies, typed errors.
// Token storage + 401 handling live here so real admin auth (Supabase email)
// swaps in behind the same surface at deployment.
const BASE = import.meta.env?.VITE_API_URL ?? 'http://localhost:4000';
const KEY = 'gm_admin_token';

let unauthorizedHandler = null;
export const onUnauthorized = (fn) => {
  unauthorizedHandler = fn;
};

export const getToken = () => localStorage.getItem(KEY);
export const setToken = (token) => localStorage.setItem(KEY, token);
export const clearToken = () => localStorage.removeItem(KEY);

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A 401 means session loss ONLY when the server says so explicitly
    // (error: 'unauthorized' — an expired/invalid/revoked token). Other 401s
    // (e.g. wrong_password on a change-password attempt, invalid_credentials
    // on login) are just a rejected request — the current session, if any,
    // stays intact and the component renders its own inline copy for the code.
    if (res.status === 401 && data.error === 'unauthorized') {
      clearToken();
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, data.error ?? 'request_failed');
  }
  return data;
}
