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
    if (res.status === 401) {
      clearToken();
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, data.error ?? 'request_failed');
  }
  return data;
}
