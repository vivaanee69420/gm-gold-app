import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // PGlite ships WASM assets that must load natively, not through vite's transform.
    server: { deps: { external: [/@electric-sql\/pglite/] } },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
