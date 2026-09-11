// Run these with `npm run test:mobile` FROM THE REPO ROOT, not with a `test` script in this
// package.json. That is load-bearing, not a style choice.
//
// app.json sets `runtimeVersion: { policy: 'fingerprint' }`, and the Expo fingerprint hashes
// this package's package.json scripts — every one of them except `android` and `ios`. Adding a
// `test` script here moved the fingerprint from 518efa8697… to 9067a32fb0…, which silently made
// every existing build ineligible for OTA updates: `eas update` would publish successfully,
// report success, and reach zero devices. The ROOT package.json is not a fingerprint input, so
// the script lives there.
//
// It also has to be `npm exec --workspace apps/mobile -- vitest run` rather than plain
// `vitest run`: this workspace is on vitest 5 while apps/api and apps/admin are on vitest 3,
// and a bare `vitest` inside an npm script resolves the ROOT binary (v3), which ignores this
// config entirely — no setupFiles, no jsdom, ten confusing failures.
//
// After ANY change to this package's scripts, re-check:
//   npx expo-updates fingerprint:generate --platform android
// against `npx eas-cli build:list --json`.
import { defineConfig, transformWithEsbuild } from 'vite';

// This app keeps its JSX in .js files. That is fine for the app itself — Metro's
// babel-preset-expo transforms JSX in .js unconditionally — but vite's esbuild picks a loader
// by extension, and the .js loader refuses to parse JSX. Without this every component import
// dies at parse time with "content contains invalid JS syntax".
//
// The `esbuild.include` config option is the documented way to do this and is ignored by the
// vite version in this workspace, so the transform is wired up as a pre-plugin instead.
const jsxInJs = {
  name: 'gmref:jsx-in-js',
  enforce: 'pre',
  async transform(code, id) {
    const path = id.split('?')[0];
    if (!/\/(src|test)\/.*\.js$/.test(path)) return null;
    return transformWithEsbuild(code, path, { loader: 'jsx', jsx: 'automatic' });
  },
};

export default defineConfig({
  plugins: [jsxInJs],
  // Metro injects __DEV__ into every module; react-native-web and anything ported from
  // react-native reads it, and an undefined global throws at import time rather than
  // failing a test you can read. True, because these are development-time runs.
  define: { __DEV__: 'true' },
  resolve: {
    // The screens and primitives all import from 'react-native'. react-native-web is already a
    // dependency here (the app ships a web build through it), speaks the same component and
    // StyleSheet API, and renders to DOM nodes jsdom can inspect. Aliasing to it means these
    // tests exercise the real component code rather than a hand-written mock of react-native
    // that would quietly drift away from it.
    //
    // What that does NOT cover: native-only behaviour (real layout, gestures, native modules).
    // Anything that matters on a device and not on the web still needs a device.
    alias: { 'react-native': 'react-native-web' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './test/setup.js',
  },
});
