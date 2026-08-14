import { vi } from 'vitest';

/** Stub global fetch with route matchers; returns the list of calls made. */
export function stubFetchRoutes(routes) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init = {}) => {
      const method = init.method ?? 'GET';
      const path = new URL(url).pathname;
      calls.push({ method, path, body: init.body ? JSON.parse(init.body) : undefined });
      const match = routes.find(
        (r) => r.method === method && (r.path instanceof RegExp ? r.path.test(path) : r.path === path),
      );
      if (!match) throw new Error(`no stub for ${method} ${path}`);
      return new Response(JSON.stringify(match.body ?? { ok: true }), {
        status: match.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}
