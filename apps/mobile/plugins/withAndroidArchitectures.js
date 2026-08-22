// Restrict which CPU architectures the Android build includes. A universal APK
// ships native libs for four ABIs (~88 MB); real phones need only arm64-v8a.
// Gated by env so ONLY profiles that set ANDROID_ARCHS (eas.json) are affected —
// a production AAB keeps all ABIs and lets Google Play serve per-device splits.
const { withGradleProperties } = require('expo/config-plugins');

module.exports = function withAndroidArchitectures(config) {
  const archs = process.env.ANDROID_ARCHS;
  if (!archs) return config;
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = cfg.modResults.filter(
      (item) => !(item.type === 'property' && item.key === 'reactNativeArchitectures'),
    );
    cfg.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value: archs });
    return cfg;
  });
};
